/**
 * The Studio's ONE drag-to-reorder wrapper (dnd-kit, brand/DESIGN.md Dependencies): the personal menu
 * order (`app/MenuCustomiser.tsx`) and the Übersicht's key figures and cards (D180) sort through it.
 *
 * A list is the unit a drag reorders within, so each list carries its own drag context. Only a pointer
 * drags (the `PointerSensor`, after 4px so a click on the grip is not a drag); the caller wires the
 * sensor's listeners onto a grip only (`useSortable`'s `setActivatorNodeRef`), which is what keeps touch
 * scrolling from ever starting a drag. Drag is never the only way: every caller pairs it with a
 * non-drag move (WCAG 2.5.7), the Mehr menu and Alt+Arrow on the focused item.
 *
 * A surface that sorts only in an edit mode keeps the list mounted in both modes and passes `disabled`
 * to its items' `useSortable`: switching then never remounts an item, never re-reads what it shows and
 * never replays an entrance.
 *
 * `strategy` picks how the neighbours make room: `vertical` for a list, `rect` for a grid. `renderOverlay`
 * draws the dragged item in a `DragOverlay` that follows the pointer while its slot stays in place; the
 * drop animation is dropped under reduced motion, like every other transition.
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, verticalListSortingStrategy } from '@dnd-kit/sortable';

/**
 * dnd-kit's own voice, silenced. Its defaults speak English and name raw ids ("Picked up draggable item
 * ar_aging"), on top of the caller's own live region; every caller here announces a move itself, in
 * the person's language and with the item's name, so dnd-kit says nothing at all.
 */
const SILENT = {
  announcements: {
    onDragStart: () => undefined,
    onDragMove: () => undefined,
    onDragOver: () => undefined,
    onDragEnd: () => undefined,
    onDragCancel: () => undefined,
  },
  screenReaderInstructions: { draggable: '' },
};

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface SortableListProps {
  ids: readonly string[];
  /** A drop: `id` was dragged onto `overId`'s place. Never called for a drop on itself or outside. */
  onReorder: (id: string, overId: string) => void;
  className: string;
  children: ReactNode;
  /** `vertical` for a list (the default), `rect` for a grid. */
  strategy?: 'vertical' | 'rect';
  /** The list element: `ul` (the default), `ol` or a `div`. */
  as?: 'ul' | 'ol' | 'div';
  /** An accessible name for the list element. */
  ariaLabel?: string;
  /** Inline style on the list element (a custom property the grid reads). */
  style?: CSSProperties;
  /** Draw the dragged item in an overlay that follows the pointer. Omitted: the item itself moves. */
  renderOverlay?: (id: string) => ReactNode;
  /** A class on the overlay's wrapper (the lift and the shadow are the caller's). */
  overlayClassName?: string;
  /**
   * `longPress`: for a list whose whole item drags. A mouse drags after 4px; a touch only after it
   * rests for 250ms within 8px (a swipe scrolls), or at once from a `data-drag-handle` grip. Omitted:
   * one pointer sensor after 4px, for a list that drags from its grips only.
   */
  touch?: 'longPress';
}

/** The element a touch drags from at once (a grip); anywhere else a touch must rest first. */
const DRAG_HANDLE = '[data-drag-handle]';

/**
 * A touch sensor for a list whose whole item drags (D180 round 5): a press on a grip
 * (`data-drag-handle`) drags at once, a press anywhere else only after it rests (the long press), so a
 * swipe over the items scrolls the page instead of moving them.
 */
class HandleAwareTouchSensor extends TouchSensor {
  constructor(props: ConstructorParameters<typeof TouchSensor>[0]) {
    const target = props.event.target;
    const onHandle = target instanceof Element && target.closest(DRAG_HANDLE) !== null;
    super(onHandle ? { ...props, options: { ...props.options, activationConstraint: undefined } } : props);
  }
}

/** A finished drag as a reorder: the dragged id and the id whose place it took, or null for none. */
export function reorderOf(event: Pick<DragEndEvent, 'active' | 'over'>): [string, string] | null {
  const { active, over } = event;
  if (over === null || active.id === over.id) return null;
  return [String(active.id), String(over.id)];
}

export function SortableList({
  ids,
  onReorder,
  className,
  children,
  strategy = 'vertical',
  as: Tag = 'ul',
  ariaLabel,
  style,
  renderOverlay,
  overlayClassName,
  touch,
}: SortableListProps) {
  const pointer = useSensor(PointerSensor, { activationConstraint: { distance: 4 } });
  const mouse = useSensor(MouseSensor, { activationConstraint: { distance: 4 } });
  const longPress = useSensor(HandleAwareTouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } });
  // The list's kind is fixed for its life, so the sensor array keeps its length between renders.
  const sensors = useSensors(...(touch === 'longPress' ? [mouse, longPress] : [pointer]));
  const [active, setActive] = useState<string | null>(null);
  const onDragStart = (event: DragStartEvent): void => setActive(String(event.active.id));
  const onDragEnd = (event: DragEndEvent): void => {
    setActive(null);
    const move = reorderOf(event);
    if (move !== null) onReorder(move[0], move[1]);
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      accessibility={SILENT}
      // Only up and down: a drag near a side edge never scrolls the page sideways.
      autoScroll={{ threshold: { x: 0, y: 0.2 } }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActive(null)}
    >
      <SortableContext items={[...ids]} strategy={strategy === 'rect' ? rectSortingStrategy : verticalListSortingStrategy}>
        <Tag className={className} aria-label={ariaLabel} style={style}>
          {children}
        </Tag>
      </SortableContext>
      {renderOverlay !== undefined ? (
        <DragOverlay dropAnimation={prefersReducedMotion() ? null : undefined} className={overlayClassName}>
          {active !== null ? renderOverlay(active) : null}
        </DragOverlay>
      ) : null}
    </DndContext>
  );
}
