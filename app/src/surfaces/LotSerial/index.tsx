/**
 * Route entry for the Inventory -> Lot & Serial Tracking surface (J01). Default export so the router
 * wires `/lot-serial-tracking` in one line. Co-located CSS imported here so the styles load with the
 * surface.
 */
import './LotSerial.css';
import { LotSerial } from './LotSerial';

export default LotSerial;
export { LotSerial };
