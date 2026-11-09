/**
 * The Favoriten section: a per-person shortcut list pinned ABOVE the menu (D118 A3, rebuilt by D178).
 *
 * WHAT THIS IS. A short, ordered list of the person's pinned surfaces, rendered above the menu and only
 * when non-empty, under its own folding "Favoriten" section header (a step quieter than a group header,
 * so it never passes for one; it carries `aria-current="location"` while folded over the open page). A favourite is
 * a pointer to a catalog surface by `navId`; a pin whose surface no longer exists is silently dropped
 * rather than shown broken. The menu below is never reordered by it.
 *
 * FLUSH WITH THE MENU (D178 point 15). A favourite row is a menu row: the same 28px band, 2px gap and
 * inset, its title at the same x as a top-level leaf's. No column is reserved for the drag grip any
 * more (the old invisible 20px grip pushed the icon to 54px, deeper than a nested child); the grip takes
 * the icon's place on hover and keyboard focus, and is always shown while "Menü anpassen" is open. The
 * look is the person's `nav.favourite_style`: the page's icon with a filled star at the right edge
 * (default), a star in the icon's place, or the icon alone.
 *
 * ONE HIGHLIGHT. Whether this row carries `aria-current` is the rail's one decision (`useRail().active`,
 * `nav.active_rule`), never a URL match of its own: before D178 the lane and the menu both lit.
 *
 * WHAT A PERSON CAN DO HERE, and the accessibility contract for each:
 *   - REORDER by pointer drag (dnd-kit) AND by "Nach oben" / "Nach unten" in the row's Mehr menu. The
 *     menu items are MANDATORY (WCAG 2.5.7: a single-pointer, non-dragging alternative) and are the
 *     keyboard path, with Alt+ArrowUp/Down on the row as the shortcut; the grip is pointer-only and
 *     hidden from assistive tech. They moved under Mehr in D178: four arrow and pencil glyphs on a
 *     hovered row left its title three letters, and D154 admits an icon alone only from the closed
 *     vocabulary, which has Mehr and no arrows.
 *   - RENAME (alias), favourites-only, also under Mehr. The canonical name survives as the tooltip.
 *   - UNPIN, the one glyph button: under `icon_star` it sits exactly where the resting star is; also
 *     "Entfernen" under Mehr, which is the path while "Menü anpassen" is open (the star steps out there
 *     and Mehr stays visible, so a touch screen never depends on the drag).
 *
 * MOTION. dnd-kit's settle animation honours reduced motion; the pointer drag itself tracks the finger
 * and is never suppressed.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { useT } from '../i18n';
import { OverflowMenu } from '../components/OverflowMenu';
import { NavIcon } from './nav-icons';
import { RailSectionHeader } from './NavTree';
import { useRail, type FavouriteStyle, type ResolvedFavourite } from './nav-prefs';
import { AgentBadge, AttentionBadge, SlotBoundary } from './chrome';

/** True when the OS asks to minimise motion. Guarded for environments without matchMedia (jsdom). */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** One favourite row: the link, the grip over its icon slot, and the trailing controls. */
function FavouriteRow({
  fav,
  index,
  count,
  active,
  style,
  reducedMotion,
  onNavigate,
  onMove,
  onUnpin,
  onAlias,
}: {
  fav: ResolvedFavourite;
  index: number;
  count: number;
  active: boolean;
  style: FavouriteStyle;
  reducedMotion: boolean;
  onNavigate: (path: string) => void;
  onMove: (navId: string, direction: 'up' | 'down') => void;
  onUnpin: (navId: string) => void;
  onAlias: (navId: string, alias: string | null) => void;
}) {
  const t = useT();
  const canonical = t(fav.surface.labelKey);
  const shown = fav.alias ?? canonical;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(shown);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Only the pointer `listeners` are wired to the grip; dnd-kit's `attributes` (role="button",
  // tabIndex 0) are deliberately NOT spread: the keyboard reorder is the move buttons (WCAG 2.5.7).
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: fav.navId,
  });

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startRename = useCallback(() => {
    setDraft(fav.alias ?? canonical);
    setEditing(true);
  }, [fav.alias, canonical]);

  const commitRename = useCallback(() => {
    if (!editing) return;
    setEditing(false);
    const trimmed = draft.trim();
    // An empty field, or the canonical name typed back verbatim, clears the alias.
    onAlias(fav.navId, trimmed.length === 0 || trimmed === canonical ? null : trimmed);
  }, [editing, draft, fav.navId, canonical, onAlias]);

  const cancelRename = useCallback(() => {
    setEditing(false);
    setDraft(fav.alias ?? canonical);
  }, [fav.alias, canonical]);

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitRename();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelRename();
    }
  };

  const dragStyle = {
    transform: CSS.Transform.toString(transform),
    transition: reducedMotion ? undefined : transition,
  };
  const slotIcon = style === 'star_only' ? 'starFilled' : fav.surface.icon;

  // Alt+ArrowUp / Alt+ArrowDown on the focused row moves it, the shortcut beside the Mehr menu.
  const onRowKeyDown = (event: KeyboardEvent<HTMLLIElement>): void => {
    if (editing || !event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    onMove(fav.navId, event.key === 'ArrowUp' ? 'up' : 'down');
  };

  return (
    <li
      ref={setNodeRef}
      style={dragStyle}
      className={isDragging ? 'rail-fav-row rail-fav-row--dragging' : 'rail-fav-row'}
      data-fav-navid={fav.navId}
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
      onKeyDown={onRowKeyDown}
    >
      {editing ? (
        <input
          ref={inputRef}
          className="rail-fav-input"
          value={draft}
          maxLength={60}
          aria-label={t('nav.favourites.renameField', { name: canonical })}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onInputKeyDown}
          onBlur={commitRename}
        />
      ) : (
        <a
          href={fav.surface.path}
          className="rail-fav-link rail-link"
          aria-current={active ? 'page' : undefined}
          // The canonical name always survives as the tooltip, even when an alias is shown.
          title={fav.alias !== undefined ? canonical : undefined}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
            event.preventDefault();
            onNavigate(fav.surface.path);
          }}
        >
          {slotIcon !== undefined && (
            <NavIcon name={slotIcon} className={style === 'star_only' ? 'rail-icon rail-fav-slot-star' : 'rail-icon'} />
          )}
          <span className="rail-label">{shown}</span>
          {fav.surface.path === '/agent' && (
            <SlotBoundary slot="agent-badge">
              <AgentBadge />
            </SlotBoundary>
          )}
          {fav.surface.path === '/attention' && (
            <SlotBoundary slot="attention-badge">
              <AttentionBadge />
            </SlotBoundary>
          )}
          {style === 'icon_star' && <NavIcon name="starFilled" size={16} className="rail-fav-star" />}
        </a>
      )}

      {/* The pointer-only drag grip over the icon slot: out of the tab order and hidden from assistive
          tech, because the keyboard reorder is the move buttons (WCAG 2.5.7). */}
      {!editing && (
        <span ref={setActivatorNodeRef} className="rail-fav-grip" aria-hidden="true" {...listeners}>
          <NavIcon name="grip" />
        </span>
      )}

      {!editing && (
        <span className="rail-fav-controls">
          {/* Move up, move down, rename and remove sit under Mehr (D154: an icon alone only from the
              closed vocabulary): the menu items are the single-pointer, non-dragging reorder of WCAG
              2.5.7 and the keyboard path, with Alt+ArrowUp/Down on the row as the shortcut. In "Menü
              anpassen" Mehr is always shown (on touch it is the reorder) and the unpin star steps out. */}
          <OverflowMenu
            label={t('nav.favourites.more', { name: shown })}
            quiet
            portal
            className="rail-fav-more"
            items={[
              { key: 'up', label: t('nav.customise.moveUp'), disabled: index === 0, onSelect: () => onMove(fav.navId, 'up') },
              { key: 'down', label: t('nav.customise.moveDown'), disabled: index === count - 1, onSelect: () => onMove(fav.navId, 'down') },
              { key: 'rename', label: t('nav.favourites.renameItem'), onSelect: startRename },
              { key: 'remove', label: t('nav.favourites.removeItem'), onSelect: () => onUnpin(fav.navId) },
            ]}
          />
          <button
            type="button"
            className="rail-fav-btn rail-fav-btn--unpin"
            aria-label={t('nav.favourites.unpin', { name: canonical })}
            onClick={() => onUnpin(fav.navId)}
          >
            <NavIcon name="starFilled" size={16} />
          </button>
        </span>
      )}
    </li>
  );
}

