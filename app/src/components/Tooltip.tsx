/**
 * A real tooltip: a supplemental description tied to its trigger via `aria-describedby`, never the
 * native `title` attribute (which is invisible to keyboard users and inconsistent across browsers).
 *
 * The description element is always in the DOM carrying its id, so assistive tech can reach it and
 * `aria-describedby` always resolves; visibility is a purely visual layer toggled on hover AND
 * keyboard focus, and dismissed on Escape or blur. Hover covers the open bubble as well as the
 * trigger, so the pointer can move onto it to read it (WCAG 2.2 SC 1.4.13). Tooltips hold plain text only (no interactive
 * content): for a titled help panel with a link, reach for HelpHint instead.
 *
 * On touch there is no hover, so a long press (450ms without moving more than 8px) opens it too, as
 * D154 asks of every icon-only control. The click that ends a long press is swallowed, because the
 * person asked what the control is, not to use it, and the tooltip closes a moment after the finger
 * lifts so it can be read. Only a pointer click inside a short window after the lift is swallowed:
 * a keyboard or assistive-technology click (detail 0) always acts.
 *
 * The trigger is any single element passed as the child. An icon-only trigger must carry its own
 * `aria-label` so it has an accessible name independent of the tooltip (`IconButton` does).
 */
import {
  cloneElement,
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

import { createPortal } from 'react-dom';

/**
 * Whether focus arrived the keyboard way (`:focus-visible`). Where the engine cannot say (no
 * `CSS.supports` for the selector, as in a test DOM), every focus counts, the behaviour before the
 * check existed.
 */
function isKeyboardFocus(el: Element): boolean {
  const css = (globalThis as { CSS?: { supports?: (q: string) => boolean } }).CSS;
  if (typeof css?.supports !== 'function' || !css.supports('selector(:focus-visible)')) return true;
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

/** The native Escape events that closed an open bubble (D180): read only by an opt-in handler. */
const CONSUMED_ESCAPES = new WeakSet<Event>();

/**
 * Whether this Escape closed a tooltip bubble. Nothing is prevented, so every Escape handler behaves
 * as before; a mode that wants the first Escape spent on the bubble alone (the Übersicht's edit mode)
 * asks here and ignores that one.
 */
export function tooltipConsumedEscape(event: Event | { nativeEvent: Event }): boolean {
  return CONSUMED_ESCAPES.has('nativeEvent' in event ? event.nativeEvent : event);
}

/**
 * D177: a surface whose tooltips sit inside a clipping container (a scrolling side panel, a table's panel)
 * provides `true`, and every Tooltip under it renders its OPEN bubble in the overlay layer (a portal on
 * `document.body`), fixed to its trigger and flipped to the side that has room. Off by default, so every
 * other surface keeps the bubble beside its trigger.
 */
export const TooltipPortalContext = createContext(false);

/** The gap between a portalled bubble and the viewport's edge, in px. */
const EDGE = 8;

/** How long a finger must rest on the trigger before the tooltip opens (D154). */
export const LONG_PRESS_MS = 450;
/** How far a finger may drift during a long press before it counts as a scroll instead. */
const LONG_PRESS_SLOP_PX = 8;
/** How long the tooltip stays after the finger lifts, so it can be read. */
const LONG_PRESS_LINGER_MS = 1400;

export interface TooltipProps {
  /** The tooltip text. Plain content only: no links or buttons. */
  content: ReactNode;
  /** The single trigger element the tooltip describes. */
  children: ReactElement;
  /**
   * Where the bubble sits relative to the trigger. Defaults to above. `left` (D177 polish): beside the
   * trigger, so it covers neither the line above nor the field below; above when the left has no room.
   */
  placement?: 'top' | 'bottom' | 'left';
  /**
   * In the overlay layer: centred on the trigger (default), or `start`, its left edge at the trigger's and
   * wrapping in the room to the viewport's right edge rather than sliding left (D177 polish: a row's tip
   * never lies over another row's amount).
   */
  align?: 'center' | 'start';
  /**
   * The id of the element inside `content` that is the description. Defaults to the whole bubble.
   * `IconButton` points it at its context line, so the name it already carries as its accessible
   * name is not read a second time as its description.
   */
  descriptionId?: string;
  /** D177: keep the bubble closed (a menu the trigger opened is showing; the bubble would cover it). */
  suppressed?: boolean;
}

/** Props the tooltip injects onto its trigger child. Kept loose so any element type composes. */
interface TriggerProps {
  'aria-describedby'?: string;
  onFocus?: (event: FocusEvent) => void;
  onBlur?: (event: FocusEvent) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  onPointerDown?: (event: PointerEvent) => void;
  onPointerMove?: (event: PointerEvent) => void;
  onPointerUp?: (event: PointerEvent) => void;
  onPointerCancel?: (event: PointerEvent) => void;
  onClickCapture?: (event: MouseEvent) => void;
  onContextMenu?: (event: MouseEvent) => void;
}

/** Who opened the bubble: only a hover-opened bubble takes the pointer (so it can be read). */
type OpenedBy = 'hover' | 'focus' | 'press';

/** Focus arriving this soon after a touch press came from the tap, not from the keyboard. */
const TOUCH_FOCUS_MS = 1000;

/** A long press's closing tap must arrive this soon after the finger lifts to be swallowed. */
const SWALLOW_WINDOW_MS = 800;

export function Tooltip({ content, children, placement = 'top', align = 'center', descriptionId, suppressed = false }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState<OpenedBy | null>(null);
  const portal = useContext(TooltipPortalContext);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const bubbleRef = useRef<HTMLSpanElement | null>(null);
  const [place, setPlace] = useState<{ style: CSSProperties; side: 'top' | 'bottom' | 'left' } | null>(null);
  const shown = open !== null && !suppressed;

  // A portalled bubble is fixed to its trigger: above it (or below, as asked), flipped to the other side
  // when the viewport has no room, and held inside the viewport sideways.
  useLayoutEffect(() => {
    if (!portal || !shown) return;
    const wrap = wrapRef.current?.getBoundingClientRect();
    const bubble = bubbleRef.current?.getBoundingClientRect();
    if (wrap === undefined || bubble === undefined) return;
    // 8px off its trigger (D177 final judge, LOW b): a bubble flush on the next row read as part of it.
    const gap = 8;
    const fixed = { position: 'fixed', bottom: 'auto', right: 'auto', transform: 'none' } as const;
    if (placement === 'left' && wrap.left - bubble.width - gap >= EDGE) {
      const top = Math.min(Math.max(EDGE, wrap.top + wrap.height / 2 - bubble.height / 2), Math.max(EDGE, window.innerHeight - bubble.height - EDGE));
      setPlace({ side: 'left', style: { ...fixed, top, left: wrap.left - bubble.width - gap } });
      return;
    }
    const roomAbove = wrap.top - bubble.height - gap >= EDGE;
    const roomBelow = wrap.bottom + bubble.height + gap <= window.innerHeight - EDGE;
    const side: 'top' | 'bottom' = placement === 'bottom' ? (roomBelow || !roomAbove ? 'bottom' : 'top') : roomAbove || !roomBelow ? 'top' : 'bottom';
    const top = side === 'top' ? wrap.top - bubble.height - gap : wrap.bottom + gap;
    if (align === 'start') {
      // Its left edge at the trigger's; a long text wraps in the room to the right instead of sliding left.
      const room = window.innerWidth - EDGE - wrap.left;
      const left = room >= 120 ? wrap.left : Math.max(EDGE, window.innerWidth - EDGE - 120);
      setPlace({ side, style: { ...fixed, top, left, maxWidth: Math.min(240, Math.max(120, room)) } });
      return;
    }
    const left = Math.min(Math.max(EDGE, wrap.left + wrap.width / 2 - bubble.width / 2), Math.max(EDGE, window.innerWidth - bubble.width - EDGE));
    setPlace({ side, style: { ...fixed, top, left } });
  }, [portal, shown, placement, align, content]);
  const press = useRef<{
    timer?: ReturnType<typeof setTimeout>;
    x: number;
    y: number;
    fired: boolean;
    swallowUntil: number;
    touchAt: number;
  }>({
    x: 0,
    y: 0,
    fired: false,
    swallowUntil: 0,
    touchAt: 0,
  });
  const linger = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      clearTimeout(press.current.timer);
      clearTimeout(linger.current);
    },
    [],
  );

  // Escape dismisses an open bubble wherever focus is (WCAG 2.2 SC 1.4.13, "dismissible"), not only
  // when the trigger has it: a bubble opened by hover is closed by Escape too.
  useEffect(() => {
    if (open === null) return undefined;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const cancelPress = () => {
    clearTimeout(press.current.timer);
    press.current.timer = undefined;
  };

  const childProps = children.props as TriggerProps;

  const trigger = cloneElement(children, {
    'aria-describedby': descriptionId ?? id,
    onFocus: (event: FocusEvent) => {
      // Focus that a touch press just caused opens nothing (a tap is not a question; the long press
      // is). Focus never takes over a hover-opened bubble either: after a mouse click it is still
      // the hover's, so it closes when the pointer leaves.
      // Only keyboard focus opens it (`:focus-visible`), never a script's `focus()` after a click (D180:
      // the edit toggle hands focus back on Fertig, and a bubble then was noise).
      if (Date.now() - press.current.touchAt > TOUCH_FOCUS_MS && isKeyboardFocus(event.currentTarget as Element)) {
        setOpen((current) => current ?? 'focus');
      }
      childProps.onFocus?.(event);
    },
    onBlur: (event: FocusEvent) => {
      setOpen(null);
      childProps.onBlur?.(event);
    },
    onKeyDown: (event: KeyboardEvent) => {
      // A keyboard act is never the closing tap of a long press.
      press.current.swallowUntil = 0;
      if (event.key === 'Escape') {
        if (open !== null) CONSUMED_ESCAPES.add(event.nativeEvent);
        setOpen(null);
      }
      childProps.onKeyDown?.(event);
    },
    onPointerDown: (event: PointerEvent) => {
      // Any new press starts clean: a long press that ended without a click must not eat the next one.
      press.current.fired = false;
      press.current.swallowUntil = 0;
      cancelPress();
      // Only a press on the trigger itself arms: React events bubble out of portals, and a long press
      // inside a popover the trigger owns (a combobox's list) must keep its own touch menu.
      if (event.pointerType === 'touch') press.current.touchAt = Date.now();
      if (event.pointerType === 'touch' && event.currentTarget.contains(event.target as Node)) {
        clearTimeout(linger.current);
        press.current.x = event.clientX;
        press.current.y = event.clientY;
        press.current.timer = setTimeout(() => {
          press.current.timer = undefined;
          press.current.fired = true;
          setOpen('press');
        }, LONG_PRESS_MS);
      }
      childProps.onPointerDown?.(event);
    },
    onPointerMove: (event: PointerEvent) => {
      if (
        press.current.timer !== undefined &&
        (Math.abs(event.clientX - press.current.x) > LONG_PRESS_SLOP_PX ||
          Math.abs(event.clientY - press.current.y) > LONG_PRESS_SLOP_PX)
      ) {
        cancelPress();
      }
      childProps.onPointerMove?.(event);
    },
    onPointerUp: (event: PointerEvent) => {
      if (event.pointerType === 'touch') {
        cancelPress();
        if (press.current.fired) {
          // The tap the platform may send now asked a question; a later click is a new act.
          press.current.fired = false;
          press.current.swallowUntil = Date.now() + SWALLOW_WINDOW_MS;
          linger.current = setTimeout(() => setOpen(null), LONG_PRESS_LINGER_MS);
        }
      }
      childProps.onPointerUp?.(event);
    },
    onPointerCancel: (event: PointerEvent) => {
      cancelPress();
      if (press.current.fired) {
        press.current.fired = false;
        setOpen(null);
      }
      childProps.onPointerCancel?.(event);
    },
    onClickCapture: (event: MouseEvent) => {
      // Only a pointer click (detail > 0) right after a long press is swallowed. A keyboard or
      // assistive-technology click has detail 0 and always acts.
      if (event.detail > 0 && Date.now() <= press.current.swallowUntil) {
        press.current.swallowUntil = 0;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      press.current.swallowUntil = 0;
      childProps.onClickCapture?.(event);
    },
    onContextMenu: (event: MouseEvent) => {
      if (press.current.fired || press.current.timer !== undefined) event.preventDefault();
      childProps.onContextMenu?.(event);
    },
  } as TriggerProps);

  // Hover is tracked on the wrapper, which holds the bubble too, so the pointer can move from the
  // trigger onto an open bubble without it closing (WCAG 2.2 SC 1.4.13, "hoverable"). Only a real
  // hover counts: a mouse or a pen. A touch tap fires compatibility mouse events, and a bubble it
  // opened would sit over the next row and catch its tap.
  const hovers = (event: PointerEvent) => event.pointerType === 'mouse' || event.pointerType === 'pen';

  // Only an OPEN bubble moves to the overlay layer; a shut one stays beside its trigger, hidden, so its
  // text stays in the trigger's own subtree for a reader of the DOM (and `aria-describedby` resolves).
  const floating = portal && shown;
  const side = floating && place !== null ? place.side : placement;
  const bubble = (
    <span
      role="tooltip"
      id={id}
      ref={bubbleRef}
      className={`tooltip tooltip-${side}${floating ? ' tooltip--portal' : ''}${shown && (!floating || place !== null) ? ' is-open' : ''}${open === 'hover' && !suppressed ? ' is-hoverable' : ''}`}
      // Before it is placed it is measured at the viewport's corner, free of `.tooltip-top`'s `bottom` (an
      // inset on both edges would squash it to its padding and place it over its own trigger).
      style={floating ? (place?.style ?? { position: 'fixed', top: 0, left: 0, bottom: 'auto', right: 'auto', transform: 'none' }) : undefined}
      // A portalled bubble is outside the wrapper: hovering it keeps it open (WCAG 2.2 SC 1.4.13).
      {...(floating
        ? {
            onPointerEnter: (event: PointerEvent) => {
              if (hovers(event)) setOpen((current) => current ?? 'hover');
            },
            onPointerLeave: (event: PointerEvent) => {
              if (hovers(event)) setOpen((current) => (current === 'hover' ? null : current));
            },
          }
        : {})}
    >
      {content}
    </span>
  );

  return (
    <span
      className="tooltip-wrap"
      ref={wrapRef}
      onPointerEnter={(event) => {
        if (hovers(event)) setOpen((current) => current ?? 'hover');
      }}
      onPointerLeave={(event) => {
        if (hovers(event)) setOpen((current) => (current === 'hover' ? null : current));
      }}
    >
      {trigger}
      {floating && typeof document !== 'undefined' ? createPortal(bubble, document.body) : bubble}
    </span>
  );
}
