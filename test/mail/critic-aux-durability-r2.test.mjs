// Critic round 2 probes for claude/aux-durability-beta5 (e3b7f3782): the Thunderbird mbox write path.
//
// `[FINDING R2-...]` tests assert the behaviour a fix must produce and FAIL on the reviewed head
// (evidence for `docs/critique/port-aux-durability-critic-r2.md`); `[HOLDS ...]` tests pin a round-1
// fix that survived, on EVERY POSIX platform, macOS included.
//
// THE SEAM. Round 1 stood a fake `lsof` first on PATH. Since the fix, macOS calls `/usr/sbin/lsof` by
// absolute path, so a PATH shim never runs there (the reason the round-1 L2/L4 probes fail on macOS).
// The adapter now spawns through the `node:child_process` DEFAULT export (that is the R1-L2 fix: E07's
// probe wraps that object), so a test can wrap the same object and stand in for any `lsof`, on every
// platform, with no PATH, no env var and no new production hook. Synthetic mboxes only.

import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ADAPTERS, MailStoreBusyError } from '../../dist/core/mail/adapters.js';
import { installEgressProbe } from '../../dist/core/egress/index.js';

const tb = ADAPTERS.thunderbird;
const POSIX = process.platform !== 'win32';
const SEP = 'From - Thu Jul 16 00:00:00 2026\n';
const USER_DRAFT = `${SEP}From: anna@example.invalid\nSubject: Entwurf Anna\n\nmein eigener Entwurf\n\n`;
const TILL_RAW = 'From: praxis@example.invalid\r\nSubject: Re: Termin\r\nMessage-ID: <maildft_1@till.local>\r\nX-Unsent: 1\r\n\r\nGerne Donnerstag.';

const isLsof = (command) => typeof command === 'string' && /(^|\/)lsof$/.test(command);

/**
 * Run `fn` with every `lsof` spawn answered by `answer(command, argv)` instead of the real binary.
 * Wraps the same module object the adapter and E07's probe use. Any other spawn passes through.
 */
function withLsof(answer, fn) {
  const original = childProcess.spawnSync;
  childProcess.spawnSync = function fakeSpawnSync(command, argv, options) {
    if (isLsof(command)) return answer(command, argv);
    return original.call(this, command, argv, options);
  };
  try {
    return fn();
  } finally {
    childProcess.spawnSync = original;
  }
}

const lsofSaysNobody = () => ({ status: 1, stdout: '', stderr: '', signal: null, pid: 0, output: [] });

function mboxRoot() {
  const root = mkdtempSync(join(tmpdir(), 'till-r2-mbox-'));
  writeFileSync(join(root, 'Drafts'), USER_DRAFT);
  return root;
}

// --- R1-L1 on macOS: the fail-closed branch, reachable through the seam ---------------------------------

