/**
 * The nav MODEL, asserted independently of any rendering of it.
 *
 * WHY THIS EXISTS SEPARATELY FROM `Shell.test.tsx`. The shell suite renders the rail and reads the
 * accessibility tree, which is the right way to test the rail and the wrong way to test the model: a
 * rendered rail proves what one component did with the data, not what the data is.
 *
 * WHAT CHANGED (D118, modernisation phase 1). The model was split into a surface CATALOG (the single
 * source of truth for which surfaces exist), a nav TREE (the rail projection, referencing surfaces by
 * navId) and a ROUTE REGISTRY (the route projection). Before the split, one structure drove both the
 * rail and the routes, so they could not drift, but neither could a user reorder the rail without
 * corrupting routing. Now that the tree and the registry are AUTHORED SEPARATELY, drift is possible,
 * and THIS SUITE is the guard against it: a route with no tree row, or a tree row with no route, is a
 * loud failure here rather than a silent 404 or an orphaned screen. That sync test is the direct
 * replacement for the old coupling.
 *
 * The model's own properties still hold and are still asserted:
 *   - a parent has no `path`, so it can never become a route to nowhere;
 *   - every path is unique, because two nodes on one path is a route table with a silent winner;
 *   - the glyph column holds: present at the top level, absent underneath a parent.
 */
import { describe, it, expect } from 'vitest';

import {
  isNavParent,
  isNavTreeParent,
  NAV_ITEMS,
  NAV_RAIL,
  NAV_TREE,
  resolveActiveNav,
  ROUTE_REGISTRY,
  resolveNavTree,
  SURFACE_CATALOG,
  type NavGroup,
  type NavItem,
  type NavParent,
  type NavTreeGroup,
} from './nav';

/** Every leaf navId in a tree, in order, parents dissolved into their children in place. */
function treeLeafIds(tree: readonly NavTreeGroup[]): string[] {
  return tree.flatMap((group) =>
    group.items.flatMap((node) => (isNavTreeParent(node) ? node.children.map((c) => c.navId) : [node.navId])),
  );
}

const catalogIds = SURFACE_CATALOG.map((s) => s.navId);
const parents: NavParent[] = NAV_RAIL.flatMap((g) => g.items.filter(isNavParent));
const topLevel: NavItem[] = NAV_RAIL.flatMap((g) => g.items.filter((n) => !isNavParent(n)) as NavItem[]);

