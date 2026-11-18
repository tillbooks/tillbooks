// A42, the Umsatz review: `settlement_review` (the real import, rolled back) and `set_settlement_event_ignored`.
// SYNTHETIC BY CONSTRUCTION: the platform "Kurswerk", the processor "Zahlfix", every person, email, id, document
// number and amount below is invented from scratch for these tests. Nothing is derived from any real settlement.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import {
  importSettlement,
  pullSettlement,
  setSettlementSource,
  resolveSettlementEvent,
  settlementReview,
  setSettlementEventIgnored,
  settlementVatFindings,
  readSettlementDocument,
  emailOf,
  periodAround,
  periodPartOf,
} from '../../dist/core/settlement/index.js';
import { PIN_FOR_VERB } from '../../dist/core/agent/vorschlagPin.js';
import { settingsSet as setSetting } from '../../dist/core/settings/index.js';
import { lockPeriod } from '../../dist/core/ledger/periods.js';
import { reverseEntry } from '../../dist/core/ledger/index.js';
import { createAccount } from '../../dist/core/accounts/accounts.js';
import { makeAuditPort } from '../../dist/core/ledger/auditLog.js';
import { getAction } from '../../dist/api/registry.js';
import { runGoverned } from '../../dist/api/agent-gate.js';
import { setSettlementTemplate } from '../../dist/core/settlement/index.js';
import { secondWorkspace, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { settlementWorld, setTemplate, templateKinds, must, refused, SYSTEM, PROCESSOR } from './support.mjs';

afterEach(assertClaimInvariantHolds);

const NOW = '2026-10-05T08:00:00.000Z';
const BASE = 'https://kurswerk.example';
const TOKEN = 'kw_test_token_0123456789abcdef';

function reviewWorld(opts = {}) {
  const t = settlementWorld(opts.world ?? {});
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
  const fctx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: fixedClock(opts.now ?? NOW), ids: t.ids, audit: makeAuditPort({ store: t.store, workspaceId: t.workspaceId, ids: t.ids }), periods: t.ctx.periods, settlementFeed: port });
  setTemplate(t);
  return { ...t, fctx, port, box };
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
const docOf = (events, extra = {}) => ({ schema: 'till-settlement/v1', source: { system: SYSTEM, processor: PROCESSOR }, currency: 'CHF', generatedAt: '2026-10-05T06:00:00.000Z', events, ...extra });

/**
 * One invented payout of July: a sale of 54.05 (net 50.00, VAT 4.05) by an invented payer, the card fee of 1.08
 * (net 1.00, input VAT 0.08), a transfer of 20.00 to a coach without VAT, and the payout of 32.97 they explain
 * (54.05 - 1.08 - 20.00 = 32.97). Every member states the payout's id.
 */
const SALE = ev('kw:sale:2001', 'sale', '2026-07-14', '54.05', '50.00', '4.05', {
  chargeId: 'ch_inv_2001',
  payoutId: 'po_inv_1',
  counterpartyEmail: 'lena.beispiel@kurswerk.example',
  counterpartyName: 'Lena Beispiel',
  test: false,
}, { document: { type: 'client_invoice', number: 'KW-R-2001' } });
const FEE = ev('zf_fee_2001', 'processing_fee', '2026-07-14', '-1.08', '-1.00', '-0.08', { chargeId: 'ch_inv_2001', payoutId: 'po_inv_1' });
const TRANSFER = ev('zf_tr_2001', 'third_party_payout', '2026-07-14', '-20.00', '-20.00', null, { chargeId: 'ch_inv_2001', transferId: 'tr_inv_2001', payoutId: 'po_inv_1' });
const PAYOUT = ev('zf_po_1', 'bank_payout', '2026-07-16', '-32.97', '-32.97', null, { payoutId: 'po_inv_1' });
const JULY = [SALE, FEE, TRANSFER, PAYOUT];

const review = (t, input = {}, ctx = t.fctx) => settlementReview(ctx, input);
const fileReview = (t, events, extra = {}, ctx = t.fctx) => settlementReview(ctx, { settlement: docOf(events), ...extra });
const ignore = (t, eventId, ignored = true, extra = {}, ctx = t.fctx) =>
  setSettlementEventIgnored(ctx, { system: SYSTEM, processor: PROCESSOR, eventId, ignored, idempotencyKey: `ign-${eventId}-${ignored}-${Math.random()}`, ...extra });
const fileImport = (t, events, key) => importSettlement(t.fctx, { settlement: docOf(events), idempotencyKey: key });
const setting = (t, key, value) => must(setSetting(t.fctx, { key, value, reason: 'Testfall (erfunden)', idempotencyKey: `set-${key}-${value}` }));
const setSettingResult = (t, key, value) => setSetting(t.fctx, { key, value, idempotencyKey: `set-${key}-${value}` });
const rowOf = (res, id) => res.rows.find((r) => r.eventId === id);
const count = (t, table) => t.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(t.workspaceId).n;

/** Every row of every table, hashed: a dry run must leave all of it as it was. */
function snapshot(store) {
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const h = createHash('sha256');
  for (const { name } of tables) h.update(name + JSON.stringify(store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()));
  return h.digest('hex');
}

// --- the dry run ----------------------------------------------------------------------------------

test('[INVARIANT dry-run-inert] a review of a file and of the feed leaves every row of the book as it was, twice', () => {
  const t = reviewWorld();
  const before = snapshot(t.store);
  must(fileReview(t, JULY));
  must(fileReview(t, JULY));
  assert.equal(snapshot(t.store), before, 'the file review leaves nothing');
  must(setSettlementSource(t.fctx, { system: SYSTEM, processor: PROCESSOR, baseUrl: BASE, fromDate: '2026-07-01', feedToken: TOKEN, idempotencyKey: 'src' }));
  t.box.doc = docOf(JULY);
  const afterSource = snapshot(t.store);
  const feed = must(review(t, { from: '2026-07-01', to: '2026-09-30' }));
  assert.equal(feed.mode, 'feed');
  assert.equal(t.box.calls, 1, 'the feed was fetched');
  assert.equal(snapshot(t.store), afterSource, 'the feed review books nothing and logs no pull');
  assert.equal(count(t, 'settlement_pull'), 0);
  assert.equal(count(t, 'settlement_event'), 0);
});

