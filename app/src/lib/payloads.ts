/**
 * The engine's DECLARED success payloads, as the DISPATCHER binds them to wire action names.
 *
 * WHAT THIS IS FOR. `src/core/result.ts` used to declare one open success shape for every verb:
 * `{ ok: true }` plus `[key: string]: unknown`. Nothing anywhere stated what a verb sends back, so
 * `body.entryId` type-checked no matter what the engine actually sent, and renaming a ledger field
 * left `tsc` green across `src/`, the MCP layer, the suites and the Studio while the drawer rendered
 * `undefined`. That is this repo's longest-running defect family, "the Studio assumed a shape the
 * engine never sends", and one member rendered "1000 undefined" in a live browser with its unit test
 * green.
 *
 * `Ok<T>` / `Result<T>` closed it per verb in the engine. This file is how the Studio inherits that,
 * and it now inherits BOTH halves rather than one.
 *
 * WHAT CHANGED, AND WHY THE ACTION NAME IS NO LONGER WRITTEN HERE. Until 2026-07-26 this file read:
 *
 *     export interface ActionPayloads {
 *       post_entry: PayloadOf<typeof postEntry>;
 *     }
 *
 * The VALUE side was derived from the verb's own signature, but the wire NAME was bound by hand, and
 * the comment beside it said exactly why: `ActionDef.run` in `src/api/registry.ts` was typed
 * `(deps, input) => Result`, the OPEN one, so the dispatcher both surfaces go through erased every
 * declared payload on its way to the wire. There was nothing to derive the mapping FROM. The gap that
 * left is narrow and real: a rename inside the payload reddened the Studio, but an action re-pointed
 * to a different verb, or a verb re-pointed to a different action name, was invisible here. The
 * Studio would have gone on type-checking against a payload the wire no longer sends, which is the
 * defect family's shape one level up from where it was found six times.
 *
 * `ActionDef` is now `ActionDef<N, T>`: the tool name is a literal on the type and `run` returns the
 * declared `Result<T>`. `ActionResults` in the registry maps one to the other, off the definitions
 * themselves. So this file states no binding at all any more, and there is nothing here that can
 * disagree with the dispatcher.
 *
 * TYPE-ONLY, ALWAYS. Every import here is `import type`, which the compiler erases: nothing the
 * Studio pulls in at runtime may reach Node-only code, and `src/api/registry.ts` reaches
 * `better-sqlite3` in one hop. `test/style/studio-sees-payloads.test.mjs` compiles the real emitted
 * JS and fails if any engine module ever reaches it.
 *
 * ADDING A VERB. Nothing happens here. Declare the payload on the verb, add its action to
 * `DECLARED_ACTIONS` in `src/api/registry.ts`, and it appears below. The one line still owed is in
 * `REQUIRED_FIELDS`, which is a statement about what the STUDIO insists on, not about the engine.
 */
import type { ActionResults } from '../../../src/api/registry';

/**
 * Wire action name to the payload that action answers with.
 *
 * An interface extending the registry's derived map rather than a type alias for it, so this stays
 * one named, greppable declaration with a doc comment on it, and so the counting guard in
 * `test/style/studio-sees-payloads.test.mjs` keeps reading the same thing it always read. It adds no
 * members of its own, which is the entire point: every key and every payload below is the
 * dispatcher's, and a binding this file cannot state is a binding this file cannot get wrong.
 */
export interface ActionPayloads extends ActionResults {}

/** The success payload of `post_entry`, as the action itself declares it. */
export type PostEntryOk = ActionPayloads['post_entry'];

/** The keys of `T` that are not optional. `entryId` is one; the three FX fields are not. */
type RequiredKeys<T> = { [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? never : K }[keyof T];

/**
 * The fields a canned success for each action must actually carry, checked at runtime by
 * `cannedOk` in `./test-support`.
 *
 * `satisfies` is doing the load-bearing work: the entries are constrained to the payload's REQUIRED
 * keys, so renaming `entryId` in the engine makes the string `'entryId'` below a compile error, and
 * so does naming a field that is optional or does not exist. This is the shortest statement of the
 * whole point of this file: a field name written down in the Studio is now judged by the engine.
 *
 * TOTAL over `ActionPayloads`, not partial. Declaring a payload in the engine therefore costs one
 * line here, and that is deliberate: `cannedOk` reads this list for whatever action it is handed, so
 * an action present in the map and absent from this list would be a canned success nothing checks.
 */
export const REQUIRED_FIELDS = {
  post_entry: ['entryId'],
  // `reversalId`, NOT `entryId`. The reversal answers with the id of the MIRROR entry, and the two
  // neighbouring verbs in the same list answer with `entryId`, so this is exactly the pairing the
  // Studio used to be free to get wrong. Written here, it is judged by the engine.
  reverse_entry: ['reversalId'],
  save_draft: ['entryId'],
  get_entry: ['entry', 'lines'],
  list_journal: ['entries'],
  // `locks`, and only `locks`. The two names that are NOT here are the point: `canManage` and
  // `canUnlock` were read off this response by `Periods.tsx` and have never been sent by anything.
  // Writing either one below is now a compile error, which is the shortest demonstration that a
  // field name written down in the Studio is judged by the engine.
  list_period_locks: ['locks'],
} as const satisfies { [A in keyof ActionPayloads]: readonly RequiredKeys<ActionPayloads[A]>[] };
