/**
 * The Studio navigation model, split into TWO concerns so personalization becomes possible.
 *
 * WHY THE SPLIT (D118, modernisation phase 1). Until now one structure (`NAV_GROUPS`) drove BOTH the
 * rail (its grouping, ordering, labels, glyphs) AND the router's route table (slug to surface). A
 * user could not reorder, collapse, favourite or rename a rail row without corrupting routing,
 * because the two were the same object. So the model is now three pieces:
 *
 *   1. SURFACE_CATALOG: the single source of truth for WHICH surfaces exist. One terse record per
 *      routable surface (`navId`, `path`, `labelKey`, `icon`). This is what the route registry is a
 *      projection of, and what the tree references by `navId`.
 *   2. NAV_TREE: the rail projection. Groups, parents and leaves, arranged and nested, each leaf a
 *      reference to a catalog surface BY `navId` (never by path), each node carrying a stable
 *      `navId`. This is the structure a later agent layers per-user overrides onto (collapse state,
 *      favourite pins, aliases, reorder) WITHOUT ever touching routing, because the router does not
 *      read it.
 *   3. ROUTE_REGISTRY: the route projection. The flat `path` to `labelKey` list the router consumes.
 *      Derived from the catalog, so the two can never drift.
 *
 * The tree and the routes are two PROJECTIONS of one catalog. `nav-shape.test.ts` asserts they stay
 * in sync (every catalog surface appears in the tree exactly once; every tree leaf resolves to a
 * catalog surface, hence to a route). That sync test is the guard that replaces the old coupling:
 * with the tree and the registry independently authored, a route with no tree row, or a tree row
 * with no route, is now a loud test failure rather than a silent 404 or an orphaned screen.
 *
 * NAV_RAIL is the RESOLVED tree (leaves joined to their catalog labels and glyphs), the shape the
 * Shell renders. NAV_ITEMS is the flat, rail-ordered leaf list the router's index redirect, the
 * command palette and the first-run landing all consume. Both are derived, never authored.
 */

/** The rail icon set. One name per surface; the mapping lives in nav-icons.tsx. */
export type NavIconName =
  | 'search'
  | 'setup'
  | 'migration'
  | 'members'
  | 'customization'
  | 'automations'
  | 'accounts'
  | 'journal'
  | 'periods'
  | 'vat'
  | 'fx'
  | 'contacts'
  | 'items'
  | 'files'
  | 'documents'
  | 'payments'
  | 'openItems'
  | 'dunning'
  | 'bankAccounts'
  | 'reconciliation'
  | 'reports'
  | 'bills'
  | 'recurring'
  | 'projects'
  | 'time'
  | 'tasks'
  | 'deals'
  | 'inventory'
  | 'personal'
  | 'correspondence'
  | 'agent'
  | 'overview';

// --- 1. The surface catalog: the single source of truth ------------------------------------------

/**
 * One routable Studio surface.
 *
 * `navId` is the STABLE IDENTITY, the key a per-user override (a favourite pin, a rename alias, a
 * collapse flag) attaches to. It is deliberately separate from `path`: a slug is a deep-link
 * contract that may one day change, and a user's pinned favourite must survive that change. The two
 * happen to coincide today (the navId is the slug without its leading slash), and nothing asserts
 * they must, precisely so they can diverge later.
 *
 * FIELD ORDER IS LOAD-BEARING: `path` then `labelKey` must stay adjacent and lead the object, because
 * `scripts/generate-orientation.mjs` reads the pair off this file with a regex to build its surface
 * map. Reorder them and the generated ORIENTATION.md drifts.
 */
export interface Surface {
  path: string;
  labelKey: string;
  icon: NavIconName;
  navId: string;
}

/**
 * Every routable surface, authored once. Order here does not affect the rail (NAV_TREE owns rail
 * order) nor routing (the router matches by path); it is grouped to read alongside the tree below.
 */
