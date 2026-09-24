// B2/B3, the post-boundary VAT gate: the ENGINE owns the trace.
//
// Before this gate, post_entry persisted whatever taxCode/taxBase/taxAmount a client stamped, so a
// stale or hand-edited GUI trace could diverge from the booked 2200/1170 money (A07 would then report
// a figure the ledger does not hold), a Bezugsteuer entry could omit its statutory legs entirely, and
// a garbage code posted fine. Now, for every tagged line, postEntry:
//  (a) resolves the code (unknown_tax_code / needs_vat_config),
//  (b) recomputes the canonical base and tax server-side via the SAME computeLineTax and stamps THOSE
//      (a client value is only a hint to pick between the two honest rounding interpretations,
//      net-entered vs gross-entered; anything else is discarded), and
//  (c) rejects with vat_trace_unreconciled unless the entry's 2200 (output) and 1170/1171 (input)
//      movements equal the canonical tax of the tagged lines.
// Reversals are exempt from the RECOMPUTE only (F1): every posted line's code must exist, and
// reversalMirrorsTarget enforces the per-LINE negation of the target's stored lines, tax code
// included, so a reversal carries exactly the traces the target carried (gated at its post), negated.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { postEntry, reverseEntry } from '../../dist/core/ledger/index.js';
import { buildVatLines, computeLineTax } from '../../dist/core/vat/index.js';
import { setup } from './support.mjs';

/** Look up the seeded KMU account id by its number. */
function acc(ctx, number) {
  return ctx.store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, number).id;
}

function storedLines(ctx, entryId) {
  return ctx.store.db
    .prepare(
      'SELECT account_id, debit_minor, credit_minor, tax_code, tax_base_minor, tax_amount_minor FROM journal_line WHERE entry_id = ?',
    )
    .all(entryId);
}

let key = 0;
function post(ctx, lines, over = {}) {
  key += 1;
  return postEntry(ctx, {
    date: '2026-03-01',
    source: 'manual',
    idempotencyKey: `gate-${key}`,
    lines,
    ...over,
  });
}

// --- (a) code existence ------------------------------------------------------------------------

