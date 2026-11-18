// D198 RE-CUT and STATELESS CHECK: the money-path invariants (DECISIONS.md, "### D198 re-cut" and "### D198
// stateless check"): the test check at the import chokepoint on both doors (R1), the from-date floor (R2),
// incomplete documents (R3), the stateless pre-filing check (S1 to S4: a pure derived read over observed
// events, the latest stated figures, the import rows and the posted entries), the owner's answer of 12.11.2026
// (one comparison on arrival on both doors, and ONE override per event: `handled_outside` /
// `withdraw_handled`), the exact payout composition (R5), the test track (S5) and the security seams (R7).
// A person's own entry is never linked to an event: whoever handled an event outside the import says so with
// the override.
//
// SYNTHETIC DATA ONLY: the platform ("Kurswerk"), the processor ("Zahlfix"), every id (ch_inv_*, pi_inv_*,
// tr_inv_*, po_inv_*), document number, person and amount below is invented from scratch for these tests.
// Nothing is derived from a real feed, a real payout or a real bank line.
//
// Each money-path invariant is marked [INVARIANT name]; its comment names the code it guards, so a non-author
// critic can mutate that code and watch the test fail.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import {
  setSettlementSource,
  setSettlementTemplate,
  pullSettlement,
  importSettlement,
  resolveSettlementEvent,
  settlementVatFindings,
  settlementPayoutForBankLine,
  isTestEvent,
} from '../../dist/core/settlement/index.js';
import * as settlementIndex from '../../dist/core/settlement/index.js';
import { PIN_FOR_VERB } from '../../dist/core/agent/vorschlagPin.js';
import { settingsSet as setSetting } from '../../dist/core/settings/index.js';
import { postEntry } from '../../dist/core/ledger/postEntry.js';
import { reverseEntry } from '../../dist/core/ledger/index.js';
import { createAccount } from '../../dist/core/accounts/accounts.js';
import { bookBankLine } from '../../dist/core/banking/index.js';
import { getAction } from '../../dist/api/registry.js';
import { runGoverned } from '../../dist/api/agent-gate.js';
import { blankToken } from '../../dist/api/settlement-feed-host.js';
import { importLines, secondWorkspace, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { settlementWorld, setTemplate, templateKinds, must, refused, balanceOf, SYSTEM, PROCESSOR } from './support.mjs';

afterEach(assertClaimInvariantHolds);

const NOW = '2026-10-05T08:00:00.000Z';
const BASE = 'https://kurswerk.example';
const TOKEN = 'kw_test_token_0123456789abcdef';

// --- the world ------------------------------------------------------------------------------------

/** A settlement world whose person's context carries an in-memory feed answering `world.doc`. */
function recutWorld(opts = {}) {
  const t = settlementWorld();
  const tokens = new Map();
  const box = { doc: null, calls: 0 };
  const port = {
    secretStore: 'memory',
    storeToken: (ref, token) => (tokens.set(ref, token), { ok: true }),
    deleteToken: (ref) => (tokens.delete(ref), { ok: true }),
    hasToken: (ref) => tokens.has(ref),
    fetchFeed: () => {
      box.calls += 1;
      return { kind: 'response', status: 200, body: JSON.stringify(box.doc) };
    },
  };
  const fctx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: fixedClock(opts.now ?? NOW), ids: t.ids, settlementFeed: port });
  setTemplate(t);
  return { ...t, fctx, port, box, tokens };
}

const ev = (id, kind, day, amount, net, vat, refs = {}, extra = {}) => ({
  id,
  kind,
  day,
  currency: 'CHF',
  amount,
  net,
  vat: vat === null ? null : { amount: vat, code: 'PRODUCER-CODE', rate: 8.1 },
  refs,
  ...extra,
});

const docOf = (events, extra = {}) => ({ schema: 'till-settlement/v1', source: { system: SYSTEM, processor: PROCESSOR }, currency: 'CHF', events, ...extra });

/** The FILE door: import_settlement with the document. */
const fileImport = (t, events, key, extra = {}) => importSettlement(t.fctx, { settlement: docOf(events, extra), idempotencyKey: key });

/** The PULL door: save the source once, then pull the document the feed now serves. */
function pullDoc(t, events, key, extra = {}, range = { from: '2026-07-01', to: '2026-09-30' }) {
  if (t.store.db.prepare('SELECT COUNT(*) AS n FROM settlement_source WHERE workspace_id = ?').get(t.workspaceId).n === 0) {
    must(setSettlementSource(t.fctx, { system: SYSTEM, processor: PROCESSOR, baseUrl: BASE, fromDate: '2026-07-01', feedToken: TOKEN, idempotencyKey: 'src' }));
  }
  t.box.doc = docOf(events, extra);
  return pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, ...range, idempotencyKey: key });
}

const setting = (t, key, value) => must(setSetting(t.fctx, { key, value, reason: 'Testfall (erfunden)', idempotencyKey: `set-${key}-${value}` }));
const outcomeOf = (res, id) => res.events.find((e) => e.id === id);
const entryOf = (t, id) => t.store.db.prepare('SELECT entry_id FROM settlement_event WHERE workspace_id = ? AND event_id = ?').get(t.workspaceId, id)?.entry_id;
const resolve = (t, eventId, resolution, extra = {}, ctx = t.fctx) =>
  resolveSettlementEvent(ctx, { system: SYSTEM, processor: PROCESSOR, eventId, resolution, reason: 'Von Hand geprüft (erfunden)', idempotencyKey: `res-${eventId}-${resolution}-${Math.random()}`, ...extra });
const count = (t, table) => t.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(t.workspaceId).n;
/** The override (resolve_settlement_event handled_outside / withdraw_handled) of one event. */
const override = (t, eventId, resolution = 'handled_outside', ctx = t.fctx, processor = PROCESSOR) =>
  resolveSettlementEvent(ctx, { system: SYSTEM, processor, eventId, resolution, reason: 'Ausserhalb des Imports erledigt (erfunden)', idempotencyKey: `ovr-${eventId}-${resolution}-${Math.random()}` });
/** How many restatements the import logged for an event (rows `restated`, code `event_amended`). */
const restatedRows = (t, id) =>
  t.store.db.prepare("SELECT COUNT(*) AS n FROM settlement_feed_outcome WHERE workspace_id = ? AND event_id = ? AND outcome = 'restated' AND code = 'event_amended'").get(t.workspaceId, id).n;
/** The same event with other figures (by default the sale of 108.10, net 100.00, VAT 8.10). */
const restate = (e, amount = '108.10', net = '100.00', vat = '8.10') => ({ ...e, amount, net, vat: { ...e.vat, amount: vat } });

/** A real sale with VAT 8.1 %, keyed by its charge. */
const realSale = (n, day, refs = {}) => ev(`kw:sale:${n}`, 'sale', day, '54.05', '50.00', '4.05', { chargeId: `ch_inv_${n}`, paymentIntentId: `pi_inv_${n}`, test: false, ...refs });

/** A test payment of one charge: the sale, its refund, the card fee on it. */
const testPayment = (n, day) => [
  ev(`kw:sale:${n}`, 'sale', day, '21.62', '20.00', '1.62', { chargeId: `ch_inv_${n}`, paymentIntentId: `pi_inv_${n}`, test: true }),
  ev(`kw:refund:${n}`, 'refund', day, '-21.62', '-20.00', '-1.62', { chargeId: `ch_inv_${n}`, test: true }),
  ev(`zf_fee_${n}`, 'processing_fee', day, '-0.93', '-0.93', null, { chargeId: `ch_inv_${n}`, test: true }),
];

/**
 * A person's own entry for a sale of 54.05 (net 50.00, output VAT 4.05 on 3400 under UST81) on the clearing
 * account, its `ref` the event id when given. `refund: true` books the mirror (a refund's VAT), `vat: 0` books
 * the gross untaxed, `clearing` names another account for the money side.
 */
function handSale(t, { date, key, ref, net = 5000, vat = 405, refund = false, clearing = '1095', ctx = t.fctx, acc = t.acc }) {
  const money = refund ? 'credit' : 'debit';
  const other = refund ? 'debit' : 'credit';
  const lines = [
    { account: acc(clearing), [money]: net + vat },
    { account: acc('3400'), [other]: net, ...(vat !== 0 ? { taxCode: 'UST81', taxAmount: vat } : {}) },
    ...(vat !== 0 ? [{ account: acc('2200'), [other]: vat }] : []),
  ];
  return must(postEntry(ctx, { date, source: 'manual', description: 'Von Hand gebucht (erfunden)', ...(ref !== undefined ? { ref } : {}), idempotencyKey: key, lines })).entryId;
}

// ================================================================================================
// R1: a test transaction is never booked as an actual one
// ================================================================================================

test('[INVARIANT test-skip-both-doors] under settlement.test_events skip, a test sale, refund and transfer are never booked, on the pull and on a file import', () => {
  // Guards importSettlement.ts step 4 (`testSkips(e.kind, testModes) && isTestEvent(...)` answers
  // `skipped`, reason `test_event`) and its placement on the ONE door both the pull and a file pass.
  const events = [
    ...testPayment('6001', '2026-08-03'),
    ev('zf_tr_6001', 'third_party_payout', '2026-08-03', '-15.00', '-15.00', null, { chargeId: 'ch_inv_6001', transferId: 'tr_inv_6001', test: true }),
    ev('zf_trr_6001', 'third_party_payout_reversal', '2026-08-04', '15.00', '15.00', null, { transferId: 'tr_inv_6001', test: true }),
    realSale('6002', '2026-08-03'),
  ];
  for (const door of ['pull', 'file']) {
    const t = recutWorld();
    const res = door === 'pull' ? must(pullDoc(t, events, `d-${door}`)).import : must(fileImport(t, events, `d-${door}`));
    const skippedTest = res.events.filter((e) => e.reason === 'test_event').map((e) => e.id).sort();
    assert.deepEqual(skippedTest, ['kw:refund:6001', 'kw:sale:6001', 'zf_tr_6001', 'zf_trr_6001'], `${door}: the test sale, refund, transfer and reversal`);
    for (const id of skippedTest) assert.equal(entryOf(t, id), undefined, `${door}: ${id} has no entry`);
    assert.equal(outcomeOf(res, 'kw:sale:6002').outcome, 'booked', `${door}: the real sale books`);
    // The owner's answer (12.11.2026, "Book as real fees"): the card fee on the test payment books.
    assert.equal(outcomeOf(res, 'zf_fee_6001').outcome, 'booked', `${door}: the processor fee of a test payment books under test_fees book`);
  }
});

