/**
 * The app shell: one fixed navigation rail plus one scrolling main (G16).
 *
 * The rail is a raised panel that never scrolls (design law: a single fixed rail, only <main>
 * scrolls). Its HEAD and FOOTER stay pinned and only the middle nav region scrolls when the
 * destination list outgrows the viewport (the VS Code / Linear pattern), so the never-scrolls law
 * holds without a scrolling rail. Items are grouped into short, headed clusters. Each item is an
 * icon plus a label; the active item is a soft accent-tinted pill (tint fill + accent text/icon) AND
 * carries `aria-current="page"`, so the active state is never signalled by colour alone and never by
 * a left accent bar. Every link is keyboard-reachable and shows the token focus ring. Labels come
 * from i18n, so there is no hardcoded user-facing copy.
 *
 * THE RAIL IS A COLLAPSIBLE TREE SINCE D118 (modernisation phase 1, A1). The three levels (group
 * heading, item, nested parent children) are unchanged, but groups and parents now COLLAPSE and
 * default to collapsed, and the whole thing is a WAI-ARIA treeview. That rendering, its keyboard
 * model and its per-user expand state live in `NavTree`; the Shell only gives it a home in the rail
 * and a callback to dismiss the mobile drawer. A parent is still a LABEL, never a link, so the number
 * of links stays equal to the number of destinations.
 *
 * G16 adds around the existing frame: one keyboard dispatcher (KeyboardProvider), a first-Tab skip
 * link to <main>, the command-palette trigger in the rail head, the shortcut sheet, and the chrome
 * SLOTS (trust indicator, feedback, theme, reserved bell in the footer; the /agent entry's count
 * badge). Each slot renders `null` when it has no occupant and degrades inside its own boundary.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';

import { useT } from '../i18n';
import { ThemeToggle } from '../components/ThemeToggle';
import { DensityToggle } from '../components/DensityToggle';
import { WorkspaceSwitcher } from '../components/WorkspaceSwitcher';
import { useFeedback } from '../components/FeedbackProvider';
import { CapabilitiesProvider } from '../lib/CapabilitiesProvider';
import { DemoBanner } from '../surfaces/Onboarding';
import { EnvironmentIndicator, EnvironmentLiveBanner } from '../surfaces/Environments/EnvironmentIndicator';
import { SearchPalette } from '../surfaces/Search';
import { AgentDock } from '../surfaces/Agent';
import { NavIcon } from './nav-icons';
import { NavTree } from './NavTree';
import { FavouritesRail } from './FavouritesRail';
import { IconRail } from './IconRail';
import { RailResizer } from './RailResizer';
import { RAIL_ICON_WIDTH, useRailPrefs } from './nav-prefs';
import { KeyboardProvider, useFocusTrap, useKeyboard } from './keyboard';
import { ShortcutSheet } from './ShortcutSheet';
import { NotificationBell, SlotBoundary, TrustSlot } from './chrome';
import { IdentityChip, IdentityGate, ServedShellGate } from './identity';
import { TenantRouteReset, WorkspaceResolver } from './workspace';

/** The rail-head trigger that opens the command palette. Shows the platform's own modifier hint. */
function PaletteTrigger() {
  const t = useT();
  const { openPalette } = useKeyboard();
  const modifier = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd K' : 'Ctrl K';
  return (
    <button type="button" className="rail-search" onClick={openPalette} aria-keyshortcuts="Meta+K Control+K">
      <NavIcon name="search" className="rail-icon" />
      <span className="rail-search-label">{t('palette.trigger')}</span>
      <kbd className="rail-search-kbd">{modifier}</kbd>
    </button>
  );
}

/** A double-chevron for the collapse and expand affordances. Points the way the rail will move: left
 *  to collapse it, right to expand it. Inline SVG in currentColor, so it inherits the button's ink. */
function RailToggleIcon({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg
      className="rail-icon"
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={direction === 'left' ? undefined : { transform: 'rotate(180deg)' }}
    >
      <path d="M11 6l-6 6 6 6" />
      <path d="M18 6l-6 6 6 6" />
    </svg>
  );
}

/** True below the responsive collapse width (the point where the rail becomes the hamburger drawer).
 *  The resizer and the icon mode are a DESKTOP affordance: below this width the rail is the overlay
 *  drawer instead, so a persisted collapsed state is ignored and the separator is not rendered.
 *  Guarded for environments without `matchMedia` (jsdom), where it stays false (the desktop layout). */
