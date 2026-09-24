/**
 * F01 §H-ENUM: the `REPORT_SOURCES` registry, the single set of read models F01 can compose into a
 * report (spec §7). One entry per source: its id, its title, the entity kind its rows belong to (so a
 * `cf:` custom-field column can attach, OP7), whether it is a Swiss accounting record (OR 958f, §3),
 * the A24 read capabilities the caller must hold, its published base columns, and a pure `compute`
 * that calls the EXISTING engine read model and returns its rows (P5, recomputed every call).
 *
 * F01 OWNS NEITHER THE MATH NOR THE RBAC OF A SOURCE. `compute` calls the same read function the
 * source module already ships, so a report figure equals that module's own answer for the same filter
 * or it is a bug (the anti-drift contract, asserted by the export-fidelity test). And because F01
 * calls the engine function directly rather than through the registry boundary, the source's own RBAC
 * would be bypassed: so every verb that computes a source (`reports_preview`, `reports_run`) asserts
 * the source's `readCapabilities` via `ctx.capabilities` FIRST, the dashboards (F00) posture exactly,
 * so a report is never a privilege-escalation path around A24 (spec §5).
 *
 * Adding a source is one entry here (OP9: a plugin manifest may register its own the same way, and
 * F01 treats it identically once its permissions are granted). Nothing else in F01 changes.
 */

import type { WorkspaceContext } from '../context.js';
import type { Result } from '../result.js';
import type { Capability } from '../access/capabilities.js';
import type { ColumnType } from './enums.js';
import { listContacts } from '../sales/contact.js';
import { listItems } from '../sales/item.js';
import { listOpenItems } from '../debtors/openItems.js';
import { listVendorBills } from '../purchase/reads.js';
import { listDraftRuns } from '../drafting/index.js';

export interface ReportField {
  /** The stable column key. Matches a property on the mapped row object `compute` returns. */
  readonly key: string;
  readonly labelI18n: { readonly 'de-CH': string; readonly en: string };
  readonly type: ColumnType;
}

export interface ReportSourceDef {
  readonly id: string;
  readonly titleI18n: { readonly 'de-CH': string; readonly en: string };
  /** The OP3 entity kind a row belongs to, so `cf:` custom-field columns can attach. Undefined for an
   * aggregated source (e.g. an open-items list) whose rows are not single records. */
  readonly entityKind?: string;
  /** OR 958f (§3): whether an export of this source is a Swiss accounting record, so a retained run is
   * linked into E00. A registry-level legal determination, never a per-report toggle (§6b Fixed). */
  readonly accountingRecord: boolean;
  /** The owning module id, for the honest `needs_source_module` degradation code (P9). */
  readonly module: string;
  /** The A24 read gates the SOURCE's own read verb carries, asserted here so a report cannot read past
   * the caller's own RBAC (spec §5). ALL of them are required. */
  readonly readCapabilities: readonly Capability[];
  /** The published base columns. `reports.sources` unions these with the source's `cf:` columns. */
  readonly fields: readonly ReportField[];
  /** Whether the source's module is configured/available in THIS workspace (P9). Always-present
   * modules answer true; an optional module (e.g. inventory) answers false when it is off. */
  available(ctx: WorkspaceContext): boolean;
  /** Compute the source read model and return its rows as flat objects keyed by field key. The engine
   * read may fail (a real error); this returns the read's Result and the array key to unwrap. */
  compute(ctx: WorkspaceContext): { result: Result; rowsKey: string };
}

function t(de: string, en: string): { 'de-CH': string; en: string } {
  return { 'de-CH': de, en };
}

function field(key: string, de: string, en: string, type: ColumnType): ReportField {
  return { key, labelI18n: t(de, en), type };
}

