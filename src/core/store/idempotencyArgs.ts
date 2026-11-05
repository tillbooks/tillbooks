/**
 * §H-IDEMPOTENT, ONE KEY, ONE MEANING (N01 US-N01.5, Wave 0 slice).
 *
 * THE DEFECT IT CLOSES. An idempotency record used to hold only the RESULT of the act it memoised. A
 * second call with the same key and DIFFERENT arguments (another amount, another account, another date)
 * found that record, or a domain row keyed by the caller's key, and replayed the first act as its own:
 * the caller was told "booked" while the books held a different booking. A retry hid a different act.
 *
 * THE MECHANISM: ONE REGISTRY-LEVEL RECORD PER (workspace, verb, caller key). The table
 * `idempotency_args` holds, for each key a registry verb SPENT, the hash of the canonical arguments the
 * key was spent with and one hash per top-level field. It is
 *  - WRITTEN IN THE ACT'S OWN TRANSACTION: the registry runs every write dispatch under a claim
 *    (`claimIdempotencyArgs`), and the store's write chokepoint (`SqliteStore` runner, every write on
 *    the connection passes it) inserts the claim's row inside each transaction that wrote while the
 *    claim runs. A key is spent exactly when the act committed something, a memoised refusal included;
 *    a refusal that wrote nothing spends nothing, so the corrected retry may reuse the key.
 *  - CHECKED AT THE REGISTRY BOUNDARY BEFORE THE VERB RUNS (`claimIdempotencyArgs`) and in
 *    `enqueueDraftedAction`, so it is independent of how an engine rescopes its key, of which verb name
 *    it files a memo under, and of whether it replays from a memo or from a domain row. Same arguments:
 *    the verb runs and replays exactly as before. Different arguments: `idempotency_key_conflict`,
 *    naming the fields that differ, and the verb never runs, so nothing is written.
 * A fixed invariant, not a setting (N01 §6b "Fixed"). Rows spent before the table existed have no row
 * and replay as today (no migration of history). A direct engine call that bypasses the registry (a
 * unit test, an internal seam) carries no claim and neither records nor checks.
 *
 * NESTED DISPATCHES. A verb another verb dispatches (a G01 firing, an A12 tick, an approval replay) is
 * checked and recorded like any call. One exception: under a SYSTEM-derived key (a reserved prefix,
 * below) a nested dispatch keeps its replay, because no caller can send such a key (it is refused at
 * every transport door), so a record under it with other arguments can only be the system's own
 * earlier act, and the system's provenance guard decides (`test/recurring/auto-issue-occurrence-guard`).
 *
 * WHAT COUNTS AS THE ARGUMENTS (decided here, once):
 *  - Every top-level field the caller sent, declared in the verb's schema or not: an engine may read a
 *    field its schema does not list, and a retry that changes such a field is a different call.
 *  - EXCEPT the record's own identity (`workspaceId`, part of the record's key, and `idempotencyKey`,
 *    which IS the key), and the transport-only fields: `dryRun` (a dry run persists nothing),
 *    `agentReason` (the agent's explanation for a Vorschlag, N01), and, per verb, the confirm field an
 *    approval replay injects (`APPROVAL_CONFIRMS_FIELD`, `src/core/agent/argsIdentity.ts`), so an
 *    approved replay never conflicts with the call it approved.
 *  - FREE TEXT is a D172 setting, `idempotency.hash_free_text`: `exclude` (the default, an owner-level
 *    call made under the conservative-default rule) does not compare it, so a reworded retry replays the
 *    one act instead of tempting the caller to mint a second key; `include` holds it like any argument.
 *    What is free text is DECLARED PER VERB by its own schema (`declareVerbFreeText`): a `reason` the
 *    schema leaves a plain string; a `reason` that is a closed code carries an `enum` and is always
 *    compared. Every field hash is stored either way, so switching the setting needs no rewrite.
 *  - ABSENT VERSUS DEFAULT: the hash is over the caller's LITERAL arguments. A field left out and the
 *    same field sent with its default value are DIFFERENT arguments and refuse. The defaults live in
 *    the engines and some move (today's date, a workspace setting), so the literal input is the only
 *    identity that is stable over time. `undefined` is absent (JSON has no undefined); `null` is a
 *    value and differs from absent.
 *  - Object keys are compared in sorted order at every depth (key order is not meaning); array order
 *    is kept (line order is).
 *  - A stored identity of another canonical-form version (the `c1:` prefix) compares as absent, so a
 *    later change to this canonicalisation can never refuse a retry of a key the earlier form recorded.
 */

import { createHash } from 'node:crypto';

import { err, type Result, type OkFields } from '../result.js';

