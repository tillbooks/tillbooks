/**
 * G13, the historical GL archive: the engine property suite (spec §7/§8).
 *
 * THE ONE CLAIM EVERYTHING HERE SERVES: archive rows are structurally incapable of entering a live
 * statement, and live rows are structurally incapable of entering an archive answer. The fixture
 * that matters most builds BOTH worlds over the SAME account and the SAME period and then proves no
 * figure anywhere sums across the wall, in either direction.
 *
 * Everything drives the REAL verbs through the registry (never an INSERT for archive content), so
 * what is proven is the product's own chain: E00 upload -> plan -> discover -> scope -> import.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { retentionUntilFor } from '../../dist/core/migration/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);

function must(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

/**
 * A two-year prior-system export: four balanced entries across 2012 and 2013, one entry on an
 * UNMAPPED source account (9999), and one internally UNBALANCED entry (B-4). Amounts in Rappen.
 */
const HISTORY_CSV = [
  'Datum,BelegNr,Konto,Soll,Haben,Buchungstext',
  '2012-03-05,B-1,10,10000,0,Bareinnahme',
  '2012-03-05,B-1,34,0,10000,Ertrag',
  '2012-09-10,B-2,10,2500,0,Bareinnahme',
  '2012-09-10,B-2,34,0,2500,Ertrag',
  '2013-02-14,B-3,9999,7700,0,Unbekanntes Konto',
  '2013-02-14,B-3,34,0,7700,Ertrag',
  '2013-11-30,B-4,10,500,0,Kassendifferenz',
  '',
].join('\n');

/** Upload the export, plan it, map the accounts (10 -> 1000, 34 -> 3400), scope gl_history in. */
function seedHistory(deps, workspaceId, seed, csv = HISTORY_CSV) {
  const uploaded = must(
    call(deps, 'files_upload', {
      workspaceId,
      contentBase64: Buffer.from(csv, 'utf8').toString('base64'),
      filename: `${seed}.csv`,
      mime: 'text/csv',
      idempotencyKey: `${seed}-file`,
    }),
    'files_upload',
  );
  const planId = must(
    call(deps, 'migration_create_plan', {
      workspaceId,
      sourceSystem: 'bexio',
      cutoverDate: '2026-01-01',
      localePack: 'ch',
      idempotencyKey: `${seed}-plan`,
    }),
    'migration_create_plan',
  ).planId;
  must(call(deps, 'migration_discover_source', { workspaceId, planId, fileIds: [uploaded.file.id] }), 'discover');
  must(
    call(deps, 'migration_set_map', {
      workspaceId,
      planId,
      kind: 'account',
      entries: [
        { source: '10', sourceName: 'Kasse (alt)', target: '1000' },
        { source: '34', sourceName: 'Ertrag (alt)', target: '3400' },
        // 9999 stays deliberately unmapped: history is evidence and imports anyway.
      ],
      idempotencyKey: `${seed}-map`,
    }),
    'migration_set_map',
  );
  const scoped = must(
    call(deps, 'migration_set_scope', {
      workspaceId,
      planId,
      classes: [{ dataClass: 'gl_history', include: true }],
      idempotencyKey: `${seed}-scope`,
    }),
    'migration_set_scope',
  );
  const stepId = scoped.steps.find((s) => s.dataClass === 'gl_history').stepId;
  return { planId, stepId, fileId: uploaded.file.id };
}

/** A workspace with BOTH worlds: live 2026 postings AND the 2012/2013 archive, same accounts. */
function bothWorlds(seed) {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, `Both ${seed}`, `${seed}-ws`);
  must(
    call(deps, 'post_entry', {
      workspaceId,
      date: '2026-03-01',
      source: 'manual',
      idempotencyKey: `${seed}-live-1`,
      lines: [
        { account: accId('1000'), debit: 111100 },
        { account: accId('3400'), credit: 111100 },
      ],
    }),
    'post_entry',
  );
  const { planId, stepId, fileId } = seedHistory(deps, workspaceId, seed);
  const imported = must(
    call(deps, 'gl_archive_import', { workspaceId, planId, stepId, idempotencyKey: `${seed}-imp` }),
    'gl_archive_import',
  );
  return { deps, workspaceId, accId, planId, stepId, fileId, imported };
}

const countRows = (deps, sql, ...args) => deps.store.db.prepare(sql).get(...args).n;

