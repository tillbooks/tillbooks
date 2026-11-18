// D198, the settlement feed: set_settlement_source, pull_settlement, the payout link and the pre-filing
// finding on vat_return.
//
// SYNTHETIC DATA ONLY (see support.mjs): the platform ("Kurswerk"), the processor ("Zahlfix"), every id,
// document number, person and amount is invented for these tests. Nothing is derived from a real feed,
// a real payout or a real bank line.
//
// The money-path INVARIANTS are marked [INVARIANT ...] for the non-author critic; each comment names the
// code it guards, so a mutation of that code fails it.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import {
  setSettlementSource,
  getSettlementSource,
  pullSettlement,
  settlementPayoutForBankLine,
  settlementVatFindings,
  feedUrlOf,
} from '../../dist/core/settlement/index.js';
import { runSettlementPullStep } from '../../dist/core/settlement/dailyPull.js';
import { computeVatReturn } from '../../dist/core/vat/abrechnung.js';
import { returnHashOf } from '../../dist/core/checklists/hash.js';
import { settingsSet as setSetting } from '../../dist/core/settings/index.js';
import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { runGoverned } from '../../dist/api/agent-gate.js';
import { createBankAccount } from '../../dist/core/banking/index.js';
import { createAccount } from '../../dist/core/accounts/accounts.js';
import { importLines, secondWorkspace, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { settlementWorld, setTemplate, must, refused, SYSTEM, PROCESSOR } from './support.mjs';

afterEach(assertClaimInvariantHolds);

const NOW = '2026-10-05T08:00:00.000Z';
const BASE = 'https://kurswerk.example';
const TOKEN = 'kw_test_token_0123456789abcdef';

/** A feed host for the suites: tokens in a Map, answers from a function, every fetch recorded. */
function memoryFeed(respond) {
  const tokens = new Map();
  const calls = [];
  return {
    tokens,
    calls,
    port: {
      secretStore: 'memory',
      storeToken(ref, token) {
        tokens.set(ref, token);
        return { ok: true };
      },
      deleteToken(ref) {
        tokens.delete(ref);
        return { ok: true };
      },
      hasToken: (ref) => tokens.has(ref),
      fetchFeed(req) {
        calls.push(req);
        const token = tokens.get(req.tokenRef);
        if (token === undefined) return { kind: 'no_token' };
        return respond(req, token);
      },
    },
  };
}

/** A feed that answers `doc` to the right token, 401 otherwise. */
const serving = (doc) => (req, token) => (token === TOKEN ? { kind: 'response', status: 200, body: JSON.stringify(typeof doc === 'function' ? doc(req) : doc) } : { kind: 'response', status: 401, body: '{"error":"unauthorized"}' });

/** The settlement world with a person's context that carries the feed port. */
function feedWorld(respond = serving(q3Feed()), opts = {}) {
  const t = settlementWorld();
  const feed = memoryFeed(respond);
  const ctx = makeContext(t.store, { workspaceId: t.workspaceId, actor: opts.actor ?? 'user_1', clock: fixedClock(opts.now ?? NOW), ids: t.ids, settlementFeed: feed.port });
  return { ...t, feed, fctx: ctx };
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

/**
 * The invented Q3 feed, four stories, in the D198 re-cut contract (bondigoo PR 1055 shape, every id
 * invented): every event of a payment carries its transaction key (`chargeId`, the transfer's `transferId`)
 * and `test`; every member of a PAID payout states its `payoutId` (member re-emission).
 *  A. a sale whose platform fee is WAIVED: the card fee and the coach transfer take it all, so its payout
 *     is 0.00 while its output VAT (4.05) is owed: 54.05 - 1.87 - 52.18 = 0.00;
 *  B. a 9.9 % sale with a hold and a Connect fee: 162.15 - 4.95 - 135.13 - 2.00 - 5.00 = 15.07 paid out;
 *  C. a TEST sale and its refund, netting to zero (no payout);
 *  D. a sale whose payout (7.40) never reaches the bank, and a late sale with no payout yet.
 */
export function q3Feed() {
  const sale = (id, day, amount, net, vat, refs) =>
    ev(id, 'sale', day, amount, net, vat, { paymentIntentId: `pi_inv_${id.slice(-4)}`, chargeId: `ch_inv_${id.slice(-4)}`, invoiceNumber: `KW-R-${id.slice(-4)}`, test: false, ...refs }, { document: { type: 'client_invoice', number: `KW-R-${id.slice(-4)}` } });
  return {
    schema: 'till-settlement/v1',
    source: { system: SYSTEM, processor: PROCESSOR, entity: 'Muster Grafik GmbH' },
    currency: 'CHF',
    complete: true,
    events: [
      // A
      sale('kw:sale:3001', '2026-08-03', '54.05', '50.00', '4.05', { feeWaived: true, platformFeeBp: 0, coachVatRegistered: false, transferId: 'tr_inv_3001', selfBillNumber: 'KW-G-3001', payoutId: 'po_inv_3001' }),
      ev('zf_bt_3001:fee', 'processing_fee', '2026-08-03', '-1.87', '-1.87', null, { chargeId: 'ch_inv_3001', test: false, payoutId: 'po_inv_3001' }),
      ev('zf_tr_3001', 'third_party_payout', '2026-08-03', '-52.18', '-52.18', null, { chargeId: 'ch_inv_3001', transferId: 'tr_inv_3001', test: false, payoutId: 'po_inv_3001' }),
      ev('zf_po_3001', 'bank_payout', '2026-08-05', '0.00', '0.00', null, { payoutId: 'po_inv_3001' }),
      // B
      sale('kw:sale:3002', '2026-08-10', '162.15', '150.00', '12.15', { feeWaived: false, platformFeeBp: 990, coachVatRegistered: true, transferId: 'tr_inv_3002', selfBillNumber: 'KW-G-3002', payoutId: 'po_inv_3002' }),
      ev('zf_bt_3002:fee', 'processing_fee', '2026-08-10', '-4.95', '-4.95', null, { chargeId: 'ch_inv_3002', test: false, payoutId: 'po_inv_3002' }),
      ev('zf_tr_3002', 'third_party_payout', '2026-08-10', '-135.13', '-125.00', '-10.13', { chargeId: 'ch_inv_3002', transferId: 'tr_inv_3002', test: false, payoutId: 'po_inv_3002' }),
      ev('zf_cf_3002', 'service_fee', '2026-08-11', '-2.00', '-2.00', null, { payoutId: 'po_inv_3002' }, { description: 'Connect-Gebühr' }),
      ev('zf_res_3002', 'reserve', '2026-08-11', '-5.00', '-5.00', null, { payoutId: 'po_inv_3002' }, { description: 'Mindestguthaben' }),
      ev('zf_po_3002', 'bank_payout', '2026-08-13', '-15.07', '-15.07', null, { payoutId: 'po_inv_3002' }),
      // C
      sale('kw:sale:3003', '2026-08-20', '21.62', '20.00', '1.62', { test: true }),
      ev('kw:refund:3003', 'refund', '2026-08-21', '-21.62', '-20.00', '-1.62', { chargeId: 'ch_inv_3003', test: true }),
      // D
      sale('kw:sale:3004', '2026-09-02', '108.10', '100.00', '8.10', { feeWaived: false, platformFeeBp: 990, payoutId: 'po_inv_3004' }),
      ev('zf_bt_3004:fee', 'processing_fee', '2026-09-02', '-3.40', '-3.40', null, { chargeId: 'ch_inv_3004', test: false, payoutId: 'po_inv_3004' }),
      ev('zf_tr_3004', 'third_party_payout', '2026-09-02', '-97.30', '-97.30', null, { chargeId: 'ch_inv_3004', transferId: 'tr_inv_3004', test: false, payoutId: 'po_inv_3004' }),
      ev('zf_po_3004', 'bank_payout', '2026-09-04', '-7.40', '-7.40', null, { payoutId: 'po_inv_3004' }),
      sale('kw:sale:3005', '2026-09-29', '54.05', '50.00', '4.05', { feeWaived: false }),
    ],
  };
}

function saveSource(t, extra = {}, ctx = t.fctx) {
  return setSettlementSource(ctx, { system: SYSTEM, processor: PROCESSOR, baseUrl: BASE, fromDate: '2026-07-01', feedToken: TOKEN, idempotencyKey: `src-${Math.random()}`, ...extra });
}

/** Row counts of every table the feed verbs write. */
function feedRows(t) {
  const one = (sql) => t.store.db.prepare(sql).get(t.workspaceId).n;
  return {
    entries: one('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?'),
    events: one('SELECT COUNT(*) AS n FROM settlement_event WHERE workspace_id = ?'),
    feedEvents: one('SELECT COUNT(*) AS n FROM settlement_feed_event WHERE workspace_id = ?'),
    pulls: one('SELECT COUNT(*) AS n FROM settlement_pull WHERE workspace_id = ?'),
    sources: one('SELECT COUNT(*) AS n FROM settlement_source WHERE workspace_id = ?'),
    sourceChanges: one('SELECT COUNT(*) AS n FROM settlement_source_change WHERE workspace_id = ?'),
  };
}

/** Every text cell of every table, to prove a token is nowhere in the book. */
function bookContains(store, needle) {
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  for (const { name } of tables) {
    const cols = store.db.prepare(`PRAGMA table_info("${name}")`).all().map((c) => c.name);
    for (const col of cols) {
      const hit = store.db.prepare(`SELECT 1 FROM "${name}" WHERE CAST("${col}" AS TEXT) LIKE ? LIMIT 1`).get(`%${needle}%`);
      if (hit !== undefined) return `${name}.${col}`;
    }
  }
  return null;
}

const Q3 = { from: '2026-07-01', to: '2026-09-30' };

// ================================================================================================
// 1. The source: a person's act, the token never in the book
// ================================================================================================

test('[INVARIANT token] set_settlement_source keeps the token in the secret store only: not in any table, not in any answer', () => {
  // Guards source.ts setSettlementSource (the token goes to port.storeToken, the row holds a locator) and
  // sourceView (tokenStored only), and the change history (a note, never the value).
  const t = feedWorld();
  const res = must(saveSource(t));
  const ref = t.store.db.prepare('SELECT token_ref FROM settlement_source WHERE workspace_id = ?').get(t.workspaceId).token_ref;
  assert.match(ref, /^stl-[0-9a-f]{40}$/, 'a minted locator');
  assert.equal(t.feed.tokens.get(ref), TOKEN, 'the store holds it under the locator the row holds');
  assert.equal(bookContains(t.store, TOKEN), null, 'no table holds the token');
  assert.equal(JSON.stringify(res).includes(TOKEN), false, 'the answer never carries it');
  const got = must(getSettlementSource(t.fctx, {}));
  assert.equal(JSON.stringify(got).includes(TOKEN), false);
  assert.equal(got.sources[0].tokenStored, true);
  assert.equal(got.sources[0].baseUrl, BASE);
  assert.equal(got.sources[0].secretStore, 'memory');
  assert.equal(got.pullMode, 'manual', 'the D172 default');
  const change = t.store.db.prepare('SELECT new_json FROM settlement_source_change WHERE workspace_id = ?').get(t.workspaceId);
  assert.equal(JSON.parse(change.new_json).token, 'replaced', 'the history says a token was saved, never which');
});

test('an agent seat is refused human_only under every dial, before a draft; the trace keeps the call without the token', () => {
  const t = feedWorld();
  // The engine refuses the governed seat directly.
  const agentCtx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: fixedClock(NOW), ids: t.ids, settlementFeed: t.feed.port });
  refused(saveSource(t, {}, agentCtx), 'human_only');
  assert.equal(t.feed.tokens.size, 0, 'nothing reached the store');
  // Through the transport seam: refused, not drafted, and the trace row drops the token.
  const agentDeps = { store: t.store, clock: t.clock, ids: t.ids, actor: 'agent', settlementFeed: t.feed.port };
  const r = runGoverned(agentDeps, getAction('set_settlement_source'), { workspaceId: t.workspaceId, system: SYSTEM, processor: PROCESSOR, baseUrl: BASE, fromDate: '2026-07-01', feedToken: TOKEN, idempotencyKey: 'ag-src' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'human_only');
  assert.equal(t.store.db.prepare("SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ?").get(t.workspaceId).n, 0, 'no Vorschlag');
  assert.equal(bookContains(t.store, TOKEN), null, 'the agent trace does not carry the token');
});

test('[INVARIANT token-old-name] a token sent under the OLD field name token is refused and reaches no table, directly or through call_tool', () => {
  // Guards secretArgs.ts SECRET_ARG_FIELDS (set_settlement_source lists `token` beside `feedToken`, read by the
  // trace's stripSecretsDeep in agent-gate.ts, by argsIdentity.ts and by callToolExclusion), and source.ts
  // prepareSetSource refusing `token` with invalid_input without echoing it (security review, 12.11.2026).
  const t = feedWorld();
  // A person under the old name: refused, the value never echoed, nothing stored.
  const person = setSettlementSource(t.fctx, { system: SYSTEM, processor: PROCESSOR, baseUrl: BASE, fromDate: '2026-07-01', token: TOKEN, idempotencyKey: 'old-name' });
  refused(person, 'invalid_input');
  assert.equal(person.field, 'token');
  assert.equal(JSON.stringify(person).includes(TOKEN), false);
  assert.equal(t.feed.tokens.size, 0);
  const args = { workspaceId: t.workspaceId, system: SYSTEM, processor: PROCESSOR, baseUrl: BASE, fromDate: '2026-07-01', token: TOKEN, idempotencyKey: 'ag-old' };
  for (const actor of ['agent', 'studio']) {
    const deps = { store: t.store, clock: t.clock, ids: t.ids, actor, settlementFeed: t.feed.port };
    // Directly through the transport seam.
    const direct = runGoverned(deps, getAction('set_settlement_source'), { ...args, idempotencyKey: `${actor}-direct` });
    assert.equal(direct.ok, false, JSON.stringify(direct));
    // Nested in call_tool: refused for every seat (human-only, secret argument), the nested args stripped.
    const nested = runGoverned(deps, getAction('call_tool'), { workspaceId: t.workspaceId, name: 'set_settlement_source', args: { ...args, idempotencyKey: `${actor}-nested` } });
    assert.equal(nested.ok, false, JSON.stringify(nested));
    assert.equal(nested.error, 'call_tool_not_dispatchable');
    assert.equal(JSON.stringify(nested).includes(TOKEN), false);
  }
  assert.equal(bookContains(t.store, TOKEN), null, 'no table holds the token: not the trace, not the argument identity');
  const traced = t.store.db.prepare("SELECT args_json FROM agent_call WHERE workspace_id = ? AND verb = 'call_tool'").all(t.workspaceId);
  assert.ok(traced.length > 0, 'the agent call_tool was traced');
  for (const row of traced) assert.equal(JSON.parse(row.args_json).args.tokenOmitted, true, 'the nested field is stripped with a marker');
});

test('a base URL is https (http only to localhost), without credentials or a query; a token has a safe shape', () => {
  const t = feedWorld();
  refused(saveSource(t, { baseUrl: 'http://kurswerk.example' }), 'invalid_input');
  refused(saveSource(t, { baseUrl: 'https://user:pw@kurswerk.example' }), 'invalid_input');
  refused(saveSource(t, { baseUrl: 'https://kurswerk.example/?x=1' }), 'invalid_input');
  refused(saveSource(t, { baseUrl: 'ftp://kurswerk.example' }), 'invalid_input');
  refused(saveSource(t, { feedToken: 'short' }), 'invalid_input');
  refused(saveSource(t, { feedToken: 'has a space and "quotes" 0123456789' }), 'invalid_input');
  refused(saveSource(t, { fromDate: '2026-02-30' }), 'invalid_input');
  refused(saveSource(t, { clearToken: true }), 'invalid_input');
  assert.equal(feedRows(t).sources, 0);
  must(saveSource(t, { baseUrl: 'http://localhost:4100/' }));
  assert.equal(must(getSettlementSource(t.fctx, {})).sources[0].baseUrl, 'http://localhost:4100', 'a trailing slash is dropped');
});

test('a host without a secret store refuses a token: no fallback', () => {
  const t = settlementWorld();
  refused(setSettlementSource(t.ctx, { system: SYSTEM, processor: PROCESSOR, baseUrl: BASE, fromDate: '2026-07-01', feedToken: TOKEN, idempotencyKey: 'no-port' }), 'secret_store_unavailable');
  // A source without a token can be saved; its pull then says what is missing.
  must(setSettlementSource(t.ctx, { system: SYSTEM, processor: PROCESSOR, baseUrl: BASE, fromDate: '2026-07-01', idempotencyKey: 'no-port-2' }));
  setTemplate(t);
  refused(pullSettlement(t.ctx, { system: SYSTEM, processor: PROCESSOR, idempotencyKey: 'p' }), 'feed_transport_missing');
});

test('[INVARIANT token-address] changing the base URL without a new token drops the stored token', () => {
  // Guards source.ts urlMoved/dropToken (security review, 12.11.2026).
  const t = feedWorld();
  must(saveSource(t));
  const sameUrl = must(saveSource(t, { fromDate: '2026-08-01', feedToken: undefined }));
  assert.equal(sameUrl.source.tokenStored, true, 'another from-date keeps the token');
  const moved = must(saveSource(t, { baseUrl: `${BASE}/v2`, feedToken: undefined }));
  assert.equal(moved.tokenDroppedUrlMoved, true, 'even a new path on the same host drops it');
  assert.equal(moved.source.tokenStored, false);
  assert.equal(t.feed.tokens.size, 0, 'the store no longer holds it');
  const again = must(saveSource(t, { baseUrl: 'https://elsewhere.example' }));
  assert.equal(again.source.tokenStored, true, 'a new token for the new address is kept');
});

test('[INVARIANT token-locator] a book whose locator was nulled (a copy) never touches the Keychain item of another', () => {
  // Guards source.ts: the store is addressed only through the locator this row holds; a new one is minted.
  const t = feedWorld();
  must(saveSource(t));
  const original = t.store.db.prepare('SELECT token_ref FROM settlement_source WHERE workspace_id = ?').get(t.workspaceId).token_ref;
  // The secret floor of a copy nulls the locator (landscape/secrets.ts); simulate it on this book.
  t.store.db.prepare('UPDATE settlement_source SET token_ref = NULL WHERE workspace_id = ?').run(t.workspaceId);
  must(saveSource(t, { clearToken: true, feedToken: undefined }));
  assert.equal(t.feed.tokens.get(original), TOKEN, 'clearing on the copy deletes nothing it does not hold');
  must(saveSource(t, { feedToken: 'kw_copy_token_abcdefghijklmnop' }));
  const minted = t.store.db.prepare('SELECT token_ref FROM settlement_source WHERE workspace_id = ?').get(t.workspaceId).token_ref;
  assert.notEqual(minted, original);
  assert.equal(t.feed.tokens.get(original), TOKEN, 'the original item is untouched');
});

// ================================================================================================
// 2. The pull: refusals write nothing, the import runs unchanged, a re-pull is a no-op
// ================================================================================================

test('nothing is fetched without a saved source, a saved template and a token', () => {
  const t = feedWorld();
  refused(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, idempotencyKey: 'p0' }), 'settlement_source_missing');
  must(saveSource(t));
  refused(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, idempotencyKey: 'p1' }), 'settlement_template_missing');
  assert.equal(t.feed.calls.length, 0, '[INVARIANT no-template] the feed was never opened without a template');
  setTemplate(t);
  must(saveSource(t, { clearToken: true, feedToken: undefined }));
  refused(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, idempotencyKey: 'p2' }), 'token_missing');
  assert.equal(t.feed.calls.length, 0);
  assert.equal(feedRows(t).pulls, 0);
});

