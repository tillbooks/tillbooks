/**
 * D177 (A39 §16.1, critic D177-C6): the drafted actions whose approval replay is running RIGHT NOW in this
 * process. A bank-line decision resolves every other pending Vorschlag for its line ("Zeile entschieden",
 * `resolveLineDraftsOnDecision` in `../banking/bankLines.ts`), and it must never resolve the very draft
 * whose approval is making the decision: that row's commit mark would then find it rejected and roll the
 * approved booking back. No imports, so the banking module can read it without a cycle.
 */

/** Per id, how many approval replays of it are running (critic D177 round 2: a nested approval of the same
 * id keeps the exclusion until the OUTERMOST one ends). */
const approving = new Map<string, number>();

/** Run `fn` (an approval's replay) with `actionId` marked as being approved. */
export function withApproving<T>(actionId: string, fn: () => T): T {
  approving.set(actionId, (approving.get(actionId) ?? 0) + 1);
  try {
    return fn();
  } finally {
    const depth = (approving.get(actionId) ?? 1) - 1;
    if (depth <= 0) approving.delete(actionId);
    else approving.set(actionId, depth);
  }
}

/** The ids whose approval replay is running now (usually none, at most a few nested). */
export function approvingActionIds(): string[] {
  return [...approving.keys()];
}
