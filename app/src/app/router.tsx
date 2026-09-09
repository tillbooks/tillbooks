/**
 * The Studio router.
 *
 * One layout route (the Shell) wraps one route per surface. `/` redirects to the first rail surface.
 * The route table is derived from the ROUTE_REGISTRY (the route projection of the surface catalog),
 * NOT from the rail tree: the router never reads NAV_TREE, so the rail can be reordered, collapsed or
 * favourited without touching routing. The registry and the tree are kept in sync by
 * `nav-shape.test.ts`. A built surface has its real component in SURFACES; the rest fall back to the
 * Placeholder until they land (each surface is wired here as a one-line entry when the orchestrator
 * cherry-picks it).
 */
import { createBrowserRouter, Navigate, type RouteObject } from 'react-router-dom';
import type { ReactElement } from 'react';

import { RouteCrash } from './ErrorBoundary';
import { Shell } from './Shell';
import { Placeholder } from './Placeholder';
import { NAV_ITEMS, ROUTE_REGISTRY } from './nav';
import { NotFound } from './NotFound';
import { WorkspaceRoute, WorkspaceSurfaceRoute } from './workspace';
import { installMotionNavigation } from '../lib/motion';

import Setup from '../surfaces/Setup';
import Operations from '../surfaces/Operations';
import Members from '../surfaces/Members';
import Customization from '../surfaces/Customization';
import Automations from '../surfaces/Automations';
import Extensions from '../surfaces/Extensions';
import Accounts from '../surfaces/Accounts';
import Journal from '../surfaces/Journal';
import Contacts from '../surfaces/Contacts';
import Items from '../surfaces/Items';
import Files from '../surfaces/Files';
import Periods from '../surfaces/Periods';
import VatSettings from '../surfaces/VatSettings';
import Documents from '../surfaces/Documents';
import Payments from '../surfaces/Payments';
import OpenItems from '../surfaces/OpenItems';
import Dunning from '../surfaces/Dunning';
import Bills from '../surfaces/Bills';
import CaptureInbox from '../surfaces/Capture';
import BankAccounts from '../surfaces/BankAccounts';
import CreditorPayments from '../surfaces/CreditorPayments';
import Reconciliation from '../surfaces/Reconciliation';
import Reports from '../surfaces/Reports';
import VatReturn from '../surfaces/VatReturn';
import Fx from '../surfaces/Fx';
import Recurring from '../surfaces/Recurring';
import Migration from '../surfaces/Migration';
import Environments from '../surfaces/Environments';
import Projects from '../surfaces/Projects';
import Time from '../surfaces/Time';
import Inventory from '../surfaces/Inventory';
import Tasks from '../surfaces/Tasks';
import Attention from '../surfaces/Attention';
import Checklists from '../surfaces/Checklists';
import Correspondence from '../surfaces/Correspondence';
import WritingStyle from '../surfaces/WritingStyle';
import DocumentTemplates from '../surfaces/DocumentTemplates';
import Dispatch from '../surfaces/Dispatch';
import Deals from '../surfaces/Deals';
import Forecast from '../surfaces/Forecast';
import Quotes from '../surfaces/Quotes';
import SalesOrders from '../surfaces/SalesOrders';
import Purchasing from '../surfaces/Purchasing';
import Hr from '../surfaces/Hr';
import Uebersicht from '../surfaces/Uebersicht';
import ReportBuilder from '../surfaces/ReportBuilder';
import Onboarding from '../surfaces/Onboarding';
import FirstRun from '../surfaces/FirstRun';
import Search from '../surfaces/Search';
import AssetCategories from '../surfaces/FixedAssets';
import AssetRegister from '../surfaces/FixedAssets/AssetRegister';
import Requisitions from '../surfaces/Requisitions';
import Agent from '../surfaces/Agent';
import PurchaseVersions from '../surfaces/PurchaseVersions';
import Warehouses from '../surfaces/Warehouses';
import AssetDepreciation from '../surfaces/FixedAssets/AssetDepreciation';
import AssetLocations from '../surfaces/FixedAssets/AssetLocations';
import AssetDepreciationRuns from '../surfaces/FixedAssets/AssetDepreciationRuns';
import AssetReconciliation from '../surfaces/FixedAssets/AssetReconciliation';
import AssetMaintenance from '../surfaces/FixedAssets/AssetMaintenance';
import AssetReports from '../surfaces/FixedAssets/AssetReports';
import LotSerial from '../surfaces/LotSerial';
import InventoryMovements from '../surfaces/InventoryMovements';
import GoodsReceipt from '../surfaces/GoodsReceipt';
import LandedCosts from '../surfaces/LandedCosts';
import ThreeWayMatch from '../surfaces/ThreeWayMatch';
import ProcurementAnalytics from '../surfaces/ProcurementAnalytics';
import InventoryValuation from '../surfaces/InventoryValuation';
import ValuationRuns from '../surfaces/ValuationRuns';
import CycleCounts from '../surfaces/CycleCounts';
import Adjustments from '../surfaces/Adjustments';
import ReasonCodes from '../surfaces/ReasonCodes';
import InventoryAlerts from '../surfaces/InventoryAlerts';
import Review from '../surfaces/Review/Review';
import Export from '../surfaces/Review/Export';

