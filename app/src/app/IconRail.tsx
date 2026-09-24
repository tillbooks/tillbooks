/**
 * The rail's collapsed ICON strip and its flyouts (D118, modernisation phase 1, A4).
 *
 * When the resizable rail is collapsed to 56px (dragged below the minimum, or via the collapse
 * affordance), the full tree is replaced by this: one icon per top-level rail entry, and a flyout that
 * opens on hover OR on keyboard focus to reveal that entry's label and destinations. It is a SEPARATE
 * rendering from `NavTree` (a different mode, not a restyle), reading the same `NAV_RAIL` model so the
 * icon strip and the tree can never disagree about what exists or where it sits.
 *
 * THE TWO KINDS OF ENTRY:
 *   - A single destination (an always-visible daily surface: Übersicht, Aufgaben, ...) is a `link`
 *     icon. Its button navigates on click; its flyout is a label, a tooltip for the icon.
 *   - A headed group (Stammdaten, Verkauf, ...) is a `group` icon. Its button opens a flyout listing
 *     the group's destinations (nested parents dissolved into their children in place). Clicking a
 *     destination navigates.
 *
 * THE ACCESSIBILITY CONTRACT. The flyout is NOT a modal dialog: it is a disclosure, so it never
 * carries a modal dialog role (the modal-role guard reserves that for a bare div, and a
 * menu/disclosure is not modal anyway). It is a plain positioned `div` with `role="group"` and an
 * accessible name (the entry label). Every trigger is a real `<button>` with its own name, so the
 * strip is fully keyboard reachable: Tab lands on a trigger, focusing it opens the flyout, Tab walks
 * into the
 * destinations, Escape closes the flyout and returns focus to the trigger. The active surface is
 * marked with `aria-current="page"` (on a `link` trigger, and on the matching destination inside a
 * group flyout), never by colour alone.
 *
 * The flyout is `position: fixed`, anchored to the trigger's rect, so it escapes the rail's
 * `overflow: hidden` (the "rail never scrolls" law keeps the rail clipped) rather than being cut off.
 */
import { useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useT } from '../i18n';
import {
  isNavParent,
  NAV_RAIL,
  resolveActiveNav,
  type NavGroup,
  type NavIconName,
  type NavItem,
} from './nav';
import { NavIcon } from './nav-icons';

/** One reachable destination inside a group flyout. */
interface Destination {
  navId: string;
  path: string;
  labelKey: string;
}

/** A top-level icon: a single destination, or a group that discloses its destinations. */
type IconEntry =
  | { kind: 'link'; navId: string; labelKey: string; icon: NavIconName; path: string }
  | { kind: 'group'; navId: string; labelKey: string; icon: NavIconName; destinations: Destination[] };

/** The icon that stands for a group: the glyph of its first row (a leaf's own icon, or a parent's). */
function groupIcon(group: NavGroup): NavIconName {
  const first = group.items[0];
  if (first === undefined) return 'overview';
  return isNavParent(first) ? first.icon : ((first as NavItem).icon ?? 'overview');
}

/** A group's destinations, top to bottom, with nested parents dissolved into their children in place
 *  (a parent is a heading, not a destination, exactly as in the tree). */
function groupDestinations(group: NavGroup): Destination[] {
  const out: Destination[] = [];
  for (const node of group.items) {
    if (isNavParent(node)) {
      for (const child of node.children) out.push({ navId: child.navId, path: child.path, labelKey: child.labelKey });
    } else {
      out.push({ navId: node.navId, path: node.path, labelKey: node.labelKey });
    }
  }
  return out;
}

/** The top-level entries, derived once from the static rail model. A headerless cluster contributes
 *  its leaves as individual `link` icons (they are the always-visible daily surfaces); a headed group
 *  contributes one `group` icon. */
