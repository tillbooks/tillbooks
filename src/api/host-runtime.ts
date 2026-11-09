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
 * EXCEPT `fetchBankKeys`, which it overrides with the private package's HPB parser. The core's
 * pin/compare logic is untouched: the runtime only produces hashes, the core decides trust.
 *
 * A36, the core's duties toward the wire (wire `docs/design-decisions.md` A36-7, W2):
 *  - CONTRACT VERSION 2, EXACTLY. The module must export `WIRE_CONTRACT_VERSION === 2` (a number,
 *    strictly equal). A missing export, an older or newer wire, or the string '2' is refused at boot:
 *    a `main`-branch wire satisfies the old duck-typed shape and verifies nothing (design D-1).
 *  - THE UNTRUSTED-BYTES FOLDER. `untrustedDir` is `<keystore file>.untrusted`, beside the keystore,
 *    never inside E00, the SQLite folder or a backup set: where the wire keeps the raw bytes of the last
 *    20 refused answers, to tell a verifier bug from interference (§4.2).
 *  - EVERY HASH HPB RETURNS. The bank's certificate hashes (what the owner compares against ZKB's "H005
 *    mit Zertifikat" row) and classic key hashes travel into the pin beside the SPKI fingerprints; the
 *    wire's pin gate compares every hash the pin holds.
 *  - THE PASSPHRASE. The launcher reads it from the macOS login Keychain into
 *    `TILL_EBICS_KEYSTORE_PASSPHRASE`; it is deleted from this process's environment once the keystore
 *    is unlocked, which keeps it from later child processes but NOT from `ps -E` for this process. No
 *    secrecy is claimed: OD-2 leaves no signing key behind it (§4.2).
 *  - An extra TLS anchor (`TILL_EBICS_CA_FILE`) exists for the local mock bank only: a wire built with
 *    one refuses every host that is not loopback (`extra_trust_anchor_refused`, §4.6).
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

/** The wire/core contract version this core speaks (A36, download only). The module must export it. */
export const EBICS_WIRE_CONTRACT_VERSION = 2;

/** The public shape the `TILL_EBICS_RUNTIME` module must expose. This is a CONTRACT the host module
 *  fulfils (the `@tillbooks/ebics-wire` surface), declared structurally so no static import is needed. */
export interface HostWireModule {
  WIRE_CONTRACT_VERSION: number;
  createEbicsWire(opts: {
    keystore: EbicsSigningKeystore;
    tls?: { minVersion?: 'TLSv1.2' | 'TLSv1.3'; ca?: Array<string | Uint8Array> };
    untrustedDir?: string;
  }): EbicsWire;
  createEbicsTransport(opts: { wire: EbicsWire }): {
    wire: EbicsWire;
    fetchBankKeys(req: { connection: EbicsConnectionRef }):
      | {
          ok: true;
          bankKeyHashes: {
            authentication: string;
            encryption: string;
            /** SHA-256 over each bank certificate DER, per purpose (H005 with certificates). */
            certificateHashes?: Partial<Record<'authentication' | 'encryption', string>>;
            /** The classic EBICS key hash of each bank key, per purpose. */
            keyHashes?: Partial<Record<'authentication' | 'encryption', string>>;
          };
        }
      | { ok: false; reason: string; codes?: { technical: string | null; business: string | null }; detail?: string };
  };
}

/** The ports a live host runtime supplies. Both absent means "no live wire", the honest OSS default. */
export interface HostEbicsPorts {
  ebicsTransport?: EbicsTransportPort;
  ebicsKeystore?: EbicsKeystorePort;
  /**
   * D142: how to build the SAME live wire again in another thread (the `till up` sync worker), read
   * once at boot. It carries the keystore passphrase IN MEMORY (the process already holds it, in the
   * keystore's provider): the worker receives it through `workerData`, never through the environment,
   * which this module cleared. Absent exactly when no live wire is configured.
   */
  recipe?: EbicsRuntimeRecipe;
}

