/**
 * A2, "Bank" (`/bank`): the bank inbox, the owner-facing half of the bank process, on the A39 engine,
 * in the layout the owner picked on 01.10.2026: B2 "Eine Zeile Kontext" (spec A39 §6.1).
 *
 * ONE INBOX (the bank-process judge's outcome 1). Every line of every imported statement, of every
 * Bankkonto, in one list, newest first; a statement is a fact the line carries, never a screen to open
 * in turn. Three views of the same lines by their ONE state (open; booked or matched; ignored), a
 * search the engine runs (counterparty, text, reference, IBAN, amount) and facets on what the proposal
 * says (needs you, sure) and on the money's direction.
 *
 * NOTHING OPENS BY ITSELF, AND ONE LAYOUT AT EVERY WIDTH (B2). No line is selected on load and there is
 * no side panel. A line is selected by the person's act (a click on its row, Enter or Space on the
 * focused row) or by a deep link (`?line=`, `?credit=`), and then its Details show in the side panel (D177,
 * which retired B2's context strip; a drawer below 1180 px). B2 showed under the row:
 * how sure, why, the VAT split, the rare actions as icons. Measured before it, on the picker: the first
 * line opened by itself as a block inside the list on every laptop, one line visible at 1280x800 behind
 * 81 words.
 *
 * REDUCED TO MAX (D167, 14.10.2026). One decision per row: the account (× clears it, ☆ makes it the
 * counterparty's standard), MWST as a field, the paperclip, Buchen. A line an agent drafted books with the
 * same Buchen (no "Prüfen"): unedited it approves the pinned Vorschlag, edited it books the person's version
 * first and only then closes the Vorschlag. "Brauchen dich" and the directions live in one Filter menu.
 *
 * EVERY LINE IS DECIDED ON ITS ROW (outcome 2), credits and debits alike, with the verb the agent
 * would call: `book_bank_line` (to accounts with VAT, to an open invoice or bill, to a payment run, or
 * matched to an entry already on the books), `ignore_bank_line`, and in the Gebucht view
 * `reopen_bank_line` ("Stornieren", "Abgleich lösen", "Wieder zu buchen": every undo, outcome 7).
 * Nothing here is a second path to the books: the GUI and the agent call the same verbs, and a pending
 * agent Vorschlag for a line shows ON the line, in words, with the same consequence sentence (outcome
 * 8). No rules, no rebooking into another period (spec §6).
 *
 * THE BALANCE IS THE ARBITER (owner answer 1, outcome 3; spec L4). One line per account names the
 * difference; its card holds bank = books + open lines + difference in the engine's own figures. One
 * number per question (outcome 10): the tab counts are the engine's totals per state, the balance line
 * is the engine's summary, nothing is recounted here.
 *
 * FIRST RUN LEADS (outcome 9): no Bankkonto says so and links to create one; no statement makes the
 * import the primary action with a drop zone; an import confirms with its new lines, highlighted.
 *
 * Capability gates (A24) pre-disable or hide what the role cannot do, with the reason on the control;
 * the engine's refusal remains the real gate and renders with its cause and fix (outcome 5).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useKeyboardOptional } from '../../app/keyboard';
import { CAP, useCan, useCapabilities } from '../../lib/capabilities';
import { consequenceSentence } from '../../lib/approval-tiers';
import { useT, useI18n, formatDate, formatMoney } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, refusalText, useRevealAfterDelay } from '../../components/states';
import { channelRefusal, numberJumpText } from '../BankAccounts/channelWording';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { Tabs } from '../../components/Tabs';
import { TooltipPortalContext } from '../../components/Tooltip';
import { PickerButton } from '../../components/AccountCombobox';
import { OverflowMenu } from '../../components/OverflowMenu';
import { ActionFeedback } from '../../components/ActionFeedback';
import { useCommitAck, useCommitAckState } from '../../lib/motion';
import { FileDrop } from '../../components/FileDrop';
import { useBankFetch } from './useBankFetch';
import { useAttachReceipt } from './useAttachReceipt';
import type {
  BankAccountBalance,
  BankAccountOption,
  BankInboxLine,
  DraftTarget,
  IgnoreReason,
  LineVorschlag,
  RowDraft,
} from './model';
import {
  bookCapability,
  bookTargetOf,
  bookingTargetFor,
  ignoreInputOf,
  lineFollowUp,
  lineVorschlag,
  draftFromProposal,
  draftFromVorschlag,
  draftTargetOf,
  isBookable,
  isCredit,
  lineDate,
  isSureAndUntouched,
  isUntouched,
  parseBankAccounts,
  parseBatches,
  parseBills,
  parseChart,
  parseInbox,
  parseInvoices,
  parseStandards,
  parseTaxCodes,
  parseVorschlaege,
  proposalTarget,
  targetKey,
} from './model';
import { EMPTY_LOOKUPS, accountLabel, bookedToPhrase, buildLookups, entryDateOf, lineDateLong, partyOf, plural, targetPhrase, vatPickerShows, type Lookups } from './lookups';
import { useEntries } from './panelData';
import { taxCodeFieldName } from '../../components/TaxCodeCombobox';
import { DecidedRow, OpenRow } from './InboxRow';
import { DetailsPanel, type PanelMode } from './DetailsPanel';
import { SplitRows } from './SplitRows';
import { DetailDrawer } from '../../components/DetailDrawer';
import { bookingTextToSend, bookStateOf, defaultBookingText, splitStateOf, splitTargetOf, startSplit, type SplitDraft } from './rowState';
import { ruleTargetOf } from './pickers';
import { TrustLine, TrustSummary } from './TrustLine';
import { ImportDialog, type ImportResult } from './ImportDialog';
import type { FileOutcome } from './importOutcomes';
import { announceAttentionChanged } from '../Attention/attentionSummary';
import { PickBar } from './PickBar';
import { MenuButton } from './MenuButton';
import { controlAccountsIn } from './ControlAccountWarning';
import type { RefusalAction } from './errors';
import { FetchGlyph, FilterGlyph, SearchGlyph } from './glyphs';
import type { RulePayload } from './RuleEditor';
import { RulesSheet } from './RulesSheet';
import { ruleInputOf } from './rules';
import { COMPACT_PARTY_WIDTH, DEFAULT_COLUMN_WIDTHS, PANEL_BESIDE_MIN_VIEWPORT, useColumnWidths, type ResizableColumn } from './columns';
import { ColumnResizer } from './ColumnResizer';
import { DetailArea, DetailDivider, DrawerArea, useDockDrag } from './DetailArea';
import { FactsCard } from './FactsCard';
import { DuplicateCheck } from './DuplicateCheck';
import { DirectionFilter, ListCount, PeriodFilter, isoDateOrNull, periodInverted } from './ListControls';
import { duplicateFlagOf } from './statementFacts';
import { useDetailLayout, useMeasuredRoom, usePageFit } from './useDetailLayout';
import { usePref } from '../../lib/prefs';
import type { FocusNav } from './BookingModes';
import './Bank.css';

type Tab = 'open' | 'booked' | 'ignored';

/** The tab a line's state lives in. */
function tabOf(state: BankInboxLine['state']): Tab {
  return state === 'open' ? 'open' : state === 'ignored' ? 'ignored' : 'booked';
}
/**
 * The facets. `needs` and `sure` are the ENGINE's (`attention` on each open line, A39 §11), so the
 * Übersicht band's counts and these lists can never disagree; `noreceipt` (D142) is the Gebucht tab's
 * "Ohne Beleg", the engine's `needsReceipt`. Deep links name them: `/bank?facet=needs`.
 */
type Facet = 'all' | 'needs' | 'sure' | 'noreceipt';
const FACETS: readonly Facet[] = ['all', 'needs', 'sure', 'noreceipt'];
function facetOf(raw: string | null): Facet {
  return FACETS.find((f) => f === raw) ?? 'all';
}
/** The money's direction (`?dir=in|out`); the older `?facet=in|out` still reads. */
type Direction = 'all' | 'in' | 'out';
function directionOf(dir: string | null, facet: string | null): Direction {
  const raw = dir ?? facet;
  return raw === 'in' || raw === 'out' ? raw : 'all';
}

const PAGE = 200;
/** D167: the reason a Vorschlag is closed with when the person booked the line their own way. */
const SELF_BOOKED_REASON = 'selbst gebucht';
/** The most lines "Konten vorschlagen" names in one call: the engine's `MODEL_SUGGEST_IDS_MAX`. */
const SUGGEST_IDS_MAX = 200;
/** Skeleton rows: about the lines a laptop shows, so nothing grows when the data lands. */
const SKELETON_ROWS = 12;
/** The account filter's "Alle Konten" option id (an option id is never empty). */
const ALL_ACCOUNTS = '__all__';
/**
 * D177: the Details panel sits beside the table from 1180 px on (a normal laptop window), the table
 * narrower (`PANEL_COLUMN_WIDTHS`, the account field flexing); below it the panel is the shared drawer.
 * Without `matchMedia` (jsdom) the panel sits beside.
 */
const PANEL_BESIDE_QUERY = `(min-width: ${PANEL_BESIDE_MIN_VIEWPORT}px)`;
/**
 * UX judge round 2, item 12: the calm status line goes by itself after this long, or with the next click
 * outside it. It holds while the pointer rests on it or focus is in it (its Rückgängig stays reachable).
 */
export const STATUS_DISMISS_MS = 6000;

function useWideLayout(): boolean {
  const query = () => typeof window === 'undefined' || typeof window.matchMedia !== 'function' || window.matchMedia(PANEL_BESIDE_QUERY).matches;
  const [wide, setWide] = useState(query);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(PANEL_BESIDE_QUERY);
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return wide;
}

/** Where the list stands: the offset of each status read and how many lines the earlier pages showed. */
interface PageAt {
  offsets: readonly number[];
  before: number;
}
const FIRST_PAGE: PageAt = { offsets: [], before: 0 };

interface InboxData {
  lines: BankInboxLine[];
  total: number;
  summary: BankAccountBalance[];
  /** D178 E3 (A39 §17.6): the same filters without the direction, per direction (null: not answered). */
  directionCounts: { in: number; out: number } | null;
  /** Some status read answered a next cursor: more lines follow this page. */
  more: boolean;
  /** Per status read, in order: how many lines it returned on this page. */
  returned: number[];
}

interface Ack {
  id: number;
  tone: 'success' | 'info' | 'warn';
  message: string;
  detail?: string;
  /** An undo or a follow-up the ack offers in place. */
  action?: { label: string; run: () => void };
  /** A second follow-up beside it (D178 point 19: an import's "Alle exakten Treffer sind Duplikate"). */
  extra?: { label: string; run: () => void };
  /**
   * D167 polish 2: a small act that went as asked (Buchen, a standard, a Beleg, Ignorieren) says so in
   * the toolbar's one calm status line, announced and never moving the table. A warning or a refusal
   * still takes the banner: it needs the person's attention.
   */
  quiet?: boolean;
}

/**
 * Where focus goes once a decision has re-read the list: the next ROW, never its Buchen (critic F3). A
 * held or a second Enter then selects the row at most; it never books a line nobody chose. D178 N2: when the
 * detail area closes, focus goes back to its line's row, or to the list when that row has left the view.
 */
interface FocusRequest {
  lineId: string;
  /** The row is not drawn (filtered away): the list takes the focus instead of waiting for the row. */
  orList?: boolean;
}

/**
 * True when the person has put the focus somewhere other than the decided line while its write was in
 * flight: on another line's row or Details, or anywhere outside the list (critic round 2). Focus that is
 * still on the decided line, or lost to the page because its control went away, is not the person's.
 */
function focusMovedAway(lineId: string): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return false;
  const holder = active.closest<HTMLElement>('[data-line], [data-panel-for], [data-split-for]');
  if (holder === null) return true;
  return (holder.dataset.line ?? holder.dataset.panelFor ?? holder.dataset.splitFor) !== lineId;
}

/** The Details panel's Buchen for a line, when the panel shows that line (compared as data). */
function panelBook(lineId: string): HTMLButtonElement | null {
  for (const body of document.querySelectorAll<HTMLElement>('[data-panel-for]')) {
    if (body.dataset.panelFor === lineId) return body.querySelector<HTMLButtonElement>('.bank-panel__book');
  }
  return null;
}

/** A line's row on screen, by its id (compared as data, never spliced into a selector). */
function rowElement(lineId: string): HTMLTableRowElement | null {
  for (const row of document.querySelectorAll<HTMLTableRowElement>('tr.bank-row')) if (row.dataset.line === lineId) return row;
  return null;
}

/** One idempotency key per question per line; forgotten once the line is decided. */
function useLineKeys() {
  const keys = useRef(new Map<string, { question: string; key: string }>());
  const keyFor = useCallback((lineId: string, question: unknown) => {
    const asked = JSON.stringify(question);
    const held = keys.current.get(lineId);
    if (held !== undefined && held.question === asked) return held.key;
    const key = crypto.randomUUID();
    keys.current.set(lineId, { question: asked, key });
    return key;
  }, []);
  const settle = useCallback((lineId: string) => {
    keys.current.delete(lineId);
  }, []);
  return { keyFor, settle };
}

/**
 * The list's loading shape (K-34): the head strip and the rows at the height the real rows take
 * (`--t-row-head-h`, `--t-row-h`), in the DOM at once so the read is announced, invisible for the first
 * 200ms so a fast local read never flashes it.
 */
function BankSkeleton() {
  const t = useT();
  const revealRef = useRevealAfterDelay();
  return (
    <div ref={revealRef} className="bank-skeleton" role="status" aria-busy="true" aria-live="polite" data-pending="">
      <span className="visually-hidden">{t('bankInbox.loading')}</span>
      <div className="bank-skeleton__head" aria-hidden="true" />
      {Array.from({ length: SKELETON_ROWS }, (_, i) => (
        <div key={i} className="bank-skeleton__row" aria-hidden="true">
          <span className="skeleton bank-skeleton__bar" />
        </div>
      ))}
    </div>
  );
}

