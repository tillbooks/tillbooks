/**
 * The personal menu and the one active row, as pure functions (D178 points 6 and 16): the layout is a
 * VIEW over the canonical tree, validated against the catalog on every read, and the rail lights ONE row.
 */
import { describe, it, expect } from 'vitest';

import {
  COMPACT_HIDDEN,
  NAV_TREE,
  OFF_RAIL,
  SURFACE_CATALOG,
  TOP_CONTAINER,
  canonicalMenuLayout,
  containerOf,
  groupKey,
  isCanonicalMenuLayout,
  isNavTreeParent,
  menuMoveTargets,
  moveMenuRow,
  moveMenuRowTo,
  normalizeMenuLayout,
  personalNavTree,
  reorderMenuRow,
  resolveNavTree,
  resolveOpenTopGroup,
  resolveRailActive,
  resolveSectionLocation,
  setMenuRowHidden,
  type MenuLayout,
  type NavGroup,
  type RailActive,
} from './nav';
import { NAV_COMMANDS } from '../lib/command-source';

describe('one open group at a time (judge round 1 L6)', () => {
  const groups = ['projects', 'sales', 'accounting'];
  it('opens the lit row\'s group over a group opened by hand', () => {
    expect(resolveOpenTopGroup(groups, { sales: true }, new Set(['accounting']))).toBe('accounting');
  });
  it('keeps a group the person closed over the lit row closed, and then opens the hand-opened one', () => {
    expect(resolveOpenTopGroup(groups, { accounting: false, sales: true }, new Set(['accounting']))).toBe('sales');
    expect(resolveOpenTopGroup(groups, { accounting: false }, new Set(['accounting']))).toBeNull();
  });
  it('of several groups opened by hand (an old stored value) shows only the first', () => {
    expect(resolveOpenTopGroup(groups, { accounting: true, sales: true }, new Set())).toBe('sales');
  });
  it('opens nothing on a page with no group', () => {
    expect(resolveOpenTopGroup(groups, {}, new Set())).toBeNull();
  });
});

describe('the folded header stands in for the open page (judge round 1 M4)', () => {
  const none: RailActive = { favouriteNavId: null, treeNavId: null, treeSoftNavId: null, expand: new Set() };
  it('names no section while a row on screen lights', () => {
    expect(resolveSectionLocation({ ...none, favouriteNavId: 'journal' }, { ...none, favouriteNavId: 'journal' })).toBeNull();
    expect(resolveSectionLocation({ ...none, treeNavId: 'journal' }, { ...none, favouriteNavId: 'journal' })).toBeNull();
  });
  it('names the section whose row would light had nothing been folded', () => {
    expect(resolveSectionLocation(none, { ...none, favouriteNavId: 'journal' })).toBe('favourites');
    expect(resolveSectionLocation(none, { ...none, treeNavId: 'journal' })).toBe('menu');
  });
  it('names nothing for a page that has no row anywhere', () => {
    expect(resolveSectionLocation(none, none)).toBeNull();
  });
});

/** Every leaf navId of a personal tree, in rail order. */
function leafIds(layout: MenuLayout, visibleOnly = false): string[] {
  return personalNavTree(layout, { visibleOnly }).flatMap((g) =>
    g.items.flatMap((n) => (isNavTreeParent(n) ? n.children.map((c) => c.navId) : [n.navId])),
  );
}

const canonicalLeaves = NAV_TREE.flatMap((g) =>
  g.items.flatMap((n) => (isNavTreeParent(n) ? n.children.map((c) => c.navId) : [n.navId])),
);

