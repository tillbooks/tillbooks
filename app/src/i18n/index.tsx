/**
 * i18n for Studio.
 *
 * Dot-path keys resolved against a locale JSON tree, with `{param}` interpolation. Every visible
 * string in a component comes from here: no hardcoded user-facing copy. de-CH is the default and
 * uses real umlauts (never `ss` for the German sharp s, which Swiss German does not have).
 *
 * Money is always `CHF 1'234.55` (apostrophe thousands separator) regardless of locale, per house
 * style. Dates are `TT.MM.JJJJ` / `DD.MM.YYYY` (identical digits, both `31.12.2026`).
 */
import { createContext, Fragment, useContext, useMemo, useState, type ReactNode } from 'react';

import deCH from './de-CH.json';
import en from './en.json';

export type Locale = 'de-CH' | 'en';

export type Messages = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recursively merge `extra` onto `base`. Objects deep-merge; leaves in `extra` win. */
function deepMerge(base: Messages, extra: Messages): Messages {
  const out: Messages = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const existing = out[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

/**
 * Per-surface message fragments. Each surface owns its own namespace under
 * `app/src/surfaces/<Surface>/messages.<locale>.json` and is merged in here, so a surface never has
 * to edit the shared shell locale files (`de-CH.json`/`en.json`). New surfaces are picked up with no
 * change to this module. The eager glob resolves at build/test time.
 */
function mergeFragments(base: Messages, modules: Record<string, unknown>): Messages {
  let acc = base;
  for (const key of Object.keys(modules).sort()) {
    const fragment = (modules[key] as { default?: Messages }).default;
    if (fragment !== undefined) acc = deepMerge(acc, fragment);
  }
  return acc;
}

const deFragments = import.meta.glob('../surfaces/**/messages.de-CH.json', { eager: true });
const enFragments = import.meta.glob('../surfaces/**/messages.en.json', { eager: true });

const CATALOG: Record<Locale, Messages> = {
  'de-CH': mergeFragments(deCH as Messages, deFragments),
  en: mergeFragments(en as Messages, enFragments),
};

export const DEFAULT_LOCALE: Locale = 'de-CH';

/** Interpolation parameters for `t(key, params)`. */
export type TParams = Record<string, string | number>;

/**
 * Interpolation parameters for `tRich(key, params)`: a token may resolve to a React element, not
 * only to text. This is what lets a marked concept term (G17) live INSIDE a translated sentence:
 * the token is part of the authored string in every locale, so a translator moves it with the
 * sentence and cannot lose it, and the surface never has to say which word occurrence to mark.
 */
export type TRichParams = Record<string, string | number | ReactNode>;

/** Resolve a dot-path (`nav.setup`) against a message tree. Returns undefined if the path is absent. */
function resolve(tree: Messages, key: string): string | undefined {
  let node: unknown = tree;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/** Substitute `{param}` tokens. Unknown tokens are left verbatim so a missing param is visible. */
function interpolate(template: string, params?: TParams): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * Substitute `{param}` tokens where a param may be a React element (G17's marked terms).
 *
 * The template is split on its tokens and each token becomes either interpolated text or the
 * element itself, so the sentence STRUCTURALLY contains the element rather than string-matching
 * words in the output (which cannot survive translation and cannot pick an occurrence). Unknown
 * tokens are left verbatim, exactly as `interpolate` leaves them, so a missing param is visible.
 */
function interpolateRich(template: string, params?: TRichParams): ReactNode[] {
  const parts = template.split(/(\{\w+\})/g);
  return parts
    .filter((part) => part !== '')
    .map((part, index) => {
      const token = /^\{(\w+)\}$/.exec(part);
      if (token === null) return part;
      const name = token[1] as string;
      const value = params?.[name];
      if (value === undefined) return part;
      if (typeof value === 'string' || typeof value === 'number') return String(value);
      // A React element: keyed by token name + position so repeated tokens stay stable.
      return <Fragment key={`${name}-${index}`}>{value}</Fragment>;
    });
}

/** Group an integer string with an apostrophe every three digits: `1234` -> `1'234`. */
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, "'");
}

/**
 * Format a minor-unit amount as `CHF 1'234.55`. Negatives carry a leading minus sign so the value is
 * never distinguished by colour alone. The format is fixed across locales by house style.
 *
 * `currency` IS REQUIRED, and the missing default is the point rather than an oversight.
 *
 * It used to default to `'CHF'`, which is a silent, wrong answer on every workspace whose books are
 * not kept in francs (`workspace.base_currency` is a setting; `CURRENCIES` admits CHF, EUR and USD).
 * It cost real money twice. First the per-document VAT panel printed `Total MWST CHF 81.00` over a
 * EUR invoice whose franc VAT was 76.24: wrong in both currencies, on an immutable posted record, on
 * the screen a person reads before filing a VAT return. Then seven more calls were found wearing the
 * same default, including `USD 1'000.00 at rate 0.86 is CHF 860.00 in the books` on the FX
 * disclosure of a EUR-base ledger.
 *
 * Both survived because they were INVISIBLE on the common case. A default that is right nine times
 * in ten is a defect that only ships to the customers who would notice least and be hurt most. With
 * the parameter required, the next omission is a compile error at the call site instead of a wrong
 * number on a filing, and the author has to answer the only question that matters here: what
 * currency is this figure actually in? The answer is never "whatever the formatter assumes".
 *
 * The parameter is `minor`, not `minorCHF`. The old name was part of the same assumption.
 */
export function formatMoney(minor: number, currency: string): string {
  const negative = minor < 0;
  const absolute = Math.abs(Math.trunc(minor));
  const whole = Math.floor(absolute / 100);
  const rappen = absolute % 100;
  const grouped = groupThousands(String(whole));
  const sign = negative ? '-' : '';
  return `${currency} ${sign}${grouped}.${String(rappen).padStart(2, '0')}`;
}

/** Format an ISO date (`2026-12-31` or a full instant) as `31.12.2026`. */
export function formatDate(isoDate: string): string {
  const datePart = isoDate.slice(0, 10);
  const [year, month, day] = datePart.split('-');
  if (year === undefined || month === undefined || day === undefined) return isoDate;
  return `${day}.${month}.${year}`;
}

/**
 * Humanise a dot-path into something a user can read when a key is genuinely missing in production:
 * `audit.entityKind.period_lock` becomes `Period lock`. Never pretty, always better than a raw key.
 */
function humaniseKey(key: string): string {
  const leaf = key.split('.').pop() ?? key;
  const words = leaf.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** True while running the dev server or the test suite, false in a production bundle. */
function isDev(): boolean {
  return import.meta.env.DEV === true;
}

export interface I18n {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  /**
   * Resolve a key. Falls back to the default locale, then to the raw key, so nothing renders blank.
   * A miss is reported to the console in dev so it is never invisible to whoever added the key.
   */
  t: (key: string, params?: TParams) => string;
  /**
   * Resolve a key that MUST exist, for lookups built from runtime data (`audit.action.${row.action}`)
   * where a raw key would otherwise leak straight into the UI. In dev it throws, so an untranslated
   * value is impossible to miss; in production it degrades to a humanised leaf, never the dot-path.
   */
  tStrict: (key: string, params?: TParams) => string;
  /**
   * Resolve a key whose params may include React elements, returning the sentence as nodes. The
   * `t()` sibling G17's marked terms need: a token resolves to an element INSIDE the translated
   * sentence, so the marker survives translation structurally (see `TRichParams`).
   */
  tRich: (key: string, params?: TRichParams) => ReactNode[];
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({
  children,
  initialLocale = DEFAULT_LOCALE,
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, setLocale] = useState<Locale>(initialLocale);

  const value = useMemo<I18n>(() => {
    const lookup = (key: string): string | undefined =>
      resolve(CATALOG[locale], key) ?? resolve(CATALOG[DEFAULT_LOCALE], key);

    const t = (key: string, params?: TParams): string => {
      const hit = lookup(key);
      if (hit === undefined && isDev()) {
        console.error(`[i18n] missing translation for "${key}" (locale ${locale}).`);
      }
      return interpolate(hit ?? key, params);
    };

    const tStrict = (key: string, params?: TParams): string => {
      const hit = lookup(key);
      if (hit !== undefined) return interpolate(hit, params);
      // Loud in dev: an untranslated runtime value is a bug, not a rendering state.
      if (isDev()) {
        throw new Error(
          `[i18n] missing translation for "${key}" (locale ${locale}). ` +
            'Add it to the surface message files for every locale.',
        );
      }
      console.error(`[i18n] missing translation for "${key}" (locale ${locale}).`);
      return humaniseKey(key);
    };

    const tRich = (key: string, params?: TRichParams): ReactNode[] => {
      const hit = lookup(key);
      if (hit === undefined && isDev()) {
        console.error(`[i18n] missing translation for "${key}" (locale ${locale}).`);
      }
      return interpolateRich(hit ?? key, params);
    };

    return { locale, setLocale, t, tStrict, tRich };
  }, [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Access the i18n context. Throws if used outside a provider, which is a wiring bug, not a runtime state. */
export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (ctx === null) throw new Error('useI18n must be used within an I18nProvider.');
  return ctx;
}

/** The common case: just the translate function. */
export function useT(): I18n['t'] {
  return useI18n().t;
}

/** The strict translate function, for keys assembled from runtime data. See `I18n.tStrict`. */
export function useTStrict(): I18n['tStrict'] {
  return useI18n().tStrict;
}

/** The rich translate function: params may be React elements (G17 marked terms). See `I18n.tRich`. */
export function useTRich(): I18n['tRich'] {
  return useI18n().tRich;
}

/** Exposed for the locale-completeness test. */
export { CATALOG };
