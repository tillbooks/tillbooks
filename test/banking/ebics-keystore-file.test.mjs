// A36: the passphrase-encrypted EBICS keystore FILE (US-A36.2, spec §4.2, §8 row 3). Proves it survives
// a restart, refuses a wrong passphrase without regenerating (refuse-don't-guess), reports
// keystore_unavailable on a corrupt file, holds NO plaintext key material or passphrase on disk, offers
// no export path, certifies every key per §4.2, never holds the A005 private key (OD-2), and refuses a
// write to a file another process changed (keystore_changed_elsewhere).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  verify as rsaVerify,
  X509Certificate,
} from 'node:crypto';

import { fileEbicsKeystore } from '../../dist/core/banking/ebics/keystore-file.js';
import { connectBankChannel } from '../../dist/core/banking/ebics/index.js';
import { createBankAccount } from '../../dist/core/banking/index.js';
import { makeContext } from '../../dist/core/context.js';
import { setup } from './support.mjs';
import { mockBank, syntheticIban } from './ebics-support.mjs';

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

// --- A36 §4.2: certificates, OD-2, and the write that refuses a file changed elsewhere --------------

/** Open the envelope the way the store does, from the outside: what is REALLY in the file. */
function decryptFile(path, passphrase) {
  const env = JSON.parse(readFileSync(path, 'utf8'));
  const key = scryptSync(passphrase, Buffer.from(env.kdfParams.saltHex, 'hex'), 32, { N: env.kdfParams.N, r: env.kdfParams.r, p: env.kdfParams.p, maxmem: 64 * 1024 * 1024 });
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(env.nonceHex, 'hex'));
  d.setAuthTag(Buffer.from(env.tagHex, 'hex'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(env.ciphertextHex, 'hex')), d.final()]).toString('utf8'));
}

/** The keyUsage bits byte (bit n = RFC 5280 named bit n, MSB first), read from the DER independently. */
function keyUsageByte(der) {
  const oid = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x0f]);
  const at = der.indexOf(oid);
  assert.notEqual(at, -1, 'keyUsage present');
  let p = at + oid.length;
  if (der[p] === 0x01) p += 3; // critical BOOLEAN
  assert.equal(der[p], 0x04);
  p += 2;
  assert.equal(der[p], 0x03);
  return der[p + 3];
}

test('A36: every key is certified (self-signed, CN = user ID, not a CA, valid to 9999-12-31, keyUsage per purpose)', () => {
  const path = tmpPath();
  const ks = fileEbicsKeystore(path, () => 'p');
  const gen = ks.generate({ keyLength: 2048, subjectCommonName: 'USER0042' });
  const expected = { electronicSignature: 0xc0, authentication: 0x80, encryption: 0x20 };
  for (const purpose of ['electronicSignature', 'authentication', 'encryption']) {
    const m = ks.publicKeyMaterial({ keyRef: gen.keyRef, purpose });
    const cert = new X509Certificate(m.x509Der);
    assert.equal(cert.subject, 'CN=USER0042', `${purpose}: CN is the EBICS user ID`);
    assert.equal(cert.issuer, cert.subject, `${purpose}: self-issued`);
    assert.equal(cert.verify(cert.publicKey), true, `${purpose}: self-signed by its own key`);
    assert.equal(cert.ca, false, `${purpose}: not a CA`);
    assert.equal(new Date(cert.validTo).toISOString(), '9999-12-31T23:59:59.000Z', `${purpose}: unlimited validity`);
    assert.ok(Date.parse(cert.validFrom) <= Date.now(), `${purpose}: valid now`);
    assert.deepEqual(cert.publicKey.export({ type: 'spki', format: 'der' }), m.spkiDer, `${purpose}: certifies exactly this key`);
    assert.equal(keyUsageByte(m.x509Der), expected[purpose], `${purpose}: keyUsage of §4.2`);
    assert.equal(gen.hashes.certificateHashes[purpose].length, 64, `${purpose}: the certificate hash is reported`);
  }
  rmSync(path, { force: true });
});

