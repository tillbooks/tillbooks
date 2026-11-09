// CRITIC PROBE, round 2 (non-author), ADOPTED as a regression suite (critic M1, C10, engine 'none').
//
// Adopted, and since the D152 amendment driven through the rebuilt path: the reopen is the Studio's OWN code
// (`reopenState` + `composerRequest` from composerModel.ts) on the engine's `compose_entry` `decompose`
// answer, and the lines posted are the ones `compose_entry` `expand` answers, exactly as the drawer posts
// them. A regression in the drawer's reopen path or in the engine's composition fails here. Promotion parity
// runs a sample by default and the full 1'500 drafts under TILL_SLOW_TESTS=1.
//
// 1. Promotion parity (C4 manual path + C10): a random VALID draft, saved, read back with get_entry, reopened
//    the way the Studio reopens it (derived when the engine says it round-trips, else verbatim on the manual
//    path), and posted onto the draft id must store EXACTLY the rows a direct post_entry of the same lines
//    stores: no lost trace, no double tag, no moved supply date. Straddle drafts (a 2023 supply booked in
//    2024) included.
// 2. C10 engine edges: drafts never reach a posted-only reader; a 'none' code; save_draft idempotency.
//
// Every workspace, account and figure is synthetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { postEntry, saveDraft, getEntry } from '../../dist/core/ledger/index.js';
import { composeEntry } from '../../dist/core/ledger/compose.js';
import { buildVatLines, computeLineTax } from '../../dist/core/vat/index.js';
import { setup } from './support.mjs';

const COMPOSER = pathToFileURL(fileURLToPath(new URL('../../app/src/surfaces/Journal/composerPayload.ts', import.meta.url))).href;
const MODEL = pathToFileURL(fileURLToPath(new URL('../../app/src/surfaces/Journal/composerModel.ts', import.meta.url))).href;
const { composeLines } = await import(COMPOSER);
const { reopenState, composerRequest, BLANK_SATZ } = await import(MODEL);
/** The full 1'500 random drafts on demand; a sample that still bites by default. */
const PARITY_DRAFTS = process.env.TILL_SLOW_TESTS === '1' ? 1500 : Number(process.env.CRITIC_PARITY_DRAFTS ?? 300);

function world(method = 'effektiv') {
  const w = setup({ method });
  const accounts = w.store.db
    .prepare('SELECT id, number, type FROM account WHERE workspace_id = ?')
    .all(w.workspaceId)
    .map((r) => ({ id: r.id, number: r.number, type: r.type }));
  const byNumber = (n) => accounts.find((a) => a.number === n).id;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return { ...w, accounts, byNumber, accountOf: (id) => byId.get(id) };
}

function rows(w, entryId) {
  return w.store.db
    .prepare('SELECT account_id, cost_center_id, debit_minor, credit_minor, tax_code, tax_base_minor, tax_amount_minor, supply_date FROM journal_line WHERE entry_id = ?')
    .all(entryId)
    .map((r) => JSON.stringify(r))
    .sort();
}

/**
 * The Studio's reopen, through the Studio's own functions and the engine's answers, exactly as EntryDrawer
 * runs it: `compose_entry` `decompose` of the lines `get_entry` returned, `reopenState` (satz, derived grid,
 * or the verbatim manual grid), `composerRequest` for what is then on screen, and `compose_entry` `expand`,
 * whose lines are what the drawer posts.
 */
function studioReopenRepost(w, entryDate, stored, entryId) {
  const d = composeEntry(w.ctx, { mode: 'decompose', date: entryDate, lines: stored });
  assert.equal(d.ok, true, JSON.stringify(d));
  const state = reopenState(d, w.accountOf);
  const request = composerRequest({ face: state.face, satz: state.face === 'satz' ? state.satz : BLANK_SATZ, lines: state.lines, manualLock: state.manualLock }, w.accountOf, entryDate);
  const answer = composeEntry(w.ctx, { mode: 'expand', date: entryDate, ...(entryId !== undefined ? { entryId } : {}), lines: request.lines });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  return { ...answer, ok: answer.verdict.ok === true, reopened: state.face === 'satz' ? 'satz' : state.manualLock ? 'verbatim' : 'derived' };
}

