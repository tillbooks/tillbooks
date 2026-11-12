// D172 (critic R2-M1): the busy check before a Thunderbird mbox Drafts write reads the workspace
// setting `mail.mbox_client_guard` (refuse | refuse_running | off, default refuse) on every verb that
// writes a draft: mail_draft_write, draft_generate and draft_regenerate.
//
// `lsof` is answered through the `node:child_process` default export the adapter spawns through (see
// `mbox-busy-check-preflight.test.mjs`), so this bites on macOS too. Synthetic mboxes and names only.

import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAction } from '../../dist/api/registry.js';
import { SETTINGS } from '../../dist/core/settings/registry.js';
import { registerRuntime, resetRuntimeRegistration } from '../../dist/core/voice/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { makeMboxStore } from './fixtures.mjs';
import { stubAdapter, stubManifest, outboundCorpus } from '../voice/fixtures.mjs';
import { inboundAsk } from '../drafting/fixtures.mjs';

const POSIX = process.platform !== 'win32';
const SEP = 'From - Thu Jul 16 00:00:00 2026\n';
const USER_DRAFT = `${SEP}From: anna@example.invalid\nSubject: Entwurf Anna\n\nmein eigener Entwurf\n\n`;
const KEY = 'mail.mbox_client_guard';

const isLsof = (command) => typeof command === 'string' && /(^|\/)lsof$/.test(command);
function withLsof(answer, fn) {
  const original = childProcess.spawnSync;
  childProcess.spawnSync = function fakeSpawnSync(command, argv, options) {
    if (isLsof(command)) return answer(command, argv, options);
    return original.call(this, command, argv, options);
  };
  try {
    return fn();
  } finally {
    childProcess.spawnSync = original;
  }
}
const lsofTimesOut = () => ({
  status: null,
  stdout: '',
  stderr: '',
  signal: 'SIGTERM',
  pid: 0,
  output: [],
  error: Object.assign(new Error('spawnSync lsof ETIMEDOUT'), { code: 'ETIMEDOUT' }),
});
const lsofSaysHeld = () => ({ status: 0, stdout: '4242\n', stderr: '', signal: null, pid: 0, output: [] });

function workspace() {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  // The setting is human-only (critic r3 nit 1): a person changes it, as the Studio seat.
  const person = (name, input) => getAction(name).run({ ...deps, actor: 'studio' }, { workspaceId, ...input });
  const root = mkdtempSync(join(tmpdir(), 'till-guard-ws-'));
  const messages = outboundCorpus(21);
  messages.push(inboundAsk());
  makeMboxStore(root, messages);
  writeFileSync(join(root, 'Drafts'), USER_DRAFT);
  registerRuntime(stubAdapter({ complete: (prompt) => `STUB COMPLETION: ${prompt.slice(0, 40)}` }), stubManifest());
  const account = call('mail_connect', { adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'c' });
  assert.equal(account.ok, true, JSON.stringify(account));
  assert.equal(call('mail_reindex', { accountId: account.accountId, idempotencyKey: 'r' }).ok, true);
  call('runtime_select', { modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: 's' });
  call('voice_build', { accountId: account.accountId, idempotencyKey: 'b' });
  const threadId = call('mail_threads_list', { bucket: 'needs_reply' }).items?.[0]?.id;
  assert.ok(threadId, 'a thread to reply to');
  return { deps, call, person, root, threadId, drafts: join(root, 'Drafts') };
}

function close(w) {
  resetRuntimeRegistration();
  w.deps.store.close();
  rmSync(w.root, { recursive: true, force: true });
}

test('D172 registry: mail.mbox_client_guard is refuse | refuse_running | off, default refuse, owned by mail.write', () => {
  const def = SETTINGS.find((s) => s.key === KEY);
  assert.ok(def, `${KEY} is in the registry`);
  assert.deepEqual(def.schema, { type: 'enum', values: ['refuse', 'refuse_running', 'off'] });
  assert.equal(def.default, 'refuse');
  assert.equal(def.owningCapability, 'mail.write');
  assert.equal(def.dialCapability, 'customize');
  assert.equal(def.humanOnly, true, 'a guard on the user`s own mail file is changed by a person only');
  for (const text of [def.label['de-CH'], def.description['de-CH']]) assert.doesNotMatch(text, /ß/, 'Swiss German writes ss');
});