test('[INVARIANT sticky-flag] a test flag sticks across documents and every key kind (chargeId, paymentIntentId, paymentId, transferId); a later false never clears it', () => {
  // Guards flags.ts recordFlags (one row per event and key, INSERT OR IGNORE on the all-column index, a
  // later `test: false` kept beside the earlier `true`) and flaggedTest (own rows OR any row sharing a key
  // value), read by the import's test check.
  const t = recutWorld();
  // Document 1: the test facts, one key kind each.
  must(fileImport(t, [
    ev('kw:sale:7001', 'sale', '2026-08-03', '21.62', '20.00', '1.62', { chargeId: 'ch_inv_7001', test: true }),
    ev('kw:sale:7002', 'sale', '2026-08-03', '21.62', '20.00', '1.62', { paymentIntentId: 'pi_inv_7002', test: true }),
    ev('kw:sale:7003', 'sale', '2026-08-03', '21.62', '20.00', '1.62', { paymentId: 'py_inv_7003', test: true }),
    ev('zf_tr_7004', 'third_party_payout', '2026-08-03', '-15.00', '-15.00', null, { transferId: 'tr_inv_7004', test: true }),
  ], 'doc1'));
  // Document 2: the related events, each stating test: false, tied only by one key value.
  const r2 = must(fileImport(t, [
    ev('zf_fee_7001', 'processing_fee', '2026-08-04', '-0.93', '-0.93', null, { chargeId: 'ch_inv_7001', test: false }),
    ev('kw:refund:7002', 'refund', '2026-08-04', '-21.62', '-20.00', '-1.62', { paymentIntentId: 'pi_inv_7002', test: false }),
    ev('zf_tr_7003', 'third_party_payout', '2026-08-04', '-15.00', '-15.00', null, { paymentId: 'py_inv_7003', test: false }),
    ev('zf_trr_7004', 'third_party_payout_reversal', '2026-08-05', '15.00', '15.00', null, { transferId: 'tr_inv_7004', test: false }),
    // The sale itself again, now said not to be a test: the earlier true stays.
    ev('kw:sale:7001', 'sale', '2026-08-03', '21.62', '20.00', '1.62', { chargeId: 'ch_inv_7001', test: false }),
  ], 'doc2'));
  assert.equal(outcomeOf(r2, 'kw:refund:7002').reason, 'test_event', 'paymentIntentId ties the refund to the test sale');
  assert.equal(outcomeOf(r2, 'zf_tr_7003').reason, 'test_event', 'paymentId ties the transfer to the test payment');
  assert.equal(outcomeOf(r2, 'zf_trr_7004').reason, 'test_event', 'transferId ties the reversal to the test transfer');
  assert.equal(outcomeOf(r2, 'kw:sale:7001').reason, 'test_event', 'a later false never clears an earlier true');
  // The fee of a test payment books (test_fees book), yet it IS a test event.
  assert.equal(outcomeOf(r2, 'zf_fee_7001').outcome, 'booked');
  assert.equal(isTestEvent(t.fctx, 'kurswerk', 'zahlfix', 'zf_fee_7001'), true, 'chargeId ties the fee to the test sale');
  // A repeated sighting adds no flag row.
  const flags = count(t, 'settlement_feed_flag');
  must(fileImport(t, [ev('zf_trr_7004', 'third_party_payout_reversal', '2026-08-05', '15.00', '15.00', null, { transferId: 'tr_inv_7004', test: false })], 'doc3'));
  assert.equal(count(t, 'settlement_feed_flag'), flags, 'the same sighting adds nothing');
});

test('[INVARIANT test-after-stored] the test check runs AFTER the stored lookup: a stored event answers already_imported, never skipped', () => {
  // Guards the ORDER in importSettlement.ts (step 1, the stored event, before step 4, the test check).
  const t = recutWorld();
  const sale = realSale('7101', '2026-08-03');
  assert.equal(outcomeOf(must(fileImport(t, [sale], 'a')), 'kw:sale:7101').outcome, 'booked');
  const flagged = { ...sale, refs: { ...sale.refs, test: true } };
  const again = must(fileImport(t, [flagged], 'b'));
  assert.equal(outcomeOf(again, 'kw:sale:7101').outcome, 'already_imported', 'its row answers first');
  assert.equal(outcomeOf(again, 'kw:sale:7101').entryId, entryOf(t, 'kw:sale:7101'));
});

test('[INVARIANT clearing-equals-balance] with the test fees booked, the clearing account equals the processor balance on both doors; under test_fees skip it differs by the fee', () => {
  // Guards flags.ts testSkips (a processing_fee of a test payment books while settlement.test_fees is book)
  // in importSettlement.ts step 4, and its default `book` (testFeesModeOf). The file: real activity, a test
  // payment (sale, refund, the card fee on it, a test transfer and its reversal) and a bank payout of the
  // real net. The processor balance change is the import's expectedClearingChangeMinor (every event amount,
  // the payout included); once the payout's bank line is booked against 1095, 1095 must equal it.
  const events = [
    ev('kw:sale:8001', 'sale', '2026-08-03', '108.10', '100.00', '8.10', { chargeId: 'ch_inv_8001', test: false, payoutId: 'po_inv_8001' }),
    ev('zf_fee_8001', 'processing_fee', '2026-08-03', '-3.40', '-3.40', null, { chargeId: 'ch_inv_8001', test: false, payoutId: 'po_inv_8001' }),
    ev('zf_tr_8001', 'third_party_payout', '2026-08-03', '-97.30', '-97.30', null, { chargeId: 'ch_inv_8001', transferId: 'tr_inv_8001', test: false, payoutId: 'po_inv_8001' }),
    ...testPayment('8002', '2026-08-03'),
    ev('zf_tr_8002', 'third_party_payout', '2026-08-03', '-15.00', '-15.00', null, { chargeId: 'ch_inv_8002', transferId: 'tr_inv_8002', test: true }),
    ev('zf_trr_8002', 'third_party_payout_reversal', '2026-08-04', '15.00', '15.00', null, { transferId: 'tr_inv_8002', test: true }),
    ev('zf_po_8001', 'bank_payout', '2026-08-05', '-7.40', '-7.40', null, { payoutId: 'po_inv_8001' }),
  ];
  const run = (door, fees) => {
    const t = recutWorld();
    if (fees === 'skip') setting(t, 'settlement.test_fees', 'skip');
    const res = door === 'pull' ? must(pullDoc(t, events, `c-${door}`)).import : must(fileImport(t, events, `c-${door}`));
    const { lines } = importLines(t, { statementId: `zkb-${door}-${fees}`, from: '2026-08-01', to: '2026-08-31', entries: [{ ref: 'po', amountMinor: 740, cd: 'CRDT', date: '2026-08-05' }] });
    must(bookBankLine(t.fctx, { bankTxnId: lines['po'], target: { kind: 'accounts', legs: [{ accountId: t.acc('1095'), amountMinor: 740 }] }, idempotencyKey: `bank-${door}` }));
    return { t, res, clearing: balanceOf(t.store, t.workspaceId, '1095') };
  };
  for (const door of ['pull', 'file']) {
    const booked = run(door, 'book');
    assert.equal(booked.res.reconciliation.expectedClearingChangeMinor, -93, 'the processor balance moved by the test card fee');
    assert.equal(booked.clearing, booked.res.reconciliation.expectedClearingChangeMinor, `${door}: 1095 equals the processor balance`);
    const f = settlementVatFindings(booked.t.fctx, '2026-07-01', '2026-09-30');
    assert.equal(f.testActivity.testResidueMinor, 0, `${door}: the sale nets against its refund, the transfer against its reversal`);
    assert.deepEqual(f.testActivity.unrefundedTestSales, []);
    assert.deepEqual(f.testActivity.unreversedTestTransfers, []);
    // The negative: under test_fees skip the fee stays off 1095, and the residue is minus the fee.
    const skipped = run(door, 'skip');
    assert.equal(skipped.clearing, 0, `${door}: the fee is not on 1095`);
    assert.equal(skipped.clearing - skipped.res.reconciliation.expectedClearingChangeMinor, 93, `${door}: 1095 differs from the balance by minus the fee`);
    assert.equal(settlementVatFindings(skipped.t.fctx, '2026-07-01', '2026-09-30').testActivity.testResidueMinor, 93, `${door}: R4 states the residue: minus the fee`);
  }
});

test('an unrefunded test sale and an unreversed test transfer are listed; a test-skipped sale with VAT is shown, never hidden', () => {
  // Guards vatFindings.ts testActivity (unrefundedTestSales, unreversedTestTransfers) and testExcluded
  // (security review: a crafted test flag on a real sale must show its VAT).
  const t = recutWorld();
  must(fileImport(t, [
    ev('kw:sale:8101', 'sale', '2026-08-03', '54.05', '50.00', '4.05', { chargeId: 'ch_inv_8101', test: true }),
    ev('zf_tr_8101', 'third_party_payout', '2026-08-03', '-15.00', '-15.00', null, { chargeId: 'ch_inv_8101', transferId: 'tr_inv_8101', test: true }),
  ], 'u'));
  const f = settlementVatFindings(t.fctx, '2026-07-01', '2026-09-30');
  assert.deepEqual(f.testActivity.unrefundedTestSales.map((s) => [s.eventId, s.refundedMinor, s.pullId]), [['kw:sale:8101', 0, null]], 'a file import carries no pull id');
  assert.deepEqual(f.testActivity.unreversedTestTransfers.map((s) => s.eventId), ['zf_tr_8101']);
  assert.deepEqual(f.testExcluded, { sale: { events: 1, vatMinor: 405 }, refund: { events: 0, vatMinor: 0 }, input: { events: 0, vatMinor: 0 } });
  assert.equal(f.testActivity.testResidueMinor, -(5405 - 1500));
  assert.equal(f.hasFindings, true);
});

