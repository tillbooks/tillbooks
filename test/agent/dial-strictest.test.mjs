/**
 * A CALL MATCHING SEVERAL DIAL RULES IS GOVERNED BY THE STRICTEST, NEVER BY THE FIRST (critic R3 on
 * cl-periods). `dialCapabilityForCall` used to return the first input-keyed rule that matched, so an
 * extra input field that matched an earlier, looser rule moved a call to the looser dial (an agent
 * sealing with `post` on auto while `close-period` stayed on ask). Now every matching rule is a
 * candidate: the book-free answer is the most severe (`DIAL_SEVERITY`), and the transport seam drafts
 * when ANY candidate would draft against the book.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { makeContext } from '../../dist/core/context.js';
import { ledgerPorts } from '../../dist/core/ledger/index.js';
import { DIAL_CAPABILITIES } from '../../dist/core/agent/dial.js';
import { DIAL_SEVERITY, dialCapabilityForCall, dialCapabilitiesForCall, strictestDialCapability, governedDialCapability } from '../../dist/core/agent/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

/** Two rules on one invented verb that BOTH match `{ a: 1, b: 1 }`; the looser one listed first. */
const POST_FIRST = [
  { action: 'probe_verb', capability: 'post', when: (i) => i.a === 1, why: 'looser, listed first' },
  { action: 'probe_verb', capability: 'close-period', when: (i) => i.b === 1, why: 'stricter, listed second' },
];
const CLOSE_FIRST = [...POST_FIRST].reverse();

test('DIAL_SEVERITY ranks exactly the dial capabilities, the period seal first', () => {
  assert.deepEqual([...DIAL_SEVERITY].sort(), [...DIAL_CAPABILITIES].sort());
  assert.equal(DIAL_SEVERITY[0], 'close-period');
  assert.ok(DIAL_SEVERITY.indexOf('close-period') < DIAL_SEVERITY.indexOf('post'));
});

test('every matching rule is a candidate, most severe first, whatever the rule order', () => {
  for (const rules of [POST_FIRST, CLOSE_FIRST]) {
    assert.deepEqual(dialCapabilitiesForCall('probe_verb', { a: 1, b: 1 }, rules), ['close-period', 'post']);
    assert.equal(dialCapabilityForCall('probe_verb', { a: 1, b: 1 }, rules), 'close-period');
    assert.equal(dialCapabilityForCall('probe_verb', { a: 1 }, rules), 'post');
    assert.equal(dialCapabilityForCall('probe_verb', {}, rules), undefined);
  }
  // A by-name verb is governed by its name alone, whatever its input.
  assert.deepEqual(dialCapabilitiesForCall('close_year', { evidence: { kind: 'statements_signoff' }, runId: 'x' }), ['close-period']);
});

test('against the book, the candidate that would DRAFT governs, in either order', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const human = (name, input) => getAction(name).run({ ...deps, actor: 'studio' }, { workspaceId, ...input });
  // The owner lets the agent post unattended and keeps the period seal on ask.
  const set = human('set_agent_dial', { capability: 'post', level: 'auto', idempotencyKey: 'ds-post-auto' });
  assert.equal(set.ok, true, JSON.stringify(set));
  const ctx = makeContext(deps.store, { workspaceId, actor: 'studio', clock: deps.clock, ids: deps.ids, ...ledgerPorts({ store: deps.store, workspaceId, ids: deps.ids }) });
  assert.equal(strictestDialCapability(ctx, ['post', 'close-period']), 'close-period');
  assert.equal(strictestDialCapability(ctx, ['close-period', 'post']), 'close-period');
  // The real seal verb, with every extra input shape an agent might add: always close-period.
  for (const input of [{ year: '2026' }, { year: '2026', runId: 'chkrun_x' }, { year: '2026', evidence: { kind: 'statements_signoff' } }, { year: '2026', itemId: 'year_sealed' }]) {
    assert.equal(governedDialCapability(ctx, 'close_year', { workspaceId, idempotencyKey: 'k', ...input }), 'close-period');
  }
});
