/**
 * D166 point 8 (owner, 14.10.2026): the first run adopts an existing TILL book WITHOUT a terminal.
 *
 *   - `resolveDbPath`: TILL_DB_PATH, else the adopted book in `<support dir>/book.json`, else the
 *     default; a book.json that is a symlink, writable by others, or names a missing file is ignored;
 *   - `probeBook`: read-only, refuses a missing file, a directory, a non-SQLite file, SQLite without
 *     the TILL tables and a newer generation, and accepts a real TILL book;
 *   - `adoptBook`: every refusal, a 0600 book.json on success, and the book file never touched;
 *   - the door `POST /studio/adopt-book`: the human seat, JSON only, `{ ok: true, restarting: true }`
 *     with the restart strictly AFTER the answer, a refusal never restarts, served mode has no door,
 *     and a `till up` with no way to restart says so instead of pretending.
 *
 * Every book here is synthetic: created in a fresh temp directory by the real store, never derived
 * from a real install.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import Database from 'better-sqlite3';

import { ADOPTED_BOOK_FILE, MEMORY_DB, defaultDbPath, readAdoptedBookPath, resolveDbChoice, resolveDbPath } from '../../dist/api/db-path.js';
import { adoptBook, forgetBook, guaranteedColumns, probeBook, TILL_BOOK_REQUIRED_COLUMNS } from '../../dist/api/book-adopt.js';
import { makeApiDeps } from '../../dist/api/mcp.js';
import { ACTIONS } from '../../dist/api/registry.js';
import { ADDITIVE_COLUMNS, SCHEMA_GENERATION } from '../../dist/core/store/schema.js';
import { createStudioDoorHandler, STUDIO_ADOPT_PATH, STUDIO_FORGET_PATH } from '../../dist/api/studio-door.js';
import { fixedStudioKey } from '../../dist/api/studio-key-store.js';
import { startUp } from '../../dist/api/up.js';
import { getDeliveryRuntime, resetDeliveryRuntime } from '../../dist/api/runtime-state.js';
import { mintStudioKey, studioHeaders } from './studio-key-support.mjs';

const posix = process.platform !== 'win32';
const tmp = (label) => mkdtempSync(join(tmpdir(), `till-adopt-${label}-`));

/** A real TILL book, made by the real store in a fresh temp directory, then closed. */
function makeBook(label = 'book') {
  const dir = tmp(label);
  const path = join(dir, 'till.db');
  const { store } = makeApiDeps(path);
  store.close();
  return realpathSync(path); // adopt records the real path (macOS tmp is a symlink into /private)
}

function fingerprint(path) {
  const st = statSync(path);
  return { size: st.size, mtimeMs: st.mtimeMs, sha: createHash('sha256').update(readFileSync(path)).digest('hex') };
}

function writeBookJson(supportDir, dbPath, mode = 0o600) {
  const file = join(supportDir, ADOPTED_BOOK_FILE);
  writeFileSync(file, JSON.stringify({ dbPath }), { mode });
  chmodSync(file, mode);
  return file;
}

const NO_PIN = {}; // an environment with no TILL_DB_PATH

// --- resolveDbPath ---------------------------------------------------------------------------------

test('D166.8 resolveDbPath: TILL_DB_PATH wins over an adopted book', () => {
  const support = tmp('pin');
  writeBookJson(support, makeBook());
  assert.equal(resolveDbPath({ TILL_DB_PATH: '/tmp/pinned.db', TILL_SUPPORT_DIR: support }), '/tmp/pinned.db');
});

test('D166.8 resolveDbPath: the adopted book wins over the default', () => {
  const support = tmp('adopted');
  const book = makeBook();
  writeBookJson(support, book);
  assert.equal(resolveDbPath({ TILL_SUPPORT_DIR: support }), book);
  assert.equal(readAdoptedBookPath({ TILL_SUPPORT_DIR: support }), book);
});

test('D166.8 resolveDbPath: no book.json means the default', () => {
  assert.equal(resolveDbPath({ TILL_SUPPORT_DIR: tmp('empty') }), defaultDbPath());
});

test('D166.8 resolveDbPath: a symlinked book.json is ignored', { skip: !posix }, () => {
  const support = tmp('symlink');
  const elsewhere = tmp('elsewhere');
  const real = writeBookJson(elsewhere, makeBook());
  symlinkSync(real, join(support, ADOPTED_BOOK_FILE));
  assert.equal(resolveDbPath({ TILL_SUPPORT_DIR: support }), defaultDbPath());
});

test('D166.8 resolveDbPath: a group- or world-writable book.json is ignored', { skip: !posix }, () => {
  for (const mode of [0o620, 0o602]) {
    const support = tmp('writable');
    writeBookJson(support, makeBook(), mode);
    assert.equal(resolveDbPath({ TILL_SUPPORT_DIR: support }), defaultDbPath(), `mode ${mode.toString(8)}`);
  }
});

test('D166.8 resolveDbPath: a relative path or malformed JSON is no record, so the default', () => {
  const relative = tmp('relative');
  writeBookJson(relative, 'books/till.db');
  assert.equal(resolveDbPath({ TILL_SUPPORT_DIR: relative }), defaultDbPath());

  const malformed = tmp('malformed');
  writeFileSync(join(malformed, ADOPTED_BOOK_FILE), '{ not json', { mode: 0o600 });
  assert.equal(resolveDbPath({ TILL_SUPPORT_DIR: malformed }), defaultDbPath());
});