describe('the canonical layout is the default and the reset target', () => {
  it('renders the canonical rows in the canonical order, the headerless clusters as one top block', () => {
    const layout = canonicalMenuLayout();
    expect(isCanonicalMenuLayout(layout)).toBe(true);
    expect(leafIds(layout)).toEqual(canonicalLeaves);
    const tree = personalNavTree(layout, { visibleOnly: true });
    expect(tree[0]).toMatchObject({ navId: TOP_CONTAINER, labelKey: null });
    expect(tree[0]!.items.map((n) => n.navId)).toEqual(['overview', 'attention']);
    expect(tree.slice(1).map((g) => g.navId)).toEqual(NAV_TREE.filter((g) => g.labelKey !== null).map((g) => g.navId));
  });

  it('places every rail surface exactly once (the off-rail doors stay off)', () => {
    const ids = leafIds(canonicalMenuLayout());
    expect(new Set(ids).size).toBe(ids.length);
    const rail = SURFACE_CATALOG.map((s) => s.navId).filter((id) => !OFF_RAIL.has(id));
    expect([...ids].sort()).toEqual([...rail].sort());
  });

  it('reads anything that is not an object, and the empty object, as the canonical layout', () => {
    for (const raw of [undefined, null, 'x', 7, [], {}]) expect(isCanonicalMenuLayout(normalizeMenuLayout(raw))).toBe(true);
  });
});

describe('normalizeMenuLayout validates against the catalog (unknown ids dropped, new surfaces re-homed)', () => {
  it('drops unknown ids, duplicates and non-strings, keeping the person order of what it knows', () => {
    const layout = normalizeMenuLayout({
      groups: ['bank', 'nope', 'bank', 42, 'sales'],
      containers: { bank: ['payments', 'ghost', 'payments', 'bank-inbox'] },
      hidden: ['ghost', 'deals', 'deals', 'group:ghost', 'group:sales', 'sales'],
    });
    // The person's order of the groups it names survives; the unnamed ones come back around them.
    expect(layout.groups.indexOf('bank')).toBeLessThan(layout.groups.indexOf('sales'));
    expect([...layout.groups].sort()).toEqual(canonicalMenuLayout().groups.sort());
    const bank = layout.containers.bank!;
    expect(bank.filter((id) => id === 'payments')).toHaveLength(1);
    expect(bank.indexOf('payments')).toBeLessThan(bank.indexOf('bank-inbox'));
    // A group is hidden by its group key; a bare 'sales' names no page and is dropped.
    expect(layout.hidden).toEqual(['deals', 'group:sales']);
    // Every leaf still placed exactly once.
    const ids = leafIds(layout);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...canonicalLeaves].sort());
  });

  it('re-homes a surface the stored layout does not mention after its canonical predecessor', () => {
    // A layout saved before `umsatz` existed: it comes back after its canonical predecessor, `bank-inbox`.
    const layout = normalizeMenuLayout({ containers: { bank: ['bank-accounts', 'payments', 'bank-inbox'] } });
    expect(layout.containers.bank).toEqual(['bank-accounts', 'payments', 'bank-inbox', 'umsatz']);
    // D210: `creditor-payments` is canonical in Einkauf; a person who stored it under Bank keeps that.
    expect(containerOf(canonicalMenuLayout(), 'creditor-payments')).toBe('purchasing');
    const kept = normalizeMenuLayout({ containers: { bank: ['creditor-payments', 'payments'] } });
    expect(containerOf(kept, 'creditor-payments')).toBe('bank');
    expect(kept.containers.purchasing).not.toContain('creditor-payments');
  });

  it('keeps a parent out of the top block and out of another parent, and the first claim wins', () => {
    const layout = normalizeMenuLayout({
      containers: { [TOP_CONTAINER]: ['lager-group', 'journal'], 'lager-group': ['anlagen-group'], accounting: ['journal'] },
    });
    expect(layout.containers[TOP_CONTAINER]).toContain('journal');
    expect(layout.containers[TOP_CONTAINER]).not.toContain('lager-group');
    expect(layout.containers['lager-group']).not.toContain('anlagen-group');
    expect(layout.containers.accounting).not.toContain('journal');
    expect(containerOf(layout, 'lager-group')).toBe('master-data');
  });

  it('round-trips: a stored layout normalises to itself', () => {
    let layout = moveMenuRow(canonicalMenuLayout(), groupKey('sales'), 'up');
    layout = moveMenuRowTo(layout, 'journal', TOP_CONTAINER);
    layout = setMenuRowHidden(layout, 'deals', true);
    expect(normalizeMenuLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
  });
});

