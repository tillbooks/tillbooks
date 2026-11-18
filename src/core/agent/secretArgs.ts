/**
 * D198 re-cut R7 (critic r3 M1): THE ONE REGISTRY OF SECRET ARGUMENTS. A verb's argument that carries a
 * credential TILL keeps only in the OS secret store. Three readers, one list:
 *
 *  - the N01 argument identity (`argsIdentity.ts`): the value is replaced by whether it was given, so a
 *    plain hash in `idempotency_args` never becomes an offline guessing oracle;
 *  - the agent trace (`api/agent-gate.ts`): every field of these names is stripped WHEREVER it sits in the
 *    recorded input (a `call_tool { args: { feedToken } }` included), with a marker that it was omitted;
 *  - `call_tool` (`api/batch-actions.ts`): a verb with a secret argument is never dispatched through it, for
 *    any seat, so the credential travels only on the verb's own door.
 */

export const SECRET_ARG_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // `token` is the field's OLD name (critic r1 F7 renamed it): the verb refuses it, and a caller that still
  // sends it must not have the value copied into the trace or the argument identity either (security
  // review, 12.11.2026).
  set_settlement_source: ['feedToken', 'token'],
};

/** Every secret field name of any verb (the trace strips these wherever they sit). */
export const SECRET_FIELD_NAMES: ReadonlySet<string> = new Set(Object.values(SECRET_ARG_FIELDS).flat());

/** Does this verb take a secret argument? */
export function hasSecretArgs(verb: string): boolean {
  return (SECRET_ARG_FIELDS[verb]?.length ?? 0) > 0;
}

/**
 * A deep copy of `value` with every secret field removed, at any depth, and `<field>Omitted: true` left in
 * its place. Arrays and plain objects are walked; anything else is kept as it is.
 */
export function stripSecretsDeep(value: unknown, depth = 0): unknown {
  if (depth > 32) return value;
  if (Array.isArray(value)) return value.map((v) => stripSecretsDeep(v, depth + 1));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD_NAMES.has(k)) {
      out[`${k}Omitted`] = true;
      continue;
    }
    // defineProperty (A42 code critic r4 L1): a parsed `__proto__` key stays an ordinary own key, never the prototype.
    Object.defineProperty(out, k, { value: stripSecretsDeep(v, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return out;
}