test('a test sale and its full refund with VAT still raise hasFindings, and a test transfer carrying input VAT is counted (security review: never net signed VAT)', () => {
  // Guards vatFindings.ts testExcluded (every test-excluded event of the period with a non-zero VAT, per
  // bucket sale, refund, input) and hasFindings reading the event COUNTS, never a signed VAT sum.
  const t = recutWorld();
  must(fileImport(t, [
    ...testPayment('8201', '2026-08-03').slice(0, 2),
    ev('zf_tr_8201', 'third_party_payout', '2026-08-03', '-16.22', '-15.00', '-1.22', { chargeId: 'ch_inv_8201', transferId: 'tr_inv_8201', test: true }),
    ev('zf_trr_8201', 'third_party_payout_reversal', '2026-08-04', '16.22', '15.00', '1.22', { transferId: 'tr_inv_8201', test: true }),
  ], 'pair'));
  const f = settlementVatFindings(t.fctx, '2026-07-01', '2026-09-30');
  assert.deepEqual(f.testExcluded, {
    sale: { events: 1, vatMinor: 162 },
    refund: { events: 1, vatMinor: -162 },
    input: { events: 2, vatMinor: 0 },
  });
  assert.equal(f.hasFindings, true, 'equal and opposite VAT never hides the events');
});

// ================================================================================================
// R2 and R3: the from-date floor and incomplete documents
// ================================================================================================

test('[INVARIANT from-date-floor] an event dated before the source from-date is never booked, on the pull and on a file; a stored one still answers', () => {
  // Guards importSettlement.ts step 3 (`fromDate !== null && e.day < fromDate`, from the settlement_source
  // row) on the one door, and its place AFTER the stored lookup.
  const early = realSale('9001', '2026-06-20');
  const late = realSale('9002', '2026-07-02');
  for (const door of ['pull', 'file']) {
    const t = recutWorld();
    if (door === 'file') must(setSettlementSource(t.fctx, { system: SYSTEM, processor: PROCESSOR, baseUrl: BASE, fromDate: '2026-07-01', idempotencyKey: 'src' }));
    // A member re-emitted with a payout carries a day before the from-date (refs.outOfRange).
    const res = door === 'pull' ? must(pullDoc(t, [early, late], 'f')).import : must(fileImport(t, [early, late], 'f'));
    assert.equal(outcomeOf(res, 'kw:sale:9001').reason, 'before_from_date', door);
    assert.equal(entryOf(t, 'kw:sale:9001'), undefined, door);
    assert.equal(outcomeOf(res, 'kw:sale:9002').outcome, 'booked', door);
    // R4 counts it with its VAT, never lists it.
    const f = settlementVatFindings(t.fctx, '2026-04-01', '2026-06-30');
    assert.deepEqual(f.beforeFromDate, { count: 1, vatMinor: 405 }, door);
    assert.deepEqual(f.missing, [], door);
  }
  // A stored event still answers as stored after a later from-date is saved.
  const t = recutWorld();
  must(fileImport(t, [early], 'before'));
  must(setSettlementSource(t.fctx, { system: SYSTEM, processor: PROCESSOR, baseUrl: BASE, fromDate: '2026-07-01', idempotencyKey: 'src-late' }));
  assert.equal(outcomeOf(must(fileImport(t, [early], 'after')), 'kw:sale:9001').outcome, 'already_imported');
});

test('[INVARIANT incomplete] complete:false is refused whole on the file door, and the pull keeps sightings only (flags and payout links), books nothing and covers no day', () => {
  // Guards importSettlement.ts prepare (`settlement_incomplete` before anything) and source.ts pullSettlement
  // (the `complete === false` branch: recordFlags + recordPayoutRefs, no observed row, outcome `incomplete`).
  const events = [realSale('9101', '2026-08-03', { payoutId: 'po_inv_9101', test: true }), ev('zf_po_9101', 'bank_payout', '2026-08-05', '-54.05', '-54.05', null, { payoutId: 'po_inv_9101' })];
  const t = recutWorld();
  const tables = ['settlement_feed_flag', 'settlement_feed_event', 'settlement_feed_payout_ref', 'settlement_feed_outcome', 'settlement_event', 'journal_entry', 'idempotency'];
  const snap = () => Object.fromEntries(tables.map((x) => [x, count(t, x)]));
  const before = snap();
  refused(fileImport(t, events, 'inc', { complete: false }), 'settlement_incomplete');
  assert.deepEqual(snap(), before, 'a refused file writes nothing');
  const r = must(pullDoc(t, events, 'inc-pull', { complete: false }));
  assert.equal(r.complete, false);
  assert.equal(r.import, null);
  assert.ok(count(t, 'settlement_feed_flag') > before.settlement_feed_flag, 'the flags are kept');
  assert.equal(count(t, 'settlement_feed_payout_ref'), 2, 'the payout links are kept');
  assert.equal(count(t, 'settlement_feed_event'), 0, 'no figure is frozen from it');
  assert.equal(count(t, 'settlement_event'), 0, 'nothing is booked');
  const pull = t.store.db.prepare('SELECT outcome FROM settlement_pull WHERE workspace_id = ?').get(t.workspaceId);
  assert.equal(pull.outcome, 'incomplete');
  assert.deepEqual(settlementVatFindings(t.fctx, '2026-07-01', '2026-09-30').uncoveredSources[0].gaps, [{ from: '2026-07-01', to: '2026-09-30' }], 'it covers no day');
  // The sticky flag from the incomplete document already reaches a later complete one.
  const later = must(pullDoc(t, [realSale('9101', '2026-08-03', { payoutId: 'po_inv_9101', test: false })], 'later'));
  assert.equal(outcomeOf(later.import, 'kw:sale:9101').reason, 'test_event');
});

test('a refused file import and a replayed one leave no flag, no observed row and no payout link behind (security review)', () => {
  // Guards importSettlement.ts: recordFlags, recordObserved and recordPayoutRefs run inside the memo, after
  // every whole-file check of `prepare`.
  const t = recutWorld();
  const tables = ['settlement_feed_flag', 'settlement_feed_event', 'settlement_feed_payout_ref'];
  const snap = () => tables.map((x) => count(t, x));
  const events = [realSale('9201', '2026-08-03', { payoutId: 'po_inv_9201' }), ev('zf_res_9201', 'reserve', '2026-08-03', '-1.00', '-1.00', null)];
  const empty = snap();
  refused(fileImport(t, events, 'r1', { schema: 'till-settlement/v0' }), 'unsupported_schema');
  refused(importSettlement(t.fctx, { settlement: { ...docOf(events), source: { system: 'Fremd', processor: 'Niemand' } }, idempotencyKey: 'r2' }), 'settlement_template_missing');
  refused(fileImport(t, events, 'r3', { complete: false }), 'settlement_incomplete');
  assert.deepEqual(snap(), empty, 'refused imports write nothing');
  must(fileImport(t, events, 'ok'));
  const once = snap();
  must(fileImport(t, events, 'ok'));
  assert.deepEqual(snap(), once, 'a replay of the same key writes nothing');
});

// ================================================================================================
// S1: the stateless check, one signed count over the linked entries (D198 stateless check)
// ================================================================================================

/** A template that leaves sales and refunds to a person: the import books neither. */
function attentionSales(t, extra = {}) {
  must(setSettlementTemplate(t.ctx, {
    system: SYSTEM, processor: PROCESSOR, clearingAccountId: t.acc('1095'),
    kinds: { ...templateKinds(t), sale: { action: 'attention' }, refund: { action: 'attention' }, ...extra },
    idempotencyKey: `tpl-attention-${Math.random()}`,
  }));
}

const Q3 = ['2026-07-01', '2026-09-30'];
const Q4 = ['2026-10-01', '2026-12-31'];
const Q1 = ['2027-01-01', '2027-03-31'];
const check = (t, [from, to], ctx = t.fctx) => settlementVatFindings(ctx, from, to);
const reasonsOf = (list) => list.map((i) => [i.eventId, i.reason, i.figure]);

test('[INVARIANT missing-no-entry] an in-scope sale with no linked entry is missing, with its VAT summed per kind', () => {
  // Guards vatFindings.ts `if (figure <= 0) found.push(item('missing', entries))` and the missingVatMinor sum.
  const t = recutWorld();
  attentionSales(t);
  must(fileImport(t, [realSale('3001', '2026-08-03'), realSale('3002', '2026-09-03')], 'imp'));
  const f = check(t, Q3);
  assert.deepEqual(reasonsOf(f.missing), [['kw:sale:3001', 'missing', 0], ['kw:sale:3002', 'missing', 0]]);
  assert.deepEqual(f.missing[0].entries, []);
  assert.deepEqual(f.missingVatMinor, { sale: 810, refund: 0, input: 0 });
  assert.equal(f.missingCount, 2);
  assert.equal(f.hasFindings, true);
  // An event dated in Q3 is EARLIER in Q4, with the same word.
  assert.deepEqual(reasonsOf(check(t, Q4).earlier), [['kw:sale:3001', 'missing', 0], ['kw:sale:3002', 'missing', 0]]);
});

test('[INVARIANT booked-once] an event the import booked once is listed nowhere, in its period and in every later one', () => {
  // Guards vatFindings.ts the figure (signedCountThrough of the import entry) and the `figure >= 2` boundary:
  // exactly 1 lists nothing, in its period and in every later one.
  const t = recutWorld();
  must(fileImport(t, [realSale('3101', '2026-08-03')], 'imp'));
  const lists = (f) => [f.missing, f.bookedTwice, f.amended, f.overrideCheck, f.earlier];
  assert.deepEqual(lists(check(t, Q3)), [[], [], [], [], []], 'the import booked it once');
  assert.deepEqual(lists(check(t, Q4)), [[], [], [], [], []], 'and it stays booked once later');
  assert.equal(check(t, Q3).hasFindings, false);
});

test('[INVARIANT booked-twice] the import entry reversed after the period and that reversal reversed inside it: the period lists booked_twice with the import entry; a later period lists nothing', () => {
  // Guards vatFindings.ts `figure >= 2` listing `booked_twice` with the import entry, and the figure read
  // through the period's end only.
  const t = recutWorld();
  must(fileImport(t, [realSale('3201', '2026-08-03')], 'imp'));
  const x = entryOf(t, 'kw:sale:3201');
  const r1 = must(reverseEntry(t.fctx, { entryId: x, date: '2026-10-02', idempotencyKey: 'r1' })).reversalId;
  assert.equal(reverseEntry(t.fctx, { entryId: r1, date: '2026-09-20', idempotencyKey: 'r2' }).ok, true);
  const q3 = check(t, Q3);
  assert.deepEqual(reasonsOf(q3.bookedTwice), [['kw:sale:3201', 'booked_twice', 2]]);
  assert.deepEqual(q3.bookedTwice[0].entries.map((e) => [e.entryId, e.link]), [[x, 'import']]);
  assert.deepEqual([q3.missing, q3.hasFindings], [[], true]);
  assert.deepEqual(check(t, Q4).earlier, [], 'Q4: +1 -1 +1: booked once');
});