test('a review shows each event with who paid, what the import will do, the totals the books will carry and both checks', () => {
  const t = reviewWorld();
  const res = must(fileReview(t, JULY));
  assert.equal(res.mode, 'file');
  assert.deepEqual(res.period, { from: '2026-07-01', to: '2026-09-30', unit: 'quarter' }, 'a file opens on the quarter of its first day');
  assert.equal(res.rows.length, 4);
  const sale = rowOf(res, SALE.id);
  assert.equal(sale.status, 'to_book');
  assert.equal(sale.included, true);
  assert.equal(sale.inclusion.source, 'default');
  assert.deepEqual(sale.counterparty, { email: 'lena.beispiel@kurswerk.example', name: 'Lena Beispiel', masked: false, document: 'KW-R-2001', chargeId: 'ch_inv_2001' });
  assert.equal(sale.vatPostedMinor, 405);
  assert.equal(sale.toggleable, true);
  assert.equal(rowOf(res, FEE.id).vatPostedMinor, -8);
  const payout = rowOf(res, PAYOUT.id);
  assert.equal(payout.status, 'skipped');
  assert.equal(payout.reason, 'template_skip');
  assert.equal(payout.toggleable, false, 'a kind the template never books has no toggle');
  assert.equal(res.toBook, 3);
  assert.equal(res.totals.turnoverNetMinor, 5000);
  assert.equal(res.totals.outputVat.amountMinor, 405);
  assert.equal(res.totals.inputVat.amountMinor, 8);
  assert.equal(res.checks.payouts.state, 'ok');
  assert.deepEqual(res.checks.payouts.payouts.map((p) => [p.eventId, p.basis, p.restMinor]), [[PAYOUT.id, 'refs', 0]]);
  assert.equal(res.checks.vat.state, 'ok');
  assert.equal(res.checks.vat.statedMinor, 405 - 8);
  assert.equal(res.checks.vat.bookedMinor, 405 - 8);
  assert.match(res.reviewSha256, /^[0-9a-f]{64}$/);
});

test('ignore keeps an event off the import and the totals, counts its VAT, breaks the payout check; include books it again', () => {
  const t = reviewWorld();
  const answer = must(ignore(t, SALE.id, true, { reason: 'Testkauf des Inhabers (erfunden)' }));
  assert.equal(answer.state, 'ignored');
  const res = must(fileReview(t, JULY));
  const sale = rowOf(res, SALE.id);
  assert.equal(sale.included, false);
  assert.equal(sale.status, 'skipped');
  assert.equal(sale.reason, 'ignored');
  assert.deepEqual([sale.inclusion.state, sale.inclusion.source, sale.inclusion.reason], ['ignored', 'override', 'Testkauf des Inhabers (erfunden)']);
  assert.equal(res.totals.outputVat.amountMinor, 0);
  assert.deepEqual(res.totals.ignored, { events: 1, vatMinor: 405 });
  assert.equal(res.checks.payouts.state, 'differs', 'the books no longer explain the payout');
  assert.equal(res.checks.payouts.payouts[0].restMinor, -5405);
  assert.equal(res.checks.vat.state, 'ok', 'an ignored event is out of the VAT check (it is counted under ignored)');

  const imported = must(fileImport(t, JULY, 'imp-1'));
  assert.equal(imported.events.find((o) => o.id === SALE.id).reason, 'ignored');
  assert.equal(count(t, 'settlement_event'), 2, 'fee and transfer booked, the sale not');

  must(ignore(t, SALE.id, false));
  const again = must(fileReview(t, JULY));
  assert.equal(rowOf(again, SALE.id).status, 'to_book');
  assert.equal(rowOf(again, FEE.id).status, 'booked');
  assert.equal(again.checks.payouts.state, 'ok');
  must(fileImport(t, JULY, 'imp-2'));
  assert.equal(count(t, 'settlement_event'), 3);
});

test('[H3] a test sale in a file never imported reviews as test, as the import will skip it; it is included through not_test', () => {
  const t = reviewWorld();
  const testSale = ev('kw:sale:2101', 'sale', '2026-08-03', '21.62', '20.00', '1.62', { chargeId: 'ch_inv_2101', test: true });
  const testRefundLater = ev('kw:refund:2101', 'refund', '2026-08-04', '-21.62', '-20.00', '-1.62', { chargeId: 'ch_inv_2101' });
  const res = must(fileReview(t, [testSale, testRefundLater]));
  for (const id of [testSale.id, testRefundLater.id]) {
    const r = rowOf(res, id);
    assert.equal(r.test, true, `${id} is test (the refund by its chargeId)`);
    assert.equal(r.status, 'skipped');
    assert.equal(r.reason, 'test_event');
    assert.deepEqual([r.inclusion.state, r.inclusion.source, r.includeVia], ['ignored', 'test_default', 'not_test']);
    assert.equal(r.toggleable, false, 'r2 M4: not_test answers only an observed event');
  }
  assert.equal(res.totals.outputVat.amountMinor, 0);
  assert.equal(res.totals.test.events, 2);
  assert.equal(res.checks.vat.state, 'unknown', 'nothing included carries VAT');
  // An `included` answer does NOT lift a test status (paper critic r1 M7): not_test does, for the transaction.
  must(ignore(t, testSale.id, false));
  assert.equal(rowOf(must(fileReview(t, [testSale, testRefundLater])), testSale.id).status, 'skipped');
  must(fileImport(t, [testSale, testRefundLater], 'imp-t'));
  assert.equal(rowOf(must(fileReview(t, [testSale, testRefundLater])), testSale.id).toggleable, true, 'observed now: it can be included');
  must(resolveSettlementEvent(t.fctx, { system: SYSTEM, processor: PROCESSOR, eventId: testSale.id, resolution: 'not_test', reason: 'Echter Kauf (erfunden)', idempotencyKey: 'nt-1' }));
  const after = must(fileReview(t, [testSale, testRefundLater]));
  assert.deepEqual([rowOf(after, testSale.id).status, rowOf(after, testRefundLater.id).status], ['to_book', 'to_book'], 'the whole transaction is included');
});

test('[H3] a locked period and an inexact VAT review as refused, never counted, and check (b) names them', () => {
  const t = reviewWorld({ world: { realPeriods: true } });
  must(lockPeriod(t.ctx, { period: '2026-07', kind: 'soft', reason: 'Juli abgeschlossen (erfunden)', idempotencyKey: 'lock-07' }));
  const inexact = ev('kw:sale:2201', 'sale', '2026-08-05', '54.00', '50.00', '4.00', { chargeId: 'ch_inv_2201' });
  const res = must(fileReview(t, [SALE, inexact]));
  assert.deepEqual([rowOf(res, SALE.id).status, rowOf(res, SALE.id).code], ['refused', 'period_locked']);
  assert.deepEqual([rowOf(res, inexact.id).status, rowOf(res, inexact.id).code], ['refused', 'vat_not_exact']);
  assert.equal(res.totals.outputVat.amountMinor, 0);
  assert.equal(res.totals.notBooked.events, 2);
  assert.equal(res.checks.vat.state, 'differs');
  assert.deepEqual(res.checks.vat.differing.sort(), [SALE.id, inexact.id].sort());
});

