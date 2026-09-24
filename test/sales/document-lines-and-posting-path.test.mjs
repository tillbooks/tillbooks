// A11 m5 + m6: a discount line fails EARLY and readably, and there is exactly ONE posting path.
//
// m5: `createDocument` accepted `unitPriceMinor: -10000` (the obvious way to type a discount, since
// §2/US-A11.1 lists "optional discount" as a position field). Nothing rejected it until
// `issueInvoice`, which died with
//   {"account":"acc_4","reason":"amounts must be non-negative integer Rappen","error":"invalid_line"}
// naming an INTERNAL account id the operator has never seen, at the moment they issue rather than
// the moment they type. Discounts are not implemented, so the honest move is to say so at the door.
//
// m6: no test asserted the spec §7 P3 rule, "no second posting path": that nothing outside
// `buildInvoicePosting` posts an invoice. This file adds both halves, the static one (the sales
// module calls `postEntry` exactly once) and the behavioural one (a hand-rolled `postEntry` with
// `source: 'invoice'` can write a journal entry, but it can never BECOME an invoice's posting).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace, setCreditorProfile } from '../../dist/core/setup/index.js';
import { seedTaxCodes } from '../../dist/core/vat/index.js';
import { postEntry } from '../../dist/core/ledger/postEntry.js';
import { createDocument, updateDocument, issueInvoice } from '../../dist/core/sales/index.js';

const AT = '2026-07-16T00:00:00.000Z';

