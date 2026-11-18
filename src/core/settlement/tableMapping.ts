/**
 * A43 §2, THE TABLE DOOR: a CSV or XLSX export of a turnover source turned into ONE `till-settlement/v1`
 * document, which then flows UNCHANGED through `settlement_review` and `import_settlement`. There is no second
 * import path: this module books nothing, writes no event and decides no account. It writes exactly one thing,
 * the per-source column mapping (`set_settlement_table_mapping`), the `set_settlement_template` shape: one
 * live row per (workspace, system, processor), every change kept append-only with old and new, actor and time.
 *
 * THE MAPPING (per source):
 *  - `columns`: `day`, `amount` (the signed gross, the effect on the processor balance) and `id` (one column, or
 *    up to five composed into one id) are required; `kind`, `net`, `vat`, `vatRate`, `fee`, `counterparty`,
 *    `description`, `documentNumber`, `payoutId` and `currency` are optional;
 *  - `kindMap` (an export's type cell, trimmed and case-insensitive, to a `SETTLEMENT_KINDS` kind) and
 *    `kindDefault { positive, negative }` for a table without a kind column. A type cell the map does not
 *    name becomes `other` (the template's default asks a person), and the document's warnings name it: an
 *    unknown type is never booked as a sale by accident;
 *  - `fee`: a non-zero fee cell becomes its own `processing_fee` event with the id `<id>:fee`, so the gross
 *    and the fee are booked apart (`feeSign` `deducted`, the default: a positive cell is a fee taken from the
 *    balance; `signed`: the cell is already the signed effect);
 *  - `amountSign` `as_stated` (the default) | `by_kind` (the sign follows the kind: a sale is money in, a
 *    refund, a fee or a payout money out; `reserve` and `other` as stated), for an export of magnitudes;
 *  - `vat.mode`: `from_template` (the default: the gross is split at the template's tax code rate for the
 *    kind ON THE EVENT'S DAY, rounded ONCE to the Rappen, `gross x rate / (1 + rate)`, which is exactly the
 *    gross-split reading `import_settlement`'s `vatFits` accepts, so `amount = net + vat` always holds and
 *    `vat_not_exact` can never trip on it; the rounding is stated in the document's warnings), `stated` (the
 *    export's VAT or net column, checked by the import like any stated VAT), `none` (no VAT object);
 *  - the reader options: `dateFormat`, `decimalSeparator`, and `delimiter`, `encoding`, `headerRow` (A20 §13).
 *
 * THE EVENT ID (A43 §2, event identity, re-cut after two critic FAILs): a row is identified ONLY by an id the
 * export carries, one column or up to five composed as a JSON array (a day column among them contributes its
 * PARSED ISO day, so a CSV and an XLSX of the same rows compose the same id). There is no signature and no
 * occurrence counter: an id-less mapping refuses `id_column_missing` naming candidate columns to compose, a
 * row whose id cells are all blank refuses `missing_id`, and an id that repeats within ONE file refuses every
 * such row `id_not_unique`. The import's idempotency on the external id then holds by construction: the same
 * table twice, two overlapping exports, or a re-export in another order book every row once.
 *
 * THE WHOLE-DAY MODE (D206, `dayMode.ts`): under the setting `settlement.table_event_id` `column_else_day`, a
 * mapping WITHOUT an id that a person confirmed lists whole days (`wholeDays: true`, never with a payout id) mints
 * `day:<ISO day>#<n>` through the same id spec, and every day of the file is compared with what the source already
 * holds (`settlement_feed_event`): a new day imports whole, a held day of the same whole-day events is handed to the
 * import unchanged, a held day otherwise equal books nothing, a day that differs books nothing and is shown. A day
 * with an unreadable row books nothing (`day_incomplete`), the first and last day follow `settlement.table_edge_days`,
 * and a day of today or later never imports. The import checks the same again inside its own transaction.
 *
 * REFUSALS. A file whose headers differ from the SAVED mapping refuses whole (`table_mapping_mismatch`, with
 * the guessed mapping of the new file to start over from): a different report of the same source must never
 * book twice by accident. A given mapping naming a header the file lacks refuses the same way. A row with an
 * unreadable day or amount, a currency other than the workspace's, or a VAT the template cannot compute is
 * refused with its row number and a code, left out of the document, and named in its warnings.
 */

import { createHash } from 'node:crypto';

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Err, Result } from '../result.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { computeLineTax } from '../vat/applyVat.js';
import { isGovernedSeat } from '../access/index.js';
import { csvDate, readMoneyCell } from '../banking/csvStatement.js';
import { SETTLEMENT_KINDS, SETTLEMENT_SCHEMA, SETTLEMENT_ID_MAX, SETTLEMENT_TEXT_MAX } from './format.js';
import type { SettlementKind } from './format.js';
import { readSource, readStoredTemplate, TEMPLATE_KIND_DEFAULTS } from './template.js';
import type { SettlementTemplate } from './template.js';
import { headerKey, moneyText, readTable, xlsxSerialDay } from './tabular.js';
import type { ReaderOptions, TableContainer, TableRead } from './tabular.js';
import type { TabularCellKind } from '../tabular/index.js';
import {
  GENERIC_PROFILE_ID,
  IMPORT_PROFILE_SCHEMA,
  PROFILE_NOTE,
  PROFILE_REQUIRED_FIELDS,
  SETTLEMENT_TABLE_PROFILE_DATA,
  SETTLEMENT_TABLE_PROFILE_KIND,
} from './profiles.js';
import { zurichParts } from '../banking/ebics/autoSync.js';
import {
  DAY_ID_PREFIX,
  dayIdOf,
  daySumOf,
  heldVerdictOf,
  holdsDayIds,
  isDayId,
  daysBetween,
  movedFromNeighbourOf,
  nearHeldOf,
  newDayModeOf,
  observedByDay,
  shiftDay,
  silentHeldDaysOf,
  swissTodayOf,
  tableEdgeDaysModeOf,
  tableEventIdModeOf,
} from './dayMode.js';
import type { DayEvent, HeldVerdict, TableEdgeDaysMode } from './dayMode.js';

// --- the mapping shape -----------------------------------------------------------------------------------

export const TABLE_COLUMN_FIELDS = ['id', 'day', 'amount', 'kind', 'net', 'vat', 'vatRate', 'fee', 'counterparty', 'description', 'documentNumber', 'payoutId', 'currency'] as const;
export type TableColumnField = (typeof TABLE_COLUMN_FIELDS)[number];
export const TABLE_VAT_MODES = ['from_template', 'stated', 'none'] as const;
export type TableVatMode = (typeof TABLE_VAT_MODES)[number];
export const TABLE_VAT_FEES = ['none', 'from_template'] as const;
export type TableVatFees = (typeof TABLE_VAT_FEES)[number];
export const TABLE_DATE_FORMATS = ['yyyy-mm-dd', 'dd.mm.yyyy', 'dd.mm.yy', 'dd/mm/yyyy', 'mm/dd/yyyy'] as const;
export type TableDateFormat = (typeof TABLE_DATE_FORMATS)[number];
export const TABLE_FEE_SIGNS = ['deducted', 'signed'] as const;
export const TABLE_AMOUNT_SIGNS = ['as_stated', 'by_kind'] as const;
export const TABLE_DELIMITERS = ['semicolon', 'comma', 'tab'] as const;
export const TABLE_ENCODINGS = ['utf-8', 'windows-1252'] as const;

/** The most headers a mapping is saved against, and the longest header or cell value it names. */
const HEADERS_MAX = 500;
const NAME_MAX = 200;

/** The columns a mapping names: one header per field, and for `id` one header or SEVERAL composed into one id. */
export type TableColumns = Partial<Record<Exclude<TableColumnField, 'id'>, string>> & { id?: string | string[] };

/** The most columns one composed id reads. */
export const TABLE_ID_COLUMNS_MAX = 5;

/**
 * THE ID SCHEME: how this code derives an event id from a row (the id column, or the composed id as a JSON
 * array of its parts with a day column read as its parsed ISO day). Stamped on every mapping at save; a saved
 * mapping of another scheme meets `event_id_derivation_changed` while events are booked, so a change to the
 * derivation can never re-mint the ids of booked rows unnoticed. Version 3 (the re-cut: no signature, ids only);
 * version 4 (re-critic round 3: ids through ONE function and its spec, an amount part as its exact decimal);
 * version 5 (re-critic round 4: the reader options in the spec); version 6 (D206: the whole-day mode, its day key
 * in the spec).
 * No event was ever booked under versions 1 and 2 outside the unlanded A43 branch, so there is no legacy form to
 * look up or migrate.
 */
export const ID_SCHEME_VERSION = 5;

export interface TableMapping {
  /** The id scheme the mapping was saved under (`ID_SCHEME_VERSION`); never taken from a caller. */
  idScheme: number;
  columns: TableColumns;
  /** Keys are the type cell as `headerKey` reads it (trimmed, lower case). */
  kindMap: Record<string, SettlementKind>;
  kindDefault: { positive: SettlementKind; negative: SettlementKind };
  /**
   * `mode` for the event's VAT; `fees` (L1) whether `from_template` also splits a kind booked under an INPUT code
   * (a fee, a payout to a seller): `none` (the default) books it without VAT, so no unstated input VAT is invented.
   */
  vat: { mode: TableVatMode; fees: TableVatFees };
  dateFormat: TableDateFormat;
  decimalSeparator: '.' | ',';
  feeSign: 'deducted' | 'signed';
  amountSign: 'as_stated' | 'by_kind';
  /**
   * L1 (D172): what a DAY part of a composed id contributes: `day` (the default), the parsed ISO day; `second`, the
   * parsed day and, when the cell carries a time, its wall-clock time to the second as written (`YYYY-MM-DDTHH:MM:SS`,
   * any zone suffix dropped, never converted), so two transactions of one order on one day stay apart.
   */
  idDayPrecision: 'day' | 'second';
  /**
   * D206: a person confirmed that this export lists EVERY row of each day it covers. Only then, and only under
   * `settlement.table_event_id` `column_else_day`, is a mapping without an id read by whole days. Never with a
   * payout id (`day_mode_payout_mapped`). Saving it on is a person's act, audited (`confirm_whole_days`).
   */
  wholeDays?: boolean;
  delimiter?: (typeof TABLE_DELIMITERS)[number];
  encoding?: (typeof TABLE_ENCODINGS)[number];
  headerRow?: number;
}

