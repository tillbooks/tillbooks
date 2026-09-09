/**
 * The rail as a real, keyboard-navigable TREE (D118, modernisation phase 1, A1).
 *
 * WHAT THIS REPLACES. The rail used to be a flat run of grouped `NavLink`s: 71 destinations, every
 * one always rendered, and the middle band scrolled heavily. That violated the DESIGN.md law that
 * the rail never scrolls. This turns the same model into a WAI-ARIA treeview: headed groups and
 * nested parents collapse, everything collapsible defaults to collapsed, and a fresh workspace shows
 * roughly fifteen rows that fit without a scrollbar. The taxonomy (which surface sits where) is
 * authored in `nav.ts`; this file only renders and drives it.
 *
 * THE ACCESSIBILITY CONTRACT (the a11y-critical core; verified with jest-axe in both themes):
 *   - `role="tree"` on the container, one accessible name.
 *   - `role="treeitem"` on every node: group headers and parents (with `aria-expanded`), and leaves
 *     (with `aria-current="page"` and `aria-selected` on the active one).
 *   - `role="group"` on each expanded child list, linked to its owning treeitem via `aria-owns`, so
 *     the parent/child relationship survives even though the group is a DOM sibling of its header
 *     (a sibling, not a child, so a click on a child never bubbles into the header's toggle, and the
 *     header's accessible name never absorbs its descendants).
 *   - ROVING TABINDEX: exactly one treeitem is in the tab order (`tabindex=0`, the active leaf or the
 *     first row); the rest are `tabindex=-1` and reached with the arrow keys. One Tab stop, per APG.
 *   - KEYBOARD: Up/Down move between visible rows; Right expands a collapsed node or steps into the
 *     first child; Left collapses an expanded node or steps out to the parent; Home/End jump to the
 *     first/last visible row; Enter and Space activate a leaf or toggle a node.
 *   - MOTION: the chevron rotation and the reveal are CSS only, inside the 120-200ms budget, and the
 *     `prefers-reduced-motion` kill switch removes them (see global.css).
 *
 * A leaf is a REAL LINK (F-05, friction ledger Phase 2): an `<a href>` that carries the `treeitem`
 * role, the roving tabindex and `aria-current`, so middle-click, Cmd/Ctrl-click, "copy link" and
 * "open in new tab" all work the way a browser link does, with no `window.open` imitation. The A3 pin
 * star rides inside the anchor as an ARIA button on a span (a real button may neither be an anchor's
 * child nor a direct child of the tree), so the tree still owns only treeitems and groups. A plain
 * click routes in place; a modifier or middle click is left to the browser.
 * Routing is never read here: `resolveActiveNav` maps the URL to the owning leaf and its collapsible
 * ancestors, the whole coupling.
 */
import { Fragment, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useT } from '../i18n';
import {
  isNavParent,
  NAV_RAIL,
  resolveActiveNav,
  type NavGroup,
  type NavItem,
  type NavParent,
} from './nav';
import { NavIcon } from './nav-icons';
import { useNavExpansion, useNavFavourites } from './nav-prefs';
import { AgentBadge, AttentionBadge, SlotBoundary } from './chrome';

/** The disclosure chevron. Points right when collapsed, rotates to point down when expanded (the
 *  rotation is a CSS transition on the parent's `aria-expanded`, honouring reduced motion). */
