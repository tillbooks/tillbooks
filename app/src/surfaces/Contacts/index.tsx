/**
 * Route entry for the Contacts surface (A09, customers & vendors, the contacts half).
 *
 * Default export so the orchestrator can wire `/contacts` in one line. Co-located CSS is imported
 * here so the styles load with the surface.
 */
import './Contacts.css';
import { Contacts } from './Contacts';

export default Contacts;
export { Contacts };
