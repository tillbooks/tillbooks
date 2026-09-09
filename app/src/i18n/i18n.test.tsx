import { describe, it, expect, vi } from 'vitest';
import { render, renderHook } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOG, I18nProvider, useI18n, formatMoney, formatDate, type Messages } from './index';
import { allowConsole } from '../test-console';

const APP_SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = ['de-CH', 'en'] as const;

/**
 * The rejection codes ANY surface can be handed, and that therefore need their own sentence in the
 * shared catalogue rather than the generic `errors.fallback`.
 *
 * `fallback` reads "try again or check your input", which is decent advice for a rejected form and
 * actively wrong for the three below: no amount of checking your input fixes a missing role or an
 * unreachable service. `permission_denied` was missing from BOTH locales until 2026-07-25 and the
 * only trace was an `[i18n] missing translation` line on stderr, which is what this list is for:
 * key-set parity cannot see a key that is absent on both sides.
 *
 * `permission_denied` and `forbidden` are branched on by name across the surfaces;
 * `transport_error` is synthesised by `lib/client.ts` and `lib/mcp-transport.ts` themselves, so it
 * can reach a banner without any engine being involved at all.
 */
// `unexpected_error` and `store_busy` joined this list when G08 gave them copy. Before that both
// fell through to `errors.fallback` ("check your input"), which is the wrong advice for an internal
// fault and a dead end besides: the user cannot fix a defect by re-reading their own typing.
const CROSS_CUTTING_ERROR_CODES = [
  'permission_denied',
  'forbidden',
  'transport_error',
  'unexpected_error',
  'store_busy',
] as const;

/** Flatten a message tree to its set of dot-path leaf keys. */
function leafKeys(tree: Messages, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [name, value] of Object.entries(tree)) {
    const path = prefix === '' ? name : `${prefix}.${name}`;
    if (value !== null && typeof value === 'object') {
      keys.push(...leafKeys(value as Messages, path));
    } else {
      keys.push(path);
    }
  }
  return keys;
}

/** Resolve a dot-path against a message tree, mirroring the resolver in `index.tsx`. */
function resolve(tree: Messages, key: string): string | undefined {
  let node: unknown = tree;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/** Every non-test `.ts`/`.tsx` file under `app/src`, read as text. */
function appSources(dir = APP_SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...appSources(path));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) {
      out.push(readFileSync(path, 'utf8'));
    }
  }
  return out;
}

/**
 * Every key passed to `t`/`tStrict` as a STRING LITERAL. Keys assembled at runtime
 * (`t(`errors.${code}`)`) are invisible to a scan by construction, which is why the dynamic
 * families carry their own guards: `CROSS_CUTTING_ERROR_CODES` here, `AUDIT_ENTITY_KINDS` and
 * `AUDIT_ACTIONS` in `surfaces/Periods/audit-vocabulary.test.ts`.
 */
