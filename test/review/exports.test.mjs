/**
 * A25 US-A25.4, the filing exports: faithful copies, reconciled to the Rappen, idempotent to the
 * byte, and delegated rather than recomputed.
 *
 *  - `export_journal` foots (base debit == base credit == what the ledger holds), round-trips its
 *    stored values verbatim, and answers identical bytes twice.
 *  - `export_statements` is byte-identical to A08's own `export_statement` for each half, which is
 *    the "the file and the screen cannot disagree" claim made measurable.
 *  - `export_vat` carries exactly `vat_return`'s figures, and passes A07's rejections through.
 *  - An empty period is `ok` with a header-only file and a notice, never a failure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace, manualPost } from '../api/support.mjs';

function fixture(seed) {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Export AG', `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  return { deps, workspaceId, accId, call };
}

function decode(artifact) {
  return Buffer.from(artifact.base64, 'base64').toString('utf8');
}

test('A25: export_journal foots to the ledger and is idempotent to the byte', () => {
  const fx = fixture('xj');
  fx.call('post_entry', manualPost(fx.accId, 'xj-1', 5000));
  fx.call('post_entry', manualPost(fx.accId, 'xj-2', 7300));
  // A draft must never leak into a filing export.
  fx.call('save_draft', {
    date: '2026-03-05',
    lines: [
      { account: fx.accId('6500'), debit: 100 },
      { account: fx.accId('1000'), credit: 100 },
    ],
    idempotencyKey: 'xj-d',
  });

  const first = fx.call('export_journal', { period: '2026-03' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.entryCount, 2);
  assert.equal(first.lineCount, 4);
  assert.equal(first.baseDebitMinor, 12300);
  assert.equal(first.baseCreditMinor, 12300);
  assert.equal(first.artifact.reconciles, true);
  assert.equal(first.empty, false);

  const text = decode(first.artifact);
  const rows = text.trim().split('\n');
  // header + 4 line records + 1 total record.
  assert.equal(rows.length, 6);
  assert.ok(rows[0].startsWith('record_type,entry_id,date'));
  assert.ok(rows.slice(1, 5).every((r) => r.startsWith('line,')));
  const total = rows[5].split(',');
  assert.equal(total[0], 'total');
  assert.equal(Number(total[11]), 12300);
  assert.equal(Number(total[12]), 12300);
  // Locale-neutral: ISO dates and integer minor units, never a formatted franc amount.
  assert.match(rows[1], /,2026-03-01,/);
  assert.ok(!/['’]/.test(text), 'a locale-formatted amount leaked into the CSV');

  // The ledger agrees: the export's footing equals the stored base debits of the period.
  const stored = fx.deps.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor), 0) AS d FROM journal_line l
        JOIN journal_entry e ON e.id = l.entry_id
       WHERE e.workspace_id = ? AND e.status = 'posted' AND e.date >= '2026-03-01' AND e.date <= '2026-03-31'`,
    )
    .get(fx.workspaceId);
  assert.equal(first.baseDebitMinor, stored.d);

  // Same period, same bytes.
  const second = fx.call('export_journal', { period: '2026-03' });
  assert.equal(second.artifact.base64, first.artifact.base64);
});

test('A25: export_statements is byte-identical to export_statement per half', () => {
  const fx = fixture('xs');
  fx.call('post_entry', manualPost(fx.accId, 'xs-1', 9900));

  for (const format of ['csv', 'pdf']) {
    const pair = fx.call('export_statements', { period: '2026-03', format });
    assert.equal(pair.ok, true, JSON.stringify(pair));
    assert.equal(pair.artifacts.length, 2);
    const [balance, income] = pair.artifacts;

    const balanceDirect = fx.call('export_statement', { kind: 'balance', format, asOf: '2026-03-31' });
    const incomeDirect = fx.call('export_statement', {
      kind: 'income',
      format,
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
    });
    assert.equal(balance.base64, balanceDirect.artifact.base64, `Bilanz ${format} diverged from A08`);
    assert.equal(income.base64, incomeDirect.artifact.base64, `Erfolgsrechnung ${format} diverged from A08`);
  }

  const bad = fx.call('export_statements', { period: '2026-03', format: 'xlsx' });
  assert.equal(bad.error, 'invalid_input');
});

test('A25: export_vat carries exactly the vat_return figures and passes rejections through', () => {
  const fx = fixture('xv');
  // Unconfigured VAT: A07's rejection passes through unchanged, never a fabricated file.
  const unconfigured = fx.call('export_vat', { period: '2026-03' });
  assert.equal(unconfigured.ok, false);

  fx.call('vat_seed_defaults', {});
  const configured = fx.call('vat_configure', {
    method: 'effektiv',
    timing: 'soll',
    registered: true,
    idempotencyKey: 'xv-vc',
  });
  assert.equal(configured.ok, true, JSON.stringify(configured));
  fx.call('post_entry', manualPost(fx.accId, 'xv-1', 10810));

  const model = fx.call('vat_return', { periodStart: '2026-03-01', periodEnd: '2026-03-31' });
  assert.equal(model.ok, true, JSON.stringify(model));

  const exported = fx.call('export_vat', { period: '2026-03' });
  assert.equal(exported.ok, true, JSON.stringify(exported));
  assert.equal(exported.payableMinor, model.payableMinor);
  assert.equal(exported.creditMinor, model.creditMinor);

  const rows = decode(exported.artifact).trim().split('\n');
  // header + one row per vat_return line + the 500/510 totals.
  assert.equal(rows.length, 1 + model.lines.length + 2);
  const totalRow = rows.find((r) => r.startsWith('total,500,'));
  assert.ok(totalRow !== undefined);
  assert.equal(Number(totalRow.split(',').at(-1)), model.payableMinor);

  // Same period, same bytes.
  assert.equal(fx.call('export_vat', { period: '2026-03' }).artifact.base64, exported.artifact.base64);
});

test('A25: an empty period exports a header-only file with a notice, never a failure', () => {
  const fx = fixture('xe');
  const empty = fx.call('export_journal', { period: '2026-01' });
  assert.equal(empty.ok, true);
  assert.equal(empty.empty, true);
  assert.equal(empty.notice, 'empty_period');
  const rows = decode(empty.artifact).trim().split('\n');
  assert.equal(rows.length, 2); // header + footing total of zero
  assert.equal(empty.artifact.reconciles, true);
});

test('A25: an export refuses a malformed period and an unknown format', () => {
  const fx = fixture('xb');
  assert.equal(fx.call('export_journal', { period: '1. Quartal' }).error, 'invalid_period');
  assert.equal(fx.call('export_journal', { period: '2026-03', format: 'pdf' }).error, 'invalid_input');
  assert.equal(fx.call('export_vat', { period: '2026-03', format: 'pdf' }).error, 'invalid_input');
});
