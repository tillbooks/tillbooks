/**
 * The guard that stops a raw `reports.source.*` key ever reaching the Kontoblatt Herkunft column
 * again. It is the SECOND occurrence of the i18n-vocab-gap class (kaizen K-64); the first was the
 * audit-vocabulary gap (K-6), and this file is the deliberate analogue of
 * `app/src/surfaces/Periods/audit-vocabulary.test.ts`, promoted because the class has now recurred.
 *
 * THE DEFECT (K-64). `app/src/surfaces/Reports/GeneralLedger.tsx` renders the source of each ledger
 * line as `t(sourceLabelKey(line.source))`. When the key is missing, `t()` returns the RAW KEY, so a
 * `purchase` line printed the literal string `reports.source.purchase` on screen in the PRIMARY
 * de-CH locale (76 `[i18n] missing translation` console errors on rich data). The `reports.source`
 * maps in `messages.de-CH.json` / `messages.en.json` covered only 7 of the engine's source values
 * (close, invoice, payment, reversal, import, agent, fx), while the engine's `POST_ENTRY` source
 * enum emits eleven more.
 *
 * THE GUARD. It reads the engine's single §H-ENUM source of truth, the `VALID_SOURCES = new Set([...])`
 * literal in `src/core/ledger/postEntry.ts`, and asserts that every value EXCEPT `manual` has a key
 * under `reports.source.*` in BOTH locales. `manual` is exempt by design: `sourceLabelKey` returns
 * `null` for it so the column renders nothing (a column reading "Manuell" 240 times is noise). The
 * enum is SCRAPED FROM THE ENGINE SOURCE, never hand-copied, so the NEXT source value added to
 * `VALID_SOURCES` fails this suite by name until both locales are extended.
 *
 * It reads `src/` from disk rather than importing it, for the same reason K-6 does: the browser
 * bundle must never touch engine code (better-sqlite3 is native and Node-only), but a Node-side
 * vitest may read the file as text.
 *
 * THE SCRAPE IS MISS-SAFE, NEVER FALSE-POSITIVE. It anchors on the exact `const VALID_SOURCES =
 * new Set([` declaration and throws if that anchor ever drifts (a loud failure, not a silent green),
 * and it strips `//` line comments before reading array elements. That comment strip is load-bearing:
 * the enum's own comments quote unrelated identifiers in single quotes (`source='reversal'`,
 * `'landed_cost_voucher'`, `'vendor_bill'`, `'stock_valuation_run'`), and a naive literal scrape
 * would mint those as phantom enum members and demand `reports.source.vendor_bill`. Only a bare
 * `'value',` on its own array line counts. The self-proving block below holds both of these lines.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOG, type Messages } from '../../i18n';
import { sourceLabelKey } from './model';

const POST_ENTRY_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../src/core/ledger/postEntry.ts',
);
const POST_ENTRY_SRC = readFileSync(POST_ENTRY_PATH, 'utf8');

/** Resolve a dot-path against a message tree, mirroring the resolver in `i18n/index.tsx`. */
function resolve(tree: Messages, key: string): string | undefined {
  let node: unknown = tree;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * The engine's `journal_entry.source` values, scraped from the `VALID_SOURCES = new Set([...])`
 * §H-ENUM in `src/core/ledger/postEntry.ts`. Anchored on the exact declaration (throws if it drifts)
 * and comment-stripped so only bare `'value',` array elements are read.
 */
function scrapeValidSources(source: string = POST_ENTRY_SRC): Set<string> {
  const block = /const VALID_SOURCES\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(source);
  if (block === null) {
    throw new Error(
      'VALID_SOURCES `new Set([...])` anchor not found in postEntry.ts: the scrape drifted and this ' +
        'guard can no longer see the engine source enum. Re-anchor it before trusting a green run.',
    );
  }
  const out = new Set<string>();
  for (const rawLine of block[1].split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, ''); // drop any trailing line comment
    const match = /^\s*'([a-z_]+)'\s*,?\s*$/.exec(line);
    if (match !== null) out.add(match[1]);
  }
  return out;
}

describe('the source-enum scraper proves itself, every run', () => {
  it('reads bare array-element literals and ignores single-quoted words inside comments', () => {
    const synthetic =
      "const VALID_SOURCES = new Set([\n" +
      "  'manual',\n" +
      "  'invoice',\n" +
      "  // I03, freight/duty. Only `landedCostAllocateConfirm` writes one; a reverse uses source='reversal'.\n" +
      "  'landed_cost',\n" +
      "]);\n";
    // 'reversal' and 'landed_cost_voucher'-style words live only in the comment; only the three real
    // array elements are returned.
    expect([...scrapeValidSources(synthetic)].sort()).toEqual(['invoice', 'landed_cost', 'manual']);
  });

  it('throws, rather than returning empty, when the anchor drifts', () => {
    expect(() => scrapeValidSources('const SOMETHING_ELSE = [1, 2, 3];')).toThrow(/anchor not found/);
  });

  it('sees the real engine enum, including the K-64 sentinel values', () => {
    const sources = scrapeValidSources();
    // Non-empty, and carries both an original mapped value and the newest (last) enum member, so a
    // scrape that silently stopped early fails here by name.
    expect(sources.size, 'the engine scan found no source values at all').toBeGreaterThanOrEqual(19);
    expect(sources.has('invoice')).toBe(true);
    expect(sources.has('inventory_valuation')).toBe(true);
    // Proof the comment strip works: `vendor_bill` is named only in a comment, never an enum member.
    expect(sources.has('vendor_bill')).toBe(false);
  });
});

describe('reports.source vocabulary covers the engine source enum (K-64 guard)', () => {
  it('has a de-CH and an en label for every non-manual engine source value', () => {
    const sources = [...scrapeValidSources()].filter((s) => s !== 'manual');
    expect(sources.length, 'the engine scan found no non-manual source values').toBeGreaterThan(0);
    for (const locale of ['de-CH', 'en'] as const) {
      const missing = sources.filter(
        (s) => resolve(CATALOG[locale], `reports.source.${s}`) === undefined,
      );
      expect(missing, `engine source values missing from reports.source.* in ${locale}`).toEqual([]);
    }
  });

  it('leaves `manual` deliberately unmapped: it renders as nothing', () => {
    expect(sourceLabelKey('manual')).toBeNull();
    for (const locale of ['de-CH', 'en'] as const) {
      expect(resolve(CATALOG[locale], 'reports.source.manual')).toBeUndefined();
    }
  });
});

describe('the eleven K-64 source types render a translated label, not the raw key', () => {
  // The exact regression: these eleven engine source values had no key, so the Kontoblatt printed
  // e.g. the literal `reports.source.purchase`. This block fails on develop and passes after the fix.
  const K64_TYPES = [
    'purchase',
    'dunning',
    'credit_note',
    'camt',
    'stock',
    'landed_cost',
    'expense_claim',
    'asset_acquisition',
    'asset_depreciation',
    'asset_disposal',
    'inventory_valuation',
  ] as const;

  for (const type of K64_TYPES) {
    for (const locale of ['de-CH', 'en'] as const) {
      it(`${type} resolves to a real label in ${locale}`, () => {
        const key = sourceLabelKey(type);
        expect(key, `${type} must produce a label key`).toBe(`reports.source.${type}`);
        const label = resolve(CATALOG[locale], key as string);
        expect(label, `${type} has no ${locale} label`).toBeDefined();
        // A real label, never the raw key echoed back and never blank.
        expect(label).not.toBe(key);
        expect((label ?? '').trim().length).toBeGreaterThan(0);
      });
    }
  }
});
