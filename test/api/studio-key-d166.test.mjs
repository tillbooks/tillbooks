/**
 * D166 (owner decision 14.10.2026): TILL opens by itself on a known device, and nobody is sent to a
 * terminal. Three layers, each of which must keep the R3-B2 property (the key never reaches a caller
 * that did not already hold it, and nothing served carries it):
 *
 *   1. the key PERSISTS owner-only in `<support dir>/studio.key` (the native TILL.app reads it) and
 *      never travels in a link: links carry ONE-TIME tickets, host-minted or derived for one process;
 *   2. a browser that redeemed a ticket pairs a device key and later unlocks session tokens with it;
 *      "Auf allen Geräten abmelden" ROTATES the key and forgets every device and token at once;
 *   3. a tab with nothing left asks `POST /studio/reopen`, and the host opens a ticket link THROUGH THE
 *      OS. No answer carries the key, a second call inside the interval is refused, and a page on
 *      another origin cannot fire it.
 *
 * Every key below is minted for the test; no fixture is derived from a real install.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import * as up from '../../dist/api/up.js';
import { resetDeliveryRuntime } from '../../dist/api/runtime-state.js';
import { openStudioKeyStore, readStudioKeyFile, studioKeyPath } from '../../dist/api/studio-key-store.js';
import {
  createReopenLimiter,
  REOPEN_MAX_PER_HOUR,
  REOPEN_MIN_INTERVAL_MS,
  STUDIO_REOPEN_HEADER,
} from '../../dist/api/studio-door.js';
import { keyShapedRuns, mintStudioKey, sessionFromLink, studioHeaders } from './studio-key-support.mjs';

const support = (label) => mkdtempSync(join(tmpdir(), `till-d165-${label}-`));

function studioFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'till-d165-studio-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><title>TILL Studio</title></head><body><div id="root"></div></body></html>');
  return dir;
}

async function startStudioUp({ supportDir = support('up'), studioDir = studioFixture(), servedMode } = {}) {
  resetDeliveryRuntime();
  const opened = [];
  const handle = await up.startUp({
    dbPath: ':memory:', host: '127.0.0.1', port: 0, supportDir, studioDir, open: false, tickMs: 60_000,
    openUrl: (url) => opened.push(url),
    ...(servedMode !== undefined ? { servedMode } : {}),
    log: () => {},
  });
  assert.equal(handle.started, true);
  return { handle, supportDir, opened };
}

function post(url, headers = {}, body = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

const reopen = (handle, headers = {}) => post(`${handle.url}/studio/reopen`, { [STUDIO_REOPEN_HEADER]: '1', ...headers });
const rotate = (handle, headers = {}, body = {}) => post(`${handle.url}/studio/rotate-key`, { 'content-type': 'application/json', ...headers }, body);

const initialize = (name) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name, version: '0.0.0' } },
});

// --- layer 1: the key store ------------------------------------------------------------------------

test('D166 the key store mints once, writes it owner-only, and returns the same key on the next open', () => {
  const dir = support('store');
  const first = openStudioKeyStore(dir);
  assert.equal(first.origin, 'minted');
  assert.equal(statSync(studioKeyPath(dir)).mode & 0o777, 0o600);
  const second = openStudioKeyStore(dir);
  assert.equal(second.origin, 'persisted');
  assert.equal(second.current(), first.current());
  assert.match(first.current(), /^[A-Za-z0-9_-]{43}$/);
});

test('D166 a key file others could read, a malformed one, or a symlink is never trusted: a fresh key replaces it', { skip: process.platform === 'win32' }, () => {
  const exposed = support('exposed');
  const leaked = mintStudioKey();
  writeFileSync(studioKeyPath(exposed), `${leaked}\n`, { mode: 0o644 });
  chmodSync(studioKeyPath(exposed), 0o644);
  assert.equal(readStudioKeyFile(exposed), null, 'a group- or world-readable key is treated as exposed');
  const replaced = openStudioKeyStore(exposed);
  assert.notEqual(replaced.current(), leaked);
  assert.equal(statSync(studioKeyPath(exposed)).mode & 0o777, 0o600);

  const malformed = support('malformed');
  writeFileSync(studioKeyPath(malformed), 'short\n', { mode: 0o600 });
  assert.equal(readStudioKeyFile(malformed), null);
  assert.equal(openStudioKeyStore(malformed).origin, 'minted');

  // A planted symlink is neither read nor written through: the write lands on a fresh file.
  const linked = support('linked');
  const elsewhere = join(support('elsewhere'), 'target');
  const planted = mintStudioKey();
  writeFileSync(elsewhere, `${planted}\n`, { mode: 0o600 });
  symlinkSync(elsewhere, studioKeyPath(linked));
  assert.equal(readStudioKeyFile(linked), null, 'a symlinked key is not read');
  const fresh = openStudioKeyStore(linked);
  assert.notEqual(fresh.current(), planted);
  assert.equal(lstatSync(studioKeyPath(linked)).isSymbolicLink(), false, 'the link was replaced, not followed');
  assert.equal(readFileSync(elsewhere, 'utf8').trim(), planted, 'the link target was not written');
});

test('D166 persist:false keeps the key in memory and writes nothing', () => {
  const dir = support('memory');
  const store = openStudioKeyStore(dir, { persist: false });
  assert.equal(store.origin, 'memory');
  assert.equal(existsSync(studioKeyPath(dir)), false);
  store.rotate();
  assert.equal(existsSync(studioKeyPath(dir)), false);
});

test('D166 a read-only support directory degrades to an in-memory key instead of failing the start', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const dir = join(support('ro'), 'support');
  mkdirSync(dir);
  chmodSync(dir, 0o500);
  try {
    const store = openStudioKeyStore(dir);
    assert.equal(store.origin, 'memory');
    assert.match(store.current(), /^[A-Za-z0-9_-]{43}$/);
  } finally {
    chmodSync(dir, 0o700);
  }
});

// --- layer 2: rotation -----------------------------------------------------------------------------

test('D166 rotation: only the person may rotate, the caller gets a fresh TOKEN (never the key), and every old copy is refused on both faces', async () => {
  const { handle, supportDir } = await startStudioUp();
  try {
    const oldKey = handle.studioKey;

    // A Studio MCP session opened before the rotation.
    const studioClient = new Client({ name: 'till-studio', version: '0.0.0' }, { capabilities: {} });
    await studioClient.connect(new StreamableHTTPClientTransport(new URL(`${handle.url}/mcp`), { requestInit: { headers: studioHeaders(oldKey) } }));

    const keyless = await rotate(handle);
    assert.equal(keyless.status, 401);
    assert.equal((await keyless.json()).error, 'studio_key_required');
    const wrong = await rotate(handle, studioHeaders(mintStudioKey()));
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).error, 'studio_key_invalid');
    assert.equal(handle.studioKeys.current(), oldKey, 'a refused rotation changes nothing');

    const rotated = await rotate(handle, studioHeaders(oldKey));
    assert.equal(rotated.status, 200);
    const text = await rotated.text();
    const { token } = JSON.parse(text);
    const newKey = handle.studioKeys.current();
    assert.notEqual(newKey, oldKey);
    assert.ok(!text.includes(newKey) && !text.includes(oldKey), 'the answer carries no key, old or new');
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(readFileSync(studioKeyPath(supportDir), 'utf8').trim(), newKey, 'the new key is persisted');
    assert.equal(statSync(studioKeyPath(supportDir)).mode & 0o777, 0o600);

    const apiOld = await post(`${handle.url}/api/delivery_status`, studioHeaders(oldKey));
    assert.equal(apiOld.status, 401);
    assert.equal((await apiOld.json()).error, 'studio_key_invalid');
    const mcpOld = await post(`${handle.url}/mcp`, studioHeaders(oldKey), initialize('till-studio'));
    assert.equal(mcpOld.status, 401);
    await assert.rejects(studioClient.listTools(), /studio_key_invalid|401/, 'a Studio session opened with the old key is refused from the next request on');
    await studioClient.close().catch(() => {});

    assert.equal((await post(`${handle.url}/api/delivery_status`, studioHeaders(token))).status, 200, 'the caller keeps the seat');
    assert.equal((await post(`${handle.url}/api/delivery_status`, studioHeaders(newKey))).status, 200);
  } finally {
    await handle.close();
  }
});

test('D166 the rotated key survives a restart', async () => {
  const supportDir = support('rotate-restart');
  const first = await startStudioUp({ supportDir });
  await rotate(first.handle, studioHeaders(first.handle.studioKey));
  const key = first.handle.studioKeys.current();
  await first.handle.close();
  const second = await startStudioUp({ supportDir });
  try {
    assert.equal(second.handle.studioKey, key);
  } finally {
    await second.handle.close();
  }
});

// --- layer 3: the reopen door ----------------------------------------------------------------------

test('D166 reopen opens a ONE-TIME ticket link through the OS and answers with nothing key-shaped', async () => {
  const { handle, opened } = await startStudioUp();
  try {
    const res = await reopen(handle);
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(text), { ok: true, opened: true });
    assert.ok(!text.includes(handle.studioKey), 'the answer carries no key');
    assert.deepEqual(keyShapedRuns(text), [], 'nothing key-shaped in the answer');
    for (const [name, value] of res.headers) {
      assert.ok(!value.includes(handle.studioKey), `header ${name} carries no key`);
    }
    assert.equal(opened.length, 1);
    assert.match(opened[0], new RegExp(`^${handle.url}/#t=[A-Za-z0-9_-]{43}$`), 'the OS was handed a ticket link');
    assert.ok(!opened[0].includes(handle.studioKey), 'never the key');
    const token = await sessionFromLink(opened[0]);
    assert.equal((await post(`${handle.url}/api/delivery_status`, studioHeaders(token))).status, 200, 'the opened link works');
    await assert.rejects(sessionFromLink(opened[0]), /ticket_invalid/, 'once');
  } finally {
    await handle.close();
  }
});

test('D166 reopen is rate-limited: a second call inside the interval opens nothing and still carries no key', async () => {
  const { handle, opened } = await startStudioUp();
  try {
    assert.equal((await reopen(handle)).status, 200);
    const again = await reopen(handle);
    const text = await again.text();
    assert.equal(again.status, 429);
    const body = JSON.parse(text);
    assert.equal(body.error, 'reopen_rate_limited');
    assert.ok(body.retryAfterSeconds > 0 && body.retryAfterSeconds <= REOPEN_MIN_INTERVAL_MS / 1000);
    assert.ok(!text.includes(handle.studioKey));
    assert.equal(opened.length, 1, 'only the first call opened anything');
  } finally {
    await handle.close();
  }
});

test('D166 reopen needs the custom header, refuses a foreign Origin, and does nothing for a tab that already holds the key', async () => {
  const { handle, opened } = await startStudioUp();
  try {
    const bare = await post(`${handle.url}/studio/reopen`);
    assert.equal(bare.status, 400);
    assert.equal((await bare.json()).error, 'reopen_header_required');

    const foreign = await reopen(handle, { origin: 'https://evil.example' });
    assert.equal(foreign.status, 403, 'the localhost guard covers the door like every other face');

    const keyed = await reopen(handle, studioHeaders(handle.studioKey));
    assert.deepEqual(await keyed.json(), { ok: true, opened: false });
    assert.equal(opened.length, 0, 'nothing opened for any of these');
  } finally {
    await handle.close();
  }
});

test('D166 the limiter: one per interval, and at most the hourly cap in any rolling hour', () => {
  let now = 0;
  const take = createReopenLimiter(() => now);
  assert.equal(take().ok, true);
  now += REOPEN_MIN_INTERVAL_MS - 1;
  assert.equal(take().ok, false);
  now += 1;
  assert.equal(take().ok, true);
  for (let i = 2; i < REOPEN_MAX_PER_HOUR; i += 1) {
    now += REOPEN_MIN_INTERVAL_MS;
    assert.equal(take().ok, true, `call ${i + 1}`);
  }
  now += REOPEN_MIN_INTERVAL_MS;
  const capped = take();
  assert.equal(capped.ok, false, 'the hourly cap holds');
  now += 60 * 60 * 1000;
  assert.equal(take().ok, true, 'and the window rolls');
});

test('D166 keyless REST is still refused, and GET / still carries no key, with a persisted key on disk', async () => {
  const { handle } = await startStudioUp();
  try {
    const keyless = await post(`${handle.url}/api/delivery_status`);
    assert.equal(keyless.status, 401);
    assert.equal((await keyless.json()).error, 'studio_key_required');
    for (const path of ['/', '/overview', '/studio/reopen']) {
      const text = await (await fetch(`${handle.url}${path}`)).text();
      assert.ok(!text.includes(handle.studioKey), `GET ${path} carries no key`);
    }
  } finally {
    await handle.close();
  }
});

test('D166 served mode writes no key file and mounts no reopen door', async () => {
  const supportDir = support('served');
  const { handle, opened } = await startStudioUp({ supportDir, servedMode: { enabled: true, headerName: 'till-authenticated-subject' } });
  try {
    assert.equal(existsSync(studioKeyPath(supportDir)), false);
    const res = await reopen(handle, { 'till-authenticated-subject': 'someone@example.ch' });
    assert.notEqual(res.status, 200);
    assert.equal(opened.length, 0);
  } finally {
    await handle.close();
  }
});

test('D166 with no Studio built there is nothing to reopen: no door', async () => {
  const { handle, opened } = await startStudioUp({ studioDir: null });
  try {
    const res = await reopen(handle);
    assert.notEqual(res.status, 200);
    assert.equal(opened.length, 0);
  } finally {
    await handle.close();
  }
});

// --- the security review's two findings on the first cut ---------------------------------------------

test('D166 a rotation that cannot be persisted FAILS CLOSED: nothing changes, so a restart cannot revive the revoked key', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const supportDir = support('rotate-ro');
  const { handle } = await startStudioUp({ supportDir });
  const before = handle.studioKey;
  chmodSync(supportDir, 0o500); // the temp file cannot be created: the write fails
  try {
    const res = await rotate(handle, studioHeaders(before));
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.equal(JSON.parse(text).error, 'studio_key_rotate_failed');
    assert.ok(!text.includes(before), 'the refusal carries no key');
    assert.equal(handle.studioKeys.current(), before, 'the old key is still the only key in memory');
    assert.equal(readFileSync(studioKeyPath(supportDir), 'utf8').trim(), before, 'and on disk');
    assert.equal((await post(`${handle.url}/api/delivery_status`, studioHeaders(before))).status, 200);
  } finally {
    chmodSync(supportDir, 0o700);
    await handle.close();
  }
});

test('D166 by default (a launcher, a log file) the banner prints the bare URL and the key file, never a credential', async () => {
  resetDeliveryRuntime();
  const lines = [];
  const supportDir = support('quiet');
  const handle = await up.startUp({
    dbPath: ':memory:', host: '127.0.0.1', port: 0, supportDir, studioDir: studioFixture(), open: false, tickMs: 60_000,
    openUrl: () => {}, log: (l) => lines.push(l),
  });
  try {
    const all = lines.join('\n');
    assert.ok(!all.includes(handle.studioKey), `no key in the banner: ${all}`);
    assert.ok(!all.includes('#t=') && !all.includes('#k='));
    assert.ok(all.includes(handle.url));
    assert.ok(all.includes(studioKeyPath(supportDir)));
  } finally {
    await handle.close();
  }
});

test('D166 the ticket link is printed only when the caller asks (the CLI does, for a terminal); a failed browser open logs no credential', async () => {
  resetDeliveryRuntime();
  const lines = [];
  const handle = await up.startUp({
    dbPath: ':memory:', host: '127.0.0.1', port: 0, supportDir: support('tty'), studioDir: studioFixture(), open: false, tickMs: 60_000,
    openUrl: () => {}, announceStudioLink: true, log: (l) => lines.push(l),
  });
  try {
    assert.ok(lines.some((l) => l.includes(handle.studioUrl)), `the ticket link is printed: ${JSON.stringify(lines)}`);
    assert.ok(!lines.join('\n').includes(handle.studioKey), 'and never the key');
  } finally {
    await handle.close();
  }
  assert.equal(up.redactStudioLink(`http://127.0.0.1:8788/#t=${mintStudioKey()}`), 'http://127.0.0.1:8788/');
  assert.equal(up.redactStudioLink('http://127.0.0.1:8788'), 'http://127.0.0.1:8788');
});

// --- layer 2: paired browsers hold a device key, never a bearer secret --------------------------------
//
// The security review of the first cuts: a key in localStorage belongs to whoever serves the origin
// (a program squatting the port while TILL is down), and a key in a link lands in history. Now a link
// carries a one-time ticket; redeeming it pairs a NON-EXTRACTABLE device key, and a later tab trades a
// signed one-time challenge for a per-process session token. The browser's WebCrypto is played here
// by node's crypto with the same curve and signature encoding.

import { generateKeyPairSync, sign as signWith } from 'node:crypto';
import {
  MAX_CHALLENGES_PER_DEVICE,
  MAX_PAIRED_DEVICES,
  deriveTicket,
  proofMessage,
  instanceIdOf,
  openStudioDeviceRegistry,
  studioDevicesPath,
  unlockMessage,
} from '../../dist/api/studio-devices.js';

function deviceKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
  return {
    jwk: { kty, crv, x, y },
    sign: (deviceId, nonce) => signWith('sha256', Buffer.from(unlockMessage(deviceId, nonce)), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'),
  };
}

const postJsonTo = (url, body, headers = {}) => post(url, { 'content-type': 'application/json', ...headers }, body);

/** Open the Studio the way a browser does: a fresh ticket, redeemed together with a new device key. */
async function pairAndUnlock(handle) {
  const device = deviceKey();
  const link = `${handle.url}/#t=${handle.studioDevices.mintTicket()}`;
  const { token, deviceId } = await sessionFromLink(link, { publicKey: device.jwk });
  assert.match(deviceId, /^[A-Za-z0-9_-]{43}$/);
  return { device, deviceId, token };
}