export const SURFACE_CATALOG: readonly Surface[] = [
  // Top cluster: the ambient, cross-module surfaces (overview, search, agent).
  { path: '/overview', labelKey: 'nav.overview', icon: 'overview', navId: 'overview' },
  { path: '/search', labelKey: 'nav.search', icon: 'search', navId: 'search' },
  { path: '/agent', labelKey: 'nav.agent', icon: 'agent', navId: 'agent' },

  // Workspace cluster: set up once, touched rarely (access, customization, automation, onboarding).
  { path: '/setup', labelKey: 'nav.setup', icon: 'setup', navId: 'setup' },
  { path: '/operations', labelKey: 'nav.operations', icon: 'setup', navId: 'operations' },
  { path: '/members', labelKey: 'nav.members', icon: 'members', navId: 'members' },
  { path: '/customization', labelKey: 'nav.customization', icon: 'customization', navId: 'customization' },
  { path: '/automations', labelKey: 'nav.automations', icon: 'automations', navId: 'automations' },
  { path: '/extensions', labelKey: 'nav.extensions', icon: 'customization', navId: 'extensions' },
  { path: '/writing-style', labelKey: 'nav.writingStyle', icon: 'correspondence', navId: 'writing-style' },
  { path: '/document-templates', labelKey: 'nav.documentTemplates', icon: 'documents', navId: 'document-templates' },
  { path: '/dispatch', labelKey: 'nav.dispatch', icon: 'documents', navId: 'dispatch' },
  { path: '/migration', labelKey: 'nav.migration', icon: 'migration', navId: 'migration' },
  { path: '/environments', labelKey: 'nav.environments', icon: 'migration', navId: 'environments' },
  { path: '/onboarding', labelKey: 'nav.onboarding', icon: 'setup', navId: 'onboarding' },
  { path: '/first-run', labelKey: 'nav.firstRun', icon: 'setup', navId: 'first-run' },

  // The two every-morning queues (tasks, attention) and local correspondence.
  { path: '/tasks', labelKey: 'nav.tasks', icon: 'tasks', navId: 'tasks' },
  { path: '/attention', labelKey: 'nav.attention', icon: 'dunning', navId: 'attention' },
  // G22 (D127): the recurring checklists, the MWST-Periode first. Filed in the Buchhaltung group
  // beside the MWST pair it walks (the daily cluster keeps its six leaves, D118 A1: the rail never
  // scrolls); its due items reach the daily rhythm through the Pendenzen hub.
  { path: '/checklisten', labelKey: 'nav.checklists', icon: 'tasks', navId: 'checklists' },
  { path: '/correspondence', labelKey: 'nav.correspondence', icon: 'correspondence', navId: 'correspondence' },

  // Projects.
  { path: '/projects', labelKey: 'nav.projects', icon: 'projects', navId: 'projects' },
  { path: '/time', labelKey: 'nav.time', icon: 'time', navId: 'time' },
  { path: '/personal', labelKey: 'nav.personal', icon: 'personal', navId: 'personal' },

  // Master data: the registers you browse and search, including the inventory and fixed-asset families.
  { path: '/accounts', labelKey: 'nav.accounts', icon: 'accounts', navId: 'accounts' },
  { path: '/contacts', labelKey: 'nav.contacts', icon: 'contacts', navId: 'contacts' },
  { path: '/items', labelKey: 'nav.items', icon: 'items', navId: 'items' },
  { path: '/inventory', labelKey: 'nav.inventory', icon: 'inventory', navId: 'inventory' },
  { path: '/warehouses', labelKey: 'nav.warehouses', icon: 'inventory', navId: 'warehouses' },
  { path: '/lot-serial-tracking', labelKey: 'nav.lotSerial', icon: 'inventory', navId: 'lot-serial-tracking' },
  { path: '/inventory-movements', labelKey: 'nav.inventoryMovements', icon: 'inventory', navId: 'inventory-movements' },
  { path: '/inventory-valuation', labelKey: 'nav.inventoryValuation', icon: 'inventory', navId: 'inventory-valuation' },
  { path: '/inventory-valuation-runs', labelKey: 'nav.inventoryValuationRuns', icon: 'inventory', navId: 'inventory-valuation-runs' },
  { path: '/cycle-counts', labelKey: 'nav.cycleCounts', icon: 'inventory', navId: 'cycle-counts' },
  { path: '/inventory-adjustments', labelKey: 'nav.inventoryAdjustments', icon: 'inventory', navId: 'inventory-adjustments' },
  { path: '/inventory-reason-codes', labelKey: 'nav.inventoryReasonCodes', icon: 'inventory', navId: 'inventory-reason-codes' },
  { path: '/inventory-alerts', labelKey: 'nav.inventoryAlerts', icon: 'inventory', navId: 'inventory-alerts' },
  { path: '/files', labelKey: 'nav.files', icon: 'files', navId: 'files' },
  { path: '/asset-categories', labelKey: 'nav.assetCategories', icon: 'accounts', navId: 'asset-categories' },
  { path: '/assets', labelKey: 'nav.assets', icon: 'items', navId: 'assets' },
  { path: '/depreciation', labelKey: 'nav.depreciation', icon: 'accounts', navId: 'depreciation' },
  { path: '/asset-locations', labelKey: 'nav.assetLocations', icon: 'files', navId: 'asset-locations' },
  { path: '/depreciation-runs', labelKey: 'nav.depreciationRuns', icon: 'accounts', navId: 'depreciation-runs' },
  { path: '/asset-reconciliation', labelKey: 'nav.assetReconciliation', icon: 'accounts', navId: 'asset-reconciliation' },
  { path: '/asset-maintenance', labelKey: 'nav.assetMaintenance', icon: 'items', navId: 'asset-maintenance' },
  { path: '/asset-reports', labelKey: 'nav.assetReports', icon: 'reports', navId: 'asset-reports' },

  // Sales.
  { path: '/deals', labelKey: 'nav.deals', icon: 'deals', navId: 'deals' },
  { path: '/forecast', labelKey: 'nav.forecast', icon: 'reports', navId: 'forecast' },
  { path: '/quotes', labelKey: 'nav.quotes', icon: 'documents', navId: 'quotes' },
  { path: '/sales-orders', labelKey: 'nav.salesOrders', icon: 'documents', navId: 'sales-orders' },
  { path: '/documents', labelKey: 'nav.documents', icon: 'documents', navId: 'documents' },
  { path: '/open-items', labelKey: 'nav.openItems', icon: 'openItems', navId: 'open-items' },
  { path: '/dunning', labelKey: 'nav.dunning', icon: 'dunning', navId: 'dunning' },
  { path: '/recurring', labelKey: 'nav.recurring', icon: 'recurring', navId: 'recurring' },

  // Purchasing.
  { path: '/requisitions', labelKey: 'nav.requisitions', icon: 'bills', navId: 'requisitions' },
  { path: '/purchasing', labelKey: 'nav.purchasing', icon: 'bills', navId: 'purchasing' },
  { path: '/po-versions', labelKey: 'nav.poVersions', icon: 'bills', navId: 'po-versions' },
  { path: '/goods-receipts', labelKey: 'nav.goodsReceipts', icon: 'bills', navId: 'goods-receipts' },
  { path: '/landed-costs', labelKey: 'nav.landedCosts', icon: 'bills', navId: 'landed-costs' },
  { path: '/bills', labelKey: 'nav.bills', icon: 'bills', navId: 'bills' },
  { path: '/three-way-match', labelKey: 'nav.threeWayMatch', icon: 'bills', navId: 'three-way-match' },
  { path: '/procurement-analytics', labelKey: 'nav.procurementAnalytics', icon: 'reports', navId: 'procurement-analytics' },
  { path: '/capture-inbox', labelKey: 'nav.captureInbox', icon: 'files', navId: 'capture-inbox' },

  // Bank.
  { path: '/payments', labelKey: 'nav.payments', icon: 'payments', navId: 'payments' },
  { path: '/creditor-payments', labelKey: 'nav.creditorPayments', icon: 'payments', navId: 'creditor-payments' },
  { path: '/reconciliation', labelKey: 'nav.reconciliation', icon: 'reconciliation', navId: 'reconciliation' },
  { path: '/bank-accounts', labelKey: 'nav.bankAccounts', icon: 'bankAccounts', navId: 'bank-accounts' },

  // Accounting. `/mwst` and `/vat` nest under the MWST parent in the tree; the label a child shows
  // dropped its "MWST-" prefix (the parent already says it), which is why the labelKeys differ from
  // the surface heading. The ROUTES are untouched.
  { path: '/journal', labelKey: 'nav.journal', icon: 'journal', navId: 'journal' },
  { path: '/periods', labelKey: 'nav.periods', icon: 'periods', navId: 'periods' },
  { path: '/fx', labelKey: 'nav.fx', icon: 'fx', navId: 'fx' },
  { path: '/mwst', labelKey: 'nav.mwst.abrechnung', icon: 'vat', navId: 'mwst' },
  { path: '/vat', labelKey: 'nav.mwst.settings', icon: 'vat', navId: 'vat' },
  { path: '/reports', labelKey: 'nav.reports', icon: 'reports', navId: 'reports' },
  { path: '/report-builder', labelKey: 'nav.reportBuilder', icon: 'reports', navId: 'report-builder' },

  // TreuhÃ¤nder review and export.
  { path: '/review', labelKey: 'nav.review', icon: 'tasks', navId: 'review' },
  { path: '/export', labelKey: 'nav.export', icon: 'reports', navId: 'export' },
];