test('[INVARIANT signed-sum] the figure is a signed sum through the period end, never a parity: a reversal of the reversal dated before its target counts twice', () => {
  // Guards reversalChain.ts signedCountThrough (+1 at even depths, -1 at odd ones, only members dated <= the
  // day) as read by vatFindings.ts countThrough.
  const t = recutWorld();
  must(fileImport(t, [realSale('3301', '2026-08-03')], 'imp'));
  const x = entryOf(t, 'kw:sale:3301');
  must(reverseEntry(t.fctx, { entryId: x, date: '2026-10-02', idempotencyKey: 'rev-q4' }));
  assert.deepEqual(check(t, Q3).missing, [], 'Q3: +1 through 30.09');
  assert.deepEqual(reasonsOf(check(t, Q4).earlier), [['kw:sale:3301', 'missing', 0]], 'Q4: +1 -1 = 0');
  const rev = t.store.db.prepare('SELECT id FROM journal_entry WHERE workspace_id = ? AND reverses_entry_id = ?').get(t.workspaceId, x).id;
  must(reverseEntry(t.fctx, { entryId: rev, date: '2026-10-03', idempotencyKey: 'rev-rev' }));
  assert.deepEqual(check(t, Q4).earlier, [], 'Q4: +1 -1 +1 = 1');
  // Not a parity: X (+1, Q3), R1 reverses X dated in Q4, R2 reverses R1 dated in Q3 (+1, before its target).
  const u = recutWorld();
  must(fileImport(u, [realSale('3302', '2026-08-03')], 'imp'));
  const r1 = must(reverseEntry(u.fctx, { entryId: entryOf(u, 'kw:sale:3302'), date: '2026-10-02', idempotencyKey: 'r1' })).reversalId;
  assert.equal(reverseEntry(u.fctx, { entryId: r1, date: '2026-09-20', idempotencyKey: 'r2' }).ok, true);
  assert.deepEqual(reasonsOf(check(u, Q3).bookedTwice), [['kw:sale:3302', 'booked_twice', 2]]);
});

test('[INVARIANT no-ref-link] a person\'s own entry never clears an event, whatever its ref (the event id, the document number), and another event\'s import entry never does', () => {
  // Guards vatFindings.ts (the figure reads the event's OWN import entry only: no ref matching) and
  // importSettlement.ts (no step looks for a person's entry: the import books an event a hand entry names).
  const t = recutWorld();
  attentionSales(t, { refund: { action: 'book', accountId: t.acc('3400'), taxCode: 'UST81' } });
  const doc = { type: 'client_invoice', number: 'KW-R-3501' };
  must(fileImport(t, [
    { ...realSale('3501', '2026-08-03'), document: doc },
    ev('kw:refund:3501', 'refund', '2026-08-04', '-54.05', '-50.00', '-4.05', { chargeId: 'ch_inv_3501' }, { document: doc }),
    // A producer that numbers a refund with the sale's event id: the refund's import entry carries that ref.
    ev('kw:refund:3502', 'refund', '2026-08-05', '-54.05', '-50.00', '-4.05', { chargeId: 'ch_inv_3502' }, { document: { type: 'client_credit_note', number: 'kw:sale:3502' } }),
    realSale('3502', '2026-08-03'),
  ], 'imp'));
  assert.equal(t.store.db.prepare('SELECT ref FROM journal_entry WHERE id = ?').get(entryOf(t, 'kw:refund:3502')).ref, 'kw:sale:3502');
  // Hand entries carrying the sale's VAT, under the invoice number and under the event id.
  handSale(t, { date: '2026-08-03', key: 'by-number', ref: 'KW-R-3501' });
  handSale(t, { date: '2026-08-03', key: 'by-id', ref: 'kw:sale:3501' });
  const f = check(t, Q3);
  assert.deepEqual(reasonsOf(f.missing), [['kw:sale:3501', 'missing', 0], ['kw:sale:3502', 'missing', 0]], 'no entry of a person or of another event clears a sale');
  // The import books an event a hand entry already names by ref: the person says so with the override instead.
  const u = recutWorld();
  handSale(u, { date: '2026-08-03', key: 'h', ref: 'kw:sale:3503' });
  assert.equal(outcomeOf(must(fileImport(u, [realSale('3503', '2026-08-03')], 'imp')), 'kw:sale:3503').outcome, 'booked');
});

test('[INVARIANT amended] an import booking that does not carry the latest stated figures stays amended through an unreadable re-send and a template switched to skip or attention; it clears when the booked figures are stated again, or by reversing and overriding', () => {
  // Guards vatFindings.ts `amended` (the import entry counts exactly 1 and its settlement_event figures differ
  // from the latest stated ones, restated.ts foldStated) and importSettlement.ts step 1 (a stored event whose
  // arrival differs from its booked figures refuses event_amended BEFORE the template's skip answer).
  const t = recutWorld();
  const sale = realSale('3601', '2026-08-03');
  must(pullDoc(t, [sale], 'p1'));
  const restated = restate(sale);
  must(pullDoc(t, [restated], 'p2'));
  const amended = (period = Q3) => {
    const f = check(t, period);
    return [...f.amended, ...f.earlier.filter((i) => i.reason === 'amended')].map((i) => [i.eventId, i.reason, i.figure]);
  };
  assert.deepEqual(amended(), [['kw:sale:3601', 'amended', 1]]);
  assert.deepEqual(check(t, Q3).amended[0].changed.map((c) => [c.field, c.was, c.now]), [['amountMinor', 5405, 10810], ['netMinor', 5000, 10000], ['vatMinor', 405, 810]]);
  // An unreadable re-send states nothing.
  must(pullDoc(t, [{ ...restated, amount: '99.99' }], 'p3'));
  assert.deepEqual(amended(), [['kw:sale:3601', 'amended', 1]], 'an unreadable re-send clears nothing');
  // The template switched to skip, then to attention: the stored event still answers event_amended.
  for (const action of ['skip', 'attention']) {
    must(setSettlementTemplate(t.ctx, { system: SYSTEM, processor: PROCESSOR, clearingAccountId: t.acc('1095'), kinds: { ...templateKinds(t), sale: { action } }, idempotencyKey: `tpl-${action}` }));
    const o = outcomeOf(must(pullDoc(t, [restated], `p-${action}`)).import, 'kw:sale:3601');
    assert.deepEqual([o.outcome, o.code], ['refused', 'event_amended'], action);
    assert.deepEqual(amended(), [['kw:sale:3601', 'amended', 1]], `${action}: a template switched away clears nothing`);
  }
  assert.deepEqual(amended(Q4), [['kw:sale:3601', 'amended', 1]], 'listed as an earlier event later');
  // The producer states the booked figures again: the booking carries the latest stated figures.
  must(fileImport(t, [sale], 'booked-figures'));
  assert.deepEqual(amended(), [], 'the latest stated figures are the booked ones');
  // Restated once more; the correction: reverse the import entry, book by hand, and say so with the override.
  must(fileImport(t, [restated], 'again'));
  assert.deepEqual(amended(), [['kw:sale:3601', 'amended', 1]]);
  must(reverseEntry(t.fctx, { entryId: entryOf(t, 'kw:sale:3601'), date: '2026-08-03', idempotencyKey: 'fix-rev' }));
  assert.deepEqual(reasonsOf(check(t, Q3).missing), [['kw:sale:3601', 'missing', 0]], 'the reversed booking is missing');
  handSale(t, { date: '2026-08-03', key: 'fix-book', net: 10000, vat: 810 });
  must(override(t, 'kw:sale:3601'));
  const f = check(t, Q3);
  assert.deepEqual([f.amended, f.missing, f.overrideCheck, f.bookedTwice], [[], [], [], []], 'cleared by the correction');
  assert.deepEqual(amended(Q4), []);
});

test('[INVARIANT booked-test] a test event with a booking standing is listed bookedTest: via not_test then reopen_test, and via a later sticky flag', () => {
  // Guards vatFindings.ts `bookedTest` (`testModes.events === 'skip' && testExcluded && figure >= 1`), placed
  // BEFORE the test exclusion leaves the scope (paper critic H1: the exclusion removes from `missing` only).
  const t = recutWorld();
  const [sale] = testPayment('3701', '2026-08-03');
  assert.equal(outcomeOf(must(fileImport(t, [sale], 'a')), 'kw:sale:3701').reason, 'test_event');
  assert.deepEqual(check(t, Q3).bookedTest, []);
  must(resolve(t, 'kw:sale:3701', 'not_test'));
  assert.equal(outcomeOf(must(fileImport(t, [sale], 'b')), 'kw:sale:3701').outcome, 'booked', 'not_test books what was skipped');
  assert.deepEqual(check(t, Q3).bookedTest, []);
  must(resolve(t, 'kw:sale:3701', 'reopen_test'));
  const f = check(t, Q3);
  assert.deepEqual(f.bookedTest.map((b) => [b.eventId, b.figure, b.entries.map((e) => e.link)]), [['kw:sale:3701', 1, ['import']]]);
  assert.deepEqual(f.missing, [], 'never missing: a test event');
  assert.equal(f.hasFindings, true);
  // A real sale booked, then a later document flags its transaction test (sticky).
  must(fileImport(t, [realSale('3702', '2026-08-04')], 'c'));
  must(fileImport(t, [ev('kw:refund:3702', 'refund', '2026-08-05', '-54.05', '-50.00', '-4.05', { chargeId: 'ch_inv_3702', test: true })], 'd'));
  assert.deepEqual(check(t, Q3).bookedTest.map((b) => b.eventId).sort(), ['kw:sale:3701', 'kw:sale:3702']);
  // Reversing the booking clears it.
  must(reverseEntry(t.fctx, { entryId: entryOf(t, 'kw:sale:3702'), date: '2026-08-04', idempotencyKey: 'rev' }));
  assert.deepEqual(check(t, Q3).bookedTest.map((b) => b.eventId), ['kw:sale:3701']);
});

