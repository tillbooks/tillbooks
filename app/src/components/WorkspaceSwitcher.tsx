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
 * The keyboard model MIRRORS OverflowMenu (the shared APG menu-button pattern) rather than
 * inventing a third one:
 *   - Enter or Space opens the menu and puts focus on the FIRST item (via the browser's click).
 *   - ArrowDown opens at the first item, ArrowUp opens at the LAST one.
 *   - ArrowDown / ArrowUp move between items and wrap; Home / End jump to the ends.
 *   - Escape closes and returns focus TO THE TRIGGER; Tab closes and lets the browser move on.
 *   - A pointer press outside closes without stealing focus back.
 * Focus is ROVING: one tab stop, `tabindex="-1"` everywhere else.
 *
 * It is a SIBLING of OverflowMenu, not an extension of it, because the two share only the keyboard
 * model: OverflowMenu's contract is a glyph trigger over flat action labels, while this trigger
 * carries the current workspace's name and every item is a two-line row (name over a dim currency
 * and created-date meta line) with the current one marked `aria-current` in the accent-soft pill.
 * Bending OverflowMenu's API around all of that would have widened a per-row control in four
 * directions.
 *
 * The meta line used to show the raw `ws_<uuid>`, which wrapped over two lines at rail width and
 * dominated each row while carrying near-zero recognition value. It now shows the workspace's base
 * currency and created date, the two facts that actually help tell two sets of books apart, kept to
 * a single truncating line by `.ws-switcher-item-meta`.
 *
 * The current-workspace name comes from the same list; until the list has loaded (or if the id is
 * unknown to it, or the load failed) the trigger falls back to the RAW id, which is always true.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useClient } from '../lib/client-context';
import { isErr } from '../lib/client';
import { useWorkspaceId } from '../app/workspace';
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

/** One focusable menu entry: a workspace row or the trailing new-workspace item. */
interface Entry {
  key: string;
  onSelect: () => void;
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
  const [open, setOpen] = useState(false);
  /** Bumped by the error state's retry, so a failed list read is not a dead end. */
  const [reloadNonce, setReloadNonce] = useState(0);
  /** Index of the entry currently holding focus. -1 while the menu is closed. */
  const [activeIndex, setActiveIndex] = useState(-1);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const menuId = useId();
  const triggerId = useId();

  // Load the list on mount and again whenever the workspace changes: adopting a workspace that was
  // just created is exactly when the cached list is stale.
  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    void client.call('list_workspaces', {}).then((resp) => {
      if (cancelled) return;
      if (isErr(resp.body)) {
        setState({ kind: 'error' });
        return;
      }
      const { workspaces } = resp.body as unknown as { workspaces?: WorkspaceSummary[] };
      setState({ kind: 'ready', workspaces: workspaces ?? [] });
    });
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, reloadNonce]);

  const workspaces = state.kind === 'ready' ? state.workspaces : [];
  const currentName = workspaces.find((w) => w.workspaceId === workspaceId)?.name ?? workspaceId;

  // The flat, focus-ordered entry list: the workspaces, then the new-workspace item. Loading and
  // error still offer the new-workspace way out, so the menu is never empty.
  const entries: Entry[] = [
    ...workspaces.map((w) => ({
      key: w.workspaceId,
      onSelect: () => navigate(`/w/${w.workspaceId}`),
    })),
    // F-09 (J1.5 ideal step 1): the new-workspace item opens the CREATE FORM (`/setup?new=1`), never the
    // current mandate's profile. It used to land on `/setup` with the current workspace's name field
    // focused, so typing into "the new mandate's name" edited the existing company.
    { key: 'new-workspace', onSelect: () => navigate('/setup?new=1') },
  ];

  const openAt = useCallback(
    (index: number, count: number) => {
      setOpen(true);
      setActiveIndex(index < 0 ? count - 1 : index);
    },
    [],
  );

  /** Close and hand focus back to the trigger. Every keyboard exit uses this. */
  const closeAndRefocus = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
    triggerRef.current?.focus();
  }, []);

  /** Close without moving focus, for a pointer press that already landed somewhere else. */
  const closeQuietly = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  // Roving focus: whenever the active index changes while open, move real DOM focus to match.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  // A pointer press outside closes the menu. `mousedown` rather than `click`, so the menu is gone
  // before the click lands on whatever was underneath it.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      const root = rootRef.current;
      if (root !== null && !root.contains(event.target as Node)) closeQuietly();
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, closeQuietly]);

  function onTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openAt(0, entries.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openAt(entries.length - 1, entries.length);
    }
    // Enter and Space are left to the browser: they fire `click`, which opens at the first item.
  }

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((i) => (i + 1) % entries.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((i) => (i - 1 + entries.length) % entries.length);
        break;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setActiveIndex(entries.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        closeAndRefocus();
        break;
      case 'Tab':
        // Do NOT preventDefault: the menu closes and the browser moves focus onward as usual.
        closeQuietly();
        break;
      default:
        break;
    }
  }

  function selectEntry(entry: Entry) {
    // Focus returns to the trigger BEFORE the navigation runs, so the shell keeps a sane focus
    // position while the route (and possibly the workspace) changes underneath it.
    closeAndRefocus();
    entry.onSelect();
  }

  /** Wire one menu item button into the roving-focus model at its flat entry index. */
  function itemProps(index: number) {
    return {
      role: 'menuitem' as const,
      ref: (node: HTMLButtonElement | null) => {
        itemRefs.current[index] = node;
      },
      tabIndex: index === activeIndex ? 0 : -1,
      onFocus: () => setActiveIndex(index),
    };
  }

  return (
    <div className="ws-switcher" ref={rootRef}>
      <button
        type="button"
        id={triggerId}
        ref={triggerRef}
        className="ws-switcher-trigger"
        aria-label={t('workspace.switcher.trigger', { name: currentName })}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? closeQuietly() : openAt(0, entries.length))}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="ws-switcher-name">{currentName}</span>
        <svg
          className="ws-switcher-chevron"
          aria-hidden="true"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
        >
          <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
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
            onKeyDown={onMenuKeyDown}
          >
            {workspaces.map((w, index) => (
              <button
                key={w.workspaceId}
                type="button"
                className="ws-switcher-item"
                aria-current={w.workspaceId === workspaceId ? 'true' : undefined}
                onClick={() => selectEntry(entries[index])}
                {...itemProps(index)}
              >
                <span className="ws-switcher-item-name">{w.name}</span>
                <span className="ws-switcher-item-meta">{`${w.baseCurrency} · ${formatDate(w.createdAt)}`}</span>
              </button>
            ))}
            {workspaces.length > 0 && <div role="separator" className="ws-switcher-sep" />}
            <button
              type="button"
              className="ws-switcher-item ws-switcher-item-new"
              onClick={() => selectEntry(entries[entries.length - 1])}
              {...itemProps(entries.length - 1)}
            >
              <span className="ws-switcher-item-name">{t('workspace.switcher.new')}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default WorkspaceSwitcher;
