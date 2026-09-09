/**
 * SANITIZATION LEVELS for a copy out of a source environment (D-ENV-4/9, canon findings #1, #7).
 * Phase B, money-path adjacent. Applied to the RESTORED target db, before the build-then-swap, scoped
 * to the copied workspace(s) so a mandate-scoped copy leaves other workspaces in the target untouched.
 *
 * Three levels, ORTHOGONAL to the secret-neutralization floor (`secrets.ts`), which always runs:
 *
 *   - raw                 data copied verbatim; only the secret floor applies. The D-ENV-4 default.
 *   - pseudonymize        contact/person/company names, postal addresses, email, IBAN, VAT numbers and
 *                         free-text are replaced with DETERMINISTIC, stable pseudonyms (a given row`s id
 *                         maps to one pseudonym, so relations stay legible). IBANs become VALID-checksum
 *                         CH TEST IBANs. Amounts are KEPT INTACT by default (D-ENV-9); an opt-in uniform
 *                         scale factor exists for demos. This is the "pseudonymisiert" wording (#7).
 *   - structure_synthetic keeps the chart of accounts, tax config and contact STRUCTURE, masks every PII
 *                         field as pseudonymize does, and REPLACES amounts with generated values via a
 *                         uniform, balance-preserving money scale (see `scaleMoney`). It is the only
 *                         level that removes all source personal data, so the only one called
 *                         "anonymisiert". v1 SCOPE (divergence, see report): the amount transform is a
 *                         uniform integer scale (invariant-safe), not a per-transaction re-synthesis;
 *                         generating a wholly fresh transaction set is the synthetic seeder`s job and a
 *                         fast-follow. No source PII survives either way.
 *
 * MONEY SAFETY. Nothing here can unbalance the ledger. The PII/free-text masks touch no money column.
 * The amount scale multiplies EVERY `_minor` / `_rappen` integer by ONE factor `k`, so both sides of
 * every entry scale identically (Sum debit = Sum credit still holds) and every derived relation
 * (base = txn x rate, total = qty x unit_price, balance = Sum postings) is preserved because rates and
 * quantities are left alone while all money scales by the same k. The copy re-gates after this regardless.
 */

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

import type { Sanitization } from './model.js';

/** A stable salt so a pseudonym is deterministic across re-runs (idempotent), keyed on the row id. */
const PSEUDONYM_SALT = 'till.landscape.pseudonym.v1';

/** The uniform money-scale factor for `structure_synthetic` (a small prime: changes every amount, no */
/** overflow for any realistic Rappen figure, exact because it is integer x integer). Deterministic. */
export const STRUCTURE_SCALE = 7;

// --- deterministic pseudonyms ------------------------------------------------------------------

function digest(category: string, id: string): string {
  return createHash('sha256').update(`${PSEUDONYM_SALT}:${category}:${id}`).digest('hex');
}

/** A short stable token (hex) for `id` under `category`, for building a legible pseudonym. */
function token(category: string, id: string, len = 8): string {
  return digest(category, id).slice(0, len);
}

/** A deterministic integer in [0, mod) for `id` under `category`. */
function intFor(category: string, id: string, mod: number): number {
  return parseInt(digest(category, id).slice(0, 8), 16) % mod;
}

// --- CH test IBAN (valid ISO 13616 / mod-97 checksum) ------------------------------------------

/** ISO 7064 mod 97-10 over a numericised IBAN string, computed piecewise to avoid BigInt on long strings. */
function mod97(numeric: string): number {
  let remainder = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    remainder = Number(`${remainder}${numeric.slice(i, i + 7)}`) % 97;
  }
  return remainder;
}

/** Convert an IBAN`s letters to numbers (A=10..Z=35), digits unchanged. */
function ibanNumeric(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) out += String(code - 55);
    else out += ch;
  }
  return out;
}

/** Validate an IBAN: rearrange (first 4 chars to the end), numericise, mod 97 must equal 1. */
export function ibanIsValid(iban: string): boolean {
  const s = iban.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(s) || s.length < 5) return false;
  return mod97(ibanNumeric(s.slice(4) + s.slice(0, 4))) === 1;
}

/**
 * A VALID CH test IBAN derived deterministically from `id`. CH IBANs are 21 chars: `CH` + 2 check
 * digits + 5-digit clearing (bank) + 12-char account. We build a 17-char BBAN (5 digit bank in the
 * IID test range 09000-09999 that Swiss banks use for testing + 12 digit account), compute the two
 * ISO-7064 check digits, and return the full IBAN. The result passes `ibanIsValid`.
 */
