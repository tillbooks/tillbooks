// Critic round 6: the kept Leistungsdatum over the round-4 adversarial generator. Synthetic figures only.
//
// R6-E1: an untouched reopen (same booking date) goes back BYTE-verbatim, in the stored order (L2).
// R6-E2: a reopen whose booking date moves (across eras too) prices every saved taxed line at the date that
//   priced it when saved (`supply_date ?? entry date`), on every face the Studio reopens it on.
//   Adopted with the R6-V fix (02.10.2026): the verbatim path too. A posted answer whose booking date crossed
//   a rate era never carries a taxed line with a NULL supply date, which A07 would file in the new era.

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

const DRAFTS = Number(process.env.CRITIC_R6_DRAFTS ?? 1500);

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

const BLANK = { soll: '', haben: '', amount: '', taxCode: '', costCenter: '', costCenterOpen: false, supplyDate: '', statesSupplyDate: true };

/** The taxed lines of a set, as (account, side, code, the date that prices it). */
function pricing(lines, date) {
  return JSON.stringify(
    lines
      .filter((l) => l.taxCode !== undefined && l.taxCode !== null && (l.debit ?? 0) + (l.credit ?? 0) > 0)
      .map((l) => [l.account, (l.debit ?? 0) > 0 ? 'd' : 'c', l.taxCode, l.supplyDate ?? date])
      .sort(),
  );
}

test('R6-E1/E2: untouched reopens go back byte-verbatim; a moved booking date never re-prices a saved taxed line', () => {
  const failures = [];
  const lowVerbatim = [];
  const nullCrossEra = [];
  const era = (x) => (x < '2018-01-01' ? 0 : x < '2024-01-01' ? 1 : 2);
  const tally = { verbatimSame: 0, moved: 0, movedDerived: 0, movedVerbatimPosts: 0 };
  for (const method of ['effektiv', 'saldo']) {
    const w = world(method);
    const r = rng(method === 'saldo' ? 616 : 606);
    for (let i = 0; i < DRAFTS && failures.length < 10; i += 1) {
      const { date, lines } = adversarialDraft(w, r);
      const draft = saveDraft(w.ctx, { date, lines, idempotencyKey: `${method}-r6-${i}` });
      if (!draft.ok) continue;
      const stored = storedForStudio(w, draft.entryId);
      const d = composeEntry(w.ctx, { mode: 'decompose', date, lines: stored });
      const state = reopenState(d, w.accountOf);
      const req = (at) => composerRequest({ face: state.face, satz: state.satz ?? BLANK, lines: state.lines, manualLock: state.manualLock }, w.accountOf, at).lines;
      const storedPricing = pricing(d.lines, date);
      const amountless = d.lines.some((l) => (l.debit ?? 0) + (l.credit ?? 0) === 0);

      // E1: untouched, same date. A round-tripping draft opened derived answers its stored lines IN ORDER.
      const same = composeEntry(w.ctx, { mode: 'expand', date, entryId: draft.entryId, lines: req(date) });
      if (d.roundTrips && !state.manualLock && !amountless && same.composed) {
        if (JSON.stringify(same.lines.map(sig)) !== JSON.stringify(d.lines.map(sig))) {
          failures.push(`${method} ${i} E1: untouched answer ${JSON.stringify(same.lines)} != stored ${JSON.stringify(d.lines)}`);
          continue;
        }
        tally.verbatimSame += 1;
      }

      // E2: the booking date moves (often across the 2024 era boundary).
      const moved = r.pick(['2023-06-30', '2024-01-01', '2024-02-15', '2026-10-15', '2027-01-04'].filter((x) => x !== date));
      const answer = composeEntry(w.ctx, { mode: 'expand', date: moved, entryId: draft.entryId, lines: req(moved) });
      if (!answer.composed) continue;
      tally.moved += 1;
      // R6-V: a post across an era with a taxed line that states no supply date is filed in the new era.
      if (answer.verdict.ok && era(date) !== era(moved)) {
        const dateless = answer.lines.filter((l) => l.taxCode !== undefined && (l.debit ?? 0) + (l.credit ?? 0) > 0 && l.supplyDate === undefined);
        if (dateless.length > 0) {
          tally.crossEraNullSupply = (tally.crossEraNullSupply ?? 0) + 1;
          nullCrossEra.push(`${method} ${i} (${state.manualLock ? 'verbatim' : state.face}) ${date} -> ${moved}: ${JSON.stringify(dateless)}`);
        }
      }
      const movedPricing = pricing(answer.lines, moved);
      if (movedPricing === storedPricing) {
        if (!state.manualLock) tally.movedDerived += 1;
        continue;
      }
      if (state.manualLock) {
        // Verbatim: the stored line goes out as stored. Only a verdict that would POST it re-prices anything.
        if (answer.verdict.ok) {
          tally.movedVerbatimPosts += 1;
          const crossEra = d.lines.some(
            (l) => l.taxCode && !['IMPORT', 'EXPORT0', 'AUSGENOMMEN', 'none'].includes(l.taxCode) && (l.debit ?? 0) + (l.credit ?? 0) > 0 && l.supplyDate === undefined && era(date) !== era(moved),
          );
          if (crossEra) {
            tally.movedVerbatimCrossEra = (tally.movedVerbatimCrossEra ?? 0) + 1;
            lowVerbatim.unshift(`${method} ${i} CROSS-ERA ${date} -> ${moved}: ${JSON.stringify(d.lines)}`);
          }
          lowVerbatim.push(`${method} ${i}: verbatim ${JSON.stringify(d.lines.filter((l) => l.taxCode))} posts at ${moved}`);
        }
        continue;
      }
      failures.push(`${method} ${i} E2 (${state.face}): stored priced ${storedPricing}, moved to ${moved} priced ${movedPricing}`);
    }
  }
  console.log(`# R6 tally ${JSON.stringify(tally)}`);
  for (const l of lowVerbatim.slice(0, 5)) console.log(`# R6 verbatim re-price (low): ${l}`);
  assert.deepEqual(failures, []);
  assert.deepEqual(nullCrossEra.slice(0, 5), [], `${tally.crossEraNullSupply} era-crossing posts with a NULL supply date`);
  assert.ok(tally.verbatimSame > 0 && tally.movedDerived > 0, JSON.stringify(tally));
});

