/**
 * A02, the double-entry journal: the single posting path and its reads.
 * Verbs are added here as they are built, test-first.
 */

export { postEntry } from './postEntry.js';
export type { LineInput, PostEntryInput } from './postEntry.js';
export { reverseEntry } from './reverseEntry.js';
export type { ReverseEntryInput } from './reverseEntry.js';
export { saveDraft, deleteDraft } from './draft.js';
export type { SaveDraftInput, DeleteDraftInput } from './draft.js';
export { getEntry, listJournal } from './reads.js';
export type { JournalFilter } from './reads.js';

// A03, audit trail & period locks: the real ports A02 consumes, plus the period/close/log verbs.
export { appendAuditLog, getAuditLog, makeAuditPort, AUDIT_ACTIONS } from './auditLog.js';
export type { AuditDeps, AuditLogFilter } from './auditLog.js';
export {
  assertPeriodOpen,
  makePeriodPort,
  softCloseMonth,
  reopenMonth,
  lockPeriod,
  unlockPeriod,
  listPeriodLocks,
  fiscalYearOf,
  PERIOD_LOCK_KINDS,
  SEALED_LOCK_REASONS,
} from './periods.js';
export type { PeriodDeps } from './periods.js';
export { hardCloseYear } from './yearClose.js';

// A04, opening balances: the position every statement above this one is measured from.
export {
  setOpeningBalances,
  getOpeningBalances,
  OPENING_CONTRA_ACCOUNT_NUMBER,
  OPENING_KEY_PREFIX,
} from './openingBalances.js';
export type { OpeningLineInput, SetOpeningBalancesInput } from './openingBalances.js';
export { importMigration, parseSwissAmount } from './importMigration.js';
export type { ImportMapping, ImportMigrationInput } from './importMigration.js';

import type { SqliteStore } from '../store/sqlite-store.js';
import type { IdGen } from '../ids.js';
import type { PeriodPort, AuditPort } from '../ports.js';
import { makePeriodPort } from './periods.js';
import { makeAuditPort } from './auditLog.js';

/**
 * The real A03 ports for a wired ledger context: the period-lock guard A02 honours and the
 * hash-chained audit stamp it records through. A00 `createWorkspace`, the MCP/REST server (Phase E),
 * and the A03 tests build their `WorkspaceContext` with `...ledgerPorts({ store, workspaceId, ids })`;
 * the A02 unit tests keep the permissive stubs (`allPeriodsOpen` / `noAudit`).
 */
export function ledgerPorts(deps: { store: SqliteStore; workspaceId: string; ids: IdGen }): {
  periods: PeriodPort;
  audit: AuditPort;
} {
  return {
    periods: makePeriodPort({ store: deps.store, workspaceId: deps.workspaceId }),
    audit: makeAuditPort({ store: deps.store, workspaceId: deps.workspaceId, ids: deps.ids }),
  };
}