test('D166.8 critic F1: a vanished adopted book is reported unavailable and resolves to :memory:, never to the default', () => {
  const gone = tmp('gone');
  const missing = join(tmp('nothing'), 'till.db');
  writeBookJson(gone, missing);
  const env = { TILL_SUPPORT_DIR: gone };
  assert.deepEqual(resolveDbChoice(env), { path: MEMORY_DB, source: 'adopted', adoptedUnavailable: { path: missing, reason: 'missing' } });
  assert.equal(resolveDbPath(env), MEMORY_DB);
  assert.equal(readAdoptedBookPath(env), missing, 'the record still names the book');
  assert.deepEqual(resolveDbChoice({ TILL_SUPPORT_DIR: tmp('none') }), { path: defaultDbPath(), source: 'default' });
  assert.deepEqual(resolveDbChoice({ TILL_DB_PATH: '/pinned/till.db', TILL_SUPPORT_DIR: gone }), { path: '/pinned/till.db', source: 'env' });
});

// --- probeBook -------------------------------------------------------------------------------------

test('D166.8 probeBook accepts a real TILL book and names its generation', () => {
  const book = makeBook();
  const probe = probeBook(book);
  assert.equal(probe.ok, true);
  assert.equal(probe.generation, SCHEMA_GENERATION);
});

test('D166.8 probeBook refuses a missing file, a directory, a non-SQLite file and SQLite without the TILL tables', () => {
  const dir = tmp('probe');
  assert.deepEqual(probeBook(join(dir, 'missing.db')), { ok: false, error: 'book_not_found' });
  mkdirSync(join(dir, 'folder.db'));
  assert.deepEqual(probeBook(join(dir, 'folder.db')), { ok: false, error: 'not_a_till_database' });
  writeFileSync(join(dir, 'notes.db'), 'this is not a database, just some synthetic text\n'.repeat(50));
  assert.deepEqual(probeBook(join(dir, 'notes.db')), { ok: false, error: 'not_a_till_database' });
  const other = join(dir, 'other.db');
  const db = new Database(other);
  db.exec('CREATE TABLE recipe (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE account (id TEXT);');
  db.close();
  assert.deepEqual(probeBook(other), { ok: false, error: 'not_a_till_database' });
});

test('D166.8 probeBook refuses a book a newer TILL wrote, and leaves it unchanged', () => {
  const book = makeBook('newer');
  const db = new Database(book);
  db.pragma(`user_version = ${SCHEMA_GENERATION + 1}`);
  db.close();
  const before = fingerprint(book);
  assert.deepEqual(probeBook(book), { ok: false, error: 'schema_newer_than_runtime' });
  assert.deepEqual(fingerprint(book), before);
});

test('D166.8 critic F2: the guaranteed columns come from the base schema, minus what is added on open', () => {
  for (const table of ['workspace', 'account', 'journal_entry']) {
    const required = TILL_BOOK_REQUIRED_COLUMNS[table];
    assert.deepEqual(required, guaranteedColumns(table));
    assert.ok(required.includes('id'), `${table} requires id`);
    for (const { column } of ADDITIVE_COLUMNS.filter((c) => c.table === table)) {
      assert.equal(required.includes(column), false, `${table}.${column} is added on open, so an old book may lack it`);
    }
  }
  assert.ok(TILL_BOOK_REQUIRED_COLUMNS.workspace.includes('created_at'));
  assert.ok(TILL_BOOK_REQUIRED_COLUMNS.account.includes('workspace_id'));
  assert.ok(TILL_BOOK_REQUIRED_COLUMNS.journal_entry.includes('status'));
  for (const constraint of ['UNIQUE', 'PRIMARY', 'FOREIGN', 'CHECK']) {
    assert.equal(TILL_BOOK_REQUIRED_COLUMNS.account.includes(constraint), false);
  }
});

test('D166.8 critic F2 (probe P2): a foreign SQLite with lookalike table names is refused, and left unchanged', () => {
  const support = tmp('support');
  const foreign = join(tmp('foreign'), 'other-app.sqlite');
  const db = new Database(foreign);
  db.exec("CREATE TABLE workspace(x TEXT); CREATE TABLE account(y TEXT); CREATE TABLE journal_entry(z TEXT); INSERT INTO account VALUES ('synthetic');");
  db.close();
  const before = fingerprint(foreign);
  assert.deepEqual(probeBook(foreign), { ok: false, error: 'not_a_till_database' });
  assert.deepEqual(adoptBook(support, foreign, { env: NO_PIN }), { ok: false, error: 'not_a_till_database' });
  assert.equal(existsSync(join(support, ADOPTED_BOOK_FILE)), false);
  assert.deepEqual(fingerprint(foreign), before);
});

test('D166.8 a book this user may not read and write is named unreadable, not "not a TILL book"', { skip: !posix || process.getuid?.() === 0 }, () => {
  const book = makeBook('perm');
  chmodSync(book, 0o000);
  try {
    assert.deepEqual(probeBook(book), { ok: false, error: 'book_unreadable' });
  } finally {
    chmodSync(book, 0o600);
  }
});

