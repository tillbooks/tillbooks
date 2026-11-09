// CRITIC PROBE, round 3 (non-author). The M1 stored-trace reuse, attacked through the Studio's own reopen code.
// Every workspace and figure is synthetic.
//
// D152 amendment (02.10.2026): the round-3 FAIL (R3a) was the third in one class, the Studio deriving VAT
// traces itself, and the composer's VAT step was rebuilt in the engine. These probes now drive the rebuilt
// path, the Studio's own `reopenState` / `composerRequest` / `editGridLine` on the engine's `compose_entry`
// answers, and keep the round-3 findings as acceptance tests: R3a (a same-era date move posts), the stored
// line is sent verbatim only while it is untouched, and the engine never stores a stated or stale trace.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { postEntry, saveDraft, getEntry } from '../../dist/core/ledger/index.js';
import { composeEntry } from '../../dist/core/ledger/compose.js';
import { computeLineTax } from '../../dist/core/vat/index.js';
import { setup } from './support.mjs';

const COMPOSER = pathToFileURL(fileURLToPath(new URL('../../app/src/surfaces/Journal/composerPayload.ts', import.meta.url))).href;
const MODEL = pathToFileURL(fileURLToPath(new URL('../../app/src/surfaces/Journal/composerModel.ts', import.meta.url))).href;
const { composeLines } = await import(COMPOSER);
const { reopenState, composerRequest, editGridLine, BLANK_SATZ } = await import(MODEL);

function world() {
  const w = setup({});
  const accounts = w.store.db.prepare('SELECT id, number, type FROM account WHERE workspace_id = ?').all(w.workspaceId);
  const byNumber = (n) => accounts.find((a) => a.number === n).id;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return { ...w, byNumber, accountOf: (id) => byId.get(id) };
}

/** Reopen a stored entry the way EntryDrawer does: `decompose`, then `reopenState`. */
function reopen(w, entryId) {
  const stored = getEntry(w.ctx, { entryId }).lines;
  const entryDate = getEntry(w.ctx, { entryId }).entry.date;
  const d = composeEntry(w.ctx, { mode: 'decompose', date: entryDate, lines: stored });
  assert.equal(d.ok, true, JSON.stringify(d));
  return { d, state: reopenState(d, w.accountOf) };
}

/** What the drawer sends for this face state at this date, and the engine's answer. */
function compose(w, state, date, entryId) {
  const request = composerRequest({ face: state.face, satz: state.face === 'satz' ? state.satz : BLANK_SATZ, lines: state.lines, manualLock: state.manualLock }, w.accountOf, date);
  const answer = composeEntry(w.ctx, { mode: 'expand', date, ...(entryId !== undefined ? { entryId } : {}), lines: request.lines });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  return { request, answer };
}

/** Grosses whose gross split differs from net-forward (the hint case). */
function oddGrosses(w, date, n) {
  const out = [];
  for (let g = 100; out.length < n; g += 1) {
    const a = computeLineTax(w.ctx, { amountMinor: g, amountIsGross: true, taxCode: 'VST-M', supplyDate: date });
    const b = computeLineTax(w.ctx, { amountMinor: a.netMinor, amountIsGross: false, taxCode: 'VST-M', supplyDate: date });
    if (a.taxMinor !== b.taxMinor) out.push(g);
  }
  return out;
}