/** The per-row refusal codes, with the sentence an agent reads. */
export const TABLE_ROW_REFUSALS: Readonly<Record<string, string>> = {
  not_a_movement: 'the row has no day: a total, a note or a carried balance, not a movement',
  unreadable_day: 'the day cell is not a date in the mapping date format',
  unreadable_amount: 'the amount cell is not an exact amount with at most two decimals',
  unreadable_fee: 'the fee cell is not an exact amount with at most two decimals',
  unreadable_vat: 'the VAT or net cell is not an exact amount with at most two decimals',
  missing_id: 'the id columns are mapped but this row has no id in any of them',
  id_not_unique: 'another row of the same file carries this id, so which one is meant is not knowable',
  id_time_unknown: 'the id reads the time of day, which this workbook date cell does not carry: export the table as CSV, or format the column as text in Excel (or read the id by the day)',
  id_too_long: `the id is longer than ${SETTLEMENT_ID_MAX} characters`,
  currency_mismatch: 'the row is in another currency than the workspace',
  rate_era_unknown: 'the tax code has no known rate on this day, so the VAT cannot be split from the gross',
  // D206, the whole-day mode: a row is refused with its DAY.
  day_incomplete: 'another row of this day could not be read, so the day is not whole: nothing of it is booked until a file lists it whole',
  day_differs: 'the books already hold this day with other amounts: nothing of it is booked; book the difference by hand',
  edge_day_excluded: 'the first or last day of the file may be cut at a time of day, and settlement.table_edge_days leaves it out',
  edge_day_unconfirmed: 'the first or last day of the file may be cut at a time of day: say whether it is complete to book it',
  day_not_over: 'the day is today or later, so it is not over yet: it is booked once a file lists it after the day',
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => Object.prototype.toString.call(v) === '[object Object]';
const isErr = (x: unknown): x is Err => isPlainObject(x) && x['ok'] === false;
const includes = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

/**
 * Read a mapping from a caller (or a profile): the shape only, every field checked by name. `field` prefixes
 * the refusal's field (`mapping`, `profile.mapping`).
 */
export function readTableMapping(raw: unknown, field = 'mapping'): TableMapping | Err {
  if (!isPlainObject(raw)) return err('invalid_input', { field, reason: 'an object { columns, kindMap?, kindDefault?, vat?, dateFormat?, ... }' });
  const colsRaw = raw['columns'];
  if (!isPlainObject(colsRaw)) return err('invalid_input', { field: `${field}.columns`, reason: 'an object of field to header, day and amount required' });
  const columns: TableColumns = {};
  for (const [k, v] of Object.entries(colsRaw)) {
    if (!includes(TABLE_COLUMN_FIELDS, k)) return err('invalid_input', { field: `${field}.columns.${k}`, reason: 'not a mapping field', allowed: [...TABLE_COLUMN_FIELDS] });
    if (v === null || v === undefined || v === '') continue;
    if (k === 'id' && Array.isArray(v)) {
      // A composed id: one to five distinct headers, read in this order.
      if (v.length === 0 || v.length > TABLE_ID_COLUMNS_MAX || v.some((x) => typeof x !== 'string' || x.trim().length === 0 || x.length > NAME_MAX)) {
        return err('invalid_input', { field: `${field}.columns.id`, reason: `one header, or 1 to ${TABLE_ID_COLUMNS_MAX} headers composed into one id` });
      }
      const ids = (v as string[]).map((x) => x.trim());
      if (new Set(ids.map(headerKey)).size !== ids.length) return err('invalid_input', { field: `${field}.columns.id`, reason: 'a header occurs twice in the id' });
      columns.id = ids.length === 1 ? (ids[0] as string) : ids;
      continue;
    }
    if (typeof v !== 'string' || v.trim().length === 0 || v.length > NAME_MAX) return err('invalid_input', { field: `${field}.columns.${k}`, reason: 'a header of the table' });
    (columns as Record<string, string>)[k] = v.trim();
  }
  for (const req of ['day', 'amount'] as const) {
    if (columns[req] === undefined) return err('invalid_input', { field: `${field}.columns.${req}`, reason: 'required: the header of the column' });
  }
  const kindMap: Record<string, SettlementKind> = {};
  const kmRaw = raw['kindMap'] ?? {};
  if (!isPlainObject(kmRaw)) return err('invalid_input', { field: `${field}.kindMap`, reason: 'an object of type cell to kind' });
  for (const [k, v] of Object.entries(kmRaw)) {
    if (k.trim().length === 0 || k.length > NAME_MAX) return err('invalid_input', { field: `${field}.kindMap`, reason: 'a type cell of 1 to 200 characters' });
    if (!includes(SETTLEMENT_KINDS, v)) return err('invalid_input', { field: `${field}.kindMap.${k}`, allowed: [...SETTLEMENT_KINDS] });
    kindMap[headerKey(k)] = v;
  }
  let kindDefault: TableMapping['kindDefault'] = { positive: 'sale', negative: 'refund' };
  if (raw['kindDefault'] !== undefined && raw['kindDefault'] !== null) {
    const kd = raw['kindDefault'];
    if (!isPlainObject(kd) || !includes(SETTLEMENT_KINDS, kd['positive']) || !includes(SETTLEMENT_KINDS, kd['negative'])) {
      return err('invalid_input', { field: `${field}.kindDefault`, reason: 'an object { positive, negative } of kinds', allowed: [...SETTLEMENT_KINDS] });
    }
    kindDefault = { positive: kd['positive'], negative: kd['negative'] };
  }
  let vatMode: TableVatMode = 'from_template';
  let vatFees: TableVatFees = 'none';
  if (raw['vat'] !== undefined && raw['vat'] !== null) {
    const v = raw['vat'];
    if (!isPlainObject(v) || !includes(TABLE_VAT_MODES, v['mode'])) return err('invalid_input', { field: `${field}.vat.mode`, allowed: [...TABLE_VAT_MODES] });
    vatMode = v['mode'];
    if (v['fees'] !== undefined && v['fees'] !== null) {
      if (!includes(TABLE_VAT_FEES, v['fees'])) return err('invalid_input', { field: `${field}.vat.fees`, allowed: [...TABLE_VAT_FEES] });
      vatFees = v['fees'];
    }
  }
  if (vatMode === 'stated' && columns.vat === undefined && columns.net === undefined) {
    return err('invalid_input', { field: `${field}.vat.mode`, reason: 'stated VAT needs a vat or a net column' });
  }
  const pick = <T extends string>(name: string, list: readonly T[], fallback: T): T | Err => {
    const v = raw[name];
    if (v === undefined || v === null) return fallback;
    return includes(list, v) ? v : err('invalid_input', { field: `${field}.${name}`, allowed: [...list] });
  };
  const dateFormat = pick('dateFormat', TABLE_DATE_FORMATS, 'yyyy-mm-dd');
  if (isErr(dateFormat)) return dateFormat;
  const decimalSeparator = pick('decimalSeparator', ['.', ','] as const, '.');
  if (isErr(decimalSeparator)) return decimalSeparator;
  const feeSign = pick('feeSign', TABLE_FEE_SIGNS, 'deducted');
  if (isErr(feeSign)) return feeSign;
  const amountSign = pick('amountSign', TABLE_AMOUNT_SIGNS, 'as_stated');
  if (isErr(amountSign)) return amountSign;
  const idDayPrecision = pick('idDayPrecision', ['day', 'second'] as const, 'day');
  if (isErr(idDayPrecision)) return idDayPrecision;
  const mapping: TableMapping = { idScheme: ID_SCHEME_VERSION, columns, kindMap, kindDefault, vat: { mode: vatMode, fees: vatFees }, dateFormat, decimalSeparator, feeSign, amountSign, idDayPrecision };
  if (raw['wholeDays'] !== undefined && raw['wholeDays'] !== null) {
    if (typeof raw['wholeDays'] !== 'boolean') return err('invalid_input', { field: `${field}.wholeDays`, reason: 'true or false' });
    if (raw['wholeDays']) mapping.wholeDays = true;
  }
  // D206 (paper critic F1): a per-payout report is not whole days by construction (one day's sales split over two
  // payouts), so the whole-day mode refuses a mapping that names a payout id.
  if (mapping.wholeDays === true && columns.payoutId !== undefined) {
    return err('day_mode_payout_mapped', { field: `${field}.columns.payoutId`, reason: 'a table that names a payout id lists a payout, not whole days: unmap the payout id, or compose an id' });
  }
  if (raw['delimiter'] !== undefined && raw['delimiter'] !== null) {
    if (!includes(TABLE_DELIMITERS, raw['delimiter'])) return err('invalid_input', { field: `${field}.delimiter`, allowed: [...TABLE_DELIMITERS] });
    mapping.delimiter = raw['delimiter'];
  }
  if (raw['encoding'] !== undefined && raw['encoding'] !== null) {
    if (!includes(TABLE_ENCODINGS, raw['encoding'])) return err('invalid_input', { field: `${field}.encoding`, allowed: [...TABLE_ENCODINGS] });
    mapping.encoding = raw['encoding'];
  }
  if (raw['headerRow'] !== undefined && raw['headerRow'] !== null) {
    const h = raw['headerRow'];
    if (typeof h !== 'number' || !Number.isInteger(h) || h < 1 || h > 200) return err('invalid_input', { field: `${field}.headerRow`, reason: 'a row number from 1 to 200' });
    mapping.headerRow = h;
  }
  return mapping;
}

/** The mapping as stored and compared: fields in a fixed order, so two saves of one mapping compare equal. */
export function canonicalMapping(m: TableMapping): string {
  const columns: Record<string, string | string[]> = {};
  for (const f of TABLE_COLUMN_FIELDS) {
    const v = (m.columns as Record<string, string | string[] | undefined>)[f];
    if (v !== undefined) columns[f] = Array.isArray(v) ? [...v] : v;
  }
  const kindMap: Record<string, string> = {};
  for (const k of Object.keys(m.kindMap).sort()) kindMap[k] = m.kindMap[k] as string;
  return JSON.stringify({
    idScheme: m.idScheme,
    columns,
    kindMap,
    kindDefault: { positive: m.kindDefault.positive, negative: m.kindDefault.negative },
    vat: { mode: m.vat.mode, fees: m.vat.fees ?? 'none' },
    dateFormat: m.dateFormat,
    decimalSeparator: m.decimalSeparator,
    feeSign: m.feeSign,
    amountSign: m.amountSign,
    idDayPrecision: m.idDayPrecision ?? 'day',
    wholeDays: m.wholeDays === true,
    ...(m.delimiter !== undefined ? { delimiter: m.delimiter } : {}),
    ...(m.encoding !== undefined ? { encoding: m.encoding } : {}),
    ...(m.headerRow !== undefined ? { headerRow: m.headerRow } : {}),
  });
}

function readerOptionsOf(m: TableMapping | null): ReaderOptions {
  if (m === null) return {};
  return {
    ...(m.delimiter !== undefined ? { delimiter: m.delimiter } : {}),
    ...(m.encoding !== undefined ? { encoding: m.encoding } : {}),
    ...(m.headerRow !== undefined ? { headerRow: m.headerRow } : {}),
  };
}

/** The id columns of a mapping, as a list (empty without an id column). */
export function idColumnsOf(m: TableMapping): string[] {
  const id = m.columns.id;
  return id === undefined ? [] : Array.isArray(id) ? [...id] : [id];
}

/** Every header a mapping names, the id columns included. */
export function mappedHeaders(m: TableMapping): string[] {
  const out: string[] = [];
  for (const [f, v] of Object.entries(m.columns) as [string, string | string[] | undefined][]) {
    if (v === undefined) continue;
    if (f === 'id') out.push(...idColumnsOf(m));
    else out.push(v as string);
  }
  return out;
}

/** The headers a mapping names that the table does not carry. */
export function missingColumns(m: TableMapping, headers: readonly string[]): string[] {
  const have = new Set(headers.map(headerKey));
  return mappedHeaders(m).filter((h) => !have.has(headerKey(h)));
}

/**
 * THE ID SPEC (A43 §2, event identity; re-critic round 3: a chokepoint, not an enumeration). `eventIdOf` reads a
 * row ONLY through this spec, and the spec is derived from the mapping by this ONE function, so everything the id
 * depends on is in it by construction: the scheme, the id headers in their order, and for each part its kind and
 * the parse options of that kind (a day part: the date format and the precision; an amount part: the decimal mark;
 * a text part: its normalisation). Anything the id function reads and the spec lacks is a type error, not a drift.
 */
export type IdPartSpec =
  | { header: string; kind: 'day'; dateFormat: TableDateFormat; precision: 'day' | 'second' }
  | { header: string; kind: 'amount'; decimal: '.' | ',' }
  | { header: string; kind: 'text'; norm: 'trim' };
export interface IdSpec {
  v: number;
  /**
   * Re-critic round 4, L1: the reader options that turn the file's bytes into the cells the parts read. The encoding
   * reaches a text part directly (a UTF-8 `Müller` forced through windows-1252 reads `MÃ¼ller` under the same
   * header), so it is in the spec; the delimiter and the header row are too, so no reader option can reach a part
   * without being in the recipe. `auto` where the mapping leaves the reader to detect it.
   */
  reader: { encoding: string; delimiter: string; headerRow: number | 'auto' };
  parts: IdPartSpec[];
  /**
   * D206: the whole-day key, present ONLY for a mapping without an id column that a person confirmed lists whole
   * days. Every cell the day id reads is named here with its parse option, so the recipe covers it by construction:
   * the day column and its date format, the amount and the fee columns and their decimal mark, and the type column
   * (folded, never the kind it maps to: a corrected kind map keeps the ids).
   */
  day?: DayKeySpec;
}

/** D206: what a whole-day id reads, and how (the sort key within the day: amount, fee, type cell, file order). */
export interface DayKeySpec {
  day: string;
  dateFormat: TableDateFormat;
  amount: string;
  fee: string | null;
  type: string | null;
  decimal: '.' | ',';
  /** The company's zone a time carrying an explicit offset is converted to before its day is taken (`wholeDayOf`). */
  zone: 'Europe/Zurich';
}

/** D206: one row's whole-day key, as `eventIdOf` reads it; `dayIdsOf` turns the keys of a file into ids. */
export interface DayKey {
  day: string;
  amountMinor: number;
  feeMinor: number;
  type: string;
}

/** D206: is this mapping read by whole days (no id column, and a person confirmed it lists whole days)? */
export function isWholeDayMapping(m: TableMapping): boolean {
  return idColumnsOf(m).length === 0 && m.wholeDays === true;
}

export function idSpecOf(m: TableMapping): IdSpec {
  const day = m.columns.day === undefined ? null : headerKey(m.columns.day);
  const money = new Set([m.columns.amount, m.columns.fee, m.columns.vat, m.columns.net].filter((x): x is string => x !== undefined).map(headerKey));
  return {
    v: m.idScheme ?? 1,
    reader: { encoding: m.encoding ?? 'auto', delimiter: m.delimiter ?? 'auto', headerRow: m.headerRow ?? 'auto' },
    parts: idColumnsOf(m).map((h): IdPartSpec => {
      const header = headerKey(h);
      if (header === day) return { header, kind: 'day', dateFormat: m.dateFormat, precision: m.idDayPrecision ?? 'day' };
      if (money.has(header)) return { header, kind: 'amount', decimal: m.decimalSeparator };
      return { header, kind: 'text', norm: 'trim' };
    }),
    ...(isWholeDayMapping(m) && m.columns.day !== undefined && m.columns.amount !== undefined
      ? {
          day: {
            day: headerKey(m.columns.day),
            dateFormat: m.dateFormat,
            amount: headerKey(m.columns.amount),
            fee: m.columns.fee === undefined ? null : headerKey(m.columns.fee),
            type: m.columns.kind === undefined ? null : headerKey(m.columns.kind),
            decimal: m.decimalSeparator,
            zone: 'Europe/Zurich',
          },
        }
      : {}),
  };
}

/** THE ID RECIPE: the canonical text of the id spec (keys in a fixed order by construction). */
export function idRecipeOf(m: TableMapping): string {
  return JSON.stringify(idSpecOf(m));
}

/**
 * A DAY part of an id under its spec: the parsed ISO day, and under `second` the time of day the cell carries,
 * `YYYY-MM-DDTHH:MM:SS`. A text cell's time is taken as written (its wall-clock time; a zone suffix such as `+0200`
 * or `Z` is dropped, never converted, the same for every row of every export of the source). An XLSX date serial's
 * fraction is rounded to the second. A workbook cell the reader typed `date` carries no time (the reader writes its
 * day only), so under `second` it refuses `id_time_unknown` rather than mint an id without the time.
 */
function idDayOf(raw: string, p: Extract<IdPartSpec, { kind: 'day' }>, container: TableContainer, kind: TabularCellKind | undefined): string | { code: string } {
  if (p.precision === 'second' && container === 'xlsx') {
    if (kind === 'date') return { code: 'id_time_unknown' };
    if (kind === 'number' && /^\d{5}(?:\.\d+)?$/.test(raw)) {
      const total = Math.round(Number(raw) * 86_400);
      const days = Math.floor(total / 86_400);
      const secs = total - days * 86_400;
      if (days < 20_000 || days > 80_000) return { code: 'unreadable_day' };
      const iso = new Date((days - 25_569) * 86_400_000).toISOString().slice(0, 10);
      if (secs === 0 && Number(raw) === Math.floor(Number(raw))) return iso;
      const hh = String(Math.floor(secs / 3600)).padStart(2, '0');
      const mm = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
      const ss = String(secs % 60).padStart(2, '0');
      return `${iso}T${hh}:${mm}:${ss}`;
    }
  }
  const day = dayOf(raw, p.dateFormat, container);
  if (day === null) return { code: 'unreadable_day' };
  if (p.precision === 'day') return day;
  const time = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(raw);
  if (time === null) return day;
  const [h, m, sec] = [Number(time[1]), Number(time[2]), Number(time[3] ?? '0')];
  if (h > 23 || m > 59 || sec > 59) return { code: 'unreadable_day' };
  return `${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** One id cell as `eventIdOf` reads it: its text and, for a workbook, the kind the reader answered. */
export type IdCell = { raw: string; kind: TabularCellKind | undefined };

/** An exact money cell in Rappen (a workbook number point-decimal, a cell of no known kind unreadable), or null. */
function exactMinorOf(c: IdCell, container: TableContainer, decimal: '.' | ','): number | null {
  const raw = c.raw.trim();
  if (raw === '') return null;
  if (container === 'xlsx' && c.kind !== 'number' && c.kind !== 'text') return null;
  const read = readMoneyCell(c.kind === 'number' ? moneyText(raw, container) : raw, { decimal, kind: c.kind });
  return read === null ? null : read.minor;
}

/**
 * THE ONE ID FUNCTION: a row's event id from the cells its spec names, through the spec alone. The parts compose
 * as a JSON array (injective); one part stays its text. A day part is its PARSED ISO day; an amount part its
 * exact decimal (a workbook number cell point-decimal, a cell without a known kind unreadable, fail-closed); a
 * text part its trimmed cell. Refusals: `missing_id` (no part, or every id cell blank), `unreadable_day`,
 * `unreadable_amount`, `id_too_long`.
 */
export function eventIdOf(cellOf: (header: string) => IdCell, container: TableContainer, spec: IdSpec): { id: string } | { code: string } | { dayKey: DayKey } {
  // D206: a whole-day mapping reads the row's day key (the id needs the whole day: `dayIdsOf`).
  if (spec.parts.length === 0 && spec.day !== undefined) {
    const d = spec.day;
    const day = wholeDayOf(cellOf(d.day).raw.trim(), d.dateFormat, container);
    if (day === null) return { code: 'unreadable_day' };
    const amountMinor = exactMinorOf(cellOf(d.amount), container, d.decimal);
    if (amountMinor === null) return { code: 'unreadable_amount' };
    let feeMinor = 0;
    if (d.fee !== null && cellOf(d.fee).raw.trim() !== '') {
      const fee = exactMinorOf(cellOf(d.fee), container, d.decimal);
      if (fee === null) return { code: 'unreadable_fee' };
      feeMinor = fee;
    }
    return { dayKey: { day, amountMinor, feeMinor, type: d.type === null ? '' : headerKey(cellOf(d.type).raw) } };
  }
  if (spec.parts.length === 0) return { code: 'missing_id' };
  const cells = spec.parts.map((p) => cellOf(p.header));
  if (cells.every((c) => c.raw.trim() === '')) return { code: 'missing_id' };
  const parts: string[] = [];
  for (const [i, p] of spec.parts.entries()) {
    const c = cells[i] as IdCell;
    const raw = c.raw.trim();
    if (p.kind === 'day') {
      const day = idDayOf(raw, p, container, c.kind);
      if (typeof day !== 'string') return day;
      parts.push(day);
    } else if (p.kind === 'amount') {
      if (raw === '') {
        parts.push('');
        continue;
      }
      if (container === 'xlsx' && c.kind !== 'number' && c.kind !== 'text') return { code: 'unreadable_amount' };
      const read = readMoneyCell(c.kind === 'number' ? moneyText(raw, container) : raw, { decimal: p.decimal, kind: c.kind });
      if (read === null) return { code: 'unreadable_amount' };
      parts.push(decimalOf(read.minor));
    } else {
      parts.push(raw);
    }
  }
  const id = parts.length === 1 ? (parts[0] as string) : JSON.stringify(parts);
  if (id.length > SETTLEMENT_ID_MAX - 4) return { code: 'id_too_long' };
  return { id };
}

/**
 * D206: the whole-day ids of a file, `day:<ISO day>#<n>`: per day, the rows sorted by their PARSED values only
 * (the stated amount, then the fee, then the folded type cell, then the file order), n counted from 1. The order an
 * export lists its rows in, and the kind a type maps to, never move an id.
 */
export function dayIdsOf(keys: readonly { key: DayKey; order: number }[]): Map<number, string> {
  const byDay = new Map<string, { key: DayKey; order: number }[]>();
  for (const k of keys) byDay.set(k.key.day, [...(byDay.get(k.key.day) ?? []), k]);
  const out = new Map<number, string>();
  for (const [day, list] of byDay) {
    const sorted = [...list].sort(
      (a, b) => a.key.amountMinor - b.key.amountMinor || a.key.feeMinor - b.key.feeMinor || (a.key.type < b.key.type ? -1 : a.key.type > b.key.type ? 1 : 0) || a.order - b.order,
    );
    sorted.forEach((k, i) => out.set(k.order, dayIdOf(day, i + 1)));
  }
  return out;
}

/** Candidate columns to compose an id from, for the `id_column_missing` hint: the mapped descriptive ones. */
function idCandidatesOf(m: TableMapping): string[] {
  const out: string[] = [];
  for (const f of ['day', 'kind', 'documentNumber', 'counterparty', 'description', 'payoutId'] as const) {
    const h = m.columns[f];
    if (h !== undefined && !out.includes(h)) out.push(h);
  }
  return out;
}

const ID_HINT = 'compose an id from columns that tell every row apart, for example the day, the type and the document number, or the day and the payment method for a till\'s daily totals';

/** The file's own spelling of a mapped header (the reader keys records by it). */
function headerIn(headers: readonly string[], name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const k = headerKey(name);
  return headers.find((h) => headerKey(h) === k);
}

// --- profiles ---------------------------------------------------------------------------------------------

export interface SettlementTableProfile {
  schema: typeof IMPORT_PROFILE_SCHEMA;
  kind: typeof SETTLEMENT_TABLE_PROFILE_KIND;
  id: string;
  label: string;
  match: { headers: string[] };
  mapping: TableMapping;
  docsUrl: string | null;
  note: string;
}

let builtIns: SettlementTableProfile[] | null = null;

/** The built-in catalogue, each entry's mapping checked by `readTableMapping` (a bad entry throws at first use). */
export function settlementTableProfiles(): readonly SettlementTableProfile[] {
  if (builtIns !== null) return builtIns;
  builtIns = SETTLEMENT_TABLE_PROFILE_DATA.map((p) => {
    const mapping = readTableMapping(p.mapping, `profile ${p.id}`);
    if (isErr(mapping)) throw new Error(`settlement table profile ${p.id} is invalid: ${JSON.stringify(mapping)}`);
    return { schema: p.schema, kind: p.kind, id: p.id, label: p.label, match: { headers: [...p.match.headers] }, mapping, docsUrl: p.docsUrl, note: p.note };
  });
  return builtIns;
}

/** The named profile whose `match.headers` the table carries (the most specific one), or null. */
export function profileForHeaders(headers: readonly string[]): SettlementTableProfile | null {
  const have = new Set(headers.map(headerKey));
  let best: SettlementTableProfile | null = null;
  for (const p of settlementTableProfiles()) {
    if (p.match.headers.length === 0 || !p.match.headers.every((h) => have.has(headerKey(h)))) continue;
    if (best === null || p.match.headers.length > best.match.headers.length) best = p;
  }
  return best;
}

/** A profile's mapping fitted to one table: optional columns the table lacks are dropped. */
function fitProfile(m: TableMapping, headers: readonly string[]): TableMapping {
  const have = new Set(headers.map(headerKey));
  const columns: TableColumns = {};
  for (const [f, h] of Object.entries(m.columns) as [string, string | string[]][]) {
    if (f === 'id') {
      // A composed id is kept only whole: dropping a part would mint other ids for the same rows.
      const ids = idColumnsOf(m);
      if (ids.every((x) => have.has(headerKey(x)))) columns.id = h;
      continue;
    }
    if (have.has(headerKey(h as string)) || PROFILE_REQUIRED_FIELDS.includes(f)) (columns as Record<string, string>)[f] = h as string;
  }
  return { ...m, columns };
}

/** A saved mapping as a profile file (`till-import-profile/v1`), for export from the source row. */
export function profileOfMapping(system: string, processor: string, mapping: TableMapping, headers: readonly string[]): SettlementTableProfile {
  return {
    schema: IMPORT_PROFILE_SCHEMA,
    kind: SETTLEMENT_TABLE_PROFILE_KIND,
    id: `${system}.${processor}`.replace(/[^a-z0-9._-]+/g, '_').slice(0, 100),
    label: `${system} / ${processor}`,
    match: { headers: [...headers] },
    mapping: JSON.parse(canonicalMapping(mapping)) as TableMapping,
    docsUrl: null,
    note: PROFILE_NOTE,
  };
}

/** Read a profile file a person imports: the envelope, then its mapping and the headers it matches. */
export function readImportProfile(raw: unknown): { mapping: TableMapping; headers: string[]; id: string } | Err {
  if (!isPlainObject(raw)) return err('invalid_input', { field: 'profile', reason: `a ${IMPORT_PROFILE_SCHEMA} object` });
  if (raw['schema'] !== IMPORT_PROFILE_SCHEMA) return err('unsupported_schema', { field: 'profile.schema', reason: `this TILL reads ${IMPORT_PROFILE_SCHEMA} only` });
  if (raw['kind'] !== SETTLEMENT_TABLE_PROFILE_KIND) return err('invalid_input', { field: 'profile.kind', reason: `a profile of kind ${SETTLEMENT_TABLE_PROFILE_KIND}`, allowed: [SETTLEMENT_TABLE_PROFILE_KIND] });
  const id = typeof raw['id'] === 'string' && raw['id'].length > 0 && raw['id'].length <= 100 ? raw['id'] : null;
  if (id === null) return err('invalid_input', { field: 'profile.id' });
  const match = raw['match'];
  const headers = isPlainObject(match) ? match['headers'] : undefined;
  const checked = readHeaders(headers, 'profile.match.headers');
  if (isErr(checked)) return checked;
  const mapping = readTableMapping(raw['mapping'], 'profile.mapping');
  if (isErr(mapping)) return mapping;
  return { mapping, headers: checked, id };
}

function readHeaders(raw: unknown, field: string): string[] | Err {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > HEADERS_MAX) return err('invalid_input', { field, reason: `the table headers, 1 to ${HEADERS_MAX}` });
  const out: string[] = [];
  const seen = new Set<string>();
  for (const h of raw) {
    if (typeof h !== 'string' || h.trim().length === 0 || h.length > NAME_MAX) return err('invalid_input', { field, reason: 'each header a text of 1 to 200 characters' });
    const k = headerKey(h);
    if (seen.has(k)) return err('invalid_input', { field, reason: `the header ${JSON.stringify(h)} occurs twice` });
    seen.add(k);
    out.push(h.trim());
  }
  return out;
}

// --- the generic profile: a guess from the headers ------------------------------------------------------

const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  id: ['id', 'transaction id', 'transaction_id', 'transaktions-id', 'transaktionsnummer', 'transaction code', 'transaktionscode', 'reference', 'referenz', 'balance_transaction_id'],
  day: ['date', 'day', 'created', 'transaction date', 'datum', 'buchungsdatum', 'transaktionsdatum', 'valuta', 'created_utc', 'date de transaction'],
  amount: ['amount', 'gross', 'betrag', 'brutto', 'bruttobetrag', 'total', 'montant', 'umsatz'],
  kind: ['type', 'kind', 'reporting_category', 'category', 'typ', 'art', 'transaktionstyp', 'transaction type'],
  vat: ['vat', 'vat amount', 'mwst', 'mwst-betrag', 'tax', 'tax amount', 'steuer', 'tva'],
  vatRate: ['vat rate', 'mwst-satz', 'mwst satz', 'tax rate', 'steuersatz'],
  fee: ['fee', 'fees', 'gebühr', 'gebühren', 'commission', 'kommission', 'transaction fee', 'frais'],
  counterparty: ['customer', 'customer_name', 'customer name', 'kunde', 'name', 'payer', 'zahler'],
  description: ['description', 'beschreibung', 'text', 'buchungstext', 'note', 'notiz'],
  documentNumber: ['order', 'order number', 'invoice', 'invoice_number', 'invoice number', 'rechnung', 'rechnungsnummer', 'bestellung', 'bestellnummer'],
  payoutId: ['payout id', 'payout_id', 'automatic_payout_id', 'auszahlungs-id', 'auszahlung'],
  currency: ['currency', 'währung', 'devise'],
};

