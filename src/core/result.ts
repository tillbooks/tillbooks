/**
 * Structured results (Pattern P9).
 *
 * Every engine verb returns either `{ ok: true, ... }` or `{ ok: false, error: <code>, ... }`.
 * A rejection is never a thrown 500 and never a silent no-op: it is a value the caller can read,
 * the MCP tool can serialise, and the GUI can turn into an honest error state.
 *
 * WHY THE SUCCESS PAYLOAD IS GENERIC.
 *
 * `Ok` used to be one open shape: `{ ok: true }` plus `[key: string]: unknown`. Every verb returned
 * it, so `postEntry(...).entryId` was `unknown` to the suites, to the MCP layer and to the Studio
 * alike, and NOTHING anywhere stated what a verb actually sends back. That is the structural root of
 * this repo's longest-running defect family, "the Studio assumed a shape the engine never sends":
 * renaming `entryId` to `journalEntryId` inside `postEntry` kept `tsc` green across `src/`, the MCP
 * layer, the Studio and every suite, while the drawer rendered `undefined` at runtime. Members found
 * that way include a picker rendering "1000 undefined" in a live browser with its unit test green.
 *
 * So a verb may now DECLARE its success payload (`Result<PostEntryOk>`), and a declared payload is a
 * closed object type: reading a field it does not carry is TS2339, at the call site, in `src/`, in
 * the Studio, and in any `// @ts-check` suite. `test/style/result-payload-is-declared.test.mjs`
 * re-proves that against the real compiler options on every run, so the mechanism cannot rot into
 * decoration.
 *
 * THE CHANGE IS ADDITIVE, WHICH IS THE ONLY REASON IT LANDS AT ALL.
 *
 * `T` defaults to the open shape, so every verb that has not declared its payload keeps exactly the
 * type it had, every `err(...)` path is untouched, and no existing call site changed. Declaring a
 * payload is a per-verb decision made one verb at a time; the count of declared verbs is asserted,
 * not claimed, by the guard suite.
 */

/** The fields a success carries besides `ok`. */
export type OkFields = Record<string, unknown>;

/**
 * A success carrying `T`.
 *
 * A type ALIAS rather than an interface on purpose: TypeScript hands an implicit index signature to
 * anonymous object types and withholds it from interfaces, so `Ok<PostEntryOk>` stays assignable to
 * the undeclared `Ok` that 100-odd verbs still return. Declare payloads as type aliases too, for the
 * same reason.
 */
export type Ok<T extends OkFields = OkFields> = Readonly<T> & { readonly ok: true };

export interface Err {
  readonly ok: false;
  readonly error: string;
  readonly [key: string]: unknown;
}

export type Result<T extends OkFields = OkFields> = Ok<T> | Err;

/** A success carrying zero or more named fields (e.g. `ok({ entryId })`). */
export function ok(): Ok;
/**
 * A success whose payload type is inferred from `fields`, or pinned by an explicit type argument
 * (`ok<PostEntryOk>({ ... })`), which is what makes the declared shape a check rather than a
 * comment: the literal is then judged against it, missing field and typo alike.
 */
export function ok<T extends OkFields>(fields: T): Ok<T>;
export function ok(fields: OkFields = {}): Ok {
  return { ...fields, ok: true };
}

/**
 * A rejection naming a stable machine-readable `error` code, with optional context.
 * `ok` and `error` are stamped last so no caller-supplied `extra` can overwrite them.
 */
export function err(code: string, extra: Record<string, unknown> = {}): Err {
  return { ...extra, ok: false, error: code };
}