test('critic r2: a reopened draft promotes to exactly the rows a direct post_entry stores, straddles included', () => {
  const w = world();
  const pool = [
    ['VST-M', '6500', 'input'], ['VST-I', '1520', 'input'], ['UST81', '3400', 'output'], ['UST26', '3200', 'output'],
    ['BEZUG', '6500', 'input'], ['IMPORT', '6500', 'input'], ['EXPORT0', '3400', 'output'], ['AUSGENOMMEN', '3400', 'output'],
  ];
  const counters = ['1020', '1000', '1100', '2000'];
  let s = 977;
  const rnd = (n) => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s % n;
  };
  const failures = [];
  for (let iter = 0; iter < PARITY_DRAFTS && failures.length < Number(process.env.CRITIC_CAP ?? 15); iter += 1) {
    const straddle = rnd(2) === 0;
    const date = straddle ? '2024-01-10' : '2026-03-02';
    const supplyDate = straddle ? '2023-12-20' : null;
    const lines = [];
    const k = 1 + rnd(3);
    for (let i = 0; i < k; i += 1) {
      const [code, acc, direction] = pool[rnd(pool.length)];
      const built = buildVatLines(w.ctx, {
        counterAccount: w.byNumber(counters[rnd(counters.length)]),
        revenueOrExpenseAccount: w.byNumber(acc),
        amountMinor: 1 + rnd(rnd(2) === 0 ? 5000 : 10_000_000),
        amountIsGross: rnd(2) === 0,
        taxCode: code,
        direction,
        supplyDate,
      }).filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0);
      lines.push(...built);
    }
    const d = saveDraft(w.ctx, { date, lines, idempotencyKey: `d-${iter}` });
    if (!d.ok) {
      failures.push(`iter ${iter}: saveDraft ${JSON.stringify(d)}`);
      continue;
    }
    const stored = getEntry(w.ctx, { entryId: d.entryId }).lines;
    const again = studioReopenRepost(w, date, stored, d.entryId);
    if (!again.ok) {
      failures.push(`iter ${iter}: compose_entry ${JSON.stringify(again.verdict)} (${again.reopened})`);
      continue;
    }
    const promoted = postEntry(w.ctx, { entryId: d.entryId, date, source: 'manual', idempotencyKey: `p-${iter}`, lines: again.lines });
    const direct = postEntry(w.ctx, { date, source: 'manual', idempotencyKey: `x-${iter}`, lines });
    if (!promoted.ok || !direct.ok) {
      failures.push(`iter ${iter}: promoted ${JSON.stringify(promoted)} direct ${JSON.stringify(direct)}`);
      continue;
    }
    const a = rows(w, d.entryId);
    const b = rows(w, direct.entryId);
    // Line for line, the promoted traces ARE the stored ones (critic M1's silent variant: two lines whose
    // one-Rappen errors cancel post, with each line's trace moved by a Rappen; a sorted multiset of whole
    // rows would still differ, and this names it per line).
    const traceOf = (l) => [l.account, l.debit ?? 0, l.credit ?? 0, l.taxCode ?? null, l.taxBase ?? null, l.taxAmount ?? null, l.supplyDate ?? null].join('|');
    const promotedLines = getEntry(w.ctx, { entryId: d.entryId }).lines.map(traceOf);
    const storedLines = stored.map(traceOf);
    if (JSON.stringify(promotedLines) !== JSON.stringify(storedLines)) failures.push(`iter ${iter}: promoted traces ${JSON.stringify(promotedLines)} != stored ${JSON.stringify(storedLines)}`);
    if (JSON.stringify(a) !== JSON.stringify(b)) failures.push(`iter ${iter}: promoted ${JSON.stringify(a)} != direct ${JSON.stringify(b)}`);
    const tags = (r) => r.filter((x) => JSON.parse(x).tax_code !== null).length;
    if (tags(a) !== lines.filter((l) => l.taxCode !== undefined).length) failures.push(`iter ${iter}: tag count changed`);
  }
  assert.deepEqual(failures, []);
});

