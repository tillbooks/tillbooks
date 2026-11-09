/**
 * G10 x F-09, the map-suggest seam (kaizen P4 residual 1, friction ledger J1.4):
 *
 * F-09 taught discovery to recognise a bexio Saldenliste from its header line alone and LINK the file
 * to the `bexio_csv` adapter (a row in `migration_source_file`). But `migration_suggest_map` keyed the
 * column proposal off `migration_plan.source_adapter`, which discovery never updates: the linked-vendor
 * fact lived only on the source-file row. So once a Saldenliste was linked, the mapping step called
 * `migration_suggest_map` with no hand-typed headers yet (the draft is empty until a map is saved) and
 * got `source:'none', entries:[]`. The Vorschlagen/Speichern step stalled and the journey fell back to
 * scope defaults.
 *
 * These cases prove the seam end to end THROUGH the registry (the tenant check + A24 gate on the path),
 * and prove the read stays a read (nothing is written) and stays §H-TENANT.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const run = (deps, name, input) => getAction(name).run(deps, input);
const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};
const count = (deps, sql, ...args) => deps.store.db.prepare(sql).get(...args).n;
const MAPS = 'SELECT COUNT(*) AS n FROM migration_map WHERE workspace_id = ?';

const SALDENLISTE = 'Kontonummer;Bezeichnung;Saldo\n1000;Kasse;1234.50\n1020;Bank;9876.00\n';

/** A plan whose only source file is a bexio Saldenliste discovery has linked to `bexio_csv`. */
function planWithLinkedSaldenliste(deps, workspaceId, suffix = '') {
  must(run(deps, 'vat_seed_defaults', { workspaceId }), 'vat_seed_defaults');
  const plan = must(
    run(deps, 'migration_create_plan', {
      workspaceId,
      sourceSystem: 'csv',
      cutoverDate: '2026-10-01',
      localePack: 'ch',
      idempotencyKey: `plan-${workspaceId}${suffix}`,
    }),
    'create_plan',
  );
  const up = must(
    run(deps, 'files_upload', {
      workspaceId,
      filename: 'saldenliste.csv',
      mime: 'text/csv',
      contentBase64: Buffer.from(SALDENLISTE).toString('base64'),
      idempotencyKey: `up-${workspaceId}${suffix}`,
    }),
    'files_upload',
  );
  const disc = must(
    run(deps, 'migration_discover_source', { workspaceId, fileIds: [up.file.id], planId: plan.planId }),
    'discover',
  );
  // Guard the premise: discovery really did link the file to the vendor adapter with the OB class.
  const entry = disc.files.find((f) => f.fileId === up.file.id);
  assert.equal(entry.adapter, 'bexio_csv', 'discovery linked the Saldenliste to bexio_csv');
  assert.deepEqual(entry.dataClasses, ['opening_balances'], 'the Saldenliste narrowed to opening_balances');
  const linked = deps.store.db
    .prepare('SELECT adapter FROM migration_source_file WHERE plan_id = ? AND workspace_id = ?')
    .get(plan.planId, workspaceId);
  assert.equal(linked.adapter, 'bexio_csv', 'the source-file row carries the vendor adapter');
  return plan.planId;
}

test('a linked bexio Saldenliste yields a non-empty column map from suggest, with NO hand-typed headers', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const planId = planWithLinkedSaldenliste(deps, workspaceId);

  // The mapping step's own call: the draft is empty, so no headers are supplied. Before the fix this
  // returned source:'none', entries:[] (the stall). After it, the linked vendor adapter seeds the map.
  const res = must(run(deps, 'migration_suggest_map', { workspaceId, planId, kind: 'column' }), 'suggest_map');

  assert.notEqual(res.entries.length, 0, 'the column suggestion is non-empty for a linked Saldenliste');
  const targets = res.entries.map((e) => e.target).filter((t) => t !== null && t !== undefined);
  assert.ok(targets.includes('account'), 'the account column (Kontonummer) is mapped');
  assert.ok(targets.includes('balance'), 'the balance column (Saldo) is mapped');
  assert.equal(res.source, 'adapter_preset', 'the proposal names the linked vendor adapter as its source');
  assert.equal(count(deps, MAPS, workspaceId), 0, 'suggest never writes: it only proposes');
});

test('the data class can be pinned explicitly and still seeds the opening-balance columns', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const planId = planWithLinkedSaldenliste(deps, workspaceId);

  const res = must(
    run(deps, 'migration_suggest_map', { workspaceId, planId, kind: 'column', dataClass: 'opening_balances' }),
    'suggest_map',
  );
  const targets = res.entries.map((e) => e.target);
  assert.ok(targets.includes('account') && targets.includes('balance'), 'account + balance seeded for the pinned class');
});