export const REPORT_SOURCES: readonly ReportSourceDef[] = [
  {
    id: 'contacts',
    titleI18n: t('Kontakte', 'Contacts'),
    entityKind: 'contact',
    accountingRecord: false,
    module: 'C00',
    readCapabilities: ['read_master_data'],
    fields: [
      field('name', 'Name', 'Name', 'text'),
      field('email', 'E-Mail', 'Email', 'text'),
      field('vatNumber', 'MWST-Nummer', 'VAT number', 'text'),
      field('partyRole', 'Rolle', 'Role', 'select'),
      field('kind', 'Art', 'Kind', 'select'),
      field('defaultCurrency', 'Währung', 'Currency', 'text'),
      field('paymentTermsDays', 'Zahlungsfrist (Tage)', 'Payment terms (days)', 'number'),
    ],
    available: () => true,
    compute: (ctx) => ({ result: listContacts(ctx, {}), rowsKey: 'contacts' }),
  },
  {
    id: 'items',
    titleI18n: t('Artikel', 'Items'),
    entityKind: 'item',
    accountingRecord: false,
    module: 'D00',
    readCapabilities: ['read_master_data'],
    fields: [
      field('name', 'Name', 'Name', 'text'),
      field('sku', 'Artikelnummer', 'SKU', 'text'),
      field('defaultUnitPriceMinor', 'Preis', 'Price', 'money'),
      field('currency', 'Währung', 'Currency', 'text'),
      field('unit', 'Einheit', 'Unit', 'text'),
    ],
    available: () => true,
    compute: (ctx) => ({ result: listItems(ctx, {}), rowsKey: 'items' }),
  },
  {
    id: 'ar_open_items',
    titleI18n: t('Offene Debitoren', 'Open receivables'),
    // Aggregated over documents and payments: a row is not a single editable record, so no cf columns.
    accountingRecord: true,
    module: 'A16',
    readCapabilities: ['read_sales'],
    fields: [
      field('customerName', 'Kunde', 'Customer', 'text'),
      field('dueDate', 'Fällig am', 'Due date', 'date'),
      field('openMinor', 'Offen', 'Open', 'money'),
      field('currency', 'Währung', 'Currency', 'text'),
    ],
    available: () => true,
    compute: (ctx) => ({ result: listOpenItems(ctx, {}), rowsKey: 'items' }),
  },
  {
    id: 'vendor_bills',
    titleI18n: t('Kreditorenrechnungen', 'Vendor bills'),
    entityKind: 'vendor_bill',
    accountingRecord: true,
    module: 'A17',
    readCapabilities: ['read_books'],
    fields: [
      field('vendorName', 'Lieferant', 'Vendor', 'text'),
      field('vendorReference', 'Referenz', 'Reference', 'text'),
      field('billDate', 'Rechnungsdatum', 'Bill date', 'date'),
      field('grossMinor', 'Brutto', 'Gross', 'money'),
      field('currency', 'Währung', 'Currency', 'text'),
      field('status', 'Status', 'Status', 'select'),
    ],
    available: () => true,
    compute: (ctx) => ({ result: listVendorBills(ctx, {}), rowsKey: 'bills' }),
  },
  {
    id: 'draft_runs',
    titleI18n: t('Entwurfs-Läufe', 'Draft runs'),
    // Aggregated operational metadata (E06 §6b: which drafts existed, whether they were grounded),
    // NEVER the prompt or a body: `draft_run` has no such column, so this source cannot leak one.
    accountingRecord: false,
    module: 'E06',
    // The E06 read domain: a draft run is correspondence metadata (`draft_list` rides `mail.read`),
    // so composing it into a report demands exactly the read the verb itself demands.
    readCapabilities: ['mail.read'],
    fields: [
      field('status', 'Status', 'Status', 'select'),
      field('grounded', 'Buchhaltung einbezogen', 'Accounting data included', 'bool'),
      field('modelRef', 'Modell', 'Model', 'text'),
      field('startedAt', 'Gestartet am', 'Started at', 'date'),
    ],
    available: () => true,
    // Metadata only: the on-demand body reads are skipped, so composing this source never touches
    // the Drafts folder (and `body` is not a published column either way).
    compute: (ctx) => ({ result: listDraftRuns(ctx, { includeBodies: false }), rowsKey: 'runs' }),
  },
];

const BY_ID: ReadonlyMap<string, ReportSourceDef> = new Map(REPORT_SOURCES.map((s) => [s.id, s]));

export function reportSourceDef(id: unknown): ReportSourceDef | undefined {
  return typeof id === 'string' ? BY_ID.get(id) : undefined;
}

export const REPORT_SOURCE_IDS: readonly string[] = REPORT_SOURCES.map((s) => s.id);
