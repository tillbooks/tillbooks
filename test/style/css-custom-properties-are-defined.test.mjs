// @ts-check
/**
 * EVERY `var(--x)` IN THE STUDIO REFERS TO A CUSTOM PROPERTY THAT IS ACTUALLY DEFINED.
 *
 * THE DEFECT THIS EXISTS FOR. Fifty-one Studio CSS files referenced a whole family of custom
 * properties that are defined NOWHERE the app loads: `--line`, `--bg`, `--bg-elev`, `--text`,
 * `--surface`, `--muted`, `--panel`, `--space-3`, `--color-text-muted`, `--t-radius`, `--t-surface-2`
 * and around fifty more. They were an alias vocabulary that shadowed the canonical Brass tokens in
 * `brand/tokens/tokens.css` (`--t-border`, `--t-bg-elev`, `--t-text-dim`, `--t-radius-md`, ...), and
 * nothing was defining them.
 *
 * WHY THAT IS NOT A COSMETIC BUG. An undefined custom property with no fallback computes to the
 * property's `initial` value, not to nothing sensible: `background: var(--bg-elev)` becomes
 * `background: initial` (transparent), `border: 1px solid var(--line)` loses its colour, and a whole
 * panel renders as an invisible box with no ground and no edge. The ones that carried a hardcoded
 * fallback (`var(--bg-elev, #f5f5f5)`) were worse in the theme nobody was looking at: the fallback is
 * theme-blind, so a near-white panel painted onto the dark ground. Either way the operator saw a
 * broken surface, and no test saw anything, because a `var()` of a name that does not exist is valid
 * CSS.
 *
 * WHY A SOURCE SCAN AND NOT A RENDER CHECK. Whether a token resolves is a property of the stylesheet,
 * true in every rendered state of every surface at once. A per-surface visual audit only covers the
 * screens and the themes somebody remembered to open, and "somebody remembered" is not a mechanism.
 * This file is the mechanism: it reads the source, so a surface nobody opened in a test is still
 * judged, and a new one is covered the moment it is committed.
 *
 * THE RULE, denylist-free. The check is not a list of forbidden names (which would go green the first
 * time someone invents a fifty-first alias). It is: the set of custom properties USED must be a subset
 * of the set DEFINED. `used - defined` must be empty. A new phantom alias fails the moment it is
 * referenced, whatever it is called, because it is by definition not in the defined set.
 *
 * WHAT COUNTS AS DEFINED. Every `--x:` declaration across the token file and the app's own CSS. That
 * is `brand/tokens/tokens.css` (the sole definer of the `--t-*` system, imported by `global.css`),
 * `global.css` itself (which adds the semantic button aliases `--accent`, `--danger`, `--ghost`,
 * `--primary`, `--secondary`), and any surface that legitimately declares a local property and uses
 * it. The union is taken on purpose: a surface that defines `--foo` and uses `var(--foo)` is correct,
 * and this guard must not punish it.
 *
 * WHAT COUNTS AS USED. Every `var(--x)` in the app's CSS AND in its TSX/TS (inline `style` objects
 * reference tokens too, e.g. `style={{ gap: 'var(--t-space-1)' }}`, and an undefined token there is
 * the same bug). Dynamic `var(${expr})` is not a static name and is skipped by the regex, which only
 * matches a literal `--name`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { cleanGitEnv } from '../lib/git-env.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The token file the whole system is defined in. Imported by `app/src/styles/global.css`. */
const TOKENS_FILE = 'brand/tokens/tokens.css';

/**
 * The lowercased extension of a path, or `''` when it has none.
 *
 * @param {string} path repo-relative
 * @returns {string}
 */
