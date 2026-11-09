/**
 * G04 restore, THE ID CHOKEPOINT (spec G04 §0c, 30.09.2026).
 *
 * A restore re-mints every surrogate id (spec §0a.8a). Every value in a restored row that NAMES one of
 * those rows must then follow it to its new id, or the restored workspace keeps pointing at the
 * ORIGINAL workspace's rows. Until this module, restore knew which values name a row from a LIST:
 * declared foreign keys plus `RESTORE_NAMED_REFS`. The A31 critic failed three rounds in a row on the
 * forms the list did not cover (an undeclared `*_id` column, a free-text column, an id inside a JSON
 * value), and a census found 149 undeclared `*_id` / `*_ref` / `*_ids` columns across 215 tables. A
 * list cannot keep up with a schema that grows every week, so this is a CHOKEPOINT instead: every
 * TEXT value of every restored row passes through `remapValue`, whatever its column is called.
 *
 * THE RULE, and why each half is shaped the way it is:
 *
 *  - A value EQUAL to a re-minted id becomes the restored id. Production ids are `<prefix>_<uuid>`
 *    (`core/ids.ts`), so no natural value (a name, a number, a reference text) can equal one by
 *    accident: an exact match IS a reference, whatever the column.
 *  - A value that parses as JSON (an object, an array or a JSON string) has every JSON STRING token
 *    rewritten by this same rule, object keys included, so a JSON text nested inside a JSON string is
 *    followed too. The rewrite is done on the TEXT, token by token, so every other byte survives:
 *    spacing, key order, and the spelling of numbers (re-serialising a parsed value would round an
 *    integer past 2^53 and re-order integer-like keys).
 *  - A STRUCTURED value (no whitespace: a materialised path `/loc_a/loc_b/`, a composite key
 *    `<workspaceId>:2026`, a derived label `po-artifact/<poId>/rev1`, a derived idempotency key
 *    `pain001-item-<itemId>`, a comma list), or a list made of nothing but ids, has every id in it
 *    rewritten, the delimiters untouched: a whole id-shaped token (a run of `[A-Za-z0-9_-]`), or a
 *    hyphen-joined run inside one that has the minted shape `<prefix>_<suffix>`. The restore gate
 *    found each of these forms in a real world the moment it scanned for them (stock_location.path,
 *    the year-close audit entity, the PO artifact label, the payment key a pain.001 item derives),
 *    which is exactly why the gate, not a list, decides what the chokepoint must know. A derived key
 *    that follows its row keeps deduplicating: `recordPayment` looks a payment up by the key the item
 *    derives, and a copy whose key still named the source item would not find its own payment.
 *  - Anything else, which is prose (whitespace and words that are not ids), is copied verbatim. The
 *    chokepoint never rewrites an id inside a SENTENCE: a note that mentions an id is the author's
 *    text, not a reference the engine resolves.
 *
 * WHAT IT DOES NOT TOUCH: the columns in `NATURAL_KEY_COLUMNS`, each with its reason (identifiers the
 * bank, a recipient or a provider knows, which must survive a restore unchanged), and every value
 * that is not TEXT (money, counts, BLOB content). Declared foreign keys and the primary key resolve
 * through their own table's map first, in `portability.ts`, exactly as before; this module is the
 * catch-all behind them.
 *
 * WHAT IT LEAVES UNMAPPED IS RECORDED (critic R2-M2). A value in a reference position (a whole value,
 * a JSON string, a token of a structured value) that has the MINTED shape but names no row of the
 * backup is not rewritten, and it is not proof of anything either: it may name nothing, a global row,
 * or a row of ANOTHER workspace of the target book. The map keeps every such (table, column, token)
 * (`unmappedReferences`), so the restore's pre-commit gate can refuse the ones that name a row outside
 * the new workspace, whatever column they sit in. That is the tenant fence at the chokepoint: the
 * same grammar decides what is a reference for the rewrite and for the fence, so no column list can
 * fall behind it.
 *
 * AMBIGUITY REFUSES, IT NEVER GUESSES. A source id present in two tables (impossible with
 * `<prefix>_<uuid>` ids, possible in a sequence-id test book whose prefixes collide) cannot be
 * resolved without knowing which table the value means. Such an id stays out of the lookup, and a
 * value that names one throws `AmbiguousReferenceError`, which rolls the restore back.
 */

