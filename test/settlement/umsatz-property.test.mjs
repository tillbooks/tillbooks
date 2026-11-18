// A42, the Umsatz review under random sequences (the pre-mortem after code critic r4/r5: rows and totals had been
// assembled from overlapping sources, and a patch to one broke another). A seeded property test with an
// INDEPENDENT ORACLE: after Buchen with the review's digest, the VAT the books carry for the period's settlement
// entries (queried from the journal lines directly) must equal the totals the review predicted.
//
// Operations per seed: send a subset (review, then maybe book), re-send identical, amend an event's figures,
// re-send it unreadable (an amount that does not add up), send it twice (a duplicate id), ignore and withdraw,
// mark a sale as a test payment. Invariants after every review:
//   I1 no event id appears twice in the rows;
//   I2 every event the document states (with a day in the period) is a row;
//   I3 an unreadable or refused row that is not booked carries no posted VAT;
//   I4 a row is `booked` exactly when the book holds the event;
//   I5 (oracle) after Buchen, totals.outputVat / inputVat equal the journal's 2200 / 1170+1171 for the period's
//      settlement entries, and a second review books nothing and states the same totals.
//
// Seeds: 40 by default (the gate); TILL_A42_FUZZ_SEEDS=3000 runs the long pass.
// SYNTHETIC BY CONSTRUCTION: every id, amount and day below is invented.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { makeAuditPort } from '../../dist/core/ledger/auditLog.js';
import { settlementReview, importSettlement, setSettlementEventIgnored } from '../../dist/core/settlement/index.js';
import { settlementWorld, setTemplate, SYSTEM, PROCESSOR } from './support.mjs';

const NOW = '2026-10-05T08:00:00.000Z';
const Q3 = { from: '2026-07-01', to: '2026-09-30' };
const SEEDS = Number(process.env.TILL_A42_FUZZ_SEEDS ?? 40);

/** mulberry32: a small seeded PRNG, so every failure names its seed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exact 8.1 % figure sets (gross, net, VAT), so the template's VAT gate books them. */
const SALE_FIGURES = [
  ['54.05', '50.00', '4.05'],
  ['108.10', '100.00', '8.10'],
  ['21.62', '20.00', '1.62'],
];
const FEE_FIGURES = [
  ['-1.08', '-1.00', '-0.08'],
  ['-3.24', '-3.00', '-0.24'],
];

const ID_POOL = [
  { id: 'kw:sale:9001', kind: 'sale' },
  { id: 'kw:sale:9002', kind: 'sale' },
  { id: 'kw:sale:9003', kind: 'sale' },
  { id: 'zf_fee_9001', kind: 'processing_fee' },
  { id: 'zf_fee_9002', kind: 'processing_fee' },
  // A real id that reads like TILL's stand-in for an id-less event (code critic r7 H1).
  { id: '#1', kind: 'sale' },
];

function world() {
  const t = settlementWorld();
  const ctx = makeContext(t.store, {
    workspaceId: t.workspaceId,
    actor: 'user_1',
    clock: fixedClock(NOW),
    ids: t.ids,
    audit: makeAuditPort({ store: t.store, workspaceId: t.workspaceId, ids: t.ids }),
    periods: t.ctx.periods,
  });
  setTemplate(t);
  return { ...t, rctx: ctx };
}

const docOf = (events) => ({ schema: 'till-settlement/v1', source: { system: SYSTEM, processor: PROCESSOR }, currency: 'CHF', generatedAt: '2026-10-05T06:00:00.000Z', events });

/** The producer's current statement of one event. */
function eventOf(spec, state) {
  const [amount, net, vat] = (spec.kind === 'sale' ? SALE_FIGURES : FEE_FIGURES)[state.figures];
  const e = {
    id: spec.id,
    kind: spec.kind,
    day: state.day,
    currency: 'CHF',
    amount: state.unreadable ? (Number(amount) + 0.01).toFixed(2) : amount,
    net,
    vat: { amount: vat, code: 'PRODUCER-CODE', rate: 8.1 },
    refs: { chargeId: `ch_${spec.id}`, ...(state.test ? { test: true } : {}) },
  };
  return state.duplicate ? [e, { ...e }] : [e];
}