/** Catalog lookup by `navId`. Built once; the resolver and the sync test both read it. */
const SURFACE_BY_ID: ReadonlyMap<string, Surface> = new Map(
  SURFACE_CATALOG.map((surface) => [surface.navId, surface]),
);

/**
 * The one catalog surface a `navId` names, or undefined when the id names no destination (a group or
 * parent navId, or a stale favourite whose surface was removed). The Favoriten lane (A3) reads this
 * to resolve a pinned navId into a routable row: only a LEAF can be a favourite, because only a leaf
 * has a path, and a favourite that no longer resolves is silently dropped rather than shown broken.
 */
export function surfaceByNavId(navId: string): Surface | undefined {
  return SURFACE_BY_ID.get(navId);
}

// --- 2. The nav tree: the rail projection, referencing surfaces by navId -------------------------

/** A rail LEAF: a pointer to a catalog surface by its stable `navId`. Carries no path and no label
 *  of its own, so reordering, renaming (via a future alias) or favouriting a leaf never touches the
 *  route the `navId` resolves to. */
export interface NavTreeLeaf {
  navId: string;
}

/**
 * A rail PARENT: a heading that groups sibling surfaces and carries no route of its OWN.
 *
 * A parent has no path (there is no "MWST overview" screen), so it is never a routable destination in
 * its own right and the model keeps it pathless (the sync test asserts this). What CHANGED is the
 * click behaviour, not the model: D135 (owner request) made a parent row navigate on click to its
 * FIRST child leaf (its natural landing) AND expand, so the header is a shortcut to a real surface
 * rather than a dead label. The chevron keeps the pure expand/collapse toggle. The parent still adds no
 * new surface: it borrows a child's route (`firstLeafPath` resolves it). Its own `navId` is the stable
 * key a per-user collapse flag attaches to (A1 needs collapsible parents). The model carries this level
 * whether or not the rail renders nesting today, so personalization can grow into it without a schema
 * change.
 */
