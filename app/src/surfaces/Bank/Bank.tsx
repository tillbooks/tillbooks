/**
 * A2, "Bank" (`/bank`): the bank inbox, the owner-facing half of the bank process, on the A39 engine.
 *
 * ONE INBOX (the bank-process judge's outcome 1). Every line of every imported statement, of every
 * Bankkonto, in one list, newest first; a statement is a fact the line carries, never a screen to open
 * in turn. Three views of the same lines by their ONE state (open; booked or matched; ignored), a
 * search the engine runs (counterparty, text, reference, IBAN, amount) and facets on what the proposal
 * says (needs you, sure, money in, money out).
 *
 * EVERY LINE IS DECIDED ON ITS ROW (outcome 2), credits and debits alike, with the verb the agent
 * would call: `book_bank_line` (to accounts with VAT, to an open invoice or bill, to a payment run, or
 * matched to an entry already on the books), `ignore_bank_line`, and in the Gebucht view
 * `reopen_bank_line` ("Stornieren", "Abgleich lösen", "Wieder zu buchen": every undo, outcome 7).
 * Nothing here is a second path to the books: the GUI and the agent call the same verbs, and a pending
 * agent Vorschlag for a line shows ON the line, in words, with the same consequence sentence (outcome
 * 8). No rules, no receipts, no rebooking into another period (spec §6).
 *
 * THE BALANCE IS THE ARBITER (owner answer 1, outcome 3; spec L4). The balance line over the list
 * reads bank = books + open lines + difference per account and names any difference; an account that
 * cannot be judged says so, with the import that makes it judgeable. One number per question (outcome
 * 10): the tab counts are the engine's totals per state, the balance line is the engine's summary,
 * nothing is recounted here.
 *
 * FIRST RUN LEADS (outcome 9): no Bankkonto says so and links to create one; no statement makes the
 * import the primary action with a drop zone; an import confirms with its new lines, highlighted.
 *
 * Capability gates (A24) pre-disable what the role cannot do, with the reason on the control; the
 * engine's refusal remains the real gate and renders with its cause and fix (outcome 5).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useKeyboardOptional } from '../../app/keyboard';
import { CAP, useCan, useCapabilities } from '../../lib/capabilities';
import { useT, formatDate, formatMoney } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import { channelRefusal, jumpsOfSync, numberJumpText, type NumberJump } from '../BankAccounts/channelWording';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { Tabs } from '../../components/Tabs';
import { Segmented } from '../../components/Segmented';
import { Select } from '../../components/Select';
import { OverflowMenu } from '../../components/OverflowMenu';
import { ActionFeedback } from '../../components/ActionFeedback';
import { FileDrop } from '../../components/FileDrop';
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
  rowCertainty,
  targetKey,
} from './model';
import { EMPTY_LOOKUPS, buildLookups, entryDateOf, lineDateLong, partyOf, plural, targetPhrase, type Lookups } from './lookups';
import { DecidedRow, OpenRow, type RowMenuAction } from './InboxRow';
import { LinePanel, type PanelMode } from './LinePanel';
import { TrustLine } from './TrustLine';
import { ImportDialog, type ImportResult } from './ImportDialog';
import { PickBar } from './PickBar';
import type { RefusalAction } from './errors';
import { SearchGlyph } from './glyphs';
import './Bank.css';

type Tab = 'open' | 'booked' | 'ignored';

/** The tab a line's state lives in. */
function tabOf(state: BankInboxLine['state']): Tab {
  return state === 'open' ? 'open' : state === 'ignored' ? 'ignored' : 'booked';
}
type Facet = 'all' | 'needs' | 'sure' | 'in' | 'out';

const PAGE = 200;
/** Below this width of the inbox body the panel moves under the selected row. */
const SIDE_PANEL_MIN = 1360;

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

