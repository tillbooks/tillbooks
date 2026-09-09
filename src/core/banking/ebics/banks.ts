/**
 * A36, the EBICS bank directory (US-A36.4): a STATIC, in-package data module that helps the connect
 * wizard recognise a Swiss bank and prefill what is publicly, stably known about its EBICS channel.
 *
 * NEVER FETCHED AT RUNTIME (the E05 catalog stance, spec §4). This module opens no socket, imports no
 * HTTP client, and holds only data compiled into the package: `npm update` is the entire update
 * mechanism. `test/banking/ebics-directory.test.mjs` asserts the module graph has no network import.
 *
 * WHAT IS AND IS NOT SHIPPED. The stable, public facts are shipped: the bank's names, its BIC (the
 * match key), the marketing name of its EBICS channel, which customer SEGMENTS are offered EBICS as
 * publicly stated, where the signed INI letter is posted, and known protocol quirks. The per-CONTRACT
 * technicals (`hostUrl`, `hostId`) are deliberately `null` in v1: a Swiss bank issues those to the
 * customer on the signed EBICS contract, they are not reliably public, and a fabricated host URL is a
 * wrong prefill that wastes the user's afternoon. They are filled by CONTRIBUTION as each is publicly
 * confirmed, never guessed here. Every fee note is `verified:false` structurally (§4): the GUI renders
 * the unverified badge always, and whether a given bank offers EBICS to a given segment is always
 * "ask your bank". No figure in this file is presented as cleared.
 *
 * THE DIRECTORY IS NEVER A GATE (US-A36.4). An empty match is an empty result, not an error: the
 * wizard falls back to the manual host-data fields (A33's unchanged behaviour). The module is a
 * convenience layer over a ceremony that works without it.
 */

/** A fee note: always structurally unverified in v1 so the GUI can render the badge unconditionally. */
export interface BankFeeNote {
  readonly text: string;
  readonly verified: false;
  readonly asOf: string;
}

export interface BankDirectoryQuirks {
  /** Whether the bank supports a `dateRange` re-fetch (SMPG §4.2.5: "not supported by all"). null = unknown. */
  readonly dateRangeSupported: boolean | null;
  /** Free-text BTF/order-type notes (e.g. which camt variants the bank offers). */
  readonly btfNotes: string | null;
  /** The EBICS protocol versions the bank offers, for reader orientation (v1 speaks 3.0/BTF only). */
  readonly protocolVersions: readonly string[];
}

export interface BankDirectoryEntry {
  /** The bank's BIC (public, stable): the primary match key. */
  readonly bic: string;
  /** Names and common short forms the wizard search matches against. */
  readonly names: readonly string[];
  /** The per-contract EBICS host URL, or null (issued by the bank on the signed contract). */
  readonly hostUrl: string | null;
  /** The per-contract EBICS Host ID, or null (issued by the bank on the signed contract). */
  readonly hostId: string | null;
  /** The marketing name of the bank's EBICS channel + the honest "contract required" note. */
  readonly ebicsNote: string;
  /** The customer segments EBICS is publicly offered to. */
  readonly segments: readonly string[];
  /** Where the signed INI letter is posted (public where known, else a generic instruction). */
  readonly iniLetterAddress: string;
  readonly quirks: BankDirectoryQuirks;
  readonly feeNote: BankFeeNote;
}

const ASOF = '2026-08-18';
const CONTRACT_INI = 'Post the signed INI letter to the EBICS/cash-management address named on your EBICS contract.';

/**
 * The v1 curated set (build-time election Q1: curated-then-contributed). Public, stable facts only.
 * BICs are the 8- or 11-character public identifiers. `hostUrl`/`hostId` stay null until a public
 * source confirms each; the wizard prefills the rest and falls back to manual host fields.
 */
