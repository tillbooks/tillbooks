/**
 * Route entry for the Einkauf -> Bestellversionen surface (I01, OP14 PO versioning + amendment).
 *
 * Default export so the router wires `/po-versions` in one line. Co-located CSS imported here so the
 * styles load with the surface.
 */
import './PurchaseVersions.css';
import { PurchaseVersions } from './PurchaseVersions';

export default PurchaseVersions;
export { PurchaseVersions };
