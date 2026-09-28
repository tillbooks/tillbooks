/**
 * A33's default key custody (the `EbicsKeystorePort` the core ships when a host wires none).
 *
 * SMPG §3.1 places five obligations on the software developer: the participant's private keys are
 * protected from being read or changed by unauthorized parties, the bank's public keys are
 * change-protected, the secret symmetric keys are protected, the TLS trust anchor is protected, and
 * the software is protected against manipulation that could mislead the participant. This module
 * honours the FIRST directly: the private keys generated for a connection live ONLY in this process's
 * memory, addressed by an opaque `keyRef`, and are NEVER serialized to SQLite, a log line, a thrown
 * error, or an MCP result (spec §4, tripwire 3). Only PUBLIC hashes leave this module.
 *
 * A36 (D-A36.9): every key carries its self-signed X.509 certificate, and the electronic-signature
 * (A005) private key is dropped at generation (OD-2), exactly as the file store does; both stores share
 * `stored-pair.ts`, so they cannot drift. `sign` answers the authentication purpose only.
 *
 * NO PRIVATE EXPORT PATH. There is deliberately no method that returns private key material in any
 * form. `sign`/`decrypt` operate INSIDE this module and return only the signature or the recovered
 * plaintext; `publicKeyMaterial` returns PUBLIC material only.
 */

import { createPrivateKey, privateDecrypt, randomUUID, sign as rsaSign, constants } from 'node:crypto';
import type { EbicsSigningKeystore, EbicsKeyHashes, EbicsKeyPurpose } from '../../context.js';
import { generateConnectionKeys, hashesOfStored, publicMaterialOfStored, type StoredConnectionKeys } from './stored-pair.js';

/**
 * The process-global custody store. A `keyRef` is a random UUID, so two connections never collide and
 * one workspace can never address another's keys. A process exit forgets it.
 */
const KEYSTORE = new Map<string, StoredConnectionKeys>();

/** The RSA padding constant for the two `decrypt` modes (PKCS#1 v1.5 default, OAEP on request). */
function paddingConstant(padding: 'pkcs1' | 'oaep' | undefined): number {
  return padding === 'oaep' ? constants.RSA_PKCS1_OAEP_PADDING : constants.RSA_PKCS1_PADDING;
}

/**
 * The core's in-process keystore: generates and certifies the three pairs (A005, X002, E002; SMPG
 * §3.4), keeps the X002 and E002 private keys in memory, drops the A005 one (OD-2), and hands back a
 * locator plus the public hashes.
 */
export const defaultEbicsKeystore: EbicsSigningKeystore = {
  generate(input: { keyLength: number; subjectCommonName?: string | undefined }): { keyRef: string; hashes: EbicsKeyHashes } {
    const keys = generateConnectionKeys(input);
    const keyRef = `ebicskey-${randomUUID()}`;
    KEYSTORE.set(keyRef, keys);
    return { keyRef, hashes: hashesOfStored(keys) };
  },

  publicHashes(keyRef: string): EbicsKeyHashes | null {
    const keys = KEYSTORE.get(keyRef);
    return keys === undefined ? null : hashesOfStored(keys);
  },

  destroy(keyRef: string): void {
    KEYSTORE.delete(keyRef);
  },

  sign(req: { keyRef: string; purpose: 'authentication'; data: Buffer; hash?: 'sha256' }): Buffer | null {
    const keys = KEYSTORE.get(req.keyRef);
    // OD-2: only the X002 key signs; an electronic-signature request finds no key and gets null.
    if (keys === undefined || req.purpose !== 'authentication') return null;
    const pem = keys.authentication.privatePem;
    if (pem === undefined) return null;
    return rsaSign('sha256', req.data, createPrivateKey(pem));
  },

  decrypt(req: { keyRef: string; purpose: 'encryption'; ciphertext: Buffer; padding?: 'pkcs1' | 'oaep' }): Buffer | null {
    const keys = KEYSTORE.get(req.keyRef);
    if (keys === undefined || req.purpose !== 'encryption') return null;
    const pem = keys.encryption.privatePem;
    if (pem === undefined) return null;
    return privateDecrypt({ key: createPrivateKey(pem), padding: paddingConstant(req.padding) }, req.ciphertext);
  },

  publicKeyMaterial(req: { keyRef: string; purpose: EbicsKeyPurpose }): { spkiDer: Buffer; modulus: Buffer; exponent: Buffer; x509Der?: Buffer } | null {
    const keys = KEYSTORE.get(req.keyRef);
    if (keys === undefined) return null;
    if (req.purpose !== 'electronicSignature' && req.purpose !== 'authentication' && req.purpose !== 'encryption') return null;
    return publicMaterialOfStored(keys[req.purpose]);
  },
};
