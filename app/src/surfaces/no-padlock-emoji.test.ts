/**
 * The guard that stops the raw padlock emoji ever returning as a status marker in a Studio surface.
 *
 * THE DEFECT (kaizen K-73 / K-77). The padlock emoji (U+1F512, and its open twin U+1F513) was used
 * as a permission-denied marker and a lock-action label across eight surfaces: a raw
 * `<span aria-hidden="true">🔒</span>` beside the denied text, the Time "Sperren" button prefix, and
 * one entry in Time's `STATUS_GLYPHS` record. That is exactly the pattern brand/DESIGN.md's forbidden
 * list bans by name, "Emoji as section markers or status. Status is a glyph, not a face.", and the
 * owner has banned it explicitly. The emoji also renders as a full-colour vendor-specific picture
 * next to flat monochrome UI, which is the slop tell the ban exists to kill.
 *
 * THE FIX THE GUARD PROTECTS. A permission-denied state renders the shared `<PermissionDenied />`
 * panel (`components/states`), whose `<LockGlyph />` is a monochrome inline SVG paired with text. A
 * lock ACTION button renders the shared `<LockGlyph />` directly. A string-valued status glyph (the
 * one in `Time/model.ts`) uses a geometric text glyph in the same family as its siblings. None of
 * these carry an emoji codepoint, so this guard, which reads every surface source off disk and fails
 * on either padlock codepoint, holds all three fixes in place and fails the NEXT surface that reaches
 * for the emoji again, by file and line.
 *
 * DELIBERATELY SCOPED TO THE PADLOCK FAMILY. This guard bans ONLY U+1F512 and U+1F513, not every
 * emoji. Other status emoji still live in the tree (for example the checkmark on the approve buttons),
 * and sweeping them is a SEPARATE, not-yet-done finding with its own fix. Banning them here, before
 * that sweep, would red the gate on code no one has migrated yet. So the narrow scope is a documented
 * decision, NOT a blanket disable: when the checkmark sweep lands, widen this guard (or add a sibling)
 * rather than assume it already covers them.
 *
 * IT READS SOURCES OFF DISK, like `Reports/source-vocabulary.test.ts` and the loading-state guard,
 * because reading a file as text lets one test make a claim about every other source file without
 * importing (and running) it. `*.test.ts`/`*.test.tsx` files are excluded from the scan: a regression
 * test legitimately NAMES the forbidden codepoint (as the escape `\u{1F512}` inside a
 * `not.toContain(...)` assertion), and that escape is proof of the fix, not a violation. This guard
 * file itself builds the two forbidden codepoints from their numbers via `String.fromCodePoint`, so
 * its own bytes contain no padlock and it would pass even if it did not exclude itself.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SURFACES = dirname(fileURLToPath(import.meta.url));

/**
 * The two banned codepoints, built from their numbers so this guard's own source carries no padlock
 * glyph. U+1F512 CLOSED LOCK ("🔒") and U+1F513 OPEN LOCK ("🔓").
 */
const CLOSED_LOCK = String.fromCodePoint(0x1f512);
const OPEN_LOCK = String.fromCodePoint(0x1f513);
const PADLOCKS = [CLOSED_LOCK, OPEN_LOCK] as const;

/**
 * Every non-test surface source under `app/src/surfaces`. `*.test.ts(x)` is excluded: a regression
 * test may name the codepoint via a `\u{...}` escape as proof of the fix, and that escape text is not
 * an emoji byte anyway. Scans `.ts` and `.tsx` so a string-valued glyph in a plain `model.ts` (the
 * K-77 Time case) is covered, not just JSX.
 */
function surfaceSources(dir: string = SURFACES): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...surfaceSources(path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out.sort();
}

/** Every padlock hit in a source: the offending codepoint and the 1-based line it sits on. */
function padlockHits(source: string): { glyph: string; line: number }[] {
  const hits: { glyph: string; line: number }[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    for (const glyph of PADLOCKS) {
      if (lines[i].includes(glyph)) hits.push({ glyph, line: i + 1 });
    }
  }
  return hits;
}

const SOURCES = surfaceSources();

describe('the padlock scan can actually see the surfaces', () => {
  // A scan that silently matches no files passes the ban below it vacuously. This is the difference
  // between "no surface uses the emoji" and "the walker found nothing and nobody noticed".
  it('reads a plausible number of surface sources off disk', () => {
    expect(SOURCES.length).toBeGreaterThan(50);
  });

  it('excludes test files, which may legitimately name the codepoint as an escape', () => {
    expect(SOURCES.some((p) => /\.test\.tsx?$/.test(p))).toBe(false);
  });
});

describe('no Studio surface uses the padlock emoji as a status marker (DESIGN forbidden list)', () => {
  it('leaves zero padlock codepoints in any non-test surface source', () => {
    const offenders = SOURCES.flatMap((path) =>
      padlockHits(readFileSync(path, 'utf8')).map(
        (h) => `${relative(SURFACES, path)}:${h.line}`,
      ),
    );

    expect(
      offenders,
      'These surface sources use the padlock emoji (U+1F512/U+1F513) as a status marker, which ' +
        'brand/DESIGN.md bans ("Emoji as section markers or status"). For a permission-denied state ' +
        'render the shared <PermissionDenied /> panel from components/states; for a lock action ' +
        'button or an inline lock marker use the shared <LockGlyph /> SVG (components/states/glyphs); ' +
        'for a string-valued status glyph use a geometric text glyph, never an emoji.',
    ).toEqual([]);
  });
});

/**
 * The matcher, proven against strings it does not read from disk. A guard nobody has watched fire is
 * not a guard: these run the scanner over the shape it exists to catch and the shapes it must leave
 * alone, so the rule is demonstrated here rather than only asserted over the current (clean) tree.
 */
describe('the matcher fires on the shape it exists to catch', () => {
  it('flags a raw padlock span, and reports its line', () => {
    const bad = ['<div>', `  <span aria-hidden="true">${CLOSED_LOCK}</span> {t('x.denied')}`, '</div>'].join(
      '\n',
    );
    expect(padlockHits(bad)).toEqual([{ glyph: CLOSED_LOCK, line: 2 }]);
  });

  it('flags the open-lock twin as well', () => {
    expect(padlockHits(`const glyph = '${OPEN_LOCK}';`)).toHaveLength(1);
  });

  it('passes the shared-affordance fix: a PermissionDenied panel with no emoji', () => {
    const good = "return <PermissionDenied body={t('migration.denied')} />;";
    expect(padlockHits(good)).toEqual([]);
  });

  it('passes the LockGlyph SVG idiom, which carries no emoji codepoint', () => {
    const good = "<button><LockGlyph size={14} /> {t('time.action.lock')}</button>";
    expect(padlockHits(good)).toEqual([]);
  });

  it('does NOT ban other status emoji: the checkmark sweep is a separate, not-yet-done finding', () => {
    // A deliberate proof of scope. The approve-button checkmark is slop too, but it is fixed under a
    // different finding; this guard must not red the gate on it before that fix exists.
    const checkmark = String.fromCodePoint(0x2714); // ✔ HEAVY CHECK MARK
    expect(padlockHits(`<button>${checkmark} {t('approve')}</button>`)).toEqual([]);
  });
});