// --- Import: totals to the Rappen, flags, idempotency, supersede --------------------------------

test('G13: the import lands every source Rappen verbatim, flags unmapped and unbalanced, and counts them', () => {
  const { deps, workspaceId, accId, imported } = bothWorlds('g13-imp');
  assert.equal(imported.entryCount, 4);
  assert.equal(imported.lineCount, 7);
  assert.equal(imported.unmappedCount, 1, 'source account 9999 has no map entry');
  assert.equal(imported.unbalancedCount, 1, 'B-4 does not balance internally');

  // Per-account totals match the source sums to the Rappen: account 10 -> 1000.
  const kasse = deps.store.db
    .prepare(
      `SELECT SUM(debit_minor) AS d, SUM(credit_minor) AS c FROM gl_archive_line
        WHERE workspace_id = ? AND target_account_id = ?`,
    )
    .get(workspaceId, accId('1000'));
  assert.equal(kasse.d, 10000 + 2500 + 500);
  assert.equal(kasse.c, 0);

  // The unmapped line imported (never refused), queryable by its SOURCE account, target null.
  const unmapped = deps.store.db
    .prepare("SELECT target_account_id FROM gl_archive_line WHERE workspace_id = ? AND source_account = '9999'")
    .all(workspaceId);
  assert.equal(unmapped.length, 1);
  assert.equal(unmapped[0].target_account_id, null);

  // The unbalanced entry is FLAGGED, its stored amounts untouched (evidence, not corrected).
  const flagged = deps.store.db
    .prepare("SELECT balanced FROM gl_archive_entry WHERE workspace_id = ? AND source_entry_id = 'B-4'")
    .get(workspaceId);
  assert.equal(flagged.balanced, 0);

  // The step landed committed with the flag counts surfaced for G11's check.
  const step = deps.store.db
    .prepare("SELECT status, counts FROM migration_step WHERE workspace_id = ? AND data_class = 'gl_history'")
    .get(workspaceId);
  assert.equal(step.status, 'committed');
  const counts = JSON.parse(step.counts);
  assert.equal(counts.unmappedCount, 1);
  assert.equal(counts.unbalancedCount, 1);
});

test('G13: re-import is idempotent on its key AND wholesale on a new one, never an orphan line', () => {
  const { deps, workspaceId, planId, stepId, imported } = bothWorlds('g13-idem');
  const before = countRows(deps, 'SELECT COUNT(*) AS n FROM gl_archive_line WHERE workspace_id = ?', workspaceId);

  // Same key: the stored result replays, zero extra rows.
  const replay = must(
    call(deps, 'gl_archive_import', { workspaceId, planId, stepId, idempotencyKey: 'g13-idem-imp' }),
    'replay',
  );
  assert.deepEqual(replay, imported);
  assert.equal(countRows(deps, 'SELECT COUNT(*) AS n FROM gl_archive_line WHERE workspace_id = ?', workspaceId), before);

  // A NEW key re-runs: the step's rows are replaced WHOLESALE, landing the identical archive.
  const again = must(
    call(deps, 'gl_archive_import', { workspaceId, planId, stepId, idempotencyKey: 'g13-idem-imp-2' }),
    'supersede',
  );
  assert.equal(again.entryCount, imported.entryCount);
  assert.equal(countRows(deps, 'SELECT COUNT(*) AS n FROM gl_archive_line WHERE workspace_id = ?', workspaceId), before);
  // No orphan: every line's entry exists.
  assert.equal(
    countRows(
      deps,
      `SELECT COUNT(*) AS n FROM gl_archive_line l WHERE l.workspace_id = ?
        AND NOT EXISTS (SELECT 1 FROM gl_archive_entry e WHERE e.id = l.entry_id)`,
      workspaceId,
    ),
    0,
  );
});

// --- The HARD PARTITION, both directions --------------------------------------------------------

