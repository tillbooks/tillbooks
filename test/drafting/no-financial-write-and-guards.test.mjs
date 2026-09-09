/**
 * E06's structural ABSENCES, asserted rather than documented (spec §4, §6b, §7):
 *
 *   1. NO FINANCIAL WRITE (P3 by absence): `draft_run` carries zero money columns, and the
 *      drafting engine imports no posting path (`postEntry`, `recordPayment`, `ledger/`,
 *      `payments/`). E06 reads A16/A11/B00 read models and writes NOTHING back.
 *   2. NO PROMPT ON DISK: `draft_run` carries no body/prompt/excerpt/facts column, only
 *      `prompt_sha256` (the RUNTIME half is the sentinel fixture in
 *      `sentinel-containment.test.mjs`).
 *   3. NO SOCKET, STATICALLY: no `net`/`tls`/`http(s)`/`dgram`/`dns` import and no `fetch` call
 *      anywhere in `src/core/drafting/`. (The RUNTIME half is the egress probe wrapping every
 *      drafting suite.)
 *   4. NO SEND: no send-shaped export and no SMTP import. P8 holds by construction because there
 *      is no code path that transmits.
 *   5. E05'S SEAM IS THE ONLY INFERENCE DOOR: the drafting engine imports `registeredRuntime`
 *      from the voice barrel and names no inference library and no runtime internals.
 *   6. THE AUTOMATION SURFACE IS EMPTY (reconciled §6b): both writes sit in `NOT_AUTOMATABLE`
 *      and E06 emits no automation event.
 *   7. NO OP3 ATTACHMENT and erasure coverage, the E05 shapes exactly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { DRAFTING_TABLES } from '../../dist/core/drafting/index.js';
import { ENTITY_KINDS } from '../../dist/core/customization/entities.js';
import { NOT_AUTOMATABLE } from '../../dist/core/automation/denylist.js';
import { eventsEmittedBy } from '../../dist/core/automation/events.js';
import { getAction } from '../../dist/api/registry.js';
import { requiredCapabilitiesFor } from '../../dist/core/access/actionCapabilities.js';

const DRAFTING_DIR = fileURLToPath(new URL('../../src/core/drafting/', import.meta.url));

test('E06: draft_run exists and carries no prompt, body, facts, credential, or money column', () => {
  const store = new SqliteStore();
  assert.deepEqual([...DRAFTING_TABLES], ['draft_run']);
  for (const table of DRAFTING_TABLES) {
    const columns = store.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    assert.ok(columns.length >= 8, `PRAGMA answered nothing for ${table}: the probe is broken`);
    // `prompt_sha256` is a HASH, the exact opposite of a copy; the probe names copy-shaped columns.
    const copies = columns.filter(
      (name) => /body|excerpt|raw|content|text|prompt|fact/.test(name) && name !== 'prompt_sha256',
    );
    assert.deepEqual(copies, [], `${table} grew a copy-shaped column: ${copies.join(', ')} (Art. 321 containment)`);
    const money = columns.filter((name) => name.includes('_rappen') || name.includes('_minor') || name.includes('amount'));
    assert.deepEqual(money, [], `${table} grew money columns: ${money.join(', ')}`);
    const secrets = columns.filter((name) => /credential|password|token|secret|oauth|api_key|auth/.test(name));
    assert.deepEqual(secrets, [], `${table} grew a credential column: ${secrets.join(', ')}`);
    assert.ok(columns.includes('workspace_id'), `${table} lost §H-TENANT`);
  }
});

test('E06: the drafting engine reaches no posting path, no transport, and exports no send verb', () => {
  const files = readdirSync(DRAFTING_DIR).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 3, `only ${files.length} engine files found: the probe is aimed wrong`);
  const forbidden = [
    /from '.*ledger\//,
    /from '.*payments\//,
    /\bpostEntry\b\s*\(/,
    /\brecordPayment\b\s*\(/,
    /from 'node:http'/,
    /from 'node:https'/,
    /from 'node:net'/,
    /from 'node:tls'/,
    /from 'node:dgram'/,
    /from 'node:dns'/,
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /\bWebSocket\b/,
    /from '.*axios/,
    /from '.*undici/,
    /require\(.*http/i,
    /emailRelay/,
    /from '.*nodemailer/,
    /from '.*smtp/i,
  ];
  for (const file of files) {
    const source = readFileSync(`${DRAFTING_DIR}${file}`, 'utf8');
    for (const pattern of forbidden) {
      assert.equal(pattern.test(source), false, `${file} matches ${pattern}: the OP6/money boundary is crossed`);
    }
    for (const match of source.matchAll(/export (?:function|const) (\w+)/g)) {
      assert.equal(/send/i.test(match[1] ?? ''), false, `${file} exports a send-shaped symbol: ${match[1]}`);
    }
  }
  // Non-vacuous: the same probes find their prey where it legitimately lives.
  const payments = readFileSync(fileURLToPath(new URL('../../src/core/payments/payment.ts', import.meta.url)), 'utf8');
  assert.ok(/\bpostEntry\b\s*\(/.test(payments), 'the postEntry probe cannot find postEntry even in A14');
});

test('E06: inference is reached ONLY through E05\'s registeredRuntime, and no library is named', () => {
  const draft = readFileSync(`${DRAFTING_DIR}draft.ts`, 'utf8');
  assert.ok(
    /registeredRuntime[\s\S]*from '\.\.\/voice\/index\.js'/.test(draft) ||
      /from '\.\.\/voice\/index\.js'/.test(draft),
    'draft.ts no longer consumes the E05 seam through the voice barrel',
  );
  // Never the runtime internals directly, and never an inference library by name.
  for (const file of readdirSync(DRAFTING_DIR).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(`${DRAFTING_DIR}${file}`, 'utf8');
    assert.equal(/from '\.\.\/voice\/runtime\.js'/.test(source), false, `${file} bypasses the voice barrel`);
    for (const pattern of [/from '.*node-llama/, /from '.*llama\.cpp/, /from '.*@mlx/, /from '.*onnxruntime/, /from '.*transformers/, /from '.*ollama/i, /from '.*openai/i, /from '.*@anthropic/i]) {
      assert.equal(pattern.test(source), false, `${file} names an inference library: ${pattern}`);
    }
  }
});

test('E06 G01: both writes are denied to automation and no draft event exists (the empty surface)', () => {
  const denied = [...NOT_AUTOMATABLE];
  assert.ok(denied.includes('draft_generate'), 'a stored rule may fire draft_generate: E04\'s mail_draft_write denial is decorative');
  assert.ok(denied.includes('draft_regenerate'));
  assert.deepEqual(eventsEmittedBy('draft_generate'), [], 'draft_generate grew an automation event');
  assert.deepEqual(eventsEmittedBy('draft_regenerate'), [], 'draft_regenerate grew an automation event');
});

test('E06 A24: the writes gate on draft.write, the read on mail.read', () => {
  assert.deepEqual(requiredCapabilitiesFor('draft_generate', {}), ['draft.write']);
  assert.deepEqual(requiredCapabilitiesFor('draft_regenerate', {}), ['draft.write']);
  assert.deepEqual(requiredCapabilitiesFor('draft_list', {}), ['mail.read']);
});

test('E06 §6b: draft_run is not OP3-registered, so nothing can attach to it', () => {
  const kinds = new Set(ENTITY_KINDS.map((k) => k.kind));
  const tables = new Set(ENTITY_KINDS.map((k) => k.table));
  for (const table of DRAFTING_TABLES) {
    assert.equal(kinds.has(table), false, `${table} entered the OP3 entity registry: §6b declares this surface closed`);
    assert.equal(tables.has(table), false, `${table} is targeted by a registered entity kind`);
  }
  assert.equal(kinds.has('mail_thread'), true, 'the registry probe cannot see mail_thread: it is aimed wrong');
});

test('E06 erasure-coverage drift guard: the draft-run purge is inside the anonymise transaction, before the mail purge', () => {
  const draft = readFileSync(`${DRAFTING_DIR}draft.ts`, 'utf8');
  const purge = /export function purgeDraftRunsForContact[\s\S]*$/.exec(draft)?.[0];
  assert.ok(purge !== undefined, 'purgeDraftRunsForContact vanished from draft.ts');
  assert.ok(purge.includes('draft_run'), 'the purge no longer names draft_run');

  const c00 = readFileSync(fileURLToPath(new URL('../../src/core/sales/contactMerge.ts', import.meta.url)), 'utf8');
  const txBlock = /const tx = ctx\.store\.db\.transaction\(\(\) => \{[\s\S]*?\}\);\s*tx\(\);/.exec(
    /export function anonymiseContact[\s\S]*$/.exec(c00)?.[0] ?? '',
  )?.[0];
  assert.ok(txBlock !== undefined, 'the anonymise transaction block was not found');
  assert.ok(txBlock.includes('purgeDraftRunsForContact'), 'the draft-run purge is not inside the anonymise transaction');
  assert.ok(
    txBlock.indexOf('purgeDraftRunsForContact') < txBlock.indexOf('purgeMailForContact'),
    'the draft-run purge must run BEFORE the mail purge: it needs the mail_thread rows to find its own',
  );
});

test('E06: there is no draft_send tool, and erasure has one entry point', () => {
  assert.equal(getAction('draft_send'), undefined, 'a send verb entered the cluster: P8 by construction is broken');
  assert.equal(getAction('draft_purge'), undefined, 'erasure has ONE entry point: C00 contacts_anonymise');
});
