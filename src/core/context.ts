/**
 * The workspace context: what every engine verb is handed.
 *
 * A verb is `(ctx, input) -> Result` (Pattern P1). The context carries the tenant (`workspaceId`,
 * §H-TENANT), the actor, the store, and the injected seams (clock, ids, and the capability / period /
 * audit ports). Nothing in a verb reads global state or the wall clock directly, which is what keeps
 * the money path deterministic under test.
 */

import type { SqliteStore } from './store/sqlite-store.js';
import type { Clock } from './clock.js';
import type { IdGen } from './ids.js';
import { systemClock } from './clock.js';
import { systemIdGen } from './ids.js';
import type { CapabilityPort, PeriodPort, AuditPort } from './ports.js';
import { allowAllCapabilities, allPeriodsOpen, noAudit } from './ports.js';
import type { IdentitySource } from './access/actors.js';

/**
 * The outbound email transport (OP4), an injected seam exactly like the clock and the ids.
 *
 * There is deliberately NO transport in the MIT core: a local-first engine that shipped its own SMTP
 * client would be claiming a delivery guarantee it cannot make offline. The host (the Studio, a
 * cloud tier, a `till` CLI wired to a local MTA) supplies one, and `sendInvoice` degrades honestly
 * when it does not.
 *
 * The contract is narrow on purpose: `send` returns ok only when the message has genuinely been
 * handed to a transport that accepted it. An implementation that cannot tell must throw rather than
 * return ok, because a thrown outcome is treated as UNKNOWN (never retried automatically) while an
 * `{ok:false}` is treated as "nothing left the building" and may be retried.
 */
export interface EmailRelayPort {
  send(msg: {
    to: string;
    subject: string;
    pdfBase64: string;
  }): { ok: true } | { ok: false; reason: string };
}

/**
 * E01's outbound e-signature transmitter (OP4), the `EmailRelayPort` reasoning verbatim: there is
 * deliberately NO transmitter in the MIT core, because the local-first engine's contract is that
 * the sign-request artifact stays on the device until an owner-gated cloud tier hands it to a
 * provider. `sendSignRequest` degrades honestly (`needs_provider`) when none is wired.
 *
 * `transmit` returns ok only when the provider genuinely accepted the request, with the provider's
 * own reference. An implementation that cannot tell must throw rather than return ok (a thrown
 * outcome is UNKNOWN); `{ok:false}` means nothing left the building and the send may be retried.
 */
export interface SignTransmitterPort {
  transmit(envelope: unknown): { ok: true; providerRef: string } | { ok: false; reason: string };
}

/**
 * A32's eBill connector (OP4), the `SignTransmitterPort` reasoning verbatim: there is deliberately NO
 * connector in the MIT core, because the eBill infrastructure is reachable ONLY through a certified
 * network-partner contract (ebill.ch, §3), so a local-first engine that shipped a transmitter would be
 * claiming a network it has no contract for. `transmitEbill` degrades honestly to
 * `{ transmitted:false, reason:'cloud_tier' }` when none is wired, and the local artifact stays
 * downloadable so the owner can use whatever upload path their partner offers by hand.
 *
 * `submit` returns ok ONLY when the partner genuinely accepted the business case, with the partner's
 * own `businessCaseId`. An implementation that cannot tell must THROW rather than return ok: a thrown
 * outcome is UNKNOWN (the row stays `submitting`, the at-least-once window stays visible, §4), while
 * `{ ok:false, reason }` means the partner refused and the delivery records `failed` with that reason.
 * The core NEVER opens a socket itself; only this host-wired port ever speaks to the network.
 */
export interface EbillTransmitterPort {
  submit(request: {
    billerPid: string;
    format: string;
    bcFunction: string;
    correlationId: string;
    pdfBase64: string;
  }): { ok: true; businessCaseId: string } | { ok: false; reason: string };
}

/**
 * A33's EBICS transport client (OP4), the seam that speaks EBICS to the bank over the wire.
 *
 * The LOCAL EBICS client is OSS-core (owner decision D29): user-owned keys, the user's own bank
 * contract, egress from the user's own device. But the engine stays offline-testable by never opening
 * a socket itself: it calls this port, a test wires an in-process mock host, and a real HTTPS
 * implementation is wired by the `till` CLI / Studio at the edge. When NO transport is wired the
 * channel verbs degrade honestly (`needs_bank_transport`, spec §4 P9): connect still does the local
 * work it can (generate keys, render the INI letter, create the connection row), but the network
 * steps wait, and the file-based A20/A18 path stays the visible floor. The core NEVER opens a socket.
 *
 * Every method returns ok ONLY when the bank genuinely completed the step. An implementation that
 * cannot tell (a crash mid-upload) must THROW rather than return ok: a thrown outcome is UNKNOWN (the
 * order stays `intent`, `transmit_in_doubt` becomes visible, §4), while `{ ok:false, reason }` means
 * the bank refused and nothing is in doubt.
 */
