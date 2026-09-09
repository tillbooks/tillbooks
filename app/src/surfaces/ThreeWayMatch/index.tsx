/**
 * Route entry for Einkauf -> Abgleich-Ausnahmen (I04). Default export so the router wires
 * `/three-way-match` in one line. The panel is exported too so A17 / I01 detail surfaces can embed it.
 */
import { ThreeWayMatch } from './ThreeWayMatch';

export default ThreeWayMatch;
export { ThreeWayMatch };
export { ThreeWayMatchPanel } from './ThreeWayMatchPanel';