test('every feed failure is refused with its code and a sentence, writing nothing: unreachable, 401, 400, 500, not JSON, wrong schema, another source', () => {
  const answers = {
    unreachable: () => ({ kind: 'unreachable', reason: 'ECONNREFUSED' }),
    unauthorized: () => ({ kind: 'response', status: 401, body: '{"error":"bad token"}' }),
    bad: () => ({ kind: 'response', status: 400, body: '{"error":"range longer than 366 days"}' }),
    server: () => ({ kind: 'response', status: 503, body: 'down' }),
    notJson: () => ({ kind: 'response', status: 200, body: '<html>' }),
    schema: () => ({ kind: 'response', status: 200, body: JSON.stringify({ ...q3Feed(), schema: 'till-settlement/v9' }) }),
    other: () => ({ kind: 'response', status: 200, body: JSON.stringify({ ...q3Feed(), source: { system: 'Anderswo', processor: PROCESSOR } }) }),
  };
  const expected = {
    unreachable: 'feed_unreachable',
    unauthorized: 'feed_unauthorized',
    bad: 'feed_bad_request',
    server: 'feed_http_error',
    notJson: 'feed_schema',
    schema: 'feed_schema',
    other: 'feed_source_mismatch',
  };
  for (const [name, respond] of Object.entries(answers)) {
    const t = feedWorld(respond);
    must(saveSource(t));
    setTemplate(t);
    const before = feedRows(t);
    const r = pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, ...Q3, idempotencyKey: `f-${name}` });
    refused(r, expected[name]);
    assert.ok(typeof r.reason === 'string' && r.reason.length > 10, `${name}: a sentence`);
    assert.deepEqual(feedRows(t), before, `${name}: nothing written`);
  }
});