export const BANK_DIRECTORY: readonly BankDirectoryEntry[] = [
  {
    bic: 'UBSWCHZH80A',
    names: ['UBS', 'UBS Switzerland AG', 'UBS Schweiz'],
    hostUrl: null,
    hostId: null,
    ebicsNote: 'UBS offers EBICS 3.0 to business customers (marketed as UBS KeyPort). An EBICS contract is required.',
    segments: ['business'],
    iniLetterAddress: CONTRACT_INI,
    quirks: { dateRangeSupported: null, btfNotes: 'camt.053/054 statements, pain.001 upload over BTF.', protocolVersions: ['3.0'] },
    feeNote: { text: 'Fees per the UBS cash-management pricing; confirm with your relationship manager.', verified: false, asOf: ASOF },
  },
  {
    bic: 'POFICHBEXXX',
    names: ['PostFinance', 'PostFinance AG', 'Postfinance'],
    hostUrl: null,
    hostId: null,
    ebicsNote: 'PostFinance offers EBICS to business customers. An EBICS contract (Teilnehmervertrag) is required.',
    segments: ['business'],
    iniLetterAddress: CONTRACT_INI,
    quirks: { dateRangeSupported: null, btfNotes: 'camt.053/054, pain.001; also historically Z53/Z54 under 2.5.', protocolVersions: ['3.0', '2.5'] },
    feeNote: { text: 'Monthly EBICS participant fee at some segments; confirm current pricing with PostFinance.', verified: false, asOf: ASOF },
  },
  {
    bic: 'ZKBKCHZZ80A',
    names: ['ZKB', 'Zürcher Kantonalbank', 'Zuercher Kantonalbank'],
    hostUrl: null,
    hostId: null,
    ebicsNote: 'ZKB offers EBICS to business customers (marketed as ZKB Datalink). An EBICS contract is required.',
    segments: ['business'],
    iniLetterAddress: CONTRACT_INI,
    quirks: { dateRangeSupported: null, btfNotes: 'camt.053/054, pain.001 over BTF.', protocolVersions: ['3.0'] },
    feeNote: { text: 'Confirm EBICS pricing with ZKB Firmenkunden.', verified: false, asOf: ASOF },
  },
  {
    bic: 'RAIFCH22XXX',
    names: ['Raiffeisen', 'Raiffeisenbank', 'Raiffeisen Schweiz'],
    hostUrl: null,
    hostId: null,
    ebicsNote: 'Raiffeisen offers EBICS to business customers (marketed as e-connect). An EBICS contract is required.',
    segments: ['business'],
    iniLetterAddress: 'Post the signed INI letter to your local Raiffeisenbank as named on your EBICS contract.',
    quirks: { dateRangeSupported: null, btfNotes: 'camt.053/054, pain.001 over BTF.', protocolVersions: ['3.0'] },
    feeNote: { text: 'Confirm EBICS pricing with your local Raiffeisenbank.', verified: false, asOf: ASOF },
  },
  {
    bic: 'MIGRCHZZXXX',
    names: ['Migros Bank', 'Migrosbank'],
    hostUrl: null,
    hostId: null,
    ebicsNote: 'Migros Bank offers EBICS to business customers. An EBICS contract is required.',
    segments: ['business'],
    iniLetterAddress: CONTRACT_INI,
    quirks: { dateRangeSupported: null, btfNotes: null, protocolVersions: ['3.0'] },
    feeNote: { text: 'Confirm EBICS pricing with Migros Bank Firmenkunden.', verified: false, asOf: ASOF },
  },
  {
    bic: 'BCVLCH2LXXX',
    names: ['BCV', 'Banque Cantonale Vaudoise'],
    hostUrl: null,
    hostId: null,
    ebicsNote: 'BCV offers EBICS to business customers. An EBICS contract is required.',
    segments: ['business'],
    iniLetterAddress: CONTRACT_INI,
    quirks: { dateRangeSupported: null, btfNotes: null, protocolVersions: ['3.0'] },
    feeNote: { text: 'Confirm EBICS pricing with BCV.', verified: false, asOf: ASOF },
  },
  {
    bic: 'BCGECHGGXXX',
    names: ['BCGE', 'Banque Cantonale de Genève'],
    hostUrl: null,
    hostId: null,
    ebicsNote: 'BCGE offers EBICS to business customers. An EBICS contract is required.',
    segments: ['business'],
    iniLetterAddress: CONTRACT_INI,
    quirks: { dateRangeSupported: null, btfNotes: null, protocolVersions: ['3.0'] },
    feeNote: { text: 'Confirm EBICS pricing with BCGE.', verified: false, asOf: ASOF },
  },
  {
    bic: 'BCFRCH2LXXX',
    names: ['BCF', 'Banque Cantonale de Fribourg', 'Freiburger Kantonalbank'],
    hostUrl: null,
    hostId: null,
    ebicsNote: 'BCF offers EBICS to business customers. An EBICS contract is required.',
    segments: ['business'],
    iniLetterAddress: CONTRACT_INI,
    quirks: { dateRangeSupported: null, btfNotes: null, protocolVersions: ['3.0'] },
    feeNote: { text: 'Some cantonal banks offer EBICS at no setup fee; confirm current pricing with BCF.', verified: false, asOf: ASOF },
  },
  {
    bic: 'KBTGCH22XXX',
    names: ['TKB', 'Thurgauer Kantonalbank'],
    hostUrl: null,
    hostId: null,
    ebicsNote: 'TKB offers EBICS to business customers. An EBICS contract is required.',
    segments: ['business'],
    iniLetterAddress: CONTRACT_INI,
    quirks: { dateRangeSupported: null, btfNotes: null, protocolVersions: ['3.0'] },
    feeNote: { text: 'Confirm EBICS pricing with TKB.', verified: false, asOf: ASOF },
  },
  {
    bic: 'VABECH22XXX',
    names: ['Valiant', 'Valiant Bank'],
    hostUrl: null,
    hostId: null,
    ebicsNote: 'Valiant offers EBICS to business customers. An EBICS contract is required.',
    segments: ['business'],
    iniLetterAddress: CONTRACT_INI,
    quirks: { dateRangeSupported: null, btfNotes: null, protocolVersions: ['3.0'] },
    feeNote: { text: 'Confirm EBICS pricing with Valiant.', verified: false, asOf: ASOF },
  },
];

