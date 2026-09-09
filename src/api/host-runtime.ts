/**
 * The host live-wire seam (D108). The MIT core ships a structurally complete EBICS client whose
 * transport SEAM degrades honestly (`needs_bank_transport`) instead of opening a socket; the actual
 * bank wire is a RUNTIME concern that lives in a PRIVATE package (`@tillbooks/ebics-wire`). This
 * module is the one place the packaged `till` CLI / Studio attaches that private wire, WITHOUT the
 * core ever importing it.
 *
 * How the attachment stays MIT-safe and D108-clean:
 *  - The private package is NEVER named by a static import here. It is reached ONLY through the
 *    operator-set `TILL_EBICS_RUNTIME` module specifier and a runtime `import()`. In the OSS build
 *    the env is unset, the import never happens, and every EBICS network step degrades exactly as it
 *    does today. So this file carries no private code and opens no socket.
 *  - The core keeps custody: the signing keystore is the core's own `fileEbicsKeystore` (local crypto,
 *    private material never leaves it, consistent with D29). The private module supplies ONLY the live
 *    socket wire, which is exactly the line D108 draws.
 *  - A set-but-broken runtime is LOUD, not silent: if the operator asked for a live wire and it cannot
 *    be built (missing module, missing keystore path, unexpected exports), this throws rather than
 *    quietly falling back to offline. A live contract silently degrading to "offline" is the failure
 *    mode we most want to avoid.
 *
 * The `fetchBankKeys` composition (design 4.2 option a). The core's `createEbicsHttpsTransport`
 * degrades HPB even when wired, because parsing the bank's returned public keys into fingerprints is
 * runtime work. So the live transport delegates every method to `createEbicsHttpsTransport({ wire })`
 * EXCEPT `fetchBankKeys`, which it overrides with the private package's HPB parser. Core's
 * pin/compare/MITM logic (`advanceConnection`) is untouched: the runtime only produces fingerprints,
 * the core decides trust.
 */

import { readFileSync } from 'node:fs';

import { fileEbicsKeystore, type PassphraseProvider } from '../core/banking/ebics/keystore-file.js';
import { createEbicsHttpsTransport, type EbicsWire } from '../core/banking/ebics/transport-https.js';
import type {
  EbicsConnectionRef,
  EbicsKeyHashes,
  EbicsKeystorePort,
  EbicsSigningKeystore,
  EbicsTransportPort,
} from '../core/context.js';

/** The env var naming the private wire module (its built entry, or the package name once published).
 *  Unset -> no live wire, honest degrade (the OSS default). */
export const EBICS_RUNTIME_ENV = 'TILL_EBICS_RUNTIME';
/** The passphrase-encrypted keystore file the live wire signs and decrypts with. Required when live. */
export const EBICS_KEYSTORE_PATH_ENV = 'TILL_EBICS_KEYSTORE_PATH';
/**
 * The keystore passphrase for a headless (server) unlock. Sensitive. It is effectively REQUIRED for a
 * working live wire under `till serve` / `till up`: those entrypoints have no interactive prompt, so
 * without it the store stays locked and every channel verb refuses `keystore_locked`. (An interactive
 * `till` command could instead drive the keystore's own `unlock()`; none does today.)
 */
export const EBICS_KEYSTORE_PASSPHRASE_ENV = 'TILL_EBICS_KEYSTORE_PASSPHRASE';
/** A PEM file whose certificate is ADDED as an extra TLS trust anchor (a private/test CA). Optional;
 *  production leaves it unset and rides the platform anchors. It only ever ADDS trust: verification is
 *  never disabled. */
export const EBICS_CA_FILE_ENV = 'TILL_EBICS_CA_FILE';

/** The public shape the `TILL_EBICS_RUNTIME` module must expose. This is a CONTRACT the host module
 *  fulfils (the `@tillbooks/ebics-wire` surface), declared structurally so no static import is needed. */
interface HostWireModule {
  createEbicsWire(opts: {
    keystore: EbicsSigningKeystore;
    tls?: { minVersion?: 'TLSv1.2' | 'TLSv1.3'; ca?: Array<string | Uint8Array> };
  }): EbicsWire;
  createEbicsTransport(opts: { wire: EbicsWire }): {
    wire: EbicsWire;
    fetchBankKeys(req: { connection: EbicsConnectionRef }):
      | { ok: true; bankKeyHashes: { authentication: string; encryption: string } }
      | { ok: false; reason: string };
  };
}

