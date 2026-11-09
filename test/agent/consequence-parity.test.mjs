/**
 * D156: ONE consequence catalogue, served identically everywhere.
 *
 * The defect this guards: before D156 the sentence that tells a person (or an agent) what a governed
 * write does lived in three places that disagreed. The Studio rendered family sentences and eight
 * per-verb overrides from its own catalogues, the MCP tool descriptions carried 81 different English
 * sentences from `dialMap.ts`, and inside the Studio the human confirm (`ConsequenceLine`) and the
 * agent's draft card (`VorschlagCard`) showed different words for the same verb. This suite holds:
 *
 *   - every governed verb (name-keyed AND input-keyed) resolves to an entry in EN and de-CH;
 *   - the MCP `tools/list`, over the real wire, ends each description with exactly
 *     `CONSEQUENCE: <en>`, carries both languages under `_meta["tillbooks/consequence"]` beside the verb's
 *     D160 tag and declared D159 class, and derives `destructiveHint` from that declared class (false only
 *     for an append-only correctable write);
 *   - the Studio projection (`command-source.generated.json`) equals the engine byte for byte, per
 *     verb and per family, and no Studio catalogue keeps a copy (`agent.consequence*` keys);
 *   - the writing rules: at most two sentences and 220 characters, no em dash, no sharp s, none of
 *     the banned words, de-CH in the "du" register;
 *   - `initialize` returns the server `instructions`, and the claims in them hold against the code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildMcpServer, MCP_SERVER_INSTRUCTIONS, CONSEQUENCE_META_KEY, DESTRUCTIVE_DESPITE_CLASS } from '../../dist/api/mcp.js';
import { ACTIONS, getAction } from '../../dist/api/registry.js';
import {
  DIAL_CAPABILITY_FOR_ACTION,
  INPUT_KEYED_DIAL_RULES,
  CONSEQUENCE_FOR_ACTION,
  CONSEQUENCE_ENTRY_FOR_ACTION,
} from '../../dist/core/agent/dialMap.js';
import {
  CONSEQUENCE_FOR_FAMILY,
  CONSEQUENCE_FOR_VERB,
  REVERSIBILITY_LEVELS,
  consequenceFor,
} from '../../dist/core/agent/consequences.js';
import { DIAL_CAPABILITIES } from '../../dist/core/agent/index.js';
import { IDEMPOTENCY_KEY_EXEMPT } from '../api/conformance-contract.mjs';
import { freshDeps } from '../api/support.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const generated = JSON.parse(readFileSync(join(ROOT, 'app/src/lib/command-source.generated.json'), 'utf8'));
const LOCALES = ['en', 'de-CH'];

/** Every entry the catalogue holds, families included, as [label, entry]. */
const ALL_ENTRIES = [
  ...Object.entries(CONSEQUENCE_FOR_FAMILY).map(([family, c]) => [`family ${family}`, c]),
  ...Object.entries(CONSEQUENCE_FOR_VERB),
];

/**
 * The entries allowed past 220 characters, each with its reason. EMPTY: `close_year`, the one the
 * owner allowed to run long, was cut to fit (D156 item 8). A new exception is a reviewed edit here.
 */
const LENGTH_EXCEPTIONS = Object.freeze({});

const MAX_CHARS = 220;

/** U+2014, built from its code point so this file holds none (the house style gate scans it). */
const EM_DASH = String.fromCharCode(0x2014);

/** Sentence count: a terminal stop followed by whitespace and an upper-case start. */
function sentenceCount(text) {
  return text.split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ])/).filter((s) => s.trim().length > 0).length;
}