test('[INVARIANT reader-refused] a sale the READER refused is missing on both doors from the log, stays after the overlap moved on, and clears by the override', () => {
  // Guards vatFindings.ts eventsOf (the reader refusals of the log, never observed, never booked; observed
  // beats refused), the override test of the `missing` branch, and resolution.ts wasSeen (a refusal is in
  // the log only).
  const broken = { ...realSale('3801', '2026-08-03'), amount: '55.05' }; // amount is not net + VAT: amount_mismatch
  for (const door of ['pull', 'file']) {
    const t = recutWorld();
    if (door === 'pull') must(pullDoc(t, [broken, realSale('3802', '2026-08-04')], 'p1'));
    else must(fileImport(t, [broken, realSale('3802', '2026-08-04')], 'f1'));
    const listed = () => check(t, Q3).missing.map((i) => [i.eventId, i.code, i.kind, i.day, i.amountMinor]);
    assert.deepEqual(listed(), [['kw:sale:3801', 'amount_mismatch', 'sale', '2026-08-03', 5505]], door);
    if (door === 'pull') {
      must(pullDoc(t, [realSale('3803', '2026-09-20')], 'p2', {}, { from: '2026-09-01', to: '2026-09-30' }));
      assert.deepEqual(listed().map((x) => x[0]), ['kw:sale:3801'], 'still listed after the overlap moved past it');
    }
    assert.deepEqual(reasonsOf(check(t, Q4).earlier), [['kw:sale:3801', 'missing', 0]], `${door}: earlier in Q4`);
    must(override(t, 'kw:sale:3801'));
    assert.deepEqual(listed(), [], `${door}: handled outside the import`);
    must(override(t, 'kw:sale:3801', 'withdraw_handled'));
    assert.deepEqual(listed().map((x) => x[0]), ['kw:sale:3801'], `${door}: listed again once withdrawn`);
  }
  // Observed beats refused: re-sent readable, it is taken from its observed row (and booked).
  const t = recutWorld();
  must(pullDoc(t, [broken], 'p1'));
  must(pullDoc(t, [realSale('3801', '2026-08-03')], 'p2'));
  assert.deepEqual(check(t, Q3).missing, []);
});

test('[INVARIANT undated-refusal] an id-bearing refusal without a readable day is listed in every period until it is overridden', () => {
  // Guards vatFindings.ts the undated branch (`e.day === null`: listed `missing` unless an override is
  // active) and the `e.day !== null && e.day > periodEnd` guard that must not drop it.
  const t = recutWorld();
  must(pullDoc(t, [{ ...realSale('3901', '2026-08-03'), day: '03.08.2026' }], 'p1'));
  for (const period of [Q3, Q4, Q1, ['2026-01-01', '2026-03-31']]) {
    assert.deepEqual(check(t, period).missing.map((i) => [i.eventId, i.code, i.day]), [['kw:sale:3901', 'invalid_day', null]], period[0]);
  }
  must(override(t, 'kw:sale:3901'));
  for (const period of [Q3, Q4, Q1]) assert.deepEqual(check(t, period).missing, [], `${period[0]}: overridden`);
  must(override(t, 'kw:sale:3901', 'withdraw_handled'));
  assert.deepEqual(check(t, Q4).missing.map((i) => i.eventId), ['kw:sale:3901'], 'listed again once withdrawn');
});

test('unplaceable: a refusal without an id is counted per period from every document, deduped, and never clears', () => {
  // Guards vatFindings.ts UNPLACEABLE (id-less reader refusals, day in P or undated, deduped by source, kind,
  // day, amount and code).
  const t = recutWorld();
  const idless = { ...realSale('x', '2026-08-06'), id: '' };
  must(pullDoc(t, [idless, realSale('3951', '2026-08-03')], 'p1'));
  must(pullDoc(t, [idless], 'p2'));
  must(fileImport(t, [{ ...idless, day: '2026-10-06' }], 'f1'));
  const f = check(t, Q3);
  assert.deepEqual(f.unplaceable, { count: 1, items: [{ system: 'kurswerk', processor: 'zahlfix', code: 'missing_id', kind: 'sale', day: '2026-08-06', amountMinor: 5405 }] });
  assert.equal(f.hasFindings, true);
  assert.equal(check(t, Q4).unplaceable.count, 1, 'its own period only');
});

test('[INVARIANT override-skips-import] the import never books an event a person marked handled outside, on both doors; withdrawn, the next document books it', () => {
  // Guards importSettlement.ts step 2 (`activeOverridesOf(...).has(e.id)` answers `skipped`, reason
  // `handled_outside`, after the stored lookup and before the from-date, test and template steps).
  for (const door of ['pull', 'file']) {
    const t = recutWorld();
    attentionSales(t);
    const run = (key) => (door === 'pull' ? must(pullDoc(t, [realSale('4001', '2026-08-03')], key)).import : must(fileImport(t, [realSale('4001', '2026-08-03')], key)));
    assert.equal(outcomeOf(run('seen'), 'kw:sale:4001').reason, 'needs_attention');
    must(override(t, 'kw:sale:4001'));
    setTemplate(t, t.ctx, t.acc, `tpl-book-${door}`);
    const o = outcomeOf(run('again'), 'kw:sale:4001');
    assert.deepEqual([o.outcome, o.reason], ['skipped', 'handled_outside'], door);
    assert.equal(entryOf(t, 'kw:sale:4001'), undefined, `${door}: no import entry`);
    assert.equal(check(t, Q3).hasFindings, false, `${door}: nothing listed`);
    must(override(t, 'kw:sale:4001', 'withdraw_handled'));
    assert.equal(outcomeOf(run('after'), 'kw:sale:4001').outcome, 'booked', `${door}: withdrawn, it books`);
    const f = check(t, Q3);
    assert.deepEqual([f.missing, f.bookedTwice, f.overrideCheck], [[], [], []], `${door}: booked once`);
  }
});

test('[INVARIANT override-hides] a missing event a person marked handled outside the import is listed nowhere, in its period and later, and books nothing; only a person may set it', () => {
  // Guards vatFindings.ts `if (override === undefined) found.push(item('missing', entries))` with
  // resolution.ts activeOverridesOf (the latest row per event decides), and resolution.ts (the override
  // writes no entry; human-only; the event must have been seen).
  const t = recutWorld();
  attentionSales(t);
  must(fileImport(t, [realSale('5101', '2026-08-03'), realSale('5102', '2026-08-04')], 'imp'));
  const entries = count(t, 'journal_entry');
  const r = must(override(t, 'kw:sale:5101'));
  assert.deepEqual([r.resolution, r.events], ['handled_outside', []]);
  assert.equal(count(t, 'journal_entry'), entries, 'the override books nothing');
  const f = check(t, Q3);
  assert.deepEqual(reasonsOf(f.missing), [['kw:sale:5102', 'missing', 0]]);
  assert.deepEqual(f.missingVatMinor, { sale: 405, refund: 0, input: 0 });
  assert.deepEqual(f.overrideCheck, []);
  assert.deepEqual(check(t, Q4).earlier.map((i) => i.eventId), ['kw:sale:5102'], 'and later');
  const agent = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: fixedClock(NOW), ids: t.ids });
  refused(override(t, 'kw:sale:5102', 'handled_outside', agent), 'human_only');
  refused(override(t, 'kw:sale:9999'), 'event_not_observed');
  assert.equal(count(t, 'settlement_event_override'), 1, 'a refusal writes nothing');
});

test('[INVARIANT override-withdrawn-relists] withdraw_handled lists the event missing again; a withdrawal without an active override is refused; set again, it hides again', () => {
  // Guards resolution.ts activeOverridesOf (a later `withdraw_handled` row ends the override) and the
  // `override_not_active` refusal, read by vatFindings.ts.
  const t = recutWorld();
  attentionSales(t);
  must(fileImport(t, [realSale('5201', '2026-08-03')], 'imp'));
  must(override(t, 'kw:sale:5201'));
  assert.deepEqual(check(t, Q3).missing, []);
  must(override(t, 'kw:sale:5201', 'withdraw_handled'));
  assert.deepEqual(reasonsOf(check(t, Q3).missing), [['kw:sale:5201', 'missing', 0]], 'withdrawn: missing again');
  refused(override(t, 'kw:sale:5201', 'withdraw_handled'), 'override_not_active');
  must(override(t, 'kw:sale:5201'));
  assert.deepEqual([check(t, Q3).missing, check(t, Q3).hasFindings], [[], false], 'set again');
});

test('[INVARIANT override-restated-relists] an overridden event the producer restates afterwards is listed override_check (on both doors) until the override is set again', () => {
  // Guards vatFindings.ts `restatedLists.length > override.amendmentsSeen` (override_check), resolution.ts
  // (amendments_seen: the restatements counted when the override is written) and importSettlement.ts step 0
  // (the comparison logs the restatement although the override makes the import skip the event).
  for (const door of ['pull', 'file']) {
    const t = recutWorld();
    attentionSales(t);
    const sale = realSale('5301', '2026-08-03');
    const run = (e, key) => (door === 'pull' ? must(pullDoc(t, [e], key)).import : must(fileImport(t, [e], key)));
    run(sale, 'seen');
    must(override(t, 'kw:sale:5301'));
    const o = outcomeOf(run(restate(sale), 'restated'), 'kw:sale:5301');
    assert.deepEqual([o.outcome, o.reason, o.restated.map((c) => c.field)], ['skipped', 'handled_outside', ['amountMinor', 'netMinor', 'vatMinor']], door);
    const f = check(t, Q3);
    assert.deepEqual(reasonsOf(f.overrideCheck), [['kw:sale:5301', 'override_check', 0]], door);
    assert.deepEqual(f.overrideCheck[0].changed.map((c) => [c.field, c.was, c.now]), [['amountMinor', 5405, 10810], ['netMinor', 5000, 10000], ['vatMinor', 405, 810]]);
    assert.deepEqual([f.missing, f.hasFindings], [[], true]);
    assert.deepEqual(reasonsOf(check(t, Q4).earlier), [['kw:sale:5301', 'override_check', 0]], `${door}: earlier later`);
    // The same figures again are no new restatement.
    run(restate(sale), 'same');
    assert.equal(restatedRows(t, 'kw:sale:5301'), 1, door);
    must(override(t, 'kw:sale:5301'));
    assert.deepEqual(check(t, Q3).overrideCheck, [], `${door}: the person checked and set it again`);
    // A restatement back after that lists it again.
    run(sale, 'back');
    assert.deepEqual(reasonsOf(check(t, Q3).overrideCheck), [['kw:sale:5301', 'override_check', 0]], `${door}: restated again`);
  }
});