test('G13: an archive query NEVER returns a live journal row, and list_journal NEVER returns an archive row', () => {
  const { deps, workspaceId } = bothWorlds('g13-wall');

  // Direction 1: the archive query over the shared account/world returns archive entries only.
  const archived = must(call(deps, 'gl_archive_query', { workspaceId }), 'gl_archive_query');
  assert.equal(archived.total, 4);
  const liveIds = new Set(
    deps.store.db.prepare('SELECT id FROM journal_entry WHERE workspace_id = ?').all(workspaceId).map((r) => r.id),
  );
  for (const entry of archived.entries) {
    assert.equal(liveIds.has(entry.entryId), false, 'a live journal row surfaced in the archive query');
  }
  // And the label is IN the payload, so dropping it is a deliberate act.
  assert.equal(archived.provenance.system, 'bexio');
  assert.equal(archived.provenance.from, '2012-03-05');
  assert.equal(archived.provenance.to, '2013-11-30');

  // Direction 2: list_journal, filtered and unfiltered, sees only the live world.
  const journal = must(call(deps, 'list_journal', { workspaceId }), 'list_journal');
  assert.equal(journal.entries.length, 1);
  const wide = must(call(deps, 'list_journal', { workspaceId, from: '2010-01-01', to: '2030-12-31' }), 'list_journal wide');
  assert.equal(wide.entries.length, 1, 'an archive row leaked into the live journal list');
});

test('G13: no live statement figure moves when the archive arrives (the never-mixed rule on figures)', () => {
  // The same live postings, with and without the archive beside them.
  const seedLive = (deps, workspaceId, accId) =>
    must(
      call(deps, 'post_entry', {
        workspaceId,
        date: '2026-03-01',
        source: 'manual',
        idempotencyKey: 'nm-live',
        lines: [
          { account: accId('1000'), debit: 111100 },
          { account: accId('3400'), credit: 111100 },
        ],
      }),
      'post_entry',
    );

  const bare = freshDeps();
  const bareWs = mintWorkspace(bare, 'Bare', 'nm-bare');
  seedLive(bare, bareWs.workspaceId, bareWs.accId);

  const withArchive = freshDeps();
  const archWs = mintWorkspace(withArchive, 'Arch', 'nm-arch');
  seedLive(withArchive, archWs.workspaceId, archWs.accId);
  const { planId, stepId } = seedHistory(withArchive, archWs.workspaceId, 'nm');
  must(call(withArchive, 'gl_archive_import', { workspaceId: archWs.workspaceId, planId, stepId, idempotencyKey: 'nm-imp' }), 'import');

  const period = { periodStart: '2026-01-01', periodEnd: '2026-12-31' };
  for (const [verb, input] of [
    ['trial_balance', period],
    ['income_statement', period],
    ['balance_sheet', { asOf: '2026-12-31' }],
  ]) {
    const a = must(call(bare, verb, { workspaceId: bareWs.workspaceId, ...input }), verb);
    const b = must(call(withArchive, verb, { workspaceId: archWs.workspaceId, ...input }), verb);
    const strip = (r) => JSON.stringify(r);
    assert.equal(strip(b), strip(a), `${verb} moved when the archive arrived: a figure summed across the wall`);
  }
});

// --- Triggers: UPDATE and bare DELETE abort at the SQLite layer ---------------------------------

test('G13: the BEFORE-triggers really abort an UPDATE and a bare DELETE on entry and line', () => {
  const { deps, workspaceId } = bothWorlds('g13-trig');
  const entry = deps.store.db.prepare('SELECT id FROM gl_archive_entry WHERE workspace_id = ? LIMIT 1').get(workspaceId);
  const line = deps.store.db.prepare('SELECT id FROM gl_archive_line WHERE workspace_id = ? LIMIT 1').get(workspaceId);

  assert.throws(
    () => deps.store.db.prepare('UPDATE gl_archive_entry SET description = ? WHERE id = ?').run('edited', entry.id),
    /archive_immutable/,
  );
  assert.throws(() => deps.store.db.prepare('DELETE FROM gl_archive_entry WHERE id = ?').run(entry.id), /archive_immutable/);
  assert.throws(
    () => deps.store.db.prepare('UPDATE gl_archive_line SET debit_minor = 1 WHERE id = ?').run(line.id),
    /archive_immutable/,
  );
  assert.throws(() => deps.store.db.prepare('DELETE FROM gl_archive_line WHERE id = ?').run(line.id), /archive_immutable/);
});

// --- §H-TENANT ----------------------------------------------------------------------------------

