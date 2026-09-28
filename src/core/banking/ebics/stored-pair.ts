/**
 * The per-key record both keystores hold (the in-process default and the passphrase-encrypted file),
 * and the pure derivations over it. One definition, so the two stores cannot drift on how a key is
 * generated, certified, fingerprinted or dropped.
 *
 * OD-2 (owner, 24/25.09.2026; A36 D-A36.9): TILL generates the electronic-signature (A005) pair,
 * self-signs its certificate with it, and DROPS the private key before the record exists, so no
 * keystore write, backup, second process or stolen passphrase can ever sign an order. The A005 record
 * carries the public key and the certificate only. The X002 (authentication) and E002 (encryption)
 * records keep their private keys: every request is authenticated and every download decrypted.
 *
 * `certDerB64` is the key's self-signed EBICS 3.0 subscriber certificate (`certificates.ts`), issued
 * ONCE at generation and kept with the key, so the certificate (and its hash on the INI letter) is
 * stable across restarts. A record written before certificates existed has none; it is read as before
 * and nothing re-issues a certificate behind the owner's back.
 */

import { createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { EbicsKeyHashes, EbicsKeyPurpose } from '../../context.js';
import { issueSelfSignedCertificate } from './certificates.js';
import { certificateHashHex, ebicsKeyHashOfKey, spkiHashHex, EBICS_KEY_PURPOSES } from './key-hashes.js';

export interface StoredKeyPair {
  /** PEM private key (PKCS#8). X002 and E002 only: ABSENT on every A005 record written since A36 (OD-2). */
  privatePem?: string;
  /** PEM public key (SPKI). Present on every record written since A36; derived from `privatePem` before. */
  publicPem?: string;
  /** SHA-256 over the SPKI DER (hex): the primary fingerprint. */
  publicHashHex: string;
  /** The self-signed subscriber certificate, base64 DER. Absent on a pre-certificate record. */
  certDerB64?: string;
}

export type StoredConnectionKeys = Record<EbicsKeyPurpose, StoredKeyPair>;

/** The purposes whose private key the keystore keeps. The A005 key is never among them (OD-2). */
export const KEPT_PRIVATE_PURPOSES: readonly EbicsKeyPurpose[] = ['authentication', 'encryption'];

/**
 * OD-2 for a keystore written BEFORE A36: such a record may still hold the A005 private key. This drops
 * it from every record of `keys` IN PLACE, keeping (or deriving first) the public key, the certificate
 * when there is one, and the fingerprint, so the public hashes the bank and the INI letter know do not
 * change. Returns how many A005 private keys were dropped; the caller persists the result with the
 * store's own fsync'd atomic rewrite. The X002 and E002 private keys are never touched.
 */
export function dropElectronicSignaturePrivateKeys(keys: Record<string, StoredConnectionKeys>): number {
  let dropped = 0;
  for (const connection of Object.values(keys)) {
    const es = connection.electronicSignature;
    if (!es || typeof es.privatePem !== 'string' || es.privatePem.length === 0) continue;
    if (typeof es.publicPem !== 'string' || es.publicPem.length === 0) {
      es.publicPem = createPublicKey(es.privatePem).export({ type: 'spki', format: 'pem' }).toString();
    }
    delete es.privatePem;
    dropped += 1;
  }
  return dropped;
}

/** The public key of a stored pair (from `publicPem`, or derived from a pre-A36 record's private key). */
export function publicKeyOfStored(pair: StoredKeyPair): KeyObject {
  if (typeof pair.publicPem === 'string' && pair.publicPem.length > 0) return createPublicKey(pair.publicPem);
  if (typeof pair.privatePem === 'string' && pair.privatePem.length > 0) return createPublicKey(pair.privatePem);
  throw new Error('keystore record holds no key');
}

/**
 * Generate one RSA pair for `purpose` and certify it (self-signed, SMPG v1.3 section 6.1). For the
 * electronic signature the private key signs its own certificate and is then dropped: the record never
 * holds it (OD-2).
 */
export function generateStoredPair(modulusLength: number, purpose: EbicsKeyPurpose, commonName: string | undefined): StoredKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const publicHashHex = spkiHashHex(publicKey.export({ type: 'spki', format: 'der' }) as Buffer);
  const certDer = issueSelfSignedCertificate({ privateKey, publicKey, purpose, commonName });
  const record: StoredKeyPair = { publicPem, publicHashHex, certDerB64: certDer.toString('base64') };
  if ((KEPT_PRIVATE_PURPOSES as readonly string[]).includes(purpose)) {
    record.privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  }
  return record;
}

/** Generate and certify the three pairs of one connection (A005, X002, E002; SMPG v1.3 section 3.4). */
export function generateConnectionKeys(input: { keyLength: number; subjectCommonName?: string | undefined }): StoredConnectionKeys {
  const keyLength = Number.isInteger(input.keyLength) && input.keyLength >= 2048 ? input.keyLength : 2048;
  return {
    electronicSignature: generateStoredPair(keyLength, 'electronicSignature', input.subjectCommonName),
    authentication: generateStoredPair(keyLength, 'authentication', input.subjectCommonName),
    encryption: generateStoredPair(keyLength, 'encryption', input.subjectCommonName),
  };
}

/**
 * The public hashes of a connection's keys: the primary SPKI fingerprints, the classic EBICS key hashes,
 * and the certificate hashes for every key that carries a certificate.
 */
export function hashesOfStored(keys: StoredConnectionKeys): EbicsKeyHashes {
  const keyHashes: Partial<Record<EbicsKeyPurpose, string>> = {};
  const certificateHashes: Partial<Record<EbicsKeyPurpose, string>> = {};
  for (const purpose of EBICS_KEY_PURPOSES) {
    const pair = keys[purpose];
    keyHashes[purpose] = ebicsKeyHashOfKey(publicKeyOfStored(pair));
    if (typeof pair.certDerB64 === 'string' && pair.certDerB64.length > 0) {
      certificateHashes[purpose] = certificateHashHex(Buffer.from(pair.certDerB64, 'base64'));
    }
  }
  const hashes: EbicsKeyHashes = {
    electronicSignature: keys.electronicSignature.publicHashHex,
    authentication: keys.authentication.publicHashHex,
    encryption: keys.encryption.publicHashHex,
    keyHashes,
  };
  if (Object.keys(certificateHashes).length > 0) hashes.certificateHashes = certificateHashes;
  return hashes;
}

/** The PUBLIC material for one stored pair (SPKI DER, modulus, exponent, and the certificate when held). */
export function publicMaterialOfStored(pair: StoredKeyPair): { spkiDer: Buffer; modulus: Buffer; exponent: Buffer; x509Der?: Buffer } {
  const publicKey = publicKeyOfStored(pair);
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const jwk = publicKey.export({ format: 'jwk' }) as { n?: string; e?: string };
  const material: { spkiDer: Buffer; modulus: Buffer; exponent: Buffer; x509Der?: Buffer } = {
    spkiDer,
    modulus: Buffer.from(jwk.n ?? '', 'base64url'),
    exponent: Buffer.from(jwk.e ?? '', 'base64url'),
  };
  if (typeof pair.certDerB64 === 'string' && pair.certDerB64.length > 0) material.x509Der = Buffer.from(pair.certDerB64, 'base64');
  return material;
}
