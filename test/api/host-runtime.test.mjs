// The host live-wire seam (host-runtime.ts, D108): how the packaged `till` runtime attaches the
// PRIVATE EBICS wire without the MIT core ever importing it.
//
// The rule this pins: with `TILL_EBICS_RUNTIME` UNSET the core stays exactly as it ships (no live
// wire, honest degradation, no socket); with it SET, the seam builds the core file keystore, loads
// the host module by that specifier, composes the live transport, and hands both ports to ApiDeps so
// `ctxOf` reaches the A33 verbs. A misconfigured live wire is LOUD, never a silent fallback to offline.
//
// It runs against a FAKE wire module (fixtures/fake-ebics-wire.mjs) so it is hermetic and offline:
// the private package is not needed to prove the attachment, which is all this seam owns.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveEbicsRuntime } from '../../dist/api/host-runtime.js';
import { makeApiDeps } from '../../dist/api/mcp.js';
import { fileEbicsKeystore } from '../../dist/core/banking/ebics/keystore-file.js';

const FAKE_WIRE = fileURLToPath(new URL('./fixtures/fake-ebics-wire.mjs', import.meta.url));
const KEYSTORE_PATH = join(mkdtempSync(join(tmpdir(), 'till-ebics-')), 'keystore.json');

const ENV_KEYS = [
  'TILL_EBICS_RUNTIME',
  'TILL_EBICS_KEYSTORE_PATH',
  'TILL_EBICS_KEYSTORE_PASSPHRASE',
  'TILL_EBICS_CA_FILE',
];

/** Run `fn` with a clean set of the EBICS env vars, restored afterwards. */
async function withEnv(overrides, fn) {
  const prior = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, overrides);
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
  }
}

const TRANSPORT_METHODS = ['sendKeys', 'fetchBankKeys', 'download', 'acknowledge', 'upload', 'suspend'];

test('with TILL_EBICS_RUNTIME UNSET, no live wire is attached (the OSS default, honest degrade)', async () => {
  const ports = await withEnv({}, () => resolveEbicsRuntime());
  assert.deepEqual(ports, {}, 'no runtime configured means no ports, so the core degrades honestly');
});

test('with the runtime set, it builds the keystore, loads the module, and composes a full transport', async () => {
  const ports = await withEnv(
    { TILL_EBICS_RUNTIME: FAKE_WIRE, TILL_EBICS_KEYSTORE_PATH: KEYSTORE_PATH },
    () => resolveEbicsRuntime(),
  );
  assert.ok(ports.ebicsKeystore, 'a keystore port is returned');
  assert.equal(ports.ebicsKeystore.kind, 'file', 'it is the core file keystore, not an in-memory stub');
  assert.ok(ports.ebicsTransport, 'a transport port is returned');
  for (const m of TRANSPORT_METHODS) {
    assert.equal(typeof ports.ebicsTransport[m], 'function', `the composed transport exposes ${m}()`);
  }
});

test('the composed fetchBankKeys maps the wire hashes into the core three-field EbicsKeyHashes shape', async () => {
  const ports = await withEnv(
    { TILL_EBICS_RUNTIME: FAKE_WIRE, TILL_EBICS_KEYSTORE_PATH: KEYSTORE_PATH },
    () => resolveEbicsRuntime(),
  );
  const conn = { hostUrl: 'https://x/', hostId: 'H', partnerId: 'P', userIdEbics: 'U', protocolVersion: 'H005', keyRef: 'k' };
  const res = ports.ebicsTransport.fetchBankKeys({ connection: conn });
  assert.equal(res.ok, true);
  // Banks publish X002 + E002 on HPB, never an ES key: electronicSignature is carried as ''.
  assert.deepEqual(res.bankKeyHashes, {
    electronicSignature: '',
    authentication: 'auth-fingerprint',
    encryption: 'enc-fingerprint',
  });
});