test('a 401 says to save the current token again; the wrong token is never echoed', () => {
  const t = feedWorld();
  must(saveSource(t, { feedToken: 'kw_old_token_9876543210zyxwvu' }));
  setTemplate(t);
  const r = pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, ...Q3, idempotencyKey: 'old' });
  refused(r, 'feed_unauthorized');
  assert.match(r.reason, /token/);
  assert.equal(JSON.stringify(r).includes('kw_old_token'), false);
});

test('the pull asks the contract URL with the source range and books through import_settlement', () => {
  const t = feedWorld();
  must(saveSource(t));
  setTemplate(t);
  const res = must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, ...Q3, idempotencyKey: 'q3' }));
  assert.equal(t.feed.calls.length, 1);
  assert.equal(t.feed.calls[0].url, feedUrlOf(BASE, '2026-07-01', '2026-09-30'));
  assert.equal(t.feed.calls[0].url, 'https://kurswerk.example/api/accounting/till-settlement?from=2026-07-01&to=2026-09-30');
  assert.equal(res.eventsSeen, 17);
  assert.equal(res.eventsNew, 17, 'every event is observed, the skipped kinds included');
  // 11 bookable events (four real sales, four fees, three transfers); the test pair is skipped under the
  // default settlement.test_events = skip (D198 re-cut R1); three payouts (the 0.00 one included) and the
  // reserve skip by the template.
  assert.equal(res.import.booked, 11, JSON.stringify(res.import.events.filter((e) => e.outcome !== 'booked' && e.outcome !== 'skipped')));
  assert.equal(res.import.refused, 0);
  assert.equal(res.import.skipped, 6);
  assert.equal(res.complete, true);
  assert.equal(feedRows(t).pulls, 1);
  const src = must(getSettlementSource(t.fctx, {})).sources[0];
  assert.equal(src.watermark, '2026-09-30');
  assert.equal(src.lastPull.outcome, 'ok');
  assert.equal(src.lastPull.booked, 11);
  assert.equal(src.lastPull.eventsNew, 17);
});