test('a booked event shows booked with its entry, has no toggle, and a reversal in the period takes its VAT out of check (b)', () => {
  const t = reviewWorld();
  must(fileImport(t, JULY, 'imp-b'));
  const res = must(fileReview(t, JULY, { from: '2026-07-01', to: '2026-09-30' }));
  const sale = rowOf(res, SALE.id);
  assert.equal(sale.status, 'booked');
  assert.equal(sale.inclusion.source, 'booked');
  assert.equal(sale.toggleable, false);
  assert.ok(sale.entryId);
  assert.equal(res.toBook, 0);
  assert.equal(res.totals.outputVat.amountMinor, 405);
  must(reverseEntry(t.ctx, { entryId: sale.entryId, date: '2026-10-02', reason: 'Storno (erfunden)', idempotencyKey: 'rev-1' }));
  const q3 = must(fileReview(t, JULY, { from: '2026-07-01', to: '2026-09-30' }));
  assert.equal(rowOf(q3, SALE.id).vatPostedMinor, 405, 'a Q4 reversal does not take the VAT out of Q3');
  assert.equal(q3.checks.vat.state, 'ok');
});

// --- the answer ---------------------------------------------------------------------------------

test('set_settlement_event_ignored refuses a booked event, an active handled_outside, an agent seat, a bad input; it never asks a reason (D203)', () => {
  const t = reviewWorld();
  must(fileImport(t, [SALE], 'imp-r'));
  refused(ignore(t, SALE.id), 'event_booked');
  // A test sale is observed and skipped (settlement.test_events skip, the default); a person handles it outside.
  const testSale = ev('kw:sale:2302', 'sale', '2026-07-21', '54.05', '50.00', '4.05', { chargeId: 'ch_inv_2302', test: true });
  must(fileImport(t, [testSale], 'imp-test'));
  must(resolveSettlementEvent(t.fctx, { system: SYSTEM, processor: PROCESSOR, eventId: testSale.id, resolution: 'handled_outside', reason: 'Von Hand (erfunden)', idempotencyKey: 'ho-1' }));
  refused(ignore(t, testSale.id), 'handled_outside_active');
  // D203 point 5: the setting is gone, and an ignore without a reason is written (who and when are kept).
  assert.equal(setSettingResult(t, 'settlement.ignore_reason', 'required').error, 'unknown_setting');
  const bare = must(ignore(t, 'kw:sale:9999'), 'an ignore needs no reason');
  assert.equal(bare.reason, null);
  must(ignore(t, 'kw:sale:9999', false), 'an include needs no reason');
  const agent = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: fixedClock(NOW), ids: t.ids });
  const byAgent = ignore(t, 'kw:sale:9998', true, { reason: 'x' }, agent);
  assert.equal(byAgent.ok, false);
  assert.ok(['person_decides', 'permission_denied'].includes(byAgent.error), byAgent.error);
  refused(setSettlementEventIgnored(t.fctx, { system: SYSTEM, processor: PROCESSOR, eventId: 'x', ignored: 'yes', idempotencyKey: 'k' }), 'invalid_input');
  refused(setSettlementEventIgnored(t.fctx, { system: SYSTEM, processor: PROCESSOR, eventId: 'x', ignored: true, reason: 'r'.repeat(501), idempotencyKey: 'k2' }), 'invalid_input');
  assert.equal(count(t, 'settlement_event_inclusion'), 2, 'every refusal wrote nothing');
  const row = t.store.db.prepare("SELECT reason, actor, at FROM settlement_event_inclusion WHERE workspace_id = ? AND event_id = 'kw:sale:9999' ORDER BY rowid LIMIT 1").get(t.workspaceId);
  assert.equal(row.reason, null);
  assert.ok(row.actor.length > 0 && row.at.length > 0, 'who and when are kept');
});

test('[INVARIANT append-only] every answer is a new row, audited; the table refuses UPDATE and DELETE; a replay writes nothing', () => {
  const t = reviewWorld();
  const key = 'ign-replay';
  must(setSettlementEventIgnored(t.fctx, { system: SYSTEM, processor: PROCESSOR, eventId: SALE.id, ignored: true, idempotencyKey: key }));
  must(setSettlementEventIgnored(t.fctx, { system: SYSTEM, processor: PROCESSOR, eventId: SALE.id, ignored: true, idempotencyKey: key }));
  assert.equal(count(t, 'settlement_event_inclusion'), 1, 'the replay writes nothing');
  must(ignore(t, SALE.id, true), 'the same answer again is kept (paper critic r1 M1)');
  assert.equal(count(t, 'settlement_event_inclusion'), 2);
  const audited = t.store.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ? AND entity_kind = 'settlement_event_inclusion'").get(t.workspaceId).n;
  assert.equal(audited, 2);
  assert.throws(() => t.store.db.prepare('UPDATE settlement_event_inclusion SET state = state WHERE workspace_id = ?').run(t.workspaceId), /append-only/);
  assert.throws(() => t.store.db.prepare('DELETE FROM settlement_event_inclusion WHERE workspace_id = ?').run(t.workspaceId), /append-only/);
});

test('[INVARIANT tenant] an answer in one workspace changes nothing in another', () => {
  const t = reviewWorld();
  const b = secondWorkspace(t);
  must(ignore(t, SALE.id, true));
  const bctx = makeContext(t.store, { workspaceId: b.workspaceId, actor: 'user_1', clock: fixedClock(NOW), ids: t.ids });
  must(createAccount(b.ctx, { number: '1095', name: 'Durchlaufkonto Zahlfix', type: 'asset', idempotencyKey: 'b-1095' }));
  must(createAccount(b.ctx, { number: '6940', name: 'Zahlungsgebühren', type: 'expense', idempotencyKey: 'b-6940' }));
  setTemplate(b, b.ctx, b.acc, 'tpl-b');
  const res = must(settlementReview(bctx, { settlement: docOf(JULY) }));
  assert.equal(rowOf(res, SALE.id).included, true);
  assert.equal(rowOf(res, SALE.id).status, 'to_book');
});

// --- the pre-filing check -----------------------------------------------------------------------

test('[M2] the vat_return check counts an ignored event under ignored, never lists it missing, and lists it again on a restatement', () => {
  const t = reviewWorld();
  must(ignore(t, SALE.id, true));
  must(fileImport(t, JULY, 'imp-c'));
  const f = settlementVatFindings(t.fctx, '2026-07-01', '2026-09-30');
  assert.equal(f.missing.some((m) => m.eventId === SALE.id), false);
  assert.deepEqual(f.ignored.sale, { events: 1, vatMinor: 405 });
  assert.equal(f.hasFindings, true);
  must(fileImport(t, [{ ...SALE, amount: '108.10', net: '100.00', vat: { ...SALE.vat, amount: '8.10' } }], 'imp-c2'));
  const g = settlementVatFindings(t.fctx, '2026-07-01', '2026-09-30');
  assert.ok(g.overrideCheck.some((m) => m.eventId === SALE.id), 'a restatement after the ignore is listed for a person');
});

// --- the feed -----------------------------------------------------------------------------------