function literalKeys(): string[] {
  const keys = new Set<string>();
  for (const source of appSources()) {
    for (const [, key] of source.matchAll(/\bt(?:Strict)?\('([a-zA-Z0-9_.]+)'/g)) keys.add(key);
  }
  return [...keys].sort();
}

describe('locale completeness', () => {
  it('has the exact same key set in de-CH and en', () => {
    const de = new Set(leafKeys(CATALOG['de-CH']));
    const en = new Set(leafKeys(CATALOG.en));

    const missingInEn = [...de].filter((k) => !en.has(k));
    const missingInDe = [...en].filter((k) => !de.has(k));

    expect(missingInEn, `keys missing from en: ${missingInEn.join(', ')}`).toEqual([]);
    expect(missingInDe, `keys missing from de-CH: ${missingInDe.join(', ')}`).toEqual([]);
  });

  it('has a non-empty string behind every key in both locales', () => {
    for (const locale of LOCALES) {
      const blank = leafKeys(CATALOG[locale]).filter(
        (key) => (resolve(CATALOG[locale], key) ?? '').trim() === '',
      );
      expect(blank, `keys with no copy in ${locale}`).toEqual([]);
    }
  });

  it('resolves every literal t() key used anywhere in the app, in both locales', () => {
    const keys = literalKeys();
    expect(keys.length, 'the source scan found no t() calls at all').toBeGreaterThan(0);
    for (const locale of LOCALES) {
      const missing = keys.filter((key) => resolve(CATALOG[locale], key) === undefined);
      expect(missing, `keys used in the app but missing from ${locale}`).toEqual([]);
    }
  });

  it('gives every cross-cutting rejection code its own message, not the generic fallback', () => {
    for (const locale of LOCALES) {
      const missing = CROSS_CUTTING_ERROR_CODES.filter(
        (code) => resolve(CATALOG[locale], `errors.${code}`) === undefined,
      );
      expect(missing, `rejection codes with no dedicated message in ${locale}`).toEqual([]);
    }
  });

  it('de-CH copy uses real umlauts and never the German sharp s', () => {
    const de = JSON.stringify(CATALOG['de-CH']);
    expect(de).not.toContain('ß'); // sharp s must never appear in Swiss German
    expect(de).toMatch(/[äöüÄÖÜ]/); // real umlauts are used (e.g. "nötige", "ungültig")
  });
});

describe('formatMoney', () => {
  it('formats with an apostrophe thousands separator and two rappen', () => {
    expect(formatMoney(123455, 'CHF')).toBe("CHF 1'234.55");
    expect(formatMoney(0, 'CHF')).toBe('CHF 0.00');
    expect(formatMoney(5, 'CHF')).toBe('CHF 0.05');
    expect(formatMoney(100000000, 'CHF')).toBe("CHF 1'000'000.00");
  });

  it('carries a leading minus sign for negatives, so the value is never colour-only', () => {
    expect(formatMoney(-123455, 'CHF')).toBe("CHF -1'234.55");
  });

  it('formats any currency the same way, because the format is the house style, not the unit', () => {
    expect(formatMoney(4200, 'EUR')).toBe('EUR 42.00');
    expect(formatMoney(4200, 'USD')).toBe('USD 42.00');
    // Same digits, three units, three different amounts of money. Grouping and the two decimals do
    // not vary by currency here: the apostrophe separator is house style (P11), not a locale guess.
    expect(formatMoney(162150, 'EUR')).toBe("EUR 1'621.50");
  });

  it('REQUIRES a currency: no default, so an omission cannot resolve to a quiet CHF', () => {
    // The regression this guards is worth stating in full. `formatMoney(minor, currency = 'CHF')`
    // used to have a default, and it printed `Total MWST CHF 81.00` over a EUR invoice whose franc
    // VAT was 76.24: a figure true in neither currency, on an immutable posted record, on the screen
    // a person reads before filing. Seven more calls were carrying the same default.
    //
    // `Function.length` counts the parameters BEFORE the first defaulted one, so it is 2 with the
    // currency required and drops to 1 the moment a default comes back. That is a runtime fact, and
    // it is one of the two guards here.
    expect(formatMoney.length).toBe(2);

    // The other one used to be impossible. This comment read: "`app/tsconfig.json` excludes
    // `*.test.tsx`, so a `@ts-expect-error` in this file would be checked by nothing and would read
    // as protection that is not there." True when it was written, and no longer: the test sources
    // are type-checked from 2026-07-26. So the claim can be made at the type level too, and it is a
    // real claim, because an UNUSED `@ts-expect-error` is itself an error (TS2578). Give
    // `formatMoney` a default back and this line stops failing to compile, which fails the build.
    // @ts-expect-error the currency is required, and a caller who omits it must not compile
    formatMoney(4200);

    // What a caller who omitted it would actually see. Not francs, and not anything a money surface
    // could print by accident: the failure is loud at the first assertion that reads the string.
    const omitted = (formatMoney as unknown as (m: number) => string)(4200);
    expect(omitted).toBe('undefined 42.00');
    expect(omitted).not.toContain('CHF');
  });
});

describe('formatDate', () => {
  it('renders an ISO date as TT.MM.JJJJ', () => {
    expect(formatDate('2026-12-31')).toBe('31.12.2026');
    expect(formatDate('2026-01-05T08:00:00.000Z')).toBe('05.01.2026');
  });
});

describe('missing keys', () => {
  it('t reports a miss to the console in dev and still renders something', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderHook(() => useI18n(), { wrapper: I18nProvider });
    expect(result.current.t('nope.not.a.key')).toBe('nope.not.a.key');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('nope.not.a.key'));
    spy.mockRestore();
  });

  it('tStrict throws in dev, so an untranslated runtime value can never be shipped quietly', () => {
    const { result } = renderHook(() => useI18n(), { wrapper: I18nProvider });
    expect(() => result.current.tStrict('audit.action.no_such_action')).toThrow(
      /missing translation for "audit\.action\.no_such_action"/,
    );
  });

  it('tStrict resolves a key that does exist', () => {
    const { result } = renderHook(() => useI18n(), { wrapper: I18nProvider });
    expect(result.current.tStrict('audit.action.create')).toBe('Erstellt');
    expect(result.current.tStrict('audit.entityKind.workspace')).toBe('Arbeitsbereich');
  });
});

describe('tRich (G17): a React element survives inside a translated sentence', () => {
  it('resolves a token to the element, structurally, with the surrounding text intact', () => {
    const { result } = renderHook(() => useI18n(), { wrapper: I18nProvider });
    // An ad-hoc template via the raw-key fallback: the mechanism under test is interpolation.
    allowConsole(/missing translation for .x .term. y./);
    const nodes = result.current.tRich('x {term} y', { term: <strong>Saldosteuersatz</strong> });
    expect(nodes).toHaveLength(3);
    expect(nodes[0]).toBe('x ');
    expect(nodes[2]).toBe(' y');
    const { container } = render(<>{nodes}</>);
    expect(container.querySelector('strong')?.textContent).toBe('Saldosteuersatz');
  });

  it('string and number params interpolate as text, and an unknown token stays visible', () => {
    const { result } = renderHook(() => useI18n(), { wrapper: I18nProvider });
    allowConsole(/missing translation for .a .n. .missing../);
    const nodes = result.current.tRich('a {n} {missing}', { n: 7 });
    expect(nodes.join('')).toBe('a 7 {missing}');
  });
});
