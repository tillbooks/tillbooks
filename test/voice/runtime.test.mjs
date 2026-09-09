/**
 * E05's OP6 runtime seam: registration (§H-ENUM: one adapter, replacement reported), the honest
 * absent state, the fail-closed manifest contract (commercial-use licence, nameable SPDX id,
 * pinned sha256, no moving-branch URL), the PURE recommender fuzzed over (manifest × RAM), and
 * `runtime_select`'s in-verb enforcement (unknown_model_ref retains the old selection,
 * insufficient_ram names the have/need figures, byo behind a real path). All under the OP6 egress
 * probe: a catalog is a file, never a fetch, and this suite measures that.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { installEgressProbe } from '../mail/egress-probe.mjs';

const probe = installEgressProbe();

const { getAction } = await import('../../dist/api/registry.js');
const { makeContext } = await import('../../dist/core/context.js');
const {
  registerRuntime,
  reportRuntimeLoadFailure,
  registeredRuntime,
  resetRuntimeRegistration,
  recommendModel,
  runtimeStatus,
  runtimeCatalog,
  selectRuntimeModel,
} = await import('../../dist/core/voice/index.js');
const { freshDeps, mintWorkspace } = await import('../api/support.mjs');
const { tempStoreDir } = await import('../mail/fixtures.mjs');
const { stubAdapter, stubManifest } = await import('./fixtures.mjs');

function world() {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const ctx = makeContext(deps.store, { workspaceId, actor: 'agent', clock: deps.clock, ids: deps.ids });
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  return { deps, workspaceId, ctx, call };
}

test('OP6 registry: absent is honest, a load failure names itself, a replacement reports what it replaced', () => {
  resetRuntimeRegistration();
  const w = world();
  const absent = runtimeStatus(w.ctx);
  assert.equal(absent.ok, true);
  assert.equal(absent.registered, false);
  assert.equal(runtimeCatalog(w.ctx).error, 'needs_local_runtime');
  assert.equal(
    selectRuntimeModel(w.ctx, { modelRef: 'stub-4b-q4', source: 'catalog' }).error,
    'needs_local_runtime',
    'no adapter, no selection: never a cloud fallback',
  );

  reportRuntimeLoadFailure('dylib missing');
  const failed = runtimeStatus(w.ctx);
  assert.equal(failed.registered, false);
  assert.equal(failed.reason, 'dylib missing', 'an adapter that fails to load reports itself rather than being silently absent');

  const first = registerRuntime(stubAdapter(), stubManifest());
  assert.equal(first.replaced, undefined);
  const second = registerRuntime(stubAdapter({ id: 'stub-local-2' }), stubManifest());
  assert.equal(second.replaced, 'stub-local', 'exactly one adapter at a time: the replacement is reported');
  assert.equal(registeredRuntime().adapter.id, 'stub-local-2');

  const present = runtimeStatus(w.ctx);
  assert.equal(present.registered, true);
  assert.equal(present.runtimeId, 'stub-local-2');
  assert.equal(present.modelRef, 'stub-4b-q4');
  assert.equal(present.device, 'test');
});

test('OP6 manifest contract: a row a business may not use never reaches the picker (fail-closed)', () => {
  const good = stubManifest();
  const mutate = (patch) => [{ ...good[0], ...patch }];
  assert.throws(
    () => registerRuntime(stubAdapter(), mutate({ licence: { spdx: 'Apache-2.0', commercialUse: false } })),
    /commercial/,
    'a non-commercial licence must refuse the whole registration',
  );
  assert.throws(
    () => registerRuntime(stubAdapter(), mutate({ licence: { spdx: 'Gemma Terms of Use', commercialUse: true } })),
    /SPDX/,
    'a licence we cannot name in one identifier is refused: this is the filter that excludes Gemma and Llama',
  );
  assert.throws(() => registerRuntime(stubAdapter(), mutate({ sha256: 'main' })), /sha256/);
  assert.throws(
    () => registerRuntime(stubAdapter(), mutate({ upstreamUrl: 'https://example.invalid/models/stub/resolve/main/x.gguf' })),
    /moving branch/,
    'a pinned hash plus a URL tracking main is a latent break in every installation at once',
  );
  assert.throws(() => registerRuntime(stubAdapter(), mutate({ qualityDe: '' })), /German-quality/);
  assert.throws(() => registerRuntime(stubAdapter(), [good[0], good[0]]), /twice/);
  // And the good manifest still registers after all those refusals.
  registerRuntime(stubAdapter(), good);
});

test('OP6 recommend is pure: never above the floor, exactly one pick, measured beats unmeasured, fuzzed', () => {
  const manifest = stubManifest();
  // Table: below every floor, between, above the giant row.
  assert.equal(recommendModel(manifest, 0), undefined, 'a machine no row fits gets no recommendation, not a lie');
  const at8 = recommendModel(manifest, 8);
  assert.equal(at8.modelRef, 'stub-9b-q4', 'the measured row beats the unmeasured one when both fit');
  const giant = recommendModel(manifest, 200000);
  assert.equal(giant.modelRef, 'stub-70b-f16', 'among measured rows the largest floor that fits wins');

  // Fuzz over (manifest permutations x RAM values): the invariants hold everywhere.
  const rams = [0, 1, 2, 4, 8, 16, 64, 512, 99999, 100000, 250000];
  const permutations = [manifest, [...manifest].reverse(), [manifest[2], manifest[0], manifest[1]]];
  for (const perm of permutations) {
    for (const ram of rams) {
      const pick = recommendModel(perm, ram);
      const fitting = perm.filter((row) => row.minRamGb <= ram);
      if (fitting.length === 0) {
        assert.equal(pick, undefined);
        continue;
      }
      assert.ok(pick !== undefined, `ram=${ram}: a fitting row exists, one must be recommended`);
      assert.ok(pick.minRamGb <= ram, `ram=${ram}: recommended ${pick.modelRef} is above the floor`);
      assert.equal(
        perm.filter((row) => row.modelRef === pick.modelRef).length,
        1,
        'exactly one row is recommended',
      );
    }
  }
});

test('OP6 catalog: over-floor rows come back fits:false with the figures IN PLACE, never hidden', () => {
  registerRuntime(stubAdapter(), stubManifest());
  const w = world();
  const catalog = runtimeCatalog(w.ctx);
  assert.equal(catalog.ok, true, JSON.stringify(catalog));
  assert.equal(catalog.models.length, 3, 'shown rather than hidden: a user who cannot see the better option cannot understand theirs');
  const giant = catalog.models.find((row) => row.modelRef === 'stub-70b-f16');
  assert.equal(giant.fits, false);
  assert.equal(giant.recommended, false);
  assert.ok(typeof catalog.machineRamGb === 'number' && catalog.machineRamGb > 0);
  assert.equal(
    catalog.models.filter((row) => row.recommended).length,
    1,
    'exactly one row carries Empfohlen für Ihren Mac',
  );
  assert.equal(catalog.recommendedModelRef, recommendModel(stubManifest(), catalog.machineRamGb).modelRef);
  assert.equal(catalog.selection, null, 'nothing selected yet: the picker preselects the recommendation, the verb never does');
});

test('OP6 select: manifest and RAM floor enforced IN THE VERB; a bad ref retains the old selection', () => {
  registerRuntime(stubAdapter(), stubManifest());
  const w = world();
  const refusedRam = w.call('runtime_select', { modelRef: 'stub-70b-f16', source: 'catalog', idempotencyKey: 's-ram' });
  assert.equal(refusedRam.ok, false);
  assert.equal(refusedRam.error, 'insufficient_ram');
  assert.equal(refusedRam.needGb, 100000);
  assert.ok(typeof refusedRam.haveGb === 'number' && refusedRam.haveGb < 100000);

  const selected = w.call('runtime_select', { modelRef: 'stub-9b-q4', source: 'catalog', idempotencyKey: 's-ok' });
  assert.equal(selected.ok, true, JSON.stringify(selected));
  assert.equal(selected.selection.modelRef, 'stub-9b-q4');
  assert.equal(selected.selection.source, 'catalog');

  // A stale ref after a package downgrade refuses AND RETAINS: the upgrade restores it (US-E05.5).
  const unknown = w.call('runtime_select', { modelRef: 'stub-gone', source: 'catalog', idempotencyKey: 's-gone' });
  assert.equal(unknown.error, 'unknown_model_ref');
  assert.equal(runtimeStatus(w.ctx).selection.modelRef, 'stub-9b-q4', 'the old selection survives the refusal');

  // Idempotent replay: one key, one selection write, the original answer.
  const replay = w.call('runtime_select', { modelRef: 'stub-9b-q4', source: 'catalog', idempotencyKey: 's-ok' });
  assert.deepEqual(replay, selected);
  assert.equal(
    w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM runtime_selection WHERE workspace_id = ?').get(w.workspaceId).n,
    1,
    'one row per workspace, however often it is chosen',
  );
});

test('OP6 select, byo: a real local .gguf path behind Erweitert; no path, no promise, no selection', () => {
  registerRuntime(stubAdapter(), stubManifest());
  const w = world();
  assert.equal(w.call('runtime_select', { source: 'byo', idempotencyKey: 'byo-x' }).error, 'invalid_input');
  assert.equal(
    w.call('runtime_select', { source: 'byo', ggufPath: '/nonexistent/eigenes.gguf', idempotencyKey: 'byo-404' }).error,
    'not_found',
  );
  const root = tempStoreDir('till-gguf-');
  const gguf = join(root, 'eigenes.gguf');
  writeFileSync(gguf, 'GGUF');
  const selected = w.call('runtime_select', { source: 'byo', ggufPath: gguf, idempotencyKey: 'byo-ok' });
  assert.equal(selected.ok, true, JSON.stringify(selected));
  assert.equal(selected.selection.source, 'byo');
  assert.equal(selected.selection.ggufPath, gguf);
  assert.equal(w.call('runtime_select', { source: 'weights_api', idempotencyKey: 'byo-bad' }).error, 'invalid_input');
});

test('OP6 §H-TENANT: one workspace\'s selection is invisible to its neighbour in the SAME store', () => {
  registerRuntime(stubAdapter(), stubManifest());
  const a = world();
  const { workspaceId: otherId } = mintWorkspace(a.deps, 'Nachbar GmbH', 'ws-b');
  const other = makeContext(a.deps.store, { workspaceId: otherId, actor: 'agent', clock: a.deps.clock, ids: a.deps.ids });
  assert.equal(a.call('runtime_select', { modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: 't-a' }).ok, true);
  assert.equal(runtimeStatus(a.ctx).selection.modelRef, 'stub-4b-q4');
  assert.equal(runtimeStatus(other).selection, null);
  assert.equal(runtimeCatalog(other).selection, null);
});

test('E05 OP6: none of the above opened a socket (the catalog is a file, never a fetch, measured)', () => {
  assert.deepEqual(probe.violations, []);
});
