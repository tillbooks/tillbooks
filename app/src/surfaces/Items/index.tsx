/**
 * Route entry for the Items surface (A09, invoicing-lite item master data).
 *
 * Default export so the orchestrator can wire `/items` in one line. Co-located CSS is imported here
 * so the styles load with the surface.
 */
// The destructive-confirm dialog is `Accounts/ConfirmDialog`, the shared one (the `DocumentEditor`
// precedent), and its `.acc-confirm*` rules live in `Accounts.css`. Importing the stylesheet here is
// what makes the dialog styled when `/items` is the first surface a session opens; these are plain
// global stylesheets, so loading it twice costs nothing and duplicating the rules would drift.
import '../Accounts/Accounts.css';
import './Items.css';
import { Items } from './Items';

export default Items;
export { Items };