export interface EbicsConnectionRef {
  hostUrl: string;
  hostId: string;
  partnerId: string;
  userIdEbics: string;
  protocolVersion: string;
  keyRef: string;
}

export interface EbicsKeyHashes {
  electronicSignature: string;
  authentication: string;
  encryption: string;
}

export interface EbicsFetchedFile {
  /** The message name the bank reported (e.g. `camt.053`, `pain.002`, `HAC`). */
  msgName: string;
  /** The unpacked file bytes, base64. Handed to A20 byte-for-byte; A33 never transforms it. */
  contentBase64: string;
}

export type EbicsDownloadService = 'statements' | 'status_report' | 'customer_protocol';

export type EbicsTransportResult<T> = ({ ok: true } & T) | { ok: false; reason: string };

export interface EbicsTransportPort {
  /** INI + HIA: send TILL's three public keys. `ok` on the bank's acceptance of the initialisation. */
  sendKeys(req: { connection: EbicsConnectionRef; hashes: EbicsKeyHashes }): EbicsTransportResult<Record<string, never>>;
  /** HPB: fetch the bank's public keys, returning their fingerprints for out-of-band comparison. */
  fetchBankKeys(req: { connection: EbicsConnectionRef }): EbicsTransportResult<{ bankKeyHashes: EbicsKeyHashes }>;
  /**
   * BTD transfer phase (A36): fetch pending files for a service and return them WITH an `ackToken`,
   * the transport's opaque handle on the still-open download transaction, but WITHOUT sending the
   * positive EBICS receipt. The engine persists every file as an OR 958f artifact and COMMITs, THEN
   * calls `acknowledge(ackToken)` to close the transaction (spec A36 §4). Splitting the download this
   * way makes A33 §4's "persist before acknowledging" ordering enforceable by the core rather than
   * implicit inside the transport: a crash after the commit and before the acknowledge leaves the bank
   * still offering the data, and the re-fetch is A20's dedupe no-op. SMPG §5.5 statements arrive as a
   * ZIP; the transport unpacks the container and returns the per-file bytes byte-for-byte.
   */
  download(req: {
    connection: EbicsConnectionRef;
    service: EbicsDownloadService;
    dateRange?: { from?: string; to?: string } | undefined;
  }): EbicsTransportResult<{ files: EbicsFetchedFile[]; ackToken: string }>;
  /**
   * Close a download transaction opened by `download` (A36): send the positive EBICS receipt for the
   * `ackToken`. Called ONLY after the fetched files are persisted and COMMITTED. Acknowledging a token
   * the transport no longer holds (a re-run after the bank already received the receipt) is a safe
   * no-op the implementation reports `ok`.
   */
  acknowledge(req: { connection: EbicsConnectionRef; ackToken: string }): EbicsTransportResult<Record<string, never>>;
  /** BTU: upload a payload (pain.001) WITHOUT the SignatureFlag (v1, §3). `ok` only when acknowledged. */
  upload(req: {
    connection: EbicsConnectionRef;
    orderRef: string;
    payloadBase64: string;
    btf: { serviceName: string; msgName: string };
  }): EbicsTransportResult<Record<string, never>>;
  /** SPR: the administrative order that blocks the EBICS user (SMPG §6.2). */
  suspend(req: { connection: EbicsConnectionRef }): EbicsTransportResult<Record<string, never>>;
}

