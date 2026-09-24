/**
 * The SOURCE ADAPTER REGISTRY seam.
 *
 * // SEAM(G09): G09 owns this registry's full definition (the adapter FUNCTIONS over E00 bytes,
 * // the vendor presets, discovery). G10 lands the minimal shape plus the one generic adapter so
 * // its catalog read (`migration_list_source_adapters`) and the clean-room gate (spec §7: every
 * // registered adapter carries a non-empty `cleanRoomSource`) have a real row to bite on from day
 * // one, instead of a vacuously green test over an empty list.
 *
 * THE CLEAN-ROOM FIELD IS THE POINT OF THE SHAPE (G10 §2 US-G10.6). `cleanRoomSource` is the URL
 * of the PUBLISHED export or interchange documentation an adapter's knowledge was written from,
 * and an adapter without one fails the gate. That is what turns the clean-room posture from a
 * promise in CLAUDE.md into a property of the build. No vendor source code, UI or trade dress is
 * ever read or reproduced, and no vendor API is ever called.
 *
 * The one adapter registered today is the GENERIC one: RFC 4180 CSV, a public IETF standard with
 * no vendor behind it. Vendor presets (the "thirteen presets" the spec's picker budget anticipates)
 * are G09's clean-room work, one row each, each with its published-documentation URL.
 *
 * A `columnPreset` maps a source header (normalized through the locale registry's `normalizeToken`)
 * to a neutral field id; the generic adapter has none, which is exactly the degradation the spec
 * asks for: where no preset matches, the operator maps by hand and nothing blocks.
 */

import { normalizeToken } from '../locale/registry.js';

/** A column preset: a normalized source header and the neutral field it is known to carry. */
export interface AdapterColumnPreset {
  readonly header: string;
  readonly field: string;
}

/** A header signature: the normalised headers that, all present, identify one export of a vendor. */
export interface AdapterHeaderSignature {
  /** The G09 data class this export carries (one signature, one class). */
  readonly dataClass: string;
  /** Every header that must be present, normalised via `normalizeToken`. */
  readonly headers: readonly string[];
}

/** One readable source format. */
export interface SourceAdapterDef {
  /** The stable id used on the wire (`csv`). */
  readonly id: string;
  /** What the source picker shows a human. */
  readonly label: string;
  /** Media types this adapter reads. */
  readonly mediaTypes: readonly string[];
  /** The G09 data classes this adapter can produce rows for. */
  readonly dataClasses: readonly string[];
  /**
   * The URL of the vendor's PUBLISHED export/interchange documentation this adapter was written
   * from. REQUIRED and asserted non-empty by the clean-room gate (spec §7).
   */
  readonly cleanRoomSource: string;
  /** Header presets for the suggestion path. Empty for the generic adapter, by design. */
  readonly columnPresets: readonly AdapterColumnPreset[];
  /**
   * F-09 (2026-09-06, friction ledger J1.4 ideal step 3): the HEADER SIGNATURES that identify one of
   * this vendor's exports from its header line alone. Discovery over a file the plan has not yet
   * pinned to an adapter (the generic path) walks these: when every header of a signature is present
   * (normalised through `normalizeToken`), the file is classified as THIS adapter with the
   * signature's data class alone, so "bexio Saldenliste" is a fact the product states and not a
   * decision the operator takes twice. Every signature header must also be a `columnPresets` header
   * (the fixture rule keeps it clean-room-backed). Absent means the adapter is never inferred.
   */
  readonly headerSignatures?: readonly AdapterHeaderSignature[];
  /**
   * Whether a parser exists for this format (US-G18.5). `false` is the honest "not yet readable" row:
   * the vendor is catalogued with its published-documentation URL, but no fixture-backed parser was
   * authored (no usable public format doc was found), so `parseSource` refuses `not_yet_readable`
   * rather than guessing a parse. Absent means `true` (the default, a readable adapter).
   */
  readonly readable?: boolean;
}

