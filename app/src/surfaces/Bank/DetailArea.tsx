/**
 * D178 N2 (A39 §18.1, §18.2, §18.6): the /bank DETAIL AREA, the shell the selected line's details live in.
 *
 * The owner's review (21.10.2026): the D177 side panel could not be closed, could not dock to the bottom,
 * and fought the page scroll. The area is a split INSIDE the /bank route (D167 holds: no dock beside every
 * page), docked right or at the bottom by the person's preference (`useDetailLayout`), and below 1180 px the
 * shared `DetailDrawer`.
 *
 *  - The HEADER is chrome only: a pointer-only grip (drag the header to the other edge to dock it there),
 *    the dock control (a two-value `Segmented`, "Rechts" and "Unten": the keyboard path, WCAG 2.5.7; no dock
 *    glyph exists in the D154 vocabulary, so the words stay) and the vocabulary's Schliessen.
 *  - ESCAPE inside the area closes it unless a child control used the key first (an open menu, a listbox,
 *    a popover call `preventDefault`). The host returns focus to the line's row.
 *  - The DIVIDER (`DetailDivider`) resizes: a pointer drag, and the WAI-ARIA window splitter's keys on the
 *    focused separator (arrows by 16 px, 64 px with Shift, Home and End), written once they rest; a
 *    double-click returns the default.
 *
 * THE SEAM (A39 §18.6). The shell owns the header, ONE scroll container with the facts card on top, and a
 * pinned footer. A booking view renders exactly one `<DetailSlots footer={...}>{booking}</DetailSlots>`; it
 * reads where it renders and how big it is with `useDetailArea()`. In the drawer the drawer's body is the one
 * scroll owner and the footer sticks to its end.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import { useT } from '../../i18n';
import { IconButton } from '../../components/IconButton';
import { Segmented } from '../../components/Segmented';
import { GripGlyph } from '../../components/icons';
import {
  DIVIDER_PX,
  SIZE_WRITE_DELAY_MS,
  dropEdgeAt,
  sizeForKey,
  type AreaPlacement,
  type DockEdge,
} from './useDetailLayout';

/**
 * Whether a scroll area has content below its visible edge (the D177 fade under the scrolling middle):
 * measured after every render, on its own scroll, on a window resize, and when its content changes size.
 */
export function useMoreBelow(): { ref: (el: HTMLDivElement | null) => void; more: boolean } {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    if (el === null) return;
    setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 1);
  }, [el]);
  useLayoutEffect(measure);
  useEffect(() => {
    if (el === null) return undefined;
    el.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    for (const child of Array.from(el.children)) observer?.observe(child);
    return () => {
      el.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [el, measure]);
  return { ref: setEl, more };
}

// --- the seam ---------------------------------------------------------------------------------------

export interface DetailAreaValue {
  /** Where the area renders: docked right, docked at the bottom, or the drawer below 1180 px. */
  placement: AreaPlacement;
  /** The docked size in px (the width docked right, the height at the bottom); null in the drawer. */
  size: number | null;
  /** Close the area; the host returns focus to the line's row. */
  close: () => void;
  /** The facts card the shell shows at the top of the scrolling middle. */
  facts: ReactNode;
}

const DetailAreaContext = createContext<DetailAreaValue | null>(null);

/** Where the booking view renders and how big it is, or null outside the shell (a component test). */
export function useDetailArea(): DetailAreaValue | null {
  return useContext(DetailAreaContext);
}

export interface DetailSlotsProps {
  /** The booking: modes, fields, preview, case controls. Scrolls under the facts card. */
  children: ReactNode;
  /** Pinned under the scrolling middle: Betrag, verteilt, Abweichung and Buchen (today the D177 actions). */
  footer?: ReactNode;
  /**
   * `beside`: the facts card and the booking side by side (D178 point 9, focus view docked at the bottom,
   * bexio's layout); `stack` (default): the booking under the facts. `beside` stacks in the drawer and
   * docked right, where there is no width for two columns.
   */
  layout?: 'stack' | 'beside';
}

/**
 * The slots of the detail area: the facts card and the booking in ONE scroll container, the footer pinned.
 * Outside the shell (a component test that mounts a view alone) it renders the booking and the footer
 * in place, so a view never depends on the shell to be tested.
 */
export function DetailSlots({ children, footer, layout = 'stack' }: DetailSlotsProps) {
  const area = useDetailArea();
  const { ref, more } = useMoreBelow();
  const beside = layout === 'beside' && area?.placement === 'bottom';
  return (
    <>
      <div
        className="bank-panel__scroll bank-area__scroll"
        ref={ref}
        data-more={more ? 'true' : undefined}
        data-layout={beside ? 'beside' : 'stack'}
      >
        {area?.facts}
        <div className="bank-area__booking">{children}</div>
      </div>
      {footer !== undefined && footer !== null && <div className="bank-area__foot">{footer}</div>}
    </>
  );
}

// --- the docked area --------------------------------------------------------------------------------

export interface DetailAreaProps {
  id: string;
  /** The line the area shows (its row takes the focus back on close). */
  lineId: string;
  edge: DockEdge;
  size: number;
  /** The id of the facts card's title: the area is labelled by it. */
  titleId: string;
  facts: ReactNode;
  onDock: (edge: DockEdge) => void;
  onClose: () => void;
  /** A pointer pressed on the header (not on a control): the host starts the dock drag. */
  onHeaderPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  /** A header drag is under way (the area dims, no transition fights the pointer). */
  dragging: boolean;
  children: ReactNode;
}

export function DetailArea({ id, lineId, edge, size, titleId, facts, onDock, onClose, onHeaderPointerDown, dragging, children }: DetailAreaProps) {
  const t = useT();
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  };
  return (
    <section
      id={id}
      className="bank-panel bank-area"
      aria-labelledby={titleId}
      data-dock={edge}
      data-area-for={lineId}
      data-dragging={dragging ? 'true' : undefined}
      onKeyDown={onKeyDown}
    >
      <header
        className="bank-area__head"
        onPointerDown={(event) => {
          // Only the header's own surface starts a drag: never a control in it.
          if ((event.target as Element).closest('button, [role="radio"], [role="radiogroup"], a, input') !== null) return;
          onHeaderPointerDown(event);
        }}
      >
        <span className="bank-area__grip" aria-hidden="true">
          <GripGlyph size={16} />
        </span>
        <Segmented<DockEdge>
          className="bank-area__dock"
          label={t('bankInbox.area.dockLabel')}
          options={[
            { value: 'right', label: t('bankInbox.area.dockRight') },
            { value: 'bottom', label: t('bankInbox.area.dockBottom') },
          ]}
          value={edge}
          onChange={onDock}
        />
        <IconButton icon="close" small className="bank-area__close" context={t('bankInbox.area.closeContext')} onClick={onClose} placement="bottom" />
      </header>
      <div className="bank-area__body">
        <DetailAreaContext.Provider value={{ placement: edge, size, close: onClose, facts }}>{children}</DetailAreaContext.Provider>
      </div>
    </section>
  );
}