test('[INVARIANT idempotent-on-rows] a re-pull of the same range books nothing and stores nothing twice', () => {
  // Guards the reuse of import_settlement's per-event idempotency (settlement_event unique index) and the
  // observed-record dedupe in importSettlement's recordObserved (INSERT OR IGNORE on the unique index).
  const t = feedWorld();
  must(saveSource(t));
  setTemplate(t);
  must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, ...Q3, idempotencyKey: 'first' }));
  const after = feedRows(t);
  const again = must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, ...Q3, idempotencyKey: 'second' }));
  assert.equal(again.import.booked, 0);
  assert.equal(again.import.alreadyImported, 11);
  assert.equal(again.eventsNew, 0);
  assert.deepEqual({ ...feedRows(t), pulls: after.pulls }, after, 'no entry, no event, no observed row added');
  assert.equal(feedRows(t).pulls, after.pulls + 1, 'the second pull is logged');
  // The same key replays the first answer without fetching again.
  const calls = t.feed.calls.length;
  assert.deepEqual(must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, ...Q3, idempotencyKey: 'second' })), again);
  assert.equal(t.feed.calls.length, calls, 'a replay does not fetch');
});

test('an event the feed later states with other figures is counted amendedSeen and refused event_amended; nothing is edited', () => {
  let amend = false;
  const t = feedWorld(serving(() => {
    const doc = q3Feed();
    if (amend) doc.events[0] = { ...doc.events[0], amount: '64.86', net: '60.00', vat: { amount: '4.86' } };
    return doc;
  }));
  must(saveSource(t));
  setTemplate(t);
  must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, ...Q3, idempotencyKey: 'a1' }));
  amend = true;
  const before = feedRows(t);
  const r = must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, ...Q3, idempotencyKey: 'a2' }));
  assert.equal(r.amendedSeen, 1);
  assert.equal(r.import.events.find((e) => e.id === 'kw:sale:3001').code, 'event_amended');
  const stored = t.store.db.prepare("SELECT amount_minor FROM settlement_feed_event WHERE workspace_id = ? AND event_id = 'kw:sale:3001'").get(t.workspaceId);
  assert.equal(stored.amount_minor, 5405, 'the observed record keeps what was first seen');
  assert.equal(feedRows(t).entries, before.entries);
});

test('the default range runs from the watermark less 7 days to today, never before the from-date; a long default range is cut with more', () => {
  const t = feedWorld(serving(q3Feed()), { now: '2027-09-10T08:00:00.000Z' });
  must(saveSource(t, { fromDate: '2026-07-01' }));
  setTemplate(t);
  const first = must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, idempotencyKey: 'd1' }));
  assert.equal(first.from, '2026-07-01');
  assert.equal(first.to, '2027-07-01', '366 days inclusive');
  assert.equal(first.more, true);
  const second = must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, idempotencyKey: 'd2' }));
  assert.equal(second.from, '2027-06-24', 'the watermark less 7 days');
  assert.equal(second.to, '2027-09-10', 'today in Switzerland');
  assert.equal(second.more, false);
  refused(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, from: '2026-07-01', to: '2027-08-01', idempotencyKey: 'd3' }), 'invalid_input');
  // A from before the source's from-date is moved up to it.
  assert.equal(must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, from: '2026-01-01', to: '2026-12-31', idempotencyKey: 'd4' })).from, '2026-07-01');
});

// ================================================================================================
// 3. The four stories, booked: the 0.00 payout, the 9.9 % sale with holds, the test sale netting to zero
// ================================================================================================

test('[INVARIANT vat] a waived-fee sale with a 0.00 payout still books its output VAT; the test sale and its refund are not booked', () => {
  // Guards that the pull hands every event to import_settlement (the VAT comes from the feed, not the bank),
  // and the import's test check (importSettlement.ts step 4, `testSkips` + `isTestEvent`) under the default
  // settlement.test_events = skip (the owner, 12.11.2026: never book a test transaction as an actual one).
  const t = feedWorld();
  must(saveSource(t));
  setTemplate(t);
  const r = must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, ...Q3, idempotencyKey: 'v' }));
  const ret = must(computeVatReturn(t.fctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' }));
  const ust = ret.lines.filter((l) => l.code === '303').reduce((s, l) => s + l.taxMinor, 0);
  // 4.05 + 12.15 + 8.10 + 4.05 = 28.35: the 0.00-payout sale is in, the test pair is not.
  assert.equal(ust, 2835);
  const pair = t.store.db.prepare("SELECT COUNT(*) AS n FROM settlement_event WHERE workspace_id = ? AND event_id IN ('kw:sale:3003', 'kw:refund:3003')").get(t.workspaceId).n;
  assert.equal(pair, 0, 'the test sale and its refund are never booked');
  assert.deepEqual(r.import.events.filter((e) => e.reason === 'test_event').map((e) => e.id), ['kw:sale:3003', 'kw:refund:3003']);
  assert.equal(t.store.db.prepare("SELECT test FROM settlement_feed_event WHERE workspace_id = ? AND event_id = 'kw:sale:3003'").get(t.workspaceId).test, 1, 'but it is kept as seen');
});

test('under settlement.test_events = book the test sale and its refund are booked and net to zero', () => {
  const t = feedWorld();
  must(setSetting(t.fctx, { key: 'settlement.test_events', value: 'book', reason: 'Testzahlungen sind hier echtes Geld', idempotencyKey: 'te' }));
  must(saveSource(t));
  setTemplate(t);
  const r = must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, ...Q3, idempotencyKey: 'ts' }));
  assert.equal(r.import.booked, 13);
  const pair = t.store.db.prepare("SELECT SUM(amount_minor) AS s, COUNT(*) AS n FROM settlement_event WHERE workspace_id = ? AND event_id IN ('kw:sale:3003', 'kw:refund:3003')").get(t.workspaceId);
  assert.deepEqual({ ...pair }, { s: 0, n: 2 }, 'the test pair is booked and nets to zero');
});

// ================================================================================================
// 4. The payout link
// ================================================================================================