test('B2: post_entry rejects a garbage tax code (unknown_tax_code), it no longer posts', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const r = post(ctx, [
    { account: acc(ctx, '6500'), debit: 100000, taxCode: 'GARBAGE' },
    { account: acc(ctx, '1000'), credit: 100000 },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unknown_tax_code');
});

test('B2: a tagged post on an unconfigured workspace is needs_vat_config (P9, one code path)', () => {
  const { ctx } = setup({ method: 'effektiv', registered: false });
  const r = post(ctx, [
    { account: acc(ctx, '6500'), debit: 100000, taxCode: 'UST81' },
    { account: acc(ctx, '1000'), credit: 100000 },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'needs_vat_config');
});

test('B2: taxBase/taxAmount without a taxCode are rejected, never persisted as an orphan trace', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const r = post(ctx, [
    { account: acc(ctx, '6500'), debit: 100000, taxBase: 100000, taxAmount: 8100 },
    { account: acc(ctx, '1000'), credit: 100000 },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_line');
});

// --- (c) reconciliation ------------------------------------------------------------------------

test('B2: the critic divergence: revenue 1000.00 UST81 with a hand-typed 81.05 on 2200 is rejected', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const r = post(ctx, [
    { account: acc(ctx, '1100'), debit: 108105 },
    { account: acc(ctx, '3200'), credit: 100000, taxCode: 'UST81', taxBase: 100000, taxAmount: 8100 },
    { account: acc(ctx, '2200'), credit: 8105 },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'vat_trace_unreconciled');
  assert.equal(r.account, '2200');
  assert.equal(r.expectedMinor, 8100);
  assert.equal(r.bookedMinor, 8105);
});

test('B2: a Bezugsteuer entry OMITTING the 2200/1170 legs is rejected, not silently posted', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const r = post(ctx, [
    { account: acc(ctx, '4000'), debit: 200000, taxCode: 'BEZUG' },
    { account: acc(ctx, '2000'), credit: 200000 },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'vat_trace_unreconciled');
  assert.equal(r.expectedMinor, 16200);
  assert.equal(r.bookedMinor, 0);
});

test('B2: an effektiv input line whose 1170 leg is missing is rejected', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const r = post(ctx, [
    { account: acc(ctx, '4000'), debit: 100000, taxCode: 'VST-M' },
    { account: acc(ctx, '2000'), credit: 100000 },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'vat_trace_unreconciled');
  assert.equal(r.account, '1170/1171');
});

// --- (b) canonical server-side stamping --------------------------------------------------------

test('B2: the engine stamps the canonical trace and discards a divergent client base/amount', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const r = post(ctx, [
    { account: acc(ctx, '1100'), debit: 108100 },
    // The client claims a nonsense trace; the booked legs are correct. The engine stamps canon.
    { account: acc(ctx, '3200'), credit: 100000, taxCode: 'UST81', taxBase: 999999, taxAmount: 1 },
    { account: acc(ctx, '2200'), credit: 8100 },
  ]);
  assert.equal(r.ok, true);
  const revenue = storedLines(ctx, r.entryId).find((l) => l.account_id === acc(ctx, '3200'));
  assert.equal(revenue.tax_code, 'UST81');
  assert.equal(revenue.tax_base_minor, 100000);
  assert.equal(revenue.tax_amount_minor, 8100);
});

test('B3: a stale client trace cannot skew the books: the engine recomputes from the POSTED amount', () => {
  const { ctx } = setup({ method: 'effektiv' });
  // The drawer race: the amount was edited 1000.00 -> 2000.00 but the cached preview still says
  // 81.00. The client stamps the stale trace AND books the stale 2200. The engine recomputes from
  // the posted 2000.00 and rejects the 81.00 leg (never books 2000.00 revenue with 81.00 VAT).
  const r = post(ctx, [
    { account: acc(ctx, '1100'), debit: 208100 },
    { account: acc(ctx, '3200'), credit: 200000, taxCode: 'UST81', taxBase: 100000, taxAmount: 8100 },
    { account: acc(ctx, '2200'), credit: 8100 },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'vat_trace_unreconciled');
  assert.equal(r.expectedMinor, 16200);
  assert.equal(r.bookedMinor, 8100);
});

test('B2: a gross-entered split posts and keeps its money-preserving tax (the OTHER honest rounding)', () => {
  const { ctx } = setup({ method: 'effektiv' });
  // Gross 1000.06 at 8.1%: the gross split books tax 7494 / net 92512 (preserving 100006), while
  // the net formula on 92512 re-derives 7493. Both are one honest round; the booked legs pick the
  // gross interpretation and the gate must accept AND stamp exactly that, or B1's preservation and
  // this gate would contradict each other.
  const r = post(ctx, [
    { account: acc(ctx, '4000'), debit: 92512, taxCode: 'VST-M', taxBase: 92512, taxAmount: 7494 },
    { account: acc(ctx, '1170'), debit: 7494 },
    { account: acc(ctx, '2000'), credit: 100006 },
  ]);
  assert.equal(r.ok, true);
  const expense = storedLines(ctx, r.entryId).find((l) => l.account_id === acc(ctx, '4000'));
  assert.equal(expense.tax_base_minor, 92512);
  assert.equal(expense.tax_amount_minor, 7494, 'the gross-split tax is stamped, not re-rounded to 7493');
});

test('B2: an out-of-set tax leg one Rappen off in the WRONG direction still rejects', () => {
  const { ctx } = setup({ method: 'effektiv' });
  // 7493 (net formula) and 7494 (gross split) are the two honest figures for this split; 7492 is
  // neither and must not post.
  const r = post(ctx, [
    { account: acc(ctx, '4000'), debit: 92512, taxCode: 'VST-M' },
    { account: acc(ctx, '1170'), debit: 7492 },
    { account: acc(ctx, '2000'), credit: 100004 },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'vat_trace_unreconciled');
});

test('B2: a credit-note (output tagged on the debit side) reconciles signed and stamps a negated trace', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const r = post(ctx, [
    { account: acc(ctx, '3200'), debit: 100000, taxCode: 'UST81' },
    { account: acc(ctx, '2200'), debit: 8100 },
    { account: acc(ctx, '1100'), credit: 108100 },
  ]);
  assert.equal(r.ok, true);
  const revenue = storedLines(ctx, r.entryId).find((l) => l.account_id === acc(ctx, '3200'));
  assert.equal(revenue.tax_base_minor, -100000, 'an unnatural-side base stamps negated (reversal convention)');
  assert.equal(revenue.tax_amount_minor, -8100);
});

// --- buildVatLines output passes the gate by construction, for every kind ----------------------

test('B2: every buildVatLines expansion posts through the gate (A07-reads-trace == ledger by construction)', () => {
  const cases = [
    { method: 'effektiv', taxCode: 'UST81', direction: 'output', counter: '1100', main: '3200', gross: false },
    { method: 'effektiv', taxCode: 'UST26', direction: 'output', counter: '1100', main: '3200', gross: true },
    { method: 'effektiv', taxCode: 'VST-M', direction: 'input', counter: '2000', main: '4000', gross: true },
    { method: 'effektiv', taxCode: 'VST-I', direction: 'input', counter: '2000', main: '4000', gross: true },
    { method: 'effektiv', taxCode: 'BEZUG', direction: 'input', counter: '2000', main: '4000', gross: false },
    { method: 'effektiv', taxCode: 'IMPORT', direction: 'input', counter: '1020', main: '4000', gross: false },
    { method: 'effektiv', taxCode: 'EXPORT0', direction: 'output', counter: '1100', main: '3200', gross: false },
    { method: 'effektiv', taxCode: 'AUSGENOMMEN', direction: 'output', counter: '1100', main: '3200', gross: false },
    { method: 'saldo', taxCode: 'UST81', direction: 'output', counter: '1100', main: '3200', gross: false },
    { method: 'saldo', taxCode: 'VST-M', direction: 'input', counter: '2000', main: '4000', gross: true },
    { method: 'saldo', taxCode: 'BEZUG', direction: 'input', counter: '2000', main: '4000', gross: false },
    { method: 'saldo', taxCode: 'IMPORT', direction: 'input', counter: '1020', main: '4000', gross: false },
  ];
  for (const c of cases) {
    const { ctx } = setup({ method: c.method });
    // 1000.06 gross (or net) exercises the drifting rounding corner, not just the clean 1081.00.
    const lines = buildVatLines(ctx, {
      counterAccount: acc(ctx, c.counter),
      revenueOrExpenseAccount: acc(ctx, c.main),
      amountMinor: 100006,
      amountIsGross: c.gross,
      taxCode: c.taxCode,
      direction: c.direction,
    });
    const r = post(ctx, lines);
    assert.equal(r.ok, true, `${c.method}/${c.taxCode} gross=${c.gross} posts: ${JSON.stringify(r)}`);
  }
});

test('B2: the saldo gross fold stamps the gross-split trace (booked amount IS gross, no VAT leg)', () => {
  const { ctx } = setup({ method: 'saldo' });
  const lines = buildVatLines(ctx, {
    counterAccount: acc(ctx, '2000'),
    revenueOrExpenseAccount: acc(ctx, '4000'),
    amountMinor: 108100,
    amountIsGross: true,
    taxCode: 'VST-M',
    direction: 'input',
    supplyDate: '2026-03-01',
  });
  const r = post(ctx, lines);
  assert.equal(r.ok, true, JSON.stringify(r));
  const expense = storedLines(ctx, r.entryId).find((l) => l.account_id === acc(ctx, '4000'));
  assert.equal(expense.debit_minor, 108100, 'gross folds into the cost account');
  assert.equal(expense.tax_base_minor, 100000, 'trace records the net inside the fold');
  assert.equal(expense.tax_amount_minor, 8100, 'trace records the folded (non-deductible) tax');
});

// --- reversal stays the faithful mirror, exempt from recompute ---------------------------------

test('B2: reversing a gated VAT entry still mirrors the trace negated (gate skips source=reversal)', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const posted = post(ctx, [
    { account: acc(ctx, '1100'), debit: 108100 },
    { account: acc(ctx, '3200'), credit: 100000, taxCode: 'UST81' },
    { account: acc(ctx, '2200'), credit: 8100 },
  ]);
  assert.equal(posted.ok, true, JSON.stringify(posted));
  const rev = reverseEntry(ctx, { entryId: posted.entryId, idempotencyKey: 'rev-1' });
  assert.equal(rev.ok, true, JSON.stringify(rev));
  const line = storedLines(ctx, rev.reversalId).find((l) => l.account_id === acc(ctx, '3200'));
  assert.equal(line.tax_code, 'UST81');
  assert.equal(line.tax_base_minor, -100000);
  assert.equal(line.tax_amount_minor, -8100);
});

// --- F1: the reversal door honours the tax CODE ------------------------------------------------
//
// The re-critique's four probes: an in-process source='reversal' caller (A10/A11) must not be able
// to smuggle a trace past the gate through the mirror check. A mirror is per LINE, code included.

test('F1: a reversal that SWAPS the tax code (UST81 target, VST-M reversal) is rejected', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const target = post(ctx, [
    { account: acc(ctx, '1100'), debit: 108100 },
    { account: acc(ctx, '3200'), credit: 100000, taxCode: 'UST81' },
    { account: acc(ctx, '2200'), credit: 8100 },
  ]);
  assert.equal(target.ok, true, JSON.stringify(target));
  const r = post(
    ctx,
    [
      { account: acc(ctx, '1100'), credit: 108100 },
      { account: acc(ctx, '3200'), debit: 100000, taxCode: 'VST-M', taxBase: -100000, taxAmount: -8100 },
      { account: acc(ctx, '2200'), debit: 8100 },
    ],
    { source: 'reversal', reversesEntryId: target.entryId },
  );
  assert.equal(r.ok, false, 'a swapped-code reversal must not post');
  assert.equal(r.error, 'not_a_mirror');
});

test('F1: a reversal carrying a NONEXISTENT tax code is rejected (unknown_tax_code)', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const target = post(ctx, [
    { account: acc(ctx, '1100'), debit: 108100 },
    { account: acc(ctx, '3200'), credit: 100000, taxCode: 'UST81' },
    { account: acc(ctx, '2200'), credit: 8100 },
  ]);
  assert.equal(target.ok, true, JSON.stringify(target));
  const r = post(
    ctx,
    [
      { account: acc(ctx, '1100'), credit: 108100 },
      { account: acc(ctx, '3200'), debit: 100000, taxCode: 'NOT_A_CODE', taxBase: -100000, taxAmount: -8100 },
      { account: acc(ctx, '2200'), debit: 8100 },
    ],
    { source: 'reversal', reversesEntryId: target.entryId },
  );
  assert.equal(r.ok, false, 'a nonexistent code must not post, reversal or not');
  assert.equal(r.error, 'unknown_tax_code');
});

