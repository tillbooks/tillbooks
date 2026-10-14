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
 *   - Every infinite animation runs on `--t-motion-loop` (D155), the one loop the vocabulary allows.
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
const MOTION_TS = 'app/src/lib/motion.ts';

/**
 * The vocabulary, in milliseconds, exactly as D122 D-I chose it, plus the hover beat UI polish
 * round 2 added (K-41, D137): 120 ms on background, ink and edge colour of the shared primitives,
 * plus the loading loop the owner added on 09.10.2026 (D155): 1400 ms, the single allowed exception
 * to the 120-200 ms budget, for a skeleton or a pending indicator only.
 */
const VOCABULARY_MS = {
  '--t-motion-nav-out': 80,
  '--t-motion-nav-in': 200,
  '--t-motion-pill': 120,
  '--t-motion-press': 80,
  '--t-motion-commit': 180,
  '--t-motion-tint': 720,
  '--t-motion-reveal': 200,
  '--t-motion-stagger': 30,
  '--t-motion-hover': 120,
  '--t-motion-loop': 1400,
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
  const files = execFileSync('git', ['ls-files', '-z', 'app/src'], { env: cleanGitEnv(), cwd: ROOT, maxBuffer: 1 << 28 })
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
 * THE RATCHET. The daily-path surfaces the D122 friction pass adopted carry none. The ceiling stood
 * at 11 (the skeleton pulse, DataTable's sort chevron, and eight surfaces the consistency sweep
 * retired), but the Studio motion pass (f136a45) had already retired all but the two loops, and on
 * 09.10.2026 the skeleton pulse and the bank band's breathing pip moved to `--t-motion-loop`
 * (D155). The Studio now spells none, so the ceiling is the count: zero. This number may only go
 * down, and it cannot: never raise it.
 */
const RAW_DURATION_LITERAL_CEILING = 0;

test(`raw duration literals in Studio CSS stay at or below the ratchet (${RAW_DURATION_LITERAL_CEILING})`, () => {
  const hits = rawDurationLiterals();
  const listing = hits.map((h) => `  ${h.file}:${h.line} ${h.literal}`).join('\n');
  assert.ok(
    hits.length <= RAW_DURATION_LITERAL_CEILING,
    `${hits.length} raw duration literals in Studio CSS, ceiling ${RAW_DURATION_LITERAL_CEILING}. Use the --t-motion-* tokens:\n${listing}`,
  );
});

/**
 * THE LOOP IS THE ONLY LOOP (D155). An animation that repeats forever runs on `--t-motion-loop`, the
 * one cycle the vocabulary allows, and only a skeleton or a pending indicator may use it. A loop
 * spelled with its own duration is a rhythm outside the vocabulary; a loop on another token is a
 * courtesy beat repeated until it becomes decoration.
 *
 * @param {string} text CSS with comments blanked
 * @returns {string[]} the offending `animation` declarations
 */
function loopsOffToken(text) {
  return [...text.matchAll(/(?<![\w-])animation(?:-iteration-count)?\s*:\s*([^;{}]*)/g)]
    .filter((m) => /\binfinite\b/.test(m[1] ?? '') && !/var\(--t-motion-loop\)/.test(m[1] ?? ''))
    .map((m) => m[0].replace(/\s+/g, ' ').trim());
}

test('every infinite animation in the Studio and the website runs on --t-motion-loop', () => {
  const tracked = (/** @type {string} */ dir) =>
    execFileSync('git', ['ls-files', '-z', dir], { env: cleanGitEnv(), cwd: ROOT, maxBuffer: 1 << 28 })
      .toString('utf8')
      .split('\0');
  /** @type {string[]} */
  const hits = [];
  for (const f of tracked('app/src').filter((x) => x.endsWith('.css'))) {
    for (const d of loopsOffToken(withoutComments(readFileSync(join(ROOT, f), 'utf8')))) hits.push(`${f}: ${d}`);
  }
  for (const f of tracked('web/src').filter((x) => /\.(astro|css)$/.test(x))) {
    for (const chunk of webStyleChunks(f, readFileSync(join(ROOT, f), 'utf8')).css) {
      for (const d of loopsOffToken(chunk.text)) hits.push(`${f}: ${d}`);
    }
  }
  assert.deepEqual(hits, [], 'a loop runs on var(--t-motion-loop), and only for a skeleton or a pending indicator');
  // The guard bites: a loop on its own rhythm, or on a courtesy token, is caught; the loop token is not.
  assert.deepEqual(loopsOffToken('.a { animation: pulse 1.4s ease-in-out infinite; }'), ['animation: pulse 1.4s ease-in-out infinite']);
  assert.deepEqual(loopsOffToken('.a { animation: pulse var(--t-motion-reveal) infinite; }').length, 1);
  assert.deepEqual(loopsOffToken('.a { animation: pulse var(--t-motion-loop) ease-in-out infinite; }'), []);
});

test('no daily-path surface stylesheet spells a raw duration literal', () => {
  const hits = rawDurationLiterals().filter((h) =>
    /^app\/src\/surfaces\/(Journal|Payments|Documents|Bills|Reconciliation|Periods)\//.test(h.file),
  );
  assert.deepEqual(hits, [], 'the daily-path surfaces inherit the vocabulary; a literal there is a regression');
});

/*
 * ─── The website (web/src) speaks the same vocabulary ───────────────────────────────────────────
 *
 * The Astro site imports brand/tokens/tokens.css directly (web/src/styles/global.css), so it has the
 * very same `--t-motion-*` tokens and the same reduced-motion kill switch. Until the motion pass of
 * 09.10.2026 nothing held it to them: the hero rose over 550 ms on a curve of its own, the lane
 * comparison ran a ladder of CSS delays to 3.3 s, and the file flow looped every 1.3 s forever. The
 * Studio's ratchet above scans app/src only (another surface, another owner), so the site carries its
 * own guard, and it is not a ratchet: the site is at ZERO and stays there.
 *
 * WHAT IT SCANS. Every tracked web/src file a style can live in:
 *   - `.css`: the whole file.
 *   - `.astro`: every `<style>` block and every inline `style="..."` attribute (CSS), plus every
 *     `<script>` block (JS that sets a style).
 *   - `.ts`: the whole file, as both CSS-in-a-string and JS.
 * Comments are blanked first, so a duration named in prose (`the old 0.9 s blink`) is never a hit.
 *
 * THE RULES.
 *   1. No raw duration literal in a `transition`, `transition-duration`, `transition-delay`,
 *      `animation`, `animation-duration` or `animation-delay` declaration, nor in a JS style write
 *      (`el.style.transition = '...'`, `{ animationDuration: '...' }`). A surface says
 *      `var(--t-motion-reveal)`, never `200ms`. Zero (`0s`, `0ms`) is not a duration and is allowed.
 *   2. No `transition: all`, spelled or implied: a transition item that opens with its duration
 *      (`transition: var(--t-motion-hover)`) names no property, which is `all` by another name. The
 *      only properties that move are `transform`, `opacity` and colours (brand/DESIGN.md, Motion).
 *
 * ALLOWLIST. Empty, on purpose. A genuine exception is added below as `'<file>': ['<literal>']` with a
 * one-line reason, and the reason has to survive review.
 */

/** @type {Record<string, string[]>} file -> literals it may spell, each with a reason in a comment. */
const WEB_LITERAL_ALLOWLIST = {};

/**
 * `source` with `//` line comments blanked (only where `//` opens the comment, so a URL's `://`
 * survives), newlines kept.
 *
 * @param {string} source
 * @returns {string}
 */
function withoutLineComments(source) {
  return source.replace(/(^|[\s;{}()])\/\/[^\n]*/g, (m, lead) => lead + m.slice(lead.length).replace(/[^\n]/g, ' '));
}

/**
 * The style-bearing text of one web/src file, split into the CSS to read as declarations and the
 * JS to read as style writes. Every chunk keeps its offset so a hit reports its real line.
 *
 * @param {string} file
 * @param {string} raw
 * @returns {{ css: { text: string, at: number }[], js: { text: string, at: number }[] }}
 */
function webStyleChunks(file, raw) {
  const blank = withoutComments(raw.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' ')));
  if (file.endsWith('.css')) return { css: [{ text: blank, at: 0 }], js: [] };
  if (file.endsWith('.ts')) {
    const js = withoutLineComments(blank);
    return { css: [{ text: js, at: 0 }], js: [{ text: js, at: 0 }] };
  }
  /** @type {{ text: string, at: number }[]} */
  const css = [];
  /** @type {{ text: string, at: number }[]} */
  const js = [];
  for (const m of blank.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) {
    css.push({ text: m[1] ?? '', at: (m.index ?? 0) + m[0].indexOf('>') + 1 });
  }
  for (const m of blank.matchAll(/\sstyle\s*=\s*"([^"]*)"/g)) {
    css.push({ text: `${m[1] ?? ''};`, at: (m.index ?? 0) + m[0].indexOf('"') + 1 });
  }
  for (const m of blank.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    js.push({ text: withoutLineComments(m[1] ?? ''), at: (m.index ?? 0) + m[0].indexOf('>') + 1 });
  }
  return { css, js };
}

