/**
 * A42 and D203, Umsatz (`/umsatz`, Bank group): the turnover of a period from the books, the settlement events
 * still to book, and the rules behind them, in two tabs (pick B): Zahlen (the KPIs first, pick A, then the months,
 * the sources, the customers and the events) and Regeln (the booking template, the settings, the bank rules).
 *
 * THE FIGURES ARE THE BOOKS (D203 point 2): `turnover_summary`, posted entries on 3xxx and 2200, never a payout
 * and never the feed. THE EVENTS ARE THE IMPORT, ROLLED BACK: `settlement_review` runs the real import, so a
 * status or a check here is what the import does. A feed outage or a missing source takes away the events, never
 * the figures. No source at all is a calm start (`mode: 'none'`): "Datei laden" and "Quelle verbinden".
 *
 * WHAT IS BOOKED IS WHAT WAS SEEN. A loaded file is booked with `import_settlement` and the same file; the
 * feed with `pull_settlement` over the same range and `expectReviewSha256`, which refuses `review_stale` when
 * the feed, an answer or a setting moved since the review. Buchen is a bar that is there only while something
 * is ready to book (pick A); with nothing to book there is no button at all.
 *
 * A43 §2: the file input takes JSON, CSV and XLSX, sniffed by content. A table goes through `TableIntake` (name,
 * mapping, template when none exists), which hands back ONE till-settlement/v1 document; from there the screen
 * reviews and books it exactly as a loaded JSON file, so there is no second import path.
 *
 * D206, a table read by WHOLE DAYS: the days the door left out are listed above the rows, one line each ("01.09.
 * schon im Buch", "01.09. weicht ab: gebucht CHF ..., Datei CHF ..."), and a first or last day the import holds back
 * (`edge_day_unconfirmed`) gets its own check: the person's answer goes to the review and to Buchen as
 * `confirmEdgeDays`, never inside the document.
 *
 * Low cognitive load (DESIGN.md rule 7, "The calm Studio"): glyphs with their words on hover, no helper
 * sentence, no reason asked (D203 point 5: the change log keeps who and when); an ignored row is struck through
 * and stays.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { useI18n, formatMoney, formatDate } from '../../i18n';
import { useWorkspaceId } from '../../app/workspace';
import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCan } from '../../lib/capabilities';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton, refusalText } from '../../components/states';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { IconButton } from '../../components/IconButton';
import { Tooltip } from '../../components/Tooltip';
import { Select } from '../../components/Select';
import { Segmented } from '../../components/Segmented';
import { Tabs } from '../../components/Tabs';
import { DetailDrawer } from '../../components/DetailDrawer';
import {
  BankGlyph,
  ExchangeGlyph,
  HelpGlyph,
  PersonGlyph,
  PointGlyph,
  ResetGlyph,
  StatusDangerGlyph,
  StatusInactiveGlyph,
  StatusPendingGlyph,
  StatusSuccessGlyph,
  StatusWarnGlyph,
  TagGlyph,
  UploadGlyph,
} from '../../components/icons';
import { KIND_GLYPHS } from '../../components/icons/kinds';
import { TableIntake, type DayView } from './TableIntake';
import { KpiTiles, Breakdowns, type TurnoverSummary, type ToBook } from './Figures';
import { UmsatzRules } from './Rules';
import './Umsatz.css';

/** One row of `settlement_review` (the engine's `ReviewRow`). */
export interface ReviewRow {
  /** The row's identity, unique by construction; an event without an id has an empty `eventId`. */
  rowKey?: string;
  eventId: string;
  kind: string;
  day: string;
  outsidePeriod: boolean;
  amountMinor: number;
  netMinor: number;
  vatMinor: number | null;
  counterparty: { email: string | null; name: string | null; masked: boolean; document: string | null; chargeId: string | null };
  test: boolean;
  included: boolean;
  inclusion: { state: 'ignored' | 'included'; source: string; reason: string | null; actor: string | null; at: string | null };
  status: 'booked' | 'to_book' | 'skipped' | 'refused';
  reason: string | null;
  code: string | null;
  sentence: string | null;
  entryId: string | null;
  vatPostedMinor: number;
  toggleable: boolean;
  includeVia: 'inclusion' | 'not_test';
  derivation: Derivation | null;
  /** What the producer states now could not be read: never booked from this document (one row per event). */
  unreadable?: boolean;
}

/** How the producer derived an event (the engine's `SettlementDerivation`); display only. */
export interface Derivation {
  derivedFrom: string | null;
  sellerRole: string | null;
  vatRule: string | null;
  vatRatePercent: string | null;
  platformFee: { bp: number | null; amountMinor: number | null; waived: boolean | null; waiverReason: string | null };
  processingFeeMinor: number | null;
  processingFeeSource: string | null;
  payoutNetMinor: number | null;
  coachPayoutExpectedMinor: number | null;
  selfBill: { number: string | null; amountMinor: number | null; hasVat: boolean | null };
  coachTransferMinor: number | null;
  coachPayoutAdjustmentMinor: number | null;
  coachVatRegistered: boolean | null;
  ids: { bookingId: string | null; sessionId: string | null; liveSessionId: string | null; paymentIntentId: string | null; chargeId: string | null; transferId: string | null; payoutId: string | null };
  stated: { ok: boolean | null; diffMinor: number | null };
  till: boolean | null;
  ok: boolean | null;
  refsTrimmed: boolean;
}

/** One payout of check (a), as this screen reads it. */
export interface PayoutLine {
  eventId: string;
  day: string;
  basis: string;
  restMinor: number | null;
  testRestMinor: number;
  skippedRestMinor: number;
  openingRestMinor?: number;
  unexplainedMinor: number | null;
}

type CheckState = 'ok' | 'differs' | 'unknown';

/** One period of `settlement_periods`: whether TILL observed events there and whether any waits. */
export interface SettlementPeriod {
  from: string;
  to: string;
  state: 'to_book' | 'booked' | 'empty';
  booked: number;
  waiting: number;
  observed: number;
}

