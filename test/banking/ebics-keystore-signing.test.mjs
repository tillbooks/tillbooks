// A36 signing facet: the OPTIONAL private-key operations the private EBICS wire needs
// (sign / decrypt / publicKeyMaterial) on both keystores. Proves the facet is real (signatures
// verify, decryption round-trips), that the exported public material is the SAME key the core
// already fingerprints (INI-letter parity), and that an unknown keyRef/purpose returns null rather
// than throwing or leaking. The private RSA material never leaves the keystore on any path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createPublicKey, publicEncrypt, verify as rsaVerify, randomBytes, constants } from 'node:crypto';

import { defaultEbicsKeystore } from '../../dist/core/banking/ebics/keystore.js';
import { fileEbicsKeystore } from '../../dist/core/banking/ebics/keystore-file.js';

function tmpPath() {
  const dir = mkdtempSync(join(tmpdir(), 'till-ks-sign-'));
  return join(dir, 'keystore.v1');
}

// Rebuild a usable public KeyObject from the SPKI DER the store hands out, so the test verifies
// against ONLY what left the keystore (never the private key).
function publicKeyFromMaterial(material) {
  return createPublicKey({ key: material.spkiDer, type: 'spki', format: 'der' });
}

// The full contract, run against a store that has already generated one connection's keys.
function assertSigningFacet(store, keyRef, hashes) {
  // 1. sign -> verifies with the corresponding PUBLIC key, and NOT for a tampered message.
  for (const purpose of ['electronicSignature', 'authentication']) {
    const data = Buffer.from(`the INI letter body for ${purpose}`, 'utf8');
    const sig = store.sign({ keyRef, purpose, data });
    assert.ok(Buffer.isBuffer(sig) && sig.length > 0, `${purpose}: sign returns bytes`);

    const pub = publicKeyFromMaterial(store.publicKeyMaterial({ keyRef, purpose }));
    assert.equal(rsaVerify('sha256', data, pub, sig), true, `${purpose}: signature verifies`);

    const tampered = Buffer.from(`the INI letter body for ${purpose}!`, 'utf8');
    assert.equal(rsaVerify('sha256', tampered, pub, sig), false, `${purpose}: tampered message must NOT verify`);
  }

  // 2. decrypt round-trips: encrypt a random 32-byte symmetric key to the E002 public key, recover it.
  const encPub = publicKeyFromMaterial(store.publicKeyMaterial({ keyRef, purpose: 'encryption' }));
  const payload = randomBytes(32);
  for (const [padding, oaep] of [['pkcs1', false], ['oaep', true]]) {
    const ct = publicEncrypt(
      { key: encPub, padding: oaep ? constants.RSA_PKCS1_OAEP_PADDING : constants.RSA_PKCS1_PADDING },
      payload,
    );
    const pt = store.decrypt({ keyRef, purpose: 'encryption', ciphertext: ct, padding });
    assert.ok(Buffer.isBuffer(pt), `${padding}: decrypt returns bytes`);
    assert.deepEqual(pt, payload, `${padding}: decrypt round-trips the payload`);
  }
  // default padding (omitted) is pkcs1.
  const ctDefault = publicEncrypt({ key: encPub, padding: constants.RSA_PKCS1_PADDING }, payload);
  assert.deepEqual(store.decrypt({ keyRef, purpose: 'encryption', ciphertext: ctDefault }), payload, 'default padding is pkcs1');

  // 3. FINGERPRINT PARITY: sha256(spkiDer) hex EQUALS the value publicHashes already computed, for
  //    each purpose. The wire's INI-letter hashes must match the core's fingerprints exactly.
  for (const purpose of ['electronicSignature', 'authentication', 'encryption']) {
    const material = store.publicKeyMaterial({ keyRef, purpose });
    const fp = createHash('sha256').update(material.spkiDer).digest('hex');
    assert.equal(fp, hashes[purpose], `${purpose}: spkiDer fingerprint matches publicHashes`);
    // modulus/exponent are real, non-empty public bytes; exponent is the usual 65537 (0x010001).
    assert.ok(Buffer.isBuffer(material.modulus) && material.modulus.length >= 256, `${purpose}: modulus present`);
    assert.ok(Buffer.isBuffer(material.exponent) && material.exponent.length > 0, `${purpose}: exponent present`);
  }

  // 4. Unknown keyRef / wrong purpose returns null, never throws, never leaks.
  assert.equal(store.sign({ keyRef: 'ebicskey-nope', purpose: 'authentication', data: Buffer.from('x') }), null, 'unknown keyRef sign -> null');
  assert.equal(store.decrypt({ keyRef: 'ebicskey-nope', purpose: 'encryption', ciphertext: Buffer.from('x') }), null, 'unknown keyRef decrypt -> null');
  assert.equal(store.publicKeyMaterial({ keyRef: 'ebicskey-nope', purpose: 'encryption' }), null, 'unknown keyRef material -> null');
  // A purpose outside the allowed set for the method returns null (cast through to exercise the guard).
  assert.equal(store.sign({ keyRef, purpose: 'encryption', data: Buffer.from('x') }), null, 'sign with encryption purpose -> null');
  assert.equal(store.decrypt({ keyRef, purpose: 'authentication', ciphertext: Buffer.from('x') }), null, 'decrypt with authentication purpose -> null');
  assert.equal(store.publicKeyMaterial({ keyRef, purpose: 'bogus' }), null, 'material with bogus purpose -> null');
}

test('defaultEbicsKeystore (in-memory): sign/decrypt/publicKeyMaterial honour the wire contract', () => {
  const gen = defaultEbicsKeystore.generate({ keyLength: 2048 });
  const hashes = defaultEbicsKeystore.publicHashes(gen.keyRef);
  assert.ok(hashes, 'publicHashes present after generate');
  assertSigningFacet(defaultEbicsKeystore, gen.keyRef, hashes);
  defaultEbicsKeystore.destroy(gen.keyRef);
});

test('fileEbicsKeystore (passphrase-encrypted): same facet over the unlocked in-session map', () => {
  const path = tmpPath();
  const PASS = 'correct horse battery staple';
  const store = fileEbicsKeystore(path, () => PASS);
  assert.equal(store.state(), 'ready');
  const gen = store.generate({ keyLength: 2048 });
  const hashes = store.publicHashes(gen.keyRef);
  assert.ok(hashes, 'publicHashes present after generate');
  assertSigningFacet(store, gen.keyRef, hashes);
  store.destroy(gen.keyRef);
  rmSync(path, { force: true });
});

test('fileEbicsKeystore: a LOCKED store returns null from the signing facet (refuse, dont leak)', () => {
  const path = tmpPath();
  const PASS = 'correct horse battery staple';
  // Process 1: create and persist a real keystore.
  const p1 = fileEbicsKeystore(path, () => PASS);
  const gen = p1.generate({ keyLength: 2048 });

  // Process 2: same file, NO passphrase provider and no unlock -> locked. The facet must return null.
  const p2 = fileEbicsKeystore(path);
  assert.equal(p2.state(), 'locked');
  assert.equal(p2.sign({ keyRef: gen.keyRef, purpose: 'authentication', data: Buffer.from('x') }), null, 'locked store sign -> null');
  assert.equal(p2.decrypt({ keyRef: gen.keyRef, purpose: 'encryption', ciphertext: Buffer.from('x') }), null, 'locked store decrypt -> null');
  assert.equal(p2.publicKeyMaterial({ keyRef: gen.keyRef, purpose: 'encryption' }), null, 'locked store material -> null');

  rmSync(path, { force: true });
});