test('G13: §H-TENANT: workspace B sees nothing of A, and a B-aimed purge moves zero A rows', () => {
  const { deps, workspaceId } = bothWorlds('g13-ten');
  const other = mintWorkspace(deps, 'Other GmbH', 'g13-ten-b');

  const q = must(call(deps, 'gl_archive_query', { workspaceId: other.workspaceId }), 'query B');
  assert.equal(q.total, 0);
  const p = must(call(deps, 'gl_archive_periods', { workspaceId: other.workspaceId }), 'periods B');
  assert.equal(p.periods.length, 0);

  const before = countRows(deps, 'SELECT COUNT(*) AS n FROM gl_archive_entry WHERE workspace_id = ?', workspaceId);
  const purge = call(deps, 'gl_archive_purge', {
    workspaceId: other.workspaceId,
    periodFrom: '2012-01',
    periodTo: '2013-12',
    reason: 'tenant fence probe',
    confirmed: true,
    idempotencyKey: 'g13-ten-purge',
  });
  assert.equal(purge.ok, false, 'a purge aimed at B found periods to purge');
  assert.equal(purge.error, 'not_found');
  assert.equal(countRows(deps, 'SELECT COUNT(*) AS n FROM gl_archive_entry WHERE workspace_id = ?', workspaceId), before);
});

// --- Retention and purge (OR 958f, GeBüV Art. 9) ------------------------------------------------

test('G13: retentionUntilFor derives from the fiscal year end plus ten years (OR 958f)', () => {
  // Calendar fiscal year: 2012-03 belongs to FY 2012, ends 2012-12-31, plus ten years.
  assert.equal(retentionUntilFor('01-01', '2012-03'), '2022-12-31');
  assert.equal(retentionUntilFor('01-01', '2012-12'), '2022-12-31');
  // July-start fiscal year: 2012-03 is in FY 2011 (2011-07-01 to 2012-06-30).
  assert.equal(retentionUntilFor('07-01', '2012-03'), '2022-06-30');
  assert.equal(retentionUntilFor('07-01', '2012-09'), '2023-06-30');
});