export function Bank() {
  const t = useT();
  const { locale } = useI18n();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const navigate = useNavigate();
  const keyboard = useKeyboardOptional();
  const [params, setParams] = useSearchParams();
  const { keyFor, settle } = useLineKeys();

  const canRead = useCan(CAP.readSales);
  const canPost = useCan(CAP.post);
  const canPay = useCan(CAP.pay);
  const canDecideVorschlag = useCan('manage_agent_dial');
  // D178 point 9: the person's booking view and, in focus, whether the list steps aside.
  const [bookingView] = usePref<string>('bank.booking_view');
  const [listHiddenPref, setListHidden] = usePref<boolean>('bank.focus_list_hidden');
  const whoami = useCapabilities().whoami;

  // --- view state -------------------------------------------------------------------------------
  const tab: Tab = params.get('tab') === 'booked' ? 'booked' : params.get('tab') === 'ignored' ? 'ignored' : 'open';
  const accountFilter = params.get('account') ?? '';
  // D178 N3 (A39 §20.4): the Zeitraum lives in the URL like the account and the direction; the page offset is
  // the person's place in the filtered list and starts over whenever a filter changes.
  const periodFrom = isoDateOrNull(params.get('from'));
  const periodTo = isoDateOrNull(params.get('to'));
  // N3-C4: a page is an offset PER STATUS read (the Gebucht tab reads booked and matched), advanced by what
  // each read returned, and `before` counts every line the earlier pages showed, so "401 bis 550" is true.
  const [pageAt, setPageAt] = useState<PageAt>(FIRST_PAGE);
  const [pageHistory, setPageHistory] = useState<PageAt[]>([]);
  const [queryText, setQueryText] = useState(params.get('q') ?? '');
  const [query, setQuery] = useState(queryText);
  // B2: nothing is selected on load. Only a deep link selects before the person acts.
  const [selectedId, setSelectedId] = useState<string | null>(params.get('line'));
  // The selection as it is NOW, for a write's answer that arrives later (critic F9: the async book read
  // the selection of the moment it started, and moved a selection the person had changed meanwhile).
  const selectedRef = useRef<string | null>(selectedId);
  selectedRef.current = selectedId;
  // A deep link (`?line=`, the Journal drawer's "Bankzeile zeigen", a refusal's "Diese Zeile zeigen")
  // names ONE line, which may sit beyond the loaded page. It is read by its id and selected; a line this
  // book does not hold says so. Never a substitute (critic M4 lean).
  const [linkTarget, setLinkTarget] = useState<string | null>(params.get('line'));
  const [pinned, setPinned] = useState<BankInboxLine | null>(null);
  const [linkMissing, setLinkMissing] = useState(false);
  const [mode, setMode] = useState<PanelMode>('details');
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  // D177: a split under way per line (its position rows sit under the row), and the Buchungstext per line
  // as the person typed it (absent: the engine's default, which is never sent).
  const [splits, setSplits] = useState<Record<string, SplitDraft>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  // "Anderer Grund" from the row's ×: the panel's ignore editor opens on it, asking for the note.
  const [ignorePreset, setIgnorePreset] = useState<IgnoreReason | undefined>(undefined);
  // D177: the rules sheet opened on one rule (the Woher line's name).
  const [rulesFocus, setRulesFocus] = useState<string | null>(null);
  const wide = useWideLayout();
  // D178 N2 (A39 §18.3): ONE scroll owner per region. The page takes exactly the height <main> leaves and
  // never scrolls; the list and the detail area each own their scroll (the D177 panel measured the window
  // on every scroll and fought the page's own scrollbar).
  const [bankEl, setBankEl] = useState<HTMLElement | null>(null);
  usePageFit(bankEl);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const room = useMeasuredRoom(workspaceRef);
  const areaId = useId();
  const factsTitleId = useId();
  const columns = useColumnWidths(whoami?.actor ?? null);
  const [openPicker, setOpenPicker] = useState<{ lineId: string; which: 'target' | 'vat' } | null>(null);
  // The open picker among the split position rows (`<line>:acc-<key>`, `<line>:vat-<key>`, `<line>:via`).
  const [splitPicker, setSplitPicker] = useState<string | null>(null);
  const [busyLine, setBusyLine] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  // The lines picked with the row checkboxes for a bulk action (open tab only), by bank line id.
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [refusals, setRefusals] = useState<Record<string, Err>>({});
  const [ack, setAck] = useState<Ack | null>(null);
  /** The calm status line (D167 polish 2): the last small act that went as asked. */
  const [status, setStatus] = useState<Ack | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  // D150: several files dropped on the empty state go to the dialog together.
  const [importFiles, setImportFiles] = useState<File[] | null>(null);
  /** The statement the last import added: its lines carry the landing tint once. */
  const [freshStatement, setFreshStatement] = useState<string | null>(null);
  const [onlyFresh, setOnlyFresh] = useState(false);
  // The Commit moment (D122 D-I). An import's lines land with the decaying tint once, when the re-read
  // brings them (the dot beside the date stays while the import is the latest). A write that changes a
  // line WHERE IT STANDS (a Beleg attached, a Vorschlag rejected) tints that row; a decision that moves
  // the line out of the tab acknowledges on the banner instead, since its row is gone.
  const [ackLineId, ackLine] = useCommitAckState();
  const bookRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const focusBookFor = useRef<string | null>(null);
  const focusRequest = useRef<FocusRequest | null>(null);
  const scrollTo = useRef<string | null>(params.get('line'));
  const ackSeq = useRef(0);
  // "Beleg anhängen": one hidden file input, aimed at the line the person asked for.
  const fileInput = useRef<HTMLInputElement | null>(null);
  // The line the picker was opened for, by id and name: the person may switch tab while the OS dialog is
  // open, so the line is never looked up in the list again (critic F9).
  const attachFor = useRef<{ bankTxnId: string; party: string } | null>(null);
  /** A Beleg picked for a line that is no longer in the list, and refused: said in a banner, never dropped. */
  const [receiptError, setReceiptError] = useState<{ error: Err; message: string } | null>(null);

  const statusRef = useRef<HTMLParagraphElement | null>(null);
  const [statusHeld, setStatusHeld] = useState(false);
  // A line that went (its Rückgängig used, unmounted under the focus) holds nothing any more.
  useEffect(() => {
    if (status === null) setStatusHeld(false);
  }, [status]);
  useEffect(() => {
    if (status === null || statusHeld) return;
    const timer = window.setTimeout(() => setStatus(null), STATUS_DISMISS_MS);
    const onPointer = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || statusRef.current?.contains(e.target) !== true) setStatus(null);
    };
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [status, statusHeld]);

  const say = useCallback((next: Omit<Ack, 'id'>) => {
    ackSeq.current += 1;
    if (next.quiet === true && next.tone !== 'warn') {
      // In place: the row's own change (the star, the clip's count, the line leaving with the commit
      // tint) is the feedback; the status line says it in words for a screen reader and a glance.
      setStatus({ ...next, id: ackSeq.current });
      setAck(null);
      return;
    }
    setStatus(null);
    setAck({ ...next, id: ackSeq.current });
  }, []);

  const setParam = useCallback(
    (name: string, value: string | null) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value === null || value === '') next.delete(name);
          else next.set(name, value);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  // D142: the facet lives in the URL, so the Übersicht band's links land on it (`?facet=needs`).
  const facet = facetOf(params.get('facet'));
  const direction = directionOf(params.get('dir'), params.get('facet'));
  const setFacet = useCallback((next: Facet) => setParam('facet', next === 'all' ? null : next), [setParam]);
  const setDirection = useCallback(
    (next: Direction) => {
      setParams(
        (prev) => {
          const out = new URLSearchParams(prev);
          if (out.get('facet') === 'in' || out.get('facet') === 'out') out.delete('facet');
          if (next === 'all') out.delete('dir');
          else out.set('dir', next);
          return out;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  // The engine search runs on the typed words a moment after typing stops.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryText.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [queryText]);

  const select = useCallback((lineId: string | null) => {
    setSelectedId(lineId);
    setMode('details');
    setIgnorePreset(undefined);
  }, []);

  // --- data -------------------------------------------------------------------------------------
  const [accounts, setAccounts] = useState<BankAccountOption[] | null>(null);
  const [accountsError, setAccountsError] = useState<Err | null>(null);
  const [inbox, setInbox] = useState<InboxData | null>(null);
  const [inboxError, setInboxError] = useState<Err | null>(null);
  const [counts, setCounts] = useState<Record<Tab, number | null>>({ open: null, booked: null, ignored: null });
  // D178 point 10 (A39 §18.2): where the detail area docks and how big it is, per person; automatic decided
  // once, when the open count first answers on entry. A header drag docks it at the other edge.
  const layout = useDetailLayout(counts.open, workspaceId, room);
  const dockDrag = useDockDrag(workspaceRef, layout.edge, layout.dock);
  const [lookups, setLookups] = useState<Lookups>(EMPTY_LOOKUPS);
  // D175: the rules link shows once the seat could read the rules; the sheet opens over the inbox.
  const [rulesReadable, setRulesReadable] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [optionsNonce, setOptionsNonce] = useState(0);
  const reload = useCallback(() => {
    // A line read by its id reflects the state it had then; after any write the page is the truth.
    setPinned(null);
    setReloadNonce((n) => n + 1);
  }, []);
  const reloadOptions = useCallback(() => setOptionsNonce((n) => n + 1), []);

  // A36 §5: "Von der Bank abrufen" and "Zuletzt abgerufen". The EBICS channels come from
  // `bank_channel_status`; the menu offers the fetch only when one is active (D-A36.10: on demand only,
  // one fresh idempotency key per press). A failed read hides it, it never blocks the inbox.
  const [feedChannels, setFeedChannels] = useState<{ connectionId: string; state: string; lastSyncAt: string | null }[]>([]);
  // D142: the press is the shared hook the Übersicht band uses too.
  const bankFetch = useBankFetch(workspaceId);
  const fetchBusy = bankFetch.busy;
  const fetchError = bankFetch.error;
  const loadFeed = useCallback(async () => {
    if (workspaceId === null) return;
    const { body } = await client.call('bank_channel_status', { workspaceId });
    if (isErr(body)) {
      setFeedChannels([]);
      return;
    }
    const channels = ((body as Record<string, unknown>).channels as { connectionId: string; state: string; lastSyncAt: string | null; channelKind?: string }[] | undefined) ?? [];
    setFeedChannels(channels.filter((c) => (c.channelKind ?? 'ebics') === 'ebics' && c.state !== 'retired'));
  }, [client, workspaceId]);
  useEffect(() => {
    void loadFeed();
  }, [loadFeed]);
  // D144 (A39 §12): "Konten vorschlagen" asks the LOCAL decision model, so it shows only while one is
  // registered (`runtime_status`). A failed read hides it, it never blocks the inbox.
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [suggestBusy, setSuggestBusy] = useState(false);
  useEffect(() => {
    if (workspaceId === null) return undefined;
    let live = true;
    void client.call('runtime_status', { workspaceId }).then((r) => {
      if (!live) return;
      setRuntimeReady(!isErr(r.body) && (r.body as Record<string, unknown>).registered === true);
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId]);
  const activeFeeds = feedChannels.filter((c) => c.state === 'active');
  const lastFetched = feedChannels
    .map((c) => c.lastSyncAt)
    .filter((v): v is string => typeof v === 'string')
    .sort()
    .pop();

  const loadAccounts = useCallback(async () => {
    if (workspaceId === null) return;
    const response = await client.call('list_bank_accounts', { workspaceId });
    if (isErr(response.body)) {
      setAccountsError(response.body);
      return;
    }
    setAccountsError(null);
    setAccounts(parseBankAccounts(response.body));
  }, [client, workspaceId]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  // The inbox itself: the tab's state(s), the account, the engine search.
  useEffect(() => {
    if (workspaceId === null || accounts === null || accounts.length === 0) return undefined;
    let live = true;
    // D178 E3 (A39 §17.6): the direction and the Zeitraum go to the engine, so `total` and the direction
    // counts are honest across every page; an inverted Zeitraum asks nothing new (the field says why).
    const period = periodInverted(periodFrom, periodTo) ? {} : { ...(periodFrom !== null ? { from: periodFrom } : {}), ...(periodTo !== null ? { to: periodTo } : {}) };
    const scope = {
      workspaceId,
      ...(accountFilter !== '' ? { bankAccountId: accountFilter } : {}),
      ...(query !== '' ? { query } : {}),
      ...(direction !== 'all' ? { direction } : {}),
      ...period,
    };
    const statuses = tab === 'open' ? ['open'] : tab === 'booked' ? ['booked', 'matched'] : ['ignored'];
    void (async () => {
      const pages = await Promise.all(
        statuses.map((status, i) => {
          const offset = pageAt.offsets[i] ?? 0;
          return client.call('list_bank_inbox', { ...scope, status, limit: PAGE, ...(offset > 0 ? { offset } : {}) });
        }),
      );
      if (!live) return;
      const failed = pages.find((p) => isErr(p.body));
      if (failed !== undefined) {
        setInboxError(failed.body as Err);
        return;
      }
      const parsed = pages.map((p) => parseInbox(p.body));
      if (parsed.some((p) => p === null)) {
        setInboxError({ ok: false, error: 'unreadable_response' });
        return;
      }
      const ok = parsed as NonNullable<(typeof parsed)[number]>[];
      const lines = ok.flatMap((p) => p.lines);
      lines.sort((a, b) => (b.bookingDate ?? b.valueDate ?? '').localeCompare(a.bookingDate ?? a.valueDate ?? ''));
      setInboxError(null);
      const counted = ok.every((p) => p.directionCounts !== undefined);
      setInbox({
        lines,
        total: ok.reduce((s, p) => s + p.total, 0),
        summary: ok[0]?.summary ?? [],
        directionCounts: counted ? { in: ok.reduce((s, p) => s + (p.directionCounts?.in ?? 0), 0), out: ok.reduce((s, p) => s + (p.directionCounts?.out ?? 0), 0) } : null,
        more: ok.some((p) => p.nextCursor !== null),
        returned: ok.map((p) => p.lines.length),
      });
    })();
    return () => {
      live = false;
    };
  }, [client, workspaceId, accounts, accountFilter, query, tab, reloadNonce, direction, periodFrom, periodTo, pageAt]);
  // A changed filter starts the list over at its first page.
  useEffect(() => {
    setPageAt(FIRST_PAGE);
    setPageHistory([]);
  }, [workspaceId, accountFilter, query, tab, direction, periodFrom, periodTo]);

  // The tab counts: the engine's totals per state, one number per question.
  useEffect(() => {
    if (workspaceId === null || accounts === null || accounts.length === 0) return undefined;
    let live = true;
    const scope = { workspaceId, ...(accountFilter !== '' ? { bankAccountId: accountFilter } : {}), limit: 1 };
    void Promise.all(
      (['open', 'booked', 'matched', 'ignored'] as const).map(async (status) => {
        const r = await client.call('list_bank_inbox', { ...scope, status });
        return isErr(r.body) ? null : (parseInbox(r.body)?.total ?? null);
      }),
    ).then(([open, booked, matched, ignored]) => {
      if (!live) return;
      setCounts({
        open: open ?? null,
        booked: booked === null || booked === undefined || matched === null || matched === undefined ? null : booked + matched,
        ignored: ignored ?? null,
      });
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId, accounts, accountFilter, reloadNonce]);

  // The option reads the rows name things with. Each one degrades on its own: a role that may not
  // read vendor bills still books to accounts.
  useEffect(() => {
    if (workspaceId === null) return undefined;
    let live = true;
    const read = async (action: string, input: Record<string, unknown> = {}) => {
      const r = await client.call(action, { workspaceId, ...input });
      return isErr(r.body) ? null : r.body;
    };
    void Promise.all([
      read('list_accounts'),
      read('vat_codes'),
      read('list_open_items'),
      read('list_vendor_bills', { status: 'posted' }),
      read('list_drafted_actions', { status: 'pending' }),
      read('get_agent_dial'),
      // D167: the live standards, so a ★ can name what it says. A refused or unknown read is "none".
      read('list_bank_standards'),
      // D177: the generated payment runs, for the picker's "Zahlungsläufe". A refused read is "none".
      read('list_payment_batches', { status: 'generated' }),
    ]).then(([chart, tax, items, bills, drafted, dial, standards, batches]) => {
      if (!live) return;
      setRulesReadable(standards !== null);
      const dialLevels = dial !== null && typeof (dial as Record<string, unknown>).levels === 'object' ? ((dial as Record<string, unknown>).levels as Record<string, string>) : null;
      setLookups(
        buildLookups({
          chart: parseChart(chart),
          taxCodes: parseTaxCodes(tax),
          invoices: parseInvoices(items),
          bills: parseBills(bills),
          bankAccounts: accounts ?? [],
          vorschlaege: parseVorschlaege(drafted),
          dial: dialLevels,
          standards: parseStandards(standards),
          batches: parseBatches(batches),
        }),
      );
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId, accounts, optionsNonce]);

  // A fresh read of the lines (or of the pending Vorschläge) keeps what the person edited and redraws
  // the rest: the agent's pending booking when there is one, else the engine's proposal. A Vorschlag
  // that was decided in the meantime therefore takes its target off the row with it.
  const vorschlaege = lookups.vorschlaege;
  useEffect(() => {
    if (inbox === null) return;
    setDrafts((prev) => {
      const next: Record<string, RowDraft> = {};
      for (const line of inbox.lines) {
        if (line.state !== 'open') continue;
        const held = prev[line.bankTxnId];
        next[line.bankTxnId] =
          held !== undefined && held.source === 'edited' ? held : (draftFromVorschlag(lineVorschlag(line, vorschlaege)) ?? draftFromProposal(line));
      }
      return next;
    });
  }, [inbox, vorschlaege]);

  // --- derived ------------------------------------------------------------------------------------
  const lines = useMemo(() => {
    const loaded = inbox?.lines ?? [];
    if (pinned === null || tabOf(pinned.state) !== tab || loaded.some((l) => l.bankTxnId === pinned.bankTxnId)) return loaded;
    return [pinned, ...loaded];
  }, [inbox, pinned, tab]);

  // Resolve a deep link: on the loaded page, else read by its id (switching to the line's tab).
  useEffect(() => {
    if (linkTarget === null || workspaceId === null || inbox === null) return undefined;
    if (inbox.lines.some((l) => l.bankTxnId === linkTarget)) {
      select(linkTarget);
      scrollTo.current = linkTarget;
      setLinkTarget(null);
      setLinkMissing(false);
      return undefined;
    }
    let live = true;
    void client.call('list_bank_inbox', { workspaceId, bankTxnId: linkTarget, status: 'all', limit: 1 }).then((r) => {
      if (!live) return;
      const found = isErr(r.body) ? undefined : parseInbox(r.body)?.lines[0];
      setLinkTarget(null);
      if (found === undefined) {
        setLinkMissing(true);
        select(null);
        return;
      }
      setLinkMissing(false);
      setPinned(found);
      select(found.bankTxnId);
      scrollTo.current = found.bankTxnId;
      const want = tabOf(found.state);
      if (want !== tab) setParam('tab', want === 'open' ? null : want);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkTarget, inbox, workspaceId, client]);

  // An older link names the credit a line created (`?credit=`): select that line, or say it is not here.
  useEffect(() => {
    if (inbox === null || linkTarget !== null) return;
    const credit = params.get('credit');
    if (credit === null) return;
    const hit = lines.find((l) => l.creditId === credit);
    setParam('credit', null);
    if (hit !== undefined) {
      select(hit.bankTxnId);
      scrollTo.current = hit.bankTxnId;
      return;
    }
    setLinkMissing(true);
    select(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inbox, linkTarget]);

  const needsYou = useCallback(
    (line: BankInboxLine) => !isUntouched(line, drafts[line.bankTxnId]) || line.attention === 'needs' || lookups.vorschlaege.has(line.bankTxnId),
    [drafts, lookups.vorschlaege],
  );
  const isSure = useCallback(
    (line: BankInboxLine) => isUntouched(line, drafts[line.bankTxnId]) && line.attention === 'sure' && !lookups.vorschlaege.has(line.bankTxnId),
    [drafts, lookups.vorschlaege],
  );

  const visible = useMemo(() => {
    return lines.filter((line) => {
      if (onlyFresh && line.statementId !== freshStatement) return false;
      if (direction === 'in' && !isCredit(line)) return false;
      if (direction === 'out' && isCredit(line)) return false;
      if (tab !== 'open') return facet === 'noreceipt' ? line.needsReceipt : true;
      if (facet === 'needs') return needsYou(line);
      if (facet === 'sure') return isSure(line);
      return true;
    });
  }, [lines, tab, facet, direction, needsYou, isSure, onlyFresh, freshStatement]);
  useCommitAck(freshStatement, visible);
  // D167 polish 10: a Gebucht row says what it booked on its one line; the entries of the booked rows in
  // view are read once each.
  const bookedEntries = useEntries(
    workspaceId ?? '',
    tab === 'open' ? [] : visible.filter((l) => l.state === 'booked' && l.decision?.targetKind === 'accounts' && l.decision.entryId !== null).map((l) => l.decision?.entryId as string),
  );
  const rowSummary = (line: BankInboxLine): string => {
    const entryId = line.decision?.entryId ?? null;
    const detail = line.state === 'booked' && line.decision?.targetKind === 'accounts' && entryId !== null ? bookedEntries.get(entryId) : undefined;
    if (detail !== undefined) {
      const phrase = bookedToPhrase(t, lookups, detail.lines, (code) => {
        const c = lookups.taxByCode.get(code);
        return c === undefined ? null : taxCodeFieldName(t, c, lineDate(line));
      });
      if (phrase !== null) return phrase;
    }
    return decidedSummary(t, line);
  };

  useEffect(() => {
    setPicked(new Set());
  }, [tab, accountFilter, query]);
  const pickedLines = useMemo(() => (tab === 'open' ? visible.filter((l) => picked.has(l.bankTxnId)) : []), [tab, visible, picked]);
  const togglePick = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // "Alle vorgeschlagenen buchen" counts and books the lines IN VIEW only, the set the table renders
  // (critic D167-8): with the directions inside the Filter menu, a button that also booked the lines a
  // facet, a direction, the search or the account filter hides would book what the person cannot see.
  // The pick bar already reads `visible`, so both bulk paths agree.
  const sureLines = useMemo(
    () => (tab === 'open' ? visible.filter((l) => isSureAndUntouched(l, drafts[l.bankTxnId]) && !lookups.vorschlaege.has(l.bankTxnId)) : []),
    [visible, tab, drafts, lookups.vorschlaege],
  );
  const sureIds = useMemo(() => new Set(sureLines.map((l) => l.bankTxnId)), [sureLines]);
  // D144: the open lines IN VIEW no reference and no history places, the ones the model may be asked
  // about. "Konten vorschlagen" sends exactly these (critic C1: "the lines in view", A39 §12), at most a page.
  const unplacedInView = useMemo(
    () => (tab === 'open' ? visible.filter((l) => l.state === 'open' && l.proposal?.reasonCode === 'no_proposal').map((l) => l.bankTxnId).slice(0, SUGGEST_IDS_MAX) : []),
    [visible, tab],
  );
  const unplacedCount = unplacedInView.length;
  const currencies = new Set(lines.map((l) => l.currency));
  const showCurrency = currencies.size > 1;
  const summary = inbox?.summary ?? [];
  const noStatementAnywhere = summary.length > 0 && summary.every((s) => s.statementId === null) && (counts.open ?? 0) + (counts.booked ?? 0) + (counts.ignored ?? 0) === 0;
  const claimedEntryIds = useMemo(() => new Set(lines.flatMap((l) => (l.decision?.entryId != null ? [l.decision.entryId] : []))), [lines]);

  // After an account pick hands over to the VAT pick, and the VAT pick to Buchen, focus lands there.
  useEffect(() => {
    const lineId = focusBookFor.current;
    if (lineId === null || openPicker !== null) return;
    focusBookFor.current = null;
    // The selected line's Buchen is the panel's while the panel is beside the table (one Buchen per line).
    (bookRefs.current.get(lineId) ?? panelBook(lineId))?.focus();
  });

  // After a decision: the next row takes the focus once it is on screen. After the detail area closed: its
  // line's row, or the list when that row is not drawn.
  useEffect(() => {
    const request = focusRequest.current;
    if (request === null) return;
    const row = rowElement(request.lineId);
    if (row === null) {
      if (request.orList === true) {
        focusRequest.current = null;
        listRef.current?.focus();
      }
      return;
    }
    focusRequest.current = null;
    row.focus();
  });

  // A file let go anywhere off a row (the shell, the rail, the header) would make the browser leave the
  // Studio to open it (critic F9, round 2). While /bank is mounted the guard sits on the DOCUMENT, in the
  // bubble phase, so a row or a drop zone that takes the file has already prevented the default and is
  // left alone; anything nobody handled is held: no navigation, no drop. It goes when /bank unmounts.
  useEffect(() => {
    const holdStrayFiles = (e: globalThis.DragEvent) => {
      if (e.defaultPrevented || !Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
      e.preventDefault();
      if (e.dataTransfer !== null) e.dataTransfer.dropEffect = 'none';
    };
    document.addEventListener('dragover', holdStrayFiles);
    document.addEventListener('drop', holdStrayFiles);
    return () => {
      document.removeEventListener('dragover', holdStrayFiles);
      document.removeEventListener('drop', holdStrayFiles);
    };
  }, []);

  // A deep-linked line is scrolled into view once its row is drawn.
  useEffect(() => {
    const id = scrollTo.current;
    if (id === null) return;
    const row = rowElement(id);
    if (row === null) return;
    scrollTo.current = null;
    if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' });
  });

  // --- writes -------------------------------------------------------------------------------------
  const canBookTarget = useCallback((target: DraftTarget) => (bookCapability(target) === 'pay' ? canPay && canPost : canPost), [canPay, canPost]);

  /**
   * The C4 consequence sentence a bank booking carries (D118 C4), as the engine states it (D156: the one
   * catalogue). `book_bank_line` carries its own entry; the input-keyed capability (accounts and matches
   * are `post`, settlements `pay`) is the family fallback the engine resolves with, so this is the same
   * sentence the Vorschlag card shows for it. No sentence is invented here.
   */
  const consequenceFor = useCallback(
    // Null, never '': an empty string rendered an empty Tooltip on Buchen (D167, item 9).
    (target: DraftTarget) => consequenceSentence('book_bank_line', locale, bookCapability(target)) ?? null,
    [locale],
  );

  const afterDecision = useCallback(
    (line: BankInboxLine) => {
      settle(line.bankTxnId);
      setSplits(({ [line.bankTxnId]: _split, ...rest }) => rest);
      setTexts(({ [line.bankTxnId]: _text, ...rest }) => rest);
      setRefusals((r) => {
        const { [line.bankTxnId]: _gone, ...rest } = r;
        return rest;
      });
      // The next line to decide is the one after this one in the current view. Deciding the selected
      // line moves the selection there, and the focus lands on the next ROW, never on its Buchen. If the
      // person put the focus elsewhere while the write was in flight (another row, the search), it stays
      // where they put it.
      const index = visible.findIndex((l) => l.bankTxnId === line.bankTxnId);
      const next = visible[index + 1] ?? visible[index - 1] ?? null;
      if (selectedRef.current === line.bankTxnId) select(next?.bankTxnId ?? null);
      if (next !== null && !focusMovedAway(line.bankTxnId)) focusRequest.current = { lineId: next.bankTxnId };
      reload();
      reloadOptions();
    },
    [settle, visible, select, reload, reloadOptions],
  );

  const refuse = useCallback(
    (lineId: string, error: Err) => {
      setRefusals((r) => ({ ...r, [lineId]: error }));
      // The refusal is the answer to the person's own act: the line's Details show it, with its fix.
      if (selectedRef.current !== lineId) select(lineId);
    },
    [select],
  );

  const showDecided = (line: BankInboxLine) => {
    setParam('tab', 'booked');
    setSelectedId(line.bankTxnId);
    setMode('reopen');
    scrollTo.current = line.bankTxnId;
  };

  /**
   * `book_bank_line`, then the acknowledgement. With `closeVorschlaege` (D167) the person booked a line an
   * agent had drafted their OWN way: only once the booking answered ok is EVERY pending Vorschlag on the
   * line closed (`reject_drafted_action`, "selbst gebucht"; critic D167-8), never the other order, so a
   * refused booking keeps the person's draft AND the Vorschläge. `leavesOpen` says a Vorschlag stays
   * pending because the seat may not decide it, so the acknowledgement names it. Answers whether the
   * line was booked.
   */
  const book = async (
    line: BankInboxLine,
    target: DraftTarget,
    opts: { text?: string; closeVorschlaege?: readonly LineVorschlag[]; leavesOpen?: boolean } = {},
  ): Promise<boolean> => {
    if (workspaceId === null) return false;
    // D176: a "Nicht buchen" proposal is decided by ignore_bank_line with the rule's reason, note and id.
    if (target.kind === 'ignore') {
      return simpleWrite(line, 'ignore_bank_line', ignoreInputOf(target), t('bankInbox.ack.ignored', { party: partyOf(t, line) }));
    }
    // D176: a complete rule that names a next step books as the rule, so the line then offers that step.
    const sent = bookingTargetFor(line, target, lookups.standardById.get(String(((line.proposal?.reasonParams ?? {}) as Record<string, unknown>).standardId ?? '')));
    const input = { bankTxnId: line.bankTxnId, target: bookTargetOf(sent), ...(opts.text !== undefined ? { text: opts.text } : {}) };
    setBusyLine(line.bankTxnId);
    const response = await client.call('book_bank_line', { workspaceId, ...input, idempotencyKey: keyFor(line.bankTxnId, ['book_bank_line', input]) });
    if (isErr(response.body)) {
      setBusyLine(null);
      refuse(line.bankTxnId, response.body);
      return false;
    }
    const closed = opts.closeVorschlaege !== undefined && opts.closeVorschlaege.length > 0 ? await closeVorschlaege(opts.closeVorschlaege) : null;
    setBusyLine(null);
    const body = response.body as Record<string, unknown>;
    const party = partyOf(t, line);
    const phrase = targetPhrase(t, lookups, line, target);
    const remainder = (body.remainder ?? null) as { kind?: string; amountMinor?: number } | null;
    const remainderText =
      remainder !== null && remainder.kind !== undefined && remainder.kind !== 'none'
        ? t(`bankInbox.ack.remainder.${remainder.kind}`, { amount: formatMoney(remainder.amountMinor ?? 0, line.currency) })
        : '';
    const vorschlagText =
      opts.leavesOpen === true ? t('bankInbox.ack.vorschlagLeftOpen') : closed === null ? '' : t(closed ? 'bankInbox.ack.selfBooked' : 'bankInbox.ack.selfBookedOpen');
    const detailText = [remainderText, warningsText(t, body.warnings), vorschlagText].filter((x) => x !== '').join(' ');
    const detail = detailText === '' ? undefined : detailText;
    say({
      tone: closed === false || opts.leavesOpen === true ? 'warn' : 'success',
      message:
        body.state === 'matched'
          ? entryDateOf(line, target) === null
            ? t('bankInbox.ack.matchedAny', { party })
            : t('bankInbox.ack.matched', { party, date: formatDate(entryDateOf(line, target) as string) })
          : t('bankInbox.ack.booked', { party, target: phrase }),
      ...(detail !== undefined ? { detail } : {}),
      action: { label: t('bankInbox.ack.undo'), run: () => showDecided(line) },
      quiet: true,
    });
    afterDecision(line);
    return true;
  };

  /**
   * Buchen on a row, and every booking the Details' editors send (D167 item 1). With no agent Vorschlag on
   * the line it is `book_bank_line`. With one, the line as the agent drafted it (untouched, the record not
   * changed since the proposal) approves the pinned Vorschlag (`approve_drafted_action`, D162); the
   * person's own version is booked first and the Vorschlag closed after, by `book`.
   */
  const decideLine = (line: BankInboxLine, target: DraftTarget, source: RowDraft['source'], opts: { text?: string } = {}) => {
    const v = lineVorschlag(line, lookups.vorschlaege);
    // The shown one first; the line's OTHER pending ones close once the line is decided (D167-8).
    const pending = v === undefined ? [] : [v, ...(lookups.vorschlaege.get(line.bankTxnId) ?? []).filter((x) => x !== v)];
    if (v === undefined) return book(line, target, opts);
    const agentTarget = v.actionTool === 'book_bank_line' ? draftTargetOf(v.payload.target) : null;
    const asDrafted = source === 'agent' && opts.text === undefined && agentTarget !== null && targetKey(agentTarget) === targetKey(target);
    const own = whoami?.actor !== undefined && v.actor === whoami.actor;
    if (asDrafted && v.changedSinceProposal !== true && canDecideVorschlag && !own) return approve(line, v, pending.slice(1));
    return book(line, target, { ...opts, ...(canDecideVorschlag ? { closeVorschlaege: pending } : { leavesOpen: true }) });
  };

  /** Closes each Vorschlag as the person's own booking made it moot; answers whether every one closed. */
  const closeVorschlaege = async (list: readonly LineVorschlag[]): Promise<boolean> => {
    if (workspaceId === null) return false;
    let all = true;
    for (const v of list) {
      const rejected = await client.call('reject_drafted_action', { workspaceId, actionId: v.actionId, reason: SELF_BOOKED_REASON });
      if (isErr(rejected.body)) all = false;
    }
    return all;
  };

  const bookAllSure = async () => {
    if (workspaceId === null || sureLines.length === 0) return;
    setBulkBusy(true);
    let done = 0;
    let refused = 0;
    for (const line of sureLines) {
      const target = proposalTarget(line);
      if (target === null) continue;
      // D176: a `sure` "Nicht buchen" proposal (setting bank.buchungsregel_ignore_mode = bulk) is ignored with
      // the rule's reason, note and id; a complete rule with a next step books as the rule.
      const ignoring = target.kind === 'ignore';
      const action = ignoring ? 'ignore_bank_line' : 'book_bank_line';
      const input = ignoring
        ? { bankTxnId: line.bankTxnId, ...ignoreInputOf(target) }
        : { bankTxnId: line.bankTxnId, target: bookTargetOf(bookingTargetFor(line, target, lookups.standardById.get(String(((line.proposal?.reasonParams ?? {}) as Record<string, unknown>).standardId ?? '')))) };
      const response = await client.call(action, { workspaceId, ...input, idempotencyKey: keyFor(line.bankTxnId, [action, input]) });
      if (isErr(response.body)) {
        refused += 1;
        setRefusals((r) => ({ ...r, [line.bankTxnId]: response.body as Err }));
      } else {
        done += 1;
        settle(line.bankTxnId);
      }
    }
    setBulkBusy(false);
    say({
      tone: refused > 0 ? 'warn' : 'success',
      message: plural(t, 'bankInbox.ack.bulk', done),
      ...(refused > 0 ? { detail: plural(t, 'bankInbox.ack.bulkRefused', refused) } : {}),
      quiet: true,
    });
    reload();
    reloadOptions();
  };

  // The picked lines a bulk Buchen sends: a target in balance, the right to book it, and no agent
  // Vorschlag waiting (only its approval books that one).
  const readyPicked = pickedLines.filter((l) => {
    // Spec §6 (critic L6 lean): the pick bar books the checked SURE lines, reference-proven and untouched.
    const target = drafts[l.bankTxnId]?.target ?? null;
    return isSureAndUntouched(l, drafts[l.bankTxnId]) && target !== null && isBookable(l, target) && canBookTarget(target) && !lookups.vorschlaege.has(l.bankTxnId);
  });

  const runPicked = async (targets: readonly BankInboxLine[], action: 'book_bank_line' | 'ignore_bank_line', inputFor: (line: BankInboxLine) => Record<string, unknown> | null) => {
    if (workspaceId === null || targets.length === 0) return { done: 0, refused: 0 };
    setBulkBusy(true);
    let done = 0;
    let refused = 0;
    for (const line of targets) {
      const input = inputFor(line);
      if (input === null) continue;
      const response = await client.call(action, { workspaceId, bankTxnId: line.bankTxnId, ...input, idempotencyKey: keyFor(line.bankTxnId, [action, input]) });
      if (isErr(response.body)) {
        refused += 1;
        setRefusals((r) => ({ ...r, [line.bankTxnId]: response.body as Err }));
      } else {
        done += 1;
        settle(line.bankTxnId);
      }
    }
    setBulkBusy(false);
    setPicked(new Set());
    reload();
    reloadOptions();
    return { done, refused };
  };

  const bookPicked = async () => {
    const { done, refused } = await runPicked(readyPicked, 'book_bank_line', (line) => {
      const target = drafts[line.bankTxnId]?.target ?? null;
      return target === null ? null : { target: bookTargetOf(target) };
    });
    say({
      tone: refused > 0 ? 'warn' : 'success',
      message: plural(t, 'bankInbox.ack.pickedBooked', done),
      ...(refused > 0 ? { detail: plural(t, 'bankInbox.ack.bulkRefused', refused) } : {}),
      quiet: true,
    });
  };

  const ignorePicked = async (reason: IgnoreReason) => {
    const { done, refused } = await runPicked(pickedLines, 'ignore_bank_line', () => ({ reason }));
    say({
      tone: refused > 0 ? 'warn' : 'success',
      message: plural(t, 'bankInbox.ack.pickedIgnored', done, { reason: t(`bankInbox.ignore.reason.${reason}.label`) }),
      ...(refused > 0 ? { detail: plural(t, 'bankInbox.ack.pickedRefused', refused) } : {}),
      quiet: true,
    });
  };

  const simpleWrite = async (line: BankInboxLine, action: string, input: Record<string, unknown>, message: string, undo?: Ack['action']) => {
    if (workspaceId === null) return false;
    setBusyLine(line.bankTxnId);
    const response = await client.call(action, { workspaceId, bankTxnId: line.bankTxnId, ...input, idempotencyKey: keyFor(line.bankTxnId, [action, input]) });
    setBusyLine(null);
    if (isErr(response.body)) {
      refuse(line.bankTxnId, response.body);
      return false;
    }
    const warned = warningsText(t, (response.body as Record<string, unknown>).warnings);
    say({ tone: 'success', message, ...(warned !== '' ? { detail: warned } : {}), ...(undo !== undefined ? { action: undo } : {}), quiet: true });
    afterDecision(line);
    return true;
  };

  /**
   * D177 point 5: "Rückgängig" in the status line after an ignore. It reopens the line through
   * `reopen_bank_line` (the one undo, outcome 7), with its own reason and a fresh key: the line is back
   * among the open ones. A refusal is said in the banner, since the line has left the view.
   */
  const undoIgnore = async (line: BankInboxLine) => {
    if (workspaceId === null) return;
    const response = await client.call('reopen_bank_line', { workspaceId, bankTxnId: line.bankTxnId, reason: t('bankInbox.ignore.undoReason'), idempotencyKey: crypto.randomUUID() });
    if (isErr(response.body)) {
      say({ tone: 'warn', message: refusalText(t, response.body) });
      return;
    }
    say({ tone: 'success', message: t('bankInbox.ack.unignored', { party: partyOf(t, line) }), quiet: true });
    reload();
    reloadOptions();
  };

  const ignore = (line: BankInboxLine, reason: IgnoreReason, note: string) =>
    void simpleWrite(
      line,
      'ignore_bank_line',
      { reason, ...(note !== '' ? { note } : {}) },
      t('bankInbox.ack.ignoredWhy', { party: partyOf(t, line), reason: t(`bankInbox.ignore.reason.${reason}.label`) }),
      { label: t('bankInbox.ack.undoShort'), run: () => void undoIgnore(line) },
    );
  const reopen = (line: BankInboxLine, reason: string) =>
    void simpleWrite(
      line,
      'reopen_bank_line',
      { reason },
      t(line.state === 'matched' ? 'bankInbox.ack.unmatched' : line.state === 'ignored' ? 'bankInbox.ack.unignored' : 'bankInbox.ack.reopened', { party: partyOf(t, line) }),
    );

  /** Approves the pinned Vorschlag; any OTHER pending one on the line is closed once it booked (D167-8). */
  const approve = async (line: BankInboxLine, v: LineVorschlag, others: readonly LineVorschlag[] = []) => {
    if (workspaceId === null) return;
    setBusyLine(line.bankTxnId);
    const response = await client.call('approve_drafted_action', { workspaceId, actionId: v.actionId });
    if (isErr(response.body)) {
      setBusyLine(null);
      refuse(line.bankTxnId, response.body);
      reloadOptions();
      return;
    }
    const closedOthers = others.length === 0 ? true : await closeVorschlaege(others);
    setBusyLine(null);
    say({
      tone: closedOthers ? 'success' : 'warn',
      message: t('bankInbox.ack.approved', { party: partyOf(t, line) }),
      ...(closedOthers ? {} : { detail: t('bankInbox.ack.selfBookedOpen') }),
      quiet: true,
    });
    afterDecision(line);
  };

  const reject = async (line: BankInboxLine, v: LineVorschlag, reason: string) => {
    if (workspaceId === null) return;
    setBusyLine(line.bankTxnId);
    const response = await client.call('reject_drafted_action', { workspaceId, actionId: v.actionId, ...(reason !== '' ? { reason } : {}) });
    setBusyLine(null);
    if (isErr(response.body)) {
      refuse(line.bankTxnId, response.body);
      return;
    }
    say({ tone: 'info', message: t('bankInbox.ack.rejected', { party: partyOf(t, line) }), quiet: true });
    ackLine(line.bankTxnId);
    reloadOptions();
  };

  // --- Standards (D167, owner pick 1A) ------------------------------------------------------------
  /**
   * ☆: save the line's current account and MWST code as the standard for its counterparty and direction.
   * It posts nothing; future lines arrive prefilled with ★ and count for the bulk button. A refusal is the
   * line's, in words, and keeps everything the person entered.
   */
  const setStandard = async (line: BankInboxLine) => {
    const target = drafts[line.bankTxnId]?.target ?? null;
    const leg = target?.kind === 'accounts' && target.legs.length === 1 ? target.legs[0] : undefined;
    if (workspaceId === null || leg === undefined) return;
    // `taxCode` is left out for "Ohne MWST": the engine reads a missing code as none.
    const input = { bankTxnId: line.bankTxnId, accountId: leg.accountId, ...(leg.taxCode !== '' ? { taxCode: leg.taxCode } : {}) };
    setBusyLine(line.bankTxnId);
    const response = await client.call('set_bank_standard', { workspaceId, ...input, idempotencyKey: keyFor(line.bankTxnId, ['set_bank_standard', input]) });
    setBusyLine(null);
    if (isErr(response.body)) {
      refuse(line.bankTxnId, response.body);
      return;
    }
    settle(line.bankTxnId);
    setRefusals((r) => {
      const { [line.bankTxnId]: _gone, ...rest } = r;
      return rest;
    });
    const party = partyOf(t, line);
    const account = accountLabel(lookups, leg.accountId);
    say({ tone: 'success', message: t((response.body as Record<string, unknown>).unchanged === true ? 'bankInbox.standard.unchanged' : 'bankInbox.standard.done', { party, account }), quiet: true });
    // The line now books by the standard: once the re-read brings it, it shows ★.
    setDrafts((d) => (d[line.bankTxnId] === undefined ? d : { ...d, [line.bankTxnId]: { ...(d[line.bankTxnId] as RowDraft), source: 'proposal' } }));
    ackLine(line.bankTxnId);
    reload();
    reloadOptions();
  };

  /**
   * D175: ☆ on a split or a route through a Durchlaufkonto, saved from the rule form: `set_bank_standard`
   * with the recipe (`legs`), its name, its optional text and its via account. The rest leg's account and
   * code ride along as `accountId`/`taxCode`, which the engine ignores beside `legs` and a D167 reader
   * understands. Resolves to the refusal, which the form says while it keeps every input, or to null.
   */
  const saveRule = async (line: BankInboxLine, payload: RulePayload): Promise<Err | null> => {
    if (workspaceId === null) return { ok: false, error: 'no_workspace' } as Err;
    // D176: the form's outcome ("Nicht buchen") and next step ride along (`ruleInputOf`).
    const input = { bankTxnId: line.bankTxnId, ...ruleInputOf(payload) };
    setBusyLine(line.bankTxnId);
    const response = await client.call('set_bank_standard', { workspaceId, ...input, idempotencyKey: keyFor(line.bankTxnId, ['set_bank_standard', input]) });
    setBusyLine(null);
    if (isErr(response.body)) return response.body;
    settle(line.bankTxnId);
    setRefusals((r) => {
      const { [line.bankTxnId]: _gone, ...rest } = r;
      return rest;
    });
    say({ tone: 'success', message: t((response.body as Record<string, unknown>).unchanged === true ? 'bankInbox.standard.unchangedNamed' : 'bankInbox.standard.doneNamed', { name: payload.label }), quiet: true });
    ackLine(line.bankTxnId);
    reload();
    reloadOptions();
    return null;
  };

  /** D175: an amount typed into a rule's asked field; the line opens so its preview shows. */
  const setAsk = (line: BankInboxLine, legIndex: number, value: string | null) => {
    setDrafts((d) => {
      const held = d[line.bankTxnId];
      const target = held?.target;
      if (target?.kind !== 'rule') return d;
      // D177: on a computed leg a typed value is the person's override; `null` ("berechnen") hands it back.
      const next = (a: (typeof target.asks)[number]) =>
        a.legIndex !== legIndex ? a : value === null ? { ...a, value: '', override: false } : { ...a, value, ...(a.computed !== undefined ? { override: true } : {}) };
      return { ...d, [line.bankTxnId]: { target: { ...target, asks: target.asks.map(next) }, source: 'edited' } };
    });
    if (selectedRef.current !== line.bankTxnId) select(line.bankTxnId);
  };

  /** ★ → "Buchungsregel entfernen": later lines of the counterparty are no longer prefilled by it. */
  const clearStandard = async (line: BankInboxLine, standardId: string) => {
    if (workspaceId === null) return;
    setBusyLine(line.bankTxnId);
    const response = await client.call('clear_bank_standard', { workspaceId, standardId, idempotencyKey: keyFor(line.bankTxnId, ['clear_bank_standard', standardId]) });
    setBusyLine(null);
    if (isErr(response.body)) {
      refuse(line.bankTxnId, response.body);
      return;
    }
    settle(line.bankTxnId);
    say({ tone: 'info', message: t('bankInbox.standard.removed', { party: partyOf(t, line) }), quiet: true });
    ackLine(line.bankTxnId);
    reload();
    reloadOptions();
  };

  // --- Belege (D142): dropped on a row, or picked from the Details or the paperclip --------------------
  const receipts = useAttachReceipt(workspaceId);
  /**
   * Every file, one after the other, each its own upload and link; the person hears which did not land.
   * `banner` says a refusal in an ErrorBanner (the line has left the list, so no row can carry it).
   */
  const attachTo = async (target: { bankTxnId: string; party: string }, files: readonly File[], banner = false) => {
    const attached: string[] = [];
    const failed: string[] = [];
    let lastRefusal: Err | null = null;
    for (const file of files) {
      const refusal = await receipts.attach(target.bankTxnId, file);
      if (refusal === null) {
        attached.push(file.name);
        continue;
      }
      lastRefusal = refusal;
      const reason =
        refusal.error === 'file_too_large'
          ? t('files.error.file_too_large')
          : refusal.error === 'permission_denied'
            ? t('files.error.permissionDenied.write')
            : refusal.error === 'entity_not_found'
              ? t('bankInbox.receipts.lineGone')
              : refusalText(t, refusal);
      failed.push(t('bankInbox.ack.attachFailed', { name: file.name, reason }));
    }
    if (attached.length > 0) {
      ackLine(target.bankTxnId);
      reload();
    }
    if (banner && lastRefusal !== null) {
      setReceiptError({ error: lastRefusal, message: failed.join(' ') });
      if (attached.length === 0) return;
    }
    const party = target.party;
    const done = attached.length === 1 ? t('bankInbox.ack.attached', { party, name: attached[0] ?? '' }) : plural(t, 'bankInbox.ack.attachedMany', attached.length, { party });
    if (failed.length === 0) say({ tone: 'success', message: done, quiet: true });
    else say({ tone: 'warn', message: attached.length > 0 ? done : failed[0] ?? '', ...(attached.length > 0 ? { detail: failed.join(' ') } : failed.length > 1 ? { detail: failed.slice(1).join(' ') } : {}) });
  };
  const pickReceiptFor = (line: BankInboxLine) => {
    attachFor.current = { bankTxnId: line.bankTxnId, party: partyOf(t, line) };
    fileInput.current?.click();
  };

  const onRefusalAction = (line: BankInboxLine, action: RefusalAction) => {
    const draft = drafts[line.bankTxnId];
    switch (action.kind) {
      case 'ignore':
        setSelectedId(line.bankTxnId);
        setMode('ignore');
        return;
      case 'match-entry':
        // The other side booked the transfer: put that entry on the line and show the comparison.
        setDrafts((d) => ({ ...d, [line.bankTxnId]: { target: { kind: 'existing_entry', entryId: action.entryId, acceptDifference: false }, source: 'edited' } }));
        setRefusals((r) => {
          const { [line.bankTxnId]: _gone, ...rest } = r;
          return rest;
        });
        setMode('details');
        return;
      case 'accept-difference':
        // An accepted difference states its reason (critic A39-12): book once the person has written
        // it, else take them to the field that asks for it.
        if (draft?.target?.kind === 'existing_entry') {
          const reason = (draft.target.differenceReason ?? '').trim();
          if (reason !== '') {
            const target: DraftTarget = { kind: 'existing_entry', entryId: draft.target.entryId, acceptDifference: true, differenceReason: reason };
            setDrafts((d) => ({ ...d, [line.bankTxnId]: { target, source: 'edited' } }));
            void book(line, target);
          } else {
            setMode('details');
            window.setTimeout(() => document.getElementById(`difference-reason-${line.bankTxnId}`)?.focus(), 0);
          }
        }
        return;
      case 'leave-open':
        if (draft?.target?.kind === 'open_item') {
          const target: DraftTarget = { ...draft.target, remainder: 'leave_open' };
          setDrafts((d) => ({ ...d, [line.bankTxnId]: { target, source: 'edited' } }));
          void book(line, target);
        }
        return;
      case 'show-line':
        setLinkTarget(action.bankTxnId);
        return;
      case 'reload':
        setRefusals((r) => {
          const { [line.bankTxnId]: _gone, ...rest } = r;
          return rest;
        });
        reload();
        reloadOptions();
        return;
      default:
        return;
    }
  };

  /** D150: several files went through `import_camt_files`; one sentence for the whole drop. */
  const onImportedFiles = (outcomes: FileOutcome[]) => {
    const imported = outcomes.filter((o) => o.outcome === 'imported').length;
    const refused = outcomes.filter((o) => o.outcome === 'refused').length;
    say({
      tone: refused > 0 ? 'warn' : imported > 0 ? 'success' : 'info',
      message: t('bankInbox.ack.importedFiles', { imported, total: outcomes.length }),
      ...(refused > 0 ? { detail: plural(t, 'bankInbox.ack.importedFilesRefused', refused) } : {}),
    });
    announceAttentionChanged();
    setParam('tab', null);
    reload();
    reloadOptions();
  };

  const onImported = (result: ImportResult) => {
    if (result.duplicate) {
      say({ tone: 'info', message: t('bankInbox.ack.importDuplicate') });
      return;
    }
    const account = accounts?.find((a) => a.id === result.bankAccountId);
    const skipped = result.skipped.length;
    const bits: string[] = [];
    if (skipped > 0) bits.push(plural(t, 'bankInbox.ack.importSkipped', skipped));
    // A36C-1: a number jump names its skipped numbers when the engine said which (the feed facts).
    const warned = warningsText(t, result.jump !== undefined ? result.warnings.filter((w) => w !== 'statement_number_jump') : result.warnings);
    if (warned !== '') bits.push(warned);
    if (result.jump !== undefined) bits.push(numberJumpText(t, result.jump));
    const added = result.txnCount;
    setFreshStatement(added > 0 ? result.statementId : null);
    // D178 point 19: lines matched one to one on a day a statement already covers wait for the person; the
    // whole delivery can be answered at once.
    const exactMatches = result.warnings.includes('overlap_same_movement') && result.statementId !== '';
    say({
      tone: warned !== '' ? 'warn' : added > 0 ? 'success' : 'info',
      message: added > 0 ? plural(t, 'bankInbox.ack.imported', added, { name: account?.name ?? '' }) : t('bankInbox.ack.importedNothing', { name: account?.name ?? '' }),
      ...(bits.length > 0 ? { detail: bits.join(' ') } : {}),
      ...(added > 0 ? { action: { label: t('bankInbox.ack.showNew'), run: () => setOnlyFresh(true) } } : {}),
      ...(exactMatches ? { extra: { label: t('bankInbox.duplicate.allExact'), run: () => void resolveDelivery(result.statementId) } } : {}),
    });
    setParam('tab', null);
    reload();
    reloadOptions();
  };

  /**
   * D178 point 19 (A20 §11.4): one answer for a whole delivery: every line of it matched one to one on its
   * movement is a duplicate (`resolve_possible_duplicate` with `scope: one_to_one_matches`), each ignored
   * with the reason `duplicate`.
   */
  const resolveDelivery = async (statementId: string) => {
    if (workspaceId === null) return;
    const response = await client.call('resolve_possible_duplicate', { workspaceId, statementId, scope: 'one_to_one_matches', decision: 'duplicate', idempotencyKey: crypto.randomUUID() });
    if (isErr(response.body)) {
      say({ tone: 'warn', message: refusalText(t, response.body) });
      return;
    }
    const count = typeof (response.body as Record<string, unknown>).count === 'number' ? ((response.body as Record<string, unknown>).count as number) : 0;
    say({ tone: 'success', message: plural(t, 'bankInbox.duplicate.ackDelivery', count), quiet: true });
    reload();
    reloadOptions();
  };

  /** D178 point 19: one flagged line answered: "Duplikat" ignores it (Rückgängig reopens), "Kein Duplikat" frees it. */
  const resolveDuplicate = async (line: BankInboxLine, decision: 'duplicate' | 'distinct', other: string | null) => {
    if (workspaceId === null) return;
    const input = { bankTxnId: line.bankTxnId, decision, ...(other !== null ? { otherBankTxnId: other } : {}) };
    setBusyLine(line.bankTxnId);
    const response = await client.call('resolve_possible_duplicate', { workspaceId, ...input, idempotencyKey: keyFor(line.bankTxnId, ['resolve_possible_duplicate', input]) });
    setBusyLine(null);
    if (isErr(response.body)) {
      refuse(line.bankTxnId, response.body);
      return;
    }
    const party = partyOf(t, line);
    if (decision === 'duplicate') {
      say({ tone: 'success', message: t('bankInbox.duplicate.ackDuplicate', { party }), action: { label: t('bankInbox.ack.undoShort'), run: () => void undoIgnore(line) }, quiet: true });
      afterDecision(line);
      return;
    }
    settle(line.bankTxnId);
    say({ tone: 'success', message: t('bankInbox.duplicate.ackDistinct', { party }), quiet: true });
    ackLine(line.bankTxnId);
    reload();
    reloadOptions();
  };

  const fetchStatements = async () => {
    const result = await bankFetch.run(activeFeeds.map((c) => c.connectionId));
    if (result === null) return;
    const { imported, waiting, jumps } = result;
    say({
      tone: waiting > 0 || jumps.length > 0 ? 'warn' : 'success',
      message: imported === 0 && waiting === 0 ? t('bankInbox.header.fetchedNothing') : t('bankInbox.header.fetched', { imported, waiting }),
      ...(jumps.length > 0 ? { detail: jumps.map((j) => numberJumpText(t, j)).join(' ') } : {}),
    });
    reload();
    reloadOptions();
    void loadFeed();
  };

  // D144 (A39 §12): ask the local model for the unplaced lines in view. It books nothing: every
  // suggestion lands on its line with the check glyph and the AI disclosure (D167: "Prüfen" is gone,
  // the row reads Buchen), and a person books it or not.
  const SUGGEST_REFUSALS = ['needs_local_runtime', 'needs_model_selection', 'needs_decide_model', 'unsupported_model_language', 'decide_failed'];
  const suggestAccounts = async () => {
    if (workspaceId === null) return;
    setSuggestBusy(true);
    const response = await client.call('suggest_bank_lines', {
      workspaceId,
      bankTxnIds: unplacedInView,
      idempotencyKey: crypto.randomUUID(),
    });
    setSuggestBusy(false);
    if (isErr(response.body)) {
      say({ tone: 'warn', message: refusalText(t, response.body, { own: 'bankInbox.suggest.error', known: SUGGEST_REFUSALS, fallback: 'bankInbox.suggest.error.other' }) });
      return;
    }
    const body = response.body as Record<string, unknown>;
    const suggested = typeof body.suggested === 'number' ? body.suggested : 0;
    const remaining = typeof body.remaining === 'number' ? body.remaining : 0;
    say({
      tone: suggested > 0 ? 'success' : 'info',
      message: suggested > 0 ? t('bankInbox.suggest.done', { count: suggested }) : t('bankInbox.suggest.none'),
      ...(remaining > 0 ? { detail: t('bankInbox.suggest.more', { count: remaining }) } : {}),
    });
    reload();
  };

  const openImport = () => {
    setImportFile(null);
    setImportOpen(true);
  };

  // --- states -------------------------------------------------------------------------------------
  const headerMenu = [
    { key: 'accounts', label: t('bankInbox.header.bankAccounts'), onSelect: () => navigate('/bank-accounts') },
    ...(runtimeReady && unplacedCount > 0 && !noStatementAnywhere
      ? [{ key: 'suggest', label: suggestBusy ? t('bankInbox.suggest.busy') : t('bankInbox.suggest.action'), onSelect: () => void suggestAccounts(), disabled: !canPost || suggestBusy }]
      : []),
  ];
  const fetchItems = [
    ...(activeFeeds.length > 0 ? [{ key: 'fetch', label: t('bankInbox.header.fetchFromBank'), onSelect: () => void fetchStatements(), disabled: !canPay || fetchBusy }] : []),
    { key: 'import', label: t('bankInbox.header.importFile'), onSelect: openImport, disabled: !canPay },
  ];
  const header = (
    <SurfaceHeader
      title={t('bankInbox.title')}
      titleId="bank-title"
      subtitle={accounts !== null && accounts.length === 1 && accounts[0] !== undefined ? `${accounts[0].name} · ${accounts[0].currency}` : accounts !== null && accounts.length > 1 ? t('bankInbox.subtitleMany', { count: accounts.length }) : undefined}
      help={<SurfaceHelp surface="Bank" />}
      actions={
        accounts !== null && accounts.length > 0 ? (
          <>
            {/* D175: the rules live in their own sheet, never on the inbox; one quiet text button opens it. */}
            {rulesReadable && (
              <button type="button" className="btn btn--ghost bank-rules-link" onClick={() => setRulesOpen(true)}>
                {lookups.standardById.size > 0 ? t('bankInbox.rules.headerCount', { count: lookups.standardById.size }) : t('bankInbox.rules.header')}
              </button>
            )}
            <OverflowMenu label={t('bankInbox.header.more')} items={headerMenu} />
            {noStatementAnywhere ? (
              <>
                {activeFeeds.length > 0 && (
                  <button type="button" className="btn btn--secondary" disabled={!canPay || fetchBusy} onClick={() => void fetchStatements()}>
                    {fetchBusy ? t('bankInbox.header.fetching') : t('bankInbox.header.fetchFromBank')}
                  </button>
                )}
                <button type="button" className="btn btn--primary" disabled={!canPay} onClick={openImport}>
                  {t('bankInbox.import.open')}
                </button>
              </>
            ) : (
              <MenuButton
                label={fetchBusy ? t('bankInbox.header.fetching') : t('bankInbox.header.getStatement')}
                icon={<FetchGlyph size={16} />}
                items={fetchItems}
                {...(lastFetched !== undefined ? { caption: t('bankInbox.header.lastFetched', { date: formatDate(lastFetched) }) } : {})}
              />
            )}
            {/* D167 polish 3: at one line the bulk button only repeats that row's Buchen. */}
            {sureLines.length > 1 && !noStatementAnywhere && (
              <button type="button" className="btn btn--primary" disabled={bulkBusy || !canPost || !canPay} onClick={() => void bookAllSure()}>
                {bulkBusy ? t('bankInbox.row.busy') : t('bankInbox.bulk.bookSure', { count: sureLines.length })}
              </button>
            )}
          </>
        ) : undefined
      }
    />
  );

  if (workspaceId === null) return <NoWorkspaceState />;
  if (!canRead) {
    return (
      <section className="bank" aria-labelledby="bank-title" ref={setBankEl}>
        {header}
        <PermissionDenied title={t('bankInbox.denied.title')} body={t('bankInbox.denied.body')} />
      </section>
    );
  }
  if (accountsError !== null) {
    return (
      <section className="bank" aria-labelledby="bank-title" ref={setBankEl}>
        {header}
        {accountsError.error === 'permission_denied' ? (
          <PermissionDenied title={t('bankInbox.denied.title')} body={t('bankInbox.denied.body')} />
        ) : (
          <ErrorBanner context="read" error={accountsError} onRetry={() => void loadAccounts()} />
        )}
      </section>
    );
  }
  if (accounts === null) {
    return (
      <section className="bank" aria-labelledby="bank-title" ref={setBankEl}>
        {header}
        <div className="bank-list panel">
          <BankSkeleton />
        </div>
      </section>
    );
  }
  if (accounts.length === 0) {
    return (
      <section className="bank" aria-labelledby="bank-title" ref={setBankEl}>
        {header}
        <EmptyState title={t('bankInbox.first.noAccountTitle')} hint={t('bankInbox.first.noAccountHint')} action={{ label: t('bankInbox.first.createAccount'), to: '/bank-accounts?new=1' }} />
      </section>
    );
  }

  const tabs = [
    { id: 'open', label: counts.open === null ? t('bankInbox.tab.open') : t('bankInbox.tab.openCount', { count: counts.open }) },
    { id: 'booked', label: counts.booked === null ? t('bankInbox.tab.booked') : t('bankInbox.tab.bookedCount', { count: counts.booked }) },
    { id: 'ignored', label: counts.ignored === null ? t('bankInbox.tab.ignored') : t('bankInbox.tab.ignoredCount', { count: counts.ignored }) },
  ];
  const askAgent = (line: BankInboxLine) => {
    keyboard?.openPalette(t('bankInbox.agent.question', { date: lineDateLong(line), party: partyOf(t, line), amount: formatMoney(line.amountMinor, line.currency) }));
  };

  /**
   * D177: what a line books as it stands on screen: the split's positions while a split is under way,
   * else the row's draft. The row, its Buchen and the panel's preview all read this one draft.
   */
  const effectiveDraft = (line: BankInboxLine): RowDraft | undefined => {
    const split = splits[line.bankTxnId];
    if (split === undefined) return drafts[line.bankTxnId];
    return { target: splitTargetOf(splitStateOf(line, split), split), source: 'edited' };
  };
  /** The Buchungstext to send with a booking: only one the person changed (`bookingTextToSend`). */
  const textOpts = (line: BankInboxLine): { text?: string } => {
    const text = bookingTextToSend(line, texts[line.bankTxnId]);
    return text === undefined ? {} : { text };
  };
  /** The MWST of a one-account booking, from the row's picker or the Details'. */
  const setVat = (line: BankInboxLine, code: string) => {
    const target = drafts[line.bankTxnId]?.target;
    if (target?.kind !== 'accounts' || target.legs.length !== 1 || target.legs[0] === undefined) return;
    // `...target` keeps a Durchlaufkonto (D175) the one leg routes through.
    setDrafts((d) => ({ ...d, [line.bankTxnId]: { target: { ...target, legs: [{ ...(target.legs[0] as NonNullable<(typeof target.legs)[0]>), taxCode: code }] }, source: 'edited' } }));
    focusBookFor.current = line.bankTxnId;
  };
  /** Buchen on the row or in the panel: the line's effective target, with the person's Buchungstext. */
  const bookLine = (line: BankInboxLine) => {
    const draft = effectiveDraft(line);
    const target = draft?.target ?? null;
    if (target === null) return;
    const split = splits[line.bankTxnId];
    if (split !== undefined && !splitStateOf(line, split).complete) return;
    void decideLine(line, target, draft?.source ?? 'proposal', textOpts(line));
  };
  /** Aufteilen (D177 point 6): the position rows open under the row, and the row is selected. */
  const beginSplit = (line: BankInboxLine) => {
    setSplits((s) => (s[line.bankTxnId] !== undefined ? s : { ...s, [line.bankTxnId]: startSplit(line, drafts[line.bankTxnId]?.target ?? null) }));
    setSelectedId(line.bankTxnId);
    setMode('details');
    const lineId = line.bankTxnId;
    window.setTimeout(() => document.querySelector<HTMLElement>(`tr.bank-split-row[data-split-for="${CSS.escape(lineId)}"] .bank-split-row__amount`)?.focus(), 0);
  };
  const endSplit = (line: BankInboxLine) => setSplits(({ [line.bankTxnId]: _gone, ...rest }) => rest);
  /** "Anders buchen": the whole "Worauf buchen?" list, open at once (D175). */
  const bookOtherwise = (line: BankInboxLine) => {
    setDrafts((d) => ({ ...d, [line.bankTxnId]: { target: null, source: 'edited', other: true } }));
    window.setTimeout(() => setOpenPicker({ lineId: line.bankTxnId, which: 'target' }), 0);
  };
  /** Another of the payer's rules, from the Woher switcher: the row books by it (its asks in the panel). */
  const pickRule = (line: BankInboxLine, standardId: string) => {
    const target = ruleTargetOf(lookups, standardId);
    setDrafts((d) => ({ ...d, [line.bankTxnId]: { target, source: 'edited' } }));
    if (target.kind === 'rule' && target.asks.some((a) => a.computed === undefined)) {
      window.setTimeout(() => document.querySelector<HTMLInputElement>('[data-panel-for] .bank-ask__input')?.focus(), 0);
    }
  };
  const openRule = (standardId: string) => {
    setRulesFocus(standardId);
    setRulesOpen(true);
  };

  const panelFor = (line: BankInboxLine) => {
    const draft = effectiveDraft(line);
    const target = draft?.target ?? null;
    const split = splits[line.bankTxnId];
    const allowed = target === null || canBookTarget(target);
    return (
      <DetailsPanel
        workspaceId={workspaceId}
        line={line}
        draft={draft}
        lookups={lookups}
        mode={mode}
        caps={{ post: canPost, pay: canPay, decideVorschlag: canDecideVorschlag, attach: receipts.canAttach }}
        whoamiActor={whoami?.actor ?? null}
        busy={busyLine === line.bankTxnId || receipts.busyLine === line.bankTxnId}
        refusal={refusals[line.bankTxnId] ?? null}
        claimedEntryIds={claimedEntryIds}
        text={texts[line.bankTxnId] ?? defaultBookingText(line)}
        bookState={
          duplicateFlagOf(line) !== null
            ? { enabled: false, reason: t('bankInbox.duplicate.bookWhy') }
            : bookStateOf(t, line, target, { allowed, split: split === undefined ? null : splitStateOf(line, split) })
        }
        consequence={target === null ? null : consequenceFor(target)}
        splitting={split !== undefined}
        {...(ignorePreset !== undefined ? { ignorePreset } : {})}
        onText={(text) => setTexts((x) => ({ ...x, [line.bankTxnId]: text }))}
        onMode={(next) => {
          setMode(next);
          if (next === 'details') setIgnorePreset(undefined);
        }}
        onDraft={(next, source) => {
          endSplit(line);
          setDrafts((d) => ({ ...d, [line.bankTxnId]: { target: next, source } }));
        }}
        onAsk={(legIndex, value) => setAsk(line, legIndex, value)}
        onVat={(code) => setVat(line, code)}
        onBook={() => bookLine(line)}
        onBookTarget={(next) => {
          const source = targetKey(next) === targetKey(proposalTarget(line)) ? 'proposal' : 'edited';
          setDrafts((d) => ({ ...d, [line.bankTxnId]: { target: next, source } }));
          void decideLine(line, next, source);
        }}
        onSplit={() => beginSplit(line)}
        onSetStandard={() => void setStandard(line)}
        onSaveRule={(payload) => saveRule(line, payload)}
        onOpenRule={openRule}
        onPickRule={(id) => pickRule(line, id)}
        onOther={() => bookOtherwise(line)}
        onRefusalAction={(action) => onRefusalAction(line, action)}
        onIgnore={(reason, note) => ignore(line, reason, note)}
        onReopen={(reason) => reopen(line, reason)}
        onApprove={(v) => void approve(line, v)}
        onReject={(v, reason) => void reject(line, v, reason)}
        onAgent={() => askAgent(line)}
        onAttach={() => pickReceiptFor(line)}
        onReceiptsChanged={reload}
        {...(focusNav !== undefined ? { focus: focusNav } : {})}
      />
    );
  };

  /** The paperclip with a count: the line's Belege, in its panel. */
  const openReceipts = (line: BankInboxLine) => {
    setSelectedId(line.bankTxnId);
    setMode('receipts');
  };

  const toggle = (line: BankInboxLine) => select(selectedId === line.bankTxnId ? null : line.bankTxnId);
  const selectedLine = selectedId === null ? undefined : visible.find((l) => l.bankTxnId === selectedId);
  // D178 N2 (A39 §18.1): the detail area is there only while a line is selected; at rest the list takes the
  // whole workspace. Docked right, the table's MWST, paperclip and pick columns step aside (D177); docked at
  // the bottom the table keeps its full width and every column.
  const areaOpen = wide && selectedLine !== undefined;
  // D178 point 9 (A39 §20.2): the focus view, one line at a time. The stepper walks the list in view; "Liste
  // ausblenden" (a per-person preference) gives the area the whole workspace, except while a split's
  // positions are under way, which live in the list's rows.
  const focusView = bookingView !== 'tabs' && bookingView !== 'smart';
  const selectedIndex = selectedLine === undefined ? -1 : visible.findIndex((l) => l.bankTxnId === selectedLine.bankTxnId);
  const listHidden = focusView && areaOpen && listHiddenPref === true && selectedLine !== undefined && splits[selectedLine.bankTxnId] === undefined;
  const focusNav: FocusNav | undefined =
    focusView && areaOpen && selectedLine !== undefined
      ? {
          index: selectedIndex,
          count: visible.length,
          onStep: (delta) => {
            const next = visible[selectedIndex + delta];
            if (next === undefined) return;
            select(next.bankTxnId);
            scrollTo.current = next.bankTxnId;
          },
          listHidden: listHiddenPref === true,
          onListHidden: (hidden) => void setListHidden(hidden),
        }
      : undefined;
  const panelOpen = areaOpen && layout.edge === 'right';
  /** × and Escape (A39 §18.1): the area closes and focus returns to its line's row, else to the list. */
  const closeArea = () => {
    const lineId = selectedRef.current;
    select(null);
    if (lineId !== null) focusRequest.current = { lineId, orList: true };
  };
  /** The facts card for a line (A39 §18.4), at the top of the area's scrolling middle. */
  const factsFor = (line: BankInboxLine) => {
    const duplicate = duplicateFlagOf(line);
    return (
      <>
        <FactsCard line={line} lookups={lookups} titleId={factsTitleId} showAccount={accounts.length > 1} onReceipts={() => openReceipts(line)} />
        {duplicate !== null && (
          <DuplicateCheck
            line={line}
            flag={duplicate}
            busy={busyLine === line.bankTxnId}
            canDecide={canPost}
            onDecide={(decision, other) => void resolveDuplicate(line, decision, other)}
            onShowLine={(id) => setLinkTarget(id)}
          />
        )}
      </>
    );
  };

  // D177 point 7: a header cell's drag handle; the widths are the person's, remembered per seat.
  const resizer = (column: ResizableColumn, name: string) => (
    <ColumnResizer
      column={column}
      label={t('bankInbox.col.resize', { column: name })}
      width={columns.widths[column]}
      onWidth={(w) => columns.setWidth(column, w)}
      onCommit={columns.commit}
      onReset={() => columns.reset(column)}
    />
  );

  const pickBar =
    pickedLines.length === 0 ? null : (
      <PickBar
        count={pickedLines.length}
        ready={readyPicked.length}
        busy={bulkBusy}
        canPost={canPost}
        onBook={() => void bookPicked()}
        onIgnore={(reason) => void ignorePicked(reason)}
        onClear={() => setPicked(new Set())}
      />
    );

  const rows =
    visible.length === 0 ? null : (
      <table className="bank-table" aria-labelledby="bank-list-caption" data-picking={picked.size > 0 ? 'true' : undefined}>
        <caption id="bank-list-caption" className="visually-hidden">
          {t(`bankInbox.caption.${tab}`)}
        </caption>
        {/* D177 point 7: the widths are the person's (dragged, remembered, reset by a double-click). The
            counterparty and the account flex; with the Details panel open the MWST and paperclip columns go. */}
        <colgroup>
          {tab === 'open' && !panelOpen && <col className="bank-col--pick" style={{ width: DEFAULT_COLUMN_WIDTHS.pick }} />}
          <col className="bank-col--date" style={{ width: columns.widths.date }} />
          <col
            className="bank-col--party"
            style={columns.widths.party !== null ? { width: columns.widths.party } : panelOpen ? { width: COMPACT_PARTY_WIDTH } : undefined}
          />
          <col className="bank-col--target" />
          {!panelOpen && <col className="bank-col--vat" style={{ width: columns.widths.vat }} />}
          <col className="bank-col--amount" style={{ width: columns.widths.amount }} />
          {!panelOpen && <col className="bank-col--clip" style={{ width: DEFAULT_COLUMN_WIDTHS.clip }} />}
          <col className="bank-col--book" style={{ width: DEFAULT_COLUMN_WIDTHS.book }} />
          <col className="bank-col--ignore" style={{ width: DEFAULT_COLUMN_WIDTHS.ignore }} />
        </colgroup>
        <thead>
          <tr>
            {tab === 'open' && !panelOpen && (
              <th scope="col" className="bank-col-head--pick">
                <label className="check-cell">
                  <input
                    type="checkbox"
                    aria-label={t('bankInbox.pick.all')}
                    checked={visible.length > 0 && pickedLines.length === visible.length}
                    ref={(el) => {
                      if (el !== null) el.indeterminate = pickedLines.length > 0 && pickedLines.length < visible.length;
                    }}
                    onChange={() => setPicked(pickedLines.length === visible.length ? new Set() : new Set(visible.map((l) => l.bankTxnId)))}
                  />
                </label>
              </th>
            )}
            <th scope="col" className="bank-col-head--resizable">
              {t('bankInbox.col.date')}
              {resizer('date', t('bankInbox.col.date'))}
            </th>
            <th scope="col" className="bank-col-head--resizable">
              {t('bankInbox.col.party')}
              {resizer('party', t('bankInbox.col.party'))}
            </th>
            <th scope="col" colSpan={tab === 'open' || panelOpen ? 1 : 2}>
              {t(tab === 'open' ? 'bankInbox.col.target' : 'bankInbox.col.decision')}
            </th>
            {tab === 'open' && !panelOpen && (
              <th scope="col" className="bank-col-head--resizable">
                {t('bankInbox.col.vat')}
                {resizer('vat', t('bankInbox.col.vat'))}
              </th>
            )}
            <th scope="col" className="bank-col-head--num bank-col-head--resizable">
              {t('bankInbox.col.amount')}
              {resizer('amount', t('bankInbox.col.amount'))}
            </th>
            {!panelOpen && (
              <th scope="col" className="bank-col-head--clip">
                <span className="visually-hidden">{t('bankInbox.receipts.title')}</span>
              </th>
            )}
            <th scope="col" className="bank-col-head--book">
              <span className="visually-hidden">{t('bankInbox.col.actions')}</span>
            </th>
            <th scope="col" className="bank-col-head--ignore">
              <span className="visually-hidden">{t('bankInbox.col.ignore')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {visible.map((line) => {
            const isSel = line.bankTxnId === selectedId;
            const accountName = accounts.length > 1 && accountFilter === '' ? accounts.find((a) => a.id === line.bankAccountId)?.name : undefined;
            const onDropFiles = receipts.canAttach ? (files: File[]) => void attachTo({ bankTxnId: line.bankTxnId, party: partyOf(t, line) }, files) : null;
            if (line.state === 'open') {
              const draft = effectiveDraft(line);
              const split = splits[line.bankTxnId];
              const splitState = split === undefined ? null : splitStateOf(line, split);
              const after =
                split === undefined || splitState === null ? undefined : (
                  <SplitRows
                    line={line}
                    split={split}
                    state={splitState}
                    lookups={lookups}
                    busy={busyLine === line.bankTxnId || bulkBusy}
                    withPick={!panelOpen}
                    compact={panelOpen}
                    openPicker={splitPicker}
                    onOpenPicker={setSplitPicker}
                    onChange={(next) => setSplits((x) => ({ ...x, [line.bankTxnId]: next }))}
                    onCancel={() => endSplit(line)}
                  />
                );
              return (
                <OpenRow
                  key={line.bankTxnId}
                  workspaceId={workspaceId}
                  line={line}
                  draft={draft}
                  lookups={lookups}
                  selected={isSel}
                  onToggle={() => toggle(line)}
                  onDropFiles={onDropFiles}
                  {...(accountName !== undefined ? { accountName } : {})}
                  fresh={freshStatement !== null && line.statementId === freshStatement}
                  justCommitted={ackLineId === line.bankTxnId}
                  busy={busyLine === line.bankTxnId || bulkBusy}
                  showCurrency={showCurrency}
                  vorschlag={lineVorschlag(line, lookups.vorschlaege)}
                  canBook={canBookTarget}
                  canPost={canPost}
                  canAttach={receipts.canAttach}
                  consequence={consequenceFor}
                  openPicker={openPicker?.lineId === line.bankTxnId ? openPicker.which : null}
                  onOpenPicker={(which) => setOpenPicker(which === null ? null : { lineId: line.bankTxnId, which })}
                  onPick={(result) => {
                    if (result.kind === 'mode') {
                      // D177 point 6: Aufteilen opens the position rows under the row; the other two
                      // decisions open their editor in the Details panel.
                      if (result.mode === 'split') {
                        beginSplit(line);
                        return;
                      }
                      setSelectedId(line.bankTxnId);
                      setMode(result.mode);
                      return;
                    }
                    if (result.kind === 'other') {
                      bookOtherwise(line);
                      return;
                    }
                    if (result.kind !== 'target') return;
                    endSplit(line);
                    setDrafts((d) => ({ ...d, [line.bankTxnId]: { target: result.target, source: result.source } }));
                    if (result.target.kind === 'rule') {
                      // A picked rule that asks for an amount opens the Details, its first field focused.
                      const lineId = line.bankTxnId;
                      if (result.target.asks.some((a) => a.computed === undefined)) {
                        select(lineId);
                        window.setTimeout(() => document.querySelector<HTMLInputElement>('[data-panel-for] .bank-ask__input')?.focus(), 0);
                      } else focusBookFor.current = lineId;
                      return;
                    }
                    // A control-account leg is said BEFORE the commit (critic A39-11): the Details open.
                    if (result.target.kind === 'accounts' && controlAccountsIn(lookups, result.target.legs).length > 0) select(line.bankTxnId);
                    const leg = result.target.kind === 'accounts' && result.target.legs.length === 1 ? result.target.legs[0] : undefined;
                    const vatShows = leg !== undefined && vatPickerShows(lookups, leg);
                    if (result.chainVat && vatShows) setOpenPicker({ lineId: line.bankTxnId, which: 'vat' });
                    else focusBookFor.current = line.bankTxnId;
                  }}
                  onClear={() => {
                    // × (D167): back to "Worauf buchen?", the person's own act.
                    setOpenPicker(null);
                    endSplit(line);
                    setDrafts((d) => ({ ...d, [line.bankTxnId]: { target: null, source: 'edited' } }));
                  }}
                  onVat={(code) => setVat(line, code)}
                  onBook={() => bookLine(line)}
                  onIgnore={(reason) => ignore(line, reason, '')}
                  onIgnoreOther={() => {
                    setSelectedId(line.bankTxnId);
                    setIgnorePreset('other');
                    setMode('ignore');
                  }}
                  onAttach={() => pickReceiptFor(line)}
                  onSetStandard={() => void setStandard(line)}
                  onRuleForm={() => {
                    // D178 N2: a split or a route saves its rule from the form in the detail area.
                    setSelectedId(line.bankTxnId);
                    setMode('rule');
                  }}
                  onOpenRule={openRule}
                  onClearStandard={(standardId) => void clearStandard(line, standardId)}
                  onOpenReceipts={() => openReceipts(line)}
                  bookRef={(el) => {
                    bookRefs.current.set(line.bankTxnId, el);
                  }}
                  showPick={sureIds.has(line.bankTxnId) || picked.size > 0}
                  picked={picked.has(line.bankTxnId)}
                  onTogglePick={() => togglePick(line.bankTxnId)}
                  split={splitState}
                  compact={panelOpen}
                  after={after}
                />
              );
            }
            return (
              <DecidedRow
                key={line.bankTxnId}
                line={line}
                selected={isSel}
                justCommitted={ackLineId === line.bankTxnId}
                onToggle={() => toggle(line)}
                onDropFiles={onDropFiles}
                {...(accountName !== undefined ? { accountName } : {})}
                showCurrency={showCurrency}
                summary={rowSummary(line)}
                undoLabel={line.state === 'ignored' ? t('bankInbox.decided.unignore') : line.state === 'matched' ? t('bankInbox.decided.unmatch') : t('bankInbox.decided.reopen')}
                canUndo={canPost && busyLine !== line.bankTxnId}
                canAttach={receipts.canAttach}
                onUndo={() => {
                  setSelectedId(line.bankTxnId);
                  setMode('reopen');
                }}
                onAttach={() => pickReceiptFor(line)}
                onOpenReceipts={() => openReceipts(line)}
                compact={panelOpen}
                followUp={lineFollowUp(line)}
                followUpHref={(standardId) => `/journal?${new URLSearchParams({ vorlage: standardId, ...(lineDate(line) !== null ? { date: lineDate(line) as string } : {}) }).toString()}`}
              />
            );
          })}
        </tbody>
      </table>
    );

  const listBody =
    inboxError !== null ? (
      inboxError.error === 'permission_denied' ? (
        <PermissionDenied title={t('bankInbox.denied.title')} body={t('bankInbox.denied.body')} />
      ) : (
        <ErrorBanner context="read" error={inboxError} onRetry={reload} />
      )
    ) : inbox === null ? (
      <BankSkeleton />
    ) : visible.length === 0 ? (
      noStatementAnywhere ? (
        <div className="bank-first">
          <EmptyState title={t('bankInbox.first.noStatementTitle')} hint={t('bankInbox.first.noStatementHint')} action={{ label: t('bankInbox.import.open'), onClick: openImport }} />
          <FileDrop
            multiple
            accept=".xml,text/xml,application/xml"
            label={t('bankInbox.import.choose')}
            prompt={t('bankInbox.import.drop')}
            hint={t('bankInbox.import.hint')}
            disabled={!canPay}
            onFiles={(files) => {
              setImportFile(files[0] ?? null);
              setImportFiles(files);
              setImportOpen(true);
            }}
          />
        </div>
      ) : query !== '' || facet !== 'all' || direction !== 'all' || periodFrom !== null || periodTo !== null || onlyFresh ? (
        <EmptyState
          filtered={{
            onClear: () => {
              setQueryText('');
              setQuery('');
              setParams(
                (prev) => {
                  const out = new URLSearchParams(prev);
                  out.delete('facet');
                  out.delete('dir');
                  out.delete('from');
                  out.delete('to');
                  return out;
                },
                { replace: true },
              );
              setOnlyFresh(false);
            },
          }}
          title={t('bankInbox.empty.filteredTitle')}
          hint={t('bankInbox.empty.filteredHint')}
        />
      ) : tab === 'open' ? (
        <EmptyState title={t('bankInbox.empty.openTitle')} hint={t('bankInbox.empty.openHint')} action={{ label: t('bankInbox.empty.showBooked'), onClick: () => setParam('tab', 'booked') }} />
      ) : tab === 'booked' ? (
        <EmptyState title={t('bankInbox.empty.bookedTitle')} hint={t('bankInbox.empty.bookedHint')} action={{ label: t('bankInbox.empty.showOpen'), onClick: () => setParam('tab', null) }} />
      ) : (
        <EmptyState title={t('bankInbox.empty.ignoredTitle')} hint={t('bankInbox.empty.ignoredHint')} action={{ label: t('bankInbox.empty.showOpen'), onClick: () => setParam('tab', null) }} />
      )
    ) : (
      <>
        {pickBar}
        {rows}
      </>
    );

  const accountOptions = [{ value: '', label: t('bankInbox.accounts.all') }, ...accounts.map((a) => ({ value: a.id, label: a.name }))];
  const trustBalances = summary.filter((b) => accountFilter === '' || b.bankAccountId === accountFilter);

  // The facets with their counts, each offered only when it would change something (not 0, not every
  // line): a filter that changes nothing is noise. One that is ON stays, so it can be switched off.
  // D167: "Brauchen dich", "Sicher", "Ohne Beleg" and the two directions live in ONE quiet Filter menu
  // (the URL keeps `?facet=` and `?dir=`), so the toolbar is the tabs, the menu and the search.
  const total = lines.length;
  const facetItems: { value: Facet; key: string; count: number }[] =
    tab === 'open'
      ? [
          { value: 'needs', key: 'bankInbox.filter.needs', count: lines.filter(needsYou).length },
          { value: 'sure', key: 'bankInbox.filter.sure', count: lines.filter(isSure).length },
        ]
      : tab === 'booked'
        ? [{ value: 'noreceipt', key: 'bankInbox.filter.noReceipt', count: lines.filter((l) => l.needsReceipt).length }]
        : [];
  // D178 N3: the directions left the Filter menu for their own segmented control with the engine's counts.
  const filterItems = facetItems
    .filter((c) => c.value === facet || (c.count > 0 && c.count < total))
    .map((c) => ({ key: c.value, label: t(c.key, { count: c.count }), checked: facet === c.value, onSelect: () => setFacet(facet === c.value ? 'all' : c.value) }));
  const activeFilters = facet !== 'all' ? 1 : 0;
  const setPeriod = (from: string | null, to: string | null) => {
    setParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        if (from === null) out.delete('from');
        else out.set('from', from);
        if (to === null) out.delete('to');
        else out.set('to', to);
        return out;
      },
      { replace: true },
    );
  };

  return (
    // D177 (UX judge round 2): every tooltip on /bank renders in the overlay layer, so neither the table's
    // panel nor the Details panel's scroll ever clips one.
    <TooltipPortalContext.Provider value={true}>
    <section className="bank" aria-labelledby="bank-title" ref={setBankEl}>
      {header}
      {fetchError !== null && <ErrorBanner error={fetchError} message={channelRefusal(t, fetchError)} />}
      {receiptError !== null && <ErrorBanner error={receiptError.error} message={receiptError.message} />}
      {/* Two or more accounts in view: one summary line, every account in its card (D152, 02.10.2026). */}
      {trustBalances.length > 1 ? (
        <div className="bank-trusts">
          <TrustSummary
            balances={trustBalances}
            onShowOpen={(id) => {
              setParam('tab', null);
              setParam('account', id);
            }}
          />
        </div>
      ) : trustBalances.length === 1 ? (
        <div className="bank-trusts">
          {trustBalances.map((b) => (
            <TrustLine
              key={b.bankAccountId}
              balance={b}
              named={accounts.length > 1}
              onShowOpen={() => {
                setParam('tab', null);
                setParam('account', accounts.length > 1 ? b.bankAccountId : null);
              }}
            />
          ))}
        </div>
      ) : null}
      {ack !== null && (
        <ActionFeedback
          key={ack.id}
          tone={ack.tone}
          message={ack.message}
          {...(ack.detail !== undefined ? { detail: ack.detail } : {})}
          landed={ack.tone === 'success'}
          onDismiss={() => setAck(null)}
          dismissLabel={t('bankInbox.ack.dismiss')}
          className="bank-ack"
        >
          {ack.action !== undefined && (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => {
                ack.action?.run();
                setAck(null);
              }}
            >
              {ack.action.label}
            </button>
          )}
          {ack.extra !== undefined && (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => {
                ack.extra?.run();
                setAck(null);
              }}
            >
              {ack.extra.label}
            </button>
          )}
        </ActionFeedback>
      )}
      <div className="bank-toolbar">
        <Tabs
          tabs={tabs}
          activeId={tab}
          label={t('bankInbox.tab.label')}
          onChange={(id) => {
            setParams(
              (prev) => {
                const out = new URLSearchParams(prev);
                if (id === 'open') out.delete('tab');
                else out.set('tab', id);
                out.delete('facet');
                return out;
              },
              { replace: true },
            );
            setOnlyFresh(false);
            setLinkMissing(false);
            setStatus(null);
            select(null);
          }}
        />
        <div className="bank-toolbar__tools">
          {/* D167 polish 2: the one calm status line. Always in the DOM (an empty live region), on the
              toolbar's own line, so a small act's confirmation never pushes the table down. */}
          <p
            ref={statusRef}
            className="bank-status"
            role="status"
            aria-live="polite"
            data-has={status !== null ? 'true' : undefined}
            onPointerEnter={() => setStatusHeld(true)}
            onPointerLeave={() => setStatusHeld(false)}
            onFocus={() => setStatusHeld(true)}
            onBlur={() => setStatusHeld(false)}
          >
            {status !== null && (
              <>
                <span className="bank-status__text">{[status.message, status.detail].filter((x) => x !== undefined && x !== '').join(' ')}</span>
                {status.action !== undefined && (
                  <button
                    type="button"
                    className="link-inline bank-status__action"
                    onClick={() => {
                      status.action?.run();
                      setStatus(null);
                    }}
                  >
                    {status.action.label}
                  </button>
                )}
              </>
            )}
          </p>
          {filterItems.length > 0 && (
            <MenuButton
              quiet
              className="bank-filter"
              label={activeFilters > 0 ? t('bankInbox.filter.labelActive', { count: activeFilters }) : t('bankInbox.filter.label')}
              icon={<FilterGlyph size={16} />}
              items={filterItems}
            />
          )}
          {accounts.length > 1 && (
            // B5 judge (axe aria-required-children, critical): the account filter is a button that opens a
            // listbox (the bank pickers' PickerButton), not a select-only combobox the audit cannot parse.
            <PickerButton
              label={`${t('bankInbox.accounts.label')}: ${accountOptions.find((o) => o.value === accountFilter)?.label ?? t('bankInbox.accounts.all')}`}
              options={accountOptions.map((o) => ({ id: o.value === '' ? ALL_ACCOUNTS : o.value, label: o.label, current: o.value === accountFilter }))}
              value={accountFilter === '' ? ALL_ACCOUNTS : accountFilter}
              onChange={(v) => setParam('account', v === ALL_ACCOUNTS || v === '' ? null : v)}
              searchLabel={t('bankInbox.accounts.label')}
              noMatchLabel={t('bankInbox.mode.noMatch')}
              className="bank-account-filter"
              width={280}
            >
              <span className="picker-trigger__value">
                <span className="picker-trigger__name">{accountOptions.find((o) => o.value === accountFilter)?.label ?? t('bankInbox.accounts.all')}</span>
              </span>
            </PickerButton>
          )}
          {onlyFresh && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOnlyFresh(false)}>
              {t('bankInbox.fresh.showAll')}
            </button>
          )}
          <label className="bank-search" htmlFor="bank-query">
            <SearchGlyph size={16} className="bank-search__glyph" />
            <span className="visually-hidden">{t('bankInbox.search.labelLong')}</span>
            <input id="bank-query" type="search" className="bank-search__input" placeholder={t('bankInbox.search.label')} value={queryText} onChange={(e) => setQueryText(e.target.value)} />
          </label>
        </div>
      </div>
      {/* D178 N3 (A39 §20.4): the list's own bar: the direction with the engine's counts, the Zeitraum, and
          the honest count of the whole filtered list with its pages. */}
      <div className="bank-listbar">
        <DirectionFilter value={direction} counts={inbox?.directionCounts ?? null} onChange={setDirection} />
        <PeriodFilter from={periodFrom} to={periodTo} onChange={setPeriod} />
        {inbox !== null && (
          <ListCount
            view={{ offset: pageAt.before, shown: inbox.lines.length, total: inbox.total, pageSize: PAGE, more: inbox.more }}
            onPrevious={() => {
              const back = pageHistory[pageHistory.length - 1] ?? FIRST_PAGE;
              setPageHistory((h) => h.slice(0, -1));
              setPageAt(back);
              select(null);
              listRef.current?.scrollTo?.({ top: 0 });
            }}
            onNext={() => {
              setPageHistory((h) => [...h, pageAt]);
              setPageAt({ offsets: inbox.returned.map((n, i) => (pageAt.offsets[i] ?? 0) + n), before: pageAt.before + inbox.lines.length });
              select(null);
              listRef.current?.scrollTo?.({ top: 0 });
            }}
          />
        )}
      </div>
      {linkMissing && selectedId === null && (
        <p className="bank-link-missing" role="status">
          {t('bankInbox.panel.linkMissing')}
        </p>
      )}
      {/* D178 N2 (A39 §18): the list and, docked right or at the bottom, the selected line's detail area with
          the divider between them (below the breakpoint: the drawer). Each region owns its scroll. */}
      <div
        className="bank-workspace"
        ref={workspaceRef}
        data-panel={areaOpen ? 'beside' : wide ? 'none' : 'drawer'}
        data-dock={areaOpen ? layout.edge : undefined}
        data-list={listHidden ? 'hidden' : undefined}
        style={areaOpen ? ({ '--bank-area-size': `${layout.size}px` } as CSSProperties) : undefined}
      >
        <div className="bank-list panel" ref={listRef} tabIndex={-1} aria-label={t('bankInbox.area.listLabel')}>
          {listBody}
        </div>
        {areaOpen && selectedLine !== undefined && (
          <>
            <DetailDivider
              edge={layout.edge}
              size={layout.size}
              bounds={layout.bounds}
              controls={areaId}
              onDrive={layout.drive}
              onCommit={layout.commit}
              onReset={layout.reset}
            />
            <DetailArea
              id={areaId}
              lineId={selectedLine.bankTxnId}
              edge={layout.edge}
              size={layout.size}
              titleId={factsTitleId}
              facts={factsFor(selectedLine)}
              onDock={layout.dock}
              onClose={closeArea}
              onHeaderPointerDown={dockDrag.onHeaderPointerDown}
              dragging={dockDrag.dragging}
            >
              {panelFor(selectedLine)}
            </DetailArea>
          </>
        )}
        {/* The drop preview of a header drag: the half of the workspace the area would dock in. */}
        {dockDrag.dragging && dockDrag.target !== null && <div className="bank-dock-preview" data-edge={dockDrag.target} aria-hidden="true" />}
      </div>
      {!wide && selectedLine !== undefined && (
        <DetailDrawer open onClose={() => select(null)} title={partyOf(t, selectedLine)} closeLabel={t('bankInbox.panel.closeDetails')}>
          <DrawerArea facts={factsFor(selectedLine)} close={() => select(null)}>
            {panelFor(selectedLine)}
          </DrawerArea>
        </DetailDrawer>
      )}
      <input
        ref={fileInput}
        type="file"
        hidden
        aria-label={t('bankInbox.receipts.attach')}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          const target = attachFor.current;
          e.target.value = '';
          attachFor.current = null;
          if (target === null || files.length === 0) return;
          // Attached to the line it was picked for, by its id, whether or not it is still in view; a line
          // that has left the list says its refusal in a banner (critic F9).
          void attachTo(target, files, !lines.some((l) => l.bankTxnId === target.bankTxnId));
        }}
      />
      <ImportDialog
        open={importOpen}
        workspaceId={workspaceId}
        accounts={accounts}
        initialFile={importFile}
        initialFiles={importFiles}
        preferredAccountId={accountFilter !== '' ? accountFilter : null}
        onClose={() => {
          setImportOpen(false);
          setImportFile(null);
          setImportFiles(null);
        }}
        onImported={onImported}
        onImportedFiles={onImportedFiles}
      />
      <RulesSheet
        open={rulesOpen}
        focusStandardId={rulesFocus}
        workspaceId={workspaceId}
        lookups={lookups}
        currency={accounts[0]?.currency ?? 'CHF'}
        canEdit={canPost}
        onClose={() => {
          setRulesOpen(false);
          setRulesFocus(null);
        }}
        onChanged={() => {
          reload();
          reloadOptions();
        }}
      />
    </section>
    </TooltipPortalContext.Provider>
  );
}

/** The warnings a write or an import answers with (`control_account_leg`, `batch_payments_kept`, ...), in words. */
const KNOWN_WARNINGS: ReadonlySet<string> = new Set([
  'control_account_leg',
  'accepted_difference',
  'reversal_line',
  'batch_payments_kept',
  'not_day_end_statement',
  'statement_number_jump',
  // D178 point 19 (A20 §11.4): what an import flagged for the person's answer.
  'possible_cross_format_duplicate',
  'overlap_same_movement',
  'covered_period_new_line',
]);
function warningsText(t: (k: string, p?: Record<string, string | number>) => string, raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  return raw
    .filter((w): w is string => typeof w === 'string' && KNOWN_WARNINGS.has(w))
    .map((w) => t(`bankInbox.warning.${w}`))
    .join(' ');
}

/** A decided line's decision, in words, for its row. */
function decidedSummary(t: (k: string, p?: Record<string, string | number>) => string, line: BankInboxLine): string {
  const d = line.decision;
  if (line.state === 'ignored') return t(`bankInbox.ignore.reason.${d?.ignoreReason ?? 'other'}.label`);
  switch (d?.targetKind) {
    case 'existing_entry':
      return t('bankInbox.decided.matched');
    case 'open_item':
      return t('bankInbox.decided.settled');
    case 'payment_batch':
      return t('bankInbox.decided.batch');
    default:
      return t('bankInbox.decided.booked');
  }
}

export default Bank;