test('[INVARIANT restated-under-skip-compared] a booked event the producer restates while its kind is template skip or attention: event_amended logged, the check lists amended (code critic F1)', () => {
  // Guards importSettlement.ts step 0 (the comparison with the latest stated figures before the template)
  // and step 1 (a stored event's differing figures refuse event_amended before the skip answer), read by
  // vatFindings.ts `amended`.
  for (const action of ['skip', 'attention']) {
    const t = recutWorld();
    const sale = realSale('5401', '2026-08-03');
    assert.equal(outcomeOf(must(fileImport(t, [sale], 'a')), 'kw:sale:5401').outcome, 'booked');
    must(setSettlementTemplate(t.ctx, { system: SYSTEM, processor: PROCESSOR, clearingAccountId: t.acc('1095'), kinds: { ...templateKinds(t), sale: { action } }, idempotencyKey: `tpl-${action}` }));
    const o = outcomeOf(must(fileImport(t, [restate(sale)], 'b')), 'kw:sale:5401');
    assert.deepEqual([o.outcome, o.code, o.restated.map((c) => c.field)], ['refused', 'event_amended', ['amountMinor', 'netMinor', 'vatMinor']], action);
    assert.equal(restatedRows(t, 'kw:sale:5401'), 1, `${action}: logged`);
    const f = check(t, Q3);
    assert.deepEqual(reasonsOf(f.amended), [['kw:sale:5401', 'amended', 1]], action);
    assert.equal(f.hasFindings, true);
    // A never-booked event of a skipped kind is compared and logged too.
    const u = recutWorld();
    must(setSettlementTemplate(u.ctx, { system: SYSTEM, processor: PROCESSOR, clearingAccountId: u.acc('1095'), kinds: { ...templateKinds(u), sale: { action } }, idempotencyKey: `tpl-u-${action}` }));
    must(fileImport(u, [sale], 'a'));
    const ou = outcomeOf(must(fileImport(u, [restate(sale)], 'b')), 'kw:sale:5401');
    assert.deepEqual([ou.outcome, ou.reason, ou.restated.length], ['skipped', action === 'skip' ? 'template_skip' : 'needs_attention', 3], action);
    assert.equal(restatedRows(u, 'kw:sale:5401'), 1, `${action}: logged without a booking`);
  }
});

test('[INVARIANT latest-stated] every arrival is compared with the LATEST stated figures, never the first sighting: a second restatement names the first restatement as was, and a restatement back to the booked figures clears amended', () => {
  // Guards restated.ts (figureChanges against latestStatedOf: the first sighting folded with every restated
  // row in arrival order) as read by importSettlement.ts step 0 and vatFindings.ts `amended`.
  const t = recutWorld();
  const sale = realSale('5501', '2026-08-03');
  must(fileImport(t, [sale], 'a'));
  must(fileImport(t, [restate(sale)], 'b'));
  const third = restate(sale, '162.15', '150.00', '12.15');
  const o = outcomeOf(must(fileImport(t, [third], 'c')), 'kw:sale:5501');
  assert.deepEqual(o.restated.map((c) => [c.field, c.was, c.now]), [['amountMinor', 10810, 16215], ['netMinor', 10000, 15000], ['vatMinor', 810, 1215]], 'was is the latest stated, not the first sighting');
  assert.deepEqual(check(t, Q3).amended[0].changed.map((c) => [c.field, c.was, c.now]), [['amountMinor', 5405, 16215], ['netMinor', 5000, 15000], ['vatMinor', 405, 1215]]);
  assert.equal(restatedRows(t, 'kw:sale:5501'), 2);
  // Back to the booked figures: compared with the latest (16.215), logged, and the booking matches again.
  const back = outcomeOf(must(fileImport(t, [sale], 'd')), 'kw:sale:5501');
  assert.deepEqual([back.outcome, back.restated.map((c) => c.was)], ['already_imported', [16215, 15000, 1215]]);
  assert.equal(restatedRows(t, 'kw:sale:5501'), 3);
  assert.deepEqual(check(t, Q3).amended, [], 'the booking carries the latest stated figures');
  must(fileImport(t, [sale], 'e'));
  assert.equal(restatedRows(t, 'kw:sale:5501'), 3, 'the same figures again log nothing');
});

test('[INVARIANT two-sources-same-id] the same event id from two sources: an override clears only its own source, and a restatement in one never reaches the other (code critic F3)', () => {
  // Guards resolution.ts (the override row and activeOverridesOf scoped by system and processor) and
  // restated.ts (the restatements scoped likewise), read per source by vatFindings.ts.
  const t = recutWorld();
  attentionSales(t);
  must(setSettlementTemplate(t.ctx, { system: SYSTEM, processor: 'Zweitfix', clearingAccountId: t.acc('1095'), kinds: { ...templateKinds(t), sale: { action: 'attention' } }, idempotencyKey: 'tpl-b' }));
  const sale = realSale('5601', '2026-08-03');
  must(fileImport(t, [sale], 'a'));
  must(importSettlement(t.fctx, { settlement: { ...docOf([sale]), source: { system: SYSTEM, processor: 'Zweitfix' } }, idempotencyKey: 'b' }));
  assert.deepEqual(check(t, Q3).missing.map((i) => [i.processor, i.eventId]), [['zahlfix', 'kw:sale:5601'], ['zweitfix', 'kw:sale:5601']]);
  must(override(t, 'kw:sale:5601'));
  assert.deepEqual(check(t, Q3).missing.map((i) => [i.processor, i.eventId]), [['zweitfix', 'kw:sale:5601']], 'only its own source');
  must(importSettlement(t.fctx, { settlement: { ...docOf([restate(sale)]), source: { system: SYSTEM, processor: 'Zweitfix' } }, idempotencyKey: 'b2' }));
  assert.deepEqual(check(t, Q3).overrideCheck, [], 'the other source restated, not this one');
  // A hand entry by the bare event id clears neither.
  handSale(t, { date: '2026-08-03', key: 'bare', ref: 'kw:sale:5601' });
  assert.deepEqual(check(t, Q3).missing.map((i) => i.processor), ['zweitfix']);
});

test('[INVARIANT tenant] a second workspace with its OWN events, entries, restatements and overrides never reaches this check, and this one never reaches it', () => {
  // Guards the workspace_id filter of every query of vatFindings.ts (eventsOf, the import rows), restated.ts
  // (restatementsOf, latestStatedOf) and resolution.ts (activeOverridesOf).
  const t = recutWorld();
  attentionSales(t);
  const b = secondWorkspace(t);
  const bctx = makeContext(t.store, { workspaceId: b.workspaceId, actor: 'user_1', clock: fixedClock(NOW), ids: t.ids });
  must(createAccount(bctx, { number: '1095', name: 'Durchlaufkonto', type: 'asset', idempotencyKey: 'b1095' }));
  must(createAccount(bctx, { number: '6940', name: 'Gebühren', type: 'expense', idempotencyKey: 'b6940' }));
  setTemplate(t, bctx, b.acc, 'b-tpl');
  // A: the sale is missing, a refusal is missing. B: the SAME ids, booked by its import, restated, overridden.
  must(fileImport(t, [realSale('4101', '2026-08-03'), { ...realSale('4102', '2026-08-03'), amount: '55.05' }], 'a'));
  const before = check(t, Q3);
  assert.deepEqual(reasonsOf(before.missing), [['kw:sale:4101', 'missing', 0], ['kw:sale:4102', 'missing', 0]]);
  must(importSettlement(bctx, { settlement: docOf([realSale('4101', '2026-08-03'), { ...realSale('4102', '2026-08-03'), amount: '55.05' }, { ...realSale('x', '2026-08-06'), id: '' }]), idempotencyKey: 'b' }));
  must(importSettlement(bctx, { settlement: docOf([restate(realSale('4101', '2026-08-03'))]), idempotencyKey: 'b-amend' }));
  must(override(t, 'kw:sale:4102', 'handled_outside', bctx));
  assert.deepEqual(check(t, Q3), before, "B's events, entries, restatements and overrides change nothing for A");
  // And A's never reach B.
  const bf = check(t, Q3, bctx);
  assert.deepEqual(reasonsOf(bf.amended), [['kw:sale:4101', 'amended', 1]]);
  assert.deepEqual([bf.missing, bf.bookedTwice, bf.overrideCheck], [[], [], []]);
  assert.equal(bf.unplaceable.count, 1);
  assert.equal(before.unplaceable.count, 0);
  must(override(t, 'kw:sale:4101'));
  assert.deepEqual(reasonsOf(check(t, Q3).missing), [['kw:sale:4102', 'missing', 0]]);
  assert.deepEqual(check(t, Q3, bctx), bf, "A's override never reaches B");
});