/** The table-qualified column key the allowlist uses: `table.column`. */
export function columnKey(table: string, column: string): string {
  return `${table}.${column}`;
}

/**
 * Columns whose value is a NATURAL or EXTERNAL key: never rewritten by the chokepoint, and exempt from
 * the list-free restore gate (`test/data/restore-chokepoint.test.mjs`). The entry is defensive where the
 * value is external (a `<prefix>_<uuid>` id cannot equal it by accident), and load-bearing where TILL
 * minted the value from one of its own ids and then TRANSMITTED it: the bank or the recipient knows
 * the original value, and a restored book that rewrote it could no longer match what comes back.
 *
 * Adding an entry is a decision about a COLUMN, stated with its reason. A stale entry (a column the
 * schema no longer has) fails `test/data/restore-chokepoint.test.mjs`.
 */
export const NATURAL_KEY_COLUMNS: Readonly<Record<string, string>> = {
  // A36/A37 EBICS: the bank's own identifiers of the subscriber, from the bank's onboarding letter.
  'ebics_connection.host_id': 'the bank-assigned EBICS HostID',
  'ebics_connection.partner_id': 'the bank-assigned EBICS PartnerID',
  'ebics_connection.user_id_ebics': 'the bank-assigned EBICS UserID',
  'ebics_connection.key_ref': 'a machine-local key-store locator, never a row of the book',
  'ebics_order_log.order_ref': 'the order reference the bank returned',
  'managed_connection.bank_ref': 'the provider-side bank identifier',
  'managed_connection.consent_ref': 'the provider-side consent reference',
  'managed_order_log.order_ref': 'the order reference the provider returned',
  // A20/A39 camt: every value below was read out of a bank statement file.
  'bank_statement.statement_id': 'the camt Stmt/Id the bank assigned',
  'bank_txn.entry_ref': 'the camt NtryRef / AcctSvcrRef the bank assigned',
  'bank_txn.batch_pmt_inf_id': 'the PmtInfId the bank reported back for a batch booking',
  'bank_txn_detail.end_to_end_id': 'the EndToEndId the bank reported back',
  // A18 pain.001: sent to the bank, which deduplicates on it for 90 days.
  'payment_batch.msg_id': 'the pain.001 MsgId already transmitted to the bank',
  'payment_batch.pmt_inf_id': 'the pain.001 PmtInfId frozen at batch creation (D148)',
  'payment_batch.debtor_name': 'the debtor name frozen into the pain.001 file (D148)',
  'payment_batch.debtor_iban': 'the debtor IBAN frozen into the pain.001 file (D148)',
  'payment_batch_item.instr_id': 'the pain.001 InstrId frozen at batch creation (D148)',
  'payment_batch_item.end_to_end_id': 'the pain.001 EndToEndId frozen at batch creation, which the bank and creditor reconcile on (D148)',
  'payment_batch_item.creditor_name': 'the creditor name frozen into the pain.001 file; a legacy file may carry a vendor id here, which must stay as sent (D148)',
  // A12 eBill: the network's identifiers of a delivery.
  'ebill_deliveries.business_case_id': 'the eBill network business-case id',
  'ebill_deliveries.correlation_id': 'the eBill correlation id, reused verbatim on every retry',
  'ebill_delivery_events.event_id': 'the eBill network event id',
  // E04-E07 mail: RFC 5322 identifiers and machine-local maildir locators.
  'mail_message.message_id': 'the RFC 5322 Message-ID of a received or sent mail',
  'mail_message.store_ref': 'a machine-local mail store locator',
  'mail_draft.store_ref': 'a machine-local mail store locator',
  // Provider references.
  'sign_request.provider_ref': 'the signing provider reference',
  'plugin_manifests.registry_ref': 'the plugin registry reference',
  // Content addresses: `stored_file.storage_ref` IS the sha256 of the bytes (E00), never a row id.
  'stored_file.storage_ref': 'the content address (sha256) of the stored bytes',
  // G11 migration: the row reference in the migrated-FROM system (a bexio id is not a TILL row).
  'migration_step_row.source_row_ref': 'the row reference in the migrated-from system',
  // A08 Saldosteuersatz: the ESTV activity number.
  'vat_saldo_activity.activity_id': 'the ESTV Saldosteuersatz activity number',
  'vat_saldo_activity_account.activity_id': 'the ESTV Saldosteuersatz activity number',
  // A24 identity: `user` is never restored (spec §0a.8b); listed so a later change that carries
  // identity keeps the actor id the owner signs in with.
  'user.actor_id': 'the sign-in identity of a person, not a row of the book',
};