// --- forgetBook ------------------------------------------------------------------------------------

test('D166.8 forgetBook removes book.json only, never the book; pinned is refused; absent is already forgotten', () => {
  const support = tmp('forget');
  const book = makeBook();
  const before = fingerprint(book);
  assert.equal(adoptBook(support, book, { env: NO_PIN }).ok, true);
  assert.deepEqual(forgetBook(support, { env: { TILL_DB_PATH: '/pinned/till.db' } }), { ok: false, error: 'book_path_pinned' });
  assert.equal(existsSync(join(support, ADOPTED_BOOK_FILE)), true);
  assert.deepEqual(forgetBook(support, { env: NO_PIN }), { ok: true });
  assert.equal(existsSync(join(support, ADOPTED_BOOK_FILE)), false);
  assert.deepEqual(fingerprint(book), before, 'the book file is untouched');
  assert.equal(resolveDbPath({ TILL_SUPPORT_DIR: support }), defaultDbPath());
  assert.deepEqual(forgetBook(support, { env: NO_PIN }), { ok: true });
});

test('D166.8 forgetBook fails closed when book.json cannot be removed', { skip: !posix || process.getuid?.() === 0 }, () => {
  const support = tmp('forget-ro');
  assert.equal(adoptBook(support, makeBook(), { env: NO_PIN }).ok, true);
  chmodSync(support, 0o500);
  try {
    assert.deepEqual(forgetBook(support, { env: NO_PIN }), { ok: false, error: 'book_not_forgotten' });
  } finally {
    chmodSync(support, 0o700);
  }
  assert.equal(existsSync(join(support, ADOPTED_BOOK_FILE)), true);
});

// --- adoptBook -------------------------------------------------------------------------------------

test('D166.8 adoptBook records the book owner-only in book.json and never touches the book file', () => {
  const support = tmp('ok');
  const book = makeBook();
  const before = fingerprint(book);
  const result = adoptBook(support, book, { env: NO_PIN, openPath: ':memory:' });
  assert.deepEqual(result, { ok: true, dbPath: book });
  const file = join(support, ADOPTED_BOOK_FILE);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).dbPath, book);
  if (posix) assert.equal(lstatSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fingerprint(book), before, 'the adopted book is byte-for-byte unchanged');
  assert.equal(resolveDbPath({ TILL_SUPPORT_DIR: support }), book, 'the next start opens it');
});

test('D166.8 adoptBook refusals: pinned, not absolute, not found, not a book, newer, already open; none writes book.json', () => {
  const support = tmp('refuse');
  const book = makeBook();
  const newer = makeBook('newer');
  const db = new Database(newer);
  db.pragma(`user_version = ${SCHEMA_GENERATION + 1}`);
  db.close();
  const junk = join(tmp('junk'), 'junk.db');
  writeFileSync(junk, 'synthetic junk');

  const cases = [
    [adoptBook(support, book, { env: { TILL_DB_PATH: '/pinned/till.db' } }), 'book_path_pinned'],
    [adoptBook(support, 'relative/till.db', { env: NO_PIN }), 'book_path_not_absolute'],
    [adoptBook(support, 42, { env: NO_PIN }), 'book_path_not_absolute'],
    [adoptBook(support, '', { env: NO_PIN }), 'book_path_not_absolute'],
    [adoptBook(support, join(tmp('none'), 'till.db'), { env: NO_PIN }), 'book_not_found'],
    [adoptBook(support, junk, { env: NO_PIN }), 'not_a_till_database'],
    [adoptBook(support, newer, { env: NO_PIN }), 'schema_newer_than_runtime'],
    [adoptBook(support, book, { env: NO_PIN, openPath: book }), 'book_already_open'],
  ];
  for (const [result, code] of cases) assert.deepEqual(result, { ok: false, error: code });
  assert.equal(existsSync(join(support, ADOPTED_BOOK_FILE)), false);
});

test('D166.8 adoptBook answers book_not_saved when the support directory cannot be written', { skip: !posix || process.getuid?.() === 0 }, () => {
  const support = tmp('readonly');
  chmodSync(support, 0o500);
  try {
    assert.deepEqual(adoptBook(support, makeBook(), { env: NO_PIN }), { ok: false, error: 'book_not_saved' });
  } finally {
    chmodSync(support, 0o700);
  }
});

// --- the door, as a unit: the restart comes strictly after the answer -------------------------------

function fakeReq({ headers = {}, body = '' } = {}) {
  const req = Readable.from(body === '' ? [] : [Buffer.from(body)]);
  req.method = 'POST';
  req.url = STUDIO_ADOPT_PATH;
  req.headers = headers;
  return req;
}

function fakeRes(events) {
  const res = new EventEmitter();
  res.headersSent = false;
  res.writeHead = (status) => {
    res.statusCode = status;
    res.headersSent = true;
    return res;
  };
  res.end = (chunk) => {
    res.body = JSON.parse(String(chunk));
    events.push('answered');
  };
  return res;
}

