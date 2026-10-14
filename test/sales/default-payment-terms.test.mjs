/**
 * D163 (owner pick, 04.10.2026): WORKSPACE DEFAULT TERMS, the engine half.
 *
 * When a customer or supplier has no Zahlungsfrist of its own, a document falls due after the
 * workspace default set in the Firmenprofil. The due date is derived by the ENGINE, through ONE
 * function (`core/setup/paymentTerms.ts`): explicit due date, else document date + (contact terms ??
 * workspace default ?? 0). This suite holds:
 *
 *  1. the derivation over a grid (explicit, contact terms, null contact plus workspace default, both
 *     null, 0 as "due immediately"), month ends and a leap day included;
 *  2. issue stamps `due_date` when the draft stored none and keeps it when one is stored, in the same
 *     write as `issue_date`, and never re-derives an issued invoice's date when the terms change later;
 *  3. the contact column tells "not set" (null) from "due immediately" (0);
 *  4. the setting validates (0 to 365, null clears) and is tenant-scoped;
 *  5. a vendor bill recorded without a due date stores the derived one;
 *  6. a NEW workspace starts with 30 days (owner pick 07.10.2026), through every face that mints one.
 *
 * The generation-10 migration (0 becomes null) is held in `test/core/store-contact-terms-migration.test.mjs`.
 * Synthetic by construction: invented parties, amounts and dates.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createContact, updateContact, getContact, createDocument, transitionDocument } from '../../dist/core/sales/index.js';
import { recordExpense } from '../../dist/core/purchase/index.js';
import {
  deriveDueDate,
  dueDateFor,
  getCompanyProfile,
  updateCompanyProfile,
  createWorkspace,
  onboardClient,
  bootstrapWorkspace,
  PAYMENT_TERMS_MAX_DAYS,
  NEW_WORKSPACE_PAYMENT_TERMS_DAYS,
} from '../../dist/core/setup/index.js';
import { createDemoWorkspace } from '../../dist/core/onboarding/index.js';
import { getAction } from '../../dist/api/registry.js';
import { setup, secondWorkspace, AT } from '../payments/support.mjs';

const ISSUE_DAY = AT.slice(0, 10); // 2026-07-19

function customer(ctx, name, key, terms) {
  const c = createContact(ctx, {
    partyRole: 'both',
    name,
    idempotencyKey: key,
    ...(terms === undefined ? {} : { paymentTermsDays: terms }),
  });
  assert.equal(c.ok, true, JSON.stringify(c));
  return c.contact.id;
}

function draftInvoice(ctx, contactId, extra = {}) {
  const d = createDocument(ctx, {
    type: 'invoice',
    contactId,
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    ...extra,
  });
  assert.equal(d.ok, true, JSON.stringify(d));
  return d.document.id;
}

function issue(ctx, documentId, key) {
  const r = transitionDocument(ctx, { documentId, to: 'issued', idempotencyKey: key });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.document;
}

function docRow(store, id) {
  return store.db.prepare('SELECT status, issue_date, due_date FROM document WHERE id = ?').get(id);
}

function setDefault(ctx, days) {
  const r = updateCompanyProfile(ctx, { defaultPaymentTermsDays: days });
  assert.equal(r.ok, true, JSON.stringify(r));
}

// --- 1. The derivation ---------------------------------------------------------------------------

test('deriveDueDate: explicit wins, then contact terms, then the workspace default, then the document date', () => {
  const grid = [
    // [explicit, contact, workspace, documentDate, expected, source]
    ['2026-09-30', 30, 10, '2026-07-19', '2026-09-30', 'explicit'],
    [null, 30, 10, '2026-07-19', '2026-08-18', 'contact'],
    [null, null, 10, '2026-07-19', '2026-07-29', 'workspace'],
    [undefined, undefined, 10, '2026-07-19', '2026-07-29', 'workspace'],
    [null, null, null, '2026-07-19', '2026-07-19', 'document_date'],
    // 0 is "due immediately": it is the contact's own answer and the workspace default does not apply.
    [null, 0, 30, '2026-07-19', '2026-07-19', 'contact'],
    // A workspace default of 0 is a real setting too.
    [null, null, 0, '2026-07-19', '2026-07-19', 'workspace'],
    // A blank explicit date is no date.
    ['', null, 30, '2026-07-19', '2026-08-18', 'workspace'],
    // Calendar edges, UTC days: a month end, a leap day, a year end.
    [null, 30, null, '2026-01-31', '2026-03-02', 'contact'],
    [null, null, 1, '2028-02-28', '2028-02-29', 'workspace'],
    [null, null, 365, '2028-02-29', '2029-02-28', 'workspace'],
    [null, 10, null, '2026-12-31', '2027-01-10', 'contact'],
  ];
  for (const [explicit, contact, workspace, documentDate, expected, source] of grid) {
    const got = deriveDueDate({ dueDate: explicit, documentDate, contactTermsDays: contact, workspaceDefaultDays: workspace });
    assert.equal(got.dueDate, expected, JSON.stringify({ explicit, contact, workspace, documentDate }));
    assert.equal(got.source, source, JSON.stringify({ explicit, contact, workspace, documentDate }));
  }
  assert.equal(PAYMENT_TERMS_MAX_DAYS, 365);
});

test('dueDateFor reads the stored terms: contact first, the workspace default for a contact with none', () => {
  const t = setup();
  setDefault(t.ctx, null);
  const own = customer(t.ctx, 'Eigene Frist AG', 'own', 45);
  const none = customer(t.ctx, 'Keine Frist AG', 'none');
  const immediate = customer(t.ctx, 'Sofort AG', 'now', 0);
  assert.equal(dueDateFor(t.ctx, { contactId: own, documentDate: '2026-07-01' }), '2026-08-15');
  assert.equal(dueDateFor(t.ctx, { contactId: none, documentDate: '2026-07-01' }), '2026-07-01');
  setDefault(t.ctx, 20);
  assert.equal(dueDateFor(t.ctx, { contactId: own, documentDate: '2026-07-01' }), '2026-08-15');
  assert.equal(dueDateFor(t.ctx, { contactId: none, documentDate: '2026-07-01' }), '2026-07-21');
  assert.equal(dueDateFor(t.ctx, { contactId: immediate, documentDate: '2026-07-01' }), '2026-07-01');
  assert.equal(dueDateFor(t.ctx, { contactId: null, documentDate: '2026-07-01' }), '2026-07-21');
});

// --- 2. Issue stamps the due date ----------------------------------------------------------------

test('issue stamps due_date from the issue date when the draft stored none, in the same write', () => {
  const t = setup();
  setDefault(t.ctx, 10);
  const cases = [
    ['Dreissig AG', 30, '2026-08-18'],
    ['Standard AG', undefined, '2026-07-29'],
    ['Sofort AG', 0, ISSUE_DAY],
  ];
  for (const [name, terms, expected] of cases) {
    const contactId = customer(t.ctx, name, `c-${name}`, terms);
    const id = draftInvoice(t.ctx, contactId);
    assert.equal(docRow(t.store, id).due_date, null, 'the draft stores no guessed due date');
    const issued = issue(t.ctx, id, `i-${name}`);
    const row = docRow(t.store, id);
    assert.equal(row.issue_date, ISSUE_DAY);
    assert.equal(row.due_date, expected, name);
    assert.equal(issued.dueDate, expected, 'the issue response carries the stamped date');
  }
});

test('with no terms anywhere an issued invoice falls due on its issue date, as before D163', () => {
  const t = setup();
  // A workspace with no default (every workspace that existed before D163 reads null).
  setDefault(t.ctx, null);
  const id = draftInvoice(t.ctx, t.customerId);
  issue(t.ctx, id, 'plain');
  assert.equal(docRow(t.store, id).due_date, ISSUE_DAY);
});

test('a due date stored on the draft is kept at issue, terms and default notwithstanding', () => {
  const t = setup();
  setDefault(t.ctx, 10);
  const contactId = customer(t.ctx, 'Dreissig AG', 'c30', 30);
  const id = draftInvoice(t.ctx, contactId, { dueDate: '2026-12-24' });
  issue(t.ctx, id, 'kept');
  assert.equal(docRow(t.store, id).due_date, '2026-12-24');
});

test('an issued invoice keeps its due date when the terms or the default change afterwards', () => {
  const t = setup();
  setDefault(t.ctx, 10);
  const contactId = customer(t.ctx, 'Wechsel AG', 'cw');
  const id = draftInvoice(t.ctx, contactId);
  issue(t.ctx, id, 'w1');
  assert.equal(docRow(t.store, id).due_date, '2026-07-29');
  setDefault(t.ctx, 60);
  assert.equal(updateContact(t.ctx, { contactId, patch: { paymentTermsDays: 5 } }).ok, true);
  // Re-reading or re-issuing (an idempotent replay) never re-derives a stored date.
  issue(t.ctx, id, 'w1');
  assert.equal(docRow(t.store, id).due_date, '2026-07-29');
  const read = getAction('get_document').run(t.ctx, { workspaceId: t.workspaceId, documentId: id });
  assert.equal(read.document.dueDate, '2026-07-29');
});

test('a refused issue stamps nothing: the draft still has no due date', () => {
  const t = setup();
  setDefault(t.ctx, 10);
  // No lines: issue refuses `needs_lines` before the transaction.
  const empty = createDocument(t.ctx, { type: 'invoice', contactId: t.customerId, lines: [] });
  assert.equal(empty.ok, true, JSON.stringify(empty));
  const r = transitionDocument(t.ctx, { documentId: empty.document.id, to: 'issued', idempotencyKey: 'e' });
  assert.equal(r.ok, false);
  assert.deepEqual(docRow(t.store, empty.document.id), { status: 'draft', issue_date: null, due_date: null });
});

test('quotes are not given a payment due date at issue', () => {
  const t = setup();
  setDefault(t.ctx, 10);
  const q = createDocument(t.ctx, {
    type: 'quote',
    contactId: t.customerId,
    lines: [{ description: 'Offerte', unitPriceMinor: 5000, taxCode: 'UST81' }],
  });
  assert.equal(q.ok, true, JSON.stringify(q));
  const r = transitionDocument(t.ctx, { documentId: q.document.id, to: 'issued', idempotencyKey: 'q' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(docRow(t.store, q.document.id).due_date, null);
});

// --- 3. Contact terms: null is "not set", 0 is "due immediately" ---------------------------------

test('a contact created without terms stores null; 0 is stored as an explicit 0', () => {
  const t = setup();
  const none = customer(t.ctx, 'Ohne AG', 'o');
  const zero = customer(t.ctx, 'Null AG', 'z', 0);
  const raw = (id) => t.store.db.prepare('SELECT payment_terms_days AS d FROM contact WHERE id = ?').get(id).d;
  assert.equal(raw(none), null);
  assert.equal(raw(zero), 0);
  assert.equal(getContact(t.ctx, { contactId: none }).contact.paymentTermsDays, null);
  assert.equal(getContact(t.ctx, { contactId: zero }).contact.paymentTermsDays, 0);
  // The free-text parse still fills terms in.
  const parsed = createContact(t.ctx, { partyRole: 'customer', description: 'Kunde Text AG, 20 Tage', idempotencyKey: 'p' });
  assert.equal(parsed.contact.paymentTermsDays, 20);
});

test('update: null clears back to the default, 0 sets "due immediately", absent leaves the terms alone', () => {
  const t = setup();
  const id = customer(t.ctx, 'Patch AG', 'p', 30);
  assert.equal(updateContact(t.ctx, { contactId: id, patch: { name: 'Patch AG 2' } }).contact.paymentTermsDays, 30);
  assert.equal(updateContact(t.ctx, { contactId: id, patch: { paymentTermsDays: 0 } }).contact.paymentTermsDays, 0);
  assert.equal(updateContact(t.ctx, { contactId: id, patch: { paymentTermsDays: null } }).contact.paymentTermsDays, null);
  const bad = updateContact(t.ctx, { contactId: id, patch: { paymentTermsDays: -1 } });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_payment_terms_days');
  const long = updateContact(t.ctx, { contactId: id, patch: { paymentTermsDays: 366 } });
  assert.equal(long.error, 'invalid_payment_terms_days');
  assert.equal(long.max, 365);
  assert.equal(updateContact(t.ctx, { contactId: id, patch: { paymentTermsDays: 365 } }).contact.paymentTermsDays, 365);
});

test('the MCP/REST boundary accepts null for the contact terms and refuses a non-integer', () => {
  const t = setup();
  const create = getAction('create_contact');
  const made = create.run(t.ctx, { workspaceId: t.workspaceId, partyRole: 'customer', name: 'Boundary AG', paymentTermsDays: null, idempotencyKey: 'b' });
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(made.contact.paymentTermsDays, null);
  const update = getAction('update_contact');
  const refused = update.run(t.ctx, { workspaceId: t.workspaceId, contactId: made.contact.id, patch: { paymentTermsDays: 2.5 } });
  assert.equal(refused.ok, false);
});

// --- 4. The setting ------------------------------------------------------------------------------

test('the workspace default validates 0 to 365, null clears it, absent keeps it, a refusal stores nothing', () => {
  const t = setup();
  const profile = () => getCompanyProfile(t.ctx).profile;
  assert.equal(profile().defaultPaymentTermsDays, 30, 'a new workspace starts with the 30-day preset');
  for (const ok of [0, 1, 30, 365]) {
    setDefault(t.ctx, ok);
    assert.equal(profile().defaultPaymentTermsDays, ok);
  }
  setDefault(t.ctx, 30);
  for (const bad of [-1, 366, 1.5, '30', Number.NaN]) {
    const r = updateCompanyProfile(t.ctx, { name: 'Umbenannt GmbH', defaultPaymentTermsDays: bad });
    assert.equal(r.ok, false, String(bad));
    assert.equal(r.error, 'invalid_payment_terms_days');
    assert.equal(r.max, 365);
    assert.equal(profile().defaultPaymentTermsDays, 30, 'a refused value leaves the stored default');
    assert.equal(profile().name, 'Muster Grafik GmbH', 'a refusal writes no other field either');
  }
  // Absent keeps it.
  assert.equal(updateCompanyProfile(t.ctx, { name: 'Muster Grafik AG' }).ok, true);
  assert.equal(profile().defaultPaymentTermsDays, 30);
  // Null clears it.
  setDefault(t.ctx, null);
  assert.equal(profile().defaultPaymentTermsDays, null);
  // A replay of the same absolute set is the same state (the verb carries no key on purpose).
  setDefault(t.ctx, 30);
  setDefault(t.ctx, 30);
  assert.equal(profile().defaultPaymentTermsDays, 30);
});

test('the setting through the registry: typed at the boundary, read back by get_company_profile', () => {
  const t = setup();
  const update = getAction('update_company_profile');
  const read = getAction('get_company_profile');
  assert.equal(update.run(t.ctx, { workspaceId: t.workspaceId, defaultPaymentTermsDays: 30 }).ok, true);
  assert.equal(read.run(t.ctx, { workspaceId: t.workspaceId }).profile.defaultPaymentTermsDays, 30);
  const typed = update.run(t.ctx, { workspaceId: t.workspaceId, defaultPaymentTermsDays: '45' });
  assert.equal(typed.ok, false);
  assert.equal(read.run(t.ctx, { workspaceId: t.workspaceId }).profile.defaultPaymentTermsDays, 30);
  assert.equal(update.run(t.ctx, { workspaceId: t.workspaceId, defaultPaymentTermsDays: null }).ok, true);
  assert.equal(read.run(t.ctx, { workspaceId: t.workspaceId }).profile.defaultPaymentTermsDays, null);
});

test('§H-TENANT: one workspace\'s default never reaches another workspace\'s documents', () => {
  const t = setup();
  const other = secondWorkspace(t);
  setDefault(t.ctx, 45);
  setDefault(other.ctx, null);
  assert.equal(getCompanyProfile(t.ctx).profile.defaultPaymentTermsDays, 45);
  assert.equal(getCompanyProfile(other.ctx).profile.defaultPaymentTermsDays, null);
  // The neighbour's invoice falls due on its issue date; ours after 45 days.
  const theirs = draftInvoice(other.ctx, other.customerId);
  issue(other.ctx, theirs, 'theirs');
  const ours = draftInvoice(t.ctx, t.customerId);
  issue(t.ctx, ours, 'ours');
  assert.equal(docRow(t.store, theirs).due_date, ISSUE_DAY);
  assert.equal(docRow(t.store, ours).due_date, '2026-09-02');
  // A contact id from the OTHER tenant carries no terms here: the read is fenced by workspace_id, so
  // our own default (45 days) applies, never the foreign contact's 90.
  const foreign = customer(other.ctx, 'Fremd AG', 'f', 90);
  assert.equal(dueDateFor(t.ctx, { contactId: foreign, documentDate: '2026-07-01' }), '2026-08-15');
  assert.equal(dueDateFor(other.ctx, { contactId: foreign, documentDate: '2026-07-01' }), '2026-09-29');
});

// --- 5. Vendor bills -----------------------------------------------------------------------------

test('a vendor bill recorded without a due date stores the derived one', () => {
  const t = setup();
  setDefault(t.ctx, 20);
  const cases = [
    ['Lieferant Eigen', 45, '2026-07-01', '2026-08-15'],
    ['Lieferant Standard', undefined, '2026-07-01', '2026-07-21'],
    ['Lieferant Sofort', 0, '2026-07-01', '2026-07-01'],
    ['Lieferant Monatsende', undefined, '2026-01-31', '2026-02-20'],
  ];
  for (const [name, terms, billDate, expected] of cases) {
    const c = createContact(t.ctx, {
      partyRole: 'vendor',
      name,
      idempotencyKey: `v-${name}`,
      ...(terms === undefined ? {} : { paymentTermsDays: terms }),
    });
    assert.equal(c.ok, true, JSON.stringify(c));
    const r = recordExpense(t.ctx, {
      vendorId: c.contact.id,
      billDate,
      amountMinor: 108100,
      amountIsGross: true,
      taxCode: 'VST-M',
      expenseAccountId: t.acc('6500'),
      idempotencyKey: `b-${name}`,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    const row = t.store.db.prepare('SELECT due_date FROM vendor_bill WHERE id = ?').get(r.vendorBillId);
    assert.equal(row.due_date, expected, name);
  }
  // An explicit due date always wins.
  const v = createContact(t.ctx, { partyRole: 'vendor', name: 'Lieferant Explizit', idempotencyKey: 'vx', paymentTermsDays: 45 });
  const r = recordExpense(t.ctx, {
    vendorId: v.contact.id,
    billDate: '2026-07-01',
    dueDate: '2026-07-05',
    amountMinor: 1000,
    amountIsGross: true,
    expenseAccountId: t.acc('6500'),
    idempotencyKey: 'bx',
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(t.store.db.prepare('SELECT due_date FROM vendor_bill WHERE id = ?').get(r.vendorBillId).due_date, '2026-07-05');
});

// --- 6. Owner pick 07.10.2026: "Preset 30 days for new" ------------------------------------------

test('a NEW workspace starts with 30 days, through every face that mints one', () => {
  const t = setup();
  const deps = { store: t.store, clock: t.clock, ids: t.ids, actor: 'user_1' };
  const read = (workspaceId) =>
    t.store.db.prepare('SELECT default_payment_terms_days AS d FROM workspace WHERE id = ?').get(workspaceId).d;
  // The engine function every face composes, and the verbs on top of it.
  assert.equal(getCompanyProfile(t.ctx).profile.defaultPaymentTermsDays, NEW_WORKSPACE_PAYMENT_TERMS_DAYS);
  assert.equal(NEW_WORKSPACE_PAYMENT_TERMS_DAYS, 30);
  const viaVerb = getAction('create_workspace').run(deps, { name: 'Neu GmbH', idempotencyKey: 'nw' });
  assert.equal(viaVerb.ok, true, JSON.stringify(viaVerb));
  assert.equal(read(viaVerb.workspaceId), 30);
  const onboarded = onboardClient(deps, { name: 'Mandat AG', idempotencyKey: 'ob' });
  assert.equal(onboarded.ok, true, JSON.stringify(onboarded));
  assert.equal(read(onboarded.workspaceId), 30);
  const booted = bootstrapWorkspace(deps, { description: 'Atelier Muster GmbH', idempotencyKey: 'bw' });
  assert.equal(booted.ok, true, JSON.stringify(booted));
  assert.equal(read(booted.workspaceId), 30);
  const demo = createDemoWorkspace(deps, { idempotencyKey: 'demo' });
  assert.equal(demo.ok, true, JSON.stringify(demo));
  assert.equal(read(demo.workspaceId), 30);
  // An explicit null opts out at creation; an out-of-range value is refused and mints nothing.
  const none = createWorkspace(deps, { name: 'Ohne GmbH', defaultPaymentTermsDays: null });
  assert.equal(read(none.workspaceId), null);
  const before = t.store.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n;
  const bad = createWorkspace(deps, { name: 'Falsch GmbH', defaultPaymentTermsDays: 400 });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_payment_terms_days');
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n, before);
});

test('in a new workspace an invoice to a customer without terms falls due issue date + 30', () => {
  const t = setup();
  const contactId = customer(t.ctx, 'Ohne Frist AG', 'of');
  const id = draftInvoice(t.ctx, contactId);
  issue(t.ctx, id, 'n30');
  assert.equal(docRow(t.store, id).due_date, '2026-08-18');
  // A customer due immediately is not given the preset.
  const now = customer(t.ctx, 'Sofort AG', 'so', 0);
  const id2 = draftInvoice(t.ctx, now);
  issue(t.ctx, id2, 'n0');
  assert.equal(docRow(t.store, id2).due_date, ISSUE_DAY);
});