async function unlock(handle, deviceId, device) {
  const { nonce } = await (await postJsonTo(`${handle.url}/studio/challenge`, { deviceId })).json();
  const res = await (await postJsonTo(`${handle.url}/studio/unlock`, { deviceId, nonce, signature: device.sign(deviceId, nonce) })).json();
  return res.ok ? res.token : null;
}

test('D166 redeeming pairs only the PUBLIC half, owner-only; a private JWK, a non-JSON body or a bad ticket are refused', async () => {
  const { handle, supportDir } = await startStudioUp();
  try {
    const { token } = await pairAndUnlock(handle);

    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const ticket = handle.studioDevices.mintTicket();
    const withPrivate = await postJsonTo(`${handle.url}/studio/redeem`, { ticket, publicKey: privateKey.export({ format: 'jwk' }) });
    assert.equal((await withPrivate.json()).error, 'device_key_invalid', 'a JWK carrying the private member is refused');
    assert.ok(typeof (await sessionFromLink(`${handle.url}/#t=${ticket}`)) === 'string', 'and the refusal did not burn the ticket');

    const textPlain = await post(`${handle.url}/studio/redeem`, { 'content-type': 'text/plain' }, { ticket: handle.studioDevices.mintTicket() });
    assert.equal(textPlain.status, 400, 'a non-JSON content type (a no-preflight cross-origin shape) is refused');
    const invented = await postJsonTo(`${handle.url}/studio/redeem`, { ticket: mintStudioKey() });
    assert.equal((await invented.json()).error, 'ticket_invalid');
    const asTicket = await postJsonTo(`${handle.url}/studio/redeem`, { ticket: handle.studioKey });
    assert.equal((await asTicket.json()).error, 'ticket_invalid', 'the key is not a ticket');

    const file = studioDevicesPath(supportDir);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const stored = readFileSync(file, 'utf8');
    assert.ok(!stored.includes('"d"'), 'no private key material on disk');
    assert.ok(!stored.includes(handle.studioKey) && !stored.includes(token), 'neither the key nor a token on disk');
  } finally {
    await handle.close();
  }
});