const KIND_SYNONYMS: Readonly<Record<string, SettlementKind>> = {
  charge: 'sale',
  payment: 'sale',
  sale: 'sale',
  sales: 'sale',
  verkauf: 'sale',
  zahlung: 'sale',
  refund: 'refund',
  'rückerstattung': 'refund',
  gutschrift: 'refund',
  payout: 'bank_payout',
  auszahlung: 'bank_payout',
  fee: 'processing_fee',
  'gebühr': 'processing_fee',
};

/** Guess a mapping from the headers and the first rows (the generic profile); the person corrects it. */
export function guessMapping(headers: readonly string[], records: readonly Readonly<Record<string, string>>[]): TableMapping {
  const columns: Record<string, string> = {};
  const taken = new Set<string>();
  for (const field of TABLE_COLUMN_FIELDS) {
    const names = SYNONYMS[field];
    if (names === undefined) continue;
    const hit = names.map((n) => headers.find((h) => headerKey(h) === n && !taken.has(h))).find((h) => h !== undefined);
    if (hit !== undefined) {
      columns[field] = hit;
      taken.add(hit);
    }
  }
  // A table always needs a day and an amount: the first two columns stand in until the person picks.
  if (columns.day === undefined) columns.day = headers.find((h) => !taken.has(h)) ?? headers[0] ?? 'date';
  taken.add(columns.day);
  if (columns.amount === undefined) columns.amount = headers.find((h) => !taken.has(h)) ?? headers[0] ?? 'amount';
  const sample = records.slice(0, 50);
  const dayCells = sample.map((r) => (r[columns.day as string] ?? '').trim()).filter((c) => c !== '');
  const amountCells = sample.map((r) => (r[columns.amount as string] ?? '').trim()).filter((c) => c !== '');
  const kindMap: Record<string, SettlementKind> = {};
  if (columns.kind !== undefined) {
    for (const r of records) {
      const v = headerKey(r[columns.kind] ?? '');
      const k = KIND_SYNONYMS[v];
      if (v !== '' && k !== undefined) kindMap[v] = k;
    }
  }
  return {
    idScheme: ID_SCHEME_VERSION,
    columns,
    kindMap,
    kindDefault: { positive: 'sale', negative: 'refund' },
    vat: { mode: columns.vat !== undefined ? 'stated' : 'from_template', fees: 'none' },
    dateFormat: guessDateFormat(dayCells),
    decimalSeparator: amountCells.some((c) => /\d,\d{1,2}$/.test(c)) && !amountCells.some((c) => /\d\.\d{1,2}$/.test(c)) ? ',' : '.',
    feeSign: 'deducted',
    amountSign: 'as_stated',
    idDayPrecision: 'day',
  };
}

