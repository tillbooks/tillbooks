// @ts-check
/**
 * THE TYPE SCALE IS WRITTEN DOWN AS TOKENS, AND RAW FONT SIZES ONLY EVER GO DOWN.
 *
 * WHAT THIS GUARDS (UI polish round 2, K-37, D137). DESIGN.md named the typeface, the weights and
 * the case, but never a size, so every surface picked one: 802 `font-size` declarations across 35
 * values, 129 of them resolving to fractional pixels (14.4, 13.6, 12.8, 16.8), and the most common
 * size (13px) was not the body size (14px). The owner took the written scale: seven size tokens with
 * their line heights in `brand/tokens/tokens.css`, theme-independent like density, and no CSS case
 * transforms (a `text-transform: uppercase` turned "Aktiven" into the all-caps German compound the
 * design law bans by name, and a `lowercase` misspelt the German nouns in the palette).
 *
 * THE RULES.
 *   - The seven `--t-font-*` steps and their `--t-lh-*` line heights exist once each, in the bare
 *     `:root` block (never a theme block: type is not themed), with the values D137 chose.
 *   - DESIGN.md names every one of them in its Type section.
 *   - The shared core (`tokens.css`, `global.css`, `motion.css`) carries NO literal font size and
 *     NO case transform. Surfaces reach for a step; the core is where the steps are defined.
 *   - A RATCHET over the rest of the Studio CSS: literal px font sizes, literal rem/em/% font sizes,
 *     case transforms and literal border radii may only go DOWN. A surface agent that migrates a
 *     file lowers the ceiling in the same commit; nobody raises it.
 *
 * The scanner reads comment-blanked source (offsets preserved), so a size or a transform mentioned
 * in a comment is never counted. Synthetic must-catch and must-pass fixtures prove the counters bite
 * before the corpus is judged, so a green verdict is a fact and not an empty scan.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { cleanGitEnv } from '../lib/git-env.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TOKENS_FILE = 'brand/tokens/tokens.css';
const DESIGN_FILE = 'brand/DESIGN.md';
/** The shared core: the one place type steps are defined, so it spells none of its own. */
const CORE_FILES = [TOKENS_FILE, 'app/src/styles/global.css', 'app/src/styles/motion.css'];

/** The scale, exactly as D137 (K-37) chose it: size and line height per step, in px. */
const SCALE = {
  xs: [11, 16],
  sm: [12, 16],
  md: [13, 18],
  body: [14, 20],
  lg: [16, 24],
  xl: [20, 28],
  '2xl': [24, 32],
};

/**
 * THE RATCHETS, measured on 2026-09-23 after the core migration (K-37): literal px sizes 404 before,
 * 363 after; rem/em/% sizes 396 before, 393 after; case transforms 4 before, 3 after; literal radii
 * 91 (the core had none). Round 2 Part D (D137, 24.09.2026) migrated the surfaces: literal px sizes
 * 363 to 0, rem/em/% sizes 393 to 6, case transforms 3 to 0, literal radii 91 to 0. Every number may
 * only go down: lower it in the same commit that migrates a surface, and never raise it.
 */
const RAW_PX_FONT_SIZE_CEILING = 0;
const RAW_RELATIVE_FONT_SIZE_CEILING = 6;
const CASE_TRANSFORM_CEILING = 0;
const RAW_RADIUS_CEILING = 0;

/**
 * `source` with every block comment blanked to spaces, newlines kept.
 *
 * @param {string} source
 * @returns {string}
 */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Tracked CSS files under `app/src`, repo-relative.
 *
 * @returns {string[]}
 */
function appCssFiles() {
  return execFileSync('git', ['ls-files', '-z', 'app/src'], { cwd: ROOT, maxBuffer: 1 << 28, env: cleanGitEnv() })
    .toString('utf8')
    .split('\0')
    .filter((f) => f.endsWith('.css'));
}

/** @typedef {{ line: number, text: string }} Hit */

/**
 * Every value of `property` declared in `source`, with its line. A declaration starts at a rule-body
 * delimiter or whitespace, so a selector fragment is never read as one.
 *
 * @param {string} source
 * @param {string} property
 * @returns {{ line: number, value: string }[]}
 */
