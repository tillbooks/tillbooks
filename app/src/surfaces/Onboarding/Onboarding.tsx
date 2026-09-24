/**
 * G03, the first-run path choice and resume point, at `/onboarding` (ENGLISH slug, the
 * `/writing-style` precedent).
 *
 * THREE CARDS, EACH A HAND-OVER, NEVER A SECOND DOOR. **Start fresh** lands on A00's own Setup
 * surface; **Import** lands on the G09-G13 Datenübernahme at `/migration` (an import needs the
 * workspace shell first, so with no workspace it routes through Setup and says so); **Demo** calls
 * `create_demo_workspace` and adopts the minted workspace. G03 sequences existing verbs and
 * re-implements none of their screens.
 *
 * THE RESUME POINTER IS READ, NEVER OBEYED. `get_onboarding_progress` decides which card carries
 * the "continue where you left off" affordance; it gates nothing, because the underlying verbs own
 * their own validation (spec §4). `advance_onboarding_step` is written on a choice when a
 * workspace exists to write it into, and skipped silently when none does: pre-workspace there is
 * no row to keep, which is exactly why the engine keeps the pointer per workspace.
 *
 * Per D46 the deep UX polish is the end-of-build pass; the five working states are here: skeleton
 * while the pointer loads, the path choice as the deliberate empty state, inline named errors, the
 * resume affordance on success, and the demo CTA disabled only while a create is in flight (the
 * create itself is pre-workspace and ungated, so there is no padlock to render).
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspace } from '../../app/workspace';
import { useT } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { ErrorBanner, Skeleton } from '../../components/states';
import './Onboarding.css';

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

interface ProgressDto {
  path: string;
  step: string;
  completedAt: string | null;
}

type Phase =
  | { status: 'loading' }
  | { status: 'ready'; progress: ProgressDto | null; workspaceKind: string };

const RESUME_TARGET: Record<string, string> = { fresh: '/setup', import: '/migration', demo: '/overview' };

export function Onboarding(): React.ReactElement {
  const client = useClient();
  const { workspaceId, setWorkspaceId } = useWorkspace();
  const navigate = useNavigate();
  const t = useT();

  // No workspace yet: the pointer has nowhere to live, so the choice renders immediately.
  const [phase, setPhase] = useState<Phase>(
    workspaceId === null ? { status: 'ready', progress: null, workspaceKind: 'live' } : { status: 'loading' },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err | null>(null);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setPhase({ status: 'ready', progress: null, workspaceKind: 'live' });
      return;
    }
    setPhase({ status: 'loading' });
    const res = (await client.call('get_onboarding_progress', { workspaceId })).body;
    if (isErr(res)) {
      // A denied or failed read never blocks the on-ramp: the choice is still the honest screen.
      setPhase({ status: 'ready', progress: null, workspaceKind: 'live' });
      return;
    }
    setPhase({
      status: 'ready',
      progress: (res.progress as ProgressDto | null) ?? null,
      workspaceKind: (res.workspaceKind as string) ?? 'live',
    });
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Record the choice when a workspace exists to record it in, then hand over. */
  async function choose(path: 'fresh' | 'import', step: string, target: string): Promise<void> {
    if (workspaceId !== null) {
      // Bookkeeping only: a refusal (e.g. a viewer without manage_settings) must not block the
      // navigation, because the pointer is never a gate (spec §4).
      await client.call('advance_onboarding_step', { workspaceId, path, step });
    }
    navigate(target);
  }

  async function startDemo(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = (await client.call('create_demo_workspace', { idempotencyKey: newIdempotencyKey() })).body;
    setBusy(false);
    if (isErr(res)) {
      // The engine's own catalogue message drives the copy; the banner carries a retry, so a failed
      // demo mint is never a dead end (DESIGN.md: every error offers a way out).
      setError(res);
      return;
    }
    setWorkspaceId(res.workspaceId as string);
    navigate('/overview');
  }

  // K-07 (D137): the shared header on every state; the header itself never skeletons (K-34).
  const header = (
    actions?: ReactNode,
  ) => (
    <SurfaceHeader
      title={t('onboarding.title')}
      titleId="onboarding-title"
      help={<SurfaceHelp surface="Onboarding" />}
      actions={actions}
    />
  );

  if (phase.status === 'loading') {
    // A skeleton in the shape of the real path choice (three cards in a row), never one block.
    return (
      <section className="onboarding" aria-labelledby="onboarding-title">
        {header()}
        <div className="onboarding-skeleton">
          <Skeleton rows={3} columns={3} height={176} />
        </div>
      </section>
    );
  }

  const progress = phase.progress;

  // The saved pointer only ever reads back one of the three known paths; anything else falls to the
  // fresh path so the resume affordance can never point nowhere.
  const resumePathKey =
    progress !== null && (progress.path === 'import' || progress.path === 'demo') ? progress.path : 'fresh';

  /** The saved step's label; an unknown step id falls back to the raw string, never a dot-path key. */
  function stepLabel(step: string): string {
    const key = `onboarding.step.${step}`;
    const hit = t(key);
    return hit === key ? step : hit;
  }

  const resumable = progress !== null && progress.completedAt === null;

  return (
    <section className="onboarding" aria-labelledby="onboarding-title">
      {/* K-08: the resume affordance is the one primary on this surface, so it sits in the header's
          action slot; the three path choices below stay equal secondaries. */}
      {header(
        resumable && progress !== null ? (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => navigate(RESUME_TARGET[resumePathKey] ?? '/setup')}
          >
            {t('onboarding.resumeStep', { step: stepLabel(progress.step) })}
          </button>
        ) : undefined,
      )}
      <p className="onboarding-intro">{t('onboarding.intro')}</p>

      {resumable && (
        // K-24: the path name lives in this supporting line; the header button names the saved STEP,
        // so its accessible name can never collide with the path card's button below.
        <p className="onboarding-resume" role="status">
          {t('onboarding.resume')} ({t(`onboarding.pathChoice.${resumePathKey}`)})
        </p>
      )}

      <ul className="onboarding-paths">
        <li className="onboarding-card">
          <h2>{t('onboarding.pathChoice.fresh')}</h2>
          <p>{t('onboarding.pathChoice.freshBody')}</p>
          <button type="button" className="btn btn--secondary" onClick={() => void choose('fresh', 'company', '/setup')}>
            {t('onboarding.pathChoice.fresh')}
          </button>
        </li>
        <li className="onboarding-card">
          <h2>{t('onboarding.pathChoice.import')}</h2>
          <p>{workspaceId === null ? t('onboarding.pathChoice.importNeedsWorkspace') : t('onboarding.pathChoice.importBody')}</p>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => void choose('import', 'plan', workspaceId === null ? '/setup' : '/migration')}
          >
            {t('onboarding.pathChoice.import')}
          </button>
        </li>
        <li className="onboarding-card">
          <h2>{t('onboarding.pathChoice.demo')}</h2>
          <p>{t('onboarding.pathChoice.demoBody')}</p>
          <button
            type="button"
            className="btn btn--secondary"
            disabled={busy}
            onClick={() => void startDemo()}
          >
            {busy ? t('onboarding.demoBusy') : t('onboarding.pathChoice.demo')}
          </button>
        </li>
      </ul>

      {error !== null && (
        <div className="onboarding-error">
          <ErrorBanner
            error={error}
            onRetry={() => {
              setError(null);
              void startDemo();
            }}
          />
        </div>
      )}
    </section>
  );
}

export default Onboarding;