/** A time literal that is not zero: `0.35s`, `200ms`, `.5s`. Zero is a kill, not a duration. */
const TIME_LITERAL = /(?<![\w.#-])(\d*\.?\d+)(ms|s)\b/g;

/**
 * `value` split at its top-level commas (a comma inside `cubic-bezier(...)` or `calc(...)` stays).
 *
 * @param {string} value
 * @returns {string[]}
 */
function topLevelItems(value) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Every motion-vocabulary violation in one web/src file's source.
 *
 * @param {string} f the repo-relative path (decides how the source is read)
 * @param {string} raw the file's source
 * @returns {{ file: string, line: number, rule: string, text: string }[]}
 */
function scanWebSource(f, raw) {
  /** @type {{ file: string, line: number, rule: string, text: string }[]} */
  const out = [];
  const lineAt = (/** @type {number} */ i) => raw.slice(0, i).split('\n').length;
  const allowed = WEB_LITERAL_ALLOWLIST[f] ?? [];
  const { css, js } = webStyleChunks(f, raw);
  for (const chunk of css) {
    for (const d of chunk.text.matchAll(/(?<![\w-])(transition|animation)(-duration|-delay|-property)?\s*:\s*([^;{}]*)/g)) {
      const [whole, prop, suffix = '', value = ''] = d;
      const line = lineAt(chunk.at + (d.index ?? 0));
      const text = whole.replace(/\s+/g, ' ').trim();
      if (suffix !== '-property') {
        for (const t of value.matchAll(TIME_LITERAL)) {
          if (Number(t[1]) === 0 || allowed.includes(t[0])) continue;
          out.push({ file: f, line, rule: `raw duration literal ${t[0]}`, text });
        }
      }
      if (prop === 'transition' && (suffix === '' || suffix === '-property')) {
        for (const item of topLevelItems(value)) {
          if (/^all\b/.test(item)) out.push({ file: f, line, rule: 'transition: all', text });
          else if (suffix === '' && /^(?:\d|\.\d|var\(--t-motion-|calc\()/.test(item)) {
            out.push({ file: f, line, rule: 'a transition item with no property (an implied `all`)', text });
          }
        }
      }
    }
  }
  for (const chunk of js) {
    const re = /\b(?:transition|animation)(?:Duration|Delay)?\s*[:=]\s*(['"`])([^'"`]*)\1/g;
    for (const w of chunk.text.matchAll(re)) {
      const value = w[2] ?? '';
      for (const t of value.matchAll(TIME_LITERAL)) {
        if (Number(t[1]) === 0 || allowed.includes(t[0])) continue;
        out.push({ file: f, line: lineAt(chunk.at + (w.index ?? 0)), rule: `raw duration literal ${t[0]} in a JS style write`, text: w[0] });
      }
      if (/^\s*all\b/.test(value)) {
        out.push({ file: f, line: lineAt(chunk.at + (w.index ?? 0)), rule: 'transition: all in a JS style write', text: w[0] });
      }
    }
  }
  return out;
}

/**
 * Every motion-vocabulary violation across the tracked web/src files.
 *
 * @returns {{ file: string, line: number, rule: string, text: string }[]}
 */
function webMotionViolations() {
  return execFileSync('git', ['ls-files', '-z', 'web/src'], { env: cleanGitEnv(), cwd: ROOT, maxBuffer: 1 << 28 })
    .toString('utf8')
    .split('\0')
    .filter((f) => /\.(astro|css|ts)$/.test(f))
    .flatMap((f) => scanWebSource(f, readFileSync(join(ROOT, f), 'utf8')));
}

test('the website spells no raw motion duration and no transition: all (web/src, held at zero)', () => {
  const hits = webMotionViolations();
  const listing = hits.map((h) => `  ${h.file}:${h.line} ${h.rule}: ${h.text}`).join('\n');
  assert.deepEqual(
    hits.map((h) => `${h.file}:${h.line} ${h.rule}`),
    [],
    `web/src must say var(--t-motion-*), never a literal, and must name what it transitions:\n${listing}`,
  );
});

test('the website guard actually bites: every seeded shape is caught, and the vocabulary is not', () => {
  const rules = (/** @type {string} */ f, /** @type {string} */ src) => scanWebSource(f, src).map((h) => h.rule);
  // Each shape the guard exists for, in each place a style can live.
  assert.deepEqual(rules('x.astro', '<style>\n.a { transition: opacity 0.35s ease; }\n</style>'), ['raw duration literal 0.35s']);
  assert.deepEqual(rules('x.astro', '<style>\n.a { animation: spin 1.3s linear infinite; }\n</style>'), ['raw duration literal 1.3s']);
  assert.deepEqual(rules('x.astro', '<style>\n.a { animation-delay: 300ms; }\n</style>'), ['raw duration literal 300ms']);
  assert.deepEqual(rules('x.astro', '<style>\n.a { transition: all var(--t-motion-hover) var(--t-ease-out); }\n</style>'), ['transition: all']);
  assert.deepEqual(rules('x.css', '.a { transition-property: all; }'), ['transition: all']);
  assert.deepEqual(rules('x.css', '.a { transition: var(--t-motion-hover) var(--t-ease-out); }'), [
    'a transition item with no property (an implied `all`)',
  ]);
  assert.deepEqual(rules('x.astro', '<div style="transition: opacity .2s"></div>'), ['raw duration literal .2s']);
  assert.deepEqual(rules('x.astro', "<script>\nel.style.transition = 'transform 200ms';\n</script>"), [
    'raw duration literal 200ms in a JS style write',
  ]);
  assert.deepEqual(rules('x.ts', "export const s = { animationDuration: '0.5s' };"), ['raw duration literal 0.5s in a JS style write']);
  // And what is NOT a violation: the tokens, zero, comments, and a bare time outside a motion declaration.
  assert.deepEqual(
    rules(
      'x.astro',
      [
        '<style>',
        '  /* the old transition: opacity 0.35s ease, retired */',
        '  .a { transition: opacity var(--t-motion-reveal) var(--t-ease-out), transform var(--t-motion-reveal) var(--t-ease-out); }',
        '  .b { animation: rise var(--t-motion-reveal) var(--t-ease-out) calc(2 * var(--t-motion-stagger)) forwards; }',
        '  .c { transition-delay: 0s; animation-duration: 0ms; }',
        '</style>',
        '<script>',
        '  // el.style.transition = "opacity 1s" in a comment is prose',
        '  setTimeout(tick, 300);',
        '</script>',
      ].join('\n'),
    ),
    [],
  );
});