/** Built surfaces, keyed by their route path. Unlisted paths render the Placeholder. */
const SURFACES: Record<string, ReactElement> = {
  '/overview': <Uebersicht />,
  '/search': <Search />,
  '/agent': <Agent />,
  '/setup': <Setup />,
  '/operations': <Operations />,
  '/members': <Members />,
  '/customization': <Customization />,
  '/automations': <Automations />,
  '/extensions': <Extensions />,
  '/accounts': <Accounts />,
  '/journal': <Journal />,
  '/periods': <Periods />,
  '/vat': <VatSettings />,
  '/mwst': <VatReturn />,
  '/fx': <Fx />,
  '/contacts': <Contacts />,
  '/items': <Items />,
  '/files': <Files />,
  '/documents': <Documents />,
  '/payments': <Payments />,
  '/open-items': <OpenItems />,
  '/dunning': <Dunning />,
  '/bills': <Bills />,
  '/capture-inbox': <CaptureInbox />,
  '/bank-accounts': <BankAccounts />,
  '/creditor-payments': <CreditorPayments />,
  '/reconciliation': <Reconciliation />,
  '/reports': <Reports />,
  '/report-builder': <ReportBuilder />,
  '/recurring': <Recurring />,
  '/migration': <Migration />,
  '/environments': <Environments />,
  '/onboarding': <Onboarding />,
  '/first-run': <FirstRun />,
  '/projects': <Projects />,
  '/time': <Time />,
  '/personal': <Hr />,
  '/inventory': <Inventory />,
  '/tasks': <Tasks />,
  '/attention': <Attention />,
  '/checklisten': <Checklists />,
  '/correspondence': <Correspondence />,
  '/writing-style': <WritingStyle />,
  '/document-templates': <DocumentTemplates />,
  '/dispatch': <Dispatch />,
  '/deals': <Deals />,
  '/forecast': <Forecast />,
  '/quotes': <Quotes />,
  '/sales-orders': <SalesOrders />,
  '/purchasing': <Purchasing />,
  '/asset-categories': <AssetCategories />,
  '/assets': <AssetRegister />,
  '/requisitions': <Requisitions />,
  '/po-versions': <PurchaseVersions />,
  '/warehouses': <Warehouses />,
  '/depreciation': <AssetDepreciation />,
  '/asset-locations': <AssetLocations />,
  '/depreciation-runs': <AssetDepreciationRuns />,
  '/asset-reconciliation': <AssetReconciliation />,
  '/asset-maintenance': <AssetMaintenance />,
  '/asset-reports': <AssetReports />,
  '/lot-serial-tracking': <LotSerial />,
  '/inventory-movements': <InventoryMovements />,
  '/goods-receipts': <GoodsReceipt />,
  '/landed-costs': <LandedCosts />,
  '/three-way-match': <ThreeWayMatch />,
  '/procurement-analytics': <ProcurementAnalytics />,
  '/inventory-valuation': <InventoryValuation />,
  '/inventory-valuation-runs': <ValuationRuns />,
  '/cycle-counts': <CycleCounts />,
  '/inventory-adjustments': <Adjustments />,
  '/inventory-reason-codes': <ReasonCodes />,
  '/inventory-alerts': <InventoryAlerts />,
  '/review': <Review />,
  '/export': <Export />,
};

