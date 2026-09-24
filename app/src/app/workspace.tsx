/**
 * The current workspace (tenant) context.
 *
 * Every ctx-based engine verb needs a `workspaceId` in its input. The Studio operates on ONE
 * workspace at a time (multi-client switching is A23, out of Module 1 scope), so a single id lives
 * here and each surface reads it with `useWorkspaceId()` and threads it into `client.call(action,
 * { workspaceId, ... })`. The Setup surface is where a workspace is created or chosen and
 * `setWorkspaceId` is called. In component tests, wrap the surface in
 * `<WorkspaceProvider initialId="ws_test">` to supply a fixed id.
 *
 * A null id means "no workspace selected yet": a surface that needs one renders its empty/setup
 * state rather than calling a ctx verb with a blank tenant (which the engine rejects as
 * `invalid_input`).
 *
 * D12: the selection now SURVIVES A RELOAD. The id used to live in `useState` alone, so refreshing
 * the page lost the tenant and the only way forward was minting a duplicate workspace. It seeds
 * from `/w/:workspaceId` when the URL names one and from `localStorage` otherwise, and every
 * selection is written back (see `../lib/workspace-store`). The `useWorkspace()` API is unchanged,
 * so no surface has to know any of this.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';

import { isErr } from '../lib/client';
import { useClient } from '../lib/client-context';
import { Skeleton } from '../components/states';
import { isWorkspaceId, resolveInitialWorkspaceId, storeWorkspaceId } from '../lib/workspace-store';
import { NAV_ITEMS } from './nav';

export interface Workspace {
  workspaceId: string | null;
  setWorkspaceId: (id: string | null) => void;
}

const WorkspaceContext = createContext<Workspace | null>(null);

export function WorkspaceProvider({
  children,
  initialId,
}: {
  children: ReactNode;
  /**
   * Force the starting id (component tests pass a fixed one). Omit it in the real app, where the
   * URL and then `localStorage` decide. Passing `null` explicitly means "start with no workspace".
   */
  initialId?: string | null;
}) {
  const [workspaceId, setId] = useState<string | null>(() =>
    initialId === undefined ? resolveInitialWorkspaceId() : initialId,
  );

  const setWorkspaceId = useCallback((id: string | null) => {
    // Persist FIRST, then re-render: if the tab closes a beat later, the choice already survived.
    storeWorkspaceId(id);
    setId(id);
  }, []);

  const value = useMemo<Workspace>(() => ({ workspaceId, setWorkspaceId }), [workspaceId, setWorkspaceId]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

/** Read + set the current workspace. Throws outside a provider, which is a wiring bug. */
export function useWorkspace(): Workspace {
  const ctx = useContext(WorkspaceContext);
  if (ctx === null) throw new Error('useWorkspace must be used within a WorkspaceProvider.');
  return ctx;
}

/** The common case: just the current workspace id (null if none is selected yet). */
export function useWorkspaceId(): string | null {
  return useWorkspace().workspaceId;
}

/**
 * The `/w/:workspaceId` route: adopt the workspace the link names, then hand over to the app.
 *
 * The provider already reads the id from the URL on a cold load; this route covers the in-app case
 * (a client-side navigation to a `/w/...` link) and is what turns the bare workspace URL into a real
 * surface. A malformed id is IGNORED rather than adopted, so a hand-edited address bar cannot push
 * a junk tenant into every engine call: the app opens on its no-workspace state instead.
 */
export function WorkspaceRoute() {
  const { workspaceId: fromUrl } = useParams();
  const { setWorkspaceId } = useWorkspace();
  const valid = isWorkspaceId(fromUrl);

  useEffect(() => {
    if (valid) setWorkspaceId(fromUrl!);
  }, [valid, fromUrl, setWorkspaceId]);

  // US-G16.9: a dead deep link (a malformed or missing id) is a detour, not a dead end. It lands on
  // the workspace picker / first-run flow (Setup) rather than adopting a junk tenant into every
  // engine call. The picker's copy reads identically for "unknown" and "not mine" (shell.deeplink.*),
  // so following the link never reveals whether the id exists. A well-formed id is adopted and hands
  // over to the landing page; whether it is actually the operator's is the engine's call, and each
  // surface renders that answer.
  return <Navigate to={valid ? NAV_ITEMS[0].path : '/setup'} replace />;
}

/**
 * The `/w/:workspaceId/<surface>` splat (kaizen K-10): a shared per-workspace deep link. It adopts
 * the workspace exactly the way `WorkspaceRoute` does, then redirects to the suffix path inside the
 * Shell, carrying the query string along (a `?focus=` record link survives the handover). Before
 * this route existed the shape had no match at all, so a link like `/w/ws_1/payments` raised the
 * router 404 into `RouteCrash`, the panel for a broken screen, about an address that was merely
 * longer than the router knew. A malformed id takes the same US-G16.9 detour to the picker.
 */
export function WorkspaceSurfaceRoute() {
  const { workspaceId: fromUrl, '*': suffix } = useParams();
  const { search } = useLocation();
  const { setWorkspaceId } = useWorkspace();
  const valid = isWorkspaceId(fromUrl);

  useEffect(() => {
    if (valid) setWorkspaceId(fromUrl!);
  }, [valid, fromUrl, setWorkspaceId]);

  return <Navigate to={valid ? `/${suffix ?? ''}${search}` : '/setup'} replace />;
}

/**
 * US-G16.10, the route-layer §H-TENANT guard. On a workspace switch, a RECORD-scoped route (one
 * highlighting a record, by a `focus` query param or a detail path segment under a splat surface)
 * resets to its list root, so a detail id from the workspace just left never resolves under the new
 * one. A LIST route keeps its path. This is a static property of the URL, not a runtime guess.
 */
export function tenantResetTarget(pathname: string, search: string): string | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  const base = `/${segments[0]}`;
  if (new URLSearchParams(search).has('focus')) return base; // strip the highlighted record
  // The two surfaces that own a nested detail tree under a splat (router.tsx): a segment beyond the
  // base that is not the `new` composer is a record detail.
  if ((segments[0] === 'documents' || segments[0] === 'payments') && segments.length > 1 && segments[1] !== 'new') {
    return base;
  }
  return null;
}

/**
 * Mounted once in the shell: it watches the active workspace and, on a CHANGE (never on first
 * mount), resets a record-scoped route to its list root. A list route is left untouched.
 */
export function TenantRouteReset() {
  const workspaceId = useWorkspaceId();
  const location = useLocation();
  const navigate = useNavigate();
  const previous = useRef<string | null>(workspaceId);

  useEffect(() => {
    if (previous.current === workspaceId) return;
    previous.current = workspaceId;
    const target = tenantResetTarget(location.pathname, location.search);
    if (target !== null && target !== `${location.pathname}${location.search}`) navigate(target, { replace: true });
  }, [workspaceId, location.pathname, location.search, navigate]);

  return null;
}

/**
 * F-02 (friction ledger, Phase 2): the morning starts on the books.
 *
 * THE DEFECT. A ledger with existing workspaces and NO remembered selection (a new machine, a fresh
 * browser profile, a cleared store, or simply the first load after `till up` on an adopted file)
 * landed on "Kein Arbeitsbereich vorhanden", whose only action created a NEW workspace. The existing
 * books were reachable only through `/setup`'s Arbeitsbereiche panel or the switcher. Every daily
 * story (J2.1 to J2.6, J7.2) paid one screen and two clicks for it, and J1.7's adopted file was
 * answered with an invitation to start over. A fresh `till up` with no ledger at all landed on the
 * same generic state instead of the `/first-run` door with the residency sentence (J1.1 step 1).
 *
 * THE RULE, Studio-side (no engine verb, per the brief): the remembered selection wins when there is
 * one; otherwise the landing workspace is the FIRST row of `list_workspaces`, which the engine orders
 * `created_at DESC` over the caller's non-archived workspaces. The engine exposes no per-workspace
 * "last written" timestamp, so "most recently written" is approximated by "most recently set up":
 * the newest workspace is the one the person most recently created, restored or onboarded, and a
 * stale guess is one switcher click away, while the old state was a dead end. With NO workspace the
 * landing route itself becomes the `/first-run` door (three doors, residency sentence, restore
 * offered there), and `/first-run` stays a nav leaf too (K-14). A stored id that is no longer in the
 * list (the ledger file was swapped under the Studio) is replaced the same way, so a tenant that does
 * not exist is never threaded into every engine call.
 */
export function pickLandingWorkspace(
  workspaces: readonly { workspaceId?: unknown; archived?: unknown }[],
): string | null {
  for (const w of workspaces) {
    if (w.archived === true) continue;
    if (isWorkspaceId(w.workspaceId)) return w.workspaceId;
  }
  return null;
}

/** The engine's `list_workspaces` payload, read defensively: anything else is "no list". */
function parseWorkspaceList(body: unknown): { workspaceId?: unknown; archived?: unknown }[] | null {
  if (body === null || typeof body !== 'object') return null;
  const list = (body as { workspaces?: unknown }).workspaces;
  return Array.isArray(list) ? (list as { workspaceId?: unknown; archived?: unknown }[]) : null;
}

/**
 * Mounted once in the shell around the routed surface. With no selected workspace it reads
 * `list_workspaces` ONCE, adopts the landing workspace (and remembers it), or, when the ledger holds
 * none and the person is on the landing route, sends them to the `/first-run` door. While that one
 * read is in flight it renders the loading skeleton instead of the surface, so the no-workspace state
 * never flashes. A failed read (a served stranger, an engine down) falls through to the surface,
 * which renders its own honest state. With a selected workspace it renders the surface at once and
 * only checks in the background that the selection still exists.
 */
export function WorkspaceResolver({ children }: { children: ReactNode }) {
  const client = useClient();
  const { workspaceId, setWorkspaceId } = useWorkspace();
  const location = useLocation();
  // 'pending' only while a cold load with no selection waits for the list; 'empty' means the ledger
  // holds no usable workspace; 'failed' means the read was refused or broke, so the surface renders
  // its own honest state and nothing is redirected on a guess.
  const [resolution, setResolution] = useState<'pending' | 'empty' | 'failed' | 'picked'>(() =>
    workspaceId === null ? 'pending' : 'picked',
  );

  useEffect(() => {
    let cancelled = false;
    void client.call('list_workspaces', {}).then((response) => {
      if (cancelled) return;
      const list = isErr(response.body) ? null : parseWorkspaceList(response.body);
      if (list === null) {
        setResolution((r) => (r === 'pending' ? 'failed' : r));
        return;
      }
      const present = workspaceId !== null && list.some((w) => w.workspaceId === workspaceId);
      if (present) {
        setResolution('picked');
        return;
      }
      const landing = pickLandingWorkspace(list);
      if (landing !== null) {
        setWorkspaceId(landing);
        setResolution('picked');
      } else {
        if (workspaceId !== null) setWorkspaceId(null); // the stored tenant is gone: forget it
        setResolution('empty');
      }
    });
    return () => {
      cancelled = true;
    };
    // One read per selection: a switch re-validates, a same-id re-render does not re-read.
  }, [client, workspaceId, setWorkspaceId]);

  if (workspaceId !== null) return <>{children}</>;
  if (resolution === 'pending') return <Skeleton rows={4} height={96} />;
  // No workspace at all: the landing IS the first-run door. Every other route keeps its own state.
  if (resolution === 'empty' && location.pathname === NAV_ITEMS[0].path) {
    return <Navigate to="/first-run" replace />;
  }
  return <>{children}</>;
}