/** The engine's `settlement_review` answer, as this screen reads it. */
export interface Review {
  /** `none`: no file and no source saved, a calm start (D203 point 3). */
  mode: 'file' | 'feed' | 'none';
  system: string;
  processor: string;
  period: { from: string; to: string; unit: string };
  reviewSha256: string;
  rows: ReviewRow[];
  toBook: number;
  totals: {
    turnoverNetMinor: number;
    outputVat: { amountMinor: number; formLines: string[] };
    inputVat: { amountMinor: number; formLines: string[] };
    ignored: { events: number; vatMinor: number };
    test: { events: number; vatMinor: number };
    notBooked: { events: number; vatMinor: number };
  };
  checks: {
    payouts: { state: CheckState; payouts: PayoutLine[] };
    vat: { state: CheckState; statedMinor: number; bookedMinor: number; differing: string[] };
  };
  warnings: string[];
}

/** D206: the whole-day codes a review row can carry, worded by this screen (`umsatz.dayCode.<code>`). */
const DAY_CODES = ['day_differs', 'day_not_over', 'edge_day_excluded', 'edge_day_unconfirmed'] as const;

/** The refusals this screen words itself (`umsatz.refusal.<code>`). */
const KNOWN = [
  'day_mode_unconfirmed',
  'person_decides',
  'settlement_source_missing',
  'settlement_template_missing',
  'settlement_template_incomplete',
  'settlement_incomplete',
  'source_ambiguous',
  'token_missing',
  'feed_unreachable',
  'feed_unauthorized',
  'review_stale',
  'event_booked',
  'handled_outside_active',
  'invalid_settlement',
  'unsupported_schema',
] as const;

const CURRENCY = 'CHF';

let keySeq = 0;
const newKey = (act: string) => `umsatz-${act}-${Date.now().toString(36)}-${(keySeq += 1)}`;

/** The same period one step earlier or later (a quarter, a month, a year; a custom or file range by quarter). */
export function shiftPeriod(from: string, unit: string, dir: -1 | 1): { from: string; to: string } {
  const months = unit === 'month' ? 1 : unit === 'year' ? 12 : 3;
  const y = Number(from.slice(0, 4));
  const m = Number(from.slice(5, 7)) - 1 + dir * months;
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 0));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(start), to: iso(end) };
}

/**
 * The part of a loaded file the person reviewed and books: the same document with only the events dated in the
 * review's period. The engine reviews exactly this part (`periodPartOf`, the same rule), so Buchen never books
 * an event of the file outside the period shown, and the import's `review_stale` guards the rest.
 */
export function reviewedPart(content: string, period: { from: string; to: string }): unknown {
  const doc = JSON.parse(content.replace(/^\uFEFF/, '')) as Record<string, unknown>;
  const events = Array.isArray(doc.events) ? (doc.events as unknown[]) : [];
  return {
    ...doc,
    events: events.filter((e) => {
      const day = e !== null && typeof e === 'object' ? (e as Record<string, unknown>).day : undefined;
      return typeof day === 'string' && day >= period.from && day <= period.to;
    }),
  };
}

/** Bytes as base64, in slices so a large export never overflows the argument list. */
export function base64Of(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

const KIND_GLYPH: Record<string, (p: { size?: number }) => ReactElement> = {
  sale: KIND_GLYPHS.sales,
  refund: ResetGlyph,
  processing_fee: ExchangeGlyph,
  service_fee: ExchangeGlyph,
  third_party_payout: PersonGlyph,
  third_party_payout_reversal: PersonGlyph,
  bank_payout: BankGlyph,
  bank_payout_summary: BankGlyph,
  reserve: PointGlyph,
  other: HelpGlyph,
};

export function Umsatz() {
  const workspaceId = useWorkspaceId();
  if (workspaceId === null) return <NoWorkspaceState />;
  return <UmsatzPage workspaceId={workspaceId} />;
}

/** The refusals of the review that a configuration answers (a calm line with the way there, never a retry). */
const CONFIG_STATES = new Set(['settlement_source_missing', 'settlement_template_missing', 'settlement_template_incomplete', 'source_ambiguous', 'token_missing', 'feed_unauthorized']);

/** The unit a review period steps by (a custom range steps by quarter). */
const unitOf = (unit: string | undefined): PeriodUnit => (unit === 'month' || unit === 'year' ? unit : 'quarter');
type PeriodUnit = 'month' | 'quarter' | 'year';

/** The period of `unit` around a day (the engine's `periodAround`). */
export function periodAround(day: string, unit: string): { from: string; to: string } {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const start = unit === 'year' ? 0 : unit === 'month' ? m - 1 : Math.floor((m - 1) / 3) * 3;
  const months = unit === 'year' ? 12 : unit === 'month' ? 1 : 3;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(new Date(Date.UTC(y, start, 1))), to: iso(new Date(Date.UTC(y, start + months, 0))) };
}

/**
 * What Buchen would add, from ONE row set (critic r1 F2): every row the dry run books (`to_book`), the ones a
 * producer dated outside the period included, because Buchen books them too. The count, the turnover (sales and
 * refunds) and the VAT all come from that set; `outside` names how many of them fall outside the period.
 */
export function toBookOf(review: Review | null): ToBook | null {
  if (review === null) return null;
  const rows = review.rows.filter((r) => r.status === 'to_book');
  const turnover = rows.filter((r) => r.kind === 'sale' || r.kind === 'refund');
  return {
    count: rows.length,
    netMinor: turnover.reduce((s, r) => s + r.netMinor, 0),
    vatMinor: turnover.reduce((s, r) => s + (r.vatMinor ?? 0), 0),
    outside: rows.filter((r) => r.outsidePeriod).length,
  };
}