test('D166.8 door unit: success answers {ok:true,restarting:true} and restarts exactly once, only after the answer is flushed', async () => {
  const key = mintStudioKey();
  const events = [];
  const adopted = [];
  const handler = createStudioDoorHandler({
    keys: fixedStudioKey(key),
    devices: { accepts: () => false },
    openStudio: () => {},
    baseUrl: () => null,
    adoptBook: (path) => {
      adopted.push(path);
      return { ok: true, dbPath: path };
    },
    restart: () => events.push('restart'),
  });
  const res = fakeRes(events);
  const req = fakeReq({ headers: { 'content-type': 'application/json', ...studioHeaders(key) }, body: JSON.stringify({ path: '/books/till.db' }) });
  assert.equal(await handler(req, res), true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, restarting: true });
  assert.deepEqual(adopted, ['/books/till.db']);
  assert.deepEqual(events, ['answered'], 'nothing restarts before the response has been flushed');
  res.emit('finish');
  res.emit('close');
  assert.deepEqual(events, ['answered', 'restart'], 'restarted exactly once, after the flush');
});

test('D166.8 door unit: a refusal answers its code and never restarts', async () => {
  const key = mintStudioKey();
  const events = [];
  const handler = createStudioDoorHandler({
    keys: fixedStudioKey(key),
    devices: { accepts: () => false },
    openStudio: () => {},
    baseUrl: () => null,
    adoptBook: () => ({ ok: false, error: 'not_a_till_database' }),
    restart: () => events.push('restart'),
  });
  const res = fakeRes(events);
  await handler(fakeReq({ headers: { 'content-type': 'application/json', ...studioHeaders(key) }, body: JSON.stringify({ path: '/x.db' }) }), res);
  res.emit('finish');
  res.emit('close');
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { ok: false, error: 'not_a_till_database' });
  assert.deepEqual(events, ['answered']);
});

// --- the door, end to end on a real `till up` ----------------------------------------------------------

function studioFixture() {
  const dir = tmp('studio');
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>TILL Studio</title><div id="root"></div>');
  return dir;
}

async function withUp(run, { onRestartRequested, servedMode, dbPath = ':memory:', adoptedBook, supportDir = tmp('support'), log = () => {} } = {}) {
  resetDeliveryRuntime();
  const pinned = process.env.TILL_DB_PATH;
  delete process.env.TILL_DB_PATH; // the host must not look pinned to the suite runner's environment
  const handle = await startUp({
    dbPath,
    host: '127.0.0.1',
    port: 0,
    supportDir,
    studioDir: studioFixture(),
    open: false,
    tickMs: 60_000,
    openUrl: () => {},
    log,
    ...(adoptedBook !== undefined ? { adoptedBook } : {}),
    ...(onRestartRequested !== undefined ? { onRestartRequested } : {}),
    ...(servedMode !== undefined ? { servedMode } : {}),
  });
  assert.equal(handle.started, true);
  try {
    await run(handle, supportDir);
  } finally {
    await handle.close();
    if (pinned !== undefined) process.env.TILL_DB_PATH = pinned;
  }
}

const adoptCall = (handle, { headers = {}, body, contentType = 'application/json' } = {}) =>
  fetch(`${handle.url}${STUDIO_ADOPT_PATH}`, {
    method: 'POST',
    headers: { 'content-type': contentType, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
  });

test('D166.8 the adopt door needs the human seat: keyless 401, a wrong key 401, nothing recorded or restarted', async () => {
  let restarts = 0;
  await withUp(
    async (handle, supportDir) => {
      const book = makeBook();
      const keyless = await adoptCall(handle, { body: { path: book } });
      assert.equal(keyless.status, 401);
      assert.equal((await keyless.json()).error, 'studio_key_required');
      const wrong = await adoptCall(handle, { headers: studioHeaders(mintStudioKey()), body: { path: book } });
      assert.equal(wrong.status, 401);
      assert.equal((await wrong.json()).error, 'studio_key_invalid');
      assert.equal(existsSync(join(supportDir, ADOPTED_BOOK_FILE)), false);
      assert.equal(restarts, 0);
    },
    { onRestartRequested: () => restarts++ },
  );
});

test('D166.8 the adopt door refuses a body that is not application/json (400), so no other origin can send it unpreflighted', async () => {
  let restarts = 0;
  await withUp(
    async (handle, supportDir) => {
      const res = await adoptCall(handle, { headers: studioHeaders(handle.studioKey), body: JSON.stringify({ path: makeBook() }), contentType: 'text/plain' });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, 'door_body_invalid');
      assert.equal(existsSync(join(supportDir, ADOPTED_BOOK_FILE)), false);
      assert.equal(restarts, 0);
    },
    { onRestartRequested: () => restarts++ },
  );
});

test('D166.8 the adopt door: success answers restarting and calls the restart exactly once, after the answer', async () => {
  const calls = [];
  let answered = false;
  await withUp(
    async (handle, supportDir) => {
      const book = makeBook();
      const before = fingerprint(book);
      const res = await adoptCall(handle, { headers: studioHeaders(handle.studioKey), body: { path: book } });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, restarting: true });
      answered = true;
      // The restart is fired from the response's finish; give the event loop a turn to deliver it.
      for (let i = 0; i < 50 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(calls.length, 1);
      assert.equal(JSON.parse(readFileSync(join(supportDir, ADOPTED_BOOK_FILE), 'utf8')).dbPath, book);
      assert.deepEqual(fingerprint(book), before);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(calls.length, 1, 'never a second restart');
    },
    { onRestartRequested: () => calls.push(answered) },
  );
});

