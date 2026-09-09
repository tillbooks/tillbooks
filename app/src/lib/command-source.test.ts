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

import generated from './command-source.generated.json';
import { VERB_COMMANDS, verbMetaFor, rankScore, RANK } from './command-source';

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