test('[H2] the feed review fetches without booking; the pull books what was reviewed and refuses review_stale when the feed changed', () => {
  const t = reviewWorld();
  must(setSettlementSource(t.fctx, { system: SYSTEM, processor: PROCESSOR, baseUrl: BASE, fromDate: '2026-07-01', feedToken: TOKEN, idempotencyKey: 'src' }));
  t.box.doc = docOf(JULY);
  const seen = must(review(t, { from: '2026-07-01', to: '2026-09-30' }));
  assert.equal(seen.toBook, 3);
  t.box.doc = docOf([...JULY, ev('kw:sale:2401', 'sale', '2026-09-01', '54.05', '50.00', '4.05', {})], { generatedAt: '2026-10-05T07:00:00.000Z' });
  refused(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, from: '2026-07-01', to: '2026-09-30', expectReviewSha256: seen.reviewSha256, idempotencyKey: 'p-stale' }), 'review_stale');
  assert.equal(count(t, 'settlement_event'), 0);
  assert.equal(count(t, 'settlement_pull'), 0, 'a stale pull writes nothing');
  t.box.doc = docOf(JULY, { generatedAt: '2026-10-05T07:30:00.000Z' });
  const pulled = must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, from: '2026-07-01', to: '2026-09-30', expectReviewSha256: seen.reviewSha256, idempotencyKey: 'p-ok' }));
  assert.equal(pulled.import.booked, 3, 'a restamped generatedAt is the same review');
});

test('the feed review defaults to the quarter of settlement.review_period around today; several sources must be named', () => {
  assert.deepEqual(periodAround('2026-11-13', 'quarter'), { from: '2026-10-01', to: '2026-12-31' });
  assert.deepEqual(periodAround('2026-02-10', 'month'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(periodAround('2026-08-31', 'year'), { from: '2026-01-01', to: '2026-12-31' });
  const t = reviewWorld({ now: '2026-08-20T08:00:00.000Z' });
  must(setSettlementSource(t.fctx, { system: SYSTEM, processor: PROCESSOR, baseUrl: BASE, fromDate: '2026-07-01', feedToken: TOKEN, idempotencyKey: 'src' }));
  t.box.doc = docOf(JULY);
  const res = must(review(t));
  assert.deepEqual(res.period, { from: '2026-07-01', to: '2026-09-30', unit: 'quarter' });
  setting(t, 'settlement.review_period', 'month');
  assert.deepEqual(must(review(t)).period, { from: '2026-08-01', to: '2026-08-31', unit: 'month' });
  must(setSettlementSource(t.fctx, { system: 'Andere', processor: PROCESSOR, baseUrl: BASE, fromDate: '2026-07-01', feedToken: TOKEN, idempotencyKey: 'src-2' }));
  refused(review(t), 'source_ambiguous');
});

// --- code critic r1: what is booked is what was seen (the outcome digest, the chokepoint) -----------------

const saveSource = (t, fromDate = '2026-07-01', key = 'src') =>
  must(setSettlementSource(t.fctx, { system: SYSTEM, processor: PROCESSOR, baseUrl: BASE, fromDate, feedToken: TOKEN, idempotencyKey: key }));
const pullAs = (t, seen, key) =>
  pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, from: '2026-07-01', to: '2026-09-30', expectReviewSha256: seen.reviewSha256, idempotencyKey: key });

test('[code r1 H1] a template saved after the review makes the booking review_stale; nothing is booked unseen', () => {
  const t = reviewWorld();
  saveSource(t);
  must(setSettlementTemplate(t.fctx, { system: SYSTEM, processor: PROCESSOR, clearingAccountId: t.acc('1095'), kinds: { ...templateKinds(t), sale: { action: 'skip' } }, idempotencyKey: 'tpl-skip' }));
  t.box.doc = docOf(JULY);
  const seen = must(review(t, { from: '2026-07-01', to: '2026-09-30' }));
  assert.equal(rowOf(seen, SALE.id).reason, 'template_skip');
  setTemplate(t, t.fctx, t.acc, 'tpl-back');
  refused(pullAs(t, seen, 'p-h1'), 'review_stale');
  assert.equal(count(t, 'settlement_event'), 0);
  assert.equal(count(t, 'settlement_pull'), 0, 'the pull is rolled back with the import');
});

test('[code r1 H1] a from-date moved after the review makes the booking review_stale, on the feed and on a file', () => {
  const t = reviewWorld();
  saveSource(t, '2026-07-15');
  t.box.doc = docOf(JULY);
  const seen = must(review(t, { from: '2026-07-01', to: '2026-09-30' }));
  assert.equal(seen.toBook, 0);
  saveSource(t, '2026-07-01', 'src-2');
  refused(pullAs(t, seen, 'p-h1b'), 'review_stale');
  const file = must(fileReview(t, JULY));
  must(ignore(t, SALE.id, true));
  refused(importSettlement(t.fctx, { settlement: docOf(JULY), expectReviewSha256: file.reviewSha256, idempotencyKey: 'f-h1' }), 'review_stale');
  assert.equal(count(t, 'settlement_event'), 0, 'the file door books nothing unseen either');
  assert.equal(count(t, 'settlement_feed_event'), 0, 'and records nothing');
});

test('[code r1 H2] every event the import would book is a row: one the producer sends outside the range is shown and counted in toBook', () => {
  const t = reviewWorld();
  saveSource(t);
  const late = ev('kw:sale:2701', 'sale', '2026-10-02', '54.05', '50.00', '4.05', { chargeId: 'ch_inv_2701' });
  t.box.doc = docOf([...JULY, late]);
  const seen = must(review(t, { from: '2026-07-01', to: '2026-09-30' }));
  const row = rowOf(seen, late.id);
  assert.deepEqual([row.status, row.outsidePeriod], ['to_book', true]);
  assert.equal(seen.toBook, 4, 'toBook is what the import books');
  assert.equal(seen.totals.outputVat.amountMinor, 405, 'the period totals leave the outside event out');
  const pulled = must(pullAs(t, seen, 'p-h2'));
  assert.equal(pulled.import.booked, 4);
});

test('[code r1 H2] an event restated into the period after a skip before the from-date is a row where its VAT lands', () => {
  const t = reviewWorld();
  saveSource(t);
  const early = ev('kw:sale:2801', 'sale', '2026-06-28', '108.10', '100.00', '8.10', { chargeId: 'ch_inv_2801' });
  must(fileImport(t, [early], 'imp-early'));
  const moved = { ...early, day: '2026-07-02' };
  const res = must(fileReview(t, [...JULY, moved]));
  assert.deepEqual([rowOf(res, moved.id).status, rowOf(res, moved.id).day], ['to_book', '2026-07-02']);
  assert.equal(res.totals.outputVat.amountMinor, 405 + 810);
});

