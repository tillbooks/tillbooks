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
 * focused row) or by a deep link (`?line=`, `?credit=`), and then ONE context strip shows under its row:
 * how sure, why, the VAT split, the rare actions as icons. Measured before it, on the picker: the first
 * line opened by itself as a block inside the list on every laptop, one line visible at 1280x800 behind
 * 81 words.
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { FilterChips } from '../../components/FilterChips';
import { Select } from '../../components/Select';
import { OverflowMenu } from '../../components/OverflowMenu';
import { Tooltip } from '../../components/Tooltip';
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
  draftFromProposal,
  draftFromVorschlag,
  isBookable,
  isCredit,
  isSureAndUntouched,
  isUntouched,
  parseBankAccounts,
  parseBills,
  parseChart,
  parseInbox,
  parseInvoices,
  parseTaxCodes,
  parseVorschlaege,
  proposalTarget,
  targetKey,
} from './model';
import { EMPTY_LOOKUPS, buildLookups, entryDateOf, lineDateLong, partyOf, plural, targetPhrase, vatPickerShows, type Lookups } from './lookups';
import { DecidedRow, OpenRow, type RowMenuAction } from './InboxRow';
import { ContextStrip, type StripMode } from './ContextStrip';
import { TrustLine, TrustSummary } from './TrustLine';
import { ImportDialog, type ImportResult } from './ImportDialog';
import type { FileOutcome } from './importOutcomes';
import { announceAttentionChanged } from '../Attention/attentionSummary';
import { PickBar } from './PickBar';
import { MenuButton } from './MenuButton';
import { controlAccountsIn } from './ControlAccountWarning';
import type { RefusalAction } from './errors';
import { FetchGlyph, InGlyph, OutGlyph, SearchGlyph } from './glyphs';
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
/** The most lines "Konten vorschlagen" names in one call: the engine's `MODEL_SUGGEST_IDS_MAX`. */
const SUGGEST_IDS_MAX = 200;
/** Skeleton rows: about the lines a laptop shows, so nothing grows when the data lands. */
const SKELETON_ROWS = 12;

interface InboxData {
  lines: BankInboxLine[];
  total: number;
  summary: BankAccountBalance[];
}

interface Ack {
  id: number;
  tone: 'success' | 'info' | 'warn';
  message: string;
  detail?: string;
  /** An undo or a follow-up the ack offers in place. */
  action?: { label: string; run: () => void };
}

/**
 * Where focus goes once a decision has re-read the list: the next ROW, never its Buchen (critic F3). A
 * held or a second Enter then selects the row at most; it never books a line nobody chose.
 */
interface FocusRequest {
  lineId: string;
}

/**
 * True when the person has put the focus somewhere other than the decided line while its write was in
 * flight: on another line's row or strip, or anywhere outside the list (critic round 2). Focus that is
 * still on the decided line, or lost to the page because its control went away, is not the person's.
 */