function extensionOf(path) {
  const last = path.slice(path.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  return dot <= 0 ? '' : last.slice(dot).toLowerCase();
}

/**
 * `source` with every block comment blanked to spaces, newlines kept.
 *
 * Offsets and line numbers are preserved (each blanked char is a space, each newline survives), so a
 * match index still points at the right line. This exists so a `#0f766e` written inside a `/* ... *\/`
 * note, or a `var(--x)` mentioned in a comment, is not mistaken for a real declaration, reference, or
 * hardcoded colour. It handles the CSS/JS block comment; a JS `//` line comment is left alone, which is
 * immaterial for the CSS this guard is about.
 *
 * @param {string} source
 * @returns {string}
 */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Tracked files under `app/src` with one of the given extensions, repo-relative.
 *
 * `-z` because a path may legally contain a newline, which git quotes in the default output and a
 * split on `\n` would turn into two paths that do not exist.
 *
 * @param {Set<string>} extensions lowercased, with the dot
 * @returns {string[]}
 */
function appFiles(extensions) {
  return execFileSync('git', ['ls-files', '-z', 'app/src'], { env: cleanGitEnv(), cwd: ROOT, maxBuffer: 1 << 28 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((f) => extensions.has(extensionOf(f)));
}

/**
 * Every custom property DECLARED in `source`, i.e. the left-hand side of a `--x: value;` declaration.
 *
 * A DECLARATION begins where a declaration can begin: at the start of the source, or right after a
 * `{`, a `;`, a `}`, or whitespace. That boundary is the whole point of this guard's second life:
 * without it the old regex `(--x)\s*:` read the selector text `.btn--accent:hover` as a declaration of
 * `--accent`, because a `--name` glued to a `:pseudo` looks exactly like `--name:`. In a selector the
 * name is preceded by an identifier character (`.btn--accent` has an `n` before `--accent`), so the
 * boundary excludes it; in a real declaration the name is preceded by a rule-body delimiter. A
 * `var(--name)` reference is preceded by `(` and has no trailing colon, so it is excluded twice over.
 *
 * @param {string} source
 * @returns {string[]}
 */
function declaredIn(source) {
  return [...withoutComments(source).matchAll(/(?:^|[{};\s])(--[a-zA-Z0-9-]+)\s*:/g)].map(
    (m) => m[1] ?? '',
  );
}

/**
 * Every custom property REFERENCED in `source` through `var(--name ...)`.
 *
 * Only a literal name is captured; a dynamic `var(${expr})` in TSX has no static name and is skipped.
 *
 * @param {string} source
 * @returns {string[]}
 */
function referencedIn(source) {
  return [...withoutComments(source).matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)].map((m) => m[1] ?? '');
}

/** The set of custom properties the app defines: the token file plus every app CSS declaration. */
function definedProperties() {
  const defined = new Set();
  for (const p of declaredIn(readFileSync(join(ROOT, TOKENS_FILE), 'utf8'))) defined.add(p);
  for (const f of appFiles(new Set(['.css']))) {
    for (const p of declaredIn(readFileSync(join(ROOT, f), 'utf8'))) defined.add(p);
  }
  return defined;
}

/**
 * Every `var(--x)` reference in the app, with its file and line, whose name is not in `defined`.
 *
 * @param {Set<string>} defined
 * @returns {{ file: string, line: number, name: string }[]}
 */
function undefinedReferences(defined) {
  /** @type {{ file: string, line: number, name: string }[]} */
  const out = [];
  for (const f of appFiles(new Set(['.css', '.tsx', '.ts', '.jsx', '.js']))) {
    const source = withoutComments(readFileSync(join(ROOT, f), 'utf8'));
    for (const m of source.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
      const name = m[1] ?? '';
      if (defined.has(name)) continue;
      out.push({ file: f, line: source.slice(0, m.index ?? 0).split('\n').length, name });
    }
  }
  return out;
}

/**
 * Every hardcoded hex colour literal (`#rgb`, `#rrggbb`, `#rrggbbaa`) in the app's own CSS, with file
 * and line.
 *
 * WHY THIS IS HERE. DESIGN.md is explicit: "Never hardcode a hex in a component." A literal like
 * `#fff` is theme-blind (it stays white on the dark ground where the token would have flipped) and it
 * sidesteps the Pine palette entirely. The phantom-token fallbacks this whole file was rebuilt for
 * (`var(--accent, #0f766e)`) were hex literals wearing a `var()` coat; a bare `color: #fff` is the
 * same defect with the coat off, and nothing caught it.
 *
 * WHAT IS NOT A HEX. `rgb()` / `rgba()` are not matched: the only ones in the corpus are the black
 * modal scrims and drop shadows (`rgba(0, 0, 0, 0.4)`), which are a translucency the token system does
 * not model and DESIGN.md tolerates. The token file itself (`brand/tokens/tokens.css`) is out of scope
 * by construction, because it is the one place hex is DEFINED rather than hardcoded: `appFiles` only
 * walks `app/src`.
 *
 * @returns {{ file: string, line: number, hex: string }[]}
 */
function hardcodedHexColours() {
  /** @type {{ file: string, line: number, hex: string }[]} */
  const out = [];
  for (const f of appFiles(new Set(['.css']))) {
    const source = withoutComments(readFileSync(join(ROOT, f), 'utf8'));
    for (const m of source.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      out.push({ file: f, line: source.slice(0, m.index ?? 0).split('\n').length, hex: m[0] });
    }
  }
  return out;
}

/**
 * Every retired left/right accent bar in the app's own CSS: a `border-<side>` (shorthand or
 * `-color` longhand, physical or logical) whose value paints with the accent token.
 *
 * WHY THIS IS HERE. DESIGN.md bans "the accent bar or rail on the side of a card or nav item" by name,
 * and "the left accent bar is retired; do not bring it back." The Purchasing scorecard had one
 * (`border-left: 3px solid var(--accent, ...)`), which was doubly wrong: it was the retired rail AND it
 * spent the accent on a status meaning the accent must never carry. A plain `border-left: 1px solid
 * var(--t-border)` is a table rule or a layout divider, not a rail, so only the ACCENT-painted side
 * borders are caught here.
 *
 * @returns {{ file: string, line: number, text: string }[]}
 */
function accentSideBars() {
  /** @type {{ file: string, line: number, text: string }[]} */
  const out = [];
  const re = /border-(?:left|right|inline-start|inline-end)(?:-color)?\s*:[^;{}]*var\(\s*--t-accent/gi;
  for (const f of appFiles(new Set(['.css']))) {
    const source = withoutComments(readFileSync(join(ROOT, f), 'utf8'));
    for (const m of source.matchAll(re)) {
      out.push({ file: f, line: source.slice(0, m.index ?? 0).split('\n').length, text: m[0] });
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// The corpus is real
// -------------------------------------------------------------------------------------------

test('the token file and the app CSS corpus are both present and non-empty', () => {
  // A guard whose globs quietly resolve to nothing passes forever.
  const cssFiles = appFiles(new Set(['.css']));
  assert.ok(
    cssFiles.length >= 40,
    `the app CSS corpus is ${cssFiles.length} files, far below this repo's Studio surface count. ` +
      '`git ls-files app/src` returned little or nothing, so a green verdict below would mean the ' +
      'scan found no phantom tokens because it read no files.',
  );
  const defined = definedProperties();
  for (const canonical of ['--t-bg', '--t-bg-elev', '--t-border', '--t-text-dim', '--t-radius-md']) {
    assert.ok(
      defined.has(canonical),
      `${canonical} is not in the defined set, but it is a canonical Brass token declared in ` +
        `${TOKENS_FILE}. The declaration scanner is not reading the token file, so every reference ` +
        'to a real token would be reported as undefined.',
    );
  }
  // `--accent`, `--danger`, `--ghost`, `--primary`, `--secondary` are NOT in the defined set: they
  // are class NAMES (`.btn--accent`), never custom-property declarations. The old extractor read the
  // selector `.btn--accent:hover` as declaring `--accent`, which is exactly the false-green hole that
  // let `var(--accent, #0f766e)` pass. If any of them reappears as "defined", the extractor has
  // regressed to counting selector text as a declaration.
  for (const phantom of ['--accent', '--danger', '--ghost', '--primary', '--secondary']) {
    assert.ok(
      !defined.has(phantom),
      `${phantom} is in the defined set, but no stylesheet declares it as a custom property (it exists ` +
        `only as the class name .btn${phantom}). The extractor is reading selector text as a ` +
        'declaration again, which is the false-green defect this guard was rebuilt to close.',
    );
  }
});

// -------------------------------------------------------------------------------------------
// The mechanism reddens, and does not cry wolf
// -------------------------------------------------------------------------------------------

test('mechanism: the exact phantom tokens this guard was built for are caught', () => {
  // The historical defect, reproduced on a synthetic stylesheet: none of these names is defined, so
  // all four must be reported. `--ink-muted`, `--line` and `--bg-elev` are the ones named in the
  // brief; `--t-radius` is the 251-usage alias that made this systemic rather than a typo.
  const defined = definedProperties();
  const synthetic =
    '.card{background:var(--bg-elev);border:1px solid var(--line);color:var(--ink-muted);' +
    'border-radius:var(--t-radius)}';
  const caught = referencedIn(synthetic).filter((n) => !defined.has(n)).sort();
  assert.deepEqual(
    caught,
    ['--bg-elev', '--ink-muted', '--line', '--t-radius'],
    'this guard does not flag the phantom tokens it was written for, so it would have passed over ' +
      'the transparent-panel bug it exists to catch.',
  );
});

test('mechanism: real tokens and locally-defined ones are NOT reported', () => {
  // The negative half. Without it, "nothing found" is indistinguishable from "nothing looked".
  const defined = definedProperties();
  const clean =
    ':root{--foo:8px}.card{background:var(--t-bg-elev);border-color:var(--t-border);' +
    'color:var(--t-accent);gap:var(--foo)}';
  const localDefined = new Set([...defined, ...declaredIn(clean)]);
  const flagged = referencedIn(clean).filter((n) => !localDefined.has(n));
  assert.deepEqual(
    flagged,
    [],
    'a canonical token, a semantic alias, or a property defined in the same stylesheet was reported ' +
      'as undefined. A guard that fails correct CSS gets deleted for crying wolf.',
  );
});

test('declaredIn does not mistake a var() reference for a declaration', () => {
  // `var(--x, red)` must not register `--x` as DEFINED, or a file could define its own phantoms into
  // existence just by referencing them with a fallback.
  assert.deepEqual(declaredIn('color: var(--x, red); background: var(--y)'), []);
  assert.deepEqual(declaredIn('--x: 1px; --y-z:0'), ['--x', '--y-z']);
});

test('declaredIn does not mistake selector text for a declaration (the false-green hole)', () => {
  // THE regression this guard's rebuild exists to prevent. A `--name` glued to a `:pseudo` in a
  // selector looks like `--name:`; the old extractor counted it, so every phantom `--accent`/`--danger`
  // fallback passed. A declaration is preceded by a rule-body delimiter; selector text never is.
  assert.deepEqual(declaredIn('.btn--accent:hover { color: red }'), []);
  assert.deepEqual(declaredIn('.btn--danger:hover:not(:disabled) { background: red }'), []);
  assert.deepEqual(declaredIn('.a--primary:focus, .b--secondary:active { }'), []);
  // But a real declaration inside the very same rule body is still seen.
  assert.deepEqual(declaredIn('.btn--accent:hover { --local: 4px; color: var(--local) }'), ['--local']);
});

// -------------------------------------------------------------------------------------------
// No hardcoded hex, no retired accent bar
// -------------------------------------------------------------------------------------------

test('the hex scanner catches a hardcoded literal and skips rgba scrims and comments', () => {
  // Mechanism check on synthetic input, so a green corpus below is a fact and not an empty scan.
  const withHex = withoutComments('.x{color:#fff}.y{border:1px solid #0f766e}');
  assert.deepEqual([...withHex.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]), ['#fff', '#0f766e']);
  const scrim = withoutComments('.o{background:rgba(0, 0, 0, 0.4)}.s{box-shadow:0 8px 32px rgb(0 0 0 / 0.24)}');
  assert.deepEqual([...scrim.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]), []);
  const commented = withoutComments('/* fell through to #0000EE historically */ .x{color:var(--t-text)}');
  assert.deepEqual([...commented.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]), []);
});

test('no Studio stylesheet hardcodes a hex colour', () => {
  const hits = hardcodedHexColours().map((h) => `${h.file}:${h.line} ${h.hex}`);
  assert.deepEqual(
    hits,
    [],
    'a surface CSS file hardcodes a hex colour instead of a Pine token. A literal like `#fff` is ' +
      'theme-blind (it stays white on the dark ground where `var(--t-on-accent)` would flip to dark) ' +
      'and sidesteps the palette. Use the token whose role matches; define new colours in ' +
      `${TOKENS_FILE}, never in a component. Translucent black scrims (\`rgba(0,0,0,...)\`) are ` +
      `allowed and are not hex. Found:\n  ${hits.join('\n  ')}`,
  );
});

test('no Studio stylesheet brings back the retired left accent bar', () => {
  const hits = accentSideBars().map((b) => `${b.file}:${b.line} ${b.text.replace(/\s+/g, ' ')}`);
  assert.deepEqual(
    hits,
    [],
    'a surface paints a side border with the accent token, which is the retired accent bar/rail that ' +
      'DESIGN.md bans by name ("the left accent bar is retired; do not bring it back"). Active nav is ' +
      'a tinted pill (`--t-accent-soft`), and status is a glyph plus a status token, never an accent ' +
      `rail. A plain \`border-left: 1px solid var(--t-border)\` divider is fine. Found:\n  ${hits.join('\n  ')}`,
  );
});

// -------------------------------------------------------------------------------------------
// The guard proper
// -------------------------------------------------------------------------------------------

test('every var(--x) in the Studio refers to a defined custom property', () => {
  const defined = definedProperties();
  const violations = undefinedReferences(defined).map((v) => `${v.file}:${v.line} var(${v.name})`);
  assert.deepEqual(
    violations,
    [],
    'a `var(--x)` refers to a custom property that no stylesheet defines, so it computes to ' +
      '`initial` (a transparent panel, an uncoloured border) or, if it carries a fallback, a ' +
      'theme-blind literal that is wrong in dark. Use the canonical token from ' +
      `${TOKENS_FILE} (\`--t-border\`, \`--t-bg-elev\`, \`--t-text-dim\`, \`--t-radius-md\`, ...) ` +
      `instead of an alias that shadows it. Found:\n  ${violations.join('\n  ')}`,
  );
});