function Chevron() {
  return (
    <svg
      className="rail-chevron"
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
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/** The favourite star: a filled star when pinned, an outline when not. Sits at a leaf's right edge as
 *  a pointer-and-keyboard affordance to pin/unpin the surface to the Favoriten lane above the tree. */
function StarGlyph({ filled }: { filled: boolean }) {
  return (
    <svg
      className="rail-pin-glyph"
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.2 9.7l5.9-.9z" />
    </svg>
  );
}

/** One row in the flattened list of VISIBLE nodes, the model the keyboard math walks. A row exists
 *  only if all its ancestors are expanded, so Up/Down and Home/End move exactly over what is on
 *  screen. `path` is present on leaves only; `expandable` marks a group or parent. */
interface VisibleRow {
  navId: string;
  level: number;
  expandable: boolean;
  expanded: boolean;
  path: string | null;
}

export function NavTree({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const location = useLocation();
  const navigate = useNavigate();
  const treeRef = useRef<HTMLDivElement | null>(null);

  const { leafNavId: activeLeafId, ancestors } = useMemo(
    () => resolveActiveNav(location.pathname),
    [location.pathname],
  );
  const { isExpanded, toggle } = useNavExpansion(ancestors);
  const { isFavourite, toggleFavourite } = useNavFavourites();

  // The visible rows, top to bottom, respecting the current expand state. Rebuilt whenever expansion
  // changes (isExpanded closes over the overrides and the active ancestors).
  const visible = useMemo<VisibleRow[]>(() => {
    const rows: VisibleRow[] = [];
    for (const group of NAV_RAIL) {
      if (group.labelKey === null) {
        // A headerless cluster: its leaves are always-visible level-1 rows, never collapsible.
        for (const node of group.items) {
          rows.push({ navId: node.navId, level: 1, expandable: false, expanded: false, path: (node as NavItem).path });
        }
        continue;
      }
      const groupExpanded = isExpanded(group.navId);
      rows.push({ navId: group.navId, level: 1, expandable: true, expanded: groupExpanded, path: null });
      if (!groupExpanded) continue;
      for (const node of group.items) {
        if (isNavParent(node)) {
          const parentExpanded = isExpanded(node.navId);
          rows.push({ navId: node.navId, level: 2, expandable: true, expanded: parentExpanded, path: null });
          if (!parentExpanded) continue;
          for (const child of node.children) {
            rows.push({ navId: child.navId, level: 3, expandable: false, expanded: false, path: child.path });
          }
        } else {
          rows.push({ navId: node.navId, level: 2, expandable: false, expanded: false, path: node.path });
        }
      }
    }
    return rows;
  }, [isExpanded]);

  // The roving tab stop. The user's last focus wins; otherwise the active leaf, otherwise the first
  // row. Always normalised to a row that is actually visible, so collapsing a subtree can never leave
  // the single Tab stop pointing at a node that is no longer on screen.
  const [focusedNavId, setFocusedNavId] = useState<string | null>(null);
  const effectiveFocus = useMemo<string | null>(() => {
    const onScreen = (id: string | null): boolean => id !== null && visible.some((r) => r.navId === id);
    if (onScreen(focusedNavId)) return focusedNavId;
    if (onScreen(activeLeafId)) return activeLeafId;
    return visible[0]?.navId ?? null;
  }, [focusedNavId, activeLeafId, visible]);

  const tabIndexFor = (navId: string): 0 | -1 => (navId === effectiveFocus ? 0 : -1);

  const focusRow = (navId: string): void => {
    const el = treeRef.current?.querySelector<HTMLElement>(`[data-tree-navid="${navId}"]`);
    if (el !== null && el !== undefined) {
      el.focus();
      setFocusedNavId(navId);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-tree-navid]');
    if (target === null) return;
    // Only the treeitem row itself drives tree keys. A key pressed while a descendant control (the
    // pin star) holds focus is that control's business, never a navigation or a toggle.
    if (event.target !== target) return;
    const navId = target.dataset.treeNavid;
    if (navId === undefined) return;
    const index = visible.findIndex((r) => r.navId === navId);
    if (index === -1) return;
    const row = visible[index];

    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        const next = visible[index + 1];
        if (next !== undefined) focusRow(next.navId);
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        const prev = visible[index - 1];
        if (prev !== undefined) focusRow(prev.navId);
        break;
      }
      case 'Home': {
        event.preventDefault();
        if (visible[0] !== undefined) focusRow(visible[0].navId);
        break;
      }
      case 'End': {
        event.preventDefault();
        if (visible.length > 0) focusRow(visible[visible.length - 1].navId);
        break;
      }
      case 'ArrowRight': {
        event.preventDefault();
        if (row.expandable && !row.expanded) {
          toggle(row.navId); // expand in place; focus stays on the node just opened
        } else if (row.expandable && row.expanded) {
          const child = visible[index + 1];
          if (child !== undefined && child.level > row.level) focusRow(child.navId);
        }
        break;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        if (row.expandable && row.expanded) {
          toggle(row.navId); // collapse in place; focus stays on the node just closed
        } else {
          // Step out to the nearest shallower row, which is this row's parent.
          for (let i = index - 1; i >= 0; i -= 1) {
            if (visible[i].level < row.level) {
              focusRow(visible[i].navId);
              break;
            }
          }
        }
        break;
      }
      case 'Enter':
      case ' ':
      case 'Spacebar': {
        event.preventDefault();
        if (row.expandable) {
          toggle(row.navId);
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

  /** A destination row: the `treeitem` itself, which is a REAL `<a href>`
   *  (F-05), holding the pin star as an ARIA button on a span. A real `<button>` may not sit inside
   *  an anchor (invalid HTML), and a button beside the anchor is a tree child the treeview contract
   *  forbids (axe: "children which are not allowed"), so the star is a focusable span with the button
   *  role, exactly as reachable by Tab and Enter/Space as the button it replaces.
   *  A plain click and the keyboard route in place through the router; a modifier-click
   *  (Cmd/Ctrl/Shift/Alt) or a middle click is left to the browser, which opens the href in a new
   *  tab, and "copy link" reads the href. The active leaf carries `aria-current="page"` and
   *  `aria-selected`, never colour alone. Its accessible name comes from `aria-labelledby`, so the
   *  badge and the pin button's own label never pollute it.
   *
   *  The pin star toggles the surface in the Favoriten lane. Its tab stop FOLLOWS the roving focus (it
   *  is tabbable only while its own row is the focused treeitem), so a keyboard user arrows to a row
   *  and Tabs to its star, without adding a second permanent tab stop to the widget. */
  const renderLeaf = (item: NavItem, level: number): ReactNode => {
    const active = item.navId === activeLeafId;
    const pinned = isFavourite(item.navId);
    const label = t(item.labelKey);
    const labelId = `nav-leaf-${item.navId}`;
    return (
      <a
        key={item.navId}
        role="treeitem"
        href={item.path}
        aria-level={level}
        aria-current={active ? 'page' : undefined}
        aria-selected={active}
        aria-labelledby={labelId}
        tabIndex={tabIndexFor(item.navId)}
        data-tree-navid={item.navId}
        className={level >= 3 ? 'rail-leaf rail-link rail-link--nested' : 'rail-leaf rail-link'}
        onClick={(event) => {
          // A modifier or non-primary click is the browser's (new tab, new window); a plain click
          // routes in place without the full page load a bare anchor would cause.
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
          event.preventDefault();
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
        {/* The pin star: an ARIA button on a span (a real <button> may not sit inside an anchor). Its
            click stops at the star (never the anchor's navigation), and Enter/Space toggle the pin
            with the anchor's own activation suppressed. */}
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
          <StarGlyph filled={pinned} />
        </span>
      </a>
    );
  };

  /** An expandable node (a headed group or a nested parent): a heading, never a link, so the count of
   *  links stays equal to the count of destinations. It toggles on click; its child `role="group"` is
   *  a DOM sibling linked back by `aria-owns`. `variant` only styles the label (uppercase group
   *  header vs. body-weight parent); the ARIA is identical. */
  const renderExpandable = (
    node: { navId: string; labelKey: string; icon?: NavItem['icon'] },
    level: number,
    variant: 'group' | 'parent',
    children: ReactNode,
  ): ReactNode => {
    const expanded = isExpanded(node.navId);
    const labelId = `nav-label-${node.navId}`;
    const groupId = `nav-group-${node.navId}`;
    return (
      <Fragment key={node.navId}>
        <div
          role="treeitem"
          aria-level={level}
          aria-expanded={expanded}
          aria-labelledby={labelId}
          aria-owns={expanded ? groupId : undefined}
          tabIndex={tabIndexFor(node.navId)}
          data-tree-navid={node.navId}
          className={variant === 'group' ? 'rail-treeitem rail-group-row' : 'rail-treeitem rail-parent-row'}
          onClick={() => {
            toggle(node.navId);
            setFocusedNavId(node.navId);
          }}
          onFocus={() => setFocusedNavId(node.navId)}
        >
          {node.icon !== undefined && <NavIcon name={node.icon} className="rail-icon" />}
          <span id={labelId} className={variant === 'group' ? 'rail-group-label' : 'rail-label'}>
            {t(node.labelKey)}
          </span>
          <Chevron />
        </div>
        {expanded && (
          <div role="group" id={groupId} aria-labelledby={labelId} className="rail-tree-group">
            {children}
          </div>
        )}
      </Fragment>
    );
  };

  const renderGroup = (group: NavGroup): ReactNode => {
    if (group.labelKey === null) {
      // A headerless cluster contributes its leaves straight into the tree at level 1.
      return group.items.map((node) => renderLeaf(node as NavItem, 1));
    }
    return renderExpandable(
      { navId: group.navId, labelKey: group.labelKey },
      1,
      'group',
      group.items.map((node) =>
        isNavParent(node)
          ? renderExpandable(
              { navId: node.navId, labelKey: node.labelKey, icon: (node as NavParent).icon },
              2,
              'parent',
              (node as NavParent).children.map((child) => renderLeaf(child, 3)),
            )
          : renderLeaf(node as NavItem, 2),
      ),
    );
  };

  return (
    <div
      ref={treeRef}
      role="tree"
      aria-label={t('nav.label')}
      className="rail-tree"
      onKeyDown={onKeyDown}
    >
      {NAV_RAIL.map((group) => (
        <Fragment key={group.navId}>{renderGroup(group)}</Fragment>
      ))}
    </div>
  );
}
