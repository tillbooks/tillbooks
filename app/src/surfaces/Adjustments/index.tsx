/**
 * Route entry for the Inventory -> Adjustments / Bestandeskorrekturen surface (J05). Default export so
 * the router wires `/inventory-adjustments` in one line. Co-located CSS imported here so the styles
 * load with the surface.
 */
import './Adjustments.css';
import { Adjustments } from './Adjustments';

export default Adjustments;
export { Adjustments };