function guessDateFormat(cells: readonly string[]): TableDateFormat {
  if (cells.length === 0 || cells.every((c) => /^\d{4}-\d{1,2}-\d{1,2}/.test(c))) return 'yyyy-mm-dd';
  if (cells.every((c) => /^\d{1,2}\.\d{1,2}\.\d{4}/.test(c))) return 'dd.mm.yyyy';
  if (cells.every((c) => /^\d{1,2}\.\d{1,2}\.\d{2}$/.test(c))) return 'dd.mm.yy';
  if (cells.every((c) => /^\d{1,2}\/\d{1,2}\/\d{4}/.test(c))) {
    const parts = cells.map((c) => c.split('/').map(Number));
    if (parts.some((p) => (p[1] ?? 0) > 12)) return 'mm/dd/yyyy';
    return 'dd/mm/yyyy';
  }
  return 'yyyy-mm-dd';
}

// --- the conversion -----------------------------------------------------------------------------------

/** A day cell in the mapping's format; an XLSX date serial too. Null when it is not a date. */
function dayOf(raw: string, format: TableDateFormat, container: TableContainer): string | null {
  const v = raw.trim();
  if (container === 'xlsx') {
    const serial = xlsxSerialDay(v);
    if (serial !== null) return serial;
  }
  if (format === 'mm/dd/yyyy') {
    const hit = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s.*)?$/.exec(v);
    if (hit === null) return null;
    return csvDate(`${hit[2]}/${hit[1]}/${hit[3]}`, 'dd/mm/yyyy');
  }
  if (format === 'dd/mm/yyyy') {
    const hit = /^(\d{1,2}\/\d{1,2}\/\d{4})(?:\s.*)?$/.exec(v);
    return hit === null ? null : csvDate(hit[1] as string, 'dd/mm/yyyy');
  }
  return csvDate(v, format);
}

/**
 * D206, THE DAY OF A WHOLE-DAY ROW (critic r1 H1, amended D206 point 8): a cell that carries a time AND an explicit
 * zone (`Z`, `UTC`, `GMT`, `+02:00`, `+0200`, `-05`) is one instant, so it is converted to the company's day
 * (Europe/Zurich) before its day is taken: the same sale exported in another zone lands on the same day. A cell
 * without a zone (or an XLSX serial, which carries none) keeps its written date. A 12-hour time (`AM` / `PM`) is
 * read as such. Critic r2 L-B: any OTHER text after the time (`CEST`, `GMT+2`, `+2`, `+0000 (UTC)`) is a zone this
 * reader does not know, so the cell is unreadable (null) rather than taken for a cell without one. Column mode
 * never calls this.
 */
export function wholeDayOf(raw: string, format: TableDateFormat, container: TableContainer): string | null {
  const day = dayOf(raw, format, container);
  if (day === null) return null;
  const timed = /(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,]\d+)?(?:\s*(AM|PM))?(?:\s*(\S.*?))?\s*$/i.exec(raw.trim());
  if (timed === null) return day;
  const [h12, m, s] = [Number(timed[1]), Number(timed[2]), Number(timed[3] ?? '0')];
  const ampm = timed[4]?.toUpperCase();
  if (ampm !== undefined && (h12 < 1 || h12 > 12)) return null;
  const h = ampm === undefined ? h12 : (h12 % 12) + (ampm === 'PM' ? 12 : 0);
  if (h > 23 || m > 59 || s > 59) return null;
  const tail = timed[5];
  if (tail === undefined || (ampm === undefined && /^uhr$/i.test(tail))) return day;
  const zone = tail.toUpperCase();
  let offsetMin = 0;
  if (zone !== 'Z' && zone !== 'UTC' && zone !== 'GMT') {
    const z = /^([+-])(\d{2})(?::?(\d{2}))?$/.exec(zone);
    if (z === null) return null;
    const hh = Number(z[2]);
    const mm = Number(z[3] ?? '0');
    if (hh > 14 || mm > 59) return null;
    offsetMin = (z[1] === '-' ? -1 : 1) * (hh * 60 + mm);
  }
  const [y, mo, d] = day.split('-').map(Number) as [number, number, number];
  const instant = Date.UTC(y, mo - 1, d, h, m, s) - offsetMin * 60_000;
  return zurichParts(instant).date;
}

