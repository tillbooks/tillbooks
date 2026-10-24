/**
 * The rail's collapsed ICON strip and its flyouts (D118, modernisation phase 1, A4; D178).
 *
 * When the resizable rail is collapsed to 56px (dragged below the minimum, or via the collapse
 * affordance), the full tree is replaced by this: the person's favourites first (D178, US-G16.15), then
 * one icon per top-level entry of the PERSONAL menu (hidden entries left out), and a flyout that opens
 * on hover OR on keyboard focus to reveal that entry's label and destinations. It is a SEPARATE
 * rendering from `NavTree` (a different mode, not a restyle), reading the same rail model, so the icon
 * strip and the tree can never disagree about what exists, where it sits, or which row is lit.
 *
 * THE KINDS OF ENTRY:
 *   - A favourite, or a single destination of the top block, is a `link` icon. Its button navigates on
 *     click; its flyout is a label, a tooltip for the icon.
 *   - A headed group is a `group` icon. Its button opens a flyout listing the group's destinations
 *     (nested parents dissolved into their children in place). Clicking a destination navigates.
 *
 * THE ACCESSIBILITY CONTRACT. The flyout is a disclosure, never a modal: a positioned `div` with
 * `role="group"` and an accessible name (the entry label). Every trigger is a real `<button>` with its
 * own name. Escape closes the flyout and returns focus to the trigger. ONE element carries
 * `aria-current="page"`, chosen by the same `nav.active_rule` as the expanded rail; a group whose page
 * is open is marked by its pill, never by colour alone.
 *
 * The flyout is `position: fixed`, anchored to the trigger's rect, so it escapes the rail's
 * `overflow: hidden` (the "rail never scrolls" law keeps the rail clipped) rather than being cut off.
 */
import { useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useT } from '../i18n';
import { GROUP_ICON, groupKey, isNavParent, resolveRailActive, type NavGroup, type NavIconName, type NavItem } from './nav';
import { NavIcon } from './nav-icons';
import { useRail } from './nav-prefs';
import { attentionBadgeName, useAttentionBadge, type AttentionBadgeState } from './chrome';
import './IconRail.css';

/** The route whose icon carries the waiting-work count (the tree's `railAttention` badge, collapsed). */
const ATTENTION_PATH = '/attention';

/** One reachable destination inside a group flyout. */
interface Destination {
  navId: string;
  path: string;
  labelKey: string;
}

/** A top-level icon: a single destination, or a group that discloses its destinations. */
type IconEntry =
  | { kind: 'link'; key: string; navId: string; labelKey: string; icon: NavIconName; path: string; label?: string }
  | { kind: 'group'; key: string; navId: string; labelKey: string; icon: NavIconName; destinations: Destination[] };

/** The icon that stands for a group: its own group glyph, else the glyph of its first row. */
function groupIcon(group: NavGroup): NavIconName {
  const own = GROUP_ICON[group.navId];
  if (own !== undefined) return own;
  const first = group.items[0];
  if (first === undefined) return 'overview';
  return isNavParent(first) ? first.icon : ((first as NavItem).icon ?? 'overview');
}

/** A group's destinations, top to bottom, with nested parents dissolved into their children in place. */
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

/** The menu's entries: a top-block leaf is a `link`, a headed group one `group` icon. */
function menuEntries(rail: readonly NavGroup[]): IconEntry[] {
  return rail.flatMap((group): IconEntry[] => {
    if (group.labelKey === null) {
      return group.items.flatMap((node): IconEntry[] => {
        if (isNavParent(node)) {
          return [{ kind: 'group', key: node.navId, navId: node.navId, labelKey: node.labelKey, icon: node.icon, destinations: node.children.map((c) => ({ navId: c.navId, path: c.path, labelKey: c.labelKey })) }];
        }
        return [{ kind: 'link', key: node.navId, navId: node.navId, labelKey: node.labelKey, icon: node.icon ?? 'overview', path: node.path }];
      });
    }
    return [
      // A group's key is its group key: three groups share their navId with a page (nav.ts, THE ROW KEY).
      { kind: 'group', key: groupKey(group.navId), navId: group.navId, labelKey: group.labelKey, icon: groupIcon(group), destinations: groupDestinations(group) },
    ];
  });
}

/** How one entry is lit: `current` carries aria-current, `pill` the active fill, `soft` accent ink. */
interface EntryLight {
  current: boolean;
  pill: boolean;
  soft: boolean;
  /** The destination inside a group flyout that carries aria-current. */
  destination: string | null;
}

