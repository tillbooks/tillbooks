// @ts-check
/**
 * THE MOTION VOCABULARY IS A SET OF TOKENS, AND THE KILL SWITCH ZEROES EVERY ONE OF THEM.
 *
 * WHAT THIS GUARDS. D122 D-I (2026-09-05) chose the Responsive motion vocabulary: three moments
 * (navigate, commit, reveal), one ease pair, and a reduced-motion setting that zeroes everything.
 * The vocabulary ships ONCE, as `--t-motion-*` tokens in `brand/tokens/tokens.css`, and every
 * surface inherits it through `var()`. Two things can silently undo that:
 *
 *   1. A token goes missing or gets themed. A `var(--t-motion-reveal)` whose token was renamed
 *      computes to `initial`, which for `animation-duration` is `0s`: the motion vanishes and no
 *      test notices, because a `var()` of a missing name is valid CSS. And a motion token declared
 *      inside `[data-theme='dark']` would give the two themes two different rhythms, which is not
 *      what "motion is not themed" means.
 *   2. The `prefers-reduced-motion` block stops zeroing DELAYS as well as durations. DESIGN.md is
 *      explicit that an animation behind a 3s delay is still a 3s wait for the end state; the block
 *      has to zero `animation-delay` and `transition-delay` too, with `!important`, or the setting
 *      is a suggestion rather than a kill switch.
 *
 * THE RULES.
 *   - Every token the vocabulary names exists, once, in the theme-independent `:root` block.
 *   - Every `--t-motion-*` token carries a millisecond value, and the value is the one D-I chose.
 *   - The ease pair, the travel distance and the press scale exist.
 *   - The reduced-motion block zeroes the four properties with `!important`.
 *   - The JS mirror in `app/src/lib/motion.ts` (the fallback the primitives use when no stylesheet
 *     is loaded, e.g. under vitest with `css: false`) carries the SAME milliseconds as the CSS, so
 *     the two files cannot drift apart.
 *   - `brand/DESIGN.md` names every token and carries the one sentence D-I asked for verbatim.
 *   - A RATCHET over raw duration literals in the Studio's own CSS: the count may only go down.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TOKENS_FILE = 'brand/tokens/tokens.css';
const DESIGN_FILE = 'brand/DESIGN.md';
const MOTION_TS = 'app/src/lib/motion.ts';

/** The vocabulary, in milliseconds, exactly as D122 D-I chose it. */
const VOCABULARY_MS = {
  '--t-motion-nav-out': 80,
  '--t-motion-nav-in': 200,
  '--t-motion-pill': 120,
  '--t-motion-press': 80,
  '--t-motion-commit': 180,
  '--t-motion-tint': 720,
  '--t-motion-reveal': 200,
  '--t-motion-stagger': 30,
};

/** The rest of the vocabulary: the one ease pair, the travel distance, the press scale. */
const SHAPE_TOKENS = {
  '--t-ease-out': 'cubic-bezier(0.2, 0, 0, 1)',
  '--t-ease-in': 'cubic-bezier(0.4, 0, 1, 1)',
  '--t-travel': '8px',
  '--t-press-scale': '0.98',
};

/** The sentence D122 D-I added to DESIGN.md, verbatim. */
const STAGGER_SENTENCE =
  'A stagger of at most 30 ms per item over at most three items is a delay inside the budget, not a fourth duration.';

/**
 * `source` with every block comment blanked to spaces, newlines kept, so a token named in a comment
 * is never mistaken for a declaration.
 *
 * @param {string} source
 * @returns {string}
 */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Every `--name: value` declaration in `source`, in order, with the selector block it sits in.
 *
 * @param {string} source
 * @returns {{ name: string, value: string, block: string }[]}
 */
