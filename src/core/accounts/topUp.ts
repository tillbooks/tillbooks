/**
 * A01, the idempotent seed top-up: give a workspace the KMU seed accounts it lacks, by number, and
 * touch nothing it already has.
 *
 * `createWorkspace` seeds the whole chart at birth, and until 2026-09-09 that was the ONLY moment
 * the seed was ever consulted: a workspace born before A38 added 2330, 3809 and 8900 to the seed
 * never received them, and `tax_provision_preview` read `missingAccounts` forever on a book that
 * had done nothing wrong. This helper is the one path both callers share: the birth seed (every
 * number) and the data migration in `../store/migrations.ts` (the numbers a generation introduced).
 *
 * It deliberately runs on a store migration and on no READ path: a read verb advertises
 * `readOnlyHint` and the conformance gate snapshots the whole database around it, so a read that
 * quietly seeds is a lie to every caller that trusted the hint (see `listRoles` in
 * `../access/roles.ts` for the round that proved it).
 *
 * A leaf on purpose: it imports only the seed data and types, because `migrations.ts` is imported
 * by the store class and anything heavier here would be a runtime cycle.
 */

import type { Database } from 'better-sqlite3';

import type { IdGen } from '../ids.js';
import { KMU_CORE_SEED } from './kmuSeed.js';

export interface TopUpChartOptions {
  /** Restrict the top-up to these seed numbers; every seed number when absent. */
  readonly numbers?: readonly string[];
}

/**
 * Insert every seed account of `numbers` (default: the whole seed) the workspace has no row for.
 * `INSERT ... WHERE NOT EXISTS` per row, so a rerun is free, and an existing row (renamed, archived,
 * re-typed by an earlier chart) is never overwritten. Returns the numbers it added, in seed order.
 */
export function topUpChartOfAccounts(db: Database, workspaceId: string, ids: IdGen, options: TopUpChartOptions = {}): { added: string[] } {
  const wanted = options.numbers === undefined ? undefined : new Set(options.numbers);
  const insert = db.prepare(
    `INSERT INTO account (id, workspace_id, number, name, type, cost_center_allowed)
     SELECT ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM account WHERE workspace_id = ? AND number = ?)`,
  );
  const added: string[] = [];
  for (const account of KMU_CORE_SEED) {
    if (wanted !== undefined && !wanted.has(account.number)) continue;
    const result = insert.run(
      ids.next('acc'),
      workspaceId,
      account.number,
      account.name,
      account.type,
      account.costCenterAllowed ? 1 : 0,
      workspaceId,
      account.number,
    );
    if (result.changes === 1) added.push(account.number);
  }
  return { added };
}
