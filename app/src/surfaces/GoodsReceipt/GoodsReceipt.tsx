/**
 * I02, Einkauf -> Wareneingänge (`/goods-receipts`): the surface over the goods-receipt document.
 *
 * Left, the receipts with their status, order, supplier, date and value. Right, the selected one:
 * its lines with the quantity, the unit-cost snapshot, the location, the inspection state and the
 * J02 movement each recognised line minted, plus the pure impact preview and the actions the
 * document's state allows. A draft is editable and postable; a posted one is READ-ONLY and can only
 * be reversed or have its held lines accepted / rejected; a reversed or cancelled one is inert.
 *
 * WHY THERE IS NO DATE FIELD ON THE POST BUTTON. The receipt carries ONE date, set when it is
 * opened, and every stock movement it writes is stamped with it. The engine asserts that period is
 * open at post, at accept and at reverse, so a sealed year cannot be back-charged by re-dating a
 * posting. Offering a date here would imply a choice the engine deliberately does not give.
 *
 * Status is glyph + label, never colour alone (WCAG 2.2 AA); no new colour token (design-canon).
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118 B2, 2026-08-24)
 *
 * The receipt master list and the line table are the shared `DataTable` now (frame overflow, sticky
 * header, density and the five states in one place), instead of a bespoke `<ul>` of buttons and a
 * hand-rolled `<table>`. The page header is the shared `SurfaceHeader`, and the create and add-line
 * overlays are the shared `DetailDrawer` (focus trap, Escape, independent body scroll). The
 * per-surface CSS that duplicated all of that is gone; what remains in GoodsReceipt.css is genuinely
 * surface-specific (the master-detail layout, the status/inspection badges, the selection and
 * over-delivery row cues, the mono movement cell, the over-receipt/issue markers, the audit trail,
 * the hold panel and the drawer form fields). There is no FilterBar: this surface has no search or
 * filter row, and the B2 rule is not to invent one. The C3 Provenance line (added P1.8) is preserved.
 *
 * C4 (ConsequenceLine) is NOT adopted here: no goods_receipt verb carries a non-null `dialCapability`
 * in `command-source.generated.json`, and the state actions (post, cancel, reverse) fire directly
 * without a destructive confirm dialog to host a consequence sentence.
 *
 * THE PERMISSION GATE HERE IS A CONVENIENCE (the standing Studio rule): capabilities fail open and
 * the engine is the real gate. Write controls disable behind `manage_master_data`; a click that
 * slips through still surfaces the engine's own `permission_denied`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { formatMoney, useT } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { DetailDrawer } from '../../components/DetailDrawer';
import { Provenance } from '../../components/Provenance';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import './GoodsReceipt.css';

/** Glyph AND label, never colour alone (design-canon, WCAG 2.2). */
const STATUS_GLYPH: Record<string, string> = {
  draft: '✎',
  posted: '◆',
  reversed: '↺',
  cancelled: '✕',
};

const INSPECTION_GLYPH: Record<string, string> = {
  none: '·',
  pending: '⏳',
  accepted: '✓',
  rejected: '✕',
};

/** The I02 rejection codes with a surface-scoped message. Others fall through to the global mapping. */
const I02_ERROR_CODES = new Set([
  'nothing_open',
  'qty_exceeds_open',
  'over_receipt',
  'line_already_billed',
  'location_required',
  'period_locked',
  'insufficient_stock',
  'invalid_transition',
  'invalid_qty',
  'lot_required',
  'serial_required',
  'tracking_not_applicable',
  'lot_number_taken',
  'serial_number_taken',
]);

const newKey = (): string => crypto.randomUUID();
const today = (): string => new Date().toISOString().slice(0, 10);

interface ReceiptRow {
  id: string;
  number: string;
  status: string;
  poId: string;
  poNumber: string;
  supplierName: string;
  receivedAt: string;
  lineCount: number;
  valueRappen: number;
  overReceiptQty: number;
}

interface ReceiptLine {
  id: string;
  poLineId: string;
  description: string | null;
  qty: number;
  unitCostRappen: number;
  inspectionStatus: string;
  movementId: string | null;
  reversalMovementId: string | null;
  rejectReason: string | null;
  overReceiptQty: number;
}

interface ReceiptEvent {
  id: string;
  eventType: string;
  reason: string | null;
  actor: string | null;
  createdAt: string;
}

interface ReceiptDetail {
  id: string;
  number: string;
  status: string;
  poId: string;
  receivedAt: string;
  note: string | null;
  hasOverReceipt: boolean;
  lines: ReceiptLine[];
  events: ReceiptEvent[];
}

interface PreviewLine {
  lineId: string;
  overReceiptQty: number;
  ordered: number;
  alreadyReceived: number;
  open: number;
  proposed: number;
  resultingReceived: number;
  movesStock: boolean;
  overReceipt: boolean;
  issues: string[];
}