test('[code r1 H2] a file is reviewed and booked by its period: the other quarter waits for its own review', () => {
  const t = reviewWorld();
  const q4 = ev('kw:sale:2901', 'sale', '2026-10-05', '54.05', '50.00', '4.05', { chargeId: 'ch_inv_2901' });
  const q3 = must(fileReview(t, [...JULY, q4]));
  assert.deepEqual(q3.period, { from: '2026-07-01', to: '2026-09-30', unit: 'quarter' });
  assert.equal(rowOf(q3, q4.id), undefined);
  assert.equal(q3.toBook, 3);
  const part = periodPartOf(docOf([...JULY, q4]), q3.period);
  const booked = must(importSettlement(t.fctx, { settlement: part, expectReviewSha256: q3.reviewSha256, idempotencyKey: 'f-q3' }));
  assert.equal(booked.booked, 3);
  const q4review = must(fileReview(t, [...JULY, q4], { from: '2026-10-01', to: '2026-12-31' }));
  assert.equal(rowOf(q4review, q4.id).status, 'to_book');
});

test('[code r1 M2] an agent seat\'s file review is traced without the payers', () => {
  const t = reviewWorld();
  const agent = { store: t.store, clock: t.clock, ids: t.ids, actor: 'agent' };
  runGoverned(agent, getAction('settlement_review'), { workspaceId: t.workspaceId, settlement: docOf(JULY) });
  runGoverned(agent, getAction('settlement_review'), { workspaceId: t.workspaceId, content: JSON.stringify(docOf(JULY)) });
  // Security review: a wrapper verb must not carry the payers past the verb name.
  runGoverned(agent, getAction('call_tool'), { workspaceId: t.workspaceId, name: 'settlement_review', args: { settlement: docOf(JULY) } });
  const wrapped = t.store.db.prepare("SELECT args_json FROM agent_call WHERE workspace_id = ? AND verb = 'call_tool'").all(t.workspaceId).map((r) => r.args_json);
  for (const args of wrapped) assert.doesNotMatch(args, /lena\.beispiel|Lena Beispiel/);
  const traced = t.store.db.prepare("SELECT args_json FROM agent_call WHERE workspace_id = ? AND verb = 'settlement_review'").all(t.workspaceId).map((r) => r.args_json);
  assert.ok(traced.length >= 2);
  for (const args of traced) {
    assert.doesNotMatch(args, /lena\.beispiel|Lena Beispiel/);
  }
  assert.match(traced[0], /zf_po_1/, 'the rest of the document is kept');
  assert.ok(traced.some((a) => /"content":\{"omitted":true,"bytes":\d+\}/.test(a)), 'a document text is kept by its size');
});

test('[code r2 H1] the trace judges the parsed VALUE: an escaped schema, a doubly encoded text, a wrapper and an array never keep the payers', () => {
  const t = reviewWorld();
  const agent = { store: t.store, clock: t.clock, ids: t.ids, actor: 'agent' };
  const plain = JSON.stringify(docOf(JULY));
  const slash = plain.replace('till-settlement/v1', 'till-settlement\\/v1');
  const unicode = plain.replace('till-settlement/v1', 'till-settlement\\u002fv1');
  assert.notEqual(slash, plain);
  assert.equal(JSON.parse(slash).schema, 'till-settlement/v1', 'the same value, another spelling');
  const reviewed = must(settlementReview(t.fctx, { content: slash }));
  assert.equal(reviewed.rows.length, 4, 'the readers accept the escaped spelling');
  runGoverned(agent, getAction('settlement_review'), { workspaceId: t.workspaceId, content: slash });
  runGoverned(agent, getAction('settlement_review'), { workspaceId: t.workspaceId, content: '\uFEFF' + unicode });
  runGoverned(agent, getAction('call_tool'), { workspaceId: t.workspaceId, name: 'import_settlement', args: { content: slash, idempotencyKey: 'tr-h1' } });
  runGoverned(agent, getAction('call_tool'), { workspaceId: t.workspaceId, name: 'import_settlement', args: { content: JSON.stringify(slash), idempotencyKey: 'tr-h1b' } });
  runGoverned(agent, getAction('call_tool'), { workspaceId: t.workspaceId, name: 'settlement_review', args: { notes: [unicode, 'frei'] } });
  const all = t.store.db.prepare('SELECT verb, args_json FROM agent_call WHERE workspace_id = ?').all(t.workspaceId);
  assert.ok(all.length >= 5);
  for (const { verb, args_json: args } of all) {
    assert.doesNotMatch(args, /lena\.beispiel|Lena Beispiel/, `${verb} keeps no payer`);
    assert.doesNotMatch(args, /lena\\u002e|Lena\\u0020/i);
  }
  assert.ok(all.some((r) => /"content":\{"omitted":true,"bytes":\d+\}/.test(r.args_json)), 'a document text is kept by its size');
  assert.ok(all.some((r) => /"frei"/.test(r.args_json)), 'a text that holds no document is kept');
});

test('[code r3 H1, re-cut] the sink scrubs every position: a text event inside a document, agent_ask, a __proto__ key', () => {
  const t = reviewWorld();
  const agent = { store: t.store, clock: t.clock, ids: t.ids, actor: 'agent' };
  const doc = docOf(JULY);
  runGoverned(agent, getAction('settlement_review'), { workspaceId: t.workspaceId, settlement: { ...doc, events: [JSON.stringify(SALE), FEE, TRANSFER, PAYOUT] } });
  runGoverned(agent, getAction('agent_ask'), { workspaceId: t.workspaceId, text: 'Frage (erfunden)', content: JSON.stringify(doc), idempotencyKey: 'ask-h1' });
  runGoverned(agent, getAction('settlement_review'), { workspaceId: t.workspaceId, settlement: JSON.parse(`{"__proto__": {"counterpartyEmail": "lena.beispiel@kurswerk.example"}, "schema": "x"}`) });
  const all = t.store.db.prepare('SELECT verb, args_json FROM agent_call WHERE workspace_id = ?').all(t.workspaceId);
  assert.ok(all.length >= 3);
  for (const { verb, args_json: args } of all) assert.doesNotMatch(args, /lena\.beispiel|Lena Beispiel/, `${verb} keeps no payer`);
});

test('[code r3 M1 + paper] a member of an earlier period is judged by the CURRENT facts, never its flag or a stale outcome', () => {
  const t = reviewWorld();
  // Q2: a test sale (left off) and its fee (to be booked under test_fees book, but refused: 0.10 is not 8.1 %).
  const testSale = ev('kw:sale:2801', 'sale', '2026-06-29', '21.62', '20.00', '1.62', { chargeId: 'ch_inv_2801', test: true, payoutId: 'po_inv_8' });
  const badFee = ev('zf_fee_2801', 'processing_fee', '2026-06-29', '-1.10', '-1.00', '-0.10', { chargeId: 'ch_inv_2801', payoutId: 'po_inv_8' });
  const payout = ev('zf_po_8', 'bank_payout', '2026-07-02', '-20.52', '-20.52', null, { payoutId: 'po_inv_8' });
  must(fileImport(t, [testSale, badFee], 'imp-q2'));
  const q3 = must(fileReview(t, [payout]));
  const p = q3.checks.payouts.payouts.find((x) => x.eventId === payout.id);
  assert.equal(p.basis, 'refs');
  assert.equal(q3.checks.payouts.state, 'differs', 'a refused fee is no test left off by design, whatever its flag');
  assert.deepEqual([p.restMinor, p.testRestMinor], [110, 2162]);
  // A person later says the sale is no test: now it is due to be booked and is not, so it is no longer by design.
  must(resolveSettlementEvent(t.fctx, { system: SYSTEM, processor: PROCESSOR, eventId: testSale.id, resolution: 'not_test', reason: 'Echter Kauf (erfunden)', idempotencyKey: 'rse-m1' }));
  const after = must(fileReview(t, [payout]));
  const p2 = after.checks.payouts.payouts.find((x) => x.eventId === payout.id);
  assert.deepEqual([after.checks.payouts.state, p2.testRestMinor], ['differs', 0], 'the stored test_event outcome is stale; today it is no test');
});

