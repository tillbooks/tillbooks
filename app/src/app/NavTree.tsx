/**
 * The rail's Menü section: its header and the tree under it (D118 A1, D178 points 6, 16 and 17).
 *
 * WHAT THIS REPLACES. The rail used to be a flat run of grouped `NavLink`s: 71 destinations, every
 * one always rendered, and the middle band scrolled heavily. That violated the DESIGN.md law that
 * the rail never scrolls. This turns the same model into a WAI-ARIA treeview: headed groups and
 * nested parents collapse, everything collapsible defaults to collapsed, and a fresh workspace shows
 * roughly fifteen rows that fit without a scrollbar.
 *
 * WHAT IT RENDERS SINCE D178. The PERSONAL tree (`useRail().rail`): the canonical taxonomy of `nav.ts`
 * in the person's own order, hidden rows left out. Which leaf lights is not decided here: the rail's one
 * model (`resolveRailActive`) names the ONE element that carries `aria-current`, so a pinned page no
 * longer lights its favourite AND its menu row. The headers follow `nav.group_header_style`: by default
 * 14px/600 at the icon column with the group's rows flush below, or 14px/500 with a group icon and the
 * rows nested at the text column, or the K-23 12px label.
 *
 * THE ACCESSIBILITY CONTRACT (the a11y-critical core; verified with jest-axe in both themes):
 *   - `role="tree"` on the container, one accessible name.
 *   - `role="treeitem"` on every node: group headers and parents (with `aria-expanded`), and leaves
 *     (with `aria-current="page"` and `aria-selected` on the lit one).
 *   - `role="group"` on each expanded child list, linked to its owning treeitem via `aria-owns`, so
 *     the parent/child relationship survives even though the group is a DOM sibling of its header
 *     (a sibling, not a child, so a click on a child never bubbles into the header's toggle, and the
 *     header's accessible name never absorbs its descendants).
 *   - ROVING TABINDEX: exactly one treeitem is in the tab order (`tabindex=0`, the lit leaf or the
 *     first row); the rest are `tabindex=-1` and reached with the arrow keys. One Tab stop, per APG.
 *   - KEYBOARD: Up/Down move between visible rows; Right expands a collapsed node or steps into the
 *     first child; Left collapses an expanded node or steps out to the parent; Home/End jump to the
 *     first/last visible row; Enter and Space activate a leaf or toggle a node.
 *   - MOTION: the chevron rotation and the reveal are CSS only, inside the 120-200ms budget, and the
 *     `prefers-reduced-motion` kill switch removes them (see global.css).
 *
 * A leaf is a REAL LINK (F-05, friction ledger Phase 2): an `<a href>` that carries the `treeitem`
 * role, the roving tabindex and `aria-current`, so middle-click, Cmd/Ctrl-click, "copy link" and
 * "open in new tab" all work the way a browser link does. The A3 pin star rides inside the anchor as an
 * ARIA button on a span (a real button may neither be an anchor's child nor a direct child of the tree).
 */
