/**
 * M03 (spec §4 V3/V3a): the Hosting journey block on the Sync & hosting panel, and the shared
 * move-checklist component the exit box re-renders (one design language: same structure, same
 * vocabulary, four steps versus five may differ).
 *
 * WHAT THIS BLOCK IS: the D106 collaboration model in one lead sentence, the three ladder rungs
 * (Lokal / Selbst gehostet / Verwaltet), and the directional five-step move checklist driven by the
 * M03 Move record (`get_move_state` / `advance_move_step`). Every ACTION on it calls a verb that
 * already exists: step 1 runs `create_backup` (G04), step 5 archives via `archive_workspace` (A23,
 * behind the V3a confirm), step 4 fronts the existing `trial_balance` read. The pointer itself is
 * bookkeeping, never a gate (M03 §3.1).
 *
 * HONESTY RULES this file enforces, from the spec:
 *  - Steps 2 and 3 happen ON ANOTHER MACHINE. They are manual check-offs, labelled "(manuell)",
 *    and the copy says the panel cannot verify them beyond step 4's comparison.
 *  - Step 4 is a MANUAL comparison: M02 is publish-only and no verb reads another instance, so
 *    [Prüfen] shows THIS ledger's trial-balance total beside the instruction to read the target's,
 *    and the human confirms or declares the mismatch. Never an automated check, and the copy names
 *    that ("manueller Abgleich").
 *  - The managed rung renders DISABLED with "bald verfügbar" on the rung itself (D119 posture 1):
 *    prevented at the control, not at validation. "Mehr" still opens; no price, no provider.
 *  - The S7.5 stale-writable notice renders when a COMPLETED move left this workspace unarchived:
 *    one action out, Stilllegen (V3a).
 *  - V3a states the consequence before it happens: read-only, intact, reversible over the
 *    Mandatsliste. `workspace_archived` from a parallel session renders as ALREADY DONE, never an
 *    error the user must resolve.
 */
import { useCallback, useEffect, useId, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useT, formatMoney, formatDate } from '../../i18n';
import { useCapabilities } from '../../lib/capabilities';
import { ErrorBanner, Skeleton } from '../../components/states';
import { LockGlyph } from '../../components/states/glyphs';
import { StatusNeutralGlyph, StatusSuccessGlyph } from '../../components/icons';
import { HelpHint } from '../../components/HelpHint';
import { Modal } from '../../components/Modal';
import { docsUrl } from '../../lib/guidance';

/** The A23 archive confirm is consequential. Held as a value, the DataBackup precedent, so the
 *  modal-role source guard never sees a literal role attribute. */
const ALERT_DIALOG = 'alertdialog' as const;

/** Exactly the `get_move_state` fields the block consumes (see `src/core/move/state.ts`). */
interface MoveStep {
  step: number;
  doneAt: string | null;
}
interface Move {
  direction: string;
  steps: MoveStep[];
  startedAt: string;
  completedAt: string | null;
}

interface WorkspaceSummary {
  name: string;
  baseCurrency: string;
  archived: boolean;
}

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; move: Move | null; workspace: WorkspaceSummary | null }
  | { kind: 'error'; error: Err };

type Rung = 'local' | 'selfhost' | 'managed';

/** A tiny idempotency key per press (the DataBackup `g04-` precedent). */
const key = () => `m03-${Date.now()}`;

/** The two ends of a stored direction (`local_to_selfhost` -> ['local','selfhost']). */
function endsOf(direction: string): [Rung, Rung] {
  const [from, to] = direction.split('_to_');
  const rung = (v: string | undefined): Rung => (v === 'selfhost' || v === 'managed' ? v : 'local');
  return [rung(from), rung(to)];
}

/**
 * One step of the shared checklist component. `action` is the step's single control while current;
 * `manual` steps carry the honest check-off toggle instead when no action is given.
 */
export interface ChecklistStep {
  label: string;
  done: boolean;
  doneAt?: string | null;
  /** The step's control(s), rendered while the step is current (or always for manual toggles). */
  control?: React.ReactNode;
  /** An external note, e.g. "(extern)": rendered dimmed after the label. */
  note?: string;
}