/** An A1 Aufteilen draft as the Studio saves it: the engine's lines for 6500 gross VST-M + 6570 untaxed + 1020. */
function aufteilenDraft(w, gross, date, key) {
  const composed = [
    { accountId: w.byNumber('6500'), side: 'debit', amountMinor: gross, taxCode: 'VST-M', costCenter: '' },
    { accountId: w.byNumber('6570'), side: 'debit', amountMinor: 1000, taxCode: '', costCenter: '' },
    { accountId: w.byNumber('1020'), side: 'credit', amountMinor: gross + 1000, taxCode: '', costCenter: '' },
  ];
  const built = composeEntry(w.ctx, { mode: 'expand', date, lines: composeLines(composed, true, date) });
  assert.deepEqual(built.verdict, { ok: true });
  const t = computeLineTax(w.ctx, { amountMinor: gross, amountIsGross: true, taxCode: 'VST-M', supplyDate: date });
  assert.deepEqual(built.lines[0], { account: w.byNumber('6500'), debit: t.netMinor, taxCode: 'VST-M', taxBase: t.netMinor, taxAmount: t.taxMinor, supplyDate: date }, 'fixture: the gross-split trace');
  const d = saveDraft(w.ctx, { date, lines: built.lines, idempotencyKey: key });
  assert.equal(d.ok, true);
  return d.entryId;
}

test('critic r3: a reopened Aufteilen draft whose booking date moves WITHIN the same rate era still posts (R3a)', () => {
  const w = world();
  const failures = [];
  for (const g of oddGrosses(w, '2026-09-30', 40)) {
    const id = aufteilenDraft(w, g, '2026-09-30', `d-${g}`);
    const { state } = reopen(w, id);
    if (state.face !== 'grid' || state.manualLock) failures.push(`gross ${g}: reopened ${state.face}${state.manualLock ? ' verbatim' : ''}, not as the derived grid`);
    // The person moves the booking date by one day (same 8.1% era) and posts, touching nothing else. The line
    // keeps its stored Leistungsdatum (owner, 02.10.2026): the booking date moves, the supply date does not.
    const { answer } = compose(w, state, '2026-10-01', id);
    if (!answer.verdict.ok) failures.push(`gross ${g}: compose_entry ${JSON.stringify(answer.verdict)}`);
    const r = postEntry(w.ctx, { entryId: id, date: '2026-10-01', source: 'manual', idempotencyKey: `p-${g}`, lines: answer.lines });
    if (!r.ok) failures.push(`gross ${g}: ${JSON.stringify(r)}`);
    else {
      const t = computeLineTax(w.ctx, { amountMinor: g, amountIsGross: true, taxCode: 'VST-M', supplyDate: '2026-09-30' });
      const row = w.store.db.prepare("SELECT tax_amount_minor, supply_date FROM journal_line WHERE entry_id = ? AND tax_code = 'VST-M'").get(id);
      if (row.tax_amount_minor !== t.taxMinor || row.supply_date !== '2026-09-30') failures.push(`gross ${g}: posted ${JSON.stringify(row)}`);
    }
  }
  assert.deepEqual(failures, []);
});

// Adjusted 02.10.2026 (owner: keep the stored Leistungsdatum). This test asserted the retired rule, that a
// moved booking date re-prices a saved line at the new date's era. Now the line keeps its stored supply date
// and so its rate; what survives of the original intent is that the trace is composed from the gross, never
// a stale one.
test('critic r3: a booking date moved ACROSS a rate era keeps the saved line\'s Leistungsdatum and rate, composed from its gross', () => {
  const w = world();
  const id = aufteilenDraft(w, 10770, '2024-01-10', 'era-move');
  const { state } = reopen(w, id);
  const { answer } = compose(w, state, '2023-12-28', id);
  assert.deepEqual(answer.verdict, { ok: true });
  const t = computeLineTax(w.ctx, { amountMinor: 10770, amountIsGross: true, taxCode: 'VST-M', supplyDate: '2024-01-10' });
  assert.equal(t.rateBp, 810, 'fixture: the 8.1% era the line was saved in');
  assert.deepEqual(answer.lines[0], { account: w.byNumber('6500'), debit: t.netMinor, taxCode: 'VST-M', taxBase: t.netMinor, taxAmount: t.taxMinor, supplyDate: '2024-01-10' });
});

