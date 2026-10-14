/**
 * P0.5b: an agent that is told "drafted" or "you may not decide this" is also told WHERE a human
 * decides it.
 *
 * The first-run audit's agent got `drafted` for `post_entry`, then `permission_denied` naming
 * `manage_agent_dial` for `approve_drafted_action`, and nothing said where the human approves. The
 * governed seam (`src/api/agent-gate.ts`) now attaches `approveAt` (from `src/api/approval-pointer.ts`)
 * to both, over REST and MCP alike, and never to a Studio call:
 *
 *   - the route (`/agent`, Vorschläge; `/attention`, Pendenzen) always;
 *   - the full URL when a Studio runs on this machine: this very process under `till up`, or the live
 *     `till up` whose single-instance lock sits in the support directory, with `sameLedger` telling
 *     whether that Studio has this agent's book open;
 *   - no URL, and a sentence naming `till up`, when none runs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';
import { setDeliveryRuntime, resetDeliveryRuntime } from '../../dist/api/runtime-state.js';
import { approvalPointer, samePath } from '../../dist/api/approval-pointer.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

/** A book the HUMAN created (the Studio seat), which an agent seat then drives: the real sequence. */
function world() {
  const deps = freshDeps();
  deps.actor = 'studio';
  deps.supportDir = mkdtempSync(join(tmpdir(), 'till-approve-support-'));
  const { workspaceId, accId } = mintWorkspace(deps, 'Pointer GmbH', 'pointer-ws');
  const agent = { ...deps, actor: 'agent' };
  return { deps, agent, workspaceId, accId };
}

function postArgs(workspaceId, accId, key) {
  return {
    workspaceId,
    date: '2026-06-12',
    source: 'manual',
    idempotencyKey: key,
    lines: [
      { account: accId('6500'), debit: 120000 },
      { account: accId('1020'), credit: 120000 },
    ],
  };
}

test('a draft names where a human approves it, over REST and MCP, and a Studio call carries no pointer', () => {
  resetDeliveryRuntime();
  const w = world();
  const viaRest = handleRest('post_entry', postArgs(w.workspaceId, w.accId, 'p-rest'), w.agent).body;
  assert.equal(viaRest.ok, true, JSON.stringify(viaRest));
  assert.equal(viaRest.drafted, true, 'the dial is at ask: the agent drafts');
  assert.equal(viaRest.approveAt.where, 'studio');
  assert.equal(viaRest.approveAt.path, '/agent');
  assert.equal(viaRest.approveAt.alsoPath, '/attention');
  // No Studio runs in this test process and no lock sits in the support dir: no URL, and how to start one.
  assert.equal(viaRest.approveAt.url, null);
  assert.match(viaRest.approveAt.hint, /Vorschläge/);
  assert.match(viaRest.approveAt.hint, /till up/);

  const viaMcp = JSON.parse(callTool(w.agent, 'post_entry', postArgs(w.workspaceId, w.accId, 'p-mcp')).content[0].text);
  assert.equal(viaMcp.drafted, true);
  assert.equal(viaMcp.approveAt.path, '/agent');

  // The human at the Studio executes directly and is never pointed anywhere.
  const human = handleRest('post_entry', postArgs(w.workspaceId, w.accId, 'p-human'), w.deps).body;
  assert.equal(human.ok, true);
  assert.equal(human.drafted, undefined);
  assert.equal('approveAt' in human, false);
});

test('an agent that tries to approve its own draft is refused AND told where the human approves', () => {
  resetDeliveryRuntime();
  const w = world();
  const draft = handleRest('post_entry', postArgs(w.workspaceId, w.accId, 'p-approve'), w.agent).body;
  assert.equal(draft.drafted, true);
  const refused = handleRest('approve_drafted_action', { workspaceId: w.workspaceId, actionId: draft.actionId, idempotencyKey: 'a1' }, w.agent).body;
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'permission_denied');
  assert.equal(refused.capability, 'manage_agent_dial');
  assert.equal(refused.approveAt.path, '/agent');
  assert.match(refused.approveAt.hint, /human approves/);
  // A refusal on any OTHER capability is untouched: the pointer is about human decisions only.
  const other = handleRest('get_agent_dial', { workspaceId: w.workspaceId }, w.agent).body;
  if (other.ok === false && other.capability !== 'manage_agent_dial') assert.equal('approveAt' in other, false);
});

test('under till up the pointer is this process\'s own Studio URL', () => {
  const w = world();
  setDeliveryRuntime({ mode: 'up', host: '127.0.0.1', port: 8791, studioServed: true });
  try {
    const draft = handleRest('post_entry', postArgs(w.workspaceId, w.accId, 'p-up'), w.agent).body;
    assert.equal(draft.approveAt.url, 'http://127.0.0.1:8791/agent');
    assert.equal(draft.approveAt.sameLedger, true);
    assert.match(draft.approveAt.hint, /http:\/\/127\.0\.0\.1:8791\/agent/);
  } finally {
    resetDeliveryRuntime();
  }
});

test('beside a live till up (the lock in the support dir) the pointer names its URL and whether it has the same ledger open', () => {
  resetDeliveryRuntime();
  const supportDir = mkdtempSync(join(tmpdir(), 'till-approve-lock-'));
  // A LIVE holder that is not this process: the test runner that spawned us.
  const lock = { pid: process.ppid, host: '127.0.0.1', port: 8792, url: 'http://127.0.0.1:8792', startedAt: '2026-09-30T08:00:00.000Z' };

  writeFileSync(join(supportDir, 'up.lock'), JSON.stringify({ ...lock, dbPath: '/tmp/till-pointer/book.db' }));
  const same = approvalPointer({ supportDir, ownDbPath: '/tmp/till-pointer/book.db' });
  assert.equal(same.url, 'http://127.0.0.1:8792/agent');
  assert.equal(same.sameLedger, true);

  const other = approvalPointer({ supportDir, ownDbPath: '/tmp/till-pointer/other.db' });
  assert.equal(other.sameLedger, false);
  assert.match(other.hint, /different ledger/);

  // A lock an older build wrote (no dbPath) still yields the URL, with the ledger question left open.
  writeFileSync(join(supportDir, 'up.lock'), JSON.stringify(lock));
  const legacy = approvalPointer({ supportDir, ownDbPath: '/tmp/till-pointer/book.db' });
  assert.equal(legacy.url, 'http://127.0.0.1:8792/agent');
  assert.equal(legacy.sameLedger, null);

  // A dead holder is no Studio.
  writeFileSync(join(supportDir, 'up.lock'), JSON.stringify({ ...lock, pid: 2 ** 22 + 12345 }));
  assert.equal(approvalPointer({ supportDir, ownDbPath: null }).url, null);
});

test('samePath compares resolved paths and never calls two in-memory books the same', () => {
  assert.equal(samePath('/a/b/../till.db', '/a/till.db'), true);
  assert.equal(samePath(':memory:', ':memory:'), false);
  assert.equal(samePath('/a/till.db', '/a/other.db'), false);
});