/**
 * Insert an operator's saved map template directly (the READ is what the seam under test exercises;
 * the write path has its own suites). `entries` is the JSON-object-by-kind shape saveMapTemplate
 * persists. `created_in_workspace_id` is provenance only, never a read fence (schema §note).
 */
function insertTemplate(deps, { id, operatorRef, sourceSystem, workspaceId, entries }) {
  deps.store.db
    .prepare(
      `INSERT INTO migration_map_template
         (id, operator_ref, name, source_system, kinds, entries, created_in_workspace_id, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(id, operatorRef, 'Bexio-Vorlage', sourceSystem, JSON.stringify(Object.keys(entries)), JSON.stringify(entries), workspaceId, deps.clock.now());
  return id;
}

// Headers no vendor preset and no locale-pack synonym recognises, so the ONLY proposal that can clear
// the confidence floor is the operator's saved template: a clean probe of whether step 3 is consulted.
const CUSTOM_HEADERS = ['ZZKonto', 'ZZBetrag'];
const CUSTOM_TEMPLATE = { column: [{ source: 'ZZKonto', target: 'account' }, { source: 'ZZBetrag', target: 'balance' }] };
const TEMPLATES = 'SELECT COUNT(*) AS n FROM migration_map_template';

test('P4-2-F2: an operator bexio template IS proposed for a linked Saldenliste whose plan.source_adapter is still csv', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const planId = planWithLinkedSaldenliste(deps, workspaceId);

  // Premise: the plan row still declares the GENERIC adapter; the bexio fact lives on the source file.
  const planRow = deps.store.db.prepare('SELECT source_adapter FROM migration_plan WHERE id = ?').get(planId);
  assert.equal(planRow.source_adapter, 'csv', 'the plan still declares the generic adapter (F-09 never rewrites it)');

  insertTemplate(deps, { id: 'tpl-bexio', operatorRef: deps.actor, sourceSystem: 'bexio_csv', workspaceId, entries: CUSTOM_TEMPLATE });

  const res = must(
    run(deps, 'migration_suggest_map', { workspaceId, planId, kind: 'column', headers: CUSTOM_HEADERS }),
    'suggest_map',
  );

  // Before the fix step 3 keyed source_system on plan.source_adapter ('csv'), so the 'bexio_csv' template
  // was never found and this returned source:'none'. After the fix it keys off the effective adapter id.
  assert.equal(res.source, 'saved_template', 'the operator bexio template is the winning proposal');
  const targets = Object.fromEntries(res.entries.map((e) => [e.source, e.target]));
  assert.equal(targets.ZZKonto, 'account', 'the account column comes from the template');
  assert.equal(targets.ZZBetrag, 'balance', 'the balance column comes from the template');

  // suggest is a READ: it writes no map and mutates no template.
  assert.equal(count(deps, MAPS, workspaceId), 0, 'suggest never writes a map');
  assert.equal(count(deps, TEMPLATES), 1, 'the template row is untouched');
});

test('§H-TENANT: a rival operator bexio template is never proposed (the operator_ref fence survives the fix)', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const planId = planWithLinkedSaldenliste(deps, workspaceId);

  // A DIFFERENT operator saved the identical bexio template. It must stay invisible to this operator.
  insertTemplate(deps, { id: 'tpl-rival', operatorRef: 'rival-operator', sourceSystem: 'bexio_csv', workspaceId, entries: CUSTOM_TEMPLATE });

  const res = must(
    run(deps, 'migration_suggest_map', { workspaceId, planId, kind: 'column', headers: CUSTOM_HEADERS }),
    'suggest_map',
  );
  assert.equal(res.source, 'none', 'a rival operator template is invisible; nothing else matched these headers');
  assert.equal(res.entries.length, 0, 'and it leaks no entries');
});

test('§H-TENANT: the linked-file seed never crosses a workspace', () => {
  const deps = freshDeps();
  const a = mintWorkspace(deps, 'Mandant A', 'ws-a');
  const b = mintWorkspace(deps, 'Mandant B', 'ws-b');
  const planA = planWithLinkedSaldenliste(deps, a.workspaceId, '-a');

  // The co-tenant cannot see A's plan at all, so it cannot reach A's linked source file either.
  const res = run(deps, 'migration_suggest_map', { workspaceId: b.workspaceId, planId: planA, kind: 'column' });
  assert.equal(res.ok, false, 'the co-tenant is refused');
  assert.equal(res.error, 'unknown_plan', 'and leaks nothing more than unknown_plan');
});