test('D166 a host-minted ticket expires', () => {
  let now = 1_000;
  const registry = openStudioDeviceRegistry(support('ticket-expiry'), { persist: false, now: () => now });
  const ticket = registry.mintTicket();
  now += 10 * 60_000 + 1;
  assert.equal(registry.redeem(ticket).ok, false);
});

test('D166 a derived ticket is good only with the current key, for the named process, once, and not for long', () => {
  let key = mintStudioKey();
  let now = Date.now();
  const instanceId = instanceIdOf(4242, '2026-10-14T08:00:00.000Z');
  const registry = openStudioDeviceRegistry(support('derived'), { persist: false, key: () => key, instanceId, now: () => now });
  const stale = deriveTicket(key, instanceId, now - 10 * 60_000 - 1);
  assert.equal(registry.redeem(stale).ok, false, 'older than the TTL (critic L2)');
  const future = deriveTicket(key, instanceId, now + 5 * 60_000);
  assert.equal(registry.redeem(future).ok, false, 'dated in the future');
  const good = deriveTicket(key, instanceId);
  assert.equal(registry.redeem(good).ok, true);
  assert.equal(registry.redeem(good).ok, false, 'once');
  assert.equal(registry.redeem(deriveTicket(key, instanceIdOf(4243, '2026-10-14T08:00:00.000Z'))).ok, false, 'another pid');
  assert.equal(registry.redeem(deriveTicket(key, instanceIdOf(4242, '2026-10-14T09:00:00.000Z'))).ok, false, 'a restart of the same pid');
  assert.equal(registry.redeem(deriveTicket(mintStudioKey(), instanceId)).ok, false, 'another key');
  const before = deriveTicket(key, instanceId);
  key = mintStudioKey(); // a rotation
  assert.equal(registry.redeem(before).ok, false, 'a ticket derived before a rotation');
});