async function connected() {
  const server = buildMcpServer(freshDeps(), { pinnedActor: 'agent' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'consequence-parity-probe', version: '0.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

// --- the catalogue resolves --------------------------------------------------------------------

test('every dial family has an entry, and every entry names a real family or a registered verb', () => {
  assert.deepEqual(Object.keys(CONSEQUENCE_FOR_FAMILY).sort(), [...DIAL_CAPABILITIES].sort(), 'one family entry per dial capability');
  for (const verb of Object.keys(CONSEQUENCE_FOR_VERB)) assert.ok(getAction(verb), `${verb}: a catalogue entry names a registered verb`);
});

test('every governed verb resolves to EN and de-CH, by name and by every input-keyed rule', () => {
  for (const [verb, family] of Object.entries(DIAL_CAPABILITY_FOR_ACTION)) {
    const c = consequenceFor(verb, family);
    assert.ok(c, `${verb}: a name-keyed governed verb has a consequence`);
    for (const l of LOCALES) assert.ok(typeof c[l] === 'string' && c[l].length > 20, `${verb}: ${l} sentence`);
    assert.deepEqual(CONSEQUENCE_ENTRY_FOR_ACTION[verb], c, `${verb}: the projection is the resolution`);
  }
  for (const rule of INPUT_KEYED_DIAL_RULES) {
    const c = consequenceFor(rule.action, rule.capability);
    assert.ok(c, `${rule.action} under ${rule.capability}: an input-keyed call has a consequence`);
    for (const l of LOCALES) assert.ok(typeof c[l] === 'string' && c[l].length > 20, `${rule.action}: ${l} sentence`);
  }
});

test('resolution is the verb first, then the family', () => {
  // post_entry has no entry of its own: it reads the post family.
  assert.equal(CONSEQUENCE_FOR_VERB.post_entry, undefined);
  assert.deepEqual(consequenceFor('post_entry', 'post'), CONSEQUENCE_FOR_FAMILY.post);
  // close_year has its own: a family a caller names does not override it.
  assert.deepEqual(consequenceFor('close_year', 'close-period'), CONSEQUENCE_FOR_VERB.close_year);
  assert.equal(consequenceFor('list_journal'), undefined, 'a verb with nothing to say gets nothing invented');
});

test('CONSEQUENCE_FOR_ACTION is the English projection, and ActionDef.consequence is that sentence', () => {
  assert.deepEqual(Object.keys(CONSEQUENCE_FOR_ACTION).sort(), Object.keys(CONSEQUENCE_ENTRY_FOR_ACTION).sort());
  for (const [verb, c] of Object.entries(CONSEQUENCE_ENTRY_FOR_ACTION)) {
    assert.equal(CONSEQUENCE_FOR_ACTION[verb], c.en, `${verb}: projection`);
    assert.equal(getAction(verb).consequence, c.en, `${verb}: stamped onto the action`);
  }
  for (const a of ACTIONS) {
    if (CONSEQUENCE_ENTRY_FOR_ACTION[a.name] === undefined) assert.equal(a.consequence, undefined, `${a.name}: no stray consequence`);
  }
});

// --- the writing rules -------------------------------------------------------------------------

test('every sentence: at most two sentences and 220 characters (exceptions listed by name)', () => {
  for (const [label, c] of ALL_ENTRIES) {
    for (const l of LOCALES) {
      const text = c[l];
      assert.ok(sentenceCount(text) <= 2, `${label} ${l}: more than two sentences: ${text}`);
      if (LENGTH_EXCEPTIONS[label] === undefined) {
        assert.ok(text.length <= MAX_CHARS, `${label} ${l}: ${text.length} characters (max ${MAX_CHARS}): ${text}`);
      }
      assert.match(text, /[.!?]$/, `${label} ${l}: ends as a sentence`);
    }
    assert.ok(REVERSIBILITY_LEVELS.includes(c.reversibility), `${label}: reversibility is one of ${REVERSIBILITY_LEVELS.join(', ')}`);
  }
});

test('no em dash, no sharp s, none of the banned words', () => {
  for (const [label, c] of ALL_ENTRIES) {
    for (const l of LOCALES) {
      const text = c[l];
      assert.ok(!text.includes(EM_DASH), `${label} ${l}: em dash`);
      assert.doesNotMatch(text, /ß/, `${label} ${l}: sharp s`);
      // D156: no claim of no way back where a governed one exists (the catalogue states the way back
      // instead), and the retired German correction words (item 6: "Korrekturbuchung" only).
      assert.doesNotMatch(text, /irreversib|immutable|unwiderruflich|unveränderbar|unveränderlich/i, `${label} ${l}: banned word`);
      assert.doesNotMatch(text, /Gegenbuchung|Stornobuchung|\bStorno\b/, `${label} ${l}: retired correction word`);
    }
  }
});

test('de-CH speaks in the "du" register, never "Sie"', () => {
  for (const [label, c] of ALL_ENTRIES) {
    const de = c['de-CH'];
    assert.doesNotMatch(de, /\bSie\b/, `${label}: formal Sie`);
    assert.doesNotMatch(de, /\b(Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihnen)\b/, `${label}: formal possessive`);
    assert.doesNotMatch(de, /\b(ae|oe|ue)\b/i, `${label}: an ASCII transliteration where an umlaut belongs`);
  }
  // Every entry that addresses the reader does so as "du"/"dein".
  const addressing = ALL_ENTRIES.filter(([, c]) => /\b(du|dich|dir|dein|deine|deinen|deinem|deiner)\b/.test(c['de-CH']));
  assert.ok(addressing.length > 20, 'the catalogue addresses its reader as du');
});

test('the German correction is a Korrekturbuchung beside an original that stays (never phrased as editing)', () => {
  const post = CONSEQUENCE_FOR_FAMILY.post['de-CH'];
  assert.match(post, /Korrekturbuchung/);
  assert.match(post, /Original bleibt sichtbar/);
  for (const [label, c] of ALL_ENTRIES) {
    assert.doesNotMatch(c['de-CH'], /Buchung (bearbeiten|ändern)|bearbeitest du die Buchung/, `${label}: a correction phrased as editing`);
  }
});

// --- MCP: the wire ------------------------------------------------------------------------------

test('MCP initialize returns the server instructions', async () => {
  const { client, close } = await connected();
  try {
    const instructions = client.getInstructions();
    assert.equal(instructions, MCP_SERVER_INSTRUCTIONS);
    assert.match(instructions, /^TILL is an agent-first ERP for Swiss SMEs/);
    assert.match(instructions, /Call whoami first/);
    assert.match(instructions, /idempotencyKey/);
    const sentences = sentenceCount(instructions);
    assert.ok(sentences >= 2 && sentences <= 4, `2 to 4 sentences, got ${sentences}`);
    assert.ok(!instructions.includes(EM_DASH));
  } finally {
    await close();
  }
});

test('the instructions\' claims hold: whoami exists, and every write either takes an idempotencyKey or is a tested absolute setter', () => {
  const whoami = getAction('whoami');
  assert.ok(whoami, 'whoami is a verb');
  assert.equal(whoami.kind, 'read');
  const keyless = ACTIONS.filter((a) => a.kind === 'write' && !('idempotencyKey' in a.inputSchema.properties)).map((a) => a.name);
  const unexplained = keyless.filter((name) => IDEMPOTENCY_KEY_EXEMPT[name] === undefined);
  assert.deepEqual(unexplained, [], 'a write without an idempotencyKey that the conformance gate does not list as an absolute setter');
});

test('MCP tools/list: each description ends with exactly CONSEQUENCE: <en>, and _meta carries both languages', async () => {
  const { client, close } = await connected();
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, ACTIONS.length);
    let withConsequence = 0;
    for (const tool of tools) {
      const c = CONSEQUENCE_ENTRY_FOR_ACTION[tool.name];
      const action = getAction(tool.name);
      if (c === undefined) {
        assert.doesNotMatch(tool.description, / CONSEQUENCE: /, `${tool.name}: no consequence invented`);
        // D160: a write without a sentence still carries its consequence tag, and nothing else, under the key.
        assert.deepEqual(
          tool._meta?.[CONSEQUENCE_META_KEY],
          action?.kind === 'write' ? { tag: action.consequenceTag } : undefined,
          `${tool.name}: no _meta sentence invented`,
        );
        continue;
      }
      withConsequence += 1;
      const suffix = ` CONSEQUENCE: ${c.en}`;
      assert.ok(tool.description.endsWith(suffix), `${tool.name}: description ends with the catalogue's English sentence`);
      assert.equal(tool.description.indexOf(' CONSEQUENCE: '), tool.description.length - suffix.length, `${tool.name}: one CONSEQUENCE suffix`);
      // D159/D160: the sentence in both languages rides with the verb's DECLARED class and its consequence tag.
      const declared = action?.reversibility;
      assert.deepEqual(
        tool._meta?.[CONSEQUENCE_META_KEY],
        { tag: action?.consequenceTag, en: c.en, 'de-CH': c['de-CH'], reversibility: declared },
        `${tool.name}: _meta`,
      );
      // MCP: false means additive-only, which only an append-only `correctable` write is. D159: the hint
      // follows the verb's DECLARED class (`write:<class>:<tag>`), which every write now carries.
      assert.ok(declared !== undefined, `${tool.name}: a catalogued write declares its class`);
      // Critic B1: a correctable write with a non-additive edge is listed, with its reason, and claims nothing.
      const worstEdge = DESTRUCTIVE_DESPITE_CLASS[tool.name] !== undefined;
      assert.equal(tool.annotations?.destructiveHint, declared !== 'correctable' || worstEdge, `${tool.name}: destructiveHint follows the declared reversibility`);
    }
    assert.equal(withConsequence, Object.keys(CONSEQUENCE_ENTRY_FOR_ACTION).length);
  } finally {
    await close();
  }
});

test('MCP annotations: reads stay read-only, and idempotentHint only where the same arguments replay', async () => {
  const { client, close } = await connected();
  try {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const action = getAction(tool.name);
      if (action.kind === 'read') {
        assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name}: read-only`);
        continue;
      }
      const required = action.inputSchema.required.includes('idempotencyKey');
      const keyless = !('idempotencyKey' in action.inputSchema.properties);
      assert.equal(tool.annotations?.idempotentHint === true, required || keyless, `${tool.name}: idempotentHint`);
    }
  } finally {
    await close();
  }
});

test('the _meta key is valid per the MCP key rules (prefix labels then a slash, a name, not MCP-reserved)', () => {
  assert.match(CONSEQUENCE_META_KEY, /^([A-Za-z]([A-Za-z0-9-]*[A-Za-z0-9])?\.)*[A-Za-z]([A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/);
  assert.doesNotMatch(CONSEQUENCE_META_KEY, /(^|\.)(modelcontextprotocol|mcp)\./);
});

// --- the Studio projection -----------------------------------------------------------------------

test('the Studio projection equals the engine byte for byte, per verb and per family', () => {
  const byName = new Map(generated.verbs.map((v) => [v.name, v]));
  for (const a of ACTIONS) {
    const c = CONSEQUENCE_ENTRY_FOR_ACTION[a.name];
    const row = byName.get(a.name);
    assert.ok(row, `${a.name}: projected`);
    assert.equal(
      JSON.stringify(row.consequence),
      JSON.stringify(c === undefined ? null : { en: c.en, 'de-CH': c['de-CH'], reversibility: c.reversibility }),
      `${a.name}: Studio projection differs from the engine`,
    );
  }
  for (const [family, c] of Object.entries(CONSEQUENCE_FOR_FAMILY)) {
    assert.equal(
      JSON.stringify(generated.consequenceFamilies[family]),
      JSON.stringify({ en: c.en, 'de-CH': c['de-CH'], reversibility: c.reversibility }),
      `family ${family}: Studio projection differs from the engine`,
    );
  }
});

test('no agent.consequence or consequenceVerb key remains in any Studio catalogue', () => {
  const catalogues = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^(messages\.)?(en|de-CH)\.json$/.test(e.name)) catalogues.push(p);
    }
  };
  walk(join(ROOT, 'app/src'));
  assert.ok(catalogues.length > 10, 'the walk found the catalogues');
  for (const p of catalogues) {
    const agent = JSON.parse(readFileSync(p, 'utf8')).agent ?? {};
    assert.equal(agent.consequence, undefined, `${p}: agent.consequence is the engine's, not a catalogue's`);
    assert.equal(agent.consequenceVerb, undefined, `${p}: agent.consequenceVerb is the engine's, not a catalogue's`);
  }
});