test('F1: fabricated traces on an UNTRACED target are rejected even when their sums cancel', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const target = post(ctx, [
    { account: acc(ctx, '6500'), debit: 100000 },
    { account: acc(ctx, '1000'), credit: 100000 },
  ]);
  assert.equal(target.ok, true, JSON.stringify(target));
  // Two lines in the same (account, cost centre) bucket whose trace sums cancel to the target's
  // zero: under the old bucket-sum check this posted, planting +8100 UST81 and -8100 VST-M into
  // the tax subledger of an entry that never carried VAT.
  const r = post(
    ctx,
    [
      { account: acc(ctx, '6500'), credit: 50000, taxCode: 'UST81', taxBase: 100000, taxAmount: 8100 },
      { account: acc(ctx, '6500'), credit: 50000, taxCode: 'VST-M', taxBase: -100000, taxAmount: -8100 },
      { account: acc(ctx, '1000'), debit: 100000 },
    ],
    { source: 'reversal', reversesEntryId: target.entryId },
  );
  assert.equal(r.ok, false, 'fabricated traces must not ride an untraced target');
  assert.equal(r.error, 'not_a_mirror');
});

test('F1: bucket-splitting a traced target into fabricated magnitudes is rejected', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const target = post(ctx, [
    { account: acc(ctx, '1100'), debit: 108100 },
    { account: acc(ctx, '3200'), credit: 100000, taxCode: 'UST81' },
    { account: acc(ctx, '2200'), credit: 8100 },
  ]);
  assert.equal(target.ok, true, JSON.stringify(target));
  // Same account, same code, sums equal to the required negation (-100000/-8100), but the per-line
  // traces claim a 6000.00 reversal and a 5000.00 re-book that never happened.
  const r = post(
    ctx,
    [
      { account: acc(ctx, '1100'), credit: 108100 },
      { account: acc(ctx, '3200'), debit: 600000, taxCode: 'UST81', taxBase: -600000, taxAmount: -48600 },
      { account: acc(ctx, '3200'), credit: 500000, taxCode: 'UST81', taxBase: 500000, taxAmount: 40500 },
      { account: acc(ctx, '2200'), debit: 8100 },
    ],
    { source: 'reversal', reversesEntryId: target.entryId },
  );
  assert.equal(r.ok, false, 'a bucket-split reversal is not a mirror');
  assert.equal(r.error, 'not_a_mirror');
});

