/**
 * EntryDrawer: compose, post, draft, view, and reverse a double-entry journal entry (A02 §6).
 *
 * The one drawer serves three modes: `create` (blank compose), `edit` (a mutable draft), and `view`
 * (a posted, immutable entry that offers ONLY Reverse, never an edit or delete). Balance is validated
 * client-side (debits must equal credits) before Post is enabled, and the engine re-checks it, so an
 * engine rejection is surfaced inline rather than thrown. Every write carries a fresh idempotency key
 * (SH-IDEMPOTENT). Amounts are integer minor units (Rappen) throughout; money renders via formatMoney.
 *
 * THE COMPOSER IS "A1 BUCHUNGSSATZ" (owner pick, 01.10.2026; A02 §6). It reads the way a booking is said:
 * Datum, Text and the Beleg paperclip, then ONE row, `Soll [Konto] an Haben [Konto] | Betrag | MWST`, with
 * a gross Betrag and an MWST control pre-filled from the account. Under it, "+ Kostenstelle",
 * "+ Referenz", "Aufteilen" and one quiet line naming the derived VAT leg. "Aufteilen" opens the line grid
 * (`Konto | MWST | Soll | Haben | ⋯`, heads on the same grid) with everything typed carried over; the last
 * line balances itself. One line on a VAT account turns derivation off for the whole entry: the manual
 * path, the pre-A1 composer.
 *
 * THE DRAWER DOES NO VAT MATH (D152 amendment, owner 02.10.2026). It sends what is on screen as intent to
 * `compose_entry` (`composerRequest`), keyed by the request's signature, and only the answer for the CURRENT
 * signature counts: its lines are what "Buchen" and "Entwurf speichern" send, verbatim; its captions are the
 * line under each taxed line; its verdict is the engine's own and enables Buchen. A stored entry reopens
 * through `compose_entry` `decompose` (`reopenState`): as a satz or the derived grid when the engine says it
 * round-trips, else verbatim on the manual path, where the gate decides; a refusal shows in place, and the
 * person edits the lines (D152 amendment, orchestrator 02.10.2026: no recompute action).
 *
 * THE C4 SENTENCE sits in the real tooltip of an (i) beside Buchen, and Buchen is described by the same
 * words (the owner's order; D152 amends the D118 C4 rendering for this surface).
 *
 * ESCAPE CLOSES THE INNERMOST LAYER (K-29). The shared focus trap leaves Escape to an open account
 * list or picker, so one Escape closes that list and nothing else. A composer holding typed input
 * asks before it is thrown away, whether the ask came from Escape, the close X, a scrim click or
 * "Abbrechen": the lines a person typed are never lost to a single key.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err, type Result } from '../../lib/client';
import { CAP, editCapabilityForKind, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatMoney, formatDate } from '../../i18n';
import { Skeleton, ErrorBanner } from '../../components/states';
import { OverflowMenu, type OverflowMenuItem } from '../../components/OverflowMenu';
import { AccountCombobox } from '../../components/AccountCombobox';
import { DetailDrawer } from '../../components/DetailDrawer';
import { Select } from '../../components/Select';
import { Tooltip } from '../../components/Tooltip';
import { Provenance, type ProvenanceOrigin } from '../../components/Provenance';
import { ConsequenceLine } from '../../components/ConsequenceLine';
import { Modal } from '../../components/Modal';
import type { Account, CostCenter, DrawerMode, EntryLine, JournalEntry, TaxCode } from './types';
import { newIdempotencyKey, fxDisclosureOf } from './money';
import { LinkedFiles } from '../Files/LinkedFiles';
import { readFileAsUpload } from '../Files/model';
import { bankLedgerIdsOf, isVatAccount, markBankLedgers, satzSubject, type Decomposed } from './composerPayload';
import {
  BLANK_SATZ,
  autoBalance,
  blankGridLine,
  composerRequest,
  defaultCodeFor,
  editGridLine,
  effectiveLines,
  gridIsManual,
  gridShowsTax,
  minorToDecimal,
  reopenState,
  satzToGrid,
  withSatzAccount,
  withTaxCode,
  type GridLine,
  type SatzState,
} from './composerModel';
import type { ComposeCaption, ComposeExpandOk } from '../../../../src/core/ledger/compose';
import { BalanceStatus, BelegControl, MwstControl, VatCaption, type PendingBeleg } from './ComposerParts';
import { PlusGlyph, SplitGlyph } from './glyphs';
import '../Vat/Vat.css';
import './Journal.css';

export interface EntryDrawerProps {
  mode: DrawerMode;
  /** The entry to load in `edit`/`view` mode. Omitted in `create`. */
  entryId?: string;
  /** Whether the actor holds the A24 `post` capability. False pre-disables every write control. */
  canPost: boolean;
  onClose: () => void;
  /**
   * Called after a successful write so the list refetches. Carries the written entry's id when the
   * engine answered with one (`post_entry` and the draft save do), so the list can land THAT row
   * with the Commit moment (D122 D-I); a reversal answers with `reversalId` and passes nothing.
   */
  onWritten: (entryId?: string) => void;
}

/** The two faces of the composer: the Buchungssatz, and the line grid "Aufteilen" opens. */
type ComposerFace = 'satz' | 'grid';

/** A post or draft that succeeded while linking its Beleg did not: the entry stands, the link is retried. */
interface LinkFailure {
  entryId: string;
  fileId: string;
  linkKey: string;
  error: Err;
  /** Which write stood: the banner names it. */
  wrote: 'post' | 'draft';
}

/**
 * The alertdialog role travels to the shared Modal as a prop, never as a literal attribute on the
 * component, so the modal-role guard reads a bare `<Modal>` and the role lands on the div Modal owns.
 */
const ALERT_DIALOG = 'alertdialog' as const;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * F-10 J8.6 residual, the way OUT of a period-lock refusal. The engine reports the locked `period`
 * as either a month (`YYYY-MM`) or a fiscal-year label (`YYYY`); the nearest open date is the first
 * day PAST that lock. A month lock advances to the first of the next month, a year lock to the first
 * of the next year. If several consecutive periods are sealed the re-posted entry refuses again with
 * the next period, so the suggestion advances rather than posting into a still-locked month.
 */
function nextOpenDateAfter(period: string): string {
  const monthLock = /^(\d{4})-(\d{2})$/.exec(period);
  if (monthLock !== null) {
    let year = Number(monthLock[1]);
    let month = Number(monthLock[2]) + 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    return `${year}-${String(month).padStart(2, '0')}-01`;
  }
  const yearLock = /^(\d{4})$/.exec(period);
  if (yearLock !== null) return `${Number(yearLock[1]) + 1}-01-01`;
  return todayIso();
}

/**
 * C3: map a posted entry's `source` (the read model's own field) to a provenance origin. An agent or
 * an imported row is named as such; everything else is a human posting, whose seat the read carries
 * in `createdBy`. Nothing here is invented: origin comes from `source`, actor from `createdBy` and the
 * time from `createdAt`, all off `get_entry`, and the line is skipped entirely when there is no time.
 */
function provenanceOrigin(source: string): ProvenanceOrigin {
  if (source === 'agent') return 'agent';
  if (source === 'import') return 'import';
  return 'human';
}

/** Where an owned entry is undone, and in which words (A39 §6, lean critic C11 and L4). */
interface OwnedByWording {
  messageKey: string;
  href: string;
  linkKey: string;
}

/** The owner verbs whose undo lives on one surface, and that surface. */
const OWNER_SURFACE: Readonly<Record<string, string>> = {
  reverse_payment: '/payments',
  vat_settlement_reverse: '/mwst',
  accrual_reverse: '/periods',
  provision_reverse: '/periods',
  provision_release_reverse: '/periods',
  fx_revaluation_reverse: '/fx',
  void_vendor_bill: '/bills',
  transition_document: '/documents',
  asset_depreciation_run_reverse: '/assets',
  inventory_valuation_reverse: '/inventory-valuation-runs',
};

/**
 * An `owned_by` refusal in the owner's words: a live bank line links to that line; a camt entry already
 * reversed (or its Storno) has no live line, so it says so and links to the inbox; every other owner verb
 * names its surface. Null for anything else, which the shared banner words.
 */
