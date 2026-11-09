/**
 * C2 (D118): the palette action set is DERIVED from the generated verb manifest, and the vendored
 * ranker orders hits on cmdk's tiers.
 *
 * Two drift walls stand between the palette and the registry. The node suite
 * (`test/planning/command-source-drift.test.mjs`) holds the generated manifest byte-equal to the
 * live registry. This suite holds the palette's `VERB_COMMAND` set equal to that manifest: every
 * exposed command names a manifest verb and takes its gate metadata from the manifest, never from a
 * hand-kept copy. Together they make "the human palette and the agent verb surface are structurally
 * the same list" a tested fact, not a claim a reviewer has to re-check.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import generated from './command-source.generated.json';
import { VERB_COMMANDS, verbMetaFor, rankScore, verbRank, RANK, AUTO_SELECT_MIN } from './command-source';
import { CATALOG, type Locale } from '../i18n';

const manifest = new Map((generated.verbs as { name: string }[]).map((v) => [v.name, v]));

describe('C2 parity: the palette action set is derived from the manifest', () => {
  it('every exposed verb command names a live manifest verb', () => {
    for (const cmd of VERB_COMMANDS) {
      expect(manifest.has(cmd.name), `${cmd.name} is not in the generated manifest`).toBe(true);
    }
  });

  it('takes each command gate straight from the manifest, so a hand-edited copy cannot drift', () => {
    for (const cmd of VERB_COMMANDS) {
      const meta = verbMetaFor(cmd.name);
      expect(meta, `no manifest metadata for ${cmd.name}`).toBeDefined();
      // The command's gate IS the manifest's gate: same reference-by-value, no second source.
      expect(cmd.capabilities).toEqual(meta!.capabilities);
      expect(cmd.gateDynamic).toBe(meta!.gateDynamic);
    }
  });

  it('projects the dial capability for every dial-governed verb (C4 seam rides the same manifest)', () => {
    // A representative money-path verb carries its dial capability; a plain read carries null.
    expect(verbMetaFor('post_entry')?.dialCapability).toBe('post');
    expect(verbMetaFor('vat_mark_filed')?.dialCapability).toBe('vat-file');
    const read = generated.verbs.find((v) => v.kind === 'read');
    expect(read?.dialCapability ?? null).toBe(null);
  });
});

describe('C2 ranker: cmdk tiers, hand-rolled, zero dependency', () => {
  it('orders exact > prefix > word-boundary prefix > substring > subsequence > none', () => {
    expect(rankScore('offene posten', 'Offene Posten')).toBe(RANK.exact);
    expect(rankScore('offene', 'Offene Posten')).toBe(RANK.prefix);
    expect(rankScore('post', 'Offene Posten')).toBe(RANK.wordPrefix);
    expect(rankScore('ffene', 'Offene Posten')).toBe(RANK.substring);
    expect(rankScore('ofpn', 'Offene Posten')).toBe(RANK.subsequence);
    expect(rankScore('zzz', 'Offene Posten')).toBe(RANK.none);
  });

  it('ranks a better match strictly higher, so the best hit sorts first', () => {
    expect(rankScore('bel', 'Belege')).toBeGreaterThan(rankScore('ege', 'Belege'));
    expect(rankScore('ege', 'Belege')).toBeGreaterThan(rankScore('bee', 'Belege'));
  });

  it('folds diacritics so an umlaut-free keyboard still reaches a de-CH label', () => {
    expect(rankScore('ubersicht', 'Übersicht')).toBe(RANK.exact);
    expect(rankScore('ubers', 'Übersicht')).toBe(RANK.prefix);
    expect(rankScore('bersicht', 'Übersicht')).toBe(RANK.substring);
  });

  it('an empty query matches nothing', () => {
    expect(rankScore('', 'anything')).toBe(RANK.none);
    expect(rankScore('   ', 'anything')).toBe(RANK.none);
  });
});

/** The catalogue value at a dotted key in one locale, or undefined. */
function lookup(locale: Locale, key: string): string | undefined {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
      CATALOG[locale],
    );
  return typeof value === 'string' ? value : undefined;
}

