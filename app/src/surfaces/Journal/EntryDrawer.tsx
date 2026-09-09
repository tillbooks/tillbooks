/**
 * EntryDrawer: compose, post, draft, view, and reverse a double-entry journal entry (A02 §6).
 *
 * The one drawer serves three modes: `create` (blank compose), `edit` (a mutable draft), and `view`
 * (a posted, immutable entry that offers ONLY Reverse, never an edit or delete). Balance is validated
 * client-side (debits must equal credits) before Post is enabled, and the engine re-checks it, so an
 * engine rejection is surfaced inline rather than thrown. Every write carries a fresh idempotency key
 * (SH-IDEMPOTENT). Amounts are integer minor units (Rappen) throughout; money renders via formatMoney.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err, type Result } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatMoney, formatDate } from '../../i18n';
import { Skeleton, ErrorBanner } from '../../components/states';
import { OverflowMenu } from '../../components/OverflowMenu';
import { AccountCombobox } from '../../components/AccountCombobox';
import { DetailDrawer } from '../../components/DetailDrawer';
import { Provenance, type ProvenanceOrigin } from '../../components/Provenance';
import { ConsequenceLine } from '../../components/ConsequenceLine';
import { useFocusTrap } from '../../components/useFocusTrap';
import type { Account, CostCenter, DrawerMode, EntryLine, JournalEntry, TaxCode } from './types';
import { parseAmountToMinor, newIdempotencyKey, fxDisclosureOf } from './money';
import { TaxCodePicker } from '../Vat/TaxCodePicker';
import { LineVatReadout } from '../Vat/LineVatReadout';
import { VatSummary } from '../Vat/VatSummary';
import type { LineVat } from '../Vat/types';
import { summariseVat, contributionOf } from '../Vat/summary';
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

/** A composing line: amounts are raw decimal strings until parsed to Rappen at submit/balance time. */
interface DraftLine {
  key: string;
  account: string;
  debit: string;
  credit: string;
  costCenter: string;
  taxCode: string;
}

/**
 * The KMU VAT accounts (A06 spec §3: 2200 Umsatzsteuer, 1170/1171 Vorsteuer). The §H-VAT-TRACE tag
 * belongs on the BASE line (revenue/expense) whose amount is the tax base, never on the VAT account
 * itself: a tag there double-counts the figure in the summary and posts a trace the engine's B2
 * gate rejects. The one exception is an import code, whose assessed-tax line on 1170/1171 IS the
 * line the trace describes.
 */
const VAT_ACCOUNT_NUMBERS: ReadonlySet<string> = new Set(['2200', '1170', '1171']);