/**
 * The Favoriten section. Renders nothing when the person has no (resolvable) favourites, so the menu
 * sits at the top of the rail until the first pin. `onNavigate` dismisses the mobile drawer.
 */
export function FavouritesRail({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const { resolvedFavourites, favourites, sections, toggleSection, look, active, location } = useRail();
  const { move, unpin, reorder, setAlias, error } = favourites;
  const reducedMotion = prefersReducedMotion();
  const listId = useId();

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const go = useCallback(
    (path: string): void => {
      navigate(path);
      onNavigate?.();
    },
    [navigate, onNavigate],
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent): void => {
      const { active: dragged, over } = event;
      if (over === null || dragged.id === over.id) return;
      const from = favourites.favourites.findIndex((f) => f.navId === dragged.id);
      const to = favourites.favourites.findIndex((f) => f.navId === over.id);
      if (from === -1 || to === -1) return;
      reorder(from, to);
    },
    [favourites.favourites, reorder],
  );

  if (resolvedFavourites.length === 0) return null;

  return (
    <section className="rail-section rail-favourites" aria-label={t('nav.favourites.label')}>
      <RailSectionHeader
        label={t('nav.favourites.label')}
        folded={sections.favourites}
        onToggle={() => toggleSection('favourites')}
        controlsId={listId}
        location={location === 'favourites'}
      />
      {!sections.favourites && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={resolvedFavourites.map((f) => f.navId)} strategy={verticalListSortingStrategy}>
            <ul className="rail-fav-list" id={listId} data-fav-style={look.favouriteStyle}>
              {resolvedFavourites.map((fav, index) => (
                <FavouriteRow
                  key={fav.navId}
                  fav={fav}
                  index={index}
                  count={resolvedFavourites.length}
                  active={fav.navId === active.favouriteNavId}
                  style={look.favouriteStyle}
                  reducedMotion={reducedMotion}
                  onNavigate={go}
                  onMove={move}
                  onUnpin={unpin}
                  onAlias={setAlias}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
      {error !== null && (
        <p className="rail-save-note" role="status">
          {t('nav.favourites.saveFailed')}
        </p>
      )}
    </section>
  );
}
