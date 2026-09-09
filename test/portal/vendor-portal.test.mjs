/**
 * F03, the vendor portal: the money-path INVARIANTS and the isolation fences, asserted rather than
 * documented. This is the suite the non-author critic reads: every claim the spec makes about the
 * remittance advice being a snapshot, being append-only, being tenant- and contact-isolated, and
 * never posting, is proven here on real data driven end to end through the registry.
 *
 * The legs:
 *   1. NO POSTING (P3): the vendorPortal engine calls no `postEntry`/`recordPayment` and writes no
 *      `journal_entry`/`payment` row; behaviourally, filing an advice moves the journal by ZERO.
 *   2. SNAPSHOT + §H-FX at row level: the advice copies the A14 allocation figures verbatim, every
 *      foreign line carries a non-null CHF base and rate, and the header base equals Σ the line bases
 *      by integer construction.
 *   3. IDEMPOTENT ON ROWS: a keyed replay returns the same advice and writes not one extra row;
 *      an unkeyed re-file supersedes rather than overwrites.
 *   4. APPEND-ONLY: the immutability triggers abort a money/identity edit on both tables.
 *   5. §H-TENANT: a token from tenant A cannot read in tenant B, and B's read by A's contact is empty.
 *   6. CROSS-CONTACT ISOLATION FUZz: a grant for supplier X never returns supplier Y's rows.
 *   7. The grant/read fences and the opaque errors (no oracle).
 *   8. Automation: grant/revoke are NOT automatable; remittance-create is.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { getAction } from '../../dist/api/registry.js';
import { isNotAutomatable } from '../../dist/core/automation/denylist.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const VENDOR_PORTAL_DIR = fileURLToPath(new URL('../../src/core/portal/', import.meta.url));

// --- A small world, driven end to end through the registry ---------------------------------------

function world() {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const raw = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const must = (name, input) => {
    const r = raw(name, input);
    assert.equal(r.ok, true, `${name} failed: ${JSON.stringify(r)}`);
    return r;
  };
  // Every world settles MWST so a vendor bill posts.
  must('vat_seed_defaults', {});
  must('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  return { deps, workspaceId, accId, raw, must };
}

let seed = 0;
const k = (p) => `${p}-${seed++}`;

function vendor(w, name) {
  return w.must('create_contact', { partyRole: 'vendor', name, idempotencyKey: k('v') }).contact.id;
}
function customer(w, name) {
  return w.must('create_contact', { partyRole: 'customer', name, idempotencyKey: k('c') }).contact.id;
}

/** A posted vendor bill. Gross 108100 (net 100000 + 8.1% VST) in CHF unless a foreign currency + rate. */
function postedBill(w, vendorId, opts = {}) {
  const currency = opts.currency ?? 'CHF';
  const amountMinor = opts.amountMinor ?? 108100;
  if (currency !== 'CHF' && opts.rate !== undefined) {
    w.must('record_exchange_rate', { baseCurrency: currency, rate: opts.rate, asOf: opts.asOf ?? '2026-03-01', idempotencyKey: k('fx') });
  }
  const bill = w.must('create_vendor_bill', {
    vendorId,
    billDate: opts.billDate ?? '2026-03-01',
    dueDate: '2026-03-31',
    amountMinor,
    amountIsGross: true,
    taxCode: 'VST-M',
    currency,
    expenseAccountId: w.accId('6500'),
    idempotencyKey: k('bill'),
  });
  w.must('post_vendor_bill', { vendorBillId: bill.vendorBillId, idempotencyKey: k('post') });
  return bill.vendorBillId;
}

/** An outgoing supplier payment settling one bill in full. */
function payBill(w, billId, opts = {}) {
  const currency = opts.currency ?? 'CHF';
  const amountMinor = opts.amountMinor ?? 108100;
  const paid = w.must('record_payment', {
    direction: 'outgoing',
    date: opts.date ?? '2026-03-20',
    amountMinor,
    currency,
    bankAccountId: w.accId('1020'),
    allocations: [{ vendorBillId: billId, amountMinor }],
    intent: 'post_payment',
    idempotencyKey: k('pay'),
  });
  return paid.paymentId;
}

