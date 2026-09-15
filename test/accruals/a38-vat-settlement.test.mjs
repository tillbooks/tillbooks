// A38 (D129 leg 2), the MWST-Saldierung: the money-path evidence.
//
// The capability POSTS into a FILED period, so the unforgiving assertions live here: the preview is
// the posting (one model, byte-equal lines), the filed return and the bridge are UNCHANGED by a posted
// settlement (computed before and after, compared as JSON), a re-post is idempotent ON ROWS, the
// invariants refuse rather than guess (period_not_filed, nothing_to_settle, already_posted,
// already_reversed, period_locked on a seal), §H-TENANT holds, the reversal nets every account to zero
// inside the settled period, and on the Nomadik-shaped FY 2026 fixture the MWST-KONTEN-NULL fact of the
// year_close checklist becomes reachable: after four settlements 1170 = 1171 = 2200 = 0 at 31.12. and
// 2201 = the Q4 net (Q1 to Q3 paid to the ESTV from the bank).

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { makeContext } from '../../dist/core/context.js';
import { postEntry, reverseEntry, ledgerPorts } from '../../dist/core/ledger/index.js';
import { buildVatLines, computeVatReturn, configureVat, markVatPeriodFiled } from '../../dist/core/vat/index.js';
import { settlementModelOf, vatSettlementPost, vatSettlementPreview, vatSettlementReverse } from '../../dist/core/accruals/vatSettlement.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { setup } from '../vat/support.mjs';

const call = (deps, workspaceId, name, input) => getAction(name).run(deps, { workspaceId, ...input });

