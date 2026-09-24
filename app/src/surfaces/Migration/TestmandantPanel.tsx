/**
 * The Testmandant panel (G12 §6), rendered ON the Datenübernahme surface beside the Eröffnungsprüfung:
 * a trial workspace is never managed apart from the plan that trial-loads it, so there is no new route.
 *
 * WHAT THIS PANEL IS CAREFUL ABOUT (per D46 the deep UX polish is a later pass; the WORKING states
 * are here):
 *   - ONE shared WorkspaceModeBanner keyed on `workspace.kind`, `role="status"`, announced once: two
 *     banner components for one question ("these are not your real books") would be two answers.
 *   - The banner carries ONE primary action (Produktiv setzen when the check is clean; Zur Übernahme
 *     otherwise) and puts discard in an OVERFLOW behind a confirm, never as a peer button: an
 *     irreversible act and a destructive act side by side is the named anti-pattern.
 *   - Going productive is the least reversible act, so the confirm is a TYPE-TO-CONFIRM against the
 *     company's legal name, with a visible persistent label. The engine checks it too (a wrong name
 *     refuses regardless of transport), so this is defence in depth, not the only gate.
 *   - Permission-denied renders the control DISABLED naming the missing right (promote_workspace /
 *     commit_migration), never hidden.
 *   - A neutral elevated strip, one brass accent on the single primary action, glyph plus text; no
 *     second accent colour (G03's banner rule, kept), dark/light parity.
 */
import { useCallback, useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useCapabilities, CAP } from '../../lib/capabilities';
import { useT, formatDate } from '../../i18n';
import { PermissionDenied, Skeleton } from '../../components/states';

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** A data-class id as its catalogue label, falling back to the raw id when a class has no key yet. */
function dataClassLabel(t: (key: string) => string, dataClass: string): string {
  const key = `migration.dataClass.${dataClass}`;
  const hit = t(key);
  return hit === key ? dataClass : hit;
}

interface TestmandantDto {
  none?: true;
  workspaceId?: string;
  kind?: string | null;
  promotedAt?: string | null;
}

interface ProfileDto {
  name: string;
}

type Phase =
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'present'; workspaceId: string; kind: string; legalName: string };

interface DiffRow {
  dataClass: string;
  testmandantCount: number;
  liveCount: number;
}

type DiffState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'noLive' }
  | { status: 'loaded'; rows: DiffRow[] };

const GO_PRODUCTIVE_ERRORS = new Set([
  'check_not_clean',
  'sandbox_contains_demo_rows',
  'needs_company_profile',
  'live_workspace_exists',
  'confirm_name_mismatch',
]);

/** Map an engine gate-leg error to its catalogue key (each leg gets its own message + recovery). */
const ERROR_KEY: Record<string, string> = {
  check_not_clean: 'checkNotClean',
  sandbox_contains_demo_rows: 'containsDemoRows',
  needs_company_profile: 'needsCompanyProfile',
  live_workspace_exists: 'liveWorkspaceExists',
  confirm_name_mismatch: 'confirmMismatch',
  not_a_testmandant: 'notATestmandant',
  plan_already_live: 'planAlreadyLive',
};

