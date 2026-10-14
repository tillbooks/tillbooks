// Critic round 4 (fresh non-author critic of the D152 rebuild): engine-side probes for `compose_entry`.
// Every workspace, account and figure is synthetic, invented for the test.
//
// R4-E1: an UNTOUCHED reopen through the Studio's OWN reopen path (`reopenState` then `composerRequest`, the
//   code the drawer runs, not the decomposed intent fed back by hand) must post exactly the booked money the
//   draft stores, over adversarial drafts: two codes, the same amounts, mixed sides, Bezugsteuer, import,
//   saldo, straddles, cost centres, stale hints, garbage traces, amount-less lines.
// R4-E2: `roundTrips: true` must mean the Studio's request re-expands to the stored lines EXACTLY, the cost
//   centre and the trace included (the multiset in `decompose` is checked against the engine's own rows here).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { postEntry, saveDraft, getEntry, ledgerPorts } from '../../dist/core/ledger/index.js';
import { composeEntry } from '../../dist/core/ledger/compose.js';
import { buildVatLines } from '../../dist/core/vat/index.js';
import { makeContext } from '../../dist/core/context.js';
import { setup } from './support.mjs';

const MODEL = pathToFileURL(fileURLToPath(new URL('../../app/src/surfaces/Journal/composerModel.ts', import.meta.url))).href;
const { reopenState, composerRequest } = await import(MODEL);

const DRAFTS = Number(process.env.CRITIC_R4_DRAFTS ?? 1500);

function world(method) {
  const w = setup({ method });
  const ctx = makeContext(w.store, { workspaceId: w.workspaceId, actor: 'user_1', clock: w.clock, ids: w.ids, ...ledgerPorts({ store: w.store, workspaceId: w.workspaceId, ids: w.ids }) });
  w.store.db.prepare('INSERT INTO cost_center (id, workspace_id, code, name) VALUES (?, ?, ?, ?)').run('cc_1', w.workspaceId, 'K1', 'Vertrieb');
  w.store.db.prepare('INSERT INTO cost_center (id, workspace_id, code, name) VALUES (?, ?, ?, ?)').run('cc_2', w.workspaceId, 'K2', 'Werkstatt');
  w.store.db.prepare('UPDATE account SET cost_center_allowed = 1 WHERE workspace_id = ?').run(w.workspaceId);
  const accounts = w.store.db
    .prepare('SELECT id, number, type, vat_code_default, cost_center_allowed FROM account WHERE workspace_id = ?')
    .all(w.workspaceId)
    .map((r) => ({ id: r.id, number: r.number, type: r.type, vatCodeDefault: r.vat_code_default, costCenterAllowed: r.cost_center_allowed === 1 }));
  const byNumber = (n) => accounts.find((a) => a.number === n).id;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return { ...w, ctx, byNumber, accountOf: (id) => byId.get(id) };
}

function rng(seed) {
  let s = seed >>> 0;
  const rnd = (n) => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return Math.floor((s / 4294967296) * n);
  };
  return { rnd, pick: (xs) => xs[rnd(xs.length)] };
}

/** get_entry's lines, as the drawer hands them to decompose. */
function storedForStudio(w, entryId) {
  return getEntry(w.ctx, { entryId }).lines;
}

/** The booked money of a line set, per (account, side, cost centre): what the books would hold. */
function money(lines) {
  const m = new Map();
  for (const l of lines) {
    const key = JSON.stringify([l.account, l.costCenter ?? null]);
    m.set(key, (m.get(key) ?? 0) + (l.debit ?? 0) - (l.credit ?? 0));
  }
  return JSON.stringify([...m].filter(([, v]) => v !== 0).sort());
}

const sig = (l) =>
  JSON.stringify([l.account, l.debit ?? 0, l.credit ?? 0, l.costCenter ?? null, l.taxCode ?? null, l.taxBase ?? null, l.taxAmount ?? null, l.taxCode == null ? null : (l.supplyDate ?? null)]);