export function Bank() {
  const t = useT();
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
  const [facet, setFacet] = useState<Facet>('all');
  const [selectedId, setSelectedId] = useState<string | null>(params.get('line'));
  // A deep link (`?line=`, the Journal drawer's "Bankzeile zeigen", a refusal's "Diese Zeile zeigen")
  // names ONE line, which may sit beyond the loaded page. It is read by its id and selected; a line this
  // book does not hold says so. Never a substitute (critic M4 lean).
  const [linkTarget, setLinkTarget] = useState<string | null>(params.get('line'));
  const [pinned, setPinned] = useState<BankInboxLine | null>(null);
  const [linkMissing, setLinkMissing] = useState(false);
  const [mode, setMode] = useState<PanelMode>('details');
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
  /** The account a trust line's own import names; null falls back to the account filter. */
  const [importAccount, setImportAccount] = useState<string | null>(null);
  /** The statement the last import added: its lines carry the landing tint once. */
  const [freshStatement, setFreshStatement] = useState<string | null>(null);
  const [onlyFresh, setOnlyFresh] = useState(false);
  const bookRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const focusBookFor = useRef<string | null>(null);
  const ackSeq = useRef(0);

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

  // The engine search runs on the typed words a moment after typing stops.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryText.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [queryText]);

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

  // A36 §5: "Kontoauszüge abrufen" and "Zuletzt abgerufen". The EBICS channels come from
  // `bank_channel_status`; the button appears only when one is active (D-A36.10: on demand only, one
  // fresh idempotency key per press). A failed read hides the button, it never blocks the inbox.
  const [feedChannels, setFeedChannels] = useState<{ connectionId: string; state: string; lastSyncAt: string | null }[]>([]);
  const [fetchBusy, setFetchBusy] = useState(false);
  const [fetchError, setFetchError] = useState<Err | null>(null);
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
      setSelectedId(linkTarget);
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
        setSelectedId(null);
        return;
      }
      setLinkMissing(false);
      setPinned(found);
      setSelectedId(found.bankTxnId);
      setMode('details');
      const want = tabOf(found.state);
      if (want !== tab) setParam('tab', want === 'open' ? null : want);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkTarget, inbox, workspaceId, client]);
  const visible = useMemo(() => {
    return lines.filter((line) => {
      if (onlyFresh && line.statementId !== freshStatement) return false;
      if (tab !== 'open') return true;
      const draft = drafts[line.bankTxnId];
      const certainty = rowCertainty(line, draft);
      switch (facet) {
        case 'needs':
          return !(isUntouched(line, draft) && (certainty === 'sure' || certainty === 'learned')) || lookups.vorschlaege.has(line.bankTxnId);
        case 'sure':
          return isSureAndUntouched(line, draft);
        case 'in':
          return isCredit(line);
        case 'out':
          return !isCredit(line);
        default:
          return true;
      }
    });
  }, [lines, tab, facet, drafts, lookups.vorschlaege, onlyFresh, freshStatement]);

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
  const selected = lines.find((l) => l.bankTxnId === selectedId) ?? null;
  const currencies = new Set(lines.map((l) => l.currency));
  const showCurrency = currencies.size > 1;
  const summary = inbox?.summary ?? [];
  const noStatementAnywhere = summary.length > 0 && summary.every((s) => s.statementId === null) && (counts.open ?? 0) + (counts.booked ?? 0) + (counts.ignored ?? 0) === 0;
  const claimedEntryIds = useMemo(() => new Set(lines.flatMap((l) => (l.decision?.entryId != null ? [l.decision.entryId] : []))), [lines]);

  // Keep a line selected: the deep-linked one, the credit an old link names, else the first visible. A
  // deep link still resolving, or one that named a line this book does not hold, selects nothing else.
  useEffect(() => {
    if (inbox === null || linkTarget !== null || linkMissing) return;
    const credit = params.get('credit');
    if (credit !== null) {
      const hit = lines.find((l) => l.creditId === credit);
      setParam('credit', null);
      if (hit !== undefined) {
        setSelectedId(hit.bankTxnId);
        return;
      }
      setLinkMissing(true);
      setSelectedId(null);
      return;
    }
    if (selectedId !== null && visible.some((l) => l.bankTxnId === selectedId)) return;
    setSelectedId(visible[0]?.bankTxnId ?? null);
    setMode('details');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inbox, visible, linkTarget, linkMissing]);

  // After an account pick hands over to the VAT pick, and the VAT pick to Buchen, focus lands there.
  useEffect(() => {
    const lineId = focusBookFor.current;
    if (lineId === null || openPicker !== null) return;
    focusBookFor.current = null;
    bookRefs.current.get(lineId)?.focus();
  });

  // The layout: the panel beside the list when there is room, under the selected row when not.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [wide, setWide] = useState(true);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => setWide(el.getBoundingClientRect().width >= SIDE_PANEL_MIN);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [accounts, inbox === null]);

  // --- writes -------------------------------------------------------------------------------------
  const canBookTarget = useCallback((target: DraftTarget) => (bookCapability(target) === 'pay' ? canPay && canPost : canPost), [canPay, canPost]);

  const afterDecision = useCallback(
    (line: BankInboxLine) => {
      settle(line.bankTxnId);
      setRefusals((r) => {
        const { [line.bankTxnId]: _gone, ...rest } = r;
        return rest;
      });
      // The next line to decide is the one after this one in the current view.
      const index = visible.findIndex((l) => l.bankTxnId === line.bankTxnId);
      const next = visible[index + 1] ?? visible[index - 1] ?? null;
      setSelectedId(next?.bankTxnId ?? null);
      setMode('details');
      reload();
      reloadOptions();
    },
    [settle, visible, reload, reloadOptions],
  );

  const refuse = useCallback((lineId: string, error: Err) => {
    setRefusals((r) => ({ ...r, [lineId]: error }));
    setSelectedId(lineId);
  }, []);

  const book = useCallback(
    async (line: BankInboxLine, target: DraftTarget, opts: { text?: string } = {}) => {
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
    },
    // showDecided is a stable closure over setters declared below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, workspaceId, keyFor, refuse, t, lookups, say, afterDecision],
  );

  const showDecided = (line: BankInboxLine) => {
    setParam('tab', 'booked');
    setSelectedId(line.bankTxnId);
    setMode('reopen');
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

  const runPicked = async (lines: readonly BankInboxLine[], action: 'book_bank_line' | 'ignore_bank_line', inputFor: (line: BankInboxLine) => Record<string, unknown> | null) => {
    if (workspaceId === null || lines.length === 0) return { done: 0, refused: 0 };
    setBulkBusy(true);
    let done = 0;
    let refused = 0;
    for (const line of lines) {
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
    reloadOptions();
  };

  const onRefusalAction = (line: BankInboxLine, action: RefusalAction) => {
    const draft = drafts[line.bankTxnId];
    switch (action.kind) {
      case 'ignore':
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
    if (workspaceId === null) return;
    setFetchBusy(true);
    setFetchError(null);
    let imported = 0;
    let waiting = 0;
    const jumps: NumberJump[] = [];
    for (const channel of activeFeeds) {
      const { body } = await client.call('bank_sync', {
        workspaceId,
        connectionId: channel.connectionId,
        idempotencyKey: `a36-press-${channel.connectionId}-${Date.now()}`,
      });
      if (isErr(body)) {
        setFetchError(body);
        continue;
      }
      const statements = ((body as Record<string, unknown>).statements as { final?: boolean; outcome?: string; notice?: unknown; jump?: unknown }[] | undefined) ?? [];
      imported += statements.filter((x) => x.outcome === 'imported').length;
      waiting += statements.filter((x) => x.final !== true).length;
      jumps.push(...jumpsOfSync(statements));
    }
    setFetchBusy(false);
    say({
      tone: waiting > 0 || jumps.length > 0 ? 'warn' : 'success',
      message: imported === 0 && waiting === 0 ? t('bankInbox.header.fetchedNothing') : t('bankInbox.header.fetched', { imported, waiting }),
      ...(jumps.length > 0 ? { detail: jumps.map((j) => numberJumpText(t, j)).join(' ') } : {}),
    });
    reload();
    reloadOptions();
    void loadFeed();
  };

  // --- states -------------------------------------------------------------------------------------
  const header = (
    <SurfaceHeader
      title={t('bankInbox.title')}
      titleId="bank-title"
      subtitle={accounts !== null && accounts.length === 1 && accounts[0] !== undefined ? `${accounts[0].name} · ${accounts[0].currency}` : accounts !== null && accounts.length > 1 ? t('bankInbox.subtitleMany', { count: accounts.length }) : undefined}
      help={<SurfaceHelp surface="Bank" />}
      actions={
        accounts !== null && accounts.length > 0 ? (
          <>
            <OverflowMenu label={t('bankInbox.header.more')} items={[{ key: 'accounts', label: t('bankInbox.header.bankAccounts'), onSelect: () => navigate('/bank-accounts') }]} />
            {lastFetched !== undefined && (
              <span className="bank-last-fetched" title={lastFetched}>
                {t('bankInbox.header.lastFetched', { date: formatDate(lastFetched) })}
              </span>
            )}
            {activeFeeds.length > 0 && (
              <button type="button" className="btn btn--secondary bank-touch" disabled={!canPay || fetchBusy} onClick={() => void fetchStatements()}>
                {fetchBusy ? t('bankInbox.header.fetching') : t('bankInbox.header.fetchStatements')}
              </button>
            )}
            <button
              type="button"
              className={`btn ${noStatementAnywhere ? 'btn--primary' : 'btn--secondary'} bank-touch`}
              disabled={!canPay}
              onClick={() => {
                setImportFile(null);
                setImportOpen(true);
              }}
            >
              {t('bankInbox.import.open')}
            </button>
            {sureLines.length > 0 && !noStatementAnywhere && (
              <button type="button" className="btn btn--primary bank-touch" disabled={bulkBusy || !canPost || !canPay} onClick={() => void bookAllSure()}>
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
        <div role="status" aria-busy="true" aria-live="polite">
          <span className="visually-hidden">{t('bankInbox.loading')}</span>
          <Skeleton rows={8} height={36} />
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

  const panelFor = (line: BankInboxLine) => (
    <LinePanel
      workspaceId={workspaceId}
      line={line}
      draft={drafts[line.bankTxnId]}
      lookups={lookups}
      mode={mode}
      caps={{ post: canPost, pay: canPay, decideVorschlag: canDecideVorschlag }}
      whoamiActor={whoami?.actor ?? null}
      busy={busyLine === line.bankTxnId}
      refusal={refusals[line.bankTxnId] ?? null}
      claimedEntryIds={claimedEntryIds}
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
    />
  );

  const onMenu = (line: BankInboxLine, action: RowMenuAction) => {
    setSelectedId(line.bankTxnId);
    if (action === 'agent') {
      keyboard?.openPalette(t('bankInbox.agent.question', { date: lineDateLong(line), party: partyOf(t, line), amount: formatMoney(line.amountMinor, line.currency) }));
      return;
    }
    setMode(action);
  };

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
            const after =
              !wide && isSel ? (
                <tr className="bank-inline-panel">
                  <td colSpan={tab === 'open' ? 7 : 6}>
                    <div className="bank-panel bank-panel--inline">{panelFor(line)}</div>
                  </td>
                </tr>
              ) : undefined;
            if (line.state === 'open') {
              const draft = drafts[line.bankTxnId];
              return (
                <OpenRow
                  key={line.bankTxnId}
                  line={line}
                  draft={draft}
                  lookups={lookups}
                  selected={isSel}
                  fresh={freshStatement !== null && line.statementId === freshStatement}
                  busy={busyLine === line.bankTxnId || bulkBusy}
                  showCurrency={showCurrency}
                  vorschlag={lookups.vorschlaege.get(line.bankTxnId)?.[0]}
                  canBook={canBookTarget}
                  canPost={canPost}
                  openPicker={openPicker?.lineId === line.bankTxnId ? openPicker.which : null}
                  onOpenPicker={(which) => setOpenPicker(which === null ? null : { lineId: line.bankTxnId, which })}
                  onSelect={() => {
                    if (selectedId !== line.bankTxnId) {
                      setSelectedId(line.bankTxnId);
                      setMode('details');
                    }
                  }}
                  onPick={(result) => {
                    setSelectedId(line.bankTxnId);
                    if (result.kind === 'mode') {
                      setMode(result.mode);
                      return;
                    }
                    if (result.kind !== 'target') return;
                    setMode('details');
                    setDrafts((d) => ({ ...d, [line.bankTxnId]: { target: result.target, source: result.source } }));
                    if (result.chainVat) setOpenPicker({ lineId: line.bankTxnId, which: 'vat' });
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
                  onReview={() => {
                    setSelectedId(line.bankTxnId);
                    setMode('details');
                  }}
                  onMenu={(action) => onMenu(line, action)}
                  bookRef={(el) => {
                    bookRefs.current.set(line.bankTxnId, el);
                  }}
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
                lookups={lookups}
                selected={isSel}
                showCurrency={showCurrency}
                summary={decidedSummary(t, line)}
                actionLabel={line.state === 'ignored' ? t('bankInbox.decided.unignore') : line.state === 'matched' ? t('bankInbox.decided.unmatch') : t('bankInbox.decided.reopen')}
                actionDisabled={busyLine === line.bankTxnId || !canPost}
                onAction={() => {
                  setSelectedId(line.bankTxnId);
                  setMode('reopen');
                }}
                onSelect={() => {
                  if (selectedId !== line.bankTxnId) {
                    setSelectedId(line.bankTxnId);
                    setMode('details');
                  }
                }}
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
      <div role="status" aria-busy="true" aria-live="polite">
        <span className="visually-hidden">{t('bankInbox.loading')}</span>
        <Skeleton rows={8} height={36} />
      </div>
    ) : visible.length === 0 ? (
      noStatementAnywhere ? (
        <div className="bank-first">
          <EmptyState
            title={t('bankInbox.first.noStatementTitle')}
            hint={t('bankInbox.first.noStatementHint')}
            action={{
              label: t('bankInbox.import.open'),
              onClick: () => {
                setImportFile(null);
                setImportOpen(true);
              },
            }}
          />
          <FileDrop
            accept=".xml,text/xml,application/xml"
            label={t('bankInbox.import.choose')}
            prompt={t('bankInbox.import.drop')}
            hint={t('bankInbox.import.hint')}
            disabled={!canPay}
            onFiles={(files) => {
              setImportFile(files[0] ?? null);
              setImportOpen(true);
            }}
          />
        </div>
      ) : query !== '' || facet !== 'all' || onlyFresh ? (
        <EmptyState
          filtered={{
            onClear: () => {
              setQueryText('');
              setQuery('');
              setFacet('all');
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

  return (
    <section className="bank" aria-labelledby="bank-title">
      {header}
      {fetchError !== null && (
        <ErrorBanner
          error={fetchError}
          message={channelRefusal(t, fetchError)}
        />
      )}
      {trustBalances.length > 0 && (
        <div className="bank-trusts">
          {trustBalances.map((b) => (
            <TrustLine
              key={b.bankAccountId}
              balance={b}
              named={accounts.length > 1}
              canImport={canPay}
              onShowOpen={() => {
                setParam('tab', null);
                setParam('account', accounts.length > 1 ? b.bankAccountId : null);
              }}
              onImport={() => {
                setImportFile(null);
                setImportAccount(b.bankAccountId);
                setImportOpen(true);
              }}
            />
          ))}
        </div>
      )}
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
            setParam('tab', id === 'open' ? null : id);
            setOnlyFresh(false);
            setLinkMissing(false);
            setMode('details');
          }}
        />
        <div className="bank-toolbar__row">
          <label className="bank-search bank-search--main" htmlFor="bank-query">
            <SearchGlyph size={16} className="bank-search__glyph" />
            <span className="bank-search__label">{t('bankInbox.search.label')}</span>
            <input id="bank-query" type="search" className="bank-search__input" placeholder={t('bankInbox.search.placeholder')} value={queryText} onChange={(e) => setQueryText(e.target.value)} />
          </label>
          {tab === 'open' && (
            <Segmented<Facet>
              label={t('bankInbox.facet.label')}
              value={facet}
              onChange={setFacet}
              options={[
                { value: 'all', label: t('bankInbox.facet.all') },
                { value: 'needs', label: t('bankInbox.facet.needs') },
                { value: 'sure', label: t('bankInbox.facet.sure') },
                { value: 'in', label: t('bankInbox.facet.in') },
                { value: 'out', label: t('bankInbox.facet.out') },
              ]}
            />
          )}
          {accounts.length > 1 && (
            <label className="bank-account-filter" htmlFor="bank-account-filter">
              <span className="bank-search__label">{t('bankInbox.accounts.label')}</span>
              <Select id="bank-account-filter" ariaLabel={t('bankInbox.accounts.label')} value={accountFilter} onChange={(v) => setParam('account', v === '' ? null : v)} options={accountOptions} className="bank-account-filter__select" />
            </label>
          )}
          {onlyFresh && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOnlyFresh(false)}>
              {t('bankInbox.fresh.showAll')}
            </button>
          )}
        </div>
      </div>
      {linkMissing && selectedId === null && (
        <p className="bank-link-missing" role="status">
          {t('bankInbox.panel.linkMissing')}
        </p>
      )}
      <div className={`bank-body${wide ? ' bank-body--wide' : ''}`} ref={bodyRef}>
        <div className="bank-list panel">{listBody}</div>
        {wide && (
          <aside className="bank-panel panel" aria-label={selected === null ? t('bankInbox.panel.emptyLabel') : t('bankInbox.panel.label', { party: partyOf(t, selected) })}>
            {selected === null ? <p className="bank-panel__empty">{t('bankInbox.panel.empty')}</p> : panelFor(selected)}
          </aside>
        )}
      </div>
      <ImportDialog
        open={importOpen}
        workspaceId={workspaceId}
        accounts={accounts}
        initialFile={importFile}
        preferredAccountId={importAccount ?? (accountFilter !== '' ? accountFilter : null)}
        onClose={() => {
          setImportOpen(false);
          setImportFile(null);
          setImportAccount(null);
        }}
        onImported={onImported}
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