test('[HOLDS R1-L1] an lsof that cannot answer (status 2, ETIMEDOUT) refuses the write as mail_client_unknown on every POSIX platform, writing nothing', { skip: POSIX ? false : 'POSIX only' }, () => {
  for (const answer of [
    () => ({ status: 2, stdout: '', stderr: 'lsof: boom', signal: null, pid: 0, output: [] }),
    () => ({ status: null, stdout: '', stderr: '', signal: 'SIGTERM', pid: 0, output: [], error: Object.assign(new Error('spawnSync lsof ETIMEDOUT'), { code: 'ETIMEDOUT' }) }),
  ]) {
    const root = mboxRoot();
    try {
      assert.throws(
        () => withLsof(answer, () => tb.writeDraft(root, TILL_RAW)),
        (e) => e instanceof MailStoreBusyError && e.reason === 'mail_client_unknown',
      );
      assert.equal(readFileSync(join(root, 'Drafts'), 'utf8'), USER_DRAFT, 'nothing was written');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  if (process.platform === 'darwin') {
    let asked;
    const root = mboxRoot();
    try {
      withLsof((command) => ((asked = command), lsofSaysNobody()), () => tb.writeDraft(root, TILL_RAW));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    assert.equal(asked, '/usr/sbin/lsof', 'macOS asks the system lsof by absolute path, never a PATH lookup');
  }
});

// --- R1-L2, retargeted so it runs on macOS -------------------------------------------------------------

test('[HOLDS R1-L2] the E07 hard probe records the mbox write`s lsof spawn as the one allowed local subprocess (every POSIX platform)', { skip: POSIX ? false : 'POSIX only' }, () => {
  const root = mboxRoot();
  try {
    const probe = installEgressProbe({ hard: true, layers: 'all' });
    try {
      tb.writeDraft(root, TILL_RAW); // the REAL lsof (/usr/sbin/lsof on macOS)
    } finally {
      probe.uninstall();
    }
    const spawned = probe.violations.filter((v) => v.kind === 'subprocess');
    assert.equal(spawned.length, 1, JSON.stringify(probe.violations));
    assert.equal(spawned[0].allowed, true);
    assert.match(spawned[0].target, process.platform === 'darwin' ? /^\/usr\/sbin\/lsof$/ : /(^|\/)lsof$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- R1-L4, retargeted: is the ledger in a transaction while lsof runs? ---------------------------------

async function mboxWorkspace() {
  const { getAction } = await import('../../dist/api/registry.js');
  const { registerRuntime } = await import('../../dist/core/voice/index.js');
  const { freshDeps, mintWorkspace } = await import('../api/support.mjs');
  const { makeMboxStore } = await import('./fixtures.mjs');
  const { stubAdapter, stubManifest, outboundCorpus } = await import('../voice/fixtures.mjs');
  const { inboundAsk } = await import('../drafting/fixtures.mjs');
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const root = mkdtempSync(join(tmpdir(), 'till-r2-ws-'));
  const messages = outboundCorpus(21);
  messages.push(inboundAsk());
  makeMboxStore(root, messages);
  writeFileSync(join(root, 'Drafts'), USER_DRAFT);
  const hooks = { onComplete: () => {} };
  registerRuntime(stubAdapter({ complete: (prompt) => (hooks.onComplete(), `STUB COMPLETION: ${prompt.slice(0, 40)}`) }), stubManifest());
  const account = call('mail_connect', { adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'c' });
  assert.equal(account.ok, true, JSON.stringify(account));
  assert.equal(call('mail_reindex', { accountId: account.accountId, idempotencyKey: 'r' }).ok, true);
  call('runtime_select', { modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: 's' });
  call('voice_build', { accountId: account.accountId, idempotencyKey: 'b' });
  const threads = call('mail_threads_list', { bucket: 'needs_reply' });
  const threadId = threads.items?.[0]?.id;
  assert.ok(threadId, JSON.stringify(threads));
  return { deps, call, root, threadId, hooks };
}

test('[HOLDS R1-L4] no lsof spawn of mail_draft_write, draft_generate or draft_regenerate runs inside a ledger transaction (every POSIX platform)', { skip: POSIX ? false : 'POSIX only' }, async () => {
  const { resetRuntimeRegistration } = await import('../../dist/core/voice/index.js');
  const w = await mboxWorkspace();
  try {
    // Adjusted by the implementation (R2-L1): draft_generate and draft_regenerate now ask lsof a SECOND
    // time, after the model returned and right before the write, which is inside the transaction (the
    // model call already is, see the INFO note in the r2 report). That re-check is the R2-L1 fix the
    // report proposes ("affordable even inside the transaction", one lsof bounded at 2 s). The R1-L4
    // claim that stands: the FIRST busy check of every write (the one before any slow step) runs before
    // the transaction opens, and mail_draft_write never asks lsof inside one.
    let seen = [];
    const answer = () => (seen.push(w.deps.store.db.inTransaction), lsofSaysNobody());
    const per = {};
    const run = (name, input) => {
      seen = [];
      const res = withLsof(answer, () => w.call(name, input));
      per[name] = seen;
      return res;
    };
    const written = run('mail_draft_write', { threadId: w.threadId, body: 'Gerne Donnerstag.', idempotencyKey: 'w' });
    assert.equal(written.ok, true, JSON.stringify(written));
    const generated = run('draft_generate', { threadId: w.threadId, idempotencyKey: 'g' });
    assert.equal(generated.ok, true, JSON.stringify(generated));
    const regenerated = run('draft_regenerate', { draftRunId: generated.draftRunId, idempotencyKey: 'rg' });
    assert.equal(regenerated.ok, true, JSON.stringify(regenerated));
    for (const [name, spawns] of Object.entries(per)) {
      assert.ok(spawns.length >= 1, `non-vacuity: ${name} asked lsof (${spawns.length})`);
      assert.equal(spawns[0], false, `${name}'s first lsof ran inside BEGIN IMMEDIATE: ${JSON.stringify(spawns)}`);
    }
    assert.deepEqual(per.mail_draft_write, per.mail_draft_write.map(() => false), `mail_draft_write ran lsof inside BEGIN IMMEDIATE: ${JSON.stringify(per.mail_draft_write)}`);
    for (const name of ['draft_generate', 'draft_regenerate']) {
      assert.deepEqual(per[name], [false, true], `${name}: one check before the transaction, one re-check after the model (${JSON.stringify(per[name])})`);
    }
  } finally {
    resetRuntimeRegistration();
    w.deps.store.close();
    rmSync(w.root, { recursive: true, force: true });
  }
});

// --- R2-L1: the R1-L4 fix moved the busy check in front of the model call -------------------------------

test('[FINDING R2-L1] draft_generate asks lsof BEFORE the local model writes the draft, so a Thunderbird started during generation is not seen and the user`s Drafts mbox is replaced under it', { skip: POSIX ? false : 'POSIX only' }, async () => {
  const { resetRuntimeRegistration } = await import('../../dist/core/voice/index.js');
  const w = await mboxWorkspace();
  try {
    // Thunderbird is closed when the call starts and opened while the model is writing (a local
    // model takes seconds to minutes). From then on lsof names its pid, as the real one would.
    let thunderbirdRunning = false;
    const order = [];
    w.hooks.onComplete = () => {
      order.push('model');
      thunderbirdRunning = true;
    };
    const answer = () => {
      order.push('lsof');
      return thunderbirdRunning ? { status: 0, stdout: '4242\n', stderr: '', signal: null, pid: 0, output: [] } : lsofSaysNobody();
    };
    const before = readFileSync(join(w.root, 'Drafts'));
    const generated = withLsof(answer, () => w.call('draft_generate', { threadId: w.threadId, idempotencyKey: 'g2' }));
    assert.ok(order.includes('model') && order.includes('lsof'), `non-vacuity: ${order.join(' > ')}`);
    assert.equal(
      generated.error,
      'mail_store_busy',
      `order ${order.join(' > ')}: the busy check answered before the model ran, so the mbox was rewritten while "Thunderbird" ran (${JSON.stringify(generated)}; Drafts ${before.length} -> ${readFileSync(join(w.root, 'Drafts')).length} bytes)`,
    );
  } finally {
    resetRuntimeRegistration();
    w.deps.store.close();
    rmSync(w.root, { recursive: true, force: true });
  }
});

// --- R2-M1: D172, the fail-closed choice is hard-coded --------------------------------------------------

test('[FINDING R2-M1] D172: what an mbox Drafts write does when lsof cannot answer (or a client holds the mbox) is a workspace setting with refuse as its default', async () => {
  const { SETTINGS } = await import('../../dist/core/settings/registry.js');
  const mail = SETTINGS.filter((s) => s.key.startsWith('mail.'));
  assert.ok(
    mail.some((s) => s.schema.type === 'enum' && /refuse/.test(String(s.default))),
    `no mail.* setting carries the busy-check policy (settings: ${mail.map((s) => s.key).join(', ') || 'none'}): mail_client_unknown refuses every Drafts mbox write with no way to choose otherwise`,
  );
});
