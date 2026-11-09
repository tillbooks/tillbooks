/**
 * CRITIC PROBES (default-terms, D163). Non-author. Synthetic by construction: invented parties,
 * amounts and dates.
 *
 * Each test names what it probes. A test that FAILS here is a finding; a passing one is evidence the
 * claim holds.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createContact, createDocument, transitionDocument, updateContact } from '../../dist/core/sales/index.js';
import { recordExpense } from '../../dist/core/purchase/index.js';
import { updateCompanyProfile, getCompanyProfile } from '../../dist/core/setup/index.js';
import { listOpenItems } from '../../dist/core/debtors/openItems.js';
import { createBackup, restoreBackup } from '../../dist/core/data/portability.js';
import { getAction } from '../../dist/api/registry.js';
import { setup, AT } from '../payments/support.mjs';

const ISSUE_DAY = AT.slice(0, 10);

function contact(ctx, name, terms, role = 'both') {
  const c = createContact(ctx, {
    partyRole: role,
    name,
    idempotencyKey: `c-${name}`,
    ...(terms === undefined ? {} : { paymentTermsDays: terms }),
  });
  assert.equal(c.ok, true, JSON.stringify(c));
  return c.contact.id;
}

function draft(ctx, contactId, extra = {}) {
  const d = createDocument(ctx, {
    type: 'invoice',
    contactId,
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    ...extra,
  });
  assert.equal(d.ok, true, JSON.stringify(d));
  return d.document.id;
}

const dueOf = (store, id) => store.db.prepare('SELECT due_date FROM document WHERE id = ?').get(id).due_date;

// --- P1. An absurd but ACCEPTED contact term on the issue path -----------------------------------

test('P1a (flipped to assert the fix, critic M1): a contact term over 365 days is refused with a code, on every face', () => {
  const t = setup();
  for (const bad of [100_000_000, 3_000_000, 366]) {
    const c = createContact(t.ctx, { partyRole: 'customer', name: `Ewig ${bad} AG`, idempotencyKey: `ewig-${bad}`, paymentTermsDays: bad });
    assert.equal(c.ok, false, `accepted ${bad}`);
    assert.equal(c.error, 'invalid_payment_terms_days');
    assert.equal(c.max, 365);
    const viaVerb = getAction('create_contact').run(t.ctx, {
      workspaceId: t.workspaceId,
      partyRole: 'customer',
      name: `Verb ${bad} AG`,
      paymentTermsDays: bad,
      idempotencyKey: `verb-${bad}`,
    });
    assert.equal(viaVerb.ok, false);
    assert.equal(viaVerb.error, 'invalid_payment_terms_days');
    const patched = updateContact(t.ctx, { contactId: t.customerId, patch: { paymentTermsDays: bad } });
    assert.equal(patched.ok, false);
    assert.equal(patched.error, 'invalid_payment_terms_days');
  }
  // 365 is the bound, and it is accepted.
  assert.equal(createContact(t.ctx, { partyRole: 'customer', name: 'Jahr AG', idempotencyKey: 'jahr', paymentTermsDays: 365 }).ok, true);
});

test('P1b (flipped to assert the fix, critic M1): a LEGACY out-of-range stored term never throws and never stores a non-ISO date', () => {
  const t = setup();
  assert.equal(updateCompanyProfile(t.ctx, { defaultPaymentTermsDays: 10 }).ok, true);
  for (const legacy of [100_000_000, 3_000_000, 366]) {
    const id = contact(t.ctx, `Alt ${legacy} AG`, undefined, 'customer');
    // A row written before the bound existed: only raw SQL can still produce one.
    t.store.db.prepare('UPDATE contact SET payment_terms_days = ? WHERE id = ?').run(legacy, id);
    const doc = draft(t.ctx, id);
    let r;
    assert.doesNotThrow(() => {
      r = transitionDocument(t.ctx, { documentId: doc, to: 'issued', idempotencyKey: `i-${legacy}` });
    }, `issue threw on a stored ${legacy}`);
    assert.equal(r.ok, true, JSON.stringify(r));
    const due = dueOf(t.store, doc);
    assert.match(String(due), /^\d{4}-\d{2}-\d{2}$/, `stored due_date ${due}`);
    // "No usable terms" falls through to the workspace default: issue day + 10.
    assert.equal(due, '2026-07-29');
  }
});

// --- P2. The issue path: replay, later change, quotes, credit notes --------------------------------

test('P2a: a replayed issue (same key) after the default changed returns and keeps the first due date', () => {
  const t = setup();
  assert.equal(updateCompanyProfile(t.ctx, { defaultPaymentTermsDays: 30 }).ok, true);
  const id = draft(t.ctx, t.customerId);
  const first = transitionDocument(t.ctx, { documentId: id, to: 'issued', idempotencyKey: 'k' });
  assert.equal(first.ok, true);
  assert.equal(first.document.dueDate, '2026-08-18');
  assert.equal(updateCompanyProfile(t.ctx, { defaultPaymentTermsDays: 5 }).ok, true);
  const again = transitionDocument(t.ctx, { documentId: id, to: 'issued', idempotencyKey: 'k' });
  assert.equal(again.ok, true);
  assert.equal(again.document.dueDate, '2026-08-18');
  assert.equal(dueOf(t.store, id), '2026-08-18');
  // and the open-items read agrees with the stored date
  const oi = listOpenItems(t.ctx, { asOf: '2026-08-20' });
  const row = (oi.items ?? oi.openItems ?? []).find((i) => i.documentId === id || i.id === id || i.targetId === id);
  if (row) assert.equal(row.dueDate, '2026-08-18');
});

test('P2b: the response echo, the stored row and the poster all carry the same due date', () => {
  const t = setup();
  assert.equal(updateCompanyProfile(t.ctx, { defaultPaymentTermsDays: 10 }).ok, true);
  const id = draft(t.ctx, t.customerId);
  const r = transitionDocument(t.ctx, { documentId: id, to: 'issued', idempotencyKey: 'k' });
  assert.equal(r.ok, true);
  assert.equal(r.document.issueDate, ISSUE_DAY);
  assert.equal(r.document.dueDate, '2026-07-29');
  assert.equal(dueOf(t.store, id), '2026-07-29');
});

test('P2c: a credit note issued against a stamped invoice is not given a due date, the invoice keeps its own', () => {
  const t = setup();
  assert.equal(updateCompanyProfile(t.ctx, { defaultPaymentTermsDays: 10 }).ok, true);
  const id = draft(t.ctx, t.customerId);
  assert.equal(transitionDocument(t.ctx, { documentId: id, to: 'issued', idempotencyKey: 'k' }).ok, true);
  const credit = getAction('create_credit_note');
  if (credit === undefined) return;
  const cn = credit.run(
    { store: t.store, clock: t.clock, ids: t.ids, actor: 'user_1' },
    { workspaceId: t.workspaceId, invoiceId: id, idempotencyKey: 'cn' },
  );
  if (!cn.ok) return;
  const cnId = cn.document?.id ?? cn.creditNote?.id ?? cn.documentId;
  if (cnId === undefined) return;
  transitionDocument(t.ctx, { documentId: cnId, to: 'issued', idempotencyKey: 'cn-i' });
  assert.equal(dueOf(t.store, id), '2026-07-29');
});

// --- P3. Old invoices keep their null due date; nothing derives on read -----------------------------

test('P3: an issued invoice with a NULL due date (pre-D163) is never re-derived by setting a default or by reads', () => {
  const t = setup();
  const id = draft(t.ctx, t.customerId);
  assert.equal(transitionDocument(t.ctx, { documentId: id, to: 'issued', idempotencyKey: 'k' }).ok, true);
  // Emulate the pre-D163 row.
  t.store.db.prepare('UPDATE document SET due_date = NULL WHERE id = ?').run(id);
  assert.equal(updateCompanyProfile(t.ctx, { defaultPaymentTermsDays: 0 }).ok, true);
  assert.equal(updateContact(t.ctx, { contactId: t.customerId, patch: { paymentTermsDays: 0 } }).ok, true);
  const oi = listOpenItems(t.ctx, { asOf: '2027-01-01' });
  assert.equal(oi.ok, true, JSON.stringify(oi));
  assert.equal(dueOf(t.store, id), null);
});

// --- P4. Boundary validation of the setting --------------------------------------------------------

test('P4: update_company_profile through the registry: refusals carry a code and store nothing', () => {
  const t = setup();
  const deps = { store: t.store, clock: t.clock, ids: t.ids, actor: 'user_1' };
  const act = getAction('update_company_profile');
  assert.equal(act.run(deps, { workspaceId: t.workspaceId, defaultPaymentTermsDays: 30 }).ok, true);
  for (const bad of [-1, 366, 30.5, '30', true, 1e20]) {
    const r = act.run(deps, { workspaceId: t.workspaceId, defaultPaymentTermsDays: bad });
    assert.equal(r.ok, false, `accepted ${JSON.stringify(bad)}`);
    assert.equal(getCompanyProfile(t.ctx).profile.defaultPaymentTermsDays, 30, `stored after ${JSON.stringify(bad)}`);
  }
  // A mixed write whose terms are bad stores nothing, the name included.
  const before = getCompanyProfile(t.ctx).profile.name;
  const mixed = act.run(deps, { workspaceId: t.workspaceId, name: 'Neu GmbH', defaultPaymentTermsDays: 400 });
  assert.equal(mixed.ok, false);
  assert.equal(getCompanyProfile(t.ctx).profile.name, before);
  assert.equal(act.run(deps, { workspaceId: t.workspaceId, defaultPaymentTermsDays: null }).ok, true);
  assert.equal(getCompanyProfile(t.ctx).profile.defaultPaymentTermsDays, null);
});

// --- P5. Backup and restore round trip keeps null and 0 apart ---------------------------------------

test('P5: a backup restores null terms as null, 0 as 0, and the workspace default', () => {
  const t = setup();
  const deps = { store: t.store, clock: t.clock, ids: t.ids, actor: 'user_1', backupDir: mkdtempSync(join(tmpdir(), 'till-dt-')) };
  const none = contact(t.ctx, 'Keine AG', undefined);
  const zero = contact(t.ctx, 'Null AG', 0);
  const thirty = contact(t.ctx, 'Dreissig AG', 30);
  assert.equal(updateCompanyProfile(t.ctx, { defaultPaymentTermsDays: 14 }).ok, true);
  const b = createBackup(deps, { workspaceId: t.workspaceId, idempotencyKey: 'bk' });
  assert.equal(b.ok, true, JSON.stringify(b));
  const r = restoreBackup(deps, { source: b.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  const ws = r.workspaceId ?? r.restoredWorkspaceId ?? r.workspace?.id;
  assert.ok(ws, JSON.stringify(r));
  const terms = Object.fromEntries(
    t.store.db.prepare('SELECT name, payment_terms_days AS d FROM contact WHERE workspace_id = ?').all(ws).map((x) => [x.name, x.d]),
  );
  assert.equal(terms['Keine AG'], null);
  assert.equal(terms['Null AG'], 0);
  assert.equal(terms['Dreissig AG'], 30);
  assert.equal(t.store.db.prepare('SELECT default_payment_terms_days AS d FROM workspace WHERE id = ?').get(ws).d, 14);
  void none; void zero; void thirty;
});

// --- P7. Vendor bill recorded through the engine with a 0-day default -------------------------------

test('P7: a vendor with no own terms and a workspace default of 0 is due on the bill date', () => {
  const t = setup();
  assert.equal(updateCompanyProfile(t.ctx, { defaultPaymentTermsDays: 0 }).ok, true);
  const v = contact(t.ctx, 'Lieferant Null', undefined, 'vendor');
  const r = recordExpense(t.ctx, {
    vendorId: v,
    billDate: '2026-07-01',
    amountMinor: 108100,
    amountIsGross: true,
    taxCode: 'VST-M',
    expenseAccountId: t.acc('6500'),
    idempotencyKey: 'b0',
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(t.store.db.prepare('SELECT due_date FROM vendor_bill WHERE id = ?').get(r.vendorBillId).due_date, '2026-07-01');
});