test('D172 default refuse: an unanswered busy check refuses mail_draft_write as mail_store_busy and names the setting', { skip: POSIX ? false : 'POSIX only' }, () => {
  const w = workspace();
  try {
    const res = withLsof(lsofTimesOut, () => w.call('mail_draft_write', { threadId: w.threadId, body: 'Gerne Donnerstag.', idempotencyKey: 'w1' }));
    assert.equal(res.error, 'mail_store_busy', JSON.stringify(res));
    assert.equal(res.reason, 'mail_client_unknown');
    assert.equal(res.settingKey, KEY);
    assert.equal(readFileSync(w.drafts, 'utf8'), USER_DRAFT, 'nothing was written');
  } finally {
    close(w);
  }
});

test('D172 refuse_running: an unanswered check writes and says so on mail_draft_write and draft_generate; a proven holder is still refused', { skip: POSIX ? false : 'POSIX only' }, () => {
  const w = workspace();
  try {
    const set = w.person('settings_set', { key: KEY, value: 'refuse_running', reason: 'TILL.app has no lsof here', idempotencyKey: 'set' });
    assert.equal(set.ok, true, JSON.stringify(set));

    const written = withLsof(lsofTimesOut, () => w.call('mail_draft_write', { threadId: w.threadId, body: 'Gerne Donnerstag.', idempotencyKey: 'w2' }));
    assert.equal(written.ok, true, JSON.stringify(written));
    assert.equal(written.warnings?.[0]?.code, 'mail_client_unknown', JSON.stringify(written));
    assert.equal(written.warnings?.[0]?.settingKey, KEY);
    assert.match(readFileSync(w.drafts, 'utf8'), /Gerne Donnerstag\./);
    assert.match(readFileSync(w.drafts, 'utf8'), /mein eigener Entwurf/, 'the user`s own draft is kept');

    const generated = withLsof(lsofTimesOut, () => w.call('draft_generate', { threadId: w.threadId, idempotencyKey: 'g2' }));
    assert.equal(generated.ok, true, JSON.stringify(generated));
    assert.equal(generated.warnings?.[0]?.code, 'mail_client_unknown', JSON.stringify(generated));

    const before = readFileSync(w.drafts);
    const held = withLsof(lsofSaysHeld, () => w.call('draft_regenerate', { draftRunId: generated.draftRunId, idempotencyKey: 'rg2' }));
    assert.equal(held.error, 'mail_store_busy', JSON.stringify(held));
    assert.equal(held.reason, 'mail_client_running');
    assert.ok(readFileSync(w.drafts).equals(before), 'nothing was written while a client holds the mbox');
  } finally {
    close(w);
  }
});

test('D172 off: no lsof is asked for a draft write', { skip: POSIX ? false : 'POSIX only' }, () => {
  const w = workspace();
  try {
    assert.equal(w.person('settings_set', { key: KEY, value: 'off', reason: 'No mail app on this machine', idempotencyKey: 'off' }).ok, true);
    let asked = 0;
    const res = withLsof(() => ((asked += 1), lsofSaysHeld()), () => w.call('mail_draft_write', { threadId: w.threadId, body: 'Gerne Freitag.', idempotencyKey: 'w3' }));
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(asked, 0, 'the off guard spawns no lsof');
    assert.equal(res.warnings, undefined);
  } finally {
    close(w);
  }
});

test('D172 human-only: an agent seat can neither change mail.mbox_client_guard nor draft a change to it', { skip: POSIX ? false : 'POSIX only' }, () => {
  const w = workspace();
  try {
    for (const verb of ['settings_set', 'settings_reset']) {
      const input = verb === 'settings_set' ? { key: KEY, value: 'off', reason: 'Agent', idempotencyKey: `ag-${verb}` } : { key: KEY, reason: 'Agent', idempotencyKey: `ag-${verb}` };
      const res = w.call(verb, input);
      assert.equal(res.error, 'human_only', `${verb}: ${JSON.stringify(res)}`);
    }
    const drafted = w.deps.store.db.prepare("SELECT COUNT(*) AS n FROM agent_action WHERE action_tool IN ('settings_set', 'settings_reset')").get().n;
    assert.equal(drafted, 0, 'nothing was drafted for a careless approval');
    const res = withLsof(lsofTimesOut, () => w.call('mail_draft_write', { threadId: w.threadId, body: 'Gerne Donnerstag.', idempotencyKey: 'w4' }));
    assert.equal(res.error, 'mail_store_busy', 'the guard is still refuse');
  } finally {
    close(w);
  }
});