export interface NavTreeParent {
  navId: string;
  labelKey: string;
  icon: NavIconName;
  children: readonly NavTreeLeaf[];
}

/** One row of a tree group: a leaf, or a parent holding leaves. */
export type NavTreeNode = NavTreeLeaf | NavTreeParent;

/** A tree GROUP: a stable `navId` (the collapse-state key for the whole cluster), an optional header
 *  (null renders a bare, headerless cluster) and its ordered rows. */
export interface NavTreeGroup {
  navId: string;
  labelKey: string | null;
  items: readonly NavTreeNode[];
}

/** Narrow a tree node to a parent. The discriminant is `children`, the field only a parent has. */
export function isNavTreeParent(node: NavTreeNode): node is NavTreeParent {
  return (node as NavTreeParent).children !== undefined;
}

/** A tiny authoring helper so a leaf reads as `leaf('journal')` rather than `{ navId: 'journal' }`. */
const leaf = (navId: string): NavTreeLeaf => ({ navId });

/**
 * The rail, top to bottom. Grouping, order and nesting live HERE and nowhere else, so this is the
 * one structure a personalization layer rearranges. The placement rationale for each row is kept
 * beside the row it explains.
 */
export const NAV_TREE: readonly NavTreeGroup[] = [
  {
    // The ambient surfaces, and the Studio LANDING PAGE (overview). A headerless cluster, FIRST,
    // because the index redirect targets the first leaf. Search and Agent join it because, like the
    // tile wall, they compose EVERY module and would be misfiled under any one of them. A headerless
    // cluster is NOT collapsible (there is no header to collapse), so these daily doors are always
    // visible: that is the property the A2 regrouping keeps for the every-morning surfaces.
    navId: 'overview-cluster',
    labelKey: null,
    items: [leaf('overview'), leaf('search'), leaf('agent')],
  },
  {
    // The every-morning queues. NOT folded into a group (D118 A2 keeps daily work top-level): its
    // rhythm is the opposite of the governance cluster, and the queues' value is being cross-entity,
    // so filing them under one module would misfile them. A headerless cluster renders as bare rows.
    navId: 'queues-cluster',
    labelKey: null,
    items: [leaf('tasks'), leaf('attention')],
  },
  {
    // Local correspondence: the other every-morning queue, cross-contact and cross-thread, so it is
    // its own headerless cluster rather than filed under Kontakte or Verkauf. Stays top-level (A2).
    navId: 'correspondence-cluster',
    labelKey: null,
    items: [leaf('correspondence')],
  },
  {
    // Projects: set the master up, then live in the timesheet daily. Personal (HR-lite) rides the
    // nearest rhythm, day-to-day backoffice over people and their costs.
    navId: 'projects',
    labelKey: 'nav.group.projects',
    items: [leaf('projects'), leaf('time'), leaf('personal')],
  },
  {
    // Master data: registers you browse and search, not daily verbs. Holds the core three (accounts,
    // contacts, items) and files at the top level, then FOLDS the two large families behind parents
    // (D118 A2): Lager gathers the ten inventory routes, Anlagen the fixed-asset routes. Folding 17
    // former peers into 2 collapsible parents is the core of the 71-route problem's solution.
    navId: 'master-data',
    labelKey: 'nav.group.masterData',
    items: [
      leaf('accounts'),
      leaf('contacts'),
      leaf('items'),
      leaf('files'),
      {
        // Lager (D01): the whole inventory family as one collapsible parent, `inventory` (the Lager
        // landing) leading. No route of its own, so clicking it lands on that first child (D135).
        navId: 'lager-group',
        labelKey: 'nav.parent.lager',
        icon: 'inventory',
        children: [
          leaf('inventory'),
          leaf('warehouses'),
          leaf('lot-serial-tracking'),
          leaf('inventory-movements'),
          leaf('inventory-valuation'),
          leaf('inventory-valuation-runs'),
          leaf('cycle-counts'),
          leaf('inventory-adjustments'),
          leaf('inventory-reason-codes'),
          leaf('inventory-alerts'),
        ],
      },
      {
        // Anlagen: the fixed-asset family as one collapsible parent. Its reporting door (asset-reports)
        // moved to the Berichte group, so this holds the register and the run/reconcile/maintain verbs.
        navId: 'anlagen-group',
        labelKey: 'nav.parent.anlagen',
        icon: 'items',
        children: [
          leaf('asset-categories'),
          leaf('assets'),
          leaf('depreciation'),
          leaf('asset-locations'),
          leaf('depreciation-runs'),
          leaf('asset-reconciliation'),
          leaf('asset-maintenance'),
        ],
      },
    ],
  },
  {
    // Sales: the pipeline (deals), then the documents (quotes, orders, Belege), then the receivable's
    // chase (open items, dunning) and the standing recurring series. The forecast door moved to the
    // Berichte group with the other report-shaped surfaces (D118 A2).
    navId: 'sales',
    labelKey: 'nav.group.sales',
    items: [
      leaf('deals'),
      leaf('quotes'),
      leaf('sales-orders'),
      leaf('documents'),
      leaf('open-items'),
      leaf('dunning'),
      leaf('recurring'),
    ],
  },
  {
    // Purchasing: the creditor mirror of Verkauf, from the internal demand (requisitions) through the
    // PO, receipt and match, to the bill. The procurement-analytics door moved to the Berichte group
    // (D118 A2). Placed after Verkauf, because a business invoices before it pays.
    navId: 'purchasing',
    labelKey: 'nav.group.purchasing',
    items: [
      leaf('requisitions'),
      leaf('purchasing'),
      leaf('po-versions'),
      leaf('goods-receipts'),
      leaf('landed-costs'),
      leaf('bills'),
      leaf('three-way-match'),
      leaf('capture-inbox'),
    ],
  },
  {
    // Bank: the daily verbs first (payments, creditor payments), then the recurring reconciliation
    // chore, then the rarely-touched Bankkonten register.
    navId: 'bank',
    labelKey: 'nav.group.bank',
    items: [leaf('payments'), leaf('creditor-payments'), leaf('reconciliation'), leaf('bank-accounts')],
  },
  {
    // Accounting, in frequency order: the daily journal, the periodic close (periods, fx), and the
    // MWST pair under a parent (Abrechnung leads, Einstellungen follows: config never stacks on the
    // content it configures). The report doors (reports, report builder) moved to Berichte (D118 A2).
    navId: 'accounting',
    labelKey: 'nav.group.accounting',
    items: [
      leaf('journal'),
      leaf('periods'),
      leaf('fx'),
      {
        // The MWST parent: no route of its own, so clicking it lands on its first child, Abrechnung
        // (D135). The `/vat` route is untouched; only the child labels dropped the "MWST-" prefix the
        // parent already carries.
        navId: 'mwst-group',
        labelKey: 'nav.mwst.group',
        icon: 'vat',
        children: [leaf('mwst'), leaf('vat')],
      },
      // G22 (D127): the checklists walk the MWST period the pair above computes and files, so they
      // sit right after it; a later year-close template stays in the same door.
      leaf('checklists'),
    ],
  },
  {
    // Berichte (D118 A2): the report-shaped doors, gathered from where they were scattered (the two
    // accounting reports, the procurement analytics, the fixed-asset reports and the sales forecast).
    // One place to read a statement, rather than five doors hidden across five modules.
    navId: 'reports',
    labelKey: 'nav.group.berichte',
    items: [
      leaf('reports'),
      leaf('report-builder'),
      leaf('procurement-analytics'),
      leaf('asset-reports'),
      leaf('forecast'),
    ],
  },
  {
    // Treuhänder: the fiduciary's end-of-cycle work over the whole ledger (review, export). Its own
    // group, after the accounting cycle it reviews.
    navId: 'treuhaender',
    labelKey: 'nav.group.treuhaender',
    items: [leaf('review'), leaf('export')],
  },
  {
    // Einstellungen (D118 A2): the workspace governance cluster, folded from a headerless top-level
    // run of ten rows into one collapsible group, LAST. Its rhythm is "set up once at onboarding,
    // then rarely touched", so a fresh workspace keeps it collapsed and the ten rows cost one.
    navId: 'settings',
    labelKey: 'nav.group.einstellungen',
    items: [
      leaf('setup'),
      // K-16: the Betrieb surface, the read-once operational panels split off `/setup` (Option A). It
      // sits next to Einrichtung because it is the other half of the same workspace, set up once and
      // then visited on purpose.
      leaf('operations'),
      leaf('members'),
      leaf('customization'),
      leaf('automations'),
      leaf('extensions'),
      leaf('writing-style'),
      leaf('document-templates'),
      leaf('dispatch'),
      leaf('migration'),
      // The environment landscape (D126): create / refresh / reset / delete the main / test / develop
      // tiers and named ad-hoc environments. A set-up-once-then-visited-on-purpose governance surface,
      // so it rides the Einstellungen cluster next to Migration, its nearest data-lifecycle sibling.
      leaf('environments'),
      leaf('onboarding'),
      // M00's pre-workspace first-run door is NOT a row here since K-05 (D137): see OFF_RAIL below.
    ],
  },
];

