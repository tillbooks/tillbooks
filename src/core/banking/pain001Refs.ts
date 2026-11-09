/**
 * A18 pain.001: the four bank references (MsgId, PmtInfId, InstrId, EndToEndId), minted ONCE and then
 * FROZEN on the rows. A leaf module with no engine imports, because both `./pain001.ts` (the mint at
 * batch creation) and `../store/migrations.ts` (the generation-9 backfill) use it, and the store must
 * not pull the whole banking engine into its import graph.
 *
 * WHY FROZEN, NOT DERIVED (the defect this module closes). The references used to be a pure function
 * of the row's database id, re-derived on every render. A G04 restore and an `env_copy` re-mint every
 * surrogate id, so the SAME batch regenerated in the restored book carried a NEW MsgId. Swiss
 * institutions deduplicate on MsgId (SIX IG SPS 2025 v2.2, §3.8 "Duplicate checking": "at least 90
 * days"), so a re-upload of the same payments was not caught as a duplicate and could execute twice.
 * The values are now stored on `payment_batch` / `payment_batch_item` and the XML is built only from
 * the stored values: what the bank saw is what re-renders (the F6/D73 `cre_dt_tm` precedent).
 *
 * THE LIMITS, verified against the primary sources (not guessed):
 *  - SIX IG SPS 2025 v2.2 (24.02.2025) §3.2 "Character set for the reference elements": A-Z, a-z,
 *    0-9, space, and `' ( ) + , - . / : ?`; may not start with a space or `/`, end with `/`, or
 *    contain `//`. The vendored XSD (`test/banking/fixtures/xsd/pain.001.001.09.ch.03.xsd`) types all
 *    four as `Max35Text_pain001_ch`: length 1..35 and that pattern.
 *  - Uniqueness (same IG): MsgId "must have a unique value", checked "over a period of at least 90
 *    days" and best kept unique "for as long as possible"; PmtInfId unique within the message;
 *    InstrId unique within the B level. TILL keeps all four unique per WORKSPACE (a stronger rule
 *    that implies every one of the above), enforced by `mintFrozenReference` and by UNIQUE indexes.
 */

import type { Database } from 'better-sqlite3';

/**
 * The restricted reference charset (SIX IG §3.2), for `MsgId`/`PmtInfId`/`InstrId`/`EndToEndId`
 * ONLY: letters, digits, spaces and `'()+,-./:?`. This repo's own ids are minted as
 * `<prefix>_<uuid>` (`core/ids.ts`), and `_` is NOT in that set, so every id reaching one of these
 * four fields is sanitised here rather than assumed clean.
 */
