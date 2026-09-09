/**
 * THE RESERVED MONEY-PATH NAMES (P3's enforcement point) and the full core-tool-name set, both
 * SINGLE-SOURCED FROM THE REGISTRY and handed to this module at load, never hand-copied here.
 *
 * WHY THIS IS A REGISTRATION SEAM AND NOT A LITERAL LIST. `plugin.install` runs in the engine
 * (`core/plugins`), and the engine must never import `src/api/registry.ts` (the dependency runs the
 * other way, which is what keeps the module graph acyclic). So the two sets the install-time checks
 * need cannot be computed here. They are computed WHERE the tool surface actually is, `registry.ts`,
 * and handed over at module load through `registerMoneyPathTools` / `registerCoreToolNames`, exactly
 * the way G01's `registerWriteActions` hands over the write half of `ACTIONS`. A name that A02 or
 * A14 renames moves through this seam automatically; a hand-copied literal here would be the drift
 * the spec's §H-ENUM single-sourcing exists to forbid.
 *
 * FAILS CLOSED. Until `registerMoneyPathTools` has run, `moneyPathTools()` is UNSET (not empty), and
 * `plugin.install` refuses with `plugin_guard_uninitialised` rather than admitting a manifest whose
 * money-path capabilities it cannot check. An empty set would be a silent hole: it would let a plugin
 * register `post_entry` in the window before the registry loaded. The engine is only ever reachable
 * THROUGH `registry.ts` (both faces dispatch through it), so in practice the seam is always wired by
 * the time any verb runs; failing closed is the belt to that braces.
 *
 * THE MONEY-PATH SET IS A02 + A14's OWN WRITE VERBS (spec §4): `post_entry`, `reverse_entry`,
 * `save_draft`, `delete_draft` (the journal front door) and `record_payment`, `allocate_payment`,
 * `reverse_payment`, `set_write_off_threshold` (the settlement half). Including the draft verbs is
 * deliberate and strictly safer: a plugin cannot even shadow a draft-named posting tool. The set is
 * what `registry.ts` derives from the A02 named action consts and the A14 `paymentActions` group, so
 * it is the registry's OWN money-path verb set, not a second copy.
 */

let _moneyPathTools: ReadonlySet<string> | undefined;
let _coreToolNames: ReadonlySet<string> | undefined;

/**
 * Register the reserved money-path tool names (P3). Called once at load from `registry.ts` with the
 * write-verb names of the A02 journal and the A14 settlement surfaces. Idempotent: a second call
 * replaces the set, which is what lets a test drive the seam directly. Passing `undefined` CLEARS the
 * set back to the unwired state (distinct from an empty set, which is a wired deployment with zero
 * money-path tools): this is what lets a test exercise the fail-closed window.
 */
export function registerMoneyPathTools(names: readonly string[] | undefined): void {
  _moneyPathTools = names === undefined ? undefined : new Set(names);
}

/**
 * Register the full set of existing core tool names (for `capability_name_conflict`). Called once at
 * load from `registry.ts` with every `ACTIONS` name (reads and writes).
 */
export function registerCoreToolNames(names: readonly string[]): void {
  _coreToolNames = new Set(names);
}

/** The reserved money-path set, or `undefined` when the seam has not been wired (fail closed). */
export function moneyPathTools(): ReadonlySet<string> | undefined {
  return _moneyPathTools;
}

/** The full core tool-name set, or `undefined` when the seam has not been wired (fail closed). */
export function coreToolNames(): ReadonlySet<string> | undefined {
  return _coreToolNames;
}

/** Is `name` a reserved money-path tool a plugin may never register or shadow (P3)? */
export function isReservedMoneyPathTool(name: unknown): boolean {
  return typeof name === 'string' && _moneyPathTools !== undefined && _moneyPathTools.has(name);
}

/** Is `name` an existing core tool name (a registering capability may not collide with one)? */
export function isCoreToolName(name: unknown): boolean {
  return typeof name === 'string' && _coreToolNames !== undefined && _coreToolNames.has(name);
}