/** One icon and its flyout. Owns the flyout's viewport position and the focus-return on Escape. */
function IconEntryRow({
  entry,
  light,
  open,
  onOpen,
  onClose,
  onNavigate,
  badge,
}: {
  entry: IconEntry;
  light: EntryLight;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onNavigate: (path: string) => void;
  badge?: AttentionBadgeState;
}) {
  const t = useT();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const label = entry.kind === 'link' && entry.label !== undefined ? entry.label : t(entry.labelKey);
  // The count is part of the NAME ("Pendenzen, 3 offen"), never a corner number alone.
  const badgeName = badge === undefined ? null : attentionBadgeName(t, badge);
  const name = badgeName === null ? label : `${label}, ${badgeName}`;

  const openFlyout = (): void => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect !== undefined) setPos({ top: rect.top, left: rect.right + 4 });
    onOpen();
  };

  const closeAndReturn = (): void => {
    onClose();
    triggerRef.current?.focus();
  };

  // Close when focus leaves the whole entry (trigger AND flyout).
  const onWrapBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (!wrapRef.current?.contains(event.relatedTarget as Node | null)) onClose();
  };

  const onWrapKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      closeAndReturn();
    }
  };

  const className = ['rail-icon-btn', light.pill ? 'rail-icon-btn--active' : '', light.soft ? 'rail-icon-btn--soft' : '']
    .filter(Boolean)
    .join(' ');

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
        className={className}
        aria-label={name}
        // A group that holds the open page says so with `true` (the current item of the strip), the
        // page itself keeps `page` for its one row: the flyout destination, when the flyout is open.
        aria-current={light.current ? 'page' : light.pill ? 'true' : undefined}
        aria-haspopup={entry.kind === 'group' ? true : undefined}
        aria-expanded={entry.kind === 'group' ? open : undefined}
        onClick={() => {
          if (entry.kind === 'link') onNavigate(entry.path);
          else if (open) onClose();
          else openFlyout();
        }}
      >
        <NavIcon name={entry.icon} className="rail-icon" />
        {badge !== undefined && badge.kind !== 'none' && (
          <span className={badge.kind === 'error' ? 'rail-icon-count rail-icon-count--warn' : 'rail-icon-count'} aria-hidden="true">
            {badge.kind === 'error' ? '!' : badge.shown}
          </span>
        )}
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
                  aria-current={d.navId === light.destination ? 'page' : undefined}
                  onClick={() => onNavigate(d.path)}
                >
                  {t(d.labelKey)}
                </button>
              ))}
            </>
          ) : (
            <span className="rail-flyout-label">{badgeName === null ? label : name}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** The `/attention` icon: the same live count the tree's row shows, read from the shared store. */
function AttentionIconEntryRow(props: Omit<Parameters<typeof IconEntryRow>[0], 'badge'>) {
  const badge = useAttentionBadge();
  return <IconEntryRow {...props} badge={badge} />;
}

/** The collapsed rail body: the favourites, then the menu's icons, with their flyouts. Exactly one
 *  flyout is open at a time. Choosing a destination navigates and dismisses the drawer. */
export function IconRail({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const location = useLocation();
  const navigate = useNavigate();
  const { rail, resolvedFavourites, look } = useRail();
  const [openId, setOpenId] = useState<string | null>(null);

  const favouriteEntries = useMemo<IconEntry[]>(
    () =>
      resolvedFavourites.map((f) => ({
        kind: 'link',
        key: `fav:${f.navId}`,
        navId: f.navId,
        labelKey: f.surface.labelKey,
        icon: f.surface.icon ?? 'overview',
        path: f.surface.path,
        label: f.alias,
      })),
    [resolvedFavourites],
  );
  const entries = useMemo(() => menuEntries(rail), [rail]);
  // The icon strip shows every favourite (it has no folding sections), so its one active answer is
  // computed here with the same rule as the expanded rail.
  const active = useMemo(
    () =>
      resolveRailActive({
        pathname: location.pathname,
        favourites: resolvedFavourites.map((f) => ({ navId: f.navId, path: f.surface.path })),
        rail,
        rule: look.activeRule,
      }),
    [location.pathname, resolvedFavourites, rail, look.activeRule],
  );

  const lightFor = (entry: IconEntry, favourite: boolean): EntryLight => {
    if (favourite) {
      const lit = entry.navId === active.favouriteNavId;
      return { current: lit, pill: lit, soft: false, destination: null };
    }
    if (entry.kind === 'link') {
      const lit = entry.navId === active.treeNavId;
      return { current: lit, pill: lit, soft: entry.navId === active.treeSoftNavId, destination: null };
    }
    const holds = (id: string | null): boolean => id !== null && entry.destinations.some((d) => d.navId === id);
    return { current: false, pill: holds(active.treeNavId), soft: holds(active.treeSoftNavId), destination: active.treeNavId };
  };

  const go = (path: string): void => {
    navigate(path);
    onNavigate?.();
    setOpenId(null);
  };

  const render = (entry: IconEntry, favourite: boolean) => {
    const props = {
      entry,
      light: lightFor(entry, favourite),
      open: openId === entry.key,
      onOpen: () => setOpenId(entry.key),
      onClose: () => setOpenId((current) => (current === entry.key ? null : current)),
      onNavigate: go,
    };
    return entry.kind === 'link' && entry.path === ATTENTION_PATH ? (
      <AttentionIconEntryRow key={entry.key} {...props} />
    ) : (
      <IconEntryRow key={entry.key} {...props} />
    );
  };

  return (
    <div className="rail-icons">
      {favouriteEntries.length > 0 && (
        <>
          <div className="rail-icons-group" role="group" aria-label={t('nav.favourites.label')}>
            {favouriteEntries.map((entry) => render(entry, true))}
          </div>
          <div className="rail-icons-sep" aria-hidden="true" />
        </>
      )}
      {entries.map((entry) => render(entry, false))}
    </div>
  );
}