/**
 * Routed surfaces that are deliberately NOT rail rows (K-05, D137). The first-run door is the
 * pre-workspace screen: the landing route becomes it on an empty ledger (`WorkspaceResolver`), and
 * inside a workspace its three doors live where a person looks for them (a new workspace in the
 * switcher, a restore under Betrieb). As an Einstellungen leaf it was a pre-workspace door filed
 * inside a workspace. The route stays; only the rail row goes. The sync test holds this list to
 * surfaces that exist, so it cannot hide a forgotten row.
 */
export const OFF_RAIL: ReadonlySet<string> = new Set(['first-run']);

// --- 3. The route registry: the route projection the router consumes -----------------------------

/** One routable path and the label its Placeholder shows until the surface lands. The router builds
 *  its route table from this list; it never reads NAV_TREE, so the rail can be rearranged freely. */
export interface RouteEntry {
  path: string;
  labelKey: string;
}

/** Every routable surface as a route, a pure projection of the catalog. */
export const ROUTE_REGISTRY: readonly RouteEntry[] = SURFACE_CATALOG.map((surface) => ({
  path: surface.path,
  labelKey: surface.labelKey,
}));

// --- The resolved rail (NAV_RAIL) and the flat leaf list (NAV_ITEMS), both derived ---------------

/**
 * A resolved rail LEAF: a tree leaf joined to its catalog surface. Carries `path`, `labelKey`, the
 * stable `navId`, and its glyph, which is PRESENT at the top level and ABSENT under a parent: the
 * indentation carries the hierarchy, and a second column of glyphs would make the rail a texture
 * rather than a list. Dropping the glyph on nested children is what keeps the rendered rail
 * byte-identical to the pre-split rail.
 */
