/**
 * The guard that retires the bespoke-currency-format class from the Studio surfaces (kaizen K-71).
 *
 * THE DEFECTS IT EXISTS FOR. A shared formatter, `formatMoney(minor, currency)` in
 * `app/src/i18n/index.tsx`, groups thousands de-CH ("CHF 28'000.00", "CHF 1'000'000.00") and honours
 * the currency it is given. Several operations surfaces bypassed it with a hand-rolled
 * `` `CHF ${(rappen / 100).toFixed(2)}` `` (hardcoded CHF, no grouping) or rendered raw minor units.
 * Three verified findings came out of that class:
 *
 *   - rt-f3 (HIGH, material misstatement). `PurchaseVersions` printed every purchase-order total as
 *     CHF regardless of the row's `currency`, so PO-0001 (currency EUR, total 900000 minor) read
 *     "CHF 9000.00" instead of "EUR 9'000.00": wrong currency AND wrong magnitude presentation.
 *   - rt-f2 (MEDIUM). `InventoryMovements` rendered the unit-cost snapshot as the RAW integer
 *     (`m.unitCostMinor ?? '-'`), so a CHF 36.00 cost showed as "3600", a 100x misread, under a
 *     plain "Stückkosten" column with no "(Rappen)" qualifier.
 *   - rt-f5 (MEDIUM). Six surfaces (`Requisitions`, `FixedAssets/AssetRegister`,
 *     `.../AssetReports`, `.../AssetReconciliation`, `.../AssetDepreciation`,
 *     `.../AssetDepreciationRuns`) each carried the ungrouped `` `CHF ${(r / 100).toFixed(2)}` ``
 *     helper, dropping the de-CH thousands separator on every figure.
 *
 * All eight were repaired to go through `formatMoney`. Because the anti-pattern recurred across eight
 * files, the class is retired MECHANICALLY here rather than left to vigilance: this guard scans every
 * non-test `.tsx` source file under `app/src/surfaces` and fails on the exact signature of the
 * ungrouped bespoke formatter, so the NEXT author who hand-rolls one fails this suite by name.
 *
 * THE SIGNATURE, KEPT SPECIFIC. The match is a hardcoded three-letter currency literal (CHF | EUR |
 * USD) that is followed, on the same line, by a `/ 100).toFixed(` division. That is precisely the
 * ungrouped-currency-display bug and nothing else:
 *   - It does NOT flag `formatMoney(x, 'CHF')`: the currency literal is there, but no `/100).toFixed`
 *     follows it (the shared formatter does its own grouping, no `toFixed`).
 *   - It does NOT flag a legitimate non-currency `(x / 100).toFixed(2)` used to seed a numeric form
 *     input (major units for an <input>), because no currency literal sits on that line.
 *   - It does NOT flag the grouped `toLocaleString('de-CH', …)` helpers still living in
 *     `ThreeWayMatch` / `ProcurementAnalytics` / `InventoryAlerts`: they group correctly and carry no
 *     currency literal, so they are a different (currency-prefix-absent) question, out of K-71 scope.
 *
 * NO GRANDFATHERED INSTANCES REMAIN. `FixedAssets/AssetCategories.tsx` carried the last one: its
 * `residualLabel` hand-rolled a hardcoded ungrouped `CHF ${… / 100).toFixed(2)}` for a category's
 * default residual value. It was explicitly scoped OUT of the original K-71 sweep (that surface was
 * not in the finding set and is a separate file-ownership territory), then folded into `formatMoney`
 * in a follow-up and struck from GRANDFATHERED, closing the K-71 money-format class. The set below is
 * now empty: it is DEBT to burn down, never a place to add new names. A new surface that matches this
 * guard is a new defect, not a new allowlist row.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SURFACES_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The one file allowed to still match, with the reason. This is DEBT to burn down, not a place to add
 * new names: a new surface that needs to match this guard is a new defect, not a new allowlist row.
 */
