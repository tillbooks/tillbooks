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
import { useWorkspaceId } from '../../app/workspace';
import { formatMoney, useT } from '../../i18n';
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
}

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
    }))
    .filter((tr) => tr.id !== '');
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
    },
    [client, workspaceId],
  );

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
  };
  const closeDispose = () => {
    setDisposing(null);
    setDispDraft(EMPTY_DISPOSE);
    setDispPreview(null);
  };

  const dispProceedsRappen = Math.round(Number(dispDraft.proceedsMajor.trim() || '0') * 100);
  // A preview is requestable once the engine has what it needs: a valid date, a gain/loss account, a
  // non-negative integer proceeds, and (only when proceeds are received) a proceeds account.
  const dispPreviewable =
    disposing !== null &&
    dispDraft.disposalDate !== '' &&
    dispDraft.gainLossAccountId !== '' &&
    Number.isFinite(dispProceedsRappen) &&
    dispProceedsRappen >= 0 &&
    (dispProceedsRappen === 0 || dispDraft.proceedsAccountId !== '');

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
        proceedsRappen: dispProceedsRappen,
        proceedsAccountId: dispProceedsRappen > 0 ? dispDraft.proceedsAccountId : undefined,
        gainLossAccountId: dispDraft.gainLossAccountId,
      });
      if (cancelled) return;
      setDispPreview(isErr(res.body) ? null : parseDisposalPreview(res.body));
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
    dispDraft.disposalDate,
    dispDraft.proceedsAccountId,
    dispDraft.gainLossAccountId,
  ]);

  const submitDispose = useCallback(async () => {
    if (disposing === null) return;
    const proceeds = Math.round(Number(dispDraft.proceedsMajor.trim() || '0') * 100);
    const ok = await write('asset_dispose', {
      assetId: disposing.id,
      disposalDate: dispDraft.disposalDate,
      proceedsRappen: proceeds,
      proceedsAccountId: proceeds > 0 ? dispDraft.proceedsAccountId : undefined,
      gainLossAccountId: dispDraft.gainLossAccountId,
      reason: dispDraft.reason.trim() === '' ? undefined : dispDraft.reason.trim(),
      counterpartyName: dispDraft.counterparty.trim() === '' ? undefined : dispDraft.counterparty.trim(),
      idempotencyKey: newKey(),
    });
    if (ok) closeDispose();
  }, [write, disposing, dispDraft]);

  const disposeValid =
    disposing !== null &&
    dispDraft.disposalDate !== '' &&
    dispDraft.gainLossAccountId !== '' &&
    dispProceedsRappen >= 0 &&
    (dispProceedsRappen === 0 || dispDraft.proceedsAccountId !== '');

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
    { key: 'number', header: t('assets.register.col.number'), render: (a) => <span className="fa-code">{a.number}</span> },
    { key: 'name', header: t('assets.register.col.name'), render: (a) => a.name },
    { key: 'category', header: t('assets.register.col.category'), render: (a) => catById.get(a.categoryId)?.code ?? '-' },
    {
      key: 'status',
      header: t('assets.register.col.status'),
      render: (a) => <span className={`fa-badge fa-badge-${a.status}`}>{t(`assets.status.${a.status}`)}</span>,
    },
    { key: 'acquired', header: t('assets.register.col.acquired'), render: (a) => a.acquisitionDate },
    { key: 'cost', header: t('assets.register.col.cost'), numeric: true, render: (a) => money(a.acquisitionCostRappen) },
    { key: 'nbv', header: t('assets.register.col.nbv'), numeric: true, render: (a) => money(a.netBookValueRappen) },
    {
      key: 'actions',
      header: t('assets.register.col.actions'),
      headerHidden: true,
      align: 'end',
      render: (a) => (
        <div className="fa-row-actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => openEdit(a)} disabled={!canWrite}>
            {t('assets.register.edit')}
          </button>
          {a.status === 'draft' && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => openAcquire(a)} disabled={!canPost}>
              {t('assets.acquisition.record')}
            </button>
          )}
          {a.status === 'draft' && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => openOpening(a)} disabled={!canPost}>
              {t('assets.ledger.openingBalance')}
            </button>
          )}
          {(a.status === 'active' || a.status === 'fully_depreciated') && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => openAcquire(a)}
              disabled={!canPost || a.status === 'fully_depreciated'}
            >
              {t('assets.acquisition.addCapitalisation')}
            </button>
          )}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void openTxns(a)}>
            {t('assets.acquisition.transactions')}
          </button>
          {a.status !== 'disposed' && a.status !== 'archived' && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void openTransfer(a)} disabled={!canWrite}>
              {t('assets.transfer.action')}
            </button>
          )}
          {(a.status === 'active' || a.status === 'fully_depreciated') && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => openDispose(a)} disabled={!canPost}>
              {t('assets.disposal.action')}
            </button>
          )}
          {(a.status === 'draft' || a.status === 'fully_depreciated') && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setWriteError(null);
                setArchiving(a);
              }}
              disabled={!canWrite}
            >
              {t('assets.register.archive')}
            </button>
          )}
        </div>
      ),
    },
  ];

  // H07 per-asset ledger: every running balance renders VERBATIM from asset_ledger_get.
  const ledgerColumns: DataTableColumn<LedgerEvent>[] = [
    { key: 'date', header: t('assets.ledger.col.date'), render: (tr) => tr.date },
    {
      key: 'type',
      header: t('assets.ledger.col.type'),
      render: (tr) => (
        <span className={`fa-badge fa-badge-${tr.type === 'disposal' ? 'disposed' : 'posted'}`}>
          {t(`assets.acquisition.txnType.${tr.type}`)}
        </span>
      ),
    },
    { key: 'deltaCost', header: t('assets.ledger.col.deltaCost'), numeric: true, render: (tr) => (tr.deltaCostRappen === 0 ? '-' : money(tr.deltaCostRappen)) },
    { key: 'deltaAccum', header: t('assets.ledger.col.deltaAccum'), numeric: true, render: (tr) => (tr.deltaAccumDeprRappen === 0 ? '-' : money(tr.deltaAccumDeprRappen)) },
    { key: 'nbv', header: t('assets.ledger.col.nbv'), numeric: true, render: (tr) => money(tr.netBookValueAfterRappen) },
    { key: 'journal', header: t('assets.ledger.col.journal'), render: (tr) => <span className="fa-code">{tr.journalEntryId || '-'}</span> },
  ];

  const transferHistoryColumns: DataTableColumn<AssetTransferRow>[] = [
    { key: 'date', header: t('assets.transfer.col.date'), render: (h) => h.date },
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
      >
        <select
          aria-label={t('assets.register.filter.category')}
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
        >
          <option value="">{t('assets.register.filter.allCategories')}</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} {c.name}
            </option>
          ))}
        </select>
        <select
          aria-label={t('assets.register.filter.status')}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">{t('assets.register.filter.allStatuses')}</option>
          {ASSET_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`assets.status.${s}`)}
            </option>
          ))}
        </select>
      </FilterBar>

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
            <div className="fa-field">
              <label htmlFor="fa-cat">{t('assets.register.field.category')}</label>
              <select id="fa-cat" value={draft.categoryId} onChange={(e) => void onCategoryChange(e.target.value)}>
                <option value="">{t('assets.register.field.chooseCategory')}</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="fa-field">
            <label htmlFor="fa-name">{t('assets.register.field.name')}</label>
            <input id="fa-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div className="fa-field">
            <label htmlFor="fa-date">{t('assets.register.field.acquired')}</label>
            <input
              id="fa-date"
              type="date"
              value={draft.acquisitionDate}
              disabled={financialLocked}
              onChange={(e) => setDraft({ ...draft, acquisitionDate: e.target.value })}
            />
          </div>
          <div className="fa-field">
            <label htmlFor="fa-cost">{t('assets.register.field.cost')}</label>
            <input
              id="fa-cost"
              type="number"
              min={0}
              step="0.01"
              value={draft.costMajor}
              disabled={financialLocked}
              onChange={(e) => setDraft({ ...draft, costMajor: e.target.value })}
            />
          </div>
          <div className="fa-field">
            <label htmlFor="fa-method">{t('assets.register.field.method')}</label>
            <select
              id="fa-method"
              value={draft.depreciationMethod}
              disabled={financialLocked}
              onChange={(e) => setDraft({ ...draft, depreciationMethod: e.target.value as Method })}
            >
              {DEPRECIATION_METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`assets.method.${m}`)}
                </option>
              ))}
            </select>
          </div>
          {draft.depreciationMethod !== 'none' && (
            <div className="fa-field">
              <label htmlFor="fa-life">{t('assets.register.field.life')}</label>
              <input
                id="fa-life"
                type="number"
                min={1}
                value={draft.usefulLifeMonths}
                disabled={financialLocked}
                onChange={(e) => setDraft({ ...draft, usefulLifeMonths: e.target.value })}
              />
            </div>
          )}
          <div className="fa-field">
            <label htmlFor="fa-serial">{t('assets.register.field.serial')}</label>
            <input
              id="fa-serial"
              value={draft.serialNumber}
              onChange={(e) => setDraft({ ...draft, serialNumber: e.target.value })}
            />
          </div>
          <div className="fa-field">
            <label htmlFor="fa-notes">{t('assets.register.field.notes')}</label>
            <input id="fa-notes" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
          </div>
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
              className="btn btn--primary"
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

          <div className="fa-field">
            <label htmlFor="fa-acq-date">{t('assets.acquisition.date')}</label>
            <input
              id="fa-acq-date"
              type="date"
              value={acqDraft.date}
              onChange={(e) => setAcqDraft({ ...acqDraft, date: e.target.value })}
            />
          </div>
          <div className="fa-field">
            <label htmlFor="fa-acq-amount">{acqIsPrimary ? t('assets.acquisition.cost') : t('assets.acquisition.amount')}</label>
            <input
              id="fa-acq-amount"
              type="number"
              min={0}
              step="0.01"
              value={acqDraft.amountMajor}
              onChange={(e) => setAcqDraft({ ...acqDraft, amountMajor: e.target.value })}
            />
          </div>
          <div className="fa-field">
            <label htmlFor="fa-acq-credit">{t('assets.acquisition.creditAccount')}</label>
            <select
              id="fa-acq-credit"
              value={acqDraft.creditAccountId}
              onChange={(e) => setAcqDraft({ ...acqDraft, creditAccountId: e.target.value })}
            >
              <option value="">{t('assets.acquisition.chooseAccount')}</option>
              {creditAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.number} {a.name}
                </option>
              ))}
            </select>
          </div>
          {acqIsPrimary && (
            <div className="fa-field">
              <label htmlFor="fa-acq-residual">{t('assets.acquisition.residual')}</label>
              <input
                id="fa-acq-residual"
                type="number"
                min={0}
                step="0.01"
                value={acqDraft.residualMajor}
                onChange={(e) => setAcqDraft({ ...acqDraft, residualMajor: e.target.value })}
              />
            </div>
          )}
          <div className="fa-field">
            <label htmlFor="fa-acq-desc">{t('assets.acquisition.description')}</label>
            <input
              id="fa-acq-desc"
              value={acqDraft.description}
              onChange={(e) => setAcqDraft({ ...acqDraft, description: e.target.value })}
            />
          </div>

          <div className="fa-preview" aria-label={t('assets.acquisition.preview')}>
            <span className="fa-preview-title">{t('assets.acquisition.preview')}</span>
            <div className="fa-preview-line">
              <span>{t('assets.acquisition.debit')}</span>
              <span>{assetGlAccount ? `${assetGlAccount.number} ${assetGlAccount.name}` : '-'}</span>
              <span className="fa-num">{money(acqAmountRappen)}</span>
            </div>
            <div className="fa-preview-line">
              <span>{t('assets.acquisition.credit')}</span>
              <span>{acqCreditAccount ? `${acqCreditAccount.number} ${acqCreditAccount.name}` : '-'}</span>
              <span className="fa-num">{money(acqAmountRappen)}</span>
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
          <p className="fa-hint">{t('assets.ledger.subtitle')}</p>
          {txns === null ? (
            <Skeleton rows={3} />
          ) : (
            <DataTable
              columns={ledgerColumns}
              rows={txns}
              rowKey={(tr) => tr.id}
              emptyState={<EmptyState title={t('assets.ledger.empty.title')} hint={t('assets.ledger.empty.hint')} />}
            />
          )}
        </DetailDrawer>
      )}

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

          <div className="fa-field">
            <label htmlFor="fa-trf-loc">{t('assets.transfer.toLocation')}</label>
            <select
              id="fa-trf-loc"
              value={transferDraft.toLocationId}
              onChange={(e) => setTransferDraft({ ...transferDraft, toLocationId: e.target.value })}
            >
              <option value="">{t('assets.transfer.keepLocation')}</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.code} {l.name}
                </option>
              ))}
            </select>
          </div>
          <div className="fa-field">
            <label htmlFor="fa-trf-resp">{t('assets.transfer.toResponsible')}</label>
            <input
              id="fa-trf-resp"
              value={transferDraft.toResponsibleUserId}
              onChange={(e) => setTransferDraft({ ...transferDraft, toResponsibleUserId: e.target.value })}
            />
          </div>
          <div className="fa-field">
            <label htmlFor="fa-trf-date">{t('assets.transfer.effectiveDate')}</label>
            <input
              id="fa-trf-date"
              type="date"
              value={transferDraft.effectiveDate}
              onChange={(e) => setTransferDraft({ ...transferDraft, effectiveDate: e.target.value })}
            />
          </div>
          <div className="fa-field">
            <label htmlFor="fa-trf-reason">{t('assets.transfer.reason')}</label>
            <input
              id="fa-trf-reason"
              value={transferDraft.reason}
              onChange={(e) => setTransferDraft({ ...transferDraft, reason: e.target.value })}
            />
          </div>

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
                className="btn btn--danger"
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

          <div className="fa-field">
            <label htmlFor="fa-disp-date">{t('assets.disposal.date')}</label>
            <input
              id="fa-disp-date"
              type="date"
              value={dispDraft.disposalDate}
              onChange={(e) => setDispDraft({ ...dispDraft, disposalDate: e.target.value })}
            />
          </div>
          <div className="fa-field">
            <label htmlFor="fa-disp-proceeds">{t('assets.disposal.proceeds')}</label>
            <input
              id="fa-disp-proceeds"
              type="number"
              min={0}
              step="0.01"
              value={dispDraft.proceedsMajor}
              onChange={(e) => setDispDraft({ ...dispDraft, proceedsMajor: e.target.value })}
            />
          </div>
          {dispProceedsRappen > 0 && (
            <div className="fa-field">
              <label htmlFor="fa-disp-proceeds-acc">{t('assets.disposal.proceedsAccount')}</label>
              <select
                id="fa-disp-proceeds-acc"
                value={dispDraft.proceedsAccountId}
                onChange={(e) => setDispDraft({ ...dispDraft, proceedsAccountId: e.target.value })}
              >
                <option value="">{t('assets.disposal.chooseAccount')}</option>
                {proceedsAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.number} {a.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="fa-field">
            <label htmlFor="fa-disp-gl-acc">{t('assets.disposal.gainLossAccount')}</label>
            <select
              id="fa-disp-gl-acc"
              value={dispDraft.gainLossAccountId}
              onChange={(e) => setDispDraft({ ...dispDraft, gainLossAccountId: e.target.value })}
            >
              <option value="">{t('assets.disposal.chooseAccount')}</option>
              {gainLossAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.number} {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="fa-field">
            <label htmlFor="fa-disp-reason">{t('assets.disposal.reason')}</label>
            <input
              id="fa-disp-reason"
              value={dispDraft.reason}
              onChange={(e) => setDispDraft({ ...dispDraft, reason: e.target.value })}
            />
          </div>
          <div className="fa-field">
            <label htmlFor="fa-disp-counterparty">{t('assets.disposal.counterparty')}</label>
            <input
              id="fa-disp-counterparty"
              value={dispDraft.counterparty}
              onChange={(e) => setDispDraft({ ...dispDraft, counterparty: e.target.value })}
            />
          </div>

          {dispPreview !== null && (
            <div className="fa-preview" aria-label={t('assets.disposal.preview')}>
              <span className="fa-preview-title">{t('assets.disposal.preview')}</span>
              <div className="fa-preview-line">
                <span>{t('assets.disposal.cost')}</span>
                <span />
                <span className="fa-num">{money(dispPreview.acquisitionCostRappen)}</span>
              </div>
              <div className="fa-preview-line">
                <span>{t('assets.disposal.accumulated')}</span>
                <span />
                <span className="fa-num">{money(dispPreview.accumulatedDeprRappen)}</span>
              </div>
              <div className="fa-preview-line">
                <span>{t('assets.disposal.nbv')}</span>
                <span />
                <span className="fa-num">{money(dispPreview.netBookValueRappen)}</span>
              </div>
              <div className="fa-preview-line">
                <span>{dispPreview.gainLossRappen >= 0 ? t('assets.disposal.gain') : t('assets.disposal.loss')}</span>
                <span />
                <span className={`fa-num ${dispPreview.gainLossRappen >= 0 ? 'fa-gain' : 'fa-loss'}`}>
                  {money(Math.abs(dispPreview.gainLossRappen))}
                </span>
              </div>
              <span className="fa-preview-title">{t('assets.disposal.journalPreview')}</span>
              {dispPreview.lines.map((l, i) => (
                <div className="fa-preview-line" key={`${l.accountNumber}-${i}`}>
                  <span>{l.debitRappen > 0 ? t('assets.acquisition.debit') : t('assets.acquisition.credit')}</span>
                  <span>
                    {l.accountNumber} {l.accountName}
                  </span>
                  <span className="fa-num">{money(l.debitRappen > 0 ? l.debitRappen : l.creditRappen)}</span>
                </div>
              ))}
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
                className="btn btn--primary"
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

          <div className="fa-field">
            <label htmlFor="fa-open-date">{t('assets.ledger.date')}</label>
            <input
              id="fa-open-date"
              type="date"
              value={openDraft.date}
              onChange={(e) => setOpenDraft({ ...openDraft, date: e.target.value })}
            />
          </div>
          <div className="fa-field">
            <label htmlFor="fa-open-cost">{t('assets.ledger.cost')}</label>
            <input
              id="fa-open-cost"
              type="number"
              min={0}
              step="0.01"
              value={openDraft.costMajor}
              onChange={(e) => setOpenDraft({ ...openDraft, costMajor: e.target.value })}
            />
          </div>
          <div className="fa-field">
            <label htmlFor="fa-open-accum">{t('assets.ledger.accumulated')}</label>
            <input
              id="fa-open-accum"
              type="number"
              min={0}
              step="0.01"
              value={openDraft.accumulatedMajor}
              onChange={(e) => setOpenDraft({ ...openDraft, accumulatedMajor: e.target.value })}
            />
          </div>
          {openNbvRappen > 0 && (
            <div className="fa-field">
              <label htmlFor="fa-open-offset">{t('assets.ledger.offsetAccount')}</label>
              <select
                id="fa-open-offset"
                value={openDraft.offsetAccountId}
                onChange={(e) => setOpenDraft({ ...openDraft, offsetAccountId: e.target.value })}
              >
                <option value="">{t('assets.ledger.chooseAccount')}</option>
                {equityAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.number} {a.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="fa-field">
            <label htmlFor="fa-open-desc">{t('assets.ledger.description')}</label>
            <input
              id="fa-open-desc"
              value={openDraft.description}
              onChange={(e) => setOpenDraft({ ...openDraft, description: e.target.value })}
            />
          </div>

          <div className="fa-preview" aria-label={t('assets.acquisition.preview')}>
            <div className="fa-preview-line">
              <span>{t('assets.ledger.nbv')}</span>
              <span />
              <span className="fa-num">{money(openNbvRappen)}</span>
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
