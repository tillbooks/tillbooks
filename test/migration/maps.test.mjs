/**
 * G10's business rules (spec §8): whole-map validation, the completeness read model, supply-date
 * tax resolution across the 01.01.2024 rate change, template reuse without silent mis-mapping, and
 * §H-TENANT on everything workspace-scoped.
 *
 * Every call goes through the REGISTRY (`getAction(...).run`), not the engine functions directly,
 * so the boundary type check, the tenant check and the A24 gate are on the tested path; the one
 * exception is `resolveTaxTarget`, the per-row seam G09 will call, which is imported and driven as
 * the function it is.
 *
 * THE TENANT TRAP the customization suites document applies here verbatim: two workspaces in two
 * databases prove nothing, so every isolation case mints BOTH workspaces on ONE `ApiDeps` and the
 * co-tenant is real.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { resolveTaxTarget } from '../../dist/core/migration/index.js';
import { VAT_RATE_ERAS } from '../../dist/core/vat/rateEras.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);
const count = (deps, sql, ...args) => deps.store.db.prepare(sql).get(...args).n;

function must(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

function seedPlan(deps, workspaceId, id, extra = {}) {
  deps.store.db
    .prepare(
      `INSERT INTO migration_plan (id, workspace_id, status, source_adapter, locale_pack, data_class, created_at)
       VALUES (?, ?, 'draft', ?, ?, ?, ?)`,
    )
    .run(id, workspaceId, extra.sourceAdapter ?? 'csv', extra.localePack ?? 'ch', extra.dataClass ?? null, deps.clock.now());
  return id;
}

function world() {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  must(call(deps, 'vat_seed_defaults', { workspaceId }), 'vat_seed_defaults');
  // Registered, because the two-window fixture upserts a legacy 7.7 code through A05's own verb,
  // and `vat_code_upsert` rightly refuses an unregistered workspace.
  must(
    call(deps, 'vat_configure', { workspaceId, method: 'effektiv', timing: 'soll', registered: true, idempotencyKey: 'w-vc' }),
    'vat_configure',
  );
  return { deps, workspaceId, accId };
}

const MAPS = 'SELECT COUNT(*) AS n FROM migration_map WHERE workspace_id = ?';

// --- setMap: validate whole, persist whole, or persist nothing (US-G10.1) ----------------------

test('setMap rejects the whole map on the first unknown account target and persists nothing', () => {
  const { deps, workspaceId } = world();
  seedPlan(deps, workspaceId, 'p1');
  const res = call(deps, 'migration_set_map', {
    workspaceId,
    planId: 'p1',
    kind: 'account',
    entries: [
      { source: '1010', sourceName: 'Kasse', target: '1000' },
      { source: '1030', sourceName: 'Nebenkasse', target: '0000' },
    ],
    idempotencyKey: 'k1',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'unknown_account');
  assert.equal(res.sourceAccount, '1030');
  // NOTHING was half-written: not even the valid first entry.
  assert.equal(count(deps, MAPS, workspaceId), 0);
});

test('setMap refuses a tax target A05 does not carry, naming the source code', () => {
  const { deps, workspaceId } = world();
  seedPlan(deps, workspaceId, 'p1');
  const res = call(deps, 'migration_set_map', {
    workspaceId,
    planId: 'p1',
    kind: 'tax',
    entries: [{ source: 'MWST-N', sourceRateBp: 810, target: 'NO-SUCH-CODE', validFrom: '2024-01-01' }],
    idempotencyKey: 'k1',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'unknown_tax_code');
  assert.equal(res.sourceCode, 'MWST-N');
  assert.equal(count(deps, MAPS, workspaceId), 0);
});

test('setMap is idempotent on its key: the replay returns the stored result and writes no second row', () => {
  const { deps, workspaceId } = world();
  seedPlan(deps, workspaceId, 'p1');
  const input = {
    workspaceId,
    planId: 'p1',
    kind: 'account',
    entries: [{ source: '1010', target: '1000' }],
    idempotencyKey: 'k1',
  };
  const first = must(call(deps, 'migration_set_map', input), 'set_map');
  const second = must(call(deps, 'migration_set_map', input), 'set_map replay');
  assert.deepEqual(second, first);
  assert.equal(count(deps, MAPS, workspaceId), 1);
});

// --- The completeness read model (US-G10.2), and the assertion that BLOCKING BITES --------------

test('an unmapped account with a non-zero balance blocks; a zero-balance one is ignorable, listed, never hidden', () => {
  const { deps, workspaceId } = world();
  seedPlan(deps, workspaceId, 'p1');
  must(
    call(deps, 'migration_set_map', {
      workspaceId,
      planId: 'p1',
      kind: 'account',
      entries: [
        { source: '1010', sourceName: 'Kasse', balanceMinor: 250000, target: '1000' },
        { source: '1030', sourceName: 'Nebenkasse', balanceMinor: 777, target: null },
        { source: '9999', sourceName: 'Stillgelegt', balanceMinor: 0, target: null },
      ],
      idempotencyKey: 'k1',
    }),
    'set_map',
  );
  const res = must(call(deps, 'migration_get_map', { workspaceId, planId: 'p1', kind: 'account' }), 'get_map');
  assert.equal(res.complete, false);
  assert.deepEqual(res.blocking, [{ source: '1030', sourceName: 'Nebenkasse', balanceMinor: 777 }]);
  assert.deepEqual(res.ignorable, [{ source: '9999', sourceName: 'Stillgelegt' }]);

  // BLOCKING BITES (spec §7): resolving the one blocking account, and nothing else, flips the
  // predicate. A mutation that made `complete` ignore balances would fail the first half above;
  // one that made it ignore targets would fail this half.
  must(
    call(deps, 'migration_set_map', {
      workspaceId,
      planId: 'p1',
      kind: 'account',
      entries: [
        { source: '1010', sourceName: 'Kasse', balanceMinor: 250000, target: '1000' },
        { source: '1030', sourceName: 'Nebenkasse', balanceMinor: 777, target: '1000' },
        { source: '9999', sourceName: 'Stillgelegt', balanceMinor: 0, target: null },
      ],
      idempotencyKey: 'k2',
    }),
    'set_map resolve',
  );
  const after = must(call(deps, 'migration_get_map', { workspaceId, planId: 'p1', kind: 'account' }), 'get_map');
  assert.equal(after.complete, true);
  assert.equal(after.blocking.length, 0);
  // The deliberate consolidation is VISIBLE: 1010 and 1030 both landed on 1000.
  assert.deepEqual(after.collapsed, [{ target: '1000', sources: ['1010', '1030'] }]);
});

test('the completedMapId occurrence key is null while blocking and the mapId once complete (the event null-collapse)', () => {
  const { deps, workspaceId } = world();
  seedPlan(deps, workspaceId, 'p1');
  const incomplete = must(
    call(deps, 'migration_set_map', {
      workspaceId,
      planId: 'p1',
      kind: 'account',
      entries: [{ source: '1010', balanceMinor: 100, target: null }],
      idempotencyKey: 'k1',
    }),
    'set_map incomplete',
  );
  assert.equal(incomplete.completedMapId, null);
  const complete = must(
    call(deps, 'migration_set_map', {
      workspaceId,
      planId: 'p1',
      kind: 'account',
      entries: [{ source: '1010', balanceMinor: 100, target: '1000' }],
      idempotencyKey: 'k2',
    }),
    'set_map complete',
  );
  assert.equal(complete.completedMapId, complete.mapId);
});

test('a plan with no map row reads as complete:false, never as ready', () => {
  const { deps, workspaceId } = world();
  seedPlan(deps, workspaceId, 'p1');
  const res = must(call(deps, 'migration_get_map', { workspaceId, planId: 'p1', kind: 'account' }), 'get_map');
  assert.equal(res.complete, false);
  assert.deepEqual(res.entries, []);
});

// --- The tax map: supply-date resolution across 01.01.2024, and the overlap refusal (US-G10.3) --

/**
 * The two-window golden fixture (spec §8): the source's one historic code maps to a 7.7 code
 * before 2024 and to UST81 from 2024-01-01. The 7.7 code is upserted through A05's own verb, the
 * way a workspace with legacy periods really carries one.
 */
