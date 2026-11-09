/**
 * CRITIC ROUND 3, N2: resetting a SAVED email text waits for the person; resetting a slot with no saved
 * text stays free.
 *
 * `dispatch_text_reset` hard-deletes the workspace's own Textbaustein for one document kind and
 * locale, and the only way back is saving it again through the governed `dispatch_text_upsert`. It was
 * ungoverned, so an agent could delete a person's custom text without asking. It is now governed under
 * `customize` by a BOOK-keyed rule (an INPUT_KEYED_DIAL_RULES entry with `whenBook`, dialMap.ts): the
 * transport seam reads the book and drafts exactly when a saved row exists. A reset of a slot holding nothing changes
 * nothing and is not a question for anyone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleRest } from '../../dist/api/rest.js';
import { getAction } from '../../dist/api/registry.js';
import { dialCapabilitiesForVerb, dialCapabilityForCall, INPUT_KEYED_DIAL_RULES, NOT_DIAL_GOVERNED } from '../../dist/core/agent/dialMap.js';
import { consequenceFor } from '../../dist/core/agent/consequences.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

function world() {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const person = { ...deps, actor: 'studio' };
  const agent = { ...deps, actor: 'agent' };
  const saved = () =>
    deps.store.db.prepare('SELECT subject, body FROM dispatch_texts WHERE workspace_id = ? AND document_kind = ? AND locale = ?').get(workspaceId, 'quote', 'fr-CH');
  return { deps, workspaceId, person, agent, saved };
}

test('N2: the agent resetting a person\'s saved text drafts under customize, and the text survives until the person approves', () => {
  const w = world();
  const upserted = getAction('dispatch_text_upsert').run(w.person, {
    workspaceId: w.workspaceId,
    documentKind: 'quote',
    locale: 'fr-CH',
    subject: 'Offre {{quote_number}}',
    body: 'Bonjour {{contact_name}}',
  });
  assert.equal(upserted.ok, true, JSON.stringify(upserted));

  const drafted = handleRest('dispatch_text_reset', { workspaceId: w.workspaceId, documentKind: 'quote', locale: 'fr-CH' }, w.agent).body;
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  assert.equal(drafted.dialCapability, 'customize');
  assert.deepEqual(w.saved(), { subject: 'Offre {{quote_number}}', body: 'Bonjour {{contact_name}}' }, 'the saved text survives the proposal');

  const approved = getAction('approve_drafted_action').run(w.person, { workspaceId: w.workspaceId, actionId: drafted.actionId });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(w.saved(), undefined, 'the person\'s approval resets it');
  w.deps.store.close();
});

test('N2: resetting a slot with no saved text stays free (it changes nothing)', () => {
  const w = world();
  const reset = handleRest('dispatch_text_reset', { workspaceId: w.workspaceId, documentKind: 'invoice', locale: 'de-CH' }, w.agent).body;
  assert.equal(reset.ok, true, JSON.stringify(reset));
  assert.equal(reset.drafted, undefined, 'no Vorschlag for a no-op');
  assert.equal(reset.unchanged, true);
  w.deps.store.close();
});

test('N2: a person resets their own saved text directly, as before', () => {
  const w = world();
  getAction('dispatch_text_upsert').run(w.person, { workspaceId: w.workspaceId, documentKind: 'quote', locale: 'fr-CH', subject: 'Offre', body: 'Bonjour' });
  const reset = handleRest('dispatch_text_reset', { workspaceId: w.workspaceId, documentKind: 'quote', locale: 'fr-CH' }, w.person).body;
  assert.equal(reset.ok, true, JSON.stringify(reset));
  assert.equal(reset.drafted, undefined);
  assert.equal(w.saved(), undefined);
  w.deps.store.close();
});

test('N2: the reset is governable, no longer excluded, and carries its consequence in EN and de-CH', () => {
  assert.deepEqual(dialCapabilitiesForVerb('dispatch_text_reset'), ['customize']);
  assert.equal(NOT_DIAL_GOVERNED.dispatch_text_reset, undefined);
  assert.ok(INPUT_KEYED_DIAL_RULES.some((r) => r.action === 'dispatch_text_reset' && r.capability === 'customize' && typeof r.whenBook === 'function'));
  // Without a book the input alone says nothing: the no-op answer is the free one.
  assert.equal(dialCapabilityForCall('dispatch_text_reset', { documentKind: 'quote', locale: 'fr-CH' }), undefined);
  const c = consequenceFor('dispatch_text_reset');
  assert.ok(c !== undefined && c !== null);
  for (const text of [c.en, c['de-CH']]) {
    assert.equal(text.includes(String.fromCharCode(0x2014)), false, 'no em dash');
    assert.equal(text.includes(String.fromCharCode(0xdf)), false, 'no sharp s');
  }
  assert.match(c['de-CH'], /\bdu\b|\bdein/i, 'de-CH addresses the person with du');
});