test('[INVARIANT payout-link] a bank line of 15.07 is the 9.9 % sale payout, and its composition explains it to the Rappen', () => {
  // Guards payoutLink.ts payoutsMatching (amount sign, ±3 days, clearing account) and compositionOf (exact
  // only, D198 re-cut R5: the members that state the payout's payoutId).
  const t = feedWorld();
  must(saveSource(t));
  setTemplate(t);
  must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, ...Q3, idempotencyKey: 'pl' }));
  const { lines } = importLines(t, { statementId: 'zkb-inv-08', from: '2026-08-01', to: '2026-08-31', entries: [
    { ref: 'pay-1507', amountMinor: 1507, cd: 'CRDT', date: '2026-08-14', name: 'Zahlfix Payments' },
    { ref: 'far-1507', amountMinor: 1507, cd: 'CRDT', date: '2026-08-20', name: 'Zahlfix Payments' },
    { ref: 'out-1507', amountMinor: 1507, cd: 'DBIT', date: '2026-08-14', name: 'Irgendwer' },
  ] });
  const hit = must(settlementPayoutForBankLine(t.fctx, { bankTxnId: lines['pay-1507'] }));
  assert.equal(hit.match, 'one');
  const m = hit.matches[0];
  assert.equal(m.payoutEventId, 'zf_po_3002');
  assert.equal(m.payoutId, 'po_inv_3002');
  assert.equal(m.dayDistance, 1);
  assert.equal(m.clearingAccountId, t.acc('1095'));
  assert.equal(m.composition.basis, 'refs');
  assert.deepEqual(m.composition.events.map((e) => e.eventId), ['kw:sale:3002', 'zf_bt_3002:fee', 'zf_tr_3002', 'zf_cf_3002', 'zf_res_3002']);
  assert.equal(m.composition.sumMinor, 1507);
  assert.equal(m.composition.residualMinor, 0);
  assert.equal(m.composition.byKind.reserve.amountMinor, -500, 'the hold is named');
  assert.equal(m.composition.events[0].feeWaived, false);
  assert.equal(must(settlementPayoutForBankLine(t.fctx, { bankTxnId: lines['far-1507'] })).match, 'none', 'seven days away is not the payout');
  assert.equal(must(settlementPayoutForBankLine(t.fctx, { bankTxnId: lines['out-1507'] })).match, 'none', 'money going out is never a payout');
  assert.equal(must(settlementPayoutForBankLine(t.fctx, { bankTxnId: lines['pay-1507'], clearingAccountId: t.acc('1020') })).match, 'none', 'another clearing account');
  // The waived-fee payout of 0.00 is made of the sale, its card fee and the transfer.
  const zero = t.store.db.prepare("SELECT rowid, * FROM settlement_feed_event WHERE workspace_id = ? AND event_id = 'zf_po_3001'").get(t.workspaceId);
  assert.equal(zero.amount_minor, 0);
});

test('a producer that states the payout on its events gets the exact composition (basis refs)', () => {
  const doc = q3Feed();
  for (const e of doc.events) if (['kw:sale:3004', 'zf_bt_3004:fee', 'zf_tr_3004'].includes(e.id)) e.refs = { ...e.refs, payoutId: 'po_inv_3004' };
  const t = feedWorld(serving(doc));
  must(saveSource(t));
  setTemplate(t);
  must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, ...Q3, idempotencyKey: 'refs' }));
  const { lines } = importLines(t, { statementId: 'zkb-inv-09', from: '2026-09-01', to: '2026-09-30', entries: [{ ref: 'p740', amountMinor: 740, cd: 'CRDT', date: '2026-09-04' }] });
  const m = must(settlementPayoutForBankLine(t.fctx, { bankTxnId: lines['p740'] })).matches[0];
  assert.equal(m.composition.basis, 'refs');
  assert.deepEqual(m.composition.events.map((e) => e.eventId), ['kw:sale:3004', 'zf_bt_3004:fee', 'zf_tr_3004'], 'the test pair of the window is not in it');
  assert.equal(m.composition.residualMinor, 0);
});

// ================================================================================================
// 5. The pre-filing finding
// ================================================================================================

test('[INVARIANT finding] vat_return carries the books-based check and the days no pull covers; it never blocks', () => {
  // Guards vatFindings.ts (D198 stateless check S1: books-based, not bank-based; test events under skip left
  // out, gaps) and its wiring into computeVatReturn.
  const t = feedWorld();
  must(saveSource(t));
  setTemplate(t);
  const before = settlementVatFindings(t.fctx, '2026-07-01', '2026-09-30');
  assert.deepEqual(before.uncoveredSources, [{ system: 'kurswerk', processor: 'zahlfix', gaps: [{ from: '2026-07-01', to: '2026-09-30' }] }], 'a source nobody pulled');
  must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, from: '2026-07-01', to: '2026-08-31', idempotencyKey: 'f1' }));
  const partial = settlementVatFindings(t.fctx, '2026-07-01', '2026-09-30');
  assert.deepEqual(partial.uncoveredSources[0].gaps, [{ from: '2026-09-01', to: '2026-09-30' }]);
  must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, from: '2026-09-01', to: '2026-09-30', idempotencyKey: 'f2' }));
  const ret = must(computeVatReturn(t.fctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' }));
  const f = ret.settlement;
  assert.deepEqual(f.uncoveredSources, []);
  // Every real sale is booked in Q3, whatever the bank shows (the 0.00 payout and the payout not on the bank
  // are no VAT question): nothing is listed.
  assert.deepEqual([f.missing, f.bookedTwice, f.amended, f.overrideCheck, f.earlier], [[], [], [], [], []]);
  assert.deepEqual(f.missingVatMinor, { sale: 0, refund: 0, input: 0 });
  // The test pair is counted as test activity, never listed: it nets to zero on the clearing account.
  assert.deepEqual(f.testActivity.byKind, { sale: { count: 1, amountMinor: 2162 }, refund: { count: 1, amountMinor: -2162 } });
  assert.equal(f.testActivity.testResidueMinor, 0);
  assert.deepEqual(f.testActivity.unrefundedTestSales, []);
  // A test flag never hides VAT silently (security review): the pair's VAT is shown, by its count.
  assert.deepEqual(f.testExcluded, { sale: { events: 1, vatMinor: 162 }, refund: { events: 1, vatMinor: -162 }, input: { events: 0, vatMinor: 0 } });
  assert.equal(f.hasFindings, true);
  assert.equal(ret.salesNotOnBank, undefined, 'the finding is one field, the return stands');
});

test('a sale the import did not book is VAT the return misses, and the finding says how much', () => {
  const t = feedWorld();
  must(saveSource(t));
  // A template that sends sales to a person: nothing books them.
  must(getAction('set_settlement_template').run({ store: t.store, clock: t.clock, ids: t.ids, actor: 'user_1' }, {
    workspaceId: t.workspaceId,
    system: SYSTEM,
    processor: PROCESSOR,
    clearingAccountId: t.acc('1095'),
    kinds: { sale: { action: 'attention' }, refund: { action: 'attention' }, processing_fee: { action: 'skip' }, service_fee: { action: 'skip' }, third_party_payout: { action: 'skip' } },
    idempotencyKey: 'tpl-att',
  }));
  must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, ...Q3, idempotencyKey: 'att' }));
  const f = settlementVatFindings(t.fctx, '2026-07-01', '2026-09-30');
  // Every real sale qualifies (the test pair is left out under skip), and none is booked.
  assert.deepEqual(f.missing.map((u) => [u.eventId, u.reason, u.figure]), [
    ['kw:sale:3001', 'missing', 0],
    ['kw:sale:3002', 'missing', 0],
    ['kw:sale:3004', 'missing', 0],
    ['kw:sale:3005', 'missing', 0],
  ]);
  assert.deepEqual(f.missingVatMinor, { sale: 405 + 1215 + 810 + 405, refund: 0, input: 0 });
  // The coach transfer with input VAT is skipped by the owner's template: counted, never listed.
  assert.deepEqual(f.templateSkipped, { count: 1, vatMinor: -1013 });
  assert.equal(f.hasFindings, true);
});

