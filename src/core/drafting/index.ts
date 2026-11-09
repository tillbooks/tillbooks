/**
 * E06, ledger-grounded drafts: the barrel `src/api/` imports from.
 *
 * `purgeDraftRunsForContact` is exported for C00's `contacts_anonymise` (called INSIDE that verb's
 * transaction, BEFORE the E04 mail purge, and deliberately not an MCP tool of its own, the
 * E04/E05 shape); `buildDraftContext` and `formatAmount` are exported pure for the property tests;
 * the schema constants feed the store and the guard suites.
 */

export {
  generateDraft,
  regenerateDraft,
  listDraftRuns,
  buildDraftContext,
  formatAmount,
  purgeDraftRunsForContact,
} from './draft.js';
export type {
  GenerateDraftInput,
  RegenerateDraftInput,
  ListDraftRunsInput,
  DraftContextInput,
} from './draft.js';
export { DRAFT_RUN_STATUSES, isDraftRunStatus } from './enums.js';
export type { DraftRunStatus } from './enums.js';
export { DRAFTING_SCHEMA_SQL, DRAFTING_TABLES } from './schema.js';