/**
 * A37's managed bank connectivity port (the bLink relay behind A33's verbs), an OP4 cloud tier
 * (owner decision D108/D109). This is the seam a vendor-operated relay implements; the MIT core ships
 * ONLY the port interface, the dispatch and the tables. When NO managed channel is wired the managed
 * rail degrades to the honest OP4 shape (`{ ok:false, error:'cloud_tier' }`) with ZERO side effects
 * (spec §3, tripwire 5): no row, no socket, no simulated consent. There is deliberately no local
 * stub, because a local simulation of a paid tier would be a lie in both directions.
 *
 * THE CREDENTIAL-FREE CONTRACT, ENFORCED BY THE INTERFACE SHAPE (spec §3 clause 1, tripwire 1): this
 * port exports NO key operation and takes NO password/token/certificate on any method. The bLink
 * platform identity (mTLS certs) and the per-customer Provider Tokens live relay-side; the local
 * engine only ever hands the relay an opaque `consentRef` and receives opaque handles back. The
 * interface having nothing to ask for is the mechanical enforcement of the trust boundary.
 *
 * THE LOCAL APP POLLS THE RELAY. Every method is a client-initiated call from the user's device: no
 * inbound connection, no push, no listener in TILL. The relay never sees an e-banking credential
 * (login and consent happen at the bank), and it holds no ledger data at rest (spec §4).
 *
 * Every method returns ok ONLY when the relay genuinely completed the step. An implementation that
 * cannot tell (a crash mid-submit) must THROW rather than return ok: a thrown outcome is UNKNOWN (the
 * order stays `intent`, `transmit_in_doubt` becomes visible, §4), while `{ ok:false, reason }` means
 * the relay refused and nothing is in doubt. The core NEVER opens a socket itself.
 */
export interface ManagedConnectionRef {
  /** The local managed_connection id. Carried so the relay can key its per-customer routing record. */
  connectionId: string;
  /** The platform this connection rides (spec §4: 'blink' in v1). */
  provider: string;
  /** The relay's per-customer bank routing reference (which bank/segment). Opaque, never a secret. */
  bankRef: string;
  /** The opaque relay-side consent handle for an in-flight or granted consent, when one exists. */
  consentRef?: string | undefined;
}

/** A file the relay collected from the bank's bLink interface (spec §4), bytes exactly as delivered. */
export interface ManagedFetchedFile {
  /** The relay's opaque handle on this queued file, acknowledged after durable local persistence. */
  queueId: string;
  /** The message name the bank delivered (e.g. `camt.053`, `camt.054`, `pain.002`). */
  msgName: string;
  /** The unpacked file bytes, base64. Handed to A20 byte-for-byte; A37 never transforms it. */
  contentBase64: string;
}

export type ManagedConsentState = 'pending' | 'granted' | 'revoked' | 'expired';

export type ManagedResult<T> = ({ ok: true } & T) | { ok: false; reason: string };

export interface ManagedChannelPort {
  /**
   * Ask the relay for a fresh bank consent URL (OAuth code flow terminates at the relay; the URL is
   * short-lived and NEVER stored). `consentRef` is the opaque handle the later poll resolves. The
   * customer grants the AIS/PSS consent inside their own e-banking; TILL never sees a credential.
   */
  beginConsent(req: {
    connection: ManagedConnectionRef;
    scopes: readonly string[];
    bankRef: string;
  }): ManagedResult<{ consentUrl: string; consentRef: string }>;
  /** Poll the current consent state at the relay. `bankConsentExpiresAt` is set only when the bank reports one. */
  getConsentState(req: {
    connection: ManagedConnectionRef;
    consentRef: string;
  }): ManagedResult<{ state: ManagedConsentState; scopes: readonly string[]; bankConsentExpiresAt?: string | undefined }>;
  /**
   * Return the statement/status files the relay has collected since the last acknowledged poll, bytes
   * exactly as the bank delivered them. The engine persists each as an E00 artifact and COMMITs, THEN
   * calls `acknowledge(queueIds)`: the persist-before-acknowledge ordering (tripwire 4) is enforced by
   * the core, not implicit in the relay. A `format_unsupported` bank yields the reason, never a
   * synthesised camt (spec §4: the relay adds no identity of its own to the bytes).
   */
  fetchQueued(req: { connection: ManagedConnectionRef }): ManagedResult<{ files: ManagedFetchedFile[] }>;
  /**
   * Confirm durable local persistence of the named queued files; the relay deletes its transient
   * copies. Acknowledging a queueId the relay no longer holds (a re-run after a crash) is a safe no-op.
   */
  acknowledge(req: { connection: ManagedConnectionRef; queueIds: readonly string[] }): ManagedResult<Record<string, never>>;
  /**
   * Forward a byte-identical A18 pain.001 for bLink PSS submission. Release stays at the bank (the
   * no-sole-authority boundary, spec §3). `ok` only when the relay accepted the submission for
   * delivery; a THROW is UNKNOWN (the intent stands, `transmit_in_doubt`).
   */
  submitPayment(req: {
    connection: ManagedConnectionRef;
    orderRef: string;
    payloadBase64: string;
  }): ManagedResult<Record<string, never>>;
  /** The managed twin of A33's HAC: the relay's delivery-log entries, resolving `transmit_in_doubt` evidence-based. */
  getDeliveryLog(req: {
    connection: ManagedConnectionRef;
    window?: { from?: string; to?: string } | undefined;
  }): ManagedResult<{ entries: { orderRef: string; event: string; at: string }[] }>;
}