// ================================================================================================
// 6. Append-only, tenancy, the daily pull, the REST twin
// ================================================================================================

test('[INVARIANT append-only] the pull log, the observed events and the source history refuse UPDATE and DELETE', () => {
  // Guards the triggers in schema.ts.
  const t = feedWorld();
  must(saveSource(t));
  setTemplate(t);
  must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, ...Q3, idempotencyKey: 'ao' }));
  for (const table of ['settlement_pull', 'settlement_feed_event', 'settlement_source_change']) {
    assert.throws(() => t.store.db.prepare(`UPDATE ${table} SET workspace_id = workspace_id WHERE workspace_id = ?`).run(t.workspaceId), /append-only/, `${table} UPDATE`);
    assert.throws(() => t.store.db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(t.workspaceId), /append-only/, `${table} DELETE`);
  }
});

test('[INVARIANT tenant] another workspace sees no source, no observed event, no payout and no finding', () => {
  // Guards the workspace_id filter on every query of source.ts, payoutLink.ts and vatFindings.ts.
  const t = feedWorld();
  must(saveSource(t));
  setTemplate(t);
  must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, ...Q3, idempotencyKey: 'ten' }));
  const b = secondWorkspace(t);
  const bctx = makeContext(t.store, { workspaceId: b.workspaceId, actor: 'user_1', clock: fixedClock(NOW), ids: t.ids, settlementFeed: t.feed.port });
  assert.deepEqual(must(getSettlementSource(bctx, {})).sources, []);
  refused(pullSettlement(bctx, { system: SYSTEM, processor: PROCESSOR, ...Q3, idempotencyKey: 'ten-b' }), 'settlement_source_missing');
  const bBank = must(createBankAccount(bctx, { name: 'Nachbarkonto', iban: 'CH9300762011623852957', currency: 'CHF', ledgerAccountId: b.acc('1020'), idempotencyKey: 'b-bank' }));
  const { lines } = importLines({ ...b, store: t.store }, { statementId: 'b-08', iban: 'CH9300762011623852957', from: '2026-08-01', to: '2026-08-31', entries: [{ ref: 'bp', amountMinor: 1507, cd: 'CRDT', date: '2026-08-14' }] }, { ctx: bctx, bankAccountId: bBank.bankAccountId });
  assert.equal(must(settlementPayoutForBankLine(bctx, { bankTxnId: lines['bp'] })).match, 'none');
  refused(settlementPayoutForBankLine(t.fctx, { bankTxnId: lines['bp'] }), 'not_found');
  const f = settlementVatFindings(bctx, '2026-07-01', '2026-09-30');
  assert.equal(f.hasFindings, false);
});

test('the daily pull runs once per Swiss day as the person who saved the source, and logs a failed attempt', () => {
  const t = feedWorld();
  must(saveSource(t));
  setTemplate(t);
  const step = (ctx) => runSettlementPullStep(ctx, { pull: (actor, input) => pullSettlement({ ...ctx, actor }, input), holdsPost: () => true });
  assert.deepEqual(step(t.fctx), [], 'manual mode: nothing runs');
  must(setSetting(t.fctx, { key: 'settlement.pull_mode', value: 'daily', reason: 'Feed täglich abholen', idempotencyKey: 'mode' }));
  const first = step(t.fctx);
  assert.equal(first[0].outcome, 'pulled');
  assert.equal(step(t.fctx)[0].outcome, 'skipped', 'once per day');
  const row = t.store.db.prepare("SELECT trigger_kind, actor, outcome FROM settlement_pull WHERE workspace_id = ? ORDER BY rowid DESC").get(t.workspaceId);
  assert.deepEqual(row, { trigger_kind: 'daily', actor: 'user_1', outcome: 'ok' });
  // A failing feed on the next day is recorded with its code.
  const failing = feedWorld(() => ({ kind: 'unreachable', reason: 'offline' }));
  must(saveSource(failing));
  setTemplate(failing);
  must(setSetting(failing.fctx, { key: 'settlement.pull_mode', value: 'daily', reason: 'Feed täglich abholen', idempotencyKey: 'mode' }));
  const failed = runSettlementPullStep(failing.fctx, { pull: (actor, input) => pullSettlement({ ...failing.fctx, actor }, input), holdsPost: () => true });
  assert.deepEqual(failed, [{ sourceId: failed[0].sourceId, outcome: 'failed', code: 'feed_unreachable' }]);
  const last = must(getSettlementSource(failing.fctx, {})).sources[0].lastPull;
  assert.equal(last.outcome, 'failed');
  assert.equal(last.errorCode, 'feed_unreachable');
  assert.equal(must(getSettlementSource(failing.fctx, {})).sources[0].watermark, null, 'a failed pull moves no watermark');
  // Nobody who may post: recorded as no_actor, nothing fetched.
  const calls = failing.feed.calls.length;
  const later = { ...failing.fctx, clock: fixedClock('2026-10-05T10:30:00.000Z') };
  const noActor = runSettlementPullStep(later, { pull: () => assert.fail('must not run'), holdsPost: () => false });
  assert.equal(noActor[0].code, 'no_actor');
  assert.equal(failing.feed.calls.length, calls);
});

test('the REST twin and the MCP verb answer the same, never the token', () => {
  const t = feedWorld();
  const deps = { store: t.store, clock: fixedClock(NOW), ids: t.ids, actor: 'studio', settlementFeed: t.feed.port };
  const saved = handleRest('set_settlement_source', { workspaceId: t.workspaceId, system: SYSTEM, processor: PROCESSOR, baseUrl: BASE, fromDate: '2026-07-01', feedToken: TOKEN, idempotencyKey: 'rest' }, deps);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(JSON.stringify(saved.body).includes(TOKEN), false);
  const viaRest = handleRest('get_settlement_source', { workspaceId: t.workspaceId }, deps).body;
  const viaMcp = getAction('get_settlement_source').run(deps, { workspaceId: t.workspaceId });
  assert.deepEqual(viaRest, viaMcp);
  assert.equal(viaMcp.sources[0].tokenStored, true);
  assert.equal(JSON.stringify(viaMcp).includes(TOKEN), false);
});

// ================================================================================================
// 7. Critic round 1 regressions (D198, 12.11.2026)
// ================================================================================================

