import { CATALOG, type TParams } from '../../i18n';
import type { Err } from '../../lib/client';
import { sharedRefusalKey } from './refusalSuffix';

/**
 * THE ONE PATH from an engine refusal to a sentence, for every surface that words refusals itself
 * (critic R5-1). `ErrorBanner` is the other door and asks the same question first.
 *
 * Round 4 fixed six faces one by one and round 5 found about twenty more hand-rolled mappers, each
 * reading `error.error` into its own catalogue and never the flags. A saved-whole refusal
 * (`schema_newer_than_runtime`, `partial`, `completed`) then read "could not be posted, try again" on
 * the payments drawer, beside a button that posted again. So the rule sits HERE, once, and
 * `app/src/refusal-rendering-convention.test.ts` fails the build when a surface builds an error key
 * by hand instead of coming through this function.
 *
 * The order, which no surface can reorder:
 *  1. `sharedRefusalKey`: the newer-book refusal, and any refusal raised after the call had already
 *     saved (`partial`, with `completed` the saved sentence). Only the shared catalogue words these
 *     truthfully, so a surface's own sentence never wins over them.
 *  2. `keys[code]`, then `<own>.<code>` (restricted to `known` when given): the surface's own words,
 *     used only when the catalogue really has them, so a code the surface never wrote a sentence for
 *     falls through instead of rendering its dot path.
 *  3. `fallback` when the surface names one, else the shared `errors.<code>`, else `fallbackText`
 *     (verbatim) or `errors.fallback`.
 *
 * `error` may be a bare code (a stored run's or a row's error): it carries no flags, so step 1 then
 * catches only the newer-book code itself.
 */
export interface RefusalWording {
  /** The surface's own namespace: `<own>.<code>` words a code when the catalogue has that key. */
  own?: string;
  /** Restrict `own` to these codes (a surface that words only some codes itself). */
  known?: ReadonlySet<string> | readonly string[];
  /** A specific key for a code, checked before `own`. */
  keys?: Readonly<Record<string, string>>;
  /** Interpolation for the surface's own sentence (`keys` or `own`). */
  params?: TParams;
  /** The sentence when the surface has none, in place of the shared `errors.<code>` and `errors.fallback`. */
  fallback?: string;
  /** Interpolation for `fallback`. */
  fallbackParams?: TParams;
  /**
   * Verbatim text in place of `errors.fallback` only, after the shared `errors.<code>` (a history row
   * that shows the bare code an operator can search for rather than a generic sentence).
   */
  fallbackText?: string;
}

type Translate = (key: string, params?: TParams) => string;

/** Does any locale's catalogue carry `key`? Looked up without `t`, so a miss logs nothing. */
export function hasMessage(key: string): boolean {
  return Object.values(CATALOG).some((tree) => {
    let node: unknown = tree;
    for (const part of key.split('.')) {
      if (node === null || typeof node !== 'object') return false;
      node = (node as Record<string, unknown>)[part];
    }
    return typeof node === 'string';
  });
}

/** Does the surface's own namespace word `code` (`<own>.<code>` in the catalogue)? */
export function ownsWording(own: string, code: string): boolean {
  return hasMessage(`${own}.${code}`);
}

function lists(known: ReadonlySet<string> | readonly string[], code: string): boolean {
  return known instanceof Set ? known.has(code) : (known as readonly string[]).includes(code);
}

export function refusalText(t: Translate, error: Err | string, wording: RefusalWording = {}): string {
  const refusal: Err = typeof error === 'string' ? { ok: false, error } : error;
  const shared = sharedRefusalKey(refusal);
  if (shared !== undefined) return t(shared);
  const code = refusal.error;
  const specific = wording.keys?.[code];
  if (specific !== undefined && hasMessage(specific)) return t(specific, wording.params);
  if (wording.own !== undefined && (wording.known === undefined || lists(wording.known, code))) {
    const own = `${wording.own}.${code}`;
    if (hasMessage(own)) return t(own, wording.params);
  }
  if (wording.fallback !== undefined) return t(wording.fallback, wording.fallbackParams);
  const common = `errors.${code}`;
  if (hasMessage(common)) return t(common);
  return wording.fallbackText ?? t('errors.fallback');
}
