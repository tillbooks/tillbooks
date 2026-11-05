// @ts-nocheck
/**
 * N01 US-N01.4: THE SCHEMA SURVEY GATE. Every top-level key a real caller sends (the conformance scenarios,
 * write and read, and every Studio `client.call('<verb>', { ... })`) is a key the verb's schema declares, or
 * a transport field. This is what lets `mcp.unknown_fields_agent` / `mcp.unknown_fields_studio` move to
 * `refuse` without breaking a valid call, and what keeps a field the engine reads discoverable to an agent.
 *
 * The first run found nine gaps, all fixed at the source: `post_entry` lacked `currency`/`fxRate`,
 * `create_item`/`update_item` lacked the D00 master-data fields, `list_contacts` lacked `kind`, `segment` and
 * `role`, and the Studio sent `idempotencyKey` to four key-exempt verbs (a transport field since).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { scenarioGaps, studioGaps, studioCallCount, topLevelKeys, stripComments } from './schema-survey.mjs';

test('every key the conformance scenarios send is declared by the verb\'s schema', () => {
  assert.deepEqual(scenarioGaps(), []);
});

test('every key a Studio call sends by name is declared by the verb\'s schema', () => {
  assert.ok(studioCallCount() > 600, `the survey read ${studioCallCount()} Studio calls: the parser broke, not the Studio`);
  assert.deepEqual(studioGaps(), []);
});

test('IT BITES: the reader finds a misspelled key past a comment, a spread, a nested object and a string', () => {
  const source = stripComments(`client.call('post_entry', {
    // the engine's own rule: a comment with an apostrophe and a \`backtick\`
    workspaceId,
    ...base,
    lnes: [{ account: '6500', debit: 1 }],
    description: 'a, b: c',
    nested: { notAKey: 1 },
    'quoted': true,
  })`);
  const body = source.slice(source.indexOf('{') + 1, source.lastIndexOf('}'));
  assert.deepEqual(topLevelKeys(body), ['workspaceId', 'lnes', 'description', 'nested', 'quoted']);
});
