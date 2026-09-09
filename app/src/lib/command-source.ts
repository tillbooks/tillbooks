/**
 * G16, the command palette's command source: a drift-tested PROJECTION of the registry.
 *
 * WHY IT IS A PROJECTION AND NOT A HAND LIST. TILL's thesis is that humans and agents drive the
 * identical verbs. The palette must therefore run the same `ActionDef[]` the MCP `tools/list` and the
 * REST route table resolve, and it must not fall behind the registry silently. The browser cannot
 * import `src/api/registry.ts` (it reaches `better-sqlite3` in one hop), so the per-verb metadata is
 * GENERATED into `command-source.generated.json` by `scripts/generate-command-source.mjs`, and the
 * curated by-name exposure is AUTHORED in `command-source.exposed.json`. Both are plain JSON so the
 * node drift test (`test/planning/command-source-drift.test.mjs`) can read them back and hold them
 * equal to the live registry, the live `CAPABILITY_FOR_ACTION` gate and the live denylist.
 *
 * THE THREE ROW KINDS a palette command resolves to:
 *   - `navigate`   a rail destination (no verb). Enter routes. Always free and reversible.
 *   - `direct-run` a verb Enter executes inline (a read, or a zero-input reversible non-destructive
 *                  non-denylisted write). The result renders in the palette. Safety, not arity (D89 #6).
 *   - `handoff`    a parameterised or outbound verb. Enter routes to the owning surface's flow; the
 *                  palette owns no form and injects no input (D84), so the surface's A24 gate and P8
 *                  draft/approval apply byte-identically.
 *
 * Records are NOT in this source: they come live from G07's `search_global`, per workspace, per actor.
 */
import generated from './command-source.generated.json';
import exposed from './command-source.exposed.json';
import { NAV_ITEMS } from '../app/nav';

/** Per-verb metadata, derived from the registry. Mirrors `command-source.generated.json`. */
export interface VerbMeta {
  name: string;
  kind: 'read' | 'write';
  /** Required input beyond `workspaceId` / `idempotencyKey` (the two the palette never asks for). */
  reqCount: number;
  /** True when any required input is an array or object: unfillable in a palette (design §3c). */
  hasComplexInput: boolean;
  /** The A24 capability(ies) the gate checks. Empty for an ungated or dynamically-gated verb. */
  capabilities: readonly string[];
  /** A verb whose gate depends on its input (e.g. `set_field_value`): the palette does not disable it. */
  gateDynamic: boolean;
  /** On G01's `NOT_AUTOMATABLE` denylist. */
  denylisted: boolean;
  /**
   * C4: the A26 dial capability that governs this verb (`dialMap.ts`), or null when it is not
   * dial-governed. Sourced from the same drift-tested projection as everything else, so the tiered
   * confirm's verb-to-consequence mapping cannot drift from the engine's `DIAL_CAPABILITY_FOR_ACTION`.
   */
  dialCapability: string | null;
}

interface ExposedEntry {
  name: string;
  kind: 'direct-run' | 'handoff';
  labelKey: string;
  targetRoute?: string;
  directRunSafe: boolean;
  reversible?: boolean;
  destructive?: boolean;
}

const VERB_META: ReadonlyMap<string, VerbMeta> = new Map(
  (generated.verbs as VerbMeta[]).map((v) => [v.name, v]),
);

/** The projected metadata for one verb, or undefined for a name the registry does not carry. */
export function verbMetaFor(name: string): VerbMeta | undefined {
  return VERB_META.get(name);
}

const EXPOSED: readonly ExposedEntry[] = (exposed.commands as ExposedEntry[]);

export type CommandKind = 'navigate' | 'direct-run' | 'handoff';

/** A navigation command: a rail destination, no verb. */
export interface NavCommand {
  kind: 'navigate';
  path: string;
  labelKey: string;
}

/** A verb command: run inline (direct-run) or route to a surface (handoff). */
export interface VerbCommand {
  kind: 'direct-run' | 'handoff';
  name: string;
  labelKey: string;
  /** The surface a handoff routes to, and the surface a direct-run's result links back to. */
  targetRoute?: string;
  /** The A24 capability(ies) the palette disables the row on. Empty = never disabled. */
  capabilities: readonly string[];
  /** A dynamically-gated verb is never disabled by the chrome (the engine stays the gate). */
  gateDynamic: boolean;
  /** True only for a read, or a zero-input reversible non-destructive non-denylisted write. */
  directRunSafe: boolean;
}

export type Command = NavCommand | VerbCommand;