interface Preview {
  valueRappen: number;
  postable: boolean;
  lines: PreviewLine[];
  /** Refusals that belong to the DOCUMENT, not to any line: today `period_locked`. */
  issues: string[];
}

interface OpenPoLine {
  id: string;
  itemId: string | null;
  description: string | null;
  openQty: number;
}

/** A J01 lot or serial the selected order line's item actually has. */
interface TrackingOption {
  id: string;
  number: string;
}

interface PoOption {
  id: string;
  number: string;
  status: string;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

function parseReceipts(body: unknown): ReceiptRow[] {
  return asArray<Record<string, unknown>>((body as { goodsReceipts?: unknown })?.goodsReceipts).map((r) => ({
    id: str(r.id),
    number: str(r.number),
    status: str(r.status),
    poId: str(r.poId),
    poNumber: str(r.poNumber),
    supplierName: str(r.supplierName),
    receivedAt: str(r.receivedAt),
    lineCount: num(r.lineCount),
    valueRappen: num(r.valueRappen),
    overReceiptQty: num(r.overReceiptQty),
  }));
}

function parseDetail(body: unknown): ReceiptDetail | null {
  const gr = (body as { goodsReceipt?: Record<string, unknown> })?.goodsReceipt;
  if (gr === undefined || gr === null) return null;
  return {
    id: str(gr.id),
    number: str(gr.number),
    status: str(gr.status),
    poId: str(gr.poId),
    receivedAt: str(gr.receivedAt),
    note: typeof gr.note === 'string' ? gr.note : null,
    hasOverReceipt: gr.hasOverReceipt === true,
    lines: asArray<Record<string, unknown>>(gr.lines).map((l) => ({
      id: str(l.id),
      poLineId: str(l.poLineId),
      description: typeof l.description === 'string' ? l.description : null,
      qty: num(l.qty),
      unitCostRappen: num(l.unitCostRappen),
      inspectionStatus: str(l.inspectionStatus),
      movementId: typeof l.movementId === 'string' ? l.movementId : null,
      reversalMovementId: typeof l.reversalMovementId === 'string' ? l.reversalMovementId : null,
      rejectReason: typeof l.rejectReason === 'string' ? l.rejectReason : null,
      overReceiptQty: num(l.overReceiptQty),
    })),
    events: asArray<Record<string, unknown>>(gr.events).map((e) => ({
      id: str(e.id),
      eventType: str(e.eventType),
      reason: typeof e.reason === 'string' ? e.reason : null,
      actor: typeof e.actor === 'string' ? e.actor : null,
      createdAt: str(e.createdAt),
    })),
  };
}

export function GoodsReceipt() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();
  const canWrite = can(CAP.manageMasterData);