const multiset = (ls) => JSON.stringify(ls.map(sig).sort());

/** An adversarial agent draft. */
function adversarialDraft(w, r) {
  const { rnd, pick } = r;
  const pool = [
    ['VST-M', '6500', 'input'], ['VST-M', '6570', 'input'], ['VST-I', '1500', 'input'], ['UST81', '3400', 'output'],
    ['UST81', '3200', 'output'], ['UST26', '3200', 'output'], ['BEZUG', '6500', 'input'], ['IMPORT', '6500', 'input'],
    ['EXPORT0', '3400', 'output'], ['AUSGENOMMEN', '3400', 'output'],
  ];
  const straddle = rnd(3) === 0;
  const date = straddle ? '2024-01-10' : pick(['2026-03-02', '2026-09-30']);
  const lines = [];
  const sameAmount = 1 + rnd(rnd(2) === 0 ? 3000 : 2_000_000);
  for (let k = 1 + rnd(3); k > 0; k -= 1) {
    const [code, acc, direction] = pick(pool);
    const built = buildVatLines(w.ctx, {
      counterAccount: w.byNumber(pick(['1020', '1000', '1100', '2000'])),
      revenueOrExpenseAccount: w.byNumber(acc),
      amountMinor: rnd(2) === 0 ? sameAmount : 1 + rnd(rnd(2) === 0 ? 3000 : 2_000_000),
      amountIsGross: rnd(2) === 0,
      taxCode: code,
      direction,
      supplyDate: straddle && rnd(2) === 0 ? '2023-12-20' : rnd(3) === 0 ? date : null,
      ...(rnd(3) === 0 ? { costCenterId: pick(['cc_1', 'cc_2']) } : {}),
    }).filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0);
    // Mixed sides: a refund is the same booking mirrored.
    lines.push(...(rnd(4) === 0 ? built.map((l) => ({ ...l, debit: l.credit, credit: l.debit })).map((l) => Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined))) : built));
  }
  // Adversarial noise on the traces an agent may store.
  const t = lines.find((l) => l.taxCode !== undefined);
  const noise = rnd(8);
  if (t && noise === 0) t.taxAmount = (t.taxAmount ?? 0) + pick([1, -1, 37]);
  else if (t && noise === 1) delete t.taxAmount;
  else if (t && noise === 2) { delete t.taxBase; delete t.taxAmount; }
  else if (t && noise === 3) t.taxBase = -(t.taxBase ?? 0);
  else if (noise === 4) lines.push({ account: w.byNumber(pick(['6500', '1020'])) });
  if (rnd(6) === 0) lines.reverse();
  return { date, lines };
}