test('D166.8 the adopt door: a refusal answers its code and never restarts', async () => {
  let restarts = 0;
  const open = makeBook('open');
  await withUp(
    async (handle, supportDir) => {
      const junk = join(tmp('junk'), 'junk.db');
      writeFileSync(junk, 'synthetic junk');
      for (const [path, status, code] of [
        [junk, 400, 'not_a_till_database'],
        ['relative.db', 400, 'book_path_not_absolute'],
        [open, 409, 'book_already_open'],
      ]) {
        const res = await adoptCall(handle, { headers: studioHeaders(handle.studioKey), body: { path } });
        assert.equal(res.status, status, code);
        assert.deepEqual(await res.json(), { ok: false, error: code });
      }
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(restarts, 0);
      assert.equal(existsSync(join(supportDir, ADOPTED_BOOK_FILE)), false);
    },
    { onRestartRequested: () => restarts++, dbPath: open },
  );
});

test('D166.8 a till up with no way to restart answers restart_unavailable and records nothing', async () => {
  await withUp(async (handle, supportDir) => {
    const res = await adoptCall(handle, { headers: studioHeaders(handle.studioKey), body: { path: makeBook() } });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { ok: false, error: 'restart_unavailable' });
    assert.equal(existsSync(join(supportDir, ADOPTED_BOOK_FILE)), false);
  });
});

test('D166.8 served mode mounts no adopt door', async () => {
  let restarts = 0;
  await withUp(
    async (handle, supportDir) => {
      const res = await adoptCall(handle, { headers: { 'till-authenticated-subject': 'someone@example.ch' }, body: { path: makeBook() } });
      assert.notEqual(res.status, 200);
      assert.equal(existsSync(join(supportDir, ADOPTED_BOOK_FILE)), false);
      assert.equal(restarts, 0);
    },
    { onRestartRequested: () => restarts++, servedMode: { enabled: true, headerName: 'till-authenticated-subject' } },
  );
});

// --- forget-book: "Vergessen und neu beginnen" ----------------------------------------------------------

const forgetCall = (handle, headers = {}) =>
  fetch(`${handle.url}${STUDIO_FORGET_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });

test('D166.8 the forget door needs the human seat, removes book.json, keeps the book, and restarts once after the answer', async () => {
  const calls = [];
  const supportDir = tmp('support');
  const book = makeBook();
  const before = fingerprint(book);
  assert.equal(adoptBook(supportDir, book, { env: NO_PIN }).ok, true);
  await withUp(
    async (handle) => {
      const keyless = await forgetCall(handle);
      assert.equal(keyless.status, 401);
      assert.equal(existsSync(join(supportDir, ADOPTED_BOOK_FILE)), true);
      const res = await forgetCall(handle, studioHeaders(handle.studioKey));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, restarting: true });
      for (let i = 0; i < 50 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(calls.length, 1);
      assert.equal(existsSync(join(supportDir, ADOPTED_BOOK_FILE)), false);
      assert.deepEqual(fingerprint(book), before, 'the book file is never touched');
    },
    { onRestartRequested: () => calls.push(1), supportDir },
  );
});

test('D166.8 the forget door fails closed: book.json that cannot go answers book_not_forgotten and never restarts', { skip: !posix || process.getuid?.() === 0 }, async () => {
  let restarts = 0;
  const supportDir = tmp('support');
  assert.equal(adoptBook(supportDir, makeBook(), { env: NO_PIN }).ok, true);
  await withUp(
    async (handle) => {
      chmodSync(supportDir, 0o500);
      try {
        const res = await forgetCall(handle, studioHeaders(handle.studioKey));
        assert.equal(res.status, 500);
        assert.deepEqual(await res.json(), { ok: false, error: 'book_not_forgotten' });
      } finally {
        chmodSync(supportDir, 0o700);
      }
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(restarts, 0);
      assert.equal(existsSync(join(supportDir, ADOPTED_BOOK_FILE)), true);
    },
    { onRestartRequested: () => restarts++, supportDir },
  );
});

// --- till up with an adopted book it cannot open (critic F1/F2) ----------------------------------------

async function deliveryStatus(handle) {
  const res = await fetch(`${handle.url}/api/delivery_status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...studioHeaders(handle.studioKey) },
    body: '{}',
  });
  return res.json();
}

test('D166.8 critic F1: till up with a MISSING adopted book runs on :memory:, reports it, and runs no cadence', async () => {
  const missing = join(tmp('gone'), 'till.db');
  const lines = [];
  await withUp(
    async (handle) => {
      const status = await deliveryStatus(handle);
      assert.deepEqual(status.adoptedBookUnavailable, { path: missing, reason: 'missing' });
      assert.equal(status.dbPath, MEMORY_DB);
      assert.equal(status.scheduler.enabled, false, 'no cadence runs against the stand-in book');
      assert.equal(existsSync(missing), false, 'nothing was created where the book was');
      assert.ok(lines.some((l) => l.includes(missing)), 'the log names the adopted book');
    },
    { dbPath: MEMORY_DB, adoptedBook: { path: missing, unavailable: 'missing' }, onRestartRequested: () => {}, log: (l) => lines.push(l) },
  );
  assert.equal(getDeliveryRuntime().adoptedBookUnavailable, null, 'close resets the state');
});