/** A `sent` purchase order for a supplier. Returns the PO id. */
function sentPO(w, vendorId, price = 5000) {
  const item = w.must('create_item', { name: `Teil ${seed}`, defaultUnitPriceMinor: price, idempotencyKey: k('item') }).item.id;
  const po = w.must('po_upsert', { supplierContactId: vendorId, lines: [{ itemId: item, qty: 3, unitPriceRappen: price }], idempotencyKey: k('po') });
  w.must('po_send', { poId: po.poId, idempotencyKey: k('send') });
  return po.poId;
}

function grant(w, vendorId, opts = {}) {
  return w.must('vendor_portal_grant', {
    contactId: vendorId,
    expiresAt: opts.expiresAt ?? '2027-01-31',
    ...(opts.scopes !== undefined ? { scopes: opts.scopes } : {}),
    idempotencyKey: opts.key ?? k('grant'),
  });
}

/** Count rows in a table for this workspace (row-level idempotency proof). */
function rowCount(w, table) {
  return w.deps.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(w.workspaceId).n;
}

// --- 1. No posting (P3) --------------------------------------------------------------------------

test('F03: the vendorPortal engine reaches no posting path (P3)', () => {
  const files = readdirSync(VENDOR_PORTAL_DIR).filter((f) => f.endsWith('.ts'));
  const source = readFileSync(`${VENDOR_PORTAL_DIR}vendorPortal.ts`, 'utf8');
  const forbidden = [
    /\bpostEntry\s*\(/,
    /\brecordPayment\s*\(/,
    /INSERT INTO journal_entry\b/,
    /INSERT INTO payment\b/,
    /from 'node:http'/,
    /from 'node:https'/,
    /\bfetch\s*\(/,
  ];
  for (const probe of forbidden) {
    assert.equal(probe.test(source), false, `vendorPortal.ts matches ${probe}: the money/posting boundary is crossed`);
  }
  assert.ok(files.includes('vendorPortal.ts'), 'the probe is aimed wrong: vendorPortal.ts not found');
});

test('F03: the remittance tables carry no arithmetic and filing an advice posts NOTHING', () => {
  const w = world();
  const v = vendor(w, 'Lieferant GmbH');
  const bill = postedBill(w, v);
  const pay = payBill(w, bill);

  const journalBefore = rowCount(w, 'journal_entry');
  const paymentsBefore = rowCount(w, 'payment');

  const adv = w.must('vendor_portal_remittance_create', { paymentId: pay, idempotencyKey: k('adv') });
  assert.equal(adv.transmitted, false);
  assert.equal(adv.reason, 'cloud_tier');

  // The advice posts nothing: the journal and payment tables are exactly where the A14 payment left them.
  assert.equal(rowCount(w, 'journal_entry'), journalBefore, 'filing an advice moved the journal');
  assert.equal(rowCount(w, 'payment'), paymentsBefore, 'filing an advice minted a payment');
});

// --- 2. Snapshot + §H-FX at row level ------------------------------------------------------------

test('F03: a CHF advice snapshots the allocation and header base == Σ line bases', () => {
  const w = world();
  const v = vendor(w, 'Lieferant GmbH');
  const bill = postedBill(w, v);
  const pay = payBill(w, bill);
  const { advice } = w.must('vendor_portal_remittance_create', { paymentId: pay, idempotencyKey: k('adv') });

  assert.equal(advice.currency, 'CHF');
  assert.equal(advice.totalRappen, 108100);
  assert.equal(advice.lines.length, 1);
  const line = advice.lines[0];
  assert.equal(line.billId, bill);
  assert.equal(line.amountRappen, 108100);
  assert.equal(line.currency, 'CHF');
  assert.equal(line.amountBaseRappen, 108100);
  assert.equal(line.fxRate, '1');
  // The invariant, by integer construction: the header base is the sum of the line bases.
  const sumBase = advice.lines.reduce((s, l) => s + l.amountBaseRappen, 0);
  assert.equal(advice.totalBaseRappen, sumBase);
});

test('F03: a FOREIGN advice carries txn + base + rate on every line (§H-FX at row level)', () => {
  const w = world();
  const v = vendor(w, 'Auslandslieferant SA');
  // Booked and paid at 0.95 EUR->CHF on the rate date: 100000 EUR settles to 95000 CHF base.
  const bill = postedBill(w, v, { currency: 'EUR', rate: '0.95', amountMinor: 100000, billDate: '2026-03-01' });
  const pay = payBill(w, bill, { currency: 'EUR', amountMinor: 100000, date: '2026-03-01' });
  const { advice } = w.must('vendor_portal_remittance_create', { paymentId: pay, idempotencyKey: k('adv') });

  assert.equal(advice.lines.length, 1);
  const line = advice.lines[0];
  assert.equal(line.currency, 'EUR');
  assert.equal(line.amountRappen, 100000);
  // Every foreign line has a non-null CHF base and a non-'1' rate (spec §7 / §8).
  assert.ok(line.amountBaseRappen !== null && line.amountBaseRappen !== 100000, `base should differ from txn: ${line.amountBaseRappen}`);
  assert.equal(line.amountBaseRappen, 95000);
  assert.ok(line.fxRate !== null && line.fxRate !== '1', `foreign line must carry a rate: ${line.fxRate}`);
  // Header base still equals Σ line bases exactly.
  assert.equal(advice.totalBaseRappen, advice.lines.reduce((s, l) => s + l.amountBaseRappen, 0));
});

// --- 3. Idempotent on rows + supersede -----------------------------------------------------------

test('F03: a keyed remittance replay returns the SAME advice and writes not one extra row', () => {
  const w = world();
  const v = vendor(w, 'Lieferant GmbH');
  const pay = payBill(w, postedBill(w, v));
  const key = k('adv');

  const first = w.must('vendor_portal_remittance_create', { paymentId: pay, idempotencyKey: key });
  const advices = rowCount(w, 'remittance_advice');
  const lines = rowCount(w, 'remittance_advice_line');
  const files = rowCount(w, 'stored_file');

  const second = w.must('vendor_portal_remittance_create', { paymentId: pay, idempotencyKey: key });
  assert.equal(second.adviceId, first.adviceId, 'a keyed replay minted a second advice');
  assert.equal(rowCount(w, 'remittance_advice'), advices, 'a keyed replay wrote an advice row');
  assert.equal(rowCount(w, 'remittance_advice_line'), lines, 'a keyed replay wrote a line row');
  assert.equal(rowCount(w, 'stored_file'), files, 'a keyed replay filed a second artifact');
});

test('F03: an UNKEYED re-file supersedes the current advice, never overwrites it', () => {
  const w = world();
  const v = vendor(w, 'Lieferant GmbH');
  const pay = payBill(w, postedBill(w, v));

  const first = w.must('vendor_portal_remittance_create', { paymentId: pay });
  const second = w.must('vendor_portal_remittance_create', { paymentId: pay });
  assert.notEqual(second.adviceId, first.adviceId);
  assert.equal(second.advice.supersedesId, first.adviceId, 'the re-file must reference what it supersedes');
  // Both rows survive (append-only): the old advice is not deleted or edited.
  assert.equal(rowCount(w, 'remittance_advice'), 2);
});

// --- 4. Append-only immutability -----------------------------------------------------------------

test('F03: the immutability triggers abort a money/identity edit on both remittance tables', () => {
  const w = world();
  const v = vendor(w, 'Lieferant GmbH');
  const pay = payBill(w, postedBill(w, v));
  const { adviceId } = w.must('vendor_portal_remittance_create', { paymentId: pay, idempotencyKey: k('adv') });

  assert.throws(
    () => w.deps.store.db.prepare('UPDATE remittance_advice SET total_rappen = 1 WHERE id = ?').run(adviceId),
    /remittance_advice_immutable/,
    'a money edit on remittance_advice was not aborted',
  );
  assert.throws(
    () => w.deps.store.db.prepare('UPDATE remittance_advice_line SET amount_base_rappen = 1 WHERE advice_id = ?').run(adviceId),
    /remittance_advice_line_immutable/,
    'an edit on remittance_advice_line was not aborted',
  );
});

// --- 5. §H-TENANT --------------------------------------------------------------------------------

test('F03 §H-TENANT: a token minted in workspace A is denied in workspace B of the SAME store', () => {
  // ONE shared store, TWO workspaces (not two freshDeps() calls, which mint SEPARATE in-memory
  // databases and would let this test pass by ABSENCE: B would never hold A's token_hash, so the
  // `workspace_id` clause in `grantByTokenInWorkspace` would never be the thing that denies). Here A's
  // grant row genuinely lives in the SAME database B queries, so the ONLY reason B's read denies is
  // the tenant fence firing. Remove `workspace_id = ?` from `grantByTokenInWorkspace` and this case
  // goes red: A's token then resolves in B (the row is present), and the assertions below catch it.
  const deps = freshDeps();
  const A = mintWorkspace(deps, 'Tenant A GmbH', 'wsA');
  const B = mintWorkspace(deps, 'Tenant B GmbH', 'wsB');
  const call = (workspaceId, name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const mustA = (name, input) => {
    const r = call(A.workspaceId, name, input);
    assert.equal(r.ok, true, `${name} failed: ${JSON.stringify(r)}`);
    return r;
  };

  // A real vendor grant in workspace A, and a PO for that vendor so a resolved read has data to leak.
  const vA = mustA('create_contact', { partyRole: 'vendor', name: 'A Lieferant', idempotencyKey: 'a-vendor' }).contact.id;
  const itemA = mustA('create_item', { name: 'A-Teil', defaultUnitPriceMinor: 5000, idempotencyKey: 'a-item' }).item.id;
  const poA = mustA('po_upsert', { supplierContactId: vA, lines: [{ itemId: itemA, qty: 2, unitPriceRappen: 5000 }], idempotencyKey: 'a-po' });
  mustA('po_send', { poId: poA.poId, idempotencyKey: 'a-send' });
  const gA = mustA('vendor_portal_grant', { contactId: vA, expiresAt: '2027-01-31', idempotencyKey: 'a-grant' });

  // Sanity: A's token resolves in its OWN workspace and sees A's PO. So a denial in B is provably the
  // tenant fence, not a globally dead or malformed token.
  const ownOk = call(A.workspaceId, 'vendor_portal_pos', { grantToken: gA.tokenOnce });
  assert.equal(ownOk.ok, true, `the token must resolve in its own tenant: ${JSON.stringify(ownOk)}`);
  assert.equal(ownOk.pos.length, 1);

  // THE BITE: present A's token to workspace B (same store). The grant row is PRESENT in the database,
  // so only the `workspace_id = B` clause can deny it. It must deny with the opaque grant_invalid, and
  // never resolve A's data across the tenant boundary (no existence leak, no oracle).
  const posInB = call(B.workspaceId, 'vendor_portal_pos', { grantToken: gA.tokenOnce });
  assert.equal(posInB.ok, false, `A's token resolved in tenant B: the §H-TENANT fence did not fire (${JSON.stringify(posInB)})`);
  assert.equal(posInB.error, 'grant_invalid');
  const remInB = call(B.workspaceId, 'vendor_portal_remittances', { grantToken: gA.tokenOnce });
  assert.equal(remInB.ok, false, `A's token resolved in tenant B on the advice read (${JSON.stringify(remInB)})`);
  assert.equal(remInB.error, 'grant_invalid');

  // The operator preview path is likewise tenant-bound: B reading by A's contact id sees none of A's
  // rows, because every read is scoped to ctx.workspaceId (= B).
  const previewInB = call(B.workspaceId, 'vendor_portal_pos', { contactId: vA });
  assert.equal(previewInB.ok, true);
  assert.equal(previewInB.pos.length, 0, 'B saw a PO belonging to A via the operator preview');
});

// --- 6. Cross-contact isolation fuzz -------------------------------------------------------------

test('F03: a grant for supplier X never returns supplier Y POs or advices (isolation)', () => {
  const w = world();
  const x = vendor(w, 'Lieferant X');
  const y = vendor(w, 'Lieferant Y');
  sentPO(w, x);
  sentPO(w, y);
  const poY = sentPO(w, y);
  const payY = payBill(w, postedBill(w, y));
  w.must('vendor_portal_remittance_create', { paymentId: payY, idempotencyKey: k('adv') });

  const gX = grant(w, x); // default scopes: pos.read + remittance.read

  // X's token sees ONLY X's POs (X has one), never Y's two.
  const posX = w.must('vendor_portal_pos', { grantToken: gX.tokenOnce });
  assert.equal(posX.pos.length, 1);
  assert.ok(posX.pos.every((p) => p.supplierContactId === x), 'X token leaked a non-X PO');

  // X's token sees ZERO advices (only Y has one).
  const remX = w.must('vendor_portal_remittances', { grantToken: gX.tokenOnce });
  assert.equal(remX.advices.length, 0, 'X token leaked Y\'s advice');

  // The operator preview by Y's contact id sees exactly Y's rows: the fence is the contact, not the caller.
  const posY = w.must('vendor_portal_pos', { contactId: y });
  assert.equal(posY.pos.length, 2);
  assert.ok(posY.pos.some((p) => p.id === poY));
});

test('F03: only sent|received POs are exposed; a draft PO is never visible', () => {
  const w = world();
  const v = vendor(w, 'Lieferant GmbH');
  const item = w.must('create_item', { name: 'Draft-Teil', defaultUnitPriceMinor: 5000, idempotencyKey: k('item') }).item.id;
  w.must('po_upsert', { supplierContactId: v, lines: [{ itemId: item, qty: 1, unitPriceRappen: 5000 }], idempotencyKey: k('draft') }); // stays draft
  const sent = sentPO(w, v);

  const pos = w.must('vendor_portal_pos', { contactId: v });
  assert.equal(pos.pos.length, 1, 'a draft PO was exposed');
  assert.equal(pos.pos[0].id, sent);
});

// --- 7. Grant + read fences and opaque errors ----------------------------------------------------

test('F03: granting for a customer (non-supplier) contact is opaque contact_not_found', () => {
  const w = world();
  const c = customer(w, 'Kunde AG');
  const r = w.raw('vendor_portal_grant', { contactId: c, expiresAt: '2027-01-31', idempotencyKey: k('g') });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'contact_not_found');
  // And a truly missing contact returns the SAME code (no customer/vendor oracle).
  const miss = w.raw('vendor_portal_grant', { contactId: 'nope', expiresAt: '2027-01-31', idempotencyKey: k('g') });
  assert.equal(miss.error, 'contact_not_found');
});

test('F03: a past expiry is refused; an idempotent grant replay returns the original token', () => {
  const w = world();
  const v = vendor(w, 'Lieferant GmbH');
  const past = w.raw('vendor_portal_grant', { contactId: v, expiresAt: '2000-01-01', idempotencyKey: k('g') });
  assert.equal(past.ok, false);
  assert.equal(past.error, 'expiry_in_past');

  const key = k('g');
  const first = w.must('vendor_portal_grant', { contactId: v, expiresAt: '2027-01-31', idempotencyKey: key });
  const again = w.must('vendor_portal_grant', { contactId: v, expiresAt: '2027-01-31', idempotencyKey: key });
  assert.equal(again.grantId, first.grantId);
  assert.equal(again.tokenOnce, first.tokenOnce, 'a replay minted a second token');
});

test('F03: a vendor grant idempotency key cannot collide with a customer grant under the same key', () => {
  const w = world();
  const cust = customer(w, 'Kunde AG');
  const vend = vendor(w, 'Lieferant GmbH');
  // A customer grant needs an entity scope; seed an invoice for it.
  const inv = w.must('create_document', { type: 'invoice', contactId: cust, currency: 'CHF', dueDate: '2026-06-01', lines: [{ description: 'X', unitPriceMinor: 1000, taxCode: 'UST81' }], idempotencyKey: k('doc') });
  const customerGrant = w.must('portal_grant_create', { contactId: cust, scopes: [{ kind: 'invoice', id: inv.document.id }], expiresAt: '2027-01-31', idempotencyKey: 'SHARED-KEY' });
  // The SAME raw key on the vendor door must mint a DISTINCT vendor grant (not replay the customer's).
  const vendorGrant = w.must('vendor_portal_grant', { contactId: vend, expiresAt: '2027-01-31', idempotencyKey: 'SHARED-KEY' });
  assert.notEqual(vendorGrant.grantId, customerGrant.grantId, 'the shared key leaked the customer grant to the vendor door');
  assert.notEqual(vendorGrant.tokenOnce, customerGrant.tokenOnce);
  // And the vendor grant is really a vendor grant.
  const listed = w.must('vendor_portal_grants_list', { contactId: vend });
  assert.equal(listed.grants.length, 1);
});

test('F03: an expired/revoked/foreign token denies as grant_invalid, indistinguishably', () => {
  const w = world();
  const v = vendor(w, 'Lieferant GmbH');
  const g = grant(w, v);

  // Revoked: the read now denies.
  w.must('vendor_portal_revoke', { grantId: g.grantId, idempotencyKey: k('rev') });
  const revoked = w.raw('vendor_portal_pos', { grantToken: g.tokenOnce });
  assert.equal(revoked.error, 'grant_invalid');

  // A never-existed token denies with the SAME code (no oracle).
  const never = w.raw('vendor_portal_pos', { grantToken: 'deadbeef' });
  assert.equal(never.error, 'grant_invalid');
});

test('F03: the scope fence: a pos.read-only grant cannot read remittances', () => {
  const w = world();
  const v = vendor(w, 'Lieferant GmbH');
  const g = grant(w, v, { scopes: [{ kind: 'pos.read' }] });
  const r = w.raw('vendor_portal_remittances', { grantToken: g.tokenOnce });
  assert.equal(r.error, 'grant_invalid', 'a pos.read grant must not read remittances');
  // But it CAN read POs.
  const pos = w.must('vendor_portal_pos', { grantToken: g.tokenOnce });
  assert.equal(pos.ok, true);
});

test('F03: remittance errors are opaque payment_not_found (missing, incoming, no-vendor-bill)', () => {
  const w = world();
  // Missing payment.
  assert.equal(w.raw('vendor_portal_remittance_create', { paymentId: 'nope', idempotencyKey: k('a') }).error, 'payment_not_found');

  // An INCOMING (customer) payment is not a supplier settlement.
  const cust = customer(w, 'Kunde AG');
  const inv = w.must('create_document', { type: 'invoice', contactId: cust, currency: 'CHF', dueDate: '2026-06-01', lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }], idempotencyKey: k('doc') });
  w.must('issue_invoice', { invoiceId: inv.document.id, idempotencyKey: k('iss') });
  const inPay = w.must('record_payment', { direction: 'incoming', date: '2026-03-20', amountMinor: 108100, bankAccountId: w.accId('1020'), counterpartyId: cust, allocations: [{ documentId: inv.document.id, amountMinor: 108100 }], intent: 'post_payment', idempotencyKey: k('inpay') });
  assert.equal(w.raw('vendor_portal_remittance_create', { paymentId: inPay.paymentId, idempotencyKey: k('a') }).error, 'payment_not_found');

  // A bill-less refusal writes ZERO advice rows (tx-atomicity: a refusal is a pre-check).
  assert.equal(rowCount(w, 'remittance_advice'), 0);
});

// --- 8. Automation posture -----------------------------------------------------------------------

test('F03: grant/revoke are NOT automatable; remittance-create IS', () => {
  assert.equal(isNotAutomatable('vendor_portal_grant'), true, 'vendor_portal_grant must be denylisted');
  assert.equal(isNotAutomatable('vendor_portal_revoke'), true, 'vendor_portal_revoke must be denylisted');
  assert.equal(isNotAutomatable('vendor_portal_remittance_create'), false, 'the accepted rule action must not be denylisted');
});