describe('the edits (reorder, move, hide, reset)', () => {
  it('moves a group up and down, never past an end', () => {
    const base = canonicalMenuLayout();
    const up = moveMenuRow(base, groupKey('master-data'), 'up');
    expect(up.groups).toEqual(['bank', 'sales', 'purchasing', 'master-data', 'accounting', 'projects']);
    expect(moveMenuRow(base, groupKey('bank'), 'up')).toBe(base);
    const last = base.groups[base.groups.length - 1]!;
    expect(moveMenuRow(base, groupKey(last), 'down')).toBe(base);
    expect(isCanonicalMenuLayout(up)).toBe(false);
  });

  it('reorders a row within its own list (the drag commit), and refuses a drag across lists', () => {
    const base = canonicalMenuLayout();
    const dragged = reorderMenuRow(base, 'bank-accounts', 'bank-inbox');
    expect(dragged.containers.bank).toEqual(['bank-accounts', 'bank-inbox', 'umsatz', 'payments']);
    expect(reorderMenuRow(base, 'journal', 'bank-inbox')).toBe(base);
  });

  it('moves a page into another group, the top block or a parent, at its end', () => {
    const base = canonicalMenuLayout();
    const moved = moveMenuRowTo(base, 'journal', 'bank');
    expect(moved.containers.accounting).not.toContain('journal');
    expect(moved.containers.bank!.at(-1)).toBe('journal');
    const top = moveMenuRowTo(base, 'journal', TOP_CONTAINER);
    expect(personalNavTree(top, { visibleOnly: true })[0]!.items.map((n) => n.navId)).toContain('journal');
    const intoParent = moveMenuRowTo(base, 'fx', 'lager-group');
    expect(intoParent.containers['lager-group']!.at(-1)).toBe('fx');
    expect(intoParent.containers.accounting).not.toContain('fx');
  });

  it('moves a parent between headed groups only', () => {
    const base = canonicalMenuLayout();
    expect(moveMenuRowTo(base, 'lager-group', 'purchasing').containers.purchasing!.at(-1)).toBe('lager-group');
    expect(moveMenuRowTo(base, 'lager-group', TOP_CONTAINER)).toBe(base);
    expect(moveMenuRowTo(base, 'lager-group', 'anlagen-group')).toBe(base);
    const targets = menuMoveTargets(base, 'lager-group');
    expect(targets).not.toContain(TOP_CONTAINER);
    expect(targets).not.toContain('master-data');
    expect(targets).toContain('purchasing');
    expect(menuMoveTargets(base, 'journal')).toEqual(expect.arrayContaining([TOP_CONTAINER, 'bank', 'lager-group']));
    expect(menuMoveTargets(base, 'journal')).not.toContain('accounting');
  });

  it('hides a page, a parent with its pages, and a group; an emptied group renders no dead header', () => {
    let layout = setMenuRowHidden(canonicalMenuLayout(), 'deals', true);
    expect(leafIds(layout, true)).not.toContain('deals');
    expect(leafIds(layout, false)).toContain('deals');
    layout = setMenuRowHidden(layout, 'lager-group', true);
    expect(leafIds(layout, true)).not.toContain('warehouses');
    layout = setMenuRowHidden(layout, groupKey('bank'), true);
    expect(personalNavTree(layout, { visibleOnly: true }).map((g) => g.navId)).not.toContain('bank');
    // Hide every row of Projekte: the group goes too.
    let empty = canonicalMenuLayout();
    for (const id of empty.containers.projects!) empty = setMenuRowHidden(empty, id, true);
    expect(personalNavTree(empty, { visibleOnly: true }).map((g) => g.navId)).not.toContain('projects');
    expect(setMenuRowHidden(setMenuRowHidden(canonicalMenuLayout(), 'deals', true), 'deals', false).hidden).toEqual([]);
  });
});