test('D166.8 critic F2: till up with an adopted file that is not a TILL book starts, reports it unopenable, and never writes to it', async () => {
  const foreign = join(tmp('foreign'), 'other-app.sqlite');
  const db = new Database(foreign);
  db.exec("CREATE TABLE workspace(x TEXT); CREATE TABLE account(y TEXT); CREATE TABLE journal_entry(z TEXT); INSERT INTO account VALUES ('synthetic');");
  db.close();
  const before = fingerprint(foreign);
  for (let attempt = 0; attempt < 2; attempt++) {
    await withUp(
      async (handle) => {
        const status = await deliveryStatus(handle);
        assert.deepEqual(status.adoptedBookUnavailable, { path: foreign, reason: 'unopenable' });
        assert.equal(status.dbPath, MEMORY_DB);
        assert.equal(status.scheduler.enabled, false);
      },
      { dbPath: foreign, adoptedBook: { path: foreign }, onRestartRequested: () => {} },
    );
  }
  assert.deepEqual(fingerprint(foreign), before, 'not a byte written, not even a WAL header');
  assert.equal(existsSync(`${foreign}-wal`), false);
});

test('D166.8 an adopted book that becomes available again opens normally, and the state is clear', async () => {
  const book = makeBook();
  await withUp(
    async (handle) => {
      const status = await deliveryStatus(handle);
      assert.equal(status.adoptedBookUnavailable, null);
      assert.equal(status.dbPath, book);
      assert.equal(status.scheduler.enabled, true);
    },
    { dbPath: book, adoptedBook: { path: book }, onRestartRequested: () => {} },
  );
});

test('D166.8 a refused open of a book that was NOT adopted still fails till up, as before', async () => {
  const junk = join(tmp('junk'), 'junk.db');
  writeFileSync(junk, 'synthetic junk, not a database '.repeat(40));
  resetDeliveryRuntime();
  await assert.rejects(
    startUp({ dbPath: junk, host: '127.0.0.1', port: 0, supportDir: tmp('support'), studioDir: null, open: false, log: () => {} }),
  );
});

// --- the critic's CLI probes, ported to assert the FIXED behaviour (origin/critic/d166-adopt-book) -------

const BIN = fileURLToPath(new URL('../../bin/till.mjs', import.meta.url));
const realTmp = (label) => realpathSync(tmp(label));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** An isolated environment: temp HOME (so the default book is under it), temp support dir, no pin. */
function isolatedEnv(extra = {}) {
  const home = realTmp('home');
  const support = join(home, '.till');
  mkdirSync(support, { recursive: true, mode: 0o700 });
  const env = { ...process.env, HOME: home, TILL_SUPPORT_DIR: support, TILL_NO_OPEN: '1', ...extra };
  delete env.TILL_DB_PATH;
  delete env.TILL_SUPERVISED;
  return { home, support, env };
}

/** Run a CLI face until `until` matches its stderr (or it exits), then return what it printed. */
function runCli(args, env, { until, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let done = false;
    const finish = (how) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ child, stderr, how });
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (until !== undefined && until.test(stderr)) finish('matched');
    });
    child.on('exit', (code) => finish(`exit:${code}`));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function stop(child) {
  child.kill('SIGTERM');
  for (let i = 0; i < 50 && alive(child.pid); i++) await sleep(100);
}

test('P1 fixed: with the adopted book gone, till mcp refuses in one sentence naming it, and creates no default book', { skip: !posix }, async () => {
  const { home, support, env } = isolatedEnv();
  const book = realpathSync(makeBook('external'));
  assert.equal(adoptBook(support, book, { env: {} }).ok, true);
  renameSync(book, `${book}.moved`);
  const { child, stderr, how } = await runCli(['mcp'], env);
  if (alive(child.pid)) await stop(child);
  assert.equal(how, 'exit:1', stderr);
  assert.ok(stderr.includes(book), 'the adopted book is named');
  assert.match(stderr, /not reachable/);
  assert.match(stderr, /Open TILL/);
  assert.equal(stderr.trim().split('\n').length, 1, 'one plain sentence');
  assert.equal(existsSync(join(home, '.till', 'till.db')), false, 'no default book was created');
  assert.equal(existsSync(join(support, ADOPTED_BOOK_FILE)), true);
});

test('P1b fixed: with the adopted book gone, till up starts on nothing, names the book, and never opens the default', { skip: !posix }, async () => {
  const { home, support, env } = isolatedEnv({ TILL_STUDIO_DIR: studioFixture() });
  const book = realpathSync(makeBook('external'));
  assert.equal(adoptBook(support, book, { env: {} }).ok, true);
  renameSync(book, `${book}.moved`);
  const port = await freePort();
  const { child, stderr, how } = await runCli(['up'], { ...env, TILL_PORT: String(port) }, { until: /MCP over HTTP at/ });
  try {
    assert.equal(how, 'matched', stderr);
    const lock = JSON.parse(readFileSync(join(support, 'up.lock'), 'utf8'));
    assert.notEqual(lock.dbPath, join(home, '.till', 'till.db'), 'the running Studio is not on the default book');
    assert.ok(stderr.includes(book), 'the adopted book is named');
    assert.match(stderr, /not reachable/);
    assert.equal(existsSync(join(home, '.till', 'till.db')), false, 'no default book was created');
  } finally {
    await stop(child);
  }
});