test('[INVARIANT hash] the finding never moves the G22 return hash (critic r1 F1)', () => {
  // Guards hash.ts returnHashOf leaving `settlement` out: a signed-off return must not read stale because
  // a source was saved or a pull ran, and no bound hash may move on upgrade.
  const t = feedWorld();
  const before = must(computeVatReturn(t.fctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' }));
  must(saveSource(t));
  const after = must(computeVatReturn(t.fctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' }));
  assert.notDeepEqual(after.settlement, before.settlement, 'the finding changed');
  assert.equal(returnHashOf(after), returnHashOf(before));
  const { settlement: _s, ...legacy } = after;
  assert.equal(returnHashOf(after), returnHashOf(legacy), 'the hash is the one a return without the field had');
});

test('[INVARIANT coverage] a range into the future is cut at today, and a pull covers only the days before it ran (critic r1 F2)', () => {
  // Guards preparePull's clamp of `to` and coveredRangesOf.
  const t = feedWorld();
  must(saveSource(t));
  setTemplate(t);
  const r = must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, from: '2026-07-01', to: '2027-06-30', idempotencyKey: 'fut' }));
  assert.equal(r.to, '2026-10-05', 'cut at today in Switzerland');
  const src = must(getSettlementSource(t.fctx, {})).sources[0];
  assert.equal(src.watermark, '2026-10-04', 'the pull day itself is not covered yet');
  const q4 = settlementVatFindings(t.fctx, '2026-10-01', '2026-12-31');
  assert.deepEqual(q4.uncoveredSources[0].gaps, [{ from: '2026-10-05', to: '2026-12-31' }]);
  // A later default pull still works.
  const later = { ...t.fctx, clock: fixedClock('2026-12-20T08:00:00.000Z') };
  const next = must(pullSettlement(later, { system: SYSTEM, processor: PROCESSOR, idempotencyKey: 'fut-2' }));
  assert.equal(next.from, '2026-09-27');
  assert.equal(next.to, '2026-12-20');
});

test('a payout no event states yet is in transit (basis none), and a sale stating an unseen payout is checked by the books (re-cut R5, critic r1 F4)', () => {
  const doc = q3Feed();
  doc.events.push(
    { id: 'kw:sale:3007', kind: 'sale', day: '2026-09-15', currency: 'CHF', amount: '54.05', net: '50.00', vat: { amount: '4.05' }, refs: { chargeId: 'ch_inv_3007', payoutId: 'po_never_seen', test: false } },
    { id: 'zf_po_3008', kind: 'bank_payout', day: '2026-09-17', currency: 'CHF', amount: '-50.00', net: '-50.00', vat: null, refs: { payoutId: 'po_other' } },
  );
  const t = feedWorld(serving(doc));
  must(saveSource(t));
  setTemplate(t);
  must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, ...Q3, idempotencyKey: 'st' }));
  const { lines } = importLines(t, { statementId: 'zkb-inv-09b', from: '2026-09-01', to: '2026-09-30', entries: [{ ref: 'p5000', amountMinor: 5000, cd: 'CRDT', date: '2026-09-17' }] });
  const m = must(settlementPayoutForBankLine(t.fctx, { bankTxnId: lines['p5000'] })).matches[0];
  assert.equal(m.composition.basis, 'none', 'no event states po_other: never guessed from a day window');
  assert.deepEqual(m.composition.events, []);
  assert.equal(m.composition.residualMinor, -5000);
  const f = settlementVatFindings(t.fctx, '2026-07-01', '2026-09-30');
  assert.ok(!f.missing.some((x) => x.eventId === 'kw:sale:3007'), 'the sale is booked: its VAT is in the return, wherever its money is');
});

test('a payout link the producer adds on a later pull counts, and the exact composition is complete (critic r1 F5)', () => {
  let linked = false;
  const t = feedWorld(serving(() => {
    const doc = q3Feed();
    // The first pull states the payout on the bank_payout only (a producer before member re-emission).
    if (!linked) for (const e of doc.events) if (['kw:sale:3002', 'zf_bt_3002:fee', 'zf_tr_3002', 'zf_cf_3002', 'zf_res_3002'].includes(e.id)) delete e.refs.payoutId;
    return doc;
  }));
  must(saveSource(t));
  setTemplate(t);
  must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, ...Q3, idempotencyKey: 'l1' }));
  linked = true;
  const again = must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, ...Q3, idempotencyKey: 'l2' }));
  assert.equal(again.amendedSeen, 0, 'a new link is no amended figure');
  const { lines } = importLines(t, { statementId: 'zkb-inv-08c', from: '2026-08-01', to: '2026-08-31', entries: [{ ref: 'p1507', amountMinor: 1507, cd: 'CRDT', date: '2026-08-13' }] });
  const m = must(settlementPayoutForBankLine(t.fctx, { bankTxnId: lines['p1507'] })).matches[0];
  assert.equal(m.composition.basis, 'refs');
  assert.equal(m.composition.events.length, 5);
  assert.equal(m.composition.residualMinor, 0);
});

test('an error body that echoes the request never carries a credential into the answer (critic r1 F6)', () => {
  const t = feedWorld(() => ({ kind: 'response', status: 500, body: `debug: authorization=Bearer ${TOKEN} x-api-key: abcdefghijklmnopqrstuvwxyz0123` }));
  must(saveSource(t));
  setTemplate(t);
  const r = pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, ...Q3, idempotencyKey: 'echo' });
  refused(r, 'feed_http_error');
  assert.equal(JSON.stringify(r).includes(TOKEN), false);
  assert.equal(JSON.stringify(r).includes('abcdefghijklmnopqrstuvwxyz0123'), false);
  // Critic r2 N2: a short token after a lowercase word, and a JSON-escaped one, are withheld too.
  for (const body of ['upstream said: Authorization: Bearer abcdEFGH0123456789xy', '{"headers":{"Authorization":"Bearer kw\\/test\\/token\\/0123456789abcdef+Zq=="}}']) {
    const u = feedWorld(() => ({ kind: 'response', status: 400, body }));
    must(saveSource(u));
    setTemplate(u);
    const rr = pullSettlement(u.fctx, { system: SYSTEM, processor: PROCESSOR, ...Q3, idempotencyKey: 'echo2' });
    assert.equal(rr.detail, '[withheld: the answer mentions a credential]');
  }
});

test('the same key with other arguments is refused, never replayed as if it were the same save (critic r1 F7)', () => {
  const t = feedWorld();
  const deps = { store: t.store, clock: fixedClock(NOW), ids: t.ids, actor: 'studio', settlementFeed: t.feed.port };
  const base = { workspaceId: t.workspaceId, system: SYSTEM, processor: PROCESSOR, fromDate: '2026-07-01', feedToken: TOKEN, idempotencyKey: 'same-key' };
  assert.equal(getAction('set_settlement_source').run(deps, { ...base, baseUrl: BASE }).ok, true);
  const second = getAction('set_settlement_source').run(deps, { ...base, baseUrl: 'https://elsewhere.example' });
  assert.equal(second.ok, false, JSON.stringify(second));
  assert.equal(must(getSettlementSource(t.fctx, {})).sources[0].baseUrl, BASE);
  // Security review: the argument identity never holds the token, not even its hash.
  const sha = createHash('sha256').update(JSON.stringify(TOKEN)).digest('hex');
  const shaRaw = createHash('sha256').update(TOKEN).digest('hex');
  for (const needle of [sha, shaRaw, TOKEN]) assert.equal(bookContains(t.store, needle), null, `no table holds ${needle.slice(0, 8)}`);
});

test('a pull the import refuses whole writes nothing, and the same key works once the template is fixed (critic r1 F8)', () => {
  const t = feedWorld();
  must(saveSource(t));
  // A template that maps sales only: the feed carries fees and transfers too.
  must(getAction('set_settlement_template').run({ store: t.store, clock: t.clock, ids: t.ids, actor: 'user_1' }, {
    workspaceId: t.workspaceId, system: SYSTEM, processor: PROCESSOR, clearingAccountId: t.acc('1095'),
    kinds: { sale: { action: 'book', accountId: t.acc('3400'), taxCode: 'UST81' } }, idempotencyKey: 'tpl-thin',
  }));
  const idem = () => t.store.db.prepare('SELECT COUNT(*) AS n FROM idempotency WHERE workspace_id = ?').get(t.workspaceId).n;
  const before = { rows: feedRows(t), idem: idem() };
  refused(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, ...Q3, idempotencyKey: 'fix' }), 'settlement_template_incomplete');
  assert.deepEqual({ rows: feedRows(t), idem: idem() }, before, 'nothing written, not even a memo');
  setTemplate(t, t.ctx, t.acc, 'tpl-full');
  assert.equal(must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, ...Q3, idempotencyKey: 'fix' })).import.booked, 11);
});

