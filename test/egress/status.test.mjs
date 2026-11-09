/**
 * `egress_status`, the standing trust indicator's read model (spec §4, US-E07.2): the three honest
 * states, driven through the real MCP verb. The monitor is a process singleton, so the test seams
 * `forceEgressMonitorForTests` / `resetEgressMonitorForTests` set its state deterministically and the
 * suite restores the real observer at the end.
 *
 * THE HONESTY PROPERTY IS THE POINT: `local` is only ever returned when the probe is installed AND
 * has seen zero sockets; a probe that could not install reports `unknown`, never an optimistic
 * `local` (US-E07.2 Error: an unverified claim renders as unverified).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { getAction } = await import('../../dist/api/registry.js');
const { freshDeps, mintWorkspace } = await import('../api/support.mjs');
const { forceEgressMonitorForTests, resetEgressMonitorForTests, ensureEgressMonitor } =
  await import('../../dist/core/egress/index.js');

function statusIn(workspace) {
  return getAction('egress_status').run(workspace.deps, { workspaceId: workspace.workspaceId });
}

function freshWorkspace() {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  return { deps, workspaceId };
}

test('egress_status: installed and clean reports local with socketsOpened:0', () => {
  const ws = freshWorkspace();
  forceEgressMonitorForTests({ installed: true, violations: [] });
  const result = statusIn(ws);
  assert.equal(result.ok, true);
  assert.equal(result.state, 'local');
  assert.equal(result.socketsOpened, 0);
  assert.ok(result.since, 'a clean session still reports since when it started observing');
  assert.equal(result.offenders, undefined, 'the happy read carries no offenders array');
  resetEgressMonitorForTests();
  ensureEgressMonitor();
});

test('egress_status: an observed socket reports violated, with the offender named', () => {
  const ws = freshWorkspace();
  forceEgressMonitorForTests({
    installed: true,
    violations: [{ kind: 'tcp_connect', target: '203.0.113.9:443', stack: 'at somewhere' }],
  });
  const result = statusIn(ws);
  assert.equal(result.ok, true);
  assert.equal(result.state, 'violated');
  assert.equal(result.socketsOpened, 1);
  assert.ok(Array.isArray(result.offenders) && result.offenders.length === 1);
  assert.match(result.offenders[0].target, /203\.0\.113\.9/);
  resetEgressMonitorForTests();
  ensureEgressMonitor();
});

test('egress_status: a probe that could not install reports unknown, never an optimistic local', () => {
  const ws = freshWorkspace();
  forceEgressMonitorForTests({ installed: false });
  const result = statusIn(ws);
  assert.equal(result.ok, true);
  assert.equal(result.state, 'unknown', 'the failure mode of a trust indicator must be honesty, not optimism');
  assert.notEqual(result.state, 'local');
  resetEgressMonitorForTests();
  ensureEgressMonitor();
});

test('egress_status: it reads no rows, so §H-TENANT is trivial and the answer is workspace-independent', () => {
  const a = freshWorkspace();
  const b = freshWorkspace();
  forceEgressMonitorForTests({ installed: true, violations: [] });
  const ra = statusIn(a);
  const rb = statusIn(b);
  // The process observes the PROCESS, not a tenant, so two workspaces get the same process-scoped
  // answer, and neither call touched a row of either database.
  assert.equal(ra.state, rb.state);
  assert.equal(ra.socketsOpened, rb.socketsOpened);
  resetEgressMonitorForTests();
  ensureEgressMonitor();
});