/**
 * A33's key custody seam (SMPG §3.1, spec §4 open question 2). Keys are generated on the user's
 * device and held ONLY here, addressed by an opaque `keyRef`; the private material never reaches
 * SQLite, a log line, a thrown error, or an MCP result (tripwire 3). The core ships a real in-process
 * keystore (`defaultEbicsKeystore`, RSA via node:crypto); a host may replace it with the OS keychain
 * or a passphrase-encrypted keystore file, the mechanism the spec leaves open.
 */
export type EbicsKeystoreKind = 'memory' | 'file' | 'keychain';
export type EbicsKeystoreState = 'ready' | 'locked' | 'unavailable';

/**
 * The three EBICS key purposes, keyed to `EBICS_DEFAULT_KEY_PARAMS` (A005 electronic signature, X002
 * authentication, E002 encryption). A purpose selects which of a connection's three RSA pairs a
 * signing/decryption operation uses; the private material never leaves the keystore.
 */
export type EbicsKeyPurpose = 'electronicSignature' | 'authentication' | 'encryption';

export interface EbicsKeystorePort {
  /** Generate the three key pairs, store the private material, and return a locator plus public fingerprints. */
  generate(input: { keyLength: number }): { keyRef: string; hashes: EbicsKeyHashes };
  /** The public-key fingerprints for a locator, or null when it is unknown (e.g. after destroy). */
  publicHashes(keyRef: string): EbicsKeyHashes | null;
  /** Destroy all key material for a locator (retire). Idempotent: destroying an unknown ref is a no-op. */
  destroy(keyRef: string): void;
  /**
   * A36 introspection (ALL OPTIONAL, so the in-memory `defaultEbicsKeystore` and any out-of-repo
   * implementation stay valid unchanged). A host's persistent store (file/keychain) exposes them so
   * the status card can render `keystore:{kind,state}` and so a channel verb can pre-check the store
   * BEFORE calling `generate`/`publicHashes`: an absent method reads as the always-ready in-memory
   * default (`kind:'memory'`, `persistent:false`, `state:'ready'`).
   */
  readonly kind?: EbicsKeystoreKind;
  /** Whether key material survives a process restart. `false`/absent for the in-memory default. */
  readonly persistent?: boolean;
  /**
   * The unlock state a channel verb pre-checks: `ready` (usable), `locked` (a passphrase-encrypted
   * store not yet unlocked this session, or a wrong passphrase: refuse, never regenerate), or
   * `unavailable` (the backing file is missing or corrupt: re-initialisation is the one recovery).
   * Absent means always ready.
   */
  state?(): EbicsKeystoreState;
  /**
   * The private-key signing facet the EBICS wire needs (INI-letter signatures, the ES/AuthSignature on
   * every order). ALL OPTIONAL, so the in-memory default and any out-of-repo implementation stay valid
   * unchanged. Every method operates INSIDE the keystore: the private RSA material is used but NEVER
   * returned. `sign`/`decrypt`/`publicKeyMaterial` return `null` (never throw) for an unknown
   * keyRef/purpose or a store that is not `ready`, and leak no key material on any path.
   *
   * `sign`: RSASSA-PKCS1-v1_5 over `data` with the private key for `purpose` (electronicSignature ->
   * A005, authentication -> X002). `hash` defaults to sha256. Returns the raw signature bytes.
   */
  sign?(req: { keyRef: string; purpose: 'authentication' | 'electronicSignature'; data: Buffer; hash?: 'sha256' }): Buffer | null;
  /**
   * `decrypt`: RSA-decrypt `ciphertext` (the wire's symmetric transaction key) with the E002 encryption
   * private key. `padding` selects PKCS#1 v1.5 (`'pkcs1'`, the default) or OAEP (`'oaep'`). Returns the
   * recovered plaintext.
   */
  decrypt?(req: { keyRef: string; purpose: 'encryption'; ciphertext: Buffer; padding?: 'pkcs1' | 'oaep' }): Buffer | null;
  /**
   * `publicKeyMaterial`: the PUBLIC key for `purpose`, for the INI letter and the HIA/HPB exchange. The
   * SPKI DER (its sha256 is the fingerprint `publicHashes` reports) plus the RSA modulus and exponent
   * bytes. `x509Der` is present only for a certificate-bearing store (omitted for the raw-key variant).
   * No private material is ever returned.
   */
  publicKeyMaterial?(req: { keyRef: string; purpose: EbicsKeyPurpose }): { spkiDer: Buffer; modulus: Buffer; exponent: Buffer; x509Der?: Buffer } | null;
}