test('F1: a NEW posting with an ARCHIVED code is rejected (archived_tax_code)', () => {
  const { ctx } = setup({ method: 'effektiv' });
  ctx.store.db
    .prepare("UPDATE tax_code SET active = 0 WHERE workspace_id = ? AND code = 'UST81'")
    .run(ctx.workspaceId);
  const r = post(ctx, [
    { account: acc(ctx, '1100'), debit: 108100 },
    { account: acc(ctx, '3200'), credit: 100000, taxCode: 'UST81' },
    { account: acc(ctx, '2200'), credit: 8100 },
  ]);
  assert.equal(r.ok, false, 'an archived code is not for new postings');
  assert.equal(r.error, 'archived_tax_code');
});

test('F1: a faithful reverseEntry still posts after the code is ARCHIVED (the one legal correction)', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const posted = post(ctx, [
    { account: acc(ctx, '1100'), debit: 108100 },
    { account: acc(ctx, '3200'), credit: 100000, taxCode: 'UST81' },
    { account: acc(ctx, '2200'), credit: 8100 },
  ]);
  assert.equal(posted.ok, true, JSON.stringify(posted));
  ctx.store.db
    .prepare("UPDATE tax_code SET active = 0 WHERE workspace_id = ? AND code = 'UST81'")
    .run(ctx.workspaceId);
  const rev = reverseEntry(ctx, { entryId: posted.entryId, idempotencyKey: 'rev-archived' });
  assert.equal(rev.ok, true, JSON.stringify(rev));
  const line = storedLines(ctx, rev.reversalId).find((l) => l.account_id === acc(ctx, '3200'));
  assert.equal(line.tax_code, 'UST81');
  assert.equal(line.tax_base_minor, -100000);
  assert.equal(line.tax_amount_minor, -8100);
});

