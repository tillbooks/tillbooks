/**
 * Route entry for the Fixed Assets -> Categories surface (H00, asset categories & defaults).
 *
 * Default export so the router wires `/asset-categories` in one line. Co-located CSS imported here so
 * the styles load with the surface.
 */
import './FixedAssets.css';
import { AssetCategories } from './AssetCategories';
import { AssetRegister } from './AssetRegister';
import { AssetDepreciation } from './AssetDepreciation';
import { AssetLocations } from './AssetLocations';
import { AssetDepreciationRuns } from './AssetDepreciationRuns';
import { AssetReconciliation } from './AssetReconciliation';
import { AssetMaintenance } from './AssetMaintenance';

export default AssetCategories;
export { AssetCategories, AssetRegister, AssetDepreciation, AssetLocations, AssetDepreciationRuns, AssetReconciliation, AssetMaintenance };