/** Every rail destination as a navigation command. */
export const NAV_COMMANDS: readonly NavCommand[] = NAV_ITEMS.map((item) => ({
  kind: 'navigate',
  path: item.path,
  labelKey: item.labelKey,
}));

/** The curated verbs the palette exposes by name, joined with their live metadata. */
export const VERB_COMMANDS: readonly VerbCommand[] = EXPOSED.flatMap((e) => {
  const meta = VERB_META.get(e.name);
  if (meta === undefined) return []; // guarded by the drift test; belt-and-braces at runtime.
  const cmd: VerbCommand = {
    kind: e.kind,
    name: e.name,
    labelKey: e.labelKey,
    capabilities: meta.capabilities,
    gateDynamic: meta.gateDynamic,
    directRunSafe: e.directRunSafe,
  };
  if (e.targetRoute !== undefined) cmd.targetRoute = e.targetRoute;
  return [cmd];
});

/**
 * The single safety predicate, stated once so the property test and the palette agree.
 *
 * `directRunSafe` is true only for a **read**, or a **write that is zero-required-input AND reversible
 * AND non-destructive AND not on the `NOT_AUTOMATABLE` denylist** (D89 #6 / D90 D-1). Zero input alone
 * is not sufficient: a zero-input verb can still be irreversible or destructive.
 */
export function isDirectRunSafe(meta: VerbMeta, entry: { reversible?: boolean; destructive?: boolean }): boolean {
  if (meta.kind === 'read') return true;
  return (
    meta.reqCount === 0 &&
    entry.reversible === true &&
    entry.destructive !== true &&
    !meta.denylisted
  );
}

/**
 * The structural reason a registry verb is NOT exposed by name. A total function over the metadata,
 * so every non-exposed verb carries a written reason (the drift test asserts exposure XOR a reason).
 * A verb reached "via surface" is still reachable by a human: its surface is in the rail, and the
 * palette navigates there.
 */
export function exclusionReason(meta: VerbMeta): string {
  if (meta.kind === 'read') return 'read_reached_via_surface';
  if (meta.hasComplexInput) return 'array_or_object_input_reached_via_surface';
  if (meta.reqCount > 0) return 'parameterised_reached_via_surface';
  return 'not_curated_reached_via_surface';
}

/** Case-insensitive match quality: 3 exact, 2 prefix, 1 contains, 0 none. No numeric score (data honesty). */
export function matchScore(query: string, text: string): 0 | 1 | 2 | 3 {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return 0;
  const t = text.toLowerCase();
  if (t === q) return 3;
  if (t.startsWith(q)) return 2;
  return t.includes(q) ? 1 : 0;
}

/**
 * C2, the vendored ranking IDEA, not the library.
 *
 * `cmdk`'s command matcher ranks a fuzzy hit by HOW it matched, not merely whether it did: an exact
 * hit beats a prefix, a prefix beats a word-boundary prefix, that beats a loose substring, and a
 * scattered subsequence comes last. We reproduce that ORDER with a hand-rolled scorer and take on no
 * dependency (D118 C2 / the zero-dep policy): a dormant `cmdk` in the bundle would cost more than the
 * thirty lines below, and its own ranking heuristics would drift from ours silently.
 *
 * Diacritics are folded so a keyboard without umlauts still reaches a de-CH label ("ubersicht" finds
 * "Übersicht"); the ß fold is defensive only, Swiss German has none. The tiers are spaced wide so a
 * caller can add its own small nudge (the concept floor, a recency bump) without crossing a tier.
 */
export const RANK = {
  none: 0,
  subsequence: 20,
  substring: 40,
  wordPrefix: 60,
  prefix: 80,
  exact: 100,
} as const;

/** Lower-case and strip combining diacritics so folded letters compare equal. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').toLowerCase();
}

/** True when every character of `q` appears in `t`, in order (a scattered subsequence). */
function isSubsequence(q: string, t: string): boolean {
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j += 1) {
    if (t[j] === q[i]) i += 1;
  }
  return i === q.length;
}

/**
 * Rank `text` against `query` on cmdk's tiers: exact > prefix > word-boundary prefix > contiguous
 * substring > subsequence > none. Returns one of the `RANK` constants; 0 means no match at all.
 */
export function rankScore(query: string, text: string): number {
  const q = fold(query.trim());
  if (q.length === 0) return RANK.none;
  const t = fold(text);
  if (t === q) return RANK.exact;
  if (t.startsWith(q)) return RANK.prefix;
  if (t.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(q))) return RANK.wordPrefix;
  if (t.includes(q)) return RANK.substring;
  return isSubsequence(q, t) ? RANK.subsequence : RANK.none;
}