/** Net (debit - credit) in base Rappen on `number` across posted lines dated at or before `upTo`. */
function balance(deps, workspaceId, number, upTo = '9999-12-31') {
  return deps.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ? AND a.number = ? AND e.status = 'posted' AND e.date <= ?`,
    )
    .get(workspaceId, number, upTo).net;
}

function entryCount(deps, workspaceId) {
  return deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n;
}

function rowCount(deps, workspaceId) {
  return deps.store.db.prepare('SELECT COUNT(*) AS n FROM vat_settlement WHERE workspace_id = ?').get(workspaceId).n;
}

/** An effektiv/soll workspace through the registry, with the default tax codes. */
function effektivWorld(deps) {
  const { workspaceId, accId } = mintWorkspace(deps);
  call(deps, workspaceId, 'vat_seed_defaults', {});
  call(deps, workspaceId, 'set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  return { workspaceId, accId };
}

let n = 0;
const key = (tag) => `a38-${tag}-${(n += 1)}`;

/** One taxable sale (Ziffer 303) and one deductible purchase (Ziffer 400) inside a quarter. */
function quarterActivity(deps, ws, accId, { saleNet, purchaseNet, saleDate, purchaseDate }) {
  const sale = call(deps, ws, 'post_entry', {
    date: saleDate,
    source: 'manual',
    description: 'Beratung',
    idempotencyKey: key('sale'),
    lines: [
      { account: accId('1100'), debit: Math.round(saleNet * 1.081) },
      { account: accId('3200'), credit: saleNet, taxCode: 'UST81' },
      { account: accId('2200'), credit: Math.round(saleNet * 0.081) },
    ],
  });
  assert.equal(sale.ok, true, JSON.stringify(sale));
  if (purchaseNet > 0) {
    const purchase = call(deps, ws, 'post_entry', {
      date: purchaseDate,
      source: 'manual',
      description: 'Material',
      idempotencyKey: key('purchase'),
      lines: [
        { account: accId('4000'), debit: purchaseNet, taxCode: 'VST-M' },
        { account: accId('1170'), debit: Math.round(purchaseNet * 0.081) },
        { account: accId('2000'), credit: Math.round(purchaseNet * 1.081) },
      ],
    });
    assert.equal(purchase.ok, true, JSON.stringify(purchase));
  }
}

const QUARTERS = [
  { label: '2026-Q1', end: '2026-03-31', saleNet: 4_000_000, purchaseNet: 1_000_000, saleDate: '2026-02-10', purchaseDate: '2026-03-05', payOn: '2026-05-28' },
  { label: '2026-Q2', end: '2026-06-30', saleNet: 5_000_000, purchaseNet: 2_000_000, saleDate: '2026-05-15', purchaseDate: '2026-05-20', payOn: '2026-08-28' },
  { label: '2026-Q3', end: '2026-09-30', saleNet: 3_000_000, purchaseNet: 500_000, saleDate: '2026-08-12', purchaseDate: '2026-09-03', payOn: '2026-11-27' },
  { label: '2026-Q4', end: '2026-12-31', saleNet: 6_000_000, purchaseNet: 1_500_000, saleDate: '2026-11-11', purchaseDate: '2026-12-02', payOn: null },
];

/**
 * The Nomadik-shaped FY 2026: calendar year, effektiv quarterly, activity in every quarter, Q1 to Q3
 * paid to the ESTV from the bank inside the following quarter (Dr 2201 / Cr 1020 for the quarter's
 * net, dated before that quarter is filed), all four quarters filed. Nothing settled yet.
 */
function nomadikYear(deps) {
  const { workspaceId: ws, accId } = effektivWorld(deps);
  for (const q of QUARTERS) {
    quarterActivity(deps, ws, accId, q);
    if (q.payOn !== null) {
      const preview = vatSettlementPreview(makeCtx(deps, ws), { period: q.label });
      assert.equal(preview.ok, true, JSON.stringify(preview));
      const paid = call(deps, ws, 'post_entry', {
        date: q.payOn,
        source: 'manual',
        description: `MWST ${q.label} an ESTV`,
        idempotencyKey: key('pay'),
        lines: [{ account: accId('2201'), debit: preview.netMinor }, { account: accId('1020'), credit: preview.netMinor }],
      });
      assert.equal(paid.ok, true, JSON.stringify(paid));
    }
  }
  for (const q of QUARTERS) {
    const filed = call(deps, ws, 'vat_mark_filed', { period: q.label, idempotencyKey: key('file') });
    assert.equal(filed.ok, true, JSON.stringify(filed));
  }
  return { ws, accId };
}

function makeCtx(deps, workspaceId) {
  return makeContext(deps.store, { workspaceId, actor: 'user_1', clock: deps.clock, ids: deps.ids, ...ledgerPorts({ store: deps.store, workspaceId, ids: deps.ids }) });
}

function returnsOf(deps, ws) {
  return QUARTERS.map((q) => {
    const r = call(deps, ws, 'vat_return', { periodStart: `${q.end.slice(0, 4)}-${String(Number(q.end.slice(5, 7)) - 2).padStart(2, '0')}-01`, periodEnd: q.end });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r;
  });
}

// --- the preview is the posting ----------------------------------------------------------------

test('the preview reads the booked movement, the return beside it, and the exact lines Dr 2200 / Cr 2201, Dr 2201 / Cr 1170', () => {
  const deps = freshDeps();
  const { ws, accId } = nomadikYear(deps);
  const p = call(deps, ws, 'vat_settlement_preview', { period: '2026-Q1' });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.method, 'effektiv');
  assert.equal(p.filed, true);
  assert.equal(p.periodStart, '2026-01-01');
  assert.equal(p.periodEnd, '2026-03-31');
  assert.equal(p.outputMinor, 324_000, 'net credit on 2200: 4.0m x 8.1%');
  assert.equal(p.inputMinor, 81_000, 'net debit on 1170: 1.0m x 8.1%');
  assert.equal(p.netMinor, 243_000);
  assert.deepEqual(p.declared, { outputMinor: 324_000, inputMinor: 81_000, netMinor: 243_000 }, 'Ziffer 399 and 400 beside the books');
  assert.deepEqual(p.differences, { outputMinor: 0, inputMinor: 0, netMinor: 0 });
  assert.equal(p.nothingToSettle, false);
  assert.equal(p.settlement, null);
  assert.deepEqual(
    p.lines.map((l) => [l.role, l.accountNumber, l.debitMinor, l.creditMinor]),
    [
      ['output', '2200', 324_000, 0],
      ['input_1170', '1170', 0, 81_000],
      ['output', '2201', 0, 243_000],
    ],
  );
  assert.equal(p.lines.every((l) => l.accountId === accId(l.accountNumber)), true, 'the lines name the chart ids');
});

test('the post writes EXACTLY the lines the preview showed, dated the period end, source vat_settlement, and one row', () => {
  const deps = freshDeps();
  const { ws } = nomadikYear(deps);
  const preview = call(deps, ws, 'vat_settlement_preview', { period: '2026-Q2' });
  const posted = call(deps, ws, 'vat_settlement_post', { period: '2026-Q2', idempotencyKey: 'q2-1' });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  assert.equal(posted.status, 'posted');
  assert.deepEqual(posted.lines, preview.lines, 'one model: the post books what the preview showed');
  assert.equal(posted.outputMinor, preview.outputMinor);
  assert.equal(posted.netMinor, preview.netMinor);

  const entry = deps.store.db.prepare('SELECT date, source, status, description FROM journal_entry WHERE id = ?').get(posted.entryId);
  assert.deepEqual(entry, { date: '2026-06-30', source: 'vat_settlement', status: 'posted', description: 'MWST-Saldierung 2026-Q2' });
  const lines = deps.store.db
    .prepare('SELECT a.number, l.base_debit_minor AS d, l.base_credit_minor AS c FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.rowid')
    .all(posted.entryId);
  assert.deepEqual(
    lines,
    preview.lines.map((l) => ({ number: l.accountNumber, d: l.debitMinor, c: l.creditMinor })),
  );
  assert.equal(rowCount(deps, ws), 1);
  const again = call(deps, ws, 'vat_settlement_preview', { period: '2026-Q2' });
  assert.equal(again.settlement.settlementId, posted.settlementId, 'the preview now names the standing settlement');
  // The settlement entry is EXCLUDED from the read, so the preview still shows the figures that were
  // settled (the same model, byte-equal lines) beside the row that settled them; it does not collapse
  // to zero and pretend the quarter never owed anything. `already_posted` is the guard, not the read.
  assert.equal(again.nothingToSettle, false);
  assert.deepEqual(again.lines, preview.lines);
  assert.equal(again.outputMinor, preview.outputMinor, 'the booked figures still read what was settled, not zero');
});

// --- the filed figure does not move ------------------------------------------------------------

test('a posted settlement leaves vat_return and the bridge UNCHANGED: four quarters computed before and after, byte-equal', () => {
  const deps = freshDeps();
  const { ws } = nomadikYear(deps);
  const before = returnsOf(deps, ws);
  for (const r of before) {
    assert.equal(r.reconciled, true, 'the healthy fixture reconciles before settlement');
    assert.equal(r.bridge.kind, 'match');
  }
  for (const q of QUARTERS) {
    const s = call(deps, ws, 'vat_settlement_post', { period: q.label, idempotencyKey: key('settle') });
    assert.equal(s.ok, true, JSON.stringify(s));
  }
  const after = returnsOf(deps, ws);
  assert.equal(JSON.stringify(after), JSON.stringify(before), 'the filed returns are byte-identical after four settlements');
  for (const r of after) {
    assert.equal(r.reconciliation.driftMinor, 0);
    assert.equal(r.bridge.kind, 'match');
  }
});

test('MWST-KONTEN-NULL: after four settlements 1170 = 1171 = 2200 = 0 at 31.12. and 2201 = the Q4 net', () => {
  const deps = freshDeps();
  const { ws } = nomadikYear(deps);
  assert.notEqual(balance(deps, ws, '2200', '2026-12-31'), 0, 'before: 2200 carries the year');
  const nets = {};
  for (const q of QUARTERS) {
    const s = call(deps, ws, 'vat_settlement_post', { period: q.label, idempotencyKey: key('settle') });
    assert.equal(s.ok, true, JSON.stringify(s));
    nets[q.label] = s.netMinor;
  }
  assert.equal(balance(deps, ws, '2200', '2026-12-31'), 0);
  assert.equal(balance(deps, ws, '1170', '2026-12-31'), 0);
  assert.equal(balance(deps, ws, '1171', '2026-12-31'), 0);
  // 2201 is a liability: a credit balance reads negative on the debit-positive convention.
  assert.equal(balance(deps, ws, '2201', '2026-12-31'), -nets['2026-Q4']);
  assert.equal(nets['2026-Q4'], 6_000_000 * 0.081 - 1_500_000 * 0.081);
  // The year-close validation's own read is by period: each quarter's 2200 movement nets to zero.
  for (const q of QUARTERS) {
    const start = `${q.end.slice(0, 4)}-${String(Number(q.end.slice(5, 7)) - 2).padStart(2, '0')}-01`;
    const inPeriod = deps.store.db
      .prepare(
        `SELECT COALESCE(SUM(l.base_credit_minor - l.base_debit_minor), 0) AS net FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id
          WHERE e.workspace_id = ? AND a.number = '2200' AND e.status = 'posted' AND e.date >= ? AND e.date <= ?`,
      )
      .get(ws, start, q.end).net;
    assert.equal(inPeriod, 0, `${q.label} 2200 nets to zero inside the period`);
  }
  const listed = call(deps, ws, 'vat_settlement_list', { year: '2026' });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.settlements.map((s) => [s.period, s.status]), [['2026-Q4', 'posted'], ['2026-Q3', 'posted'], ['2026-Q2', 'posted'], ['2026-Q1', 'posted']]);
});

// --- the refusals ---------------------------------------------------------------------------------

test('period_not_filed: a settlement waits for the declaration; the preview still answers with filed:false', () => {
  const deps = freshDeps();
  const { workspaceId: ws, accId } = effektivWorld(deps);
  quarterActivity(deps, ws, accId, QUARTERS[1]);
  const p = call(deps, ws, 'vat_settlement_preview', { period: '2026-Q2' });
  assert.equal(p.ok, true);
  assert.equal(p.filed, false);
  assert.equal(p.outputMinor, 405_000);
  const before = entryCount(deps, ws);
  const r = call(deps, ws, 'vat_settlement_post', { period: '2026-Q2', idempotencyKey: 'unfiled' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'period_not_filed');
  assert.equal(r.period, '2026-Q2');
  assert.equal(entryCount(deps, ws), before);
  assert.equal(rowCount(deps, ws), 0);
});

test('nothing_to_settle: a filed period with no movement on the three accounts posts nothing and records no row', () => {
  const deps = freshDeps();
  const { workspaceId: ws } = effektivWorld(deps);
  assert.equal(call(deps, ws, 'vat_mark_filed', { period: '2026-Q1', idempotencyKey: 'f-q1' }).ok, true);
  const p = call(deps, ws, 'vat_settlement_preview', { period: '2026-Q1' });
  assert.equal(p.nothingToSettle, true);
  assert.deepEqual(p.lines, []);
  assert.equal(p.netMinor, 0);
  const r = call(deps, ws, 'vat_settlement_post', { period: '2026-Q1', idempotencyKey: 'empty' });
  assert.equal(r.error, 'nothing_to_settle');
  assert.equal(rowCount(deps, ws), 0);
});

test('§H-IDEMPOTENT on ROWS: the same key replays byte-identically and writes nothing; a different key is already_posted', () => {
  const deps = freshDeps();
  const { ws } = nomadikYear(deps);
  const first = call(deps, ws, 'vat_settlement_post', { period: '2026-Q3', idempotencyKey: 'q3-key' });
  assert.equal(first.ok, true);
  const entries = entryCount(deps, ws);
  const replay = call(deps, ws, 'vat_settlement_post', { period: '2026-Q3', idempotencyKey: 'q3-key' });
  assert.equal(JSON.stringify(replay), JSON.stringify(first));
  assert.equal(entryCount(deps, ws), entries);
  assert.equal(rowCount(deps, ws), 1);
  const other = call(deps, ws, 'vat_settlement_post', { period: '2026-Q3', idempotencyKey: 'q3-other' });
  assert.equal(other.ok, false);
  assert.equal(other.error, 'already_posted');
  assert.equal(other.settlementId, first.settlementId);
  assert.equal(other.entryId, first.entryId);
  assert.equal(entryCount(deps, ws), entries);
  assert.equal(rowCount(deps, ws), 1);
});

test('a settlement into a year_close SEAL is refused period_locked {reason: year_close}, nothing written', () => {
  const deps = freshDeps();
  const { ws } = nomadikYear(deps);
  const sealed = call(deps, ws, 'close_year', { year: '2026', idempotencyKey: 'seal' });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  const before = entryCount(deps, ws);
  const r = call(deps, ws, 'vat_settlement_post', { period: '2026-Q4', idempotencyKey: 'sealed' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'period_locked');
  assert.equal(r.reason, 'year_close');
  assert.equal(entryCount(deps, ws), before);
  assert.equal(rowCount(deps, ws), 0, 'the row is rolled back with the refused entry');
});

test('invalid_period for a malformed label, a label the method does not file, and needs_vat_config with no method', () => {
  const deps = freshDeps();
  const { workspaceId: ws } = effektivWorld(deps);
  const bad = call(deps, ws, 'vat_settlement_preview', { period: 'Q2/2026' });
  assert.equal(bad.error, 'invalid_period');
  const half = call(deps, ws, 'vat_settlement_preview', { period: '2026-H1' });
  assert.equal(half.error, 'invalid_period');
  assert.deepEqual(half.expected, ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4']);
  const { workspaceId: bare } = mintWorkspace(deps, 'Bare AG', 'ws-bare');
  const none = call(deps, bare, 'vat_settlement_preview', { period: '2026-Q1' });
  assert.equal(none.error, 'needs_vat_config');
});

// --- the reversal ---------------------------------------------------------------------------------

test('reverse: the Storno is dated the period end inside the filed lock, every account nets back, and a fresh post creates a NEW row', () => {
  const deps = freshDeps();
  const { ws } = nomadikYear(deps);
  const beforeBalances = ['2200', '1170', '2201'].map((a) => balance(deps, ws, a, '2026-12-31'));
  const posted = call(deps, ws, 'vat_settlement_post', { period: '2026-Q4', idempotencyKey: 'q4-1' });
  assert.equal(posted.ok, true);
  const reversed = call(deps, ws, 'vat_settlement_reverse', { settlementId: posted.settlementId, idempotencyKey: 'q4-rev' });
  assert.equal(reversed.ok, true, JSON.stringify(reversed));
  assert.equal(reversed.status, 'reversed');
  const rev = deps.store.db.prepare('SELECT date, source, reverses_entry_id FROM journal_entry WHERE id = ?').get(reversed.reversalEntryId);
  assert.deepEqual(rev, { date: '2026-12-31', source: 'reversal', reverses_entry_id: posted.entryId });
  assert.deepEqual(
    ['2200', '1170', '2201'].map((a) => balance(deps, ws, a, '2026-12-31')),
    beforeBalances,
    'the reversal restores every balance inside the period',
  );

  // The row keeps its history and the return is still untouched.
  const row = deps.store.db.prepare('SELECT status, reversal_entry_id, reversed_by FROM vat_settlement WHERE id = ?').get(posted.settlementId);
  assert.deepEqual(row, { status: 'reversed', reversal_entry_id: reversed.reversalEntryId, reversed_by: 'agent' });
  const again = call(deps, ws, 'vat_settlement_reverse', { settlementId: posted.settlementId, idempotencyKey: 'q4-rev-2' });
  assert.equal(again.error, 'already_reversed');
  const replay = call(deps, ws, 'vat_settlement_reverse', { settlementId: posted.settlementId, idempotencyKey: 'q4-rev' });
  assert.equal(JSON.stringify(replay), JSON.stringify(reversed));

  // A fresh post: the preview reads the movement again (the reversed pair is excluded), and posts a new row.
  const p = call(deps, ws, 'vat_settlement_preview', { period: '2026-Q4' });
  assert.equal(p.settlement, null);
  assert.equal(p.nothingToSettle, false);
  assert.equal(p.outputMinor, posted.outputMinor);
  const second = call(deps, ws, 'vat_settlement_post', { period: '2026-Q4', idempotencyKey: 'q4-2' });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.notEqual(second.settlementId, posted.settlementId);
  assert.notEqual(second.entryId, posted.entryId);
  assert.equal(rowCount(deps, ws), 2);
  const listed = call(deps, ws, 'vat_settlement_list', { year: '2026' });
  assert.deepEqual(listed.settlements.map((s) => s.status), ['posted', 'reversed']);
  // Only Q4 is settled in this test, so 2200 still carries Q1 to Q3: exactly the Q4 output moved.
  assert.equal(balance(deps, ws, '2200', '2026-12-31'), beforeBalances[0] + second.outputMinor);
});

test('§H-AUDIT: the settlement row admits no edit of its figures and no delete (accrual_append_only)', () => {
  const deps = freshDeps();
  const { ws } = nomadikYear(deps);
  const posted = call(deps, ws, 'vat_settlement_post', { period: '2026-Q1', idempotencyKey: 'q1-audit' });
  assert.equal(posted.ok, true);
  assert.throws(() => deps.store.db.prepare('UPDATE vat_settlement SET net_minor = 1 WHERE id = ?').run(posted.settlementId), /accrual_append_only/);
  assert.throws(() => deps.store.db.prepare('DELETE FROM vat_settlement WHERE id = ?').run(posted.settlementId), /accrual_append_only/);
  const audit = call(deps, ws, 'get_audit_log', { entityKind: 'vat_settlement' });
  assert.equal(audit.ok, true, JSON.stringify(audit));
  assert.ok(audit.rows.some((e) => e.entityKind === 'vat_settlement' && e.entityId === posted.settlementId && e.action === 'post'), JSON.stringify(audit));
  assert.equal(audit.chainVerified, true);
});

// --- §H-TENANT ------------------------------------------------------------------------------------

test('§H-TENANT: a second workspace in the SAME store lists nothing, previews its own book, and gets not_found on a foreign id', () => {
  const deps = freshDeps();
  const { ws } = nomadikYear(deps);
  const posted = call(deps, ws, 'vat_settlement_post', { period: '2026-Q1', idempotencyKey: 'q1-t' });
  assert.equal(posted.ok, true);
  const { workspaceId: other } = mintWorkspace(deps, 'Other GmbH', 'ws-other');
  call(deps, other, 'vat_seed_defaults', {});
  call(deps, other, 'set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  assert.deepEqual(call(deps, other, 'vat_settlement_list', {}).settlements, []);
  const p = call(deps, other, 'vat_settlement_preview', { period: '2026-Q1' });
  assert.equal(p.ok, true);
  assert.equal(p.outputMinor, 0, 'the other tenant sees none of the first tenant\'s movement');
  const r = call(deps, other, 'vat_settlement_reverse', { settlementId: posted.settlementId, idempotencyKey: 'x' });
  assert.equal(r.error, 'not_found');
  assert.equal(deps.store.db.prepare('SELECT status FROM vat_settlement WHERE id = ?').get(posted.settlementId).status, 'posted');
});

// --- the Saldo branch (Q3) ------------------------------------------------------------------------

test('Saldo (Q3): the flat-rate tax due lands on 2201 against 3809, 2200 is emptied, no Vorsteuer legs; missing 3809 is missing_account', () => {
  const world = setup({ method: 'saldo', timing: 'soll', saldoRates: [{ rateBp: 620 }] });
  const ctx = makeContext(world.store, { workspaceId: world.workspaceId, actor: 'user_1', clock: world.clock, ids: world.ids, ...ledgerPorts({ store: world.store, workspaceId: world.workspaceId, ids: world.ids }) });
  const acc = (number) => ctx.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ctx.workspaceId, number).id;
  // A net-booked Saldo sale: the invoiced 8.1% sits on 2200, the return owes 6.2% of the gross.
  const lines = buildVatLines(ctx, { counterAccount: acc('1100'), revenueOrExpenseAccount: acc('3200'), amountMinor: 1_000_000, amountIsGross: false, taxCode: 'UST81', direction: 'output', supplyDate: '2026-03-15' });
  assert.equal(postEntry(ctx, { date: '2026-03-15', source: 'manual', idempotencyKey: 's-sale', lines }).ok, true);
  assert.equal(markVatPeriodFiled(ctx, { period: '2026-H1', idempotencyKey: 's-file' }).ok, true);

  // The KMU seed ships 3809 since A38 (N2, `kmuSeed.ts`, and the generation-7 top-up for older
  // workspaces), so a chart WITHOUT it is simulated by renumbering the seeded account: the refusal
  // names the number, and the same chart with the account back settles.
  const renumber = ctx.store.db.prepare('UPDATE account SET number = ? WHERE workspace_id = ? AND number = ?');
  renumber.run('3809-absent', ctx.workspaceId, '3809');
  const missing = settlementModelOf(ctx, '2026-H1');
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'missing_account');
  assert.equal(missing.number, '3809');
  renumber.run('3809', ctx.workspaceId, '3809-absent');

  const model = settlementModelOf(ctx, '2026-H1');
  assert.equal(model.ok, true, JSON.stringify(model));
  assert.equal(model.method, 'saldo');
  assert.equal(model.outputMinor, 81_000, 'the invoiced tax on 2200');
  assert.equal(model.inputMinor, 0, 'no Vorsteuer under Art. 37');
  const taxDue = model.declared.outputMinor;
  assert.equal(taxDue, Math.round(1_081_000 * 0.062), 'Ziffer 399 is 6.2% of the gross');
  assert.equal(model.netMinor, taxDue);
  assert.deepEqual(
    model.lines.map((l) => [l.role, l.accountNumber, l.debitMinor, l.creditMinor]),
    [
      ['output', '2200', 81_000, 0],
      ['saldo_difference', '3809', 0, 81_000 - taxDue],
      ['output', '2201', 0, taxDue],
    ],
  );
  const posted = vatSettlementPost(ctx, { period: '2026-H1', idempotencyKey: 's-post' });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  const bal = (number) => ctx.store.db.prepare(`SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net FROM journal_line l JOIN account a ON a.id = l.account_id WHERE a.workspace_id = ? AND a.number = ?`).get(ctx.workspaceId, number).net;
  assert.equal(bal('2200'), 0);
  assert.equal(bal('2201'), -taxDue);
  assert.equal(bal('3809'), -(81_000 - taxDue), 'the Saldo income effect is a credit on 3809');
  const rev = vatSettlementReverse(ctx, { settlementId: posted.settlementId, idempotencyKey: 's-rev' });
  assert.equal(rev.ok, true, JSON.stringify(rev));
  assert.equal(bal('2200'), -81_000);
  assert.equal(bal('3809'), 0);
});

test('a NEGATIVE quarter (more credit notes than sales) flips the sides: Cr 2200 / Dr 2201', () => {
  const deps = freshDeps();
  const { workspaceId: ws, accId } = effektivWorld(deps);
  // A credit note-shaped manual entry: revenue reversed with its tax, so 2200 is left in DEBIT.
  const r = call(deps, ws, 'post_entry', {
    date: '2026-02-10',
    source: 'manual',
    description: 'Gutschrift',
    idempotencyKey: 'neg-1',
    lines: [
      { account: accId('3200'), debit: 100_000, taxCode: 'UST81' },
      { account: accId('2200'), debit: 8_100 },
      { account: accId('1100'), credit: 108_100 },
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(call(deps, ws, 'vat_mark_filed', { period: '2026-Q1', idempotencyKey: 'neg-file' }).ok, true);
  const p = call(deps, ws, 'vat_settlement_preview', { period: '2026-Q1' });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.outputMinor, -8_100);
  assert.equal(p.netMinor, -8_100);
  assert.deepEqual(
    p.lines.map((l) => [l.accountNumber, l.debitMinor, l.creditMinor]),
    [['2200', 0, 8_100], ['2201', 8_100, 0]],
  );
  const posted = call(deps, ws, 'vat_settlement_post', { period: '2026-Q1', idempotencyKey: 'neg-post' });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  assert.equal(balance(deps, ws, '2200'), 0);
  assert.equal(balance(deps, ws, '2201'), 8_100, 'a Vorsteuer-style surplus is a debit (a claim) on 2201');
});

test('a spent key: post with K, reverse, post with K again is already_reversed_key (never a silent ok), and a NEW key books a NEW settlement', () => {
  const deps = freshDeps();
  const { ws } = nomadikYear(deps);
  const first = call(deps, ws, 'vat_settlement_post', { period: '2026-Q4', idempotencyKey: 'spent-K' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const reversed = call(deps, ws, 'vat_settlement_reverse', { settlementId: first.settlementId, idempotencyKey: 'spent-rev' });
  assert.equal(reversed.ok, true, JSON.stringify(reversed));
  const entriesBefore = entryCount(deps, ws);

  // The Studio panel's exact replay after a reversal (its key was period-derived and the reversed row
  // no longer shows in the model): the memo names a settlement that is gone, so it must not answer ok.
  const replay = call(deps, ws, 'vat_settlement_post', { period: '2026-Q4', idempotencyKey: 'spent-K' });
  assert.equal(replay.ok, false, `a spent key must not replay a reversed post as success: ${JSON.stringify(replay)}`);
  assert.equal(replay.error, 'already_reversed_key');
  assert.equal(replay.settlementId, first.settlementId);
  assert.equal(replay.reversalEntryId, reversed.reversalEntryId);
  assert.equal(replay.idempotencyKey, 'spent-K');
  assert.equal(entryCount(deps, ws), entriesBefore, 'the refusal writes nothing');
  assert.equal(call(deps, ws, 'vat_settlement_preview', { period: '2026-Q4' }).settlement, null, 'the ledger still shows no settlement');

  // A fresh key is a fresh act: a NEW entry, a NEW row, and the ledger shows the settlement again.
  const second = call(deps, ws, 'vat_settlement_post', { period: '2026-Q4', idempotencyKey: 'spent-K2' });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.notEqual(second.settlementId, first.settlementId);
  assert.notEqual(second.entryId, first.entryId);
  assert.equal(entryCount(deps, ws), entriesBefore + 1);
  const shown = call(deps, ws, 'vat_settlement_preview', { period: '2026-Q4' });
  assert.equal(shown.settlement.settlementId, second.settlementId);
  assert.equal(shown.settlement.status, 'posted');
  // And the new key replays byte-identically while ITS settlement stands.
  assert.equal(JSON.stringify(call(deps, ws, 'vat_settlement_post', { period: '2026-Q4', idempotencyKey: 'spent-K2' })), JSON.stringify(second));
});

test('Saldo with booked Vorsteuer: refused saldo_input_vat_booked naming the balance (never netted into 2201); once the book is corrected the posting is Dr 2200 / Cr 3809 / Cr 2201 and 1170 is untouched', () => {
  const world = setup({ method: 'saldo', timing: 'soll', saldoRates: [{ rateBp: 620 }] });
  const ctx = makeContext(world.store, { workspaceId: world.workspaceId, actor: 'user_1', clock: world.clock, ids: world.ids, ...ledgerPorts({ store: world.store, workspaceId: world.workspaceId, ids: world.ids }) });
  const acc = (number) => ctx.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ctx.workspaceId, number).id;
  const bal = (number) => ctx.store.db.prepare(`SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id WHERE e.workspace_id = ? AND e.status = 'posted' AND a.number = ?`).get(ctx.workspaceId, number).net;
  // 3809 ships with the KMU seed since A38 (N2); nothing to create.
  assert.notEqual(acc('3809'), undefined, 'the seed ships 3809');
  // The critic's repro: a net-booked sale of 1'000'000 (2200 carries 81'000) and a purchase that
  // booked Vorsteuer the flat rate never deducts (Dr 1170 40'500), both inside H1. The purchase is
  // UNTAGGED: a `VST-M` line under Saldo is already refused by the ledger's own reconcile
  // (`vat_trace_unreconciled`, expected 0 on 1170), while an entry with no tagged line skips the
  // reconcile entirely, so this is the shape a Saldo book really admits.
  const sale = buildVatLines(ctx, { counterAccount: acc('1100'), revenueOrExpenseAccount: acc('3200'), amountMinor: 1_000_000, amountIsGross: false, taxCode: 'UST81', direction: 'output', supplyDate: '2026-03-15' });
  assert.equal(postEntry(ctx, { date: '2026-03-15', source: 'manual', idempotencyKey: 'sv-sale', lines: sale }).ok, true);
  const purchase = postEntry(ctx, {
    date: '2026-03-20',
    source: 'manual',
    idempotencyKey: 'sv-purchase',
    lines: [{ account: acc('4000'), debit: 500_000 }, { account: acc('1170'), debit: 40_500 }, { account: acc('2000'), credit: 540_500 }],
  });
  assert.equal(purchase.ok, true, JSON.stringify(purchase));
  assert.equal(markVatPeriodFiled(ctx, { period: '2026-H1', idempotencyKey: 'sv-file' }).ok, true);
  const taxDue = Math.round(1_081_000 * 0.062);
  assert.equal(computeVatReturn(ctx, { periodStart: '2026-01-01', periodEnd: '2026-06-30' }).totalTaxDueMinor, taxDue, 'the return owes 67\'022 and deducts nothing');

  // Refused by name, on preview and on post, nothing written. The old engine netted 1170 into 2201
  // and left 2201 at 26'522 against a return owing 67'022.
  const refused = settlementModelOf(ctx, '2026-H1');
  assert.equal(refused.ok, false, `a Saldo book with a 1170 balance must be refused, not settled: ${JSON.stringify(refused)}`);
  assert.equal(refused.error, 'saldo_input_vat_booked');
  assert.deepEqual(refused.balance, { 1170: 40_500, 1171: 0 });
  assert.equal(refused.totalMinor, 40_500);
  assert.equal(refused.period, '2026-H1');
  const entries = () => ctx.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(ctx.workspaceId).n;
  const before = entries();
  const post = vatSettlementPost(ctx, { period: '2026-H1', idempotencyKey: 'sv-post' });
  assert.equal(post.error, 'saldo_input_vat_booked');
  assert.equal(entries(), before);
  assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM vat_settlement WHERE workspace_id = ?').get(ctx.workspaceId).n, 0);

  // The human corrects the book: the purchase is reversed in the OPEN period (H1 is filed and locked),
  // which a period-bounded balance read would never have seen.
  const fixed = reverseEntry(ctx, { entryId: purchase.entryId, date: '2026-08-01', idempotencyKey: 'sv-fix' });
  assert.equal(fixed.ok, true, JSON.stringify(fixed));
  assert.equal(bal('1170'), 0);
  const model = settlementModelOf(ctx, '2026-H1');
  assert.equal(model.ok, true, JSON.stringify(model));
  assert.equal(model.inputMinor, 0, 'no Vorsteuer figure under Saldo');
  assert.equal(model.netMinor, taxDue, '2201 takes exactly what the return owes');
  assert.deepEqual(
    model.lines.map((l) => [l.role, l.accountNumber, l.debitMinor, l.creditMinor]),
    [
      ['output', '2200', 81_000, 0],
      ['saldo_difference', '3809', 0, 81_000 - taxDue],
      ['output', '2201', 0, taxDue],
    ],
    'the owner-confirmed shape (2026-09-09): 2200 emptied, 3809 takes the difference, no 1170 leg',
  );
  const posted = vatSettlementPost(ctx, { period: '2026-H1', idempotencyKey: 'sv-post-2' });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  assert.equal(bal('2200'), 0);
  assert.equal(bal('2201'), -taxDue);
  assert.equal(bal('3809'), -(81_000 - taxDue), '3809 carries a credit when 2200 exceeds the flat-rate due');
  assert.equal(bal('1170'), 0, 'the settlement never touched 1170');
  // With the settlement standing, a LATER stray 1170 debit does not hide the posted state from the preview.
  assert.equal(postEntry(ctx, { date: '2026-09-01', source: 'manual', idempotencyKey: 'sv-stray', lines: [{ account: acc('4000'), debit: 1_000 }, { account: acc('1170'), debit: 81 }, { account: acc('2000'), credit: 1_081 }] }).ok, true);
  const standing = settlementModelOf(ctx, '2026-H1');
  assert.equal(standing.ok, true, JSON.stringify(standing));
  assert.equal(standing.settlement.settlementId, posted.settlementId);
});

// --- the 1170 / 1171 gate is bounded by the period it protects (critic finding, 2026-09-10) ----------

/** A Saldo book with one net-booked sale in 2026-H2 and both half-years filed, plus a ctx and helpers. */
function saldoH2World() {
  const world = setup({ method: 'saldo', timing: 'soll', saldoRates: [{ rateBp: 620 }] });
  const ctx = makeContext(world.store, { workspaceId: world.workspaceId, actor: 'user_1', clock: world.clock, ids: world.ids, ...ledgerPorts({ store: world.store, workspaceId: world.workspaceId, ids: world.ids }) });
  const acc = (number) => ctx.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ctx.workspaceId, number).id;
  const bal = (number) => ctx.store.db.prepare(`SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id WHERE e.workspace_id = ? AND e.status = 'posted' AND a.number = ?`).get(ctx.workspaceId, number).net;
  const sale = buildVatLines(ctx, { counterAccount: acc('1100'), revenueOrExpenseAccount: acc('3200'), amountMinor: 1_000_000, amountIsGross: false, taxCode: 'UST81', direction: 'output', supplyDate: '2026-09-15' });
  assert.equal(postEntry(ctx, { date: '2026-09-15', source: 'manual', idempotencyKey: 'ms-sale', lines: sale }).ok, true);
  return { ctx, acc, bal };
}

/** The lawful Art. 37 Abs. 4 switch to effektiv from 01.01.2027, after 2026-H2 is filed. */
function switchToEffektiv(ctx) {
  const switched = configureVat(ctx, {
    method: 'effektiv',
    timing: 'soll',
    registered: true,
    asOf: '2027-01-01',
    methodChange: { validFrom: '2027-01-01' },
    idempotencyKey: 'ms-switch',
  });
  assert.equal(switched.ok, true, JSON.stringify(switched));
}

/** One ordinary, deductible effektiv purchase in January 2027: Dr 4000 500'000 / Dr 1170 40'500 / Cr 2000. */
function januaryPurchase(ctx, acc) {
  const lines = buildVatLines(ctx, { counterAccount: acc('2000'), revenueOrExpenseAccount: acc('4000'), amountMinor: 500_000, amountIsGross: false, taxCode: 'VST-M', direction: 'input', supplyDate: '2027-01-15' });
  const purchase = postEntry(ctx, { date: '2027-01-15', source: 'manual', idempotencyKey: 'ms-jan', lines });
  assert.equal(purchase.ok, true, JSON.stringify(purchase));
  return purchase;
}

test('a Saldo period settles after the method switch: a legitimate effektiv 1170 debit in January 2027 does not block 2026-H2 (Dr 2200 / Cr 3809 / Cr 2201, the January leg untouched)', () => {
  const { ctx, acc, bal } = saldoH2World();
  assert.equal(markVatPeriodFiled(ctx, { period: '2026-H1', idempotencyKey: 'ms-file-h1' }).ok, true);
  assert.equal(markVatPeriodFiled(ctx, { period: '2026-H2', idempotencyKey: 'ms-file-h2' }).ok, true);
  const before = settlementModelOf(ctx, '2026-H2');
  assert.equal(before.ok, true, JSON.stringify(before));

  switchToEffektiv(ctx);
  januaryPurchase(ctx, acc);
  assert.equal(bal('1170'), 40_500, 'the January Vorsteuer is real and deductible under effektiv');

  // The critic's repro (2026-09-10): the old engine summed 1170 over the WHOLE book and refused
  // `saldo_input_vat_booked` here, telling the human to reverse a correct January entry. In a live
  // effektiv book 1170 is never zero, so the last Saldo period was practically unsettleable.
  const taxDue = Math.round(1_081_000 * 0.062);
  const model = settlementModelOf(ctx, '2026-H2');
  assert.equal(model.ok, true, `a 1170 balance booked AFTER the period must not block it: ${JSON.stringify(model)}`);
  assert.equal(model.method, 'saldo', 'the method that governed the period');
  assert.deepEqual(
    model.lines.map((l) => [l.role, l.accountNumber, l.debitMinor, l.creditMinor]),
    [
      ['output', '2200', 81_000, 0],
      ['saldo_difference', '3809', 0, 81_000 - taxDue],
      ['output', '2201', 0, taxDue],
    ],
  );
  const posted = vatSettlementPost(ctx, { period: '2026-H2', idempotencyKey: 'ms-post' });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  assert.equal(bal('2200'), 0);
  assert.equal(bal('2201'), -taxDue);
  assert.equal(bal('3809'), -(81_000 - taxDue));
  assert.equal(bal('1170'), 40_500, 'the January 1170 leg is untouched');
});

test('a stray 1170 debit dated INSIDE the Saldo period still refuses by name, and the balance it names is the period\'s alone', () => {
  const { ctx, acc, bal } = saldoH2World();
  // The untagged shape a Saldo book really admits (no tagged line, so no VAT reconcile).
  const stray = postEntry(ctx, { date: '2026-10-01', source: 'manual', idempotencyKey: 'ms-stray', lines: [{ account: acc('4000'), debit: 1_000 }, { account: acc('1170'), debit: 81 }, { account: acc('2000'), credit: 1_081 }] });
  assert.equal(stray.ok, true, JSON.stringify(stray));
  assert.equal(markVatPeriodFiled(ctx, { period: '2026-H1', idempotencyKey: 'ms-file-h1b' }).ok, true);
  assert.equal(markVatPeriodFiled(ctx, { period: '2026-H2', idempotencyKey: 'ms-file-h2b' }).ok, true);
  switchToEffektiv(ctx);
  januaryPurchase(ctx, acc);
  assert.equal(bal('1170'), 40_581);

  const refused = settlementModelOf(ctx, '2026-H2');
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.error, 'saldo_input_vat_booked');
  assert.deepEqual(refused.balance, { 1170: 81, 1171: 0 }, 'the stray inside the period, not the January Vorsteuer after it');
  assert.equal(refused.totalMinor, 81);
  const post = vatSettlementPost(ctx, { period: '2026-H2', idempotencyKey: 'ms-post-b' });
  assert.equal(post.error, 'saldo_input_vat_booked');

  // Corrected the only way a filed period can be: a reversal dated in the open period. The read
  // follows the reversal to the entry it undoes, so the correction clears the gate.
  assert.equal(reverseEntry(ctx, { entryId: stray.entryId, date: '2027-02-01', idempotencyKey: 'ms-stray-fix' }).ok, true);
  const model = settlementModelOf(ctx, '2026-H2');
  assert.equal(model.ok, true, JSON.stringify(model));
  assert.equal(bal('1170'), 40_500, 'only the stray was undone');
});
