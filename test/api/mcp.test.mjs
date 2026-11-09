// Smoke: the MCP server wires over the registry without throwing, callTool serialises a verb Result
// as a JSON content block, and read/write tools carry the right MCP annotations and a human title.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildMcpServer, makeApiDeps, callTool, startMcpServer, toolFor, toolTitle, TOOL_TITLE_WORDS, TOOL_TITLE_WHOLE } from '../../dist/api/mcp.js';
import { ACTIONS, getAction } from '../../dist/api/registry.js';

test('makeApiDeps opens a store and buildMcpServer wires without throwing', () => {
  const { deps, store } = makeApiDeps();
  const server = buildMcpServer(deps);
  assert.ok(server, 'server built');
  store.close();
});

test('callTool returns a JSON content block carrying the verb Result', () => {
  const { deps, store } = makeApiDeps();
  const res = callTool(deps, 'create_workspace', { name: 'Smoke GmbH', idempotencyKey: 'k' });
  assert.equal(res.content.length, 1);
  assert.equal(res.content[0].type, 'text');
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.workspaceId);
  assert.equal(res.isError, undefined, 'a successful verb is not an MCP protocol error');
  store.close();
});

test('callTool on an unknown tool returns a structured unknown_action Result, not a throw', () => {
  const { deps, store } = makeApiDeps();
  const res = callTool(deps, 'no_such_tool', {});
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, 'unknown_action');
  store.close();
});

test('a verb rejection is returned as content, not as an MCP protocol error', () => {
  const { deps, store } = makeApiDeps();
  // Missing required fields: the verb rejects, but it is a normal Result the caller reads.
  const res = callTool(deps, 'create_workspace', {});
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.ok, false);
  assert.equal(res.isError, undefined);
  store.close();
});

test('read tools advertise readOnlyHint; write tools do not (the real toolFor, not a mirror of it)', () => {
  const getEntry = /** @type {any} */ (toolFor(/** @type {any} */ (getAction('get_entry'))));
  const postEntry = /** @type {any} */ (toolFor(/** @type {any} */ (getAction('post_entry'))));
  assert.equal(getEntry.annotations.readOnlyHint, true);
  assert.notEqual(postEntry.annotations.readOnlyHint, true);
  assert.equal(typeof postEntry.annotations.destructiveHint, 'boolean', 'a write states its destructiveHint');
});

test('every advertised tool carries a non-empty human title, the same in Tool.title and annotations.title, and no two tools share one', () => {
  const seen = new Map();
  for (const a of ACTIONS) {
    const tool = /** @type {any} */ (toolFor(a));
    assert.equal(typeof tool.title, 'string', `${a.name}: Tool.title`);
    assert.ok(tool.title.trim().length > 0, `${a.name}: a non-empty title`);
    assert.equal(tool.title, tool.title.trim(), `${a.name}: no stray whitespace`);
    assert.doesNotMatch(tool.title, /_/, `${a.name}: the title is words, not the snake_case name`);
    assert.equal(tool.annotations.title, tool.title, `${a.name}: annotations.title matches Tool.title`);
    assert.equal(tool.title, toolTitle(a.name), `${a.name}: derived from the name, never hand-written`);
    assert.ok(
      tool.annotations.readOnlyHint === true || typeof tool.annotations.destructiveHint === 'boolean',
      `${a.name}: readOnlyHint or destructiveHint, as the Claude directory requires`,
    );
    assert.equal(seen.get(tool.title), undefined, `${a.name}: title "${tool.title}" already used by ${seen.get(tool.title)}`);
    seen.set(tool.title, a.name);
  }
});

test('toolTitle: sentence case over the verb words, acronyms and standards in their own spelling', () => {
  assert.equal(toolTitle('post_entry'), 'Post entry');
  assert.equal(toolTitle('vat_export_ech0217'), 'VAT export eCH-0217');
  assert.equal(toolTitle('generate_pain001'), 'Generate pain.001');
  assert.equal(toolTitle('get_ebill_config'), 'Get eBill config');
  assert.equal(toolTitle('import_camt'), 'Import camt');
  assert.equal(toolTitle('review_bank_txn'), 'Review bank transaction');
  assert.equal(toolTitle('whoami'), 'Who am I');
  // Every mapped word is a word some verb really uses, so the map cannot rot into dead entries.
  const words = new Set(ACTIONS.flatMap((a) => a.name.split('_')));
  for (const w of Object.keys(TOOL_TITLE_WORDS)) assert.ok(words.has(w), `TOOL_TITLE_WORDS.${w}: no verb uses it`);
  for (const n of Object.keys(TOOL_TITLE_WHOLE)) assert.ok(getAction(n) !== undefined, `TOOL_TITLE_WHOLE.${n}: not a verb`);
});

test('startMcpServer is exported as a function (the bin entry point)', () => {
  assert.equal(typeof startMcpServer, 'function');
});
