/**
 * The Eröffnungsprüfung panel (G11 §6), rendered ON the Datenübernahme surface: a check is never
 * read apart from the plan that produced it, so there is no new route.
 *
 * WHAT THIS PANEL IS CAREFUL ABOUT:
 *   - Each control renders as a LABEL-ABOVE-VALUES block, never a five-column row: the German
 *     compounds ("Rohbilanz stimmt mit der Quelle überein") cannot hold a grid at the narrowest
 *     supported width, and promising "no horizontal scroll" without changing the layout would be an
 *     assertion rather than a solution.
 *   - A `passed` control renders NEUTRAL INK plus a check glyph and NO colour at all (brand: an
 *     all-clear state does not get a colour). `not_asserted` and `not_computable` render
 *     `--t-warn`, which is ORANGE, never amber (brass occupies amber); `failed` renders
 *     `--t-danger`. Status is always glyph PLUS text, never colour alone.
 *   - Waiving sits on the individual control row, never as a panel-level action, and the reason is
 *     required BEFORE the call: the engine refuses a blank reason (`waiver_needs_reason`) and the
 *     panel says why rather than round-tripping to find out.
 *   - Readiness never reads plain-ready over waivers: with N waivers the line is
 *     "bereit, mit N Ausnahmen".
 */
import { useCallback, useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { formatMoney, useT } from '../../i18n';
import { ErrorBanner, Skeleton } from '../../components/states';

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export interface ControlDto {
  controlId: string;
  kind: string;
  scope: string;
  declaredMinor: number | null;
  computedMinor: number | null;
  differenceMinor: number | null;
  status: string;
  waiverReason: string | null;
  detail: string | null;
}

interface CheckSummaryDto {
  checkId: string;
  clean: boolean;
  checkHash: string;
  createdAt: string;
}

/** Engine control kinds are snake_case; the catalogue keys are camelCase. */
const KIND_KEY: Record<string, string> = {
  trial_balance_balanced: 'trialBalanceBalanced',
  trial_balance_matches_source: 'trialBalanceMatchesSource',
  ar_control: 'arControl',
  ap_control: 'apControl',
  bank_control: 'bankControl',
  vat_balance_at_cutover: 'vatBalanceAtCutover',
  row_count: 'rowCount',
  document_integrity: 'documentIntegrity',
  source_as_at: 'sourceAsAt',
};

const STATUS_KEY: Record<string, string> = {
  passed: 'passed',
  failed: 'failed',
  not_asserted: 'notAsserted',
  not_computable: 'notComputable',
  waived: 'waived',
};

/** Glyph PLUS text always; the glyph is aria-hidden because the text says the same thing. */
const STATUS_GLYPH: Record<string, string> = {
  passed: '✓',
  failed: '✕',
  not_asserted: '!',
  not_computable: '?',
  waived: '≈',
};

/** The kinds whose figures are money in Rappen; the others count rows or days. */
const MONEY_KINDS = new Set([
  'trial_balance_balanced',
  'trial_balance_matches_source',
  'ar_control',
  'ap_control',
  'bank_control',
  'vat_balance_at_cutover',
]);

type PanelState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'empty' }
  | { status: 'loaded'; check: CheckSummaryDto; controls: ControlDto[] };

