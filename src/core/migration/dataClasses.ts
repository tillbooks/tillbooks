/**
 * G09, the DATA-CLASS REGISTRY: the heart of Pattern P3 in the migration family.
 *
 * Sixteen classes, each a row declaring its owner spec, the verb its commit routes to, whether it is
 * money-path, its MATCH KEY (US-G09.9), and whether it is in first scope. G09 ORCHESTRATES; the
 * owning verb WRITES. This is the one thing that keeps an imported row subject to exactly the same
 * validation, VAT resolution and audit stamping as a hand-entered one: a second writer would be P3's
 * second posting path in disguise (spec §6b Fixed).
 *
 * THE MONEY-PATH RULE, STATED ONCE. A `moneyPath` class NEVER replays each historical document as a
 * journal posting. Its whole ledger effect arrives through A04's SINGLE opening-balance entry
 * (`opening_balances`), or through a migrated A10 document that itself posts nothing (`open_items_*`,
 * D86 §2). `commitStep` enforces this by construction: the only posting path it can reach is the
 * owning verb named here, and none of them is `postEntry` directly.
 *
 * `commitVerb` is the ENGINE function name the step routes to, resolved in `steps.ts`. A class whose
 * owning verb is not built in this wave carries `commitBuilt:false`, and `commitStep` returns a
 * structured `class_commit_unavailable` naming the owning spec rather than inventing a writer
 * (US-G09.2 boundary: "a class whose commit belongs to another spec routes there and says so").
 */

/** The sixteen data classes. §H-ENUM: this array is the single source, guarded by a case-plus-test. */
export const DATA_CLASSES = [
  'contacts',
  'items',
  'chart_of_accounts',
  'tax_codes',
  'payment_terms',
  'bank_accounts',
  'opening_balances',
  'open_items_ar',
  'open_items_ap',
  'bank_statements',
  'documents',
  'vat_history',
  'gl_history',
  'fixed_assets',
  'inventory',
  'payroll',
] as const;

export type DataClass = (typeof DATA_CLASSES)[number];

const DATA_CLASS_SET: ReadonlySet<string> = new Set(DATA_CLASSES);

export function isDataClass(value: unknown): value is DataClass {
  return typeof value === 'string' && DATA_CLASS_SET.has(value);
}

/** One row of the registry: everything the harness needs to route a class without a second writer. */
export interface DataClassDef {
  readonly dataClass: DataClass;
  /** The spec that owns the target records, named in `unavailable[]` when the class is out of scope. */
  readonly owner: string;
  /**
   * The ENGINE verb `commitStep` routes an included, checked step through. `null` when the class is a
   * pure archive (`gl_history`, handled by G13's seam) or a later-wave seam whose verb does not exist.
   */
  readonly commitVerb: string | null;
  /** True when `commitVerb` names a verb that is BUILT today. A false here yields class_commit_unavailable. */
  readonly commitBuilt: boolean;
  /** US-G09.9: the fields that decide `willSkip` (exact match) vs `willConflict` (match, differing). */
  readonly matchKey: readonly string[];
  /** True when a commit posts to the ledger, and therefore needs a bound approval (US-G09.4). */
  readonly moneyPath: boolean;
  /** True when the class is imported in the first phase; false classes render collapsed / unavailable. */
  readonly firstScope: boolean;
}

/**
 * The registry (spec §4 table, verbatim). Order is the scope step's group order: Stammdaten, Bank,
 * Eröffnungsposition, Offene Posten, Historie und Belege, then the later-wave seams.
 */