export function toReferenceSafe(raw: string): string {
  const mapped = raw.replace(/_/g, '-');
  const filtered = mapped.replace(/[^A-Za-z0-9 '()+,\-./:?]/g, '');
  // May not start with a space or a slash, may not end with a slash, may not contain "//".
  const noLeading = filtered.replace(/^[ /]+/, '');
  const noTrailing = noLeading.replace(/\/+$/, '');
  return noTrailing.replace(/\/\//g, '-');
}

/** The ISO 20022 ceiling on `MsgId`/`PmtInfId`/`InstrId`/`EndToEndId`: all four are `Max35Text`. */
export const REFERENCE_MAX_LEN = 35;

/**
 * Mint a COMPACT, charset-safe reference for one of the four `Max35Text` elements (F2). This repo's
 * ids are `<prefix>_<uuid>` (`core/ids.ts`), and `<prefix>-<uuid>` is 46-47 characters once a tag is
 * added, well over the 35-character schema ceiling. The uuid's 128 bits are re-encoded base36 (0-9a-z,
 * all inside the SIX IG §3.2 charset), which is at most 25 characters, so a one-letter tag plus the
 * encoding never exceeds 26. A non-uuid suffix (the `sequenceIdGen` test ids, `pbatch_1`) is short
 * already and is used as-is after charset filtering.
 *
 * This is the SEED of a frozen reference, read exactly once per row (at batch creation, or by the
 * generation-9 backfill for a row that predates it). It is never re-derived for a row that already
 * carries its reference, because the id it reads is exactly what a restore changes.
 */
export function compactReference(tag: string, id: string): string {
  const suffix = id.slice(id.lastIndexOf('_') + 1);
  const hex = suffix.replace(/-/g, '');
  const core = /^[0-9a-fA-F]{32}$/.test(hex)
    ? BigInt(`0x${hex}`).toString(36)
    : suffix.replace(/[^0-9A-Za-z]/g, '');
  return toReferenceSafe(`${tag}${core}`).slice(0, REFERENCE_MAX_LEN);
}

/** Does `value` satisfy SIX IG §3.2 and `Max35Text_pain001_ch` as it stands (length 1..35, charset, slashes)? */
export function isSixReference(value: string): boolean {
  return value.length >= 1 && value.length <= REFERENCE_MAX_LEN && toReferenceSafe(value) === value;
}

/** The four frozen reference columns, by the table that holds them. */
export type FrozenReferenceColumn =
  | { table: 'payment_batch'; column: 'msg_id' | 'pmt_inf_id' }
  | { table: 'payment_batch_item'; column: 'instr_id' | 'end_to_end_id' };

/** How many disambiguated candidates are tried before minting refuses loudly (never reached in practice). */
const MAX_DISAMBIGUATION = 10_000;

/**
 * Mint the value to FREEZE, unique within the workspace. Starts from `seed` (normally
 * `compactReference(tag, id)`); when a row of this workspace already holds it (a batch restored from a
 * book whose ids have since been re-minted keeps the reference the bank saw, and a new batch can derive
 * the very same value from its fresh id), the seed is disambiguated with a `-<n>` suffix, truncating
 * the seed so the result still fits `Max35Text`. Deterministic: the same book state mints the same
 * value. `taken` answers for ONE workspace (§H-TENANT): another workspace holding the value is not a
 * collision, because a restored copy legitimately shares every reference with its source.
 */
export function mintFrozenReference(seed: string, taken: (candidate: string) => boolean): string {
  if (!isSixReference(seed)) {
    throw new Error(`pain.001 reference seed ${JSON.stringify(seed)} is not a SIX IG §3.2 Max35Text reference`);
  }
  if (!taken(seed)) return seed;
  for (let n = 2; n <= MAX_DISAMBIGUATION; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${seed.slice(0, REFERENCE_MAX_LEN - suffix.length)}${suffix}`;
    if (isSixReference(candidate) && !taken(candidate)) return candidate;
  }
  throw new Error(`pain.001 reference ${JSON.stringify(seed)} could not be made unique in this workspace`);
}

/**
 * The generation-9 rule for a batch whose `msg_id` was written before the references were frozen:
 * keep the stored value when it has the exact shape `compactReference('M', ...)` mints (it is then the
 * MsgId a develop-era file carried, possibly for an ORIGINAL id a develop-era restore has since
 * re-minted, which is precisely the value the bank deduplicates on); otherwise, the id-derived one.
 * A pre-F2 `PB-<id>` value (over 35 characters for every production id, so rejected by the bank's
 * schema check) fails the shape test and is replaced by the value the XML has carried since F2.
 */
export function isCompactMsgId(value: string | null): value is string {
  return value !== null && /^M[0-9A-Za-z]{1,34}$/.test(value);
}

/**
 * THE one blank-name rule for a pain.001 party name (critic r2 R2-2), shared by batch creation, the
 * generation of a draft and the generation-9 backfill: no name, or one that is empty after trimming,
 * is no name. A whitespace name would pass the XSD (length >= 1) and send the bank `<Nm>  </Nm>`.
 */
export function isBlankName(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim().length === 0;
}

/**
 * Did this batch ever produce a file? `payment_batch.generated_at` is stamped by the first generation
 * (the draft-to-generated flip) and frozen by trigger, so it is the one fact this reads (critic r3 R3-2:
 * it used to read `ctrl_sum_minor`, which nothing froze). Only a batch with a file has a sent record to
 * keep byte-identical and, under the owner's R2-5 answer, to retain on an erasure. The erasure's SQL
 * twin is `BATCH_HAD_FILE_SQL` in `sales/contactMerge.ts`, and both item triggers read the same column.
 */
export function batchHadFile(generatedAt: string | null): boolean {
  return generatedAt !== null;
}

/**
 * The `taken` predicate for `mintFrozenReference` over one frozen column of ONE workspace (§H-TENANT:
 * `workspace_id` is part of the predicate). `exceptId` leaves out the row being frozen, which the
 * generation-9 backfill needs when a row already holds the value it keeps.
 */
export function referenceTakenIn(
  db: Database,
  workspaceId: string,
  ref: FrozenReferenceColumn,
  exceptId?: string,
): (candidate: string) => boolean {
  const stmt = db.prepare(
    `SELECT 1 AS hit FROM ${ref.table} WHERE workspace_id = ? AND ${ref.column} = ? AND id IS NOT ? LIMIT 1`,
  );
  return (candidate) => stmt.get(workspaceId, candidate, exceptId ?? null) !== undefined;
}