test('[INVARIANT booking-track-deleted] the booking resolutions and the ref links are gone; resolve_settlement_event takes the test track and the override, both pinned', () => {
  // Guards schema.ts (no settlement_event_resolution), settlement-actions.ts (the enum), resolution.ts
  // (prepare refuses any other answer), vorschlagPin.ts (the test track and the override pinned, no booking
  // track), index.ts (no ref-link export) and importSettlement.ts (no booked_by_ref answer).
  const t = recutWorld();
  assert.equal(t.store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'settlement_event_resolution%'").get().n, 0);
  const action = getAction('resolve_settlement_event');
  assert.deepEqual(action.inputSchema.properties.resolution.enum, ['not_test', 'reopen_test', 'handled_outside', 'withdraw_handled']);
  assert.equal(action.inputSchema.properties.entryId, undefined);
  must(fileImport(t, [realSale('4201', '2026-08-03')], 'imp'));
  for (const gone of ['booked_elsewhere', 'keep_booked', 'not_to_book', 'reopen']) {
    const r = resolveSettlementEvent(t.fctx, { system: SYSTEM, processor: PROCESSOR, eventId: 'kw:sale:4201', resolution: gone, reason: 'x', idempotencyKey: `k-${gone}` });
    assert.equal(r.error, 'invalid_input', gone);
  }
  for (const verb of ['import_settlement', 'pull_settlement']) {
    assert.ok(!PIN_FOR_VERB[verb].some((p) => p.record === 'settlement_event_resolutions_all'), verb);
    assert.ok(PIN_FOR_VERB[verb].some((p) => p.record === 'settlement_test_resolutions_all'), `${verb} still pins the test track`);
    assert.ok(PIN_FOR_VERB[verb].some((p) => p.record === 'settlement_event_overrides_all'), `${verb} pins the override`);
  }
  for (const name of ['BOOKING_RESOLUTIONS', 'latestBookingResolution', 'latestPullOutcome', 'pendingAmendment', 'REFUSED_ENTRY_SOURCES', 'refCandidatesOf', 'refLinksOf', 'passesVatTest', 'statedFiguresOf']) {
    assert.equal(settlementIndex[name], undefined, name);
  }
  assert.equal(settlementIndex.SETTLEMENT_OUTCOME_TEXT.booked_by_ref, undefined);
  assert.deepEqual(settlementIndex.TEST_RESOLUTIONS, ['not_test', 'reopen_test']);
  assert.deepEqual(settlementIndex.OVERRIDE_RESOLUTIONS, ['handled_outside', 'withdraw_handled']);
});

test('cancelling groups: hide_test hides only test groups, hide_all real ones too, show none (settlement.check_cancelling_groups)', () => {
  // Guards vatFindings.ts the cancelling-group filter over the `missing` items and cancellingGroupsModeOf.
  const t = recutWorld();
  setting(t, 'settlement.test_events', 'book');
  // A template that leaves sales and refunds to a person: nothing of them books.
  must(getAction('set_settlement_template').run({ store: t.store, clock: t.clock, ids: t.ids, actor: 'user_1' }, {
    workspaceId: t.workspaceId, system: SYSTEM, processor: PROCESSOR, clearingAccountId: t.acc('1095'),
    kinds: { sale: { action: 'attention' }, refund: { action: 'attention' }, processing_fee: { action: 'skip' } }, idempotencyKey: 'tpl-att',
  }));
  must(fileImport(t, [
    ...testPayment('1401', '2026-08-03').slice(0, 2),
    realSale('1402', '2026-08-04'),
    ev('kw:refund:1402', 'refund', '2026-08-05', '-54.05', '-50.00', '-4.05', { chargeId: 'ch_inv_1402', test: false }),
  ], 'cg'));
  const ids = () => check(t, Q3).missing.map((u) => u.eventId).sort();
  assert.deepEqual(ids(), ['kw:refund:1402', 'kw:sale:1402'], 'hide_test (the default): the test pair is hidden, the real pair listed');
  setting(t, 'settlement.check_cancelling_groups', 'hide_all');
  assert.deepEqual(ids(), []);
  setting(t, 'settlement.check_cancelling_groups', 'show');
  assert.deepEqual(ids(), ['kw:refund:1401', 'kw:refund:1402', 'kw:sale:1401', 'kw:sale:1402']);
});

test('the refusal bounds: after the period end not listed, before the from-date counted, a re-sent readable test event leaves the refusal for testExcluded', () => {
  // Guards vatFindings.ts the refusal path through the same scope as an observed event (`e.day > periodEnd`,
  // the from-date floor counted in beforeFromDate, observed beats refused).
  const t = recutWorld();
  const broken = (n, day) => ({ ...realSale(n, day), amount: '55.05' });
  must(pullDoc(t, [broken('4301', '2026-08-03'), broken('4302', '2026-10-05'), broken('4303', '2026-06-15')], 'p1', {}, { from: '2026-06-01', to: '2026-10-05' }));
  const f = check(t, Q3);
  assert.deepEqual(f.missing.map((u) => u.eventId), ['kw:sale:4301'], 'after the period end (05.10) is not listed');
  assert.deepEqual(check(t, ['2026-04-01', '2026-06-30']).beforeFromDate, { count: 1, vatMinor: 0 }, 'before the from-date (01.07): counted, VAT unknown');
  must(pullDoc(t, [realSale('4301', '2026-08-03', { test: true })], 'p2'));
  const g = check(t, Q3);
  assert.deepEqual(g.missing, []);
  assert.equal(g.testExcluded.sale.events, 1);
});

test('[INVARIANT tenant-2] a second workspace with its own refused events and shared-key test flags never reaches this check', () => {
  // Guards the workspace_id filter of eventsOf's refusal query, the unplaceable query and loadTestIndex's key path.
  const t = recutWorld();
  const b = secondWorkspace(t);
  const bctx = makeContext(t.store, { workspaceId: b.workspaceId, actor: 'user_1', clock: fixedClock(NOW), ids: t.ids });
  must(createAccount(bctx, { number: '1095', name: 'Durchlaufkonto', type: 'asset', idempotencyKey: 'b1095' }));
  must(createAccount(bctx, { number: '6940', name: 'Gebühren', type: 'expense', idempotencyKey: 'b6940' }));
  setTemplate(t, bctx, b.acc, 'b-tpl');
  must(fileImport(t, [realSale('9070', '2026-08-03'), ev('zf_fee_9070', 'processing_fee', '2026-08-03', '-1.00', '-1.00', null, { chargeId: 'ch_inv_9070', test: false })], 'a'));
  const before = check(t, Q3);
  must(importSettlement(bctx, { settlement: docOf([realSale('9071', '2026-08-04', { chargeId: 'ch_inv_9070', test: true }), { ...realSale('9072', '2026-08-05'), amount: '1.23' }, { ...realSale('x', '2026-08-06'), id: '' }]), idempotencyKey: 'b' }));
  assert.deepEqual(check(t, Q3), before, "B's flags and refusals change nothing for A");
  const bf = check(t, Q3, bctx);
  assert.deepEqual([bf.missing.map((u) => u.code), bf.unplaceable.items.map((u) => u.code)], [['amount_mismatch'], ['missing_id']]);
});

// ================================================================================================
// R5: the exact composition
// ================================================================================================

test('an event stating two payoutIds appears in both compositions with conflict: true', () => {
  // Guards payoutLink.ts compositionOf (`conflict`: a member's stated refs beyond this payout's).
  const t = recutWorld();
  must(pullDoc(t, [
    realSale('1501', '2026-08-03', { payoutId: 'po_inv_1501' }),
    ev('zf_po_1501', 'bank_payout', '2026-08-05', '-54.05', '-54.05', null, { payoutId: 'po_inv_1501' }),
  ], 'c1'));
  must(pullDoc(t, [
    realSale('1501', '2026-08-03', { payoutId: 'po_inv_1502' }),
    ev('zf_po_1502', 'bank_payout', '2026-08-12', '-54.05', '-54.05', null, { payoutId: 'po_inv_1502' }),
  ], 'c2'));
  const { lines } = importLines(t, { statementId: 'zkb-cf', from: '2026-08-01', to: '2026-08-31', entries: [
    { ref: 'a', amountMinor: 5405, cd: 'CRDT', date: '2026-08-05' },
    { ref: 'b', amountMinor: 5405, cd: 'CRDT', date: '2026-08-12' },
  ] });
  for (const ref of ['a', 'b']) {
    const m = must(settlementPayoutForBankLine(t.fctx, { bankTxnId: lines[ref] })).matches[0];
    assert.deepEqual(m.composition.events.map((e) => [e.eventId, e.conflict]), [['kw:sale:1501', true]], ref);
  }
});


// ================================================================================================
// R7: the security seams
// ================================================================================================

test('[INVARIANT call-tool] call_tool refuses a human-only verb and a secret-argument verb for every seat, and the trace strips a nested feedToken', () => {
  // Guards batch-actions.ts callToolExclusion (`human_only`, `secret_argument`) and agent-gate.ts recordCall
  // (`stripSecretsDeep` over the whole recorded input).
  const t = recutWorld();
  must(fileImport(t, testPayment('2001', '2026-08-03'), 'ct'));
  for (const actor of ['agent', 'studio']) {
    const deps = { store: t.store, clock: t.clock, ids: t.ids, actor, settlementFeed: t.port };
    const resolveVia = runGoverned(deps, getAction('call_tool'), {
      workspaceId: t.workspaceId,
      name: 'resolve_settlement_event',
      args: { workspaceId: t.workspaceId, system: SYSTEM, processor: PROCESSOR, eventId: 'kw:sale:2001', resolution: 'not_test', reason: 'x', idempotencyKey: `${actor}-r` },
    });
    assert.equal(resolveVia.error, 'call_tool_not_dispatchable', actor);
    assert.equal(resolveVia.reason, 'human_only', actor);
    const sourceVia = runGoverned(deps, getAction('call_tool'), {
      workspaceId: t.workspaceId,
      name: 'set_settlement_source',
      args: { workspaceId: t.workspaceId, system: SYSTEM, processor: PROCESSOR, baseUrl: BASE, fromDate: '2026-07-01', feedToken: TOKEN, idempotencyKey: `${actor}-s` },
    });
    assert.equal(sourceVia.error, 'call_tool_not_dispatchable', actor);
  }
  assert.equal(count(t, 'settlement_test_resolution'), 0, 'nothing resolved');
  const traced = t.store.db.prepare("SELECT args_json FROM agent_call WHERE workspace_id = ? AND verb = 'call_tool'").all(t.workspaceId);
  assert.ok(traced.length > 0);
  for (const row of traced) {
    assert.equal(row.args_json.includes(TOKEN), false, 'no token in the trace');
    const args = JSON.parse(row.args_json).args;
    if (args.baseUrl !== undefined) assert.equal(args.feedTokenOmitted, true, 'the nested field is stripped with a marker');
  }
});

test('[INVARIANT reserved-prefix] settlement-daily: is a key no caller may send', () => {
  // Guards idempotencyArgs.ts RESERVED_IDEMPOTENCY_KEY_PREFIXES (`settlement-daily:`), checked at the door.
  const t = recutWorld();
  must(setSettlementSource(t.fctx, { system: SYSTEM, processor: PROCESSOR, baseUrl: BASE, fromDate: '2026-07-01', feedToken: TOKEN, idempotencyKey: 'src' }));
  for (const actor of ['agent', 'studio']) {
    const deps = { store: t.store, clock: t.clock, ids: t.ids, actor, settlementFeed: t.port };
    const r = runGoverned(deps, getAction('pull_settlement'), { workspaceId: t.workspaceId, system: SYSTEM, processor: PROCESSOR, idempotencyKey: 'settlement-daily:stlsrc_x:2026-10-05:1' });
    assert.equal(r.error, 'invalid_input', actor);
  }
  assert.equal(t.box.calls, 0, 'nothing fetched');
});

test('[INVARIANT blank-token] blankToken covers raw, JSON-escaped, \\u-escaped, percent-encoded in either case and whitespace-split spellings', () => {
  // Guards settlement-feed-host.ts blankToken.
  const tok = 'kw_test/token+0123456789abcdef';
  const enc = encodeURIComponent(tok);
  const spellings = [tok, tok.replace('/', '\\/'), enc, enc.toLowerCase(), tok.replace('s', '\\u0073'), `${tok.slice(0, 9)}\n  ${tok.slice(9)}`, tok.replace('/', '%2f')];
  for (const s of spellings) {
    const out = blankToken(`before ${s} after`, tok);
    assert.equal(out, 'before [token] after', JSON.stringify(s));
  }
});

test('[INVARIANT governance-pin] a test answer, an override, a settlement setting or a source changed after an agent drafted the import refuses the approval vorschlag_stale', () => {
  // Guards vorschlagPin.ts PIN_FOR_VERB.import_settlement (settlement_test_resolutions_all,
  // settlement_event_overrides_all, settlement_settings_all, and since code critic C2 settlement_sources_all:
  // the import reads the source's from-date) and RecordSpec.where (the settings slice).
  for (const change of ['resolution', 'override', 'setting', 'source']) {
    const t = recutWorld();
    if (change === 'source') pullDoc(t, [realSale('2199', '2026-07-05')], 'src-seed');
    must(fileImport(t, testPayment('2101', '2026-08-03').slice(0, 1), 'seen'));
    const agent = { store: t.store, clock: t.clock, ids: t.ids, actor: 'agent' };
    const drafted = runGoverned(agent, getAction('import_settlement'), { workspaceId: t.workspaceId, settlement: docOf(testPayment('2101', '2026-08-03')), idempotencyKey: `draft-${change}` });
    assert.equal(typeof drafted.actionId, 'string', JSON.stringify(drafted));
    if (change === 'resolution') must(resolve(t, 'kw:sale:2101', 'not_test'));
    else if (change === 'override') must(override(t, 'kw:sale:2101'));
    else if (change === 'setting') setting(t, 'settlement.test_events', 'book');
    else must(setSettlementSource(t.fctx, { system: SYSTEM, processor: PROCESSOR, baseUrl: BASE, fromDate: '2026-06-01', idempotencyKey: 'from-earlier' }));
    const entries = count(t, 'journal_entry');
    const decided = getAction('approve_drafted_action').run({ store: t.store, clock: t.clock, ids: t.ids, actor: 'studio' }, { workspaceId: t.workspaceId, actionId: drafted.actionId });
    assert.equal(decided.error, 'vorschlag_stale', `${change}: ${JSON.stringify(decided)}`);
    assert.equal(count(t, 'journal_entry'), entries, `${change}: nothing booked`);
  }
});


test('[INVARIANT append-only] every table of the feed refuses UPDATE and DELETE', () => {
  // Guards the triggers in schema.ts for settlement_feed_flag, settlement_feed_outcome, settlement_feed_event,
  // settlement_feed_payout_ref, settlement_test_resolution and settlement_event_override.
  const t = recutWorld();
  must(fileImport(t, [...testPayment('1901', '2026-08-03'), realSale('1902', '2026-08-03', { payoutId: 'po_inv_1902' })], 'ao'));
  must(resolve(t, 'kw:sale:1901', 'not_test'));
  must(override(t, 'kw:sale:1902'));
  for (const table of ['settlement_feed_flag', 'settlement_feed_outcome', 'settlement_test_resolution', 'settlement_event_override', 'settlement_feed_event', 'settlement_feed_payout_ref']) {
    assert.ok(count(t, table) > 0, `${table} has rows to protect`);
    assert.throws(() => t.store.db.prepare(`UPDATE ${table} SET workspace_id = workspace_id WHERE workspace_id = ?`).run(t.workspaceId), /append-only/, `${table} UPDATE`);
    assert.throws(() => t.store.db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(t.workspaceId), /append-only/, `${table} DELETE`);
  }
});

test('[INVARIANT test-track] not_test and reopen_test change what books and what is test-excluded, never what is booked; their tenancy holds', () => {
  // Guards flags.ts (settlement_test_resolution, read by isTestEvent and loadTestIndex, by workspace) and
  // resolution.ts (the human-only, observed-only answer).
  const t = recutWorld();
  attentionSales(t);
  const [sale] = testPayment('1601', '2026-08-03');
  must(fileImport(t, [sale], 'a'));
  const isTest = (ctx = t.fctx) => isTestEvent(ctx, 'kurswerk', 'zahlfix', 'kw:sale:1601');
  assert.equal(isTest(), true);
  const cleared = must(resolve(t, 'kw:sale:1601', 'not_test'));
  assert.deepEqual(cleared.events.map((e) => e.eventId), ['kw:sale:1601'], 'not_test lists what it clears');
  assert.equal(isTest(), false);
  // Not test is no booking: the template leaves sales to a person, so it is missing until a person books it.
  assert.deepEqual(reasonsOf(check(t, Q3).missing), [['kw:sale:1601', 'missing', 0]]);
  must(resolve(t, 'kw:sale:1601', 'reopen_test'));
  assert.equal(isTest(), true, 'reopen_test returns the transaction to its flags');
  assert.deepEqual(check(t, Q3).missing, []);
  refused(resolve(t, 'kw:sale:9999', 'not_test'), 'event_not_observed');
  const agent = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: fixedClock(NOW), ids: t.ids });
  refused(resolve(t, 'kw:sale:1601', 'not_test', {}, agent), 'human_only');
  // B flags the same ids test; A's answers never clear B's flag, and B's never reach A.
  const b = secondWorkspace(t);
  const bctx = makeContext(t.store, { workspaceId: b.workspaceId, actor: 'user_1', clock: fixedClock(NOW), ids: t.ids });
  must(createAccount(bctx, { number: '1095', name: 'Durchlaufkonto', type: 'asset', idempotencyKey: 'b1095' }));
  must(createAccount(bctx, { number: '6940', name: 'Gebühren', type: 'expense', idempotencyKey: 'b6940' }));
  setTemplate(t, bctx, b.acc, 'b-tpl');
  must(importSettlement(bctx, { settlement: docOf([sale]), idempotencyKey: 'b' }));
  must(resolve(t, 'kw:sale:1601', 'not_test'));
  assert.equal(isTest(bctx), true, "A's not_test never clears B's flag");
  refused(resolve(t, 'kw:sale:1603', 'not_test'), 'event_not_observed');
});