const ICON_ENTRIES: readonly IconEntry[] = NAV_RAIL.flatMap((group): IconEntry[] => {
  if (group.labelKey === null) {
    return group.items.map((node): IconEntry => {
      const leaf = node as NavItem;
      return { kind: 'link', navId: leaf.navId, labelKey: leaf.labelKey, icon: leaf.icon ?? 'overview', path: leaf.path };
    });
  }
  return [
    {
      kind: 'group',
      navId: group.navId,
      labelKey: group.labelKey,
      icon: groupIcon(group),
      destinations: groupDestinations(group),
    },
  ];
});

/** One icon and its flyout. Owns the flyout's viewport position (anchored to the trigger) and the
 *  focus-return on Escape; whether it is the OPEN one is lifted to `IconRail` so only one is open. */
function IconEntryRow({
  entry,
  activeNavId,
  open,
  onOpen,
  onClose,
  onNavigate,
}: {
  entry: IconEntry;
  activeNavId: string | null;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onNavigate: (path: string) => void;
}) {
  const t = useT();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const label = t(entry.labelKey);
  const groupActive = entry.kind === 'group' && entry.destinations.some((d) => d.navId === activeNavId);
  const linkActive = entry.kind === 'link' && entry.navId === activeNavId;

  const openFlyout = (): void => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect !== undefined) setPos({ top: rect.top, left: rect.right + 4 });
    onOpen();
  };

  const closeAndReturn = (): void => {
    onClose();
    triggerRef.current?.focus();
  };

  // Close when focus leaves the whole entry (trigger AND flyout). Moving from the trigger into a
  // flyout destination keeps focus inside the wrapper, so the flyout stays open while it is used.
  const onWrapBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (!wrapRef.current?.contains(event.relatedTarget as Node | null)) onClose();
  };

  const onWrapKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      closeAndReturn();
    }
  };

  return (
    <div
      ref={wrapRef}
      className="rail-icon-entry"
      onMouseEnter={openFlyout}
      onMouseLeave={onClose}
      onFocus={openFlyout}
      onBlur={onWrapBlur}
      onKeyDown={onWrapKeyDown}
    >
      <button
        ref={triggerRef}
        type="button"
        className={linkActive || groupActive ? 'rail-icon-btn rail-icon-btn--active' : 'rail-icon-btn'}
        aria-label={label}
        aria-current={linkActive ? 'page' : undefined}
        aria-haspopup={entry.kind === 'group' ? true : undefined}
        aria-expanded={entry.kind === 'group' ? open : undefined}
        onClick={() => {
          if (entry.kind === 'link') onNavigate(entry.path);
          else if (open) onClose();
          else openFlyout();
        }}
      >
        <NavIcon name={entry.icon} className="rail-icon" />
      </button>
      {open && (
        <div className="rail-flyout" role="group" aria-label={label} style={{ top: pos.top, left: pos.left }}>
          {entry.kind === 'group' ? (
            <>
              <p className="rail-flyout-title" aria-hidden="true">
                {label}
              </p>
              {entry.destinations.map((d) => (
                <button
                  key={d.navId}
                  type="button"
                  className="rail-flyout-link"
                  aria-current={d.navId === activeNavId ? 'page' : undefined}
                  onClick={() => onNavigate(d.path)}
                >
                  {t(d.labelKey)}
                </button>
              ))}
            </>
          ) : (
            <span className="rail-flyout-label">{label}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** The collapsed rail body: the vertical icon strip with its flyouts. Exactly one flyout is open at a
 *  time. Choosing a destination navigates and (on a narrow viewport) dismisses the drawer. */
export function IconRail({ onNavigate }: { onNavigate?: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { leafNavId } = resolveActiveNav(location.pathname);
  const [openId, setOpenId] = useState<string | null>(null);

  const go = (path: string): void => {
    navigate(path);
    onNavigate?.();
    setOpenId(null);
  };

  return (
    <div className="rail-icons">
      {ICON_ENTRIES.map((entry) => (
        <IconEntryRow
          key={entry.navId}
          entry={entry}
          activeNavId={leafNavId}
          open={openId === entry.navId}
          onOpen={() => setOpenId(entry.navId)}
          onClose={() => setOpenId((current) => (current === entry.navId ? null : current))}
          onNavigate={go}
        />
      ))}
    </div>
  );
}
