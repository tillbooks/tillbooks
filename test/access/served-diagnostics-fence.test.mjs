/**
 * Security review F4 (Low): `set_diagnostics` and `clear_diagnostics` are `ungated('machine_scope')`
 * on the reasoning "changing YOUR OWN privacy setting is self-determination". On a served instance the
 * diagnostics log is the MACHINE's, so a served subject (a stranger included) clearing it wipes the
 * whole instance's G08 record under an unknown identity. The fix refuses both writes for a served
 * subject; a LOCAL operator (the file holder) keeps the self-determination the copy promises.
 *
 * BITE: remove `refuseServedMachineWrite(...)` from `dist/api/support-actions.js` and the served
 * tests redden (the stranger's clear/set return ok).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAction } from '../../dist/api/registry.js';
import { resolveServedActor } from '../../dist/api/session.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);

function served(deps, subject) {
  const id = resolveServedActor(deps.store, subject);
  return { ...deps, actor: id.actor, subject: id.subject, identitySource: id.identitySource };
}

function seatServedMember(deps, workspaceId, email, role, key) {
  const invited = call(deps, 'invite_member', { workspaceId, email, role, idempotencyKey: `${key}:inv` });
  assert.equal(invited.ok, true, `invite failed: ${JSON.stringify(invited)}`);
  const accepted = call(served(deps, email), 'accept_invite', { token: invited.token });
  assert.equal(accepted.ok, true, `accept failed: ${JSON.stringify(accepted)}`);
}

test('F4: a served subject cannot set_diagnostics or clear_diagnostics (the log is machine-scoped)', () => {
  const priorSupport = process.env.TILL_SUPPORT_DIR;
  const supportDir = mkdtempSync(join(tmpdir(), 'till-f4-support-'));
  process.env.TILL_SUPPORT_DIR = supportDir;
  try {
    const deps = freshDeps();
    const w1 = mintWorkspace(deps, 'Mandate One', 'ws1').workspaceId;
    seatServedMember(deps, w1, 'alice@client.example', 'owner', 'alice');

    for (const subject of ['nobody@evil.example', 'alice@client.example']) {
      const who = served(deps, subject);
      const set = call(who, 'set_diagnostics', { workspaceId: w1, capture: true });
      assert.equal(set.ok, false, `${subject}: set_diagnostics must be refused: ${JSON.stringify(set)}`);
      assert.equal(set.error, 'permission_denied');

      const cleared = call(who, 'clear_diagnostics', { workspaceId: w1 });
      assert.equal(cleared.ok, false, `${subject}: clear_diagnostics must be refused: ${JSON.stringify(cleared)}`);
      assert.equal(cleared.error, 'permission_denied');
    }
  } finally {
    if (priorSupport === undefined) delete process.env.TILL_SUPPORT_DIR;
    else process.env.TILL_SUPPORT_DIR = priorSupport;
    rmSync(supportDir, { recursive: true, force: true });
  }
});

test('F4: a LOCAL operator keeps set_diagnostics and clear_diagnostics', () => {
  const priorSupport = process.env.TILL_SUPPORT_DIR;
  const supportDir = mkdtempSync(join(tmpdir(), 'till-f4-local-'));
  process.env.TILL_SUPPORT_DIR = supportDir;
  try {
    const deps = freshDeps();
    const w1 = mintWorkspace(deps, 'Mandate One', 'ws1').workspaceId;

    const set = call(deps, 'set_diagnostics', { workspaceId: w1, capture: true });
    assert.equal(set.ok, true, `a local set_diagnostics must work: ${JSON.stringify(set)}`);
    const cleared = call(deps, 'clear_diagnostics', { workspaceId: w1 });
    assert.equal(cleared.ok, true, `a local clear_diagnostics must work: ${JSON.stringify(cleared)}`);
  } finally {
    if (priorSupport === undefined) delete process.env.TILL_SUPPORT_DIR;
    else process.env.TILL_SUPPORT_DIR = priorSupport;
    rmSync(supportDir, { recursive: true, force: true });
  }
});

test('F4 feedback: a served subject cannot prepare_feedback or preview_feedback (machine-scope file surface)', () => {
  const priorSupport = process.env.TILL_SUPPORT_DIR;
  const supportDir = mkdtempSync(join(tmpdir(), 'till-f4-fb-'));
  process.env.TILL_SUPPORT_DIR = supportDir;
  try {
    const deps = freshDeps();
    const w1 = mintWorkspace(deps, 'Mandate One', 'ws1').workspaceId;
    seatServedMember(deps, w1, 'alice@client.example', 'owner', 'alice');

    for (const subject of ['nobody@evil.example', 'alice@client.example']) {
      const who = served(deps, subject);
      const prep = call(who, 'prepare_feedback', { workspaceId: w1, subject: 'hi', message: 'x', idempotencyKey: `fb-${subject}` });
      assert.equal(prep.ok, false, `${subject}: prepare_feedback must be refused: ${JSON.stringify(prep)}`);
      assert.equal(prep.error, 'permission_denied');

      const prev = call(who, 'preview_feedback', { workspaceId: w1, subject: 'hi', message: 'x' });
      assert.equal(prev.ok, false, `${subject}: preview_feedback must be refused: ${JSON.stringify(prev)}`);
      assert.equal(prev.error, 'permission_denied');
    }
  } finally {
    if (priorSupport === undefined) delete process.env.TILL_SUPPORT_DIR;
    else process.env.TILL_SUPPORT_DIR = priorSupport;
    rmSync(supportDir, { recursive: true, force: true });
  }
});

test('F4 feedback: a LOCAL operator keeps prepare_feedback and preview_feedback', () => {
  const priorSupport = process.env.TILL_SUPPORT_DIR;
  const supportDir = mkdtempSync(join(tmpdir(), 'till-f4-fb-local-'));
  process.env.TILL_SUPPORT_DIR = supportDir;
  try {
    const deps = freshDeps();
    const w1 = mintWorkspace(deps, 'Mandate One', 'ws1').workspaceId;

    const prev = call(deps, 'preview_feedback', { workspaceId: w1, subject: 'hi', message: 'x' });
    assert.equal(prev.ok, true, `a local preview_feedback must work: ${JSON.stringify(prev)}`);
    const prep = call(deps, 'prepare_feedback', { workspaceId: w1, subject: 'hi', message: 'x', idempotencyKey: 'fb-local' });
    assert.equal(prep.ok, true, `a local prepare_feedback must work: ${JSON.stringify(prep)}`);
  } finally {
    if (priorSupport === undefined) delete process.env.TILL_SUPPORT_DIR;
    else process.env.TILL_SUPPORT_DIR = priorSupport;
    rmSync(supportDir, { recursive: true, force: true });
  }
});
