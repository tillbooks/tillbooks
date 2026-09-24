/**
 * A38, the accrual and provision editor: a drawer on `/periods` beside the month checklist, and the
 * draft LIST that is the ONE posting control on both faces (design doc S11/S12, S4/S5).
 *
 * WHAT IT DOES. Describes one Abgrenzung (OR 958b) or one Rückstellung (OR 960e) so the engine can
 * post it: kind or reason picker with a one-line explainer each, amount in francs, the contra account
 * from a closed list (recognition over recall), description, an optional source reference. The lines
 * the draft will carry render below AS YOU TYPE, with the reversal lines under "Rückbuchung am
 * {date}". "Entwurf speichern" writes a DRAFT (`accrual_create` / `provision_create`) and never posts.
 *
 * THE LIST POSTS. Every draft in the list carries "Buchen" behind the consequence confirm (D118 C4:
 * the engine's own sentence for `accrual_post` / `provision_post`), and "alle buchen" runs one call
 * per draft behind one confirm naming the count and the total, then reports a half-done state
 * honestly (posted, refused, remaining). A posted accrual offers "Rückgängig (Storno)"; a posted
 * provision with an open balance offers "Auflösen" (amount, date, target account, the release's
 * consequence). The success state is the posted row itself with both entry ids and the reversal
 * date: no toast.
 *
 * WHAT IT DOES NOT DO. It does not compute money: the amount is parsed to integer Rappen exactly and
 * handed to the engine, and every figure shown after a save is the engine's. It holds no rule the
 * engine does not hold: the preview mirrors the four statutory kinds (see `accrual-model.ts`), and
 * the engine refuses what the preview cannot know (a locked period, an archived account).
 *
 * STATES. loading (a skeleton over the list), empty ("Noch keine Abgrenzung erfasst" with the
 * editor as the first step), error (the banner with retry; a field refusal inline next to its
 * field), success (the posted row), permission-denied (the padlock naming `post`, the controls
 * disabled with the reason as text), at-scale (the list is a DataTable; twenty drafts render as
 * twenty rows with one "alle buchen").
 */
import { useCallback, useEffect, useId, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useCapabilities, CAP } from '../../lib/capabilities';
import { useT, formatDate, formatMoney } from '../../i18n';
import { EmptyState, ErrorBanner, Skeleton } from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import type { OverflowMenuItem } from '../../components/OverflowMenu';
import { Modal, type ModalRole } from '../../components/Modal';
import { ConsequenceLine } from '../../components/ConsequenceLine';
import { LockGlyph } from '../../components/states/glyphs';
import { Select } from '../../components/Select';
import {
  ACCRUAL_KINDS,
  ACCRUAL_KIND_RULES,
  PROVISION_REASONS,
  accrualRowsOf,
  isProvisionAccount,
  parseAmountToMinor,
  pickerAccountsOf,
  previewAccrualLines,
  previewProvisionLines,
  provisionRowsOf,
  dayAfter,
  type AccrualKind,
  type AccrualRow,
  type PickerAccount,
  type PreviewLine,
  type ProvisionReason,
  type ProvisionRow,
} from './accrual-model';

/** The consequential confirms are alertdialogs. A constant, so the modal-role guard reads it on Modal's own host. */
const ALERT_DIALOG: ModalRole = 'alertdialog';

export interface AccrualEditorProps {
  workspaceId: string;
  /** The ISO day the drafts are dated: the month end the checklist is closing, or a year end. */
  periodEnd: string;
  /** Override for tests and embedders; defaults to A24's answer for `post` from `whoami`. */
  canPost?: boolean;
}

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; error: Err }
  | { kind: 'ok'; accruals: AccrualRow[]; provisions: ProvisionRow[] };

type DrawerMode = 'accrual' | 'provision';

interface FieldError {
  field: 'amount' | 'account' | 'description' | 'form';
  text: string;
}

/** One pending consequential act: which verb, on which row. */
type Confirm =
  | { verb: 'accrual_post'; id: string; label: string }
  | { verb: 'provision_post'; id: string; label: string }
  | { verb: 'accrual_reverse'; id: string; label: string }
  | { verb: 'provision_reverse'; id: string; label: string }
  | { verb: 'provision_release_reverse'; id: string; label: string }
  | { verb: 'post_all'; drafts: { verb: 'accrual_post' | 'provision_post'; id: string; amountMinor: number }[] };

/** One release of a provision, as `provision_get` lists it; reversed when the engine names the reversing entry. */
interface ReleaseRow {
  id: string;
  date: string;
  amountMinor: number;
  targetAccountNumber: string;
  entryId: string;
  reversedByEntryId: string | null;
}