import { Fragment, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { useT } from '../i18n';
import { IconButton } from '../components/IconButton';
import { TooltipPortalContext } from '../components/Tooltip';
import {
  firstLeafPath,
  GROUP_ICON,
  groupKey,
  isNavParent,
  type NavGroup,
  type NavIconName,
  type NavItem,
  type NavParent,
} from './nav';
import { NavIcon } from './nav-icons';
import { useRail, useRailOptional } from './nav-prefs';
import { AgentBadge, AttentionBadge, SlotBoundary } from './chrome';
import { useKeyboardOptional } from './keyboard';
import { MenuCustomiser } from './MenuCustomiser';

/** One row in the flattened list of VISIBLE nodes, the model the keyboard math walks. `key` is unique
 *  (a headed group is `group:<navId>`, because three groups share their navId with a page inside them);
 *  `navId` is what the expand state and the routes are keyed by. */
interface VisibleRow {
  key: string;
  navId: string;
  level: number;
  expandable: boolean;
  expanded: boolean;
  path: string | null;
}

/**
 * A section header of the rail, "Favoriten" or "Menü" (D178): a disclosure button that folds the
 * section. It reads one step quieter than a group header (judge round 1 M1, the owner's picker): the
 * chevron in the icon column, the label at the text column in the 12px label type (dim under the 14px
 * group styles, full ink under the 12px group label), so "Favoriten" and "Menü" never pass for groups.
 * `location` marks the folded header that holds the open page (`aria-current="location"`, accent ink).
 * `trailing` is an optional control beside it (the Menü's "Menü anpassen"); it is a sibling of the
 * button, never inside it, so the header never nests one control in another.
 */
export function RailSectionHeader({
  label,
  folded,
  onToggle,
  controlsId,
  location = false,
  trailing,
}: {
  label: string;
  folded: boolean;
  onToggle: () => void;
  controlsId: string;
  location?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <div className="rail-section-head" data-trailing={trailing === undefined ? undefined : ''}>
      <button
        type="button"
        className="rail-section-toggle"
        aria-expanded={!folded}
        aria-controls={folded ? undefined : controlsId}
        aria-current={location ? 'location' : undefined}
        onClick={onToggle}
      >
        <span className="rail-section-chevron" aria-hidden="true">
          <NavIcon name="chevron" size={16} className="rail-chevron" />
        </span>
        <span className="rail-section-label">{label}</span>
      </button>
      {trailing}
    </div>
  );
}

/** "Menü anpassen": the pencil that opens the editor. Shown always in the drawer and on touch, on
 *  hover and keyboard focus at the desktop rail (judge round 1 M5). */
function CustomiseButton({ className }: { className: string }) {
  const t = useT();
  const { setCustomising } = useRail();
  return (
    <TooltipPortalContext.Provider value={true}>
      <IconButton icon="edit" context={t('nav.customise.open')} small className={className} onClick={() => setCustomising(true)} />
    </TooltipPortalContext.Provider>
  );
}

/**
 * The way into "Menü anpassen" when the Menü has no header (no favourites yet, judge round 1 M3): the
 * same pencil, in the rail's footer row, always visible. Renders nothing while the header carries it.
 */
export function MenuCustomiseEntry() {
  const rail = useRailOptional();
  if (rail === null || rail.menuHeader || rail.customising) return null;
  return <CustomiseButton className="rail-icon-btn rail-customise-entry" />;
}

/**
 * The Menü section: its header (with "Menü anpassen") while there are favourites above it, and, unless
 * folded, the tree, or the editor while "Menü anpassen" is open. Without favourites the menu stands
 * alone and needs no title: the header (and its row of height) is left out.
 */
export function MenuSection({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const { sections, toggleSection, customising, menuHeader, location } = useRail();
  const bodyId = useId();
  const folded = sections.menu && !customising;
  return (
    <div className="rail-section rail-section--menu">
      {menuHeader && (
        <RailSectionHeader
          label={t('nav.sections.menu')}
          folded={folded}
          onToggle={() => {
            if (customising) return;
            toggleSection('menu');
          }}
          controlsId={bodyId}
          location={location === 'menu'}
          trailing={customising ? undefined : <CustomiseButton className="rail-section-action" />}
        />
      )}
      {!folded && (
        <div id={bodyId}>{customising ? <MenuCustomiser /> : <NavTree onNavigate={onNavigate} />}</div>
      )}
    </div>
  );
}

export function NavTree({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const treeRef = useRef<HTMLDivElement | null>(null);
  const { rail, active, expansion, favourites, look } = useRail();
  const { isExpanded, toggle } = expansion;
  const { isFavourite, toggleFavourite } = favourites;
  // "Suche" opens the command palette OVER the current surface instead of routing to the full-screen
  // /search page (owner request). Read optionally: the unit tests mount the tree without the shell.
  const keyboard = useKeyboardOptional();
  const headerStyle = look.groupHeaderStyle;

  // The accordion set (D135): the top-level headed groups of the personal tree.
  const topLevelGroupIds = useMemo(() => rail.filter((g) => g.labelKey !== null).map((g) => g.navId), [rail]);
  const accordionSetFor = (navId: string): readonly string[] | undefined =>
    topLevelGroupIds.includes(navId) ? topLevelGroupIds : undefined;

  // Where a header row navigates on click (D135): its first VISIBLE leaf in the personal tree.
  const firstChildPaths = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of rail) {
      if (group.labelKey !== null) {
        const groupPath = firstLeafPath(group);
        if (groupPath !== null) map.set(group.navId, groupPath);
      }
      for (const node of group.items) {
        if (isNavParent(node)) {
          const parentPath = firstLeafPath(node);
          if (parentPath !== null) map.set(node.navId, parentPath);
        }
      }
    }
    return map;
  }, [rail]);

  // The visible rows, top to bottom, respecting the current expand state.
  const visible = useMemo<VisibleRow[]>(() => {
    const rows: VisibleRow[] = [];
    const pushParent = (node: NavParent, level: number): void => {
      const open = isExpanded(node.navId);
      rows.push({ key: node.navId, navId: node.navId, level, expandable: true, expanded: open, path: null });
      if (!open) return;
      for (const child of node.children) {
        rows.push({ key: child.navId, navId: child.navId, level: level + 1, expandable: false, expanded: false, path: child.path });
      }
    };
    for (const group of rail) {
      if (group.labelKey === null) {
        for (const node of group.items) {
          if (isNavParent(node)) pushParent(node, 1);
          else rows.push({ key: node.navId, navId: node.navId, level: 1, expandable: false, expanded: false, path: node.path });
        }
        continue;
      }
      const groupExpanded = isExpanded(group.navId);
      rows.push({ key: groupKey(group.navId), navId: group.navId, level: 1, expandable: true, expanded: groupExpanded, path: null });
      if (!groupExpanded) continue;
      for (const node of group.items) {
        if (isNavParent(node)) pushParent(node, 2);
        else rows.push({ key: node.navId, navId: node.navId, level: 2, expandable: false, expanded: false, path: node.path });
      }
    }
    return rows;
  }, [rail, isExpanded]);

  // EXACTLY ONE aria-current (judge round 1 M4): when the lit leaf sits inside a group or parent the
  // person closed, the collapsed row on screen that holds it carries aria-current="location" and the
  // accent ink, so the open page always has one mark in the rail.
  const locationKey = useMemo<string | null>(() => {
    if (active.treeNavId === null || visible.some((r) => r.key === active.treeNavId)) return null;
    return visible.find((r) => r.expandable && !r.expanded && active.expand.has(r.navId))?.key ?? null;
  }, [active, visible]);

  // The roving tab stop: the user's last focus, else the lit leaf (or the row standing in for it), else
  // the first row; always a row on screen, so collapsing a subtree can never leave the single Tab stop
  // pointing at a hidden node.
  const [focusedNavId, setFocusedNavId] = useState<string | null>(null);
  const effectiveFocus = useMemo<string | null>(() => {
    const onScreen = (key: string | null): boolean => key !== null && visible.some((r) => r.key === key);
    if (onScreen(focusedNavId)) return focusedNavId;
    if (onScreen(active.treeNavId)) return active.treeNavId;
    if (onScreen(locationKey)) return locationKey;
    return visible[0]?.key ?? null;
  }, [focusedNavId, active.treeNavId, locationKey, visible]);

  const tabIndexFor = (key: string): 0 | -1 => (key === effectiveFocus ? 0 : -1);

  const focusRow = (key: string): void => {
    const el = treeRef.current?.querySelector<HTMLElement>(`[data-tree-key="${key}"]`);
    if (el !== null && el !== undefined) {
      el.focus();
      setFocusedNavId(key);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-tree-key]');
    if (target === null) return;
    // Only the treeitem row itself drives tree keys: a key on the pin star is the star's business.
    if (event.target !== target) return;
    const key = target.dataset.treeKey;
    if (key === undefined) return;
    const index = visible.findIndex((r) => r.key === key);
    if (index === -1) return;
    const row = visible[index];

    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        const next = visible[index + 1];
        if (next !== undefined) focusRow(next.key);
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        const prev = visible[index - 1];
        if (prev !== undefined) focusRow(prev.key);
        break;
      }
      case 'Home': {
        event.preventDefault();
        if (visible[0] !== undefined) focusRow(visible[0].key);
        break;
      }
      case 'End': {
        event.preventDefault();
        if (visible.length > 0) focusRow(visible[visible.length - 1].key);
        break;
      }
      case 'ArrowRight': {
        event.preventDefault();
        if (row.expandable && !row.expanded) {
          toggle(row.navId, accordionSetFor(row.navId));
        } else if (row.expandable && row.expanded) {
          const child = visible[index + 1];
          if (child !== undefined && child.level > row.level) focusRow(child.key);
        }
        break;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        if (row.expandable && row.expanded) {
          toggle(row.navId);
        } else {
          for (let i = index - 1; i >= 0; i -= 1) {
            if (visible[i].level < row.level) {
              focusRow(visible[i].key);
              break;
            }
          }
        }
        break;
      }
      case 'Enter': {
        event.preventDefault();
        if (row.expandable) {
          // D135: Enter on a parent navigates to its first child and expands, like a pointer click.
          const destination = firstChildPaths.get(row.navId);
          if (destination !== undefined) {
            navigate(destination);
            onNavigate?.();
          }
          if (!row.expanded) toggle(row.navId, accordionSetFor(row.navId));
        } else if (row.path !== null) {
          navigate(row.path);
          onNavigate?.();
        }
        break;
      }
      case ' ':
      case 'Spacebar': {
        event.preventDefault();
        if (row.expandable) {
          toggle(row.navId, accordionSetFor(row.navId));
        } else if (row.path !== null) {
          navigate(row.path);
          onNavigate?.();
        }
        break;
      }
      default:
        break;
    }
  };

  /** A destination row: the `treeitem` itself, a REAL `<a href>` (F-05), holding the pin star as an
   *  ARIA button on a span. It carries `aria-current` only when the rail's one model names it; under
   *  `both_soft` the menu copy of a pinned page is drawn in accent ink without the fill and without
   *  `aria-current` (`data-soft-current`). The pin star shows on hover and focus only, filled when the
   *  page is pinned, so a pinned page draws no second accent in the menu. */
  const renderLeaf = (item: NavItem, level: number, nested: boolean): ReactNode => {
    const lit = item.navId === active.treeNavId;
    const soft = item.navId === active.treeSoftNavId;
    const pinned = isFavourite(item.navId);
    const label = t(item.labelKey);
    const labelId = `nav-leaf-${item.navId}`;
    return (
      <a
        key={item.navId}
        role="treeitem"
        href={item.path}
        aria-level={level}
        aria-current={lit ? 'page' : undefined}
        aria-selected={lit}
        aria-labelledby={labelId}
        tabIndex={tabIndexFor(item.navId)}
        data-tree-navid={item.navId}
        data-tree-key={item.navId}
        data-soft-current={soft ? '' : undefined}
        className={nested ? 'rail-leaf rail-link rail-link--nested' : 'rail-leaf rail-link'}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
          event.preventDefault();
          if (item.path === '/search' && keyboard !== null) {
            keyboard.openPalette();
            onNavigate?.();
            return;
          }
          navigate(item.path);
          onNavigate?.();
        }}
        onFocus={(event) => {
          if (event.target === event.currentTarget) setFocusedNavId(item.navId);
        }}
      >
        {item.icon !== undefined && <NavIcon name={item.icon} className="rail-icon" />}
        <span id={labelId} className="rail-label">
          {label}
        </span>
        {item.path === '/agent' && (
          <SlotBoundary slot="agent-badge">
            <AgentBadge />
          </SlotBoundary>
        )}
        {item.path === '/attention' && (
          <SlotBoundary slot="attention-badge">
            <AttentionBadge />
          </SlotBoundary>
        )}
        <span
          role="button"
          className={pinned ? 'rail-pin rail-pin--on' : 'rail-pin'}
          aria-pressed={pinned}
          aria-label={t(pinned ? 'nav.favourites.unpin' : 'nav.favourites.pin', { name: label })}
          tabIndex={item.navId === effectiveFocus ? 0 : -1}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            toggleFavourite(item.navId);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
              event.preventDefault();
              event.stopPropagation();
              toggleFavourite(item.navId);
            }
          }}
        >
          <NavIcon name={pinned ? 'starFilled' : 'star'} size={16} className="rail-pin-glyph" />
        </span>
      </a>
    );
  };

  /** An expandable node (a headed group or a nested parent). A click on the ROW navigates to its first
   *  visible leaf AND expands it (D135); the chevron keeps the pure toggle. A group header is set in the
   *  person's header style; a parent keeps the leaf's type, with its icon. */
  const renderExpandable = (
    node: { navId: string; labelKey: string; icon?: NavIconName },
    level: number,
    variant: 'group' | 'parent',
    children: ReactNode,
  ): ReactNode => {
    const rowKey = variant === 'group' ? groupKey(node.navId) : node.navId;
    const expanded = isExpanded(node.navId);
    const labelId = `nav-label-${node.navId}`;
    const groupId = `nav-group-${node.navId}`;
    const destination = firstChildPaths.get(node.navId) ?? null;
    const accordionSet = accordionSetFor(node.navId);
    const icon = variant === 'group' ? (headerStyle === 'icon_14' ? GROUP_ICON[node.navId] : undefined) : node.icon;
    return (
      <Fragment key={node.navId}>
        <div
          role="treeitem"
          aria-level={level}
          aria-expanded={expanded}
          aria-current={rowKey === locationKey ? 'location' : undefined}
          aria-labelledby={labelId}
          aria-owns={expanded ? groupId : undefined}
          tabIndex={tabIndexFor(rowKey)}
          data-tree-navid={node.navId}
          data-tree-key={rowKey}
          className={
            variant === 'group' ? 'rail-treeitem rail-group-row rail-header-row' : 'rail-treeitem rail-parent-row'
          }
          onClick={() => {
            if (destination !== null) {
              navigate(destination);
              onNavigate?.();
            }
            if (!expanded) toggle(node.navId, accordionSet);
            setFocusedNavId(rowKey);
          }}
          onFocus={() => setFocusedNavId(rowKey)}
        >
          {icon !== undefined && <NavIcon name={icon} className="rail-icon" />}
          <span id={labelId} className={variant === 'group' ? 'rail-header-label rail-group-label' : 'rail-label'}>
            {t(node.labelKey)}
          </span>
          <NavIcon
            name="chevron"
            size={16}
            className="rail-chevron"
            onClick={(event: MouseEvent<SVGSVGElement>) => {
              event.stopPropagation();
              event.preventDefault();
              toggle(node.navId, accordionSet);
              setFocusedNavId(rowKey);
            }}
          />
        </div>
        {expanded && (
          <div
            role="group"
            id={groupId}
            aria-labelledby={labelId}
            className={variant === 'group' ? 'rail-tree-group rail-tree-group--group' : 'rail-tree-group rail-tree-group--parent'}
          >
            {children}
          </div>
        )}
      </Fragment>
    );
  };

  const renderParent = (node: NavParent, level: number): ReactNode =>
    renderExpandable(
      { navId: node.navId, labelKey: node.labelKey, icon: node.icon },
      level,
      'parent',
      node.children.map((child) => renderLeaf(child, level + 1, true)),
    );

  const renderGroup = (group: NavGroup): ReactNode => {
    if (group.labelKey === null) {
      return group.items.map((node) => (isNavParent(node) ? renderParent(node, 1) : renderLeaf(node, 1, false)));
    }
    return renderExpandable(
      { navId: group.navId, labelKey: group.labelKey },
      1,
      'group',
      group.items.map((node) => (isNavParent(node) ? renderParent(node, 2) : renderLeaf(node, 2, false))),
    );
  };

  return (
    <div ref={treeRef} role="tree" aria-label={t('nav.label')} className="rail-tree" onKeyDown={onKeyDown}>
      {rail.map((group) => (
        <Fragment key={group.navId}>{renderGroup(group)}</Fragment>
      ))}
    </div>
  );
}
