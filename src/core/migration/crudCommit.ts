/**
 * G09, the CRUD-class row mapper and dispatcher: `items`, `chart_of_accounts`, `tax_codes`,
 * `payment_terms`, `bank_accounts`.
 *
 * P3 IS THE SPINE. This module NEVER writes a domain row itself: every create routes through the
 * OWNING spec's verb (`createItem`, `createAccount`, `upsertTaxCode`, `updateContact`,
 * `createBankAccount`), so an imported row is subject to exactly the same validation, VAT resolution
 * and audit stamping as a hand-entered one. A resolved `take_imported` conflict routes through the
 * owning UPDATE verb, never a direct write.
 *
 * THE ROW SHAPE. A source row arrives as `ParsedRow` (source headers, string cells). Two layers turn
 * it into a verb input, in priority order:
 *   1. G10's APPLIED column map (`migration_map`, kind `column`): `{source: header, target: field}`.
 *   2. The neutral-field alias table below, matched on `normalizeToken` (the locale registry's own
 *      normalization), so a plain `sku,name,price` CSV works with no map at all.
 * Only the fields the target verb accepts survive (US-G09.8: minimisation is architectural); the
 * rest of the row is dropped here and never persisted.
 *
 * IDEMPOTENCY ON ROWS (§H-IDEMPOTENT). Every row is classified against its class's declared MATCH
 * KEY (US-G09.9) before dispatch: an exact match is `skip` (nothing to do), a key match with
 * differing fields is `conflict` (blocks commit until resolved), no match is `create`. Re-committing
 * the same source against the same target therefore creates ZERO extra rows, and that is asserted on
 * ROWS by the tests, not assumed.
 */

import type { WorkspaceContext } from '../context.js';
import type { Result } from '../result.js';
import { err } from '../result.js';
import { createItem, updateItem, updateContact } from '../sales/index.js';
import { createAccount, updateAccount, ACCOUNT_TYPES } from '../accounts/index.js';
import { upsertTaxCode } from '../vat/index.js';
import { createBankAccount, updateBankAccount } from '../banking/index.js';
import { normalizeToken } from './locale/registry.js';
import type { ParsedRow } from './adapters/parse.js';
import type { DataClass } from './dataClasses.js';

/** The five CRUD classes this module commits. `contacts` keeps its bespoke `contacts_import` path. */
export const CRUD_COMMIT_CLASSES: readonly DataClass[] = [
  'items',
  'chart_of_accounts',
  'tax_codes',
  'payment_terms',
  'bank_accounts',
];

export function isCrudCommitClass(dataClass: string): boolean {
  return (CRUD_COMMIT_CLASSES as readonly string[]).includes(dataClass);
}

// --- Layer 2: the neutral-field alias table (normalized via normalizeToken) ---------------------

/** Per class: neutral field id -> the normalized source headers known to carry it (de/fr/it/en). */
const FIELD_ALIASES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  items: {
    name: ['name', 'bezeichnung', 'artikelname', 'description', 'descrizione'],
    sku: ['sku', 'artikelnummer', 'artikelnr', 'artnr', 'itemnumber', 'nummer'],
    unitPriceMinor: ['unitpriceminor', 'priceminor', 'preisminor', 'preisrappen', 'rappen'],
    price: ['price', 'preis', 'verkaufspreis', 'ansatz', 'prix', 'prezzo'],
    unit: ['unit', 'einheit', 'unité', 'unita'],
    taxCode: ['taxcode', 'mwstcode', 'steuercode', 'codetva'],
    kind: ['kind', 'art', 'typ', 'type'],
  },
  chart_of_accounts: {
    number: ['number', 'konto', 'kontonummer', 'account', 'accountnumber', 'nummer', 'compte', 'conto'],
    name: ['name', 'bezeichnung', 'kontobezeichnung', 'description', 'label', 'libellé', 'descrizione'],
    type: ['type', 'typ', 'kontoart', 'art'],
    taxCode: ['taxcode', 'mwstcode', 'steuercode', 'codetva'],
  },
  tax_codes: {
    code: ['code', 'steuercode', 'mwstcode', 'taxcode', 'codetva'],
    kind: ['kind', 'art', 'typ', 'type'],
    rateBp: ['ratebp', 'satzbp'],
    rate: ['rate', 'satz', 'prozent', 'taux', 'aliquota'],
    formLine: ['formline', 'ziffer', 'formularziffer', 'chiffre'],
    label: ['label', 'bezeichnung', 'text', 'libellé', 'descrizione'],
    validFrom: ['validfrom', 'gültigab', 'ab'],
  },
  payment_terms: {
    contact: ['contact', 'kontakt', 'kunde', 'lieferant', 'name', 'client', 'fournisseur'],
    days: ['days', 'tage', 'zahlungsfrist', 'zahlungsziel', 'frist', 'nettotage', 'délai', 'giorni'],
  },
  bank_accounts: {
    name: ['name', 'bezeichnung', 'kontoname', 'bank'],
    iban: ['iban'],
    currency: ['currency', 'währung', 'monnaie', 'valuta'],
    ledgerAccount: ['ledgeraccount', 'konto', 'kontonummer', 'sachkonto', 'fibukonto', 'account'],
  },
};