import type { WorkspaceContext } from '../../context.js';
import { ok, err } from '../../result.js';
import type { Result } from '../../result.js';

/**
 * The `bank_channel_directory` read verb (P5): a pure lookup over the static directory. It takes a
 * `workspace_id` by the P4 convention but reads no tenant data and opens no socket (readOnlyHint on
 * MCP). An empty result is an empty array, never an error. `query` may be empty (the wizard's initial
 * list). Nothing here is a gate on the ceremony.
 */
export function lookupBankDirectory(_ctx: WorkspaceContext, input: { query?: unknown }): Result {
  if (input.query !== undefined && typeof input.query !== 'string') {
    return err('invalid_input', { field: 'query' });
  }
  const banks = lookupBankDirectoryData(typeof input.query === 'string' ? input.query : '');
  return ok({ banks });
}

/** Fold diacritics and lowercase, so "Zurcher" matches "Zürcher" and "geneve" matches "Genève". */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Substring / BIC match over the static directory. Pure, offline, allocation-only. An empty or
 * whitespace query returns the whole set (the wizard's initial list); a no-hit query returns `[]` (an
 * empty state, never an error, US-A36.4).
 */
export function lookupBankDirectoryData(query: string): BankDirectoryEntry[] {
  const q = fold(query);
  if (q.length === 0) return [...BANK_DIRECTORY];
  return BANK_DIRECTORY.filter(
    (b) => fold(b.bic).includes(q) || b.names.some((n) => fold(n).includes(q)),
  );
}
