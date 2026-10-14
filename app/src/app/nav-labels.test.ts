/**
 * The rail's WORDS, asserted per locale: no two rail rows read the same.
 *
 * WHY (D152, rule 3 "one action, one place", applied to the rail). The cognitive-load audit found two
 * pairs of rail rows sharing one label: "Lager" named both /inventory and /warehouses, and
 * "Auswertungen" named both /reports and /procurement-analytics. Two rows with one name ask the reader
 * to open both to learn which is which. The owner renamed them (Lagerbestand, Lagerorte,
 * Einkaufsauswertung), then named the three older heading twins this guard surfaced: /report-builder
 * is "Berichtsgenerator" (so /reports takes "Berichte", the group heading that opens it), /purchasing
 * "Bestellungen" (it read as the Einkauf heading, which opens /requisitions) and the /vat row
 * "MWST-Einstellungen" (it read as the Einstellungen heading, which opens /setup). This suite keeps
 * the next surface from quietly reintroducing a twin, and it carries no allowlist.
 *
 * WHAT COUNTS AS A ROW. Every treeitem the rail can show: each destination leaf, each parent heading
 * (Lager, Anlagen, MWST) and each group heading (Stammdaten, Berichte...). A heading is a row in its
 * own right: a click on it lands on its first leaf (D135). So a heading MAY share its word with the
 * one leaf it lands on (group "Projekte" opens /projects "Projekte": one place, two doors to it), and
 * a heading that shares a word with a leaf it does NOT land on is the same defect as two leaves
 * sharing one.
 *
 * The labels are resolved through the real merged catalogue (shell locale plus every surface
 * fragment), so a surface overriding a `nav.*` key in its own messages file is judged by what the
 * person actually reads.
 */
import { describe, expect, it } from 'vitest';

import { CATALOG, type Locale, type Messages } from '../i18n';
import { firstLeafPath, isNavParent, NAV_RAIL } from './nav';

const LOCALES: readonly Locale[] = Object.keys(CATALOG) as Locale[];

/** One rail row: what kind it is, its stable navId, the label key it renders, and the path a click
 *  on it opens (a leaf's own path; a heading's first leaf, D135). */
interface RailRow {
  kind: 'group' | 'parent' | 'leaf';
  navId: string;
  labelKey: string;
  opens: string | null;
}

/** Every labelled row of the canonical rail, in rail order. A headerless cluster shows no heading. */
function railRows(): RailRow[] {
  const rows: RailRow[] = [];
  for (const group of NAV_RAIL) {
    if (group.labelKey !== null) {
      rows.push({ kind: 'group', navId: group.navId, labelKey: group.labelKey, opens: firstLeafPath(group) });
    }
    for (const node of group.items) {
      if (isNavParent(node)) {
        rows.push({ kind: 'parent', navId: node.navId, labelKey: node.labelKey, opens: firstLeafPath(node) });
        for (const child of node.children) {
          rows.push({ kind: 'leaf', navId: child.navId, labelKey: child.labelKey, opens: child.path });
        }
      } else {
        rows.push({ kind: 'leaf', navId: node.navId, labelKey: node.labelKey, opens: node.path });
      }
    }
  }
  return rows;
}

function resolve(tree: Messages, key: string): string | undefined {
  let node: unknown = tree;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/** All pairs of rows that render the same label (case- and whitespace-insensitive) in a locale AND
 *  open different places. Two rows that open the same place are one action with two doors (a heading
 *  and the leaf it lands on), which rule 3 does not forbid. */
function collisions(locale: Locale): Array<{ label: string; a: RailRow; b: RailRow }> {
  const tree = CATALOG[locale];
  const byLabel = new Map<string, RailRow[]>();
  for (const row of railRows()) {
    const label = resolve(tree, row.labelKey);
    if (label === undefined) continue; // a missing key is the locale-completeness suite's failure
    const norm = label.trim().replace(/\s+/g, ' ').toLocaleLowerCase(locale);
    byLabel.set(norm, [...(byLabel.get(norm) ?? []), row]);
  }
  const out: Array<{ label: string; a: RailRow; b: RailRow }> = [];
  for (const [label, rows] of byLabel) {
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const a = rows[i] as RailRow;
        const b = rows[j] as RailRow;
        if (a.opens !== b.opens) out.push({ label, a, b });
      }
    }
  }
  return out;
}

describe('rail labels (D152 rule 3)', () => {
  it('covers more than one locale and resolves every row label in each', () => {
    expect(LOCALES.length).toBeGreaterThan(1);
    for (const locale of LOCALES) {
      for (const row of railRows()) expect(resolve(CATALOG[locale], row.labelKey), `${locale} ${row.labelKey}`).toBeTruthy();
    }
  });

  it.each(LOCALES)('gives every rail row its own label in %s, with no exceptions', (locale) => {
    // No allowlist: a new twin gets a name from the owner, not an entry here.
    const offenders = collisions(locale).map(({ label, a, b }) => `"${label}": ${a.kind} ${a.navId} and ${b.kind} ${b.navId}`);
    expect(offenders).toEqual([]);
  });

  it('pins the owner-approved names of the four rows the audit found twinned (de-CH)', () => {
    const de = CATALOG['de-CH'];
    expect(resolve(de, 'nav.inventory')).toBe('Lagerbestand');
    expect(resolve(de, 'nav.warehouses')).toBe('Lagerorte');
    expect(resolve(de, 'nav.reports')).toBe('Berichte');
    expect(resolve(de, 'nav.procurementAnalytics')).toBe('Einkaufsauswertung');
  });

  it('pins the owner-approved names of the three heading twins (de-CH)', () => {
    const de = CATALOG['de-CH'];
    expect(resolve(de, 'nav.reportBuilder')).toBe('Berichtsgenerator');
    expect(resolve(de, 'nav.purchasing')).toBe('Bestellungen');
    expect(resolve(de, 'nav.mwst.settings')).toBe('MWST-Einstellungen');
  });

  it('gives the renamed surfaces a page title that matches their rail row', () => {
    for (const locale of LOCALES) {
      const tree = CATALOG[locale];
      expect(resolve(tree, 'stock.route.title')).toBe(resolve(tree, 'nav.inventory'));
      expect(resolve(tree, 'reports.title')).toBe(resolve(tree, 'nav.reports'));
      expect(resolve(tree, 'procurement.analytics.title')).toBe(resolve(tree, 'nav.procurementAnalytics'));
      expect(resolve(tree, 'reportBuilder.route.title')).toBe(resolve(tree, 'nav.reportBuilder'));
      expect(resolve(tree, 'po.title')).toBe(resolve(tree, 'nav.purchasing'));
      expect(resolve(tree, 'vat.settings.title')).toBe(resolve(tree, 'nav.mwst.settings'));
    }
  });
});