function ownedByWording(error: { error: string; [key: string]: unknown }): OwnedByWording | null {
  if (error.error !== 'owned_by' || typeof error.verb !== 'string') return null;
  if (error.verb === 'reopen_bank_line') {
    return typeof error.bankTxnId === 'string'
      ? { messageKey: 'entry.ownedBy.reopen_bank_line', href: `/bank?tab=booked&line=${encodeURIComponent(error.bankTxnId)}`, linkKey: 'entry.ownedByShowLine' }
      : { messageKey: 'entry.ownedBy.reopen_bank_line_done', href: '/bank', linkKey: 'entry.ownedByGoTo.bank' };
  }
  const surface = OWNER_SURFACE[error.verb];
  if (surface === undefined) return null;
  return { messageKey: `entry.ownedBy.${error.verb}`, href: surface, linkKey: `entry.ownedByGoTo.${surface.slice(1)}` };
}

/**
 * A stored line as `get_entry` sent it, in the `post_entry` shape with its absent fields left out: the
 * fallback when `decompose` cannot be read, so the line still goes back exactly as it was stored.
 */
function storedLine(l: EntryLine): Decomposed['lines'][number] {
  const out: Decomposed['lines'][number] = { account: l.account };
  if (typeof l.debit === 'number' && l.debit > 0) out.debit = l.debit;
  if (typeof l.credit === 'number' && l.credit > 0) out.credit = l.credit;
  if (typeof l.costCenter === 'string' && l.costCenter !== '') out.costCenter = l.costCenter;
  if (typeof l.taxCode === 'string' && l.taxCode !== '') out.taxCode = l.taxCode;
  if (typeof l.taxBase === 'number') out.taxBase = l.taxBase;
  if (typeof l.taxAmount === 'number') out.taxAmount = l.taxAmount;
  if (typeof l.supplyDate === 'string') out.supplyDate = l.supplyDate;
  return out;
}

/**
 * Whether the engine's expansion of a line books something on the line's own account, so a cost centre has
 * a line to ride (critic C2). True while nothing says otherwise (an untaxed line, an answer in flight).
 */
function keepsOwnAccount(caption: ComposeCaption | null | undefined): boolean {
  if (caption === null || caption === undefined) return true;
  return caption.ok ? caption.keepsOwnAccount : caption.error !== 'cost_center_unplaced';
}

/** How long the composer waits after the last keystroke before it asks `compose_entry` again. */
const COMPOSE_DEBOUNCE_MS = 120;

/** The engine's answer to one `compose_entry` request, with the signature of the request it answered. */
interface ComposeAnswer {
  signature: string;
  /** The UI key of each request line, so a caption finds its row. */
  keys: readonly string[];
  body: ExpandAnswer | Err;
}

/** A successful `compose_entry` `expand` answer as it arrives on the wire. */
type ExpandAnswer = ComposeExpandOk & { readonly ok: true };

/**
 * The verdict refusals that say something the person can act on, shown in place. An entry that is simply
 * not finished yet (unbalanced, a line without an amount) is not refused at the person: the balance status
 * and the held Buchen already say it, and a banner on every keystroke would be noise.
 */
const QUIET_VERDICTS: ReadonlySet<string> = new Set(['unbalanced', 'invalid_line']);

/** The verdicts a control already names in place (the code on its MWST control, the chart note, C2). */
const INLINE_VERDICTS: ReadonlySet<string> = new Set([
  'unknown_tax_code',
  'archived_tax_code',
  'needs_vat_config',
  'vat_account_missing',
  'cost_center_unplaced',
]);