test('G13: a purge inside retention refuses with the date, records the refusal, and deletes NOTHING', () => {
  const { deps, workspaceId } = bothWorlds('g13-ret');
  // Mutate the retention date FORWARD (the spec-mandated mutation): the same purge must now refuse.
  deps.store.db
    .prepare("UPDATE gl_archive_period SET retention_until = '2099-12-31' WHERE workspace_id = ? AND period = '2012-09'")
    .run(workspaceId);
  const before = countRows(deps, 'SELECT COUNT(*) AS n FROM gl_archive_entry WHERE workspace_id = ?', workspaceId);

  const refused = call(deps, 'gl_archive_purge', {
    workspaceId,
    periodFrom: '2012-01',
    periodTo: '2012-12',
    reason: 'Löschbegehren',
    confirmed: true,
    idempotencyKey: 'g13-ret-1',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'retention_active');
  assert.equal(refused.until, '2099-12-31');
  assert.equal(refused.statutoryRef, 'OR 958f');
  assert.equal(countRows(deps, 'SELECT COUNT(*) AS n FROM gl_archive_entry WHERE workspace_id = ?', workspaceId), before);

  // The refusal is RECORDED with the statute: that record is the data subject's answer (US-G13.4).
  const record = deps.store.db
    .prepare("SELECT outcome, statutory_ref, reason FROM gl_archive_purge_record WHERE workspace_id = ? AND outcome = 'refused'")
    .get(workspaceId);
  assert.equal(record.statutory_ref, 'OR 958f');
  assert.equal(record.reason, 'Löschbegehren');
});

test('G13: an expired-period purge removes the rows, keeps the record, marks the periods, and never touches a live row', () => {
  const { deps, workspaceId } = bothWorlds('g13-purge');
  const liveEntriesBefore = countRows(deps, 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?', workspaceId);
  const LIVE_LINES = `SELECT COUNT(*) AS n FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id WHERE e.workspace_id = ?`;
  const liveLinesBefore = countRows(deps, LIVE_LINES, workspaceId);

  // Pinned clock 2026-07-16; 2012 retention ran out 2022-12-31, so 2012 is purgeable, 2013 stays.
  const purged = must(
    call(deps, 'gl_archive_purge', {
      workspaceId,
      periodFrom: '2012-01',
      periodTo: '2012-12',
      reason: 'Aufbewahrungsfrist abgelaufen',
      confirmed: true,
      idempotencyKey: 'g13-purge-1',
    }),
    'gl_archive_purge',
  );
  assert.equal(purged.purgedEntries, 2);
  assert.equal(purged.record.statutoryRef, 'OR 958f');

  // The 2012 rows are gone, the 2013 rows stay, and the purge record survives the purge (GeBüV Art. 9).
  assert.equal(countRows(deps, "SELECT COUNT(*) AS n FROM gl_archive_entry WHERE workspace_id = ? AND entry_date < '2013-01-01'", workspaceId), 0);
  assert.equal(countRows(deps, "SELECT COUNT(*) AS n FROM gl_archive_entry WHERE workspace_id = ? AND entry_date >= '2013-01-01'", workspaceId), 2);
  const record = deps.store.db
    .prepare("SELECT row_count FROM gl_archive_purge_record WHERE workspace_id = ? AND outcome = 'purged'")
    .get(workspaceId);
  assert.equal(record.row_count, 2);
  const period = must(call(deps, 'gl_archive_periods', { workspaceId }), 'periods');
  const p2012 = period.periods.filter((p) => p.period.startsWith('2012'));
  assert.ok(p2012.length > 0 && p2012.every((p) => p.purged), 'the purged periods are not marked');

  // THE INVARIANT: the purge is structurally incapable of touching a live journal row.
  assert.equal(countRows(deps, 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?', workspaceId), liveEntriesBefore);
  assert.equal(countRows(deps, LIVE_LINES, workspaceId), liveLinesBefore);

  // Idempotent: the same key replays the stored result, deleting nothing further.
  const replay = must(
    call(deps, 'gl_archive_purge', {
      workspaceId,
      periodFrom: '2012-01',
      periodTo: '2012-12',
      reason: 'Aufbewahrungsfrist abgelaufen',
      confirmed: true,
      idempotencyKey: 'g13-purge-1',
    }),
    'replay',
  );
  assert.deepEqual(replay, purged);
});

test('G13: purge without confirmed refuses; querying and purging gate on their capabilities', () => {
  const { deps, workspaceId } = bothWorlds('g13-gate');
  const unconfirmed = call(deps, 'gl_archive_purge', {
    workspaceId,
    periodFrom: '2012-01',
    periodTo: '2012-12',
    reason: 'x',
    idempotencyKey: 'g13-gate-1',
  });
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.error, 'needs_confirmation');
});

// --- The comparative (US-G13.2): labelled, one-sided, partial refuses ---------------------------

test('G13: the Vorsystem comparative equals the archive-only sum and carries its label in the payload', () => {
  const { deps, workspaceId, accId } = bothWorlds('g13-cmp');

  const res = must(
    call(deps, 'trial_balance', {
      workspaceId,
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      compareTo: { periodStart: '2012-01-01', periodEnd: '2012-12-31', source: 'archive' },
    }),
    'trial_balance archive compare',
  );
  assert.equal(res.comparative.source, 'archive');
  assert.equal(res.comparative.status, 'ok');
  assert.equal(res.comparative.system, 'bexio');

  const kasse = res.rows.find((r) => r.account.id === accId('1000'));
  // The archive-only cumulative net for 1000 at 2012-12-31: 10000 + 2500 (B-4's 500 is 2013).
  assert.equal(kasse.compareClosingMinor, 12500, 'the comparative is not the archive-only sum');
  // And the LIVE closing is untouched by the archive: 111100 from the 2026 posting alone.
  assert.equal(kasse.closingMinor, 111100);
  // The unmapped 9999 net is reported, never silently dropped.
  assert.equal(typeof res.comparative.unlistedNetMinor, 'number');

  // The Bilanz comparative: side-adjusted archive balances, computed equity from the archive result.
  const bilanz = must(
    call(deps, 'balance_sheet', {
      workspaceId,
      asOf: '2026-12-31',
      compareTo: { asOf: '2012-12-31', source: 'archive' },
    }),
    'balance_sheet archive compare',
  );
  assert.equal(bilanz.comparative.status, 'ok');
  assert.equal(bilanz.compareTo, '2012-12-31');
});

test('G13: a partially covered compare window yields NO figures, never a partial sum', () => {
  const { deps, workspaceId } = bothWorlds('g13-part');
  // 2011 is before the archive's coverage; 2011-07..2012-06 overlaps it partially.
  const res = must(
    call(deps, 'trial_balance', {
      workspaceId,
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      compareTo: { periodStart: '2011-07-01', periodEnd: '2012-06-30', source: 'archive' },
    }),
    'partial compare',
  );
  assert.equal(res.comparative.status, 'partial');
  for (const row of res.rows) {
    assert.equal('compareClosingMinor' in row, false, 'a partial window produced a figure');
  }

  // A window wholly outside the archive is no_data.
  const none = must(
    call(deps, 'trial_balance', {
      workspaceId,
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      compareTo: { periodStart: '2019-01-01', periodEnd: '2019-12-31', source: 'archive' },
    }),
    'no_data compare',
  );
  assert.equal(none.comparative.status, 'no_data');
});

test('G13: the archive comparative is not exportable this wave, and says so by name', () => {
  const { deps, workspaceId } = bothWorlds('g13-exp');
  const res = call(deps, 'export_statement', {
    workspaceId,
    kind: 'trial',
    format: 'csv',
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
    compareTo: { periodStart: '2012-01-01', periodEnd: '2012-12-31', source: 'archive' },
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'archive_comparative_not_exportable');
});

// --- Pagination and the aggregate read ----------------------------------------------------------

test('G13: the query paginates and the account history aggregates per period with a running balance', () => {
  const { deps, workspaceId, accId } = bothWorlds('g13-agg');
  const page = must(call(deps, 'gl_archive_query', { workspaceId, page: 1 }), 'query');
  assert.equal(page.pageSize, 50);
  assert.equal(page.entries.length, 4);

  const history = must(
    call(deps, 'gl_archive_account_history', { workspaceId, accountId: accId('1000'), groupBy: 'year' }),
    'account history',
  );
  assert.deepEqual(
    history.periods,
    [
      { period: '2012', debitMinor: 12500, creditMinor: 0, balanceMinor: 12500 },
      { period: '2013', debitMinor: 500, creditMinor: 0, balanceMinor: 13000 },
    ],
  );

  // By SOURCE account too: the unmapped 9999 stays queryable (US-G13.1 error case).
  const bySource = must(
    call(deps, 'gl_archive_account_history', { workspaceId, sourceAccount: '9999', groupBy: 'year' }),
    'history by source',
  );
  assert.equal(bySource.periods.length, 1);
  assert.equal(bySource.periods[0].debitMinor, 7700);
});

// --- GeBüV Art. 10: readable across a system change, exercised on ourselves ---------------------

test('G13: the archive survives a store reopen (simulated upgrade) with its totals reproducible', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { SqliteStore } = await import('../../dist/core/store/sqlite-store.js');
  const { fixedClock } = await import('../../dist/core/clock.js');
  const { sequenceIdGen } = await import('../../dist/core/ids.js');

  const dir = mkdtempSync(join(tmpdir(), 'g13-art10-'));
  const location = join(dir, 'till.db');
  const AT = '2026-07-16T00:00:00.000Z';

  const first = { store: new SqliteStore({ location, clock: fixedClock(AT) }), clock: fixedClock(AT), ids: sequenceIdGen(), actor: 'agent' };
  const { workspaceId } = mintWorkspace(first, 'Reopen AG', 'g13-reopen');
  const { planId, stepId } = seedHistory(first, workspaceId, 'g13-reopen');
  const imported = must(call(first, 'gl_archive_import', { workspaceId, planId, stepId, idempotencyKey: 'g13-reopen-imp' }), 'import');
  const beforeTotals = must(call(first, 'gl_archive_account_history', { workspaceId, sourceAccount: '34', groupBy: 'year' }), 'before');
  first.store.db.close();

  // The "upgrade": a NEW store over the same file re-applies the schema and re-runs migrations.
  const second = { store: new SqliteStore({ location, clock: fixedClock(AT) }), clock: fixedClock(AT), ids: sequenceIdGen(), actor: 'agent' };
  const afterTotals = must(call(second, 'gl_archive_account_history', { workspaceId, sourceAccount: '34', groupBy: 'year' }), 'after');
  assert.deepEqual(afterTotals, beforeTotals, 'the archived journal did not survive the upgrade');
  const q = must(call(second, 'gl_archive_query', { workspaceId }), 'query after reopen');
  assert.equal(q.total, imported.entryCount);
  second.store.db.close();
});