export function UmsatzPage({ workspaceId }: { workspaceId: string }) {
  const { t } = useI18n();
  const client = useClient();
  const canPost = useCan(CAP.post);
  const titleId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const { search } = useLocation();
  // D210: `?tab=regeln` opens the rules (the Pendenzen door "Als Umsatz buchen" without a template).
  const [tab, setTab] = useState<'zahlen' | 'regeln'>(() => (new URLSearchParams(search).get('tab') === 'regeln' ? 'regeln' : 'zahlen'));
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  // A43: a CSV or XLSX export on its way to a document (the bytes, base64).
  const [table, setTable] = useState<{ name: string; contentBase64: string } | null>(null);
  // A43 §2, event identity: the table's events whose id is already booked, marked in the review (never swallowed):
  // the same figures, and the same id with other figures (the import refuses those event_amended).
  const [sameAsBooked, setSameAsBooked] = useState<ReadonlySet<string>>(new Set());
  const [sameIdOther, setSameIdOther] = useState<ReadonlySet<string>>(new Set());
  // D206: the days a whole-day table left out (shown above the rows), and the first or last days the person says
  // are complete (sent with the review and with Buchen, never written into the document).
  const [tableDays, setTableDays] = useState<DayView[]>([]);
  const [confirmEdgeDays, setConfirmEdgeDays] = useState<string[]>([]);
  const [fileDays, setFileDays] = useState<{ first: string; last: string } | null>(null);
  // The period the person picked; until then the review's own (the setting settlement.review_period).
  const [period, setPeriod] = useState<{ from: string; to: string; unit: string } | null>(null);
  const [compare, setCompare] = useState<'previous_period' | 'previous_year'>('previous_period');
  const [review, setReview] = useState<Review | null>(null);
  const [summary, setSummary] = useState<TurnoverSummary | null>(null);
  const [summaryError, setSummaryError] = useState<Err | null>(null);
  const [periods, setPeriods] = useState<SettlementPeriod[]>([]);
  const [loadError, setLoadError] = useState<Err | null>(null);
  const [actionError, setActionError] = useState<Err | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReviewRow | null>(null);
  const [onlyToBook, setOnlyToBook] = useState(false);
  const [tick, setTick] = useState(0);

  // A workspace switch resets the surface (DESIGN.md, D153).
  useEffect(() => {
    setFile(null);
    setTable(null);
    setTableDays((prev) => (prev.length === 0 ? prev : []));
    setConfirmEdgeDays((prev) => (prev.length === 0 ? prev : []));
    setFileDays(null);
    setPeriod(null);
    setReview(null);
    setSummary(null);
    setDetail(null);
    setDone(null);
    setActionError(null);
    setOnlyToBook(false);
  }, [workspaceId]);

  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = (loadSeq.current += 1);
    const input: Record<string, unknown> = { workspaceId };
    if (file !== null) input.content = file.content;
    if (confirmEdgeDays.length > 0) input.confirmEdgeDays = confirmEdgeDays;
    if (fileDays !== null) input.fileDays = fileDays;
    if (period !== null) {
      input.from = period.from;
      input.to = period.to;
    }
    const { body } = await client.call('settlement_review', input);
    // An answer overtaken by a newer read (another period, a file, a workspace switch) is dropped (D153).
    if (seq !== loadSeq.current) return;
    if (isErr(body)) {
      setLoadError(body);
      setReview(null);
      return;
    }
    setLoadError(null);
    setReview(body as unknown as Review);
  }, [client, workspaceId, file, period, confirmEdgeDays, fileDays]);

  useEffect(() => {
    if (canPost) void load();
  }, [load, canPost]);

  // The period shown: the person's pick, else the review's, else the quarter around today (a refused review).
  const shown = period ?? (review !== null ? review.period : null) ?? (loadError !== null ? { ...periodAround(todayIso(), 'quarter'), unit: 'quarter' } : null);
  const unit = unitOf(period?.unit ?? review?.period.unit);

  // THE FIGURES FROM THE BOOKS (D203 point 2): read for the period shown, whatever the review answered.
  const summarySeq = useRef(0);
  useEffect(() => {
    if (!canPost || shown === null) return;
    const seq = (summarySeq.current += 1);
    void client.call('turnover_summary', { workspaceId, from: shown.from, to: shown.to, compare }).then(({ body }) => {
      if (seq !== summarySeq.current) return;
      if (isErr(body)) {
        setSummaryError(body);
        setSummary(null);
        return;
      }
      setSummaryError(null);
      setSummary(body as unknown as TurnoverSummary);
    });
  }, [client, workspaceId, shown?.from, shown?.to, compare, canPost, tick]);

  // Each period's booking state, for the period control (booked, to book, empty).
  useEffect(() => {
    if (!canPost || shown === null) return;
    void client.call('settlement_periods', { workspaceId, unit, around: shown.from }).then(({ body }) => {
      if (!isErr(body)) setPeriods(((body as unknown as { periods?: SettlementPeriod[] }).periods ?? []) as SettlementPeriod[]);
    });
  }, [client, workspaceId, unit, shown?.from, canPost, tick]);

  const word = (e: Err): string => refusalText(t, e, { own: 'umsatz.refusal', known: KNOWN });

  /** Ignore or include at once: no reason is asked (D203 point 5); the engine keeps who and when. */
  async function toggle(row: ReviewRow) {
    if (review === null) return;
    setActionError(null);
    setDone(null);
    const ignore = row.included;
    const { body } =
      !ignore && row.includeVia === 'not_test'
        ? await client.call('resolve_settlement_event', {
            workspaceId,
            system: review.system,
            processor: review.processor,
            eventId: row.eventId,
            resolution: 'not_test',
            idempotencyKey: newKey('not-test'),
          })
        : await client.call('set_settlement_event_ignored', {
            workspaceId,
            system: review.system,
            processor: review.processor,
            eventId: row.eventId,
            ignored: ignore,
            idempotencyKey: newKey('answer'),
          });
    if (isErr(body)) {
      setActionError(body);
      return;
    }
    void load();
  }

  async function book() {
    if (review === null || review.toBook === 0 || busy) return;
    setBusy(true);
    setActionError(null);
    setDone(null);
    const { body } =
      review.mode === 'file' && file !== null
        ? await client.call('import_settlement', {
            workspaceId,
            settlement: reviewedPart(file.content, review.period),
            ...(confirmEdgeDays.length > 0 ? { confirmEdgeDays } : {}),
            ...(fileDays !== null ? { fileDays } : {}),
            expectReviewSha256: review.reviewSha256,
            idempotencyKey: newKey('import'),
          })
        : await client.call('pull_settlement', {
            workspaceId,
            system: review.system,
            processor: review.processor,
            from: review.period.from,
            to: review.period.to,
            expectReviewSha256: review.reviewSha256,
            idempotencyKey: newKey('pull'),
          });
    if (isErr(body)) {
      setActionError(body);
      // Something moved since the review: read the period again, so the next Buchen books what is shown now.
      if (body.error === 'review_stale') await load();
      setBusy(false);
      return;
    }
    const report = body as unknown as { booked?: number; import?: { booked?: number } | null };
    setDone(t('umsatz.booked', { count: report.booked ?? report.import?.booked ?? 0 }));
    setOnlyToBook(false);
    // The bar stays busy until the new review lands, so a second click never meets the old digest.
    await load();
    setTick((n) => n + 1);
    setBusy(false);
  }

  function clearDayMarks() {
    setTableDays((prev) => (prev.length === 0 ? prev : []));
    setConfirmEdgeDays((prev) => (prev.length === 0 ? prev : []));
    setFileDays(null);
  }

  async function pickFile(list: FileList | null) {
    const picked = list?.[0];
    if (picked === undefined) return;
    setPeriod(null);
    setDone(null);
    setActionError(null);
    setTab('zahlen');
    const bytes = new Uint8Array(await picked.arrayBuffer());
    // Sniffed by content, never by name: a JSON document starts with `{` (after a BOM or blanks).
    const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 64)).replace(/^﻿/, '').trimStart();
    setSameAsBooked(new Set());
    setSameIdOther(new Set());
    // Critic r1 L3: the whole-day marks of an earlier table never stay above another file.
    clearDayMarks();
    if (head.startsWith('{')) {
      setTable(null);
      setFile({ name: picked.name, content: new TextDecoder('utf-8').decode(bytes) });
      return;
    }
    setFile(null);
    setTable({ name: picked.name, contentBase64: base64Of(bytes) });
  }

  if (!canPost) return <PermissionDenied title={t('umsatz.title')} body={t('umsatz.denied')} />;

  const openFile = () => fileInput.current?.click();
  const fileControl = (
    <>
      {file === null && table === null ? (
        <IconButton icon="import" name={t('umsatz.loadFile')} context={t('umsatz.loadFileContext')} onClick={openFile} />
      ) : (
        <IconButton
          icon="close"
          name={t('umsatz.closeFile')}
          context={file?.name ?? table?.name ?? ''}
          onClick={() => {
            setFile(null);
            setTable(null);
            setPeriod(null);
            clearDayMarks();
          }}
        />
      )}
      <input
        ref={fileInput}
        type="file"
        accept=".json,.csv,.txt,.xlsx,application/json,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        hidden
        aria-hidden="true"
        tabIndex={-1}
        data-testid="umsatz-file-input"
        onChange={(e) => {
          void pickFile(e.target.files);
          e.target.value = '';
        }}
      />
    </>
  );

  const header = (
    <SurfaceHeader
      title={t('umsatz.title')}
      titleId={titleId}
      help={<SurfaceHelp surface="Umsatz" />}
      actions={
        <>
          {shown !== null && (
            <span className="umsatz-period">
              <Segmented
                label={t('umsatz.unit.label')}
                value={unit}
                options={(['month', 'quarter', 'year'] as const).map((u) => ({ value: u, label: t(`umsatz.unit.${u}`) }))}
                onChange={(u) => setPeriod({ ...periodAround(shown.from, u), unit: u })}
              />
              {/* The period is the shared Select (DESIGN.md rule 7: it opens below its trigger), each period with
                  its booking state in words. */}
              <Select
                id={`${titleId}-period`}
                value={`${shown.from}|${shown.to}`}
                onChange={(value) => {
                  const [from, to] = value.split('|');
                  if (from !== undefined && to !== undefined) setPeriod({ from, to, unit });
                }}
                options={periodOptions(shown, unit, periods, t)}
                ariaLabel={t('umsatz.period')}
              />
            </span>
          )}
          {fileControl}
        </>
      }
    />
  );

  if (table !== null && file === null) {
    return (
      <section className="umsatz" aria-labelledby={titleId}>
        {header}
        <TableIntake
          key={table.contentBase64.length + table.name}
          workspaceId={workspaceId}
          contentBase64={table.contentBase64}
          onDocument={(settlement, marks) => {
            setFile({ name: table.name, content: JSON.stringify(settlement) });
            setSameAsBooked(new Set(marks.same));
            setSameIdOther(new Set(marks.other));
            setTableDays(marks.days ?? []);
            setFileDays(marks.fileDays ?? null);
            setConfirmEdgeDays((prev) => (prev.length === 0 ? prev : []));
            setTable(null);
          }}
          onOtherFile={() => {
            setTable(null);
            openFile();
          }}
        />
      </section>
    );
  }

  const toBook = toBookOf(review);
  const rows = review === null ? [] : onlyToBook ? review.rows.filter((r) => r.status === 'to_book') : review.rows;

  const events = (() => {
    if (loadError !== null && review === null) {
      // A configuration state is a calm line with the way there; only a transient read offers a retry.
      if (CONFIG_STATES.has(loadError.error)) {
        return (
          <div className="umsatz-calm" role="status">
            <span>{word(loadError)}</span>
            <Link className="btn btn--ghost btn--sm" to="/bank-accounts">
              {t('umsatz.start.connect')}
            </Link>
          </div>
        );
      }
      return <ErrorBanner message={word(loadError)} onRetry={() => void load()} context="read" />;
    }
    if (review === null) return <Skeleton />;
    if (review.mode === 'none') {
      // D203 point 3: no source is a calm start, never an error. Two ways in.
      return (
        <div className="umsatz-start" aria-label={t('umsatz.start.label')}>
          <button type="button" className="umsatz-start-way" onClick={openFile}>
            <UploadGlyph size={20} />
            <span>{t('umsatz.start.file')}</span>
          </button>
          <Link className="umsatz-start-way" to="/bank-accounts">
            <BankGlyph size={20} />
            <span>{t('umsatz.start.connect')}</span>
          </Link>
        </div>
      );
    }
    return (
      <>
        <div className="umsatz-events-head">
          <h2 className="umsatz-subhead">{t('umsatz.events')}</h2>
          <Check label={t('umsatz.checkPayouts')} state={review.checks.payouts.state} lines={payoutLines(t, review)} />
          <Check
            label={t('umsatz.checkVat')}
            state={review.checks.vat.state}
            lines={[t(`umsatz.check.vat.${review.checks.vat.state}`, { count: review.checks.vat.differing.length })]}
          />
          {onlyToBook && (
            <IconButton icon="close" small name={t('umsatz.showAll')} context={t('umsatz.figures.toBook')} onClick={() => setOnlyToBook(false)} />
          )}
        </div>
        {rows.length === 0 ? (
          <EmptyState title={t('umsatz.empty')} hint="" />
        ) : (
          <table className="umsatz-table">
            <caption className="visually-hidden">{t('umsatz.caption', { from: formatDate(review.period.from), to: formatDate(review.period.to) })}</caption>
            <thead>
              <tr>
                <th scope="col">{t('umsatz.col.day')}</th>
                <th scope="col">
                  <span className="visually-hidden">{t('umsatz.col.kind')}</span>
                </th>
                <th scope="col">{t('umsatz.col.who')}</th>
                <th scope="col" className="num">
                  {t('umsatz.col.amount')}
                </th>
                <th scope="col" className="num">
                  {t('umsatz.col.vat')}
                </th>
                <th scope="col">
                  <span className="visually-hidden">{t('umsatz.col.derivation')}</span>
                </th>
                <th scope="col">
                  <span className="visually-hidden">{t('umsatz.col.status')}</span>
                </th>
                <th scope="col">
                  <span className="visually-hidden">{t('umsatz.col.include')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <EventRow
                  key={row.rowKey ?? `${row.eventId}:${i}`}
                  row={row}
                  onToggle={() => void toggle(row)}
                  onDetail={() => setDetail(row)}
                  sameAsBooked={sameAsBooked.has(row.eventId)}
                  sameIdOther={sameIdOther.has(row.eventId)}
                />
              ))}
            </tbody>
          </table>
        )}
      </>
    );
  })();

  const zahlen = (
    <div className="umsatz-zahlen">
      <div className="umsatz-compare">
        <Segmented
          label={t('umsatz.figures.compareLabel')}
          value={compare}
          options={[
            { value: 'previous_period', label: t('umsatz.figures.compareWord.previous_period') },
            { value: 'previous_year', label: t('umsatz.figures.compareWord.previous_year') },
          ]}
          onChange={setCompare}
        />
      </div>
      {summaryError !== null && <ErrorBanner message={word(summaryError)} context="read" />}
      <KpiTiles summary={summary} toBook={toBook} onlyToBook={onlyToBook} onToBook={() => setOnlyToBook((v) => !v)} />
      {summary !== null && <Breakdowns summary={summary} />}
      {actionError !== null && <ErrorBanner message={word(actionError)} />}
      {done !== null && (
        <p className="umsatz-done" role="status">
          {done}
        </p>
      )}
      <DayLines days={tableDays} />
      <EdgeDays
        days={[...new Set((review?.rows ?? []).filter((r) => r.code === 'edge_day_unconfirmed').map((r) => r.day))].sort()}
        confirmed={confirmEdgeDays}
        near={tableDays}
        onConfirm={(day) => setConfirmEdgeDays((prev) => (prev.includes(day) ? prev : [...prev, day]))}
        onUndo={(day) => setConfirmEdgeDays((prev) => prev.filter((d) => d !== day))}
      />
      <section className="umsatz-events" aria-label={t('umsatz.events')}>
        {events}
      </section>
    </div>
  );

  return (
    <section className={`umsatz${review !== null && review.toBook > 0 ? ' umsatz--bar' : ''}`} aria-labelledby={titleId}>
      {header}
      <Tabs
        label={t('umsatz.tabs')}
        activeId={tab}
        onChange={(id) => setTab(id === 'regeln' ? 'regeln' : 'zahlen')}
        tabs={[
          { id: 'zahlen', label: t('umsatz.tab.zahlen'), panel: zahlen },
          {
            id: 'regeln',
            label: t('umsatz.tab.regeln'),
            // Read only while the tab is open: the figures never wait on the rules.
            panel:
              tab === 'regeln' ? (
                <UmsatzRules
                  workspaceId={workspaceId}
                  clearing={summary?.accounts.clearing ?? []}
                  onChanged={() => {
                    void load();
                    setTick((n) => n + 1);
                  }}
                />
              ) : null,
          },
        ]}
      />
      {/* D203 point 4: Buchen is a bar that is there only while something is ready to book (pick A). */}
      {review !== null && toBook !== null && review.toBook > 0 && (
        <div className="umsatz-bookbar" role="region" aria-label={t('umsatz.bookBar')}>
          <span className="umsatz-bookbar-what">
            {t('umsatz.bookBarWhat', { count: toBook.count, net: formatMoney(toBook.netMinor, CURRENCY), vat: formatMoney(toBook.vatMinor, CURRENCY) })}
          </span>
          {toBook.outside > 0 && (
            <Tooltip content={t('umsatz.outsidePeriod')}>
              <span className="umsatz-bookbar-outside" tabIndex={0} role="img" aria-label={`${t('umsatz.bookBarOutside', { count: toBook.outside })}: ${t('umsatz.outsidePeriod')}`}>
                {t('umsatz.bookBarOutside', { count: toBook.outside })}
              </span>
            </Tooltip>
          )}
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void book()}>
            {busy ? t('umsatz.booking') : t('umsatz.book')}
          </button>
        </div>
      )}
      {detail !== null && <DerivationDrawer row={detail} onClose={() => setDetail(null)} />}
    </section>
  );
}