function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-width: 767px)');
    const update = (): void => setNarrow(mq.matches);
    update();
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  }, []);
  return narrow;
}

/**
 * F-05: a hash on a client-side navigation scrolls its target into view. A browser only honours
 * `#id` on a full document load; after `pushState` nothing moves, so a door like
 * `/operations#data-title` would land at the top of Betrieb with the panel out of sight. The target
 * usually mounts a beat after the route (the surface reads before it renders), so this polls a few
 * frames for it, then scrolls <main> so the target sits just below the sticky surface header. Renders
 * nothing; inert without a hash.
 */
function HashAnchor() {
  const { pathname, hash, key } = useLocation();
  useEffect(() => {
    if (hash === '' || typeof document === 'undefined') return;
    const id = decodeURIComponent(hash.slice(1));
    let frame = 0;
    let handle = 0;
    const tryScroll = (): void => {
      const target = document.getElementById(id);
      const main = document.getElementById('main-content');
      if (target !== null && main !== null) {
        const header = parseFloat(main.style.getPropertyValue('--surface-header-height')) || 0;
        const offset = target.getBoundingClientRect().top - main.getBoundingClientRect().top;
        main.scrollTop += offset - header - 8;
        return;
      }
      frame += 1;
      if (frame < 60) handle = window.requestAnimationFrame(tryScroll);
    };
    handle = window.requestAnimationFrame(tryScroll);
    return () => window.cancelAnimationFrame(handle);
  }, [pathname, hash, key]);
  return null;
}