function declarations(source) {
  /** @type {{ name: string, value: string, block: string }[]} */
  const out = [];
  const clean = withoutComments(source);
  // Walk the top-level rule blocks: `selector { ... }`. Nested @media blocks are walked one level
  // deeper, which is as deep as the token file goes.
  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of clean.matchAll(blockRe)) {
    const selector = (m[1] ?? '').trim().split('\n').pop()?.trim() ?? '';
    const body = m[2] ?? '';
    for (const d of body.matchAll(/(?:^|[;\s])(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
      out.push({ name: d[1] ?? '', value: (d[2] ?? '').trim(), block: selector });
    }
  }
  return out;
}

const tokensSource = readFileSync(join(ROOT, TOKENS_FILE), 'utf8');
const decls = declarations(tokensSource);

test('every --t-motion-* token exists exactly once, in the theme-independent :root block', () => {
  for (const name of Object.keys(VOCABULARY_MS)) {
    const found = decls.filter((d) => d.name === name);
    assert.equal(found.length, 1, `${name} must be declared exactly once in ${TOKENS_FILE} (found ${found.length})`);
    assert.equal(found[0]?.block, ':root', `${name} must live in the bare :root block, never a theme block (motion is not themed)`);
  }
  // No motion token may be redeclared under a theme selector.
  const themed = decls.filter((d) => d.name.startsWith('--t-motion-') && d.block !== ':root');
  assert.deepEqual(themed, [], 'a --t-motion-* token declared inside a theme block would give light and dark two rhythms');
});

test('every --t-motion-* token carries the millisecond value D122 D-I chose', () => {
  const declaredMotion = decls.filter((d) => d.name.startsWith('--t-motion-'));
  assert.equal(
    declaredMotion.length,
    Object.keys(VOCABULARY_MS).length,
    `the token file declares ${declaredMotion.map((d) => d.name).join(', ')}; the vocabulary names ${Object.keys(VOCABULARY_MS).join(', ')}. Add a new moment to VOCABULARY_MS here, DESIGN.md and motion.ts together.`,
  );
  for (const [name, ms] of Object.entries(VOCABULARY_MS)) {
    const value = decls.find((d) => d.name === name)?.value ?? '';
    const m = /^(\d+(?:\.\d+)?)ms$/.exec(value);
    assert.ok(m, `${name} must be a millisecond literal like "80ms", got "${value}"`);
    assert.equal(Number(m?.[1]), ms, `${name} is ${value}; D122 D-I says ${ms}ms`);
  }
});

test('the ease pair, the travel distance and the press scale exist with the chosen values', () => {
  for (const [name, expected] of Object.entries(SHAPE_TOKENS)) {
    const found = decls.filter((d) => d.name === name);
    assert.equal(found.length, 1, `${name} must be declared exactly once`);
    assert.equal(found[0]?.value, expected, `${name} is "${found[0]?.value}", expected "${expected}"`);
    assert.equal(found[0]?.block, ':root', `${name} must live in the bare :root block`);
  }
});

test('the prefers-reduced-motion block zeroes durations AND delays, for animations AND transitions, with !important', () => {
  const clean = withoutComments(tokensSource);
  const at = clean.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(at >= 0, `${TOKENS_FILE} must carry a prefers-reduced-motion block`);
  const block = clean.slice(at);
  for (const rule of [
    /animation-duration:\s*0(?:\.001ms|s|ms)\s*!important/,
    /animation-delay:\s*0s\s*!important/,
    /transition-duration:\s*0(?:\.001ms|s|ms)\s*!important/,
    /transition-delay:\s*0s\s*!important/,
  ]) {
    assert.match(block, rule, `the reduced-motion block must declare ${rule.source}`);
  }
  // The universal selector, so a token-driven duration on any element is caught.
  assert.match(block, /\*\s*,\s*\*::before\s*,\s*\*::after/, 'the kill switch must apply to every element and pseudo-element');
});

test('DESIGN.md names every motion token and carries the D-I stagger sentence verbatim', () => {
  const design = readFileSync(join(ROOT, DESIGN_FILE), 'utf8');
  // The sentence wraps across a line in the markdown; compare with whitespace folded.
  const folded = design.replace(/\s+/g, ' ');
  assert.ok(folded.includes(STAGGER_SENTENCE), `${DESIGN_FILE} must carry: "${STAGGER_SENTENCE}"`);
  for (const name of [...Object.keys(VOCABULARY_MS), ...Object.keys(SHAPE_TOKENS)]) {
    assert.ok(design.includes(`\`${name}\``), `${DESIGN_FILE} must name ${name} in its Motion section`);
  }
});

test('the JS fallback table in motion.ts mirrors the CSS milliseconds exactly', () => {
  const ts = readFileSync(join(ROOT, MOTION_TS), 'utf8');
  for (const [name, ms] of Object.entries(VOCABULARY_MS)) {
    // The table is keyed by the CSS custom property name, so the mirror is checked by name.
    const re = new RegExp(`'${name}':\\s*(\\d+)`);
    const m = re.exec(ts);
    assert.ok(m, `${MOTION_TS} must carry a fallback entry '${name}': <ms>`);
    assert.equal(Number(m?.[1]), ms, `${MOTION_TS} says ${name} is ${m?.[1]}ms; the CSS says ${ms}ms`);
  }
});

/**
 * Raw duration literals in transition/animation declarations across the Studio's own CSS. A `0.12s`
 * spelled inline is a surface that opted out of the vocabulary; every one of them should be a token.
 *
 * @returns {{ file: string, line: number, literal: string }[]}
 */
function rawDurationLiterals() {
  /** @type {{ file: string, line: number, literal: string }[]} */
  const out = [];
  const files = execFileSync('git', ['ls-files', '-z', 'app/src'], { cwd: ROOT, maxBuffer: 1 << 28 })
    .toString('utf8')
    .split('\0')
    .filter((f) => f.endsWith('.css'));
  for (const f of files) {
    const source = withoutComments(readFileSync(join(ROOT, f), 'utf8'));
    for (const m of source.matchAll(/(?:transition|animation)(?:-duration|-delay)?\s*:[^;]*?(\b\d*\.?\d+(?:ms|s)\b)/g)) {
      out.push({ file: f, line: source.slice(0, m.index ?? 0).split('\n').length, literal: m[1] ?? '' });
    }
  }
  return out;
}

/**
 * THE RATCHET. The daily-path surfaces the D122 friction pass adopted carry none; the rest of the
 * Studio still spells eleven (the skeleton pulse, DataTable's sort chevron, and eight surfaces the
 * consistency sweep retires). This number may only go down: lower it in the same commit that
 * removes a literal, and never raise it.
 */
const RAW_DURATION_LITERAL_CEILING = 11;

test(`raw duration literals in Studio CSS stay at or below the ratchet (${RAW_DURATION_LITERAL_CEILING})`, () => {
  const hits = rawDurationLiterals();
  const listing = hits.map((h) => `  ${h.file}:${h.line} ${h.literal}`).join('\n');
  assert.ok(
    hits.length <= RAW_DURATION_LITERAL_CEILING,
    `${hits.length} raw duration literals in Studio CSS, ceiling ${RAW_DURATION_LITERAL_CEILING}. Use the --t-motion-* tokens:\n${listing}`,
  );
});

test('no daily-path surface stylesheet spells a raw duration literal', () => {
  const hits = rawDurationLiterals().filter((h) =>
    /^app\/src\/surfaces\/(Journal|Payments|Documents|Bills|Reconciliation|Periods)\//.test(h.file),
  );
  assert.deepEqual(hits, [], 'the daily-path surfaces inherit the vocabulary; a literal there is a regression');
});