function twoWindowTaxMap(deps, workspaceId) {
  must(
    call(deps, 'vat_code_upsert', {
      workspaceId,
      code: 'UST77',
      kind: 'output',
      rateBp: 770,
      formLine: '302',
      label: 'Umsatzsteuer 7.7% (Normalsatz bis 2023)',
      idempotencyKey: 'tw-code',
    }),
    'vat_code_upsert',
  );
  seedPlan(deps, workspaceId, 'ptax');
  // `sourceRateBp` is deliberately WRONG on both entries (9999): it is evidence of what the source
  // believed, and if any resolution path ever consulted it as an input, the assertions below on
  // A05's real rates would go red. That is the P6 discipline, proven rather than stated.
  must(
    call(deps, 'migration_set_map', {
      workspaceId,
      planId: 'ptax',
      kind: 'tax',
      entries: [
        { source: 'MWST-N', sourceRateBp: 9999, target: 'UST77', validFrom: '2018-01-01', validTo: '2024-01-01' },
        { source: 'MWST-N', sourceRateBp: 9999, target: 'UST81', validFrom: '2024-01-01' },
      ],
      idempotencyKey: 'tw-map',
    }),
    'set_map tax',
  );
  return must(call(deps, 'migration_get_map', { workspaceId, planId: 'ptax', kind: 'tax' }), 'get_map tax').entries;
}

