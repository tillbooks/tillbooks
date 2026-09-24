/**
 * The Favoriten lane: a per-user personal shortcut section pinned ABOVE the canonical tree (D118 A3).
 *
 * WHAT THIS IS. A short, ordered list of a user's pinned surfaces, rendered above the canonical rail
 * tree, appearing ONLY when non-empty. The canonical tree below is untouched (favourites are
 * additive, never a reorder of the shared taxonomy: one shared mental model for documentation,
 * support and the agent, one personal lane on top). A favourite is a pointer to a catalog surface by
 * `navId`, resolved through `surfaceByNavId`; a pin whose surface no longer exists is silently dropped
 * rather than shown broken.
 *
 * THREE THINGS A USER CAN DO HERE, and the accessibility contract for each:
 *   - REORDER by pointer drag (dnd-kit) AND by keyboard move-up / move-down buttons. The buttons are
 *     MANDATORY, not a nicety: WCAG 2.5.7 (Dragging Movements, AA) requires a single-pointer,
 *     non-dragging alternative to every drag, and the buttons are also the keyboard path. The drag
 *     handle is a pointer-only grip (aria-hidden, out of the tab order) precisely so the buttons are
 *     the one true keyboard reorder and there is no confusing second keyboard grabber.
 *   - RENAME (alias), favourites-only. An inline text field replaces the label; Enter commits, Escape
 *     cancels, blur commits. The canonical name always survives as the row's `title` tooltip and stays
 *     the label the tree below shows. Aliasing is deliberately not offered anywhere else in the tree.
 *   - UNPIN, removing the surface from the lane (the tree row remains, of course).
 *
 * MOTION. dnd-kit's own settle animation and the section reveal both honour `prefers-reduced-motion`:
 * the sortable transition is nulled under reduced motion, and the CSS reveal is switched off in
 * global.css. The pointer drag itself is not "motion" in the reduced-motion sense (it tracks the
 * finger), so it is never suppressed.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { useT } from '../i18n';
import { surfaceByNavId, type NavItem } from './nav';
import { NavIcon } from './nav-icons';
import { useNavFavourites, type NavFavourite } from './nav-prefs';

/** True when the OS asks to minimise motion. Guarded for environments without matchMedia (jsdom). */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A small square glyph, stroked in currentColor, matching the rail's 16px chevron weight. */
function Glyph({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      className={className}
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
    >
      {children}
    </svg>
  );
}

const StarIcon = () => (
  <Glyph className="rail-fav-glyph">
    <path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.2 9.7l5.9-.9z" fill="currentColor" />
  </Glyph>
);
const MoveUpIcon = () => (
  <Glyph className="rail-fav-glyph">
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Glyph>
);
const MoveDownIcon = () => (
  <Glyph className="rail-fav-glyph">
    <path d="M12 5v14M6 13l6 6 6-6" />
  </Glyph>
);
const RenameIcon = () => (
  <Glyph className="rail-fav-glyph">
    <path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z" />
    <path d="M13.5 7.5l3 3" />
  </Glyph>
);
const GripIcon = () => (
  <Glyph className="rail-fav-glyph">
    <path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" />
  </Glyph>
);

/** One resolved favourite: its catalog surface joined to the user's alias (if any) and its index. */
interface ResolvedFavourite {
  navId: string;
  surface: NavItem;
  alias?: string;
}

/**
 * One favourite row: a sortable list item holding the navigation link and its personalization
 * controls (move up/down, rename, unpin). Kept as its own component because `useSortable` is a hook
 * and must be called per item.
 */