/** A G10 applied-column-map entry, as `getMap` returns it: source header -> neutral field id. */
export interface AppliedColumnEntry {
  readonly source: string;
  readonly target?: string | null;
}

/** Read the plan's APPLIED column map (G10). No map yet is an empty list, never an error. */
export function appliedColumnMap(ctx: WorkspaceContext, planId: string): AppliedColumnEntry[] {
  const row = ctx.store.db
    .prepare("SELECT entries FROM migration_map WHERE plan_id = ? AND kind = 'column' AND workspace_id = ?")
    .get(planId, ctx.workspaceId) as { entries: string } | undefined;
  if (row === undefined) return [];
  try {
    const parsed = JSON.parse(row.entries) as AppliedColumnEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Turn one source row into a neutral-field record for its class: the applied column map first
 * (an explicit mapping ALWAYS wins), then the alias table for whatever the map left unmapped.
 */
export function normalizeCrudRow(
  dataClass: string,
  row: ParsedRow,
  map: readonly AppliedColumnEntry[],
): Record<string, string> {
  const aliases = FIELD_ALIASES[dataClass] ?? {};
  const byToken = new Map<string, string>();
  for (const [header, value] of Object.entries(row)) {
    if (!byToken.has(normalizeToken(header))) byToken.set(normalizeToken(header), value);
  }
  const out: Record<string, string> = {};
  // Layer 1: the applied column map. `target` is the neutral field id (G10 §4).
  for (const e of map) {
    if (e.target === null || e.target === undefined || e.target === '') continue;
    const value = row[e.source] ?? byToken.get(normalizeToken(e.source));
    if (value !== undefined && value !== '' && out[e.target] === undefined) out[e.target] = value;
  }
  // Layer 2: aliases fill only the gaps the map left.
  for (const [field, headers] of Object.entries(aliases)) {
    if (out[field] !== undefined) continue;
    for (const h of headers) {
      const value = byToken.get(normalizeToken(h));
      if (value !== undefined && value !== '') {
        out[field] = value;
        break;
      }
    }
  }
  return out;
}

// --- Value parsing (P2: parse exactly, never round) ---------------------------------------------

/** Parse an integer-minor amount, or a decimal major amount with at most 2 dp, into minor units. */
export function parseMinor(minorText: string | undefined, majorText: string | undefined): number | null | 'invalid' {
  if (minorText !== undefined) {
    const n = Number(minorText);
    return Number.isInteger(n) && n >= 0 ? n : 'invalid';
  }
  if (majorText === undefined) return null;
  // A decimal with more than 2 dp cannot be represented in Rappen without ROUNDING, which this
  // module must never do (P2: round once, and not here). Swiss exports use . or , as the decimal mark.
  const cleaned = majorText.replace(/'/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return 'invalid';
  const [whole, frac = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

/** Parse a percent (at most 2 dp, e.g. `8.1`) or an integer bp field into basis points. */
function parseRateBp(bpText: string | undefined, percentText: string | undefined): number | null | 'invalid' {
  if (bpText !== undefined) {
    const n = Number(bpText);
    return Number.isInteger(n) && n >= 0 ? n : 'invalid';
  }
  if (percentText === undefined) return null;
  const cleaned = percentText.replace('%', '').replace(',', '.').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return 'invalid';
  const [whole, frac = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

/** Map a source account-type word onto A01's enum; `null` when the word is not recognisable. */
function mapAccountType(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const t = normalizeToken(raw);
  if (ACCOUNT_TYPES.has(t as never)) return t;
  if (['aktiv', 'aktiven', 'actif', 'actifs', 'attivo'].includes(t)) return 'asset';
  if (['passiv', 'passiven', 'fremdkapital', 'passif', 'passivo'].includes(t)) return 'liability';
  if (['eigenkapital', 'fondspropres', 'capitaleproprio'].includes(t)) return 'equity';
  if (['ertrag', 'erträge', 'revenue', 'produits', 'ricavi'].includes(t)) return 'income';
  if (['aufwand', 'aufwände', 'charges', 'costi', 'cost'].includes(t)) return 'expense';
  return null;
}

/**
 * Derive an account type from a KMU-chart number when the source carries no usable type column.
 * Mirrors the KMU_CORE_SEED's own mapping (1 asset, 2 liability with 28/29 equity, 3 income,
 * 4-6 expense). A 7/8/9 account mixes Ertrag and Aufwand within one class, so it is NOT guessable
 * and the row fails with the reason named rather than landing under a wrong type.
 */
function deriveAccountType(number: string): string | null {
  const d = number.charAt(0);
  if (d === '1') return 'asset';
  if (d === '2') return number.startsWith('28') || number.startsWith('29') ? 'equity' : 'liability';
  if (d === '3') return 'income';
  if (d === '4' || d === '5' || d === '6') return 'expense';
  return null;
}

/** Map a source tax-kind word onto A05's enum; `null` when not recognisable. */
function mapTaxKind(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const t = normalizeToken(raw);
  const direct = ['output', 'input', 'reversecharge', 'import', 'zero', 'exempt', 'none'];
  if (direct.includes(t)) return t === 'reversecharge' ? 'reverse_charge' : t;
  if (['umsatz', 'umsatzsteuer', 'ust', 'verkauf'].includes(t)) return 'output';
  if (['vorsteuer', 'vst', 'einkauf'].includes(t)) return 'input';
  if (['bezugsteuer', 'bezugssteuer'].includes(t)) return 'reverse_charge';
  if (['einfuhr', 'einfuhrsteuer'].includes(t)) return 'import';
  if (['befreit', 'echtbefreit'].includes(t)) return 'zero';
  if (['ausgenommen'].includes(t)) return 'exempt';
  if (['keine', 'ohne'].includes(t)) return 'none';
  return null;
}

/** IBAN, normalized the way A19 compares it: uppercase, no spaces. */
function normIban(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

// --- Classification (US-G09.9): the match key decides create | skip | conflict ------------------

export type CrudOutcome = 'create' | 'skip' | 'conflict' | 'error';

export interface ClassifiedCrudRow {
  readonly ref: string;
  readonly outcome: CrudOutcome;
  /** For `error`: what is wrong; for `conflict`: which field differs. */
  readonly reason?: string;
  /** The neutral-field record dispatch consumes; present unless the row is an `error`. */
  readonly normalized: Record<string, string>;
  /** For `skip`/`conflict`: the id of the existing target row (contact id, account id, ...). */
  readonly existingId?: string;
}

function classified(ref: string, outcome: CrudOutcome, normalized: Record<string, string>, reason?: string, existingId?: string): ClassifiedCrudRow {
  return { ref, outcome, normalized, ...(reason !== undefined ? { reason } : {}), ...(existingId !== undefined ? { existingId } : {}) };
}

/** Compare an existing value against an imported one; `undefined` imported means "not asserted". */
function differs(imported: string | undefined, existing: string | null | undefined): boolean {
  if (imported === undefined || imported === '') return false;
  return imported.trim() !== (existing ?? '').trim();
}

function classifyOne(ctx: WorkspaceContext, dataClass: string, ref: string, n: Record<string, string>): ClassifiedCrudRow {
  const db = ctx.store.db;
  switch (dataClass) {
    case 'items': {
      if ((n.name ?? '') === '' && (n.sku ?? '') === '') return classified(ref, 'error', n, 'missing_name');
      const priceMinor = parseMinor(n.unitPriceMinor, n.price);
      if (priceMinor === 'invalid') return classified(ref, 'error', n, 'invalid_price');
      // Match key: SKU, then name (registry). §H-TENANT on both probes.
      const bySku = (n.sku ?? '') === ''
        ? undefined
        : (db.prepare('SELECT id, name, default_unit_price_minor FROM item WHERE workspace_id = ? AND item_sku = ?')
            .get(ctx.workspaceId, n.sku) as { id: string; name: string; default_unit_price_minor: number } | undefined);
      const byName = bySku !== undefined || (n.name ?? '') === ''
        ? undefined
        : (db.prepare('SELECT id, name, default_unit_price_minor FROM item WHERE workspace_id = ? AND name = ?')
            .get(ctx.workspaceId, n.name) as { id: string; name: string; default_unit_price_minor: number } | undefined);
      const hit = bySku ?? byName;
      if (hit === undefined) return classified(ref, 'create', n);
      const priceDiffers = priceMinor !== null && priceMinor !== hit.default_unit_price_minor;
      if (differs(n.name, hit.name) || priceDiffers) return classified(ref, 'conflict', n, 'item_exists_differs', hit.id);
      return classified(ref, 'skip', n, undefined, hit.id);
    }
    case 'chart_of_accounts': {
      if ((n.number ?? '') === '') return classified(ref, 'error', n, 'missing_account_number');
      const type = mapAccountType(n.type) ?? deriveAccountType(n.number ?? '');
      const hit = db
        .prepare('SELECT id, name, type FROM account WHERE workspace_id = ? AND number = ?')
        .get(ctx.workspaceId, n.number) as { id: string; name: string; type: string } | undefined;
      if (hit === undefined) {
        if ((n.name ?? '') === '') return classified(ref, 'error', n, 'missing_account_name');
        if (type === null) return classified(ref, 'error', n, 'unmappable_account_type');
        return classified(ref, 'create', { ...n, type });
      }
      // Match key: account number. Type is FROZEN on an existing account (A01), so a differing type
      // is a conflict the operator resolves, never a silent re-type.
      if (differs(n.name, hit.name) || (type !== null && type !== hit.type)) {
        return classified(ref, 'conflict', { ...n, ...(type !== null ? { type } : {}) }, 'account_exists_differs', hit.id);
      }
      return classified(ref, 'skip', n, undefined, hit.id);
    }
    case 'tax_codes': {
      if ((n.code ?? '') === '') return classified(ref, 'error', n, 'missing_code');
      const kind = mapTaxKind(n.kind);
      const rateBp = parseRateBp(n.rateBp, n.rate);
      if (rateBp === 'invalid') return classified(ref, 'error', n, 'invalid_rate');
      const hit = db
        .prepare('SELECT kind, rate_bp, esa_form_line FROM tax_code WHERE workspace_id = ? AND code = ?')
        .get(ctx.workspaceId, n.code) as { kind: string; rate_bp: number; esa_form_line: string | null } | undefined;
      if (hit === undefined) {
        if (kind === null) return classified(ref, 'error', n, 'unmappable_tax_kind');
        if (rateBp === null) return classified(ref, 'error', n, 'missing_rate');
        if ((n.formLine ?? '') === '') return classified(ref, 'error', n, 'missing_form_line');
        return classified(ref, 'create', { ...n, kind, rateBp: String(rateBp) });
      }
      const kindDiffers = kind !== null && kind !== hit.kind;
      const rateDiffers = rateBp !== null && rateBp !== hit.rate_bp;
      const lineDiffers = differs(n.formLine, hit.esa_form_line);
      if (kindDiffers || rateDiffers || lineDiffers) {
        return classified(ref, 'conflict', { ...n, ...(kind !== null ? { kind } : {}), ...(rateBp !== null ? { rateBp: String(rateBp) } : {}) }, 'tax_code_exists_differs', n.code);
      }
      return classified(ref, 'skip', n, undefined, n.code);
    }
    case 'payment_terms': {
      if ((n.contact ?? '') === '') return classified(ref, 'error', n, 'missing_contact');
      const days = Number(n.days);
      if (!Number.isInteger(days) || days < 0) return classified(ref, 'error', n, 'invalid_days');
      const hit = db
        .prepare('SELECT id, payment_terms_days FROM contact WHERE workspace_id = ? AND name = ? AND merged_into_id IS NULL')
        .get(ctx.workspaceId, n.contact) as { id: string; payment_terms_days: number } | undefined;
      // The target of a payment-terms row IS the contact: a missing one is an error the operator
      // fixes by importing contacts first, never a silent create of a half-known party.
      if (hit === undefined) return classified(ref, 'error', n, 'contact_not_found');
      // Match key: contact + days. Same days = nothing to do; a DIFFERENT explicit value already on
      // the contact is a conflict (the operator chose it); the 0 default is overwritable.
      if (hit.payment_terms_days === days) return classified(ref, 'skip', n, undefined, hit.id);
      if (hit.payment_terms_days !== 0) return classified(ref, 'conflict', n, 'payment_terms_differ', hit.id);
      return classified(ref, 'create', n, undefined, hit.id);
    }
    case 'bank_accounts': {
      if ((n.iban ?? '') === '') return classified(ref, 'error', n, 'missing_iban');
      const iban = normIban(n.iban ?? '');
      const hit = db
        .prepare('SELECT id, name, currency FROM bank_account WHERE workspace_id = ? AND iban = ?')
        .get(ctx.workspaceId, iban) as { id: string; name: string; currency: string } | undefined;
      if (hit === undefined) {
        if ((n.name ?? '') === '') return classified(ref, 'error', n, 'missing_name');
        return classified(ref, 'create', { ...n, iban });
      }
      if (differs(n.name, hit.name) || differs(n.currency, hit.currency)) {
        return classified(ref, 'conflict', { ...n, iban }, 'bank_account_exists_differs', hit.id);
      }
      return classified(ref, 'skip', { ...n, iban }, undefined, hit.id);
    }
    default:
      return classified(ref, 'error', n, 'unknown_data_class');
  }
}

/** Classify every row of a CRUD class. Zero writes anywhere: previewStep calls this as a READ. */
export function classifyCrudRows(
  ctx: WorkspaceContext,
  dataClass: string,
  rows: readonly ParsedRow[],
  map: readonly AppliedColumnEntry[],
  refOf: (index: number) => string,
): ClassifiedCrudRow[] {
  return rows.map((row, i) => classifyOne(ctx, dataClass, refOf(i), normalizeCrudRow(dataClass, row, map)));
}

// --- Dispatch: the OWNING verb writes, never this module (P3) -----------------------------------

export interface CrudRowResult {
  readonly ref: string;
  readonly outcome: 'created' | 'skipped' | 'failed';
  readonly targetKind: string;
  readonly targetId?: string;
  readonly reason?: string;
}

const TARGET_KINDS: Readonly<Record<string, string>> = {
  items: 'item',
  chart_of_accounts: 'account',
  tax_codes: 'tax_code',
  payment_terms: 'contact',
  bank_accounts: 'bank_account',
};

function extractId(res: Result, keys: readonly string[]): string | undefined {
  const r = res as unknown as Record<string, unknown>;
  for (const k of keys) {
    const v = r[k];
    if (typeof v === 'string') return v;
    if (v !== null && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') {
      return (v as { id: string }).id;
    }
  }
  return undefined;
}

/** Dispatch a CREATE through the owning verb. Returns the new target id, or the verb's refusal. */
function dispatchCreate(ctx: WorkspaceContext, dataClass: string, n: Record<string, string>, rowKey: string, existingId?: string): Result {
  switch (dataClass) {
    case 'items': {
      const priceMinor = parseMinor(n.unitPriceMinor, n.price);
      return createItem(ctx, {
        name: (n.name ?? n.sku) as string,
        defaultUnitPriceMinor: typeof priceMinor === 'number' ? priceMinor : 0,
        ...(n.sku !== undefined ? { sku: n.sku } : {}),
        ...(n.unit !== undefined ? { unit: n.unit } : {}),
        ...(n.taxCode !== undefined ? { defaultTaxCode: n.taxCode } : {}),
        ...(n.kind === 'product' || n.kind === 'service' ? { kind: n.kind } : {}),
      });
    }
    case 'chart_of_accounts':
      return createAccount(ctx, {
        number: n.number ?? '',
        name: n.name ?? '',
        type: n.type ?? '',
        ...(n.taxCode !== undefined ? { vatCodeDefault: n.taxCode } : {}),
        idempotencyKey: rowKey,
      });
    case 'tax_codes':
      return upsertTaxCode(ctx, {
        code: n.code ?? '',
        kind: n.kind ?? '',
        rateBp: Number(n.rateBp),
        formLine: n.formLine ?? '',
        ...(n.label !== undefined ? { label: n.label } : {}),
        ...(n.validFrom !== undefined ? { validFrom: n.validFrom } : {}),
        idempotencyKey: rowKey,
      });
    case 'payment_terms':
      // The owning verb IS an update: payment terms live on the contact (registry: `update_contact`).
      return updateContact(ctx, { contactId: existingId as string, patch: { paymentTermsDays: Number(n.days) } });
    case 'bank_accounts': {
      const ledger = (n.ledgerAccount ?? '') === ''
        ? undefined
        : (ctx.store.db
            .prepare("SELECT id FROM account WHERE workspace_id = ? AND number = ? AND type = 'asset' AND archived = 0")
            .get(ctx.workspaceId, n.ledgerAccount) as { id: string } | undefined);
      if (ledger === undefined) {
        // A19 requires a real asset ledger account; guessing one would tie bank money to the wrong
        // account. The operator maps a ledger-account column (or creates the account) and re-runs.
        return err('needs_ledger_account', { reason: (n.ledgerAccount ?? '') === '' ? 'missing' : 'unusable', ledgerAccount: n.ledgerAccount ?? null });
      }
      return createBankAccount(ctx, {
        name: n.name ?? '',
        iban: n.iban ?? '',
        ...(n.currency !== undefined ? { currency: n.currency.toUpperCase() } : {}),
        ledgerAccountId: ledger.id,
        idempotencyKey: rowKey,
      });
    }
    default:
      return err('unknown_data_class', { dataClass });
  }
}

/** Dispatch a resolved `take_imported` conflict through the owning UPDATE verb. */
function dispatchTakeImported(ctx: WorkspaceContext, dataClass: string, n: Record<string, string>, rowKey: string, existingId: string): Result {
  switch (dataClass) {
    case 'items': {
      const priceMinor = parseMinor(n.unitPriceMinor, n.price);
      return updateItem(ctx, {
        itemId: existingId,
        patch: {
          ...(n.name !== undefined ? { name: n.name } : {}),
          ...(typeof priceMinor === 'number' ? { defaultUnitPriceMinor: priceMinor } : {}),
        },
      });
    }
    case 'chart_of_accounts':
      // `number` and `type` are frozen on A01; take-imported can carry the NAME across, nothing else.
      return updateAccount(ctx, { accountId: existingId, ...(n.name !== undefined ? { name: n.name } : {}) });
    case 'tax_codes':
      // The owning verb is already an upsert; it refuses a resolution-affecting change on a
      // referenced code (§H-VAT-TRACE), which is exactly the guard the import must inherit.
      return dispatchCreate(ctx, dataClass, n, rowKey);
    case 'payment_terms':
      return updateContact(ctx, { contactId: existingId, patch: { paymentTermsDays: Number(n.days) } });
    case 'bank_accounts':
      return updateBankAccount(ctx, {
        bankAccountId: existingId,
        ...(n.name !== undefined ? { name: n.name } : {}),
        ...(n.currency !== undefined ? { currency: n.currency.toUpperCase() } : {}),
        idempotencyKey: rowKey,
      });
    default:
      return err('unknown_data_class', { dataClass });
  }
}

const ID_KEYS: Readonly<Record<string, readonly string[]>> = {
  items: ['item', 'itemId'],
  chart_of_accounts: ['accountId'],
  tax_codes: ['code'],
  payment_terms: ['contact'],
  bank_accounts: ['bankAccountId'],
};

/**
 * Commit a CRUD class's rows through the owning verbs. Row-level partial success (US-G09.3): a bad
 * row lands in the result with its reason while the rest commits. The caller (steps.ts) has already
 * enforced the gate, so an unresolved conflict reaching this loop is a defect guard, not a path.
 */
export function commitCrudRows(
  ctx: WorkspaceContext,
  dataClass: string,
  classifiedRows: readonly ClassifiedCrudRow[],
  resolutions: Readonly<Record<string, unknown>>,
  stepId: string,
): CrudRowResult[] {
  const targetKind = TARGET_KINDS[dataClass] ?? dataClass;
  const out: CrudRowResult[] = [];
  for (const row of classifiedRows) {
    const rowKey = `migstep:${stepId}:${row.ref}`;
    if (row.outcome === 'error') {
      out.push({ ref: row.ref, outcome: 'failed', targetKind, reason: row.reason ?? 'invalid_row' });
      continue;
    }
    if (row.outcome === 'skip') {
      out.push({ ref: row.ref, outcome: 'skipped', targetKind, ...(row.existingId !== undefined ? { targetId: row.existingId } : {}) });
      continue;
    }
    if (row.outcome === 'conflict') {
      const resolution = normalizeToken(String(resolutions[row.ref] ?? ''));
      if (resolution === 'takeimported' && row.existingId !== undefined) {
        const res = dispatchTakeImported(ctx, dataClass, row.normalized, rowKey, row.existingId);
        out.push(
          res.ok
            ? { ref: row.ref, outcome: 'created', targetKind, targetId: row.existingId }
            : { ref: row.ref, outcome: 'failed', targetKind, reason: String((res as { error?: unknown }).error ?? 'update_failed') },
        );
      } else if (resolution === 'keepexisting') {
        out.push({ ref: row.ref, outcome: 'skipped', targetKind, ...(row.existingId !== undefined ? { targetId: row.existingId } : {}) });
      } else {
        // The gate blocks unresolved conflicts before dispatch; this is the defence if it ever slips.
        out.push({ ref: row.ref, outcome: 'failed', targetKind, reason: 'unresolved_conflict' });
      }
      continue;
    }
    const res = dispatchCreate(ctx, dataClass, row.normalized, rowKey, row.existingId);
    if (!res.ok) {
      out.push({ ref: row.ref, outcome: 'failed', targetKind, reason: String((res as { error?: unknown }).error ?? 'create_failed') });
      continue;
    }
    const targetId = extractId(res, ID_KEYS[dataClass] ?? []) ?? row.existingId;
    out.push({ ref: row.ref, outcome: 'created', targetKind, ...(targetId !== undefined ? { targetId } : {}) });
  }
  return out;
}

/** The step's persisted conflict resolutions, parsed. */
export function parsedResolutions(conflictResolutions: string | null): Record<string, unknown> {
  if (conflictResolutions === null) return {};
  try {
    const parsed = JSON.parse(conflictResolutions) as Record<string, unknown>;
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