/** The registry. Append-only; a vendor preset is one row plus its published-documentation URL. */
export const SOURCE_ADAPTERS: readonly SourceAdapterDef[] = [
  {
    id: 'csv',
    label: 'CSV (generisch)',
    mediaTypes: ['text/csv'],
    // The generic adapter reads ANY tabular export, so it can produce every first-scope class the
    // harness commits. `gl_history` is G13's archive discovery (this row read `journal` until
    // 03.08.2026, a name the DATA_CLASSES enum never carried; corrected when G13 bound the seam so
    // a csv source file's stored data_classes can actually match the class the step imports).
    dataClasses: [
      'opening_balances',
      'gl_history',
      'contacts',
      'items',
      'chart_of_accounts',
      'tax_codes',
      'payment_terms',
      'bank_accounts',
      // G18 R5: a VAT-history export (one row per filed Steuerperiode label) is a plain tabular file
      // the generic adapter reads. `documents` (opaque blobs) and `bank_statements` (camt XML) are
      // NOT generic-CSV classes: they enter through their own adapters (US-G18.2/3), so they are not
      // listed here even though their commit arms are wired.
      'vat_history',
    ],
    // A public IETF standard, not vendor documentation: the one adapter with no vendor at all.
    cleanRoomSource: 'https://www.rfc-editor.org/rfc/rfc4180',
    columnPresets: [],
  },
  {
    // G18 US-G18.1: the bexio adapter. bexio's exports are ordinary delimited files, so the parse arm
    // is the generic CSV reader (parseSource routes `bexio_csv` -> parseGenericCsv); what the bexio
    // adapter adds over the generic one is the COLUMN PRESETS below, the header knowledge for the
    // column map (US-G10.1 suggestMap consults `adapter_preset` first).
    //
    // THE FIXTURE RULE (spec §2 US-G18.1): every preset entry traces to a real bexio export header held
    // as an ANONYMISED fixture in `./fixtures/index.ts` (the g18-adapters "unbacked preset never ships"
    // test walks it). The headers are the clean-room-safe part (the documented export layout, observed
    // from a real bexio account and help.bexio.com); the fixture VALUES are invented. The presets cover
    // the two column-map shapes a bexio export carries as neutral ledger columns:
    //   - opening_balances (the Saldenliste: Kontonummer -> account, Saldo -> balance);
    //   - gl_history (the Buchungen/Journal: Datum/Referenz/Soll/Haben/Beschreibung/Betrag/
    //     Buchungswährung/MWST -> date/reference/debit/credit/description/amount/currency/taxCode).
    // Headers with no neutral field (the bexio booking Id, the FX-detail trio) stay unmapped, which is
    // correct. Contacts and chart_of_accounts do NOT use column presets (their commit adapters read the
    // named columns directly, and the KMU numbers are identity-mappable onto TILL's seeded chart); the
    // bexio-code -> TILL tax-code MAPPING is separate content (a `tax` map), authored for live posting,
    // not a column preset. Headers are stored normalised via `normalizeToken`, exactly as suggestMap
    // looks them up.
    id: 'bexio_csv',
    label: 'bexio (CSV)',
    mediaTypes: ['text/csv'],
    dataClasses: ['contacts', 'chart_of_accounts', 'items', 'tax_codes', 'payment_terms', 'bank_accounts', 'opening_balances', 'gl_history'],
    // bexio's PUBLISHED import/export documentation (the sanctioned clean-room channel: functional
    // observation of the owner's own account plus help.bexio.com; no vendor code, UI or API).
    cleanRoomSource: 'https://help.bexio.com/s/article/000001598?language=de',
    columnPresets: [
      // opening_balances: the Saldenliste. `Name` carries no neutral field and stays unmapped.
      { header: normalizeToken('Kontonummer'), field: 'account' },
      { header: normalizeToken('Saldo'), field: 'balance' },
      // gl_history: the Buchungen/Journal. Soll/Haben are the debit/credit accounts (bexio's own
      // spelling of the same debit/credit the CH locale pack already knows); Betrag is the value.
      { header: normalizeToken('Datum'), field: 'date' },
      { header: normalizeToken('Referenz'), field: 'reference' },
      { header: normalizeToken('Soll'), field: 'debit' },
      { header: normalizeToken('Haben'), field: 'credit' },
      { header: normalizeToken('Beschreibung'), field: 'description' },
      { header: normalizeToken('Betrag'), field: 'amount' },
      { header: normalizeToken('Buchungswährung'), field: 'currency' },
      { header: normalizeToken('MWST'), field: 'taxCode' },
    ],
    // F-09: the two exports discovery recognises from the header line alone. The Saldenliste is
    // Kontonummer + Saldo (the two neutral columns the opening position needs; `Bezeichnung`/`Name`
    // carries no neutral field and is not part of the signature); the Buchungen/Journal is
    // Datum + Soll + Haben + Betrag. A file matching neither degrades to the generic path (US-G18.1
    // Empty), exactly as before.
    headerSignatures: [
      { dataClass: 'opening_balances', headers: [normalizeToken('Kontonummer'), normalizeToken('Saldo')] },
      { dataClass: 'gl_history', headers: [normalizeToken('Datum'), normalizeToken('Soll'), normalizeToken('Haben'), normalizeToken('Betrag')] },
    ],
  },
  {
    // G18 US-G18.2: the xlsx adapter. An `.xlsx` is an Open Packaging Convention zip of XML parts, read
    // by the pure `parseXlsx` arm (parseSource routes `xlsx` -> parseXlsx): the first worksheet by
    // default, the others reported by name for a per-file worksheet choice. The clean-room source is
    // the PUBLISHED ECMA-376 Office Open XML standard, a public specification with no vendor behind it.
    id: 'xlsx',
    label: 'Excel-Arbeitsmappe (.xlsx)',
    mediaTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    dataClasses: [
      'opening_balances',
      'gl_history',
      'contacts',
      'items',
      'chart_of_accounts',
      'tax_codes',
      'payment_terms',
      'bank_accounts',
      'vat_history',
    ],
    cleanRoomSource: 'https://ecma-international.org/publications-and-standards/standards/ecma-376/',
    columnPresets: [],
  },
  {
    // G18 US-G18.5: Abacus AbaConnect. The published interface is XML; the pure `parseAbaConnect` arm
    // reads it with the SAME regex technique A20's camt parser uses (never a second XML stack). The
    // envelope carries an interface Version but no generation date, so `asAt` stays null.
    id: 'abacus_abaconnect',
    label: 'Abacus (AbaConnect XML)',
    mediaTypes: ['application/xml', 'text/xml'],
    dataClasses: ['contacts', 'chart_of_accounts', 'items', 'gl_history'],
    cleanRoomSource: 'https://downloads.abacus.ch/en/downloads/abaconnect/documentation',
    columnPresets: [],
  },
  {
    // G18 US-G18.5: Banana Accounting. Its documented text export is TAB-separated with case-sensitive
    // English headers (Date, Description, AccountDebit, AccountCredit, Amount, ...); the generic reader
    // detects the tab delimiter from the header line, so no separate parse arm is needed.
    id: 'banana_tsv',
    label: 'Banana (Text/TSV)',
    mediaTypes: ['text/tab-separated-values', 'text/csv', 'text/plain'],
    dataClasses: ['gl_history', 'chart_of_accounts', 'contacts', 'opening_balances'],
    cleanRoomSource: 'https://www.banana.ch/doc/en/node/9947',
    columnPresets: [],
  },
  {
    // G18 US-G18.5: Crésus Comptabilité. Its documented text export is TAB-separated (CR+LF lines), Swiss
    // number style (apostrophe thousands) in the cell values, which the mapping/locale layer handles, not
    // the parser. The generic reader detects the tab delimiter; no separate parse arm.
    id: 'cresus_csv',
    label: 'Crésus (Text/TSV)',
    mediaTypes: ['text/csv', 'text/tab-separated-values', 'text/plain'],
    dataClasses: ['gl_history', 'chart_of_accounts', 'contacts', 'opening_balances'],
    cleanRoomSource: 'https://support.cresus.ch/manuels/cresus-comptabilite/exporter-des-donnees-233/',
    columnPresets: [],
  },
  {
    // G18 US-G18.5, HONEST "not yet readable": the Sage Schweiz CSV-Format documentation exists but was
    // not fetchable during the build (the vendor help server returned 522), so no fixture-backed parser
    // was authored. The row is catalogued with the vendor's own published documentation URL; parseSource
    // refuses `not_yet_readable` rather than guessing a parse from a partial third-party description.
    id: 'sage50_ch',
    label: 'Sage 50 (Schweiz) - noch nicht lesbar',
    mediaTypes: ['text/csv'],
    dataClasses: [],
    cleanRoomSource: 'https://onlinehelp.sageschweiz.ch/default.aspx?tabid=19983',
    columnPresets: [],
    readable: false,
  },
  {
    // G18 US-G18.5, HONEST "not yet readable": KLARA's data-export help articles are published but return
    // 403 to any automated fetch, and its transaction import is oriented around camt.053 rather than a
    // documented columnar CSV. No usable column layout was obtainable, so no parser is authored.
    id: 'klara_csv',
    label: 'KLARA - noch nicht lesbar',
    mediaTypes: ['text/csv'],
    dataClasses: [],
    cleanRoomSource: 'https://support.klara.ch/hc/de/articles/360005033340',
    columnPresets: [],
    readable: false,
  },
  {
    // G18 US-G18.5, the SPEC'S NAMED "not yet readable" row (W3, Topal boundary): no usable public export
    // column/field layout exists (the published Topal docs are API/REST oriented, and CSV import consumes
    // a folder hierarchy with no documented header set). Catalogued with its published import help URL;
    // no parser until a real export or a documented format exists.
    id: 'topal',
    label: 'Topal - noch nicht lesbar',
    mediaTypes: ['text/csv', 'application/xml'],
    dataClasses: [],
    cleanRoomSource: 'https://info.topal.ch/content/help/Topal_Online_Help/default/de/import.htm',
    columnPresets: [],
    readable: false,
  },
];

