/**
 * EBICS 3.0 (H005) subscriber certificates: a self-signed X.509 v3 certificate per subscriber key,
 * issued INSIDE the keystore where the private key lives (the signing facet deliberately refuses the
 * encryption purpose, so an E002 certificate could never be minted from outside).
 *
 * WHY. SIX, Swiss Market Practice Guidelines EBICS 3.0 v1.3, section 6.1: initialisation "is carried
 * out according to the EBICS 3.0 standard, which provides for X.509 certificates for the registration
 * of new keys", self-signed or CA-issued, with any valid validity date ("Unlimited = 9999-12-31").
 * Section 3.4 fixes the procedures: A005/A006 electronic signature, X002 authentication, E002
 * encryption, 2048 bit.
 *
 * THE PROFILE (RFC 5280), a fixed template and deliberately not a general ASN.1 library:
 *  - version v3, a random positive 128-bit serial (RFC 5280 4.1.2.2: positive, at most 20 octets);
 *  - signature sha256WithRSAEncryption (1.2.840.113549.1.1.11, NULL parameters, RFC 4055);
 *  - issuer = subject = a single CN (self-signed); the CN is the connection's EBICS user id or a
 *    neutral fallback, never a person's or a company's name hardcoded here;
 *  - notBefore = issuance time minus 24 hours (`EBICS_CERT_BACKDATE_MS`), so a bank host whose clock
 *    runs behind ours never sees a not-yet-valid certificate (UTCTime, RFC 5280 4.1.2.5: dates through
 *    2049 are UTCTime),
 *    notAfter = 9999-12-31T23:59:59Z as GeneralizedTime (the SMPG "unlimited" value; RFC 5280
 *    4.1.2.5 names 99991231235959Z as the no-well-defined-expiration value);
 *  - extensions: basicConstraints cA=FALSE (critical), keyUsage (critical: digitalSignature for the
 *    A00x and X002 keys, keyEncipherment for E002), subjectKeyIdentifier (RFC 5280 4.2.1.2 method 1).
 *
 * No dependency: DER is hand-encoded below and the signature is `node:crypto` RSASSA-PKCS1-v1_5 over
 * the TBSCertificate. The private key is only ever passed in by the keystore and never leaves it.
 */

import { createHash, randomBytes, sign as rsaSign, type KeyObject } from 'node:crypto';
import type { EbicsKeyPurpose } from '../../context.js';

/** The notAfter every TILL subscriber certificate carries (SMPG v1.3 section 6.1, "Unlimited"). */
export const EBICS_CERT_NOT_AFTER = '99991231235959Z';

/** notBefore is backdated by this much (24 h) against clock skew with a strict bank host. */
export const EBICS_CERT_BACKDATE_MS = 24 * 60 * 60 * 1000;

/** The CN used when the caller supplies no subject (a neutral string, no personal data). */
export const EBICS_CERT_DEFAULT_CN = 'TILL EBICS subscriber';

// --- minimal DER encoder (definite-length, the handful of types a certificate needs) -----------

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const explicit = (n: number, content: Buffer): Buffer => tlv(0xa0 | n, content);
const octetString = (b: Buffer): Buffer => tlv(0x04, b);
const bitString = (b: Buffer, unusedBits = 0): Buffer => tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), b]));
const derNull = (): Buffer => Buffer.from([0x05, 0x00]);
const derTrue = (): Buffer => Buffer.from([0x01, 0x01, 0xff]);