/** The canonical-form version every hash carries; a stored hash of another version compares as absent. */
export const ARGS_HASH_VERSION = 'c1';

/** The fields that identify the record rather than describe the act: never hashed. */
const IDENTITY_FIELDS: readonly string[] = ['workspaceId', 'idempotencyKey'];

/** Transport-only on every verb: never part of the act. */
export const TRANSPORT_ONLY_FIELDS: readonly string[] = ['dryRun', 'agentReason'];

/**
 * The field names that MAY be free text. Whether a verb's field of that name IS free text is that verb's
 * own declaration (`declareVerbFreeText`, from its schema at registry load): a plain string is free
 * text; a field whose schema carries an `enum` is a closed code (an ignore reason, a provision kind, a
 * stock movement reason) and is compared like any argument, whatever the setting says.
 */
export const FREE_TEXT_CANDIDATES: readonly string[] = ['reason'];

const freeTextByVerb = new Map<string, readonly string[]>();

/** Declare `verb`'s free-text fields from its schema properties (the registry does, for every verb). */
export function declareVerbFreeText(verb: string, properties: Readonly<Record<string, unknown>>): void {
  const fields = FREE_TEXT_CANDIDATES.filter((field) => {
    const spec = properties[field] as { type?: unknown; enum?: unknown } | undefined;
    return spec !== undefined && spec.type === 'string' && spec.enum === undefined;
  });
  freeTextByVerb.set(verb, fields);
}

/** The free-text fields `verb` declared; none for a verb never declared (everything is compared). */
export function freeTextFieldsOf(verb: string): readonly string[] {
  return freeTextByVerb.get(verb) ?? [];
}

/** The fields a comparison skips for `verb` under `policy`. */
export function excludedFreeText(verb: string, policy: FreeTextPolicy): readonly string[] {
  return policy === 'exclude' ? freeTextFieldsOf(verb) : [];
}

/** The D172 setting and its two values (`src/core/settings/registry.ts`). */
export const HASH_FREE_TEXT_SETTING = 'idempotency.hash_free_text';
export const HASH_FREE_TEXT_VALUES = ['exclude', 'include'] as const;
export type FreeTextPolicy = (typeof HASH_FREE_TEXT_VALUES)[number];

/** The refusal code: the same one the payment, bank, HR and stock paths already answer. */
export const IDEMPOTENCY_KEY_CONFLICT = 'idempotency_key_conflict';

/**
 * THE KEY SHAPES ONLY THE SYSTEM MINTS: every idempotency key a SYSTEM dispatch derives and hands to a
 * registry verb outside an `innerWrite` scope, by its prefix (security review on N01, 02.11.2026). A
 * nested dispatch keeps its replay only under one of these, and a CALLER may not send one:
 * `refuseReservedIdempotencyKey` refuses it at every transport door (`runGoverned` /
 * `runGovernedAsync`) and at a plugin's `host_call`. Each builder is held to this list by
 * `test/api/idempotency-reserved-keys.test.mjs`.
 *
 *  - `auto:`: G01, a rule's firing (`derivedIdempotencyKey`, `src/core/automation/fire.ts`).
 *  - `recurring:` and `recurring_issue:`: A12, a schedule tick's create and its issue (inline template
 *    literals in `src/core/recurring/recurring.ts`, kept inline so the K1 guard sees the derivation;
 *    the test reads them off a real tick).
 *  - `a36-auto-`: A36, the scheduled bank sync (`autoSyncKey`, `src/core/banking/ebics/autoSync.ts`).
 *    The Studio's own A36 keys (`a36-sync-`, `a36-press-`, ...) are not this prefix.
 *  - `autobook:`: N04, a Buchungsregel's automatic booking (`autobookKey`, `src/core/banking/autobook.ts`).
 *  - `schedule:`: N04, a Dauerbuchung's period (`scheduleRunKey`, `src/core/ledger/vorlageSchedule.ts`), the
 *    key its posting runs under and its Vorschlag's approval replays.
 */
export const RESERVED_IDEMPOTENCY_KEY_PREFIXES: readonly string[] = ['auto:', 'recurring:', 'recurring_issue:', 'a36-auto-', 'autobook:', 'schedule:'];

/** The reserved prefix `key` carries, or undefined for a key a caller may use. */
export function reservedKeyPrefix(key: unknown): string | undefined {
  if (typeof key !== 'string') return undefined;
  return RESERVED_IDEMPOTENCY_KEY_PREFIXES.find((prefix) => key.startsWith(prefix));
}