export interface NavItem {
  navId: string;
  path: string;
  labelKey: string;
  icon?: NavIconName;
}

/** A resolved rail PARENT: its own label and glyph, plus its resolved children. */
export interface NavParent {
  navId: string;
  labelKey: string;
  icon: NavIconName;
  children: readonly NavItem[];
}

/** One resolved row: a destination or a parent holding destinations. */
export type NavNode = NavItem | NavParent;

/** A resolved GROUP: header (or null) and its resolved rows. */
export interface NavGroup {
  navId: string;
  labelKey: string | null;
  items: readonly NavNode[];
}

/** Narrow a resolved node to a parent. The discriminant is `children`, the field only a parent has. */
export function isNavParent(node: NavNode): node is NavParent {
  return (node as NavParent).children !== undefined;
}

/** Resolve one leaf against the catalog. `nested` drops the glyph, preserving the top-level-only
 *  glyph rule. Throws on an unknown `navId`: a tree leaf with no catalog surface is a defect the
 *  sync test also catches, but failing loudly at load is the belt to that test's braces. */
function resolveLeaf(node: NavTreeLeaf, nested: boolean): NavItem {
  const surface = SURFACE_BY_ID.get(node.navId);
  if (surface === undefined) {
    throw new Error(`nav tree references unknown surface navId: ${node.navId}`);
  }
  const item: NavItem = { navId: surface.navId, path: surface.path, labelKey: surface.labelKey };
  return nested ? item : { ...item, icon: surface.icon };
}

