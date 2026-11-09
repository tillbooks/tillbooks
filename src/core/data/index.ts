/**
 * G04 data freedom, the public engine surface. `src/api/data-actions.ts` and `src/api/registry.ts`
 * import ONLY from here, so the module's internal split (portability vs catalog vs schema) is free to
 * change without touching the api layer.
 */

export {
  exportWorkspace,
  createBackup,
  listBackups,
  verifyBackup,
  restoreBackup,
  deleteBackup,
  BACKUP_KINDS,
  BACKUP_FORMATS,
  BACKUP_STATUSES,
} from './portability.js';
export type { PortDeps } from './portability.js';

export { listRestorableBackups } from './restorable.js';
export type { RestorableBackup } from './restorable.js';

export { getApiCatalog, TILL_VERSION } from './catalog.js';
export type { CatalogAction, CatalogInputSchema } from './catalog.js';

export { DATA_SCHEMA_SQL } from './schema.js';