test('the wire receives the core keystore (custody stays in the core, never the private package)', async () => {
  const fixture = await import(FAKE_WIRE);
  fixture.calls.wire.length = 0;
  const ports = await withEnv(
    { TILL_EBICS_RUNTIME: FAKE_WIRE, TILL_EBICS_KEYSTORE_PATH: KEYSTORE_PATH },
    () => resolveEbicsRuntime(),
  );
  assert.equal(fixture.calls.wire.length, 1, 'createEbicsWire was called exactly once');
  assert.equal(fixture.calls.wire[0].keystore, ports.ebicsKeystore, 'the SAME core keystore is handed to the wire');
});

test('a requested live wire with NO keystore path is a LOUD failure, not a silent offline fallback', async () => {
  await withEnv({ TILL_EBICS_RUNTIME: FAKE_WIRE }, async () => {
    await assert.rejects(() => resolveEbicsRuntime(), /TILL_EBICS_KEYSTORE_PATH is not/);
  });
});

test('a runtime module that does not export the wire contract is rejected loudly', async () => {
  // Point at a module that exists but lacks createEbicsWire/createEbicsTransport (this test file).
  const notAWire = fileURLToPath(import.meta.url);
  await withEnv(
    { TILL_EBICS_RUNTIME: notAWire, TILL_EBICS_KEYSTORE_PATH: KEYSTORE_PATH },
    async () => {
      await assert.rejects(() => resolveEbicsRuntime(), /not a compatible @tillbooks\/ebics-wire build/);
    },
  );
});

test('an unresolvable runtime module is a loud failure naming the specifier', async () => {
  await withEnv(
    { TILL_EBICS_RUNTIME: '/no/such/ebics-wire.js', TILL_EBICS_KEYSTORE_PATH: KEYSTORE_PATH },
    async () => {
      await assert.rejects(() => resolveEbicsRuntime(), /Failed to load the EBICS wire module/);
    },
  );
});

test('a wrong keystore passphrase is a LOUD boot failure (never mints keys, never silent-offline)', async () => {
  // Seed a REAL passphrase-encrypted keystore, then boot the runtime with the wrong passphrase.
  const dir = mkdtempSync(join(tmpdir(), 'till-ebics-pass-'));
  const path = join(dir, 'ks.json');
  const seed = fileEbicsKeystore(path, () => 'correct-horse');
  seed.generate({ keyLength: 2048 });

  await withEnv(
    { TILL_EBICS_RUNTIME: FAKE_WIRE, TILL_EBICS_KEYSTORE_PATH: path, TILL_EBICS_KEYSTORE_PASSPHRASE: 'wrong' },
    async () => {
      await assert.rejects(() => resolveEbicsRuntime(), /wrong passphrase/);
    },
  );
  // The correct passphrase opens it, proving the throw was the passphrase and not the file.
  const ports = await withEnv(
    { TILL_EBICS_RUNTIME: FAKE_WIRE, TILL_EBICS_KEYSTORE_PATH: path, TILL_EBICS_KEYSTORE_PASSPHRASE: 'correct-horse' },
    () => resolveEbicsRuntime(),
  );
  assert.ok(ports.ebicsKeystore, 'the correct passphrase opens the same file');
});

test('makeApiDeps carries the host ports through to ApiDeps (so ctxOf can reach the A33 verbs)', async () => {
  const ports = await withEnv(
    { TILL_EBICS_RUNTIME: FAKE_WIRE, TILL_EBICS_KEYSTORE_PATH: KEYSTORE_PATH },
    () => resolveEbicsRuntime(),
  );
  const { deps, store } = makeApiDeps(undefined, ports);
  try {
    assert.equal(deps.ebicsTransport, ports.ebicsTransport, 'the transport reaches ApiDeps');
    assert.equal(deps.ebicsKeystore, ports.ebicsKeystore, 'the keystore reaches ApiDeps');
  } finally {
    store.close();
  }
});

test('makeApiDeps with no host ports leaves the EBICS members ABSENT (honest degradation default)', () => {
  const { deps, store } = makeApiDeps();
  try {
    assert.equal('ebicsTransport' in deps, false, 'absent, not an explicit undefined');
    assert.equal('ebicsKeystore' in deps, false);
  } finally {
    store.close();
  }
});