test('[code r4 H1] an event the reader refuses is a row (refused, its code) and check (b) fails closed; an undated file event too', () => {
  const t = reviewWorld();
  const bad = ev('kw:sale:2900', 'sale', '2026-07-20', '108.10', '100.00', '8.11', { chargeId: 'ch_inv_2900' });
  const twice = ev('kw:sale:2901', 'sale', '2026-07-21', '21.62', '20.00', '1.62', { chargeId: 'ch_inv_2901' });
  const undated = { ...ev('kw:sale:2902', 'sale', '2026-07-22', '10.81', '10.00', '0.81'), day: undefined };
  const res = must(fileReview(t, [SALE, FEE, TRANSFER, PAYOUT, bad, twice, { ...twice }, undated]));
  const refusedRows = res.rows.filter((r) => r.status === 'refused');
  assert.deepEqual(
    refusedRows.map((r) => r.eventId).sort(),
    ['kw:sale:2900', 'kw:sale:2901', 'kw:sale:2902'].sort(),
    'every event the document states is a row, the unreadable ones included, ONE row per event (the twice-sent id once)',
  );
  assert.ok(refusedRows.every((r) => r.code !== null && r.toggleable === false && r.vatPostedMinor === 0 && r.unreadable === true));
  assert.equal(res.checks.vat.state, 'differs', 'stated VAT that is never booked is never ok');
  for (const id of ['kw:sale:2900', 'kw:sale:2901', 'kw:sale:2902']) assert.ok(res.checks.vat.differing.includes(id), id);
  assert.equal(res.totals.notBooked.events, 3);
  // Stepping to Q4: the undated event follows (it belongs to no period until the producer fixes it).
  const q4 = must(fileReview(t, [SALE, FEE, TRANSFER, PAYOUT, undated], { from: '2026-10-01', to: '2026-12-31' }));
  assert.deepEqual(q4.rows.filter((r) => r.status === 'refused').map((r) => r.eventId), ['kw:sale:2902']);
  assert.equal(q4.checks.vat.state, 'differs');
});

test('[code r5 H1] a booked event re-sent unreadable, once or twice, is counted once: the totals are the books', () => {
  const t = reviewWorld();
  must(fileImport(t, JULY, 'imp-r5'));
  const booked = must(fileReview(t, JULY));
  assert.equal(booked.totals.outputVat.amountMinor, 405);
  const mismatch = { ...SALE, amount: '54.06' };
  for (const sent of [[mismatch, FEE, TRANSFER, PAYOUT], [SALE, { ...SALE }, FEE, TRANSFER, PAYOUT]]) {
    const res = must(fileReview(t, sent));
    assert.equal(res.totals.outputVat.amountMinor, 405, 'the entry the books carry, once');
    assert.equal(res.totals.inputVat.amountMinor, booked.totals.inputVat.amountMinor);
    assert.equal(res.totals.turnoverNetMinor, booked.totals.turnoverNetMinor);
    assert.equal(res.checks.vat.state, 'differs', 'the unreadable copy is still never ok');
    const sale = res.rows.filter((r) => r.eventId === SALE.id);
    assert.equal(sale.length, 1, 'one row per event');
    assert.deepEqual([sale[0].status, sale[0].unreadable, sale[0].reason], ['booked', true, 'resent_unreadable'], 'the books carry it; what the producer states now cannot be read');
  }
});

test('[code r7 H1] a stand-in for an event without an id never merges with a real id that reads #1, nor with another stand-in', () => {
  const t = reviewWorld();
  const noId = { ...ev('x', 'sale', '2026-07-10', '10.81', '10.00', '0.81'), id: undefined };
  const hashId = ev('#1', 'sale', '2026-07-11', '21.62', '20.00', '1.62', { chargeId: 'ch_hash_1' });
  const undatedNoId = { ...ev('x', 'sale', '2026-07-12', '5.41', '5.00', '0.41'), id: undefined, day: undefined };
  const res = must(fileReview(t, [noId, hashId, undatedNoId]));
  const real = res.rows.filter((r) => r.eventId === '#1');
  assert.equal(real.length, 1, 'the real #1 is its own row, and the only one showing that id');
  assert.ok(res.rows.filter((r) => r.unreadable).every((r) => r.eventId === '' && r.rowKey.startsWith('standin:')));
  assert.equal(real[0].status, 'to_book');
  assert.equal(res.rows.filter((r) => r.unreadable).length, 2, 'both id-less events keep a row each');
  assert.equal(res.totals.outputVat.amountMinor, 162, 'the review predicts the books');
  // The Studio books the reviewed period part (the undated event belongs to no period); the whole file would be
  // something else than was reviewed, and the digest says so.
  refused(importSettlement(t.fctx, { settlement: docOf([noId, hashId, undatedNoId]), expectReviewSha256: res.reviewSha256, idempotencyKey: 'imp-r7-whole' }), 'review_stale');
  const booked = must(importSettlement(t.fctx, { settlement: periodPartOf(docOf([noId, hashId, undatedNoId]), res.period), expectReviewSha256: res.reviewSha256, idempotencyKey: 'imp-r7' }));
  assert.equal(booked.booked, 1);
});

test('[code r7 L1] check (b) counts what the books carry for a booked event re-sent unreadable', () => {
  const t = reviewWorld();
  must(fileImport(t, JULY, 'imp-r7l1'));
  const res = must(fileReview(t, [{ ...SALE, amount: '54.06' }, FEE, TRANSFER, PAYOUT]));
  assert.equal(res.checks.vat.state, 'differs');
  assert.equal(res.checks.vat.bookedMinor, 405 - 8, 'the sale\'s 4.05 on the books, less the fee\'s 0.08');
});

test('[code r4 L4] totals.events counts only the period\'s rows', () => {
  const t = reviewWorld();
  const q4 = ev('kw:sale:3001', 'sale', '2026-10-02', '10.81', '10.00', '0.81');
  must(fileImport(t, [q4], 'imp-l4'));
  const res = must(fileReview(t, [...JULY, q4], { from: '2026-07-01', to: '2026-09-30' }));
  assert.equal(res.totals.events, res.rows.filter((r) => !r.outsidePeriod).length);
});

