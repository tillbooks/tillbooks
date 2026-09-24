/**
 * Security review, structural recommendation (section 4): a served-stranger SWEEP that makes the NEXT
 * `ungated('pre_workspace'|'machine_scope')` verb a CONSCIOUS decision about served exposure, so a
 * future ungated verb cannot silently skip `identitySource` the way F2/F3/F4 did.
 *
 * The reviewer's ideal form drives every ungated verb over a real listener; the load-bearing half that
 * is cheap and robust is the COMPLETENESS check below: every ungated pre_workspace / machine_scope verb
 * must be classified either SERVED_DENY (a served subject is refused, or the verb is gated elsewhere so
 * a stranger cannot pass) or SERVED_ALLOW (reachable by design: token-authenticated, self-scoped, or a
 * build-time corpus with no tenant data). A new verb in neither list REDDENS this test, forcing the
 * author to decide and to add a proof. A runtime deny-proof over the drivable DENY verbs backs it up.
 *
 * BITE (completeness): add a new `ungated('pre_workspace', ...)` verb to `CAPABILITY_FOR_ACTION` and
 * this reddens until it is classified here with a reason.
 * BITE (runtime): the per-finding suites (F1-F4) redden when their guard is removed; this asserts the
 * same denials once more through one door.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CAPABILITY_FOR_ACTION, isUngated, SERVED_STRANGER_ACTOR } from '../../dist/core/access/index.js';
import { getAction } from '../../dist/api/registry.js';
import { resolveServedActor } from '../../dist/api/session.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);
const served = (deps, subject) => {
  const id = resolveServedActor(deps.store, subject);
  return { ...deps, actor: id.actor, subject: id.subject, identitySource: id.identitySource };
};

/**
 * A served subject must be REFUSED these, or the verb is gated elsewhere (the D111 create gate) so a
 * stranger cannot pass. Each has a proving suite named beside it.
 */
const SERVED_DENY = {
  create_workspace: 'D111 (d111-served-create-workspace.test.mjs)',
  bootstrap_workspace: 'composes the D111 create gate',
  create_demo_workspace: 'composes the D111 create gate',
  onboard_client: 'composes the D111 create gate',
  restore_backup: 'F2/F3 (served-backup-fence.test.mjs): denied to every served subject, plan and confirmed',
  list_restorable_backups: 'F3 (served-backup-fence.test.mjs)',
  verify_backup: 'F3 (served-backup-fence.test.mjs)',
  set_diagnostics: 'F4 (served-diagnostics-fence.test.mjs)',
  clear_diagnostics: 'F4 (served-diagnostics-fence.test.mjs)',
  prepare_feedback: 'F4 feedback (served-diagnostics-fence.test.mjs): machine-scope file write, host-only',
  preview_feedback: 'F4 feedback (served-diagnostics-fence.test.mjs): machine-scope self-service, host-only',
};

/**
 * Reachable by a served subject BY DESIGN, each for a structural reason: token-authenticated, a
 * self-scoped or per-actor-scoped read, a build-time corpus, or the software contract. None discloses
 * another tenant's data or mints a tenant a served identity could not open.
 */
const SERVED_ALLOW = {
  accept_invite: 'the single-use token IS the authorisation (a stranger redeems it)',
  delivery_status: 'describes the running delivery process, not tenant data',
  get_api_catalog: 'the software contract (every tool + route), not workspace data',
  list_concepts: 'the Begriffe corpus is a build-time constant, identical in every workspace',
  get_concept: 'same corpus, the wording of record',
  list_workspaces: 'the D12 tenant picker, A23-scoped PER ACTOR; a served subject sees ONLY workspaces it is an accepted member of (the unprovisioned-name branch is disabled for served, served-list-workspaces-scope.test.mjs)',
  migration_list_source_adapters: 'adapter catalogue, build-time descriptions, no tenant data',
  migration_list_locale_packs: 'locale-pack catalogue, build-time, no tenant data',
  migration_list_extraction_guides: 'extraction-guide catalogue, build-time, no tenant data',
  migration_get_extraction_guide: 'one extraction guide, build-time, no tenant data',
  portal_resolve: 'token-authenticated; the resolver triple-fences every read itself',
  portal_quote_accept: 'token-authenticated; fence-checks scope + contact then delegates',
};