describe('D210: the seven-area menu and the compact scope', () => {
  const ids = (tree: ReturnType<typeof personalNavTree>) => tree.map((g) => g.navId);
  const flat = (tree: ReturnType<typeof personalNavTree>) =>
    tree.flatMap((g) => g.items.flatMap((n) => (isNavTreeParent(n) ? [n.navId, ...n.children.map((c) => c.navId)] : [n.navId])));

  it('keeps the top block to exactly Übersicht and Pendenzen, and the five compact groups in order', () => {
    const tree = personalNavTree(canonicalMenuLayout(), { visibleOnly: true, scope: 'compact' });
    expect(tree[0]).toMatchObject({ navId: TOP_CONTAINER, labelKey: null });
    expect(tree[0]!.items.map((n) => n.navId)).toEqual(['overview', 'attention']);
    expect(ids(tree).slice(1)).toEqual(['bank', 'sales', 'purchasing', 'accounting', 'master-data']);
    expect(ids(personalNavTree(canonicalMenuLayout(), { visibleOnly: true, scope: 'all' })).slice(1)).toEqual([
      'bank', 'sales', 'purchasing', 'accounting', 'master-data', 'projects',
    ]);
  });

  it('compact hides exactly COMPACT_HIDDEN, and all shows every row', () => {
    const every = flat(personalNavTree(canonicalMenuLayout(), { visibleOnly: true, scope: 'all' }));
    const compactTree = personalNavTree(canonicalMenuLayout(), { visibleOnly: true, scope: 'compact' });
    const compact = flat(compactTree);
    const compactKeys = new Set([...compact, ...ids(compactTree).filter((id) => id !== TOP_CONTAINER).map(groupKey)]);
    const allKeys = new Set([
      ...every,
      ...ids(personalNavTree(canonicalMenuLayout(), { visibleOnly: true, scope: 'all' })).filter((id) => id !== TOP_CONTAINER).map(groupKey),
    ]);
    const gone = [...allKeys].filter((k) => !compactKeys.has(k));
    // Every hidden key is a real row of the tree, and a hidden parent takes its leaves with it.
    for (const key of COMPACT_HIDDEN) expect(allKeys.has(key)).toBe(true);
    for (const key of COMPACT_HIDDEN) expect(gone).toContain(key);
    for (const key of gone) {
      if (COMPACT_HIDDEN.has(key)) continue;
      // The only other rows that vanish are the children of a hidden parent or the pages of a hidden group.
      const home = containerOf(canonicalMenuLayout(), key);
      expect(home !== null && (COMPACT_HIDDEN.has(home) || COMPACT_HIDDEN.has(groupKey(home)))).toBe(true);
    }
    expect(compact).toEqual(expect.arrayContaining(['bills', 'capture-inbox', 'creditor-payments', 'journal', 'mwst']));
    expect(compact).not.toContain('forecast');
    expect(every).toEqual(expect.arrayContaining(['forecast', 'warehouses', 'assets', 'time', 'deals']));
  });

  it('defaults to scope all when called directly', () => {
    expect(flat(personalNavTree(canonicalMenuLayout(), { visibleOnly: true }))).toContain('forecast');
  });

  it('gives every OFF_RAIL surface except first-run a palette command', () => {
    const paths = new Set(NAV_COMMANDS.map((c) => c.path));
    for (const id of OFF_RAIL) {
      const surface = SURFACE_CATALOG.find((s) => s.navId === id);
      expect(surface, `${id} is routed`).toBeDefined();
      expect(paths.has(surface!.path), `${id} is off the rail and must be in the palette`).toBe(id !== 'first-run');
    }
  });

  it('normalises a stored layout that still names removed ids without them', () => {
    const layout = normalizeMenuLayout({
      groups: ['group:settings', 'group:reports', 'settings', 'reports', 'bank'],
      containers: {
        [TOP_CONTAINER]: ['overview', 'agent', 'search', 'tasks', 'settings-home', 'attention'],
        bank: ['bank-inbox'],
      },
      hidden: ['agent', 'search', 'tasks', 'settings-home', 'group:settings', 'group:reports'],
    });
    const everyId = [...layout.groups, ...Object.values(layout.containers).flat(), ...layout.hidden];
    for (const gone of ['agent', 'search', 'tasks', 'settings-home', 'settings', 'reports-group', 'group:settings', 'group:reports']) {
      expect(everyId, gone).not.toContain(gone);
    }
    expect(layout.groups).not.toContain('settings');
    expect(layout.hidden).toEqual([]);
    expect(layout.containers[TOP_CONTAINER]).toEqual(['overview', 'attention']);
    expect([...layout.groups].sort()).toEqual([...canonicalMenuLayout().groups].sort());
  });
});

