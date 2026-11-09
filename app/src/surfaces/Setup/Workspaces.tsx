/**
 * The "Arbeitsbereiche" management panel (D24, variant B).
 *
 * The Setup surface's list twin of `list_workspaces`: every workspace as a row (name over a dim
 * meta line of id, base currency and created date), the ACTIVE one carrying a small "Aktiv" chip in
 * the accent-soft treatment, the whole row navigating to `/w/:workspaceId` for the WorkspaceRoute
 * to adopt. The footer offers "Neuer Arbeitsbereich", which hands over to whatever create
 * affordance the surface already has (the one CreateWorkspaceForm): this panel never grows a
 * second create form.
 *
 * Two render modes, because the panel serves two faces of the surface:
 *  - the loaded profile face renders it ALWAYS, with its own loading (Skeleton), error
 *    (ErrorBanner + retry) and row states;
 *  - the no-workspace face passes `onlyWhenPopulated`, so the panel appears exactly when there is
 *    something to pick from and stays out of the way of a fresh install's create call to action.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useT, formatDate } from '../../i18n';
import { Skeleton, ErrorBanner } from '../../components/states';
import { Status } from '../../components/Status';

/** One row of `list_workspaces`, as the engine's `WorkspaceSummary` arrives over the wire. */
export interface WorkspaceSummary {
  workspaceId: string;
  name: string;
  legalForm: string | null;
  baseCurrency: string;
  fiscalYearStart: string;
  createdAt: string;
}

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; error: Err }
  | { kind: 'ready'; workspaces: WorkspaceSummary[] };

export interface WorkspacesPanelProps {
  /** The currently selected workspace, whose row carries the "Aktiv" chip. Null when none is. */
  activeId: string | null;
  /** Disclose (or scroll to) the surface's EXISTING create-workspace affordance. */
  onNewWorkspace: () => void;
  /** Render nothing until the list has loaded non-empty (the no-workspace face). */
  onlyWhenPopulated?: boolean;
}

export function WorkspacesPanel({ activeId, onNewWorkspace, onlyWhenPopulated = false }: WorkspacesPanelProps) {
  const t = useT();
  const client = useClient();
  const navigate = useNavigate();
  const headingId = useId();

  const [state, setState] = useState<ListState>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const resp = await client.call('list_workspaces', {});
    if (isErr(resp.body)) {
      setState({ kind: 'error', error: resp.body });
      return;
    }
    const { workspaces } = resp.body as unknown as { workspaces?: WorkspaceSummary[] };
    setState({ kind: 'ready', workspaces: workspaces ?? [] });
  }, [client]);

  // Load on mount and again when the selection changes: adopting a workspace that was just
  // created is exactly when the cached list is stale.
  useEffect(() => {
    void load();
  }, [load, activeId]);

  if (onlyWhenPopulated && (state.kind !== 'ready' || state.workspaces.length === 0)) return null;

  return (
    <section className="panel setup-panel" aria-labelledby={headingId}>
      <h2 id={headingId} className="setup-panel-title">
        {t('workspaces.title')}
      </h2>

      {state.kind === 'loading' && <Skeleton rows={3} height={40} />}
      {state.kind === 'error' && <ErrorBanner error={state.error} context="read" onRetry={() => void load()} />}
      {state.kind === 'ready' &&
        (state.workspaces.length === 0 ? (
          <p className="field-hint">{t('workspaces.empty')}</p>
        ) : (
          <ul className="setup-ws-list">
            {state.workspaces.map((ws) => (
              <li key={ws.workspaceId}>
                <button
                  type="button"
                  className="setup-ws-row"
                  aria-label={t('workspaces.open', { name: ws.name })}
                  aria-current={ws.workspaceId === activeId ? 'true' : undefined}
                  onClick={() => navigate(`/w/${ws.workspaceId}`)}
                >
                  <span className="setup-ws-row-head">
                    <span className="setup-ws-name">{ws.name}</span>
                    {/* K-22: the shared Status, never an accent chip. `.setup-ws-chip` is the verify flows' hook. */}
                    {ws.workspaceId === activeId && (
                      <Status kind="success" label={t('workspaces.active')} className="setup-ws-chip" />
                    )}
                  </span>
                  <span className="setup-ws-meta">
                    {`${ws.workspaceId} · ${ws.baseCurrency} · ${formatDate(ws.createdAt)}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ))}

      <div className="setup-ws-footer">
        <button type="button" className="btn btn--secondary" onClick={onNewWorkspace}>
          {t('workspaces.newWorkspace')}
        </button>
      </div>
    </section>
  );
}
