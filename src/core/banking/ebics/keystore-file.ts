/**
 * A36, the passphrase-encrypted EBICS keystore FILE (D108 v1 election): the persistent implementation
 * of `EbicsKeystorePort` that makes the A33 ceremony survive a restart (US-A36.2). The core default
 * (`defaultEbicsKeystore`) holds key material in process memory, so a quit after INI/HIA strands the
 * connection the bank just accepted; the `till` CLI and Studio hosts wire THIS store instead.
 *
 * WHAT IS STORED, AND WHAT IS NEVER STORED. A single versioned file (`~/.till/ebics/keystore.v1` by
 * convention; the host names the path) holds the three RSA private keys per connection, addressed by
 * the same opaque `keyRef` the in-memory store uses, encrypted at rest. The envelope is
 * `{v:1, kdf:'scrypt', kdfParams, nonce, ciphertext, tag}`. The plaintext inside is a JSON map
 * `keyRef -> {electronicSignature, authentication, encryption}` of PEM private keys plus their public
 * fingerprints. NOTHING outside this module ever sees a private key or the passphrase: `publicHashes`
 * returns only fingerprints, there is deliberately NO export method, and the passphrase is a host
 * secret this module holds in memory for the process session and never writes anywhere (spec §4,
 * tripwire 3/4). SMPG §3.1's first custody obligation (private keys protected from unauthorized read)
 * is honoured at rest as well as in memory.
 *
 * REFUSE, DON'T GUESS (US-A36.2). A wrong passphrase yields `locked` and leaves the file byte-identical:
 * a wrong passphrase can NEVER mint fresh keys, because that would strand the live bank contract and
 * force a re-ceremony. A missing or corrupt file yields `unavailable`, naming re-initialisation as the
 * one honest recovery; restoring the file from the user's own backup resumes as if nothing happened,
 * which is exactly why the format is a single, versioned, stable artifact.
 *
 * CRYPTO: node:crypto only, no new dependency. scrypt (N=2^15, r=8, p=1) derives a 32-byte key from
 * the passphrase and a per-file random salt; AES-256-GCM encrypts the plaintext under a per-write
 * random 12-byte nonce and authenticates it with the 16-byte tag, so tampering or a wrong key is
 * detected on decrypt rather than yielding garbage.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  randomUUID,
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
  sign as rsaSign,
  constants,
} from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EbicsSigningKeystore, EbicsKeyHashes, EbicsKeystoreState, EbicsKeyPurpose } from '../../context.js';

/** A host callback that supplies the user's passphrase (Studio dialog / CLI prompt), or null on cancel. */
export type PassphraseProvider = () => string | null;

interface StoredKeyPair {
  privatePem: string;
  publicHashHex: string;
}
interface StoredConnectionKeys {
  electronicSignature: StoredKeyPair;
  authentication: StoredKeyPair;
  encryption: StoredKeyPair;
}
type KeyMap = Record<string, StoredConnectionKeys>;

interface Envelope {
  v: 1;
  kdf: 'scrypt';
  kdfParams: { N: number; r: number; p: number; saltHex: string };
  nonceHex: string;
  ciphertextHex: string;
  tagHex: string;
}

// N=2^15, r=8, p=1 is the interactive-login OWASP baseline. `maxmem` must be raised above node's 32MB
// default because scrypt needs ~128*N*r bytes (~33.5MB here); 64MB gives headroom.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keyLen: 32, maxmem: 64 * 1024 * 1024 } as const;

function generatePair(modulusLength: number): StoredKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const publicHashHex = createHash('sha256').update(publicDer).digest('hex');
  return { privatePem, publicHashHex };
}

function hashesOf(keys: StoredConnectionKeys): EbicsKeyHashes {
  return {
    electronicSignature: keys.electronicSignature.publicHashHex,
    authentication: keys.authentication.publicHashHex,
    encryption: keys.encryption.publicHashHex,
  };
}

/** The RSA padding constant for the two `decrypt` modes (PKCS#1 v1.5 default, OAEP on request). */
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

/** Derive the PUBLIC material (SPKI DER + RSA modulus/exponent) for a stored pair from its private PEM. PUBLIC only. */
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