/**
 * Resolve a tree (the canonical one, or a future personalized one) into the render model the Shell
 * consumes. Exported so a later personalization layer can reuse it on a rearranged tree: the
 * resolution rules (glyph placement, catalog join) live in exactly one place.
 */
export function resolveNavTree(tree: readonly NavTreeGroup[]): readonly NavGroup[] {
  return tree.map((group) => ({
    navId: group.navId,
    labelKey: group.labelKey,
    items: group.items.map((node) =>
      isNavTreeParent(node)
        ? {
            navId: node.navId,
            labelKey: node.labelKey,
            icon: node.icon,
            children: node.children.map((child) => resolveLeaf(child, true)),
          }
        : resolveLeaf(node, false),
    ),
  }));
}

/** The resolved rail the Shell renders. */
export const NAV_RAIL: readonly NavGroup[] = resolveNavTree(NAV_TREE);

/**
 * Every DESTINATION, flattened in rail order, parents dissolved into their children in place. The
 * index redirect lands on `NAV_ITEMS[0]`, and the command palette and first-run on-ramp list these
 * in this order. Parents contribute nothing: they have no destination.
 */
export const NAV_ITEMS: readonly NavItem[] = NAV_RAIL.flatMap((group) =>
  group.items.flatMap((node) => (isNavParent(node) ? node.children : [node])),
);