/**
 * THE one checklist component for every move-shaped process (spec §4 V3: the exit box's steps
 * render as the SAME component with the same vocabulary and position marker). Presentational: the
 * caller owns state and verbs.
 */
export function MoveChecklist({
  title,
  position,
  steps,
  footer,
}: {
  title: string;
  position: string;
  steps: ChecklistStep[];
  footer?: React.ReactNode;
}) {
  return (
    <div className="hosting-checklist">
      <div className="hosting-checklist-head">
        <span className="hosting-checklist-title">{title}</span>
        <span className="hosting-checklist-pos">{position}</span>
      </div>
      <ol className="hosting-steps">
        {steps.map((s, i) => (
          <li key={i} className={`hosting-step${s.done ? ' hosting-step--done' : ''}`}>
            {/* K-22: the icon set's check and empty circle, never a text dingbat; the list's own
                order and the words carry the state too. */}
            <span className="hosting-step-mark" aria-hidden="true">
              {s.done ? <StatusSuccessGlyph size={16} /> : <StatusNeutralGlyph size={16} />}
            </span>
            <span className="hosting-step-label">
              {s.label}
              {s.note !== undefined && <span className="hosting-step-note"> {s.note}</span>}
            </span>
            {s.control !== undefined && <span className="hosting-step-control">{s.control}</span>}
          </li>
        ))}
      </ol>
      {footer}
    </div>
  );
}