test('P3 fixed: an adopted book that became unreadable no longer stops till up; it reports it and stays up', { skip: !posix || process.getuid?.() === 0 }, async () => {
  const { support, env } = isolatedEnv({ TILL_STUDIO_DIR: studioFixture() });
  const book = realpathSync(makeBook('perm'));
  assert.equal(adoptBook(support, book, { env: {} }).ok, true);
  chmodSync(book, 0o000);
  try {
    const port = await freePort();
    const { child, stderr, how } = await runCli(['up'], { ...env, TILL_PORT: String(port) }, { until: /MCP over HTTP at/ });
    try {
      assert.equal(how, 'matched', stderr);
      assert.ok(stderr.includes(book), 'the adopted book is named');
    } finally {
      await stop(child);
    }
  } finally {
    chmodSync(book, 0o600);
  }
});

test('P4: the real CLI adopts, hands over to a detached successor on the adopted book, one live till up', { skip: !posix }, async () => {
  const { support, env } = isolatedEnv({ TILL_STUDIO_DIR: studioFixture() });
  const book = realpathSync(makeBook('target'));
  const port = await freePort();
  const first = await runCli(['up'], { ...env, TILL_PORT: String(port) }, { until: /MCP over HTTP at/ });
  assert.equal(first.how, 'matched', first.stderr);
  let successorPid = null;
  try {
    const key = readFileSync(join(support, 'studio.key'), 'utf8').trim();
    const firstPid = first.child.pid;
    const exited = new Promise((r) => first.child.on('exit', (code) => r(code)));
    const res = await fetch(`http://127.0.0.1:${port}/studio/adopt-book`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-till-studio-key': key },
      body: JSON.stringify({ path: book }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, restarting: true });
    assert.equal(await exited, 0);
    let lock = null;
    for (let i = 0; i < 300; i++) {
      await sleep(100);
      try {
        lock = JSON.parse(readFileSync(join(support, 'up.lock'), 'utf8'));
      } catch {
        lock = null;
      }
      if (lock !== null && lock.pid !== firstPid && alive(lock.pid) && lock.port === port) break;
    }
    assert.ok(lock !== null && lock.pid !== firstPid, 'a successor holds the lock');
    successorPid = lock.pid;
    assert.equal(lock.dbPath, book, 'the successor opened the adopted book');
    for (let i = 0; i < 300; i++) {
      const up = await fetch(`http://127.0.0.1:${port}/studio/prove`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce: 'regression-probe-nonce-0123456789' }),
      }).then(
        () => true,
        () => false,
      );
      if (up) break;
      await sleep(100);
    }
    const again = await fetch(`http://127.0.0.1:${port}/studio/adopt-book`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-till-studio-key': key },
      body: JSON.stringify({ path: book }),
    });
    assert.deepEqual(await again.json(), { ok: false, error: 'book_already_open' });
    const second = await runCli(['up'], { ...env, TILL_PORT: String(port) }, { until: /already running|MCP over HTTP at/ });
    assert.match(second.stderr, /already running/);
    await stop(second.child);
  } finally {
    if (alive(first.child.pid)) await stop(first.child);
    if (successorPid !== null && alive(successorPid)) process.kill(successorPid, 'SIGTERM');
    for (let i = 0; i < 50 && successorPid !== null && alive(successorPid); i++) await sleep(100);
  }
});

// --- critic round 2 (origin/critic/d166-adopt-book-r2), ported to assert the FIXED behaviour --------------

/** A foreign SQLite that only shares the three table names (the critic's lookalike). */
function lookalike(path) {
  const db = new Database(path);
  db.exec("CREATE TABLE workspace(x TEXT); CREATE TABLE account(y TEXT); CREATE TABLE journal_entry(z TEXT); INSERT INTO account VALUES ('synthetic');");
  db.close();
}

async function agentClient(url) {
  const agent = new McpClient({ name: 'some-agent', version: '0.0.0' }, { capabilities: {} });
  await agent.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  return agent;
}