const GRANDFATHERED = new Set<string>([
  // Empty: the last grandfathered instance (`FixedAssets/AssetCategories.tsx`, whose `residualLabel`
  // hand-rolled an ungrouped `CHF ${… / 100).toFixed(2)}`) was folded into `formatMoney` and its entry
  // deleted, closing the K-71 money-format class. This is DEBT to burn down, not a place to add new
  // names: a new surface that needs to match this guard is a new defect, not a new allowlist row.
]);

/**
 * The ungrouped-currency-display signature: a CHF | EUR | USD literal followed on the SAME line by a
 * `/ 100).toFixed(` division. Deliberately narrow (see the header) so it flags the bespoke formatter
 * and never `formatMoney`, a numeric form-input seed, or a grouped `toLocaleString` helper.
 */
const BESPOKE_CURRENCY_FORMAT = /(?:CHF|EUR|USD)[^\n]*\/\s*100\s*\)\s*\.toFixed\s*\(/;

/** Every `*.tsx` under the surfaces tree, excluding `*.test.tsx`, as paths relative to the tree. */
function surfaceSources(dir: string = SURFACES_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...surfaceSources(full));
    } else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/** The lines of a file that match the bespoke-format signature, as `1-based-line: text`. */
function offendingLines(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const hits: string[] = [];
  src.split('\n').forEach((line, i) => {
    if (BESPOKE_CURRENCY_FORMAT.test(line)) hits.push(`${i + 1}: ${line.trim()}`);
  });
  return hits;
}

const rel = (file: string): string => relative(SURFACES_DIR, file).split(sep).join('/');

describe('the K-71 signature matcher proves itself, every run', () => {
  // The synthetic samples are built without a real backtick or a real interpolation so the file's own
  // lexer never sees a template literal here; the regex only cares about the currency word and the
  // `/ 100).toFixed(` tail, both present as plain text.
  it('flags a hardcoded-currency + ungrouped toFixed display, in helper or inline form', () => {
    expect(BESPOKE_CURRENCY_FORMAT.test('const chf = (r) => CHF (r / 100).toFixed(2);')).toBe(true);
    expect(BESPOKE_CURRENCY_FORMAT.test('return EUR (total / 100).toFixed(2);')).toBe(true);
    expect(BESPOKE_CURRENCY_FORMAT.test('return USD (x / 100).toFixed(2);')).toBe(true);
  });

  it('does NOT flag formatMoney, a numeric form seed, or a grouped toLocaleString helper', () => {
    expect(BESPOKE_CURRENCY_FORMAT.test("render: (r) => formatMoney(r.totalRappen, 'CHF')")).toBe(false);
    expect(BESPOKE_CURRENCY_FORMAT.test('costMajor: (a.acquisitionCostRappen / 100).toFixed(2),')).toBe(false);
    expect(BESPOKE_CURRENCY_FORMAT.test("const chf = (r) => (r / 100).toLocaleString('de-CH', {})")).toBe(false);
  });
});

describe('no surface hand-rolls a bespoke currency formatter (K-71 guard)', () => {
  it('finds surface source files to scan at all', () => {
    // A scan that silently walked an empty tree is a green that proves nothing.
    expect(surfaceSources().length).toBeGreaterThan(20);
  });

  it('has zero bespoke-currency-format matches outside the grandfathered set', () => {
    const offenders = surfaceSources()
      .filter((file) => !GRANDFATHERED.has(rel(file).split('/').join(sep)))
      .flatMap((file) => offendingLines(file).map((hit) => `${rel(file)}:${hit}`));
    // Every figure goes through formatMoney(minor, currency). A match here means a new bespoke
    // formatter crept in: use formatMoney(minor, currency) instead (it groups de-CH and honours the
    // currency), never a hand-rolled currency-word plus an ungrouped toFixed on a /100 division.
    expect(offenders, 'bespoke currency formatter(s) found: use formatMoney(minor, currency)').toEqual([]);
  });

  it('proves every grandfathered exemption still bites (delete it once the file is fixed)', () => {
    for (const relPath of GRANDFATHERED) {
      const file = join(SURFACES_DIR, relPath);
      expect(
        offendingLines(file).length,
        `${relPath.split(sep).join('/')} no longer matches: it was fixed, so remove it from GRANDFATHERED`,
      ).toBeGreaterThan(0);
    }
  });
});
