// Critic round 4 probes for claude/aux-durability-beta5 (02e1add39): the remaining ledger-presence
// decisions, and the human-only guard setting.
//
// `[FINDING R4-...]` asserts what a fix must produce and FAILS on the reviewed head; `[HOLDS ...]` pins a
// claim that survived. Synthetic ledgers and support dirs in temp directories only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureDbChoice } from '../../dist/api/db-path.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';

test('[FINDING R4-L1] an adopted book (book.json) truncated to 0 bytes is still treated as present, and the face opens it as a new empty ledger', () => {
  const support = mkdtempSync(join(tmpdir(), 'till-crit-r4-'));
  try {
    const book = join(support, 'Buchhaltung.till');
    writeFileSync(book, ''); // the adopted book, emptied by a half-restored disk or an interrupted copy
    const record = join(support, 'book.json');
    writeFileSync(record, JSON.stringify({ dbPath: book }));
    chmodSync(record, 0o600);

    const choice = ensureDbChoice({ TILL_SUPPORT_DIR: support });
    assert.equal(choice.source, 'adopted', `non-vacuity: book.json was honoured (${JSON.stringify(choice)})`);
    if (choice.path !== ':memory:') new SqliteStore({ location: choice.path }).close(); // what a face does next
    assert.equal(
      choice.adoptedUnavailable?.path,
      book,
      `a 0-byte adopted book resolved as present (${JSON.stringify(choice)}) and was opened: it is now a ${statSync(book).size}-byte empty ledger. D166 says an adopted book is never silently replaced; a missing one answers adoptedUnavailable.`,
    );
  } finally {
    rmSync(support, { recursive: true, force: true });
  }
});

test('[HOLDS] mail.mbox_client_guard is human-only through the transport, under customize ask AND auto: an agent seat is refused and nothing is drafted; a person sets it', async () => {
  const { getAction } = await import('../../dist/api/registry.js');
  const { handleRest } = await import('../../dist/api/rest.js');
  const { fixture } = await import('../api/conformance-contract.mjs');
  const KEY = 'mail.mbox_client_guard';
  const fx = fixture();
  const person = { ...fx.deps, actor: 'studio' };
  const agent = { ...fx.deps, actor: 'agent' };
  const drafts = () => fx.deps.store.db.prepare("SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ? AND action_tool IN ('settings_set','settings_reset')").get(fx.workspaceId).n;
  for (const level of ['ask', 'auto']) {
    const dial = getAction('set_agent_dial').run(person, { workspaceId: fx.workspaceId, capability: 'customize', level, idempotencyKey: `dial-${level}` });
    assert.equal(dial.ok, true, JSON.stringify(dial));
    const set = handleRest('settings_set', { workspaceId: fx.workspaceId, key: KEY, value: 'off', reason: 'Agent', idempotencyKey: `s-${level}` }, agent).body;
    assert.equal(set.error, 'human_only', `${level}: ${JSON.stringify(set)}`);
    const reset = handleRest('settings_reset', { workspaceId: fx.workspaceId, key: KEY, reason: 'Agent', idempotencyKey: `r-${level}` }, agent).body;
    assert.equal(reset.error, 'human_only', `${level}: ${JSON.stringify(reset)}`);
    assert.equal(drafts(), 0, `${level}: nothing was drafted for approval`);
    assert.equal(getAction('settings_get').run(person, { workspaceId: fx.workspaceId, key: KEY }).setting.value, 'refuse');
  }
  const byPerson = handleRest('settings_set', { workspaceId: fx.workspaceId, key: KEY, value: 'refuse_running', reason: 'lsof fehlt hier', idempotencyKey: 'p1' }, person).body;
  assert.equal(byPerson.ok, true, JSON.stringify(byPerson));
  assert.equal(getAction('settings_get').run(person, { workspaceId: fx.workspaceId, key: KEY }).setting.value, 'refuse_running');
});