describe('the surface catalog: the single source of truth', () => {
  it('gives every surface a unique navId and a unique path', () => {
    expect(new Set(catalogIds).size).toBe(catalogIds.length);
    const paths = SURFACE_CATALOG.map((s) => s.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('starts every path with a single leading slash', () => {
    for (const s of SURFACE_CATALOG) expect(s.path).toMatch(/^\/[^/]/);
  });
});

describe('the route registry: the route projection', () => {
  it('is exactly the catalog paths, so the router and the catalog cannot drift', () => {
    expect(ROUTE_REGISTRY.map((r) => r.path).sort()).toEqual(SURFACE_CATALOG.map((s) => s.path).sort());
  });

  it('carries the catalog label for each path', () => {
    const label = new Map(SURFACE_CATALOG.map((s) => [s.path, s.labelKey]));
    for (const entry of ROUTE_REGISTRY) expect(entry.labelKey).toBe(label.get(entry.path));
  });
});

describe('the tree and the registry stay in sync (the guard that replaces the old coupling)', () => {
  it('places every catalog surface in the tree exactly once', () => {
    const ids = treeLeafIds(NAV_TREE).sort();
    expect(ids).toEqual([...catalogIds].sort());
    // "exactly once": no surface appears twice, and none is missing.
    expect(ids.length).toBe(catalogIds.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves every tree leaf to a catalog surface, hence to a route', () => {
    const routable = new Set(ROUTE_REGISTRY.map((r) => r.path));
    for (const item of NAV_ITEMS) {
      const surface = SURFACE_CATALOG.find((s) => s.navId === item.navId);
      expect(surface).toBeDefined();
      expect(routable.has(item.path)).toBe(true);
    }
  });

  it('FAILS when a route has no tree row (a catalog surface the tree forgot)', () => {
    // Plant a routable surface the tree never references, and prove the sync check catches it. This
    // is the exact drift the old single-structure model made impossible and the split reintroduced.
    const orphanedCatalogIds = [...catalogIds, 'phantom-surface'];
    const treeIds = treeLeafIds(NAV_TREE);
    const missingFromTree = orphanedCatalogIds.filter((id) => !treeIds.includes(id));
    expect(missingFromTree).toEqual(['phantom-surface']);
  });

  it('FAILS when a tree row has no route (a leaf pointing at nothing)', () => {
    // Plant a tree leaf whose navId is in no catalog surface, and prove resolution rejects it.
    const brokenTree: NavTreeGroup[] = [
      { navId: 'x', labelKey: null, items: [{ navId: 'not-a-real-surface' }] },
    ];
    expect(() => resolveNavTree(brokenTree)).toThrow(/unknown surface/);
  });
});

describe('the resolved rail', () => {
  it('nests MWST over Abrechnung and Einstellungen, in that order (W1)', () => {
    const mwst = parents.find((p) => p.labelKey === 'nav.mwst.group');
    expect(mwst).toBeDefined();
    expect(mwst?.children.map((c) => c.path)).toEqual(['/mwst', '/vat']);
  });

  it('leaves the /vat ROUTE untouched: only its label moved under the parent', () => {
    const vat = NAV_ITEMS.find((i) => i.path === '/vat');
    expect(vat).toBeDefined();
    expect(vat?.labelKey).toBe('nav.mwst.settings');
  });

  it('gives a parent no path, so it can never be routed to', () => {
    expect(parents.length).toBeGreaterThan(0);
    for (const parent of parents) {
      expect(parent).not.toHaveProperty('path');
    }
  });

  it('flattens every destination into NAV_ITEMS and nothing else', () => {
    const nestedChildPaths = parents.flatMap((p) => p.children.map((c) => c.path));
    const expected = [...topLevel.map((i) => i.path), ...nestedChildPaths].sort();
    expect([...NAV_ITEMS].map((i) => i.path).sort()).toEqual(expected);
    expect(NAV_ITEMS).toHaveLength(topLevel.length + nestedChildPaths.length);
    // One leaf per catalog surface, no more, no fewer.
    expect(NAV_ITEMS).toHaveLength(SURFACE_CATALOG.length);
  });

  it('keeps every path unique, so the route table has no silent winner', () => {
    const paths = NAV_ITEMS.map((i) => i.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('carries a glyph on every top-level item and on no nested child', () => {
    expect(topLevel.length).toBeGreaterThan(0);
    for (const item of topLevel) expect(item.icon).toBeDefined();
    for (const parent of parents) {
      expect(parent.icon).toBeDefined();
      for (const child of parent.children) expect(child.icon).toBeUndefined();
    }
  });

  it('holds every nested parent inside a headed group', () => {
    for (const group of NAV_RAIL as readonly NavGroup[]) {
      for (const node of group.items) {
        if (isNavParent(node)) expect(group.labelKey).not.toBeNull();
      }
    }
  });

  it('lands the index redirect on the overview surface, stable across the split', () => {
    expect(NAV_ITEMS[0]?.path).toBe('/overview');
  });
});

describe('the A2 regrouping (D118): folding the taxonomy', () => {
  const groupByLabel = (labelKey: string) => NAV_RAIL.find((g) => g.labelKey === labelKey);
  const parentByLabel = (labelKey: string) => parents.find((p) => p.labelKey === labelKey);

  it('folds the ten inventory routes behind a Lager parent, with inventory leading', () => {
    const lager = parentByLabel('nav.parent.lager');
    expect(lager).toBeDefined();
    expect(lager?.children.map((c) => c.path)).toEqual([
      '/inventory',
      '/warehouses',
      '/lot-serial-tracking',
      '/inventory-movements',
      '/inventory-valuation',
      '/inventory-valuation-runs',
      '/cycle-counts',
      '/inventory-adjustments',
      '/inventory-reason-codes',
      '/inventory-alerts',
    ]);
  });

  it('folds the fixed-asset register behind an Anlagen parent (its report door moved to Berichte)', () => {
    const anlagen = parentByLabel('nav.parent.anlagen');
    expect(anlagen).toBeDefined();
    expect(anlagen?.children.map((c) => c.path)).toEqual([
      '/asset-categories',
      '/assets',
      '/depreciation',
      '/asset-locations',
      '/depreciation-runs',
      '/asset-reconciliation',
      '/asset-maintenance',
    ]);
    // The report door is NOT here; it lives in the Berichte group.
    expect(anlagen?.children.map((c) => c.path)).not.toContain('/asset-reports');
  });

  it('gathers the five scattered report doors into one Berichte group', () => {
    const berichte = groupByLabel('nav.group.berichte');
    expect(berichte).toBeDefined();
    expect(berichte?.items.map((n) => (n as NavItem).path).sort()).toEqual(
      ['/reports', '/report-builder', '/procurement-analytics', '/asset-reports', '/forecast'].sort(),
    );
  });

  it('folds the governance cluster into one Einstellungen group, and it is LAST', () => {
    const settings = groupByLabel('nav.group.einstellungen');
    expect(settings).toBeDefined();
    expect(settings?.items.map((n) => (n as NavItem).path)).toEqual([
      '/setup',
      '/operations',
      '/members',
      '/customization',
      '/automations',
      '/extensions',
      '/writing-style',
      '/document-templates',
      '/dispatch',
      '/migration',
      '/environments',
      '/onboarding',
      '/first-run',
    ]);
    expect(NAV_RAIL[NAV_RAIL.length - 1]?.labelKey).toBe('nav.group.einstellungen');
  });

  it('keeps the daily queues top-level (a headerless cluster), not folded into a group', () => {
    const queueGroup = NAV_RAIL.find((g) => g.items.some((n) => (n as NavItem).path === '/tasks'));
    expect(queueGroup?.labelKey).toBeNull();
  });
});

describe('resolveActiveNav: the auto-expand chain (keeps routing untouched)', () => {
  it('names the leaf and its collapsible ancestors for a nested route', () => {
    const { leafNavId, ancestors } = resolveActiveNav('/inventory-alerts');
    expect(leafNavId).toBe('inventory-alerts');
    // Both the Stammdaten group and the Lager parent must open for the active item to show.
    expect(ancestors.has('master-data')).toBe(true);
    expect(ancestors.has('lager-group')).toBe(true);
  });

  it('resolves a detail route to its list leaf (longest matching path wins)', () => {
    const { leafNavId } = resolveActiveNav('/documents/new');
    expect(leafNavId).toBe('documents');
  });

  it('gives a headerless-cluster leaf no collapsible ancestor', () => {
    const { leafNavId, ancestors } = resolveActiveNav('/overview');
    expect(leafNavId).toBe('overview');
    expect(ancestors.size).toBe(0);
  });

  it('returns no leaf and no ancestors for a non-nav route', () => {
    const { leafNavId, ancestors } = resolveActiveNav('/nowhere');
    expect(leafNavId).toBeNull();
    expect(ancestors.size).toBe(0);
  });
});