function valuesOf(source, property) {
  const clean = withoutComments(source);
  const re = new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;}]+)`, 'g');
  return [...clean.matchAll(re)].map((m) => ({
    line: clean.slice(0, m.index ?? 0).split('\n').length,
    value: (m[1] ?? '').trim(),
  }));
}

/**
 * Literal font sizes in `source`, split into px and relative (rem, em, %). A `var(--t-font-*)` is a
 * step and is not counted; `inherit` and the other keywords set no size of their own.
 *
 * @param {string} source
 * @returns {{ px: Hit[], relative: Hit[] }}
 */
function literalFontSizes(source) {
  /** @type {Hit[]} */
  const px = [];
  /** @type {Hit[]} */
  const relative = [];
  for (const { line, value } of valuesOf(source, 'font-size')) {
    if (/\b\d*\.?\d+px\b/.test(value)) px.push({ line, text: value });
    else if (/\b\d*\.?\d+(?:rem|em|%)(?![a-z])/.test(value)) relative.push({ line, text: value });
  }
  return { px, relative };
}

/**
 * `text-transform` declarations that change the case of the words.
 *
 * @param {string} source
 * @returns {Hit[]}
 */
function caseTransforms(source) {
  return valuesOf(source, 'text-transform')
    .filter(({ value }) => /\b(?:uppercase|lowercase|capitalize)\b/.test(value))
    .map(({ line, value }) => ({ line, text: value }));
}

/**
 * `border-radius` declarations (and the per-corner longhands) with a literal length instead of a
 * `--t-radius-*` step.
 *
 * @param {string} source
 * @returns {Hit[]}
 */
function literalRadii(source) {
  /** @type {Hit[]} */
  const out = [];
  for (const property of ['border-radius', 'border-(?:top|bottom)-(?:left|right)-radius']) {
    for (const { line, value } of valuesOf(source, property)) {
      if (/\b\d*\.?\d+(?:px|rem|em|%)/.test(value)) out.push({ line, text: value });
    }
  }
  return out;
}

/**
 * Every `--name: value` declaration in `source` with the selector of the block it sits in.
 *
 * @param {string} source
 * @returns {{ name: string, value: string, block: string }[]}
 */
function declarations(source) {
  /** @type {{ name: string, value: string, block: string }[]} */
  const out = [];
  for (const m of withoutComments(source).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const block = (m[1] ?? '').trim().split('\n').pop()?.trim() ?? '';
    for (const d of (m[2] ?? '').matchAll(/(?:^|[;\s])(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
      out.push({ name: d[1] ?? '', value: (d[2] ?? '').trim(), block });
    }
  }
  return out;
}

const read = (/** @type {string} */ file) => readFileSync(join(ROOT, file), 'utf8');

/**
 * The corpus totals, with a listing for the failure message.
 *
 * @param {(source: string) => Hit[]} counter
 * @returns {{ count: number, listing: string }}
 */
function corpus(counter) {
  const lines = [];
  for (const file of appCssFiles()) {
    for (const h of counter(read(file))) lines.push(`  ${file}:${h.line} ${h.text}`);
  }
  return { count: lines.length, listing: lines.join('\n') };
}

// -------------------------------------------------------------------------------------------
// The corpus is real, and the counters bite
// -------------------------------------------------------------------------------------------

test('the Studio CSS corpus is present and non-trivial', () => {
  const files = appCssFiles();
  assert.ok(files.length >= 40, `the app CSS corpus is ${files.length} files; a green ratchet below would be an empty scan`);
  const total = corpus((s) => valuesOf(s, 'font-size').map(({ line, value }) => ({ line, text: value }))).count;
  assert.ok(total >= 400, `only ${total} font-size declarations were read out of app/src; the scanner is not reading the corpus`);
});

test('mechanism: literal sizes, case transforms and literal radii are caught; tokens and comments are not', () => {
  const bad =
    '.a { font-size: 13px; }\n.b { font-size: 0.875rem; line-height: 1.4; }\n.c { font-size: 1.1em }\n' +
    '.d { text-transform: uppercase; }\n.e { border-radius: 8px; }\n.f { border-top-left-radius: 999px; }';
  const sizes = literalFontSizes(bad);
  assert.deepEqual(sizes.px.map((h) => h.text), ['13px']);
  assert.deepEqual(sizes.relative.map((h) => h.text), ['0.875rem', '1.1em']);
  assert.deepEqual(caseTransforms(bad).map((h) => h.text), ['uppercase']);
  assert.deepEqual(literalRadii(bad).map((h) => h.text), ['8px', '999px']);

  const good =
    '/* font-size: 13px; text-transform: uppercase; border-radius: 8px */\n' +
    '.a { font-size: var(--t-font-md); line-height: var(--t-lh-md); }\n.b { font: inherit; }\n' +
    '.c { text-transform: none; }\n.d { border-radius: var(--t-radius-sm); }\n.btn--sm { height: 32px; }';
  assert.deepEqual(literalFontSizes(good), { px: [], relative: [] }, 'a token, a comment or a non-size length was counted as a literal size');
  assert.deepEqual(caseTransforms(good), [], 'a `text-transform: none` reset or a comment was counted as a case transform');
  assert.deepEqual(literalRadii(good), [], 'a radius token or a comment was counted as a literal radius');
});

// -------------------------------------------------------------------------------------------
// The scale itself
// -------------------------------------------------------------------------------------------

test('the seven size steps and their line heights exist once each, in the bare :root block, with the D137 values', () => {
  const decls = declarations(read(TOKENS_FILE));
  for (const [step, [size, lineHeight]] of Object.entries(SCALE)) {
    for (const [name, px] of [[`--t-font-${step}`, size], [`--t-lh-${step}`, lineHeight]]) {
      const found = decls.filter((d) => d.name === name);
      assert.equal(found.length, 1, `${name} must be declared exactly once in ${TOKENS_FILE} (found ${found.length})`);
      assert.equal(found[0]?.block, ':root', `${name} must live in the bare :root block: type is not themed`);
      assert.equal(found[0]?.value, `${px}px`, `${name} is "${found[0]?.value}"; the scale says ${px}px`);
    }
  }
});

test('DESIGN.md names every step of the scale', () => {
  const design = read(DESIGN_FILE);
  for (const step of Object.keys(SCALE)) {
    for (const name of [`--t-font-${step}`, `--t-lh-${step}`]) {
      assert.ok(design.includes(`\`${name}\``), `${DESIGN_FILE} must name ${name} in its Type section`);
    }
  }
});