/** Integer Rappen as the exact decimal text the reader takes (`-12.3` never, `-12.30` always). */
export function decimalOf(minor: number): string {
  const neg = minor < 0;
  const abs = Math.abs(minor);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const MONEY_IN: ReadonlySet<SettlementKind> = new Set(['sale', 'third_party_payout_reversal']);
const MONEY_OUT: ReadonlySet<SettlementKind> = new Set(['refund', 'processing_fee', 'service_fee', 'third_party_payout', 'bank_payout', 'bank_payout_summary']);

function signedByKind(kind: SettlementKind, minor: number): number {
  if (MONEY_IN.has(kind)) return Math.abs(minor);
  if (MONEY_OUT.has(kind)) return 0 - Math.abs(minor);
  return minor;
}

type VatSplit = { netMinor: number; vat: { amount: string; code: string; rate: string } | null } | { code: string };

/**
 * VAT from the template: the gross split at the rate of the kind's tax code on the event's day, ONE rounding
 * (`computeLineTax` with the gross, the engine's own split), signed like the gross. A kind the template does
 * not book with a tax code carries no VAT object.
 */
function templateVat(ctx: WorkspaceContext, template: SettlementTemplate | null, kind: SettlementKind, day: string, amountMinor: number, fees: TableVatFees): VatSplit {
  const rule = template?.kinds[kind] ?? TEMPLATE_KIND_DEFAULTS[kind];
  if (template === null || rule === undefined || rule.action !== 'book' || rule.taxCode === null || amountMinor === 0) return { netMinor: amountMinor, vat: null };
  const split = computeLineTax(ctx, { amountMinor: Math.abs(amountMinor), amountIsGross: true, taxCode: rule.taxCode, supplyDate: day });
  if (!split.ok) return { code: (split as Err).error };
  const s = split as unknown as { netMinor: number; taxMinor: number; rateBp: number; kind: string };
  if (s.kind === 'none') return { netMinor: amountMinor, vat: null };
  // L1: an INPUT code (a fee, a payout to a seller) is split only when the mapping says so: the export states no
  // input VAT, and an invented one would be deducted.
  if (s.kind === 'input' && fees !== 'from_template') return { netMinor: amountMinor, vat: null };
  const sign = amountMinor < 0 ? -1 : 1;
  return { netMinor: sign * s.netMinor, vat: { amount: decimalOf(sign * s.taxMinor), code: rule.taxCode, rate: String(s.rateBp / 100) } };
}

export interface RefusedRow {
  row: number;
  code: string;
  reason: string;
  /** The row's cells, at most 200 characters each, so the person sees what was refused. */
  cells: Record<string, string>;
}

export interface TableConversion {
  document: Record<string, unknown>;
  refusedRows: RefusedRow[];
  /**
   * Every event amount of the document (the processor balance change it states), and the fee part. F9 (D206): `table`
   * is the same for every event the table's readable rows state, before any row or day is left out of the document.
   */
  totals: TableTotals;
  /** Every event of the document with its table row (a fee event shares its row's), for the booked check. */
  eventRows: { eventId: string; row: number }[];
  /** L4: every distinct type cell of the table (at most 200), so the kind map is never limited to the preview. */
  typeCells: string[];
  /** Round 4, L3: the text id columns a workbook holds as NUMBER cells (Excel may have changed them). */
  idTextAsNumber: string[];
  /** L6: what each row was read as, by row number: its event, or the code it was refused with. */
  parsed: Map<number, { id: string; day: string; kind: SettlementKind; amountMinor: number } | { code: string }>;
  warnings: string[];
  /** D206: the table is read by whole days (`day:` ids). */
  dayMode: boolean;
  /** D206: the parsed day of every row that has one, refused or not, by row number. */
  rowDays: Map<number, string>;
  /** D206: every event the table's readable rows state, per day, before any is left out (the file's side of a day). */
  dayEvents: Map<string, DayEvent[]>;
  /** D206 (F5): the days with a row that could not be read, left out whole (`day_incomplete`). */
  incompleteDays: string[];
}

export interface TableTotals {
  rows: number;
  events: number;
  amountMinor: number;
  feeMinor: number;
  table: { events: number; amountMinor: number; feeMinor: number };
}

const isFeeEvent = (e: Record<string, unknown>): boolean =>
  typeof e['id'] === 'string' && (e['id'] as string).endsWith(':fee') && e['kind'] === 'processing_fee' && (e['refs'] as Record<string, unknown> | undefined)?.['feeOf'] !== undefined;

/** The count, the sum and the fee part of a list of document events. */
function sumsOf(events: readonly Record<string, unknown>[]): { events: number; amountMinor: number; feeMinor: number } {
  let amountMinor = 0;
  let feeMinor = 0;
  for (const e of events) {
    const m = Math.round(Number(e['amount']) * 100);
    amountMinor += m;
    if (isFeeEvent(e)) feeMinor += m;
  }
  return { events: events.length, amountMinor, feeMinor };
}

/** D206 (F5): the refusals that leave a day not whole. Another currency and a total line are no movement of it. */
const DAY_NEUTRAL_REFUSALS: ReadonlySet<string> = new Set(['currency_mismatch', 'not_a_movement']);

const WARNING_ROWS_MAX = 50;

/** Turn the table into one `till-settlement/v1` document through the mapping. Writes nothing. */
export function tableToSettlement(
  ctx: WorkspaceContext,
  table: TableRead,
  mapping: TableMapping,
  source: { system: string; processor: string },
  template: SettlementTemplate | null,
): TableConversion {
  const currency = baseCurrencyOf(ctx);
  const h = (f: Exclude<TableColumnField, 'id'>): string | undefined => headerIn(table.headers, mapping.columns[f]);
  const idSpec = idSpecOf(mapping);
  const textIdKeys = new Set(idSpec.parts.filter((p) => p.kind === 'text').map((p) => p.header));
  const idTextAsNumber = new Set<string>();
  // Every event carries the hash of the recipe that minted its id, kept with the booked event (L3).
  const recipeHash = idRecipeHashOf(mapping);
  const col = {
    day: h('day'),
    amount: h('amount'),
    kind: h('kind'),
    net: h('net'),
    vat: h('vat'),
    vatRate: h('vatRate'),
    fee: h('fee'),
    counterparty: h('counterparty'),
    description: h('description'),
    documentNumber: h('documentNumber'),
    payoutId: h('payoutId'),
    currency: h('currency'),
  };
  const events: Record<string, unknown>[] = [];
  const refusedRows: RefusedRow[] = [];
  const unknownTypes = new Set<string>();
  let amountMinor = 0;
  let feeMinor = 0;
  const eventRows: { eventId: string; row: number }[] = [];
  // Per row: the events it produced (an index range of `events`) and its id, for the id_not_unique pass after.
  const rowEvents: { row: number; id: string; first: number; count: number; record: Readonly<Record<string, string>> }[] = [];
  // The reader's cell kinds count only when they are one entry per record, in step (fail-closed below).
  const kindsAligned = table.kinds !== null && table.kinds.length === table.records.length;
  const typeCells = new Set<string>();
  const parsed: TableConversion['parsed'] = new Map();
  // D206: the whole-day mode mints its ids after every row of a day is read (the n of `day:<day>#<n>`).
  const dayMode = idSpec.day !== undefined && idSpec.parts.length === 0;
  const dayKeys: { key: DayKey; order: number }[] = [];
  const rowDays = new Map<number, string>();

  table.records.forEach((record, i) => {
    const rowNumber = table.rowNumbers[i] ?? i + 2;
    const cell = (header: string | undefined): string => (header === undefined ? '' : (record[header] ?? '').trim());
    // EVERY MONEY CELL through the shared parser (WP1), with the cell's own kind: a NUMBER cell of a workbook is
    // point-decimal whatever the mapping says, a text cell (and every CSV cell) uses the mapping's mark. A currency
    // code the parser stripped that is not the workspace's makes the row foreign money: `currency_mismatch`, from
    // the parser's own answer, never from a second guess here.
    // FAIL-CLOSED (security review): a workbook cell is read by the mapping's decimal mark ONLY when the reader
    // positively answered `text` for that exact cell, looked up by this record's own index and header. A kinds list
    // that is missing or not one-for-one with the records is trusted for no row, and a cell without a kind is
    // unreadable, never guessed (a number read by a decimal comma is a 10x or 100x amount).
    const kinds = table.container === 'xlsx' && kindsAligned ? table.kinds?.[i] : undefined;
    const money = (header: string | undefined): number | null | 'foreign' => {
      const raw = cell(header);
      if (raw === '') return null;
      const kind = header === undefined ? undefined : kinds?.[header];
      if (table.container === 'xlsx' && kind !== 'number' && kind !== 'text') return null;
      const read = readMoneyCell(kind === 'number' ? moneyText(raw, table.container) : raw, { decimal: mapping.decimalSeparator, kind });
      if (read === null) return null;
      if (read.currency !== undefined && read.currency !== currency) return 'foreign';
      return read.minor;
    };
    const refuse = (code: string): void => {
      const cells: Record<string, string> = {};
      for (const hd of table.headers) cells[hd] = (record[hd] ?? '').slice(0, NAME_MAX);
      refusedRows.push({ row: rowNumber, code, reason: TABLE_ROW_REFUSALS[code] ?? code, cells });
      parsed.set(rowNumber, { code });
    };
    if (col.kind !== undefined && typeCells.size < 200) {
      const tc = (record[col.kind] ?? '').trim();
      if (tc !== '') typeCells.add(tc);
    }
    const dayCell = cell(col.day);
    if (dayCell === '') return refuse('not_a_movement');
    // D206 point 8 (amended): a whole-day row's day is the company's day of a zoned time, as its id reads it.
    const day = dayMode ? wholeDayOf(dayCell, mapping.dateFormat, table.container) : dayOf(dayCell, mapping.dateFormat, table.container);
    if (day === null) return refuse('unreadable_day');
    rowDays.set(rowNumber, day);
    const stated = money(col.amount);
    if (stated === 'foreign') return refuse('currency_mismatch');
    if (stated === null) return refuse('unreadable_amount');
    const cur = col.currency === undefined || cell(col.currency) === '' ? currency : cell(col.currency).toUpperCase();
    if (cur !== currency) return refuse('currency_mismatch');
    const typeCell = cell(col.kind);
    let kind: SettlementKind;
    if (col.kind === undefined) {
      kind = stated < 0 ? mapping.kindDefault.negative : mapping.kindDefault.positive;
    } else {
      const mapped = mapping.kindMap[headerKey(typeCell)];
      if (mapped === undefined) unknownTypes.add(typeCell === '' ? '(empty)' : typeCell.slice(0, 60));
      kind = mapped ?? 'other';
    }
    const factor = mapping.amountSign === 'by_kind' && stated !== 0 && signedByKind(kind, stated) !== stated ? -1 : 1;
    const amount = factor * stated;
    let feeSigned = 0;
    if (col.fee !== undefined && cell(col.fee) !== '') {
      const fee = money(col.fee);
      if (fee === 'foreign') return refuse('currency_mismatch');
      if (fee === null) return refuse('unreadable_fee');
      feeSigned = mapping.feeSign === 'deducted' ? 0 - fee : fee;
    }
    // THE ID, through the one id function and the spec alone (A43 §2, event identity): nothing here reads a cell
    // for the id, so nothing the id depends on can be missing from the recipe.
    const minted = eventIdOf(
      (key) => {
        const header = headerIn(table.headers, key);
        const kind = header === undefined ? undefined : kinds?.[header];
        // L3: a TEXT id part the workbook holds as a number may have lost leading zeros or digits to Excel.
        if (header !== undefined && kind === 'number' && textIdKeys.has(key)) idTextAsNumber.add(header);
        return { raw: cell(header), kind };
      },
      table.container,
      idSpec,
    );
    if ('code' in minted) return refuse(minted.code);
    // D206: a placeholder until the whole day is read; replaced by `day:<day>#<n>` below, never shipped.
    let id: string;
    if ('dayKey' in minted) {
      dayKeys.push({ key: minted.dayKey, order: i });
      id = `\u0000${i}`;
    } else {
      id = minted.id;
    }
    // VAT.
    let netMinor = amount;
    let vat: Record<string, unknown> | null = null;
    if (mapping.vat.mode === 'from_template') {
      const split = templateVat(ctx, template, kind, day, amount, mapping.vat.fees ?? 'none');
      if ('code' in split) return refuse(split.code);
      netMinor = split.netMinor;
      vat = split.vat;
    } else if (mapping.vat.mode === 'stated') {
      const vatCell = cell(col.vat);
      const netCell = cell(col.net);
      if (vatCell !== '') {
        const v = money(col.vat);
        if (v === 'foreign') return refuse('currency_mismatch');
        if (v === null) return refuse('unreadable_vat');
        vat = { amount: decimalOf(factor * v) };
        netMinor = amount - factor * v;
      } else if (netCell !== '') {
        const n = money(col.net);
        if (n === 'foreign') return refuse('currency_mismatch');
        if (n === null) return refuse('unreadable_vat');
        netMinor = factor * n;
        vat = { amount: decimalOf(amount - netMinor) };
      }
      if (vat !== null && cell(col.vatRate) !== '') vat['rate'] = cell(col.vatRate).slice(0, 20);
    }
    const text = (header: string | undefined): string | undefined => {
      const v = cell(header);
      return v === '' ? undefined : v.slice(0, SETTLEMENT_TEXT_MAX);
    };
    const docNumber = text(col.documentNumber);
    const payoutId = text(col.payoutId);
    const counterparty = text(col.counterparty);
    const description = text(col.description);
    events.push({
      id,
      kind,
      day,
      currency: cur,
      amount: decimalOf(amount),
      net: decimalOf(netMinor),
      vat,
      ...(docNumber !== undefined ? { document: { number: docNumber.slice(0, SETTLEMENT_ID_MAX) } } : {}),
      ...(counterparty !== undefined ? { counterparty } : {}),
      ...(description !== undefined ? { description } : {}),
      refs: { tableIdRecipe: recipeHash, ...(payoutId !== undefined ? { payoutId } : {}) },
    });
    amountMinor += amount;
    parsed.set(rowNumber, { id, day, kind, amountMinor: amount });
    const firstEvent = events.length - 1;
    // THE FEE: its own processing_fee event, `<id>:fee`, booked through the template like any fee.
    if (feeSigned !== 0) {
      let feeNet = feeSigned;
      let feeVat: Record<string, unknown> | null = null;
      if (mapping.vat.mode === 'from_template') {
        const split = templateVat(ctx, template, 'processing_fee', day, feeSigned, mapping.vat.fees ?? 'none');
        if ('code' in split) {
          events.pop();
          amountMinor -= amount;
          return refuse(split.code);
        }
        feeNet = split.netMinor;
        feeVat = split.vat;
      }
      events.push({
        id: `${id}:fee`,
        kind: 'processing_fee',
        day,
        currency: cur,
        amount: decimalOf(feeSigned),
        net: decimalOf(feeNet),
        vat: feeVat,
        ...(description !== undefined ? { description: `fee: ${description}`.slice(0, SETTLEMENT_TEXT_MAX) } : {}),
        refs: { feeOf: id, tableIdRecipe: recipeHash, ...(payoutId !== undefined ? { payoutId } : {}) },
      });
      amountMinor += feeSigned;
      feeMinor += feeSigned;
    }
    rowEvents.push({ row: rowNumber, id, first: firstEvent, count: events.length - firstEvent, record });
  });

  // D206: the whole-day ids, now that every row of every day is read.
  if (dayMode) {
    const minted = dayIdsOf(dayKeys);
    const real = (placeholder: string): string => minted.get(Number(placeholder.slice(1))) as string;
    for (const e of events) {
      const refs = e['refs'] as Record<string, unknown>;
      if (typeof refs['feeOf'] === 'string') {
        const base = real(refs['feeOf']);
        refs['feeOf'] = base;
        e['id'] = `${base}:fee`;
      } else {
        e['id'] = real(e['id'] as string);
      }
    }
    for (const r of rowEvents) r.id = real(r.id);
    for (const [row, p] of parsed) if (!('code' in p)) parsed.set(row, { ...p, id: real(p.id) });
  }
  // F9: what the table states, before any row or day is left out of the document.
  const tableSums = sumsOf(events);
  const dayEvents = new Map<string, DayEvent[]>();
  for (const e of events) {
    const d = e['day'] as string;
    dayEvents.set(d, [...(dayEvents.get(d) ?? []), { eventId: e['id'] as string, amountMinor: Math.round(Number(e['amount']) * 100) }]);
  }

  // ID_NOT_UNIQUE: an id that repeats within this one file refuses every row that carries it (which one is meant
  // is not knowable); never an occurrence counter. The totals are what stays in the document.
  const idCount = new Map<string, number>();
  for (const r of rowEvents) idCount.set(r.id, (idCount.get(r.id) ?? 0) + 1);
  const dropped = new Set<number>();
  for (const r of rowEvents) {
    if ((idCount.get(r.id) ?? 0) < 2) continue;
    for (let k = r.first; k < r.first + r.count; k += 1) dropped.add(k);
    const cells: Record<string, string> = {};
    for (const hd of table.headers) cells[hd] = (r.record[hd] ?? '').slice(0, NAME_MAX);
    refusedRows.push({ row: r.row, code: 'id_not_unique', reason: TABLE_ROW_REFUSALS['id_not_unique'] as string, cells });
    parsed.set(r.row, { code: 'id_not_unique' });
  }
  // D206 (F5): in the whole-day mode a day with a row that could not be read is not whole: every other row of it is
  // refused `day_incomplete` and nothing of the day reaches the document. Another currency stays excluded.
  const incompleteDays = new Set<string>();
  if (dayMode) {
    for (const r of refusedRows) {
      const d = rowDays.get(r.row);
      if (d !== undefined && !DAY_NEUTRAL_REFUSALS.has(r.code)) incompleteDays.add(d);
    }
    for (const r of rowEvents) {
      const d = rowDays.get(r.row);
      if (d === undefined || !incompleteDays.has(d)) continue;
      for (let k = r.first; k < r.first + r.count; k += 1) dropped.add(k);
      const cells: Record<string, string> = {};
      for (const hd of table.headers) cells[hd] = (r.record[hd] ?? '').slice(0, NAME_MAX);
      refusedRows.push({ row: r.row, code: 'day_incomplete', reason: TABLE_ROW_REFUSALS['day_incomplete'] as string, cells });
      parsed.set(r.row, { code: 'day_incomplete' });
    }
  }
  refusedRows.sort((a, b) => a.row - b.row);
  const kept = events.filter((_, k) => !dropped.has(k));
  events.length = 0;
  events.push(...kept);
  ({ amountMinor, feeMinor } = sumsOf(events));
  for (const r of rowEvents) {
    if ((idCount.get(r.id) ?? 0) >= 2) continue;
    const d = rowDays.get(r.row);
    if (d !== undefined && incompleteDays.has(d)) continue;
    eventRows.push({ eventId: r.id, row: r.row });
    if (r.count > 1) eventRows.push({ eventId: `${r.id}:fee`, row: r.row });
  }

  const warnings: string[] = [];
  if (mapping.vat.mode === 'from_template') {
    warnings.push(
      template === null
        ? 'VAT from the booking template: no template is saved for this source yet, so no event carries VAT; save the template and read the table again'
        : "VAT from the booking template: each event's VAT is its gross split at the rate of the kind's tax code on the event's day, rounded once to the Rappen (gross x rate / (1 + rate)), so amount = net + VAT exactly",
    );
  }
  if (mapping.vat.mode !== 'stated') {
    const noVat = events.filter((e) => (e['kind'] === 'sale' || e['kind'] === 'refund') && e['vat'] === null).length;
    if (noVat > 0) warnings.push(`${noVat} sales and refunds carry no VAT (their kind is booked without a tax code, no template is saved, or the mapping says none)`);
  }
  for (const h of idTextAsNumber) {
    warnings.push(`Excel turned the id column ${JSON.stringify(h)} into a number: leading zeros or long ids may differ from the CSV export`);
  }
  for (const t of unknownTypes) warnings.push(`The type ${JSON.stringify(t)} is not in the mapping: its rows are kind other, which the template leaves to a person`);
  for (const r of refusedRows.slice(0, WARNING_ROWS_MAX)) warnings.push(`Table row ${r.row} refused: ${r.code}`);
  if (refusedRows.length > WARNING_ROWS_MAX) warnings.push(`and ${refusedRows.length - WARNING_ROWS_MAX} more table rows refused`);
  for (const w of table.warnings.slice(0, 20)) warnings.push(`Reader: ${w}`.slice(0, SETTLEMENT_TEXT_MAX));

  const days = events.map((e) => e['day'] as string).sort();
  const document: Record<string, unknown> = {
    schema: SETTLEMENT_SCHEMA,
    source: { system: source.system, processor: source.processor },
    ...(days.length > 0 ? { period: { from: days[0], to: days[days.length - 1] } } : {}),
    currency,
    signConvention: 'amount = effect on the processor balance (positive = into it); gross incl. VAT; read from a table',
    warnings,
    events,
  };
  return {
    document,
    refusedRows,
    totals: { rows: table.records.length, events: events.length, amountMinor, feeMinor, table: tableSums },
    eventRows,
    typeCells: [...typeCells],
    idTextAsNumber: [...idTextAsNumber],
    parsed,
    warnings,
    dayMode,
    rowDays,
    dayEvents,
    incompleteDays: [...incompleteDays].sort(),
  };
}

// --- the stored mapping -------------------------------------------------------------------------------

interface MappingRow {
  id: string;
  source_system: string;
  source_processor: string;
  mapping_json: string;
  headers_json: string;
  updated_by: string;
  updated_at: string;
}

export interface StoredTableMapping {
  mappingId: string;
  system: string;
  processor: string;
  mapping: TableMapping;
  headers: string[];
  updatedBy: string;
  updatedAt: string;
}

function storedOf(row: MappingRow): StoredTableMapping {
  return {
    mappingId: row.id,
    system: row.source_system,
    processor: row.source_processor,
    mapping: JSON.parse(row.mapping_json) as TableMapping,
    headers: JSON.parse(row.headers_json) as string[],
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

/** The saved table mapping of one source, or null. */
export function readStoredTableMapping(ctx: WorkspaceContext, system: string, processor: string): StoredTableMapping | null {
  const row = ctx.store.db
    .prepare('SELECT id, source_system, source_processor, mapping_json, headers_json, updated_by, updated_at FROM settlement_table_mapping WHERE workspace_id = ? AND source_system = ? AND source_processor = ?')
    .get(ctx.workspaceId, system, processor) as MappingRow | undefined;
  return row === undefined ? null : storedOf(row);
}

export interface SetSettlementTableMappingInput {
  system?: unknown;
  processor?: unknown;
  mapping?: unknown;
  headers?: unknown;
  profile?: unknown;
  /** A43 §2 (critic M1): the person confirms a changed id recipe or header set after events were booked. */
  confirmIdChange?: unknown;
  /** Why (optional, D204), kept with the change row. */
  reason?: unknown;
  idempotencyKey?: unknown;
}

/** The short, stable hash of a mapping's id recipe, carried on every event a table mints (`refs.tableIdRecipe`). */
export function idRecipeHashOf(m: TableMapping): string {
  return createHash('sha256').update(idRecipeOf(m)).digest('hex').slice(0, 16);
}

/**
 * Re-cut round 2, L3: the id recipes the source's booked events were minted with (`refs.tableIdRecipe`, kept
 * with each booked event), so a FIRST save, or a profile or given mapping, is checked against what booked even
 * when no mapping was ever saved. Events from a JSON file or a feed carry none.
 */
export function bookedRecipesOf(ctx: WorkspaceContext, system: string, processor: string): Set<string> {
  const rows = ctx.store.db
    .prepare(
      "SELECT DISTINCT json_extract(refs_json, '$.tableIdRecipe') AS r FROM settlement_event WHERE workspace_id = ? AND source_system = ? AND source_processor = ? AND refs_json IS NOT NULL",
    )
    .all(ctx.workspaceId, system, processor) as { r: string | null }[];
  return new Set(rows.map((x) => x.r).filter((r): r is string => typeof r === 'string' && r.length > 0));
}

/**
 * Re-critic round 3, L2: the id recipes (`refs.tableIdRecipe`) a document's events carry that the source has not
 * booked under and that no saved mapping holds. The saved mapping's recipe counts as confirmed: a save that changed it
 * while events were booked needed a person's `confirmIdChange` (an agent's is drafted, a governed seat's refused). So
 * an import, including an agent's Vorschlag, never books under an id derivation nobody confirmed. Empty while the
 * source has booked no table event (nothing to differ from).
 */
export function unconfirmedRecipesOf(ctx: WorkspaceContext, system: string, processor: string, refsJsons: readonly (string | null)[]): string[] {
  const inDoc = new Set<string>();
  for (const r of refsJsons) {
    if (r === null) continue;
    try {
      const v = (JSON.parse(r) as Record<string, unknown>)['tableIdRecipe'];
      if (typeof v === 'string' && v.length > 0) inDoc.add(v);
    } catch {
      // refs that are not JSON carry no recipe
    }
  }
  if (inDoc.size === 0) return [];
  const booked = bookedRecipesOf(ctx, system, processor);
  if (booked.size === 0) return [];
  const saved = readStoredTableMapping(ctx, system, processor);
  if (saved !== null) booked.add(idRecipeHashOf({ ...saved.mapping, idScheme: saved.mapping.idScheme ?? 1 }));
  return [...inDoc].filter((r) => !booked.has(r));
}

/**
 * D206, the import's whole-file check of whole-day events (`day:` ids), run before anything is written: such an event
 * is booked only while the setting allows the whole-day mode and the source's SAVED mapping (a person confirmed its
 * `wholeDays`) minted it, by the recipe its `refs.tableIdRecipe` names. Null when the document has none or passes.
 */
export function dayModeRefusalOf(ctx: WorkspaceContext, system: string, processor: string, events: readonly { id: string; refsJson: string | null }[]): Err | null {
  const dayEvents = events.filter((e) => isDayId(e.id));
  if (dayEvents.length === 0) return null;
  const refuse = (cause: 'setting' | 'mapping' | 'recipe', reason: string): Err => err('day_mode_unconfirmed', { system, processor, cause, events: dayEvents.length, reason });
  if (tableEventIdModeOf(ctx) !== 'column_else_day') {
    return refuse('setting', `the file carries whole-day events (${DAY_ID_PREFIX}...), and settlement.table_event_id is column: switch it to column_else_day to book a table by whole days`);
  }
  const saved = readStoredTableMapping(ctx, system, processor);
  if (saved === null || !isWholeDayMapping(saved.mapping)) {
    return refuse('mapping', 'the file carries whole-day events, and the saved mapping of this source is not confirmed to list whole days: a person saves it with wholeDays first');
  }
  const hash = idRecipeHashOf({ ...saved.mapping, idScheme: saved.mapping.idScheme ?? 1 });
  for (const e of dayEvents) {
    let recipe: unknown = undefined;
    try {
      recipe = e.refsJson === null ? undefined : (JSON.parse(e.refsJson) as Record<string, unknown>)['tableIdRecipe'];
    } catch {
      recipe = undefined;
    }
    if (recipe !== hash) return refuse('recipe', 'a whole-day event of the file was minted otherwise than the saved mapping of this source reads the table: read the table again');
  }
  return null;
}

/** How many events the import booked for the source (`settlement_event`). */
function bookedEventsOf(ctx: WorkspaceContext, system: string, processor: string): number {
  return (
    ctx.store.db
      .prepare('SELECT COUNT(*) AS n FROM settlement_event WHERE workspace_id = ? AND source_system = ? AND source_processor = ?')
      .get(ctx.workspaceId, system, processor) as { n: number }
  ).n;
}

/** The headers of two lists that the other lacks, compared as `headerKey` reads them. */
function headerDiff(saved: readonly string[], now: readonly string[]): { missing: string[]; added: string[] } {
  const a = new Set(saved.map(headerKey));
  const b = new Set(now.map(headerKey));
  return { missing: saved.filter((h) => !b.has(headerKey(h))), added: now.filter((h) => !a.has(headerKey(h))) };
}

export type SetSettlementTableMappingOk = {
  mappingId: string;
  system: string;
  processor: string;
  changed: boolean;
  mapping: TableMapping;
  headers: string[];
};

type PreparedMapping = { system: string; processor: string; mapping: TableMapping; headers: string[]; idChange: string[]; reason: string | null; wholeDaysOn: boolean };

function prepareSetMapping(ctx: WorkspaceContext, input: SetSettlementTableMappingInput): PreparedMapping | Err {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) return err('invalid_input', { field: 'idempotencyKey' });
  const source = readSource(input);
  if (isErr(source)) return source;
  let mapping: TableMapping;
  let headers: string[];
  if (input.profile !== undefined && input.profile !== null) {
    if (input.mapping !== undefined || input.headers !== undefined) return err('invalid_input', { field: 'profile', reason: 'either profile (a profile file) or mapping and headers, not both' });
    const read = readImportProfile(input.profile);
    if (isErr(read)) return read;
    mapping = read.mapping;
    headers = read.headers;
  } else {
    const m = readTableMapping(input.mapping);
    if (isErr(m)) return m;
    const hs = readHeaders(input.headers, 'headers');
    if (isErr(hs)) return hs;
    mapping = m;
    headers = hs;
  }
  const missing = missingColumns(mapping, headers);
  if (missing.length > 0) return err('invalid_input', { field: 'mapping.columns', missing, reason: 'every mapped column must be one of the headers' });
  // D206: a mapping without an id is saved only for the whole-day mode (the setting allows it, the mapping says so).
  const dayModeAvailable = tableEventIdModeOf(ctx) === 'column_else_day';
  if (mapping.columns.id === undefined && !(dayModeAvailable && mapping.wholeDays === true)) {
    return err('id_column_missing', { field: 'mapping.columns.id', candidates: idCandidatesOf(mapping), dayModeAvailable, reason: ID_HINT });
  }
  if (input.confirmIdChange !== undefined && typeof input.confirmIdChange !== 'boolean') return err('invalid_input', { field: 'confirmIdChange' });
  if (input.reason !== undefined && input.reason !== null && (typeof input.reason !== 'string' || input.reason.length > 500)) return err('invalid_input', { field: 'reason', reason: 'at most 500 characters' });
  const s = source as { system: string; processor: string };
  // CRITIC M1: once events are booked for the source, the id derivation is frozen. A save that changes the id
  // recipe or the header set (another report) would mint other ids for the same rows, and the next overlapping
  // export would book them again: it needs the person's explicit confirmation.
  const idChange: string[] = [];
  const saved = readStoredTableMapping(ctx, s.system, s.processor);
  if (saved !== null) {
    if (idRecipeOf(saved.mapping) !== idRecipeOf(mapping)) idChange.push('id_recipe');
    const diff = headerDiff(saved.headers, headers);
    if (diff.missing.length > 0 || diff.added.length > 0) idChange.push('headers');
  } else {
    // L3: no mapping saved, but events booked from a table (a profile or a given mapping): the first save is
    // checked against the recipe those events were minted with.
    const booked = bookedRecipesOf(ctx, s.system, s.processor);
    if (booked.size > 0 && !booked.has(idRecipeHashOf(mapping))) idChange.push('id_recipe');
  }
  const booked = idChange.length > 0 ? bookedEventsOf(ctx, s.system, s.processor) : 0;
  if (booked === 0) idChange.length = 0;
  if (idChange.length > 0 && input.confirmIdChange !== true) {
    return err('event_id_derivation_changed', {
      system: s.system,
      processor: s.processor,
      changed: idChange,
      bookedEvents: booked,
      reason: `${booked} events are booked for this source; the new mapping would derive other ids for the same rows, so a later export could book them again. Send confirmIdChange: true to save it anyway`,
    });
  }
  const reason = typeof input.reason === 'string' && input.reason.trim().length > 0 ? input.reason.trim() : null;
  // D206: turning the whole-day flag on is a person's confirmation that the export lists whole days.
  const wholeDaysOn = mapping.wholeDays === true && saved?.mapping.wholeDays !== true;
  return { system: s.system, processor: s.processor, mapping, headers, idChange: input.confirmIdChange === true ? idChange : [], reason, wholeDaysOn };
}

/**
 * `set_settlement_table_mapping`: save (replace) the column mapping of one source, from a mapping and the
 * headers it was made for, or from a profile file. Books nothing. Needs `post`: the mapping decides which
 * cell becomes an amount, a kind and an id, which is what later imports book.
 */
export function setSettlementTableMapping(ctx: WorkspaceContext, input: SetSettlementTableMappingInput): Result<SetSettlementTableMappingOk> {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const prepared = prepareSetMapping(ctx, input);
  if (isErr(prepared)) return prepared;
  const { system, processor, mapping, headers, idChange, reason, wholeDaysOn } = prepared;
  // Re-cut round 2, L1: confirming an id change after a booking is a person's act. An agent proposes it (its call
  // at the dial `post` drafts a Vorschlag first, and the approval runs as the person); a governed seat EXECUTING
  // it is refused, under any dial or grant, so the flag is never self-confirmed.
  if (idChange.length > 0 && isGovernedSeat(ctx.store, ctx.actor)) {
    return err('person_decides', { field: 'confirmIdChange', reason: 'an agent proposes a changed id derivation; a person confirms it' });
  }
  // D206: so is confirming that an export lists whole days (an agent drafts it; a governed seat never executes it).
  if (wholeDaysOn && isGovernedSeat(ctx.store, ctx.actor)) {
    return err('person_decides', { field: 'mapping.wholeDays', reason: 'an agent proposes that an export lists whole days; a person confirms it' });
  }
  const json = canonicalMapping(mapping);
  const headersJson = JSON.stringify(headers);
  const scopedKey = JSON.stringify(['set_settlement_table_mapping', system, processor, input.idempotencyKey]);
  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'set_settlement_table_mapping', () => {
    const now = ctx.clock.now();
    const existing = ctx.store.db
      .prepare('SELECT id, mapping_json, headers_json FROM settlement_table_mapping WHERE workspace_id = ? AND source_system = ? AND source_processor = ?')
      .get(ctx.workspaceId, system, processor) as { id: string; mapping_json: string; headers_json: string } | undefined;
    let mappingId: string;
    let changed = true;
    if (existing === undefined) {
      mappingId = ctx.ids.next('stltmap');
      ctx.store.db
        .prepare('INSERT INTO settlement_table_mapping (id, workspace_id, source_system, source_processor, mapping_json, headers_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(mappingId, ctx.workspaceId, system, processor, json, headersJson, ctx.actor, now);
    } else {
      mappingId = existing.id;
      changed = existing.mapping_json !== json || existing.headers_json !== headersJson;
      if (changed) {
        ctx.store.db
          .prepare('UPDATE settlement_table_mapping SET mapping_json = ?, headers_json = ?, updated_by = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
          .run(json, headersJson, ctx.actor, now, ctx.workspaceId, mappingId);
      }
    }
    if (changed) {
      const oldJson = existing === undefined ? null : JSON.stringify({ mapping: JSON.parse(existing.mapping_json), headers: JSON.parse(existing.headers_json) });
      ctx.store.db
        .prepare('INSERT INTO settlement_table_mapping_change (id, workspace_id, mapping_id, old_json, new_json, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(
          ctx.ids.next('stltmapchg'),
          ctx.workspaceId,
          mappingId,
          oldJson,
          JSON.stringify({ mapping: JSON.parse(json), headers, ...(idChange.length > 0 ? { idChangeConfirmed: idChange, reason } : {}) }),
          ctx.actor,
          now,
        );
      ctx.audit.record({ entityKind: 'settlement_table_mapping', entityId: mappingId, action: existing === undefined ? 'create' : 'update', actor: ctx.actor, at: now });
      // The confirmed change of the id derivation is its own audit row: the override is never silent.
      if (idChange.length > 0) ctx.audit.record({ entityKind: 'settlement_table_mapping', entityId: mappingId, action: 'confirm_id_change', actor: ctx.actor, at: now });
      // D206: so is the confirmation that the export lists whole days.
      if (wholeDaysOn) ctx.audit.record({ entityKind: 'settlement_table_mapping', entityId: mappingId, action: 'confirm_whole_days', actor: ctx.actor, at: now });
    }
    return ok<SetSettlementTableMappingOk>({ mappingId, system, processor, changed, mapping: JSON.parse(json) as TableMapping, headers });
  });
}

/** D158: the save's own validation with nothing written, run before a governed seat's call is drafted. */
export function prevalidateSetSettlementTableMapping(ctx: WorkspaceContext, input: SetSettlementTableMappingInput): Result | undefined {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const prepared = prepareSetMapping(ctx, input);
  return isErr(prepared) ? prepared : undefined;
}

export type GetSettlementTableMappingOk = {
  mappings: Array<StoredTableMapping & { profile: SettlementTableProfile }>;
  profiles: Array<{ id: string; label: string; docsUrl: string | null; note: string; match: { headers: string[] } }>;
};

/**
 * `get_settlement_table_mapping`: the saved mapping of one source (`system` + `processor`), or of every source
 * when neither is given, each with its profile file for export; and the built-in profiles. A pure read.
 */
export function getSettlementTableMapping(ctx: WorkspaceContext, input: { system?: unknown; processor?: unknown }): Result<GetSettlementTableMappingOk> {
  const capable = ctx.capabilities.assert('read_books');
  if (!capable.ok) return capable;
  let rows: MappingRow[];
  if (input.system === undefined && input.processor === undefined) {
    rows = ctx.store.db
      .prepare('SELECT id, source_system, source_processor, mapping_json, headers_json, updated_by, updated_at FROM settlement_table_mapping WHERE workspace_id = ? ORDER BY source_system, source_processor')
      .all(ctx.workspaceId) as MappingRow[];
  } else {
    const source = readSource(input);
    if (isErr(source)) return source;
    const s = source as { system: string; processor: string };
    const one = readStoredTableMapping(ctx, s.system, s.processor);
    rows = [];
    if (one !== null) {
      rows.push({
        id: one.mappingId,
        source_system: one.system,
        source_processor: one.processor,
        mapping_json: canonicalMapping(one.mapping),
        headers_json: JSON.stringify(one.headers),
        updated_by: one.updatedBy,
        updated_at: one.updatedAt,
      });
    }
  }
  const mappings = rows.map((r) => {
    const s = storedOf(r);
    return { ...s, profile: profileOfMapping(s.system, s.processor, s.mapping, s.headers) };
  });
  const profiles = [
    { id: GENERIC_PROFILE_ID, label: 'Generic table', docsUrl: null, note: PROFILE_NOTE, match: { headers: [] as string[] } },
    ...settlementTableProfiles().map((p) => ({ id: p.id, label: p.label, docsUrl: p.docsUrl, note: p.note, match: { headers: [...p.match.headers] } })),
  ];
  return ok<GetSettlementTableMappingOk>({ mappings, profiles });
}

// --- settlement_from_table ------------------------------------------------------------------------------

export interface SettlementFromTableInput {
  system?: unknown;
  processor?: unknown;
  content?: unknown;
  contentBase64?: unknown;
  sheet?: unknown;
  mapping?: unknown;
  /** Re-cut round 2, L2: the caller confirms a mapping whose id recipe differs from what booked. */
  confirmIdChange?: unknown;
  /**
   * D206: the days a person says are complete (ISO days), so the door answers what the import, given the same
   * answer, does with the first and last day. Only the import's own `confirmEdgeDays` lets an edge day in.
   */
  confirmEdgeDays?: unknown;
}

/** D206: what a day of a whole-day table is, as the door answers it (`days`). */
export const DAY_STATUSES = ['new', 'passed', 'in_books', 'differs', 'incomplete', 'edge_excluded', 'edge_unconfirmed', 'not_over'] as const;
export type DayStatus = (typeof DAY_STATUSES)[number];
export interface DayVerdictView {
  day: string;
  status: DayStatus;
  /** The file's first or last day (or both, a one-day file), else null. */
  edge: 'first' | 'last' | 'both' | null;
  /** The table rows of the day. */
  rows: number[];
  /** What the file states for the day (every event its readable rows state). */
  file: { events: number; amountMinor: number };
  /** What the source holds on the day (`settlement_feed_event`), or null when it holds nothing. */
  books: { events: number; amountMinor: number } | null;
  /** A new day that books nothing because a row seems to have moved here from this neighbouring day (`movedFromNeighbourOf`). */
  movedFrom?: string;
  /**
   * D206 (critic r2 M-A): a new edge day whose outer neighbour the source holds, sharing these amounts with it
   * (`nearHeldOf`): it books only on a person's answer, whatever the edge setting, and the question names them.
   */
  nearHeld?: { day: string; amountsMinor: number[] };
}

export type MappingSource = 'given' | 'saved' | 'profile' | 'guessed';

export type SettlementFromTableOk = {
  system: string;
  processor: string;
  container: TableContainer;
  sheets: string[] | null;
  sheet: string | null;
  headers: string[];
  /** The first 20 data rows, header-keyed, with their row numbers. */
  rows: Array<{ row: number; cells: Record<string, string>; parsed: { id: string; day: string; kind: SettlementKind; amountMinor: number } | { code: string } | null }>;
  /** L4: every distinct type cell of the table (at most 200). */
  typeCells: string[];
  /** Round 4, L3: text id columns the workbook holds as number cells (warned). */
  idTextAsNumber: string[];
  rowCount: number;
  mappingSource: MappingSource;
  mapping: TableMapping;
  profile: { id: string; label: string; docsUrl: string | null; note: string };
  templateSaved: boolean;
  /**
   * Every event whose id is ALREADY BOOKED for the source with the same figures, with its table row: the import
   * answers it `already_imported` and books nothing again. Shown, never swallowed.
   */
  sameAsBooked: { eventId: string; row: number }[];
  /** Every event whose id is booked with OTHER figures: the import refuses it `event_amended` (same id, other figures). */
  sameIdOtherFigures: { eventId: string; row: number }[];
  /** The source also has a D198 feed: a second id space (warned). */
  feedSaved: boolean;
  /** A mapping is saved for the source; a given one is compared with it (critic M2). */
  savedMapping: boolean;
  /** The table's headers differ from the saved mapping's (a given mapping read another report), else null. */
  savedHeadersDiffer: { missing: string[]; added: string[] } | null;
  /** The given mapping derives event ids otherwise than the saved one. */
  idRecipeDiffers: boolean;
  /** How many events are booked for the source: what a replaced mapping could book again. */
  bookedEvents: number;
  settlement: Record<string, unknown>;
  refusedRows: RefusedRow[];
  totals: TableConversion['totals'];
  warnings: string[];
  /** D206: the table is read by whole days. */
  dayMode: boolean;
  /**
   * D206: every day the door left out of the document or handed through as held, with both sides; in the id mode
   * only a day the source holds with whole-day ids (F7: it stays gated after the mapping gained an id).
   */
  days: DayVerdictView[];
  /**
   * D206: the first and the last day of the document's whole-day events, which the IMPORT treats as possibly cut at
   * a time of day (`settlement.table_edge_days`), and the ones `confirmEdgeDays` names complete; else null.
   */
  edgeDays: { mode: TableEdgeDaysMode; first: string; last: string; confirmed: string[] } | null;
};

const PREVIEW_ROWS = 20;

/** D206: the most days one `confirmEdgeDays` names (a file has two edges; a few more do no harm). */
const CONFIRM_EDGE_DAYS_MAX = 10;

/** D206: `confirmEdgeDays`, the ISO days a person says are complete; the door and the import read it alike. */
export function readConfirmEdgeDays(raw: unknown): string[] | Err {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > CONFIRM_EDGE_DAYS_MAX || raw.some((d) => typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d))) {
    return err('invalid_input', { field: 'confirmEdgeDays', reason: `a list of at most ${CONFIRM_EDGE_DAYS_MAX} days (YYYY-MM-DD) a person says are complete` });
  }
  return [...new Set(raw as string[])];
}

/**
 * D206 (critic r1 M2): the first and the last day of the WHOLE file a whole-day document came from, a PERSON's call
 * input (the Studio sends the door's own `edgeDays.first` / `last`). A period's part of a file then keeps the file's
 * real edges, so a mid-file day at a period boundary is never taken for an edge. Absent, the edges are the
 * document's own first and last whole-day day. Never read from the document.
 */
export function readFileDays(raw: unknown): { first: string; last: string } | null | Err {
  if (raw === undefined || raw === null) return null;
  const iso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const o = raw as Record<string, unknown>;
  if (typeof raw !== 'object' || Array.isArray(raw) || !iso(o['first']) || !iso(o['last']) || (o['first'] as string) > (o['last'] as string)) {
    return err('invalid_input', { field: 'fileDays', reason: 'the first and last day (YYYY-MM-DD, first not after last) of the whole file the document came from' });
  }
  return { first: o['first'] as string, last: o['last'] as string };
}

/**
 * D206: what `settlement.table_edge_days` does with a NEW edge day of a whole-day document: null (book it), or the
 * refusal. `include` books it; `exclude` leaves it out; `ask` books it only when the person's answer names it.
 */
export function edgeVerdictOf(mode: TableEdgeDaysMode, day: string, confirmed: readonly string[]): 'edge_day_excluded' | 'edge_day_unconfirmed' | null {
  if (mode === 'include') return null;
  if (mode === 'exclude') return 'edge_day_excluded';
  return confirmed.includes(day) ? null : 'edge_day_unconfirmed';
}

/** The words of a day the door leaves out, for the document's warnings. */
function dayWarning(v: DayVerdictView): string | null {
  const chf = (m: number): string => decimalOf(m);
  switch (v.status) {
    case 'in_books':
      return `Day ${v.day} is already in the books (${v.books?.events ?? 0} events, ${chf(v.books?.amountMinor ?? 0)}): its rows book nothing`;
    case 'differs':
      if (v.rows.length === 0) return `Day ${v.day} is in the books (${chf(v.books?.amountMinor ?? 0)} in ${v.books?.events ?? 0} events) but the file lists no row for it: its rows may have moved to a neighbouring day in a re-export; a new neighbour carrying one of its amounts books nothing`;
      if (v.movedFrom !== undefined) return `Day ${v.day} carries an amount the books hold on ${v.movedFrom}, which differs: a row may have moved across midnight in a re-export, so nothing of either day is booked; book the difference by hand (a file that starts on ${v.day} asks you about it and names the amount: check it is not ${v.movedFrom}'s row first)`;
      return `Day ${v.day} differs from the books (booked ${chf(v.books?.amountMinor ?? 0)} in ${v.books?.events ?? 0} events, the file ${chf(v.file.amountMinor)} in ${v.file.events}): nothing of it is booked; book the difference by hand`;
    case 'incomplete':
      return `Day ${v.day} has a row that could not be read: nothing of it is booked until a file lists it whole`;
    case 'edge_excluded':
      return `Day ${v.day} is the first or last day of the file: the import leaves it out (settlement.table_edge_days exclude)`;
    case 'edge_unconfirmed':
      if (v.nearHeld !== undefined) return `Day ${v.day} shares ${v.nearHeld.amountsMinor.map(chf).join(', ')} with ${v.nearHeld.day}, which the books hold: a row may have moved across midnight in a re-export; the import books it only when a person confirms it complete and not ${v.nearHeld.day}'s row (confirmEdgeDays)`;
      return `Day ${v.day} is the first or last day of the file: the import books it only when a person confirms it complete (confirmEdgeDays)`;
    case 'not_over':
      return `Day ${v.day} is today or later: it is booked once a file lists it after the day`;
    default:
      return null;
  }
}

/**
 * D206, the day rules of the door (module header and `dayMode.ts`): every day of the table is compared with what the
 * source holds on it, the edges and today are applied in the whole-day mode, and every day that books nothing is
 * taken out of the document with its rows (refused with the day's code, or marked same as booked). Mutates the
 * conversion; answers the days and the edges.
 */
function applyDayRules(
  ctx: WorkspaceContext,
  source: { system: string; processor: string },
  table: TableRead,
  conversion: TableConversion,
  confirmed: readonly string[],
): { days: DayVerdictView[]; edgeDays: SettlementFromTableOk['edgeDays']; sameDayRows: { eventId: string; row: number }[] } {
  const allDays = [...new Set(conversion.rowDays.values())].sort();
  // Critic r3 H-1: every calendar day of the file's range, so a held day the file is silent on is seen too.
  const rangeDays = conversion.dayMode && allDays.length > 0 ? daysBetween(allDays[0] as string, allDays[allDays.length - 1] as string) : allDays;
  const observed = observedByDay(ctx, source.system, source.processor, rangeDays);
  const rowsOfDay = new Map<string, number[]>();
  for (const [row, d] of conversion.rowDays) rowsOfDay.set(d, [...(rowsOfDay.get(d) ?? []), row]);
  const views: DayVerdictView[] = [];
  let edgeDays: SettlementFromTableOk['edgeDays'] = null;
  const view = (day: string, status: DayStatus): DayVerdictView => {
    const held = observed.get(day);
    return { day, status, edge: null, rows: rowsOfDay.get(day) ?? [], file: daySumOf(conversion.dayEvents.get(day) ?? []), books: held === undefined ? null : daySumOf(held) };
  };
  if (conversion.dayMode) {
    const today = swissTodayOf(ctx);
    const incomplete = new Set(conversion.incompleteDays);
    for (const day of allDays) {
      if (day >= today) views.push(view(day, 'not_over'));
      else if (incomplete.has(day)) views.push(view(day, 'incomplete'));
      else views.push(view(day, heldVerdictOf(observed.get(day), conversion.dayEvents.get(day) ?? [])));
    }
    // Critic r3 H-1: a held day inside the range the file has no row for differs (the file's side is empty).
    if (allDays.length > 0) {
      for (const day of silentHeldDaysOf(new Set(allDays), allDays[0] as string, allDays[allDays.length - 1] as string, observed, today)) views.push(view(day, 'differs'));
      views.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    }
    // A row a re-export without zones moved across midnight (`movedFromNeighbourOf`): its new day books nothing.
    const verdicts = new Map<string, HeldVerdict>();
    for (const v of views) if (v.status === 'new' || v.status === 'passed' || v.status === 'in_books' || v.status === 'differs') verdicts.set(v.day, v.status);
    const moved = movedFromNeighbourOf(verdicts, observed, conversion.dayEvents);
    for (const v of views) {
      const neighbour = moved.get(v.day);
      if (neighbour === undefined) continue;
      v.status = 'differs';
      v.movedFrom = neighbour;
    }
  } else {
    // F7: a day the source holds with whole-day ids stays gated, whatever id the mapping reads now.
    for (const day of allDays) {
      const held = observed.get(day);
      if (!holdsDayIds(held)) continue;
      views.push(view(day, heldVerdictOf(held, conversion.dayEvents.get(day) ?? []) === 'in_books' ? 'in_books' : 'differs'));
    }
  }
  const withheld = new Map(views.filter((v) => v.status === 'not_over' || v.status === 'in_books' || v.status === 'differs').map((v) => [v.day, v]));
  const sameDayRows: { eventId: string; row: number }[] = [];
  if (withheld.size > 0) {
    const recordOf = new Map(table.records.map((r, i) => [table.rowNumbers[i] ?? i + 2, r]));
    const code: Record<string, string> = { differs: 'day_differs', not_over: 'day_not_over' };
    const events = conversion.document['events'] as Record<string, unknown>[];
    const kept = events.filter((e) => !withheld.has(e['day'] as string));
    events.length = 0;
    events.push(...kept);
    const keptRows: { eventId: string; row: number }[] = [];
    for (const r of conversion.eventRows) {
      const d = conversion.rowDays.get(r.row);
      const v = d === undefined ? undefined : withheld.get(d);
      if (v === undefined) keptRows.push(r);
      else if (v.status === 'in_books') sameDayRows.push(r);
    }
    conversion.eventRows = keptRows;
    const refusedAlready = new Set(conversion.refusedRows.map((r) => r.row));
    for (const v of withheld.values()) {
      if (v.status === 'in_books') continue;
      const c = code[v.status] as string;
      for (const row of v.rows) {
        if (refusedAlready.has(row)) continue;
        const record = recordOf.get(row) ?? {};
        const cells: Record<string, string> = {};
        for (const hd of table.headers) cells[hd] = (record[hd] ?? '').slice(0, NAME_MAX);
        conversion.refusedRows.push({ row, code: c, reason: TABLE_ROW_REFUSALS[c] ?? c, cells });
        conversion.parsed.set(row, { code: c });
      }
    }
    conversion.refusedRows.sort((a, b) => a.row - b.row);
    const sums = sumsOf(events);
    conversion.totals = { ...conversion.totals, events: sums.events, amountMinor: sums.amountMinor, feeMinor: sums.feeMinor };
    const days = events.map((e) => e['day'] as string).sort();
    if (days.length > 0) conversion.document['period'] = { from: days[0], to: days[days.length - 1] };
    else delete conversion.document['period'];
  }
  // THE EDGES (security review, 16.11.2026): the import decides them itself, from the first and the last day of the
  // whole-day events of the document it is given and the person's answer in ITS call (`confirmEdgeDays`), never from
  // the document. The door therefore leaves an edge day's events in the document and says here what the import will
  // do with them, so the person is asked about exactly those days.
  if (conversion.dayMode) {
    const docDays = [...new Set((conversion.document['events'] as Record<string, unknown>[]).map((e) => e['day'] as string))].sort();
    if (docDays.length > 0) {
      const mode = tableEdgeDaysModeOf(ctx);
      const first = docDays[0] as string;
      const last = docDays[docDays.length - 1] as string;
      edgeDays = { mode, first, last, confirmed: confirmed.filter((d) => docDays.includes(d)) };
      // Critic r4 H-1: the same read the import makes (`nearHeldOf` on every new day), so both answer alike.
      const around = observedByDay(ctx, source.system, source.processor, daysBetween(shiftDay(first, -1), shiftDay(last, 1)));
      for (const v of views) {
        if (v.day === first || v.day === last) v.edge = first === last ? 'both' : v.day === first ? 'first' : 'last';
        if (v.status !== 'new') continue;
        const near = nearHeldOf(v.day, conversion.dayEvents.get(v.day) ?? [], around);
        if (near !== null) v.nearHeld = near;
        const rule = newDayModeOf(mode, v.edge !== null, near !== null);
        const verdict = rule === null ? null : edgeVerdictOf(rule, v.day, confirmed);
        if (verdict !== null) v.status = verdict === 'edge_day_excluded' ? 'edge_excluded' : 'edge_unconfirmed';
      }
    }
  }
  for (const v of views) {
    const w = dayWarning(v);
    if (w !== null) (conversion.document['warnings'] as string[]).push(w.slice(0, SETTLEMENT_TEXT_MAX));
  }
  return { days: views, edgeDays, sameDayRows };
}

/**
 * The document's events whose id is already booked for the source (`settlement_event`), split into the same
 * figures (`already_imported`) and other figures (`event_amended`), in table order.
 */
function bookedOf(
  ctx: WorkspaceContext,
  system: string,
  processor: string,
  rows: readonly { eventId: string; row: number }[],
  events: readonly Record<string, unknown>[],
): { same: { eventId: string; row: number }[]; other: { eventId: string; row: number }[] } {
  if (rows.length === 0) return { same: [], other: [] };
  const booked = new Map<string, { kind: string; day: string; amount_minor: number; net_minor: number; vat_minor: number | null }>();
  const stmt = (n: number) =>
    ctx.store.db.prepare(
      `SELECT event_id, kind, day, amount_minor, net_minor, vat_minor FROM settlement_event WHERE workspace_id = ? AND source_system = ? AND source_processor = ? AND event_id IN (${Array(n).fill('?').join(',')})`,
    );
  for (let i = 0; i < rows.length; i += 400) {
    const ids = rows.slice(i, i + 400).map((r) => r.eventId);
    for (const r of stmt(ids.length).all(ctx.workspaceId, system, processor, ...ids) as { event_id: string; kind: string; day: string; amount_minor: number; net_minor: number; vat_minor: number | null }[]) booked.set(r.event_id, r);
  }
  const byId = new Map(events.map((e) => [e['id'] as string, e]));
  const minor = (v: unknown): number => Math.round(Number(v) * 100);
  const same: { eventId: string; row: number }[] = [];
  const other: { eventId: string; row: number }[] = [];
  for (const r of rows) {
    const b = booked.get(r.eventId);
    const e = byId.get(r.eventId);
    if (b === undefined || e === undefined) continue;
    const vat = e['vat'] === null || e['vat'] === undefined ? null : minor((e['vat'] as Record<string, unknown>)['amount']);
    const equal = b.kind === e['kind'] && b.day === e['day'] && b.amount_minor === minor(e['amount']) && b.net_minor === minor(e['net']) && (b.vat_minor ?? null) === vat;
    (equal ? same : other).push(r);
  }
  return { same, other };
}

/**
 * `settlement_from_table` (read): a table to a `till-settlement/v1` document, writing nothing. The mapping is
 * the one given, else the source's saved one (headers must match, else `table_mapping_mismatch`), else a
 * named profile the headers match, else the generic guess. Hand `settlement` unchanged to `settlement_review`
 * and then `import_settlement`.
 */
export function settlementFromTable(ctx: WorkspaceContext, input: SettlementFromTableInput): Result<SettlementFromTableOk> {
  const capable = ctx.capabilities.assert('read_books');
  if (!capable.ok) return capable;
  const source = readSource(input);
  if (isErr(source)) return source;
  const { system, processor } = source as { system: string; processor: string };
  // Re-critic round 3, L2: confirming an id change is a person's act, on this read as on the save.
  if (input.confirmIdChange === true && isGovernedSeat(ctx.store, ctx.actor)) {
    return err('person_decides', { field: 'confirmIdChange', reason: 'an agent proposes a changed id derivation; a person confirms it' });
  }
  // D206: the days a person says are complete, read as the import reads them.
  const confirmedEdges = readConfirmEdgeDays(input.confirmEdgeDays);
  if (isErr(confirmedEdges)) return confirmedEdges;
  let given: TableMapping | null = null;
  if (input.mapping !== undefined && input.mapping !== null) {
    const m = readTableMapping(input.mapping);
    if (isErr(m)) return m;
    given = m;
  }
  // CRITIC M2: the saved mapping is read whether or not one is given, so a given one is always compared with it.
  const stored = readStoredTableMapping(ctx, system, processor);
  const saved = given === null ? stored : null;
  const table = readTable(input, readerOptionsOf(given ?? saved?.mapping ?? null));
  if (isErr(table)) return table;

  let mapping: TableMapping;
  let mappingSource: MappingSource;
  let savedHeadersDiffer: { missing: string[]; added: string[] } | null = null;
  let idRecipeDiffers = false;
  let profile: SettlementFromTableOk['profile'] = { id: GENERIC_PROFILE_ID, label: 'Generic table', docsUrl: null, note: PROFILE_NOTE };
  if (given !== null) {
    const missing = missingColumns(given, table.headers);
    if (missing.length > 0) {
      return err('table_mapping_mismatch', { system, processor, missing, headers: table.headers, reason: 'the mapping names columns this table does not carry' });
    }
    mapping = given;
    mappingSource = 'given';
    if (stored !== null) {
      const diff = headerDiff(stored.headers, table.headers);
      if (diff.missing.length > 0 || diff.added.length > 0) savedHeadersDiffer = diff;
      idRecipeDiffers = idRecipeOf(stored.mapping) !== idRecipeOf(given);
    }
    profile = { id: `${system}.${processor}`, label: `${system} / ${processor}`, docsUrl: null, note: PROFILE_NOTE };
  } else if (saved !== null) {
    const savedKeys = new Set(saved.headers.map(headerKey));
    const fileKeys = new Set(table.headers.map(headerKey));
    const missing = saved.headers.filter((hd) => !fileKeys.has(headerKey(hd)));
    const added = table.headers.filter((hd) => !savedKeys.has(headerKey(hd)));
    if (missing.length > 0 || added.length > 0) {
      const named = profileForHeaders(table.headers);
      return err('table_mapping_mismatch', {
        system,
        processor,
        missing,
        added,
        headers: table.headers,
        guessedMapping: named !== null ? fitProfile(named.mapping, table.headers) : guessMapping(table.headers, table.records),
        reason: 'the headers differ from the saved mapping of this source: a different report of the same source must never book twice; map it anew and save the mapping, or use another source name',
      });
    }
    // A saved mapping of another id scheme would mint other ids for rows already booked: save it again, confirmed.
    if ((saved.mapping.idScheme ?? 1) !== ID_SCHEME_VERSION) {
      const booked = bookedEventsOf(ctx, system, processor);
      if (booked > 0) {
        return err('event_id_derivation_changed', {
          system,
          processor,
          changed: ['id_scheme'],
          bookedEvents: booked,
          reason: `the saved mapping derives ids by scheme ${saved.mapping.idScheme ?? 1}, this TILL by scheme ${ID_SCHEME_VERSION}, and ${booked} events are booked: save the mapping again with confirmIdChange: true`,
        });
      }
    }
    mapping = { ...saved.mapping, idScheme: ID_SCHEME_VERSION };
    mappingSource = 'saved';
    profile = { id: `${system}.${processor}`, label: `${system} / ${processor}`, docsUrl: null, note: PROFILE_NOTE };
  } else {
    const named = profileForHeaders(table.headers);
    if (named !== null) {
      mapping = fitProfile(named.mapping, table.headers);
      mappingSource = 'profile';
      profile = { id: named.id, label: named.label, docsUrl: named.docsUrl, note: named.note };
    } else {
      mapping = guessMapping(table.headers, table.records);
      mappingSource = 'guessed';
    }
  }
  // RE-CUT: a table is read only with an id. Without one the person (or the agent) composes one; the refusal carries
  // what the mapping step needs to do that: the headers, the preview rows, the mapping so far and the candidates.
  // D206: unless the setting allows the whole-day mode and the mapping says the export lists whole days.
  const dayModeAvailable = tableEventIdModeOf(ctx) === 'column_else_day';
  if (mapping.columns.id === undefined && !(dayModeAvailable && isWholeDayMapping(mapping))) {
    return err('id_column_missing', {
      dayModeAvailable,
      system,
      processor,
      field: 'mapping.columns.id',
      mappingSource,
      headers: table.headers,
      rows: table.records.slice(0, PREVIEW_ROWS).map((r, i) => ({ row: table.rowNumbers[i] ?? i + 2, cells: { ...r } })),
      rowCount: table.records.length,
      guessedMapping: JSON.parse(canonicalMapping(mapping)) as TableMapping,
      candidates: idCandidatesOf(mapping),
      reason: ID_HINT,
    });
  }
  // Re-cut round 2, L2 and L3: a mapping that is NOT the saved one (given, a profile, the guess) and derives ids
  // otherwise than what booked for the source (the saved mapping, else the recipes kept on the booked events)
  // would mint new ids for booked rows. Refused unless the caller confirms it; the saved mapping was confirmed
  // when it was saved.
  if (mappingSource !== 'saved' && input.confirmIdChange !== true) {
    const booked = bookedEventsOf(ctx, system, processor);
    if (booked > 0) {
      const recipes = stored === null ? bookedRecipesOf(ctx, system, processor) : new Set([idRecipeHashOf(stored.mapping)]);
      if (recipes.size > 0 && !recipes.has(idRecipeHashOf(mapping))) {
        return err('event_id_derivation_changed', {
          system,
          processor,
          changed: ['id_recipe'],
          bookedEvents: booked,
          headers: table.headers,
          mapping: JSON.parse(canonicalMapping(mapping)) as TableMapping,
          reason: `${booked} events are booked for this source under another id derivation; this mapping would mint other ids for the same rows. Send confirmIdChange: true to read the table with it anyway`,
        });
      }
    }
  }
  if (input.confirmIdChange !== undefined && typeof input.confirmIdChange !== 'boolean') return err('invalid_input', { field: 'confirmIdChange' });
  const template = readStoredTemplate(ctx, system, processor);
  const conversion = tableToSettlement(ctx, table, mapping, { system, processor }, template?.template ?? null);
  // D206 (F5): a row whose day cannot be read could belong to any day, so no day of the file is known whole.
  if (conversion.dayMode) {
    const unreadable = conversion.refusedRows.filter((r) => r.code === 'unreadable_day').map((r) => r.row);
    if (unreadable.length > 0) {
      return err('unreadable_day', {
        system,
        processor,
        rowNumbers: unreadable.slice(0, 50),
        headers: table.headers,
        rows: table.records.slice(0, PREVIEW_ROWS).map((r, i) => ({ row: table.rowNumbers[i] ?? i + 2, cells: { ...r }, parsed: conversion.parsed.get(table.rowNumbers[i] ?? i + 2) ?? null })),
        rowCount: table.records.length,
        mapping: JSON.parse(canonicalMapping(mapping)) as TableMapping,
        reason: 'the table is read by whole days, and a row whose day cannot be read could belong to any day: fix the date format or the row, and read it again',
      });
    }
  }
  const dayRules = applyDayRules(ctx, { system, processor }, table, conversion, confirmedEdges);
  const booked = bookedOf(ctx, system, processor, conversion.eventRows, conversion.document['events'] as Record<string, unknown>[]);
  // D206: in the whole-day mode the verdict is per day: every row of a day already in the books is the same as booked.
  const sameAsBooked = [...booked.same, ...dayRules.sameDayRows].sort((a, b) => a.row - b.row);
  const sameIdOtherFigures = booked.other;
  // CRITIC M1: a source that also has a D198 feed has a second id space: the feed's ids and the table's never match.
  const feedSaved =
    ctx.store.db.prepare('SELECT 1 AS x FROM settlement_source WHERE workspace_id = ? AND source_system = ? AND source_processor = ?').get(ctx.workspaceId, system, processor) !== undefined;
  if (feedSaved) {
    (conversion.document['warnings'] as string[]).push(
      'This source also has a settlement feed: the feed and the table derive event ids differently, so the same money arriving through both books twice; use one door per source',
    );
  }
  if (sameAsBooked.length > 0) {
    (conversion.document['warnings'] as string[]).push(
      `${sameAsBooked.length} events are the same as events already booked for this source (rows ${sameAsBooked
        .slice(0, 20)
        .map((s) => s.row)
        .join(', ')}${sameAsBooked.length > 20 ? ', ...' : ''}): they book nothing again`,
    );
  }
  if (sameIdOtherFigures.length > 0) {
    (conversion.document['warnings'] as string[]).push(
      `${sameIdOtherFigures.length} events carry the id of a booked event with other figures (rows ${sameIdOtherFigures
        .slice(0, 20)
        .map((x) => x.row)
        .join(', ')}${sameIdOtherFigures.length > 20 ? ', ...' : ''}): the import refuses them event_amended; correct a booked entry with a reversing entry`,
    );
  }
  return ok<SettlementFromTableOk>({
    system,
    processor,
    container: table.container,
    sheets: table.sheets,
    sheet: table.sheet,
    headers: table.headers,
    rows: table.records.slice(0, PREVIEW_ROWS).map((r, i) => {
      const row = table.rowNumbers[i] ?? i + 2;
      return { row, cells: { ...r }, parsed: conversion.parsed.get(row) ?? null };
    }),
    typeCells: conversion.typeCells,
    idTextAsNumber: conversion.idTextAsNumber,
    rowCount: table.records.length,
    mappingSource,
    mapping: JSON.parse(canonicalMapping(mapping)) as TableMapping,
    profile,
    templateSaved: template !== null,
    sameAsBooked,
    sameIdOtherFigures,
    feedSaved,
    savedMapping: stored !== null,
    savedHeadersDiffer,
    idRecipeDiffers,
    bookedEvents: bookedEventsOf(ctx, system, processor),
    settlement: conversion.document,
    refusedRows: conversion.refusedRows,
    totals: conversion.totals,
    warnings: conversion.warnings,
    dayMode: conversion.dayMode,
    days: dayRules.days,
    edgeDays: dayRules.edgeDays,
  });
}
