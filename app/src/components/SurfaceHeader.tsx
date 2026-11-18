/**
 * SurfaceHeader: the one page header for a Studio surface (D118 B2).
 *
 * Every surface hand-rolled `<div className="<name>-head">` with an `<h1>`, an inline `SurfaceHelp`
 * and a right-aligned action slot, and several repeated that `<h1>` verbatim across their loading,
 * empty and error branches. This is that block once: a title (the surface's accessible name via an
 * optional id), an optional subtitle, an inline help slot, and an actions slot pinned right.
 *
 * It is sticky at the top of the scrolling main, so the title and the primary action stay in view as
 * a long surface scrolls, and it is density-aware through the shared tokens. It pins flush under
 * main's opaque top-padding mask (global.css), and shows a hairline only once content has scrolled
 * under it (`data-stuck`). It renders regardless of
 * the surface's state, so the title stops being copy-pasted into every early return.
 *
 * TWO SLOTS OF THE CALM STUDIO (D201 point 6, D204 "Find it, then act"):
 *   - `back`: a page reached by drilling down shows a back chevron with the origin's name
 *     ("‹ Übersicht"). By default it is fed by the navigation state: whoever navigates into a page
 *     passes `state: backState(path, label)` (a tile, a KPI, a row), and every SurfaceHeader below it
 *     shows the way back without the surface wiring anything. `back` overrides it with an explicit
 *     target, `back={false}` suppresses it.
 *   - `settingsHref`: one settings icon (the vocabulary's Einstellungen gear) in the header's action
 *     slot, opening the settings section that governs the page.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useInRouterContext, useLocation, useNavigate } from 'react-router-dom';

import { useT } from '../i18n';
import { HintsChip, type Hint } from './HintsChip';
import { IconButton } from './IconButton';
import { ChevronRightGlyph } from './icons';
import './SurfaceHeader.css';

/** Where a drilled page came from: the path to go back to and the name of that page. */
export interface BackFrom {
  path: string;
  label: string;
}

/** The navigation state that gives the next page its back chevron: `navigate(to, { state: backState(...) })`. */
export function backState(path: string, label: string): { from: BackFrom } {
  return { from: { path, label } };
}

/** Read a `BackFrom` out of a router location state, defensively: anything else reads as none. */
export function backFromState(state: unknown): BackFrom | null {
  if (state === null || typeof state !== 'object') return null;
  const from = (state as { from?: unknown }).from;
  if (from === null || typeof from !== 'object') return null;
  const { path, label } = from as { path?: unknown; label?: unknown };
  if (typeof path !== 'string' || !path.startsWith('/') || typeof label !== 'string' || label === '') return null;
  return { path, label };
}

export interface SurfaceHeaderProps {
  /** The surface title. Sentence case, one ink (design law). */
  title: string;
  /** An id for the `<h1>`, so the surface `<section>` can point `aria-labelledby` at it. */
  titleId?: string;
  /** An optional one-line subtitle under the title. */
  subtitle?: string;
  /** An inline help affordance beside the title, e.g. the shared `<SurfaceHelp surface=... />`. */
  help?: ReactNode;
  /**
   * The action slot, pinned to the right. One primary action at most, secondary and overflow to its
   * left, per the design law. Capability-gated by the caller (hide, never show-then-reject).
   */
  actions?: ReactNode;
  /** D187: how many rows a list holds, quiet beside the title ("Belege 128"). */
  count?: number;
  /** D187 (the owner's pick "Hinweise A"): the page's notices, folded into one "N Hinweise" chip. */
  hints?: readonly Hint[];
  /**
   * D187 (the owner's pick "Berichte A"): a second row inside the sticky header, for a report's period,
   * its filters, or a list's search and filter chips, so they stay in view while the result scrolls.
   */
  toolbar?: ReactNode;
  /**
   * D201: the back chevron. Omitted, it follows the navigation state (`backState`); an explicit
   * `{ path, label }` overrides it; `false` shows none.
   */
  back?: BackFrom | false;
  /** D204: the page's settings section; renders one settings icon button at the end of the actions. */
  settingsHref?: string;
  /** What the settings icon opens, its tooltip's second line. Defaults to "Für diese Seite". */
  settingsContext?: string;
}

/** The back chevron: a real link with the origin's name beside the glyph, never a glyph alone. */
function BackLink({ from }: { from: BackFrom }) {
  const t = useT();
  return (
    <Link className="surface-header-back" to={from.path} aria-label={t('surfaceHeader.back', { label: from.label })}>
      <ChevronRightGlyph size={16} className="surface-header-back-glyph" />
      <span>{from.label}</span>
    </Link>
  );
}