/** Today in Zurich, as the engine reads it (`zurichParts`), for a page whose review was refused. */
function todayIso(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/**
 * The periods a person can pick: eight before the one shown, the one shown and four after, in its unit (a custom
 * range steps by quarter); the one shown is always among them. Each carries its booking state in words when
 * `settlement_periods` named it.
 */
export function periodOptions(
  shown: { from: string; to: string },
  unit: string,
  states: readonly SettlementPeriod[] = [],
  t?: (key: string) => string,
): { value: string; label: string }[] {
  const before: { from: string; to: string }[] = [];
  let p = shown;
  for (let k = 0; k < 8; k += 1) {
    p = shiftPeriod(p.from, unit, -1);
    before.unshift(p);
  }
  const after: { from: string; to: string }[] = [];
  p = shown;
  for (let k = 0; k < 4; k += 1) {
    p = shiftPeriod(p.from, unit, 1);
    after.push(p);
  }
  const stateOf = new Map(states.map((s) => [`${s.from}|${s.to}`, s.state]));
  return [...before, shown, ...after].map((r) => {
    const value = `${r.from}|${r.to}`;
    const range = `${formatDate(r.from)} – ${formatDate(r.to)}`;
    const state = stateOf.get(value);
    return { value, label: state !== undefined && t !== undefined ? `${range} · ${t(`umsatz.periodState.${state}`)}` : range };
  });
}

/** D206: one line per day the whole-day table left out of the document, with both sides where they differ. */
export function DayLines({ days }: { days: DayView[] }) {
  const { t } = useI18n();
  const shown = days.filter((d) => d.status !== 'new' && d.status !== 'passed' && d.status !== 'edge_unconfirmed' && d.status !== 'edge_excluded');
  if (shown.length === 0) return null;
  return (
    <ul className="umsatz-days" aria-label={t('umsatz.days.label')}>
      {shown.map((d) => {
        const Glyph = d.status === 'in_books' ? StatusSuccessGlyph : d.status === 'differs' ? StatusDangerGlyph : StatusInactiveGlyph;
        const text = t(`umsatz.days.${d.status}`, {
          day: formatDate(d.day),
          booked: formatMoney(d.books?.amountMinor ?? 0, CURRENCY),
          file: formatMoney(d.file.amountMinor, CURRENCY),
        });
        return (
          <li key={d.day}>
            <Glyph size={16} /> {text}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * D206: a day of a whole-day file the import holds back until the person answers: the first or last day (is it
 * complete?) or a day next to a booked day sharing an amount (is it its own row?, critic r4 H-1).
 */
export function EdgeDays({
  days,
  confirmed,
  near = [],
  onConfirm,
  onUndo,
}: {
  days: string[];
  confirmed: string[];
  /** Critic r2 M-A: the door's days, so an edge next to a held day names the amounts it shares with it. */
  near?: DayView[];
  onConfirm: (day: string) => void;
  onUndo: (day: string) => void;
}) {
  const { t } = useI18n();
  const askText = (day: string): string => {
    const n = near.find((d) => d.day === day)?.nearHeld;
    if (n === undefined) return t('umsatz.edge.ask', { day: formatDate(day) });
    return t('umsatz.edge.near', { day: formatDate(day), amounts: n.amountsMinor.map((a) => formatMoney(a, CURRENCY)).join(', '), neighbour: formatDate(n.day) });
  };
  const asked = days.filter((d) => !confirmed.includes(d));
  if (asked.length === 0 && confirmed.length === 0) return null;
  return (
    <ul className="umsatz-days" aria-label={t('umsatz.edge.label')}>
      {asked.map((day) => (
        <li key={day}>
          <StatusWarnGlyph size={16} /> {askText(day)}
          <IconButton icon="approve" small name={t('umsatz.edge.confirm', { day: formatDate(day) })} context={t('umsatz.edge.context')} onClick={() => onConfirm(day)} />
        </li>
      ))}
      {/* Critic r1 L3: a confirmed edge day stays visible, with its undo, until Buchen. */}
      {confirmed.map((day) => (
        <li key={`c-${day}`}>
          <StatusSuccessGlyph size={16} /> {t('umsatz.edge.confirmed', { day: formatDate(day) })}
          <IconButton icon="restore" small name={t('umsatz.edge.undo', { day: formatDate(day) })} context={t('umsatz.edge.context')} onClick={() => onUndo(day)} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The words of check (a): its state, then every payout the books do not explain (its rest) and every payout its
 * stated members leave a gap in (the gap), and, only beside a gap, the producer's warnings as its stated causes
 * (owner 13.11.2026: never silently passed or failed).
 */
export function payoutLines(t: (key: string, vars?: Record<string, string | number>) => string, review: Review): string[] {
  const lines = [t(`umsatz.check.payouts.${review.checks.payouts.state}`)];
  for (const p of review.checks.payouts.payouts) {
    const day = formatDate(p.day);
    if (p.restMinor !== null && p.restMinor !== 0) lines.push(t('umsatz.check.payouts.rest', { day, amount: formatMoney(p.restMinor, CURRENCY) }));
    // What the engine set apart is never silent (code critic r4 M1): the clearing account keeps it.
    if (p.testRestMinor !== 0) lines.push(t('umsatz.check.payouts.test', { day, amount: formatMoney(p.testRestMinor, CURRENCY) }));
    if (p.skippedRestMinor !== 0) lines.push(t('umsatz.check.payouts.skipped', { day, amount: formatMoney(p.skippedRestMinor, CURRENCY) }));
    if ((p.openingRestMinor ?? 0) !== 0) lines.push(t('umsatz.check.payouts.opening', { day, amount: formatMoney(p.openingRestMinor ?? 0, CURRENCY) }));
  }
  const gaps = review.checks.payouts.payouts.filter((p) => p.unexplainedMinor !== null && p.unexplainedMinor !== 0);
  for (const p of gaps) lines.push(t('umsatz.check.payouts.gap', { day: formatDate(p.day), amount: formatMoney(p.unexplainedMinor ?? 0, CURRENCY) }));
  if (gaps.length > 0) for (const w of review.warnings ?? []) lines.push(w);
  return lines;
}

function Check({ label, state, lines }: { label: string; state: CheckState; lines: string[] }) {
  const Glyph = state === 'ok' ? StatusSuccessGlyph : state === 'differs' ? StatusDangerGlyph : StatusWarnGlyph;
  const content = (
    <span className="umsatz-lines">
      {lines.map((l, i) => (
        <span key={i}>{l}</span>
      ))}
    </span>
  );
  return (
    <span className="umsatz-checkline">
      <span>{label}</span>
      <Tooltip content={content}>
        <span className={`umsatz-check umsatz-check--${state}`} role="img" tabIndex={0} aria-label={lines.join('. ')}>
          <Glyph size={18} />
        </span>
      </Tooltip>
    </span>
  );
}

/** One event in the row: Ignorieren and Einbeziehen at once, no reason asked (D203 point 5). */
function EventRow({
  row,
  onToggle,
  onDetail,
  sameAsBooked = false,
  sameIdOther = false,
}: {
  row: ReviewRow;
  onToggle: () => void;
  onDetail: () => void;
  /** A43: a table row whose id is already booked with the same figures. */
  sameAsBooked?: boolean;
  /** A43: a table row whose id is booked with other figures (the import refuses it event_amended). */
  sameIdOther?: boolean;
}) {
  const { t } = useI18n();
  const Kind = KIND_GLYPH[row.kind] ?? HelpGlyph;
  // A booked row that carries a code (the producer restated it, or what it states now cannot be read) says so: the
  // warning glyph and the sentence beside "Gebucht", never a plain booked row (code critic r7 M1).
  const bookedNote =
    row.status === 'booked' && sameAsBooked
      ? t('umsatz.status.sameAsBooked')
      : row.status === 'booked' && (row.unreadable === true || (row.code !== null && row.code !== undefined))
        ? (row.sentence ?? row.code)
        : null;
  const statusWord = sameIdOther
    ? t('umsatz.status.sameIdOther')
    : bookedNote !== null
      ? t('umsatz.status.bookedNote', { note: bookedNote })
      : row.status === 'booked' || row.status === 'to_book'
        ? t(`umsatz.status.${row.status}`)
        : row.code !== null && row.code !== undefined && (DAY_CODES as readonly string[]).includes(row.code)
          ? t(`umsatz.dayCode.${row.code}`)
          : (row.sentence ?? t(`umsatz.status.${row.status}`));
  const StatusGlyph =
    bookedNote !== null
      ? StatusWarnGlyph
      : row.status === 'booked'
        ? StatusSuccessGlyph
        : row.status === 'to_book'
          ? StatusPendingGlyph
          : row.status === 'refused'
            ? StatusDangerGlyph
            : StatusInactiveGlyph;
  const who = row.counterparty;
  const first = who.email ?? who.name ?? who.document ?? who.chargeId ?? (row.eventId !== '' ? row.eventId : t('umsatz.noId'));
  const second = who.email !== null ? who.name : null;
  return (
    <tr className={['umsatz-row', row.included ? '' : 'umsatz-row--ignored', row.outsidePeriod ? 'umsatz-row--outside' : ''].filter(Boolean).join(' ')} data-event={row.eventId !== '' ? row.eventId : row.rowKey}>
      <td>
        {row.outsidePeriod ? (
          <Tooltip content={t('umsatz.outsidePeriod')}>
            <span role="img" tabIndex={0} aria-label={`${formatDate(row.day)}, ${t('umsatz.outsidePeriod')}`}>
              {formatDate(row.day)}
            </span>
          </Tooltip>
        ) : (
          formatDate(row.day)
        )}
      </td>
      <td className="umsatz-kind">
        <Tooltip content={t(`umsatz.kind.${row.kind}`)}>
          <span role="img" tabIndex={0} aria-label={t(`umsatz.kind.${row.kind}`)}>
            <Kind size={16} />
          </span>
        </Tooltip>
        {row.test && (
          <Tooltip content={t('umsatz.test')}>
            <span role="img" tabIndex={0} aria-label={t('umsatz.test')} className="umsatz-test">
              <TagGlyph size={14} />
            </span>
          </Tooltip>
        )}
      </td>
      <td className="umsatz-who">
        <span>{who.masked ? t('umsatz.masked') : first}</span>
        {second !== null && <span className="umsatz-who-second">{second}</span>}
      </td>
      <td className="num t-money">{formatMoney(row.amountMinor, CURRENCY)}</td>
      <td className="num t-money">{row.vatMinor === null ? '' : formatMoney(row.vatMinor, CURRENCY)}</td>
      <td className="umsatz-derivation">{row.derivation !== null && <DerivationChips row={row} derivation={row.derivation} onOpen={onDetail} />}</td>
      <td>
        <Tooltip content={statusWord}>
          <span role="img" tabIndex={0} aria-label={statusWord} className={`umsatz-status umsatz-status--${row.status}`}>
            <StatusGlyph size={16} />
          </span>
        </Tooltip>
      </td>
      <td>
        {row.toggleable &&
          (row.included ? (
            <IconButton icon="ignore" small context={inclusionWho(t, row)} onClick={onToggle} />
          ) : (
            <IconButton icon="restore" small name={t('umsatz.include')} context={inclusionWho(t, row)} onClick={onToggle} />
          ))}
      </td>
    </tr>
  );
}

/** Who answered and when, the change log's words on the toggle's hover (no reason is asked). */
function inclusionWho(t: (key: string, vars?: Record<string, string | number>) => string, row: ReviewRow): string {
  const i = row.inclusion;
  if (i.actor === null || i.at === null) return '';
  return t('umsatz.answeredBy', { who: i.actor, at: formatDate(i.at.slice(0, 10)) });
}

/** A platform fee in basis points as a rate (990: 9.9 %). */
function rateOfBp(bp: number | null): string {
  return bp === null ? '' : `${(bp / 100).toFixed(2).replace(/\.?0+$/, '')} %`;
}

/** One glyph chip: its mark, its words on hover (the chip is no tab stop: the info button opens every figure). */
function Chip({ words, tone, children }: { words: string; tone?: 'waived' | 'ok' | 'bad'; children: ReactElement | string }) {
  return (
    <Tooltip content={words}>
      <span className={`umsatz-chip${tone !== undefined ? ` umsatz-chip--${tone}` : ''}`} role="img" aria-label={words}>
        {children}
      </span>
    </Tooltip>
  );
}

/**
 * How a sale is derived, at one glance: the platform fee (taken with its rate and amount, or waived with its
 * reason), the processing fee, the coach payout, the VAT rate, the verdict. Each figure on hover; everything in
 * the drawer. A refund or a fee row shows what its refs state (the VAT rate, the verdict).
 */
export function DerivationChips({ row, derivation: d, onOpen }: { row: ReviewRow; derivation: Derivation; onOpen: () => void }) {
  const { t } = useI18n();
  const money = (m: number) => formatMoney(m, CURRENCY);
  const fee = d.platformFee;
  const coach = d.coachTransferMinor ?? d.selfBill.amountMinor ?? d.coachPayoutExpectedMinor;
  return (
    <span className="umsatz-chips">
      {row.kind === 'sale' && fee.waived === true && (
        <Chip tone="waived" words={t('umsatz.derivation.feeWaived', { reason: t(`umsatz.derivation.waiver.${fee.waiverReason ?? 'none'}`) })}>
          %
        </Chip>
      )}
      {row.kind === 'sale' && fee.waived !== true && fee.amountMinor !== null && (
        <Chip words={t('umsatz.derivation.fee', { rate: rateOfBp(fee.bp), amount: money(fee.amountMinor) })}>%</Chip>
      )}
      {row.kind === 'sale' && d.processingFeeMinor !== null && (
        <Chip words={t('umsatz.derivation.processing', { amount: money(d.processingFeeMinor) })}>
          <ExchangeGlyph size={14} />
        </Chip>
      )}
      {row.kind === 'sale' && coach !== null && (
        <Chip words={t('umsatz.derivation.coach', { amount: money(coach) })}>
          <PersonGlyph size={14} />
        </Chip>
      )}
      {d.vatRatePercent !== null && <Chip words={t('umsatz.derivation.vat', { rate: d.vatRatePercent })}>{d.vatRatePercent}</Chip>}
      {d.ok !== null && (
        <Chip tone={d.ok ? 'ok' : 'bad'} words={t(d.ok ? 'umsatz.derivation.ok' : 'umsatz.derivation.notOk')}>
          {d.ok ? <StatusSuccessGlyph size={14} /> : <StatusDangerGlyph size={14} />}
        </Chip>
      )}
      <IconButton icon="info" small name={t('umsatz.derivation.open')} context="" onClick={onOpen} />
    </span>
  );
}

/** Every figure and id of one event's derivation, in the shared drawer; a figure the refs do not state is left out. */
export function DerivationDrawer({ row, onClose }: { row: ReviewRow; onClose: () => void }) {
  const { t } = useI18n();
  const d = row.derivation;
  const money = (m: number | null) => (m === null ? null : formatMoney(m, CURRENCY));
  const yesNo = (b: boolean | null) => (b === null ? null : t(b ? 'umsatz.derivation.yes' : 'umsatz.derivation.no'));
  const verdict = (b: boolean | null) => (b === null ? null : t(b ? 'umsatz.derivation.ok' : 'umsatz.derivation.notOk'));
  const fee = d?.platformFee;
  const feeText =
    fee === undefined
      ? null
      : fee.waived === true
        ? t('umsatz.derivation.feeWaived', { reason: t(`umsatz.derivation.waiver.${fee.waiverReason ?? 'none'}`) })
        : fee.amountMinor !== null
          ? [rateOfBp(fee.bp), money(fee.amountMinor)].filter((x) => x !== null && x !== '').join(', ')
          : null;
  const items: [string, string | null][] = [
    ['gross', money(row.amountMinor)],
    ['vat', row.vatMinor === null ? null : [money(row.vatMinor), d !== null && d.vatRatePercent !== null ? `${d.vatRatePercent} %` : null].filter(Boolean).join(', ')],
    ['net', money(row.netMinor)],
    ['payoutNet', money(d?.payoutNetMinor ?? null)],
    ['fee', feeText],
    ['processing', [money(d?.processingFeeMinor ?? null), d?.processingFeeSource ?? null].filter(Boolean).join(', ') || null],
    ['expected', money(d?.coachPayoutExpectedMinor ?? null)],
    ['selfBill', [d?.selfBill.number ?? null, money(d?.selfBill.amountMinor ?? null)].filter(Boolean).join(', ') || null],
    ['transfer', money(d?.coachTransferMinor ?? null)],
    ['adjustment', money(d?.coachPayoutAdjustmentMinor ?? null)],
    ['coachVat', yesNo(d?.coachVatRegistered ?? null)],
    ['producer', d === null ? null : [verdict(d.stated.ok), d.stated.diffMinor !== null && d.stated.diffMinor !== 0 ? money(d.stated.diffMinor) : null].filter(Boolean).join(', ') || null],
    ['till', verdict(d?.till ?? null)],
    ['derivedFrom', d?.derivedFrom ?? null],
    ['sellerRole', d?.sellerRole ?? null],
    ['vatRule', d?.vatRule ?? null],
    ['bookingId', d?.ids.bookingId ?? null],
    ['sessionId', d?.ids.sessionId ?? null],
    ['liveSessionId', d?.ids.liveSessionId ?? null],
    ['paymentIntentId', d?.ids.paymentIntentId ?? null],
    ['chargeId', d?.ids.chargeId ?? row.counterparty.chargeId],
    ['transferId', d?.ids.transferId ?? null],
    ['payoutId', d?.ids.payoutId ?? null],
    ['document', row.counterparty.document],
    ['trimmed', d?.refsTrimmed === true ? t('umsatz.derivation.yes') : null],
  ];
  return (
    <DetailDrawer open title={`${t(`umsatz.kind.${row.kind}`)}, ${formatDate(row.day)}`} closeLabel={t('umsatz.derivation.close')} onClose={onClose}>
      <dl className="umsatz-derivation-list">
        {items
          .filter((it): it is [string, string] => it[1] !== null && it[1] !== '')
          .map(([key, value]) => (
            <div key={key} className="umsatz-derivation-item">
              <dt>{t(`umsatz.derivation.field.${key}`)}</dt>
              <dd className={key.endsWith('Id') || key === 'derivedFrom' || key === 'sellerRole' || key === 'vatRule' ? 'umsatz-code' : 'num t-money'}>{value}</dd>
            </div>
          ))}
      </dl>
    </DetailDrawer>
  );
}

export default Umsatz;