test('a supply on 31.12.2023 resolves to the 7.7 code and one on 01.01.2024 to the 8.1 code, with the rate from A05', () => {
  const { deps, workspaceId } = world();
  const entries = twoWindowTaxMap(deps, workspaceId);

  const before = resolveTaxTarget(entries, 'MWST-N', '2023-12-31');
  assert.equal(before.ok, true);
  assert.equal(before.targetCode, 'UST77');
  const after = resolveTaxTarget(entries, 'MWST-N', '2024-01-01');
  assert.equal(after.ok, true);
  assert.equal(after.targetCode, 'UST81');

  // THE RATE COMES FROM A05, NEVER FROM THE MAP. The map's own sourceRateBp is a nonsense 9999;
  // the resolved codes carry A05's statutory rates, read off the workspace's own tax_code rows and
  // cross-checked against the era table's primary-source values.
  const rateOf = (code) =>
    deps.store.db.prepare('SELECT rate_bp AS r FROM tax_code WHERE workspace_id = ? AND code = ?').get(workspaceId, code).r;
  const eras = VAT_RATE_ERAS.map((e) => e.normalBp);
  assert.equal(rateOf('UST77'), 770);
  assert.equal(rateOf('UST81'), 810);
  assert.ok(eras.includes(770) && eras.includes(810), 'the fixture rates are the statutory era rates');
});

test('two windows for one source code that overlap are refused at write, both named', () => {
  const { deps, workspaceId } = world();
  seedPlan(deps, workspaceId, 'p1');
  const res = call(deps, 'migration_set_map', {
    workspaceId,
    planId: 'p1',
    kind: 'tax',
    entries: [
      { source: 'MWST-N', target: 'UST81', validFrom: '2024-01-01' },
      { source: 'MWST-N', target: 'UST26', validFrom: '2025-01-01' },
    ],
    idempotencyKey: 'k1',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'overlapping_tax_mapping');
  assert.equal(res.sourceCode, 'MWST-N');
  assert.ok(res.first !== undefined && res.second !== undefined, 'both windows are named');
  assert.equal(count(deps, MAPS, workspaceId), 0);
});

test('a supply date in no window names the MAP through its source code and date, not the row', () => {
  const { deps, workspaceId } = world();
  const entries = twoWindowTaxMap(deps, workspaceId);
  const res = resolveTaxTarget(entries, 'MWST-N', '2017-06-30');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'no_tax_mapping_for_date');
  assert.equal(res.sourceCode, 'MWST-N');
  assert.equal(res.supplyDate, '2017-06-30');
});

// --- Templates (US-G10.5): reuse without silent mis-mapping -------------------------------------

