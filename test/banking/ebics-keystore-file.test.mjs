// A36: the passphrase-encrypted EBICS keystore FILE (US-A36.2). Proves it survives a restart, refuses
// a wrong passphrase without regenerating (refuse-don't-guess), reports keystore_unavailable on a
// corrupt file, holds NO plaintext key material or passphrase on disk, and offers no export path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileEbicsKeystore } from '../../dist/core/banking/ebics/keystore-file.js';

function tmpPath() {
  const dir = mkdtempSync(join(tmpdir(), 'till-ks-'));
  return join(dir, 'keystore.v1');
}

test('a fresh file store generates keys, persists them, and survives a simulated process restart', () => {
  const path = tmpPath();
  const PASS = 'correct horse battery staple';

  // Process 1: unlock a fresh (non-existent) store, generate, capture the public fingerprints.
  const p1 = fileEbicsKeystore(path, () => PASS);
  assert.equal(p1.state(), 'ready');
  const gen = p1.generate({ keyLength: 2048 });
  assert.ok(gen.keyRef.startsWith('ebickey-') || gen.keyRef.startsWith('ebicskey-'));
  assert.ok(existsSync(path), 'the keystore file exists after generate');
  const hashes1 = p1.publicHashes(gen.keyRef);
  assert.ok(hashes1 && typeof hashes1.electronicSignature === 'string');

  // Process 2: a NEW instance over the same path (a restart). Unlock with the same passphrase; the
  // same keyRef resolves to the same public fingerprints (the private keys survived).
  const p2 = fileEbicsKeystore(path);
  assert.equal(p2.unlock(PASS), true);
  assert.equal(p2.state(), 'ready');
  assert.deepEqual(p2.publicHashes(gen.keyRef), hashes1, 'the keys survived the restart byte-for-byte');
  rmSync(path, { force: true });
});

test('a wrong passphrase yields locked, regenerates NOTHING, and leaves the file byte-identical', () => {
  const path = tmpPath();
  const p1 = fileEbicsKeystore(path, () => 'right-pass');
  p1.generate({ keyLength: 2048 });
  const before = readFileSync(path);

  const p2 = fileEbicsKeystore(path);
  assert.equal(p2.unlock('WRONG-pass'), false, 'a wrong passphrase does not unlock');
  assert.equal(p2.state(), 'locked', 'the store stays locked, not ready');
  const after = readFileSync(path);
  assert.deepEqual(after, before, 'the keystore file is byte-identical: nothing was regenerated');
  rmSync(path, { force: true });
});

test('a corrupt keystore file yields keystore_unavailable and never regenerates', () => {
  const path = tmpPath();
  writeFileSync(path, 'this is not a valid envelope {{{');
  const ks = fileEbicsKeystore(path, () => 'anything');
  assert.equal(ks.state(), 'unavailable');
  // generate() must throw rather than silently mint fresh keys over the corrupt file.
  assert.throws(() => ks.generate({ keyLength: 2048 }), /unavailable/);
  rmSync(path, { force: true });
});

test('no plaintext key material or passphrase EVER reaches the keystore file (tripwire 3/4)', () => {
  const path = tmpPath();
  const PASS = 'super-secret-passphrase-12345';
  const ks = fileEbicsKeystore(path, () => PASS);
  const gen = ks.generate({ keyLength: 2048 });
  const raw = readFileSync(path, 'utf8');
  assert.equal(raw.includes(PASS), false, 'the passphrase is not on disk');
  assert.equal(raw.includes('PRIVATE KEY'), false, 'no PEM private key header on disk');
  assert.equal(raw.includes('BEGIN'), false, 'no PEM material on disk at all');
  // The public fingerprints are derived, not the private keys; the ciphertext is opaque hex.
  const env = JSON.parse(raw);
  assert.equal(env.v, 1);
  assert.equal(env.kdf, 'scrypt');
  assert.match(env.ciphertextHex, /^[0-9a-f]+$/);
  // There is no export method on the port surface.
  assert.equal(typeof (ks).export, 'undefined');
  assert.equal(typeof (ks).privateKey, 'undefined');
  // A locked store (wrong pass) returns null publicHashes rather than leaking the ref.
  const p2 = fileEbicsKeystore(path);
  assert.equal(p2.publicHashes(gen.keyRef), null);
  rmSync(path, { force: true });
});

test('destroy removes a keyRef and retiring the last connection removes the file', () => {
  const path = tmpPath();
  const ks = fileEbicsKeystore(path, () => 'p');
  const a = ks.generate({ keyLength: 2048 });
  const b = ks.generate({ keyLength: 2048 });
  ks.destroy(a.keyRef);
  assert.equal(ks.publicHashes(a.keyRef), null, 'destroyed key is gone');
  assert.ok(ks.publicHashes(b.keyRef), 'the other key survives');
  assert.ok(existsSync(path), 'file still present with one key');
  ks.destroy(b.keyRef);
  assert.equal(existsSync(path), false, 'retiring the last connection removes the keystore file');
  ks.destroy('unknown-ref'); // idempotent, no throw
});