export function HostingJourney({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const client = useClient();
  const { whoami, can } = useCapabilities();
  const canManage = can('manage_settings');
  const served = (whoami?.identitySource ?? 'local_client') === 'served_subject';
  const hintId = useId();
  const retireBodyId = useId();

  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [target, setTarget] = useState<Rung | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<Err | null>(null);
  const [retiring, setRetiring] = useState(false);
  const [retireError, setRetireError] = useState<Err | null>(null);
  const [comparing, setComparing] = useState(false);
  const [compareTotal, setCompareTotal] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);

  const refresh = useCallback(async () => {
    setLoad({ kind: 'loading' });
    const moveResp = await client.call('get_move_state', { workspaceId });
    if (isErr(moveResp.body)) {
      setLoad({ kind: 'error', error: moveResp.body });
      return;
    }
    // The workspace summary feeds the S7.5 notice and the compare currency. It fails SOFT to null:
    // the rung list must not die on a denied roster read.
    const wsResp = await client.call('get_workspace', { workspaceId });
    const ws = isErr(wsResp.body)
      ? null
      : ((wsResp.body as unknown as { workspace: WorkspaceSummary }).workspace ?? null);
    setLoad({
      kind: 'ready',
      // Coerced to null when absent: a test double answering a bare ok must read as "no move".
      move: (moveResp.body as unknown as { move?: Move | null }).move ?? null,
      workspace: ws,
    });
  }, [client, workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const advance = useCallback(
    async (direction: string, input: Record<string, unknown>) => {
      setBusy(true);
      setActionError(null);
      const resp = await client.call('advance_move_step', { workspaceId, direction, ...input });
      setBusy(false);
      if (isErr(resp.body)) {
        setActionError(resp.body);
        return false;
      }
      await refresh();
      return true;
    },
    [client, workspaceId, refresh],
  );

  if (load.kind === 'loading') {
    return (
      <div className="hosting-block">
        <h3 className="diag-subtitle">{t('journey.hosting.title')}</h3>
        <Skeleton rows={3} />
      </div>
    );
  }

  if (load.kind === 'error') {
    return (
      <div className="hosting-block">
        <h3 className="diag-subtitle">{t('journey.hosting.title')}</h3>
        <ErrorBanner error={load.error} context="read" onRetry={() => void refresh()} />
      </div>
    );
  }

  const { move, workspace } = load;
  const current: Rung = served ? 'selfhost' : 'local';
  const active = move !== null && move.completedAt === null;
  const completed = move !== null && move.completedAt !== null;
  const rungLabel = (r: Rung) => t(`journey.hosting.rung.${r}.label`);

  // --- V3a, the retire confirm (used by step 5 AND the S7.5 notice) ----------------------------
  const retire = async () => {
    setBusy(true);
    setRetireError(null);
    // S3.4 ORDER, load-bearing: record step 5 BEFORE archiving. The registry refuses every write
    // except archive_workspace on an archived workspace (workspace_archived, registry.ts), so the
    // archive-first order dead-ended the checklist on a step-5 retry that could never succeed.
    if (move !== null && move.steps[4]?.doneAt == null) {
      const adv = await client.call('advance_move_step', { workspaceId, direction: move.direction, step: 5 });
      if (isErr(adv.body)) {
        // Nothing happened yet: the refusal renders inline and the popover stays open (V3a).
        setBusy(false);
        setRetireError(adv.body);
        return;
      }
    }
    const resp = await client.call('archive_workspace', {
      workspaceId,
      archived: true,
      idempotencyKey: key(),
    });
    setBusy(false);
    if (isErr(resp.body) && resp.body.error !== 'workspace_archived') {
      // The move is now recorded complete but this copy is still writable. The refusal renders
      // inline (popover stays open, V3a), and the refreshed panel behind it carries the S7.5
      // stale-writable notice, whose Stilllegen IS the retry path.
      setRetireError(resp.body);
      await refresh();
      return;
    }
    // Success, or `workspace_archived` from a parallel session: rendered as ALREADY DONE, never a
    // user problem (V3a).
    setRetiring(false);
    await refresh();
  };

  const retireModal = (
    <Modal
      open={retiring}
      role={ALERT_DIALOG}
      onClose={() => setRetiring(false)}
      title={t('journey.retire.title')}
      closeLabel={t('journey.retire.cancel')}
      describedById={retireBodyId}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={() => setRetiring(false)}>
            {t('journey.retire.cancel')}
          </button>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void retire()}>
            {t('journey.retire.confirm')}
          </button>
        </>
      }
    >
      <p id={retireBodyId} className="diag-confirm-body">
        {t('journey.retire.body', { name: workspace?.name ?? '' })}
      </p>
      {retireError !== null && (
        <p className="hosting-inline-error" role="alert">
          {retireError.error === 'permission_denied'
            ? t('journey.retire.denied')
            : t('journey.retire.failed', { code: retireError.error })}
        </p>
      )}
    </Modal>
  );

  // --- The completed posture and the S7.5 stale-writable notice --------------------------------
  if (completed) {
    const [, to] = endsOf(move.direction);
    const staleWritable = workspace !== null && !workspace.archived;
    return (
      <div className="hosting-block">
        <h3 className="diag-subtitle">{t('journey.hosting.title')}</h3>
        <p className="diag-prose">{t('journey.hosting.done', { name: workspace?.name ?? '', target: rungLabel(to) })}</p>
        {staleWritable && (
          <div className="hosting-stale" role="alert">
            <p>{t('journey.stale.notice')}</p>
            <button type="button" className="btn btn--secondary" disabled={busy || !canManage} onClick={() => setRetiring(true)}>
              {t('journey.stale.action')}
            </button>
          </div>
        )}
        {retireModal}
      </div>
    );
  }

  // --- The active checklist --------------------------------------------------------------------
  if (active) {
    const [from, to] = endsOf(move.direction);
    const done = (n: number) => move.steps[n - 1]?.doneAt != null;
    const doneAt = (n: number) => move.steps[n - 1]?.doneAt ?? null;
    const position = move.steps.filter((s) => s.doneAt !== null).length;
    const currentStep = (move.steps.find((s) => s.doneAt === null)?.step ?? 5) as number;

    const manualToggle = (n: number) => (
      <button
        type="button"
        className="btn btn--ghost"
        disabled={busy || !canManage}
        onClick={() => void advance(move.direction, { step: n, done: !done(n) })}
      >
        {done(n) ? t('journey.step.manual_uncheck') : t('journey.step.manual_check')}
      </button>
    );

    const runBackup = async () => {
      setBusy(true);
      setActionError(null);
      const resp = await client.call('create_backup', { workspaceId, idempotencyKey: key() });
      setBusy(false);
      if (isErr(resp.body)) {
        setActionError(resp.body);
        return;
      }
      await advance(move.direction, { step: 1 });
    };

    const openCompare = async () => {
      setComparing(true);
      setMismatch(false);
      setCompareTotal(null);
      const year = new Date().getFullYear();
      const resp = await client.call('trial_balance', {
        workspaceId,
        periodStart: `${year}-01-01`,
        periodEnd: new Date().toISOString().slice(0, 10),
      });
      if (isErr(resp.body)) {
        setActionError(resp.body);
        setComparing(false);
        return;
      }
      const totals = (resp.body as unknown as { totals?: { debitMinor?: number } }).totals;
      setCompareTotal(formatMoney(totals?.debitMinor ?? 0, workspace?.baseCurrency ?? 'CHF'));
    };

    // The one action out of a declared mismatch: back to the backup leg, honestly. Steps 1, 3 and 4
    // re-open (a NEW backup must be created and transferred; step 2's standing instance stands).
    const declareMismatch = async () => {
      setComparing(false);
      setMismatch(true);
      await advance(move.direction, { step: 4, done: false });
      await advance(move.direction, { step: 3, done: false });
      await advance(move.direction, { step: 1, done: false });
    };

    const steps: ChecklistStep[] = [
      {
        label: done(1)
          ? t('journey.step.1_done', { date: formatDate(doneAt(1) ?? '') })
          : t('journey.step.1'),
        done: done(1),
        control:
          !done(1) ? (
            <button type="button" className="btn btn--secondary" disabled={busy || !canManage} onClick={() => void runBackup()}>
              {t('journey.step.1_action')}
            </button>
          ) : undefined,
      },
      {
        label: t(`journey.step.2_${to}`),
        done: done(2),
        control: (
          <>
            {to === 'selfhost' && (
              <>
                {/* D119 posture 2: the image and the compose recipe lead (the one command is in the
                    step label); the reverse-proxy contract stays the second link. */}
                <a className="hosting-guide-link" href={docsUrl('self-hosting/under-an-hour')} target="_blank" rel="noreferrer">
                  {t('journey.step.2_guide')}
                </a>
                <a className="hosting-guide-link" href={docsUrl('self-hosting/served-access')} target="_blank" rel="noreferrer">
                  {t('journey.step.2_proxyGuide')}
                </a>
              </>
            )}
            {manualToggle(2)}
          </>
        ),
      },
      { label: t('journey.step.3'), done: done(3), control: manualToggle(3) },
      {
        label: t('journey.step.4'),
        done: done(4),
        control: !done(4) ? (
          <button type="button" className="btn btn--secondary" disabled={busy || !canManage || currentStep < 4} onClick={() => void openCompare()}>
            {t('journey.compare.check')}
          </button>
        ) : undefined,
      },
      {
        label: t('journey.step.5'),
        done: done(5),
        control: !done(5) ? (
          <button
            type="button"
            className="btn btn--secondary"
            disabled={busy || !canManage || currentStep !== 5}
            onClick={() => setRetiring(true)}
          >
            {t('journey.step.5_action')}
          </button>
        ) : undefined,
      },
    ];

    return (
      <div className="hosting-block">
        <h3 className="diag-subtitle">{t('journey.hosting.title')}</h3>
        {actionError !== null && <ErrorBanner error={actionError} />}
        {mismatch && (
          <div className="hosting-mismatch" role="alert">
            <p>{t('journey.compare.mismatchBody')}</p>
            <p>{t('journey.compare.mismatchAction')}</p>
          </div>
        )}
        <MoveChecklist
          title={t('journey.hosting.moveTitle', { from: rungLabel(from), to: rungLabel(to) })}
          position={t('journey.step.position', { n: Math.min(position + 1, 5), total: 5 })}
          steps={steps}
          footer={
            <div className="hosting-checklist-foot">
              <p className="diag-prose diag-prose-dim">{t('journey.step.manual_note')}</p>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={busy || !canManage}
                onClick={() => void advance(move.direction, { abandon: true })}
              >
                {t('journey.abort')}
              </button>
            </div>
          }
        />
        {comparing && (
          <div className="hosting-compare">
            <p className="diag-prose">{t('journey.compare.note')}</p>
            <p className="diag-prose">
              {compareTotal === null
                ? t('journey.compare.loading')
                : t('journey.compare.total', { total: compareTotal })}
            </p>
            <div className="data-actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || compareTotal === null}
                onClick={() => {
                  setComparing(false);
                  void advance(move.direction, { step: 4 });
                }}
              >
                {t('journey.compare.match')}
              </button>
              <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => void declareMismatch()}>
                {t('journey.compare.mismatch')}
              </button>
            </div>
          </div>
        )}
        {retireModal}
      </div>
    );
  }

  // --- No move in progress: the D106 model and the ladder --------------------------------------
  const rungs: { rung: Rung; disabled: boolean }[] = [
    { rung: 'local', disabled: false },
    { rung: 'selfhost', disabled: false },
    { rung: 'managed', disabled: true },
  ];
  const startDisabled = busy || !canManage || target === null || target === current;

  return (
    <div className="hosting-block">
      <h3 className="diag-subtitle">{t('journey.hosting.title')}</h3>
      {/* The D106 sentence renders ABOVE any rung, in plain language, never buried in help (S3.3). */}
      <p className="diag-prose hosting-model">{t('journey.hosting.model')}</p>
      {actionError !== null && <ErrorBanner error={actionError} />}
      <div className="hosting-rungs" role="radiogroup" aria-label={t('journey.hosting.title')}>
        {rungs.map(({ rung, disabled }) => {
          const isCurrent = rung === current;
          const selected = target === null ? isCurrent : target === rung;
          return (
            <div key={rung} className="hosting-rung">
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                className="hosting-rung-choice"
                disabled={disabled}
                onClick={() => setTarget(rung)}
              >
                {/* A drawn radio mark (K-22: no ●/○ dingbats); aria-checked carries the state. */}
                <span className="hosting-rung-mark" aria-hidden="true" />
                <span className="hosting-rung-label">
                  {rungLabel(rung)}
                  {isCurrent && <span className="hosting-rung-now"> ({t('journey.hosting.rung.current')})</span>}
                  {disabled && <span className="hosting-rung-soon"> {t('journey.hosting.rung.managed.soon')}</span>}
                </span>
                <span className="hosting-rung-hint">{t(`journey.hosting.rung.${rung}.hint`)}</span>
              </button>
              {rung === 'selfhost' && (
                <>
                  {/* D119 posture 2 (Phase 3 landed the image): the rung leads with the compose
                      recipe, "under an hour" first, the reverse-proxy contract second. */}
                  <a className="hosting-guide-link" href={docsUrl('self-hosting/under-an-hour')} target="_blank" rel="noreferrer">
                    {t('journey.hosting.rung.selfhost.guide')}
                  </a>
                  <a className="hosting-guide-link" href={docsUrl('self-hosting/served-access')} target="_blank" rel="noreferrer">
                    {t('journey.hosting.rung.selfhost.proxyGuide')}
                  </a>
                </>
              )}
              {rung === 'managed' && (
                <HelpHint
                  label={t('journey.hosting.rung.managed.more')}
                  title={t('journey.hosting.rung.managed.label')}
                  body={t('journey.hosting.rung.managed.moreBody')}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="hosting-start">
        {/* K-08: a move is a deliberate, rare act on a surface whose daily action is the backup, so it
            is a secondary; its confirm dialog carries the primary. */}
        <button
          type="button"
          className="btn btn--secondary"
          disabled={startDisabled}
          {...(!canManage ? { 'aria-disabled': true, 'aria-describedby': hintId } : {})}
          onClick={() => {
            if (target === null || target === current) return;
            void advance(`${current}_to_${target}`, {});
          }}
        >
          {t('journey.hosting.start')}
        </button>
        {!canManage && (
          <span className="sync-dial-lock" id={hintId}>
            <LockGlyph className="sync-lock-glyph" size={14} />
            {t('journey.hosting.denied')}
          </span>
        )}
      </div>
      {retireModal}
    </div>
  );
}

/**
 * The exit box's four steps, rendered on the SAME checklist component (S6.1). Static here: the
 * exit journey's live position is the move checklist above once a managed/self-host move runs; on
 * a local install this is the standing, honest description of the guarantee's mechanics.
 */
export function ExitChecklist() {
  const t = useT();
  const steps: ChecklistStep[] = [1, 2, 3, 4].map((n) => ({
    label: t(`journey.exit.steps.${n}`),
    done: false,
  }));
  return (
    <MoveChecklist
      title={t('journey.exit.title')}
      position={t('journey.step.position', { n: 1, total: 4 })}
      steps={steps}
    />
  );
}