export function chTestIban(id: string): string {
  const bank = String(9000 + intFor('iban-bank', id, 1000)).padStart(4, '0'); // 9000-9999
  const iid = `0${bank}`; // 5-digit clearing number, 09000-09999
  const acct = digest('iban-acct', id).replace(/\D/g, '').padEnd(12, '0').slice(0, 12);
  const bban = `${iid}${acct}`; // 17 chars, all digits
  const check = 98 - mod97(ibanNumeric(`${bban}CH00`));
  return `CH${String(check).padStart(2, '0')}${bban}`;
}

// --- generic workspace scoping (mirrors portability.ts scopedWhere, one source of truth here) ----

function colNames(db: Database.Database, table: string): Set<string> {
  return new Set((db.pragma(`table_info("${table}")`) as { name: string }[]).map((c) => c.name));
}

function fksOf(db: Database.Database, table: string): { from: string; table: string; to: string | null; notnull: boolean }[] {
  const cols = db.pragma(`table_info("${table}")`) as { name: string; notnull: number }[];
  const nn = new Set(cols.filter((c) => c.notnull === 1).map((c) => c.name));
  return (db.pragma(`foreign_key_list("${table}")`) as { from: string; table: string; to: string | null }[]).map((f) => ({
    from: f.from,
    table: f.table,
    to: f.to,
    notnull: nn.has(f.from),
  }));
}

/**
 * The WHERE clause (and params) selecting `table``s rows for `wsIds`, direct via `workspace_id` or
 * through an FK chain (journal_line via entry_id -> journal_entry). Empty `wsIds` means "every row"
 * (whole-instance scope). An unscopable table yields `1 = 0` (touch nothing: fail safe).
 */
export function workspaceScope(
  db: Database.Database,
  table: string,
  wsIds: readonly string[],
  seen: ReadonlySet<string> = new Set(),
): { clause: string; params: unknown[] } {
  if (wsIds.length === 0) return { clause: '1 = 1', params: [] };
  const cols = colNames(db, table);
  const ph = wsIds.map(() => '?').join(', ');
  if (table === 'workspace') return { clause: `id IN (${ph})`, params: [...wsIds] };
  if (cols.has('workspace_id')) return { clause: `workspace_id IN (${ph})`, params: [...wsIds] };
  // Prefer a NOT NULL foreign key so a nullable optional link cannot drop rows. A `seen` set stops an
  // FK cycle (were one ever introduced) from recursing forever: a table already on the path is skipped.
  const nextSeen = new Set(seen).add(table);
  const fks = fksOf(db, table).sort((a, b) => Number(b.notnull) - Number(a.notnull));
  for (const fk of fks) {
    if (fk.table === table || nextSeen.has(fk.table)) continue; // a self FK / a cycle is not a parent
    const parent = workspaceScope(db, fk.table, wsIds, nextSeen);
    if (parent.clause === '1 = 0') continue;
    return {
      clause: `"${fk.from}" IN (SELECT "${fk.to ?? 'id'}" FROM "${fk.table}" WHERE ${parent.clause})`,
      params: parent.params,
    };
  }
  return { clause: '1 = 0', params: [] };
}

// --- the PII registry --------------------------------------------------------------------------

type PiiCategory = 'name' | 'email' | 'address' | 'iban' | 'taxid';

interface PiiColumn {
  readonly table: string;
  readonly column: string;
  readonly category: PiiCategory;
}

/**
 * The CURATED PII columns. Person/company NAMES, e-mail, postal address parts, IBANs and tax numbers,
 * across the tables that actually carry client identity. Deliberately NOT the many structural `name`
 * columns (`account`, `item`, `project`, `cost_center`, `warehouse`, `automation_rule`, ...): masking
 * those would destroy the legibility pseudonymize is meant to keep. Free-text notes/descriptions are
 * handled separately, by pattern, below. `user`/`invite` PII never appears here because those tables
 * are never carried into a copy (identity exclusion).
 */