let lineSeq = 0;
function blankLine(): DraftLine {
  lineSeq += 1;
  return { key: `l${lineSeq}`, account: '', debit: '', credit: '', costCenter: '', taxCode: '' };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
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

function lineFrom(line: EntryLine): DraftLine {
  lineSeq += 1;
  const toStr = (minor?: number | null) =>
    typeof minor === 'number' && minor > 0 ? (minor / 100).toFixed(2) : '';
  return {
    key: `l${lineSeq}`,
    account: line.account,
    debit: toStr(line.debit),
    credit: toStr(line.credit),
    costCenter: line.costCenter ?? '',
    taxCode: line.taxCode ?? '',
  };
}

export function EntryDrawer({ mode, entryId, canPost, onClose, onWritten }: EntryDrawerProps) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();

  const editable = mode === 'create' || mode === 'edit';

  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [taxCodes, setTaxCodes] = useState<TaxCode[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  // A11-G2: the currency the BOOKS are kept in, from the company profile, exactly as DocumentEditor
  // reads it. The drawer composes an entry with no currency of its own, so `postEntry` resolves
  // `baseCurrencyOf(ctx)` and every figure previewed here is a base-currency figure. That is not a
  // synonym for CHF: a workspace's base currency is a setting, and the VAT controls used to label
  // these figures francs because `formatMoney` defaults to CHF when handed no currency. The initial
  // value is the overwhelmingly common one and is replaced by the engine's answer, never trusted
  // over it.
  //
  // It names THREE kinds of figure in this drawer, and all three are base-currency figures for the
  // same reason: the balance totals and the difference (composed lines, booked in the base) and the
  // two figures in the `vat_trace_unreconciled` refusal (the engine's own reconciliation of THIS
  // post). All three belong to a COMPOSED entry, which has no lines to read a label off yet, so the
  // profile is the only source there.
  //
  // It used to name a fourth: the base half of the FX disclosure. `get_entry` now sends
  // `baseCurrency` beside `base_debit_minor`, so that figure is denominated by its own line and this
  // value is only its fallback. It never names a `debit`/`credit`: those are TRANSACTION amounts and
  // carry their own `currency` per line.
  const [baseCurrency, setBaseCurrency] = useState('CHF');
  const [entry, setEntry] = useState<JournalEntry | null>(null);
  // C3 / F-08 (J5.4): the A35 session this posting came from, when the trace holds one. Resolved by
  // `list_agent_sessions { entityRef }` on view, so the provenance line can link INTO the conversation
  // in one click instead of sending the person to /agent to find the session by date. Null when the
  // trace holds nothing (a human posting) or the read fails: no link is ever invented.
  const [traceSessionId, setTraceSessionId] = useState<string | null>(null);
  const [viewLines, setViewLines] = useState<EntryLine[]>([]);
  const [loadErr, setLoadErr] = useState<Err | null>(null);
  const [loading, setLoading] = useState(true);

  const [date, setDate] = useState(todayIso());
  const [ref, setRef] = useState('');
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<DraftLine[]>(() => [blankLine(), blankLine()]);

  const [writeErr, setWriteErr] = useState<Err | null>(null);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  // Per-line VAT, keyed by the composing line's key, computed via `vat_preview` (the SAME
  // computeLineTax the agent calls: one code path, US-A06.7). Drives the readout, the summary, and
  // the frozen trace stamped at post time.
  const [lineVats, setLineVats] = useState<Record<string, LineVat>>({});
  // B3 defence in depth: true while a `vat_preview` round-trip is in flight for the CURRENT line
  // state. Post holds until it settles, so an eager click can never carry a stale figure (the
  // engine recomputes and rejects server-side regardless; this keeps the GUI honest first).
  const [vatPending, setVatPending] = useState(false);
  // Reversal posts real money into the books, so it is never one click away: the button opens this
  // confirm, and only the confirm's own action calls `reverse_entry`.
  const [confirmReverse, setConfirmReverse] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  // Deleting a draft is irreversible (the row and its lines are gone), so it too opens a confirm
  // rather than firing straight off the overflow item. It touches no books, so the copy is lighter
  // than the reversal's, but the guard against a stray click is the same.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const confirmDeleteRef = useRef<HTMLDivElement>(null);

  // Load pickers and (for edit/view) the entry once, on open. A null workspace cannot resolve a ctx
  // verb, so the drawer simply reports the missing entry rather than calling with a blank tenant.
  useEffect(() => {
    let live = true;
    async function load() {
      if (workspaceId === null) {
        if (live) setLoading(false);
        return;
      }
      const reads: Promise<void>[] = [];
      reads.push(
        client.call('list_accounts', { workspaceId }).then(({ body }) => {
          if (live && body.ok) setAccounts((body.accounts as Account[]) ?? []);
        }),
      );
      // UNCONDITIONAL, and that is the fix rather than a tidy-up. This read used to sit inside the
      // `editable` branch below, so a POSTED entry, the one mode where the FX disclosure renders at
      // all, never asked what the books are kept in and labelled its base figure from the initial
      // CHF. A EUR-base workspace then read "USD 1'000.00 at rate 0.86 is CHF 860.00 in the books"
      // on an immutable record: the engine's own number under a currency those books have never
      // held.
      //
      // The profile answers `{ok, profile: {...}}`: the wrapper, not the profile itself. Reading
      // `body.baseCurrency` here would be the assumed-shape bug family again (four Studio defects
      // have shipped from a key the engine never sent). A failed read leaves the initial value
      // rather than blanking the labels: a drawer that cannot name its currency is worse than one
      // naming the common one, and the engine still owns the posting either way.
      reads.push(
        client.call('get_company_profile', { workspaceId }).then(({ body }) => {
          if (!live || isErr(body)) return;
          const profile = body.profile as { baseCurrency?: string | null } | undefined;
          const base = profile?.baseCurrency ?? null;
          if (base !== null && base !== '') setBaseCurrency(base);
        }),
      );
      if (editable) {
        reads.push(
          client.call('vat_codes', { workspaceId }).then(({ body }) => {
            if (live && body.ok) setTaxCodes((body.taxCodes as TaxCode[]) ?? []);
          }),
        );
        reads.push(
          client.call('list_cost_centers', { workspaceId }).then(({ body }) => {
            if (live && body.ok) setCostCenters((body.costCenters as CostCenter[]) ?? []);
          }),
        );
      }
      if ((mode === 'edit' || mode === 'view') && entryId !== undefined) {
        reads.push(
          client.call('get_entry', { workspaceId, entryId }).then(({ body }) => {
            if (!live) return;
            if (isErr(body)) {
              setLoadErr(body);
              return;
            }
            const e = body.entry as JournalEntry;
            const es = (body.lines as EntryLine[]) ?? [];
            setEntry(e);
            setViewLines(es);
            setDate(e.date);
            setRef(e.ref ?? '');
            setDescription(e.description ?? '');
            if (mode === 'edit') setLines(es.length > 0 ? es.map(lineFrom) : [blankLine(), blankLine()]);
          }),
        );
      }
      if (mode === 'view' && entryId !== undefined) {
        // The trace read rides beside `get_entry`, never in front of it: a failed or absent trace
        // answer costs the link and nothing else (the drawer renders the entry regardless).
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
      if (live) setLoading(false);
    }
    void load();
    return () => {
      live = false;
    };
    // Load-on-open only: the identity inputs are stable for the drawer's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The reverse confirm is a nested dialog OVER the DetailDrawer. Its own focus trap seeds focus into
  // it and closes it on Escape, while the drawer's trap is switched off (`trapActive={!confirmReverse}`)
  // so Escape backs out of the confirm first and never doubles as "close and forget" (A06-G4). The
  // DetailDrawer owns focus, Escape and the scrim for the drawer itself, so the hand-rolled dialog
  // chrome, the manual open-focus and the post-error refocus this surface carried are all gone.
  useFocusTrap(confirmRef, {
    onEscape: () => setConfirmReverse(false),
    active: confirmReverse,
  });

  // The delete confirm is the same nested-dialog shape as the reverse confirm: its own trap seeds
  // focus and owns Escape while the drawer's trap steps aside.
  useFocusTrap(confirmDeleteRef, {
    onEscape: () => setConfirmDelete(false),
    active: confirmDelete,
  });

  const accountsById = useMemo(() => {
    const map = new Map<string, Account>();
    for (const a of accounts ?? []) map.set(a.id, a);
    return map;
  }, [accounts]);

  const accountLabel = useCallback(
    (id: string) => {
      const a = accountsById.get(id);
      return a ? `${a.number} ${a.name}` : id;
    },
    [accountsById],
  );

  // --- A06 M5: steer the VAT tag to the base line ----------------------------------------------
  const isVatAccount = useCallback(
    (accountId: string) => {
      const a = accountsById.get(accountId);
      return a !== undefined && VAT_ACCOUNT_NUMBERS.has(a.number);
    },
    [accountsById],
  );

  /** A non-import tag left on a VAT-account line (the account changed after tagging): flagged,
   *  excluded from preview and summary, and it blocks Post. */
  const strandedVatTag = useCallback(
    (l: DraftLine) => {
      if (l.taxCode === '' || !isVatAccount(l.account)) return false;
      const kind = taxCodes.find((c) => c.code === l.taxCode)?.kind;
      return kind !== undefined && kind !== 'import';
    },
    [isVatAccount, taxCodes],
  );

  /** A tagged code that is not among the active codes (archived or unknown). The picker flags it
   *  inline (M35); the engine rejects it at post (`archived_tax_code`), so we hold Post here rather
   *  than let a click land on a code the money path will refuse. */
  const codeInvalid = useCallback(
    (l: DraftLine) => l.taxCode !== '' && !taxCodes.some((c) => c.code === l.taxCode),
    [taxCodes],
  );

  // --- Balance maths (Rappen) ------------------------------------------------------------------
  const parsed = lines.map((l) => ({
    line: l,
    debitMinor: parseAmountToMinor(l.debit),
    creditMinor: parseAmountToMinor(l.credit),
  }));
  const debitTotal = parsed.reduce((s, p) => s + (p.debitMinor ?? 0), 0);
  const creditTotal = parsed.reduce((s, p) => s + (p.creditMinor ?? 0), 0);
  const difference = debitTotal - creditTotal;
  const balanced = debitTotal > 0 && difference === 0;

  // What the posted rows say about currency. Null for a base-currency entry, and null in `create`
  // mode too: a line being composed has no rate yet, and the engine resolves one at post time.
  const fx = useMemo(() => fxDisclosureOf(viewLines), [viewLines]);

  const nonEmpty = parsed.filter(
    (p) => p.line.account !== '' || p.line.debit !== '' || p.line.credit !== '',
  );
  const oneSide = (p: (typeof parsed)[number]) =>
    ((p.debitMinor ?? 0) > 0) !== ((p.creditMinor ?? 0) > 0);
  const allLinesValid = nonEmpty.every((p) => p.line.account !== '' && oneSide(p));

  const hasStrandedVatTag = lines.some(strandedVatTag);
  const hasInvalidCode = lines.some(codeInvalid);
  const effectiveCanPost = canPost && !denied;
  const canSubmitPost =
    effectiveCanPost &&
    balanced &&
    allLinesValid &&
    nonEmpty.length >= 2 &&
    !busy &&
    // B3: never post over an in-flight preview; M5: never post a tag stranded on a VAT account;
    // M35/C3: never post a line carrying an archived or unknown code (the engine rejects it).
    !vatPending &&
    !hasStrandedVatTag &&
    !hasInvalidCode;
  const canSaveDraft = effectiveCanPost && !busy && nonEmpty.some((p) => p.line.account !== '');

  // --- A06 VAT: per-line preview + document summary --------------------------------------------
  // A registered workspace always seeds codes, so an empty active list means MWST is not configured
  // (P9): the picker shows a banner-CTA into /vat rather than a dropdown that could post untaxed.
  const needsVatConfig = editable && !loading && loadErr === null && taxCodes.length === 0;
  // A persona without the posting scope sees the tax control and summary as read-only text.
  const vatReadOnly = !effectiveCanPost;

  /** The base amount of a line: the positive side (debit or credit). Zero means nothing to preview. */
  const lineAmountMinor = useCallback((l: DraftLine): number => {
    const dm = parseAmountToMinor(l.debit) ?? 0;
    const cm = parseAmountToMinor(l.credit) ?? 0;
    return dm > 0 ? dm : cm;
  }, []);

  // Recompute the previews whenever a line's code, account, or amount, or the supply date, changes.
  // Keyed on a compact signature so a keystroke that changes nothing VAT-relevant does not refetch.
  // The account is part of the signature because it decides the M5 stranded-tag exclusion.
  const vatSignature = lines
    .map((l) => `${l.key}:${l.account}:${l.taxCode}:${lineAmountMinor(l)}`)
    .join('|') + `#${date}`;
  useEffect(() => {
    if (!editable || workspaceId === null) {
      setLineVats({});
      setVatPending(false);
      return;
    }
    // The lines that have something to ask about, decided BEFORE anything goes in flight.
    //
    // Doing this first is what keeps the pending flag honest. The effect is keyed on a signature
    // that includes each line's amount, so it re-runs on every keystroke of an amount field. When
    // no line carries a code there is nothing to preview, yet the old shape still set
    // `vatPending` true, awaited an empty `Promise.all`, and set it false again: two extra renders
    // of the whole drawer per character, and a `lineVats` object with a fresh identity each time,
    // which invalidated the `vatSummary` memo for good measure.
    //
    // The visible half of that was worse than the cost. `vatPending` disables Post, so composing an
    // ordinary untagged entry flickered Post disabled on every character typed into an amount. The
    // B3 hold is meant to name one specific state (figures in flight for the current lines), and a
    // flag that also blinks on unrelated typing is not naming it.
    const previewable = lines.filter(
      (l) => l.taxCode !== '' && !strandedVatTag(l) && lineAmountMinor(l) > 0,
    );
    if (previewable.length === 0) {
      // Settled synchronously, because it IS settled: no round trip can change an empty answer.
      // The identity guard keeps the memo below stable on the common path of typing an amount.
      setLineVats((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      setVatPending(false);
      return;
    }
    let live = true;
    // In flight until THIS run settles; a superseded run (live=false) never clears the flag, so
    // Post stays held until the figures match the latest line state (B3).
    setVatPending(true);
    async function run() {
      const results: Record<string, LineVat> = {};
      await Promise.all(
        previewable.map(async (l) => {
          const amountMinor = lineAmountMinor(l);
          const { body } = await client.call('vat_preview', {
            workspaceId,
            amountMinor,
            amountIsGross: false,
            taxCode: l.taxCode,
            supplyDate: date,
          });
          results[l.key] = body as LineVat;
        }),
      );
      if (live) {
        setLineVats(results);
        setVatPending(false);
      }
    }
    void run();
    return () => {
      live = false;
    };
    // Keyed on the compact VAT signature; the client / workspace are stable for the drawer's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vatSignature]);

  const vatSummary = useMemo(() => {
    const contribs = lines
      .map((l) => contributionOf(lineVats[l.key]))
      .filter((c): c is NonNullable<typeof c> => c !== null);
    return summariseVat(contribs);
  }, [lines, lineVats]);

  // --- Write handlers --------------------------------------------------------------------------
  const settle = useCallback(
    (body: Result) => {
      if (isErr(body)) {
        if (body.error === 'permission_denied') setDenied(true);
        else setWriteErr(body);
        // A rejected write disables the Post button while it was in flight, so the browser can drop
        // focus to <body>. No manual refocus is needed any more: DetailDrawer's `useFocusTrap` binds
        // Escape and Tab at the document level, so a keyboard user is pulled straight back into the
        // drawer regardless of where focus lands (A06-G4).
        return false;
      }
      const entryId = (body as { entryId?: unknown }).entryId;
      onWritten(typeof entryId === 'string' ? entryId : undefined);
      onClose();
      return true;
    },
    [onClose, onWritten],
  );

  // Map the composing lines to the engine line shape: account plus at most one positive amount,
  // and the optional cost centre / tax code. A draft may still be incomplete; the engine allows it.
  function buildLines() {
    return nonEmpty
      .filter((p) => p.line.account !== '')
      .map((p) => {
        const out: Record<string, unknown> = { account: p.line.account };
        if ((p.debitMinor ?? 0) > 0) out.debit = p.debitMinor;
        if ((p.creditMinor ?? 0) > 0) out.credit = p.creditMinor;
        if (p.line.costCenter !== '') out.costCenter = p.line.costCenter;
        if (p.line.taxCode !== '') {
          out.taxCode = p.line.taxCode;
          // F2: the post boundary recomputes at the line's Leistungsdatum, so send the SAME supply
          // date the vat_preview above was asked with. The drawer has no separate supply-date field
          // yet, so that is the entry date: identical figures, endorsed by construction.
          out.supplyDate = date;
          // Freeze the §H-VAT-TRACE via A06 (the cached vat_preview result, one code path): the base
          // and tax A07 reads without recomputing. No second posting path: post_entry persists these
          // trace columns, the accountant's own lines keep the entry balanced.
          const vat = lineVats[p.line.key];
          if (vat !== undefined && vat.ok === true) {
            if (vat.trace.taxBaseMinor !== null) out.taxBase = vat.trace.taxBaseMinor;
            if (vat.trace.taxAmountMinor !== null) out.taxAmount = vat.trace.taxAmountMinor;
          }
        }
        return out;
      });
  }

  async function submitPost() {
    if (workspaceId === null || !canSubmitPost) return;
    setBusy(true);
    setWriteErr(null);
    const input: Record<string, unknown> = {
      workspaceId,
      date,
      lines: buildLines(),
      source: 'manual',
      idempotencyKey: newIdempotencyKey(),
    };
    if (mode === 'edit' && entryId !== undefined) input.entryId = entryId;
    if (ref !== '') input.ref = ref;
    if (description !== '') input.description = description;
    const { body } = await client.call('post_entry', input);
    setBusy(false);
    settle(body);
  }

  async function submitDraft() {
    if (workspaceId === null || !canSaveDraft) return;
    setBusy(true);
    setWriteErr(null);
    const input: Record<string, unknown> = {
      workspaceId,
      date,
      lines: buildLines(),
      idempotencyKey: newIdempotencyKey(),
    };
    if (mode === 'edit' && entryId !== undefined) input.entryId = entryId;
    if (ref !== '') input.ref = ref;
    if (description !== '') input.description = description;
    const { body } = await client.call('save_draft', input);
    setBusy(false);
    settle(body);
  }

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

  const titleKey =
    mode === 'create' ? 'entry.newTitle' : mode === 'edit' ? 'entry.editTitle' : 'entry.viewTitle';

  function updateLine(key: string, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  // C3: the quiet provenance line for a posted, viewed entry, from the read model's own header
  // (`get_entry` sends `source`, `createdBy`, `createdAt`). Skipped when there is no timestamp, so
  // nothing is fabricated. It rides the DetailDrawer's dedicated provenance slot, below the body.
  //
  // F-08 (J5.4): `traceHref` links into the A35 session whose trace created or approved this entry
  // (D118 C3: "a link into the A35 trace when a trace exists"); a human posting has none. The
  // parenthetical act is the source word for a human or imported row; an agent row names the agent in
  // words already, and repeating the raw source label in brackets after it was the J5 friction.
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

  // The action row, pinned to the DetailDrawer foot below the scrolling body. Rendered only once the
  // entry has loaded: a skeleton or a load error has nothing to post, reverse or cancel.
  const footerActions = (
    <div className="journal-drawer-actions">
      {/* D15/C2: the hand-rolled overflow that lived here is now the shared OverflowMenu, so this
          menu inherits the full APG keyboard model (roving focus, Home/End, Escape back to the
          trigger) instead of a click-only toggle. */}
      {mode === 'edit' && (
        <OverflowMenu
          label={t('entry.more')}
          disabled={!effectiveCanPost || busy}
          items={[
            { key: 'delete', label: t('entry.delete'), onSelect: () => setConfirmDelete(true), danger: true },
          ]}
        />
      )}
      <span className="journal-spacer" />
      {/* A view-only dialog has nothing to cancel: it closes. Compose/edit keeps "Abbrechen",
          where there really are unsaved changes to abandon. */}
      <button type="button" className="btn btn--secondary" onClick={onClose}>
        {mode === 'view' ? t('entry.close') : t('entry.cancel')}
      </button>
      {mode === 'view' ? (
        /* Never `.btn--primary`: a solid accent fill invites the careless click, and this
           action posts money. The danger outline states the weight without shouting. */
        <button
          type="button"
          className="btn btn--danger"
          disabled={!effectiveCanPost || busy}
          title={!canPost ? t('entry.requiresBookkeeper') : undefined}
          onClick={() => setConfirmReverse(true)}
        >
          {t('entry.reverse')}
        </button>
      ) : (
        <>
          <button
            type="button"
            className="btn btn--secondary"
            disabled={!canSaveDraft}
            title={!canPost ? t('entry.requiresBookkeeper') : undefined}
            onClick={submitDraft}
          >
            {t('entry.saveDraft')}
          </button>
          {/* `.btn--accent`, never `.btn--primary`: this posts money into an append-only ledger,
              and a solid accent fill invites the careless click. The tint plus outline still reads
              as the go action without shouting. */}
          <button
            type="button"
            className="btn btn--accent"
            disabled={!canSubmitPost}
            title={!canPost ? t('entry.requiresBookkeeper') : undefined}
            onClick={submitPost}
          >
            {t('entry.post')}
          </button>
        </>
      )}
    </div>
  );

  return (
    <>
      <DetailDrawer
        open
        onClose={onClose}
        title={t(titleKey)}
        closeLabel={t('entry.close')}
        // A nested confirm (reverse or delete) owns focus and Escape while open, so the drawer stands
        // down (A06-G4); flipped back when the confirm closes.
        trapActive={!confirmReverse && !confirmDelete}
        provenance={provenance}
        footer={loading || loadErr !== null ? undefined : footerActions}
      >
        {loading ? (
          <Skeleton rows={4} height={32} />
        ) : loadErr !== null ? (
          <ErrorBanner error={loadErr} />
        ) : (
          <div className="journal-drawer-body-spacing">
            {mode === 'view' && entry?.reversesEntryId != null && (
              <p className="journal-drawer-hint">{t('entry.reversalOf')}</p>
            )}

            <div className="journal-drawer-meta">
              <label className="journal-field">
                {t('entry.date')}
                {editable ? (
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    aria-label={t('entry.date')}
                  />
                ) : (
                  <span>{formatDate(date)}</span>
                )}
              </label>
              <label className="journal-field">
                {t('entry.ref')}
                {editable ? (
                  <input
                    type="text"
                    value={ref}
                    onChange={(e) => setRef(e.target.value)}
                    aria-label={t('entry.ref')}
                  />
                ) : (
                  <span>{ref}</span>
                )}
              </label>
              <label className="journal-field" style={{ flexBasis: '100%' }}>
                {t('entry.description')}
                {editable ? (
                  <input
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    aria-label={t('entry.description')}
                  />
                ) : (
                  <span>{description}</span>
                )}
              </label>
            </div>

            {editable ? (
              <table className="journal-drawer-lines">
                <caption className="visually-hidden">{t('entry.lines')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('entry.account')}</th>
                    <th scope="col">{t('entry.debit')}</th>
                    <th scope="col">
                      <span className="journal-drawer-credit-mark" aria-hidden="true">
                        -{' '}
                      </span>
                      {t('entry.credit')}
                    </th>
                    <th scope="col">{t('entry.costCenter')}</th>
                    <th scope="col">{t('entry.taxCode')}</th>
                    <th scope="col">
                      <span className="visually-hidden">{t('entry.addLine')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={l.key}>
                      <td>
                        {/* F-03 (J3.7): a typeable combobox, keyboard-first ("6500", Enter, Tab on),
                            in place of the native select that cost two clicks and could not take
                            the account number. */}
                        <AccountCombobox
                          id={`entry-account-${l.key}`}
                          ariaLabel={`${t('entry.account')} ${i + 1}`}
                          accounts={accounts ?? []}
                          value={l.account}
                          onChange={(account) => updateLine(l.key, { account })}
                          placeholder={t('entry.selectAccount')}
                          noMatchLabel={t('entry.noAccountMatch')}
                        />
                      </td>
                      <td className="journal-drawer-amount">
                        <input
                          type="text"
                          inputMode="decimal"
                          aria-label={`${t('entry.debit')} ${i + 1}`}
                          value={l.debit}
                          onChange={(e) => updateLine(l.key, { debit: e.target.value, credit: '' })}
                        />
                      </td>
                      <td className="journal-drawer-amount">
                        <input
                          type="text"
                          inputMode="decimal"
                          aria-label={`${t('entry.credit')} ${i + 1}`}
                          value={l.credit}
                          onChange={(e) => updateLine(l.key, { credit: e.target.value, debit: '' })}
                        />
                      </td>
                      <td>
                        <select
                          aria-label={`${t('entry.costCenter')} ${i + 1}`}
                          value={l.costCenter}
                          onChange={(e) => updateLine(l.key, { costCenter: e.target.value })}
                        >
                          <option value="">{t('entry.none')}</option>
                          {costCenters.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.code} {c.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <TaxCodePicker
                          id={`vat-code-${l.key}`}
                          ariaLabel={`${t('entry.taxCode')} ${i + 1}`}
                          // M5: a VAT-account line (2200/1170/1171) offers import codes only; the
                          // trace belongs on the base line, and 1170 only carries it for an
                          // assessed import tax.
                          codes={
                            isVatAccount(l.account)
                              ? taxCodes.filter((c) => c.kind === 'import')
                              : taxCodes
                          }
                          value={l.taxCode}
                          onChange={(code) => updateLine(l.key, { taxCode: code })}
                          disabled={loading}
                          readOnly={vatReadOnly}
                          needsConfig={needsVatConfig}
                          invalidCode={codeInvalid(l)}
                          strandedOnVatAccount={strandedVatTag(l)}
                        />
                        {/* Suppress the figure readout on a flagged line: the picker already shows
                            the archived/unknown reason, and `vat_preview` still returns live figures
                            for an archived code (it does not filter `active`), so showing them next
                            to the flag is a mixed signal (A06-G3). */}
                        {!codeInvalid(l) && <LineVatReadout vat={lineVats[l.key]} currency={baseCurrency} />}
                      </td>
                      <td>
                        {lines.length > 2 && (
                          <button
                            type="button"
                            className="journal-drawer-line-remove"
                            aria-label={t('entry.removeLine', { number: i + 1 })}
                            onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                          >
                            <span aria-hidden="true">x</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="journal-drawer-lines">
                <caption className="visually-hidden">{t('entry.lines')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('entry.account')}</th>
                    <th scope="col">{t('entry.debit')}</th>
                    <th scope="col">{t('entry.credit')}</th>
                  </tr>
                </thead>
                <tbody>
                  {viewLines.map((l, i) => (
                    <tr key={l.id ?? i}>
                      <td>{accountLabel(l.account)}</td>
                      {/* §H-FX: the line's OWN currency, never a hardcoded CHF. `debit` is the
                          transaction amount, so labelling a EUR figure CHF put the wrong number and
                          the wrong unit on screen at once. `journal_line.currency` is `TEXT NOT
                          NULL` with no default, so a line the ENGINE sent always names it; the
                          fallback is for a client-composed row that has never been near the engine,
                          and it falls back to the workspace base currency rather than to CHF,
                          because that is what such a row would post as. */}
                      <td className="journal-drawer-view-amount">
                        {typeof l.debit === 'number' && l.debit > 0
                          ? formatMoney(l.debit, l.currency ?? baseCurrency)
                          : ''}
                      </td>
                      <td className="journal-drawer-view-amount">
                        {typeof l.credit === 'number' && l.credit > 0
                          ? formatMoney(l.credit, l.currency ?? baseCurrency)
                          : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {/* The books are kept in the base currency, so a converted entry has to say what it
                became there and at which rate, or the reader is left to guess whether the figures
                above are the transaction or the booking. Shown only when there is a conversion:
                `fxRate` is null for a base-currency entry, and disclosing a rate of 1 would make
                every ordinary entry look like an FX one. */}
            {fx !== null && (
              <p className="journal-drawer-fx">
                {t(fx.mixed ? 'entry.fx.mixed' : 'entry.fx.note', {
                  amount: formatMoney(fx.transactionDebitMinor, fx.currency),
                  rate: fx.rate,
                  // The two halves are in DIFFERENT currencies, which is the whole point of the
                  // sentence. Both labels now come off the LINES: `fx.currency` denominates the
                  // transaction figure and `fx.baseCurrency` denominates `SUM(base_debit_minor)`,
                  // so the label travels in the same response as the number it names and the two
                  // cannot come apart. That is the fix for the shape that let this note read
                  // "is CHF 860.00 in the books" on a posted EUR-base entry. The profile read stays
                  // as the fallback (and for compose mode, which has no lines yet), never a literal.
                  base: formatMoney(fx.baseDebitMinor, fx.baseCurrency ?? baseCurrency),
                })}
              </p>
            )}

            {editable && (
              <>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => setLines((prev) => [...prev, blankLine()])}
                >
                  {t('entry.addLine')}
                </button>
                {/* S10, the per-document VAT summary, above the balance panel. Reconciles to the
                    line readouts to the Rappen; an all-untaxed entry reads the honest empty. */}
                <VatSummary summary={vatSummary} currency={baseCurrency} />
                {/* The composed totals. `submitPost` sends no `currency`, so `postEntry` books this
                    entry in `baseCurrencyOf(ctx)`: these three figures are base-currency figures,
                    and the base currency is a setting rather than a synonym for CHF. */}
                <dl className="journal-drawer-balance">
                  <div>
                    <dt>{t('entry.debitTotal')}</dt>
                    <dd>{formatMoney(debitTotal, baseCurrency)}</dd>
                  </div>
                  <div>
                    <dt>{t('entry.creditTotal')}</dt>
                    <dd>{formatMoney(creditTotal, baseCurrency)}</dd>
                  </div>
                  <div>
                    <dt>{t('entry.balanced')}</dt>
                    <dd className={balanced ? 'journal-drawer-balanced' : 'journal-drawer-unbalanced'}>
                      {balanced
                        ? t('entry.balanced')
                        : difference !== 0 || debitTotal > 0 || creditTotal > 0
                          ? t('entry.unbalanced', {
                              difference: formatMoney(Math.abs(difference), baseCurrency),
                            })
                          : ''}
                    </dd>
                  </div>
                </dl>
              </>
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
            {writeErr !== null && writeErr.error === 'period_locked' ? (
              <div className="error-banner panel" role="alert">
                <span aria-hidden="true">! </span>
                <div>
                  <p className="error-body">{t('entry.periodLocked')}</p>
                  <Link to="/periods">{t('entry.periodLockedLink')}</Link>
                </div>
              </div>
            ) : writeErr !== null && writeErr.error === 'vat_trace_unreconciled' ? (
              /* B2: the engine's reconciliation rejection, with the actual figures (expected vs
                 booked), never a raw error code or stack trace. Both figures are the engine's
                 reconciliation of the post THIS drawer just attempted, which carried no currency,
                 so both are in the base currency. Unlabelled they read as francs, and 81.00 against
                 76.24 mislabelled is the exact shape of the defect this pass exists for. */
              <div className="error-banner panel" role="alert">
                <span aria-hidden="true">! </span>
                <p className="error-body">
                  {t('entry.vatUnreconciled', {
                    expected: formatMoney(Number(writeErr.expectedMinor ?? 0), baseCurrency),
                    booked: formatMoney(Number(writeErr.bookedMinor ?? 0), baseCurrency),
                  })}
                </p>
              </div>
            ) : (
              writeErr !== null && <ErrorBanner error={writeErr} />
            )}
          </div>
        )}
      </DetailDrawer>
      {/* The reverse confirm is a nested dialog OVER the drawer, rendered as a sibling so the
          drawer's slide-in transform never becomes its containing block. Its own focus trap
          (above) owns focus and Escape while it is open. */}
      {confirmReverse && (
              <div
                className="journal-drawer-confirm-overlay"
                role="presentation"
                onClick={() => setConfirmReverse(false)}
              >
                <div
                  className="journal-drawer-confirm panel"
                  role="alertdialog"
                  aria-modal="true"
                  aria-labelledby="entry-reverse-confirm-title"
                  aria-describedby="entry-reverse-confirm-body"
                  ref={confirmRef}
                  tabIndex={-1}
                  onClick={(e) => e.stopPropagation()}
                >
                  <h3 id="entry-reverse-confirm-title" className="journal-drawer-confirm-title">
                    {t('entry.reverseConfirmTitle')}
                  </h3>
                  <p id="entry-reverse-confirm-body" className="journal-drawer-confirm-body">
                    {t('entry.reverseConfirmBody')}
                  </p>
                  {/* C4: the SAME consequence sentence a human confirming here and an approver
                      clearing an agent's drafted reversal both read. `reverse_entry` is dial-governed
                      (`post`), so the line renders; ConsequenceLine returns null for a verb that is
                      not, so no sentence is ever invented. */}
                  <ConsequenceLine verb="reverse_entry" />
                  <div className="journal-drawer-confirm-foot">
                    <button
                      type="button"
                      className="btn btn--secondary"
                      onClick={() => setConfirmReverse(false)}
                    >
                      {t('entry.cancel')}
                    </button>
                    <button
                      type="button"
                      className="btn btn--danger"
                      disabled={busy}
                      onClick={submitReverse}
                    >
                      {t('entry.reverseConfirmAction')}
                    </button>
                  </div>
                </div>
              </div>
            )}
      {/* The delete confirm mirrors the reverse confirm's nested-dialog chrome. A draft delete is
          irreversible, so it is never one click off the overflow. */}
      {confirmDelete && (
              <div
                className="journal-drawer-confirm-overlay"
                role="presentation"
                onClick={() => setConfirmDelete(false)}
              >
                <div
                  className="journal-drawer-confirm panel"
                  role="alertdialog"
                  aria-modal="true"
                  aria-labelledby="entry-delete-confirm-title"
                  aria-describedby="entry-delete-confirm-body"
                  ref={confirmDeleteRef}
                  tabIndex={-1}
                  onClick={(e) => e.stopPropagation()}
                >
                  <h3 id="entry-delete-confirm-title" className="journal-drawer-confirm-title">
                    {t('entry.deleteConfirmTitle')}
                  </h3>
                  <p id="entry-delete-confirm-body" className="journal-drawer-confirm-body">
                    {t('entry.deleteConfirmBody')}
                  </p>
                  <div className="journal-drawer-confirm-foot">
                    <button
                      type="button"
                      className="btn btn--secondary"
                      onClick={() => setConfirmDelete(false)}
                    >
                      {t('entry.cancel')}
                    </button>
                    <button
                      type="button"
                      className="btn btn--danger"
                      disabled={busy}
                      onClick={submitDelete}
                    >
                      {t('entry.deleteConfirmAction')}
                    </button>
                  </div>
                </div>
              </div>
            )}
    </>
  );
}