test('A36 OD-2: no A005 private key in the decrypted file after generate, INI and activation', () => {
  const path = tmpPath();
  const PASS = 'od2-passphrase';
  const ks = fileEbicsKeystore(path, () => PASS);
  const t = setup();
  const bank = mockBank();
  const ctx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: t.clock, ids: t.ids, ebicsTransport: bank.port, ebicsKeystore: ks });
  const acc = createBankAccount(t.ctx, { name: 'K', iban: syntheticIban(4242), ledgerAccountId: t.acc('1020'), idempotencyKey: 'od2-ba' }).bankAccountId;
  const host = { url: 'https://ebics.example/ebicsweb', hostId: 'SYNTHHST', partnerId: 'PARTNER42', userId: 'USER0042' };

  const assertNoEsPrivateKey = (stage) => {
    const map = decryptFile(path, PASS);
    const refs = Object.keys(map);
    assert.equal(refs.length, 1, stage);
    const keys = map[refs[0]];
    assert.equal(keys.electronicSignature.privatePem, undefined, `${stage}: the A005 private key is not in the file`);
    assert.ok(typeof keys.electronicSignature.certDerB64 === 'string', `${stage}: its certificate is`);
    assert.ok(keys.authentication.privatePem.includes('PRIVATE KEY') && keys.encryption.privatePem.includes('PRIVATE KEY'), `${stage}: X002 and E002 are kept`);
    assert.equal(JSON.stringify(map).match(/PRIVATE KEY-----/g).length, 4, `${stage}: exactly two private keys (BEGIN and END each)`);
  };

  const c = connectBankChannel(ctx, { host, routeBankAccountIds: [acc], confirm: true, idempotencyKey: 'od2' });
  assert.equal(c.state, 'pending_bank_activation', JSON.stringify(c));
  assertNoEsPrivateKey('after generate, INI and HIA');
  const fetched = connectBankChannel(ctx, { connectionId: c.connectionId, confirm: true });
  const active = connectBankChannel(ctx, { connectionId: c.connectionId, confirm: true, confirmBankKeys: true, expectedBankKeyHashes: fetched.bankKeyHashes });
  assert.equal(active.state, 'active');
  assertNoEsPrivateKey('after activation');
  // Nothing the channel wrote to SQLite carries key material.
  const dump = JSON.stringify(t.store.db.prepare('SELECT * FROM ebics_connection').all()) + JSON.stringify(t.store.db.prepare('SELECT * FROM ebics_order_log').all());
  assert.equal(dump.includes('PRIVATE KEY'), false);
  rmSync(path, { force: true });
});

test('A36: a write to a keystore file changed elsewhere is refused (keystore_changed_elsewhere) and leaves it byte-identical', () => {
  const path = tmpPath();
  const p1 = fileEbicsKeystore(path, () => 'shared');
  const first = p1.generate({ keyLength: 2048 });
  const p2 = fileEbicsKeystore(path, () => 'shared');
  assert.equal(p2.state(), 'ready');
  // Process 1 writes again: the file is no longer the one process 2 read.
  p1.generate({ keyLength: 2048 });
  const before = readFileSync(path);
  assert.throws(() => p2.generate({ keyLength: 2048 }), /keystore_changed_elsewhere/);
  assert.throws(() => p2.destroy(first.keyRef), /keystore_changed_elsewhere/, 'a destroy would drop the key process 1 added');
  assert.ok(p2.publicHashes(first.keyRef), 'the refused destroy kept the key in process 2 as well');
  assert.deepEqual(readFileSync(path), before, 'the file process 1 wrote is untouched');
  // Process 1, which wrote it, still writes; no temp file is left behind by any write.
  p1.generate({ keyLength: 2048 });
  assert.deepEqual(readdirSync(dirname(path)).filter((f) => f.includes('.tmp-')), []);
  rmSync(path, { force: true });
});

// --- OD-2 for a keystore written BEFORE A36 (a synthetic pre-A36 file) ----------------------------

/** Seal a key map exactly the way the pre-A36 store did (scrypt N=2^15, r=8, p=1; AES-256-GCM). */
function sealPreA36(map, passphrase) {
  const saltHex = randomBytes(16).toString('hex');
  const nonce = randomBytes(12);
  const key = scryptSync(passphrase, Buffer.from(saltHex, 'hex'), 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(map), 'utf8')), cipher.final()]);
  return {
    v: 1,
    kdf: 'scrypt',
    kdfParams: { N: 1 << 15, r: 8, p: 1, saltHex },
    nonceHex: nonce.toString('hex'),
    ciphertextHex: ciphertext.toString('hex'),
    tagHex: cipher.getAuthTag().toString('hex'),
  };
}

/** A pre-A36 record: three raw pairs, private PEM plus SPKI fingerprint each, no certificate, no publicPem. */
function preA36Pair() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicHashHex: createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex'),
  };
}

