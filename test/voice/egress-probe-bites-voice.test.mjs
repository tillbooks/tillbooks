/**
 * The probe proves itself AT E05'S OWN SEAM, every run: E04's bites-test proves the probe catches
 * a bare offender; this one proves it catches the offender that matters HERE, a registered ADAPTER
 * that dials out. The adapter registry is the one place third-party inference code enters the
 * loop, so if the probe did not bite through `voice_build`'s call into `adapter.embed`, the
 * "provably local" claim would be decoration exactly where the realistic threat lives.
 *
 * (The wired ENGINE path was additionally proven once during the E05 build by inserting a
 * `dns.lookup` into `buildVoiceProfile` and watching `voice.test.mjs` go red; removed again, the
 * build report records it. This suite keeps the permanent, structural half of that proof.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { installEgressProbe } from '../mail/egress-probe.mjs';

const probe = installEgressProbe();

const { getAction } = await import('../../dist/api/registry.js');
const { makeContext } = await import('../../dist/core/context.js');
const { buildVoiceProfile, registerRuntime } = await import('../../dist/core/voice/index.js');
const { freshDeps, mintWorkspace } = await import('../api/support.mjs');
const { tempStoreDir, makeMaildirStore } = await import('../mail/fixtures.mjs');
const { stubAdapter, stubManifest, deterministicEmbed, outboundCorpus } = await import('./fixtures.mjs');

test('OP6 bites for E05: an adapter that dials out fails the build loudly and leaves a record', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const ctx = makeContext(deps.store, { workspaceId, actor: 'agent', clock: deps.clock, ids: deps.ids });
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });

  // The DELIBERATE OFFENDER: an adapter whose embed() phones home before answering. This is the
  // realistic threat shape (a transitive dependency of a companion package, not our own code).
  const offender = stubAdapter({
    embed: (text) => {
      net.connect({ host: '203.0.113.7', port: 443 });
      return deterministicEmbed(text);
    },
  });
  registerRuntime(offender, stubManifest());

  const root = tempStoreDir('till-voice-offender-');
  makeMaildirStore(root, outboundCorpus(21));
  const account = call('mail_connect', { adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'off-c' });
  call('mail_reindex', { accountId: account.accountId, idempotencyKey: 'off-r' });
  call('runtime_select', { modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: 'off-s' });

  assert.throws(
    () => buildVoiceProfile(ctx, { accountId: account.accountId, idempotencyKey: 'off-b' }),
    (error) => error.name === 'EgressViolation' && /203\.0\.113\.7/.test(error.message),
    'the offending adapter was NOT caught: the probe does not reach the adapter seam and the local claim is decoration',
  );
  assert.equal(probe.violations.length, 1, 'the record survives any catch');
  assert.equal(probe.violations[0].kind, 'tcp_connect');

  // And no profile row survived the refused build: the transaction died with the throw.
  assert.equal(
    deps.store.db.prepare('SELECT COUNT(*) AS n FROM voice_profile WHERE workspace_id = ?').get(workspaceId).n,
    0,
    'a build that dialled out must not leave a half-written profile behind',
  );
});