// --- F2: the gate honours the Leistungsdatum (supply date), not just the booking date ----------
//
// Filing a 2023 supply in 2024 is the NORMAL case, and A06 §3 says the supply-date rate governs.
// The gate used to recompute with the ENTRY date only, refusing legs that buildVatLines correctly
// priced at the straddle rate (vat_trace_unreconciled, expected 8.1% vs booked 7.7%).

test('F2: a 2023 straddle (supplyDate 2023-11-15, booked 2024-01-20) reconciles at 7.7% and posts', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const lines = buildVatLines(ctx, {
    counterAccount: acc(ctx, '1100'),
    revenueOrExpenseAccount: acc(ctx, '3200'),
    amountMinor: 100000,
    amountIsGross: false,
    taxCode: 'UST81',
    direction: 'output',
    supplyDate: '2023-11-15',
  });
  const r = post(ctx, lines, { date: '2024-01-20' });
  assert.equal(r.ok, true, `the straddle must post: ${JSON.stringify(r)}`);
  const revenue = storedLines(ctx, r.entryId).find((l) => l.account_id === acc(ctx, '3200'));
  assert.equal(revenue.tax_base_minor, 100000);
  assert.equal(revenue.tax_amount_minor, 7700, 'the stored trace is the 7.7% figure, frozen');
});