/** The VAT the books carry for the period's settlement entries, read from the journal directly (the oracle). */
function bookVat(t) {
  const sum = (numbers, sign) =>
    t.store.db
      .prepare(
        `SELECT COALESCE(SUM(${sign}), 0) AS v
           FROM journal_line l
           JOIN account a ON a.id = l.account_id AND a.workspace_id = ?
           JOIN journal_entry j ON j.id = l.entry_id AND j.workspace_id = ?
          WHERE a.number IN (${numbers.map(() => '?').join(',')})
            AND j.date >= ? AND j.date <= ?
            AND l.entry_id IN (SELECT entry_id FROM settlement_event WHERE workspace_id = ? AND entry_id IS NOT NULL)`,
      )
      .get(t.workspaceId, t.workspaceId, ...numbers, Q3.from, Q3.to, t.workspaceId).v;
  return {
    output: sum(['2200'], 'l.base_credit_minor - l.base_debit_minor'),
    input: sum(['1170', '1171'], 'l.base_debit_minor - l.base_credit_minor'),
    // The template books sales and refunds to 3400 and nothing else there: the turnover excl. VAT.
    turnover: sum(['3400'], 'l.base_credit_minor - l.base_debit_minor'),
  };
}

function bookedIds(t) {
  return new Set(t.store.db.prepare('SELECT event_id FROM settlement_event WHERE workspace_id = ?').all(t.workspaceId).map((r) => r.event_id));
}

/** How often each case occurred, so the property is never vacuous. */
const SEEN = { oracle: 0, resentUnreadable: 0, amendedBooked: 0, unreadableUnbooked: 0, ignored: 0, test: 0, duplicate: 0, idless: 0, hashId: 0, standinCollision: 0 };

function checkInvariants(t, res, events, seed, step) {
  const where = `seed ${seed} step ${step}`;
  const keys = res.rows.map((r) => r.rowKey);
  assert.equal(new Set(keys).size, keys.length, `I1 one row per identity (${where}): ${keys.join(', ')}`);
  const ids = res.rows.filter((r) => r.eventId !== '').map((r) => r.eventId);
  assert.equal(new Set(ids).size, ids.length, `I1 no real event id twice (${where}): ${ids.join(', ')}`);
  for (const e of events) {
    if (e.id === undefined) continue;
    if (e.day >= Q3.from && e.day <= Q3.to) assert.ok(ids.includes(e.id), `I2 ${e.id} is a row (${where})`);
  }
  const idless = events.filter((e) => e.id === undefined).length;
  if (idless > 0) SEEN.idless += 1;
  if (events.some((e) => e.id === '#1')) SEEN.hashId += 1;
  if (idless > 1) SEEN.standinCollision += 1;
  assert.equal(res.rows.filter((r) => r.unreadable && r.status !== 'booked' && r.code === 'missing_id').length, idless, `I6 every id-less event keeps its own row (${where})`);
  const booked = bookedIds(t);
  if (events.length !== new Set(events.map((e) => e.id)).size) SEEN.duplicate += 1;
  for (const r of res.rows) {
    if (r.reason === 'resent_unreadable') SEEN.resentUnreadable += 1;
    if (r.status === 'booked' && r.code === 'event_amended') SEEN.amendedBooked += 1;
    if (r.unreadable && r.status !== 'booked') SEEN.unreadableUnbooked += 1;
    if (r.inclusion.source === 'override' && !r.included) SEEN.ignored += 1;
    if (r.test) SEEN.test += 1;
    if ((r.unreadable || r.status === 'refused') && r.status !== 'booked') assert.equal(r.vatPostedMinor, 0, `I3 ${r.eventId} (${where})`);
    if (!r.outsidePeriod) assert.equal(r.status === 'booked', booked.has(r.eventId), `I4 ${r.eventId} booked=${r.status} (${where})`);
  }
}