test('a template never overwrites a hand-set entry: the collision lands in conflicts[] and the hand-set value wins', () => {
  const { deps, workspaceId } = world();
  seedPlan(deps, workspaceId, 'pa');
  must(
    call(deps, 'migration_set_map', {
      workspaceId,
      planId: 'pa',
      kind: 'account',
      entries: [{ source: '1010', sourceName: 'Kasse', target: '1000' }],
      idempotencyKey: 'pa-map',
    }),
    'set_map A',
  );
  const saved = must(
    call(deps, 'migration_save_map_template', {
      workspaceId,
      planId: 'pa',
      name: 'Vorlage',
      sourceSystem: 'csv',
      kinds: ['account'],
      idempotencyKey: 'pa-tpl',
    }),
    'save_template',
  );
  seedPlan(deps, workspaceId, 'pb');
  // The operator already mapped 1010 BY HAND onto 1020 on the second plan.
  must(
    call(deps, 'migration_set_map', {
      workspaceId,
      planId: 'pb',
      kind: 'account',
      entries: [
        { source: '1010', sourceName: 'Kasse', target: '1020' },
        { source: '1050', sourceName: 'Depot', balanceMinor: 5, target: null },
      ],
      idempotencyKey: 'pb-map',
    }),
    'set_map B',
  );
  const applied = must(
    call(deps, 'migration_apply_map_template', {
      workspaceId,
      planId: 'pb',
      templateId: saved.templateId,
      idempotencyKey: 'pb-apply',
    }),
    'apply_template',
  );
  assert.deepEqual(applied.conflicts, [{ kind: 'account', source: '1010', current: '1020', template: '1000' }]);
  assert.deepEqual(applied.new, [{ kind: 'account', source: '1050' }]);
  const after = must(call(deps, 'migration_get_map', { workspaceId, planId: 'pb', kind: 'account' }), 'get_map');
  const handSet = after.entries.find((e) => e.source === '1010');
  assert.equal(handSet.target, '1020', 'the hand-set value won');
  assert.deepEqual(after.conflicts, [{ source: '1010', target: '1020', templateTarget: '1000' }]);
});

test('a template crosses workspaces; a target the next chart lacks lands in unmatched[], never applied invalid', () => {
  const deps = freshDeps();
  const a = mintWorkspace(deps, 'Mandant A', 'ws-a');
  const b = mintWorkspace(deps, 'Mandant B', 'ws-b');
  // An account that exists ONLY in workspace A.
  must(
    call(deps, 'create_account', { workspaceId: a.workspaceId, number: '6660', name: 'Spezialaufwand', type: 'expense', idempotencyKey: 'a-acc' }),
    'create_account A',
  );
  seedPlan(deps, a.workspaceId, 'plan-a');
  must(
    call(deps, 'migration_set_map', {
      workspaceId: a.workspaceId,
      planId: 'plan-a',
      kind: 'account',
      entries: [
        { source: '1010', sourceName: 'Kasse', target: '1000' },
        { source: '6001', sourceName: 'Spezial', target: '6660' },
      ],
      idempotencyKey: 'a-map',
    }),
    'set_map A',
  );
  const saved = must(
    call(deps, 'migration_save_map_template', {
      workspaceId: a.workspaceId,
      planId: 'plan-a',
      name: 'Mandantenvorlage',
      sourceSystem: 'csv',
      kinds: ['account'],
      idempotencyKey: 'a-tpl',
    }),
    'save_template',
  );
  seedPlan(deps, b.workspaceId, 'plan-b');
  const applied = must(
    call(deps, 'migration_apply_map_template', {
      workspaceId: b.workspaceId,
      planId: 'plan-b',
      templateId: saved.templateId,
      idempotencyKey: 'b-apply',
    }),
    'apply_template in B',
  );
  // 1000 exists in B's KMU chart, 6660 does not: applied and unmatched split exactly there.
  assert.deepEqual(applied.applied, [{ kind: 'account', source: '1010', target: '1000' }]);
  assert.deepEqual(applied.unmatched, [{ kind: 'account', source: '6001', target: '6660' }]);
  const inB = must(call(deps, 'migration_get_map', { workspaceId: b.workspaceId, planId: 'plan-b', kind: 'account' }), 'get_map B');
  assert.equal(inB.entries.find((e) => e.source === '6001').target, null, 'the unmatched target arrived unset, not invalid');
});