function focusMovedAway(lineId: string): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return false;
  const holder = active.closest<HTMLElement>('[data-line], [data-strip-for]');
  if (holder === null) return true;
  return (holder.dataset.line ?? holder.dataset.stripFor) !== lineId;
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
  const whoami = useCapabilities().whoami;

  // --- view state -------------------------------------------------------------------------------
  const tab: Tab = params.get('tab') === 'booked' ? 'booked' : params.get('tab') === 'ignored' ? 'ignored' : 'open';
  const accountFilter = params.get('account') ?? '';
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
  const [mode, setMode] = useState<StripMode>('details');
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [openPicker, setOpenPicker] = useState<{ lineId: string; which: 'target' | 'vat' } | null>(null);
  const [busyLine, setBusyLine] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  // The lines picked with the row checkboxes for a bulk action (open tab only), by bank line id.
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [refusals, setRefusals] = useState<Record<string, Err>>({});
  const [ack, setAck] = useState<Ack | null>(null);
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

  const say = useCallback((next: Omit<Ack, 'id'>) => {
    ackSeq.current += 1;
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
  }, []);

  // --- data -------------------------------------------------------------------------------------
  const [accounts, setAccounts] = useState<BankAccountOption[] | null>(null);
  const [accountsError, setAccountsError] = useState<Err | null>(null);
  const [inbox, setInbox] = useState<InboxData | null>(null);
  const [inboxError, setInboxError] = useState<Err | null>(null);
  const [counts, setCounts] = useState<Record<Tab, number | null>>({ open: null, booked: null, ignored: null });
  const [lookups, setLookups] = useState<Lookups>(EMPTY_LOOKUPS);
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
    const scope = { workspaceId, ...(accountFilter !== '' ? { bankAccountId: accountFilter } : {}), ...(query !== '' ? { query } : {}) };
    const statuses = tab === 'open' ? ['open'] : tab === 'booked' ? ['booked', 'matched'] : ['ignored'];
    void (async () => {
      const pages = await Promise.all(statuses.map((status) => client.call('list_bank_inbox', { ...scope, status, limit: PAGE })));
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
      setInbox({ lines, total: ok.reduce((s, p) => s + p.total, 0), summary: ok[0]?.summary ?? [] });
    })();
    return () => {
      live = false;
    };
  }, [client, workspaceId, accounts, accountFilter, query, tab, reloadNonce]);

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
    ]).then(([chart, tax, items, bills, drafted, dial]) => {
      if (!live) return;
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
          held !== undefined && held.source === 'edited' ? held : (draftFromVorschlag(vorschlaege.get(line.bankTxnId)?.[0]) ?? draftFromProposal(line));
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

  const sureLines = useMemo(() => (tab === 'open' ? lines.filter((l) => isSureAndUntouched(l, drafts[l.bankTxnId]) && !lookups.vorschlaege.has(l.bankTxnId)) : []), [lines, tab, drafts, lookups.vorschlaege]);
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
    bookRefs.current.get(lineId)?.focus();
  });

  // After a decision: the next row takes the focus once it is on screen.
  useEffect(() => {
    const request = focusRequest.current;
    if (request === null) return;
    const row = rowElement(request.lineId);
    if (row === null) return;
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
    (target: DraftTarget) => consequenceSentence('book_bank_line', locale, bookCapability(target)) ?? '',
    [locale],
  );

  const afterDecision = useCallback(
    (line: BankInboxLine) => {
      settle(line.bankTxnId);
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
      // The refusal is the answer to the person's own act: the line's strip shows it, with its fix.
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

  const book = async (line: BankInboxLine, target: DraftTarget, opts: { text?: string } = {}) => {
    if (workspaceId === null) return;
    const input = { bankTxnId: line.bankTxnId, target: bookTargetOf(target), ...(opts.text !== undefined ? { text: opts.text } : {}) };
    setBusyLine(line.bankTxnId);
    const response = await client.call('book_bank_line', { workspaceId, ...input, idempotencyKey: keyFor(line.bankTxnId, ['book_bank_line', input]) });
    setBusyLine(null);
    if (isErr(response.body)) {
      refuse(line.bankTxnId, response.body);
      return;
    }
    const body = response.body as Record<string, unknown>;
    const party = partyOf(t, line);
    const phrase = targetPhrase(t, lookups, line, target);
    const remainder = (body.remainder ?? null) as { kind?: string; amountMinor?: number } | null;
    const remainderText =
      remainder !== null && remainder.kind !== undefined && remainder.kind !== 'none'
        ? t(`bankInbox.ack.remainder.${remainder.kind}`, { amount: formatMoney(remainder.amountMinor ?? 0, line.currency) })
        : '';
    const detailText = [remainderText, warningsText(t, body.warnings)].filter((x) => x !== '').join(' ');
    const detail = detailText === '' ? undefined : detailText;
    say({
      tone: 'success',
      message:
        body.state === 'matched'
          ? entryDateOf(line, target) === null
            ? t('bankInbox.ack.matchedAny', { party })
            : t('bankInbox.ack.matched', { party, date: formatDate(entryDateOf(line, target) as string) })
          : t('bankInbox.ack.booked', { party, target: phrase }),
      ...(detail !== undefined ? { detail } : {}),
      action: { label: t('bankInbox.ack.undo'), run: () => showDecided(line) },
    });
    afterDecision(line);
  };

  const bookAllSure = async () => {
    if (workspaceId === null || sureLines.length === 0) return;
    setBulkBusy(true);
    let done = 0;
    let refused = 0;
    for (const line of sureLines) {
      const target = proposalTarget(line);
      if (target === null) continue;
      const input = { bankTxnId: line.bankTxnId, target: bookTargetOf(target) };
      const response = await client.call('book_bank_line', { workspaceId, ...input, idempotencyKey: keyFor(line.bankTxnId, ['book_bank_line', input]) });
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
    });
  };

  const ignorePicked = async (reason: IgnoreReason) => {
    const { done, refused } = await runPicked(pickedLines, 'ignore_bank_line', () => ({ reason }));
    say({
      tone: refused > 0 ? 'warn' : 'success',
      message: plural(t, 'bankInbox.ack.pickedIgnored', done, { reason: t(`bankInbox.ignore.reason.${reason}.label`) }),
      ...(refused > 0 ? { detail: plural(t, 'bankInbox.ack.pickedRefused', refused) } : {}),
    });
  };

  const simpleWrite = async (line: BankInboxLine, action: string, input: Record<string, unknown>, message: string) => {
    if (workspaceId === null) return false;
    setBusyLine(line.bankTxnId);
    const response = await client.call(action, { workspaceId, bankTxnId: line.bankTxnId, ...input, idempotencyKey: keyFor(line.bankTxnId, [action, input]) });
    setBusyLine(null);
    if (isErr(response.body)) {
      refuse(line.bankTxnId, response.body);
      return false;
    }
    const warned = warningsText(t, (response.body as Record<string, unknown>).warnings);
    say({ tone: 'success', message, ...(warned !== '' ? { detail: warned } : {}) });
    afterDecision(line);
    return true;
  };

  const ignore = (line: BankInboxLine, reason: IgnoreReason, note: string) =>
    void simpleWrite(line, 'ignore_bank_line', { reason, ...(note !== '' ? { note } : {}) }, t('bankInbox.ack.ignored', { party: partyOf(t, line) }));
  const reopen = (line: BankInboxLine, reason: string) =>
    void simpleWrite(
      line,
      'reopen_bank_line',
      { reason },
      t(line.state === 'matched' ? 'bankInbox.ack.unmatched' : line.state === 'ignored' ? 'bankInbox.ack.unignored' : 'bankInbox.ack.reopened', { party: partyOf(t, line) }),
    );

  const approve = async (line: BankInboxLine, v: LineVorschlag) => {
    if (workspaceId === null) return;
    setBusyLine(line.bankTxnId);
    const response = await client.call('approve_drafted_action', { workspaceId, actionId: v.actionId });
    setBusyLine(null);
    if (isErr(response.body)) {
      refuse(line.bankTxnId, response.body);
      reloadOptions();
      return;
    }
    say({ tone: 'success', message: t('bankInbox.ack.approved', { party: partyOf(t, line) }) });
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
    say({ tone: 'info', message: t('bankInbox.ack.rejected', { party: partyOf(t, line) }) });
    ackLine(line.bankTxnId);
    reloadOptions();
  };

  // --- Belege (D142): dropped on a row, or picked from the strip or the overflow --------------------
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
    if (failed.length === 0) say({ tone: 'success', message: done });
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
    say({
      tone: warned !== '' ? 'warn' : added > 0 ? 'success' : 'info',
      message: added > 0 ? plural(t, 'bankInbox.ack.imported', added, { name: account?.name ?? '' }) : t('bankInbox.ack.importedNothing', { name: account?.name ?? '' }),
      ...(bits.length > 0 ? { detail: bits.join(' ') } : {}),
      ...(added > 0 ? { action: { label: t('bankInbox.ack.showNew'), run: () => setOnlyFresh(true) } } : {}),
    });
    setParam('tab', null);
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
  // suggestion lands on its line as "Prüfen" with the AI disclosure, and a person books it or not.
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
            {sureLines.length > 0 && !noStatementAnywhere && (
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
      <section className="bank" aria-labelledby="bank-title">
        {header}
        <PermissionDenied title={t('bankInbox.denied.title')} body={t('bankInbox.denied.body')} />
      </section>
    );
  }
  if (accountsError !== null) {
    return (
      <section className="bank" aria-labelledby="bank-title">
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
      <section className="bank" aria-labelledby="bank-title">
        {header}
        <div className="bank-list panel">
          <BankSkeleton />
        </div>
      </section>
    );
  }
  if (accounts.length === 0) {
    return (
      <section className="bank" aria-labelledby="bank-title">
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
  const colSpan = tab === 'open' ? 7 : 6;

  const askAgent = (line: BankInboxLine) => {
    keyboard?.openPalette(t('bankInbox.agent.question', { date: lineDateLong(line), party: partyOf(t, line), amount: formatMoney(line.amountMinor, line.currency) }));
  };

  const stripFor = (line: BankInboxLine) => (
    <ContextStrip
      workspaceId={workspaceId}
      line={line}
      draft={drafts[line.bankTxnId]}
      lookups={lookups}
      mode={mode}
      caps={{ post: canPost, pay: canPay, decideVorschlag: canDecideVorschlag, attach: receipts.canAttach }}
      whoamiActor={whoami?.actor ?? null}
      busy={busyLine === line.bankTxnId || receipts.busyLine === line.bankTxnId}
      refusal={refusals[line.bankTxnId] ?? null}
      claimedEntryIds={claimedEntryIds}
      colSpan={colSpan}
      onMode={setMode}
      onDraft={(target, source) => setDrafts((d) => ({ ...d, [line.bankTxnId]: { target, source } }))}
      onBook={(target, opts) => {
        setDrafts((d) => ({ ...d, [line.bankTxnId]: { target, source: targetKey(target) === targetKey(proposalTarget(line)) ? 'proposal' : 'edited' } }));
        void book(line, target, opts);
      }}
      onRefusalAction={(action) => onRefusalAction(line, action)}
      onIgnore={(reason, note) => ignore(line, reason, note)}
      onReopen={(reason) => reopen(line, reason)}
      onApprove={(v) => void approve(line, v)}
      onReject={(v, reason) => void reject(line, v, reason)}
      onAgent={() => askAgent(line)}
      onAttach={() => pickReceiptFor(line)}
      onReceiptsChanged={reload}
    />
  );

  const onMenu = (line: BankInboxLine, action: RowMenuAction) => {
    if (action === 'agent') {
      askAgent(line);
      return;
    }
    if (action === 'attach') {
      pickReceiptFor(line);
      return;
    }
    setSelectedId(line.bankTxnId);
    setMode(action);
  };

  const toggle = (line: BankInboxLine) => select(selectedId === line.bankTxnId ? null : line.bankTxnId);

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
      <table className="bank-table" aria-labelledby="bank-list-caption">
        <caption id="bank-list-caption" className="visually-hidden">
          {t(`bankInbox.caption.${tab}`)}
        </caption>
        <colgroup>
          {tab === 'open' && <col className="bank-col--pick" />}
          <col className="bank-col--date" />
          <col className="bank-col--party" />
          <col className="bank-col--target" />
          <col className="bank-col--vat" />
          <col className="bank-col--amount" />
          <col className="bank-col--actions" />
        </colgroup>
        <thead>
          <tr>
            {tab === 'open' && (
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
            <th scope="col">{t('bankInbox.col.date')}</th>
            <th scope="col">{t('bankInbox.col.party')}</th>
            <th scope="col" colSpan={tab === 'open' ? 1 : 2}>
              {t(tab === 'open' ? 'bankInbox.col.target' : 'bankInbox.col.decision')}
            </th>
            {tab === 'open' && <th scope="col">{t('bankInbox.col.vat')}</th>}
            <th scope="col" className="bank-col-head--num">
              {t('bankInbox.col.amount')}
            </th>
            <th scope="col">
              <span className="visually-hidden">{t('bankInbox.col.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {visible.map((line) => {
            const isSel = line.bankTxnId === selectedId;
            const after = isSel ? stripFor(line) : undefined;
            const accountName = accounts.length > 1 && accountFilter === '' ? accounts.find((a) => a.id === line.bankAccountId)?.name : undefined;
            const onDropFiles = receipts.canAttach ? (files: File[]) => void attachTo({ bankTxnId: line.bankTxnId, party: partyOf(t, line) }, files) : null;
            if (line.state === 'open') {
              const draft = drafts[line.bankTxnId];
              return (
                <OpenRow
                  key={line.bankTxnId}
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
                  vorschlag={lookups.vorschlaege.get(line.bankTxnId)?.[0]}
                  canBook={canBookTarget}
                  canPost={canPost}
                  canAttach={receipts.canAttach}
                  consequence={consequenceFor}
                  openPicker={openPicker?.lineId === line.bankTxnId ? openPicker.which : null}
                  onOpenPicker={(which) => setOpenPicker(which === null ? null : { lineId: line.bankTxnId, which })}
                  onPick={(result) => {
                    if (result.kind === 'mode') {
                      setSelectedId(line.bankTxnId);
                      setMode(result.mode);
                      return;
                    }
                    if (result.kind !== 'target') return;
                    setDrafts((d) => ({ ...d, [line.bankTxnId]: { target: result.target, source: result.source } }));
                    // A control-account leg is said BEFORE the commit (critic A39-11): the strip opens.
                    if (result.target.kind === 'accounts' && controlAccountsIn(lookups, result.target.legs).length > 0) select(line.bankTxnId);
                    const leg = result.target.kind === 'accounts' && result.target.legs.length === 1 ? result.target.legs[0] : undefined;
                    const vatShows = leg !== undefined && vatPickerShows(lookups, leg);
                    if (result.chainVat && vatShows) setOpenPicker({ lineId: line.bankTxnId, which: 'vat' });
                    else focusBookFor.current = line.bankTxnId;
                  }}
                  onVat={(code) => {
                    const target = draft?.target;
                    if (target?.kind !== 'accounts' || target.legs.length !== 1 || target.legs[0] === undefined) return;
                    setDrafts((d) => ({ ...d, [line.bankTxnId]: { target: { kind: 'accounts', legs: [{ ...(target.legs[0] as NonNullable<(typeof target.legs)[0]>), taxCode: code }] }, source: 'edited' } }));
                    focusBookFor.current = line.bankTxnId;
                  }}
                  onBook={() => {
                    const target = draft?.target ?? null;
                    if (target !== null) void book(line, target);
                  }}
                  onReview={() => select(line.bankTxnId)}
                  onMenu={(action) => onMenu(line, action)}
                  bookRef={(el) => {
                    bookRefs.current.set(line.bankTxnId, el);
                  }}
                  showPick={sureIds.has(line.bankTxnId) || picked.size > 0}
                  picked={picked.has(line.bankTxnId)}
                  onTogglePick={() => togglePick(line.bankTxnId)}
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
                summary={decidedSummary(t, line)}
                undoLabel={line.state === 'ignored' ? t('bankInbox.decided.unignore') : line.state === 'matched' ? t('bankInbox.decided.unmatch') : t('bankInbox.decided.reopen')}
                canUndo={canPost && busyLine !== line.bankTxnId}
                canAttach={receipts.canAttach}
                onUndo={() => {
                  setSelectedId(line.bankTxnId);
                  setMode('reopen');
                }}
                onAttach={() => pickReceiptFor(line)}
                after={after}
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
      ) : query !== '' || facet !== 'all' || direction !== 'all' || onlyFresh ? (
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

  // The facets with their counts, each hidden when it would change nothing (0, or every line): a filter
  // that changes nothing is noise. A facet that is ON stays, so it can be switched off.
  const total = lines.length;
  const facetChips: { value: Facet; label: string; count: number }[] =
    tab === 'open'
      ? [
          { value: 'needs', label: t('bankInbox.facet.needs'), count: lines.filter(needsYou).length },
          { value: 'sure', label: t('bankInbox.facet.sure'), count: lines.filter(isSure).length },
        ]
      : tab === 'booked'
        ? [{ value: 'noreceipt', label: t('bankInbox.facet.noReceipt'), count: lines.filter((l) => l.needsReceipt).length }]
        : [];
  const shownChips = facetChips.filter((c) => c.value === facet || (c.count > 0 && c.count < total));
  const credits = lines.filter(isCredit).length;
  const bothDirections = direction !== 'all' || (credits > 0 && credits < total);

  return (
    <section className="bank" aria-labelledby="bank-title">
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
            select(null);
          }}
        />
        <div className="bank-toolbar__tools">
          {shownChips.length > 0 && (
            <FilterChips<Facet>
              label={t('bankInbox.facet.label')}
              chips={shownChips}
              selected={facet === 'all' ? [] : [facet]}
              onChange={(next) => setFacet(next.find((v) => v !== facet) ?? 'all')}
            />
          )}
          {bothDirections && (
            <span className="bank-direction" role="group" aria-label={t('bankInbox.direction.label')}>
              {(['in', 'out'] as const).map((d) => (
                <Tooltip key={d} content={t(`bankInbox.direction.${d}`)}>
                  <button
                    type="button"
                    className="btn btn--ghost btn--icon btn--sm bank-direction__toggle"
                    aria-label={t(`bankInbox.direction.${d}`)}
                    aria-pressed={direction === d}
                    onClick={() => setDirection(direction === d ? 'all' : d)}
                  >
                    {d === 'in' ? <InGlyph size={16} /> : <OutGlyph size={16} />}
                  </button>
                </Tooltip>
              ))}
            </span>
          )}
          {accounts.length > 1 && (
            <Select id="bank-account-filter" ariaLabel={t('bankInbox.accounts.label')} value={accountFilter} onChange={(v) => setParam('account', v === '' ? null : v)} options={accountOptions} className="bank-account-filter__select" />
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
      {linkMissing && selectedId === null && (
        <p className="bank-link-missing" role="status">
          {t('bankInbox.panel.linkMissing')}
        </p>
      )}
      <div className="bank-list panel">{listBody}</div>
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
    </section>
  );
}

/** The warnings a write or an import answers with (`control_account_leg`, `batch_payments_kept`, ...), in words. */
const KNOWN_WARNINGS: ReadonlySet<string> = new Set(['control_account_leg', 'accepted_difference', 'reversal_line', 'batch_payments_kept', 'not_day_end_statement', 'statement_number_jump']);
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