const PII_COLUMNS: readonly PiiColumn[] = [
  { table: 'contact', column: 'name', category: 'name' },
  { table: 'contact', column: 'address_street', category: 'address' },
  { table: 'contact', column: 'address_house_no', category: 'address' },
  { table: 'contact', column: 'address_zip', category: 'address' },
  { table: 'contact', column: 'address_city', category: 'address' },
  { table: 'contact', column: 'address_country', category: 'address' },
  { table: 'contact', column: 'email', category: 'email' },
  { table: 'contact', column: 'vat_number', category: 'taxid' },
  { table: 'employee', column: 'first_name', category: 'name' },
  { table: 'employee', column: 'last_name', category: 'name' },
  { table: 'workspace', column: 'name', category: 'name' },
  { table: 'workspace', column: 'creditor_name', category: 'name' },
  { table: 'workspace', column: 'creditor_address', category: 'address' },
  { table: 'workspace', column: 'creditor_iban', category: 'iban' },
  { table: 'workspace', column: 'email_relay', category: 'email' },
  { table: 'bank_account', column: 'iban', category: 'iban' },
  { table: 'creditor_bank_profile', column: 'iban', category: 'iban' },
  { table: 'payment_batch_item', column: 'creditor_iban', category: 'iban' },
  { table: 'bank_txn', column: 'payer_name', category: 'name' },
  { table: 'reconciliation_match', column: 'payer_name', category: 'name' },
  { table: 'gl_archive_line', column: 'source_account_name', category: 'name' },
  { table: 'document', column: 'sent_to_email', category: 'email' },
  { table: 'dispatches', column: 'recipient_email', category: 'email' },
  { table: 'mail_account', column: 'address', category: 'email' },
  { table: 'mail_message', column: 'from_address', category: 'email' },
  { table: 'mail_message', column: 'to_address', category: 'email' },
  { table: 'warehouse', column: 'address_line1', category: 'address' },
  { table: 'warehouse', column: 'address_line2', category: 'address' },
  { table: 'warehouse', column: 'postal_code', category: 'address' },
];

/** Free-text columns (may carry PII), redacted by name-pattern over every copied table. */
const FREE_TEXT_RE = /^(notes?|memo|comment|remark|parse_notes|subject|subject_resolved|description|before_description|after_description)$/i;

/** The pseudonym value for one PII cell, deterministic on the row id + category. */
function pseudonymFor(category: PiiCategory, id: string): string {
  switch (category) {
    case 'name':
      return `Muster ${token('name', id, 6).toUpperCase()}`;
    case 'email':
      return `kontakt.${token('email', id, 8)}@example.invalid`;
    case 'address':
      return `Teststrasse ${1 + intFor('addr', id, 199)}`;
    case 'iban':
      return chTestIban(id);
    case 'taxid':
      return `CHE-${String(intFor('vat-a', id, 1000)).padStart(3, '0')}.${String(intFor('vat-b', id, 1000)).padStart(3, '0')}.${String(intFor('vat-c', id, 1000)).padStart(3, '0')}`;
  }
}

// --- money scale (structure_synthetic + the pseudonymize opt-in) -------------------------------