test('R4-E1/E2: an untouched reopen through the Studio reopen path posts exactly the booked money it stores', () => {
  const failures = [];
  const tally = { satz: 0, derived: 0, verbatim: 0, posted: 0 };
  for (const method of ['effektiv', 'saldo']) {
    const w = world(method);
    const r = rng(method === 'saldo' ? 515 : 152);
    for (let i = 0; i < DRAFTS && failures.length < 10; i += 1) {
      const { date, lines } = adversarialDraft(w, r);
      const draft = saveDraft(w.ctx, { date, lines, idempotencyKey: `${method}-adv-${i}` });
      if (!draft.ok) continue;
      const stored = storedForStudio(w, draft.entryId);
      const d = composeEntry(w.ctx, { mode: 'decompose', date, lines: stored });
      assert.equal(d.ok, true, JSON.stringify(d));
      const state = reopenState(d, w.accountOf);
      tally[state.face === 'satz' ? 'satz' : state.manualLock ? 'verbatim' : 'derived'] += 1;
      const request = composerRequest({ face: state.face, satz: state.satz ?? { soll: '', haben: '', amount: '', taxCode: '', costCenter: '', costCenterOpen: false, supplyDate: '', statesSupplyDate: true }, lines: state.lines, manualLock: state.manualLock }, w.accountOf, date);
      const answer = composeEntry(w.ctx, { mode: 'expand', date, entryId: draft.entryId, lines: request.lines });
      assert.equal(answer.ok, true);
      const storedLines = d.lines;
      if (d.roundTrips && !state.manualLock) {
        // E2: the Studio's request is the intent, so its expansion IS the stored lines.
        if (answer.composed && multiset(answer.lines) !== multiset(storedLines)) {
          failures.push(`${method} ${i}: roundTrips, yet the Studio request expands to ${JSON.stringify(answer.lines)} != stored ${JSON.stringify(storedLines)}`);
          continue;
        }
      }
      // E1: whatever face it opened on, what the drawer would post books exactly the stored money.
      if (answer.composed && money(answer.lines) !== money(storedLines.filter((l) => (l.debit ?? 0) + (l.credit ?? 0) > 0))) {
        failures.push(`${method} ${i} (${state.face}${state.manualLock ? ', verbatim' : ''}): the untouched reopen books ${money(answer.lines)} but the draft holds ${money(storedLines)}`);
        continue;
      }
      if (answer.verdict.ok) {
        const posted = postEntry(w.ctx, { entryId: draft.entryId, date, source: 'manual', idempotencyKey: `${method}-advp-${i}`, lines: answer.lines });
        if (!posted.ok) failures.push(`${method} ${i}: compose said ok, post refused ${JSON.stringify(posted)}`);
        else tally.posted += 1;
      }
    }
  }
  console.log(`# R4-E1 tally ${JSON.stringify(tally)}`);
  assert.deepEqual(failures, []);
  for (const k of ['satz', 'derived', 'verbatim', 'posted']) assert.ok(tally[k] > 0, `never reached ${k}: ${JSON.stringify(tally)}`);
});

// R4-E3: the read writes nothing ON THE HAPPY PATH, in a book that holds drafts and posted entries. No
// existing suite asserts this: conformance has no READ_SCENARIOS entry for compose_entry, and the author's
// "writes nothing" check runs against a workspace with no rows, so a compose_entry that UPDATEs every draft
// on each call passes all of them (critic mutation, round 4).
test('R4-E3: compose_entry expand and decompose write nothing in a book with drafts and posted entries', () => {
  const w = world('effektiv');
  const id = (n) => w.byNumber(n);
  const draft = saveDraft(w.ctx, { date: '2026-03-02', lines: [{ account: id('6500'), debit: 9963, taxCode: 'VST-M', taxBase: 9963, taxAmount: 807 }, { account: id('1170'), debit: 807 }, { account: id('1020'), credit: 10770 }], idempotencyKey: 'r4e3-d' });
  assert.equal(draft.ok, true);
  const posted = postEntry(w.ctx, { date: '2026-03-02', source: 'manual', idempotencyKey: 'r4e3-p', lines: [{ account: id('6500'), debit: 100 }, { account: id('1020'), credit: 100 }] });
  assert.equal(posted.ok, true);
  const before = w.store.db.prepare('SELECT total_changes() AS n').get().n;
  const e = composeEntry(w.ctx, { mode: 'expand', date: '2026-03-02', entryId: draft.entryId, lines: [{ account: id('6500'), side: 'debit', amount: 10770, gross: true, taxCode: 'VST-M' }, { account: id('1020'), side: 'credit', amount: 10770, gross: true }] });
  assert.deepEqual(e.verdict, { ok: true });
  assert.equal(composeEntry(w.ctx, { mode: 'decompose', entryId: draft.entryId }).ok, true);
  assert.equal(composeEntry(w.ctx, { mode: 'decompose', entryId: posted.entryId }).ok, true);
  assert.equal(w.store.db.prepare('SELECT total_changes() AS n').get().n, before, 'compose_entry wrote');
});