test('[code r2 M1] a payout no event names keeps the payout check unknown, its whole amount the gap', () => {
  const t = reviewWorld();
  const lone = ev('zf_po_9', 'bank_payout', '2026-07-20', '-500.00', '-500.00', null, { payoutId: 'po_inv_9' });
  const res = must(fileReview(t, [...JULY, lone]));
  assert.equal(res.checks.payouts.state, 'unknown', 'never ok while a payout is unexplained');
  const p = res.checks.payouts.payouts.find((x) => x.eventId === lone.id);
  assert.deepEqual([p.basis, p.restMinor, p.unexplainedMinor], ['none', null, -50000]);
});

test('[code r2 M2] a test member the import was to book but a person ignored is a gap, judged by the outcome, not the flag', () => {
  const t = reviewWorld();
  // settlement.test_fees is `book` by default: the fee of a test payment is booked, its sale is not.
  const testSale = ev('kw:sale:2701', 'sale', '2026-07-15', '21.62', '20.00', '1.62', { chargeId: 'ch_inv_2701', test: true, payoutId: 'po_inv_7' });
  const testFee = ev('zf_fee_2701', 'processing_fee', '2026-07-15', '-1.08', '-1.00', '-0.08', { chargeId: 'ch_inv_2701', payoutId: 'po_inv_7' });
  const payout = ev('zf_po_7', 'bank_payout', '2026-07-17', '-20.54', '-20.54', null, { payoutId: 'po_inv_7' });
  const before = must(fileReview(t, [testSale, testFee, payout]));
  assert.equal(rowOf(before, testFee.id).status, 'to_book');
  assert.equal(before.checks.payouts.state, 'ok');
  must(ignore(t, testFee.id, true));
  const after = must(fileReview(t, [testSale, testFee, payout]));
  assert.equal(rowOf(after, testFee.id).reason, 'ignored');
  assert.equal(after.checks.payouts.state, 'differs', 'an ignored fee is no test left off by design');
  assert.deepEqual(after.checks.payouts.payouts.map((p) => [p.restMinor, p.testRestMinor]), [[108, 2162]]);
});

test('[code r2 M3] a template skip of a kind booked by default is a gap; a reserve hold skipped by default is not', () => {
  const t = reviewWorld();
  const hold = ev('zf_res_1', 'reserve', '2026-07-14', '-5.00', '-5.00', null, { payoutId: 'po_inv_1' });
  const held = ev(PAYOUT.id, 'bank_payout', '2026-07-16', '-27.97', '-27.97', null, { payoutId: 'po_inv_1' });
  const withHold = [SALE, FEE, TRANSFER, hold, held];
  const ok1 = must(fileReview(t, withHold));
  assert.equal(ok1.checks.payouts.state, 'ok');
  assert.deepEqual(ok1.checks.payouts.payouts.map((p) => [p.restMinor, p.skippedRestMinor]), [[0, -500]]);
  const kinds = { ...templateKinds(t), processing_fee: { action: 'skip' } };
  must(setSettlementTemplate(t.fctx, { system: SYSTEM, processor: PROCESSOR, clearingAccountId: t.acc('1095'), kinds, idempotencyKey: 'tpl-skip-fee' }));
  const red = must(fileReview(t, withHold));
  assert.equal(rowOf(red, FEE.id).reason, 'template_skip');
  assert.equal(red.checks.payouts.state, 'differs', 'a fee the owner\'s template skips is not explained by the books');
  assert.deepEqual(red.checks.payouts.payouts.map((p) => [p.restMinor, p.skippedRestMinor]), [[108, -500]]);
});

test('[code r2 pre-mortem] a member before the source\'s from-date is left off by design (the opening balance carries it)', () => {
  const t = reviewWorld();
  must(setSettlementSource(t.fctx, { system: SYSTEM, processor: PROCESSOR, baseUrl: BASE, fromDate: '2026-07-01', feedToken: TOKEN, idempotencyKey: 'src-fd' }));
  const early = ev('kw:sale:2050', 'sale', '2026-06-28', '10.81', '10.00', '0.81', { chargeId: 'ch_inv_2050', payoutId: 'po_inv_1', test: true });
  const payout = ev(PAYOUT.id, 'bank_payout', '2026-07-16', '-43.78', '-43.78', null, { payoutId: 'po_inv_1' });
  const res = must(fileReview(t, [early, SALE, FEE, TRANSFER, payout], { from: '2026-06-01', to: '2026-09-30' }));
  assert.equal(rowOf(res, early.id).reason, 'before_from_date');
  assert.equal(res.checks.payouts.state, 'ok');
  assert.deepEqual(res.checks.payouts.payouts.map((p) => [p.restMinor, p.openingRestMinor, p.skippedRestMinor, p.testRestMinor]), [[0, 1081, 0, 0]], 'its own figure (code critic r3 L1)');
});

test('[code r2 L1] a changed payer text changes what is booked, so the digest refuses the booking review_stale', () => {
  const t = reviewWorld();
  const seen = must(fileReview(t, JULY));
  const renamed = { ...SALE, counterparty: 'Erfundene Person Neu' };
  refused(importSettlement(t.fctx, { settlement: docOf([renamed, FEE, TRANSFER, PAYOUT]), expectReviewSha256: seen.reviewSha256, idempotencyKey: 'imp-l1' }), 'review_stale');
  assert.equal(count(t, 'settlement_event'), 0);
  must(importSettlement(t.fctx, { settlement: docOf(JULY), expectReviewSha256: seen.reviewSha256, idempotencyKey: 'imp-l1-ok' }));
});

// --- the counterparty refs and privacy -----------------------------------------------------------

test('the reader accepts refs.counterpartyEmail and counterpartyName of any shape; the review shows only a plausible email', () => {
  const shapes = [null, 42, { nested: true }, 'not an email', 'a@b@c.example', '  lena@kurswerk.example  '];
  const events = shapes.map((v, i) => ev(`kw:sale:25${i}`, 'sale', '2026-07-14', '54.05', '50.00', '4.05', { counterpartyEmail: v, counterpartyName: v }));
  const read = readSettlementDocument(docOf(events), 'CHF');
  assert.equal(read.ok, true);
  assert.equal(read.document.events.length, shapes.length, 'no event refused for a ref');
  assert.equal(read.document.refused.length, 0);
  assert.deepEqual(shapes.map(emailOf), [null, null, null, null, null, 'lena@kurswerk.example']);
  const t = reviewWorld();
  const res = must(fileReview(t, events));
  assert.equal(rowOf(res, 'kw:sale:255').counterparty.email, 'lena@kurswerk.example');
  assert.equal(rowOf(res, 'kw:sale:251').counterparty.name, null, 'a number is no name');
});