/**
 * Columns that LEGITIMATELY name another workspace of the same book, exempt from the restore's tenant
 * fence for a reference to the `workspace` table only (a reference into any other table of another
 * workspace is refused even here). Each entry is a decision about a column, stated with its reason; a
 * stale entry (a column the schema no longer has) fails `test/data/restore-tenant-fence.test.mjs`.
 */
export const CROSS_WORKSPACE_REFERENCE_COLUMNS: Readonly<Record<string, string>> = {
  // G18: a migration plan names its test mandate, a sibling workspace of the same book. The chokepoint
  // records the value before the row transform runs, so the entry stays: a single restore then CLEARS
  // it (`RESTORE_ROW_TRANSFORMS` in portability.ts, owner decision 11.10.2026: the copy does not own
  // the original's Testmandant), and env_copy re-points it at the mandate's copy once every copied
  // workspace exists (`remapCopiedWorkspaceIds`) and sweeps any link it could not re-point.
  'migration_plan.testmandant_workspace_id': 'the G18 test mandate: cleared on restore, re-pointed by env_copy',
};

/** One minted-shape value in a reference position that the chokepoint did not map. */
export interface UnmappedReference {
  readonly table: string;
  readonly column: string;
  readonly token: string;
}

/** A value that names a source id present in more than one table: the restore refuses, never guesses. */
export class AmbiguousReferenceError extends Error {
  constructor(
    readonly table: string,
    readonly column: string,
  ) {
    super(`ambiguous_reference ${table}.${column}`);
    this.name = 'AmbiguousReferenceError';
  }
}

/** How deep a JSON text nested inside a JSON string is followed. Real values nest once at most. */
const MAX_NESTED_JSON = 4;

/** A run of the characters an id is made of (`<prefix>_<uuid>`, `<prefix>_<n>`). */
const ID_TOKEN = /[A-Za-z0-9_-]+/g;

/** A value whose first non-blank character opens a JSON object, array or string. */
function mayBeJson(text: string): boolean {
  const first = text.trimStart().charAt(0);
  return first === '{' || first === '[' || first === '"';
}

/**
 * THE STRING RULE, one function for a whole cell and for every JSON string inside one (spec §0c item
 * 2). Returns the rewritten string, or undefined when it names no re-minted id.
 */
function remapString(value: string, ids: IdLookup, depth: number): string | undefined {
  const whole = ids.lookup(value);
  if (whole !== undefined) return whole;
  if (MINTED_ID.test(value)) {
    // A whole value of the minted shape IS a reference; this one names no row of the backup.
    ids.note(value);
    return undefined;
  }
  if (depth <= MAX_NESTED_JSON && mayBeJson(value)) {
    const json = remapJsonText(value, ids, depth);
    if (json !== null) return json;
  }
  return remapStructured(value, ids);
}

