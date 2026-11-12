/**
 * H01, Fixed Assets -> Register (`/assets`): the controlled list of every capitalised fixed asset,
 * created FROM an H00 category so the accounting defaults are inherited and only what is special is
 * overridden.
 *
 * A dense table (number, name, category, status, acquisition, cost, net book value) with a search box
 * and category/status filters, plus a right-hand drawer for create and edit. On create the category
 * picker comes first; selecting one calls `asset_category_resolve_defaults` and the inherited
 * depreciation trio + three GL accounts appear, editable only here (the spec's "overrides allowed at
 * creation"). Cost is entered in major units and converted to Rappen.
 *
 * THE FINANCIAL-FIELD LOCK IS SURFACED, NOT INVENTED HERE: once an asset leaves `draft` (a posted
 * acquisition, H02), its financial inputs render disabled and a note explains why; the engine is the
 * real gate and still answers `financial_fields_locked` for anything that slips through. Status is
 * glyph + label, never colour alone (WCAG 2.2 AA). No new colour token (design-canon).
 *
 * THE PERMISSION GATE HERE IS A CONVENIENCE (the standing Studio rule): `whoami` is the one source,
 * it fails open, and the engine is the real gate. Write controls disable behind `manage_master_data`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { Select } from '../../components/Select';
import { Field } from '../../components/Field';
import { IconButton } from '../../components/IconButton';
import { useWorkspaceId } from '../../app/workspace';
import { formatDate, formatMoney, useT } from '../../i18n';
import { useCalendarFormat } from '../../lib/format';
import { Status, type StatusKind } from '../../components/Status';
import type { OverflowMenuItem } from '../../components/OverflowMenu';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { FilterBar } from '../../components/FilterBar';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { DetailDrawer } from '../../components/DetailDrawer';
import { Modal } from '../../components/Modal';
import { ConsequenceLine } from '../../components/ConsequenceLine';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import './FixedAssets.css';

const DEPRECIATION_METHODS = ['straight_line', 'declining_balance', 'units_of_production', 'none'] as const;
type Method = (typeof DEPRECIATION_METHODS)[number];
const ASSET_STATUSES = ['draft', 'active', 'fully_depreciated', 'disposed', 'archived'] as const;

/** A fresh key per write, so a retry after a transport failure is a retry and not a second write. */
const newKey = () => crypto.randomUUID();

/** The archive confirm is a consequential question: the role travels to the shared Modal as a prop,
 * never as a literal attribute the modal-role guard would read on a component. */
const ALERT_DIALOG = 'alertdialog' as const;
/** The engine verbs the money-path drawers post through. C4 ConsequenceLine resolves its dial sentence
 * from these; they carry NO dialCapability in command-source today, so it renders nothing
 * (NEEDS-ENGINE-DATA), lighting up only when the engine dials the verb, with no UI change here. */
const DISPOSE_VERB = 'asset_dispose';

export interface Asset {
  id: string;
  number: string;
  name: string;
  categoryId: string;
  status: string;
  acquisitionDate: string;
  acquisitionCostRappen: number;
  residualValueRappen: number;
  usefulLifeMonths: number | null;
  depreciationMethod: string;
  glAssetAccountId: string;
  glAccumDeprAccountId: string;
  glDeprExpenseAccountId: string;
  serialNumber: string | null;
  barcode: string | null;
  manufacturer: string | null;
  model: string | null;
  warrantyUntil: string | null;
  notes: string | null;
  accumulatedDeprRappen: number;
  netBookValueRappen: number;
}

interface Category {
  id: string;
  code: string;
  name: string;
}

interface Account {
  id: string;
  number: string;
  name: string;
  type: string;
}

/** H07: one ledger EVENT, an asset_transaction row with the running balances AFTER it. The authoritative
 * per-asset ledger the Transactions drawer renders (asset_ledger_get, US-H07.1). */
export interface LedgerEvent {
  id: string;
  type: string;
  date: string;
  deltaCostRappen: number;
  deltaAccumDeprRappen: number;
  journalEntryId: string;
  description: string | null;
  costAfterRappen: number;
  accumulatedDeprAfterRappen: number;
  netBookValueAfterRappen: number;
  /** D170: the compensating row that took this event back, or null while it stands. */
  reversedByTransactionId: string | null;
  /** D191: a disposal's linked proceeds document still stands (true), no longer does (false), or none (null). */
  proceedsDocumentStands: boolean | null;
}

/** D170: the four events `asset_transaction_reverse` takes back (depreciation goes with its run). */
const REVERSIBLE_TYPES = new Set(['acquisition', 'additional_capitalisation', 'opening', 'disposal']);
const REVERSE_VERB = 'asset_transaction_reverse';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/** The account types A01 permits on the CREDIT side of a capitalisation (bank, creditor, equity). */
const CREDIT_TYPES = new Set(['asset', 'liability', 'equity']);

/** H06: the money-side accounts disposal proceeds may land on (bank / receivable / occasional
 * liability), and the income/expense accounts the book gain or loss may land on. Mirrors the engine's
 * PROCEEDS_ACCOUNT_TYPES / GAIN_LOSS_ACCOUNT_TYPES; the engine is the real gate. */
const PROCEEDS_TYPES = new Set(['asset', 'liability']);
const GAIN_LOSS_TYPES = new Set(['income', 'expense']);

function parseAccounts(body: unknown): Account[] {
  const rows = (body as { accounts?: unknown })?.accounts;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({ id: String(r.id ?? ''), number: String(r.number ?? ''), name: String(r.name ?? ''), type: String(r.type ?? '') }))
    .filter((a) => a.id !== '');
}

function parseLedger(body: unknown): LedgerEvent[] {
  const rows = (body as { events?: unknown })?.events;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({
      id: String(r.id ?? ''),
      type: String(r.type ?? ''),
      date: String(r.date ?? ''),
      deltaCostRappen: num(r.deltaCostRappen),
      deltaAccumDeprRappen: num(r.deltaAccumDeprRappen),
      journalEntryId: String(r.journalEntryId ?? ''),
      description: str(r.description),
      costAfterRappen: num(r.costAfterRappen),
      accumulatedDeprAfterRappen: num(r.accumulatedDeprAfterRappen),
      netBookValueAfterRappen: num(r.netBookValueAfterRappen),
      reversedByTransactionId: str(r.reversedByTransactionId),
      proceedsDocumentStands: typeof r.proceedsDocumentStands === 'boolean' ? r.proceedsDocumentStands : null,
    }))
    .filter((tr) => tr.id !== '');
}

/** D191: the engine's `invalid_proceeds_document` reasons, each with its own sentence (never the raw code). */
const PROCEEDS_REASONS = [
  'not_found',
  'not_an_invoice',
  'not_issued',
  'not_incoming',
  'not_standing',
  'payment_not_for_invoice',
  'no_proceeds',
  // D192
  'no_sale_line',
  'sale_not_single_line',
  'proceeds_needs_invoice',
  'invoice_already_cleared',
] as const;

/** D191: the message key for a refused link's reason; an unknown reason gets the generic sentence. */
export function proceedsReasonKey(reason: string): string {
  return (PROCEEDS_REASONS as readonly string[]).includes(reason) ? `assets.disposal.proceedsDocReason.${reason}` : 'assets.disposal.proceedsDocInvalid';
}

/** D192: the dispose refusals that concern the DATE, each with its own sentence on the date field. */
const DATE_REFUSALS = ['sale_in_other_financial_year', 'years_not_adjacent', 'disposal_date_in_future', 'disposal_date_before_reversal', 'period_locked'] as const;

/**
 * D192: where a dispose refusal is shown and in which words (never the raw code). `doc` is the proceeds
 * document field, `date` the disposal date; null for a refusal the generic banner handles.
 */
export function disposalRefusal(body: unknown): { field: 'doc' | 'date'; key: string; suggestedDate: string | null } | null {
  const b = (body ?? {}) as { error?: unknown; reason?: unknown; suggestedDisposalDate?: unknown };
  const error = String(b.error ?? '');
  const reason = String(b.reason ?? '');
  const suggestedDate = typeof b.suggestedDisposalDate === 'string' ? b.suggestedDisposalDate : null;
  if (error === 'invalid_proceeds_document') return { field: 'doc', key: proceedsReasonKey(reason), suggestedDate };
  if (error === 'invalid_input' && reason === 'proceeds_from_document') return { field: 'doc', key: 'assets.disposal.refusal.proceeds_from_document', suggestedDate };
  if ((DATE_REFUSALS as readonly string[]).includes(error)) return { field: 'date', key: `assets.disposal.refusal.${error}`, suggestedDate };
  return null;
}

/** D192: how a linked disposal books its proceeds (the `assets.proceeds_booking` setting). */
export type ProceedsBookingMode = 'clear_via_document' | 'book_proceeds';

export function parseProceedsBooking(body: unknown): ProceedsBookingMode {
  const v = (body as { setting?: { value?: unknown } })?.setting?.value;
  return v === 'book_proceeds' ? 'book_proceeds' : 'clear_via_document';
}

/** D191: how the reverse treats a standing proceeds document (the `assets.proceeds_check` setting). */
export type ProceedsCheckMode = 'refuse' | 'warn' | 'off';

/** D191: the mode asset_ledger_get reports; anything unknown reads as the default, `refuse`. */
export function parseProceedsCheck(body: unknown): ProceedsCheckMode {
  const v = (body as { proceedsCheck?: unknown })?.proceedsCheck;
  return v === 'warn' || v === 'off' ? v : 'refuse';
}