test('D166 a paired browser unlocks a session token that seats the person on both faces; the token is never the key', async () => {
  const { handle } = await startStudioUp();
  try {
    const first = await pairAndUnlock(handle);
    const token = await unlock(handle, first.deviceId, first.device);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(token, handle.studioKey);
    assert.equal((await post(`${handle.url}/api/delivery_status`, studioHeaders(token))).status, 200);
    const client = new Client({ name: 'till-studio', version: '0.0.0' }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${handle.url}/mcp`), { requestInit: { headers: studioHeaders(token) } }));
    const created = await (await post(`${handle.url}/api/create_workspace`, studioHeaders(token), { name: 'D166 Probe GmbH', idempotencyKey: 'd165-token' })).json();
    assert.equal(created.ok, true, JSON.stringify(created));
    const who = JSON.parse((await client.callTool({ name: 'whoami', arguments: { workspaceId: created.workspaceId } })).content[0].text);
    await client.close();
    assert.equal(who.actor, 'studio');
  } finally {
    await handle.close();
  }
});

test('D166 unlock refuses an unknown device, a replayed or invented nonce, and a bad signature; nothing in a refusal is key-shaped', async () => {
  const { handle } = await startStudioUp();
  try {
    const { device, deviceId } = await pairAndUnlock(handle);
    const other = deviceKey();

    const unknown = await postJsonTo(`${handle.url}/studio/challenge`, { deviceId: 'x'.repeat(43) });
    assert.equal((await unknown.json()).error, 'device_unknown');

    const { nonce } = await (await postJsonTo(`${handle.url}/studio/challenge`, { deviceId })).json();
    const forged = await (await postJsonTo(`${handle.url}/studio/unlock`, { deviceId, nonce, signature: other.sign(deviceId, nonce) })).text();
    assert.equal(JSON.parse(forged).error, 'signature_invalid');
    assert.deepEqual(keyShapedRuns(forged), []);
    // The nonce was spent by the failed attempt: even the right signature cannot reuse it.
    const replay = await (await postJsonTo(`${handle.url}/studio/unlock`, { deviceId, nonce, signature: device.sign(deviceId, nonce) })).json();
    assert.equal(replay.error, 'challenge_invalid');
    const invented = await (await postJsonTo(`${handle.url}/studio/unlock`, { deviceId, nonce: 'n'.repeat(43), signature: device.sign(deviceId, 'n'.repeat(43)) })).json();
    assert.equal(invented.error, 'challenge_invalid', 'a nonce the host never issued (a squatter pre-signing) is refused');
  } finally {
    await handle.close();
  }
});

test('D166 a restart keeps the pairing but forgets every token: the browser simply unlocks again', async () => {
  const supportDir = support('pair-restart');
  const first = await startStudioUp({ supportDir });
  const { device, deviceId, token } = await pairAndUnlock(first.handle);
  await first.handle.close();
  const second = await startStudioUp({ supportDir });
  try {
    assert.equal((await post(`${second.handle.url}/api/delivery_status`, studioHeaders(token))).status, 401, 'tokens are per process');
    const fresh = await unlock(second.handle, deviceId, device);
    assert.ok(fresh !== null, 'the device is still paired');
    assert.equal((await post(`${second.handle.url}/api/delivery_status`, studioHeaders(fresh))).status, 200);
  } finally {
    await second.handle.close();
  }
});

test('D166 Auf allen Geräten abmelden forgets every device and token, on disk; a token tab may sign out and pairs anew', async () => {
  const { handle, supportDir } = await startStudioUp();
  try {
    const a = await pairAndUnlock(handle);
    const b = await pairAndUnlock(handle);
    const fresh = deviceKey();
    const rotated = await rotate(handle, studioHeaders(a.token), { publicKey: fresh.jwk });
    assert.equal(rotated.status, 200, 'the person on a paired tab can sign everyone else out');
    const grant = await rotated.json();
    assert.equal((await post(`${handle.url}/api/delivery_status`, studioHeaders(b.token))).status, 401);
    assert.equal((await post(`${handle.url}/api/delivery_status`, studioHeaders(a.token))).status, 401);
    assert.equal(await unlock(handle, b.deviceId, b.device), null, 'the old device is forgotten');
    assert.equal((await post(`${handle.url}/api/delivery_status`, studioHeaders(grant.token))).status, 200);
    assert.ok((await unlock(handle, grant.deviceId, fresh)) !== null, 'the caller paired its new device in the same step');
    assert.equal(handle.studioDevices.count(), 1);
    assert.equal(JSON.parse(readFileSync(studioDevicesPath(supportDir), 'utf8')).devices.length, 1);
  } finally {
    await handle.close();
  }
});

test('D166 the registry caps paired devices and replaces the one a browser names', () => {
  const registry = openStudioDeviceRegistry(support('cap'));
  let last;
  for (let i = 0; i < MAX_PAIRED_DEVICES + 3; i += 1) last = registry.redeem(registry.mintTicket(), deviceKey().jwk);
  assert.equal(registry.count(), MAX_PAIRED_DEVICES);
  const replaced = registry.redeem(registry.mintTicket(), deviceKey().jwk, last.deviceId);
  assert.equal(replaced.ok, true);
  assert.equal(registry.count(), MAX_PAIRED_DEVICES);
  assert.equal(registry.challenge(last.deviceId).ok, false, 'the replaced device is gone');
});

test('D166 an expired challenge is refused', () => {
  let now = 1_000;
  const registry = openStudioDeviceRegistry(support('expiry'), { persist: false, now: () => now });
  const device = deviceKey();
  const { deviceId } = registry.redeem(registry.mintTicket(), device.jwk);
  const { nonce } = registry.challenge(deviceId);
  now += 61_000;
  assert.equal(registry.unlock(deviceId, nonce, device.sign(deviceId, nonce)).error, 'challenge_invalid');
});

// --- critic round 1 (non-author, 14.10.2026) ----------------------------------------------------------

import { createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

/** TILL.app's gate since critic H1, in JS: the lock names the pid it started AND the server proves the key. */
async function tillAppGate(port, supportDir, startedPid) {
  let lock;
  let key;
  try {
    lock = JSON.parse(readFileSync(join(supportDir, 'up.lock'), 'utf8'));
    key = readFileSync(studioKeyPath(supportDir), 'utf8').trim();
  } catch {
    return false;
  }
  if (lock.pid !== startedPid || lock.port !== port) return false;
  const nonce = randomBytes(18).toString('base64url');
  const expected = createHmac('sha256', key).update(proofMessage(instanceIdOf(lock.pid, lock.startedAt), nonce)).digest('base64url');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/studio/prove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce }),
    });
    const body = await res.json();
    return body.ok === true && body.proof === expected;
  } catch {
    return false;
  }
}

test('CRITIC H1 the app gate never passes while ANOTHER program holds the port, even though the lock names a starting till up', async () => {
  const occupant = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, proof: 'x'.repeat(43) })); // an occupant may answer anything
  });
  await new Promise((r) => occupant.listen(0, '127.0.0.1', r));
  const port = occupant.address().port;
  const supportDir = support('critic-race');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../bin/till.mjs', import.meta.url)), 'up', '--no-open'], {
    env: { ...process.env, TILL_PORT: String(port), TILL_SUPPORT_DIR: supportDir, TILL_DB_PATH: join(supportDir, 'book.sqlite'), TILL_NO_OPEN: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));
  let exited = false;
  const done = new Promise((r) => child.on('exit', (code) => { exited = true; r(code); }));
  let gatePassed = false;
  while (!exited) {
    if (await tillAppGate(port, supportDir, child.pid)) gatePassed = true;
    await new Promise((r) => setTimeout(r, 2));
  }
  const code = await done;
  await new Promise((r) => occupant.close(r));
  assert.notEqual(code, 0);
  assert.match(stderr, /already in use|EADDRINUSE/);
  assert.equal(gatePassed, false, 'the app would load nothing into a port another program holds');
});

test('CRITIC H1 the gate passes for the real till up, and a proof is no ticket and carries no key', async () => {
  const supportDir = support('prove');
  const { handle } = await startStudioUp({ supportDir });
  try {
    const port = Number(new URL(handle.url).port);
    assert.equal(await tillAppGate(port, supportDir, process.pid), true);
    const nonce = randomBytes(18).toString('base64url');
    const text = await (await post(`${handle.url}/studio/prove`, { 'content-type': 'application/json' }, { nonce })).text();
    assert.ok(!text.includes(handle.studioKey));
    const { proof } = JSON.parse(text);
    assert.equal((await post(`${handle.url}/studio/redeem`, { 'content-type': 'application/json' }, { ticket: `d.${Date.now()}.${nonce}.${proof}` })).status, 401, 'a proof is not a ticket (different domain)');
    const bad = await post(`${handle.url}/studio/prove`, { 'content-type': 'application/json' }, { nonce: 'short' });
    assert.equal(bad.status, 400);
  } finally {
    await handle.close();
  }
});

test('CRITIC H1 the Studio shell is never cached; hashed assets may be', async () => {
  const studioDir = studioFixture();
  mkdirSync(join(studioDir, 'assets'));
  writeFileSync(join(studioDir, 'assets', 'index-abc.js'), 'x');
  const { handle } = await startStudioUp({ studioDir });
  try {
    for (const path of ['/', '/journal', '/index.html']) {
      assert.equal((await fetch(`${handle.url}${path}`)).headers.get('cache-control'), 'no-store', path);
    }
    assert.equal((await fetch(`${handle.url}/assets/index-abc.js`)).headers.get('cache-control'), null);
  } finally {
    await handle.close();
  }
});

test('CRITIC L3 flooding one device id evicts only that device\'s own challenges', () => {
  const registry = openStudioDeviceRegistry(support('flood'), { persist: false });
  const a = deviceKey();
  const b = deviceKey();
  const { deviceId: idA } = registry.redeem(registry.mintTicket(), a.jwk);
  const { deviceId: idB } = registry.redeem(registry.mintTicket(), b.jwk);
  const { nonce } = registry.challenge(idB);
  for (let i = 0; i < 200; i += 1) registry.challenge(idA);
  assert.equal(registry.unlock(idB, nonce, b.sign(idB, nonce)).ok, true, 'the other device still unlocks');
  const opened = [];
  for (let i = 0; i < MAX_CHALLENGES_PER_DEVICE + 2; i += 1) opened.push(registry.challenge(idA).nonce);
  const oldest = opened[0];
  assert.equal(registry.unlock(idA, oldest, a.sign(idA, oldest)).error, 'challenge_invalid', 'a device keeps only its newest challenges');
  const newest = opened[opened.length - 1];
  assert.equal(registry.unlock(idA, newest, a.sign(idA, newest)).ok, true);
});

test('CRITIC L4 a redeem whose device cannot be saved still hands a (deviceless) token for the spent ticket', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const dir = join(support('l4'), 'support');
  mkdirSync(dir);
  const registry = openStudioDeviceRegistry(dir);
  chmodSync(dir, 0o500);
  try {
    const res = registry.redeem(registry.mintTicket(), deviceKey().jwk);
    assert.equal(res.ok, true);
    assert.equal(res.deviceId, undefined);
    assert.equal(registry.accepts(res.token), true);
  } finally {
    chmodSync(dir, 0o700);
  }
});