/**
 * How the string rule asks about ids: `known` answers whether a token is a source id at all (never
 * throws, so prose that merely CONTAINS an ambiguous token is still left alone), `lookup` resolves one
 * the rule is about to rewrite (and refuses an ambiguous one).
 */
interface IdLookup {
  known(token: string): boolean;
  lookup(token: string): string | undefined;
  /** Record a minted-shape token in a reference position that names no row of the backup. */
  note(token: string): void;
}

/**
 * A structured value (no whitespace: a path, a composite key, a derived label or key, a comma list) or
 * a list of nothing but ids: every id in it is replaced and every delimiter kept. An id is found as a
 * whole id-shaped token, or as a hyphen-joined run INSIDE one (`pain001-item-<itemId>`,
 * `ebics-ini-letter-<connectionId>.txt`) when the run has the minted shape `<prefix>_<suffix>`. Prose
 * (whitespace, and at least one token that is not an id) is left alone. Returns undefined when nothing
 * changed.
 */
function remapStructured(value: string, ids: IdLookup): string | undefined {
  const tokens = value.match(ID_TOKEN);
  if (tokens === null) return undefined;
  if (/\s/.test(value) && tokens.some((t) => !ids.known(t))) return undefined; // prose
  let changed = false;
  const out = value.replace(ID_TOKEN, (t) => {
    noteUnmappedRuns(t, ids);
    const r = remapToken(t, ids);
    if (r === undefined) return t;
    changed = true;
    return r;
  });
  return changed ? out : undefined;
}

/** A minted-shape run inside an id-shaped token (`pain001-item-<itemId>`), bounded by the token or `-`. */
const MINTED_RUN = /[A-Za-z][A-Za-z0-9_]*_(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)/g;

/** Note every minted-shape run of `token` (the whole token included) that names no row of the backup. */
function noteUnmappedRuns(token: string, ids: IdLookup): void {
  for (const m of token.matchAll(MINTED_RUN)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (start > 0 && token.charAt(start - 1) !== '-') continue;
    if (end < token.length && token.charAt(end) !== '-') continue;
    if (!ids.known(m[0])) ids.note(m[0]);
  }
}

/**
 * One id-shaped token: the restored id when the token IS a source id, else the token with every
 * hyphen-joined run that is a minted source id (it contains `_`) replaced, longest run first, or
 * undefined when it names none.
 */
function remapToken(token: string, ids: IdLookup): string | undefined {
  if (ids.known(token)) return ids.lookup(token);
  if (!token.includes('-')) return undefined;
  const parts = token.split('-');
  const out: string[] = [];
  let changed = false;
  for (let i = 0; i < parts.length; ) {
    let hit = -1;
    for (let j = parts.length - 1; j >= i; j -= 1) {
      const run = parts.slice(i, j + 1).join('-');
      if (run.includes('_') && ids.known(run)) {
        out.push(ids.lookup(run) ?? run);
        hit = j;
        changed = true;
        break;
      }
    }
    if (hit === -1) {
      out.push(parts[i] as string);
      i += 1;
    } else {
      i = hit + 1;
    }
  }
  return changed ? out.join('-') : undefined;
}

/**
 * Rewrite the JSON string tokens of `text` by the string rule. Returns null when `text` is not JSON
 * (so the caller treats it as a plain string), undefined when it is JSON naming no re-minted id, and
 * the new text otherwise, with every byte but the rewritten literals unchanged. Because the text
 * parsed, a double quote outside a string literal always opens one, so a linear scan that skips
 * escaped characters finds every literal exactly.
 */
