/**
 * A15, Mahnwesen (`/dunning`): propose, review, issue, send. The batch surface over A16's overdue
 * open items.
 *
 * ONE PRIMARY ACTION, AND IT IS THE PROPOSE. "Mahnlauf vorschlagen" is the accent-filled button and
 * the whole entry to the flow; Ausstellen and Versenden are the commitments and live ON the run they
 * commit, as secondary controls, because the accent budget is spent where the flow starts.
 *
 * THE HUMAN CLICK IS THE P8 CONFIRMATION. `issue_dunning_run` and `send_dunning_run` are
 * draft-by-default in the engine; this surface passes `confirmed: true` from the button because a
 * person at the button has already decided (the Files-delete idiom). An agent calling the same
 * verbs without the dial is refused: the gate is the engine's, this is just the honest client.
 *
 * EVERY FIGURE IS THE ENGINE'S. Levels, days overdue, open amounts, fees and interest notes render
 * from the run's frozen rows; nothing is computed here. Status and level render as glyph/number
 * PLUS text, never colour alone. A24's courtesy gates pre-disable what the role cannot do
 * (`dun` for propose/issue, `dun`+`send` for send, `manage_settings` for the policy), and the
 * engine's refusal remains the real gate.
 *
 * D118 B2 primitives: the page header is the shared `SurfaceHeader`, and both tables (the current
 * run's review and the run history) are the shared `DataTable`, so the frame overflow, sticky
 * header, density tokens and tabular money alignment stop being hand-rolled here. The `dun`
 * consequence sentence rides the shared `ConsequenceLine` (C4) beside the commit, so the operator
 * reads the SAME words an approver reads when clearing an agent's proposal of the same write. There
 * is no confirm Modal and no DetailDrawer: the commit button IS the P8 confirmation (the Files-delete
 * idiom, unchanged), and the run review is the surface's persistent primary panel, not a peek-detail.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useCan, CAP } from '../../lib/capabilities';
import { useT, formatMoney, formatDate } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { ConsequenceLine } from '../../components/ConsequenceLine';
import { Provenance } from '../../components/Provenance';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import { useIdempotencyKey } from '../../lib/idempotency';
import { ConfigPanel, type FeeAccountOption } from './ConfigPanel';
import {
  parseConfig,
  parseRun,
  parseRuns,
  type DunningConfigView,
  type DunningItemChange,
  type DunningItemView,
  type DunningRunSummary,
  type DunningRunView,
} from './model';
import './Dunning.css';

interface SavedViewOption {
  id: string;
  name: string;
}

export function Dunning() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const [params, setParams] = useSearchParams();
  const viewParam = params.get('view');

  const [config, setConfig] = useState<DunningConfigView | null>(null);
  const [runs, setRuns] = useState<DunningRunSummary[] | null>(null);
  const [current, setCurrent] = useState<DunningRunView | null>(null);
  /** Which run the review panel shows. Null means "the newest", which is what a fresh visit wants. */
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [savedViews, setSavedViews] = useState<SavedViewOption[]>([]);
  const [feeAccounts, setFeeAccounts] = useState<FeeAccountOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  /** A verb-level note the last action produced: nothing overdue, transport missing, fee skipped. */
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** Whether the policy disclosure stands open. Seeded once from the config, then owned by the operator. */
  const [configOpen, setConfigOpen] = useState(false);
  const configSeeded = useRef(false);

  const canDun = useCan(CAP.dun);
  const canSend = useCan(CAP.send);
  // The engine asserts `post` before a fee-bearing issue (the unlock_period shape); the courtesy
  // gate mirrors it so the refusal is told BEFORE the click (critic N2).
  const canPost = useCan(CAP.post);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const [configResp, runsResp, viewsResp, accountsResp] = await Promise.all([
      client.call('get_dunning_config', { workspaceId }),
      client.call('list_dunning_runs', { workspaceId, ...(viewParam === null ? {} : { savedViewId: viewParam }) }),
      client.call('list_saved_views', { workspaceId, entityKind: 'dunning_run' }),
      client.call('list_accounts', { workspaceId }),
    ]);
    if (isErr(configResp.body) || isErr(runsResp.body)) {
      const firstError = isErr(configResp.body) ? configResp : runsResp;
      if ((firstError.body as { error?: string }).error === 'permission_denied' || firstError.status === 403) {
        setDenied(true);
      } else {
        setFailed(true);
      }
      setLoading(false);
      return;
    }
    const parsedConfig = parseConfig(configResp.body);
    const parsedRuns = parseRuns(runsResp.body);
    if (parsedConfig === null || parsedRuns === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setConfig(parsedConfig);
    setRuns(parsedRuns);

    // The option reads are OTHER capabilities' verbs (A01, G00): a failure narrows the form,
    // never the surface. There is deliberately NO tax-code read any more: the fee's VAT follows
    // the chased invoice automatically (D69), so there is nothing here to pick.
    if (!isErr(viewsResp.body) && Array.isArray(viewsResp.body.savedViews)) {
      setSavedViews(
        (viewsResp.body.savedViews as { viewId?: unknown; name?: unknown }[])
          .map((v) => ({ id: String(v.viewId ?? ''), name: String(v.name ?? '') }))
          .filter((v) => v.id.length > 0),
      );
    }
    if (!isErr(accountsResp.body) && Array.isArray(accountsResp.body.accounts)) {
      setFeeAccounts(
        (accountsResp.body.accounts as { id: string; number: string; name: string; type: string }[])
          .filter((a) => a.type === 'income')
          .map((a) => ({ id: a.id, number: a.number, name: a.name })),
      );
    }
    // The newest run is the working set by DEFAULT, and the operator can put an older one there.
    // The history used to be a list of rows that opened nothing, which made every earlier Mahnlauf
    // unreachable: its letters could not be reprinted, and a reminder is the evidence of what was
    // demanded. A selection that has fallen out of the list (a filter changed) falls back to the
    // newest rather than emptying the panel.
    const wanted =
      selectedRunId !== null && parsedRuns.some((r) => r.runId === selectedRunId)
        ? selectedRunId
        : (parsedRuns[0]?.runId ?? null);
    if (wanted !== null) {
      const detail = await client.call('get_dunning_run', { workspaceId, runId: wanted });
      if (!isErr(detail.body)) {
        setCurrent(parseRun(detail.body));
      }
    } else {
      setCurrent(null);
    }
    setLoading(false);
  }, [client, workspaceId, viewParam, selectedRunId]);

  useEffect(() => {
    void load();
  }, [load]);

  // An unconfigured policy is the one thing that stops this surface working, so the panel shows
  // itself. Once. Every later read leaves the disclosure exactly where the operator put it.
  useEffect(() => {
    if (config === null || configSeeded.current) return;
    configSeeded.current = true;
    setConfigOpen(!config.configured);
  }, [config]);

  const proposeKey = useIdempotencyKey([workspaceId, 'propose']);
  const propose = async () => {
    if (workspaceId === null) return;
    setBusy('propose');
    setNote(null);
    const response = await client.call('propose_dunning_run', { workspaceId, idempotencyKey: proposeKey });
    setBusy(null);
    if (isErr(response.body)) {
      setNote(t('dunning.error.action'));
      return;
    }
    if (response.body.runId === null) {
      setNote(t('dunning.noOverdue'));
      return;
    }
    // The engine dedupes on the asOf date: a second propose for the same day returns the run that
    // already exists, flagged `existing: true`. Without this note the click was a silent no-op
    // (the button did something, said nothing, and changed nothing on screen), so the surface now
    // says so and puts that run into the working set.
    if (response.body.existing === true) {
      setSelectedRunId(String(response.body.runId));
      setNote(t('dunning.alreadyProposed'));
      return;
    }
    void load();
  };

  const issueKey = useIdempotencyKey([workspaceId, 'issue', current?.runId ?? '']);
  /**
   * The C8 recovery reaches `issue_dunning_run` too, and it is a DIFFERENT QUESTION, so it carries a
   * different key. Under the issue key it was not a recovery at all: `rememberIdempotent` keys on
   * `(workspace, verb, key)` and fingerprints no input, so the second call replayed the first
   * issue's memoised answer, the surface reported success, and not one Rappen of the deferred
   * Mahngebühr ever reached the ledger. This is the shared idempotency law's own rule (one key per
   * question) applied where two questions happened to share a verb.
   */
  const recoverFeeKey = useIdempotencyKey([workspaceId, 'recover-fee', current?.runId ?? '']);
  const issue = async (intent: 'issue' | 'recover-fee' = 'issue') => {
    if (workspaceId === null || current === null) return;
    setBusy(intent);
    setNote(null);
    const response = await client.call('issue_dunning_run', {
      workspaceId,
      runId: current.runId,
      // The human at this button is the P8 confirmation.
      confirmed: true,
      idempotencyKey: intent === 'issue' ? issueKey : recoverFeeKey,
    });
    setBusy(null);
    if (isErr(response.body)) {
      const code = response.body.error;
      // `recovery_needs_its_own_key` IS reachable from here, despite the separate recovery key
      // above, and it is worth saying where from: the lost-response window. `Ausstellen` renders
      // only while the run reads `proposed`, so if the issue landed and its response was lost, the
      // surface still shows that button and the next click arrives under the SAME issue key, on a
      // run that is already issued with its fee deferred. The engine refuses to guess whether that
      // is a retry or a recovery request, which is correct, and the operator must not be told
      // "try again": the key is stable per question, so a retry repeats the refusal for ever.
      // The reload puts the run's real state on screen, where "Gebühr nachbuchen" is waiting.
      if (code === 'recovery_needs_its_own_key') {
        setNote(t('dunning.alreadyIssuedUseRecovery'));
        void load();
        return;
      }
      setNote(
        code === 'needs_creditor_address'
          ? t('dunning.needsCreditorAddress')
          : code === 'nothing_to_issue'
            ? t('dunning.nothingToIssue')
            : code === 'period_locked'
              ? t('dunning.feeStillLocked')
              : t('dunning.error.action'),
      );
      return;
    }
    if ((response.body as { feeSkippedReason?: string | null }).feeSkippedReason === 'period_locked') {
      setNote(t('dunning.feeSkippedLockedPeriod'));
    }
    void load();
  };

  const sendKey = useIdempotencyKey([workspaceId, 'send', current?.runId ?? '']);
  const send = async () => {
    if (workspaceId === null || current === null) return;
    setBusy('send');
    setNote(null);
    const response = await client.call('send_dunning_run', {
      workspaceId,
      runId: current.runId,
      confirmed: true,
      idempotencyKey: sendKey,
    });
    setBusy(null);
    if (isErr(response.body)) {
      const code = response.body.error;
      setNote(
        code === 'needs_email_config' || code === 'needs_email_transport'
          ? t('dunning.needsEmailTransport')
          : t('dunning.error.action'),
      );
      return;
    }
    void load();
  };

  const downloadLetter = async (debtorId: string, debtorName: string | null) => {
    if (workspaceId === null || current === null) return;
    const response = await client.call('get_dunning_pdf', { workspaceId, runId: current.runId, debtorId });
    if (isErr(response.body)) {
      setNote(t('dunning.error.action'));
      return;
    }
    const letter = (response.body as Record<string, unknown>).pdf as { base64?: unknown } | undefined;
    if (letter === undefined || typeof letter.base64 !== 'string') {
      setNote(t('dunning.error.action'));
      return;
    }
    const bytes = Uint8Array.from(atob(letter.base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `mahnung-${current.runDate}-${debtorName ?? debtorId}.pdf`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const settled = !loading && !failed && runs !== null && config !== null;
  const history = useMemo(() => runs ?? [], [runs]);

  // The history columns for the shared DataTable. The date cell stays a control (never the whole row),
  // so the `aria-current` selection marker survives: which run is open is stated on the button, never
  // by the row tint alone. Debtor and item counts are numeric, right-aligned tabular figures.
  const historyColumns: DataTableColumn<DunningRunSummary>[] = [
    {
      key: 'runDate',
      header: t('dunning.column.runDate'),
      // Every row OPENS. Without this the history was a list of dates that did nothing, so an earlier
      // Mahnlauf could not be reviewed and its letters could not be reprinted: a reminder is the
      // evidence of what was demanded, and it stays reachable after a newer run supersedes it here.
      render: (run) => (
        <button
          type="button"
          className="dunning-link"
          aria-current={run.runId === current?.runId ? 'true' : undefined}
          onClick={() => setSelectedRunId(run.runId)}
        >
          {formatDate(run.runDate)}
        </button>
      ),
    },
    {
      key: 'status',
      header: t('dunning.column.status'),
      render: (run) => (
        <>
          <StatusChip status={run.status} />
          {run.feeSkippedReason !== null && (
            <span className="dunning-dim"> {t('dunning.feeSkippedShort')}</span>
          )}
        </>
      ),
    },
    { key: 'debtors', header: t('dunning.column.debtors'), numeric: true, render: (run) => run.debtorCount },
    { key: 'items', header: t('dunning.column.items'), numeric: true, render: (run) => run.itemCount },
    {
      key: 'maxLevel',
      header: t('dunning.column.maxLevel'),
      render: (run) => (run.maxLevel > 0 ? <LevelChip level={run.maxLevel} /> : null),
    },
  ];

  if (workspaceId === null) return <NoWorkspaceState />;
  if (denied) return <PermissionDenied body={t('dunning.error.permissionDenied.read')} />;

  return (
    <section className="dunning" aria-labelledby="dunning-title">
      <SurfaceHeader
        title={t('dunning.title')}
        titleId="dunning-title"
        help={<SurfaceHelp surface="Dunning" />}
        actions={
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canDun || busy !== null}
            onClick={() => void propose()}
          >
            {canDun ? t('dunning.propose') : t('dunning.proposeDenied')}
          </button>
        }
      />
      <p className="dunning-dim">
        {t('dunning.subtitle')} <Link to="/open-items">{t('dunning.toOpenItems')}</Link>
      </p>

      {note !== null && (
        <div className="dunning-note" role="status">
          <p>{note}</p>
          {note === t('dunning.needsCreditorAddress') && (
            <Link to="/setup">{t('dunning.toSetup')}</Link>
          )}
        </div>
      )}

      {failed && <ErrorBanner message={t('dunning.error.transport')} onRetry={() => void load()} />}

      {loading ? (
        <Skeleton rows={6} />
      ) : !settled ? null : history.length === 0 ? (
        <EmptyState
          title={t('dunning.empty.title')}
          hint={t('dunning.empty.hint')}
          action={{ label: t('dunning.propose'), onClick: () => void propose() }}
        />
      ) : (
        <>
          {current !== null && (
            <CurrentRun
              run={current}
              canDun={canDun}
              canSend={canSend}
              canPost={canPost}
              busy={busy}
              onIssue={() => void issue('issue')}
              onRecoverFee={() => void issue('recover-fee')}
              onSend={() => void send()}
              onDownload={(debtorId, debtorName) => void downloadLetter(debtorId, debtorName)}
            />
          )}

          <div className="dunning-history">
            <div className="dunning-history-head">
              <h2>{t('dunning.history')}</h2>
              {savedViews.length > 0 && (
                <label className="dunning-filter">
                  <span>{t('dunning.savedView')}</span>
                  <select
                    value={viewParam ?? ''}
                    onChange={(event) => {
                      const next = new URLSearchParams(params);
                      if (event.target.value === '') next.delete('view');
                      else next.set('view', event.target.value);
                      setParams(next, { replace: false });
                    }}
                  >
                    <option value="">{t('dunning.allRuns')}</option>
                    {savedViews.map((view) => (
                      <option key={view.id} value={view.id}>
                        {view.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <DataTable
              columns={historyColumns}
              rows={history}
              rowKey={(run) => run.runId}
              caption={t('dunning.historyCaption')}
              rowClassName={(run) =>
                run.runId === current?.runId ? 'dunning-table-row--selected' : undefined
              }
            />
          </div>
        </>
      )}

      {/* NOT gated on `settled`, and that is the repair rather than an oversight. `settled` is false
          for the whole of any refresh, so gating on it UNMOUNTED the policy form every time the
          surface reloaded, including the reload the save itself triggers: the panel disappeared, the
          `ConfigPanel` was rebuilt from scratch with fresh state, and the "Gespeichert." it had just
          set was destroyed a frame after it appeared. A person saving a policy saw the form flash
          and was told nothing at all. A form is not a read model; it does not get torn down because
          a background read is in flight. */}
      {config !== null && !failed && (
        /* The disclosure opens ITSELF exactly once, when an unconfigured policy first loads, and is
           the operator's from then on. Binding `open` straight to `config.configured` collapsed the
           panel the instant a save succeeded, folding the form away mid-task and taking its own
           "Gespeichert." confirmation down with it: the one moment the panel must stay put is the
           moment it stops being unconfigured. */
        <details
          className="dunning-config-panel panel"
          open={configOpen}
          onToggle={(event) => setConfigOpen(event.currentTarget.open)}
        >
          <summary>{t('dunning.config.title')}</summary>
          <ConfigPanel
            workspaceId={workspaceId}
            config={config}
            feeAccounts={feeAccounts}
            onSaved={() => void load()}
          />
        </details>
      )}
    </section>
  );
}

/** The run status as glyph plus text, never colour alone (DESIGN.md's status set). */
function StatusChip({ status }: { status: string }) {
  const t = useT();
  const glyph = status === 'sent' ? '✓' : status === 'issued' ? '▸' : '○';
  return (
    <span className={`dunning-status dunning-status--${status}`}>
      <span aria-hidden="true">{glyph}</span> {t(`dunning.status.${status}`)}
    </span>
  );
}

/** The i18n key suffix for a change cause: 'partially_paid' becomes the camelCase 'partiallyPaid'. */
function changeKey(reason: DunningItemChange): string {
  return reason === 'partially_paid' ? 'partiallyPaid' : reason;
}

/**
 * The per-invoice warning in the review table: a settled, partially paid, cancelled or credited
 * invoice named on a frozen letter, marked by cause. A glyph PLUS text (never colour alone,
 * DESIGN.md), so a grayscale printout reads the same.
 */
function ChangeBadge({ reason }: { reason: DunningItemChange }) {
  const t = useT();
  return (
    <span className="dunning-changed" role="note">
      {' '}
      <span aria-hidden="true">⚠ </span>
      {t('dunning.changedBadge', { reason: t(`dunning.changed.${changeKey(reason)}`) })}
    </span>
  );
}

/** The escalation level as a numbered chip with an accessible name, never colour alone. */
function LevelChip({ level }: { level: number }) {
  const t = useT();
  return (
    <span className="dunning-level" aria-label={t(`dunning.level${Math.min(Math.max(level, 1), 3)}`)}>
      {level}
    </span>
  );
}

/** The newest run: its review table and the two commitments. */
function CurrentRun({
  run,
  canDun,
  canSend,
  canPost,
  busy,
  onIssue,
  onRecoverFee,
  onSend,
  onDownload,
}: {
  run: DunningRunView;
  canDun: boolean;
  canSend: boolean;
  canPost: boolean;
  busy: string | null;
  onIssue: () => void;
  onRecoverFee: () => void;
  onSend: () => void;
  onDownload: (debtorId: string, debtorName: string | null) => void;
}) {
  const t = useT();
  const issued = run.status !== 'proposed';
  // A run whose items carry a fee that is not yet on the ledger BOOKS when issued (or recovered),
  // so issuing it needs `post` as well as `dun`: the engine asserts exactly this, and the courtesy
  // gate says it before the click (critic N2).
  const willBook = run.items.some((i) => i.feeMinor > 0 && !i.feeBooked);
  const mayIssue = canDun && (!willBook || canPost);
  const issueDeniedLabel = !canDun ? t('dunning.issueDenied') : t('dunning.issueDeniedPost');

  // C4: the governed write this run is about to commit, if any. A proposed run issues; an issued run
  // sends; a sent run has nothing pending, so it names no verb. Both governed verbs carry the `dun`
  // dial capability, so the ConsequenceLine renders the SAME sentence an approver reads when clearing
  // an agent's proposal of the same write (`agent.consequence.dun`). It renders nothing for a verb
  // with no dial capability, so a future ungoverned write would simply show no line.
  const pendingVerb =
    run.status === 'proposed' ? 'issue_dunning_run' : run.status === 'issued' ? 'send_dunning_run' : null;

  // The review columns for the shared DataTable. Text left, the money and count columns numeric and
  // right-aligned with tabular figures. EVERY figure is the engine's, rendered verbatim: no total is
  // summed here (the run may mix currencies, which never add, so there is no honest column total).
  const reviewColumns: DataTableColumn<DunningItemView>[] = [
    { key: 'debtor', header: t('dunning.column.debtor'), render: (item) => item.debtorName ?? item.debtorId },
    {
      key: 'invoice',
      header: t('dunning.column.invoice'),
      // K-31: a named invoice that took a payment, was cancelled or credited SINCE issue carries a
      // visible warning right here, so the operator sees it before mailing or downloading the letter.
      // Never a settled invoice silently shown as chased.
      render: (item) => (
        <>
          {item.number ?? item.documentId}
          {item.changeSinceIssue !== null && <ChangeBadge reason={item.changeSinceIssue} />}
        </>
      ),
    },
    { key: 'level', header: t('dunning.column.level'), render: (item) => <LevelChip level={item.level} /> },
    {
      key: 'dueDate',
      header: t('dunning.column.dueDate'),
      render: (item) => (item.dueDate === null ? '' : formatDate(item.dueDate)),
    },
    { key: 'daysOverdue', header: t('dunning.column.daysOverdue'), numeric: true, render: (item) => item.daysOverdue },
    {
      key: 'open',
      header: t('dunning.column.open'),
      numeric: true,
      render: (item) => formatMoney(item.overdueMinor, item.currency),
    },
    {
      key: 'fee',
      header: t('dunning.column.fee'),
      numeric: true,
      // Critic N6: on an ISSUED run this column is the FROZEN DEMAND, never the policy's fee. The two
      // part company exactly when a period lock defers the booking: the letter then asks for no
      // Mahngebühr at all, and `feeMinor` here would print a franc amount the debtor's copy never
      // mentions. A bare blank would be just as wrong in the other direction (it reads as "no fee
      // configured"), so the cell says the fee was not demanded, which stays true after the C8
      // recovery books it.
      render: (item) =>
        issued
          ? item.demandedFeeMinor > 0
            ? formatMoney(item.demandedFeeMinor, item.currency)
            : item.feeMinor > 0
              ? <span className="dunning-dim">{t('dunning.feeNotDemanded')}</span>
              : ''
          : item.feeMinor > 0
            ? formatMoney(item.feeMinor, item.currency)
            : '',
    },
    {
      key: 'interest',
      header: t('dunning.column.interest'),
      numeric: true,
      render: (item) =>
        item.interestMinor !== null && item.interestMinor > 0
          ? formatMoney(item.interestMinor, item.currency)
          : '',
    },
  ];

  return (
    <div className="dunning-current panel" data-testid="dunning-current">
      <div className="dunning-current-head">
        <div>
          <h2>
            {t('dunning.currentRun', { date: formatDate(run.runDate) })} <StatusChip status={run.status} />
          </h2>
          {run.feeSkippedReason === 'period_locked' && (
            <p className="dunning-dim" role="note">
              {t('dunning.feeSkippedLockedPeriod')}
            </p>
          )}
          {/* C3: who proposed this run and when, from the run's own header (`created_by`/`created_at`).
              Rendered only when the read model carries a timestamp, so a legacy row fabricates nothing. */}
          {run.createdAt !== null && (
            <Provenance origin="human" actor={run.createdBy} timestamp={run.createdAt} />
          )}
        </div>
        <div className="dunning-current-actions">
          {run.status === 'proposed' && (
            <button
              type="button"
              className="btn btn--secondary"
              disabled={!mayIssue || busy !== null}
              onClick={onIssue}
            >
              {mayIssue ? t('dunning.issue') : issueDeniedLabel}
            </button>
          )}
          {/* C8: a period-skipped fee is recoverable in place: the same issue verb books it once
              the period allows, and the control lives on the run whose note explains it. It is a
              DIFFERENT QUESTION from the issue, though, and it carries its own idempotency key:
              under the issue's key the engine replayed the memoised issue and booked nothing. */}
          {issued && run.feeSkippedReason === 'period_locked' && (
            <button
              type="button"
              className="btn btn--secondary"
              disabled={!(canDun && canPost) || busy !== null}
              onClick={onRecoverFee}
            >
              {canDun && canPost ? t('dunning.recoverFee') : issueDeniedLabel}
            </button>
          )}
          {run.status === 'issued' && (
            <button
              type="button"
              className="btn btn--secondary"
              disabled={!(canDun && canSend) || busy !== null}
              onClick={onSend}
            >
              {canDun && canSend ? t('dunning.send') : t('dunning.sendDenied')}
            </button>
          )}
        </div>
      </div>

      {/* C4: the consequence sentence for the write the commit button will make, the same one an
          approver reads for an agent's proposal of it. Quiet by law (the ConsequenceLine's own
          styling), placed where the operator decides. */}
      {pendingVerb !== null && <ConsequenceLine verb={pendingVerb} />}

      <DataTable
        columns={reviewColumns}
        rows={run.items}
        rowKey={(item) => item.documentId}
        caption={t('dunning.reviewCaption')}
      />

      {issued && (
        <ul className="dunning-letters">
          {run.debtors.map((group) => (
            <li key={group.debtorId} className={group.changedSinceIssue ? 'dunning-letter--held' : undefined}>
              <button type="button" className="dunning-link" onClick={() => onDownload(group.debtorId, group.debtorName)}>
                {t('dunning.downloadLetter', { debtor: group.debtorName ?? group.debtorId })}
              </button>
              {group.sent && <span className="dunning-dim"> {t('dunning.letterSent')}</span>}
              {group.sendError !== null && group.sendError === 'no_email' && (
                <span className="dunning-dim"> {t('dunning.noEmail')}</span>
              )}
              {/* K-31 f1: a letter naming an invoice changed since issue is HELD. The operator is
                  warned by name and cause here, BEFORE they manually mail or download it: the frozen
                  demand no longer matches what the debtor owes (D73 keeps the letter as evidence). */}
              {group.changedSinceIssue && group.changeReason !== null && (
                <span className="dunning-changed" role="note">
                  {' '}
                  <span aria-hidden="true">⚠ </span>
                  {t('dunning.changedLetterHeld', { reason: t(`dunning.changed.${changeKey(group.changeReason)}`) })}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
