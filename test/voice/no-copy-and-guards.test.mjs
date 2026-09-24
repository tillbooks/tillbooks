/**
 * E05's structural ABSENCES, asserted rather than documented (spec §4 "Money correctness", §6b,
 * §7, §8 "Compliance fixture"):
 *
 *   1. INDEX, NEVER COPY, twice over: none of the three voice tables carries a body/excerpt/raw
 *      column (read off the live PRAGMA), AND the Art. 321 sentinel fixture: after building a
 *      profile over a corpus carrying a distinctive sentinel sentence, a byte-scan of the raw
 *      SQLite FILE finds ZERO hits. That second half is what makes "index, never copy" a fact
 *      about the database rather than a claim about the schema.
 *   2. NO MONEY: zero `_rappen`/`_minor`/`amount` columns anywhere in the cluster, and the voice
 *      engine imports no posting path (`postEntry`, `recordPayment`, `ledger/`, `payments/`).
 *   3. NO SOCKET, STATICALLY: no `net`/`tls`/`http(s)`/`dgram`/`dns` import and no `fetch` call
 *      anywhere in `src/core/voice/`, and NO HTTP client in the catalog path, so "periodically
 *      refresh the models" can never quietly become a poll. (The RUNTIME half is the egress probe
 *      wrapping every voice suite.)
 *   4. THE SEAM IS THE ONLY DOOR: no module outside `src/core/voice/runtime.ts` names an inference
 *      library, and the core itself names none (it declares the interface and ships no
 *      implementation: the no-cloud-fallback property is structural).
 *   5. NO OP3 ATTACHMENT: none of the three tables is a registered entity kind, so custom fields,
 *      automation rules and plugins cannot target them (§6b: fixed unless provably leak-safe).
 *   6. ERASURE COVERAGE: `voice_exemplar` is named in the C00 anonymise transaction, and the
 *      drift guard holds the purge to E05's own table list.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installEgressProbe } from '../mail/egress-probe.mjs';

const probe = installEgressProbe();

const { getAction } = await import('../../dist/api/registry.js');
const { SqliteStore } = await import('../../dist/core/store/sqlite-store.js');
const { fixedClock } = await import('../../dist/core/clock.js');
const { sequenceIdGen } = await import('../../dist/core/ids.js');
const { VOICE_TABLES, registerRuntime } = await import('../../dist/core/voice/index.js');
const { ENTITY_KINDS } = await import('../../dist/core/customization/entities.js');
const { NOT_AUTOMATABLE } = await import('../../dist/core/automation/denylist.js');
const { tempStoreDir, makeMaildirStore, rfc822 } = await import('../mail/fixtures.mjs');
const { stubAdapter, stubManifest, outboundCorpus } = await import('./fixtures.mjs');

const VOICE_DIR = fileURLToPath(new URL('../../src/core/voice/', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../../src/', import.meta.url));

test('E05: all three voice tables exist and none carries a body, excerpt, or money column', () => {
  const store = new SqliteStore();
  assert.deepEqual([...VOICE_TABLES].sort(), ['runtime_selection', 'voice_exemplar', 'voice_profile']);
  for (const table of VOICE_TABLES) {
    const columns = store.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    assert.ok(columns.length >= 4, `PRAGMA answered nothing for ${table}: the probe is broken`);
    // `style_card` is the distilled card, not source material; the probe names copy-shaped columns.
    const bodies = columns.filter((name) => /body|excerpt|raw|content|text/.test(name));
    assert.deepEqual(bodies, [], `${table} grew a copy-shaped column: ${bodies.join(', ')} (OP6 index-never-copy)`);
    const money = columns.filter((name) => name.includes('_rappen') || name.includes('_minor') || name.includes('amount'));
    assert.deepEqual(money, [], `${table} grew money columns: ${money.join(', ')}`);
  }
  // Non-vacuous: the body probe must find a body column where one legitimately lives.
  const activity = store.db.prepare('PRAGMA table_info(contact_activity)').all().map((c) => c.name);
  assert.ok(activity.includes('body'), 'the body probe cannot see contact_activity.body: it is aimed wrong');
});

test('E05: the Art. 321 sentinel fixture: no corpus byte survives anywhere in the SQLite file', () => {
  // A sentence distinctive enough that a hit could only be a copied excerpt. It appears in every
  // outbound message of this corpus, so ANY copy path (style card, exemplar, idempotency memo,
  // stray debug column) would land it in the file at least once.
  const sentinel = 'SENTINEL-321-Fallbesprechung-vom-elften-August';
  const location = join(mkdtempSync(join(tmpdir(), 'till-voice-db-')), 'till.sqlite');
  const store = new SqliteStore({ location, clock: fixedClock('2026-07-16T00:00:00.000Z') });
  const deps = { store, clock: fixedClock('2026-07-16T00:00:00.000Z'), ids: sequenceIdGen(), actor: 'agent' };
  const created = getAction('create_workspace').run(deps, { name: 'Sentinel AG', idempotencyKey: 'ws' });
  const call = (name, input) => getAction(name).run(deps, { workspaceId: created.workspaceId, ...input });

  registerRuntime(stubAdapter(), stubManifest());
  const root = tempStoreDir('till-voice-sentinel-');
  const messages = outboundCorpus(21).map((message) => ({
    ...message,
    raw: message.raw.replace('Guten Tag', `Guten Tag ${sentinel}`),
  }));
  makeMaildirStore(root, messages);
  const account = call('mail_connect', { adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'sn-c' });
  assert.equal(account.ok, true, JSON.stringify(account));
  assert.equal(call('mail_reindex', { accountId: account.accountId, idempotencyKey: 'sn-r' }).ok, true);
  assert.equal(call('runtime_select', { modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: 'sn-s' }).ok, true);
  const built = call('voice_build', { accountId: account.accountId, idempotencyKey: 'sn-b' });
  assert.equal(built.ok, true, JSON.stringify(built));
  assert.ok(built.profile.exemplarCount >= 21);

  // Retrieval READS the sentinel back (bodies on demand from the store): the corpus is reachable...
  const got = call('voice_retrieve', { profileId: built.profileId, queryText: 'Fallbesprechung', k: 1 });
  assert.equal(got.ok, true);
  assert.match(got.items[0].body, new RegExp(sentinel), 'the fixture never planted its sentinel: the scan below proves nothing');

  // ...and the DATABASE FILE still holds zero bytes of it. WAL is checkpointed into the main file
  // first so the scan covers everything SQLite has durably written.
  store.db.pragma('wal_checkpoint(TRUNCATE)');
  store.close();
  const bytes = readFileSync(location);
  assert.equal(bytes.includes(Buffer.from(sentinel, 'utf8')), false, 'a corpus byte reached the SQLite file: index-never-copy is broken');
  assert.equal(bytes.includes(Buffer.from('Fallbesprechung', 'utf8')), false);
});

test('E05: the voice engine reaches no posting path, no transport, and exports no send verb', () => {
  const files = readdirSync(VOICE_DIR).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 4, `only ${files.length} engine files found: the probe is aimed wrong`);
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
  ];
  for (const file of files) {
    const source = readFileSync(`${VOICE_DIR}${file}`, 'utf8');
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

test('E05: no module in src/ names an inference library: the core declares the seam and ships nothing', () => {
  // The no-cloud-fallback and stays-local claims, made structural: the OSS core holds ZERO
  // inference imports anywhere (runtime.ts declares the interface; the companion package is the
  // only implementer and it is not in this repo). A grep, so a "helpful" direct import in E06 or a
  // catalog fetch dressed as a model loader reddens this file the day it lands.
  const offenders = [];
  const inferenceShaped = [
    /from '.*node-llama/,
    /from '.*llama\.cpp/,
    /from '.*@mlx/,
    /from '.*onnxruntime/,
    /from '.*transformers/,
    /from '.*ollama/i,
    /from '.*openai/i,
    /from '.*@anthropic/i,
  ];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) {
        const source = readFileSync(path, 'utf8');
        for (const pattern of inferenceShaped) {
          if (pattern.test(source)) offenders.push(`${path}: ${pattern}`);
        }
      }
    }
  };
  walk(SRC_DIR);
  assert.deepEqual(offenders, [], 'an inference library entered the MIT core: the OP6 seam is no longer the only door');
});

test('E05 §6b: none of the three voice tables is OP3-registered, so nothing can attach to them', () => {
  const kinds = new Set(ENTITY_KINDS.map((k) => k.kind));
  const tables = new Set(ENTITY_KINDS.map((k) => k.table));
  for (const table of VOICE_TABLES) {
    assert.equal(kinds.has(table), false, `${table} entered the OP3 entity registry: §6b declares this surface closed`);
    assert.equal(tables.has(table), false, `${table} is targeted by a registered entity kind`);
  }
  // Non-vacuous: E04's one registered kind is where the probe would find a registration.
  assert.equal(kinds.has('mail_thread'), true, 'the registry probe cannot see mail_thread: it is aimed wrong');
});

test('E05 G01: both writes are denied to automation, so no rule can relearn a voice or swap a model', () => {
  const denied = [...NOT_AUTOMATABLE];
  assert.ok(denied.includes('voice_build'));
  assert.ok(denied.includes('runtime_select'));
});

test('E05 erasure-coverage drift guard: the exemplar purge is inside the anonymise transaction', () => {
  const voice = readFileSync(`${VOICE_DIR}voice.ts`, 'utf8');
  const purge = /export function purgeVoiceForContact[\s\S]*$/.exec(voice)?.[0];
  assert.ok(purge !== undefined, 'purgeVoiceForContact vanished from voice.ts');
  assert.ok(purge.includes('voice_exemplar'), 'the purge no longer names voice_exemplar');

  const c00 = readFileSync(fileURLToPath(new URL('../../src/core/sales/contactMerge.ts', import.meta.url)), 'utf8');
  const txBlock = /const tx = ctx\.store\.db\.transaction\(\(\) => \{[\s\S]*?\}\);\s*tx\(\);/.exec(
    /export function anonymiseContact[\s\S]*$/.exec(c00)?.[0] ?? '',
  )?.[0];
  assert.ok(txBlock !== undefined, 'the anonymise transaction block was not found');
  assert.ok(txBlock.includes('purgeVoiceForContact'), 'the voice purge is not inside the anonymise transaction');
  assert.ok(
    txBlock.indexOf('purgeVoiceForContact') < txBlock.indexOf('purgeMailForContact'),
    'the voice purge must run BEFORE the mail purge: it needs the mail_message rows to find its own',
  );
});

test('E05: runtime.register is deliberately NOT an MCP tool, and never will be', () => {
  assert.equal(getAction('runtime_register'), undefined, 'an agent must never swap the model out from under a user (P8)');
  assert.equal(getAction('voice_purge'), undefined, 'erasure has ONE entry point: C00 contacts_anonymise');
});

test('E05 OP6: none of the above opened a socket', () => {
  assert.deepEqual(probe.violations, []);
});