function FavouriteRow({
  fav,
  index,
  count,
  active,
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
  // tabIndex 0, aria-*) are deliberately NOT spread, because the grip is a pointer-only, AT-hidden
  // handle: the keyboard reorder path is the move buttons (WCAG 2.5.7), not this grip.
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: fav.navId });

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

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: reducedMotion ? undefined : transition,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={isDragging ? 'rail-fav-row rail-fav-row--dragging' : 'rail-fav-row'}
    >
      {/* Pointer-only drag grip: out of the tab order and hidden from assistive tech, because the
          keyboard reorder is the move buttons (WCAG 2.5.7), not a second keyboard grabber. */}
      <span
        ref={setActivatorNodeRef}
        className="rail-fav-grip"
        aria-hidden="true"
        tabIndex={-1}
        {...listeners}
      >
        <GripIcon />
      </span>

      {editing ? (
        <input
          ref={inputRef}
          className="rail-fav-input"
          value={draft}
          aria-label={t('nav.favourites.renameField', { name: canonical })}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onInputKeyDown}
          onBlur={commitRename}
        />
      ) : (
        <a
          href={fav.surface.path}
          className="rail-fav-link rail-link"
          role="link"
          aria-current={active ? 'page' : undefined}
          // The canonical name always survives as the tooltip, even when an alias is shown (design
          // law: when a friendly label replaces a machine key, the raw key survives as the tooltip).
          title={fav.alias !== undefined ? canonical : undefined}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
            event.preventDefault();
            onNavigate(fav.surface.path);
          }}
        >
          {fav.surface.icon !== undefined && <NavIcon name={fav.surface.icon} className="rail-icon" />}
          <span className="rail-label">{shown}</span>
        </a>
      )}

      {!editing && (
        <span className="rail-fav-controls">
          <button
            type="button"
            className="rail-fav-btn"
            disabled={index === 0}
            aria-label={t('nav.favourites.moveUp', { name: shown })}
            onClick={() => onMove(fav.navId, 'up')}
          >
            <MoveUpIcon />
          </button>
          <button
            type="button"
            className="rail-fav-btn"
            disabled={index === count - 1}
            aria-label={t('nav.favourites.moveDown', { name: shown })}
            onClick={() => onMove(fav.navId, 'down')}
          >
            <MoveDownIcon />
          </button>
          <button
            type="button"
            className="rail-fav-btn"
            aria-label={t('nav.favourites.rename', { name: canonical })}
            onClick={startRename}
          >
            <RenameIcon />
          </button>
          <button
            type="button"
            className="rail-fav-btn rail-fav-btn--unpin"
            aria-label={t('nav.favourites.unpin', { name: canonical })}
            onClick={() => onUnpin(fav.navId)}
          >
            <StarIcon />
          </button>
        </span>
      )}
    </li>
  );
}

/**
 * The Favoriten lane. Renders nothing when the user has no (resolvable) favourites, so the canonical
 * tree sits at the very top of the rail until the first pin. `onNavigate` dismisses the mobile drawer,
 * matching `NavTree`.
 */
export function FavouritesRail({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const location = useLocation();
  const navigate = useNavigate();
  const { favourites, move, unpin, reorder, setAlias } = useNavFavourites();
  const reducedMotion = prefersReducedMotion();

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // Resolve each pin to its catalog surface, dropping any that no longer resolves (a removed surface).
  const resolved: ResolvedFavourite[] = favourites.flatMap((f: NavFavourite) => {
    const surface = surfaceByNavId(f.navId);
    if (surface === undefined) return [];
    const item: NavItem = {
      navId: surface.navId,
      path: surface.path,
      labelKey: surface.labelKey,
      icon: surface.icon,
    };
    return [{ navId: f.navId, surface: item, alias: f.alias }];
  });

  const go = useCallback(
    (path: string): void => {
      navigate(path);
      onNavigate?.();
    },
    [navigate, onNavigate],
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent): void => {
      const { active, over } = event;
      if (over === null || active.id === over.id) return;
      const from = resolved.findIndex((f) => f.navId === active.id);
      const to = resolved.findIndex((f) => f.navId === over.id);
      if (from === -1 || to === -1) return;
      reorder(from, to);
    },
    [resolved, reorder],
  );

  if (resolved.length === 0) return null;

  const activePath = location.pathname;
  const isActive = (path: string): boolean => activePath === path || activePath.startsWith(`${path}/`);

  return (
    <section className="rail-favourites" aria-labelledby="rail-fav-label">
      <p id="rail-fav-label" className="rail-group-label rail-fav-label">
        {t('nav.favourites.label')}
      </p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={resolved.map((f) => f.navId)} strategy={verticalListSortingStrategy}>
          <ul className="rail-fav-list">
            {resolved.map((fav, index) => (
              <FavouriteRow
                key={fav.navId}
                fav={fav}
                index={index}
                count={resolved.length}
                active={isActive(fav.surface.path)}
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
    </section>
  );
}