test('F2: vat_preview and the post boundary agree on the supply date for the same input', () => {
  const { ctx } = setup({ method: 'effektiv' });
  // The preview an agent (or the GUI) sees for the 2023 supply...
  const preview = computeLineTax(ctx, {
    amountMinor: 100000,
    amountIsGross: false,
    taxCode: 'UST81',
    supplyDate: '2023-11-15',
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.taxMinor, 7700);
  // ...is exactly what the post boundary endorses when the line carries the same Leistungsdatum.
  const r = post(
    ctx,
    [
      { account: acc(ctx, '1100'), debit: 107700 },
      { account: acc(ctx, '3200'), credit: 100000, taxCode: 'UST81', supplyDate: '2023-11-15' },
      { account: acc(ctx, '2200'), credit: 7700 },
    ],
    { date: '2024-01-20' },
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  const revenue = storedLines(ctx, r.entryId).find((l) => l.account_id === acc(ctx, '3200'));
  assert.equal(revenue.tax_base_minor, preview.trace.taxBaseMinor);
  assert.equal(revenue.tax_amount_minor, preview.taxMinor);
});

test('F2: a same-day entry with no per-line supplyDate is unchanged (the entry date governs)', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const r = post(ctx, [
    { account: acc(ctx, '1100'), debit: 108100 },
    { account: acc(ctx, '3200'), credit: 100000, taxCode: 'UST81' },
    { account: acc(ctx, '2200'), credit: 8100 },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const revenue = storedLines(ctx, r.entryId).find((l) => l.account_id === acc(ctx, '3200'));
  assert.equal(revenue.tax_amount_minor, 8100, 'supplyDate absent: the entry date still governs');
});

test('F2: a malformed per-line supplyDate is a structured rejection, never silently the entry date', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const r = post(ctx, [
    { account: acc(ctx, '1100'), debit: 108100 },
    { account: acc(ctx, '3200'), credit: 100000, taxCode: 'UST81', supplyDate: '2023-13-45' },
    { account: acc(ctx, '2200'), credit: 8100 },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_line');
});

// --- import convention: the assessed-tax line on 1170 is the tagged line -----------------------

test('B2: an import posting tags the 1170 line with the assessed tax and reconciles', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const r = post(ctx, [
    { account: acc(ctx, '1170'), debit: 15500, taxCode: 'IMPORT' },
    { account: acc(ctx, '1020'), credit: 15500 },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const line = storedLines(ctx, r.entryId).find((l) => l.account_id === acc(ctx, '1170'));
  assert.equal(line.tax_base_minor, 0);
  assert.equal(line.tax_amount_minor, 15500);
});
