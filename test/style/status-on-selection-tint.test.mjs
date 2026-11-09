// @ts-check
/**
 * STATUS COLOURS STAY LEGIBLE ON THE SELECTION TINT (D137, the C1 money critic, finding F3).
 *
 * K-24 made a selected table row a pill: `--t-accent-soft` on every cell. A figure keeps its own
 * ink on that tint, and a loss is inked in `--t-danger` (Fx, the asset reports). The C1 critic
 * measured the dark danger at 4.02:1 on the tint over the page and 3.72:1 over a panel, under the
 * 4.5:1 AA text floor, so dark danger was lifted to #f88484.
 *
 * The rule this pins, in both themes, over the page ground and the panel ground:
 *   - `--t-danger` is used as FIGURE ink (a loss, a credit note's sign), so it must clear 4.5:1 on
 *     the tint (WCAG 1.4.3);
 *   - every status colour (`--t-success`, `--t-warn`, `--t-danger`) is at least GLYPH ink (the
 *     `Status` primitive colours only its glyph; the word stays in the text ink), so it must clear
 *     3:1 on the tint (WCAG 1.4.11).
 *
 * The tokens are read from `brand/tokens/tokens.css`, the tint is composited over each ground the
 * way the browser paints it, and the ratio is the WCAG relative-luminance ratio.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TOKENS = readFileSync(join(ROOT, 'brand/tokens/tokens.css'), 'utf8');

/**
 * The declarations of the first block whose selector contains `marker`.
 * @param {string} css
 * @param {string} marker
 * @returns {Map<string, string>}
 */
function block(css, marker) {
  const start = css.indexOf(marker);
  assert.ok(start !== -1, `tokens.css has no block for ${marker}`);
  const open = css.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = css.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Map();
  for (const m of body.matchAll(/(--t-[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1] ?? '', (m[2] ?? '').trim());
  return out;
}

/** @param {string} value @returns {{rgb: number[], a: number}} */
function parseColour(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex !== null) {
    const h = hex[1] ?? '';
    return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)), a: 1 };
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/i.exec(value);
  assert.ok(rgba !== null, `not a literal colour: ${value}`);
  return {
    rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])],
    a: rgba[4] === undefined ? 1 : Number(rgba[4]),
  };
}

/** @param {{rgb: number[], a: number}} top @param {number[]} under @returns {number[]} */
function over(top, under) {
  return top.rgb.map((c, i) => Math.round(c * top.a + (under[i] ?? 0) * (1 - top.a)));
}

/** @param {number[]} rgb */
function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** @param {number[]} a @param {number[]} b */
function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** @type {Array<[string, Map<string, string>]>} */
const THEMES = [
  ['light', block(TOKENS, "[data-theme='light']")],
  ['dark', block(TOKENS, "[data-theme='dark']")],
];
const DARK = block(TOKENS, "[data-theme='dark']");

/** @param {Map<string, string>} tokens @param {string} name */
function colour(tokens, name) {
  const value = tokens.get(name);
  assert.ok(value !== undefined, `${name} is not defined in this theme`);
  return parseColour(value);
}

test('danger, as figure ink, clears 4.5:1 on the selection tint over the page and the panel', () => {
  const misses = [];
  for (const [theme, tokens] of THEMES) {
    const tint = colour(tokens, '--t-accent-soft');
    const danger = colour(tokens, '--t-danger').rgb;
    for (const ground of ['--t-bg', '--t-bg-elev']) {
      const r = ratio(danger, over(tint, colour(tokens, ground).rgb));
      if (r < 4.5) misses.push(`${theme} on ${ground}: ${r.toFixed(2)}:1`);
    }
  }
  assert.deepEqual(misses, [], `--t-danger on the selection tint is under 4.5:1: ${misses.join('; ')}`);
});

test('every status colour, as glyph ink, clears 3:1 on the selection tint', () => {
  const misses = [];
  for (const [theme, tokens] of THEMES) {
    const tint = colour(tokens, '--t-accent-soft');
    for (const status of ['--t-success', '--t-warn', '--t-danger']) {
      const ink = colour(tokens, status).rgb;
      for (const ground of ['--t-bg', '--t-bg-elev']) {
        const r = ratio(ink, over(tint, colour(tokens, ground).rgb));
        if (r < 3) misses.push(`${theme} ${status} on ${ground}: ${r.toFixed(2)}:1`);
      }
    }
  }
  assert.deepEqual(misses, [], `a status glyph on the selection tint is under 3:1: ${misses.join('; ')}`);
});

test('the guard bites: the pre-C1 dark danger fails the figure rule', () => {
  const dark = new Map(DARK);
  dark.set('--t-danger', '#f26868');
  const tint = colour(dark, '--t-accent-soft');
  const r = ratio(colour(dark, '--t-danger').rgb, over(tint, colour(dark, '--t-bg-elev').rgb));
  assert.ok(r < 4.5, `expected the old dark danger to fail on the panel tint, got ${r.toFixed(2)}:1`);
});
