// @ts-check
/**
 * THE GLOBAL ANCHOR RULES CARRY ZERO SPECIFICITY, AND CHROME NEVER UNDERLINES.
 *
 * THE DEFECT THIS EXISTS FOR (UI polish round 2, A1/A2). `global.css` used to declare
 * `a { color: var(--t-accent) }` (0,0,1) and `a:hover { color: var(--t-accent-dim);
 * text-decoration: underline }` (0,1,1). Every `.btn` variant rendered as a router `<Link>` or an
 * `<a>` lost its label on hover: `a:hover` (0,1,1) outranked `.btn--primary { color: var(--t-on-accent) }`
 * (0,1,0), and `.btn--primary:hover` set only the background, so "Buchen" became brass text on a
 * brass fill (measured 1.00:1 in the browser). The same `a:hover` underline leaked onto the rail rows
 * (`.rail-link` base `text-decoration: none` is (0,1,0) and loses to (0,1,1)), onto the checklist card
 * rows and onto several surface link classes. Every one of those was a specificity accident, not a
 * design, and nothing in the test suite could see it because a rule that loses the cascade is valid CSS.
 *
 * THE RULES, stated as source properties so a surface nobody opened in a test is still judged:
 *   (a) In `app/src/styles/global.css`, a rule whose SUBJECT is a bare `a` (any state, any prose
 *       scope) is written ENTIRELY inside `:where()`, so it carries specificity 0 and every component
 *       class wins by construction. `:where(a) {...}`, `:where(a:hover) {...}` and
 *       `:where(.help-body a:hover) {...}` pass; `a:hover {...}` and `.help-body a:hover {...}` fail.
 *   (b) Anywhere in the Studio CSS, `text-decoration: underline` on an `a` ELEMENT selector (a bare
 *       `a` subject, not a class) is written entirely inside `:where()`. Underline on hover is an
 *       explicit opt-in for text links (`.link-inline`, a class), never a rule an element inherits.
 *   (c) The base `.btn` rule and the base `.rail-link` rule each state `text-decoration: none`
 *       themselves, so a button-shaped anchor and a rail row never depend on a global reset.
 *   (d) Any `.btn--<variant>:hover` rule that sets a background also sets `color`, because a hover
 *       fill that changes under an inherited text colour is exactly how the label vanished.
 *
 * The scanner is a small brace walker over comment-blanked source (offsets preserved, so a line
 * number still points at the rule). It descends into `@media` blocks and reads each style rule's
 * selector list and declarations. It is deliberately not a CSS parser: the corpus is hand-written
 * and the four properties above are about selector shape and declaration names, which a walker
 * reads exactly. Synthetic must-catch AND must-pass fixtures below prove the mechanism bites before
 * the corpus is judged, so a green verdict is a fact and not an empty scan.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { cleanGitEnv } from '../lib/git-env.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const GLOBAL_CSS = 'app/src/styles/global.css';

/**
 * `source` with every block comment blanked to spaces, newlines kept, so a selector or a declaration
 * mentioned in a comment is never read as a rule. Offsets are preserved.
 *
 * @param {string} source
 * @returns {string}
 */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Tracked CSS files under `app/src`, repo-relative. `-z` because a path may legally contain a newline.
 *
 * @returns {string[]}
 */
function appCssFiles() {
  return execFileSync('git', ['ls-files', '-z', 'app/src'], { env: cleanGitEnv(), cwd: ROOT, maxBuffer: 1 << 28 })
    .toString('utf8')
    .split('\0')
    .filter((f) => f.endsWith('.css'));
}

/**
 * @typedef {{ selector: string, body: string, line: number }} StyleRule
 */

/**
 * Every style rule in `source` (selector, declaration body, 1-based line of the opening brace),
 * including rules nested inside `@media` / `@supports` blocks. At-rule preludes themselves are not
 * returned. Keyframe steps (`from`, `50%`) come back as rules too; no check below matches them.
 *
 * @param {string} source
 * @returns {StyleRule[]}
 */
