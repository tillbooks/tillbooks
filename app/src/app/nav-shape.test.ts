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
 *   - every row carries its glyph, at the top level and underneath a parent alike (D201).
 */
import { describe, it, expect } from 'vitest';

import {
  areaNavIdOf,
  areaPath,
  findAreaIn,
  firstLeafPath,
  isNavParent,
  isNavTreeParent,
  NAV_ITEMS,
  NAV_RAIL,
  NAV_TREE,
  OFF_RAIL,
  resolveActiveNav,
  ROUTE_REGISTRY,
  resolveNavTree,
  resolveRailActive,
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
/** The catalog surfaces the rail carries: every one except the routed-but-off-rail doors (K-05). */
const railIds = catalogIds.filter((id) => !OFF_RAIL.has(id));
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
  it('places every catalog surface in the tree exactly once, except the named off-rail doors', () => {
    const ids = treeLeafIds(NAV_TREE).sort();
    expect(ids).toEqual([...railIds].sort());
    // "exactly once": no surface appears twice, and none is missing.
    expect(ids.length).toBe(railIds.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the off-rail list to real, routed surfaces that the tree does not carry (K-05)', () => {
    // The list may only name catalog surfaces (so it cannot hide a typo), each one still routed.
    const routable = new Set(ROUTE_REGISTRY.map((r) => r.path));
    for (const id of OFF_RAIL) {
      const surface = SURFACE_CATALOG.find((s) => s.navId === id);
      expect(surface).toBeDefined();
      expect(routable.has(surface?.path ?? '')).toBe(true);
      expect(treeLeafIds(NAV_TREE)).not.toContain(id);
    }
    // D210: the first-run door, Suche, Agent, Aufgaben, /vat and the fifteen Einstellungen pages.
    expect([...OFF_RAIL].sort()).toEqual(
      [
        'first-run', 'search', 'agent', 'tasks', 'vat',
        'settings-home', 'setup', 'operations', 'my-settings', 'hausbuch', 'members', 'customization',
        'automations', 'extensions', 'writing-style', 'document-templates', 'dispatch', 'migration',
        'environments', 'onboarding',
      ].sort(),
    );
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
    const orphanedCatalogIds = [...railIds, 'phantom-surface'];
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
  it('carries MWST as ONE leaf in Buchhaltung, no parent over it (D210)', () => {
    expect(parents.find((p) => p.labelKey === 'nav.mwst.group')).toBeUndefined();
    const accounting = NAV_RAIL.find((g) => g.navId === 'accounting');
    const mwst = accounting?.items.find((n) => !isNavParent(n) && n.navId === 'mwst') as NavItem | undefined;
    expect(mwst).toBeDefined();
    expect(mwst?.path).toBe('/mwst');
    expect(mwst?.labelKey).toBe('nav.mwst.group');
  });

  it('leaves the /vat ROUTE untouched: routed and off the rail, reached from the settings page', () => {
    expect(NAV_ITEMS.find((i) => i.path === '/vat')).toBeUndefined();
    expect(OFF_RAIL.has('vat')).toBe(true);
    const vat = SURFACE_CATALOG.find((s) => s.path === '/vat');
    expect(vat?.labelKey).toBe('nav.mwst.settings');
    expect(ROUTE_REGISTRY.some((r) => r.path === '/vat')).toBe(true);
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
    // One leaf per rail surface (the catalog minus the off-rail doors), no more, no fewer.
    expect(NAV_ITEMS).toHaveLength(SURFACE_CATALOG.length - OFF_RAIL.size);
  });

  it('keeps every path unique, so the route table has no silent winner', () => {
    const paths = NAV_ITEMS.map((i) => i.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('carries a glyph on every row, a nested child included (D201: icons on every row)', () => {
    expect(topLevel.length).toBeGreaterThan(0);
    for (const item of topLevel) expect(item.icon).toBeDefined();
    for (const parent of parents) {
      expect(parent.icon).toBeDefined();
      for (const child of parent.children) {
        // The child's glyph is its own catalog surface's, never a stand-in.
        expect(child.icon).toBe(SURFACE_CATALOG.find((s) => s.navId === child.navId)?.icon);
      }
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

  it('keeps the rail to the headerless top block and the six headed areas, in order (D210)', () => {
    expect(NAV_RAIL.map((g) => g.navId)).toEqual([
      'overview-cluster', 'bank', 'sales', 'purchasing', 'accounting', 'master-data', 'projects',
    ]);
    expect(NAV_RAIL[0]!.labelKey).toBeNull();
    expect(NAV_RAIL[0]!.items.map((n) => n.navId)).toEqual(['overview', 'attention']);
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

  it('folds the fixed-asset register behind an Anlagen parent (its report door sits in Buchhaltung)', () => {
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
    // The report door is NOT here; it lives in Buchhaltung.
    expect(anlagen?.children.map((c) => c.path)).not.toContain('/asset-reports');
  });

  it('gathers the report doors into Buchhaltung, after the period work (D210)', () => {
    const accounting = groupByLabel('nav.group.accounting');
    expect(accounting).toBeDefined();
    const paths = accounting?.items.map((n) => (n as NavItem).path);
    for (const door of ['/reports', '/report-builder', '/procurement-analytics', '/asset-reports', '/forecast', '/review', '/export']) {
      expect(paths).toContain(door);
    }
    expect(paths!.indexOf('/periods')).toBeLessThan(paths!.indexOf('/reports'));
    // The old Berichte, Treuhänder and Einstellungen groups are gone.
    for (const gone of ['nav.group.berichte', 'nav.group.treuhaender', 'nav.group.einstellungen']) {
      expect(groupByLabel(gone)).toBeUndefined();
    }
  });

  it('moves the governance cluster off the rail: every Einstellungen page stays routed, none is a row (D210)', () => {
    const settingsPaths = [
      '/settings', '/setup', '/operations', '/my-settings', '/hausbuch', '/members', '/customization',
      '/automations', '/extensions', '/writing-style', '/document-templates', '/dispatch', '/migration',
      '/environments', '/onboarding',
    ];
    const railPaths = new Set(NAV_ITEMS.map((i) => i.path));
    const routed = new Set(ROUTE_REGISTRY.map((r) => r.path));
    for (const path of settingsPaths) {
      expect(railPaths.has(path), `${path} is not a rail row`).toBe(false);
      expect(routed.has(path), `${path} stays routed`).toBe(true);
    }
  });

  it('keeps the daily doors top-level (a headerless cluster), not folded into a group', () => {
    const queueGroup = NAV_RAIL.find((g) => g.items.some((n) => (n as NavItem).path === '/attention'));
    expect(queueGroup?.labelKey).toBeNull();
    expect(queueGroup?.items.map((n) => n.navId)).toEqual(['overview', 'attention']);
  });
});

describe('firstLeafPath: a parent navigates to its natural landing (D135)', () => {
  const groupByLabel = (labelKey: string): NavGroup =>
    NAV_RAIL.find((g) => g.labelKey === labelKey) as NavGroup;
  const parentByLabel = (labelKey: string): NavParent =>
    parents.find((p) => p.labelKey === labelKey) as NavParent;

  it('resolves a headed group to the path of its first leaf', () => {
    expect(firstLeafPath(groupByLabel('nav.group.masterData'))).toBe('/contacts');
    expect(firstLeafPath(groupByLabel('nav.group.bank'))).toBe('/bank');
    expect(firstLeafPath(groupByLabel('nav.group.projects'))).toBe('/projects');
    expect(firstLeafPath(groupByLabel('nav.group.accounting'))).toBe('/journal');
  });

  it('resolves a nested parent to the path of its first child leaf', () => {
    expect(firstLeafPath(parentByLabel('nav.parent.lager'))).toBe('/inventory');
    expect(firstLeafPath(parentByLabel('nav.parent.anlagen'))).toBe('/asset-categories');
  });

  it('recurses when a group leads with a nested parent, landing on that parent first leaf', () => {
    const group: NavGroup = {
      navId: 'synthetic',
      labelKey: 'x',
      items: [
        {
          navId: 'p',
          labelKey: 'p',
          icon: 'items',
          children: [{ navId: 'a', path: '/a', labelKey: 'a' }],
        },
      ],
    };
    expect(firstLeafPath(group)).toBe('/a');
  });

  it('returns null for a group with no leaf beneath it', () => {
    expect(firstLeafPath({ navId: 'empty', labelKey: 'x', items: [] })).toBeNull();
  });

  it('only ever returns a real catalog path, because a parent still has none of its own', () => {
    const catalogPaths = new Set(SURFACE_CATALOG.map((s) => s.path));
    for (const group of NAV_RAIL) {
      if (group.labelKey === null) continue;
      const landing = firstLeafPath(group);
      expect(landing !== null && catalogPaths.has(landing)).toBe(true);
      for (const node of group.items) {
        if (isNavParent(node)) {
          const parentLanding = firstLeafPath(node);
          expect(parentLanding !== null && catalogPaths.has(parentLanding)).toBe(true);
        }
      }
    }
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

describe('the area overviews (D201): one page of tiles per group and nested parent', () => {
  it('round-trips an overview path and refuses every other path', () => {
    expect(areaPath('master-data')).toBe('/area/master-data');
    expect(areaNavIdOf('/area/master-data')).toBe('master-data');
    expect(areaNavIdOf('/area/lager-group/')).toBe('lager-group');
    expect(areaNavIdOf('/accounts')).toBeNull();
    expect(areaNavIdOf('/area/a/b')).toBeNull();
  });

  it('finds every headed group and every nested parent, and no headerless cluster or leaf', () => {
    for (const group of NAV_RAIL) {
      if (group.labelKey === null) {
        expect(findAreaIn(NAV_RAIL, group.navId)).toBeNull();
        continue;
      }
      expect(findAreaIn(NAV_RAIL, group.navId)?.kind).toBe('group');
      for (const node of group.items) {
        if (isNavParent(node)) expect([...(findAreaIn(NAV_RAIL, node.navId)?.ancestors ?? [])]).toEqual([group.navId, node.navId]);
      }
    }
    expect(findAreaIn(NAV_RAIL, 'accounts')).toBeNull();
  });

  it('keeps every overview id apart from every other overview id (one route, one node)', () => {
    const ids = [...NAV_RAIL.filter((g) => g.labelKey !== null).map((g) => g.navId), ...parents.map((p) => p.navId)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('opens the node of an open overview, and lights no leaf there', () => {
    const active = resolveRailActive({ pathname: '/area/lager-group', favourites: [], rail: NAV_RAIL, rule: 'favourite' });
    expect(active.treeNavId).toBeNull();
    expect([...active.expand].sort()).toEqual(['lager-group', 'master-data']);
  });
});