// ================================================================================================
// Code critic on the override design (12.11.2026): G1 and the pull pin (L4)
// ================================================================================================

test('[INVARIANT booked-restated-out-of-scope] an import-booked sale restated to 0.00, or to a kind without VAT, stays listed amended; booked twice then zeroed stays booked_twice (code critic G1)', () => {
  // Guards vatFindings.ts: the scope (`candidate`) and zero filters apply only when `importEntryId === null`.
  const check = (t) => settlementVatFindings(t.fctx, '2026-07-01', '2026-09-30');
  for (const [name, restated] of [
    ['zero', { amount: '0.00', net: '0.00', vat: null }],
    ['no-vat-kind', { kind: 'third_party_payout', vat: null, amount: '-54.05', net: '-54.05' }],
  ]) {
    const t = recutWorld();
    must(fileImport(t, [realSale('9301', '2026-08-03')], `b-${name}`));
    assert.ok(entryOf(t, 'kw:sale:9301'), `${name}: booked`);
    fileImport(t, [{ ...realSale('9301', '2026-08-03'), ...restated }], `r-${name}`);
    const f = check(t);
    assert.deepEqual(f.amended.map((a) => a.eventId), ['kw:sale:9301'], `${name}: still listed, its VAT is still in the books`);
    assert.equal(f.hasFindings, true, name);
  }
  // Booked twice (the import entry plus its reversal of the reversal), then restated to zero.
  const t = recutWorld();
  must(fileImport(t, [realSale('9302', '2026-08-03')], 'b2'));
  const x = entryOf(t, 'kw:sale:9302');
  const r1 = must(reverseEntry(t.fctx, { entryId: x, date: '2026-10-02', idempotencyKey: 'r1' })).reversalId;
  must(reverseEntry(t.fctx, { entryId: r1, date: '2026-09-20', idempotencyKey: 'r2' }));
  assert.deepEqual(check(t).bookedTwice.map((b) => b.eventId), ['kw:sale:9302']);
  fileImport(t, [{ ...realSale('9302', '2026-08-03'), amount: '0.00', net: '0.00', vat: null }], 'z2');
  assert.deepEqual(check(t).bookedTwice.map((b) => b.eventId), ['kw:sale:9302'], 'a zero restatement never hides a double booking');
});

test('[INVARIANT governance-pin-pull] an override made after an agent drafted a pull refuses the approval vorschlag_stale (code critic L4)', () => {
  // Guards vorschlagPin.ts PIN_FOR_VERB.pull_settlement settlement_event_overrides_all.
  const t = recutWorld();
  must(pullDoc(t, [{ ...realSale('9401', '2026-08-03'), amount: '55.05' }], 'seen'));
  t.box.doc = docOf([realSale('9401', '2026-08-03')]);
  const agent = { store: t.store, clock: t.clock, ids: t.ids, actor: 'agent', settlementFeed: t.port };
  const drafted = runGoverned(agent, getAction('pull_settlement'), { workspaceId: t.workspaceId, system: SYSTEM, processor: PROCESSOR, from: '2026-07-01', to: '2026-09-30', idempotencyKey: 'draft-pull' });
  assert.equal(typeof drafted.actionId, 'string', JSON.stringify(drafted));
  must(override(t, 'kw:sale:9401'));
  const entries = count(t, 'journal_entry');
  const decided = getAction('approve_drafted_action').run({ store: t.store, clock: t.clock, ids: t.ids, actor: 'studio', settlementFeed: t.port }, { workspaceId: t.workspaceId, actionId: drafted.actionId });
  assert.equal(decided.error, 'vorschlag_stale', JSON.stringify(decided));
  assert.equal(count(t, 'journal_entry'), entries);
});