test('[M8, r2 M1] an agent seat sees the payer masked unless settlement.agent_sees_email is shown, and never fetches the feed', () => {
  const t = reviewWorld();
  const agent = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: fixedClock(NOW), ids: t.ids, settlementFeed: t.port });
  const masked = must(settlementReview(agent, { settlement: docOf(JULY) }));
  assert.deepEqual(rowOf(masked, SALE.id).counterparty, { email: null, name: null, masked: true, document: 'KW-R-2001', chargeId: 'ch_inv_2001' });
  must(setSettlementSource(t.fctx, { system: SYSTEM, processor: PROCESSOR, baseUrl: BASE, fromDate: '2026-07-01', feedToken: TOKEN, idempotencyKey: 'src' }));
  t.box.doc = docOf(JULY);
  refused(settlementReview(agent, { from: '2026-07-01', to: '2026-09-30' }), 'feed_review_person_only');
  assert.equal(t.box.calls, 0, 'the agent spent no token');
  setting(t, 'settlement.agent_sees_email', 'shown');
  const shown = rowOf(must(settlementReview(agent, { settlement: docOf(JULY) })), SALE.id).counterparty;
  assert.deepEqual([shown.email, shown.name, shown.masked], ['lena.beispiel@kurswerk.example', 'Lena Beispiel', false]);
});

test('[r2 M2] a booked event the document no longer carries is still shown, booked, and counted: the totals are the books', () => {
  const t = reviewWorld();
  must(fileImport(t, JULY, 'imp-m2'));
  const res = must(fileReview(t, [FEE, TRANSFER, PAYOUT], { from: '2026-07-01', to: '2026-09-30' }));
  const sale = rowOf(res, SALE.id);
  assert.deepEqual([sale.status, sale.reason, sale.toggleable], ['booked', 'not_in_document', false]);
  assert.equal(res.totals.outputVat.amountMinor, 405);
  assert.equal(res.checks.vat.state, 'ok');
});

test('[r2 M3] a test member of a payout is reported apart and never turns the payout check red', () => {
  const t = reviewWorld();
  const testSale = ev('kw:sale:2601', 'sale', '2026-07-15', '21.62', '20.00', '1.62', { chargeId: 'ch_inv_2601', test: true, payoutId: 'po_inv_2' });
  const realFee = ev('zf_fee_2601', 'processing_fee', '2026-07-15', '-1.08', '-1.00', '-0.08', { chargeId: 'ch_inv_2602', payoutId: 'po_inv_2' });
  const payout = ev('zf_po_2', 'bank_payout', '2026-07-17', '-20.54', '-20.54', null, { payoutId: 'po_inv_2' });
  const res = must(fileReview(t, [testSale, realFee, payout]));
  assert.equal(rowOf(res, testSale.id).reason, 'test_event');
  assert.deepEqual(res.checks.payouts.payouts.map((p) => [p.restMinor, p.testRestMinor]), [[0, 2162]]);
  assert.equal(res.checks.payouts.state, 'ok');
});

test('[r2 L2] the pull refuses review_stale when an answer moved after the review, even with the same feed', () => {
  const t = reviewWorld();
  must(setSettlementSource(t.fctx, { system: SYSTEM, processor: PROCESSOR, baseUrl: BASE, fromDate: '2026-07-01', feedToken: TOKEN, idempotencyKey: 'src' }));
  t.box.doc = docOf(JULY);
  const seen = must(review(t, { from: '2026-07-01', to: '2026-09-30' }));
  must(ignore(t, SALE.id, true));
  refused(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, from: '2026-07-01', to: '2026-09-30', expectReviewSha256: seen.reviewSha256, idempotencyKey: 'p-l2' }), 'review_stale');
  assert.equal(count(t, 'settlement_event'), 0);
});

// --- governance ---------------------------------------------------------------------------------

test('governance: the import and the pull pin the answers; the verbs are registered with their kinds', () => {
  for (const verb of ['import_settlement', 'pull_settlement']) {
    assert.ok(PIN_FOR_VERB[verb].some((p) => p.record === 'settlement_event_inclusions_all'), `${verb} pins the answers`);
  }
  assert.equal(getAction('settlement_review').kind, 'read');
  assert.equal(getAction('set_settlement_event_ignored').kind, 'write');
});

// --- D203: a calm start, and no reasons ---------------------------------------------------------------

test('D203: with no file, none named and no source saved, the review is a calm start (mode none), never a refusal', () => {
  const t = reviewWorld();
  const before = snapshot(t.store);
  const none = must(review(t));
  assert.equal(none.mode, 'none');
  assert.deepEqual(none.rows, []);
  assert.equal(none.toBook, 0);
  assert.equal(none.totals.turnoverNetMinor, 0);
  assert.equal(none.checks.payouts.state, 'unknown');
  assert.deepEqual(none.period, { from: '2026-10-01', to: '2026-12-31', unit: 'quarter' }, 'the period around today');
  const asked = must(review(t, { from: '2026-07-01', to: '2026-09-30' }));
  assert.equal(asked.mode, 'none');
  assert.deepEqual(asked.period, { from: '2026-07-01', to: '2026-09-30', unit: 'custom' });
  assert.equal(snapshot(t.store), before, 'it writes nothing');
  // A named source that is not saved still refuses as the pull would; a saved one is reviewed from the feed.
  refused(review(t, { system: SYSTEM, processor: PROCESSOR }), 'settlement_source_missing');
  must(setSettlementSource(t.fctx, { system: SYSTEM, processor: PROCESSOR, baseUrl: BASE, fromDate: '2026-07-01', feedToken: TOKEN, idempotencyKey: 'src-none' }));
  t.box.doc = docOf(JULY);
  assert.equal(must(review(t, { from: '2026-07-01', to: '2026-09-30' })).mode, 'feed');
});

test('D203: resolve_settlement_event takes no reason; the row keeps who and when, an empty text for the reason', () => {
  const t = reviewWorld();
  const testSale = ev('kw:sale:2402', 'sale', '2026-07-22', '54.05', '50.00', '4.05', { chargeId: 'ch_inv_2402', test: true });
  must(fileImport(t, [testSale], 'imp-test-noreason'));
  must(resolveSettlementEvent(t.fctx, { system: SYSTEM, processor: PROCESSOR, eventId: testSale.id, resolution: 'not_test', idempotencyKey: 'nt-1' }));
  const row = t.store.db.prepare('SELECT reason, actor, at FROM settlement_test_resolution WHERE workspace_id = ? AND event_id = ?').get(t.workspaceId, testSale.id);
  assert.equal(row.reason, '');
  assert.equal(row.actor, 'user_1');
  assert.ok(row.at.length > 0);
  must(resolveSettlementEvent(t.fctx, { system: SYSTEM, processor: PROCESSOR, eventId: testSale.id, resolution: 'handled_outside', reason: null, idempotencyKey: 'ho-noreason' }));
  refused(resolveSettlementEvent(t.fctx, { system: SYSTEM, processor: PROCESSOR, eventId: testSale.id, resolution: 'reopen_test', reason: 7, idempotencyKey: 'bad-reason' }), 'invalid_input');
  const res = must(fileReview(t, [testSale]));
  assert.equal(rowOf(res, testSale.id).status, 'skipped', 'handled outside the import now');
});
