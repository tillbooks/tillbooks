/**
 * D180: the Übersicht's edit mode, item by item. One `EditItem` wraps every key figure and every card in
 * both modes, and the drag context stays mounted, so switching modes never remounts what an item shows.
 *
 * THE LOOK (round 4, owner: simple, modern, low load). The controls live ON the item: a grip handle
 * inside its top-left corner and a small floating pill of icons on its top-right edge. Nothing is
 * added above or between the items, so entering or leaving edit mode moves nothing on the page.
 *
 * THE ACCESSIBILITY CONTRACT (the MenuCustomiser's, brand/DESIGN.md Dependencies).
 *   - Pointer drag through the shared `SortableList`, on the WHOLE item (its face is inert while
 *     editing, so a press anywhere on it is a press on the item). The grip is the visual cue, hidden
 *     from assistive tech. The pill stops a press from starting a drag, so its icons stay clicks.
 *   - The single-pointer, non-dragging alternative (WCAG 2.5.7) is the item's Mehr menu, "Nach vorne"
 *     and "Nach hinten"; the keyboard shortcut is Alt+Arrow on any of the item's controls. The caller
 *     keeps the focus on the moved item and announces every move in a polite live region.
 *   - While editing the item is a named group ("Umsatz", or "Umsatz, ausgeblendet"), so a reader keeps
 *     the item's name while its face is inert.
 *   - Every corner control is an `IconButton` of the closed vocabulary (Ausblenden, Einblenden, Grösse
 *     ändern, Mehr), so each has a name, a context and a tooltip. There are no text buttons.
 */
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { useT } from '../../i18n';
import { GripGlyph } from '../../components/icons';
import { IconButton } from '../../components/IconButton';
import { OverflowMenu, type OverflowMenuItem } from '../../components/OverflowMenu';

export interface EditItemProps {
  id: string;
  /** The item's name, as a person reads it ("Umsatz", "Offene Kreditoren"). */
  name: string;
  editing: boolean;
  /** `li` in the key-figure list, `div` in the card grid. */
  as: 'li' | 'div';
  className?: string;
  /** Its place in the edited list, for the Mehr menu's first and last. */
  index: number;
  count: number;
  /** A move by one place, earlier (-1) or later (+1). */
  onMove: (delta: -1 | 1) => void;
  /** The pill's icons before Mehr (Ausblenden or Einblenden, Grösse ändern). */
  tools?: ReactNode;
  /** A hidden item while editing: drawn as a ghost in its slot. */
  ghost?: boolean;
  children: ReactNode;
}

/** The arrow keys Alt moves an item with: up and left are earlier, down and right later. */
const EARLIER = new Set(['ArrowUp', 'ArrowLeft']);
const LATER = new Set(['ArrowDown', 'ArrowRight']);

/** A press on the pill is a press on an icon, never the start of a drag. */
const keepPressHere = (event: PointerEvent<HTMLElement>): void => event.stopPropagation();

export function EditItem({ id, name, editing, as: Tag, className, index, count, onMove, tools, ghost = false, children }: EditItemProps) {
  const t = useT();
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: !editing });

  // dnd-kit decides WHEN the neighbours glide (never right after a drop, which would flicker); the
  // HOW is the Reveal token, so the reduced-motion kill switch zeroes it like every other transition.
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition: transition === undefined || transition === null ? undefined : 'transform var(--t-motion-reveal) var(--t-ease-out)',
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!editing || !event.altKey) return;
    const delta = EARLIER.has(event.key) ? -1 : LATER.has(event.key) ? 1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    event.stopPropagation();
    if ((delta === -1 && index === 0) || (delta === 1 && index === count - 1)) return;
    onMove(delta);
  };

  const moves: OverflowMenuItem[] = [
    { key: 'forward', label: t('dashboard.edit.forward'), onSelect: () => onMove(-1), disabled: index === 0 },
    { key: 'back', label: t('dashboard.edit.back'), onSelect: () => onMove(1), disabled: index === count - 1 },
  ];

  const classes = ['uebersicht-item', className ?? '', editing ? 'is-editing' : '', ghost ? 'is-ghost' : '', isDragging ? 'is-dragging' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <Tag
      ref={setNodeRef}
      style={editing ? style : undefined}
      className={classes}
      data-slot={id}
      onKeyDown={onKeyDown}
      aria-keyshortcuts={editing ? 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight' : undefined}
      {...(editing ? listeners : {})}
    >
      {/* One stable wrapper in both modes (nothing remounts): a named group while editing. */}
      <div
        className="uebersicht-item__group"
        role={editing ? 'group' : undefined}
        aria-label={editing ? (ghost ? t('dashboard.edit.ghostName', { name }) : name) : undefined}
      >
        {/* The item's own face. While editing it is inert: a keyboard never tabs into a link or a card's
            controls mid-arrangement, and a press on it is a press on the item. */}
        <div className="uebersicht-item__face" inert={editing}>
          {children}
        </div>
        {editing ? (
          <>
            <span className="uebersicht-grip" aria-hidden="true" data-drag-handle="">
              <GripGlyph size={16} />
            </span>
            <div className="uebersicht-tools" onPointerDown={keepPressHere}>
              {tools}
              <OverflowMenu
                icon="more"
                quiet
                portal
                label={t('dashboard.edit.more', { name })}
                tooltip={t('dashboard.edit.moreTip', { name })}
                items={moves}
                className="uebersicht-tools__more"
              />
            </div>
          </>
        ) : null}
      </div>
    </Tag>
  );
}

/** The eye on an item: Ausblenden while it shows, Einblenden on its ghost. */
export function VisibilityToggle({ name, on, onToggle }: { name: string; on: boolean; onToggle: () => void }) {
  return <IconButton icon={on ? 'hide' : 'show'} context={name} small onClick={onToggle} />;
}

/**
 * The ghost a hidden item leaves in its slot while editing: its name and the word for its state
 * ("Ausgeblendet", or another word for an item that has no figures to show).
 */
export function Ghost({ name, state }: { name: string; state?: string }) {
  const t = useT();
  return (
    <div className="uebersicht-ghost">
      <span className="uebersicht-ghost__name">{name}</span>
      <span className="uebersicht-ghost__state">{state ?? t('dashboard.edit.hidden')}</span>
    </div>
  );
}

/** The attributes a snapshot drops: ids and the references to them, and the edit mode's inert. */
const SNAPSHOT_DROPS = ['id', 'aria-describedby', 'aria-labelledby', 'aria-controls', 'inert'] as const;

/**
 * A static copy of an item's rendered face for the drag preview. It is a DOM clone (`cloneNode`), never
 * a serialised string parsed again, so text the person entered (a vendor name, a task title) stays text
 * and nothing in it can become markup. Ids and the references to them are dropped (the original is
 * still on the page), and so is `inert`.
 */
export function snapshotFace(face: Element): HTMLElement {
  const clone = face.cloneNode(true) as HTMLElement;
  for (const el of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) {
    for (const name of SNAPSHOT_DROPS) el.removeAttribute(name);
  }
  return clone;
}

/** The drag preview: the snapshot attached through a ref, in a container hidden from assistive tech. */
export function FaceSnapshot({ face }: { face: Element }) {
  return <div className="uebersicht-overlay-face" aria-hidden="true" ref={(el) => el?.replaceChildren(snapshotFace(face))} />;
}