export function OpeningCheck(props: { workspaceId: string; planId: string; stepId: string | null }): React.ReactElement {
  const { workspaceId, planId, stepId } = props;
  const client = useClient();
  const t = useT();
  const [state, setState] = useState<PanelState>({ status: 'loading' });
  const [currency, setCurrency] = useState('CHF');
  const [waivingId, setWaivingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [reasonHint, setReasonHint] = useState(false);
  const [exportedAs, setExportedAs] = useState<string | null>(null);
  // A refused write used to reload in silence: the run, waive and export handlers now name the failure
  // as text (role="alert") instead of leaving the screen unchanged after a call the engine rejected.
  const [actionError, setActionError] = useState<'run' | 'waive' | 'export' | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    const profile = (await client.call('get_company_profile', { workspaceId })).body;
    if (!isErr(profile)) {
      const base = (profile.profile as { baseCurrency?: string } | undefined)?.baseCurrency;
      if (typeof base === 'string' && base !== '') setCurrency(base);
    }
    const listed = (await client.call('migration_list_checks', { workspaceId, planId })).body;
    if (isErr(listed)) {
      setState({ status: 'error' });
      return;
    }
    const newest = ((listed.checks ?? []) as CheckSummaryDto[])[0];
    if (newest === undefined) {
      setState({ status: 'empty' });
      return;
    }
    const full = (await client.call('migration_get_check', { workspaceId, checkId: newest.checkId })).body;
    if (isErr(full)) {
      setState({ status: 'error' });
      return;
    }
    setState({ status: 'loaded', check: newest, controls: (full.controls ?? []) as ControlDto[] });
  }, [client, workspaceId, planId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(): Promise<void> {
    if (stepId === null) return;
    setActionError(null);
    const res = (
      await client.call('migration_check_step', {
        workspaceId,
        planId,
        stepId,
        against: 'testmandant',
        idempotencyKey: newIdempotencyKey(),
      })
    ).body;
    if (isErr(res)) {
      setActionError('run');
      return;
    }
    await load();
  }

  async function waive(controlId: string): Promise<void> {
    if (reason.trim() === '') {
      // The engine would refuse with waiver_needs_reason; the panel says why without a round trip.
      setReasonHint(true);
      return;
    }
    setActionError(null);
    const waived = (await client.call('migration_waive_control', { workspaceId, controlId, reason: reason.trim(), idempotencyKey: newIdempotencyKey() })).body;
    if (isErr(waived)) {
      setActionError('waive');
      return;
    }
    // The waiver lives on the control row; re-running the check mints the snapshot that carries it.
    if (stepId !== null) {
      const rechecked = (await client.call('migration_check_step', { workspaceId, planId, stepId, against: 'testmandant', idempotencyKey: newIdempotencyKey() })).body;
      if (isErr(rechecked)) {
        setActionError('waive');
        return;
      }
    }
    setWaivingId(null);
    setReason('');
    setReasonHint(false);
    await load();
  }

  async function exportBericht(checkId: string): Promise<void> {
    setActionError(null);
    const res = (await client.call('migration_export_check', { workspaceId, checkId, format: 'json' })).body;
    if (isErr(res)) {
      setActionError('export');
      return;
    }
    if (typeof res.filename === 'string') setExportedAs(res.filename);
  }

  function figure(control: ControlDto, minor: number | null): string {
    if (minor === null) return '–';
    return MONEY_KINDS.has(control.kind) ? formatMoney(minor, currency) : String(minor);
  }

  if (state.status === 'loading') {
    return (
      <section className="check" aria-busy="true" aria-label={t('check.title')}>
        <h2>{t('check.title')}</h2>
        <Skeleton rows={2} height={64} />
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section className="check" aria-label={t('check.title')}>
        <h2>{t('check.title')}</h2>
        <ErrorBanner message={t('check.error')} context="read" onRetry={() => void load()} />
      </section>
    );
  }

  if (state.status === 'empty') {
    return (
      <section className="check" aria-label={t('check.title')}>
        <h2>{t('check.title')}</h2>
        <p>{t('check.empty')}</p>
        {stepId !== null && (
          <button type="button" className="btn btn--secondary" onClick={() => void run()}>
            {t('check.run')}
          </button>
        )}
        {actionError !== null && <p className="check-action-error" role="alert">{t(`check.actionError.${actionError}`)}</p>}
      </section>
    );
  }

  const { check, controls } = state;
  const waivers = controls.filter((c) => c.status === 'waived');

  return (
    <section className="check" aria-label={t('check.title')}>
      <h2>{t('check.title')}</h2>

      {check.clean && waivers.length === 0 && <p className="check-clean">{t('check.clean')}</p>}
      {check.clean && waivers.length > 0 && (
        <p className="check-clean">
          {waivers.length === 1 ? t('check.ready.withOneWaiver') : t('check.ready.withWaivers', { n: waivers.length })}
        </p>
      )}
      {waivers.length > 0 && !check.clean && <p>{t('check.waivers.count', { n: waivers.length })}</p>}

      <ul className="check-controls">
        {controls.map((control) => {
          const statusKey = STATUS_KEY[control.status] ?? control.status;
          return (
            <li key={control.controlId} className="check-control" data-status={control.status}>
              <p className="check-control-name">
                {t(`check.kind.${KIND_KEY[control.kind] ?? control.kind}`)}
                {control.scope !== 'workspace' && <span className="check-control-scope">{control.scope}</span>}
              </p>
              <dl className="check-control-values">
                <div>
                  <dt>{t('check.declared')}</dt>
                  <dd>{figure(control, control.declaredMinor)}</dd>
                </div>
                <div>
                  <dt>{t('check.computed')}</dt>
                  <dd>{figure(control, control.computedMinor)}</dd>
                </div>
                <div>
                  <dt>{t('check.difference')}</dt>
                  <dd>{figure(control, control.differenceMinor)}</dd>
                </div>
              </dl>
              <p className="check-control-status">
                <span aria-hidden="true">{STATUS_GLYPH[control.status] ?? ''}</span> {t(`check.status.${statusKey}`)}
                {control.status === 'waived' && control.waiverReason !== null && (
                  <span className="check-waiver-reason">{control.waiverReason}</span>
                )}
              </p>
              {/* A failed money-path gate never carries an INERT control. The recovery names its route
                  as text and, where an in-surface handler exists, offers it: a balance gap is fixed by
                  correcting the figures above and re-running the check (a real action), while a wrong
                  export date is fixed only by a fresh upload in the intake step (named as text). */}
              {control.status === 'failed' && control.kind !== 'source_as_at' && (
                <div className="check-recover" role="group" aria-label={t('check.recover.fixOpening')}>
                  <p className="check-recover-hint">{t('check.recover.fixOpeningHint')}</p>
                  {stepId !== null && (
                    <button type="button" className="btn btn--secondary check-recover-action" onClick={() => void run()}>
                      {t('check.recover.recheck')}
                    </button>
                  )}
                </div>
              )}
              {control.status === 'failed' && control.kind === 'source_as_at' && (
                <div className="check-recover" role="group" aria-label={t('check.recover.newExport')}>
                  <p className="check-recover-hint">{t('check.recover.newExportHint')}</p>
                </div>
              )}
              {control.status !== 'passed' && control.status !== 'waived' && (
                <div className="check-waive">
                  {waivingId === control.controlId ? (
                    <>
                      <label>
                        {t('check.waive.reason')}
                        <input
                          className="field"
                          type="text"
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          aria-invalid={reasonHint ? true : undefined}
                        />
                      </label>
                      {reasonHint && <p className="check-waive-hint" role="alert">{t('check.waive.needsReason')}</p>}
                      <button className="btn btn--secondary" type="button" onClick={() => void waive(control.controlId)}>{t('check.waive.action')}</button>
                    </>
                  ) : (
                    <button className="btn btn--secondary"
                      type="button"
                      onClick={() => {
                        setWaivingId(control.controlId);
                        setReason('');
                        setReasonHint(false);
                      }}
                    >
                      {t('check.waive.action')}
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="check-actions">
        {stepId !== null && (
          <button type="button" className="btn btn--secondary" onClick={() => void run()}>
            {t('check.run')}
          </button>
        )}
        <button className="btn btn--secondary" type="button" onClick={() => void exportBericht(check.checkId)}>{t('check.export')}</button>
        {exportedAs !== null && <span className="check-exported">{t('check.exported', { filename: exportedAs })}</span>}
      </div>
      {actionError !== null && <p className="check-action-error" role="alert">{t(`check.actionError.${actionError}`)}</p>}
      <p className="check-hash">{t('check.hash')}: <code>{check.checkHash}</code></p>
    </section>
  );
}

export default OpeningCheck;
