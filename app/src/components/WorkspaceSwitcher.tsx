/**
 * WorkspaceSwitcher: the rail-head workspace picker (D24, variant A).
 *
 * `list_workspaces` is the one engine read that legitimately crosses the tenant boundary: it IS the
 * tenant list. This control gives it its GUI twin for SWITCHING (the Setup surface carries the
 * management list, variant B). The trigger names the CURRENT workspace on every surface and
 * discloses the full list on click; each item navigates to `/w/:workspaceId`, which the existing
 * WorkspaceRoute adopts, and below a separator sits "Neuer Arbeitsbereich" leading to Setup's create
 * form (`/setup?new=1`, F-09: name and legal form, seated through `onboard_client`). While
 * no workspace is selected the control renders NOTHING: the no-workspace states already route
 * people to Setup, and a switcher with nothing to switch from would only compete with them.
 *
 * Since K-01 (D137) it shares ONE 36px row with the "TILL Studio" wordmark in the rail head, so the
 * trigger is compact and the name truncates; the menu below spans the whole head row and shows every
 * name in full.
 *
 * The keyboard model is the rail's shared menu button (`useMenuButton`, the OverflowMenu contract):
 * Enter/Space and ArrowDown open at the first item, ArrowUp at the last, arrows wrap, Home/End jump,
 * Escape closes back onto the trigger, Tab and an outside press close quietly. Focus is ROVING.
 *
 * Each item is a two-line row (name over a dim currency and created-date meta line) with the current
 * one marked `aria-current` in the accent-soft pill, and, since K-03 (D137), the mandate's Pendenzen
 * count at its right: the Übersicht's mandates strip only appears from three workspaces, so below
 * that this menu is where a Treuhänder reads which mandate is waiting. The count follows the rail
 * badge's honesty rules (a number or nothing: never a zero, never a placeholder, never a guess).
 *
 * NEVER THE RAW ID (K-02, D137). On a full load the list arrives a beat after the trigger renders,
 * and the trigger used to print `ws_1` in the meantime: the one control that says whose books these
 * are showed a machine id for the first second of every session. Now it shows the LAST KNOWN name
 * (remembered per id, in memory and in `localStorage`), and with no name known an empty placeholder
 * line; the id itself never reaches the screen. A refetch keeps the previous list until the new one
 * lands, so switching never blanks the menu.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useClient } from '../lib/client-context';
import { isErr } from '../lib/client';
import { useWorkspaceId } from '../app/workspace';
import { useMenuButton } from '../app/useMenuButton';
import { useT, formatDate } from '../i18n';

/** One row of `list_workspaces`, as the engine's `WorkspaceSummary` arrives over the wire. */
interface WorkspaceSummary {
  workspaceId: string;
  name: string;
  legalForm: string | null;
  baseCurrency: string;
  fiscalYearStart: string;
  createdAt: string;
}

type ListState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; workspaces: WorkspaceSummary[] };

/** A mandate's waiting count (K-03): only a known, positive number is ever shown. */
type Count = { status: 'loading' } | { status: 'error' } | { status: 'ok'; total: number | null };

/** How many mandates read their count when the menu opens; the rest stay silent (no forty reads). */
export const SWITCHER_COUNT_CAP = 8;

/** The `localStorage` key holding the last known name per workspace id (K-02). */
export const WORKSPACE_NAMES_KEY = 'till-workspace-names';

/** In-memory mirror of the name cache, so a remount never waits on storage. */
const knownNames = new Map<string, string>();

