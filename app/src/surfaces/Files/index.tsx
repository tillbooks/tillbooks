/**
 * Route entry for the Dateien surface (E00, file management).
 *
 * Default export so the router wires `/files` in one line. Co-located CSS is imported here so the
 * styles load with the surface. `LinkedFiles` is exported too: it is the shared attachment panel any
 * entity detail view mounts, and it belongs to E00 rather than to the surfaces that will host it.
 */
import './Files.css';
import { Files } from './Files';

export default Files;
export { Files };
export { LinkedFiles } from './LinkedFiles';
export type { LinkedFilesProps } from './LinkedFiles';
