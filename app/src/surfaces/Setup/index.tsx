/**
 * Setup surface entry point.
 *
 * Wired at `/setup` (nav item `nav.setup`) with a one-liner:
 *   import Setup from './surfaces/Setup';
 *   { path: 'setup', element: <Setup /> }
 *
 * The default export is the composed surface, which after the K-16 split is the Firmenprofil face
 * (company profile plus the Arbeitsbereiche list). `CompanyProfile` stays exported by name, because
 * the router is not the only caller: its own test suite renders it directly. The operational panels
 * moved to the Betrieb surface at `/operations`.
 */
import { Setup } from './Setup';
import { CompanyProfile } from './CompanyProfile';

export default Setup;
export { Setup, CompanyProfile };