export function EntryDrawer({ mode, entryId, canPost, onClose, onWritten }: EntryDrawerProps) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();
  const consequenceId = useId();

  const editable = mode === 'create' || mode === 'edit';

  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [taxCodes, setTaxCodes] = useState<TaxCode[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  // A11-G2: the currency the BOOKS are kept in, from the company profile, exactly as DocumentEditor
  // reads it. The drawer composes an entry with no currency of its own, so `postEntry` resolves
  // `baseCurrencyOf(ctx)` and every figure previewed here is a base-currency figure. That is not a
  // synonym for CHF: a workspace's base currency is a setting. The initial value is the overwhelmingly
  // common one and is replaced by the engine's answer, never trusted over it. It names the composed
  // figures (the VAT caption, the grid's difference, the `vat_trace_unreconciled` refusal) and is the
  // fallback for the base half of the FX disclosure, which `get_entry` now labels per line. It never
  // names a posted `debit`/`credit`: those are TRANSACTION amounts and carry their own currency.
  const [baseCurrency, setBaseCurrency] = useState('CHF');
  const [entry, setEntry] = useState<JournalEntry | null>(null);
  // C3 / F-08 (J5.4): the A35 session this posting came from, when the trace holds one. Resolved by
  // `list_agent_sessions { entityRef }` on view, so the provenance line can link INTO the conversation
  // in one click. Null when the trace holds nothing (a human posting) or the read fails.
  const [traceSessionId, setTraceSessionId] = useState<string | null>(null);
  const [viewLines, setViewLines] = useState<EntryLine[]>([]);
  const [loadErr, setLoadErr] = useState<Err | null>(null);
  const [loading, setLoading] = useState(true);

  const [date, setDate] = useState(todayIso());
  // F-10 J8.6: the date input, so the period-lock "way out" can move the entered date to the nearest
  // open period and land focus there without discarding the composed lines.
  const dateInputRef = useRef<HTMLInputElement>(null);
  const [ref, setRef] = useState('');
  const [refOpen, setRefOpen] = useState(false);
  const refInputRef = useRef<HTMLInputElement>(null);
  const [description, setDescription] = useState('');

  const [face, setFace] = useState<ComposerFace>('satz');
  // A stored entry the engine could not decompose into intent that reproduces it (`roundTrips` false) opens
  // on the manual path with its lines VERBATIM, and the whole entry stays there: nothing is re-derived, and
  // the engine's gate decides (critic C4).
  const [manualLock, setManualLock] = useState(false);
  const [satz, setSatz] = useState<SatzState>(BLANK_SATZ);
  const [lines, setLines] = useState<GridLine[]>(() => [blankGridLine(), blankGridLine()]);
  const addLineRef = useRef<HTMLButtonElement>(null);
  const costCenterRef = useRef<HTMLDivElement>(null);
  const [focusCostCenter, setFocusCostCenter] = useState(false);
  const [focusRefField, setFocusRefField] = useState(false);

  // The Beleg picked for a NEW entry: filed on pick, linked once the write answers with an id.
  const [beleg, setBeleg] = useState<PendingBeleg | null>(null);
  // The Beleg AS IT STANDS when a write answers: a chip removed while the post was in flight must not be
  // linked by a closure that still holds the earlier one (critic, the orphan gap).
  const belegRef = useRef<PendingBeleg | null>(null);
  belegRef.current = beleg;
  const [belegErr, setBelegErr] = useState<Err | null>(null);
  const [linkFailure, setLinkFailure] = useState<LinkFailure | null>(null);

  const [writeErr, setWriteErr] = useState<Err | null>(null);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  // The engine's newest `compose_entry` answer, with the signature of the request it answered. It is read
  // ONLY while that signature is the current request's (critic C3, B3): an answer composed for another
  // date, code, amount or line is not this entry's, whatever arrived last, and Buchen holds until the
  // answer for what is on screen is in.
  const [answer, setAnswer] = useState<ComposeAnswer | null>(null);
  // Reversal posts real money into the books, so it is never one click away.
  const [confirmReverse, setConfirmReverse] = useState(false);
  // Deleting a draft is irreversible, so it too opens a confirm.
  const [confirmDelete, setConfirmDelete] = useState(false);
  // K-29: closing a composer that holds typed input asks first.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const initialSnapshot = useRef<string | null>(null);
  // §H-IDEMPOTENT across a LOST answer (critic C7, K3): one key per composed CONTENT, per verb, for the
  // life of the drawer. A retry of any content already sent replays the write the engine may have
  // committed instead of booking it twice, even after other content was tried in between (A lost, B
  // lost, back to A: A reuses A's key). Different content always gets a different key, so the engine
  // never replays one content's write for another. A content's key is dropped only when ITS write
  // succeeds; a refusal is never memoised by the engine, so reusing its key after a refusal is safe.
  const postIntents = useRef(new Map<string, string>());
  const draftIntents = useRef(new Map<string, string>());

  // A Beleg is upload THEN link (D62 / F8), so attaching costs `manage_files` AND the journal entry's own
  // edit right, derived from the kind by the engine's own map, exactly the LinkedFiles gate. Fail-open
  // while `whoami` is unanswered; the engine is the enforcement.
  const canAttach = can(CAP.manageFiles) && can(editCapabilityForKind('journal_entry'));

  // Load pickers and (for edit/view) the entry once, on open. A null workspace cannot resolve a ctx
  // verb, so the drawer simply reports the missing entry rather than calling with a blank tenant.
  useEffect(() => {
    let live = true;
    async function load() {
      if (workspaceId === null) {
        if (live) setLoading(false);
        return;
      }
      let chart: Account[] = [];
      let bankLedgers: ReadonlySet<string> = new Set();
      let codes: TaxCode[] = [];
      let stored: { entry: JournalEntry; lines: EntryLine[] } | null = null;
      const reads: Promise<void>[] = [];
      reads.push(
        client.call('list_accounts', { workspaceId }).then(({ body }) => {
          if (body.ok) chart = (body.accounts as Account[]) ?? [];
        }),
      );
      // Each Bankkonto's own ledger account never offers MWST (critic L2). A failed read marks none.
      reads.push(
        client.call('list_bank_accounts', { workspaceId }).then(({ body }) => {
          if (body.ok) bankLedgers = bankLedgerIdsOf(body);
        }),
      );
      // UNCONDITIONAL: a POSTED entry, the one mode where the FX disclosure renders, must know what the
      // books are kept in too. The profile answers `{ok, profile: {...}}`; a failed read leaves the
      // initial value rather than blanking the labels.
      reads.push(
        client.call('get_company_profile', { workspaceId }).then(({ body }) => {
          if (!live || isErr(body)) return;
          const profile = body.profile as { baseCurrency?: string | null } | undefined;
          const base = profile?.baseCurrency ?? null;
          if (base !== null && base !== '') setBaseCurrency(base);
        }),
      );
      // The codes and the cost centres: the composer's controls, and the names a posted line shows.
      reads.push(
        client.call('vat_codes', { workspaceId }).then(({ body }) => {
          if (body.ok) codes = (body.taxCodes as TaxCode[]) ?? [];
        }),
      );
      reads.push(
        client.call('list_cost_centers', { workspaceId }).then(({ body }) => {
          if (live && body.ok) setCostCenters((body.costCenters as CostCenter[]) ?? []);
        }),
      );
      if ((mode === 'edit' || mode === 'view') && entryId !== undefined) {
        reads.push(
          client.call('get_entry', { workspaceId, entryId }).then(({ body }) => {
            if (!live) return;
            if (isErr(body)) {
              setLoadErr(body);
              return;
            }
            stored = { entry: body.entry as JournalEntry, lines: (body.lines as EntryLine[]) ?? [] };
          }),
        );
      }
      if (mode === 'view' && entryId !== undefined) {
        // The trace read rides beside `get_entry`, never in front of it: a failed or absent trace
        // answer costs the link and nothing else.
        reads.push(
          client
            .call('list_agent_sessions', { workspaceId, entityRef: entryId })
            .then(({ body }) => {
              if (!live || isErr(body)) return;
              const sessions = Array.isArray(body.sessions) ? (body.sessions as { sessionId?: unknown }[]) : [];
              const first = sessions[0];
              setTraceSessionId(first !== undefined && typeof first.sessionId === 'string' ? first.sessionId : null);
            })
            .catch(() => undefined),
        );
      }
      await Promise.all(reads);
      if (!live) return;
      setAccounts(markBankLedgers(chart, bankLedgers));
      setTaxCodes(codes);
      const loaded = stored as { entry: JournalEntry; lines: EntryLine[] } | null;
      if (loaded !== null) {
        setEntry(loaded.entry);
        setViewLines(loaded.lines);
        setDate(loaded.entry.date);
        setRef(loaded.entry.ref ?? '');
        setRefOpen((loaded.entry.ref ?? '') !== '');
        setDescription(loaded.entry.description ?? '');
        if (mode === 'edit') await openStored(loaded.entry, loaded.lines, chart, () => live);
      }
      if (live) setLoading(false);
    }

    /**
     * A draft, an agent's Vorschlag or `?entry=` reopens through the engine's `decompose` (D152 amendment):
     * a satz or the derived grid when it round-trips, else the manual grid with the stored lines VERBATIM.
     * The Studio reads no trace and re-derives nothing here: `reopenState` only places what the engine said.
     * A failed read opens the stored lines verbatim, which is the answer that can never re-price anything.
     */
    async function openStored(e: JournalEntry, stored: EntryLine[], chart: Account[], isLive: () => boolean) {
      const byId = new Map(chart.map((a) => [a.id, a]));
      const accountOf = (id: string) => byId.get(id);
      if (workspaceId === null) return;
      const { body } = await client.call('compose_entry', { workspaceId, mode: 'decompose', date: e.date, lines: stored });
      if (!isLive()) return;
      const decomposed: Decomposed = isErr(body)
        ? { date: e.date, lines: stored.map(storedLine), intent: [], roundTrips: false }
        : (body as unknown as Decomposed);
      const state = reopenState(decomposed, accountOf);
      setFace(state.face);
      setLines(state.lines);
      setManualLock(state.manualLock);
      if (state.face === 'satz') setSatz(state.satz);
    }

    void load();
    return () => {
      live = false;
    };
    // Load-on-open only: the identity inputs are stable for the drawer's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const accountsById = useMemo(() => {
    const map = new Map<string, Account>();
    for (const a of accounts ?? []) map.set(a.id, a);
    return map;
  }, [accounts]);
  const accountOf = useCallback((id: string) => accountsById.get(id), [accountsById]);
  const accountLabel = useCallback(
    (id: string) => {
      const a = accountsById.get(id);
      return a ? `${a.number} ${a.name}` : id;
    },
    [accountsById],
  );
  const accountNumber = useCallback((id: string) => accountsById.get(id)?.number ?? id, [accountsById]);
  const activeCodes = useMemo(() => taxCodes.filter((c) => c.active !== false), [taxCodes]);
  const costCenterName = useCallback(
    (id: string) => {
      const c = costCenters.find((x) => x.id === id);
      return c !== undefined ? `${c.code} ${c.name}` : id;
    },
    [costCenters],
  );

  // What the composer holds, as one comparable string (keys are React identities, not input).
  const snapshot = (): string =>
    JSON.stringify({
      date,
      ref,
      description,
      face,
      satz: [satz.soll, satz.haben, satz.amount, satz.taxCode, satz.costCenter],
      lines: lines.map(({ account, debit, credit, costCenter, taxCode }) => [account, debit, credit, costCenter, taxCode]),
      beleg: beleg?.name ?? null,
    });

  // Taken once, when the composer has finished loading, so a loaded draft is the baseline.
  useEffect(() => {
    if (!loading && initialSnapshot.current === null) initialSnapshot.current = snapshot();
    // Only the end of the load decides the baseline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const dirty =
    editable && !loading && linkFailure === null && initialSnapshot.current !== null && snapshot() !== initialSnapshot.current;

  /** Every way out of the drawer (Escape, the X, the scrim, Abbrechen) asks first when input would be lost. */
  const requestClose = useCallback(() => {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  }, [dirty, onClose]);

  // --- The composed entry ------------------------------------------------------------------------------
  const manual = face === 'grid' && (manualLock || gridIsManual(lines, accountOf));
  const eff = useMemo(() => effectiveLines(lines), [lines]);
  const auto = useMemo(() => autoBalance(lines), [lines]);
  const subject = satzSubject(accountOf(satz.soll), accountOf(satz.haben));

  /**
   * The ONE request for what is on screen (`composerRequest`): intent on the derived path, plain or verbatim
   * stored lines on the manual path, and the draft's content as well (a half-typed satz, an amount-less row:
   * C4, C9, M2). The engine answers the lines a draft keeps and whether they would post.
   */
  const request = useMemo(
    () => composerRequest({ face, satz, lines, manualLock }, accountOf, date),
    [face, satz, lines, manualLock, accountOf, date],
  );
  const signature = useMemo(
    () => JSON.stringify({ date, entryId: mode === 'edit' ? (entryId ?? null) : null, lines: request.lines }),
    [date, mode, entryId, request],
  );

  // Ask the engine, debounced, for the CURRENT request only. An answer is stored with the signature it
  // answered and read only while that signature is still the current one, so a slow answer for an earlier
  // keystroke can never stand in for this one (critic C3).
  useEffect(() => {
    if (!editable || workspaceId === null || loading || request.lines.length === 0) return;
    let live = true;
    const timer = setTimeout(() => {
      void client
        .call('compose_entry', {
          workspaceId,
          mode: 'expand',
          date,
          ...(mode === 'edit' && entryId !== undefined ? { entryId } : {}),
          lines: request.lines,
        })
        .then(({ body }) => {
          if (live) setAnswer({ signature, keys: request.keys, body: body as unknown as ExpandAnswer | Err });
        });
    }, COMPOSE_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // Keyed on the signature, which names everything the request carries; the client, workspace and mode
    // are stable for the drawer's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, editable, loading]);

  /** The answer for what is on screen now, or undefined while it is in flight (or for an empty composer). */
  const current: ExpandAnswer | Err | undefined = answer !== null && answer.signature === signature ? answer.body : undefined;
  const composedAnswer = current !== undefined && current.ok ? current : undefined;

  /** The engine's caption for the composed row with this key, or undefined while it is in flight. */
  const captionFor = useCallback(
    (key: string | undefined): ComposeCaption | null | undefined => {
      if (key === undefined || composedAnswer === undefined) return undefined;
      const i = request.keys.indexOf(key);
      return i < 0 ? undefined : (composedAnswer.captions[i] ?? null);
    },
    [composedAnswer, request],
  );

  /**
   * Whether a row's own account keeps a line in the engine's expansion, for OFFERING a cost centre (critic
   * C2). It reads the answer for what is on screen, and while that is in flight the newest answer's view
   * of the same row: an affordance does not blink on every keystroke, and no money ever rides this.
   */
  const keepsOwnFor = useCallback(
    (key: string | undefined): boolean => {
      const now = captionFor(key);
      if (now !== undefined) return keepsOwnAccount(now);
      if (key === undefined || answer === null || !answer.body.ok) return true;
      const i = answer.keys.indexOf(key);
      return i < 0 ? true : keepsOwnAccount(answer.body.captions[i]);
    },
    [captionFor, answer],
  );

  /** M5: a non-import code on a VAT-account line (a loaded draft, or the account changed under it). */
  const strandedVatTag = useCallback(
    (accountId: string, code: string) => {
      if (code === '' || !isVatAccount(accountOf(accountId))) return false;
      const kind = taxCodes.find((c) => c.code === code)?.kind;
      return kind !== undefined && kind !== 'import';
    },
    [accountOf, taxCodes],
  );
  /** A code not among the active ones (archived or unknown): flagged, and Post holds (the engine refuses it). */
  const codeInvalid = useCallback((code: string) => code !== '' && !activeCodes.some((c) => c.code === code), [activeCodes]);

  // --- Balance and the gate ----------------------------------------------------------------------------
  const debitTotal = eff.reduce((s, e) => s + (e.debitMinor ?? 0), 0);
  const creditTotal = eff.reduce((s, e) => s + (e.creditMinor ?? 0), 0);
  const gridBalanced = debitTotal > 0 && debitTotal === creditTotal;
  const gridNonEmpty = eff.filter((e) => e.line.account !== '' || e.line.debit !== '' || e.line.credit !== '');
  const gridValid = gridNonEmpty.every((e) => e.line.account !== '' && ((e.debitMinor ?? 0) > 0) !== ((e.creditMinor ?? 0) > 0));

  const satzComplete = request.lines.length === 2 && request.lines.every((l) => ('amount' in l ? l.amount > 0 : (l.debit ?? 0) + (l.credit ?? 0) > 0));
  const balanced = face === 'satz' ? satzComplete : gridBalanced;
  const allLinesValid = face === 'satz' ? satzComplete : gridValid;
  const shownCodes = face === 'satz' ? (subject !== null ? [{ account: subject.id, code: satz.taxCode }] : []) : lines.map((l) => ({ account: l.account, code: l.taxCode }));
  const hasStrandedVatTag = shownCodes.some((l) => strandedVatTag(l.account, l.code));
  const hasInvalidCode = shownCodes.some((l) => codeInvalid(l.code));
  const belegSettled = beleg === null || beleg.status === 'ready';
  const effectiveCanPost = canPost && !denied;
  /** The engine's verdict on what is on screen: `{ok:true}`, its refusal, or undefined while in flight. */
  const verdict = composedAnswer?.verdict ?? (current !== undefined && !current.ok ? current : undefined);
  const canSubmitPost =
    effectiveCanPost &&
    balanced &&
    allLinesValid &&
    !busy &&
    // B3/C3: Buchen stands on the engine's answer for exactly what is on screen, and on its verdict: never
    // on an answer in flight or one composed for something else.
    composedAnswer !== undefined &&
    composedAnswer.verdict.ok &&
    // M5: never a tag stranded on a VAT account; M35/C3: never an archived or unknown code (the engine
    // refuses both too; these name it on the control).
    !hasStrandedVatTag &&
    !hasInvalidCode &&
    // A Beleg still uploading, or failed, holds Post: it would otherwise be lost to an eager click.
    belegSettled &&
    linkFailure === null;
  const hasAnyAccount = face === 'satz' ? satz.soll !== '' || satz.haben !== '' : lines.some((l) => l.account !== '');
  // Critic C4/C3: a draft keeps exactly the lines the engine composed for what is on screen, so "Entwurf
  // speichern" holds while that answer is in flight, exactly as Buchen does. A draft may be unbalanced: it
  // needs the engine to have COMPOSED it, not to accept it as a posting.
  const canSaveDraft =
    effectiveCanPost && !busy && hasAnyAccount && composedAnswer !== undefined && composedAnswer.composed && belegSettled && linkFailure === null;

  // A registered workspace always seeds codes, so an empty list means MWST is not configured (P9): the
  // picker shows the banner-CTA into /vat rather than a control that could post untaxed.
  const needsVatConfig = editable && !loading && loadErr === null && taxCodes.length === 0;
  const vatReadOnly = !effectiveCanPost;

  // --- The Beleg ----------------------------------------------------------------------------------------
  const upload = useCallback(
    async (b: PendingBeleg) => {
      if (workspaceId === null) return;
      setBelegErr(null);
      const payloadFile = await readFileAsUpload(b.file);
      const { body } = await client.call('files_upload', {
        workspaceId,
        ...payloadFile,
        title: payloadFile.filename,
        idempotencyKey: b.uploadKey,
      });
      setBeleg((prev) => {
        if (prev === null || prev.uploadKey !== b.uploadKey) return prev;
        if (isErr(body)) return { ...prev, status: 'failed' };
        const file = (body as unknown as { file: { id: string } }).file;
        return { ...prev, status: 'ready', fileId: file.id };
      });
      if (isErr(body)) setBelegErr(body);
    },
    [client, workspaceId],
  );

  const pickBeleg = useCallback(
    (file: File) => {
      const next: PendingBeleg = {
        name: file.name,
        file,
        status: 'uploading',
        fileId: null,
        uploadKey: newIdempotencyKey(),
        linkKey: newIdempotencyKey(),
      };
      setBeleg(next);
      void upload(next);
    },
    [upload],
  );

  /** Link the filed Beleg to the entry the write just answered with. True when it stands linked. */
  async function linkBeleg(target: string, fileId: string, linkKey: string): Promise<Err | null> {
    if (workspaceId === null) return null;
    const { body } = await client.call('files_link', {
      workspaceId,
      fileId,
      entityKind: 'journal_entry',
      entityId: target,
      idempotencyKey: linkKey,
    });
    return isErr(body) ? body : null;
  }

  // --- Write handlers ------------------------------------------------------------------------------------
  /** The answer of a post or a draft save: refused stays open; written links the Beleg, then closes. */
  async function afterWrite(body: Result, wrote: 'post' | 'draft') {
    if (isErr(body)) {
      if (body.error === 'permission_denied') setDenied(true);
      else setWriteErr(body);
      return;
    }
    const written = (body as { entryId?: unknown }).entryId;
    const writtenId = typeof written === 'string' ? written : undefined;
    const current = belegRef.current;
    if (writtenId !== undefined && current !== null && current.status === 'ready' && current.fileId !== null) {
      const failed = await linkBeleg(writtenId, current.fileId, current.linkKey);
      if (failed !== null) {
        // The write STANDS. The drawer stays open on the banner with a retry, and the list learns of the
        // entry now: nothing is lost and nothing is written twice.
        setLinkFailure({ entryId: writtenId, fileId: current.fileId, linkKey: current.linkKey, error: failed, wrote });
        onWritten(writtenId);
        return;
      }
    }
    onWritten(writtenId);
    onClose();
  }

  async function retryLink() {
    if (linkFailure === null) return;
    setBusy(true);
    const failed = await linkBeleg(linkFailure.entryId, linkFailure.fileId, linkFailure.linkKey);
    setBusy(false);
    if (failed !== null) {
      setLinkFailure({ ...linkFailure, error: failed });
      return;
    }
    onClose();
  }

  /** The key for this exact content: the one already minted for it, or a fresh one (critic C7, K3). */
  function intentKey(intents: { current: Map<string, string> }, signature: string): string {
    const known = intents.current.get(signature);
    if (known !== undefined) return known;
    const key = newIdempotencyKey();
    intents.current.set(signature, key);
    return key;
  }

  // Both writes send the engine's answered lines VERBATIM (D152 amendment): what `compose_entry` composed
  // for exactly what is on screen, never a figure of the Studio's own.
  async function submitPost() {
    if (workspaceId === null || !canSubmitPost || composedAnswer === undefined) return;
    setBusy(true);
    setWriteErr(null);
    const content: Record<string, unknown> = { date, lines: composedAnswer.lines, source: 'manual' };
    if (mode === 'edit' && entryId !== undefined) content.entryId = entryId;
    if (ref !== '') content.ref = ref;
    if (description !== '') content.description = description;
    const signature = JSON.stringify(content);
    const input = { workspaceId, ...content, idempotencyKey: intentKey(postIntents, signature) };
    const { body } = await client.call('post_entry', input);
    if (!isErr(body)) postIntents.current.delete(signature);
    await afterWrite(body, 'post');
    setBusy(false);
  }

  async function submitDraft() {
    if (workspaceId === null || !canSaveDraft || composedAnswer === undefined) return;
    setBusy(true);
    setWriteErr(null);
    const content: Record<string, unknown> = { date, lines: composedAnswer.lines };
    if (mode === 'edit' && entryId !== undefined) content.entryId = entryId;
    if (ref !== '') content.ref = ref;
    if (description !== '') content.description = description;
    const signature = JSON.stringify(content);
    const input = { workspaceId, ...content, idempotencyKey: intentKey(draftIntents, signature) };
    const { body } = await client.call('save_draft', input);
    if (!isErr(body)) draftIntents.current.delete(signature);
    await afterWrite(body, 'draft');
    setBusy(false);
  }

  const settle = useCallback(
    (body: Result) => {
      if (isErr(body)) {
        if (body.error === 'permission_denied') setDenied(true);
        else setWriteErr(body);
        return false;
      }
      const written = (body as { entryId?: unknown }).entryId;
      onWritten(typeof written === 'string' ? written : undefined);
      onClose();
      return true;
    },
    [onClose, onWritten],
  );

  /** Posts the mirror entry. Only ever reached from the confirm step, never from a bare click. */
  async function submitReverse() {
    if (workspaceId === null || entryId === undefined || !effectiveCanPost || busy) return;
    setConfirmReverse(false);
    setBusy(true);
    setWriteErr(null);
    const { body } = await client.call('reverse_entry', {
      workspaceId,
      entryId,
      idempotencyKey: newIdempotencyKey(),
    });
    setBusy(false);
    settle(body);
  }

  async function submitDelete() {
    if (workspaceId === null || entryId === undefined || !effectiveCanPost || busy) return;
    setConfirmDelete(false);
    setBusy(true);
    setWriteErr(null);
    const { body } = await client.call('delete_draft', {
      workspaceId,
      entryId,
      idempotencyKey: newIdempotencyKey(),
    });
    setBusy(false);
    settle(body);
  }

  // --- Composer edits ------------------------------------------------------------------------------------
  /** An edit to one row. Any edit drops the stored line a verbatim reopen carried (`editGridLine`). */
  function updateLine(key: string, patch: Partial<Omit<GridLine, 'key' | 'verbatim'>>) {
    setLines((prev) => prev.map((l) => (l.key === key ? editGridLine(l, patch) : l)));
  }

  /**
   * A grid line's account changed: its code follows the new account and its cost centre is cleared. Its
   * kept Leistungsdatum follows the one rule (`withTaxCode`, critic R6-S1): it stays while the line still
   * carries a code (R5 L-a), and goes when the new account leaves it with none.
   */
  function setLineAccount(key: string, accountId: string) {
    const acc = accountOf(accountId);
    updateLine(key, { account: accountId, costCenter: '', ...withTaxCode(defaultCodeFor(acc, activeCodes)) });
  }

  function split() {
    setLines(satzToGrid(satz, accountOf));
    setFace('grid');
  }

  // Critic C2: when the engine finds no line on the account a cost centre rides (the code became a
  // deductible Einfuhrsteuer) it refuses that line `cost_center_unplaced`, and the centre is cleared ON
  // SCREEN rather than silently dropped at post.
  useEffect(() => {
    if (current === undefined || !current.ok) return;
    const unplaced = request.keys.filter((_, i) => {
      const c = current.captions[i];
      return c !== null && c !== undefined && !c.ok && c.error === 'cost_center_unplaced';
    });
    if (unplaced.length === 0) return;
    if (face === 'satz') {
      setSatz((s) => ({ ...s, costCenter: '', costCenterOpen: false }));
      return;
    }
    setLines((prev) => prev.map((l) => (unplaced.includes(l.key) ? { ...l, costCenter: '' } : l)));
  }, [current, request, face]);

  // Focus follows the act: "Aufteilen" lands on "+ Zeile" (the button that pressed it is gone), and
  // "+ Kostenstelle" lands on the picker it opened.
  useEffect(() => {
    if (face === 'grid' && editable && !loading) addLineRef.current?.focus();
    // Only the switch itself moves focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [face]);
  useEffect(() => {
    if (!focusCostCenter) return;
    costCenterRef.current?.querySelector<HTMLElement>('button, input')?.focus();
    setFocusCostCenter(false);
  }, [focusCostCenter]);
  useEffect(() => {
    if (!focusRefField) return;
    refInputRef.current?.focus();
    setFocusRefField(false);
  }, [focusRefField]);

  const titleKey = mode === 'create' ? 'entry.newTitle' : mode === 'edit' ? 'entry.editTitle' : 'entry.viewTitle';

  // C3: the quiet provenance line for a posted, viewed entry, from the read model's own header.
  const origin = entry !== null ? provenanceOrigin(entry.source) : 'unknown';
  const provenance =
    mode === 'view' && entry !== null && entry.createdAt != null ? (
      <Provenance
        origin={origin}
        actor={entry.createdBy ?? null}
        action={origin === 'agent' ? null : t(`journal.source.${entry.source}`)}
        timestamp={entry.createdAt}
        {...(traceSessionId !== null ? { traceHref: `/agent?session=${encodeURIComponent(traceSessionId)}` } : {})}
      />
    ) : undefined;

  const fx = useMemo(() => fxDisclosureOf(viewLines), [viewLines]);

  // --- The footer --------------------------------------------------------------------------------------
  const footerActions = (
    <div className="journal-drawer-foot">
      <div className="journal-drawer-actions">
        {mode === 'edit' && linkFailure === null && (
          <OverflowMenu
            label={t('entry.more')}
            disabled={!effectiveCanPost || busy}
            items={[{ key: 'delete', label: t('entry.delete'), onSelect: () => setConfirmDelete(true), danger: true }]}
          />
        )}
        {editable && face === 'grid' && linkFailure === null && (
          <BalanceStatus debitTotal={debitTotal} creditTotal={creditTotal} currency={baseCurrency} />
        )}
        <span className="journal-spacer" />
        {mode === 'view' ? (
          <>
            <button type="button" className="btn btn--secondary" onClick={requestClose}>
              {t('entry.close')}
            </button>
            {/* Never `.btn--primary`: a solid accent fill invites the careless click, and this action
                posts money. The danger outline states the weight without shouting. */}
            <button
              type="button"
              className="btn btn--danger"
              disabled={!effectiveCanPost || busy}
              title={!canPost ? t('entry.requiresBookkeeper') : undefined}
              onClick={() => setConfirmReverse(true)}
            >
              {t('entry.reverse')}
            </button>
          </>
        ) : linkFailure !== null ? (
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            {t('entry.close')}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={!canSaveDraft}
              title={!canPost ? t('entry.requiresBookkeeper') : undefined}
              onClick={submitDraft}
            >
              {t('entry.saveDraft')}
            </button>
            <button type="button" className="btn btn--secondary" onClick={requestClose}>
              {t('entry.cancel')}
            </button>
            {/* `.btn--accent`: the ONE role the tinted button has (K-08, D137), the commit of a money write
                into an append-only ledger. The C4 sentence an approver reads on an agent's drafted post
                is the tooltip of the (i) beside it, and describes this button too. */}
            <button
              type="button"
              className="btn btn--accent"
              data-money-commit="post_entry"
              disabled={!canSubmitPost}
              aria-describedby={consequenceId}
              title={!canPost ? t('entry.requiresBookkeeper') : undefined}
              onClick={submitPost}
            >
              {t('entry.post')}
            </button>
            <ConsequenceLine verb="post_entry" variant="tooltip" triggerLabel={t('entry.consequenceInfo')} describedById={consequenceId} />
          </>
        )}
      </div>
    </div>
  );

  // --- The Buchungssatz ----------------------------------------------------------------------------------
  const satzKey = subject === null ? undefined : subject.id === satz.soll ? 'satz-soll' : 'satz-haben';
  const satzCaption = subject !== null && satz.taxCode !== '' ? captionFor(satzKey) : null;
  // Critic C2: a cost centre is offered only where the engine's expansion books something on the account it
  // would ride (a deductible Einfuhrsteuer books the 1170 line and nothing on the expense).
  const satzKeepsSubject = satz.taxCode === '' || keepsOwnFor(satzKey);
  const canOfferCostCenter = subject !== null && subject.costCenterAllowed === true && costCenters.length > 0 && satzKeepsSubject;
  const refControl = refOpen ? (
    <label className="journal-field journal-ref">
      {t('entry.ref')}
      <input
        ref={refInputRef}
        className="field"
        type="text"
        value={ref}
        onChange={(e) => setRef(e.target.value)}
        aria-label={t('entry.ref')}
      />
    </label>
  ) : (
    <button
      type="button"
      className="btn btn--ghost btn--sm"
      onClick={() => {
        setRefOpen(true);
        setFocusRefField(true);
      }}
    >
      <PlusGlyph size={16} />
      {t('entry.addRef')}
    </button>
  );

  const satzRow = (
    <div className="journal-satz-block">
      <div className="journal-satz" role="group" aria-label={t('entry.satzLabel')}>
        <div className="journal-field journal-satz-soll">
          <span aria-hidden="true">{t('entry.debit')}</span>
          <AccountCombobox
            id="entry-satz-soll"
            ariaLabel={t('entry.debit')}
            inputClassName="field"
            accounts={accounts ?? []}
            value={satz.soll}
            onChange={(id) => setSatz((s) => withSatzAccount(s, 'soll', id, accountOf, activeCodes))}
            placeholder={t('entry.accountPlaceholder')}
            noMatchLabel={t('entry.noAccountMatch')}
          />
        </div>
        <span className="journal-satz-an" aria-hidden="true">
          {t('entry.satzAn')}
        </span>
        <div className="journal-field journal-satz-haben">
          <span aria-hidden="true">{t('entry.credit')}</span>
          <AccountCombobox
            id="entry-satz-haben"
            ariaLabel={t('entry.credit')}
            inputClassName="field"
            accounts={accounts ?? []}
            value={satz.haben}
            onChange={(id) => setSatz((s) => withSatzAccount(s, 'haben', id, accountOf, activeCodes))}
            placeholder={t('entry.accountPlaceholder')}
            noMatchLabel={t('entry.noAccountMatch')}
          />
        </div>
        <label className="journal-field journal-satz-amount">
          {t('entry.amount')}
          <input
            className="field journal-line-amount"
            type="text"
            inputMode="decimal"
            placeholder={t('entry.amountPlaceholder')}
            value={satz.amount}
            onChange={(e) => setSatz((s) => ({ ...s, amount: e.target.value }))}
            aria-label={t('entry.amount')}
          />
        </label>
        <div className="journal-field journal-satz-tax">
          {subject !== null && (
            <>
              <span aria-hidden="true">{t('entry.mwst')}</span>
              <MwstControl
                label={t('entry.mwst')}
                codes={activeCodes}
                value={satz.taxCode}
                onChange={(code) => setSatz((s) => ({ ...s, ...withTaxCode(code) }))}
                direction={subject.id === satz.soll ? 'out' : 'in'}
                needsConfig={needsVatConfig}
                readOnly={vatReadOnly}
                invalidCode={codeInvalid(satz.taxCode)}
                stranded={false}
              />
            </>
          )}
        </div>
      </div>
      <div className="journal-satz-under">
        <div className="journal-satz-actions">
          {/* Critic C1: nothing hidden carries a value. A cost centre the satz holds is ON SCREEN, even on
              an account that would not offer one (an agent's Vorschlag, an old draft), so it can be seen
              and taken off before it posts; "+ Kostenstelle" itself is only offered where one is allowed. */}
          {satz.costCenter !== '' || (canOfferCostCenter && satz.costCenterOpen) ? (
            <div className="journal-field journal-satz-cc" ref={costCenterRef}>
              <span aria-hidden="true">{t('entry.costCenter')}</span>
              <Select
                ariaLabel={t('entry.costCenter')}
                value={satz.costCenter}
                onChange={(value) => setSatz((s) => ({ ...s, costCenter: value }))}
                options={[
                  { value: '', label: t('entry.noCostCenter') },
                  ...costCenters.map((c) => ({ value: c.id, label: `${c.code} ${c.name}` })),
                  ...(satz.costCenter !== '' && !costCenters.some((c) => c.id === satz.costCenter)
                    ? [{ value: satz.costCenter, label: satz.costCenter }]
                    : []),
                ]}
              />
            </div>
          ) : (
            canOfferCostCenter && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  setSatz((s) => ({ ...s, costCenterOpen: true }));
                  setFocusCostCenter(true);
                }}
              >
                <PlusGlyph size={16} />
                {t('entry.addCostCenter')}
              </button>
            )
          )}
          {refControl}
          <Tooltip content={t('entry.splitTip')}>
            <button type="button" className="btn btn--ghost btn--sm" onClick={split}>
              <SplitGlyph size={16} />
              {t('entry.split')}
            </button>
          </Tooltip>
        </div>
        <div className="journal-satz-caption" aria-live="polite">
          {/* A kept Leistungsdatum shows only while it differs from the booking date (owner, 02.10.2026). */}
          {satz.supplyDate !== '' && satz.supplyDate !== date && subject !== null && satz.taxCode !== '' && (
            <p className="journal-caption">{t('entry.supplyDateCaption', { date: formatDate(satz.supplyDate) })}</p>
          )}
          <VatCaption
            caption={satzCaption}
            suppressed={codeInvalid(satz.taxCode)}
            currency={baseCurrency}
            accountNumber={accountNumber}
          />
        </div>
      </div>
    </div>
  );

  // --- The grid ------------------------------------------------------------------------------------------
  const gridRows = lines.map((l, i) => {
    const e = eff[i];
    const acc = accountOf(l.account);
    const showTax = gridShowsTax(l, manual, accountOf);
    const isAuto = e !== undefined && e.auto;
    const autoDebit = isAuto && auto !== null && auto.side === 'debit' ? minorToDecimal(auto.amountMinor) : '';
    const autoCredit = isAuto && auto !== null && auto.side === 'credit' ? minorToDecimal(auto.amountMinor) : '';
    const caption = l.taxCode !== '' ? captionFor(l.key) : null;
    const items: OverflowMenuItem[] = [];
    if (acc?.costCenterAllowed === true && (l.taxCode === '' || keepsOwnFor(l.key))) {
      for (const c of costCenters) {
        if (c.id === l.costCenter) continue;
        items.push({ key: `cc-${c.id}`, label: t('entry.setCostCenter', { name: `${c.code} ${c.name}` }), onSelect: () => updateLine(l.key, { costCenter: c.id }) });
      }
    }
    if (l.costCenter !== '') items.push({ key: 'cc-none', label: t('entry.removeCostCenter'), onSelect: () => updateLine(l.key, { costCenter: '' }) });
    if (lines.length > 2) {
      items.push({ key: 'remove', label: t('entry.removeLineShort'), danger: true, onSelect: () => setLines((prev) => prev.filter((x) => x.key !== l.key)) });
    }
    const codes = manual && isVatAccount(acc) ? activeCodes.filter((c) => c.kind === 'import') : activeCodes;
    return (
      <div className="journal-grid-row" key={l.key} role="group" aria-label={t('entry.lineN', { number: i + 1 })}>
        <div className="journal-grid-account">
          {/* F-03 (J3.7): a typeable combobox, keyboard-first ("6500", Enter, Tab on). */}
          <AccountCombobox
            id={`entry-account-${l.key}`}
            ariaLabel={`${t('entry.account')} ${i + 1}`}
            inputClassName="field"
            accounts={accounts ?? []}
            value={l.account}
            onChange={(account) => setLineAccount(l.key, account)}
            placeholder={t('entry.accountPlaceholder')}
            noMatchLabel={t('entry.noAccountMatch')}
          />
          {l.costCenter !== '' && (
            <span className="journal-grid-cc">{t('entry.costCenterCaption', { name: costCenterName(l.costCenter) })}</span>
          )}
          {l.supplyDate !== '' && l.supplyDate !== date && l.taxCode !== '' && (
            <span className="journal-grid-cc">{t('entry.supplyDateCaption', { date: formatDate(l.supplyDate) })}</span>
          )}
        </div>
        <div className="journal-grid-tax">
          {showTax && (
            <MwstControl
              label={`${t('entry.mwst')} ${i + 1}`}
              codes={codes}
              value={l.taxCode}
              onChange={(code) => updateLine(l.key, withTaxCode(code))}
              direction={(e?.creditMinor ?? 0) > 0 ? 'in' : (e?.debitMinor ?? 0) > 0 ? 'out' : undefined}
              needsConfig={needsVatConfig}
              readOnly={vatReadOnly}
              invalidCode={codeInvalid(l.taxCode)}
              stranded={strandedVatTag(l.account, l.taxCode)}
            />
          )}
        </div>
        <input
          className="field journal-line-amount"
          data-auto={autoDebit !== '' ? 'true' : undefined}
          type="text"
          inputMode="decimal"
          aria-label={`${t('entry.debit')} ${i + 1}`}
          value={l.debit}
          placeholder={autoDebit}
          onChange={(ev) => updateLine(l.key, { debit: ev.target.value, credit: '' })}
        />
        <input
          className="field journal-line-amount"
          data-auto={autoCredit !== '' ? 'true' : undefined}
          type="text"
          inputMode="decimal"
          aria-label={`${t('entry.credit')} ${i + 1}`}
          value={l.credit}
          placeholder={autoCredit}
          onChange={(ev) => updateLine(l.key, { credit: ev.target.value, debit: '' })}
        />
        <div className="journal-grid-more">
          {items.length > 0 && <OverflowMenu quiet label={t('entry.lineMore', { number: i + 1 })} items={items} />}
        </div>
        {l.account !== '' && l.taxCode !== '' && (
          <div className="journal-grid-caption">
            <VatCaption
              caption={caption}
              suppressed={codeInvalid(l.taxCode) || strandedVatTag(l.account, l.taxCode)}
              currency={baseCurrency}
              accountNumber={accountNumber}
            />
          </div>
        )}
      </div>
    );
  });

  const grid = (
    <div className="journal-grid" role="group" aria-label={t('entry.lines')}>
      {/* The heads, once, on the SAME grid as the rows, so each sits over its column 1:1. Every control
          names itself ("Soll 2"), so the heads are for the eye only. */}
      <div className="journal-grid-head" aria-hidden="true">
        <span>{t('entry.account')}</span>
        <span>{t('entry.mwst')}</span>
        <span className="journal-grid-num">{t('entry.debit')}</span>
        <span className="journal-grid-num">{t('entry.credit')}</span>
        <span />
      </div>
      {gridRows}
      <div className="journal-grid-foot">
        <div className="journal-satz-actions">
          <button ref={addLineRef} type="button" className="btn btn--ghost btn--sm" onClick={() => setLines((prev) => [...prev, blankGridLine()])}>
            <PlusGlyph size={16} />
            {t('entry.addLineShort')}
          </button>
          {refControl}
        </div>
        <span className="journal-caption">{manual ? t('entry.manualNote') : t('entry.grossNote')}</span>
      </div>
    </div>
  );

  // --- The body ------------------------------------------------------------------------------------------
  const showBeleg = mode === 'create' && canAttach;
  const metaRow = (
    <div className={`journal-meta${showBeleg ? '' : ' journal-meta--two'}`}>
      <label className="journal-field">
        {t('entry.date')}
        <input
          ref={dateInputRef}
          className="field"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-label={t('entry.date')}
        />
      </label>
      <label className="journal-field">
        {t('entry.text')}
        <input
          className="field"
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          aria-label={t('entry.text')}
        />
      </label>
      {showBeleg && (
        <div className="journal-field journal-meta-beleg">
          <span aria-hidden="true">{t('entry.beleg.label')}</span>
          <BelegControl
            beleg={beleg}
            onPick={pickBeleg}
            onRemove={() => {
              setBeleg(null);
              setBelegErr(null);
            }}
            disabled={busy}
          />
        </div>
      )}
    </div>
  );

  // What is refused, in place: a write's own refusal, else the engine's verdict on what is on screen when it
  // says something the person can act on (a locked period, VAT that does not reconcile, an account or
  // cost centre the book does not hold). An unfinished entry is not refused at the person (QUIET_VERDICTS),
  // and what a control already names inline (a code, a missing VAT account) is not said twice.
  const verdictShown =
    verdict !== undefined && !verdict.ok && !QUIET_VERDICTS.has(verdict.error) && !INLINE_VERDICTS.has(verdict.error) ? verdict : null;
  const shownErr: Err | null = writeErr ?? verdictShown;
  const refusal =
    shownErr !== null && shownErr.error === 'period_locked' ? (
      /* F-10 J8.6: the refusal names the way OUT, not only /periods. The nearest open date is offered as
         an action that moves the entered date and KEEPS the composed lines. */
      (() => {
        const lockedPeriod = typeof shownErr.period === 'string' ? shownErr.period : undefined;
        const suggestedDate = lockedPeriod !== undefined ? nextOpenDateAfter(lockedPeriod) : undefined;
        return (
          <div className="error-banner panel" role="alert">
            <span aria-hidden="true">! </span>
            <div>
              <p className="error-body">{t('entry.periodLocked')}</p>
              {suggestedDate !== undefined && (
                <p className="error-body">{t('entry.periodLockedWayOut', { date: formatDate(suggestedDate) })}</p>
              )}
              <div className="journal-drawer-locked-actions">
                {suggestedDate !== undefined && (
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => {
                      setDate(suggestedDate);
                      setWriteErr(null);
                      dateInputRef.current?.focus();
                    }}
                  >
                    {t('entry.periodLockedChangeDate')}
                  </button>
                )}
                <Link className="link-inline" to="/periods">
                  {t('entry.periodLockedLink')}
                </Link>
              </div>
            </div>
          </div>
        );
      })()
    ) : shownErr !== null && shownErr.error === 'vat_trace_unreconciled' ? (
      /* B2: the engine's reconciliation rejection, with the actual figures (expected vs booked), in the
         base currency the post was booked in. It stands in place with no special action: the person edits
         the lines (a verbatim reopen included), and the engine judges what is then on screen. */
      <div className="error-banner panel" role="alert">
        <span aria-hidden="true">! </span>
        <div>
          <p className="error-body">
            {t('entry.vatUnreconciled', {
              expected: formatMoney(Number(shownErr.expectedMinor ?? 0), baseCurrency),
              booked: formatMoney(Number(shownErr.bookedMinor ?? 0), baseCurrency),
            })}
          </p>
        </div>
      </div>
    ) : shownErr !== null && ownedByWording(shownErr) !== null ? (
      /* A39 §6 (lean critic C11, L4): an owned entry is undone by its owner's own verb. */
      (() => {
        const owned = ownedByWording(shownErr) as OwnedByWording;
        return (
          <>
            <ErrorBanner error={shownErr} message={t(owned.messageKey)} />
            <Link className="link-inline" to={owned.href}>
              {t(owned.linkKey)}
            </Link>
          </>
        );
      })()
    ) : (
      shownErr !== null && <ErrorBanner error={shownErr} />
    );

  const composerBody = (
    <div
      className="journal-drawer-body-spacing"
      onDragOver={showBeleg ? (e) => e.preventDefault() : undefined}
      onDrop={
        showBeleg
          ? (e) => {
              e.preventDefault();
              const dropped = e.dataTransfer?.files?.[0];
              if (dropped !== undefined && !busy) pickBeleg(dropped);
            }
          : undefined
      }
    >
      {metaRow}
      {belegErr !== null && beleg !== null && (
        <ErrorBanner error={belegErr} onRetry={() => void upload({ ...beleg, status: 'uploading' })} />
      )}
      {face === 'satz' ? satzRow : grid}
      {verdict !== undefined && !verdict.ok && verdict.error === 'vat_account_missing' && (
        /* The chart lacks the account the derived leg books to: say which, and where it is added. Buchen
           holds until it exists, so this is the reason on screen, never a silent disabled button. */
        <p role="note" className="journal-drawer-requires">
          <span aria-hidden="true">! </span>
          {t('entry.vatAccountMissing')}{' '}
          <Link className="link-inline" to="/accounts">
            {t('entry.vatAccountMissingLink')}
          </Link>
        </p>
      )}
      {denied && (
        <p role="alert" className="journal-drawer-requires">
          <span aria-hidden="true">! </span>
          {t('entry.permissionDenied')}
        </p>
      )}
      {!canPost && (
        <p className="journal-drawer-requires">
          <span aria-hidden="true">! </span>
          {t('entry.requiresBookkeeper')}
        </p>
      )}
      {refusal}
      {/* E00: the shared Dateien panel for an entry that already exists. It is the ONE attachment UI for
          a stored entry; a new entry's Beleg rides the paperclip and is linked once the entry has an id. */}
      {entryId !== undefined && workspaceId !== null && (
        <LinkedFiles workspaceId={workspaceId} entityKind="journal_entry" entityId={entryId} />
      )}
    </div>
  );

  const linkFailureBody = linkFailure !== null && (
    <div className="journal-drawer-body-spacing">
      <ErrorBanner
        error={linkFailure.error}
        message={t(linkFailure.wrote === 'post' ? 'entry.beleg.linkFailedPosted' : 'entry.beleg.linkFailedDraft', {
          name: beleg?.name ?? '',
        })}
        onRetry={() => void retryLink()}
      />
    </div>
  );

  const viewBody = (
    <div className="journal-drawer-body-spacing">
      {entry?.reversesEntryId != null && <p className="journal-drawer-hint">{t('entry.reversalOf')}</p>}
      <dl className="journal-view-meta">
        <div>
          <dt>{t('entry.date')}</dt>
          <dd className="journal-view-date">{formatDate(date)}</dd>
        </div>
        <div>
          <dt>{t('entry.text')}</dt>
          <dd>{description}</dd>
        </div>
        {ref !== '' && (
          <div>
            <dt>{t('entry.ref')}</dt>
            <dd>{ref}</dd>
          </div>
        )}
      </dl>
      {/* A posted entry shows EVERY stored line, its derived VAT legs included: posted entries are N
          lines, and the record is what the books hold, read-only. */}
      <table className="journal-drawer-lines">
        <caption className="visually-hidden">{t('entry.lines')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('entry.account')}</th>
            <th scope="col">{t('entry.mwst')}</th>
            <th scope="col" className="journal-drawer-view-amount">
              {t('entry.debit')}
            </th>
            <th scope="col" className="journal-drawer-view-amount">
              {t('entry.credit')}
            </th>
          </tr>
        </thead>
        <tbody>
          {viewLines.map((l, i) => (
            <tr key={l.id ?? i}>
              <td>
                {accountLabel(l.account)}
                {l.costCenter != null && l.costCenter !== '' && (
                  <span className="journal-grid-cc">{t('entry.costCenterCaption', { name: costCenterName(l.costCenter) })}</span>
                )}
              </td>
              <td className="journal-drawer-view-code">{l.taxCode ?? ''}</td>
              {/* §H-FX: the line's OWN currency, never a hardcoded CHF; a line the ENGINE sent always names
                  it, and the fallback is the workspace base currency, never CHF. */}
              <td className="journal-drawer-view-amount t-money">
                {typeof l.debit === 'number' && l.debit > 0 ? formatMoney(l.debit, l.currency ?? baseCurrency) : ''}
              </td>
              <td className="journal-drawer-view-amount t-money">
                {typeof l.credit === 'number' && l.credit > 0 ? formatMoney(l.credit, l.currency ?? baseCurrency) : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* The books are kept in the base currency, so a converted entry says what it became there and at
          which rate. Shown only when there is a conversion: a rate of 1 is not FX. */}
      {fx !== null && (
        <p className="journal-drawer-fx">
          {t(fx.mixed ? 'entry.fx.mixed' : 'entry.fx.note', {
            amount: formatMoney(fx.transactionDebitMinor, fx.currency),
            rate: fx.rate,
            base: formatMoney(fx.baseDebitMinor, fx.baseCurrency ?? baseCurrency),
          })}
        </p>
      )}
      {denied && (
        <p role="alert" className="journal-drawer-requires">
          <span aria-hidden="true">! </span>
          {t('entry.permissionDenied')}
        </p>
      )}
      {!canPost && (
        <p className="journal-drawer-requires">
          <span aria-hidden="true">! </span>
          {t('entry.requiresBookkeeper')}
        </p>
      )}
      {refusal}
      {entryId !== undefined && workspaceId !== null && (
        <LinkedFiles workspaceId={workspaceId} entityKind="journal_entry" entityId={entryId} />
      )}
    </div>
  );

  return (
    <>
      <DetailDrawer
        open
        onClose={linkFailure !== null ? onClose : requestClose}
        title={t(titleKey)}
        closeLabel={t('entry.close')}
        // K-30: the composer is a grid, so it takes the wide drawer (720px); a posted entry read in view
        // mode keeps the default width.
        width={editable ? 'wide' : 'default'}
        trapActive={!confirmReverse && !confirmDelete && !confirmDiscard}
        provenance={provenance}
        footer={
          loading ? undefined : loadErr !== null ? (
            /* The way out of a refused read (an id this book does not hold): close, back to the journal. */
            <div className="journal-drawer-actions">
              <span className="journal-spacer" />
              <button type="button" className="btn btn--secondary" onClick={onClose}>
                {t('entry.close')}
              </button>
            </div>
          ) : (
            footerActions
          )
        }
      >
        {loading ? (
          <Skeleton rows={4} height={32} />
        ) : loadErr !== null ? (
          <ErrorBanner
            error={loadErr}
            context="read"
            {...(loadErr.error === 'not_found' ? { message: t('entry.notFound') } : {})}
          />
        ) : linkFailure !== null ? (
          linkFailureBody
        ) : mode === 'view' ? (
          viewBody
        ) : (
          composerBody
        )}
      </DetailDrawer>
      {/* The reverse confirm is the shared Modal as an alertdialog OVER the drawer, rendered as a sibling
          so the drawer's slide-in transform never becomes its containing block. */}
      <Modal
        open={confirmReverse}
        onClose={() => setConfirmReverse(false)}
        role={ALERT_DIALOG}
        title={t('entry.reverseConfirmTitle')}
        closeLabel={t('entry.close')}
        describedById="entry-reverse-confirm-body"
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setConfirmReverse(false)}>
              {t('entry.cancel')}
            </button>
            <button type="button" className="btn btn--danger" disabled={busy} onClick={submitReverse}>
              {t('entry.reverseConfirmAction')}
            </button>
          </>
        }
      >
        <p id="entry-reverse-confirm-body" className="journal-drawer-confirm-body">
          {t('entry.reverseConfirmBody')}
        </p>
        {/* C4: the SAME consequence sentence a human confirming here and an approver clearing an agent's
            drafted reversal both read. */}
        <ConsequenceLine verb="reverse_entry" />
      </Modal>
      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        role={ALERT_DIALOG}
        title={t('entry.deleteConfirmTitle')}
        closeLabel={t('entry.close')}
        describedById="entry-delete-confirm-body"
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setConfirmDelete(false)}>
              {t('entry.cancel')}
            </button>
            <button type="button" className="btn btn--danger" disabled={busy} onClick={submitDelete}>
              {t('entry.deleteConfirmAction')}
            </button>
          </>
        }
      >
        <p id="entry-delete-confirm-body" className="journal-drawer-confirm-body">
          {t('entry.deleteConfirmBody')}
        </p>
      </Modal>
      {/* K-29: a composer holding typed input asks before it is thrown away. "Weiter bearbeiten" is the safe
          answer and takes the first focus; the drawer and every typed line stay. */}
      <Modal
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        role={ALERT_DIALOG}
        title={t('entry.discardConfirmTitle')}
        closeLabel={t('entry.close')}
        describedById="entry-discard-confirm-body"
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setConfirmDiscard(false)}>
              {t('entry.discardConfirmKeep')}
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => {
                setConfirmDiscard(false);
                onClose();
              }}
            >
              {t('entry.discardConfirmAction')}
            </button>
          </>
        }
      >
        <p id="entry-discard-confirm-body" className="journal-drawer-confirm-body">
          {t('entry.discardConfirmBody')}
        </p>
      </Modal>
    </>
  );
}