function remapJsonText(text: string, ids: IdLookup, depth: number): string | undefined | null {
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  let out = '';
  let last = 0;
  let changed = false;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 34 /* " */) continue;
    let j = i + 1;
    while (j < text.length) {
      const c = text.charCodeAt(j);
      if (c === 92 /* backslash */) {
        j += 2;
        continue;
      }
      if (c === 34) break;
      j += 1;
    }
    const decoded = JSON.parse(text.slice(i, j + 1)) as string;
    const rewritten = remapString(decoded, ids, depth + 1);
    if (rewritten !== undefined) {
      out += text.slice(last, i) + JSON.stringify(rewritten);
      last = j + 1;
      changed = true;
    }
    i = j;
  }
  return changed ? out + text.slice(last) : undefined;
}

/**
 * The shape an `IdGen` mints (`core/ids.ts`): `<prefix>_<uuid>` in production, `<prefix>_<n>` from a
 * sequence. ONLY such an id is resolved outside a declared foreign key. Every engine table's `id` is
 * minted this way (measured over every conformance world and the Seeblick ledger; the one exception
 * is an id DERIVED from the workspace id, whose workspace token the structured rule follows anyway).
 * A table whose `id` were a NATURAL value (a currency code, a content hash, a template name) must not
 * enter the lookup: every equal value anywhere in the book (a currency column, a `sha256` column)
 * would be rewritten to that row's new id. Such a row still restores, and a declared foreign key to
 * it still follows it; a free-standing reference to it stays verbatim, where the gate names it.
 */
const MINTED_ID = /^[A-Za-z][A-Za-z0-9_]*_(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * The one map a restore resolves every non-FK reference through: source surrogate id to restored id,
 * across every loaded table, plus the workspace id and the audit rows. Built by `add` during pass one.
 */
export class RestoreIdMap {
  private readonly map = new Map<string, string>();
  private readonly owner = new Map<string, string>();
  private readonly ambiguous = new Set<string>();
  private readonly unmapped = new Map<string, UnmappedReference>();

  /**
   * Record that `sourceId` of `table` restores as `restoredId`. Only an id of the MINTED shape enters
   * the lookup (see `MINTED_ID`): the safety valve against a table whose `id` is a natural value, which
   * would otherwise turn every equal value in the book into that row's new id.
   */
  add(table: string, sourceId: string, restoredId: string): void {
    if (!MINTED_ID.test(sourceId)) return;
    const seen = this.owner.get(sourceId);
    if (seen !== undefined && seen !== table) {
      this.ambiguous.add(sourceId);
      this.map.delete(sourceId);
      return;
    }
    if (this.ambiguous.has(sourceId)) return;
    this.owner.set(sourceId, table);
    this.map.set(sourceId, restoredId);
  }

  /** The restored id a source id maps to, or undefined. */
  get(sourceId: string): string | undefined {
    return this.map.get(sourceId);
  }

  /**
   * Every minted-shape value in a reference position that named no row of the backup, once per
   * (table, column, token), in the order met. The restore's tenant fence reads it (critic R2-M2).
   */
  unmappedReferences(): UnmappedReference[] {
    return [...this.unmapped.values()];
  }

  /** How many source ids map. */
  get size(): number {
    return this.map.size;
  }

  /**
   * THE CHOKEPOINT. The value a restored `table.column` cell takes under the string rule (a whole id,
   * the string tokens of a JSON text, the id tokens of a structured value); prose, every allowlisted
   * column and every non-text value are returned as they came.
   */
  remapValue(table: string, column: string, value: unknown): unknown {
    if (typeof value !== 'string' || value.length === 0) return value;
    if (NATURAL_KEY_COLUMNS[columnKey(table, column)] !== undefined) return value;
    const ids: IdLookup = {
      known: (s) => this.map.has(s) || this.ambiguous.has(s),
      lookup: (s) => {
        if (this.ambiguous.has(s)) throw new AmbiguousReferenceError(table, column);
        return this.map.get(s);
      },
      note: (s) => {
        const key = `${columnKey(table, column)}\u0000${s}`;
        if (!this.unmapped.has(key)) this.unmapped.set(key, { table, column, token: s });
      },
    };
    return remapString(value, ids, 0) ?? value;
  }
}