/** H05: a fixed-asset location, the transfer target and the register's location dimension. */
export interface AssetLocation {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

/** H05: one immutable transfer-history row on an asset. Non-financial by construction. */
export interface AssetTransferRow {
  id: string;
  date: string;
  fromLocationId: string | null;
  toLocationId: string | null;
  fromResponsibleUserId: string | null;
  toResponsibleUserId: string | null;
  description: string | null;
}

function parseLocations(body: unknown): AssetLocation[] {
  const rows = (body as { locations?: unknown })?.locations;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({ id: String(r.id ?? ''), code: String(r.code ?? ''), name: String(r.name ?? ''), active: r.active === true }))
    .filter((l) => l.id !== '');
}

function parseTransfers(body: unknown): AssetTransferRow[] {
  const rows = (body as { transfers?: unknown })?.transfers;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({
      id: String(r.id ?? ''),
      date: String(r.date ?? ''),
      fromLocationId: str(r.fromLocationId),
      toLocationId: str(r.toLocationId),
      fromResponsibleUserId: str(r.fromResponsibleUserId),
      toResponsibleUserId: str(r.toResponsibleUserId),
      description: str(r.description),
    }))
    .filter((tr) => tr.id !== '');
}

function parseAssets(body: unknown): Asset[] | null {
  const rows = (body as { assets?: unknown })?.assets;
  if (!Array.isArray(rows)) return null;
  const out: Asset[] = [];
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') return null;
    const a = raw as Record<string, unknown>;
    if (typeof a.id !== 'string' || typeof a.number !== 'string' || typeof a.name !== 'string') return null;
    out.push({
      id: a.id,
      number: a.number,
      name: a.name,
      categoryId: str(a.categoryId) ?? '',
      status: str(a.status) ?? 'draft',
      acquisitionDate: str(a.acquisitionDate) ?? '',
      acquisitionCostRappen: num(a.acquisitionCostRappen),
      residualValueRappen: num(a.residualValueRappen),
      usefulLifeMonths: typeof a.usefulLifeMonths === 'number' ? a.usefulLifeMonths : null,
      depreciationMethod: str(a.depreciationMethod) ?? 'straight_line',
      glAssetAccountId: str(a.glAssetAccountId) ?? '',
      glAccumDeprAccountId: str(a.glAccumDeprAccountId) ?? '',
      glDeprExpenseAccountId: str(a.glDeprExpenseAccountId) ?? '',
      serialNumber: str(a.serialNumber),
      barcode: str(a.barcode),
      manufacturer: str(a.manufacturer),
      model: str(a.model),
      warrantyUntil: str(a.warrantyUntil),
      notes: str(a.notes),
      accumulatedDeprRappen: num(a.accumulatedDeprRappen),
      netBookValueRappen: num(a.netBookValueRappen),
    });
  }
  return out;
}

function parseCategories(body: unknown): Category[] {
  const rows = (body as { categories?: unknown })?.categories;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({ id: String(r.id ?? ''), code: String(r.code ?? ''), name: String(r.name ?? '') }))
    .filter((c) => c.id !== '');
}

// K-71: format through the shared `formatMoney` so de-CH thousands grouping is applied once, in one
// place. The asset register is kept in the workspace base currency and carries no per-row currency,
// so the base (CHF) is passed explicitly rather than assumed inside the formatter.
const money = (rappen: number): string => formatMoney(rappen, 'CHF');

/** An asset's lifecycle on the shared Status vocabulary (K-22): glyph plus word, one weight. */
export function assetStatusKind(status: string): StatusKind {
  switch (status) {
    case 'active':
      return 'success';
    case 'draft':
      return 'neutral';
    default:
      // fully_depreciated, disposed, archived: the asset is out of use, which is a quiet state.
      return 'inactive';
  }
}

interface Draft {
  categoryId: string;
  name: string;
  description: string;
  acquisitionDate: string;
  costMajor: string; // CHF major units, converted to Rappen on submit
  depreciationMethod: Method;
  usefulLifeMonths: string;
  residualValuePct: string;
  serialNumber: string;
  location: string;
  responsible: string;
  notes: string;
}

const EMPTY_DRAFT: Draft = {
  categoryId: '',
  name: '',
  description: '',
  acquisitionDate: '',
  costMajor: '',
  depreciationMethod: 'straight_line',
  usefulLifeMonths: '',
  residualValuePct: '',
  serialNumber: '',
  location: '',
  responsible: '',
  notes: '',
};

interface AcqDraft {
  date: string;
  amountMajor: string; // CHF major units, converted to Rappen on submit
  creditAccountId: string;
  residualMajor: string; // primary acquisition only
  description: string;
}

const EMPTY_ACQ: AcqDraft = { date: '', amountMajor: '', creditAccountId: '', residualMajor: '', description: '' };

/** H07: the opening-balance drawer inputs. Cost and accumulated are entered in major units and converted
 * to Rappen; the offset (equity/opening) account carries the net book value. */
interface OpeningDraft {
  date: string;
  costMajor: string;
  accumulatedMajor: string;
  offsetAccountId: string;
  description: string;
}

const EMPTY_OPENING: OpeningDraft = { date: '', costMajor: '', accumulatedMajor: '', offsetAccountId: '', description: '' };

interface TransferDraft {
  toLocationId: string;
  toResponsibleUserId: string;
  effectiveDate: string;
  reason: string;
}

/** H06: the dispose drawer's inputs. Proceeds are entered in major units and converted to Rappen. */
interface DisposeDraft {
  disposalDate: string;
  proceedsMajor: string;
  proceedsAccountId: string;
  gainLossAccountId: string;
  reason: string;
  counterparty: string;
  /** D191: the optional proceeds document, `invoice:<id>` or `payment:<id>`; '' links none. */
  proceedsDoc: string;
}

/** D191: one pickable proceeds document (an issued invoice or a standing incoming payment). */
export interface ProceedsOption {
  key: string;
  label: string;
}

/** D191: the open invoices and standing incoming payments a disposal may name as its proceeds. */
export function proceedsOptions(docs: unknown, payments: unknown, money: (minor: number) => string, invoiceWord: string, paymentWord: string): ProceedsOption[] {
  const rows = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? v.filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object') : [];
  const invoices = rows(docs)
    .filter((d) => d.type === 'invoice' && d.status !== 'draft' && d.status !== 'cancelled' && typeof d.id === 'string')
    .map((d) => ({ key: `invoice:${String(d.id)}`, label: `${invoiceWord} ${String(d.number ?? d.id)} · ${money(num(d.totalMinor))}` }));
  const pays = rows(payments)
    .filter((p) => p.direction === 'incoming' && p.status === 'posted' && typeof p.id === 'string')
    .map((p) => ({ key: `payment:${String(p.id)}`, label: `${paymentWord} ${String(p.date ?? '')} · ${money(num(p.baseAmountMinor ?? p.amountMinor))}` }));
  return [...invoices, ...pays];
}

/** D191: the engine fields for a picked proceeds document. */
function proceedsFields(key: string): { proceedsInvoiceId?: string; proceedsPaymentId?: string } {
  if (key.startsWith('invoice:')) return { proceedsInvoiceId: key.slice('invoice:'.length) };
  if (key.startsWith('payment:')) return { proceedsPaymentId: key.slice('payment:'.length) };
  return {};
}

/** H06: the previewed disposal journal (asset_disposal_preview), the exact entry a dispose will post. */
interface DisposalPreviewLine {
  accountNumber: string;
  accountName: string;
  debitRappen: number;
  creditRappen: number;
}
interface DisposalPreview {
  acquisitionCostRappen: number;
  accumulatedDeprRappen: number;
  netBookValueRappen: number;
  proceedsRappen: number;
  gainLossRappen: number;
  lines: DisposalPreviewLine[];
  /** D191: amount / currency / counterparty differences between the proceeds and the linked document. */
  warnings: string[];
  /** D192: the proceeds come from the linked invoice's sale line (the engine derived them). */
  proceedsFromDocument: boolean;
  /** D192: the account the proceeds (or the clearing) land on, as `number name`. */
  proceedsAccountLabel: string | null;
  /** D192: the Abgrenzung a sale across a year end posts with the disposal, or null. */
  abgrenzung: { kind: string; periodEnd: string; reversalDate: string; lines: DisposalPreviewLine[] } | null;
}

function previewLinesOf(raw: unknown): DisposalPreviewLine[] {
  const rows = Array.isArray(raw) ? raw : [];
  return rows
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({
      accountNumber: String(r.account_number ?? ''),
      accountName: String(r.account_name ?? ''),
      debitRappen: num(r.debit_rappen),
      creditRappen: num(r.credit_rappen),
    }));
}

function parseDisposalPreview(body: unknown): DisposalPreview | null {
  const p = (body as { preview?: unknown })?.preview;
  if (p === null || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  const rawLines = Array.isArray(o.journal_lines) ? o.journal_lines : [];
  const lines: DisposalPreviewLine[] = rawLines
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({
      accountNumber: String(r.account_number ?? ''),
      accountName: String(r.account_name ?? ''),
      debitRappen: num(r.debit_rappen),
      creditRappen: num(r.credit_rappen),
    }));
  return {
    acquisitionCostRappen: num(o.acquisition_cost_rappen),
    accumulatedDeprRappen: num(o.accumulated_depr_rappen),
    netBookValueRappen: num(o.net_book_value_rappen),
    proceedsRappen: num(o.proceeds_rappen),
    gainLossRappen: num(o.gain_loss_rappen),
    lines,
    warnings: Array.isArray(o.warnings)
      ? o.warnings.map((w) => String((w as { code?: unknown })?.code ?? '')).filter((c) => c !== '')
      : [],
    proceedsFromDocument: o.proceeds_from_document === true,
    proceedsAccountLabel:
      o.proceeds_account !== null && typeof o.proceeds_account === 'object'
        ? `${String((o.proceeds_account as { number?: unknown }).number ?? '')} ${String((o.proceeds_account as { name?: unknown }).name ?? '')}`.trim()
        : null,
    abgrenzung:
      o.abgrenzung !== null && typeof o.abgrenzung === 'object'
        ? {
            kind: String((o.abgrenzung as { kind?: unknown }).kind ?? ''),
            periodEnd: String((o.abgrenzung as { period_end?: unknown }).period_end ?? ''),
            reversalDate: String((o.abgrenzung as { reversal_date?: unknown }).reversal_date ?? ''),
            lines: previewLinesOf((o.abgrenzung as { lines?: unknown }).lines),
          }
        : null,
  };
}

