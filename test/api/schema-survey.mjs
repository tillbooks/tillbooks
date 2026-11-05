// @ts-nocheck
/**
 * N01 US-N01.4, THE SCHEMA SURVEY: which top-level keys the callers of every verb actually SEND that the
 * verb's input schema does not DECLARE. The unknown-field check (`src/api/input-boundary.ts`) reports such
 * a key, so before its default may ever become `refuse` this survey must come back empty; every gap it
 * finds is fixed in the schema (the engine reads the field) or in the caller (it never did).
 *
 * Two sources of real calls:
 *  - the conformance contract: every write scenario's input (`SCENARIOS`, one valid call per write verb);
 *  - the Studio: every `client.call('<verb>', { ... })` with an object literal in `app/src` (tests
 *    excluded), its top-level keys read statically (a spread or a computed key is not a key it sends by
 *    name, and is skipped).
 *
 * A helper module, not a suite: `schema-survey.test.mjs` asserts on it, and a person can run it by hand.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACTIONS, getAction } from '../../dist/api/registry.js';
import { TRANSPORT_FIELDS } from '../../dist/api/input-boundary.js';
import { SCENARIOS, READ_SCENARIOS, fixture } from './conformance-contract.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Keys a schema accepts by name: its properties and the transport fields. */
function accepted(verb) {
  const action = getAction(verb);
  if (action === undefined) return undefined;
  return new Set([...Object.keys(action.inputSchema.properties), ...TRANSPORT_FIELDS]);
}

/**
 * Every conformance scenario's top-level keys the schema does not declare: each write scenario's input,
 * and each read scenario's input (a read scenario may answer one input or several).
 */
export function scenarioGaps() {
  const gaps = [];
  for (const action of ACTIONS) {
    const scenario = action.kind === 'write' ? SCENARIOS[action.name] : READ_SCENARIOS[action.name];
    if (scenario === undefined) continue;
    const fx = fixture();
    try {
      const answered = scenario(fx);
      const inputs = Array.isArray(answered) ? answered : [answered];
      const known = accepted(action.name);
      for (const input of inputs) {
        if (typeof input !== 'object' || input === null) continue;
        for (const key of Object.keys(input)) {
          if (input[key] === undefined || known.has(key)) continue;
          gaps.push(`${action.name}.${key} (conformance)`);
        }
      }
    } finally {
      fx.deps.store.close();
    }
  }
  return [...new Set(gaps)].sort();
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === 'node_modules' || name === 'dist') continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * The source with its comments blanked (same length, so offsets and line numbers hold): a comment's
 * apostrophe or backtick would otherwise open a string the literal reader never closes.
 */
export function stripComments(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote !== null) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      out += '\n';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    out += c;
  }
  return out;
}

/** The object literal starting at `open` (a `{`), by brace matching that skips strings and templates. */
function literalAt(text, open) {
  let depth = 0;
  let i = open;
  let quote = null;
  for (; i < text.length; i += 1) {
    const c = text[i];
    if (quote !== null) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '{' || c === '[' || c === '(') depth += 1;
    else if (c === '}' || c === ']' || c === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/** The top-level keys an object literal's body names: `key:`, `'key':` and shorthand `key`. */
export function topLevelKeys(body) {
  const keys = [];
  let depth = 0;
  let quote = null;
  let segment = '';
  const flush = () => {
    const s = segment.trim();
    segment = '';
    if (s.length === 0 || s.startsWith('...') || s.startsWith('[')) return;
    const named = /^(?:'([A-Za-z_$][\w$]*)'|"([A-Za-z_$][\w$]*)"|([A-Za-z_$][\w$]*))\s*(:|$|\()/.exec(s);
    if (named !== null) keys.push(named[1] ?? named[2] ?? named[3]);
  };
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quote !== null) {
      segment += c;
      if (c === '\\') {
        segment += body[i + 1] ?? '';
        i += 1;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      segment += c;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') depth += 1;
    if (c === '}' || c === ']' || c === ')') depth -= 1;
    if (c === ',' && depth === 0) {
      flush();
      continue;
    }
    segment += c;
  }
  flush();
  return keys;
}

/** Every Studio call's top-level keys the verb's schema does not declare, as `verb.key (file:line)`. */
export function studioGaps() {
  const gaps = [];
  const CALL = /\.call\(\s*'([a-z0-9_]+)',\s*\{/g;
  for (const file of walk(join(ROOT, 'app/src'))) {
    const text = stripComments(readFileSync(file, 'utf8'));
    for (const m of text.matchAll(CALL)) {
      const known = accepted(m[1]);
      if (known === undefined) continue; // a mocked or plugin verb: not the registry's
      const body = literalAt(text, m.index + m[0].length - 1);
      if (body === null) continue;
      for (const key of topLevelKeys(body)) {
        if (known.has(key)) continue;
        const line = text.slice(0, m.index).split('\n').length;
        gaps.push(`${m[1]}.${key} (${relative(ROOT, file)}:${line})`);
      }
    }
  }
  return gaps.sort();
}

/** How many Studio call sites the survey read (so a broken parser cannot pass by reading none). */
export function studioCallCount() {
  let n = 0;
  for (const file of walk(join(ROOT, 'app/src'))) n += [...readFileSync(file, 'utf8').matchAll(/\.call\(\s*'([a-z0-9_]+)',\s*\{/g)].length;
  return n;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify({ scenario: scenarioGaps(), studio: studioGaps(), studioCalls: studioCallCount() }, null, 1));
}