function runSeed(seed) {
  const next = rng(seed);
  const pick = (list) => list[Math.floor(next() * list.length)];
  const t = world();
  /** @type {Map<string, {figures: number, day: string, unreadable: boolean, duplicate: boolean, test: boolean}>} */
  const state = new Map(
    ID_POOL.map((spec) => [
      spec.id,
      { figures: Math.floor(next() * (spec.kind === 'sale' ? SALE_FIGURES : FEE_FIGURES).length), day: `2026-07-${String(1 + Math.floor(next() * 28)).padStart(2, '0')}`, unreadable: false, duplicate: false, test: false },
    ]),
  );
  const steps = 3 + Math.floor(next() * 6);
  for (let step = 0; step < steps; step += 1) {
    const op = next();
    const spec = pick(ID_POOL);
    const s = state.get(spec.id);
    if (op < 0.1) s.figures = (s.figures + 1) % (spec.kind === 'sale' ? SALE_FIGURES : FEE_FIGURES).length;
    else if (op < 0.2) s.unreadable = !s.unreadable;
    else if (op < 0.28) s.duplicate = !s.duplicate;
    else if (op < 0.34 && spec.kind === 'sale') s.test = !s.test;
    else if (op < 0.44) setSettlementEventIgnored(t.rctx, { system: SYSTEM, processor: PROCESSOR, eventId: spec.id, ignored: next() < 0.6, idempotencyKey: `ign-${seed}-${step}` });
    // Every step sends a random subset (at least one event) and reviews it; most of the time it then books.
    const subset = ID_POOL.filter(() => next() < 0.7);
    if (subset.length === 0) subset.push(pick(ID_POOL));
    const events = subset.flatMap((sp) => eventOf(sp, state.get(sp.id)));
    // Now and then the producer sends an event without an id (the reader refuses it, missing_id).
    // At a random position, so its stand-in `#n` sometimes reads like the real id `#1` (code critic r7 H1).
    const idless = next() < 0.25 ? (next() < 0.4 ? 2 : 1) : 0;
    for (let k = 0; k < idless; k += 1) {
      events.splice(Math.floor(next() * (events.length + 1)), 0, { ...eventOf(ID_POOL[0], { figures: k, day: '2026-07-15', unreadable: false, duplicate: false, test: false })[0], id: undefined });
    }
    const res = settlementReview(t.rctx, { settlement: docOf(events), ...Q3 });
    assert.equal(res.ok, true, `review refused (seed ${seed} step ${step}): ${JSON.stringify(res).slice(0, 300)}`);
    checkInvariants(t, res, events, seed, step);
    if (next() < 0.75) {
      const booked = importSettlement(t.rctx, { settlement: docOf(events), expectReviewSha256: res.reviewSha256, idempotencyKey: `imp-${seed}-${step}` });
      assert.equal(booked.ok, true, `Buchen with the review digest refused (seed ${seed} step ${step}): ${JSON.stringify(booked).slice(0, 300)}`);
      const vat = bookVat(t);
      SEEN.oracle += 1;
      assert.equal(res.totals.outputVat.amountMinor, vat.output, `I5 output VAT predicted = booked (seed ${seed} step ${step})`);
      assert.equal(res.totals.inputVat.amountMinor, vat.input, `I5 input VAT predicted = booked (seed ${seed} step ${step})`);
      assert.equal(res.totals.turnoverNetMinor, vat.turnover, `I5 turnover predicted = booked (seed ${seed} step ${step})`);
      const again = settlementReview(t.rctx, { settlement: docOf(events), ...Q3 });
      assert.equal(again.ok, true);
      assert.equal(again.toBook, 0, `I5 a second review books nothing (seed ${seed} step ${step})`);
      assert.equal(again.totals.outputVat.amountMinor, vat.output, `I5 the second review states the books (seed ${seed} step ${step})`);
      checkInvariants(t, again, events, seed, `${step}b`);
    }
  }
  t.store.close?.();
}

test(`[A42 property] ${SEEDS} random sequences: one row per event, every event shown, nothing refused counted, the review predicts the books`, () => {
  for (let seed = 1; seed <= SEEDS; seed += 1) runSeed(seed);
  // Never vacuous: every case the sequences generate occurred at least once.
  for (const [k, n] of Object.entries(SEEN)) assert.ok(n > 0, `the property never met the case ${k}: ${JSON.stringify(SEEN)}`);
});