/** The back chevron fed by the navigation state, only inside a router. */
function StateBackLink() {
  const location = useLocation();
  const from = backFromState(location.state);
  return from === null ? null : <BackLink from={from} />;
}

/** The settings icon: the vocabulary's gear, navigating to the page's settings section. */
function SettingsButton({ href, context }: { href: string; context?: string }) {
  const t = useT();
  const navigate = useNavigate();
  return <IconButton icon="settings" context={context ?? t('surfaceHeader.settingsContext')} onClick={() => navigate(href)} />;
}

export function SurfaceHeader({
  title,
  titleId,
  subtitle,
  help,
  actions,
  count,
  hints,
  toolbar,
  back,
  settingsHref,
  settingsContext,
}: SurfaceHeaderProps) {
  const inRouter = useInRouterContext();
  const headerRef = useRef<HTMLElement>(null);

  // S1 (N5 sweep): the sticky DataTable thead and this sticky header live in the ONE .frame>main
  // scroll region, so the thead must stick just BELOW the header or the opaque header hides the
  // column labels on every list surface. Publish the header's ACTUAL rendered height as
  // --surface-header-height on the scroll region, so the thead offset (DataTable.css:
  // `top: var(--surface-header-height, 0px)`) is always exact: it tracks a subtitle, the density
  // toggle and a wrapped title with no per-surface tuning and no magic number. A layout effect sets
  // it BEFORE the first paint, so there is no collision flash; a ResizeObserver keeps it current
  // across density and viewport changes. Guarded for jsdom (no layout, no ResizeObserver).
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (header === null) return;
    // The header always renders inside <main> (the Shell scroll region); documentElement is a
    // defensive fallback so a header mounted elsewhere still publishes somewhere its thead inherits.
    const scope: HTMLElement = header.closest('main') ?? document.documentElement;
    const publish = (): void => {
      const measured = header.offsetHeight;
      if (measured > 0) scope.style.setProperty('--surface-header-height', `${measured}px`);
    };
    publish();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish);
    observer?.observe(header);
    return () => {
      observer?.disconnect();
      scope.style.removeProperty('--surface-header-height');
    };
  }, []);

  // The scrolled-state hairline (P6). At rest the header carries no border; once it is PINNED and
  // content has scrolled under it, `data-stuck` turns on one --t-border hairline (SurfaceHeader.css).
  // Pinned means the header's top sits at the scroll region's padding edge, where `top: 0` holds it,
  // and the region has scrolled. A banner above the header delays that until the banner has gone, so
  // the line never appears over content that is still above the header. A passive scroll listener,
  // coalesced to one read per frame, and nothing for jsdom to trip over: without layout every rect
  // is zero, so there the attribute follows scrollTop alone.
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const header = headerRef.current;
    const scroller = header?.closest('main') ?? null;
    if (header === null || scroller === null) return;
    const raf = typeof window.requestAnimationFrame === 'function';
    let frame = 0;
    const measure = (): void => {
      frame = 0;
      const paddingTop = parseFloat(window.getComputedStyle(scroller).paddingTop) || 0;
      const edge = scroller.getBoundingClientRect().top + scroller.clientTop + paddingTop;
      setStuck(scroller.scrollTop > 0 && header.getBoundingClientRect().top <= edge + 0.5);
    };
    const onScroll = (): void => {
      if (!raf) measure();
      else if (frame === 0) frame = window.requestAnimationFrame(measure);
    };
    measure();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <header
      ref={headerRef}
      className={toolbar === undefined ? 'surface-header' : 'surface-header surface-header--toolbar'}
      data-stuck={stuck ? '' : undefined}
    >
      <div className="surface-header-titles">
        {back === undefined ? inRouter && <StateBackLink /> : back !== false && <BackLink from={back} />}
        {/* D187: the help trigger sits BESIDE the h1, not inside it. Inside, its hover name became part
            of the heading's accessible name ("Kontakte Hilfe zu Kontakte"). */}
        <div className="surface-header-titleline">
          <h1 id={titleId} className="surface-header-title">
            {title}
          </h1>
          {count !== undefined && <span className="surface-header-count t-num">{count}</span>}
          {help !== undefined && <span className="surface-header-help">{help}</span>}
          {hints !== undefined && hints.length > 0 && <HintsChip hints={hints} />}
        </div>
        {subtitle !== undefined && <p className="surface-header-subtitle">{subtitle}</p>}
      </div>
      {(actions !== undefined || settingsHref !== undefined) && (
        <div className="surface-header-actions">
          {actions}
          {settingsHref !== undefined && <SettingsButton href={settingsHref} context={settingsContext} />}
        </div>
      )}
      {toolbar !== undefined && <div className="surface-header-toolbar">{toolbar}</div>}
    </header>
  );
}