/**
 * The paths that resolve to a REAL built surface (not the Placeholder). Exported so G15's
 * `Attention.routes.test.tsx` can prove every attention provider's deep link opens a built surface,
 * which is the app-side half of the engine's registration guard (design story 2.3): a hub row can
 * never reach a Placeholder.
 */
export const BUILT_SURFACE_PATHS: readonly string[] = Object.keys(SURFACES);

const surfaceRoutes: RouteObject[] = ROUTE_REGISTRY.map((entry) => ({
  // The path is stored with a leading slash in the registry; the child route wants it relative.
  // Documents owns a nested route tree (list / new / :id), so it mounts with a splat and resolves
  // its own sub-routes internally. Payments does the same for `/payments/new`, the P21 handover.
  path: ['/documents', '/payments'].includes(entry.path)
    ? `${entry.path.replace(/^\//, '')}/*`
    : entry.path.replace(/^\//, ''),
  element: SURFACES[entry.path] ?? <Placeholder titleKey={entry.labelKey} />,
  // Per surface, so a crash keeps the rail and the user can navigate away from the broken screen
  // instead of losing the whole application to it.
  errorElement: <RouteCrash />,
}));

export const routes: RouteObject[] = [
  // D12: `/w/:workspaceId` is the linkable, bookmarkable way into one set of books. It selects the
  // workspace and redirects into the app, so it sits OUTSIDE the Shell (it renders no chrome of its
  // own). Reloading a surface path restores the workspace from localStorage instead.
  { path: '/w/:workspaceId', element: <WorkspaceRoute />, errorElement: <RouteCrash /> },
  // K-10: a shared per-workspace deep link (`/w/ws_1/payments`) adopts the workspace and redirects
  // to the surface, so a colleague's link opens the right screen in the right books. Without this
  // splat the shape had no match and the router 404 raised into RouteCrash.
  { path: '/w/:workspaceId/*', element: <WorkspaceSurfaceRoute />, errorElement: <RouteCrash /> },
  {
    path: '/',
    element: <Shell />,
    // The Shell itself throwing takes the rail with it, so this one renders bare. It is the last
    // stop inside the router; the class boundary in main.tsx catches anything outside it.
    errorElement: <RouteCrash />,
    children: [
      { index: true, element: <Navigate to={NAV_ITEMS[0].path} replace /> },
      ...surfaceRoutes,
      // K-10, US-G16.9: an address the router does not know is a detour in plain words, never the
      // crash screen. RouteCrash stays what it is, the panel for a route that THREW.
      { path: '*', element: <NotFound />, errorElement: <RouteCrash /> },
    ],
  },
];

export const router = createBrowserRouter(routes);

// The Navigate moment (D122 D-I), wired ONCE: every move between two rail surfaces swaps with
// flushSync and then enters the new surface live (200 ms from 8 px on the travel side); the
// registry order decides forward from back. A same-surface move, a redirect and a path outside
// the rail run bare. No view transition: measured to hold and drop the pointer (see motion.ts).
installMotionNavigation(
  router,
  ROUTE_REGISTRY.map((entry) => entry.path),
);