/** Today as YYYY-MM-DD, the transfer default (a physical move is normally recorded on the day). */
const today = (): string => new Date().toISOString().slice(0, 10);

const EMPTY_TRANSFER: TransferDraft = { toLocationId: '', toResponsibleUserId: '', effectiveDate: '', reason: '' };

const EMPTY_DISPOSE: DisposeDraft = {
  disposalDate: '',
  proceedsMajor: '',
  proceedsAccountId: '',
  gainLossAccountId: '',
  reason: '',
  counterparty: '',
  proceedsDoc: '',
};

function draftFrom(a: Asset): Draft {
  return {
    categoryId: a.categoryId,
    name: a.name,
    description: '',
    acquisitionDate: a.acquisitionDate,
    costMajor: (a.acquisitionCostRappen / 100).toFixed(2),
    depreciationMethod: (DEPRECIATION_METHODS.includes(a.depreciationMethod as Method)
      ? a.depreciationMethod
      : 'straight_line') as Method,
    usefulLifeMonths: a.usefulLifeMonths === null ? '' : String(a.usefulLifeMonths),
    residualValuePct: '',
    serialNumber: a.serialNumber ?? '',
    location: '',
    responsible: '',
    notes: a.notes ?? '',
  };
}

export function AssetRegister() {
  const t = useT();
  const cal = useCalendarFormat();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();

  const [assets, setAssets] = useState<Asset[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);
  const [drawer, setDrawer] = useState<'closed' | 'create' | string>('closed');
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState<Asset | null>(null);
  const [archiving, setArchiving] = useState<Asset | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [acquiring, setAcquiring] = useState<Asset | null>(null);
  const [acqDraft, setAcqDraft] = useState<AcqDraft>(EMPTY_ACQ);
  const [viewing, setViewing] = useState<Asset | null>(null);
  const [txns, setTxns] = useState<LedgerEvent[] | null>(null);
  // H07, opening balance: the draft asset being seeded and its input draft.
  const [opening, setOpening] = useState<Asset | null>(null);
  const [openDraft, setOpenDraft] = useState<OpeningDraft>(EMPTY_OPENING);
  // H05, transfer & location: the location list (transfer target + label dimension), the asset being
  // transferred, its draft, and its loaded history.
  const [locations, setLocations] = useState<AssetLocation[]>([]);
  const [transferring, setTransferring] = useState<Asset | null>(null);
  const [transferDraft, setTransferDraft] = useState<TransferDraft>(EMPTY_TRANSFER);
  const [history, setHistory] = useState<AssetTransferRow[] | null>(null);
  // H06, disposal: the asset being disposed, its draft, and the live journal preview.
  const [disposing, setDisposing] = useState<Asset | null>(null);
  const [dispDraft, setDispDraft] = useState<DisposeDraft>(EMPTY_DISPOSE);
  const [dispPreview, setDispPreview] = useState<DisposalPreview | null>(null);
  // D170: the ledger event a person is about to take back, and the reason they give. The reverse runs
  // only from the confirm dialog, never straight from the row's menu.
  const [reversingTxn, setReversingTxn] = useState<LedgerEvent | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  // D191: the single-case override of the proceeds check, with its own required reason.
  const [overrideProceeds, setOverrideProceeds] = useState(false);
  // D191: the workspace setting `assets.proceeds_check` as asset_ledger_get reports it.
  const [proceedsCheck, setProceedsCheck] = useState<ProceedsCheckMode>('refuse');
  const [overrideReason, setOverrideReason] = useState('');
  const [proceedsChoices, setProceedsChoices] = useState<ProceedsOption[]>([]);
  const [dispPreviewError, setDispPreviewError] = useState<{ field: 'doc' | 'date'; key: string } | null>(null);
  // D192: how a linked disposal books its proceeds; with an invoice under `clear_via_document` the
  // engine derives them and the amount and account fields give way to the preview's figures.
  const [proceedsBooking, setProceedsBooking] = useState<ProceedsBookingMode>('clear_via_document');
  // D192: the date is pre-filled from a refusal's suggestion only while the person has not touched it.
  const [dispDateTouched, setDispDateTouched] = useState(false);

  const canWrite = can(CAP.manageMasterData);
  // A capitalisation posts a journal, so the honest gate is the posting capability; the register CRUD
  // stays on manage_master_data. `whoami` fails open and the engine is the real gate (the standing rule).
  const canPost = can(CAP.post);
  const creditAccounts = useMemo(() => accounts.filter((a) => CREDIT_TYPES.has(a.type)), [accounts]);
  // H06: the proceeds picker offers money-side accounts, the gain/loss picker income/expense accounts.
  const proceedsAccounts = useMemo(() => accounts.filter((a) => PROCEEDS_TYPES.has(a.type)), [accounts]);
  const gainLossAccounts = useMemo(() => accounts.filter((a) => GAIN_LOSS_TYPES.has(a.type)), [accounts]);
  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const trimmed = search.trim();
    const listCall = trimmed
      ? client.call('asset_search', { workspaceId, query: trimmed })
      : client.call('asset_list', { workspaceId, includeArchived: true });
    const [listed, cats, accts, locs] = await Promise.all([
      listCall,
      client.call('asset_category_list', { workspaceId }),
      client.call('list_accounts', { workspaceId }),
      client.call('asset_location_list', { workspaceId, active: true }),
    ]);
    if (isErr(listed.body)) {
      if (listed.body.error === 'permission_denied' || listed.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseAssets(listed.body);
    if (parsed === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setAssets(parsed);
    if (!isErr(cats.body)) setCategories(parseCategories(cats.body));
    // Render the credit-account picker from the RECORDED payload, never a literal chart.
    if (!isErr(accts.body)) setAccounts(parseAccounts(accts.body));
    if (!isErr(locs.body)) setLocations(parseLocations(locs.body));
    setLoading(false);
  }, [client, workspaceId, search]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(
    () =>
      assets.filter(
        (a) =>
          (categoryFilter === '' || a.categoryId === categoryFilter) &&
          (statusFilter === '' || a.status === statusFilter),
      ),
    [assets, categoryFilter, statusFilter],
  );

  const write = useCallback(
    async (action: string, input: Record<string, unknown>): Promise<boolean> => {
      if (workspaceId === null) return false;
      setWriteError(null);
      const response = await client.call(action, { workspaceId, ...input });
      if (isErr(response.body)) {
        setWriteError(response.body);
        return false;
      }
      await load();
      return true;
    },
    [client, workspaceId, load],
  );

  const openCreate = () => {
    setWriteError(null);
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setDrawer('create');
  };
  const openEdit = (a: Asset) => {
    setWriteError(null);
    setEditing(a);
    setDraft(draftFrom(a));
    setDrawer(a.id);
  };
  const closeDrawer = () => {
    setDrawer('closed');
    setEditing(null);
  };

  // When a category is chosen while creating, pull its resolved defaults and prefill the trio.
  const onCategoryChange = useCallback(
    async (categoryId: string) => {
      setDraft((d) => ({ ...d, categoryId }));
      if (categoryId === '' || workspaceId === null) return;
      const resolved = await client.call('asset_category_resolve_defaults', { workspaceId, categoryId });
      if (isErr(resolved.body)) return;
      const defaults = (resolved.body as { defaults?: Record<string, unknown> }).defaults;
      if (!defaults) return;
      setDraft((d) => ({
        ...d,
        depreciationMethod: (DEPRECIATION_METHODS.includes(defaults.depreciationMethod as Method)
          ? (defaults.depreciationMethod as Method)
          : 'straight_line'),
        usefulLifeMonths:
          typeof defaults.usefulLifeMonths === 'number' ? String(defaults.usefulLifeMonths) : '',
        residualValuePct:
          typeof defaults.residualValuePct === 'number' && defaults.residualValuePct !== 0
            ? String(defaults.residualValuePct)
            : '',
      }));
    },
    [client, workspaceId],
  );

  const financialLocked = editing !== null && editing.status !== 'draft';
  const terminal = editing !== null && (editing.status === 'archived' || editing.status === 'disposed');

  const submit = useCallback(async () => {
    const costRappen = Math.round(Number(draft.costMajor.trim()) * 100);
    const life = draft.usefulLifeMonths.trim();
    const pct = draft.residualValuePct.trim();
    let ok = false;
    if (drawer === 'create') {
      ok = await write('asset_create', {
        categoryId: draft.categoryId,
        name: draft.name.trim(),
        description: draft.description.trim() === '' ? undefined : draft.description.trim(),
        acquisitionDate: draft.acquisitionDate,
        acquisitionCostRappen: costRappen,
        depreciationMethod: draft.depreciationMethod,
        usefulLifeMonths: draft.depreciationMethod === 'none' || life === '' ? undefined : Number(life),
        residualValuePct: pct === '' ? undefined : Number(pct),
        serialNumber: draft.serialNumber.trim() === '' ? undefined : draft.serialNumber.trim(),
        locationId: draft.location.trim() === '' ? undefined : draft.location.trim(),
        responsibleUserId: draft.responsible.trim() === '' ? undefined : draft.responsible.trim(),
        notes: draft.notes.trim() === '' ? undefined : draft.notes.trim(),
        idempotencyKey: newKey(),
      });
    } else {
      // Descriptive patch always; the financial baseline only while still draft.
      const patch: Record<string, unknown> = {
        name: draft.name.trim(),
        serialNumber: draft.serialNumber.trim() === '' ? '' : draft.serialNumber.trim(),
        notes: draft.notes.trim() === '' ? '' : draft.notes.trim(),
      };
      if (!financialLocked) {
        patch.acquisitionDate = draft.acquisitionDate;
        patch.acquisitionCostRappen = costRappen;
        patch.depreciationMethod = draft.depreciationMethod;
        patch.usefulLifeMonths = draft.depreciationMethod === 'none' || life === '' ? null : Number(life);
        if (pct !== '') patch.residualValuePct = Number(pct);
      }
      ok = await write('asset_update', { assetId: drawer, patch, idempotencyKey: newKey() });
    }
    if (ok) closeDrawer();
  }, [write, draft, drawer, financialLocked]);

  const confirmArchive = useCallback(async () => {
    if (archiving === null) return;
    const ok = await write('asset_archive', { assetId: archiving.id, idempotencyKey: newKey() });
    if (ok) setArchiving(null);
  }, [write, archiving]);

  // A draft asset acquires (primary), an active one adds capitalisation: one drawer, chosen by status.
  const openAcquire = (a: Asset) => {
    setWriteError(null);
    setAcqDraft({ ...EMPTY_ACQ, date: a.acquisitionDate, amountMajor: a.status === 'draft' ? (a.acquisitionCostRappen / 100).toFixed(2) : '' });
    setAcquiring(a);
  };
  const closeAcquire = () => {
    setAcquiring(null);
    setAcqDraft(EMPTY_ACQ);
  };

  const acqIsPrimary = acquiring !== null && acquiring.status === 'draft';

  const submitAcquire = useCallback(async () => {
    if (acquiring === null) return;
    const amountRappen = Math.round(Number(acqDraft.amountMajor.trim()) * 100);
    const residual = acqDraft.residualMajor.trim();
    let ok = false;
    if (acqIsPrimary) {
      ok = await write('asset_acquire', {
        assetId: acquiring.id,
        date: acqDraft.date,
        acquisitionCostRappen: amountRappen,
        creditAccountId: acqDraft.creditAccountId,
        residualValueRappen: residual === '' ? undefined : Math.round(Number(residual) * 100),
        description: acqDraft.description.trim() === '' ? undefined : acqDraft.description.trim(),
        idempotencyKey: newKey(),
      });
    } else {
      ok = await write('asset_add_capitalisation', {
        assetId: acquiring.id,
        date: acqDraft.date,
        amountRappen,
        creditAccountId: acqDraft.creditAccountId,
        description: acqDraft.description.trim() === '' ? undefined : acqDraft.description.trim(),
        idempotencyKey: newKey(),
      });
    }
    if (ok) closeAcquire();
  }, [write, acquiring, acqDraft, acqIsPrimary]);

  const openTxns = useCallback(
    async (a: Asset) => {
      setViewing(a);
      setTxns(null);
      if (workspaceId === null) return;
      // The authoritative per-asset ledger (H07): every event with the running cost / accumulated / NBV
      // and its journal link, from asset_ledger_get.
      const res = await client.call('asset_ledger_get', { workspaceId, assetId: a.id });
      setTxns(isErr(res.body) ? [] : parseLedger(res.body));
      setProceedsCheck(isErr(res.body) ? 'refuse' : parseProceedsCheck(res.body));
    },
    [client, workspaceId],
  );

  // D170: take one event back. On success the ledger is re-read so the new correcting row and the
  // moved status show at once (write() already reloads the register list).
  const confirmReverse = useCallback(async () => {
    if (viewing === null || reversingTxn === null || reverseReason.trim() === '') return;
    const ok = await write(REVERSE_VERB, {
      assetId: viewing.id,
      transactionId: reversingTxn.id,
      reason: reverseReason.trim(),
      ...(overrideProceeds ? { overrideProceedsCheck: true, overrideReason: overrideReason.trim() } : {}),
      idempotencyKey: newKey(),
    });
    if (!ok) return;
    setReversingTxn(null);
    setReverseReason('');
    setOverrideProceeds(false);
    setOverrideReason('');
    await openTxns(viewing);
  }, [write, viewing, reversingTxn, reverseReason, overrideProceeds, overrideReason, openTxns]);

  // D170: an event that still stands offers Stornieren, destructive, behind its confirm dialog.
  // Stornieren is destructive, so it stays under Mehr (brand/DESIGN.md, Icon vocabulary).
  const ledgerActions = (tr: LedgerEvent): OverflowMenuItem[] =>
    REVERSIBLE_TYPES.has(tr.type) && tr.reversedByTransactionId === null
      ? [{
          key: 'reverse',
          label: t('assets.ledger.reverse'),
          danger: true,
          disabled: !canPost,
          onSelect: () => {
            setWriteError(null);
            setReverseReason('');
            setOverrideProceeds(false);
            setOverrideReason('');
            setReversingTxn(tr);
          },
        }]
      : [];

  // H07, opening balance: seed a DRAFT asset's historical cost + accumulated depreciation. The offset
  // picker offers equity accounts (the net book value is carried against the opening/equity account).
  const equityAccounts = useMemo(() => accounts.filter((a) => a.type === 'equity'), [accounts]);
  const openOpening = (a: Asset) => {
    setWriteError(null);
    setOpenDraft({ ...EMPTY_OPENING, date: a.acquisitionDate || today() });
    setOpening(a);
  };
  const closeOpening = () => {
    setOpening(null);
    setOpenDraft(EMPTY_OPENING);
  };
  const openCostRappen = Math.round(Number(openDraft.costMajor.trim() || '0') * 100);
  const openAccumRappen = Math.round(Number(openDraft.accumulatedMajor.trim() || '0') * 100);
  const openNbvRappen = openCostRappen - openAccumRappen;
  const openingValid =
    opening !== null &&
    openDraft.date !== '' &&
    openCostRappen > 0 &&
    openAccumRappen >= 0 &&
    openAccumRappen <= openCostRappen &&
    (openNbvRappen === 0 || openDraft.offsetAccountId !== '');
  const submitOpening = useCallback(async () => {
    if (opening === null) return;
    const cost = Math.round(Number(openDraft.costMajor.trim() || '0') * 100);
    const accum = Math.round(Number(openDraft.accumulatedMajor.trim() || '0') * 100);
    const ok = await write('asset_opening_balance', {
      assetId: opening.id,
      date: openDraft.date,
      costRappen: cost,
      accumulatedDeprRappen: accum,
      offsetAccountId: cost - accum > 0 ? openDraft.offsetAccountId : undefined,
      description: openDraft.description.trim() === '' ? undefined : openDraft.description.trim(),
      idempotencyKey: newKey(),
    });
    if (ok) closeOpening();
  }, [write, opening, openDraft]);

  const locById = useMemo(() => new Map(locations.map((l) => [l.id, l])), [locations]);
  const locLabel = useCallback(
    (id: string | null): string => {
      if (id === null) return t('assets.transfer.none');
      const l = locById.get(id);
      return l ? `${l.code} ${l.name}` : id;
    },
    [locById, t],
  );

  // The transfer drawer is per-asset (the AssetDetail flow). It loads the asset's history alongside so
  // the timeline refreshes in place after a successful move.
  const openTransfer = useCallback(
    async (a: Asset) => {
      setWriteError(null);
      setTransferDraft({ ...EMPTY_TRANSFER, effectiveDate: today() });
      setTransferring(a);
      setHistory(null);
      if (workspaceId === null) return;
      const res = await client.call('asset_transfer_history', { workspaceId, assetId: a.id });
      setHistory(isErr(res.body) ? [] : parseTransfers(res.body));
    },
    [client, workspaceId],
  );
  const closeTransfer = () => {
    setTransferring(null);
    setTransferDraft(EMPTY_TRANSFER);
    setHistory(null);
  };

  const submitTransfer = useCallback(async () => {
    if (transferring === null) return;
    const loc = transferDraft.toLocationId.trim();
    const resp = transferDraft.toResponsibleUserId.trim();
    const ok = await write('asset_transfer', {
      assetIds: [transferring.id],
      toLocationId: loc === '' ? undefined : loc,
      toResponsibleUserId: resp === '' ? undefined : resp,
      effectiveDate: transferDraft.effectiveDate,
      reason: transferDraft.reason.trim() === '' ? undefined : transferDraft.reason.trim(),
      idempotencyKey: newKey(),
    });
    if (ok) {
      // Reload the history in place; keep the drawer open so the move is visibly recorded.
      if (workspaceId !== null) {
        const res = await client.call('asset_transfer_history', { workspaceId, assetId: transferring.id });
        setHistory(isErr(res.body) ? [] : parseTransfers(res.body));
      }
      setTransferDraft({ ...EMPTY_TRANSFER, effectiveDate: today() });
    }
  }, [write, transferring, transferDraft, client, workspaceId]);

  const transferValid =
    transferDraft.effectiveDate !== '' &&
    (transferDraft.toLocationId.trim() !== '' || transferDraft.toResponsibleUserId.trim() !== '');

  // --- H06, disposal -----------------------------------------------------------------------------
  const openDispose = (a: Asset) => {
    setWriteError(null);
    setDispPreview(null);
    setDispDraft({ ...EMPTY_DISPOSE, disposalDate: today() });
    setDisposing(a);
    setProceedsChoices([]);
    setDispPreviewError(null);
    setDispDateTouched(false);
    if (workspaceId === null) return;
    // D191: the optional proceeds picker offers issued invoices and standing incoming payments.
    void (async () => {
      const [docs, pays, booking] = await Promise.all([
        client.call('list_documents', { workspaceId, type: 'invoice' }),
        client.call('list_payments', { workspaceId, direction: 'incoming' }),
        client.call('settings_get', { workspaceId, key: 'assets.proceeds_booking' }),
      ]);
      setProceedsBooking(isErr(booking.body) ? 'clear_via_document' : parseProceedsBooking(booking.body));
      setProceedsChoices(
        proceedsOptions(
          isErr(docs.body) ? [] : (docs.body as { documents?: unknown }).documents,
          isErr(pays.body) ? [] : (pays.body as { payments?: unknown }).payments,
          money,
          t('assets.disposal.proceedsDocInvoice'),
          t('assets.disposal.proceedsDocPayment'),
        ),
      );
    })();
  };
  const closeDispose = () => {
    setDisposing(null);
    setDispDraft(EMPTY_DISPOSE);
    setDispPreview(null);
  };

  const dispProceedsRappen = Math.round(Number(dispDraft.proceedsMajor.trim() || '0') * 100);
  // D192: a document linked under `clear_via_document` brings its own proceeds (an invoice's sale line);
  // the engine derives them, so the call names none and the amount fields step aside.
  const dispDerived = proceedsBooking === 'clear_via_document' && dispDraft.proceedsDoc !== '';
  // A preview is requestable once the engine has what it needs: a valid date, a gain/loss account, a
  // non-negative integer proceeds, and (only when proceeds are received) a proceeds account.
  const dispPreviewable =
    disposing !== null &&
    dispDraft.disposalDate !== '' &&
    dispDraft.gainLossAccountId !== '' &&
    (dispDerived ||
      (Number.isFinite(dispProceedsRappen) &&
        dispProceedsRappen >= 0 &&
        (dispProceedsRappen === 0 || dispDraft.proceedsAccountId !== '')));

  // Live journal preview: recompute whenever the inputs change, so the exact entry the disposal will
  // post (and the gain/loss) is visible BEFORE the irreversible click. The preview is a pure read.
  useEffect(() => {
    if (!dispPreviewable || disposing === null || workspaceId === null) {
      setDispPreview(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const res = await client.call('asset_disposal_preview', {
        workspaceId,
        assetId: disposing.id,
        disposalDate: dispDraft.disposalDate,
        ...(dispDerived
          ? {}
          : { proceedsRappen: dispProceedsRappen, proceedsAccountId: dispProceedsRappen > 0 ? dispDraft.proceedsAccountId : undefined }),
        gainLossAccountId: dispDraft.gainLossAccountId,
        ...proceedsFields(dispDraft.proceedsDoc),
      });
      if (cancelled) return;
      setDispPreview(isErr(res.body) ? null : parseDisposalPreview(res.body));
      const refusal = isErr(res.body) ? disposalRefusal(res.body) : null;
      setDispPreviewError(refusal === null ? null : { field: refusal.field, key: refusal.key });
      // D192: a refusal that names the invoice's date fills it in while the person has not chosen one.
      if (refusal?.suggestedDate != null && !dispDateTouched) {
        setDispDraft((dr) => ({ ...dr, disposalDate: refusal.suggestedDate as string }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    client,
    workspaceId,
    disposing,
    dispPreviewable,
    dispProceedsRappen,
    dispDerived,
    dispDateTouched,
    dispDraft.disposalDate,
    dispDraft.proceedsAccountId,
    dispDraft.gainLossAccountId,
    dispDraft.proceedsDoc,
  ]);

  const submitDispose = useCallback(async () => {
    if (disposing === null) return;
    const proceeds = Math.round(Number(dispDraft.proceedsMajor.trim() || '0') * 100);
    const ok = await write('asset_dispose', {
      assetId: disposing.id,
      disposalDate: dispDraft.disposalDate,
      // D192: under clear_via_document an invoice brings its own proceeds; the call names none.
      ...(dispDerived ? {} : { proceedsRappen: proceeds, proceedsAccountId: proceeds > 0 ? dispDraft.proceedsAccountId : undefined }),
      gainLossAccountId: dispDraft.gainLossAccountId,
      reason: dispDraft.reason.trim() === '' ? undefined : dispDraft.reason.trim(),
      counterpartyName: dispDraft.counterparty.trim() === '' ? undefined : dispDraft.counterparty.trim(),
      ...(dispDerived || proceeds > 0 ? proceedsFields(dispDraft.proceedsDoc) : {}),
      idempotencyKey: newKey(),
    });
    if (ok) closeDispose();
  }, [write, disposing, dispDraft, dispDerived]);

  const disposeValid =
    disposing !== null &&
    dispDraft.disposalDate !== '' &&
    dispDraft.gainLossAccountId !== '' &&
    (dispDerived
      ? dispPreview !== null && dispPreviewError === null
      : dispProceedsRappen >= 0 && (dispProceedsRappen === 0 || dispDraft.proceedsAccountId !== ''));

  const assetGlAccount = useMemo(() => {
    if (acquiring === null) return null;
    return accounts.find((a) => a.id === acquiring.glAssetAccountId) ?? null;
  }, [accounts, acquiring]);
  const acqCreditAccount = useMemo(
    () => creditAccounts.find((a) => a.id === acqDraft.creditAccountId) ?? null,
    [creditAccounts, acqDraft.creditAccountId],
  );
  const acqAmountRappen = Math.round(Number(acqDraft.amountMajor.trim() || '0') * 100);

  const noCategories = categories.length === 0;

  // Every figure renders VERBATIM from the read models: acquisition cost and net book value from
  // asset_list/asset_search; the UI computes no depreciation or NBV.
  const assetColumns: DataTableColumn<Asset>[] = [
    {
      key: 'number',
      header: t('assets.register.col.number'),
      rowHeader: true,
      render: (a) => <span className="fa-code">{a.number}</span>,
    },
    { key: 'name', header: t('assets.register.col.name'), render: (a) => a.name },
    { key: 'category', header: t('assets.register.col.category'), render: (a) => catById.get(a.categoryId)?.code ?? '-' },
    {
      key: 'status',
      header: t('assets.register.col.status'),
      render: (a) => <Status kind={assetStatusKind(a.status)} label={t(`assets.status.${a.status}`)} />,
    },
    { key: 'acquired', header: t('assets.register.col.acquired'), render: (a) => cal.date(a.acquisitionDate) },
    { key: 'cost', header: t('assets.register.col.cost'), numeric: true, render: (a) => money(a.acquisitionCostRappen) },
    { key: 'nbv', header: t('assets.register.col.nbv'), numeric: true, render: (a) => money(a.netBookValueRappen) },
  ];

  // K-21: the row itself opens the asset (the edit drawer, or the read-only transactions for a
  // viewer), and every other verb sits behind ONE quiet overflow, destructive last. The row used to
  // carry up to six ghost buttons and measured 108.5px.
  const openAsset = (a: Asset) => (canWrite ? openEdit(a) : void openTxns(a));
  const assetActions = (a: Asset): OverflowMenuItem[] => {
    const items: OverflowMenuItem[] = [];
    if (a.status === 'draft') {
      items.push({ key: 'acquire', label: t('assets.acquisition.record'), onSelect: () => openAcquire(a), disabled: !canPost });
      items.push({ key: 'opening', label: t('assets.ledger.openingBalance'), onSelect: () => openOpening(a), disabled: !canPost });
    }
    if (a.status === 'active' || a.status === 'fully_depreciated') {
      items.push({
        key: 'capitalise',
        label: t('assets.acquisition.addCapitalisation'),
        onSelect: () => openAcquire(a),
        disabled: !canPost || a.status === 'fully_depreciated',
      });
    }
    items.push({ key: 'transactions', label: t('assets.acquisition.transactions'), onSelect: () => void openTxns(a) });
    if (canWrite) items.push({ key: 'edit', label: t('assets.register.edit'), onSelect: () => openEdit(a) });
    if (a.status !== 'disposed' && a.status !== 'archived') {
      items.push({ key: 'transfer', label: t('assets.transfer.action'), onSelect: () => void openTransfer(a), disabled: !canWrite });
    }
    if (a.status === 'active' || a.status === 'fully_depreciated') {
      items.push({ key: 'dispose', label: t('assets.disposal.action'), onSelect: () => openDispose(a), disabled: !canPost });
    }
    if (a.status === 'draft' || a.status === 'fully_depreciated') {
      items.push({
        key: 'archive',
        label: t('assets.register.archive'),
        onSelect: () => {
          setWriteError(null);
          setArchiving(a);
        },
        disabled: !canWrite,
        danger: true,
      });
    }
    return items;
  };

  // H07 per-asset ledger: every running balance renders VERBATIM from asset_ledger_get.
  const ledgerColumns: DataTableColumn<LedgerEvent>[] = [
    { key: 'date', header: t('assets.ledger.col.date'), render: (tr) => cal.date(tr.date) },
    // The event TYPE is a word, not a status: plain text, no badge (K-22 keeps Status for states).
    {
      key: 'type',
      header: t('assets.ledger.col.type'),
      render: (tr) => (
        <>
          {t(`assets.acquisition.txnType.${tr.type}`)}
          {tr.reversedByTransactionId !== null && <> <Status kind="inactive" label={t('assets.ledger.reversed')} /></>}
        </>
      ),
    },
    { key: 'deltaCost', header: t('assets.ledger.col.deltaCost'), numeric: true, render: (tr) => (tr.deltaCostRappen === 0 ? '-' : money(tr.deltaCostRappen)) },
    { key: 'deltaAccum', header: t('assets.ledger.col.deltaAccum'), numeric: true, render: (tr) => (tr.deltaAccumDeprRappen === 0 ? '-' : money(tr.deltaAccumDeprRappen)) },
    { key: 'nbv', header: t('assets.ledger.col.nbv'), numeric: true, render: (tr) => money(tr.netBookValueAfterRappen) },
    { key: 'journal', header: t('assets.ledger.col.journal'), render: (tr) => <span className="fa-code">{tr.journalEntryId || '-'}</span> },
  ];

  const transferHistoryColumns: DataTableColumn<AssetTransferRow>[] = [
    { key: 'date', header: t('assets.transfer.col.date'), render: (h) => cal.date(h.date) },
    { key: 'from', header: t('assets.transfer.col.from'), render: (h) => locLabel(h.fromLocationId) },
    { key: 'to', header: t('assets.transfer.col.to'), render: (h) => locLabel(h.toLocationId) },
    { key: 'reason', header: t('assets.transfer.col.reason'), render: (h) => h.description ?? '-' },
  ];

  if (workspaceId === null) return <NoWorkspaceState body={t('assets.register.noWorkspace')} />;
  if (denied) return <PermissionDenied title={t('assets.register.title')} />;

  return (
    <div className="fa">
      <SurfaceHeader
        title={t('assets.register.title')}
        help={<SurfaceHelp surface="FixedAssets" />}
        count={visible.length}
        actions={
          <button type="button" className="btn btn--primary" onClick={openCreate} disabled={!canWrite || noCategories}>
            {t('assets.register.new')}
          </button>
        }
      />

      <FilterBar
        searchValue={search}
        onSearchChange={setSearch}
        searchLabel={t('assets.register.searchPlaceholder')}
        searchPlaceholder={t('assets.register.searchPlaceholder')}
        active={search.trim() !== '' || categoryFilter !== '' || statusFilter !== ''}
        onClear={() => {
          setSearch('');
          setCategoryFilter('');
          setStatusFilter('');
        }}
        clearLabel={t('assets.register.filter.clear')}
        facets={[
          {
            key: 'category',
            label: t('assets.register.filter.category'),
            options: categories.map((c) => ({ value: c.id, label: `${c.code} ${c.name}` })),
            value: categoryFilter === '' ? null : categoryFilter,
            onChange: (value) => setCategoryFilter(value ?? ''),
          },
          {
            key: 'status',
            label: t('assets.register.filter.status'),
            options: ASSET_STATUSES.map((st) => ({ value: st, label: t(`assets.status.${st}`) })),
            value: statusFilter === '' ? null : statusFilter,
            onChange: (value) => setStatusFilter(value ?? ''),
          },
        ]}
      />

      {failed ? (
        <ErrorBanner message={t('assets.register.error.transport')} onRetry={() => void load()} />
      ) : (
        <DataTable
          columns={assetColumns}
          rows={visible}
          rowKey={(a) => a.id}
          caption={t('assets.register.title')}
          loading={loading}
          rowClassName={(a) => (a.status === 'archived' ? 'fa-row-archived' : undefined)}
          onRowClick={openAsset}
          rowLabel={(a) => t('assets.register.rowOpen', { number: a.number, name: a.name })}
          rowActions={assetActions}
          rowActionsLabel={(a) => t('assets.register.rowActionsFor', { number: a.number })}
          emptyState={
            <EmptyState
              title={noCategories ? t('assets.register.empty.noCatTitle') : t('assets.register.empty.title')}
              hint={noCategories ? t('assets.register.empty.noCatHint') : t('assets.register.empty.hint')}
              action={canWrite && !noCategories ? { label: t('assets.register.empty.cta'), onClick: openCreate } : undefined}
            />
          }
        />
      )}

      <DetailDrawer
        open={drawer !== 'closed'}
        onClose={closeDrawer}
        title={drawer === 'create' ? t('assets.register.form.createTitle') : t('assets.register.form.editTitle')}
        closeLabel={t('assets.common.close')}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={closeDrawer}>
              {t('assets.register.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void submit()}
              disabled={!canWrite || terminal || (drawer === 'create' && draft.categoryId === '')}
            >
              {t('assets.register.save')}
            </button>
          </>
        }
      >
        {editing !== null && (
          <p className="fa-hint">
            {t('assets.register.form.numberLabel')}: <strong>{editing.number}</strong> ·{' '}
            {t(`assets.status.${editing.status}`)}
          </p>
        )}
        {financialLocked && <div className="fa-locked-note">{t('assets.register.form.locked')}</div>}
        {writeError && <ErrorBanner error={writeError} />}

        {drawer === 'create' && (
            <Field label={t('assets.register.field.category')} id="fa-cat">
              <Select
                id="fa-cat"
                value={draft.categoryId}
                onChange={(value) => void onCategoryChange(value)}
                options={[
                  { value: '', label: t('assets.register.field.chooseCategory') },
                  ...categories.map((c) => ({ value: c.id, label: `${c.code} ${c.name}` })),
                ]}
                ariaLabel={t('assets.register.field.category')}
              />
            </Field>
          )}

          <Field label={t('assets.register.field.name')} id="fa-name">
            <input className="field" id="fa-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Field label={t('assets.register.field.acquired')} id="fa-date">
            <input className="field"
              id="fa-date"
              type="date"
              value={draft.acquisitionDate}
              disabled={financialLocked}
              onChange={(e) => setDraft({ ...draft, acquisitionDate: e.target.value })}
            />
          </Field>
          <Field label={t('assets.register.field.cost')} id="fa-cost">
            <input className="field"
              id="fa-cost"
              type="number"
              min={0}
              step="0.01"
              value={draft.costMajor}
              disabled={financialLocked}
              onChange={(e) => setDraft({ ...draft, costMajor: e.target.value })}
            />
          </Field>
          <Field label={t('assets.register.field.method')} id="fa-method">
            <Select
              id="fa-method"
              value={draft.depreciationMethod}
              disabled={financialLocked}
              onChange={(value) => setDraft({ ...draft, depreciationMethod: value as Method })}
              options={DEPRECIATION_METHODS.map((m) => ({ value: m, label: t(`assets.method.${m}`) }))}
              ariaLabel={t('assets.register.field.method')}
            />
          </Field>
          {draft.depreciationMethod !== 'none' && (
            <Field label={t('assets.register.field.life')} id="fa-life">
              <input className="field"
                id="fa-life"
                type="number"
                min={1}
                value={draft.usefulLifeMonths}
                disabled={financialLocked}
                onChange={(e) => setDraft({ ...draft, usefulLifeMonths: e.target.value })}
              />
            </Field>
          )}
          <Field label={t('assets.register.field.serial')} id="fa-serial">
            <input className="field"
              id="fa-serial"
              value={draft.serialNumber}
              onChange={(e) => setDraft({ ...draft, serialNumber: e.target.value })}
            />
          </Field>
          <Field label={t('assets.register.field.notes')} id="fa-notes">
            <input className="field" id="fa-notes" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
          </Field>
      </DetailDrawer>

      <Modal
        open={archiving !== null}
        role={ALERT_DIALOG}
        onClose={() => setArchiving(null)}
        title={t('assets.register.archive')}
        closeLabel={t('assets.common.close')}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setArchiving(null)}>
              {t('assets.register.cancel')}
            </button>
            <button type="button" className="btn btn--danger" onClick={() => void confirmArchive()}>
              {t('assets.register.archive')}
            </button>
          </>
        }
      >
        {archiving !== null && <p>{t('assets.register.confirmArchive', { number: archiving.number })}</p>}
        {writeError && <ErrorBanner error={writeError} />}
      </Modal>

      <DetailDrawer
        open={acquiring !== null}
        onClose={closeAcquire}
        title={acqIsPrimary ? t('assets.acquisition.recordTitle') : t('assets.acquisition.addTitle')}
        closeLabel={t('assets.common.close')}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={closeAcquire}>
              {t('assets.register.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--accent"
              data-money-commit="asset_acquire asset_add_capitalisation"
              onClick={() => void submitAcquire()}
              disabled={!canPost || acqDraft.date === '' || acqAmountRappen <= 0 || acqDraft.creditAccountId === ''}
            >
              {t('assets.acquisition.post')}
            </button>
          </>
        }
      >
        {acquiring !== null && (
          <p className="fa-hint">
            {t('assets.register.form.numberLabel')}: <strong>{acquiring.number}</strong> · {acquiring.name}
          </p>
        )}
        {writeError && <ErrorBanner error={writeError} />}

          <Field label={t('assets.acquisition.date')} id="fa-acq-date">
            <input className="field"
              id="fa-acq-date"
              type="date"
              value={acqDraft.date}
              onChange={(e) => setAcqDraft({ ...acqDraft, date: e.target.value })}
            />
          </Field>
          <Field label={acqIsPrimary ? t('assets.acquisition.cost') : t('assets.acquisition.amount')} id="fa-acq-amount">
            <input className="field"
              id="fa-acq-amount"
              type="number"
              min={0}
              step="0.01"
              value={acqDraft.amountMajor}
              onChange={(e) => setAcqDraft({ ...acqDraft, amountMajor: e.target.value })}
            />
          </Field>
          <Field label={t('assets.acquisition.creditAccount')} id="fa-acq-credit">
            <Select
              id="fa-acq-credit"
              value={acqDraft.creditAccountId}
              onChange={(value) => setAcqDraft({ ...acqDraft, creditAccountId: value })}
              options={[
                { value: '', label: t('assets.acquisition.chooseAccount') },
                ...creditAccounts.map((a) => ({ value: a.id, label: `${a.number} ${a.name}` })),
              ]}
              ariaLabel={t('assets.acquisition.creditAccount')}
            />
          </Field>
          {acqIsPrimary && (
            <Field label={t('assets.acquisition.residual')} id="fa-acq-residual">
              <input className="field"
                id="fa-acq-residual"
                type="number"
                min={0}
                step="0.01"
                value={acqDraft.residualMajor}
                onChange={(e) => setAcqDraft({ ...acqDraft, residualMajor: e.target.value })}
              />
            </Field>
          )}
          <Field label={t('assets.acquisition.description')} id="fa-acq-desc">
            <input className="field"
              id="fa-acq-desc"
              value={acqDraft.description}
              onChange={(e) => setAcqDraft({ ...acqDraft, description: e.target.value })}
            />
          </Field>

          <div className="fa-preview" aria-label={t('assets.acquisition.preview')}>
            <span className="fa-preview-title">{t('assets.acquisition.preview')}</span>
            <div className="fa-preview-line">
              <span>{t('assets.acquisition.debit')}</span>
              <span>{assetGlAccount ? `${assetGlAccount.number} ${assetGlAccount.name}` : '-'}</span>
              <span className="fa-num t-money">{money(acqAmountRappen)}</span>
            </div>
            <div className="fa-preview-line">
              <span>{t('assets.acquisition.credit')}</span>
              <span>{acqCreditAccount ? `${acqCreditAccount.number} ${acqCreditAccount.name}` : '-'}</span>
              <span className="fa-num t-money">{money(acqAmountRappen)}</span>
            </div>
          </div>
          {/* C4: the shared consequence sentence for the acquisition post. It renders nothing today,
              the verb carries no dial capability in command-source (NEEDS-ENGINE-DATA). */}
          <ConsequenceLine verb={acqIsPrimary ? 'asset_acquire' : 'asset_add_capitalisation'} />
      </DetailDrawer>

      {viewing !== null && (
        <DetailDrawer
          open
          onClose={() => setViewing(null)}
          title={t('assets.acquisition.transactions')}
          headerExtra={<IconButton icon="info" small context={t('assets.ledger.subtitle')} />}
          closeLabel={t('assets.common.close')}
          footer={
            <button type="button" className="btn btn--ghost" onClick={() => setViewing(null)}>
              {t('assets.register.cancel')}
            </button>
          }
        >
          <p className="fa-hint">
            {t('assets.register.form.numberLabel')}: <strong>{viewing.number}</strong> · {viewing.name}
          </p>
          {txns === null ? (
            <Skeleton rows={3} />
          ) : (
            <DataTable
              columns={ledgerColumns}
              rows={txns}
              rowKey={(tr) => tr.id}
              rowActions={ledgerActions}
              rowActionsLabel={(tr) => t('assets.ledger.reverseActionsLabel', { date: cal.date(tr.date) })}
              emptyState={<EmptyState title={t('assets.ledger.empty.title')} hint={t('assets.ledger.empty.hint')} />}
            />
          )}
        </DetailDrawer>
      )}

      {/* D170: taking an event back is a money-path correction, so it asks WHY first, in an alertdialog. */}
      <Modal
        open={reversingTxn !== null}
        role={ALERT_DIALOG}
        onClose={() => setReversingTxn(null)}
        title={reversingTxn === null ? '' : t('assets.ledger.reverseTitle', { type: t(`assets.acquisition.txnType.${reversingTxn.type}`), date: cal.date(reversingTxn.date) })}
        closeLabel={t('assets.common.close')}
        describedById="fa-reverse-body"
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setReversingTxn(null)}>
              {t('assets.ledger.reverseCancel')}
            </button>
            <button
              type="button"
              className="btn btn--danger"
              disabled={!canPost || reverseReason.trim() === '' || (overrideProceeds && overrideReason.trim() === '')}
              onClick={() => void confirmReverse()}
            >
              {t('assets.ledger.reverseConfirm')}
            </button>
          </>
        }
      >
        <div id="fa-reverse-body">
          <p>{t('assets.ledger.reverseBody')}</p>
          <ConsequenceLine verb={REVERSE_VERB} />
          {/* D191: the linked proceeds document still stands: name the order (undo the money act first). */}
          {reversingTxn?.type === 'disposal' && proceedsCheck === 'warn' && reversingTxn.proceedsDocumentStands === true && (
            <p role="status" className="fa-hint">{t('assets.ledger.proceedsStandsWarn')}</p>
          )}
          {reversingTxn?.type === 'disposal' &&
            ((proceedsCheck === 'refuse' && reversingTxn.proceedsDocumentStands === true) || writeError?.error === 'proceeds_settled') && (
            <div role="alert" className="fa-hint">
              <p>{t('assets.ledger.proceedsSettled')}</p>
              <label>
                <input type="checkbox" checked={overrideProceeds} onChange={(e) => setOverrideProceeds(e.target.checked)} />{' '}
                {t('assets.ledger.proceedsOverride')}
              </label>
              {overrideProceeds && (
                <Field label={t('assets.ledger.proceedsOverrideReason')} id="fa-reverse-override-reason">
                  <input className="field" id="fa-reverse-override-reason" value={overrideReason} maxLength={200} onChange={(e) => setOverrideReason(e.target.value)} />
                </Field>
              )}
            </div>
          )}
          {writeError && writeError.error !== 'proceeds_settled' && <ErrorBanner error={writeError} />}
          <Field label={t('assets.ledger.reverseReason')} id="fa-reverse-reason">
            <input className="field"
              id="fa-reverse-reason"
              type="text"
              value={reverseReason}
              maxLength={200}
              onChange={(e) => setReverseReason(e.target.value)}
            />
          </Field>
        </div>
      </Modal>

      {transferring !== null && (
        <DetailDrawer
          open
          onClose={closeTransfer}
          title={t('assets.transfer.title')}
          closeLabel={t('assets.common.close')}
          footer={
            <>
              <button type="button" className="btn btn--ghost" onClick={closeTransfer}>
                {t('assets.register.cancel')}
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void submitTransfer()}
                disabled={!canWrite || !transferValid}
              >
                {t('assets.transfer.confirm')}
              </button>
            </>
          }
        >
          <p className="fa-hint">
            {t('assets.register.form.numberLabel')}: <strong>{transferring.number}</strong> · {transferring.name}
          </p>
          <p className="fa-hint">{t('assets.transfer.nonPosting')}</p>
          {writeError && <ErrorBanner error={writeError} />}

          <Field label={t('assets.transfer.toLocation')} id="fa-trf-loc">
            <Select
              id="fa-trf-loc"
              value={transferDraft.toLocationId}
              onChange={(value) => setTransferDraft({ ...transferDraft, toLocationId: value })}
              options={[
                { value: '', label: t('assets.transfer.keepLocation') },
                ...locations.map((l) => ({ value: l.id, label: `${l.code} ${l.name}` })),
              ]}
              ariaLabel={t('assets.transfer.toLocation')}
            />
          </Field>
          <Field label={t('assets.transfer.toResponsible')} id="fa-trf-resp">
            <input className="field"
              id="fa-trf-resp"
              value={transferDraft.toResponsibleUserId}
              onChange={(e) => setTransferDraft({ ...transferDraft, toResponsibleUserId: e.target.value })}
            />
          </Field>
          <Field label={t('assets.transfer.effectiveDate')} id="fa-trf-date">
            <input className="field"
              id="fa-trf-date"
              type="date"
              value={transferDraft.effectiveDate}
              onChange={(e) => setTransferDraft({ ...transferDraft, effectiveDate: e.target.value })}
            />
          </Field>
          <Field label={t('assets.transfer.reason')} id="fa-trf-reason">
            <input className="field"
              id="fa-trf-reason"
              value={transferDraft.reason}
              onChange={(e) => setTransferDraft({ ...transferDraft, reason: e.target.value })}
            />
          </Field>

          <h3 className="fa-drawer-subtitle">{t('assets.transfer.history')}</h3>
          {history === null ? (
            <Skeleton rows={2} />
          ) : (
            <DataTable
              columns={transferHistoryColumns}
              rows={history}
              rowKey={(h) => h.id}
              emptyState={<EmptyState title={t('assets.transfer.empty.title')} hint={t('assets.transfer.empty.hint')} />}
            />
          )}
        </DetailDrawer>
      )}

      {disposing !== null && (
        <DetailDrawer
          open
          onClose={closeDispose}
          title={t('assets.disposal.title')}
          closeLabel={t('assets.common.close')}
          footer={
            <>
              <button type="button" className="btn btn--ghost" onClick={closeDispose}>
                {t('assets.register.cancel')}
              </button>
              <button
                type="button"
                className="btn btn--accent"
                data-money-commit="asset_dispose"
                onClick={() => void submitDispose()}
                disabled={!canPost || !disposeValid}
              >
                {t('assets.disposal.post')}
              </button>
            </>
          }
        >
          <p className="fa-hint">
            {t('assets.register.form.numberLabel')}: <strong>{disposing.number}</strong> · {disposing.name}
          </p>
          <p className="fa-hint">{t('assets.disposal.explainer')}</p>
          {writeError && <ErrorBanner error={writeError} />}

          <Field
            label={t('assets.disposal.date')}
            id="fa-disp-date"
            error={dispPreviewError?.field === 'date' ? t(dispPreviewError.key) : undefined}
          >
            <input className="field"
              id="fa-disp-date"
              type="date"
              value={dispDraft.disposalDate}
              onChange={(e) => {
                setDispDateTouched(true);
                setDispDraft({ ...dispDraft, disposalDate: e.target.value });
              }}
            />
          </Field>
          <Field
            label={t('assets.disposal.proceedsDoc')}
            id="fa-disp-proceeds-doc"
            info={
              dispDraft.proceedsDoc === ''
                ? t('assets.disposal.proceedsDocNone')
                : dispDerived
                  ? t('assets.disposal.proceedsDocClears')
                  : t('assets.disposal.proceedsDocLinked')
            }
            error={dispPreviewError?.field === 'doc' ? t(dispPreviewError.key) : undefined}
          >
            <Select
              id="fa-disp-proceeds-doc"
              value={dispDraft.proceedsDoc}
              onChange={(value) => setDispDraft({ ...dispDraft, proceedsDoc: value })}
              options={[{ value: '', label: t('assets.disposal.proceedsDocNoneOption') }, ...proceedsChoices.map((o) => ({ value: o.key, label: o.label }))]}
              ariaLabel={t('assets.disposal.proceedsDoc')}
            />
          </Field>
          {!dispDerived && (
          <Field label={t('assets.disposal.proceeds')} id="fa-disp-proceeds">
            <input className="field"
              id="fa-disp-proceeds"
              type="number"
              min={0}
              step="0.01"
              value={dispDraft.proceedsMajor}
              onChange={(e) => setDispDraft({ ...dispDraft, proceedsMajor: e.target.value })}
            />
          </Field>
          )}
          {!dispDerived && dispProceedsRappen > 0 && (
            <Field label={t('assets.disposal.proceedsAccount')} id="fa-disp-proceeds-acc">
              <Select
                id="fa-disp-proceeds-acc"
                value={dispDraft.proceedsAccountId}
                onChange={(value) => setDispDraft({ ...dispDraft, proceedsAccountId: value })}
                options={[
                  { value: '', label: t('assets.disposal.chooseAccount') },
                  ...proceedsAccounts.map((a) => ({ value: a.id, label: `${a.number} ${a.name}` })),
                ]}
                ariaLabel={t('assets.disposal.proceedsAccount')}
              />
            </Field>
          )}
          <Field label={t('assets.disposal.gainLossAccount')} id="fa-disp-gl-acc">
            <Select
              id="fa-disp-gl-acc"
              value={dispDraft.gainLossAccountId}
              onChange={(value) => setDispDraft({ ...dispDraft, gainLossAccountId: value })}
              options={[
                { value: '', label: t('assets.disposal.chooseAccount') },
                ...gainLossAccounts.map((a) => ({ value: a.id, label: `${a.number} ${a.name}` })),
              ]}
              ariaLabel={t('assets.disposal.gainLossAccount')}
            />
          </Field>
          <Field label={t('assets.disposal.reason')} id="fa-disp-reason">
            <input className="field"
              id="fa-disp-reason"
              value={dispDraft.reason}
              onChange={(e) => setDispDraft({ ...dispDraft, reason: e.target.value })}
            />
          </Field>
          <Field label={t('assets.disposal.counterparty')} id="fa-disp-counterparty">
            <input className="field"
              id="fa-disp-counterparty"
              value={dispDraft.counterparty}
              onChange={(e) => setDispDraft({ ...dispDraft, counterparty: e.target.value })}
            />
          </Field>

          {dispPreview !== null && (
            <div className="fa-preview" aria-label={t('assets.disposal.preview')}>
              <span className="fa-preview-title">{t('assets.disposal.preview')}</span>
              <div className="fa-preview-line">
                <span>{t('assets.disposal.cost')}</span>
                <span />
                <span className="fa-num t-money">{money(dispPreview.acquisitionCostRappen)}</span>
              </div>
              <div className="fa-preview-line">
                <span>{t('assets.disposal.accumulated')}</span>
                <span />
                <span className="fa-num t-money">{money(dispPreview.accumulatedDeprRappen)}</span>
              </div>
              <div className="fa-preview-line">
                <span>{t('assets.disposal.nbv')}</span>
                <span />
                <span className="fa-num t-money">{money(dispPreview.netBookValueRappen)}</span>
              </div>
              {dispPreview.proceedsFromDocument && (
                <div className="fa-preview-line" data-testid="fa-disp-derived">
                  <span>{t('assets.disposal.proceedsFromInvoice')}</span>
                  <span>{dispPreview.proceedsAccountLabel}</span>
                  <span className="fa-num t-money">{money(dispPreview.proceedsRappen)}</span>
                </div>
              )}
              <div className="fa-preview-line">
                <span>{dispPreview.gainLossRappen >= 0 ? t('assets.disposal.gain') : t('assets.disposal.loss')}</span>
                <span />
                <span className={`fa-num t-money ${dispPreview.gainLossRappen >= 0 ? 'fa-gain' : 'fa-loss'}`}>
                  {money(Math.abs(dispPreview.gainLossRappen))}
                </span>
              </div>
              {dispPreview.warnings.map((w) => (
                <p className="fa-hint" key={w}>{t(`assets.disposal.warning.${w}`)}</p>
              ))}
              <span className="fa-preview-title">{t('assets.disposal.journalPreview')}</span>
              {dispPreview.lines.map((l, i) => (
                <div className="fa-preview-line" key={`${l.accountNumber}-${i}`}>
                  <span>{l.debitRappen > 0 ? t('assets.acquisition.debit') : t('assets.acquisition.credit')}</span>
                  <span>
                    {l.accountNumber} {l.accountName}
                  </span>
                  <span className="fa-num t-money">{money(l.debitRappen > 0 ? l.debitRappen : l.creditRappen)}</span>
                </div>
              ))}
              {dispPreview.abgrenzung !== null && (
                <>
                  <span className="fa-preview-title" data-testid="fa-disp-abgrenzung">
                    {t('assets.disposal.abgrenzung', { date: formatDate(dispPreview.abgrenzung.periodEnd), reversal: formatDate(dispPreview.abgrenzung.reversalDate) })}
                  </span>
                  {dispPreview.abgrenzung.lines.map((l, i) => (
                    <div className="fa-preview-line" key={`abg-${l.accountNumber}-${i}`}>
                      <span>{l.debitRappen > 0 ? t('assets.acquisition.debit') : t('assets.acquisition.credit')}</span>
                      <span>
                        {l.accountNumber} {l.accountName}
                      </span>
                      <span className="fa-num t-money">{money(l.debitRappen > 0 ? l.debitRappen : l.creditRappen)}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
          {/* C4: the shared consequence sentence for the disposal post. It renders nothing today, the
              verb carries no dial capability in command-source (NEEDS-ENGINE-DATA). The journal preview
              above is the operator's review; dialing the verb lights this sentence up too. */}
          <ConsequenceLine verb={DISPOSE_VERB} />
        </DetailDrawer>
      )}

      {opening !== null && (
        <DetailDrawer
          open
          onClose={closeOpening}
          title={t('assets.ledger.openingTitle')}
          closeLabel={t('assets.common.close')}
          footer={
            <>
              <button type="button" className="btn btn--ghost" onClick={closeOpening}>
                {t('assets.register.cancel')}
              </button>
              <button
                type="button"
                className="btn btn--accent"
                data-money-commit="asset_opening_balance"
                onClick={() => void submitOpening()}
                disabled={!canPost || !openingValid}
              >
                {t('assets.ledger.post')}
              </button>
            </>
          }
        >
          <p className="fa-hint">
            {t('assets.register.form.numberLabel')}: <strong>{opening.number}</strong> · {opening.name}
          </p>
          <p className="fa-hint">{t('assets.ledger.openingHint')}</p>
          {writeError && <ErrorBanner error={writeError} />}

          <Field label={t('assets.ledger.date')} id="fa-open-date">
            <input className="field"
              id="fa-open-date"
              type="date"
              value={openDraft.date}
              onChange={(e) => setOpenDraft({ ...openDraft, date: e.target.value })}
            />
          </Field>
          <Field label={t('assets.ledger.cost')} id="fa-open-cost">
            <input className="field"
              id="fa-open-cost"
              type="number"
              min={0}
              step="0.01"
              value={openDraft.costMajor}
              onChange={(e) => setOpenDraft({ ...openDraft, costMajor: e.target.value })}
            />
          </Field>
          <Field label={t('assets.ledger.accumulated')} id="fa-open-accum">
            <input className="field"
              id="fa-open-accum"
              type="number"
              min={0}
              step="0.01"
              value={openDraft.accumulatedMajor}
              onChange={(e) => setOpenDraft({ ...openDraft, accumulatedMajor: e.target.value })}
            />
          </Field>
          {openNbvRappen > 0 && (
            <Field label={t('assets.ledger.offsetAccount')} id="fa-open-offset">
              <Select
                id="fa-open-offset"
                value={openDraft.offsetAccountId}
                onChange={(value) => setOpenDraft({ ...openDraft, offsetAccountId: value })}
                options={[
                  { value: '', label: t('assets.ledger.chooseAccount') },
                  ...equityAccounts.map((a) => ({ value: a.id, label: `${a.number} ${a.name}` })),
                ]}
                ariaLabel={t('assets.ledger.offsetAccount')}
              />
            </Field>
          )}
          <Field label={t('assets.ledger.description')} id="fa-open-desc">
            <input className="field"
              id="fa-open-desc"
              value={openDraft.description}
              onChange={(e) => setOpenDraft({ ...openDraft, description: e.target.value })}
            />
          </Field>

          <div className="fa-preview" aria-label={t('assets.acquisition.preview')}>
            <div className="fa-preview-line">
              <span>{t('assets.ledger.nbv')}</span>
              <span />
              <span className="fa-num t-money">{money(openNbvRappen)}</span>
            </div>
          </div>
          {/* C4: the shared consequence sentence for the opening-balance post. It renders nothing
              today, the verb carries no dial capability in command-source (NEEDS-ENGINE-DATA). */}
          <ConsequenceLine verb="asset_opening_balance" />
        </DetailDrawer>
      )}
    </div>
  );
}

// A default export too, so `router.tsx` imports it with the same plain `import X from '...'` shape
// the orientation generator recognises as a routed surface component.
export default AssetRegister;