test('SWEEP completeness: every ungated pre_workspace/machine_scope verb is classified served-deny or served-allow', () => {
  const shaped = Object.entries(CAPABILITY_FOR_ACTION)
    .filter(([, rule]) => isUngated(rule) && (rule.shape === 'pre_workspace' || rule.shape === 'machine_scope'))
    .map(([name]) => name);

  const classified = new Set([...Object.keys(SERVED_DENY), ...Object.keys(SERVED_ALLOW)]);

  const unclassified = shaped.filter((n) => !classified.has(n));
  assert.deepEqual(
    unclassified,
    [],
    `these ungated pre_workspace/machine_scope verbs are not triaged for served exposure. Add each to ` +
      `SERVED_DENY (and a proving test) or SERVED_ALLOW (with the structural reason it is safe): ${unclassified.join(', ')}`,
  );

  // No stale classification: a name here that is no longer an ungated pre_workspace/machine_scope verb.
  const shapedSet = new Set(shaped);
  const stale = [...classified].filter((n) => !shapedSet.has(n));
  assert.deepEqual(stale, [], `these classified names are no longer ungated pre_workspace/machine_scope verbs: ${stale.join(', ')}`);

  // A verb cannot be in BOTH lists.
  const both = Object.keys(SERVED_DENY).filter((n) => n in SERVED_ALLOW);
  assert.deepEqual(both, [], `these verbs are classified both deny AND allow: ${both.join(', ')}`);
});

test('SWEEP runtime: a served stranger is refused every drivable SERVED_DENY verb', () => {
  const deps = freshDeps();
  deps.backupDir = mkdtempSync(join(tmpdir(), 'till-sweep-'));
  const w1 = mintWorkspace(deps, 'Mandate One', 'ws1').workspaceId;
  // A real backup, so restore_backup's read-only pre-flight passes and the call reaches the D111 gate
  // (an invalid source would short-circuit to backup_corrupt before the gate, not proving the denial).
  const backup = call(deps, 'create_backup', { workspaceId: w1, idempotencyKey: 'sweep-bkp' });
  assert.equal(backup.ok, true, JSON.stringify(backup));
  const stranger = served(deps, 'nobody@evil.example');
  assert.equal(stranger.actor, SERVED_STRANGER_ACTOR, 'the unknown subject resolves to the stranger sentinel');

  // Minimal plausible inputs for the verbs that are cheap to drive from a stranger. The create-family
  // (bootstrap_workspace / onboard_client / create_demo_workspace) is denied by the same D111 gate and
  // proven in d111-served-create-workspace.test.mjs; driving their full onboarding inputs here would be
  // brittle, so they are asserted by the completeness classification above.
  const inputs = {
    create_workspace: { name: 'Spam', idempotencyKey: 'sweep-cw' },
    restore_backup: { source: backup.artifactRef, newWorkspaceName: 'x', confirmed: true, idempotencyKey: 'sweep-rb' },
    list_restorable_backups: {},
    verify_backup: { source: '/etc' },
    set_diagnostics: { workspaceId: w1, capture: true },
    clear_diagnostics: { workspaceId: w1 },
  };

  for (const [name, input] of Object.entries(inputs)) {
    const res = call(stranger, name, input);
    assert.equal(res.ok, false, `${name}: a served stranger must be refused: ${JSON.stringify(res)}`);
    assert.equal(res.error, 'permission_denied', `${name}: the refusal must be permission_denied, got ${res.error}`);
  }

  rmSync(deps.backupDir, { recursive: true, force: true });
});