export const DATA_CLASS_REGISTRY: readonly DataClassDef[] = [
  // --- Stammdaten (master data): non-money CRUD, committed on manage_import alone -----------------
  { dataClass: 'contacts', owner: 'C00/A09', commitVerb: 'contacts_import', commitBuilt: true, matchKey: ['uid', 'name+postcode'], moneyPath: false, firstScope: true },
  // The CRUD classes below route PER ROW through their BUILT owning verb (`crudCommit.ts`): G10's
  // applied column map translates arbitrary source headers first, a locale-aware alias table covers
  // the unmapped plain-CSV case, and the class's match key decides create / skip / conflict, which
  // is what makes a re-import create ZERO extra rows (US-G09.9, §H-IDEMPOTENT on rows).
  { dataClass: 'items', owner: 'D00/A09', commitVerb: 'create_item', commitBuilt: true, matchKey: ['sku', 'name'], moneyPath: false, firstScope: true },
  { dataClass: 'chart_of_accounts', owner: 'A01', commitVerb: 'create_account', commitBuilt: true, matchKey: ['number'], moneyPath: false, firstScope: true },
  { dataClass: 'tax_codes', owner: 'A05', commitVerb: 'vat_code_upsert', commitBuilt: true, matchKey: ['code'], moneyPath: false, firstScope: true },
  { dataClass: 'payment_terms', owner: 'A09', commitVerb: 'update_contact', commitBuilt: true, matchKey: ['contact+days'], moneyPath: false, firstScope: true },
  // --- Bank ---------------------------------------------------------------------------------------
  { dataClass: 'bank_accounts', owner: 'A19', commitVerb: 'create_bank_account', commitBuilt: true, matchKey: ['iban'], moneyPath: false, firstScope: true },
  // --- Eröffnungsposition (opening position): the money path's single entry ----------------------
  { dataClass: 'opening_balances', owner: 'A04', commitVerb: 'set_opening_balances', commitBuilt: true, matchKey: ['account'], moneyPath: true, firstScope: true },
  // --- Offene Posten (open items): the migrated A10 document that posts NOTHING (D86 §2) ----------
  // The migrated-document shape is owned by A10 (`origin='migrated'`), extended in A10's own commit,
  // not here. Until that lands the commit is unavailable and says so rather than inventing a writer.
  { dataClass: 'open_items_ar', owner: 'A10/A16', commitVerb: null, commitBuilt: false, matchKey: ['document_number'], moneyPath: true, firstScope: true },
  { dataClass: 'open_items_ap', owner: 'A17', commitVerb: null, commitBuilt: false, matchKey: ['vendor+vendor_reference'], moneyPath: true, firstScope: true },
  // --- Historie und Belege (history and vouchers) --------------------------------------------------
  // `firstScope` flipped true by G18 R5 in the same commit that wired their commitRoute arms: the
  // PHASE4 runbook (A3/B5) scopes and commits all three, and `setScope` creates a step only for a
  // first-scope class, so a class whose importer is BUILT and WIRED but unreachable would make the
  // scope surface name it unavailable while the registry said otherwise (the G13 §0 correction 6
  // shape). bank_statements delegates to A20 import_camt (posts no journal), documents to E00
  // files_link, vat_history to A07 vat_mark_filed (which posts nothing, P3 by absence).
  { dataClass: 'bank_statements', owner: 'A20', commitVerb: 'import_camt', commitBuilt: true, matchKey: ['entry_identity'], moneyPath: true, firstScope: true },
  { dataClass: 'documents', owner: 'E00', commitVerb: 'files_link', commitBuilt: true, matchKey: ['sha256'], moneyPath: false, firstScope: true },
  { dataClass: 'vat_history', owner: 'A07', commitVerb: 'vat_mark_filed', commitBuilt: true, matchKey: ['period'], moneyPath: true, firstScope: true },
  // gl_history routes to G13's archive (BOUND 03.08.2026), never to the live ledger: `archive`, not
  // post. `firstScope` flipped true in the same commit that bound the seam: `setScope` creates a step
  // only for first-scope classes, and a class whose importer is BUILT but unreachable would make the
  // scope surface name G13 as unavailable while the registry said otherwise (G13 spec §0 correction 6).
  { dataClass: 'gl_history', owner: 'G13', commitVerb: 'gl_archive_import', commitBuilt: true, matchKey: ['source_entry_id'], moneyPath: false, firstScope: true },
  // --- Later-wave seams: declared so the scope step names them in unavailable[] with their owner ---
  { dataClass: 'fixed_assets', owner: 'H01/H02', commitVerb: null, commitBuilt: false, matchKey: ['asset_number'], moneyPath: true, firstScope: false },
  { dataClass: 'inventory', owner: 'J02', commitVerb: null, commitBuilt: false, matchKey: ['item+location+lot'], moneyPath: true, firstScope: false },
  { dataClass: 'payroll', owner: 'A34', commitVerb: 'wage_journal_post', commitBuilt: false, matchKey: ['period'], moneyPath: true, firstScope: false },
];

const BY_CLASS: ReadonlyMap<string, DataClassDef> = new Map(DATA_CLASS_REGISTRY.map((d) => [d.dataClass, d]));

/** The registry row for a class, or undefined when it is not a known class. */
export function dataClassDef(dataClass: unknown): DataClassDef | undefined {
  return typeof dataClass === 'string' ? BY_CLASS.get(dataClass) : undefined;
}

/** Every class id, for the scope step's picker and for a validation message that names the real set. */
export const DATA_CLASS_IDS: readonly string[] = DATA_CLASSES.map((d) => d);