function writePreA36Keystore(path, passphrase) {
  const keys = { electronicSignature: preA36Pair(), authentication: preA36Pair(), encryption: preA36Pair() };
  const keyRef = 'ebicskey-00000000-0000-4000-8000-000000000a36';
  writeFileSync(path, JSON.stringify(sealPreA36({ [keyRef]: keys }, passphrase)), { mode: 0o600 });
  return { keyRef, keys };
}

test('A36 OD-2 for an older file: the first unlock drops the A005 private key with an atomic rewrite, the public hashes unchanged', () => {
  const path = tmpPath();
  const PASS = 'pre-a36-passphrase';
  const { keyRef, keys } = writePreA36Keystore(path, PASS);
  assert.equal(typeof decryptFile(path, PASS)[keyRef].electronicSignature.privatePem, 'string', 'the synthetic old file holds the A005 private key');
  const before = readFileSync(path);

  const ks = fileEbicsKeystore(path, () => PASS);
  assert.equal(ks.state(), 'ready');
  const after = decryptFile(path, PASS)[keyRef];
  assert.equal(after.electronicSignature.privatePem, undefined, 'the A005 private key is gone from the file');
  assert.match(after.electronicSignature.publicPem, /BEGIN PUBLIC KEY/, 'its public key stays');
  assert.equal(after.electronicSignature.publicHashHex, keys.electronicSignature.publicHashHex);
  assert.equal(after.authentication.privatePem, keys.authentication.privatePem, 'X002 untouched');
  assert.equal(after.encryption.privatePem, keys.encryption.privatePem, 'E002 untouched');
  assert.notDeepEqual(readFileSync(path), before, 'the file was rewritten');
  assert.deepEqual(readdirSync(dirname(path)).filter((f) => f.includes('.tmp-')), [], 'atomically, no temp file left');

  // What the bank and the INI letter know does not move.
  const hashes = ks.publicHashes(keyRef);
  assert.deepEqual(
    [hashes.electronicSignature, hashes.authentication, hashes.encryption],
    [keys.electronicSignature.publicHashHex, keys.authentication.publicHashHex, keys.encryption.publicHashHex],
  );
  // No order signature is possible; authentication still works.
  assert.equal(ks.sign({ keyRef, purpose: 'electronicSignature', data: Buffer.from('an order') }), null);
  const sig = ks.sign({ keyRef, purpose: 'authentication', data: Buffer.from('a request') });
  assert.equal(rsaVerify('sha256', Buffer.from('a request'), createPublicKey(keys.authentication.privatePem), sig), true);

  // A second open finds nothing to drop and writes nothing.
  const settled = readFileSync(path);
  assert.equal(fileEbicsKeystore(path, () => PASS).state(), 'ready');
  assert.deepEqual(readFileSync(path), settled, 'no second rewrite');
  rmSync(path, { force: true });
});

test('A36 OD-2 for an older file: a wrong passphrase drops nothing and leaves the file byte-identical', () => {
  const path = tmpPath();
  writePreA36Keystore(path, 'right');
  const before = readFileSync(path);
  const ks = fileEbicsKeystore(path);
  assert.equal(ks.unlock('wrong'), false);
  assert.deepEqual(readFileSync(path), before);
  rmSync(path, { force: true });
});

test('A36 OD-2 for an older file: when the rewrite cannot happen at unlock, the key is gone in memory and the next write drops it on disk', () => {
  const path = tmpPath();
  const PASS = 'deferred';
  const { keyRef } = writePreA36Keystore(path, PASS);
  const dir = dirname(path);
  chmodSync(dir, 0o500); // the folder refuses the temp file, so the unlock-time rewrite fails
  let ks;
  try {
    ks = fileEbicsKeystore(path, () => PASS);
    assert.equal(ks.state(), 'ready', 'the store still opens');
    assert.equal(ks.sign({ keyRef, purpose: 'electronicSignature', data: Buffer.from('x') }), null);
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.equal(typeof decryptFile(path, PASS)[keyRef].electronicSignature.privatePem, 'string', 'the disk still held it');
  ks.generate({ keyLength: 2048 }); // the next write of the store
  const map = decryptFile(path, PASS);
  for (const ref of Object.keys(map)) assert.equal(map[ref].electronicSignature.privatePem, undefined, `${ref}: no A005 private key`);
  rmSync(path, { force: true });
});