/** The drawer below 1180 px: the same seam, the drawer's body the one scroll owner. */
export function DrawerArea({ facts, close, children }: { facts: ReactNode; close: () => void; children: ReactNode }) {
  return (
    <div className="bank-area bank-area--drawer" data-dock="drawer">
      <DetailAreaContext.Provider value={{ placement: 'drawer', size: null, close, facts }}>{children}</DetailAreaContext.Provider>
    </div>
  );
}

// --- the divider ------------------------------------------------------------------------------------

export interface DetailDividerProps {
  edge: DockEdge;
  size: number;
  bounds: { min: number; max: number };
  /** The area's element id (`aria-controls`). */
  controls: string;
  /** A size the pointer or a key drives now. */
  onDrive: (size: number) => void;
  /** Write the driven size. */
  onCommit: () => void;
  /** Back to the default size (a double-click). */
  onReset: () => void;
}

export function DetailDivider({ edge, size, bounds, controls, onDrive, onCommit, onReset }: DetailDividerProps) {
  const t = useT();
  const drag = useRef<{ start: number; size: number; id: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const writeTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(writeTimer.current), []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = sizeForKey(edge, event.key, event.shiftKey, size, bounds);
    if (next === null) return;
    event.preventDefault();
    onDrive(next);
    window.clearTimeout(writeTimer.current);
    writeTimer.current = window.setTimeout(onCommit, SIZE_WRITE_DELAY_MS);
  };
  const point = (event: ReactPointerEvent) => (edge === 'right' ? event.clientX : event.clientY);
  return (
    <div
      className="bank-divider"
      role="separator"
      tabIndex={0}
      aria-orientation={edge === 'right' ? 'vertical' : 'horizontal'}
      aria-controls={controls}
      aria-label={t('bankInbox.area.resize')}
      aria-valuenow={size}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuetext={t('bankInbox.area.sizeText', { size })}
      data-edge={edge}
      data-dragging={dragging ? 'true' : undefined}
      style={{ [edge === 'right' ? 'width' : 'height']: DIVIDER_PX }}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        drag.current = { start: point(event), size, id: event.pointerId };
        setDragging(true);
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        const d = drag.current;
        if (d === null || d.id !== event.pointerId) return;
        // The divider sits before the area: moving it toward the list (left, up) grows the area.
        const delta = d.start - point(event);
        onDrive(Math.round(Math.min(bounds.max, Math.max(bounds.min, d.size + delta))));
      }}
      onPointerUp={(event) => {
        if (drag.current === null || drag.current.id !== event.pointerId) return;
        drag.current = null;
        setDragging(false);
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        onCommit();
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
        onCommit();
      }}
    />
  );
}

// --- the header drag --------------------------------------------------------------------------------

/**
 * The dock drag: a press on the area's header that moves past a few pixels starts it; while the pointer
 * is over the other edge's half of the workspace the drop preview shows there; letting go there docks the
 * area at that edge, anywhere else (or Escape) changes nothing. Pointer only: the dock control is the
 * keyboard's way (WCAG 2.5.7).
 */
export function useDockDrag(workspace: RefObject<HTMLElement | null>, edge: DockEdge, onDock: (edge: DockEdge) => void) {
  const [state, setState] = useState<{ dragging: boolean; target: DockEdge | null }>({ dragging: false, target: null });
  const live = useRef({ edge, onDock });
  live.current = { edge, onDock };
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const onHeaderPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || event.pointerType === 'touch') return;
    const startX = event.clientX;
    const startY = event.clientY;
    let started = false;
    let target: DockEdge | null = null;
    const move = (e: PointerEvent) => {
      if (!started) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 6) return;
        started = true;
      }
      const rect = workspace.current?.getBoundingClientRect();
      target = rect === undefined ? null : dropEdgeAt(live.current.edge, { x: e.clientX, y: e.clientY }, rect);
      setState({ dragging: true, target });
    };
    const end = (commit: boolean) => {
      cleanup.current?.();
      cleanup.current = null;
      setState({ dragging: false, target: null });
      if (commit && started && target !== null) live.current.onDock(target);
    };
    const up = () => end(true);
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        end(false);
      }
    };
    const cancel = () => end(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
    cleanup.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
    };
  };
  return { onHeaderPointerDown, dragging: state.dragging, target: state.target };
}