test('critic r3: the stored line is sent VERBATIM only while its row is untouched; an edit sends what is on screen', () => {
  const w = world();
  // A draft that does not round-trip: two hint-traced lines whose legs were merged into one 1170 line.
  const lines = [
    { account: w.byNumber('6500'), debit: 93, taxCode: 'VST-M', taxBase: 93, taxAmount: 7, supplyDate: '2026-09-30' },
    { account: w.byNumber('6570'), debit: 93, taxCode: 'VST-M', taxBase: 93, taxAmount: 7, supplyDate: '2026-09-30' },
    { account: w.byNumber('1170'), debit: 14 },
    { account: w.byNumber('1020'), credit: 200 },
  ];
  const id = saveDraft(w.ctx, { date: '2026-09-30', lines, idempotencyKey: 'merged' }).entryId;
  const { d, state } = reopen(w, id);
  assert.equal(d.roundTrips, false);
  assert.equal(state.manualLock, true);
  const sent = (s, date = '2026-09-30') => compose(w, s, date, id).request.lines;
  const stored = getEntry(w.ctx, { entryId: id }).lines;
  const asStored = (l) => {
    const out = { account: l.account };
    if (l.debit > 0) out.debit = l.debit;
    if (l.credit > 0) out.credit = l.credit;
    for (const k of ['costCenter', 'taxCode', 'taxBase', 'taxAmount', 'supplyDate']) if (l[k] !== null) out[k] = l[k];
    return out;
  };
  const edit = (i, patch) => ({ ...state, lines: state.lines.map((l, j) => (j === i ? editGridLine(l, patch) : l)) });
  const cases = {
    unchanged: [state, stored.map(asStored)],
    // A date move keeps the stored lines: the engine's gate decides, and refuses when the era changed.
    'date moved': [state, stored.map(asStored), '2026-10-01'],
    'amount edited': [edit(0, { debit: '0.94' }), null],
    'amount edited and typed back': [edit(0, { debit: '0.93' }), null],
    'code edited': [edit(0, { taxCode: 'VST-I' }), null],
  };
  const wrong = [];
  for (const [name, [s, expect, date]] of Object.entries(cases)) {
    const got = sent(s, date);
    if (expect !== null) {
      if (JSON.stringify(got) !== JSON.stringify(expect)) wrong.push(`${name}: ${JSON.stringify(got)}`);
    } else if (got[0].taxBase !== undefined || got[0].taxAmount !== undefined) wrong.push(`${name}: a stored trace rode an edited row ${JSON.stringify(got[0])}`);
  }
  assert.deepEqual(wrong, []);
  // Untouched, the gate takes the stored hints; edited, the gate prices what is shown and says why it refuses.
  assert.deepEqual(compose(w, state, '2026-09-30', id).answer.verdict, { ok: true });
  assert.equal(compose(w, edit(0, { debit: '0.93' }), '2026-09-30', id).answer.verdict.error, 'vat_trace_unreconciled');
});

test('critic r3: the engine never stores a stated taxBase (or a stale non-fixed-point taxAmount) on a manual post', () => {
  const w = world();
  const r = postEntry(w.ctx, {
    date: '2026-03-02', source: 'manual', idempotencyKey: 'bogus',
    lines: [
      { account: w.byNumber('6500'), debit: 93, taxCode: 'VST-M', taxBase: 5000, taxAmount: 7 },
      { account: w.byNumber('1170'), debit: 7 },
      { account: w.byNumber('1020'), credit: 100 },
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const row = w.store.db.prepare('SELECT tax_base_minor, tax_amount_minor FROM journal_line WHERE entry_id = ? AND tax_code IS NOT NULL').get(r.entryId);
  assert.deepEqual(row, { tax_base_minor: 93, tax_amount_minor: 7 });
  const r2 = postEntry(w.ctx, {
    date: '2026-03-02', source: 'manual', idempotencyKey: 'bogus2',
    lines: [
      { account: w.byNumber('6500'), debit: 9963, taxCode: 'VST-M', taxBase: 9963, taxAmount: 700 },
      { account: w.byNumber('1170'), debit: 700 },
      { account: w.byNumber('1020'), credit: 10663 },
    ],
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'vat_trace_unreconciled');
});
