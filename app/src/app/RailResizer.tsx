/**
 * The hand-rolled splitter between the navigation rail and the main content (D118, modernisation
 * phase 1, A4). D2 is binding: this stays hand-rolled, ZERO new dependencies, no resize library.
 *
 * It is the WAI-ARIA WINDOW SPLITTER (https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/):
 * a focusable `role="separator"` that reports the rail's current width as its value and drives it by
 * pointer AND by keyboard, so the rail is resizable without a mouse.
 *
 *   - POINTER: dragging left/right resizes freely. The consumer clamps the width into [MIN, MAX], so
 *     a drag can never make the rail smaller than MIN or larger than MAX. Dragging PAST the minimum
 *     (below a snap threshold well under MIN) collapses the rail to the 56px icon strip. Dragging back
 *     out from the icon strip restores an expanded rail. A double-click resets to the default width.
 *   - KEYBOARD: Left/Right resize by a 16px step (clamped at the bounds, never silently collapsing);
 *     Home/End jump to MIN/MAX; Enter toggles the icon strip (the APG collapse/restore action, and the
 *     keyboard path to the collapsed mode). All within the [MIN, MAX] contract the aria-value* report.
 *
 * The component is CONTROLLED: it owns no width state, it renders the width it is handed and calls
 * back on every change. The Shell owns the persisted geometry (`useRailPrefs`) and the layout, so the
 * one source of truth for the width is the store, not this widget. `aria-controls` points at the rail
 * it sizes. Motion is the Shell's CSS transition on the rail; this widget only reports and requests.
 */
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

import { useT } from '../i18n';
import { RAIL_ICON_WIDTH, RAIL_MAX_WIDTH, RAIL_MIN_WIDTH } from './nav-prefs';

/** The keyboard resize step. One arrow press nudges the rail by this many pixels. */
const STEP = 16;

/** Dragging below this width (well under the minimum) snaps to the icon strip. The gap between it and
 *  the minimum stops a small overshoot near the minimum from collapsing the rail by accident. */
const SNAP_THRESHOLD = RAIL_MIN_WIDTH - 40;

export interface RailResizerProps {
  /** The current EXPANDED width in px (the stored width, even while collapsed). */
  width: number;
  /** Whether the rail is currently collapsed to the icon strip. */
  collapsed: boolean;
  /** The id of the rail element this separator sizes (its `aria-controls` target). */
  controlsId: string;
  /** Request a new width. The consumer clamps to [MIN, MAX] and expands the rail. */
  onWidthChange: (width: number) => void;
  /** Request the collapsed icon strip. */
  onCollapse: () => void;
  /** Reset to the default width (the double-click). */
  onReset: () => void;
  /** Notify the Shell that a pointer drag started or ended, so it can suppress the width transition
   *  DURING the drag (a transition would make the rail lag the pointer). */
  onDraggingChange?: (dragging: boolean) => void;
}

export function RailResizer({
  width,
  collapsed,
  controlsId,
  onWidthChange,
  onCollapse,
  onReset,
  onDraggingChange,
}: RailResizerProps) {
  const t = useT();
  // The drag anchor: the pointer x and the rendered rail width at pointer-down. Null when not dragging.
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  // The width the rail is actually rendering right now: the icon strip when collapsed, else the value.
  const renderedWidth = collapsed ? RAIL_ICON_WIDTH : width;

  const applyProposed = (proposed: number): void => {
    if (proposed < SNAP_THRESHOLD) {
      if (!collapsed) onCollapse();
    } else {
      // onWidthChange clamps into [MIN, MAX] and expands, so a proposal above MAX or a proposal that
      // re-expands from the icon strip both resolve correctly here.
      onWidthChange(proposed);
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    // Only the primary button drives a resize; ignore the secondary/middle buttons (a positive
    // button index). A missing index (0 or undefined) is the primary button.
    if (event.button > 0) return;
    event.preventDefault();
    drag.current = { startX: event.clientX, startWidth: renderedWidth };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    onDraggingChange?.(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current === null) return;
    const dx = event.clientX - drag.current.startX;
    applyProposed(drag.current.startWidth + dx);
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current === null) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onDraggingChange?.(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'ArrowLeft': {
        event.preventDefault();
        // Shrink, clamped at the minimum. Collapsing is the deliberate Enter action, never a stray
        // arrow, so a keyboard user cannot lose the rail by holding Left.
        if (!collapsed) onWidthChange(Math.max(RAIL_MIN_WIDTH, width - STEP));
        break;
      }
      case 'ArrowRight': {
        event.preventDefault();
        // Grow, clamped at the maximum. From the icon strip, the first Right re-expands to the last
        // stored width.
        onWidthChange(collapsed ? width : Math.min(RAIL_MAX_WIDTH, width + STEP));
        break;
      }
      case 'Home': {
        event.preventDefault();
        onWidthChange(RAIL_MIN_WIDTH);
        break;
      }
      case 'End': {
        event.preventDefault();
        onWidthChange(RAIL_MAX_WIDTH);
        break;
      }
      case 'Enter': {
        // The APG collapse/restore action: collapse an expanded rail, restore a collapsed one.
        event.preventDefault();
        if (collapsed) onWidthChange(width);
        else onCollapse();
        break;
      }
      default:
        break;
    }
  };

  return (
    <div
      className="rail-resizer"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t('nav.resize.label')}
      aria-controls={controlsId}
      aria-valuemin={RAIL_MIN_WIDTH}
      aria-valuemax={RAIL_MAX_WIDTH}
      // When collapsed the rendered width (56px) sits below the reported minimum, so the value clamps
      // to the minimum: the value range describes the EXPANDED rail, and the icon strip is the state
      // below it. The collapsed mode is conveyed by the icon rail itself, not by an out-of-range value.
      aria-valuenow={collapsed ? RAIL_MIN_WIDTH : width}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    >
      <span className="rail-resizer-grip" aria-hidden="true" />
    </div>
  );
}