test('N1 the chokepoint: while the adopted book is unavailable, EVERY registry verb but delivery_status is refused on BOTH faces', async () => {
  const missing = join(tmp('gone'), 'till.db');
  const names = ACTIONS.map((a) => a.name);
  assert.ok(names.length > 100, `the whole registry (${names.length} verbs)`);
  assert.ok(names.includes('delivery_status') && names.includes('create_workspace') && names.includes('post_entry'));
  const check = (face, name, body) => {
    if (name === 'delivery_status') {
      assert.equal(body.ok, true, `${face} ${name}`);
      assert.deepEqual(body.adoptedBookUnavailable, { path: missing, reason: 'missing' });
      return;
    }
    assert.equal(body.ok, false, `${face} ${name} must be refused`);
    assert.equal(body.error, 'adopted_book_unavailable', `${face} ${name}: ${JSON.stringify(body).slice(0, 200)}`);
    assert.equal(body.path, missing);
    assert.equal(body.reason, 'missing');
    assert.match(body.message, /not reachable/);
  };
  await withUp(
    async (handle) => {
      for (const name of names) {
        const res = await fetch(`${handle.url}/api/${name}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...studioHeaders(handle.studioKey) },
          body: '{}',
        });
        check('REST', name, await res.json());
      }
      const agent = await agentClient(handle.url);
      try {
        for (const name of names) {
          const res = await agent.callTool({ name, arguments: {} });
          check('MCP', name, JSON.parse(res.content[0].text));
        }
      } finally {
        await agent.close();
      }
    },
    { dbPath: MEMORY_DB, adoptedBook: { path: missing, unavailable: 'missing' }, onRestartRequested: () => {} },
  );
});

test('N1 (probe R5) fixed: an agent seat cannot create a workspace in the stand-in book, so the Studio has nothing to land in', async () => {
  const missing = join(tmp('gone'), 'till.db');
  await withUp(
    async (handle) => {
      const agent = await agentClient(handle.url);
      let created;
      try {
        const res = await agent.callTool({ name: 'create_workspace', arguments: { name: 'Synthetisch AG', idempotencyKey: 'n1-ws' } });
        created = JSON.parse(res.content[0].text);
      } finally {
        await agent.close();
      }
      assert.equal(created.ok, false);
      assert.equal(created.error, 'adopted_book_unavailable');
      const count = handle.store.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n;
      assert.equal(count, 0, 'nothing was written into the stand-in');
    },
    { dbPath: MEMORY_DB, adoptedBook: { path: missing, unavailable: 'missing' }, onRestartRequested: () => {} },
  );
});

test('N1: a till up whose adopted book IS open refuses nothing (the chokepoint is inert)', async () => {
  const book = makeBook();
  await withUp(
    async (handle) => {
      const res = await fetch(`${handle.url}/api/list_workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...studioHeaders(handle.studioKey) },
        body: '{}',
      });
      assert.equal((await res.json()).ok, true);
    },
    { dbPath: book, adoptedBook: { path: book }, onRestartRequested: () => {} },
  );
});

test('L-a fixed: the lock names the book actually opened (:memory: for the stand-in), not the one asked for', async () => {
  const foreign = join(tmp('foreign'), 'other-app.sqlite');
  lookalike(foreign);
  const supportDir = tmp('support');
  await withUp(
    async () => {
      assert.equal(JSON.parse(readFileSync(join(supportDir, 'up.lock'), 'utf8')).dbPath, MEMORY_DB);
    },
    { dbPath: foreign, adoptedBook: { path: foreign }, onRestartRequested: () => {}, supportDir },
  );
});

test('L-b / R3 fixed: a foreign file swapped in after the adoption is never written by till mcp or till serve; both refuse', { skip: !posix }, async () => {
  const { support, env } = isolatedEnv();
  const book = realpathSync(makeBook('swap'));
  assert.equal(adoptBook(support, book, { env: {} }).ok, true);
  renameSync(book, `${book}.orig`);
  // The real book's own WAL and shared-memory files go with it, so whatever sits beside the swapped
  // file afterwards was written by a face under test.
  for (const suffix of ['-wal', '-shm']) if (existsSync(book + suffix)) renameSync(book + suffix, `${book}.orig${suffix}`);
  lookalike(book);
  const before = fingerprint(book);
  const mcp = await runCli(['mcp'], env);
  if (alive(mcp.child.pid)) await stop(mcp.child);
  assert.equal(mcp.how, 'exit:1', mcp.stderr);
  assert.match(mcp.stderr, /cannot be opened/);
  assert.ok(mcp.stderr.includes(book));
  const serve = await runCli(['serve'], { ...env, TILL_PORT: String(await freePort()) });
  if (alive(serve.child.pid)) await stop(serve.child);
  assert.equal(serve.how, 'exit:1', serve.stderr);
  assert.deepEqual(fingerprint(book), before, 'not a byte written, not even a WAL header');
  assert.equal(existsSync(`${book}-wal`), false);
});

test('L-b / R4 fixed: a read-only (0444) adopted book gets the same answer from till up and till mcp, and the lock tells the truth', { skip: !posix || process.getuid?.() === 0 }, async () => {
  const { support, env } = isolatedEnv({ TILL_STUDIO_DIR: studioFixture() });
  const book = realpathSync(makeBook('ro'));
  assert.equal(adoptBook(support, book, { env: {} }).ok, true);
  chmodSync(book, 0o444);
  try {
    const port = await freePort();
    const up = await runCli(['up'], { ...env, TILL_PORT: String(port) }, { until: /MCP over HTTP at/ });
    try {
      assert.equal(up.how, 'matched', up.stderr);
      const key = readFileSync(join(support, 'studio.key'), 'utf8').trim();
      const status = await (
        await fetch(`http://127.0.0.1:${port}/api/delivery_status`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-till-studio-key': key },
          body: '{}',
        })
      ).json();
      assert.deepEqual(status.adoptedBookUnavailable, { path: book, reason: 'unopenable' });
      assert.equal(JSON.parse(readFileSync(join(support, 'up.lock'), 'utf8')).dbPath, MEMORY_DB);
      const mcp = await runCli(['mcp'], env);
      if (alive(mcp.child.pid)) await stop(mcp.child);
      assert.equal(mcp.how, 'exit:1', mcp.stderr);
      assert.match(mcp.stderr, /cannot be opened/);
    } finally {
      await stop(up.child);
    }
  } finally {
    chmodSync(book, 0o600);
  }
});
