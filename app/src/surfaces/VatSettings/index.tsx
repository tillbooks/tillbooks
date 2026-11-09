/**
 * Route entry for the VatSettings surface (A05, MWST config, nav `/vat`).
 *
 * Default export so the orchestrator can wire `/vat` in one line. Co-located CSS is imported here so
 * the styles load with the surface.
 */
import './VatSettings.css';
import { VatSettings } from './VatSettings';

export default VatSettings;
export { VatSettings };