function releaseRowsOf(body: unknown): ReleaseRow[] {
  const rows = (body as { releases?: unknown }).releases;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null && typeof r.id === 'string')
    .map((r) => ({
      id: r.id as string,
      date: typeof r.date === 'string' ? r.date : '',
      amountMinor: typeof r.amountMinor === 'number' ? r.amountMinor : 0,
      targetAccountNumber: typeof r.targetAccountNumber === 'string' ? r.targetAccountNumber : '',
      entryId: typeof r.entryId === 'string' ? r.entryId : '',
      reversedByEntryId: typeof r.reversedByEntryId === 'string' ? r.reversedByEntryId : null,
    }));
}

interface BatchSummary {
  posted: number;
  /** Drafts the engine answered `already_posted` for: done before the batch reached them, not refused. */
  already: number;
  refused: { id: string; code: string }[];
  remaining: number;
}

/** What the last successful post said, rendered under the list as the success state. */
interface Posted {
  kind: DrawerMode;
  entryId: string;
  reversalEntryId?: string;
  reversalDate?: string;
}

function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function AccrualEditor({ workspaceId, periodEnd, canPost }: AccrualEditorProps) {
  const t = useT();
  const client = useClient();
  const capabilities = useCapabilities();
  const allowed = canPost ?? capabilities.can(CAP.post);
  const titleId = useId();
  const lockNoteId = useId();
  const previewId = useId();

  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [accounts, setAccounts] = useState<PickerAccount[] | null>(null);
  const [accountsFailed, setAccountsFailed] = useState(false);
  const [currency, setCurrency] = useState('CHF');
  const [drawer, setDrawer] = useState<DrawerMode | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [release, setRelease] = useState<ProvisionRow | null>(null);
  /** The releases of one provision, listed for their undo (`provision_release_reverse`, D129 leg 2). */
  const [releases, setReleases] = useState<{ provision: ProvisionRow; rows: ReleaseRow[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [posted, setPosted] = useState<Posted | null>(null);
  const [batch, setBatch] = useState<BatchSummary | null>(null);
  /** Per-row quiet notes (an `already_posted` badge, a refusal code) keyed by row id. */
  const [rowNotes, setRowNotes] = useState<Record<string, string>>({});

  // The form.
  const [kind, setKind] = useState<AccrualKind>('accrued_expense');
  const [reason, setReason] = useState<ProvisionReason>('garantie');
  const [amountText, setAmountText] = useState('');
  const [contraId, setContraId] = useState('');
  const [provisionAccountId, setProvisionAccountId] = useState('');
  const [expenseAccountId, setExpenseAccountId] = useState('');
  const [description, setDescription] = useState('');
  const [sourceRef, setSourceRef] = useState('');
  const [fieldError, setFieldError] = useState<FieldError | null>(null);

  // The release form.
  const [releaseAmountText, setReleaseAmountText] = useState('');
  const [releaseDate, setReleaseDate] = useState(dayAfter(periodEnd));
  const [releaseTargetId, setReleaseTargetId] = useState('');
  const [releaseError, setReleaseError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const [accruals, provisions] = await Promise.all([
      client.call('accrual_list', { workspaceId, periodEnd }),
      client.call('provision_list', { workspaceId, periodEnd }),
    ]);
    if (isErr(accruals.body)) {
      setState({ kind: 'error', error: accruals.body });
      return;
    }
    if (isErr(provisions.body)) {
      setState({ kind: 'error', error: provisions.body });
      return;
    }
    // The unit rides the answer that carries the figures (`baseCurrency` on `accrual_list`), never
    // a second read: a figure under a guessed CHF is the defect the base-currency suites exist for.
    const named = (accruals.body as { baseCurrency?: unknown }).baseCurrency;
    if (typeof named === 'string' && named !== '') setCurrency(named);
    setState({ kind: 'ok', accruals: accrualRowsOf(accruals.body), provisions: provisionRowsOf(provisions.body) });
  }, [client, workspaceId, periodEnd]);

  useEffect(() => {
    void load();
  }, [load]);

  // The chart, once per workspace. A failed chart read leaves the list usable and the drawer says
  // the picker could not be read; it never invents an account.
  useEffect(() => {
    let live = true;
    void client.call('list_accounts', { workspaceId }).then(({ body }) => {
      if (!live) return;
      if (isErr(body)) {
        setAccountsFailed(true);
        return;
      }
      setAccounts(pickerAccountsOf(body));
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId]);

  const money = useCallback((minor: number) => formatMoney(minor, currency), [currency]);

  /** The accounts the current picker offers: P&L of the kind's type, or the provision / expense lists. */
  const contraOptions = useMemo(() => {
    if (accounts === null) return [];
    if (drawer === 'accrual') return accounts.filter((a) => a.type === ACCRUAL_KIND_RULES[kind].contraType);
    return accounts.filter((a) => a.type === 'income' || a.type === 'expense');
  }, [accounts, drawer, kind]);
  const provisionOptions = useMemo(() => (accounts === null ? [] : accounts.filter(isProvisionAccount)), [accounts]);
  const byId = useCallback((id: string) => accounts?.find((a) => a.id === id) ?? null, [accounts]);

  const amountMinor = parseAmountToMinor(amountText);
  const preview = useMemo(() => {
    const amount = amountMinor ?? 0;
    if (drawer === 'accrual') {
      const balance = accounts?.find((a) => a.number === ACCRUAL_KIND_RULES[kind].balanceNumber) ?? null;
      return previewAccrualLines(kind, amount, byId(contraId), balance, periodEnd);
    }
    return { lines: previewProvisionLines(amount, byId(provisionAccountId), byId(expenseAccountId), periodEnd), reversalLines: [] };
  }, [drawer, kind, amountMinor, accounts, byId, contraId, provisionAccountId, expenseAccountId, periodEnd]);

  const openDrawer = useCallback(
    (mode: DrawerMode) => {
      setFieldError(null);
      setAmountText('');
      setDescription('');
      setSourceRef('');
      setContraId('');
      setExpenseAccountId('');
      // 2330 is the seeded default for a short-term provision; the picker still offers every 23xx/26xx.
      const shortTerm = accounts?.find((a) => a.number === '2330');
      setProvisionAccountId(shortTerm?.id ?? '');
      setDrawer(mode);
    },
    [accounts],
  );

  /** Map an engine refusal on the draft save to the field it belongs to, or to the form. */
  const explainSave = useCallback(
    (err: Err): FieldError => {
      switch (err.error) {
        case 'invalid_account': {
          const reasonKey = typeof err.reason === 'string' ? err.reason : 'generic';
          return { field: 'account', text: t(`accruals.error.invalid_account.${reasonKey}`) };
        }
        case 'invalid_amount':
          return { field: 'amount', text: t('accruals.error.invalid_amount') };
        case 'invalid_input':
          if (err.field === 'description') return { field: 'description', text: t('provisions.error.sonstige') };
          return { field: 'form', text: t('accruals.error.generic') };
        case 'missing_account':
          return { field: 'account', text: t('accruals.error.missing_account', { number: String(err.number ?? '') }) };
        case 'permission_denied':
          return { field: 'form', text: t('accruals.noPost') };
        default:
          return { field: 'form', text: t('accruals.error.generic') };
      }
    },
    [t],
  );

  const saveDraft = useCallback(async () => {
    if (drawer === null) return;
    if (amountMinor === null) {
      setFieldError({ field: 'amount', text: t('accruals.error.invalid_amount') });
      return;
    }
    if (description.trim() === '') {
      setFieldError({ field: 'description', text: t('accruals.error.description') });
      return;
    }
    setBusy(true);
    setFieldError(null);
    const input =
      drawer === 'accrual'
        ? {
            kind,
            periodEnd,
            amountMinor,
            contraAccount: contraId,
            description: description.trim(),
            ...(sourceRef.trim() !== '' ? { sourceRef: sourceRef.trim() } : {}),
            idempotencyKey: newIdempotencyKey(),
          }
        : {
            reason,
            periodEnd,
            amountMinor,
            provisionAccount: provisionAccountId,
            expenseAccount: expenseAccountId,
            description: description.trim(),
            idempotencyKey: newIdempotencyKey(),
          };
    const { body } = await client.call(drawer === 'accrual' ? 'accrual_create' : 'provision_create', { workspaceId, ...input });
    setBusy(false);
    if (isErr(body)) {
      setFieldError(explainSave(body));
      return;
    }
    setDrawer(null);
    setPosted(null);
    await load();
  }, [drawer, amountMinor, description, kind, periodEnd, contraId, sourceRef, reason, provisionAccountId, expenseAccountId, client, workspaceId, explainSave, load, t]);

  /** Explain a refusal on a post, a Storno or a release, as a banner sentence. */
  const explainAct = useCallback(
    (err: Err): string => {
      switch (err.error) {
        case 'period_locked':
          return t('accruals.error.period_locked', { date: typeof err.date === 'string' ? formatDate(err.date) : String(err.period ?? '') });
        case 'release_exceeds_balance':
          return t('provisions.error.release_exceeds_balance', { open: money(typeof err.openBalanceMinor === 'number' ? err.openBalanceMinor : 0) });
        case 'release_blocked':
          return t('provisions.error.release_blocked');
        case 'permission_denied':
          return t('accruals.noPost');
        default:
          return t('accruals.error.generic');
      }
    },
    [t, money],
  );

  /** Run one governed write on one row: the confirm has already been given. */
  const act = useCallback(
    async (verb: Confirm['verb'] & string, id: string, extra: Record<string, unknown> = {}): Promise<{ ok: boolean; code?: string }> => {
      const idField = verb === 'provision_release_reverse' ? 'releaseId' : verb.startsWith('accrual') ? 'accrualId' : 'provisionId';
      const { body } = await client.call(verb, { workspaceId, [idField]: id, idempotencyKey: newIdempotencyKey(), ...extra });
      if (isErr(body)) {
        if (body.error === 'already_posted' || body.error === 'already_reversed') {
          // Quiet: the row already is what the act wanted it to be. A badge, not a banner.
          setRowNotes((n) => ({ ...n, [id]: t(`accruals.badge.${body.error}`) }));
        } else {
          setFeedback(explainAct(body));
        }
        return { ok: false, code: body.error };
      }
      const b = body as Record<string, unknown>;
      if (verb === 'accrual_post') {
        setPosted({
          kind: 'accrual',
          entryId: String(b.entryId),
          reversalEntryId: String(b.reversalEntryId),
          reversalDate: String(b.reversalDate),
        });
      } else if (verb === 'provision_post') {
        setPosted({ kind: 'provision', entryId: String(b.entryId) });
      } else if (verb === 'accrual_reverse') {
        setPosted({ kind: 'accrual', entryId: String(b.stornoEntryId), reversalEntryId: String(b.stornoReversalEntryId) });
      } else if (verb === 'provision_reverse') {
        setPosted({ kind: 'provision', entryId: String(b.reversalEntryId) });
      } else if (verb === 'provision_release_reverse') {
        setPosted({ kind: 'provision', entryId: String(b.reversalEntryId ?? b.entryId ?? '') });
      }
      return { ok: true };
    },
    [client, workspaceId, explainAct, t],
  );

  const runConfirm = useCallback(async () => {
    if (confirm === null) return;
    setConfirm(null);
    setBusy(true);
    setFeedback(null);
    if (confirm.verb === 'post_all') {
      const summary: BatchSummary = { posted: 0, already: 0, refused: [], remaining: confirm.drafts.length };
      for (const d of confirm.drafts) {
        const r = await act(d.verb, d.id);
        summary.remaining -= 1;
        if (r.ok) {
          summary.posted += 1;
          continue;
        }
        if (r.code === 'already_posted') {
          // Done before the batch reached it (a stale list, a second tab): the row already is what
          // the batch wanted, so it counts as done and the batch goes on to the next draft.
          summary.already += 1;
          continue;
        }
        summary.refused.push({ id: d.id, code: r.code ?? 'error' });
        // One refusal stops the batch: the half-done state names what is posted, what was refused
        // and what is still waiting, and the person decides how to go on.
        break;
      }
      setBatch(summary);
    } else {
      await act(confirm.verb, confirm.id);
      if (confirm.verb === 'provision_release_reverse') setReleases(null);
    }
    setBusy(false);
    await load();
  }, [confirm, act, load]);

  /** List a provision's releases (a read), each with its undo through the owner verb. */
  const openReleases = useCallback(
    async (row: ProvisionRow) => {
      setFeedback(null);
      const { body } = await client.call('provision_get', { workspaceId, provisionId: row.id });
      if (isErr(body)) {
        setFeedback(explainAct(body));
        return;
      }
      setReleases({ provision: row, rows: releaseRowsOf(body) });
    },
    [client, workspaceId, explainAct],
  );

  const runRelease = useCallback(async () => {
    if (release === null) return;
    const amount = parseAmountToMinor(releaseAmountText);
    if (amount === null) {
      setReleaseError(t('accruals.error.invalid_amount'));
      return;
    }
    if (releaseTargetId === '') {
      setReleaseError(t('accruals.error.invalid_account.target_not_found'));
      return;
    }
    setBusy(true);
    setReleaseError(null);
    const { body } = await client.call('provision_release', {
      workspaceId,
      provisionId: release.id,
      date: releaseDate,
      amountMinor: amount,
      targetAccount: releaseTargetId,
      idempotencyKey: newIdempotencyKey(),
    });
    setBusy(false);
    if (isErr(body)) {
      setReleaseError(explainAct(body));
      return;
    }
    setRelease(null);
    setPosted({ kind: 'provision', entryId: String((body as Record<string, unknown>).entryId) });
    await load();
  }, [release, releaseAmountText, releaseTargetId, releaseDate, client, workspaceId, explainAct, load, t]);

  const drafts = useMemo(() => {
    if (state.kind !== 'ok') return [];
    return [
      ...state.accruals.filter((a) => a.status === 'draft').map((a) => ({ verb: 'accrual_post' as const, id: a.id, amountMinor: a.amountMinor })),
      ...state.provisions.filter((p) => p.status === 'draft').map((p) => ({ verb: 'provision_post' as const, id: p.id, amountMinor: p.amountMinor })),
    ];
  }, [state]);
  const draftsTotal = drafts.reduce((s, d) => s + d.amountMinor, 0);

  const accrualColumns: DataTableColumn<AccrualRow>[] = [
    { key: 'kind', header: t('accruals.col.kind'), render: (r) => t(`accruals.kind.${r.kind}`), rowHeader: true },
    { key: 'description', header: t('accruals.description'), render: (r) => r.description },
    { key: 'account', header: t('accruals.contraAccount'), render: (r) => `${r.contraAccountNumber} ${r.contraAccountName}` },
    { key: 'amount', header: t('accruals.amount'), numeric: true, render: (r) => money(r.amountMinor) },
    {
      key: 'status',
      header: t('accruals.col.status'),
      render: (r) => (
        <span className={`accrual-status accrual-status--${r.status}`}>
          {t(`accruals.status.${r.status}`)}
          {rowNotes[r.id] !== undefined && <span className="accrual-badge">{rowNotes[r.id]}</span>}
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('accruals.col.actions'),
      headerHidden: true,
      render: (r) =>
        r.status === 'draft' ? (
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={!allowed || busy}
            onClick={() => setConfirm({ verb: 'accrual_post', id: r.id, label: r.description })}
          >
            {t('accruals.post')}
          </button>
        ) : r.status === 'posted' ? (
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={!allowed || busy}
            onClick={() => setConfirm({ verb: 'accrual_reverse', id: r.id, label: r.description })}
          >
            {t('accruals.reverse')}
          </button>
        ) : null,
    },
  ];

  const provisionColumns: DataTableColumn<ProvisionRow>[] = [
    { key: 'reason', header: t('provisions.col.reason'), render: (r) => t(`provisions.reason.${r.reason}`), rowHeader: true },
    { key: 'description', header: t('accruals.description'), render: (r) => r.description },
    { key: 'account', header: t('provisions.account'), render: (r) => `${r.provisionAccountNumber} / ${r.expenseAccountNumber}` },
    { key: 'amount', header: t('accruals.amount'), numeric: true, render: (r) => money(r.amountMinor) },
    { key: 'open', header: t('provisions.openBalance'), numeric: true, render: (r) => (r.status === 'posted' || r.status === 'released' ? money(r.openBalanceMinor) : '') },
    {
      key: 'status',
      header: t('accruals.col.status'),
      render: (r) => (
        <span className={`accrual-status accrual-status--${r.status}`}>
          {t(`provisions.status.${r.status}`)}
          {rowNotes[r.id] !== undefined && <span className="accrual-badge">{rowNotes[r.id]}</span>}
        </span>
      ),
    },
  ];

  /**
   * A provision row's verbs, behind its ONE overflow (K-21, D137): a posted provision offered up to
   * three buttons side by side (release, reverse, the release history). Nothing about the verbs
   * changes, only where they sit; each still opens its own confirm or dialog before any write.
   */
  const provisionActions = (r: ProvisionRow): OverflowMenuItem[] => {
    if (r.status === 'draft') {
      return [
        {
          key: 'post',
          label: t('accruals.post'),
          disabled: !allowed || busy,
          onSelect: () => setConfirm({ verb: 'provision_post', id: r.id, label: r.description }),
        },
      ];
    }
    if (r.status !== 'posted' && r.status !== 'released') return [];
    const items: OverflowMenuItem[] = [];
    if (r.openBalanceMinor > 0) {
      items.push({
        key: 'release',
        label: t('provisions.release'),
        disabled: !allowed || busy,
        onSelect: () => {
          setReleaseError(null);
          setReleaseAmountText('');
          setReleaseDate(dayAfter(periodEnd));
          setReleaseTargetId(accounts?.find((a) => a.number === r.expenseAccountNumber)?.id ?? '');
          setRelease(r);
        },
      });
    }
    if (r.openBalanceMinor < r.amountMinor) {
      items.push({ key: 'releases', label: t('provisions.releases'), disabled: busy, onSelect: () => void openReleases(r) });
    }
    if (r.status === 'posted') {
      items.push({
        key: 'reverse',
        label: t('accruals.reverse'),
        disabled: !allowed || busy,
        onSelect: () => setConfirm({ verb: 'provision_reverse', id: r.id, label: r.description }),
      });
    }
    return items;
  };

  function renderLines(lines: PreviewLine[], caption: string) {
    return (
      // The table scrolls inside its own container on a narrow viewport instead of forcing the modal
      // wider or clipping a long account name (presentation only).
      <div className="accrual-lines-wrap">
        <table className="accrual-lines">
          <caption className="accrual-lines-caption">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">{t('accruals.lines.account')}</th>
              <th scope="col" className="t-num">{t('accruals.lines.debit')}</th>
              <th scope="col" className="t-num">{t('accruals.lines.credit')}</th>
              <th scope="col">{t('accruals.lines.date')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={`${l.accountNumber}-${i}`}>
                <td>{l.accountNumber === '' ? t('accruals.lines.pick') : `${l.accountNumber} ${l.accountName}`}</td>
                <td className="t-num">{l.debitMinor > 0 ? money(l.debitMinor) : ''}</td>
                <td className="t-num">{l.creditMinor > 0 ? money(l.creditMinor) : ''}</td>
                <td>{formatDate(l.date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const accountFieldId = `${previewId}-account`;
  const amountFieldId = `${previewId}-amount`;
  const descriptionFieldId = `${previewId}-description`;
  const errorId = `${previewId}-error`;

  return (
    <section className="accrual-editor panel" aria-labelledby={titleId} data-period-end={periodEnd}>
      <div className="accrual-editor-head">
        <h2 id={titleId} className="periods-subtitle">
          {t('accruals.title', { date: formatDate(periodEnd) })}
        </h2>
        <div className="accrual-editor-actions">
          <button type="button" className="btn btn--secondary btn--sm" disabled={!allowed} aria-describedby={allowed ? undefined : lockNoteId} onClick={() => openDrawer('accrual')}>
            {!allowed && <LockGlyph size={14} />}
            {t('accruals.new')}
          </button>
          <button type="button" className="btn btn--secondary btn--sm" disabled={!allowed} aria-describedby={allowed ? undefined : lockNoteId} onClick={() => openDrawer('provision')}>
            {!allowed && <LockGlyph size={14} />}
            {t('provisions.new')}
          </button>
          {!allowed && (
            <span id={lockNoteId} className="lock-note">
              {t('accruals.noPost')}
            </span>
          )}
        </div>
      </div>

      {feedback !== null && (
        <p className="accrual-feedback accrual-feedback--error" role="alert">
          {feedback}
        </p>
      )}
      {posted !== null && (
        <p className="accrual-feedback accrual-feedback--ok" role="status" data-testid="accrual-posted">
          {posted.reversalDate !== undefined && posted.reversalEntryId !== undefined
            ? t('accruals.posted.pair', { entryId: posted.entryId, reversalEntryId: posted.reversalEntryId, date: formatDate(posted.reversalDate) })
            : posted.reversalEntryId !== undefined
              ? t('accruals.posted.storno', { entryId: posted.entryId, reversalEntryId: posted.reversalEntryId })
              : t('accruals.posted.one', { entryId: posted.entryId })}
        </p>
      )}
      {batch !== null && (
        <p className="accrual-feedback" role="status" data-testid="accrual-batch">
          {t('accruals.batch.summary', { posted: batch.posted, refused: batch.refused.length, remaining: batch.remaining })}
          {batch.already > 0 && ` ${t('accruals.batch.already', { count: batch.already })}`}
          {batch.refused.length > 0 && ` ${t('accruals.batch.refused', { codes: batch.refused.map((r) => r.code).join(', ') })}`}
        </p>
      )}

      {state.kind === 'loading' && <Skeleton rows={3} height={18} />}
      {state.kind === 'error' && <ErrorBanner error={state.error} onRetry={() => void load()} />}
      {state.kind === 'ok' && state.accruals.length === 0 && state.provisions.length === 0 && (
        <EmptyState
          title={t('accruals.empty')}
          hint={t('accruals.emptyHint')}
          action={allowed ? { label: t('accruals.new'), onClick: () => openDrawer('accrual') } : undefined}
        />
      )}
      {state.kind === 'ok' && (state.accruals.length > 0 || state.provisions.length > 0) && (
        <>
          {state.accruals.length > 0 && (
            <DataTable<AccrualRow>
              columns={accrualColumns}
              rows={state.accruals}
              rowKey={(r) => r.id}
              caption={t('accruals.listCaption')}
              rowClassName={(r) => `accrual-row accrual-row--${r.status}`}
            />
          )}
          {state.provisions.length > 0 && (
            <DataTable<ProvisionRow>
              columns={provisionColumns}
              rows={state.provisions}
              rowKey={(r) => r.id}
              caption={t('provisions.listCaption')}
              rowActions={provisionActions}
              rowActionsLabel={(r) => t('provisions.rowActionsFor', { label: r.description })}
              rowClassName={(r) => `accrual-row accrual-row--${r.status}`}
            />
          )}
          {drafts.length > 1 && (
            <div className="accrual-editor-batch">
              {/* A secondary: the one primary on Perioden is "Monat abschliessen" (K-08), and this
                  opens a confirm before anything posts. */}
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                disabled={!allowed || busy}
                onClick={() => setConfirm({ verb: 'post_all', drafts })}
              >
                {t('accruals.postAll', { count: drafts.length, total: money(draftsTotal) })}
              </button>
            </div>
          )}
        </>
      )}

      {drawer !== null && (
        <Modal
          open
          title={drawer === 'accrual' ? t('accruals.drawerTitle') : t('provisions.drawerTitle')}
          onClose={() => setDrawer(null)}
          closeLabel={t('accruals.close')}
          describedById={fieldError?.field === 'form' ? errorId : undefined}
          trapActive={confirm === null}
          footer={
            <>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setDrawer(null)}>
                {t('accruals.cancel')}
              </button>
              <button type="button" className="btn btn--primary" disabled={!allowed || busy} onClick={() => void saveDraft()}>
                {t('accruals.save')}
              </button>
            </>
          }
        >
          <form
            className="accrual-form"
            onSubmit={(e) => {
              e.preventDefault();
              void saveDraft();
            }}
          >
            {drawer === 'accrual' ? (
              <fieldset className="accrual-picker">
                <legend>{t('accruals.kindLabel')}</legend>
                {ACCRUAL_KINDS.map((k) => (
                  <label key={k} className="accrual-picker-option">
                    <input type="radio" name="accrual-kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
                    <span className="accrual-picker-name">{t(`accruals.kind.${k}`)}</span>
                    <span className="accrual-picker-hint">{t(`accruals.kindHint.${k}`)}</span>
                  </label>
                ))}
              </fieldset>
            ) : (
              <div className="period-field">
                {t('provisions.reasonLabel')}
                <Select
                  value={reason}
                  onChange={(value) => setReason(value as ProvisionReason)}
                  options={PROVISION_REASONS.map((r) => ({ value: r, label: t(`provisions.reason.${r}`) }))}
                  ariaLabel={t('provisions.reasonLabel')}
                />
                <span className="accrual-picker-hint">{t(`provisions.reasonHint.${reason}`)}</span>
              </div>
            )}

            <label className="period-field" htmlFor={amountFieldId}>
              {t('accruals.amount')} ({currency})
            </label>
            <input
              id={amountFieldId}
              className="field"
              inputMode="decimal"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              aria-invalid={fieldError?.field === 'amount' ? true : undefined}
              aria-describedby={fieldError?.field === 'amount' ? errorId : undefined}
            />
            {fieldError?.field === 'amount' && (
              <p id={errorId} className="accrual-field-error" role="alert">
                {fieldError.text}
              </p>
            )}

            {drawer === 'provision' && (
              <div className="period-field">
                {t('provisions.account')}
                <Select
                  value={provisionAccountId}
                  onChange={(value) => setProvisionAccountId(value)}
                  options={[
                    { value: '', label: t('accruals.lines.pick') },
                    ...provisionOptions.map((a) => ({ value: a.id, label: `${a.number} ${a.name}` })),
                  ]}
                  ariaLabel={t('provisions.account')}
                />
              </div>
            )}

            <label className="period-field" htmlFor={accountFieldId}>
              {drawer === 'accrual' ? t('accruals.contraAccount') : t('provisions.expenseAccount')}
            </label>
            <Select
              id={accountFieldId}
              value={drawer === 'accrual' ? contraId : expenseAccountId}
              onChange={(value) => (drawer === 'accrual' ? setContraId(value) : setExpenseAccountId(value))}
              options={[
                {
                  value: '',
                  label: accountsFailed
                    ? t('accruals.accountsFailed')
                    : accounts === null
                      ? t('accruals.accountsLoading')
                      : t('accruals.lines.pick'),
                },
                ...contraOptions.map((a) => ({ value: a.id, label: `${a.number} ${a.name}` })),
              ]}
              invalid={fieldError?.field === 'account'}
              describedBy={fieldError?.field === 'account' ? errorId : undefined}
              disabled={accounts === null}
              ariaLabel={drawer === 'accrual' ? t('accruals.contraAccount') : t('provisions.expenseAccount')}
            />
            {fieldError?.field === 'account' && (
              <p id={errorId} className="accrual-field-error" role="alert">
                {fieldError.text}
              </p>
            )}

            <label className="period-field" htmlFor={descriptionFieldId}>
              {t('accruals.description')}
            </label>
            <input
              id={descriptionFieldId}
              className="field"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              aria-invalid={fieldError?.field === 'description' ? true : undefined}
              aria-describedby={fieldError?.field === 'description' ? errorId : undefined}
            />
            {fieldError?.field === 'description' && (
              <p id={errorId} className="accrual-field-error" role="alert">
                {fieldError.text}
              </p>
            )}

            {drawer === 'accrual' && (
              <label className="period-field">
                {t('accruals.sourceRef')}
                <input className="field" value={sourceRef} onChange={(e) => setSourceRef(e.target.value)} />
              </label>
            )}

            {fieldError?.field === 'form' && (
              <p id={errorId} className="accrual-field-error" role="alert">
                {fieldError.text}
              </p>
            )}
          </form>

          <div className="accrual-preview" data-testid="accrual-preview">
            {renderLines(preview.lines, t('accruals.previewCaption'))}
            {drawer === 'accrual' && renderLines(preview.reversalLines, t('accruals.reversalOn', { date: formatDate(dayAfter(periodEnd)) }))}
          </div>
        </Modal>
      )}

      {confirm !== null && (
        <Modal
          open
          role={ALERT_DIALOG}
          title={confirm.verb === 'post_all' ? t('accruals.postAllTitle', { count: confirm.drafts.length }) : t(`accruals.confirm.${confirm.verb}`)}
          onClose={() => setConfirm(null)}
          closeLabel={t('accruals.close')}
          footer={
            <>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setConfirm(null)}>
                {t('accruals.cancel')}
              </button>
              <button type="button" className="btn btn--danger" onClick={() => void runConfirm()}>
                {confirm.verb === 'post_all' ? t('accruals.postAllAction') : t(`accruals.confirmAction.${confirm.verb}`)}
              </button>
            </>
          }
        >
          <p className="period-confirm-message">
            {confirm.verb === 'post_all'
              ? t('accruals.postAllMessage', { count: confirm.drafts.length, total: money(confirm.drafts.reduce((s, d) => s + d.amountMinor, 0)) })
              : confirm.label}
          </p>
          <ConsequenceLine verb={confirm.verb === 'post_all' ? 'accrual_post' : confirm.verb} />
        </Modal>
      )}

      {releases !== null && (
        <Modal open title={t('provisions.releasesTitle', { description: releases.provision.description })} onClose={() => setReleases(null)} closeLabel={t('accruals.close')} trapActive={confirm === null}>
          {releases.rows.length === 0 ? (
            <p className="period-confirm-message">{t('provisions.noReleases')}</p>
          ) : (
            <div className="accrual-lines-wrap">
              <table className="accrual-lines">
                <caption className="accrual-lines-caption">{t('provisions.releases')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('provisions.releaseDate')}</th>
                    <th scope="col" className="t-num">{t('accruals.amount')}</th>
                    <th scope="col">{t('provisions.targetAccount')}</th>
                    <th scope="col">{t('accruals.col.status')}</th>
                    <th scope="col" className="accrual-lines-actions">{t('accruals.col.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {releases.rows.map((rel) => (
                    <tr key={rel.id} data-release={rel.id}>
                      <td>{formatDate(rel.date)}</td>
                      <td className="t-num">{money(rel.amountMinor)}</td>
                      <td>{rel.targetAccountNumber}</td>
                      <td>{rel.reversedByEntryId === null ? rel.entryId : t('provisions.releaseReversed', { entryId: rel.reversedByEntryId })}</td>
                      <td>
                        {rel.reversedByEntryId === null && (
                          <button type="button" className="btn btn--secondary btn--sm" disabled={!allowed || busy} onClick={() => setConfirm({ verb: 'provision_release_reverse', id: rel.id, label: t('provisions.releaseLabel', { date: formatDate(rel.date), amount: money(rel.amountMinor) }) })}>
                            {t('provisions.releaseReverse')}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}

      {release !== null && (
        <Modal
          open
          role={ALERT_DIALOG}
          title={t('provisions.releaseTitle')}
          onClose={() => setRelease(null)}
          closeLabel={t('accruals.close')}
          footer={
            <>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setRelease(null)}>
                {t('accruals.cancel')}
              </button>
              <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void runRelease()}>
                {t('provisions.release')}
              </button>
            </>
          }
        >
          <p className="period-confirm-message">{t('provisions.releaseMessage', { open: money(release.openBalanceMinor) })}</p>
          <label className="period-field">
            {t('accruals.amount')} ({currency})
            <input className="field" inputMode="decimal" value={releaseAmountText} onChange={(e) => setReleaseAmountText(e.target.value)} />
          </label>
          <label className="period-field">
            {t('provisions.releaseDate')}
            <input className="field" type="date" value={releaseDate} onChange={(e) => setReleaseDate(e.target.value)} />
          </label>
          <div className="period-field">
            {t('provisions.targetAccount')}
            <Select
              value={releaseTargetId}
              onChange={(value) => setReleaseTargetId(value)}
              options={[
                { value: '', label: t('accruals.lines.pick') },
                ...(accounts ?? [])
                  .filter((a) => a.type === 'income' || a.type === 'expense')
                  .map((a) => ({ value: a.id, label: `${a.number} ${a.name}` })),
              ]}
              ariaLabel={t('provisions.targetAccount')}
            />
          </div>
          {releaseError !== null && (
            <p className="accrual-field-error" role="alert">
              {releaseError}
            </p>
          )}
          <ConsequenceLine verb="provision_release" />
        </Modal>
      )}
    </section>
  );
}