test('critic r2: a draft supply date never reaches a posted-only reader, and an untagged line stores none', () => {
  const w = world();
  const d = saveDraft(w.ctx, {
    date: '2026-03-02',
    idempotencyKey: 'draft-sd',
    lines: [
      { account: w.byNumber('6500'), debit: 9963, taxCode: 'VST-M', supplyDate: '2023-12-20' },
      { account: w.byNumber('1170'), debit: 807, supplyDate: '2023-12-20' },
      { account: w.byNumber('1020'), credit: 10770 },
    ],
  });
  assert.equal(d.ok, true, JSON.stringify(d));
  const raw = w.store.db.prepare('SELECT a.number, l.supply_date FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.entry_id = ?').all(d.entryId);
  assert.deepEqual(Object.fromEntries(raw.map((r) => [r.number, r.supply_date])), { 6500: '2023-12-20', 1170: null, 1020: null });
  // Every reader that reads supply_date on posted rows filters status = 'posted' (abrechnung, exports) or is
  // keyed on a posted entry (reverse, credit note). The draft stays draft:
  assert.equal(w.store.db.prepare('SELECT status FROM journal_entry WHERE id = ?').get(d.entryId).status, 'draft');
});

test("critic r2: save_draft with the literal 'none' code and a supply date (engine edge)", () => {
  const w = world();
  const d = saveDraft(w.ctx, {
    date: '2026-03-02',
    idempotencyKey: 'draft-none',
    lines: [
      { account: w.byNumber('6500'), debit: 100, taxCode: 'none', supplyDate: '2023-12-20' },
      { account: w.byNumber('1020'), credit: 100 },
    ],
  });
  const raw = d.ok ? w.store.db.prepare('SELECT tax_code, supply_date FROM journal_line WHERE entry_id = ? AND debit_minor > 0').get(d.entryId) : null;
  const p = postEntry(w.ctx, {
    date: '2026-03-02', source: 'manual', idempotencyKey: 'post-none',
    lines: [
      { account: w.byNumber('6500'), debit: 100, taxCode: 'none', supplyDate: '2023-12-20' },
      { account: w.byNumber('1020'), credit: 100 },
    ],
  });
  const posted = p.ok ? w.store.db.prepare('SELECT tax_code, supply_date FROM journal_line WHERE entry_id = ? AND debit_minor > 0').get(p.entryId) : null;
  // Adopted as an assertion (round 2 recorded it): the draft stores exactly what post stores, NULL for both.
  assert.deepEqual(raw, { tax_code: null, supply_date: null });
  assert.deepEqual(raw, posted);
});

test('critic r2: an A1 Aufteilen draft (two taxed lines, derived) saved, reopened and posted unchanged must post', () => {
  const w = world();
  const date = '2026-03-02';
  // Grosses whose gross split differs from net-forward on the same net (the hint case), searched.
  const odd = [];
  for (let g = 100; g < 20000 && odd.length < 40; g += 1) {
    const a = computeLineTax(w.ctx, { amountMinor: g, amountIsGross: true, taxCode: 'VST-M', supplyDate: date });
    const b = computeLineTax(w.ctx, { amountMinor: a.netMinor, amountIsGross: false, taxCode: 'VST-M', supplyDate: date });
    if (a.taxMinor !== b.taxMinor) odd.push(g);
  }
  assert.ok(odd.length > 0);
  const failures = [];
  for (const g of odd) {
    const composed = [
      { accountId: w.byNumber('6500'), side: 'debit', amountMinor: g, taxCode: 'VST-M', costCenter: '' },
      { accountId: w.byNumber('6570'), side: 'debit', amountMinor: 1000, taxCode: '', costCenter: '' },
      { accountId: w.byNumber('1020'), side: 'credit', amountMinor: g + 1000, taxCode: '', costCenter: '' },
    ];
    const built = composeEntry(w.ctx, { mode: 'expand', date, lines: composeLines(composed, true, date) });
    assert.deepEqual(built.verdict, { ok: true });
    const d = saveDraft(w.ctx, { date, lines: built.lines, idempotencyKey: `ad-${g}` });
    const stored = getEntry(w.ctx, { entryId: d.entryId }).lines;
    const again = studioReopenRepost(w, date, stored, d.entryId);
    if (again.reopened !== 'derived') failures.push(`gross ${g}: reopened ${again.reopened}, not as the derived grid`);
    const r = postEntry(w.ctx, { entryId: d.entryId, date, source: 'manual', idempotencyKey: `ap-${g}`, lines: again.lines });
    if (!r.ok) failures.push(`gross ${g}: ${JSON.stringify(r)}`);
  }
  assert.deepEqual(failures, []);
});