const tFor =
  (locale: Locale) =>
  (key: string): string =>
    lookup(locale, key) ?? key;

const APP_SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A surface source file by its base name, wherever its surface directory is. */
function surfaceFile(base: string): string {
  const root = join(APP_SRC, 'surfaces');
  for (const dir of readdirSync(root)) {
    const candidate = join(root, dir, base);
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      // not in this directory
    }
  }
  throw new Error(`no surface file named ${base}`);
}

/**
 * K-42 (D137): the surface header's primary label for each exposed verb, and where it lives. The
 * table is held to the source below (the key must still sit on that surface), so a relabelled or
 * moved button reddens this suite instead of silently falling out of the palette.
 */
/** `file` is the surface source's base name (the directory is found, not spelled). */
const HEADER_PRIMARY: readonly { verb: string; file: string; key: string }[] = [
  { verb: 'post_entry', file: 'Journal.tsx', key: 'journal.newEntry' },
  { verb: 'post_entry', file: 'HomeDoors.tsx', key: 'dashboard.doors.book' },
  { verb: 'record_payment', file: 'Payments.tsx', key: 'payment.record' },
  { verb: 'create_document', file: 'Documents.tsx', key: 'document.new' },
  { verb: 'create_contact', file: 'Contacts.tsx', key: 'contact.new' },
  { verb: 'create_item', file: 'Items.tsx', key: 'item.new' },
  { verb: 'quotes_create', file: 'Quotes.tsx', key: 'quotes.action.create' },
  { verb: 'sales_order_create', file: 'SalesOrders.tsx', key: 'so.action.new' },
  { verb: 'requisition_upsert', file: 'Requisitions.tsx', key: 'requisitions.new' },
];

describe('K-42: one verb answers to every word the product uses for it', () => {
  it('every alias key exists, non-empty, in BOTH locales', () => {
    for (const cmd of VERB_COMMANDS) {
      if (cmd.aliasKey === undefined) continue;
      for (const locale of ['de-CH', 'en'] as const) {
        expect(lookup(locale, cmd.aliasKey), `${cmd.name} ${locale}`).toMatch(/\S/);
      }
    }
  });

  it('the header-primary table still points at a real button label on each surface', () => {
    for (const row of HEADER_PRIMARY) {
      const source = surfaceFile(row.file);
      expect(source.includes(`t('${row.key}')`), `${row.file} no longer renders ${row.key}`).toBe(true);
      expect(VERB_COMMANDS.some((c) => c.name === row.verb), `${row.verb} is not an exposed verb`).toBe(true);
    }
  });

  it('DRIFT: each surface header primary label resolves its verb in the palette, in both locales', () => {
    for (const row of HEADER_PRIMARY) {
      const cmd = VERB_COMMANDS.find((c) => c.name === row.verb);
      expect(cmd).toBeDefined();
      for (const locale of ['de-CH', 'en'] as const) {
        const label = lookup(locale, row.key);
        expect(label, `${row.key} ${locale}`).toBeDefined();
        // The button's own words are an EXACT hit (an alias), never a prefix or a guess.
        expect(verbRank(label as string, cmd!, tFor(locale)), `"${label}" (${locale}) -> ${row.verb}`).toBe(RANK.exact);
      }
    }
  });

  it('a question is not a subsequence hit: from three words or sixteen characters the tier is off', () => {
    expect(rankScore('wie viele offene rechnungen habe ich', 'Berichtigungsabrechnung')).toBe(RANK.none);
    expect(rankScore('bchg erfassen xyz', 'Buchung erfassen')).toBe(RANK.none);
    // A short, hurried query keeps the tier.
    expect(rankScore('bchg', 'Buchung')).toBe(RANK.subsequence);
    // And the auto-select floor sits above it, so a subsequence never takes Enter from the ask row.
    expect(AUTO_SELECT_MIN).toBeGreaterThan(RANK.subsequence);
    expect(AUTO_SELECT_MIN).toBeLessThanOrEqual(RANK.substring);
  });
});