/** The adapter ids that are registered honestly but carry NO parser (US-G18.5 "not yet readable"). */
export const NOT_YET_READABLE_ADAPTERS: ReadonlySet<string> = new Set(
  SOURCE_ADAPTERS.filter((a) => a.readable === false).map((a) => a.id),
);

const BY_ID: ReadonlyMap<string, SourceAdapterDef> = new Map(SOURCE_ADAPTERS.map((a) => [a.id, a]));

/** The registry row for an adapter id, or undefined when it is not registered. */
export function sourceAdapterDef(id: unknown): SourceAdapterDef | undefined {
  return typeof id === 'string' ? BY_ID.get(id) : undefined;
}

/** Every registered adapter id, for a validation message that names them. */
export const SOURCE_ADAPTER_IDS: readonly string[] = SOURCE_ADAPTERS.map((a) => a.id);

/**
 * F-09: which vendor export does this header line belong to? Walks every adapter's `headerSignatures`
 * (in registry order) and answers the first signature whose headers are ALL present, with the one
 * data class that export carries. Headers are compared normalised, the way `suggestMap` compares
 * them, so "Kontonummer;Bezeichnung;Saldo" and " kontonummer , SALDO " read the same. `null` when
 * no signature matches: the generic path, unchanged.
 */
export function detectAdapterFromHeaders(headers: readonly string[]): { adapter: string; dataClass: string } | null {
  const present = new Set(headers.map((h) => normalizeToken(h)));
  for (const adapter of SOURCE_ADAPTERS) {
    for (const signature of adapter.headerSignatures ?? []) {
      if (signature.headers.length > 0 && signature.headers.every((h) => present.has(h))) {
        return { adapter: adapter.id, dataClass: signature.dataClass };
      }
    }
  }
  return null;
}
