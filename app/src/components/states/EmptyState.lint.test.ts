/**
 * THE EMPTY-STATE LINT (K-33, D137): an empty state offers a way forward.
 *
 * WHAT WENT WRONG. Six surfaces said "Lege den ersten Eintrag an" and offered nothing to press; one
 * said it on a surface where there is no entry to create at all. The design law is plain ("an empty
 * list offers create", "No dead ends"), and nothing checked it, because an `<EmptyState>` without an
 * `action` is valid JSX that renders fine.
 *
 * THE RULE, read off the source (the way the i18n literal scan reads it), so a surface nobody opened
 * in a test is still judged:
 *   1. An `<EmptyState>` in a surface either passes `action` (the first step, mirroring the title) or
 *      is the filtered-empty state (`filtered`), whose action is "Filter zurücksetzen".
 *   2. A filtered-empty state never ALSO passes a create `action`: the component would drop it, and
 *      writing it is a claim the screen does not keep.
 *
 * Rule 1 is a RATCHET: the count measured when this landed (23.09.2026) may only go down. A surface
 * that fixes its empty state lowers the ceiling in the same commit. An `<EmptyState>` with a spread
 * (`{...props}`) cannot be read statically and is counted as passing; there is none today.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCOPES = ['surfaces', 'app'];

/**
 * The measured count of surface empty states with no action and no filter (23.09.2026, 73 across
 * the surfaces and the app shell; 53 after round 2 Part D, 24.09.2026). It only goes down.
 */
const NO_ACTION_CEILING = 53;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) out.push(path);
  }
  return out.sort();
}

interface Usage {
  file: string;
  line: number;
  /** The attribute text between `<EmptyState` and its closing `>` / `/>`. */
  attributes: string;
}

/**
 * Every `<EmptyState ...>` opening tag in `source`, with its attribute text. Braces are counted so an
 * arrow function inside an attribute (`onClick={() => a > b}`) does not end the tag early, and
 * strings (a JSX attribute string or one inside braces) are skipped for the same reason.
 */
function emptyStateUsages(source: string, file = ''): Usage[] {
  const found: Usage[] = [];
  const opener = /<EmptyState\b/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    let i = match.index + match[0].length;
    let depth = 0;
    let quote: string | null = null;
    while (i < source.length) {
      const c = source[i];
      if (quote !== null) {
        if (c === '\\') i += 1;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === '`') {
        quote = c;
      } else if (c === '{') {
        depth += 1;
      } else if (c === '}') {
        depth -= 1;
      } else if (depth === 0 && c === '>') {
        break;
      }
      i += 1;
    }
    found.push({
      file,
      line: source.slice(0, match.index).split('\n').length,
      attributes: source.slice(match.index + match[0].length, i),
    });
  }
  return found;
}

const hasAttr = (attributes: string, name: string): boolean =>
  new RegExp(`(^|\\s)${name}=`).test(attributes);
const hasSpread = (attributes: string): boolean => /\{\s*\.\.\./.test(attributes);

function allUsages(): Usage[] {
  return SCOPES.flatMap((scope) =>
    sources(join(APP_SRC, scope)).flatMap((path) =>
      emptyStateUsages(readFileSync(path, 'utf8'), relative(APP_SRC, path)),
    ),
  );
}

describe('the empty-state lint reads JSX correctly', () => {
  it('finds each opening tag and its attributes, arrow functions and strings included', () => {
    const source = [
      '<EmptyState title={t("a")} action={{ label: "x", onClick: () => (a > b ? go() : null) }} />',
      '<div><EmptyState hint="Ein > Zeichen" /></div>',
      '<EmptyState',
      '  filtered={{ onClear: () => setQ("") }}',
      '/>',
    ].join('\n');
    const usages = emptyStateUsages(source);
    expect(usages).toHaveLength(3);
    expect(hasAttr(usages[0]!.attributes, 'action')).toBe(true);
    expect(hasAttr(usages[1]!.attributes, 'action')).toBe(false);
    // The `>` inside the hint string did not end the tag.
    expect(usages[1]!.attributes).toContain('Ein > Zeichen');
    expect(hasAttr(usages[2]!.attributes, 'filtered')).toBe(true);
    expect(usages[2]!.line).toBe(3);
  });

  it('reads the real surfaces: there are empty states to judge', () => {
    expect(allUsages().length).toBeGreaterThan(20);
  });
});

describe('the empty-state lint (K-33)', () => {
  const usages = allUsages();

  it(`surface empty states with no action and no filter stay at or below ${NO_ACTION_CEILING}`, () => {
    const dead = usages.filter(
      (u) => !hasSpread(u.attributes) && !hasAttr(u.attributes, 'action') && !hasAttr(u.attributes, 'filtered'),
    );
    const list = dead.map((u) => `${u.file}:${u.line}`).join('\n');
    expect(dead.length, `Empty states with no way forward:\n${list}`).toBeLessThanOrEqual(NO_ACTION_CEILING);
  });

  it('a filtered-empty state never also offers a create action', () => {
    const both = usages.filter((u) => hasAttr(u.attributes, 'filtered') && hasAttr(u.attributes, 'action'));
    expect(both.map((u) => `${u.file}:${u.line}`)).toEqual([]);
  });
});
