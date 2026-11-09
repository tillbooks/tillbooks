/**
 * WHAT "THE CURRENT VERSION" MEANS, defined exactly once.
 *
 * This is a one-line module because the predicate is the whole point. A version chain is linear and
 * append-only: `supersedes_id` points BACKWARDS at the row a version replaced, so a row is the HEAD
 * of its chain when nothing points at it. The tempting shorthand, `supersedes_id IS NULL`, means
 * something else entirely: it means "this is version 1", which is the OLDEST row in a chain of two and
 * the exact opposite of the head. Getting that wrong would show every list the superseded copy and
 * hide the current one, and it would do so silently on a one-version workspace, where the two
 * predicates agree.
 *
 * Every read that shows "the current file" and every guard that refuses to supersede a non-head row
 * resolves through here, so the two can never disagree.
 */

/**
 * SQL for "the row aliased `alias` is the head of its version chain".
 *
 * Correlated on the workspace as well as on the id (§H-TENANT): the chain check must not be answerable
 * by another tenant's row, and a shared id space is not a property to rely on.
 */
export function IS_HEAD(alias: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM stored_file successor
     WHERE successor.workspace_id = ${alias}.workspace_id AND successor.supersedes_id = ${alias}.id
  )`;
}
