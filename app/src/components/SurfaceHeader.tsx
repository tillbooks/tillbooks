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
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import './SurfaceHeader.css';

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
}

export function SurfaceHeader({ title, titleId, subtitle, help, actions }: SurfaceHeaderProps) {
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
    <header ref={headerRef} className="surface-header" data-stuck={stuck ? '' : undefined}>
      <div className="surface-header-titles">
        <h1 id={titleId} className="surface-header-title">
          {title}
          {help !== undefined && <span className="surface-header-help">{help}</span>}
        </h1>
        {subtitle !== undefined && <p className="surface-header-subtitle">{subtitle}</p>}
      </div>
      {actions !== undefined && <div className="surface-header-actions">{actions}</div>}
    </header>
  );
}