/** Every `_minor` / `_rappen` integer column, the money convention (`portability.ts` FORMAT.md). */
function moneyColumns(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info("${table}")`) as { name: string }[])
    .map((c) => c.name)
    .filter((n) => /_minor$|_rappen$/i.test(n));
}

function allTables(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);
}

/**
 * Multiply every money column in `db` by the integer `factor`, scoped to `wsIds`. Balance-preserving:
 * one factor for all money means both sides of every entry scale together, and rates/quantities are
 * untouched so every derived figure stays consistent. A no-op for `factor <= 1`.
 */
export function scaleMoney(db: Database.Database, factor: number, wsIds: readonly string[]): number {
  if (!Number.isInteger(factor) || factor <= 1) return 0;
  let cells = 0;
  for (const table of allTables(db)) {
    const cols = moneyColumns(db, table);
    if (cols.length === 0) continue;
    const scope = workspaceScope(db, table, wsIds);
    if (scope.clause === '1 = 0') continue;
    for (const col of cols) {
      const info = db
        .prepare(`UPDATE "${table}" SET "${col}" = "${col}" * ? WHERE "${col}" IS NOT NULL AND (${scope.clause})`)
        .run(factor, ...scope.params);
      cells += info.changes;
    }
  }
  return cells;
}

// --- the public entry point --------------------------------------------------------------------

export interface SanitizeOptions {
  readonly level: Sanitization;
  /** The workspaces to sanitize (empty = every workspace, whole-instance scope). */
  readonly workspaceIds: readonly string[];
  /** D-ENV-9 opt-in demo scale for `pseudonymize` (kept intact when undefined/<=1). */
  readonly scaleFactor?: number | undefined;
}

export interface SanitizeSummary {
  readonly level: Sanitization;
  readonly piiCellsMasked: number;
  readonly ibansReplaced: number;
  readonly freeTextRedacted: number;
  readonly amountsScaled: number;
}

/**
 * Apply `level` to the target db. `raw` masks nothing (the secret floor is separate and always runs).
 * `pseudonymize` and `structure_synthetic` mask PII deterministically and redact free-text;
 * `structure_synthetic` additionally scales amounts. Throws on a SQL error so the copy`s build-then-swap
 * leaves the prior target intact.
 */
export function applySanitization(db: Database.Database, opts: SanitizeOptions): SanitizeSummary {
  const level = opts.level;
  if (level === 'raw') {
    return { level, piiCellsMasked: 0, ibansReplaced: 0, freeTextRedacted: 0, amountsScaled: 0 };
  }

  const wsIds = opts.workspaceIds;
  const existing = new Set(allTables(db));
  let piiCellsMasked = 0;
  let ibansReplaced = 0;
  let freeTextRedacted = 0;

  // 1. Structured PII: rewrite each non-null cell to a deterministic pseudonym keyed on the row id.
  for (const pii of PII_COLUMNS) {
    if (!existing.has(pii.table)) continue;
    const cols = colNames(db, pii.table);
    if (!cols.has(pii.column)) continue;
    const idCol = cols.has('id') ? 'id' : 'rowid';
    const scope = workspaceScope(db, pii.table, wsIds);
    if (scope.clause === '1 = 0') continue;
    const rows = db
      .prepare(`SELECT ${idCol} AS rid, "${pii.column}" AS val FROM "${pii.table}" WHERE "${pii.column}" IS NOT NULL AND (${scope.clause})`)
      .all(...scope.params) as { rid: string; val: unknown }[];
    const update = db.prepare(`UPDATE "${pii.table}" SET "${pii.column}" = ? WHERE ${idCol} = ?`);
    for (const r of rows) {
      const value = pseudonymFor(pii.category, String(r.rid));
      update.run(value, r.rid);
      piiCellsMasked += 1;
      if (pii.category === 'iban') ibansReplaced += 1;
    }
  }

  // 2. Free-text (notes/memo/comment/subject/description) on every copied table: redact by pattern.
  //    Deterministic on the row id so a re-run is idempotent. A structural token, no source text kept.
  for (const table of allTables(db)) {
    const info = db.pragma(`table_info("${table}")`) as { name: string; type: string }[];
    const idCol = info.some((c) => c.name === 'id') ? 'id' : 'rowid';
    const freeText = info.filter((c) => FREE_TEXT_RE.test(c.name) && /TEXT/i.test(c.type || ''));
    if (freeText.length === 0) continue;
    const scope = workspaceScope(db, table, wsIds);
    if (scope.clause === '1 = 0') continue;
    for (const col of freeText) {
      const rows = db
        .prepare(`SELECT ${idCol} AS rid FROM "${table}" WHERE "${col.name}" IS NOT NULL AND "${col.name}" != '' AND (${scope.clause})`)
        .all(...scope.params) as { rid: string }[];
      const update = db.prepare(`UPDATE "${table}" SET "${col.name}" = ? WHERE ${idCol} = ?`);
      for (const r of rows) {
        update.run(`[redigiert ${token('freetext', `${table}:${col.name}:${r.rid}`, 6)}]`, r.rid);
        freeTextRedacted += 1;
      }
    }
  }

  // 3. Amounts. structure_synthetic replaces amounts with a uniform, balance-preserving money scale;
  //    pseudonymize keeps amounts intact unless an opt-in demo scale is given (D-ENV-9).
  let amountsScaled = 0;
  if (level === 'structure_synthetic') {
    amountsScaled = scaleMoney(db, STRUCTURE_SCALE, wsIds);
  } else if (opts.scaleFactor !== undefined && opts.scaleFactor > 1) {
    amountsScaled = scaleMoney(db, Math.floor(opts.scaleFactor), wsIds);
  }

  return { level, piiCellsMasked, ibansReplaced, freeTextRedacted, amountsScaled };
}