describe('THE ROW KEY: a group and the page that shares its navId never stand in for each other', () => {
  it('hides the Einkauf group without hiding the Bestellungen page, and the other way round', () => {
    const groupHidden = setMenuRowHidden(canonicalMenuLayout(), groupKey('purchasing'), true);
    expect(personalNavTree(groupHidden, { visibleOnly: true }).map((g) => g.navId)).not.toContain('purchasing');
    const pageHidden = setMenuRowHidden(canonicalMenuLayout(), 'purchasing', true);
    const tree = personalNavTree(pageHidden, { visibleOnly: true });
    expect(tree.map((g) => g.navId)).toContain('purchasing');
    expect(leafIds(pageHidden, true)).not.toContain('purchasing');
    expect(leafIds(pageHidden, true)).toContain('requisitions');
  });

  it('moves the Projekte page, not the Projekte group, when the page is named', () => {
    const base = canonicalMenuLayout();
    const moved = moveMenuRow(base, 'projects', 'down');
    expect(moved.groups).toEqual(base.groups);
    expect(moved.containers.projects).toEqual(['time', 'projects', 'personal']);
    expect(containerOf(base, 'projects')).toBe('projects');
    expect(containerOf(base, groupKey('projects'))).toBe('groups');
  });
});

describe('resolveRailActive: ONE row per nav.active_rule', () => {
  const rail: readonly NavGroup[] = resolveNavTree(personalNavTree(canonicalMenuLayout(), { visibleOnly: true }));
  const pins = [{ navId: 'journal', path: '/journal' }];

  it('favourite (default): the favourite, no tree row, nothing opened', () => {
    const a = resolveRailActive({ pathname: '/journal', favourites: pins, rail, rule: 'favourite' });
    expect(a).toMatchObject({ favouriteNavId: 'journal', treeNavId: null, treeSoftNavId: null });
    expect(a.expand.size).toBe(0);
  });

  it('tree: the tree row and its ancestors, no favourite', () => {
    const a = resolveRailActive({ pathname: '/journal/abc', favourites: pins, rail, rule: 'tree' });
    expect(a).toMatchObject({ favouriteNavId: null, treeNavId: 'journal', treeSoftNavId: null });
    expect([...a.expand]).toEqual(['accounting']);
  });

  it('both_soft: the favourite lit, the tree row soft, its ancestors open', () => {
    const a = resolveRailActive({ pathname: '/journal', favourites: pins, rail, rule: 'both_soft' });
    expect(a).toMatchObject({ favouriteNavId: 'journal', treeNavId: null, treeSoftNavId: 'journal' });
    expect([...a.expand]).toEqual(['accounting']);
  });

  it('falls back to whichever copy is on screen, and to nothing when neither is', () => {
    expect(resolveRailActive({ pathname: '/journal', favourites: [], rail, rule: 'favourite' }).treeNavId).toBe('journal');
    expect(resolveRailActive({ pathname: '/journal', favourites: pins, rail: [], rule: 'tree' }).favouriteNavId).toBe('journal');
    const none = resolveRailActive({ pathname: '/journal', favourites: [], rail: [], rule: 'tree' });
    expect([none.favouriteNavId, none.treeNavId, none.treeSoftNavId]).toEqual([null, null, null]);
  });

  it('the longest matching favourite wins (a detail route of a pinned list)', () => {
    const a = resolveRailActive({
      pathname: '/inventory-valuation-runs/7',
      favourites: [
        { navId: 'inventory-valuation', path: '/inventory-valuation' },
        { navId: 'inventory-valuation-runs', path: '/inventory-valuation-runs' },
      ],
      rail,
      rule: 'favourite',
    });
    expect(a.favouriteNavId).toBe('inventory-valuation-runs');
  });
});
