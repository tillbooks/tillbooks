/**
 * f16: German leaked into the EN pack. Two labels were the source German, not a translation:
 * `implProject.phase.liveLabel` read "Stabilisierung" and `check.run` read "Prüfen". They are the
 * English words now. Deliberate proper nouns retained across both packs (Eröffnungsprüfung,
 * Testmandant) are NOT translated and are asserted here so a future edit does not "fix" them wrongly.
 */
import { describe, it, expect } from 'vitest';
import en from './messages.en.json';

describe('migration EN pack house style (f16)', () => {
  it('translates the two leaked German labels to English', () => {
    expect(en.implProject.phase.liveLabel).toBe('Stabilisation');
    expect(en.check.run).toBe('Check');
  });

  it('keeps the intentional proper nouns unchanged', () => {
    expect(en.check.title).toBe('Eröffnungsprüfung');
    expect(en.migration.testmandant.banner.title).toContain('Testmandant');
  });
});