/**
 * An `EbicsKeystorePort` that is known to expose the signing facet (the wire requires it). The three
 * optional methods are narrowed to required, so a caller holding this type may use `sign`/`decrypt`/
 * `publicKeyMaterial` without a per-call presence check. The core's `defaultEbicsKeystore` and the
 * persistent `fileEbicsKeystore` both satisfy it.
 */
export type EbicsSigningKeystore = EbicsKeystorePort &
  Required<Pick<EbicsKeystorePort, 'sign' | 'decrypt' | 'publicKeyMaterial'>>;

export interface WorkspaceContext {
  readonly workspaceId: string;
  readonly actor: string;
  /**
   * M01: the proxy-attested subject in served mode, absent on a local install. Carried so `whoami` can
   * name it (US-M01.4); NEVER consulted for authorization (the `actor` and A24 own that). A verb that
   * is not `whoami` has no business reading it.
   */
  readonly subject?: string | undefined;
  /**
   * M01: HOW this session's identity was established (`local_client` by default, `served_subject` in
   * served mode). Additive; every existing caller reads `local_client`.
   */
  readonly identitySource?: IdentitySource | undefined;
  readonly store: SqliteStore;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly capabilities: CapabilityPort;
  readonly periods: PeriodPort;
  readonly audit: AuditPort;
  /** The outbound email transport, when the host wired one. Absent means no transport, never a stub. */
  readonly emailRelay?: EmailRelayPort | undefined;
  /** The e-signature transmitter (E01/OP4), when the host wired one. Absent means cloud-tier only. */
  readonly signTransmitter?: SignTransmitterPort | undefined;
  /** A32's eBill connector (OP4), when the host wired one. Absent means cloud-tier only, never a stub. */
  readonly ebillTransmitter?: EbillTransmitterPort | undefined;
  /** A33's EBICS transport (OP4), when the host wired one. Absent means the network steps degrade honestly. */
  readonly ebicsTransport?: EbicsTransportPort | undefined;
  /** A33's key custody seam. Absent means the core's in-process `defaultEbicsKeystore` is used. */
  readonly ebicsKeystore?: EbicsKeystorePort | undefined;
  /**
   * A37's managed bank connectivity relay (OP4, owner-gated). Absent means the cloud tier is OFF, and
   * every managed action degrades to the honest `{ ok:false, error:'cloud_tier' }` shape with zero
   * side effects. There is NO stub: a local simulation of a paid tier would be a lie (spec §3).
   */
  readonly managedChannel?: ManagedChannelPort | undefined;
}

export interface ContextOverrides {
  workspaceId: string;
  actor?: string;
  subject?: string;
  identitySource?: IdentitySource;
  clock?: Clock;
  ids?: IdGen;
  capabilities?: CapabilityPort;
  periods?: PeriodPort;
  audit?: AuditPort;
  emailRelay?: EmailRelayPort;
  signTransmitter?: SignTransmitterPort;
  ebillTransmitter?: EbillTransmitterPort;
  ebicsTransport?: EbicsTransportPort;
  ebicsKeystore?: EbicsKeystorePort;
  managedChannel?: ManagedChannelPort;
}

export function makeContext(store: SqliteStore, o: ContextOverrides): WorkspaceContext {
  return {
    workspaceId: o.workspaceId,
    actor: o.actor ?? 'system',
    // M01: carried through only when the host set them (served mode). Under exactOptionalPropertyTypes
    // an explicit `undefined` differs from absent, and "absent" is what a local session reads.
    subject: o.subject,
    identitySource: o.identitySource,
    store,
    clock: o.clock ?? systemClock,
    ids: o.ids ?? systemIdGen,
    capabilities: o.capabilities ?? allowAllCapabilities,
    periods: o.periods ?? allPeriodsOpen,
    audit: o.audit ?? noAudit,
    // Carried through rather than dropped: without this the only way to reach the relay was an
    // untyped cast, which is why `send_invoice` had no reachable transport on any shipped surface.
    emailRelay: o.emailRelay,
    signTransmitter: o.signTransmitter,
    ebillTransmitter: o.ebillTransmitter,
    ebicsTransport: o.ebicsTransport,
    ebicsKeystore: o.ebicsKeystore,
    managedChannel: o.managedChannel,
  };
}