/** The ports a live host runtime supplies. Both absent means "no live wire", the honest OSS default. */
export interface HostEbicsPorts {
  ebicsTransport?: EbicsTransportPort;
  ebicsKeystore?: EbicsKeystorePort;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${EBICS_RUNTIME_ENV} is set (a live EBICS wire was requested) but ${name} is not. ` +
        `Set ${name}, or unset ${EBICS_RUNTIME_ENV} to run offline.`,
    );
  }
  return value;
}

function isHostWireModule(mod: unknown): mod is HostWireModule {
  return (
    typeof mod === 'object' &&
    mod !== null &&
    typeof (mod as { createEbicsWire?: unknown }).createEbicsWire === 'function' &&
    typeof (mod as { createEbicsTransport?: unknown }).createEbicsTransport === 'function'
  );
}

/**
 * Resolve the host's live EBICS wire, or return `{}` when none is configured.
 *
 * Unset `TILL_EBICS_RUNTIME` -> `{}` (offline, honest degrade). Set -> build the core file keystore,
 * dynamically load the private wire module, compose the live transport, and return both ports. A
 * misconfiguration throws (a requested live wire must not silently become offline).
 */
export async function resolveEbicsRuntime(): Promise<HostEbicsPorts> {
  const specifier = process.env[EBICS_RUNTIME_ENV];
  if (specifier === undefined || specifier.trim() === '') return {};

  const keystorePath = requireEnv(EBICS_KEYSTORE_PATH_ENV);

  const passphrase = process.env[EBICS_KEYSTORE_PASSPHRASE_ENV];
  const passphraseProvider: PassphraseProvider | undefined =
    passphrase !== undefined && passphrase !== '' ? () => passphrase : undefined;

  const keystore = fileEbicsKeystore(keystorePath, passphraseProvider);
  // A headless server (`till serve` / `till up`) has no prompt, so the env passphrase is how the store
  // is unlocked up front for the wire to sign/decrypt. Without it the store stays `locked` and every
  // channel verb refuses loudly at call time (`keystore_locked`, US-A36.2); there is no interactive
  // fallback in these entrypoints. When the passphrase IS given, a failure to open is a boot-time
  // throw (loud, not deferred): `unlock` returns true for a not-yet-created file (the first ceremony),
  // so a false result means a real problem, and it never mints fresh keys over an existing file.
  if (passphrase !== undefined && passphrase !== '') {
    if (!keystore.unlock(passphrase)) {
      const why =
        keystore.state?.() === 'unavailable'
          ? 'the keystore file is unreadable or corrupt'
          : `it did not unlock with ${EBICS_KEYSTORE_PASSPHRASE_ENV} (wrong passphrase)`;
      throw new Error(
        `The EBICS keystore at ${keystorePath} could not be opened: ${why}. ` +
          `The file is left untouched (a wrong passphrase never mints fresh keys).`,
      );
    }
  }

  let mod: unknown;
  try {
    mod = await import(specifier);
  } catch (cause) {
    throw new Error(
      `Failed to load the EBICS wire module named by ${EBICS_RUNTIME_ENV} ("${specifier}"): ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  if (!isHostWireModule(mod)) {
    throw new Error(
      `The module named by ${EBICS_RUNTIME_ENV} ("${specifier}") does not export ` +
        `createEbicsWire + createEbicsTransport. It is not a compatible @tillbooks/ebics-wire build.`,
    );
  }

  const tls = readTlsOptions();
  const wire = mod.createEbicsWire(tls !== undefined ? { keystore, tls } : { keystore });
  const ebicsTransport = composeLiveTransport(wire, mod);
  return { ebicsTransport, ebicsKeystore: keystore };
}

/** Read the optional extra TLS trust anchor, or undefined (platform anchors only). Never disables verification. */
function readTlsOptions(): { ca: Array<string | Uint8Array> } | undefined {
  const caFile = process.env[EBICS_CA_FILE_ENV];
  if (caFile === undefined || caFile.trim() === '') return undefined;
  const pem = readFileSync(caFile);
  return { ca: [pem] };
}

/**
 * Compose the full `EbicsTransportPort`: the core seam handles every method with the live `wire`, and
 * `fetchBankKeys` is overridden with the private package's HPB parser (design 4.2 option a). Banks
 * publish only X002 (authentication) and E002 (encryption) on HPB, so `electronicSignature` has no
 * bank value and is carried as an empty string; `sameHashes` in the core compares the shape it stores
 * against the shape it fetches, both produced here, so the pin/compare stays consistent.
 */
function composeLiveTransport(wire: EbicsWire, mod: HostWireModule): EbicsTransportPort {
  const base = createEbicsHttpsTransport({ wire });
  const parser = mod.createEbicsTransport({ wire });
  return {
    ...base,
    fetchBankKeys(req) {
      const parsed = parser.fetchBankKeys(req);
      // Defence against a drifted/async host module: the contract is a synchronous union. Anything
      // else (a Promise, a malformed object) becomes a diagnosable reason, never an undefined one that
      // would surface downstream as `channel_unreachable` with no explanation.
      if (parsed === null || typeof parsed !== 'object' || typeof parsed.ok !== 'boolean') {
        return { ok: false, reason: 'ebics_wire_contract_error' };
      }
      if (!parsed.ok) return { ok: false, reason: parsed.reason ?? 'unreadable_hpb_order_data' };
      const bankKeyHashes: EbicsKeyHashes = {
        electronicSignature: '',
        authentication: parsed.bankKeyHashes.authentication,
        encryption: parsed.bankKeyHashes.encryption,
      };
      return { ok: true, bankKeyHashes };
    },
  };
}
