/**
 * Route entry for the Accounts surface (A01, chart of accounts).
 *
 * Default export so the orchestrator can wire `/accounts` in one line. Co-located CSS is imported
 * here so the styles load with the surface.
 */
import './Accounts.css';
import { Accounts } from './Accounts';

export default Accounts;
export { Accounts };