/**
 * The refusal a caller's reserved-shape key gets at a transport door, or undefined. `invalid_input` on
 * `idempotencyKey`, the boundary's own vocabulary, with the prefix it hit; nothing runs and nothing is
 * written, and a key of any other shape is untouched.
 */
export function refuseReservedIdempotencyKey(input: Readonly<Record<string, unknown>>): ReturnType<typeof err> | undefined {
  const prefix = reservedKeyPrefix(input.idempotencyKey);
  if (prefix === undefined) return undefined;
  return err('invalid_input', {
    field: 'idempotencyKey',
    reason: 'reserved_prefix',
    prefix,
    detail: 'keys starting with this prefix are minted by TILL itself (automation firings, recurring ticks, the scheduled bank sync, automatic bookings, Dauerbuchungen); choose another key',
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

/**
 * Canonical JSON: object keys sorted at every depth, arrays in order, `undefined` dropped (JSON
 * semantics). Two inputs that differ only in key order serialise identically.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (!isPlainObject(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) sorted[k] = v[k];
    return sorted;
  });
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A call's argument identity: the whole hash and one hash per top-level argument. */
export interface ArgsIdentity {
  readonly argsHash: string;
  readonly fieldHashes: Readonly<Record<string, string>>;
}

/**
 * The argument identity of a call: `c1:` + the sha256 of the canonical JSON of its top-level input,
 * and the sha256 of each top-level field, without the identity fields, the transport-only fields and
 * `extraTransport` (a verb's own transport field, see `verbArgsIdentity`). A field whose value is
 * `undefined` is absent.
 */
export function idempotencyArgsIdentity(input: Readonly<Record<string, unknown>>, extraTransport: Iterable<string> = []): ArgsIdentity {
  const dropped = new Set([...IDENTITY_FIELDS, ...TRANSPORT_ONLY_FIELDS, ...extraTransport]);
  const args: Record<string, unknown> = {};
  const fieldHashes: Record<string, string> = {};
  for (const [field, value] of Object.entries(input)) {
    if (dropped.has(field) || value === undefined) continue;
    args[field] = value;
    fieldHashes[field] = sha256(canonicalJson(value));
  }
  return { argsHash: `${ARGS_HASH_VERSION}:${sha256(canonicalJson(args))}`, fieldHashes };
}

/** The whole-call hash alone (`idempotencyArgsIdentity(...).argsHash`). */
export function idempotencyArgsHash(input: Readonly<Record<string, unknown>>, extraTransport: Iterable<string> = []): string {
  return idempotencyArgsIdentity(input, extraTransport).argsHash;
}

/**
 * The arguments that make `claimed` another call than `stored`, sorted; empty when they are the same
 * call. A stored identity of another canonical-form version compares as absent (empty). A field in
 * `excluded` (the verb's free text under the `exclude` policy, `excludedFreeText`) never counts.
 */
export function differingArgs(stored: ArgsIdentity, claimed: ArgsIdentity, excluded: readonly string[]): string[] {
  const version = `${ARGS_HASH_VERSION}:`;
  if (!stored.argsHash.startsWith(version) || !claimed.argsHash.startsWith(version)) return [];
  if (stored.argsHash === claimed.argsHash) return [];
  const fields = new Set([...Object.keys(stored.fieldHashes), ...Object.keys(claimed.fieldHashes)]);
  const differing: string[] = [];
  for (const field of fields) {
    if (excluded.includes(field)) continue;
    if (stored.fieldHashes[field] !== claimed.fieldHashes[field]) differing.push(field);
  }
  return differing.sort();
}

/** The refusal a same-key call with different arguments answers, on every path that refuses one. */
export function idempotencyKeyConflict(
  idempotencyKey: string,
  action: string,
  fields: readonly string[],
  extra: Record<string, unknown> = {},
): ReturnType<typeof err> {
  return err(IDEMPOTENCY_KEY_CONFLICT, {
    idempotencyKey,
    action,
    fields: [...fields],
    ...extra,
    reason: `Same key, different ${fields.join(', ')}. If this is the same act, resend the original arguments; only a genuinely different act takes a new key.`,
  });
}

/**
 * What a keyed call claims while it runs: where and under which key it records its identity, which
 * fields its comparison skips (its free text under the `exclude` policy), and whether a mismatch
 * refuses (false only for a nested dispatch under a reserved system key, which keeps its replay).
 */
export interface IdempotencyArgsClaim extends ArgsIdentity {
  readonly workspaceId: string;
  readonly verb: string;
  readonly key: string;
  readonly excluded: readonly string[];
  readonly refuses: boolean;
}

/**
 * Thrown by the store's write chokepoint when the act's own transaction finds the key ALREADY recorded
 * with other arguments: another process spent it between this call's boundary check and its write
 * (D12 puts a second writer on the file). The throw rolls the act's transaction back, so the second
 * act never commits; `claimIdempotencyArgs` turns it into the refusal.
 */
export class IdempotencyKeyConflictError extends Error {
  constructor(
    readonly verb: string,
    readonly idempotencyKey: string,
    readonly fields: readonly string[],
  ) {
    super(`idempotency key ${JSON.stringify(idempotencyKey)} of ${verb} was spent meanwhile with other ${fields.join(', ')}`);
    this.name = 'IdempotencyKeyConflictError';
  }
}

/** The store surface the claim needs. A store stub without it runs the call unclaimed. */
interface ClaimingStore {
  withIdempotencyArgs?<T>(claim: IdempotencyArgsClaim | null, fn: () => T): T;
  inIdempotencyDispatch?(): boolean;
  recordedIdempotencyArgs?(workspaceId: string, verb: string, key: string): ArgsIdentity | undefined;
  idempotencyScope?(verb: string): string;
}

/**
 * Where a call's identity is recorded: the AUTHENTICATED workspace it acts in, or null for a call that
 * has none (security review on N01, 02.11.2026). A pre-workspace verb has no workspace, and a
 * token-authenticated call names a `workspaceId` the caller chose while its tenant comes from the token
 * inside the verb; keying either would put unauthenticated callers in one namespace (or another
 * tenant's), where one could pre-claim a key to make another's call conflict, and the refusal would
 * answer before authentication. Such a call is never claimed: its engine-scoped memo decides, as before.
 */
export interface ClaimSite {
  readonly verb: string;
  readonly workspaceId: string | null;
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * Run a write verb's dispatch under its argument claim. BEFORE the verb runs, a key this verb already
 * spent with other arguments answers `idempotency_key_conflict` naming the fields, and the verb never
 * runs. Every write dispatch is marked (a keyless or unclaimed one with a null claim), so the store can
 * tell a nested dispatch from the outermost one and record the claim in each transaction the act
 * commits. Inside a composite's `innerWrite` the record is held under the inner scope
 * (`<composite>>verb`), like the K1 memos, so a public call under the same key never collides with it.
 * `identityOf` and `policyOf` are called only when there is a key to claim.
 */
export function claimIdempotencyArgs<T extends OkFields>(
  store: ClaimingStore,
  site: ClaimSite,
  identityOf: () => ArgsIdentity,
  policyOf: () => FreeTextPolicy,
  run: () => Result<T>,
): Result<T> {
  if (typeof store.withIdempotencyArgs !== 'function') return run();
  const key = site.input.idempotencyKey;
  if (typeof key !== 'string' || key.length === 0 || site.workspaceId === null || site.workspaceId.length === 0) {
    return store.withIdempotencyArgs(null, run);
  }
  const verb = typeof store.idempotencyScope === 'function' ? store.idempotencyScope(site.verb) : site.verb;
  const identity = identityOf();
  const excluded = excludedFreeText(site.verb, policyOf());
  const nested = store.inIdempotencyDispatch?.() === true;
  const refuses = !(nested && reservedKeyPrefix(key) !== undefined);
  const recorded = store.recordedIdempotencyArgs?.(site.workspaceId, verb, key);
  if (recorded !== undefined) {
    const fields = differingArgs(recorded, identity, excluded);
    if (fields.length > 0 && refuses) return idempotencyKeyConflict(key, site.verb, fields);
  }
  // The check above runs before the act's transaction; the store repeats it INSIDE that transaction
  // (`recordIdempotencyArgsIn`, under the write lock), so a second process that spent the key in
  // between makes this act roll back instead of committing beside it.
  let outcome: Result<T>;
  try {
    outcome = store.withIdempotencyArgs({ workspaceId: site.workspaceId, verb, key, ...identity, excluded, refuses }, run);
  } catch (e) {
    if (e instanceof IdempotencyKeyConflictError && e.idempotencyKey === key) return idempotencyKeyConflict(key, site.verb, e.fields);
    throw e;
  }
  // The other half of the race: an act that WROTE nothing (its engine replayed a memo the other process
  // committed meanwhile) never reached the in-transaction check. Its answer would be the other act's, so
  // the record is read once more: if the key now stands for other arguments, this call refuses (it wrote
  // nothing; had it written, its transaction would have thrown above).
  if (refuses) {
    const after = store.recordedIdempotencyArgs?.(site.workspaceId, verb, key);
    if (after !== undefined) {
      const fields = differingArgs(after, identity, excluded);
      if (fields.length > 0) return idempotencyKeyConflict(key, site.verb, fields);
    }
  }
  return outcome;
}