function Frame() {
  const t = useT();

  // Responsive collapse (D89 #1): below a comfortable rail width the rail is a hamburger-triggered
  // overlay drawer that traps focus, closes on Esc or a backdrop click, restores focus to the
  // hamburger, and dismisses when a destination is chosen. Above that width CSS keeps the rail fixed
  // and the hamburger hidden, so `drawerOpen` is inert. `prefers-reduced-motion` is honoured in CSS.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const hamburgerRef = useRef<HTMLButtonElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    hamburgerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (drawerOpen) railRef.current?.querySelector<HTMLElement>('a, button')?.focus();
  }, [drawerOpen]);

  // The collapse drawer is a modal overlay over a scrim, so Tab must not walk out onto the surface
  // behind it (spec US-G16.1 boundary / §6: "a focus-trapped overlay drawer"). Inert above the
  // collapse width, where `drawerOpen` never becomes true because the hamburger is hidden.
  useFocusTrap(railRef, drawerOpen);

  // G08 §2 US-G08.2: feedback belongs in the shell, not on a route. Renders nothing without a provider.
  const feedback = useFeedback();

  // A4 (D118): the resizable rail. Its width and collapsed flag are persisted per workspace; the
  // separator (RailResizer) drives them. Icon mode is a desktop affordance, so it is suppressed on a
  // narrow viewport (where the rail is the hamburger drawer instead). `resizing` suppresses the width
  // transition during a pointer drag, so the rail tracks the pointer instead of lagging behind it.
  const isNarrow = useIsNarrow();
  const { width, collapsed, setWidth, setCollapsed, reset } = useRailPrefs();
  const [resizing, setResizing] = useState(false);
  const iconMode = collapsed && !isNarrow;
  const railWidthPx = iconMode ? RAIL_ICON_WIDTH : width;
  // Inline width drives BOTH modes on desktop; on a narrow viewport the drawer's CSS width wins, so
  // no inline width is set there.
  const railStyle = isNarrow ? undefined : { width: `${railWidthPx}px`, flexBasis: `${railWidthPx}px` };
  const railClassName = [
    'rail',
    drawerOpen ? 'rail--open' : '',
    iconMode ? 'rail--icon' : '',
    resizing ? 'rail--resizing' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={drawerOpen ? 'frame frame--drawer-open' : 'frame'}>
      {/* US-G16.10: reset a record-scoped route to its list root on a workspace switch. Renders nothing. */}
      <TenantRouteReset />
      {/* F-05: a `#id` on a client-side navigation scrolls its target into view. Renders nothing. */}
      <HashAnchor />
      {/* WCAG 2.2 bypass-blocks: the first focusable element jumps past the rail to the content. */}
      <a className="skip-link" href="#main-content">
        {t('shell.skipToContent')}
      </a>
      {/* The hamburger (CSS shows it only below the collapse width). */}
      <button
        ref={hamburgerRef}
        type="button"
        className="rail-hamburger"
        aria-expanded={drawerOpen}
        aria-controls="studio-rail"
        aria-label={t('shell.nav.more')}
        onClick={() => setDrawerOpen((v) => !v)}
      >
        <span aria-hidden="true">☰</span>
      </button>
      {drawerOpen && <div className="rail-scrim" role="presentation" onClick={closeDrawer} />}
      <nav
        id="studio-rail"
        ref={railRef}
        className={railClassName}
        style={railStyle}
        aria-label={t('nav.label')}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && drawerOpen) {
            event.preventDefault();
            closeDrawer();
          }
        }}
      >
        {iconMode ? (
          <>
            {/* A4 icon mode: an expand affordance, then the icon strip, then the theme toggle. The
                head text, switcher and palette label do not fit 56px, so they yield to Cmd/Ctrl+K and
                the expanded rail. */}
            <div className="rail-head rail-head--icon">
              <button
                type="button"
                className="rail-icon-btn"
                aria-label={t('nav.expand')}
                onClick={() => setCollapsed(false)}
              >
                <RailToggleIcon direction="right" />
              </button>
            </div>
            <div className="rail-nav">
              <IconRail onNavigate={() => setDrawerOpen(false)} />
            </div>
            <div className="rail-footer rail-footer--icon">
              {/* M01: the signed-in-identity chip, its own CapabilitiesProvider because it renders
                  outside <main>'s provider (the AgentDock pattern). Icon-only here; silent in local mode. */}
              <SlotBoundary slot="identity">
                <CapabilitiesProvider>
                  <IdentityChip iconOnly />
                </CapabilitiesProvider>
              </SlotBoundary>
              <DensityToggle />
              <ThemeToggle />
            </div>
          </>
        ) : (
          <>
            <div className="rail-head">
              <p className="rail-title">{t('app.title')}</p>
              <p className="rail-tagline">{t('app.tagline')}</p>
              {/* D24 variant A: the workspace switcher. Renders nothing while no workspace is selected. */}
              <WorkspaceSwitcher />
              {/* G16: the palette trigger sits above the nav, the widest door into the product. */}
              <PaletteTrigger />
            </div>
            {/* A3: the Favoriten lane, ABOVE the canonical tree. A per-user personal shortcut list that
                renders nothing until the first pin, so the tree sits at the top on a fresh workspace. It
                is additive: the canonical tree below is never reordered by it (one shared vocabulary). */}
            {/* A1: the collapsible tree rail. A WAI-ARIA treeview owns its own keyboard model and its own
                per-user expand state; choosing a destination dismisses the drawer on a narrow viewport. */}
            <div className="rail-nav">
              <FavouritesRail onNavigate={() => setDrawerOpen(false)} />
              <NavTree onNavigate={() => setDrawerOpen(false)} />
            </div>
            <div className="rail-footer">
              {/* M01: the signed-in-identity chip (spec §6, the G15 slot). Its own CapabilitiesProvider,
                  because it renders OUTSIDE <main>'s provider (the AgentDock pattern), and it reads the
                  same `whoami` through the sanctioned single source rather than calling the verb itself.
                  Silent in local mode: a laptop user has no login and must not be shown a fake one. */}
              <SlotBoundary slot="identity">
                <CapabilitiesProvider>
                  <IdentityChip />
                </CapabilitiesProvider>
              </SlotBoundary>
              {/* E07 trust indicator: glyph + text, resting `local`, zero accent. Degrades in its own slot. */}
              <SlotBoundary slot="trust">
                <TrustSlot />
              </SlotBoundary>
              {/* D126: the environment indicator (7.4). Its own CapabilitiesProvider (it renders outside
                  <main>'s provider, the AgentDock pattern) and its own slot boundary; renders nothing
                  when the landscape is unavailable. `main` shows the one warning accent. */}
              <SlotBoundary slot="environment">
                <CapabilitiesProvider>
                  <EnvironmentIndicator />
                </CapabilitiesProvider>
              </SlotBoundary>
              {/* G06 bell: a reserved slot, silent until G06 wires a reader. */}
              <SlotBoundary slot="bell">
                <NotificationBell />
              </SlotBoundary>
              {feedback !== null && (
                /* A quiet ghost control. It NEVER spends the accent (an accent down here would spend it
                   on every screen at once). */
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => feedback.open({ kind: 'idea' })}
                >
                  {t('feedback.open')}
                </button>
              )}
              {/* A4: the pointer collapse affordance, the non-dragging alternative to snapping the
                  separator past the minimum. */}
              {!isNarrow && (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm rail-collapse"
                  aria-label={t('nav.collapse')}
                  onClick={() => setCollapsed(true)}
                >
                  <RailToggleIcon direction="left" />
                </button>
              )}
              {/* B3: the density toggle, the theme toggle's twin. Both quiet ghost icon controls,
                  side by side at the foot of the rail. Neither spends the accent. */}
              <DensityToggle />
              <ThemeToggle />
            </div>
          </>
        )}
      </nav>
      {/* A4: the hand-rolled window splitter (D2: no resize library). A desktop affordance, so it is
          not rendered while the rail is the hamburger drawer. */}
      {!isNarrow && (
        <RailResizer
          width={width}
          collapsed={collapsed}
          controlsId="studio-rail"
          onWidthChange={setWidth}
          onCollapse={() => setCollapsed(true)}
          onReset={reset}
          onDraggingChange={setResizing}
        />
      )}
      {/*
        A24: `whoami` is read once here and published to the tree, because a capability answer is a
        property of the session and the workspace rather than of any one screen. It wraps only the
        outlet: the rail and the chrome gate nothing, and a permission read must never delay them.
      */}
      <main id="main-content">
        <CapabilitiesProvider>
          {/* G12/G03: the one shared workspace-mode banner, above EVERY surface, rendered only while
              the workspace is not live and rendering nothing otherwise. */}
          <DemoBanner />
          {/* D126 E6a: the persistent LIVE banner across the top of the content while the active
              environment is `main`. Renders nothing on every other environment. */}
          <EnvironmentLiveBanner />
          {/* M01: the served-access resolver gate. In served mode it shows the "signed in, not a
              member here" page or the 401-shape "sign-in required" page in place of the surface, from
              the same `whoami` this provider read. In local mode and for a resolved member it renders
              the surface unchanged, so nothing changes on a laptop or for an invited user. */}
          <IdentityGate>
            {/* F-02: a cold load with no remembered selection opens the newest existing books, and a
                ledger with none opens on the /first-run door; the surface renders once that is known. */}
            <WorkspaceResolver>
              <Outlet />
            </WorkspaceResolver>
          </IdentityGate>
          {/* G16: the command palette, one mount for the whole app, opened from the trigger or Cmd/Ctrl+K.
              Inside CapabilitiesProvider (it disables denied verb rows) and KeyboardProvider. */}
          <SearchPalette />
        </CapabilitiesProvider>
      </main>
      {/*
        A35: G16's dock slot (assistDock), filled. A flex SIBLING of <main>, so an open dock PUSHES
        the content and never overlays it (D90 D-2; the D102 layout-law exception in brand/DESIGN.md
        is its written licence). With zero agent sessions, no read right or no workspace it emits NO
        DOM at all (guarantee 2), and it degrades inside its own slot boundary like every other slot.
        Its own CapabilitiesProvider, because it renders beside <main>'s provider, not inside it.
      */}
      <SlotBoundary slot="agent-dock">
        <CapabilitiesProvider>
          <AgentDock />
        </CapabilitiesProvider>
      </SlotBoundary>
      {/* The shortcut sheet, opened on `?`. Read surface, Esc closes and returns focus to the trigger. */}
      <ShortcutSheet />
    </div>
  );
}

export function Shell() {
  // One keyboard dispatcher owns the global keydown, the palette/help open state and the nav chords.
  // It renders inside the router (Shell is the layout route element), so `useNavigate` is in context.
  // M01 / F-11: a served stranger or a subject-less served request meets its FULL page here, before
  // any rail, switcher or palette trigger exists to refuse it; everyone else gets the frame.
  return (
    <KeyboardProvider>
      <ServedShellGate>
        <Frame />
      </ServedShellGate>
    </KeyboardProvider>
  );
}
