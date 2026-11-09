/**
 * C01's write wrapper: §H-IDEMPOTENT without memoising failure, atomic either way.
 *
 * `rememberIdempotent` stores whatever its compute returns, INCLUDING an `Err`. For a verb whose
 * run can fail on state a caller will then repair (a missing FX rate, a permission the delegated
 * quote verb refuses), memoising the failure would make the repaired retry under the SAME key
 * replay the stale refusal forever. So a failing run THROWS a private carrier instead: the
 * surrounding transaction rolls back every partial write (the OP5 note a failed reminder would
 * otherwise strand, the seeded pipeline of a failed create), nothing is remembered, and the caller
 * gets the same `Err` value P9 promises. The unkeyed path gets the same atomicity through a bare
 * `tx`, the `createDocument` shape; better-sqlite3 nests inner transactions as savepoints, so a
 * delegated verb's own keyed write composes.
 */

import type { WorkspaceContext } from '../context.js';
import type { Err, Result } from '../result.js';

class RolledBack extends Error {
  constructor(readonly outcome: Err) {
    super(`rolled back: ${outcome.error}`);
  }
}

export function idempotentWrite(
  ctx: WorkspaceContext,
  verb: string,
  key: string | undefined,
  run: () => Result,
): Result {
  const attempt = (): Result => {
    const outcome = run();
    if (!outcome.ok) throw new RolledBack(outcome);
    return outcome;
  };
  try {
    if (typeof key === 'string' && key.length > 0) {
      return ctx.store.rememberIdempotent(ctx.workspaceId, key, verb, attempt);
    }
    return ctx.store.tx(attempt);
  } catch (e) {
    if (e instanceof RolledBack) return e.outcome;
    throw e;
  }
}
