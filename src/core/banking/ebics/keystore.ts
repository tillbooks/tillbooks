/**
 * A33's default key custody (the `EbicsKeystorePort` the core ships when a host wires none).
 *
 * SMPG §3.1 places five obligations on the software developer: the participant's private keys are
 * protected from being read or changed by unauthorized parties, the bank's public keys are
 * change-protected, the secret symmetric keys are protected, the TLS trust anchor is protected, and
 * the software is protected against manipulation that could mislead the participant. This module
 * honours the FIRST directly: the three RSA private keys generated for a connection live ONLY in this
 * process's memory, addressed by an opaque `keyRef`, and are NEVER serialized to SQLite, a log line, a
 * thrown error, or an MCP result (spec §4, tripwire 3). Only SHA-256 fingerprints of the PUBLIC keys
 * leave this module, which is exactly what the INI letter and the HPB comparison need.
 *
 * The mechanism is spec open question 2: macOS Keychain vs a passphrase-encrypted keystore file. The
 * core default is an in-process store (correct key custody, offline-testable), and a host replaces it
 * with a persistent keystore via `ctx.ebicsKeystore`. Generating real RSA key pairs keeps this an
 * honest OSS-core implementation, not a stub: the keys are genuine, the hashes are genuine.
 *
 * NO PRIVATE EXPORT PATH. There is deliberately no method that returns private key material in any
 * form. `sign`/`decrypt` operate INSIDE this module over the in-memory private PEM and return only the
 * signature or the recovered plaintext; `publicKeyMaterial` returns PUBLIC material only. No caller can
 * serialize a private key.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  randomUUID,
  sign as rsaSign,
  constants,
} from 'node:crypto';
import type { EbicsKeystorePort, EbicsKeyHashes, EbicsKeyPurpose } from '../../context.js';

interface StoredKeyPair {
  /** PEM private key. Held in memory only; never returned by any method. */
  privatePem: string;
  /** SHA-256 fingerprint (hex) of the DER-encoded public key. The only thing that ever leaves. */
  publicHashHex: string;
}

interface StoredConnectionKeys {
  electronicSignature: StoredKeyPair;
  authentication: StoredKeyPair;
  encryption: StoredKeyPair;
}

/**
 * The process-global custody store. A `keyRef` is a random UUID, so two connections never collide and
 * one workspace can never address another's keys. Private material lives here and nowhere else; a
 * process exit forgets it, exactly as a keystore-file host would persist it (mechanism, open Q2).
 */
const KEYSTORE = new Map<string, StoredConnectionKeys>();

/** Generate one RSA key pair and its public fingerprint. `modulusLength` is the captured key length (§3.4). */
function generatePair(modulusLength: number): StoredKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const publicHashHex = createHash('sha256').update(publicDer).digest('hex');
  return { privatePem, publicHashHex };
}

/**
 * The RSA padding constant for the two `decrypt` modes. PKCS#1 v1.5 is the EBICS-classic transaction
 * key wrapping; OAEP is offered for a bank profile that negotiates it. Default is pkcs1.
 */
function paddingConstant(padding: 'pkcs1' | 'oaep' | undefined): number {
  return padding === 'oaep' ? constants.RSA_PKCS1_OAEP_PADDING : constants.RSA_PKCS1_PADDING;
}

/** Sign `data` (RSASSA-PKCS1-v1_5, sha256) with a stored pair's private PEM. Never returns key material. */
function signWithPair(pair: StoredKeyPair, data: Buffer): Buffer {
  return rsaSign('sha256', data, createPrivateKey(pair.privatePem));
}

/** RSA-decrypt `ciphertext` with a stored pair's private PEM under the chosen padding. Returns the plaintext. */
function decryptWithPair(pair: StoredKeyPair, ciphertext: Buffer, padding: 'pkcs1' | 'oaep' | undefined): Buffer {
  return privateDecrypt({ key: createPrivateKey(pair.privatePem), padding: paddingConstant(padding) }, ciphertext);
}

/**
 * Derive the PUBLIC material for a stored pair from its private PEM: the SPKI DER (whose sha256 is the
 * `publicHashes` fingerprint) plus the RSA modulus and exponent from a JWK export. PUBLIC only.
 */
function publicMaterialOf(pair: StoredKeyPair): { spkiDer: Buffer; modulus: Buffer; exponent: Buffer } {
  const publicKey = createPublicKey(pair.privatePem);
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const jwk = publicKey.export({ format: 'jwk' }) as { n?: string; e?: string };
  return {
    spkiDer,
    modulus: Buffer.from(jwk.n ?? '', 'base64url'),
    exponent: Buffer.from(jwk.e ?? '', 'base64url'),
  };
}

/**
 * The core's in-process keystore. Generates the three key pairs (electronic signature, authentication,
 * encryption; SMPG §3.4), holds the private material in memory, and hands back a locator plus the
 * public fingerprints. `publicHashes` re-reads the fingerprints for re-rendering the INI letter;
 * `destroy` forgets a connection's keys on retire (idempotent). `sign`/`decrypt`/`publicKeyMaterial`
 * are the signing facet the EBICS wire needs, operating over the in-memory private map without ever
 * returning private material.
 */
export const defaultEbicsKeystore: EbicsKeystorePort = {
  generate(input: { keyLength: number }): { keyRef: string; hashes: EbicsKeyHashes } {
    const keyLength = Number.isInteger(input.keyLength) && input.keyLength >= 2048 ? input.keyLength : 2048;
    const keys: StoredConnectionKeys = {
      electronicSignature: generatePair(keyLength),
      authentication: generatePair(keyLength),
      encryption: generatePair(keyLength),
    };
    const keyRef = `ebicskey-${randomUUID()}`;
    KEYSTORE.set(keyRef, keys);
    return { keyRef, hashes: publicHashesOf(keys) };
  },

  publicHashes(keyRef: string): EbicsKeyHashes | null {
    const keys = KEYSTORE.get(keyRef);
    return keys === undefined ? null : publicHashesOf(keys);
  },

  destroy(keyRef: string): void {
    KEYSTORE.delete(keyRef);
  },

  sign(req: { keyRef: string; purpose: 'authentication' | 'electronicSignature'; data: Buffer; hash?: 'sha256' }): Buffer | null {
    const keys = KEYSTORE.get(req.keyRef);
    if (keys === undefined) return null;
    if (req.purpose !== 'authentication' && req.purpose !== 'electronicSignature') return null;
    return signWithPair(keys[req.purpose], req.data);
  },

  decrypt(req: { keyRef: string; purpose: 'encryption'; ciphertext: Buffer; padding?: 'pkcs1' | 'oaep' }): Buffer | null {
    const keys = KEYSTORE.get(req.keyRef);
    if (keys === undefined) return null;
    if (req.purpose !== 'encryption') return null;
    return decryptWithPair(keys.encryption, req.ciphertext, req.padding);
  },

  publicKeyMaterial(req: { keyRef: string; purpose: EbicsKeyPurpose }): { spkiDer: Buffer; modulus: Buffer; exponent: Buffer } | null {
    const keys = KEYSTORE.get(req.keyRef);
    if (keys === undefined) return null;
    if (req.purpose !== 'electronicSignature' && req.purpose !== 'authentication' && req.purpose !== 'encryption') return null;
    return publicMaterialOf(keys[req.purpose]);
  },
};

function publicHashesOf(keys: StoredConnectionKeys): EbicsKeyHashes {
  return {
    electronicSignature: keys.electronicSignature.publicHashHex,
    authentication: keys.authentication.publicHashHex,
    encryption: keys.encryption.publicHashHex,
  };
}