function deriveKey(passphrase: string, saltHex: string): Buffer {
  return scryptSync(passphrase, Buffer.from(saltHex, 'hex'), SCRYPT.keyLen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
}

/** Encrypt the map under a fresh salt+nonce. A per-write salt means a re-write never reuses a keystream. */
function seal(map: KeyMap, passphrase: string): Envelope {
  const saltHex = randomBytes(16).toString('hex');
  const nonce = randomBytes(12);
  const key = deriveKey(passphrase, saltHex);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const plaintext = Buffer.from(JSON.stringify(map), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    kdf: 'scrypt',
    kdfParams: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, saltHex },
    nonceHex: nonce.toString('hex'),
    ciphertextHex: ciphertext.toString('hex'),
    tagHex: tag.toString('hex'),
  };
}

/** Returns the decrypted map, or null when the passphrase is wrong (GCM tag mismatch). Throws only on a corrupt envelope. */
function open(env: Envelope, passphrase: string): KeyMap | null {
  const key = deriveKey(passphrase, env.kdfParams.saltHex);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.nonceHex, 'hex'));
  decipher.setAuthTag(Buffer.from(env.tagHex, 'hex'));
  try {
    const plaintext = Buffer.concat([decipher.update(Buffer.from(env.ciphertextHex, 'hex')), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as KeyMap;
  } catch {
    // A GCM tag mismatch (wrong passphrase or tampering) throws in `final()`. That is `locked`, not
    // `unavailable`: the file is intact, the passphrase is wrong. Refuse, don't guess.
    return null;
  }
}

function isEnvelope(v: unknown): v is Envelope {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return e.v === 1 && e.kdf === 'scrypt' && typeof e.nonceHex === 'string' && typeof e.ciphertextHex === 'string' && typeof e.tagHex === 'string';
}

/**
 * The concrete file keystore. It ALWAYS implements the signing facet (sign/decrypt/publicKeyMaterial),
 * so its type is the signing-capable `EbicsSigningKeystore`, not the bare port: the runtime hands it
 * straight to the private wire (which requires a signing keystore) with no cast. Adds `unlock`
 * (host-facing); the core only ever calls the port methods.
 */
export interface FileEbicsKeystore extends EbicsSigningKeystore {
  /**
   * Try the passphrase (the host prompt's answer). `true` unlocks this process session; `false` leaves
   * the store `locked` and the file byte-identical (refuse, don't guess). On a first-ever ceremony
   * (no file yet) any passphrase is accepted and becomes the file's passphrase on the first `generate`.
   */
  unlock(passphrase: string): boolean;
}

/**
 * Wire a persistent, passphrase-encrypted EBICS keystore at `path`.
 *
 * `passphraseProvider` is the host prompt (Studio dialog / CLI). It is consulted lazily the first time
 * the store needs the passphrase and never after a successful unlock this session. A host that drives
 * `unlock()` explicitly may omit it.
 */
export function fileEbicsKeystore(path: string, passphraseProvider?: PassphraseProvider): FileEbicsKeystore {
  let map: KeyMap | null = null; // the decrypted, in-session map; null while locked/unopened
  let sessionPassphrase: string | null = null;
  let corrupt = false;

  function readEnvelope(): Envelope | null | 'corrupt' {
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (!isEnvelope(parsed)) return 'corrupt';
      return parsed;
    } catch {
      return 'corrupt';
    }
  }

  /** Try to open the store with `passphrase`. Returns the resulting state; sets `map`/`sessionPassphrase` on success. */
  function tryUnlock(passphrase: string): EbicsKeystoreState {
    const env = readEnvelope();
    if (env === 'corrupt') {
      corrupt = true;
      return 'unavailable';
    }
    if (env === null) {
      // No file yet: a fresh store. This passphrase becomes the file's on the first generate/persist.
      map = {};
      sessionPassphrase = passphrase;
      return 'ready';
    }
    const opened = open(env, passphrase);
    if (opened === null) return 'locked';
    map = opened;
    sessionPassphrase = passphrase;
    return 'ready';
  }

  /** Ensure the store is open, consulting the provider once if a passphrase has not yet been supplied. */
  function ensureOpen(): EbicsKeystoreState {
    if (corrupt) return 'unavailable';
    if (map !== null && sessionPassphrase !== null) return 'ready';
    const env = readEnvelope();
    if (env === 'corrupt') {
      corrupt = true;
      return 'unavailable';
    }
    if (passphraseProvider === undefined) return 'locked';
    const supplied = passphraseProvider();
    if (typeof supplied !== 'string' || supplied.length === 0) return 'locked';
    return tryUnlock(supplied);
  }

  function persist(): void {
    if (map === null || sessionPassphrase === null) throw new Error('keystore_locked');
    const env = seal(map, sessionPassphrase);
    mkdirSync(dirname(path), { recursive: true });
    // Atomic write: a full temp file swapped in by rename, so a crash mid-write never truncates the
    // live keystore (a half-written keystore would strand the bank contract).
    const tmp = `${path}.tmp-${randomUUID()}`;
    writeFileSync(tmp, JSON.stringify(env), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  }

  return {
    kind: 'file',
    persistent: true,

    state(): EbicsKeystoreState {
      return ensureOpen();
    },

    unlock(passphrase: string): boolean {
      const s = tryUnlock(passphrase);
      return s === 'ready';
    },

    generate(input: { keyLength: number }): { keyRef: string; hashes: EbicsKeyHashes } {
      const s = ensureOpen();
      if (s !== 'ready' || map === null) {
        // The channel verbs pre-check `state()` (keystoreBlock), so this is unreachable in normal
        // operation; the throw is the last line of "refuse, don't guess" for a direct caller.
        throw new Error(s === 'unavailable' ? 'keystore_unavailable' : 'keystore_locked');
      }
      const keyLength = Number.isInteger(input.keyLength) && input.keyLength >= 2048 ? input.keyLength : 2048;
      const keys: StoredConnectionKeys = {
        electronicSignature: generatePair(keyLength),
        authentication: generatePair(keyLength),
        encryption: generatePair(keyLength),
      };
      const keyRef = `ebicskey-${randomUUID()}`;
      map[keyRef] = keys;
      persist();
      return { keyRef, hashes: hashesOf(keys) };
    },

    publicHashes(keyRef: string): EbicsKeyHashes | null {
      const s = ensureOpen();
      if (s !== 'ready' || map === null) return null;
      const keys = map[keyRef];
      return keys === undefined ? null : hashesOf(keys);
    },

    destroy(keyRef: string): void {
      const s = ensureOpen();
      if (s !== 'ready' || map === null) return; // a locked/unavailable store destroys nothing (idempotent no-op)
      if (map[keyRef] === undefined) return;
      delete map[keyRef];
      if (Object.keys(map).length === 0 && existsSync(path)) {
        // The last connection retired: remove the file rather than leave an empty encrypted envelope.
        try {
          unlinkSync(path);
        } catch {
          persist();
        }
        return;
      }
      persist();
    },

    sign(req: { keyRef: string; purpose: 'authentication' | 'electronicSignature'; data: Buffer; hash?: 'sha256' }): Buffer | null {
      const s = ensureOpen();
      if (s !== 'ready' || map === null) return null;
      if (req.purpose !== 'authentication' && req.purpose !== 'electronicSignature') return null;
      const keys = map[req.keyRef];
      if (keys === undefined) return null;
      return signWithPair(keys[req.purpose], req.data);
    },

    decrypt(req: { keyRef: string; purpose: 'encryption'; ciphertext: Buffer; padding?: 'pkcs1' | 'oaep' }): Buffer | null {
      const s = ensureOpen();
      if (s !== 'ready' || map === null) return null;
      if (req.purpose !== 'encryption') return null;
      const keys = map[req.keyRef];
      if (keys === undefined) return null;
      return decryptWithPair(keys.encryption, req.ciphertext, req.padding);
    },

    publicKeyMaterial(req: { keyRef: string; purpose: EbicsKeyPurpose }): { spkiDer: Buffer; modulus: Buffer; exponent: Buffer } | null {
      const s = ensureOpen();
      if (s !== 'ready' || map === null) return null;
      if (req.purpose !== 'electronicSignature' && req.purpose !== 'authentication' && req.purpose !== 'encryption') return null;
      const keys = map[req.keyRef];
      if (keys === undefined) return null;
      return publicMaterialOf(keys[req.purpose]);
    },
  };
}
