/**
 * The REAL engine behind `compose_entry`, for the Journal composer's component suites (D152 amendment).
 *
 * WHY A REAL ENGINE AND NOT A STAND-IN. The composer was rebuilt because a Studio-side copy of the VAT
 * derivation drifted from the engine by a Rappen, three critic rounds in a row. A stand-in `compose_entry`
 * in the suites would be exactly that copy again, only in the test tree. So the suites answer
 * `compose_entry` with the engine itself: an in-memory book seeded the way `createWorkspace` and
 * `configureVat` seed every workspace, whose account ids (`acc_1`...) are the ones the recorded
 * `list_accounts` fixture carries, and the drawer under test is held to what the ENGINE composes.
 *
 * WHY IT LIVES OUTSIDE `app/src`. It reaches `better-sqlite3`, which a browser cannot load, and
 * `test/style/studio-sees-payloads.test.mjs` holds every committed source under `app/src` to "nothing the
 * Studio pulls in at runtime reaches Node-only code". A test-only harness is never bundled, so it sits
 * beside the sources rather than among them, and that guard keeps meaning what it says. Vitest runs in
 * Node, where the engine loads as it does under `till up`.
 *
 * `compose_entry` is a READ, so one book per method serves a whole suite. Every figure is synthetic.
 */
import { SqliteStore } from '../../src/core/store/sqlite-store.js';
import { makeContext } from '../../src/core/context.js';
import { fixedClock } from '../../src/core/clock.js';
import { sequenceIdGen } from '../../src/core/ids.js';
import { createWorkspace } from '../../src/core/setup/index.js';
import { configureVat } from '../../src/core/vat/index.js';
import { ledgerPorts } from '../../src/core/ledger/index.js';
import { composeEntry, type ComposeEntryInput } from '../../src/core/ledger/compose.js';
import type { RestResponse } from '../src/lib/client';

export interface ComposeEngineOptions {
  /** The VAT method the book is configured with; saldo makes input VAT and Bezugsteuer non-deductible. */
  method?: 'effektiv' | 'saldo';
  /** Cost centres the suites name by id (`cc_1`), inserted as the book's own. */
  costCenters?: readonly { id: string; code: string; name: string }[];
  /** Months to soft-lock (`YYYY-MM`), so the verdict says `period_locked` as `post_entry` would. */
  lockedMonths?: readonly string[];
  /** Account numbers the chart lacks (a book without 1170, say), removed from the seeded chart. */
  withoutAccounts?: readonly string[];
}

const AT = '2026-07-16T00:00:00.000Z';
const books = new Map<string, ReturnType<typeof makeContext>>();

function book(options: ComposeEngineOptions): ReturnType<typeof makeContext> {
  const key = JSON.stringify(options);
  const known = books.get(key);
  if (known !== undefined) return known;
  const clock = fixedClock(AT);
  const store = new SqliteStore({ clock });
  const ids = sequenceIdGen();
  const minted = createWorkspace({ store, clock, ids }, { name: 'Acme GmbH' });
  if (!minted.ok) throw new Error(`composeEngine: createWorkspace failed: ${JSON.stringify(minted)}`);
  const workspaceId = (minted as unknown as { workspaceId: string }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids, ...ledgerPorts({ store, workspaceId, ids }) });
  const method = options.method ?? 'effektiv';
  configureVat(ctx, {
    method,
    timing: 'soll',
    registered: true,
    idempotencyKey: 'cfg1',
    ...(method === 'saldo' ? { saldoRates: [{ rateBp: 620 }] } : {}),
  });
  for (const cc of options.costCenters ?? [{ id: 'cc_1', code: 'K1', name: 'Vertrieb' }]) {
    store.db.prepare('INSERT INTO cost_center (id, workspace_id, code, name) VALUES (?, ?, ?, ?)').run(cc.id, workspaceId, cc.code, cc.name);
  }
  for (const month of options.lockedMonths ?? []) {
    store.db
      .prepare("INSERT INTO period_lock (workspace_id, period, kind, reason, locked_at, locked_by) VALUES (?, ?, 'soft', NULL, ?, 'user_1')")
      .run(workspaceId, month, AT);
  }
  for (const number of options.withoutAccounts ?? []) {
    store.db.prepare('DELETE FROM account WHERE workspace_id = ? AND number = ?').run(workspaceId, number);
  }
  books.set(key, ctx);
  return ctx;
}

/** A transport handler answering `compose_entry` with the real engine, in the REST twin's status mapping. */
export function composeEngine(options: ComposeEngineOptions = {}): (input: Record<string, unknown>) => RestResponse {
  return (input) => {
    const ctx = book(options);
    // The suites answer `get_entry` with a canned draft the book never saw. A request naming that draft
    // (`entryId`, the promotion `post_entry` would make) finds it here as the draft the suite says it is,
    // so the verdict is the one a real book holding that draft gives, never a `not_found` of the harness.
    if (typeof input.entryId === 'string') {
      ctx.store.db
        .prepare(
          `INSERT OR IGNORE INTO journal_entry (id, workspace_id, date, status, idempotency_key, source, created_by, created_at)
           VALUES (?, ?, '2026-01-01', 'draft', ?, 'manual', 'user_1', ?)`,
        )
        .run(input.entryId, ctx.workspaceId, `suite-draft-${input.entryId}`, AT);
    }
    const result = composeEntry(ctx, input as unknown as ComposeEntryInput);
    return { status: result.ok ? 200 : 422, body: result as unknown as RestResponse['body'] };
  };
}
