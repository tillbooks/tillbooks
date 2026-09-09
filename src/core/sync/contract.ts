/**
 * M02, `till-sync/1`: the §I sync/publish contract, single-sourced (§H-ENUM).
 *
 * §I carries the whole cloud strategy in four lines: the MIT core is the SOLE writer of the local
 * SQLite, and a future private cloud runtime "consumes a versioned sync/publish contract, it never
 * reaches into this schema". This module is the machine-readable half of that promise. It names the
 * contract version, the CLOSED set of stream `kind` namespaces, and the envelope shape, so every
 * consumer (the managed tier in its own private repo, or a self-hoster) reads the same contract.
 *
 * THE ONE INVARIANT THIS FILE ENCODES, above every field name: every `kind` is a FACT, stated in the
 * past tense, about something that ALREADY happened in the ledger. The contract defines NO command
 * kind, ever. That is what makes "the stream cannot instruct the ledger" a property of the schema
 * rather than a hope in a review: there is no `kind` a consumer could send back that any code in this
 * core would treat as an instruction to post. The inbound lane (cloud-originated facts) is a SEPARATE,
 * closed enumeration of EXISTING engine verbs (record_payment, mirrorEbillPartnerStatus, bank_sync),
 * reached exactly as any other caller reaches them, gated by A24, idempotent by their own keys. No
 * part of this contract is a second writer.
 *
 * D106 (2026-08-18): publish-only, append-only, versioned, one writer, no bidirectional sync, no
 * CRDT. Conflicts on an append-only ledger are a contradiction, so there is nothing to merge.
 */

/**
 * The contract identifier. `till-sync/<major>`. Within a major version the contract is ADDITIVE only
 * (new `kind`s, new optional envelope fields); a breaking change is a new major, and a consumer
 * states the majors it speaks. An unknown major is `unsupported_contract`, never a best-effort parse
 * (Refuse-dont-guess, the D41 posture applied to the wire instead of the schema).
 */
export const CONTRACT_VERSION = 'till-sync/1' as const;

/** Every contract major this build can produce and serve. Additive; a new major is appended. */
export const SUPPORTED_CONTRACT_VERSIONS: readonly string[] = [CONTRACT_VERSION];

/**
 * The three published stream families, a CLOSED §H-ENUM `kind` namespace. Additive WITHIN a contract
 * version: a new family or a new leaf is a spec amendment, never a config flag, because the set of
 * things a consumer can trust to appear is the entire value of the contract.
 *
 *  1. `journal.*`  posted-entry facts. Integer Rappen, the §H-FX triple (txn + base + rate), the A03
 *     stamp. A fact ABOUT a posting, never a command to post. Built and proven lossless here.
 *  2. `artifact.*` content-addressed handles (sha256 + size + mime) for rendered invoices, camt
 *     files, eCH-0217 exports, .tillbackup snapshots; the blob bytes are fetched by hash, never
 *     inlined into the stream. The namespace is defined here; its producers ride E00's content store.
 *  3. `readmodel.*` named P5 read-model snapshots/deltas (open items, balances) so a portal surface
 *     never re-derives accounting in tier code. The namespace is defined here; its producers ride P5.
 *
 * Every value is a NOUN in the past tense. `isFactKind` below is the guard that keeps it that way.
 */
export const STREAM_KINDS = {
  /** A journal entry reached `posted`. Carries the entry, all its lines, and the §H-FX trace. */
  JOURNAL_POSTED: 'journal.posted',
  /** A rendered artifact was stored, addressed by its sha256 (blob fetched via `readSyncArtifact`). */
  ARTIFACT_RENDERED: 'artifact.rendered',
  /** A named read-model snapshot was produced (open items, balances). */
  READMODEL_SNAPSHOT: 'readmodel.snapshot',
} as const;

export type StreamKind = (typeof STREAM_KINDS)[keyof typeof STREAM_KINDS];

/** The closed set, for membership checks and the facts-only assertion. */
export const ALL_STREAM_KINDS: readonly StreamKind[] = Object.freeze([
  STREAM_KINDS.JOURNAL_POSTED,
  STREAM_KINDS.ARTIFACT_RENDERED,
  STREAM_KINDS.READMODEL_SNAPSHOT,
]);

