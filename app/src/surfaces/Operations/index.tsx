/**
 * Betrieb (Operations) surface entry point.
 *
 * Wired at `/operations` (nav item `nav.operations`) with a one-liner:
 *   import Operations from './surfaces/Operations';
 *   { path: 'operations', element: <Operations /> }
 *
 * The default export is the composed surface (trust + runtime line + sync/hosting + data & backup +
 * implementation roster + diagnostics). The panels stay exported by name, because the router is not
 * the only caller: each panel's test suite renders it directly.
 */
import { Operations } from './Operations';
import { Trust } from './Trust';
import { SyncHosting } from './SyncHosting';
import { DataBackup } from './DataBackup';
import { ImplementationRoster } from './ImplementationRoster';
import { Diagnostics } from './Diagnostics';

export default Operations;
export { Operations, Trust, SyncHosting, DataBackup, ImplementationRoster, Diagnostics };