/** D142: everything needed to rebuild the live wire in a worker thread. */
export interface EbicsRuntimeRecipe {
  specifier: string;
  keystorePath: string;
  passphrase?: string;
  caFile?: string;
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
 * W2: refuse any module that does not declare EXACTLY this core's contract version, a number strictly
 * equal to 2. Throws (loud at boot), never degrades: a live wire the owner asked for must not quietly
 * become a different one.
 */
export function assertWireContract(mod: unknown, specifier: string): asserts mod is HostWireModule {
  if (!isHostWireModule(mod)) {
    throw new Error(
      `The module named by ${EBICS_RUNTIME_ENV} ("${specifier}") does not export ` +
        `createEbicsWire + createEbicsTransport. It is not a compatible @tillbooks/ebics-wire build.`,
    );
  }
  const version = (mod as { WIRE_CONTRACT_VERSION?: unknown }).WIRE_CONTRACT_VERSION;
  if (typeof version !== 'number' || version !== EBICS_WIRE_CONTRACT_VERSION) {
    throw new Error(
      `The module named by ${EBICS_RUNTIME_ENV} ("${specifier}") declares wire contract ` +
        `${version === undefined ? 'none' : JSON.stringify(version)}; this TILL needs exactly ${EBICS_WIRE_CONTRACT_VERSION} ` +
        `(A36, download only, every answer authenticated). Build the matching @tillbooks/ebics-wire.`,
    );
  }
}

/** Where the wire keeps the raw bytes of refused answers: beside the keystore file (§4.2, W2). */
export function untrustedDirFor(keystorePath: string): string {
  return `${keystorePath}.untrusted`;
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
  const caFile = process.env[EBICS_CA_FILE_ENV];
  const recipe: EbicsRuntimeRecipe = {
    specifier,
    keystorePath,
    ...(passphrase !== undefined && passphrase !== '' ? { passphrase } : {}),
    ...(caFile !== undefined && caFile.trim() !== '' ? { caFile } : {}),
  };
  // A headless server (`till serve` / `till up`) has no prompt, so the env passphrase is how the store
  // is unlocked up front for the wire to sign/decrypt. It is deleted before anything else can read or
  // inherit it (later child processes and the D142 sync worker, which receives the recipe instead).
  // `ps -E` still shows this process's initial environment, so no secrecy is claimed (A36 §4.2).
  if (recipe.passphrase !== undefined) delete process.env[EBICS_KEYSTORE_PASSPHRASE_ENV];
  return { ...(await buildEbicsPorts(recipe)), recipe };
}

/**
 * Build the live ports from a recipe: the core file keystore (unlocked with the recipe's passphrase),
 * the private wire module, the composed transport. The boot path above and the D142 sync worker both
 * build through here, so the worker's wire is the boot wire, rule for rule.
 *
 * Without a passphrase the store stays `locked` and every channel verb refuses loudly at call time
 * (`keystore_locked`, US-A36.2). With one, a failure to open is a throw (loud, not deferred): `unlock`
 * returns true for a not-yet-created file (the first ceremony), so a false result means a real problem,
 * and it never mints fresh keys over an existing file.
 */
export async function buildEbicsPorts(recipe: EbicsRuntimeRecipe): Promise<Pick<HostEbicsPorts, 'ebicsTransport' | 'ebicsKeystore'>> {
  const { specifier, keystorePath, passphrase } = recipe;
  const passphraseProvider: PassphraseProvider | undefined = passphrase !== undefined ? () => passphrase : undefined;
  const keystore = fileEbicsKeystore(keystorePath, passphraseProvider);
  if (passphrase !== undefined) {
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
  assertWireContract(mod, specifier);

  const tls = readTlsOptions(recipe.caFile);
  const untrustedDir = untrustedDirFor(keystorePath);
  const wire = mod.createEbicsWire(tls !== undefined ? { keystore, tls, untrustedDir } : { keystore, untrustedDir });
  const ebicsTransport = composeLiveTransport(wire, mod);
  return { ebicsTransport, ebicsKeystore: keystore };
}

/** Read the optional extra TLS trust anchor, or undefined (platform anchors only). Never disables verification. */
function readTlsOptions(caFile: string | undefined): { ca: Array<string | Uint8Array> } | undefined {
  if (caFile === undefined || caFile.trim() === '') return undefined;
  const pem = readFileSync(caFile);
  return { ca: [pem] };
}

/**
 * Compose the full `EbicsTransportPort`: the core seam handles every method with the live `wire`, and
 * `fetchBankKeys` is overridden with the private package's HPB parser (design 4.2 option a). Banks
 * publish only X002 (authentication) and E002 (encryption) on HPB, so `electronicSignature` has no
 * bank value and is carried as an empty string. The certificate hashes and classic key hashes are KEPT
 * (W2): they are what the owner compares against ZKB's sheet, and the pin carries them.
 */
export function composeLiveTransport(wire: EbicsWire, mod: HostWireModule): EbicsTransportPort {
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
      if (!parsed.ok) {
        return {
          ok: false,
          reason: parsed.reason ?? 'unreadable_hpb_order_data',
          ...(parsed.codes !== undefined ? { codes: parsed.codes } : {}),
          ...(parsed.detail !== undefined ? { detail: parsed.detail } : {}),
        };
      }
      const b = parsed.bankKeyHashes;
      if (b === null || typeof b !== 'object' || typeof b.authentication !== 'string' || typeof b.encryption !== 'string') {
        return { ok: false, reason: 'ebics_wire_contract_error' };
      }
      const bankKeyHashes: EbicsKeyHashes = {
        electronicSignature: '',
        authentication: b.authentication,
        encryption: b.encryption,
        ...(b.certificateHashes !== undefined ? { certificateHashes: { ...b.certificateHashes } } : {}),
        ...(b.keyHashes !== undefined ? { keyHashes: { ...b.keyHashes } } : {}),
      };
      return { ok: true, bankKeyHashes };
    },
  };
}