function readKnownName(workspaceId: string): string | null {
  const cached = knownNames.get(workspaceId);
  if (cached !== undefined) return cached;
  try {
    const raw = window.localStorage.getItem(WORKSPACE_NAMES_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const name = (parsed as Record<string, unknown>)[workspaceId];
    if (typeof name !== 'string' || name === '') return null;
    knownNames.set(workspaceId, name);
    return name;
  } catch {
    // Storage can throw outright (private mode, a hardened profile): no name is known, nothing breaks.
    return null;
  }
}

function rememberNames(workspaces: readonly WorkspaceSummary[]): void {
  const record: Record<string, string> = {};
  for (const w of workspaces) {
    if (w.name === '') continue;
    knownNames.set(w.workspaceId, w.name);
    record[w.workspaceId] = w.name;
  }
  try {
    window.localStorage.setItem(WORKSPACE_NAMES_KEY, JSON.stringify(record));
  } catch {
    // Silent, as above: the in-memory mirror still serves this session.
  }
}

/** Test seam: forget every remembered name (the module cache outlives a test's render). */
export function forgetWorkspaceNames(): void {
  knownNames.clear();
}

export function WorkspaceSwitcher() {
  const workspaceId = useWorkspaceId();
  // The guard lives OUTSIDE the stateful component so the hook order never changes shape: with no
  // workspace selected there is nothing to switch from, and the no-workspace states own the screen.
  if (workspaceId === null || workspaceId === '') return null;
  return <SwitcherMenu workspaceId={workspaceId} />;
}

function SwitcherMenu({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const client = useClient();
  const navigate = useNavigate();

  const [state, setState] = useState<ListState>({ kind: 'loading' });
  /** Bumped by the error state's retry, so a failed list read is not a dead end. */
  const [reloadNonce, setReloadNonce] = useState(0);
  const [counts, setCounts] = useState<Record<string, Count>>({});
  // The ids whose count read is in flight or done, so a re-render never fires a second read.
  const requested = useRef<Set<string>>(new Set());

  const menuId = useId();
  const triggerId = useId();

  // Load the list on mount and again whenever the workspace changes: adopting a workspace that was
  // just created is exactly when the cached list is stale. A refetch KEEPS the list it has until the
  // answer lands (K-02): only the very first read starts from `loading`.
  useEffect(() => {
    let cancelled = false;
    setState((previous) => (previous.kind === 'ready' ? previous : { kind: 'loading' }));
    void client.call('list_workspaces', {}).then((resp) => {
      if (cancelled) return;
      if (isErr(resp.body)) {
        setState({ kind: 'error' });
        return;
      }
      const { workspaces } = resp.body as unknown as { workspaces?: WorkspaceSummary[] };
      const list = workspaces ?? [];
      rememberNames(list);
      setState({ kind: 'ready', workspaces: list });
    });
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, reloadNonce]);

  const workspaces = state.kind === 'ready' ? state.workspaces : [];
  // K-02: the live list's name, else the last known one, else nothing (never the raw id).
  const currentName = workspaces.find((w) => w.workspaceId === workspaceId)?.name ?? readKnownName(workspaceId);

  // The flat, focus-ordered entry list: the workspaces, then the new-workspace item. Loading and
  // error still offer the new-workspace way out, so the menu is never empty.
  const entries: { key: string; onSelect: () => void }[] = [
    ...workspaces.map((w) => ({
      key: w.workspaceId,
      onSelect: () => navigate(`/w/${w.workspaceId}`),
    })),
    // F-09 (J1.5 ideal step 1): the new-workspace item opens the CREATE FORM (`/setup?new=1`), never the
    // current mandate's profile. It used to land on `/setup` with the current workspace's name field
    // focused, so typing into "the new mandate's name" edited the existing company.
    { key: 'new-workspace', onSelect: () => navigate('/setup?new=1') },
  ];

  const menu = useMenuButton(entries.length);

  // K-03: read the waiting counts when the menu opens, capped, once per mandate.
  useEffect(() => {
    if (!menu.open) return;
    for (const w of workspaces.slice(0, SWITCHER_COUNT_CAP)) {
      const id = w.workspaceId;
      if (requested.current.has(id)) continue;
      requested.current.add(id);
      setCounts((c) => ({ ...c, [id]: { status: 'loading' } }));
      void client.call('attention_summary', { workspaceId: id, topLimit: 1 }).then((response) => {
        if (isErr(response.body)) {
          setCounts((c) => ({ ...c, [id]: { status: 'error' } }));
          return;
        }
        const total = (response.body as { total?: unknown }).total;
        setCounts((c) => ({ ...c, [id]: { status: 'ok', total: typeof total === 'number' ? total : null } }));
      });
    }
  }, [menu.open, workspaces, client]);

  function selectEntry(index: number) {
    // Focus returns to the trigger BEFORE the navigation runs, so the shell keeps a sane focus
    // position while the route (and possibly the workspace) changes underneath it.
    menu.closeAndRefocus();
    entries[index]?.onSelect();
  }

  return (
    <div className="ws-switcher" ref={menu.rootRef}>
      <button
        type="button"
        id={triggerId}
        ref={menu.triggerRef}
        className="ws-switcher-trigger"
        aria-label={
          currentName === null
            ? t('workspace.switcher.triggerUnnamed')
            : t('workspace.switcher.trigger', { name: currentName })
        }
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-controls={menu.open ? menuId : undefined}
        onClick={menu.onTriggerClick}
        onKeyDown={menu.onTriggerKeyDown}
      >
        {currentName === null ? (
          <span className="ws-switcher-name ws-switcher-name--pending" aria-hidden="true">
            <span className="skeleton ws-switcher-skeleton" />
          </span>
        ) : (
          <span className="ws-switcher-name">{currentName}</span>
        )}
        <svg
          className="ws-switcher-chevron"
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
        >
          <path d="M7 10l5 5 5-5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {menu.open && (
        <div className="ws-switcher-pop">
          {state.kind === 'error' && (
            // Outside the role="menu" container on purpose: a menu's owned children are menu items
            // and separators, and neither a status sentence nor its retry is one. The retry keeps a
            // failed list read from being a dead end (DESIGN.md: every error offers a way out).
            <div className="ws-switcher-note">
              <p className="ws-switcher-note-text">{t('workspace.switcher.loadFailed')}</p>
              <button
                type="button"
                className="ws-switcher-retry"
                onClick={() => setReloadNonce((nonce) => nonce + 1)}
              >
                {t('states.error.retry')}
              </button>
            </div>
          )}
          <div
            className="ws-switcher-menu"
            id={menuId}
            role="menu"
            aria-labelledby={triggerId}
            onKeyDown={menu.onMenuKeyDown}
          >
            {workspaces.map((w, index) => (
              <button
                key={w.workspaceId}
                type="button"
                role="menuitem"
                className="ws-switcher-item"
                aria-current={w.workspaceId === workspaceId ? 'true' : undefined}
                onClick={() => selectEntry(index)}
                {...menu.itemProps(index)}
              >
                <span className="ws-switcher-item-text">
                  <span className="ws-switcher-item-name">{w.name}</span>
                  <span className="ws-switcher-item-meta">{`${w.baseCurrency} · ${formatDate(w.createdAt)}`}</span>
                </span>
                <WaitingCount count={counts[w.workspaceId]} />
              </button>
            ))}
            {workspaces.length > 0 && <div role="separator" className="ws-switcher-sep" />}
            <button
              type="button"
              role="menuitem"
              className="ws-switcher-item ws-switcher-item-new"
              onClick={() => selectEntry(entries.length - 1)}
              {...menu.itemProps(entries.length - 1)}
            >
              <span className="ws-switcher-item-name">{t('workspace.switcher.new')}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A mandate's Pendenzen count in its menu row (K-03). The rail badge's rules: a known positive number
 * or nothing. Loading, a failed read, a denied read (`total: null`) and a true zero render nothing, so
 * the menu never shows a placeholder or a guessed zero.
 */
function WaitingCount({ count }: { count: Count | undefined }) {
  const t = useT();
  if (count === undefined || count.status !== 'ok' || count.total === null || count.total <= 0) return null;
  const shown = count.total > 99 ? '99+' : String(count.total);
  return (
    <span className="rail-badge ws-switcher-item-count" role="img" aria-label={t('workspace.switcher.waiting', { count: shown })}>
      {shown}
    </span>
  );
}

export default WorkspaceSwitcher;