  const [receipts, setReceipts] = useState<ReceiptRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReceiptDetail | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [openLines, setOpenLines] = useState<OpenPoLine[]>([]);
  const [pos, setPos] = useState<PoOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);

  const [createDrawer, setCreateDrawer] = useState(false);
  const [newPoId, setNewPoId] = useState('');
  const [newDate, setNewDate] = useState(today);
  const [newNote, setNewNote] = useState('');

  const [lineDrawer, setLineDrawer] = useState(false);
  const [linePoLineId, setLinePoLineId] = useState('');
  const [lineQty, setLineQty] = useState('');
  const [lineHold, setLineHold] = useState(false);
  const [lineLotId, setLineLotId] = useState('');
  const [lineSerialId, setLineSerialId] = useState('');
  const [lots, setLots] = useState<TrackingOption[]>([]);
  const [serials, setSerials] = useState<TrackingOption[]>([]);
  const [newLotNumber, setNewLotNumber] = useState('');
  const [newSerialNumber, setNewSerialNumber] = useState('');
  const [stockedItemIds, setStockedItemIds] = useState<Set<string>>(new Set());

  const [reverseReason, setReverseReason] = useState('');
  const [rejectReason, setRejectReason] = useState('');

  const localError = useCallback(
    (e: Err | null): string | undefined => (e !== null && I02_ERROR_CODES.has(e.error) ? t(`goodsReceipt.errors.${e.error}`) : undefined),
    [t],
  );

  const loadList = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const [listRes, poRes, itemRes] = await Promise.all([
      client.call('goods_receipt_list', { workspaceId }),
      client.call('po_list', { workspaceId }),
      client.call('list_items', { workspaceId }),
    ]);
    if (isErr(listRes.body)) {
      if (listRes.body.error === 'permission_denied' || listRes.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    const rows = parseReceipts(listRes.body);
    setReceipts(rows);
    // Which items carry stock at all. That, not "does it already have lots", is what decides whether
    // the lot / serial fields are offered on a line (see `loadTracking`).
    setStockedItemIds(
      new Set(
        isErr(itemRes.body)
          ? []
          : asArray<Record<string, unknown>>((itemRes.body as { items?: unknown }).items)
              .filter((i) => i.trackStock === true)
              .map((i) => str(i.id)),
      ),
    );
    setPos(
      isErr(poRes.body)
        ? []
        : asArray<Record<string, unknown>>((poRes.body as { pos?: unknown }).pos)
            .map((p) => ({ id: str(p.id), number: str(p.number), status: str(p.status) }))
            // Only an order that can still receive: `sent`, or `received` with quantity reopened by
            // a reversal (D02 has no received -> sent edge, so the status alone does not say).
            .filter((p) => p.status === 'sent' || p.status === 'received'),
    );
    setSelectedId((prev) => (prev !== null && rows.some((r) => r.id === prev) ? prev : (rows[0]?.id ?? null)));
    setLoading(false);
  }, [client, workspaceId]);

  const loadDetail = useCallback(
    async (grId: string) => {
      if (workspaceId === null) return;
      const [getRes, previewRes] = await Promise.all([
        client.call('goods_receipt_get', { workspaceId, grId }),
        client.call('goods_receipt_preview', { workspaceId, grId }),
      ]);
      const parsed = isErr(getRes.body) ? null : parseDetail(getRes.body);
      setDetail(parsed);
      const previewBody = isErr(previewRes.body) ? null : (previewRes.body as unknown as Preview);
      // Defensive: an older engine has no document-level array, and reading `undefined.length` in the
      // render would blank the surface rather than degrade.
      setPreview(previewBody === null ? null : { ...previewBody, issues: previewBody.issues ?? [] });
      if (parsed !== null) {
        const poRes = await client.call('po_get', { workspaceId, poId: parsed.poId });
        setOpenLines(
          isErr(poRes.body)
            ? []
            : asArray<Record<string, unknown>>((poRes.body as { lines?: unknown }).lines)
                .map((l) => ({
                  id: str(l.id),
                  itemId: typeof l.itemId === 'string' ? l.itemId : null,
                  description: typeof l.description === 'string' ? l.description : null,
                  openQty: num(l.openQty),
                }))
                .filter((l) => l.openQty > 0),
        );
      } else setOpenLines([]);
    },
    [client, workspaceId],
  );

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (selectedId !== null) void loadDetail(selectedId);
    else {
      setDetail(null);
      setPreview(null);
      setOpenLines([]);
    }
  }, [selectedId, loadDetail]);

  const refresh = useCallback(async () => {
    await loadList();
    if (selectedId !== null) await loadDetail(selectedId);
  }, [loadList, loadDetail, selectedId]);

  /** One call shape for every write: run it, surface the engine's own rejection, then re-read. */
  const run = useCallback(
    async (tool: string, input: Record<string, unknown>): Promise<boolean> => {
      if (workspaceId === null) return false;
      setWriteError(null);
      const response = await client.call(tool, { workspaceId, ...input, idempotencyKey: newKey() });
      if (isErr(response.body)) {
        setWriteError(response.body);
        return false;
      }
      await refresh();
      return true;
    },
    [client, workspaceId, refresh],
  );

  /**
   * The J01 lots and serials a receipt line may name.
   *
   * TWO THINGS HERE ARE DELIBERATE AND BOTH WERE WRONG BEFORE.
   *
   * 1. SERIALS COME FROM `serial_list`, never from `inventory_available_serials`, and WHETHER A UNIT
   *    IS ON HAND IS DECIDED BY ITS LOCATION, NOT BY ITS STATUS. `inventory_available_serials` is
   *    documented as the allocation query an agent runs BEFORE PICKING UNITS: it returns serials
   *    already IN stock, which are exactly the ones a receipt must not take again. J02 has no guard
   *    against re-receiving an on-hand serial, so a wrong predicate here is a silent double-count of
   *    a unit of one.
   *
   *    THE SIGNAL IS `currentLocationId`, and it is J02's own. `updateSerialProjection` parks a unit
   *    at a location on every inbound leg and nulls it on every outbound one, so a non-null location
   *    means on hand whatever the status column says. It is the only signal that gets all four
   *    on-hand shapes right, including the one a status check misses entirely: a CUSTOMER RETURN
   *    (`movementType:'return'` with a POSITIVE quantity) leaves the status `returned` while putting
   *    the unit physically back on the shelf.
   *
   *    STATUS IS NOT THAT SIGNAL, and reaching for it cost two rounds. `serial_create` and
   *    `serial_create_bulk` mint `status:'available'` with a NULL location, so `available` is the
   *    default state of every serial J01 can produce and most of them have never been received at
   *    all. Filtering it out hid exactly the case this picker exists for: a serial pre-registered
   *    from a supplier ASN, which could then be neither picked (no control renders for an empty
   *    list) nor retyped (`serial_number_taken`).
   *
   *    NO status is consulted. An earlier revision also excluded `reserved`, reasoning from J01's
   *    `serialArchive` that a unit somebody has spoken for should not be offered. A critic enumerated
   *    the reachable states and that clause never helped: `reserved` can only change the answer when
   *    the location is already null, and every clean `location === null` state has a movement sum of
   *    zero, so the ledger says OFFER in all of them. It had zero states where it improved agreement
   *    and one where it broke it (a serial pre-registered from an ASN and reserved before arrival was
   *    hidden, which is the very dead end this filter was rewritten to fix). Excluding a shape "in
   *    the safe direction" is the same mistake as excluding `available` was: hiding a receivable unit
   *    is not caution, it is the bug.
   *
   *    The real authority is `SUM(stock_movement.qty)` for that serial, which this surface cannot get
   *    in one read. Location is the projection J02 maintains from those very movements, so it is the
   *    faithful stand-in, and where the projection itself drifts from the sum (J02's unpaired
   *    `transfer_out` leaves it stale) that is J02's defect to close, not this filter's to guess at.
   * 2. WHETHER TO OFFER THE FIELDS AT ALL is decided by the item being STOCK-TRACKED, not by whether
   *    it already has lots. A goods receipt is the normal moment a purchased lot comes into
   *    existence, because the supplier's lot number arrives on the delivery note, so an empty list
   *    is the FIRST delivery rather than evidence of an untracked item. Hiding the fields there left
   *    the operator reading "choose a lot" with no way to choose one, which is the dead end this
   *    surface shipped.
   *
   * The engine stays the real gate: `lot_create` refuses `tracking_not_applicable` on an item that
   * is not lot-tracked, and the post still refuses `lot_required` if the field is left empty.
   */
  const loadTracking = useCallback(
    async (poLineId: string) => {
      const itemId = openLines.find((l) => l.id === poLineId)?.itemId ?? null;
      if (workspaceId === null || itemId === null) {
        setLots([]);
        setSerials([]);
        return;
      }
      const [lotRes, serialRes] = await Promise.all([
        client.call('lot_list', { workspaceId, itemId }),
        client.call('serial_list', { workspaceId, itemId }),
      ]);
      const pick = (body: unknown, key: string): Array<TrackingOption & { status: string; currentLocationId: string | null }> =>
        asArray<Record<string, unknown>>((body as Record<string, unknown>)?.[key])
          .map((r) => ({
            id: str(r.id),
            number: str(r.number),
            status: str(r.status),
            currentLocationId: typeof r.currentLocationId === 'string' ? r.currentLocationId : null,
          }))
          .filter((x) => x.id !== '');
      setLots(isErr(lotRes.body) ? [] : pick(lotRes.body, 'lots'));
      setSerials(
        isErr(serialRes.body)
          ? []
          : pick(serialRes.body, 'serials').filter((x) => x.currentLocationId === null),
      );
    },
    [client, workspaceId, openLines],
  );

  const submitCreate = useCallback(async () => {
    if (newPoId === '') {
      setWriteError({ error: 'invalid_input' } as Err);
      return;
    }
    if (workspaceId === null) return;
    setWriteError(null);
    const response = await client.call('goods_receipt_create', {
      workspaceId,
      poId: newPoId,
      receivedAt: newDate,
      note: newNote.trim() === '' ? undefined : newNote.trim(),
      idempotencyKey: newKey(),
    });
    if (isErr(response.body)) {
      setWriteError(response.body);
      return;
    }
    const created = parseDetail(response.body);
    setCreateDrawer(false);
    setNewNote('');
    await loadList();
    if (created !== null) setSelectedId(created.id);
  }, [client, workspaceId, newPoId, newDate, newNote, loadList]);

  const lineItemId = useMemo(
    () => openLines.find((l) => l.id === linePoLineId)?.itemId ?? null,
    [openLines, linePoLineId],
  );
  /** Whether this line's item carries stock at all, which is what decides the lot / serial fields. */
  const lineIsStocked = lineItemId !== null && stockedItemIds.has(lineItemId);

  const submitLine = useCallback(async () => {
    if (detail === null || workspaceId === null) return;
    const qty = Number.parseInt(lineQty, 10);
    if (!Number.isInteger(qty) || qty <= 0) {
      setWriteError({ error: 'invalid_qty' } as Err);
      return;
    }
    setWriteError(null);

    // A goods receipt is the normal moment a purchased lot or serial comes into existence, because
    // the supplier's number arrives on the delivery note. Minting it here, before the line is added,
    // is what makes the FIRST delivery of a tracked item possible at all. The engine is the gate:
    // an item that is not lot-tracked refuses with `tracking_not_applicable`, and a number already
    // used refuses with `lot_number_taken`, both of which this surface has copy for.
    let lotId = lineLotId;
    if (newLotNumber.trim() !== '' && lineItemId !== null) {
      const created = await client.call('lot_create', {
        workspaceId,
        itemId: lineItemId,
        number: newLotNumber.trim(),
        idempotencyKey: newKey(),
      });
      if (isErr(created.body)) {
        setWriteError(created.body);
        return;
      }
      lotId = str((created.body as { lot?: Record<string, unknown> }).lot?.id);
      // The lot is WRITTEN now, whatever happens to the rest of this submit. Re-read the pickers so a
      // later failure leaves it visible in the dropdown: without this the operator retyped the same
      // number, got `lot_number_taken` ("pick it from the list instead"), and the list was empty.
      await loadTracking(linePoLineId);
      setNewLotNumber('');
      setLineLotId(lotId);
    }

    let serialId = lineSerialId;
    if (newSerialNumber.trim() !== '' && lineItemId !== null) {
      const created = await client.call('serial_create', {
        workspaceId,
        itemId: lineItemId,
        number: newSerialNumber.trim(),
        // A `lot_and_serial` item needs its serial to name the lot it belongs to.
        ...(lotId === '' ? {} : { lotId }),
        idempotencyKey: newKey(),
      });
      if (isErr(created.body)) {
        setWriteError(created.body);
        return;
      }
      serialId = str((created.body as { serial?: Record<string, unknown> }).serial?.id);
      // Same reasoning as the lot above: it exists now, so it has to be reachable now.
      await loadTracking(linePoLineId);
      setNewSerialNumber('');
      setLineSerialId(serialId);
    }

    const okDone = await run('goods_receipt_upsert_lines', {
      grId: detail.id,
      ops: [
        {
          op: 'add',
          poLineId: linePoLineId,
          qty,
          inspectionStatus: lineHold ? 'pending' : 'none',
          // Omitted rather than sent empty: an empty string is not a missing value, and the engine
          // refuses an unknown reference with `invalid_reference` rather than throwing.
          ...(lotId === '' ? {} : { lotId }),
          ...(serialId === '' ? {} : { serialId }),
        },
      ],
    });
    if (okDone) {
      setLineDrawer(false);
      setLineQty('');
      setLineHold(false);
      setLineLotId('');
      setLineSerialId('');
      setNewLotNumber('');
      setNewSerialNumber('');
    } else {
      // The add failed AFTER any mint. Whatever was minted has to be in the dropdown before the
      // operator tries again.
      await loadTracking(linePoLineId);
    }
  }, [
    detail,
    workspaceId,
    client,
    lineQty,
    linePoLineId,
    lineItemId,
    lineHold,
    lineLotId,
    lineSerialId,
    newLotNumber,
    newSerialNumber,
    loadTracking,
    run,
  ]);

  const heldLines = useMemo(() => (detail?.lines ?? []).filter((l) => l.inspectionStatus === 'pending'), [detail]);
  const issuesFor = useCallback(
    (lineId: string): string[] => preview?.lines.find((p) => p.lineId === lineId)?.issues ?? [],
    [preview],
  );

  if (workspaceId === null) return <NoWorkspaceState body={t('goodsReceipt.noWorkspace')} />;
  if (denied) return <PermissionDenied title={t('goodsReceipt.title')} />;

  const isDraft = detail?.status === 'draft';
  const isPosted = detail?.status === 'posted';

  // The receipt master list. Two columns: the number over its order/supplier/date meta, and the
  // status (glyph + label, never colour alone) with the over-delivery exception badge where a buyer
  // scans. Headers are visually hidden (the compact list carried none), still named for assistive tech.
  const receiptColumns: DataTableColumn<ReceiptRow>[] = [
    {
      key: 'receipt',
      header: t('goodsReceipt.col.receipt'),
      headerHidden: true,
      render: (r) => (
        <span className="gr-list-cell">
          <span className="gr-list-number">{r.number}</span>
          <span className="gr-muted">
            {r.poNumber} · {r.supplierName} · {r.receivedAt}
          </span>
        </span>
      ),
    },
    {
      key: 'status',
      header: t('goodsReceipt.col.status'),
      headerHidden: true,
      align: 'end',
      render: (r) => (
        <span className="gr-list-badges">
          <span className="gr-badge">
            {STATUS_GLYPH[r.status] ?? '·'} {t(`goodsReceipt.status.${r.status}`)}
          </span>
          {/* The exception is visible where a buyer scans, not buried in the detail. Glyph AND label,
              never colour alone (design-canon, WCAG 2.2 AA). */}
          {r.overReceiptQty > 0 && (
            <span className="gr-badge">
              ⚠ {t('goodsReceipt.overReceipt.badge')} +{r.overReceiptQty}
            </span>
          )}
        </span>
      ),
    },
  ];

  // The lines of the selected receipt: numeric qty and unit-cost right-align (DataTable `numeric`),
  // the inspection state is a glyph + label badge, the minted J02 movement is mono, and the note cell
  // carries the over-delivery marker, any preview issue and the rejection reason.
  const lineColumns: DataTableColumn<ReceiptLine>[] = [
    { key: 'description', header: t('goodsReceipt.col.description'), render: (l) => l.description ?? l.poLineId },
    { key: 'qty', header: t('goodsReceipt.col.qty'), numeric: true, render: (l) => l.qty },
    { key: 'unitCost', header: t('goodsReceipt.col.unitCost'), numeric: true, render: (l) => formatMoney(l.unitCostRappen, 'CHF') },
    {
      key: 'inspection',
      header: t('goodsReceipt.col.inspection'),
      render: (l) => (
        <span className="gr-badge">
          {INSPECTION_GLYPH[l.inspectionStatus] ?? '·'} {t(`goodsReceipt.inspection.${l.inspectionStatus}`)}
        </span>
      ),
    },
    {
      key: 'movement',
      header: t('goodsReceipt.col.movement'),
      render: (l) => (
        <span className="gr-mono">
          {l.reversalMovementId !== null ? t('goodsReceipt.reversed') : (l.movementId ?? t('goodsReceipt.noMovement'))}
        </span>
      ),
    },
    {
      key: 'note',
      header: t('goodsReceipt.col.note'),
      render: (l) => (
        <>
          {l.overReceiptQty > 0 && (
            <span className="gr-issue">
              ⚠ {t('goodsReceipt.overReceipt.line', { qty: String(l.overReceiptQty) })}
            </span>
          )}
          {/* Only a code this surface has copy for is translated; anything else is shown raw rather
              than asking the i18n layer for a key that does not exist (which would warn on the console
              and redden the gate). */}
          {issuesFor(l.id).map((code) => (
            <span key={code} className="gr-issue">
              {I02_ERROR_CODES.has(code) ? t(`goodsReceipt.errors.${code}`) : code}
            </span>
          ))}
          {l.rejectReason}
        </>
      ),
    },
  ];

  const headerActions = (
    <button
      type="button"
      className="btn btn--primary"
      disabled={!canWrite || pos.length === 0}
      onClick={() => {
        setWriteError(null);
        setNewPoId(pos[0]?.id ?? '');
        setNewDate(today());
        setCreateDrawer(true);
      }}
    >
      {t('goodsReceipt.new')}
    </button>
  );

  return (
    <div className="gr">
      <SurfaceHeader
        title={t('goodsReceipt.title')}
        help={<SurfaceHelp surface="GoodsReceipt" />}
        actions={headerActions}
      />

      {failed && <ErrorBanner message={t('goodsReceipt.error.transport')} onRetry={() => void loadList()} />}

      {loading ? (
        <Skeleton rows={4} />
      ) : receipts.length === 0 ? (
        <EmptyState title={t('goodsReceipt.empty.title')} hint={t('goodsReceipt.empty.hint')} />
      ) : (
        <div className="gr-split">
          <section className="gr-pane" aria-label={t('goodsReceipt.listLabel')}>
            <DataTable
              columns={receiptColumns}
              rows={receipts}
              rowKey={(r) => r.id}
              caption={t('goodsReceipt.listLabel')}
              onRowClick={(r) => setSelectedId(r.id)}
              rowLabel={(r) => `${r.number} ${t(`goodsReceipt.status.${r.status}`)} ${r.poNumber} ${r.supplierName}`}
              rowClassName={(r) =>
                [r.id === selectedId ? 'gr-row--selected' : '', r.overReceiptQty > 0 ? 'gr-row--exception' : '']
                  .filter(Boolean)
                  .join(' ') || undefined
              }
            />
          </section>

          <section className="gr-pane gr-detail" aria-label={t('goodsReceipt.detailLabel')}>
            {detail === null ? (
              <p className="gr-muted">{t('goodsReceipt.selectHint')}</p>
            ) : (
              <>
                <div className="gr-detail-head">
                  <div>
                    <h2 className="gr-detail-title">{detail.number}</h2>
                    <p className="gr-muted">
                      {t('goodsReceipt.field.receivedAt')}: <strong>{detail.receivedAt}</strong>
                      {' · '}
                      <span className="gr-badge">
                        {STATUS_GLYPH[detail.status] ?? '·'} {t(`goodsReceipt.status.${detail.status}`)}
                      </span>
                    </p>
                    <p className="gr-hint">{t('goodsReceipt.dateIsFixed')}</p>
                    {/* C3: the quiet provenance of the receipt, from its creation event (who + when),
                        at the point of judgement. Broad rollout to other detail views is Phase 2. */}
                    {detail.events.length > 0 && (
                      <Provenance
                        origin={detail.events[0].actor !== null ? 'human' : 'unknown'}
                        actor={detail.events[0].actor}
                        action={t(`goodsReceipt.event.${detail.events[0].eventType}`)}
                        timestamp={detail.events[0].createdAt}
                      />
                    )}
                  </div>
                  <div className="gr-actions">
                    {isDraft && (
                      <>
                        <button
                          type="button"
                          className="btn btn--secondary"
                          disabled={!canWrite || openLines.length === 0}
                          onClick={() => {
                            setWriteError(null);
                            const first = openLines[0]?.id ?? '';
                            setLinePoLineId(first);
                            setLineQty(String(openLines[0]?.openQty ?? 1));
                            setLineLotId('');
                            setLineSerialId('');
                            void loadTracking(first);
                            setLineDrawer(true);
                          }}
                        >
                          {t('goodsReceipt.addLine')}
                        </button>
                        <button
                          type="button"
                          className="btn btn--primary"
                          disabled={!canWrite || preview?.postable !== true}
                          onClick={() => void run('goods_receipt_post', { grId: detail.id })}
                        >
                          {t('goodsReceipt.post')}
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost"
                          disabled={!canWrite}
                          onClick={() => void run('goods_receipt_cancel', { grId: detail.id })}
                        >
                          {t('goodsReceipt.cancel')}
                        </button>
                      </>
                    )}
                    {isPosted && (
                      <button
                        type="button"
                        className="btn btn--secondary"
                        disabled={!canWrite || reverseReason.trim() === ''}
                        onClick={() => void run('goods_receipt_reverse', { grId: detail.id, reason: reverseReason.trim() })}
                      >
                        {t('goodsReceipt.reverse')}
                      </button>
                    )}
                  </div>
                </div>

                {isPosted && (
                  <div className="gr-field">
                    <label htmlFor="gr-reverse-reason">{t('goodsReceipt.form.reverseReason')}</label>
                    <input id="gr-reverse-reason" className="field" value={reverseReason} onChange={(e) => setReverseReason(e.target.value)} />
                  </div>
                )}

                {/* WHY Post is unavailable, when the reason belongs to the document rather than to
                    any line. Without this a sealed period greyed the button out with every line
                    clean and nothing on screen explaining it, which is the exact opposite of what
                    the preview contract is for. */}
                {(preview?.issues ?? []).length > 0 && (
                  <p className="gr-issue">
                    ⚠{' '}
                    {(preview?.issues ?? [])
                      .map((code) => (I02_ERROR_CODES.has(code) ? t(`goodsReceipt.errors.${code}`) : code))
                      .join(' ')}
                  </p>
                )}

                {writeError && !createDrawer && !lineDrawer && <ErrorBanner error={writeError} message={localError(writeError)} />}

                <DataTable
                  columns={lineColumns}
                  rows={detail.lines}
                  rowKey={(l) => l.id}
                  caption={t('goodsReceipt.detailLabel')}
                  emptyState={<p className="gr-muted">{t('goodsReceipt.noLines')}</p>}
                  rowClassName={(l) => (l.overReceiptQty > 0 ? 'gr-row--exception' : undefined)}
                />

                {preview !== null && (
                  <p className="gr-total">
                    {t('goodsReceipt.value')}: <strong>{formatMoney(preview.valueRappen, 'CHF')}</strong>
                  </p>
                )}

                {/* Say WHY an over-delivery is about to post rather than letting it look like a bug.
                    Shown on a draft that carries one and on a posted receipt that recorded one. */}
                {(detail.hasOverReceipt || (preview?.lines ?? []).some((l) => l.overReceiptQty > 0)) && (
                  <p className="gr-hint">{t('goodsReceipt.overReceiptHint')}</p>
                )}

                {isPosted && heldLines.length > 0 && (
                  <div className="gr-hold">
                    <h3 className="gr-subtitle">{t('goodsReceipt.holdTitle')}</h3>
                    <div className="gr-field">
                      <label htmlFor="gr-reject-reason">{t('goodsReceipt.form.rejectReason')}</label>
                      <input id="gr-reject-reason" className="field" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
                    </div>
                    <div className="gr-actions">
                      <button
                        type="button"
                        className="btn btn--primary"
                        disabled={!canWrite}
                        onClick={() => void run('goods_receipt_accept_lines', { grId: detail.id, lineIds: heldLines.map((l) => l.id) })}
                      >
                        {t('goodsReceipt.accept')}
                      </button>
                      <button
                        type="button"
                        className="btn btn--secondary"
                        disabled={!canWrite || rejectReason.trim() === ''}
                        onClick={() =>
                          void run('goods_receipt_reject_lines', {
                            grId: detail.id,
                            lineIds: heldLines.map((l) => l.id),
                            reason: rejectReason.trim(),
                          })
                        }
                      >
                        {t('goodsReceipt.reject')}
                      </button>
                    </div>
                  </div>
                )}

                <h3 className="gr-subtitle">{t('goodsReceipt.trailTitle')}</h3>
                <ul className="gr-trail">
                  {detail.events.map((e) => (
                    <li key={e.id}>
                      <span className="gr-mono">{e.createdAt.slice(0, 10)}</span> {t(`goodsReceipt.event.${e.eventType}`)}
                      {e.actor !== null ? ` · ${e.actor}` : ''}
                      {e.reason !== null ? ` · ${e.reason}` : ''}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </div>
      )}

      {createDrawer && (
        <DetailDrawer
          open
          onClose={() => setCreateDrawer(false)}
          title={t('goodsReceipt.form.createTitle')}
          closeLabel={t('goodsReceipt.close')}
          footer={
            <>
              <button type="button" className="btn btn--secondary" onClick={() => setCreateDrawer(false)}>
                {t('goodsReceipt.close')}
              </button>
              <button type="button" className="btn btn--primary" onClick={() => void submitCreate()} disabled={!canWrite}>
                {t('goodsReceipt.save')}
              </button>
            </>
          }
        >
          {writeError && <ErrorBanner error={writeError} message={localError(writeError)} />}
          <div className="gr-field">
            <label htmlFor="gr-po">{t('goodsReceipt.form.po')}</label>
            <select id="gr-po" className="field" value={newPoId} onChange={(e) => setNewPoId(e.target.value)}>
              {pos.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.number}
                </option>
              ))}
            </select>
          </div>
          <div className="gr-field">
            <label htmlFor="gr-date">{t('goodsReceipt.form.receivedAt')}</label>
            <input id="gr-date" className="field" type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
            <p className="gr-hint">{t('goodsReceipt.dateIsFixed')}</p>
          </div>
          <div className="gr-field">
            <label htmlFor="gr-note">{t('goodsReceipt.form.note')}</label>
            <input id="gr-note" className="field" value={newNote} onChange={(e) => setNewNote(e.target.value)} />
          </div>
        </DetailDrawer>
      )}

      {lineDrawer && detail !== null && (
        <DetailDrawer
          open
          onClose={() => setLineDrawer(false)}
          title={t('goodsReceipt.form.lineTitle')}
          closeLabel={t('goodsReceipt.close')}
          footer={
            <>
              <button type="button" className="btn btn--secondary" onClick={() => setLineDrawer(false)}>
                {t('goodsReceipt.close')}
              </button>
              <button type="button" className="btn btn--primary" onClick={() => void submitLine()} disabled={!canWrite}>
                {t('goodsReceipt.save')}
              </button>
            </>
          }
        >
          {writeError && <ErrorBanner error={writeError} message={localError(writeError)} />}
          <div className="gr-field">
            <label htmlFor="gr-poline">{t('goodsReceipt.form.poLine')}</label>
            <select
              id="gr-poline"
              className="field"
              value={linePoLineId}
              onChange={(e) => {
                setLinePoLineId(e.target.value);
                setLineLotId('');
                setLineSerialId('');
                void loadTracking(e.target.value);
              }}
            >
              {openLines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.description ?? l.id} ({t('goodsReceipt.form.open')}: {l.openQty})
                </option>
              ))}
            </select>
          </div>
          <div className="gr-field">
            <label htmlFor="gr-qty">{t('goodsReceipt.form.qty')}</label>
            <input id="gr-qty" className="field" type="number" min="1" value={lineQty} onChange={(e) => setLineQty(e.target.value)} />
          </div>
          {/* Shown only when the item actually HAS lots or serials, so an untracked item keeps the
              drawer short. Without these the surface shipped an error message ("choose a lot for the
              line") pointing at an affordance that did not exist, which is a lie rather than a
              missing polish item. The engine stays the real gate: skipping a required one still
              comes back as lot_required. */}
          {lineIsStocked && (
            <>
              {lots.length > 0 && (
                <div className="gr-field">
                  <label htmlFor="gr-lot">{t('goodsReceipt.form.lot')}</label>
                  <select id="gr-lot" className="field" value={lineLotId} onChange={(e) => setLineLotId(e.target.value)}>
                    <option value="">{t('goodsReceipt.form.noneSelected')}</option>
                    {lots.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.number}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="gr-field">
                <label htmlFor="gr-new-lot">{t('goodsReceipt.form.newLot')}</label>
                <input
                  id="gr-new-lot"
                  className="field"
                  value={newLotNumber}
                  onChange={(e) => setNewLotNumber(e.target.value)}
                  placeholder={t('goodsReceipt.form.optional')}
                />
                <p className="gr-hint">{t('goodsReceipt.form.newLotHint')}</p>
              </div>
              {serials.length > 0 && (
                <div className="gr-field">
                  <label htmlFor="gr-serial">{t('goodsReceipt.form.serial')}</label>
                  <select id="gr-serial" className="field" value={lineSerialId} onChange={(e) => setLineSerialId(e.target.value)}>
                    <option value="">{t('goodsReceipt.form.noneSelected')}</option>
                    {serials.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.number}
                      </option>
                    ))}
                  </select>
                  <p className="gr-hint">{t('goodsReceipt.form.serialReturnHint')}</p>
                </div>
              )}
              <div className="gr-field">
                <label htmlFor="gr-new-serial">{t('goodsReceipt.form.newSerial')}</label>
                <input
                  id="gr-new-serial"
                  className="field"
                  value={newSerialNumber}
                  onChange={(e) => setNewSerialNumber(e.target.value)}
                  placeholder={t('goodsReceipt.form.optional')}
                />
                <p className="gr-hint">{t('goodsReceipt.form.serialHint')}</p>
              </div>
            </>
          )}
          <label className="gr-check">
            <input type="checkbox" checked={lineHold} onChange={(e) => setLineHold(e.target.checked)} />
            <span>{t('goodsReceipt.form.hold')}</span>
          </label>
        </DetailDrawer>
      )}
    </div>
  );
}

export { STATUS_GLYPH };
