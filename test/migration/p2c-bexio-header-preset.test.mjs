/**
 * F-09 (friction ledger, Phase 2), J1.4 ideal step 3: a CSV whose header line is the bexio
 * Saldenliste layout is classified as bexio, with the data class defaulted to opening balances.
 *
 * THE DEFECT THIS EXISTS FOR. The measurement dropped a bexio-shaped Saldenliste (Kontonummer /
 * Bezeichnung / Saldo) into the intake and the source list said "CSV (generisch)" with nine data
 * classes on offer, so the operator picked the class by hand: a decision the adapter preset was
 * meant to default (G18 US-G18.1). Every fixture here is SYNTHETIC (invented figures, the documented
 * header layout); never the owner's file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { detectAdapterFromHeaders, SOURCE_ADAPTERS } from '../../dist/core/migration/adapters/registry.js';
import { normalizeToken } from '../../dist/core/migration/locale/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);
const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};

function upload(deps, workspaceId, filename, text) {
  return must(
    call(deps, 'files_upload', {
      workspaceId,
      filename,
      mime: 'text/csv',
      contentBase64: Buffer.from(text, 'utf8').toString('base64'),
      idempotencyKey: `up-${filename}`,
    }),
    'files_upload',
  ).file.id;
}

const SALDENLISTE = ['Kontonummer;Bezeichnung;Saldo', '1020;Bank;12500.00', '1100;Debitoren;3400.00', '2000;Kreditoren;-1900.00', '2800;Stammkapital;-14000.00'].join('\n') + '\n';
const JOURNAL = ['Datum;Referenz;Soll;Haben;Beschreibung;Betrag;Buchungswährung;MWST', '2026-01-05;R-1;1100;3400;Beratung;1200.00;CHF;UST81'].join('\n') + '\n';
const GENERIC = ['account,debitMinor,creditMinor', '1020,100000,0', '2800,0,100000'].join('\n') + '\n';

test('the detector: a Saldenliste header is bexio opening balances, a journal header is bexio gl_history, anything else is null', () => {
  assert.deepEqual(detectAdapterFromHeaders(['Kontonummer', 'Bezeichnung', 'Saldo']), { adapter: 'bexio_csv', dataClass: 'opening_balances' });
  // Order, case and spacing do not matter: headers compare normalised, the way suggestMap compares them.
  assert.deepEqual(detectAdapterFromHeaders([' SALDO ', 'kontonummer']), { adapter: 'bexio_csv', dataClass: 'opening_balances' });
  assert.deepEqual(detectAdapterFromHeaders(['Datum', 'Referenz', 'Soll', 'Haben', 'Beschreibung', 'Betrag']), { adapter: 'bexio_csv', dataClass: 'gl_history' });
  // Half a signature is no signature: the generic path keeps the file.
  assert.equal(detectAdapterFromHeaders(['Kontonummer', 'Name']), null);
  assert.equal(detectAdapterFromHeaders(['account', 'debitMinor', 'creditMinor']), null);
  assert.equal(detectAdapterFromHeaders([]), null);
});

test('the fixture rule holds for signatures: every signature header is a column preset of its adapter', () => {
  for (const adapter of SOURCE_ADAPTERS) {
    const presets = new Set(adapter.columnPresets.map((p) => p.header));
    for (const signature of adapter.headerSignatures ?? []) {
      assert.ok(adapter.dataClasses.includes(signature.dataClass), `${adapter.id}: signature class ${signature.dataClass} is not a class the adapter produces`);
      for (const h of signature.headers) {
        assert.equal(h, normalizeToken(h), `${adapter.id}: signature header ${h} is not normalised`);
        assert.ok(presets.has(h), `${adapter.id}: signature header ${h} has no column preset (no fixture backing)`);
      }
    }
  }
});

test('discovery classifies a bexio-shaped Saldenliste as bexio (CSV) with opening balances alone, and links it as such', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Übernahme GmbH', 'bhp-ws');
  const fileId = upload(deps, workspaceId, 'saldenliste-synthetic.csv', SALDENLISTE);

  const disc = must(call(deps, 'migration_discover_source', { workspaceId, fileIds: [fileId] }), 'discover');
  assert.equal(disc.failures.length, 0, JSON.stringify(disc.failures));
  const [file] = disc.files;
  assert.equal(file.adapter, 'bexio_csv', 'the header line IS the bexio Saldenliste layout');
  assert.deepEqual(file.dataClasses, ['opening_balances'], 'the data class defaults to opening balances, nothing else is offered');
  assert.equal(file.confidence, 'high');
  assert.equal(file.rowCount, 4);

  // With a plan (created generic: the operator had not named a source yet), the link carries the
  // classified adapter, and the source-adapter-only scope offer is the one class.
  const planId = must(
    call(deps, 'migration_create_plan', { workspaceId, sourceSystem: 'csv', cutoverDate: '2026-01-01', localePack: 'ch', idempotencyKey: 'bhp-plan' }),
    'create_plan',
  ).planId;
  const linked = must(call(deps, 'migration_discover_source', { workspaceId, fileIds: [fileId], planId }), 'discover with plan');
  assert.equal(linked.files[0].adapter, 'bexio_csv');
  const row = deps.store.db.prepare('SELECT adapter, data_classes FROM migration_source_file WHERE plan_id = ? AND file_id = ?').get(planId, fileId);
  assert.ok(row, 'the file was linked to the plan');
  assert.equal(row.adapter, 'bexio_csv', 'the link names the classified adapter, not the requested one');
  assert.deepEqual(JSON.parse(row.data_classes), ['opening_balances']);
});

test('a bexio journal export narrows to gl_history; a generic CSV stays generic with every class on offer', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Übernahme GmbH', 'bhp-ws-2');
  const journalId = upload(deps, workspaceId, 'journal-synthetic.csv', JOURNAL);
  const genericId = upload(deps, workspaceId, 'opening-generic.csv', GENERIC);
  const disc = must(call(deps, 'migration_discover_source', { workspaceId, fileIds: [journalId, genericId] }), 'discover');
  const byId = new Map(disc.files.map((f) => [f.fileId, f]));
  assert.equal(byId.get(journalId).adapter, 'bexio_csv');
  assert.deepEqual(byId.get(journalId).dataClasses, ['gl_history']);
  const generic = byId.get(genericId);
  assert.equal(generic.adapter, 'csv', 'a header that matches no signature is the generic path, unchanged');
  assert.ok(generic.dataClasses.length > 1, 'the generic adapter still offers every first-scope class');
  assert.equal(generic.confidence, 'low');
});

test('end to end: the classified bexio Saldenliste COMMITS one balanced opening entry, credit accounts on the credit side', () => {
  // MINOR-1 closed: classification is proven above, but the SIGNED Saldo -> debit/credit mapping and
  // the trial-balance-nets-to-zero were only asserted for the generic dr/cr fixture, never for the
  // newly-detected bexio path. This drives the whole flow (discover -> scope -> control totals ->
  // trial load -> stage -> approve -> commit) on the SALDENLISTE and reads the posted ROWS, so the
  // sign split (positive Saldo = debit asset, negative = credit equity/liability) is measured, not
  // trusted. The clock is 2026-07-16 (AT), so a 2026-01-01 Stichtag is in the past and does not wait.
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Übernahme GmbH', 'bhp-commit-ws');
  const fileId = upload(deps, workspaceId, 'saldenliste-synthetic.csv', SALDENLISTE);

  const planId = must(
    call(deps, 'migration_create_plan', { workspaceId, sourceSystem: 'bexio', cutoverDate: '2026-01-01', localePack: 'ch', idempotencyKey: 'bhp-commit-plan' }),
    'create_plan',
  ).planId;
  const linked = must(call(deps, 'migration_discover_source', { workspaceId, fileIds: [fileId], planId }), 'discover with plan');
  assert.equal(linked.files[0].adapter, 'bexio_csv', 'the committed file is the bexio-classified Saldenliste');
  const scope = must(
    call(deps, 'migration_set_scope', { workspaceId, planId, classes: [{ dataClass: 'opening_balances', include: true }], idempotencyKey: 'bhp-commit-scope' }),
    'set_scope',
  );
  const stepId = scope.steps[0].stepId;

  // The declared control totals ARE the signed Saldi in Rappen: positive on the debit accounts,
  // negative on the credit ones. They net to zero, which is the invariant the commit must preserve.
  const declared = [
    ['1020', 1250000],
    ['1100', 340000],
    ['2000', -190000],
    ['2800', -1400000],
  ];
  assert.equal(declared.reduce((s, [, m]) => s + m, 0), 0, 'the fixture nets to zero');
  for (const [number, declaredMinor] of declared) {
    must(
      call(deps, 'migration_declare_control_total', { workspaceId, planId, stepId, kind: 'trial_balance_matches_source', scope: number, declaredMinor, idempotencyKey: `bhp-dcl-${number}` }),
      `declare ${number}`,
    );
  }
  must(call(deps, 'migration_trial_load_step', { workspaceId, planId, stepId, idempotencyKey: 'bhp-trial' }), 'trial load');

  const before = deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n;
  const staged = must(call(deps, 'migration_commit_step', { workspaceId, planId, stepId, idempotencyKey: 'bhp-commit-1' }), 'commit (staged)');
  assert.equal(staged.staged, true);
  deps.store.db.prepare('UPDATE migration_plan SET backup_ref = ? WHERE id = ?').run('bhp-backup', planId);
  must(call(deps, 'migration_record_approval', { workspaceId, planId, stepId, checkHash: staged.checkHash, idempotencyKey: 'bhp-appr' }), 'approval');
  const committed = must(call(deps, 'migration_commit_step', { workspaceId, planId, stepId, idempotencyKey: 'bhp-commit-1' }), 'commit');

  const entryId = committed.openingEntryId;
  assert.ok(entryId, 'the commit reports the single opening entry');
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n, before + 1, 'exactly ONE opening entry');

  // Read the posted lines by account NUMBER and prove the sign split. A wrong absolute-value split
  // would still balance at the total, so the per-account side is what actually bites here.
  const lines = deps.store.db
    .prepare('SELECT a.number AS number, l.debit_minor AS d, l.credit_minor AS c FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.entry_id = ?')
    .all(entryId);
  const by = new Map(lines.map((l) => [l.number, l]));
  assert.equal(by.get('1020').d, 1250000, 'a positive Saldo posts to the DEBIT side (asset)');
  assert.equal(by.get('1020').c, 0);
  assert.equal(by.get('1100').d, 340000);
  assert.equal(by.get('2000').c, 190000, 'a negative Saldo posts to the CREDIT side (liability)');
  assert.equal(by.get('2000').d, 0);
  assert.equal(by.get('2800').c, 1400000, 'and the equity account too');
  assert.equal(by.get('2800').d, 0);

  const totalD = lines.reduce((s, l) => s + l.d, 0);
  const totalC = lines.reduce((s, l) => s + l.c, 0);
  assert.equal(totalD, totalC, 'the opening entry nets to zero (trial balance balanced)');
  assert.equal(totalD, 1590000, 'and carries the whole Saldenliste, no clarification line invented');
});

test('a forced adapter (K-15) is the operator\'s word: the header is not re-inferred against it', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Übernahme GmbH', 'bhp-ws-3');
  const fileId = upload(deps, workspaceId, 'saldenliste-synthetic.csv', SALDENLISTE);
  const forced = must(call(deps, 'migration_discover_source', { workspaceId, fileIds: [fileId], override: { adapter: 'csv' } }), 'forced discover');
  assert.equal(forced.files[0].adapter, 'csv', 'a forced generic adapter stands');
});