export function TestmandantPanel(props: {
  workspaceId: string;
  planId: string;
  planState: string;
  /** True when the plan's Eröffnungsprüfung is clean, so the primary action is Produktiv setzen. */
  checkClean: boolean;
  /**
   * F-09: true while the Übernahmestichtag is still ahead. The promotion control then renders
   * DISABLED with the reason on the control (the engine refuses `cutover_in_future` for the same
   * reason), so a prepared plan never shows a button that would be refused.
   */
  cutoverPending?: boolean;
  cutoverDate?: string | null;
  onChanged: () => void;
}): React.ReactElement {
  const { workspaceId, planId, planState, checkClean, onChanged } = props;
  const cutoverPending = props.cutoverPending === true;
  const cutoverDateText = props.cutoverDate == null ? '' : formatDate(props.cutoverDate);
  const client = useClient();
  const caps = useCapabilities();
  const t = useT();

  const [phase, setPhase] = useState<Phase>({ status: 'loading' });
  const [confirmName, setConfirmName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // f6: the Testmandant-to-live comparison used to be fired and DISCARDED (the response never
  // rendered). It now lands in state, with its own loading, error, no-live and no-differences states.
  const [diff, setDiff] = useState<DiffState>({ status: 'idle' });
  // f10: discard destroys a trial workspace, so it sits behind a confirm sub-state (shaped like the
  // close/abandon confirms on the parent surface), never firing on the first click of the disclosure.
  const [discardConfirm, setDiscardConfirm] = useState(false);

  // promote_workspace AND commit_migration, the two the engine requires together; the disabled
  // control names the FIRST one missing so the operator knows exactly which right to request.
  const missingRight = !caps.can(CAP.promoteWorkspace)
    ? CAP.promoteWorkspace
    : !caps.can(CAP.commitMigration)
      ? CAP.commitMigration
      : null;

  const load = useCallback(async () => {
    setPhase({ status: 'loading' });
    const res = (await client.call('migration_get_testmandant', { workspaceId, planId })).body;
    if (isErr(res) || res.none === true) {
      setPhase({ status: 'none' });
      return;
    }
    const dto = res as TestmandantDto;
    const wsId = dto.workspaceId as string;
    const profile = (await client.call('get_company_profile', { workspaceId: wsId })).body;
    const legalName = isErr(profile) ? '' : ((profile.profile as ProfileDto).name ?? '');
    setPhase({ status: 'present', workspaceId: wsId, kind: (dto.kind as string) ?? 'sandbox', legalName });
  }, [client, workspaceId, planId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createTestmandant(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = (await client.call('migration_create_testmandant', { workspaceId, planId, idempotencyKey: newIdempotencyKey() })).body;
    setBusy(false);
    if (isErr(res)) {
      setError(res.error);
      return;
    }
    await load();
    onChanged();
  }

  async function goProductive(): Promise<void> {
    if (phase.status !== 'present') return;
    setBusy(true);
    setError(null);
    const res = (await client.call('go_productive', { workspaceId, planId, confirmedName: confirmName, idempotencyKey: newIdempotencyKey() })).body;
    setBusy(false);
    if (isErr(res)) {
      setError(GO_PRODUCTIVE_ERRORS.has(res.error) ? res.error : 'error');
      return;
    }
    setConfirmName('');
    await load();
    onChanged();
  }

  async function runDiff(): Promise<void> {
    setDiff({ status: 'loading' });
    const res = (await client.call('migration_diff_testmandant_to_live', { workspaceId, planId })).body;
    if (isErr(res)) {
      setDiff({ status: 'error' });
      return;
    }
    // The engine returns `{live:null}` when no live workspace of this UID exists: the comparison does
    // not arise, which is a distinct empty state from "compared, no differences".
    if (res.live === null || res.live === undefined) {
      setDiff({ status: 'noLive' });
      return;
    }
    setDiff({ status: 'loaded', rows: (res.perClass as DiffRow[]) ?? [] });
  }

  async function discard(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = (await client.call('discard_testmandant', { workspaceId, planId, confirmed: true, idempotencyKey: newIdempotencyKey() })).body;
    setBusy(false);
    if (isErr(res)) {
      setError(res.error);
      return;
    }
    setDiscardConfirm(false);
    await load();
    onChanged();
  }

  if (phase.status === 'loading') {
    return (
      <section className="testmandant" aria-busy="true">
        <Skeleton rows={1} height={64} />
      </section>
    );
  }

  if (phase.status === 'none') {
    // Empty: what a Testmandant is for, and the offer to create one once the plan is planned.
    const canCreate = planState !== 'draft';
    return (
      <section className="testmandant testmandant-empty">
        <h2>{t('migration.testmandant.empty.title')}</h2>
        <p>{t('migration.testmandant.empty.body')}</p>
        {canCreate && (
          <button type="button" className="btn btn--primary" disabled={busy || !caps.can(CAP.manageImport)} onClick={() => void createTestmandant()}>
            {t('migration.testmandant.create')}
          </button>
        )}
        {error !== null && <p className="testmandant-error" role="alert">{t(`migration.testmandant.err.${ERROR_KEY[error] ?? 'generic'}`)}</p>}
      </section>
    );
  }

  // A live workspace is simply the workspace now: no banner, because the state is gone.
  if (phase.kind === 'live') {
    return (
      <section className="testmandant">
        <p className="testmandant-live" role="status">{t('migration.testmandant.wentLive')}</p>
      </section>
    );
  }

  const primaryLabel = checkClean ? t('migration.testmandant.goProductive') : t('migration.testmandant.toIntake');

  return (
    <section className="testmandant">
      {/* The one shared WorkspaceModeBanner: names what the workspace is and the plan it belongs to. */}
      <div className="workspace-mode-banner" role="status">
        {/* K-22: an SVG from the icon language (a flag), never a text dingbat. */}
        <svg className="workspace-mode-glyph" width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="M5 21V4" />
          <path d="M5 4h11l-2 4 2 4H5" />
        </svg>
        <span className="workspace-mode-text">
          <strong>{t('migration.testmandant.banner.title')}</strong>
          <span className="workspace-mode-plan">{t('migration.testmandant.banner.plan')}</span>
        </span>

        {/* ONE primary action on the banner. Discard is NOT a peer here: it lives in the overflow below. */}
        {checkClean ? (
          missingRight !== null ? (
            // The reason is the PermissionDenied note below, never a `title` tooltip (DESIGN.md).
            <button type="button" className="btn btn--primary" disabled aria-disabled="true">
              {primaryLabel}
            </button>
          ) : cutoverPending ? (
            // F-09: prepared ahead of the Stichtag. The control is disabled with its reason tied to
            // it (D15/C3: the precondition is named inline, never a tooltip alone).
            <button type="button" className="btn btn--primary" disabled aria-disabled="true" aria-describedby="testmandant-stichtag-note">
              {primaryLabel}
            </button>
          ) : null
        ) : (
          <button type="button" className="btn btn--primary" onClick={onChanged}>{primaryLabel}</button>
        )}
      </div>

      {checkClean && missingRight === null && cutoverPending && (
        <p id="testmandant-stichtag-note" className="testmandant-stichtag-note" role="status">
          {t('migration.testmandant.waitForStichtag', { date: cutoverDateText })}
        </p>
      )}

      {/* The type-to-confirm, shown when the check is clean, the Stichtag has arrived and the operator holds the rights. */}
      {checkClean && missingRight === null && !cutoverPending && (
        <form
          className="testmandant-confirm"
          onSubmit={(e) => {
            e.preventDefault();
            void goProductive();
          }}
        >
          <label htmlFor="testmandant-confirm-input">{t('migration.testmandant.confirmLabel')}</label>
          <p className="testmandant-irreversible">{t('migration.testmandant.irreversible')}</p>
          <input
            className="field"
            id="testmandant-confirm-input"
            type="text"
            value={confirmName}
            autoComplete="off"
            onChange={(e) => setConfirmName(e.target.value)}
            aria-describedby="testmandant-confirm-expected"
          />
          <span id="testmandant-confirm-expected" className="testmandant-expected">{phase.legalName}</span>
          <button type="submit" className="btn btn--primary" disabled={busy || confirmName !== phase.legalName}>
            {t('migration.testmandant.goProductive')}
          </button>
        </form>
      )}

      {checkClean && missingRight !== null && (
        <PermissionDenied body={t(`capability.${missingRight}`)} />
      )}

      {error !== null && (
        <p className="testmandant-error" role="alert">{t(`migration.testmandant.err.${ERROR_KEY[error] ?? 'generic'}`)}</p>
      )}

      {/* Discard in an OVERFLOW behind a native disclosure, never a peer of the primary action. */}
      <details className="testmandant-overflow">
        <summary>{t('migration.testmandant.more')}</summary>

        {/* f6: the comparison renders its result (per data class, the row counts on each side), with a
            distinct no-live and no-differences state and an error line, instead of discarding the read. */}
        <button type="button" className="btn btn--secondary testmandant-diff" disabled={busy || diff.status === 'loading'} onClick={() => void runDiff()}>
          {t('migration.testmandant.diff.title')}
        </button>
        {diff.status === 'loading' && <p className="testmandant-diff-status">{t('migration.testmandant.diff.loading')}</p>}
        {diff.status === 'error' && <p className="testmandant-diff-error" role="alert">{t('migration.testmandant.diff.error')}</p>}
        {diff.status === 'noLive' && <p className="testmandant-diff-empty">{t('migration.testmandant.diff.noLive')}</p>}
        {diff.status === 'loaded' && (
          diff.rows.every((r) => r.testmandantCount === r.liveCount) ? (
            <p className="testmandant-diff-empty">{t('migration.testmandant.diff.same')}</p>
          ) : (
            <ul className="testmandant-diff-rows" aria-label={t('migration.testmandant.diff.title')}>
              {diff.rows.map((r) => (
                <li key={r.dataClass} data-changed={r.testmandantCount !== r.liveCount ? 'true' : undefined}>
                  {t('migration.testmandant.diff.row', {
                    class: dataClassLabel(t, r.dataClass),
                    testmandant: r.testmandantCount,
                    live: r.liveCount,
                  })}
                </li>
              ))}
            </ul>
          )
        )}

        {/* f10: discard is destructive (it destroys the trial workspace). It now sits behind a confirm
            sub-state; the disclosure hiding the button was never a confirmation. */}
        {!discardConfirm ? (
          <button type="button" className="testmandant-discard" disabled={busy} onClick={() => setDiscardConfirm(true)}>
            {t('migration.testmandant.discard')}
          </button>
        ) : (
          <div className="testmandant-discard-confirm" role="group" aria-label={t('migration.testmandant.discard')}>
            <p>{t('migration.testmandant.discardConfirm')}</p>
            <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void discard()}>
              {t('migration.testmandant.discard')}
            </button>
            <button className="btn btn--secondary" type="button" onClick={() => setDiscardConfirm(false)}>{t('migration.intake.back')}</button>
          </div>
        )}
      </details>
    </section>
  );
}

export default TestmandantPanel;