/** A non-negative INTEGER from big-endian magnitude bytes: minimal, with a 0x00 pad when the top bit is set. */
function derUnsignedInteger(magnitude: Buffer): Buffer {
  let i = 0;
  while (i < magnitude.length - 1 && magnitude[i] === 0) i += 1;
  let body = magnitude.subarray(i);
  if (body.length === 0) body = Buffer.from([0]);
  if ((body[0] as number) & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return tlv(0x02, body);
}

function derOid(dotted: string): Buffer {
  const arcs = dotted.split('.').map((s) => Number(s));
  const first = (arcs[0] as number) * 40 + (arcs[1] as number);
  const out: number[] = [];
  for (const arc of [first, ...arcs.slice(2)]) {
    const chunk: number[] = [arc & 0x7f];
    let v = Math.floor(arc / 128);
    while (v > 0) {
      chunk.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** RFC 5280 4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050. Seconds precision, Zulu. */
function derTime(d: Date): Buffer {
  const y = d.getUTCFullYear();
  const rest = `${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
  if (y >= 1950 && y <= 2049) return tlv(0x17, Buffer.from(`${pad2(y % 100)}${rest}`, 'ascii'));
  return tlv(0x18, Buffer.from(`${String(y).padStart(4, '0')}${rest}`, 'ascii'));
}

const OID = {
  sha256WithRSAEncryption: '1.2.840.113549.1.1.11',
  commonName: '2.5.4.3',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  subjectKeyIdentifier: '2.5.29.14',
} as const;

function algorithmIdentifier(): Buffer {
  return seq(derOid(OID.sha256WithRSAEncryption), derNull());
}

function nameWithCn(cn: string): Buffer {
  // UTF8String (tag 0x0c), the RFC 5280 4.1.2.4 MUST for new DirectoryString encodings.
  return seq(set(seq(derOid(OID.commonName), tlv(0x0c, Buffer.from(cn, 'utf8')))));
}

/**
 * The keyUsage BIT STRING per purpose (RFC 5280 4.2.1.3, DER named-bit-list: trailing zero bits
 * dropped). digitalSignature is bit 0, nonRepudiation (contentCommitment) bit 1, keyEncipherment bit 2.
 *  - X002 authentication: digitalSignature (0x80, 7 unused bits);
 *  - A00x electronic signature: digitalSignature + nonRepudiation (0xC0, 6 unused), the ES being the
 *    bank-technical signature that commits to an order;
 *  - E002 encryption: keyEncipherment (0x20, 5 unused).
 * keyCertSign is deliberately NOT asserted: RFC 5280 4.2.1.3 allows it only with cA=TRUE, and these
 * are end-entity certificates. Consequence, measured: OpenSSL's issuer check (`X509Certificate
 * .checkIssued`) answers false for the certificate against itself, because it requires keyCertSign on
 * the issuer; self-issuance is proven instead by issuer == subject and a signature that verifies
 * under the certificate's own public key.
 */
function keyUsageFor(purpose: EbicsKeyPurpose): Buffer {
  if (purpose === 'encryption') return bitString(Buffer.from([0x20]), 5);
  if (purpose === 'electronicSignature') return bitString(Buffer.from([0xc0]), 6);
  return bitString(Buffer.from([0x80]), 7);
}

function extension(oid: string, critical: boolean, value: Buffer): Buffer {
  return critical ? seq(derOid(oid), derTrue(), octetString(value)) : seq(derOid(oid), octetString(value));
}

/** Normalise a CN: trimmed, control characters removed, at most 64 characters (ub-common-name). */
export function certificateCommonName(raw: unknown): string {
  const cleaned = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  const cn = cleaned.length > 0 ? cleaned : EBICS_CERT_DEFAULT_CN;
  return Array.from(cn).slice(0, 64).join('');
}

/**
 * Issue a self-signed X.509 v3 certificate for one subscriber key pair and return its DER. The
 * keystore passes its own KeyObjects; nothing here persists or returns private material.
 */
export function issueSelfSignedCertificate(input: {
  privateKey: KeyObject;
  publicKey: KeyObject;
  purpose: EbicsKeyPurpose;
  commonName?: string | undefined;
  now?: Date | undefined;
}): Buffer {
  const cn = certificateCommonName(input.commonName);
  const now = input.now ?? new Date();
  const notBefore = new Date(Math.floor((now.getTime() - EBICS_CERT_BACKDATE_MS) / 1000) * 1000);

  const serial = randomBytes(16);
  // Positive (top bit clear) and non-zero leading octet, so the INTEGER is exactly 16 octets.
  serial[0] = ((serial[0] as number) & 0x7f) | 0x01;

  const spkiDer = input.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  // RFC 5280 4.2.1.2 method (1): SHA-1 over the subjectPublicKey BIT STRING value, which for RSA is
  // exactly the PKCS#1 RSAPublicKey DER.
  const rsaPublicKeyDer = input.publicKey.export({ type: 'pkcs1', format: 'der' }) as Buffer;
  const ski = createHash('sha1').update(rsaPublicKeyDer).digest();

  const extensions = seq(
    extension(OID.basicConstraints, true, seq()),
    extension(OID.keyUsage, true, keyUsageFor(input.purpose)),
    extension(OID.subjectKeyIdentifier, false, octetString(ski)),
  );

  const name = nameWithCn(cn);
  const tbs = seq(
    explicit(0, derUnsignedInteger(Buffer.from([2]))),
    derUnsignedInteger(serial),
    algorithmIdentifier(),
    name,
    seq(derTime(notBefore), tlv(0x18, Buffer.from(EBICS_CERT_NOT_AFTER, 'ascii'))),
    name,
    spkiDer,
    explicit(3, extensions),
  );
  const signature = rsaSign('sha256', tbs, input.privateKey);
  return seq(tbs, algorithmIdentifier(), bitString(signature));
}