/**
 * The three family prefixes. Every `kind` belongs to exactly one, and a family is a namespace of
 * FACTS. There is deliberately no `command.*`, `post.*`, `do.*` or any imperative family: the
 * absence is the invariant, and `isFactKind` proves a `kind` names one of these fact families and
 * nothing else.
 */
export const FACT_FAMILIES: readonly string[] = Object.freeze(['journal', 'artifact', 'readmodel']);

/**
 * Is `kind` a member of the closed FACT namespace? A `kind` that is not in `ALL_STREAM_KINDS`, or
 * whose family is not one of `FACT_FAMILIES`, is rejected. This is the schema property behind
 * "the stream cannot instruct the ledger": the reconstruct/consumer code and the drift tests both
 * call it, so a `kind` shaped like a command (`journal.post`, `payment.record`) is not a fact and is
 * refused before any consumer could mistake it for an instruction.
 */
export function isFactKind(kind: string): kind is StreamKind {
  if (!(ALL_STREAM_KINDS as readonly string[]).includes(kind)) return false;
  const family = kind.split('.')[0] ?? '';
  return FACT_FAMILIES.includes(family);
}

/** The payload schema id a `kind` currently emits. `<kind>/<schema-major>`, additive by major. */
export const PAYLOAD_SCHEMAS: Readonly<Record<StreamKind, string>> = Object.freeze({
  [STREAM_KINDS.JOURNAL_POSTED]: 'journal.posted/1',
  [STREAM_KINDS.ARTIFACT_RENDERED]: 'artifact.rendered/1',
  [STREAM_KINDS.READMODEL_SNAPSHOT]: 'readmodel.snapshot/1',
});

/**
 * One event on the wire. The envelope is fixed; the `payload` shape is governed by `payloadSchema`.
 *
 *  - `seq` is strictly monotonic and GAPLESS per workspace: it is what a consumer's cursor advances
 *    over, and a gap would mean a lost fact.
 *  - `epoch` re-mints on a G04 restore (which re-mints ids): a cursor whose epoch does not match the
 *    head epoch is reading a forked history and gets `cursor_reset_required`, never a silent replay.
 *  - `occurredAt` is when the fact happened (the entry's post time), NOT when it was read.
 *  - `actor` is the A03 stamp on the fact.
 *  - `payload` is a FACT, past tense. There is no command payload in this contract.
 *
 * The envelope carries NO secret: money is integer Rappen, ids are ledger ids, and nothing here is a
 * credential, a token, or a private key. `test/sync/no-secret-in-stream.test.mjs` holds that.
 */
export interface StreamEnvelope {
  readonly contractVersion: string;
  readonly workspaceId: string;
  readonly seq: number;
  readonly epoch: string;
  readonly occurredAt: string;
  readonly actor: string;
  readonly kind: StreamKind;
  readonly payloadSchema: string;
  /** Present only on `artifact.*`: the content hash whose bytes `readSyncArtifact` returns. */
  readonly artifactSha256?: string;
  readonly payload: Record<string, unknown>;
}

/** The stable machine-readable rejection codes this contract emits (single-sourced for the specs). */
export const SYNC_ERRORS = {
  /** The consumer named a contract major this build does not speak. */
  UNSUPPORTED_CONTRACT: 'unsupported_contract',
  /** A cursor beyond `head_seq`, or from another workspace. */
  INVALID_CURSOR: 'invalid_cursor',
  /** A cursor from a superseded stream epoch (after a G04 restore re-mint). Carries the new epoch. */
  CURSOR_RESET_REQUIRED: 'cursor_reset_required',
  /** A stream read against a workspace whose owner has publishing turned OFF. */
  PUBLISHING_DISABLED: 'publishing_disabled',
  /** An artifact hash the content store does not hold (or no local runtime is wired to serve it). */
  ARTIFACT_NOT_FOUND: 'artifact_not_found',
} as const;