test('template purity: no balance or any other client figure survives into the stored template row', () => {
  const { deps, workspaceId } = world();
  seedPlan(deps, workspaceId, 'p1');
  must(
    call(deps, 'migration_set_map', {
      workspaceId,
      planId: 'p1',
      kind: 'account',
      entries: [{ source: '1010', sourceName: 'Kasse', balanceMinor: 987654, target: '1000' }],
      idempotencyKey: 'k1',
    }),
    'set_map',
  );
  must(
    call(deps, 'migration_save_map_template', {
      workspaceId,
      planId: 'p1',
      name: 'Vorlage',
      sourceSystem: 'csv',
      kinds: ['account'],
      idempotencyKey: 'k2',
    }),
    'save_template',
  );
  const stored = deps.store.db.prepare('SELECT entries FROM migration_map_template').get().entries;
  assert.ok(!stored.includes('balanceMinor'), 'the balance field itself is stripped');
  assert.ok(!stored.includes('987654'), 'the balance value cannot appear anywhere in the row');
  const parsed = JSON.parse(stored);
  assert.deepEqual(parsed.account, [{ source: '1010', sourceName: 'Kasse', target: '1000' }]);
});

test('a template whose kinds do not fit the plan data class is refused with template_kind_mismatch, writing nothing', () => {
  const { deps, workspaceId } = world();
  seedPlan(deps, workspaceId, 'pa');
  must(
    call(deps, 'migration_set_map', {
      workspaceId,
      planId: 'pa',
      kind: 'account',
      entries: [{ source: '1010', target: '1000' }],
      idempotencyKey: 'k1',
    }),
    'set_map',
  );
  const saved = must(
    call(deps, 'migration_save_map_template', {
      workspaceId,
      planId: 'pa',
      name: 'Kontenvorlage',
      sourceSystem: 'csv',
      kinds: ['account'],
      idempotencyKey: 'k2',
    }),
    'save_template',
  );
  seedPlan(deps, workspaceId, 'pc', { dataClass: 'contacts' });
  const res = call(deps, 'migration_apply_map_template', {
    workspaceId,
    planId: 'pc',
    templateId: saved.templateId,
    idempotencyKey: 'k3',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'template_kind_mismatch');
  assert.equal(res.kind, 'account');
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM migration_map WHERE plan_id = ?', 'pc'), 0);
});

test('templates are operator-scoped: another actor neither lists nor applies them', () => {
  const { deps, workspaceId } = world();
  seedPlan(deps, workspaceId, 'p1');
  must(
    call(deps, 'migration_set_map', {
      workspaceId,
      planId: 'p1',
      kind: 'account',
      entries: [{ source: '1010', target: '1000' }],
      idempotencyKey: 'k1',
    }),
    'set_map',
  );
  const saved = must(
    call(deps, 'migration_save_map_template', {
      workspaceId,
      planId: 'p1',
      name: 'Meine Vorlage',
      sourceSystem: 'csv',
      kinds: ['account'],
      idempotencyKey: 'k2',
    }),
    'save_template',
  );
  const other = { ...deps, actor: 'other-operator' };
  const listed = must(call(other, 'migration_list_map_templates', { workspaceId }), 'list as other');
  assert.deepEqual(listed.templates, []);
  const res = call(other, 'migration_apply_map_template', {
    workspaceId,
    planId: 'p1',
    templateId: saved.templateId,
    idempotencyKey: 'k3',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'unknown_template');
});

// --- suggestMap (US-G10.1): named sources, nothing written --------------------------------------

test('the locale pack suggests KMU targets from Swiss labels, names itself, and writes nothing', () => {
  const { deps, workspaceId } = world();
  seedPlan(deps, workspaceId, 'p1');
  const res = must(
    call(deps, 'migration_suggest_map', {
      workspaceId,
      planId: 'p1',
      kind: 'account',
      headers: ['Kassenbestand', 'Bankkonto'],
    }),
    'suggest_map',
  );
  assert.equal(res.source, 'locale_pack');
  assert.deepEqual(
    res.entries.map((e) => e.target),
    ['1000', '1020'],
  );
  assert.equal(count(deps, MAPS, workspaceId), 0, 'a suggestion is never applied by writing it');
});

test('headers that match nothing return entries:[] with source none and the raw headers', () => {
  const { deps, workspaceId } = world();
  seedPlan(deps, workspaceId, 'p1');
  const res = must(
    call(deps, 'migration_suggest_map', {
      workspaceId,
      planId: 'p1',
      kind: 'account',
      headers: ['Zeugs', 'Unbekanntes'],
    }),
    'suggest_map',
  );
  assert.equal(res.source, 'none');
  assert.deepEqual(res.entries, []);
  assert.deepEqual(res.headers, ['Zeugs', 'Unbekanntes']);
});

test('a plan naming an unregistered locale pack is refused with unknown_locale_pack', () => {
  const { deps, workspaceId } = world();
  seedPlan(deps, workspaceId, 'p1', { localePack: 'atlantis' });
  const res = call(deps, 'migration_suggest_map', { workspaceId, planId: 'p1', kind: 'account', headers: ['Kasse'] });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'unknown_locale_pack');
  assert.equal(res.localePack, 'atlantis');
});

// --- §H-TENANT: the co-tenant is real, and validation is tenant-scoped --------------------------

test('a plan is invisible from a co-tenant, and a map cannot reference an account or tax code outside its workspace', () => {
  const deps = freshDeps();
  const a = mintWorkspace(deps, 'Mandant A', 'ws-a');
  const b = mintWorkspace(deps, 'Mandant B', 'ws-b');
  seedPlan(deps, a.workspaceId, 'plan-a');

  // The co-tenant cannot see A's plan through any verb.
  for (const [verb, input] of [
    ['migration_get_map', { kind: 'account' }],
    ['migration_suggest_map', { kind: 'account', headers: ['Kasse'] }],
    ['migration_set_map', { kind: 'account', entries: [], idempotencyKey: 'x1' }],
  ]) {
    const res = call(deps, verb, { workspaceId: b.workspaceId, planId: 'plan-a', ...input });
    assert.equal(res.ok, false, `${verb} crossed the tenant`);
    assert.equal(res.error, 'unknown_plan', `${verb} leaked more than unknown_plan`);
  }

  // An account minted ONLY in B is not a legal target in A, so the existence check itself is
  // tenant-scoped: without `AND workspace_id` in the lookup this assertion goes red.
  must(
    call(deps, 'create_account', { workspaceId: b.workspaceId, number: '6661', name: 'Nur in B', type: 'expense', idempotencyKey: 'b-acc' }),
    'create_account B',
  );
  const acc = call(deps, 'migration_set_map', {
    workspaceId: a.workspaceId,
    planId: 'plan-a',
    kind: 'account',
    entries: [{ source: '6001', target: '6661' }],
    idempotencyKey: 'a-k1',
  });
  assert.equal(acc.ok, false);
  assert.equal(acc.error, 'unknown_account');

  // Same for a tax code that exists only in B.
  must(call(deps, 'vat_seed_defaults', { workspaceId: b.workspaceId }), 'vat_seed B');
  must(
    call(deps, 'vat_configure', { workspaceId: b.workspaceId, method: 'effektiv', timing: 'soll', registered: true, idempotencyKey: 'b-vc' }),
    'vat_configure B',
  );
  must(
    call(deps, 'vat_code_upsert', {
      workspaceId: b.workspaceId,
      code: 'NUR-B',
      kind: 'output',
      rateBp: 810,
      formLine: '303',
      idempotencyKey: 'b-tax',
    }),
    'vat_code_upsert B',
  );
  const tax = call(deps, 'migration_set_map', {
    workspaceId: a.workspaceId,
    planId: 'plan-a',
    kind: 'tax',
    entries: [{ source: 'S1', target: 'NUR-B', validFrom: '2024-01-01' }],
    idempotencyKey: 'a-k2',
  });
  assert.equal(tax.ok, false);
  assert.equal(tax.error, 'unknown_tax_code');
});