function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Nomadik GmbH' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  seedTaxCodes(ctx);
  store.db
    .prepare("UPDATE workspace SET vat_method = 'effektiv', vat_accounting = 'soll' WHERE id = ?")
    .run(workspaceId);
  setCreditorProfile(ctx, {
    creditorName: 'Nomadik GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });
  store.db
    .prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, address_street, address_house_no, address_zip, address_city, address_country, email, default_currency, payment_terms_days, created_at)
       VALUES ('ct_1', ?, 'customer', 'Muster AG', 'Musterstrasse', '5', '3000', 'Bern', 'CH', 'billing@muster.example', 'CHF', 30, ?)`,
    )
    .run(workspaceId, AT);
  return { ctx, store, workspaceId };
}

const account = (store, workspaceId, number) =>
  store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number).id;

// --- m5: a discount line is refused at the door, readably ---------------------------------------

test('m5: createDocument REJECTS a negative unit price instead of letting issue die on an account id', () => {
  const { ctx, store } = setup();
  const res = createDocument(ctx, {
    type: 'invoice',
    contactId: 'ct_1',
    currency: 'CHF',
    lines: [
      { description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' },
      { description: 'Rabatt', unitPriceMinor: -10000, taxCode: 'UST81' },
    ],
  });
  assert.equal(res.ok, false, `the draft must not be created: ${JSON.stringify(res)}`);
  assert.equal(res.error, 'invalid_line');
  assert.equal(res.field, 'unitPriceMinor');
  assert.equal(res.position, 2, 'the POSITION the operator typed, not an internal id');
  // Human-readable, and it names the missing capability rather than an internal invariant.
  assert.match(res.reason, /discount/i, JSON.stringify(res));
  assert.equal(/acc_/.test(JSON.stringify(res)), false, 'no internal account id may appear in the message');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM document').get().n, 0, 'nothing was written');
});

test('m5: a negative QUANTITY is the same defect by another route and is refused too', () => {
  const { ctx } = setup();
  const res = createDocument(ctx, {
    type: 'invoice',
    contactId: 'ct_1',
    currency: 'CHF',
    lines: [{ description: 'Rabatt', quantityMilli: -1000, unitPriceMinor: 10000, taxCode: 'UST81' }],
  });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, 'invalid_line');
  assert.equal(res.field, 'quantityMilli');
  assert.equal(res.position, 1);
});

test('m5: updateDocument cannot smuggle a negative line into an existing draft', () => {
  const { ctx, store } = setup();
  const doc = createDocument(ctx, {
    type: 'invoice',
    contactId: 'ct_1',
    currency: 'CHF',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
  });
  assert.ok(doc.ok, JSON.stringify(doc));
  const res = updateDocument(ctx, {
    documentId: doc.document.id,
    patch: { lines: [{ description: 'Rabatt', unitPriceMinor: -10000, taxCode: 'UST81' }] },
  });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, 'invalid_line');
  const line = store.db.prepare('SELECT unit_price_minor AS p FROM document_line WHERE document_id = ?').get(doc.document.id);
  assert.equal(line.p, 100000, 'the original line is untouched');
});

test('m5: a zero-price line is still legal (a free position is not a discount)', () => {
  const { ctx } = setup();
  const res = createDocument(ctx, {
    type: 'invoice',
    contactId: 'ct_1',
    currency: 'CHF',
    lines: [
      { description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' },
      { description: 'Gratis-Zugabe', unitPriceMinor: 0, taxCode: 'UST81' },
    ],
  });
  assert.equal(res.ok, true, JSON.stringify(res));
});

// --- m6: spec §7 P3, no second posting path -----------------------------------------------------

test('m6: the sales module calls postEntry EXACTLY once, and it is inside buildInvoicePosting', () => {
  const src = readFileSync(new URL('../../src/core/sales/invoice.ts', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/\bpostEntry\s*\(/g)];
  assert.equal(calls.length, 1, `A11 must have exactly ONE postEntry call site, found ${calls.length}`);

  // ...and that one call site sits inside buildInvoicePosting, not in some later verb.
  const start = src.indexOf('export function buildInvoicePosting');
  const end = src.indexOf('export const invoicePoster');
  assert.ok(start >= 0 && end > start, 'buildInvoicePosting and invoicePoster must both still exist');
  const body = src.slice(start, end);
  assert.match(body, /\bpostEntry\s*\(/, 'the single call site belongs to buildInvoicePosting');

  // No other file in the sales module may open a posting path at all.
  for (const file of ['document.ts', 'contact.ts', 'item.ts', 'qrbill.ts', 'index.ts']) {
    const other = readFileSync(new URL(`../../src/core/sales/${file}`, import.meta.url), 'utf8');
    assert.equal(/\bpostEntry\s*\(/.test(other), false, `${file} must not call postEntry`);
  }
});

test('m6: a hand-rolled postEntry with source "invoice" cannot BECOME an invoice posting', () => {
  const { ctx, store, workspaceId } = setup();
  const doc = createDocument(ctx, {
    type: 'invoice',
    contactId: 'ct_1',
    currency: 'CHF',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
  });
  const invoiceId = doc.document.id;

  // An arbitrary caller writes a balanced entry and labels it `source: 'invoice'`, even reusing the
  // idempotency key A11 would have used. `source` is a provenance LABEL on the journal entry, not a
  // capability, so this succeeds as a journal entry...
  const forged = postEntry(ctx, {
    date: '2026-07-16',
    source: 'invoice',
    ref: 'R-2026-0001',
    description: 'Rechnung R-2026-0001',
    idempotencyKey: `invoice-post-${invoiceId}`,
    lines: [
      { account: account(store, workspaceId, '1100'), debit: 108100 },
      { account: account(store, workspaceId, '3200'), credit: 108100 },
    ],
  });
  assert.equal(forged.ok, true, JSON.stringify(forged));

  // ...and yet it is NOT this invoice's posting. Nothing links it to the document.
  const row = store.db
    .prepare('SELECT status, number, posted_entry_id FROM document WHERE id = ?')
    .get(invoiceId);
  assert.equal(row.status, 'draft', 'a forged entry cannot advance the state machine');
  assert.equal(row.number, null, 'a forged entry cannot consume a gap-free number');
  assert.equal(row.posted_entry_id, null, 'a forged entry cannot become the document posting');
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM document_status_history WHERE document_id = ? AND to_status = 'issued'").get(invoiceId).n,
    0,
  );
});

test('m6: the real issue path still posts, even after a forged same-key entry exists', () => {
  const { ctx, store, workspaceId } = setup();
  const doc = createDocument(ctx, {
    type: 'invoice',
    contactId: 'ct_1',
    currency: 'CHF',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
  });
  const invoiceId = doc.document.id;
  const forged = postEntry(ctx, {
    date: '2026-07-16',
    source: 'invoice',
    description: 'squatting on the key',
    idempotencyKey: `invoice-post-${invoiceId}`,
    lines: [
      { account: account(store, workspaceId, '1100'), debit: 1 },
      { account: account(store, workspaceId, '3200'), credit: 1 },
    ],
  });
  assert.equal(forged.ok, true, 'a forged entry is still an ordinary journal entry');

  // `invoice-post-<id>` USED to be the key A11 posted under, and it is derivable from the document
  // id alone, so A02's §H-IDEMPOTENT replayed the squatter's entry back to A11 and the invoice went
  // `issued` against that CHF 0.01 entry: the receivable the QR-bill billed (CHF 1081.00) was no
  // longer the receivable the books carried, broken by a caller holding only the `post` capability.
  //
  // A11 now MINTS its posting key instead of deriving it, so the squat collides with nothing. The
  // guarantee asserted here is therefore not "the issue is refused" (that was a statement about one
  // particular remediation) but the invariant itself: the forged entry never becomes the posting,
  // and the entry the invoice does point at is the one A11 built from its own positions.
  const issue = issueInvoice(ctx, { invoiceId });
  assert.equal(issue.ok, true, `the honest path must not be deniable by a squatter: ${JSON.stringify(issue)}`);

  const row = store.db
    .prepare('SELECT status, number, posted_entry_id, subtotal_minor, tax_minor, total_minor FROM document WHERE id = ?')
    .get(invoiceId);
  assert.equal(row.status, 'issued');
  assert.equal(row.number, 'R-2026-0001');
  assert.notEqual(row.posted_entry_id, forged.entryId, 'the forged entry must NEVER become the posting');
  assert.equal(row.total_minor, 108100);

  // B-1 restated as the invariant rather than as the old one-aggregate guard: the posting is A11's
  // own, so it books the gross receivable, the net revenue AND the output VAT liability, on the
  // invoice's own date and under its own number. A CHF 0.01 impostor satisfies none of that.
  const posting = store.db
    .prepare('SELECT date, ref, source FROM journal_entry WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, row.posted_entry_id);
  assert.deepEqual(posting, { date: '2026-07-16', ref: 'R-2026-0001', source: 'invoice' });
  const net = (number) =>
    store.db
      .prepare(
        'SELECT COALESCE(SUM(base_debit_minor),0) - COALESCE(SUM(base_credit_minor),0) AS n FROM journal_line WHERE entry_id = ? AND account_id = ?',
      )
      .get(row.posted_entry_id, account(store, workspaceId, number)).n;
  assert.equal(net('1100'), row.total_minor, 'the NET receivable equals the gross the QR-bill bills');
  assert.equal(net('3200'), -row.subtotal_minor, 'revenue is credited with the invoice net');
  assert.equal(net('2200'), -row.tax_minor, 'and the output VAT liability is raised');

  // The forged entry is still there, untouched and unrelated: it moved CHF 0.01, not CHF 1081.00.
  assert.equal(net_forged(store, workspaceId, forged.entryId, account(store, workspaceId, '1100')), 1);
});

function net_forged(store, workspaceId, entryId, accountId) {
  return store.db
    .prepare(
      'SELECT COALESCE(SUM(base_debit_minor),0) - COALESCE(SUM(base_credit_minor),0) AS n FROM journal_line WHERE entry_id = ? AND account_id = ?',
    )
    .get(entryId, accountId).n;
}
