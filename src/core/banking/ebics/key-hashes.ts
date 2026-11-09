/**
 * The two EBICS hash values a subscriber or a bank key is known by, besides the SPKI fingerprint
 * TILL has always stored as the primary `EbicsKeyHashes` value.
 *
 * 1. THE CLASSIC KEY HASH. EBICS specification 2.5 (H004), section 4.4.1.2.3 "Initialisation
 *    letters" and section 5.5.1.1.1 (BankPubKeyDigests): the SHA-256 hash values of the X002, E002,
 *    A005 and A006 public keys "are composed by concatenating the exponent with a blank character and
 *    the modulus in hexadecimal representation (using lower case letters) without leading zeros (as
 *    to the hexadecimal representation). The resulting string has to be converted into a byte array
 *    based on US ASCII code." Banks publish this value unchanged for H004 and for H005 subscribers
 *    registered with bare keys.
 *
 * 2. THE CERTIFICATE HASH. EBICS 3.0 (H005) registers keys as X.509 certificates (SIX SMPG EBICS 3.0
 *    v1.3 section 6.1). The hash a bank prints for an "H005 with certificates" key, and the value
 *    compared on the initialisation letter, is SHA-256 over the certificate's DER encoding.
 *
 * Both are lowercase hex here; `hash-format.ts` renders them bank-style for humans.
 */

import { createHash, X509Certificate, type KeyObject } from 'node:crypto';
import type { EbicsKeyPurpose } from '../../context.js';

/** Big-endian bytes as lowercase hex with leading zero NIBBLES removed ("0" for an all-zero value). */
export function hexWithoutLeadingZeros(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex').replace(/^0+/, '');
  return hex.length === 0 ? '0' : hex;
}

/** The classic EBICS key hash (EBICS 2.5 section 4.4.1.2.3) from raw modulus/exponent bytes, lowercase hex. */
export function ebicsKeyHashHex(modulus: Uint8Array, exponent: Uint8Array): string {
  const text = `${hexWithoutLeadingZeros(exponent)} ${hexWithoutLeadingZeros(modulus)}`;
  return createHash('sha256').update(Buffer.from(text, 'ascii')).digest('hex');
}

/** The classic EBICS key hash of an RSA public key object. */
export function ebicsKeyHashOfKey(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: 'jwk' }) as { n?: string; e?: string };
  return ebicsKeyHashHex(Buffer.from(jwk.n ?? '', 'base64url'), Buffer.from(jwk.e ?? '', 'base64url'));
}

/** SHA-256 over a certificate's DER bytes, lowercase hex (the H005 certificate hash). */
export function certificateHashHex(der: Uint8Array): string {
  return createHash('sha256').update(der).digest('hex');
}

/** SHA-256 over SPKI DER, lowercase hex: TILL's primary fingerprint, unchanged since A33. */
export function spkiHashHex(spkiDer: Uint8Array): string {
  return createHash('sha256').update(spkiDer).digest('hex');
}

/** Every hash of one certificate: its own DER hash plus the classic key hash of the key it carries. */
export function hashesOfCertificate(der: Uint8Array): { certificateHash: string; keyHash: string; spkiHash: string } {
  const key = new X509Certificate(Buffer.from(der)).publicKey;
  const spki = key.export({ type: 'spki', format: 'der' }) as Buffer;
  return { certificateHash: certificateHashHex(der), keyHash: ebicsKeyHashOfKey(key), spkiHash: spkiHashHex(spki) };
}

/** The three purposes, in the order a letter prints them. */
export const EBICS_KEY_PURPOSES: readonly EbicsKeyPurpose[] = ['electronicSignature', 'authentication', 'encryption'];
