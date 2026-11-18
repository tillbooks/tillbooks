// A tiny JSON Schema validator for the SUBSET the published till-settlement/v1 schema uses. No dependency.
// It throws on a keyword it does not know, so a schema that grows a keyword fails the parity test loudly
// instead of being half-checked.

const KNOWN = new Set([
  '$schema', '$id', '$ref', '$defs', 'title', 'description', 'type', 'const', 'enum', 'required', 'properties', 'items', 'minItems', 'maxItems',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'anyOf',
]);

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** Errors (a list of "path: what") of `value` against `schema`; empty means valid. */
export function validate(schema, value, root = schema, path = '') {
  const errors = [];
  for (const key of Object.keys(schema)) if (!KNOWN.has(key)) throw new Error(`validator does not know the keyword ${key}`);
  const at = path === '' ? '(document)' : path;
  if (schema.$ref !== undefined) {
    const name = schema.$ref.replace('#/$defs/', '');
    return validate(root.$defs[name], value, root, path);
  }
  if ('const' in schema && value !== schema.const) errors.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum !== undefined && !schema.enum.includes(value)) errors.push(`${at}: not one of the allowed values`);
  if (schema.type !== undefined) {
    const t = typeOf(value);
    const ok = schema.type === t || (schema.type === 'number' && t === 'number' && Number.isFinite(value));
    if (!ok) return [`${at}: must be ${schema.type}`];
  }
  if (schema.anyOf !== undefined) {
    const branches = schema.anyOf.map((s) => validate(s, value, root, path));
    if (!branches.some((b) => b.length === 0)) errors.push(`${at}: matches none of the allowed shapes`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) errors.push(`${at}: too short`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) errors.push(`${at}: too long`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${at}: does not match the pattern`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below the minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above the maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: too many items`);
    if (schema.items !== undefined) value.forEach((item, i) => errors.push(...validate(schema.items, item, root, `${path}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path === '' ? '' : `${path}.`}${key}: required`);
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) errors.push(...validate(sub, value[key], root, `${path === '' ? '' : `${path}.`}${key}`));
    }
  }
  return errors;
}