test('[INVARIANT payout-window] the match window is 3 days exactly, the line must be in the workspace currency, and the composition is exactly the events that state the payout', () => {
  // Guards PAYOUT_MATCH_DAYS, the currency filter and compositionOf (re-cut R5: the stated members only, and
  // `partial` whenever they do not explain the payout to the Rappen).
  const doc = q3Feed();
  doc.events.push(
    { id: 'zf_edge_prev', kind: 'processing_fee', day: '2026-08-12', currency: 'CHF', amount: '-0.10', net: '-0.10', vat: null, refs: { chargeId: 'ch_inv_edge' } },
    { id: 'zf_edge_this', kind: 'processing_fee', day: '2026-08-13', currency: 'CHF', amount: '-0.20', net: '-0.20', vat: null, refs: { chargeId: 'ch_inv_edge', payoutId: 'po_inv_3002' } },
  );
  const t = feedWorld(serving(doc));
  must(saveSource(t));
  setTemplate(t);
  must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, ...Q3, idempotencyKey: 'edge' }));
  const { lines } = importLines(t, { statementId: 'zkb-edge', from: '2026-08-01', to: '2026-08-31', entries: [
    { ref: 'd3', amountMinor: 1507, cd: 'CRDT', date: '2026-08-16' },
    { ref: 'd4', amountMinor: 1507, cd: 'CRDT', date: '2026-08-17' },
  ] });
  const three = must(settlementPayoutForBankLine(t.fctx, { bankTxnId: lines['d3'] }));
  assert.equal(three.match, 'one');
  assert.equal(must(settlementPayoutForBankLine(t.fctx, { bankTxnId: lines['d4'] })).match, 'none', 'four days is outside');
  const ids = three.matches[0].composition.events.map((e) => e.eventId);
  assert.ok(!ids.includes('zf_edge_prev'), 'an event inside the old day window that states no payout is not a member');
  assert.ok(ids.includes('zf_edge_this'), 'an event that states the payout is a member');
  assert.equal(three.matches[0].composition.residualMinor, -20);
  assert.equal(three.matches[0].composition.basis, 'partial', 'never presented as exact unless the residual is 0');
  const eurBank = must(createBankAccount(t.ctx, { name: 'EUR-Konto', iban: 'CH5604835012345678009', currency: 'EUR', ledgerAccountId: t.acc('1020'), idempotencyKey: 'eur' }));
  const eur = importLines(t, { statementId: 'zkb-eur', iban: 'CH5604835012345678009', currency: 'EUR', from: '2026-08-01', to: '2026-08-31', entries: [{ ref: 'e', amountMinor: 1507, cd: 'CRDT', date: '2026-08-13' }] }, { bankAccountId: eurBank.bankAccountId });
  assert.equal(must(settlementPayoutForBankLine(t.fctx, { bankTxnId: eur.lines['e'] })).match, 'none', 'a EUR line is never a CHF payout');
});

test('[INVARIANT tenant-2] another workspace with its own template, payout and bank line neither sees nor clears this one', () => {
  // Guards the workspace_id filter of payoutsMatching, payoutReachedBank, pulledRangesOf and watermarkOf.
  const t = feedWorld();
  must(saveSource(t));
  setTemplate(t);
  must(pullSettlement(t.fctx, { system: SYSTEM, processor: PROCESSOR, ...Q3, idempotencyKey: 'a' }));
  const aBefore = settlementVatFindings(t.fctx, '2026-07-01', '2026-09-30');
  const b = secondWorkspace(t);
  const bFeed = memoryFeed(serving(q3Feed()));
  const bctx = makeContext(t.store, { workspaceId: b.workspaceId, actor: 'user_1', clock: fixedClock(NOW), ids: t.ids, settlementFeed: bFeed.port });
  must(createAccount(bctx, { number: '1095', name: 'Durchlaufkonto', type: 'asset', idempotencyKey: 'b1095' }));
  must(createAccount(bctx, { number: '6940', name: 'Gebühren', type: 'expense', idempotencyKey: 'b6940' }));
  setTemplate(t, bctx, b.acc, 'b-tpl');
  // B's bank line pays A's not-on-bank payout of 7.40: it must not clear A's sale.
  const bBank = must(createBankAccount(bctx, { name: 'Nachbarkonto', iban: 'CH9300762011623852957', currency: 'CHF', ledgerAccountId: b.acc('1020'), idempotencyKey: 'b-bank' }));
  const { lines } = importLines({ ...b, store: t.store }, { statementId: 'b-09', iban: 'CH9300762011623852957', from: '2026-09-01', to: '2026-09-30', entries: [{ ref: 'b740', amountMinor: 740, cd: 'CRDT', date: '2026-09-04' }] }, { ctx: bctx, bankAccountId: bBank.bankAccountId });
  assert.deepEqual(settlementVatFindings(t.fctx, '2026-07-01', '2026-09-30'), aBefore, "B's bank line changes nothing for A");
  assert.equal(must(settlementPayoutForBankLine(bctx, { bankTxnId: lines['b740'] })).match, 'none', "B never matches A's payout");
  // B pulls its own feed, whose sale 3002 STATES payout 3004 (same event ids as A): A's sale 3002 must keep
  // its own payout (guards the workspace filter of statedPayoutRefsOf).
  const bDoc = q3Feed();
  bDoc.events.find((e) => e.id === 'kw:sale:3002').refs.payoutId = 'po_inv_3004';
  const bFeed2 = memoryFeed(serving(bDoc));
  const bctx2 = { ...bctx, settlementFeed: bFeed2.port };
  must(setSettlementSource(bctx2, { system: SYSTEM, processor: PROCESSOR, baseUrl: BASE, fromDate: '2026-07-01', feedToken: TOKEN, idempotencyKey: 'b-src' }));
  must(pullSettlement(bctx2, { system: SYSTEM, processor: PROCESSOR, ...Q3, idempotencyKey: 'b-pull' }));
  assert.deepEqual(settlementVatFindings(t.fctx, '2026-07-01', '2026-09-30'), aBefore, "B's stated payout links change nothing for A");
  // B's own payout of 7.40 now has B's own bank line: B matches its own payout, never A's.
  const bMatch = must(settlementPayoutForBankLine(bctx2, { bankTxnId: lines['b740'] }));
  assert.equal(bMatch.match, 'one');
  assert.equal(bMatch.matches[0].clearingAccountId, b.acc('1095'), "B's clearing account, not A's");
  assert.equal(must(getSettlementSource(bctx, {})).sources.length, 1, 'B sees its own source only');
});

test('the same key with another token replays the first save and never stores the second token', () => {
  const t = feedWorld();
  const deps = { store: t.store, clock: fixedClock(NOW), ids: t.ids, actor: 'studio', settlementFeed: t.feed.port };
  const base = { workspaceId: t.workspaceId, system: SYSTEM, processor: PROCESSOR, baseUrl: BASE, fromDate: '2026-07-01', idempotencyKey: 'tok-key' };
  const first = getAction('set_settlement_source').run(deps, { ...base, feedToken: TOKEN });
  assert.equal(first.ok, true);
  const second = getAction('set_settlement_source').run(deps, { ...base, feedToken: 'kw_second_token_abcdefghijklmn' });
  assert.equal(second.ok, true);
  assert.deepEqual(second, first, 'a replay');
  assert.deepEqual([...t.feed.tokens.values()], [TOKEN], 'the second token never reached the store');
});
