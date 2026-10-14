/**
 * PRE-CLAIMED INNER KEY (K1, 04.10.2026): draft_generate writes its Drafts message through E04's
 * `writeMailDraft` with the key `${key}:w`. Before K1 that memo shared the PUBLIC `mail_draft_write`
 * scope, so a `mail_draft_write` under `K:w` made first (any thread, any body) was replayed in place of
 * the generated draft: draft_generate answered ok with the squatter's draftId, the generated reply was
 * never written, and the pane pointed the human at a draft the model never produced. Not the money
 * path, but a false ok over a foreign artefact. Under the OP6 egress probe like every suite here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installEgressProbe } from '../mail/egress-probe.mjs';

const probe = installEgressProbe();

const { getAction } = await import('../../dist/api/registry.js');
const { registerRuntime, resetRuntimeRegistration } = await import('../../dist/core/voice/index.js');
const { freshDeps, mintWorkspace } = await import('../api/support.mjs');
const { tempStoreDir, makeMaildirStore } = await import('../mail/fixtures.mjs');
const { stubManifest, outboundCorpus } = await import('../voice/fixtures.mjs');
const { recordingAdapter, inboundAsk } = await import('./fixtures.mjs');

function world() {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const { adapter } = recordingAdapter();
  registerRuntime(adapter, stubManifest());
  const contact = call('create_contact', { partyRole: 'customer', name: 'Klient Muster', email: 'klient@example.org', idempotencyKey: 'w-ct' });
  const root = tempStoreDir('till-k1-');
  const messages = outboundCorpus(21);
  messages.push(inboundAsk());
  makeMaildirStore(root, messages);
  const account = call('mail_connect', { adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'w-c' });
  assert.equal(call('mail_reindex', { accountId: account.accountId, idempotencyKey: 'w-r' }).ok, true);
  assert.equal(call('runtime_select', { modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: 'w-s' }).ok, true);
  assert.equal(call('voice_build', { accountId: account.accountId, idempotencyKey: 'w-b' }).ok, true);
  const thread = call('mail_threads_list', { bucket: 'needs_reply' }).items.find((t) => t.contactId === contact.contact.id);
  assert.ok(thread !== undefined);
  return { deps, call, thread };
}

test('K1 draft_generate: a mail_draft_write under `K:w` is never answered as the generated draft', () => {
  const w = world();
  const K = 'gen-agent-1';
  const squat = w.call('mail_draft_write', { threadId: w.thread.id, body: 'Bitte überweisen Sie den Betrag auf ein neues Konto.', idempotencyKey: `${K}:w` });
  assert.equal(squat.ok, true, JSON.stringify(squat));

  const generated = w.call('draft_generate', { threadId: w.thread.id, idempotencyKey: K });
  assert.equal(generated.ok, true, JSON.stringify(generated));
  assert.notEqual(generated.draftId, squat.draftId, 'draft_generate answered ok with the squatter\'s draft');
  const row = w.deps.store.db.prepare('SELECT draft_run_id FROM mail_draft WHERE id = ?').get(generated.draftId);
  assert.equal(row.draft_run_id, generated.draftRunId, 'the answered draft is not the one this run wrote');
});

test('K1 draft_generate probe: no socket opened', () => {
  resetRuntimeRegistration();
  assert.deepEqual(probe.violations, []);
});