// -------------------------------------------------------------------------------------------
// The core spells no size and no case of its own
// -------------------------------------------------------------------------------------------

test('the shared core (tokens.css, global.css, motion.css) carries no literal font size and no case transform', () => {
  const hits = [];
  for (const file of CORE_FILES) {
    const source = read(file);
    const sizes = literalFontSizes(source);
    for (const h of [...sizes.px, ...sizes.relative]) hits.push(`${file}:${h.line} font-size: ${h.text}`);
    for (const h of caseTransforms(source)) hits.push(`${file}:${h.line} text-transform: ${h.text}`);
  }
  assert.deepEqual(
    hits,
    [],
    'the shared core defines the type steps, so it reaches for them too: use `var(--t-font-*)` with its ' +
      `\`var(--t-lh-*)\`, and write the words in the case they are meant to be read in. Found:\n  ${hits.join('\n  ')}`,
  );
});

// -------------------------------------------------------------------------------------------
// The ratchets
// -------------------------------------------------------------------------------------------

test(`literal px font sizes in Studio CSS stay at or below the ratchet (${RAW_PX_FONT_SIZE_CEILING})`, () => {
  const { count, listing } = corpus((s) => literalFontSizes(s).px);
  assert.ok(
    count <= RAW_PX_FONT_SIZE_CEILING,
    `${count} literal px font sizes in Studio CSS, ceiling ${RAW_PX_FONT_SIZE_CEILING}. Use a --t-font-* step:\n${listing}`,
  );
});

test(`literal rem/em/% font sizes in Studio CSS stay at or below the ratchet (${RAW_RELATIVE_FONT_SIZE_CEILING})`, () => {
  const { count, listing } = corpus((s) => literalFontSizes(s).relative);
  assert.ok(
    count <= RAW_RELATIVE_FONT_SIZE_CEILING,
    `${count} literal relative font sizes in Studio CSS, ceiling ${RAW_RELATIVE_FONT_SIZE_CEILING}. A rem or em size ` +
      `resolves to fractional pixels (14.4, 13.6, 12.8); use a --t-font-* step:\n${listing}`,
  );
});

test(`case transforms in Studio CSS stay at or below the ratchet (${CASE_TRANSFORM_CEILING})`, () => {
  const { count, listing } = corpus(caseTransforms);
  assert.ok(
    count <= CASE_TRANSFORM_CEILING,
    `${count} case transforms in Studio CSS, ceiling ${CASE_TRANSFORM_CEILING}. Sentence case is written in the ` +
      `catalogue, never applied by CSS:\n${listing}`,
  );
});

test(`literal border radii in Studio CSS stay at or below the ratchet (${RAW_RADIUS_CEILING})`, () => {
  const { count, listing } = corpus(literalRadii);
  assert.ok(
    count <= RAW_RADIUS_CEILING,
    `${count} literal border radii in Studio CSS, ceiling ${RAW_RADIUS_CEILING}. The scale is --t-radius-sm/md/lg ` +
      `(6/10/14) plus --t-radius-full:\n${listing}`,
  );
});