/**
 * The path of the FIRST destination beneath a resolved group or parent: its first leaf, or, when the
 * first row is itself a nested parent, that parent's first leaf (recursing). This is the "natural
 * landing" a header navigates to on click (D135, owner request): a parent has no route of its own, so
 * clicking it opens its first child rather than a new "section landing" surface. It stays pathless in
 * the model (the sync test asserts a parent has no `path`); it merely BORROWS this child's route at
 * click time. Returns null only for the degenerate case of a group with no leaf anywhere beneath it,
 * which the canonical tree never contains (every group holds at least one leaf).
 */
export function firstLeafPath(node: NavGroup | NavParent): string | null {
  const rows: readonly NavNode[] = 'children' in node ? node.children : node.items;
  for (const row of rows) {
    if (isNavParent(row)) {
      const nested = firstLeafPath(row);
      if (nested !== null) return nested;
    } else {
      return row.path;
    }
  }
  return null;
}

// --- Active-route resolution: which leaf owns a URL, and which collapsible nodes hold it ----------

/** A leaf OWNS a pathname when the URL is the leaf's path or a segment beneath it (a detail route).
 *  This is what decides the active pill and the auto-expand chain, and it never touches routing. */
function leafOwnsPath(leafPath: string, pathname: string): boolean {
  return pathname === leafPath || pathname.startsWith(`${leafPath}/`);
}

/**
 * Resolve a URL to the rail node that owns it: the active leaf's navId and the set of COLLAPSIBLE
 * ancestor navIds (the headed group, and the parent when the leaf is nested) that must be expanded
 * for the active item to be visible. A headerless cluster contributes no ancestor, because it never
 * collapses. Returns an empty ancestor set and a null leaf when no leaf matches (a non-nav route).
 *
 * The longest matching leaf path wins, so `/documents/new` resolves to `/documents` and not to a
 * shorter accidental prefix. This is the one place the Shell learns, without reading routing, both
 * what to mark current and what to open.
 */
export function resolveActiveNav(pathname: string): { leafNavId: string | null; ancestors: Set<string> } {
  let bestLength = -1;
  let leafNavId: string | null = null;
  let ancestors: Set<string> = new Set();
  const consider = (leafPath: string, navId: string, anc: Set<string>): void => {
    if (!leafOwnsPath(leafPath, pathname)) return;
    if (leafPath.length > bestLength) {
      bestLength = leafPath.length;
      leafNavId = navId;
      ancestors = anc;
    }
  };
  for (const group of NAV_RAIL) {
    // A headerless cluster (labelKey null) never collapses, so it is not an ancestor to expand.
    const groupAncestor = group.labelKey === null ? [] : [group.navId];
    for (const node of group.items) {
      if (isNavParent(node)) {
        for (const child of node.children) {
          consider(child.path, child.navId, new Set([...groupAncestor, node.navId]));
        }
      } else {
        consider(node.path, node.navId, new Set(groupAncestor));
      }
    }
  }
  return { leafNavId, ancestors };
}