function rulesOf(source) {
  const text = withoutComments(source);
  /** @type {StyleRule[]} */
  const out = [];
  /** @type {{ prelude: string, bodyStart: number, isAt: boolean, line: number }[]} */
  const stack = [];
  let preludeStart = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      const prelude = text.slice(preludeStart, i).trim();
      stack.push({ prelude, bodyStart: i + 1, isAt: prelude.startsWith('@'), line: text.slice(0, i).split('\n').length });
      preludeStart = i + 1;
    } else if (ch === '}') {
      const top = stack.pop();
      if (top !== undefined && !top.isAt) {
        out.push({ selector: top.prelude, body: text.slice(top.bodyStart, i), line: top.line });
      }
      preludeStart = i + 1;
    } else if (ch === ';') {
      preludeStart = i + 1;
    }
  }
  return out;
}

/**
 * Split `text` on `separator` at parenthesis depth 0 only, so a `:where(a, b)` list stays whole.
 *
 * @param {string} text
 * @param {string} separator a single character
 * @returns {string[]}
 */
function splitTopLevel(text, separator) {
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * `selector` with every `:where(...)` group removed (nesting-aware). What remains is the part of the
 * selector that CARRIES specificity: an empty remainder means the whole selector is specificity 0.
 *
 * @param {string} selector one selector, not a list
 * @returns {string}
 */
function stripWhere(selector) {
  let out = '';
  let i = 0;
  while (i < selector.length) {
    if (selector.startsWith(':where(', i)) {
      let depth = 0;
      let j = i + ':where'.length;
      for (; j < selector.length; j += 1) {
        if (selector[j] === '(') depth += 1;
        else if (selector[j] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      i = j + 1;
      continue;
    }
    out += selector[i];
    i += 1;
  }
  return out.trim();
}

/**
 * The SUBJECT of a selector: its last compound, after the last top-level combinator
 * (descendant space, `>`, `+`, `~`). Parentheses are respected so a space inside `:where(...)` or
 * `:not(...)` is not a combinator.
 *
 * @param {string} selector one selector, not a list
 * @returns {string}
 */
function subjectOf(selector) {
  let depth = 0;
  let cut = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector.charAt(i);
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0 && /[\s>+~]/.test(ch)) cut = i + 1;
  }
  return selector.slice(cut).trim();
}

/** A compound that is the element `a` plus, at most, pseudo-classes: no class, id or attribute. */
const BARE_ANCHOR = /^a(?::[a-zA-Z-]+(?:\((?:[^()]|\([^()]*\))*\))?)*$/;

/**
 * True when the selector's subject is a bare `a` (with or without pseudo-classes), reading through a
 * `:where()` wrapper: `:where(a:hover)` and `:where(.help-body a:hover)` have a bare-anchor subject
 * inside, and so does `.x a:hover` outside.
 *
 * @param {string} selector one selector, not a list
 * @returns {boolean}
 */
function hasBareAnchorSubject(selector) {
  const subject = subjectOf(selector);
  if (BARE_ANCHOR.test(subject)) return true;
  // A `:where(...)` group, possibly followed by pseudo-classes OUTSIDE it (`:where(a):hover`), which
  // is the form that looks zero-specificity and is not.
  const where = /^:where\(([\s\S]*?)\)((?::[a-zA-Z-]+(?:\([^()]*\))?)*)$/.exec(subject);
  if (where === null) return false;
  return splitTopLevel(where[1] ?? '', ',').some((inner) => hasBareAnchorSubject(inner));
}

/**
 * The declarations of a rule body as `[property, value]` pairs, properties lowercased.
 *
 * @param {string} body
 * @returns {[string, string][]}
 */
function declarationsOf(body) {
  /** @type {[string, string][]} */
  const out = [];
  for (const decl of splitTopLevel(body, ';')) {
    const colon = decl.indexOf(':');
    if (colon === -1) continue;
    out.push([decl.slice(0, colon).trim().toLowerCase(), decl.slice(colon + 1).trim()]);
  }
  return out;
}

/** True when the declarations set an underline through the shorthand or the `-line` longhand. */
function setsUnderline(/** @type {[string, string][]} */ decls) {
  return decls.some(([p, v]) => (p === 'text-decoration' || p === 'text-decoration-line') && /\bunderline\b/.test(v));
}

/**
 * (a) Rules in ONE source whose subject is a bare `a` and which are not entirely inside `:where()`.
 *
 * @param {string} source
 * @returns {{ line: number, selector: string }[]}
 */
function anchorRulesWithSpecificity(source) {
  /** @type {{ line: number, selector: string }[]} */
  const out = [];
  for (const rule of rulesOf(source)) {
    for (const sel of splitTopLevel(rule.selector, ',')) {
      if (hasBareAnchorSubject(sel) && stripWhere(sel) !== '') out.push({ line: rule.line, selector: sel });
    }
  }
  return out;
}

/**
 * (b) Rules in ONE source that underline an `a` element selector outside `:where()`.
 *
 * @param {string} source
 * @returns {{ line: number, selector: string }[]}
 */
function elementUnderlines(source) {
  /** @type {{ line: number, selector: string }[]} */
  const out = [];
  for (const rule of rulesOf(source)) {
    if (!setsUnderline(declarationsOf(rule.body))) continue;
    for (const sel of splitTopLevel(rule.selector, ',')) {
      if (hasBareAnchorSubject(sel) && stripWhere(sel) !== '') out.push({ line: rule.line, selector: sel });
    }
  }
  return out;
}

/**
 * (c) Whether the rule whose selector is EXACTLY `selector` declares `text-decoration: none`.
 * Missing rule counts as missing declaration.
 *
 * @param {string} source
 * @param {string} selector
 * @returns {boolean}
 */
function baseRuleResetsDecoration(source, selector) {
  return rulesOf(source).some(
    (rule) => splitTopLevel(rule.selector, ',').length === 1 && rule.selector.trim() === selector &&
      declarationsOf(rule.body).some(([p, v]) => p === 'text-decoration' && /^none\b/.test(v)),
  );
}

/** A `.btn--<variant>` compound in a hover state, e.g. `.btn--primary:hover:not(:disabled)`. */
const VARIANT_HOVER = /^\.btn--[a-z]+(?:\.[a-zA-Z0-9_-]+)*(?::[a-zA-Z-]+(?:\([^()]*\))?)*$/;

/**
 * (d) `.btn--*:hover` rules that set a background without setting `color`.
 *
 * @param {string} source
 * @returns {{ line: number, selector: string }[]}
 */
function hoverFillsWithoutColour(source) {
  /** @type {{ line: number, selector: string }[]} */
  const out = [];
  for (const rule of rulesOf(source)) {
    const decls = declarationsOf(rule.body);
    const setsBackground = decls.some(([p]) => p === 'background' || p === 'background-color');
    const setsColour = decls.some(([p]) => p === 'color');
    if (!setsBackground || setsColour) continue;
    for (const sel of splitTopLevel(rule.selector, ',')) {
      const subject = subjectOf(sel);
      if (VARIANT_HOVER.test(subject) && /:hover\b/.test(subject)) out.push({ line: rule.line, selector: sel });
    }
  }
  return out;
}

const read = (/** @type {string} */ file) => readFileSync(join(ROOT, file), 'utf8');

// -------------------------------------------------------------------------------------------
// The corpus is real
// -------------------------------------------------------------------------------------------

test('the Studio CSS corpus and global.css are present and non-trivial', () => {
  const files = appCssFiles();
  assert.ok(files.length >= 40, `the app CSS corpus is ${files.length} files; \`git ls-files app/src\` returned little or nothing, so a green verdict below would be an empty scan.`);
  assert.ok(files.includes(GLOBAL_CSS), `${GLOBAL_CSS} is not in the tracked corpus`);
  const rules = rulesOf(read(GLOBAL_CSS));
  assert.ok(rules.length >= 150, `only ${rules.length} rules were read out of ${GLOBAL_CSS}; the brace walker is not reading the file`);
  assert.ok(rules.some((r) => r.selector === '.btn'), 'the base .btn rule was not found, so (c) below would be judging nothing');
  assert.ok(rules.some((r) => r.selector === '.rail-link'), 'the base .rail-link rule was not found, so (c) below would be judging nothing');
});

// -------------------------------------------------------------------------------------------
// The mechanism reddens on the historical defect, and does not cry wolf
// -------------------------------------------------------------------------------------------

test('mechanism (a): the exact global anchor rules this guard was built for are caught, and the :where() form passes', () => {
  const historical = 'a { color: var(--t-accent); text-decoration: none; }\n' +
    'a:hover { color: var(--t-accent-dim); text-decoration: underline; text-underline-offset: 3px; }\n' +
    '.help-body a:hover { text-decoration: underline; }';
  assert.deepEqual(
    anchorRulesWithSpecificity(historical).map((h) => h.selector),
    ['a', 'a:hover', '.help-body a:hover'],
    'the walker does not flag the very rules that made "Buchen" invisible on hover',
  );
  const fixed = ':where(a) { color: var(--t-accent); text-decoration: none; }\n' +
    ':where(a:hover) { color: var(--t-accent-dim); }\n' +
    ':where(.help-body a:hover, .state-body a:hover) { text-decoration: underline; text-underline-offset: 3px; }\n' +
    '@media (max-width: 767px) { :where(a) { color: inherit; } }\n' +
    '.btn { color: var(--t-text); } a.btn:hover { text-decoration: none; } .link-inline:hover { text-decoration: underline; }';
  assert.deepEqual(anchorRulesWithSpecificity(fixed), [], 'a zero-specificity :where() anchor rule, a class rule, or an `a.btn` compound was flagged; a guard that fails correct CSS gets deleted');
});

test('mechanism (a): a :where() wrapper with a state OUTSIDE it still carries specificity and is caught', () => {
  assert.deepEqual(anchorRulesWithSpecificity(':where(a):hover { color: red; }').map((h) => h.selector), [':where(a):hover']);
  assert.deepEqual(anchorRulesWithSpecificity('main :where(a) { color: red; }').map((h) => h.selector), ['main :where(a)']);
});

test('mechanism (b): an element underline outside :where() is caught anywhere; a class underline is not', () => {
  const bad = '.members-goonline a:hover { text-decoration: underline; }\n' +
    '.x a { text-decoration-line: underline; }\n' +
    'a:hover { color: red; text-decoration: underline dotted; }';
  assert.deepEqual(elementUnderlines(bad).map((h) => h.selector), ['.members-goonline a:hover', '.x a', 'a:hover']);
  const good = '.help-link:hover { text-decoration: underline; }\n' +
    ':where(.diag-prose a:hover) { text-decoration: underline; }\n' +
    '.members-goonline a { white-space: nowrap; }\n' +
    'a.documents-back:hover { text-decoration: underline; }';
  assert.deepEqual(elementUnderlines(good), [], 'a class-scoped underline, a :where()-scoped one, a non-underline element rule or an `a.class` compound was flagged');
});

test('mechanism (c): the base reset is found when present and missed when absent', () => {
  assert.equal(baseRuleResetsDecoration('.btn { display: inline-flex; text-decoration: none; }', '.btn'), true);
  assert.equal(baseRuleResetsDecoration('.btn { display: inline-flex; }', '.btn'), false);
  assert.equal(baseRuleResetsDecoration('.btn:hover { text-decoration: none; }', '.btn'), false, 'a hover rule is not the base rule');
  assert.equal(baseRuleResetsDecoration('.btn, .x { text-decoration: none; }', '.btn'), false, 'a shared list is not the base rule');
});

test('mechanism (d): a variant hover that fills without a colour is caught; one that states its colour passes', () => {
  const bad = '.btn--primary:hover:not(:disabled) { background: var(--t-accent-dim); }\n' +
    '.btn--secondary:hover { background-color: var(--t-bg-soft); border-color: var(--t-text-faint); }';
  assert.deepEqual(hoverFillsWithoutColour(bad).map((h) => h.selector), ['.btn--primary:hover:not(:disabled)', '.btn--secondary:hover']);
  const good = '.btn--primary:hover:not(:disabled) { background: var(--t-accent-dim); color: var(--t-on-accent); }\n' +
    '.btn--ghost:hover { color: var(--t-text); }\n' +
    '.btn--primary:focus-visible { background: red; }\n' +
    '.btn--danger:hover:not(:disabled) { background: var(--t-danger); color: var(--t-on-danger); }';
  assert.deepEqual(hoverFillsWithoutColour(good), [], 'a hover rule that states its colour, a colour-only hover, or a non-hover state was flagged');
});

test('the walker preserves line numbers through comments and nested @media blocks', () => {
  const src = '/* a comment\n spanning lines */\n.x { color: red; }\n@media (hover: none) {\n  a:hover { text-decoration: underline; }\n}';
  const rules = rulesOf(src);
  assert.deepEqual(rules.map((r) => [r.selector, r.line]), [['.x', 3], ['a:hover', 5]]);
});

// -------------------------------------------------------------------------------------------
// The guard proper
// -------------------------------------------------------------------------------------------

test('(a) every bare-anchor rule in global.css is entirely inside :where() (specificity 0)', () => {
  const hits = anchorRulesWithSpecificity(read(GLOBAL_CSS)).map((h) => `${GLOBAL_CSS}:${h.line} ${h.selector}`);
  assert.deepEqual(
    hits,
    [],
    'a global anchor rule carries specificity, so it can outrank a component class on an <a> (this is how ' +
      'the primary door lost its label on hover). Write it as `:where(a) {...}` / `:where(a:hover) {...}`, ' +
      `and scope any prose underline as \`:where(.container a:hover)\`. Found:\n  ${hits.join('\n  ')}`,
  );
});

test('(b) no Studio stylesheet underlines an `a` element selector outside :where()', () => {
  const hits = [];
  for (const file of appCssFiles()) {
    for (const h of elementUnderlines(read(file))) hits.push(`${file}:${h.line} ${h.selector}`);
  }
  assert.deepEqual(
    hits,
    [],
    'an element-level anchor rule sets an underline with real specificity, so it leaks onto every <a> ' +
      'under it (rail rows, card rows, button-shaped links). Underline on hover is an opt-in: put ' +
      `\`link-inline\` on the text link, or scope the rule inside \`:where()\`. Found:\n  ${hits.join('\n  ')}`,
  );
});

test('(c) the base .btn and .rail-link rules state text-decoration: none themselves', () => {
  const source = read(GLOBAL_CSS);
  for (const selector of ['.btn', '.rail-link']) {
    assert.ok(
      baseRuleResetsDecoration(source, selector),
      `the base \`${selector}\` rule in ${GLOBAL_CSS} does not declare \`text-decoration: none\`. A button-shaped ` +
        'anchor and a rail row must never depend on a global reset for their decoration.',
    );
  }
});

test('(d) every .btn--<variant>:hover rule that sets a background also sets its colour', () => {
  const hits = [];
  for (const file of appCssFiles()) {
    for (const h of hoverFillsWithoutColour(read(file))) hits.push(`${file}:${h.line} ${h.selector}`);
  }
  assert.deepEqual(
    hits,
    [],
    'a button variant changes its fill on hover without restating its text colour, so an inherited ' +
      'colour (a global anchor hover, a parent) can sit invisibly on the new fill. State `color` in ' +
      `every variant's :hover, :active and :focus-visible. Found:\n  ${hits.join('\n  ')}`,
  );
});
