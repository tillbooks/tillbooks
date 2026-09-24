// @ts-check
/**
 * THE FOCUS BORDER CUE ARRIVES: THE TOKEN SELECTOR OUTRANKS A RESTING BORDER, AND EVERY CONTROL HAS A BORDER TO COLOUR.
 *
 * THE DEFECT THIS EXISTS FOR (UI polish round 2, K-10, D137). The owner's "Sehr subtil" focus is
 * two cues: the control's border turns brass (the primary one) and a faint 2px accent-soft halo sits
 * outside it. Measured live, the primary cue was missing on the controls a keyboard reaches first:
 *   1. The token rule was `:where(a, button, input, select, textarea, [tabindex]):focus-visible`,
 *      and its comment called it specificity 0. It was (0,1,0): the `:focus-visible` outside the
 *      `:where()` counts. Every single-class rule that set a border and loaded later
 *      (`.select-trigger`, `.rail-search`, every tab family) kept its grey border under focus.
 *   2. Twenty-two controls had no border at all (`.rail-link`, `.rail-treeitem`, the two footer
 *      toggles, `.help-trigger`, ...), so there was nothing to turn brass. A rail leaf reached with an
 *      arrow key showed only the halo, at 1.15:1 in light and 1.36:1 in dark.
 *
 * THE RULES, stated as source properties so a control nobody opened in a test is still judged:
 *   (a) The token focus rule in `brand/tokens/tokens.css` is written with `:is(...)` over the six
 *       focusable kinds, never `:where(...)`, and computes to specificity (0,2,0).
 *   (b) Every focusable control class in `app/src/styles/global.css` declares a border with a real
 *       width (transparent is fine: it is the edge the focus rule colours).
 *   (c) No rule in `global.css` takes the border off a clickable control class (`border: 0`,
 *       `border: none`, `border-width: 0`, `border-style: none`) unless that class is a named
 *       exemption below with its reason.
 *   (d) Every class `global.css` makes clickable (a `cursor: pointer`, `col-resize` or `grab` rule)
 *       is CLASSIFIED: it is either a focusable control under (b) or a named exemption. A new
 *       clickable class therefore fails here until someone decides which it is.
 *
 * The walker is the same comment-blanking brace walker the anchor guard uses: not a CSS parser, but
 * the corpus is hand-written and these properties are about selector shape and declaration names.
 * Synthetic must-catch and must-pass fixtures below prove each rule bites before the corpus is judged.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TOKENS_FILE = 'brand/tokens/tokens.css';
const GLOBAL_CSS = 'app/src/styles/global.css';

/** The six kinds a keyboard can land on, in the order the token rule lists them. */
const FOCUSABLE_KINDS = ['a', 'button', 'input', 'select', 'textarea', '[tabindex]'];

/**
 * The focusable control classes of `global.css`. Each one must declare a border with a width, so
 * the focus rule has an edge to turn brass.
 */
const FOCUSABLE_CONTROLS = [
  'btn',
  'field',
  'select-trigger',
  'ws-switcher-trigger',
  'ws-switcher-item',
  'ws-switcher-retry',
  'rail-search',
  'rail-env-pill',
  'rail-link',
  'rail-treeitem',
  'rail-fav-btn',
  'rail-fav-input',
  'rail-pin',
  'rail-icon-btn',
  'rail-flyout-link',
  'rail-hamburger',
  'theme-toggle',
  'density-toggle',
  'help-trigger',
  'help-see-also-term',
  'concept-term',
  'link-inline',
  'panel--interactive',
  'error-retry',
  'skip-link',
];

/** Clickable classes that are deliberately NOT a bordered focus stop, each with its reason. */
const EXEMPT = {
  'select-option':
    'an option of the <Select> listbox; focus stays on the trigger, which drives the list through aria-activedescendant',
  'rail-fav-grip':
    'the pointer-only drag grip, aria-hidden and out of the tab order; the keyboard reorder is the move buttons (WCAG 2.5.7)',
  'rail-resizer':
    'the 8px window splitter; a border would draw a brass box down the whole viewport, so its edge cue is the grip turning brass beside the halo',
  'check-cell':
    'the label around a native checkbox (K-14); the checkbox inside is the focus stop and carries the ring',
};

/**
 * `source` with every block comment blanked to spaces, newlines kept.
 *
 * @param {string} source
 * @returns {string}
 */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** @typedef {{ selector: string, body: string, line: number }} StyleRule */

/**
 * Every style rule (selector, body, 1-based line), including rules nested in `@media` blocks.
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
      if (top !== undefined && !top.isAt) out.push({ selector: top.prelude, body: text.slice(top.bodyStart, i), line: top.line });
      preludeStart = i + 1;
    } else if (ch === ';') {
      preludeStart = i + 1;
    }
  }
  return out;
}

/**
 * Split `text` on `separator` at parenthesis depth 0 only.
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

/**
 * The subject compound of one selector (after the last top-level combinator), with a whole-selector
 * `:where(...)` wrapper of a single argument opened first, so `:where(.x)` reads as `.x`.
 *
 * @param {string} selector one selector, not a list
 * @returns {string}
 */
function subjectOf(selector) {
  const whole = /^:where\(([^()]*)\)$/.exec(selector.trim());
  const sel = whole !== null && splitTopLevel(whole[1] ?? '', ',').length === 1 ? (whole[1] ?? '').trim() : selector;
  let depth = 0;
  let cut = 0;
  for (let i = 0; i < sel.length; i += 1) {
    const ch = sel.charAt(i);
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0 && /[\s>+~]/.test(ch)) cut = i + 1;
  }
  return sel.slice(cut).trim();
}

/**
 * The first class a subject compound names (`input.field:hover` gives `field`), or null.
 *
 * @param {string} subject
 * @returns {string | null}
 */
function classOf(subject) {
  const m = /\.([a-zA-Z0-9_-]+)/.exec(subject);
  return m === null ? null : (m[1] ?? null);
}

/**
 * True when `subject` is the class's RESTING compound: the class, optionally on an element, with no
 * state, no second class and no attribute (`.rail-link`, `input.field`; not `.rail-link:hover`).
 *
 * @param {string} subject
 * @param {string} cls
 * @returns {boolean}
 */
function isRestingCompound(subject, cls) {
  return new RegExp(`^[a-z]*\\.${cls.replace(/[-]/g, '\\-')}$`).test(subject);
}

/** True when the declarations give an element a border with a real width. */
function declaresBorderWidth(/** @type {[string, string][]} */ decls) {
  return decls.some(
    ([p, v]) =>
      ((p === 'border' || p === 'border-width') && !/^(?:none|0)\b/.test(v) && /\b(?:0?\.\d+|[1-9]\d*(?:\.\d+)?)px\b/.test(v)),
  );
}

/** True when the declarations take the border away. */
function removesBorder(/** @type {[string, string][]} */ decls) {
  return decls.some(
    ([p, v]) =>
      ((p === 'border' || p === 'border-width') && /^(?:none|0(?:px)?)$/.test(v)) || (p === 'border-style' && /^none$/.test(v)),
  );
}

/**
 * Every class a stylesheet makes clickable, i.e. the subject class of a rule that sets a pointer-ish
 * cursor.
 *
 * @param {string} source
 * @returns {Set<string>}
 */
function clickableClasses(source) {
  const out = new Set();
  for (const rule of rulesOf(source)) {
    if (!declarationsOf(rule.body).some(([p, v]) => p === 'cursor' && /^(?:pointer|col-resize|row-resize|grab|grabbing)$/.test(v))) continue;
    for (const sel of splitTopLevel(rule.selector, ',')) {
      const cls = classOf(subjectOf(sel));
      if (cls !== null) out.add(cls);
    }
  }
  return out;
}

/**
 * (b) The classes among `wanted` that no resting rule gives a border width.
 *
 * @param {string} source
 * @param {string[]} wanted
 * @returns {string[]}
 */
function controlsWithoutBorder(source, wanted) {
  const bordered = new Set();
  for (const rule of rulesOf(source)) {
    if (!declaresBorderWidth(declarationsOf(rule.body))) continue;
    for (const sel of splitTopLevel(rule.selector, ',')) {
      const subject = subjectOf(sel);
      const cls = classOf(subject);
      if (cls !== null && isRestingCompound(subject, cls)) bordered.add(cls);
    }
  }
  return wanted.filter((cls) => !bordered.has(cls));
}

/**
 * (c) Rules that take the border off a clickable, non-exempt class.
 *
 * @param {string} source
 * @param {Record<string, string>} exempt
 * @returns {{ line: number, selector: string }[]}
 */
function borderRemovals(source, exempt) {
  const clickable = clickableClasses(source);
  /** @type {{ line: number, selector: string }[]} */
  const out = [];
  for (const rule of rulesOf(source)) {
    if (!removesBorder(declarationsOf(rule.body))) continue;
    for (const sel of splitTopLevel(rule.selector, ',')) {
      const cls = classOf(subjectOf(sel));
      if (cls !== null && clickable.has(cls) && !(cls in exempt)) out.push({ line: rule.line, selector: sel });
    }
  }
  return out;
}

/**
 * Selector specificity `[ids, classes, types]` of ONE complex selector. Enough of Selectors 4 for
 * this corpus: `:is()`/`:not()`/`:has()` take their most specific argument, `:where()` counts zero,
 * any other pseudo-class counts as a class, a pseudo-element as a type.
 *
 * @param {string} selector
 * @returns {[number, number, number]}
 */
function specificity(selector) {
  /** @type {[number, number, number]} */
  const total = [0, 0, 0];
  const s = selector.trim();
  const identEnd = (/** @type {number} */ from) => {
    let j = from;
    while (j < s.length && /[a-zA-Z0-9_-]/.test(s.charAt(j))) j += 1;
    return j;
  };
  const parensEnd = (/** @type {number} */ from) => {
    let depth = 0;
    let j = from;
    for (; j < s.length; j += 1) {
      if (s[j] === '(') depth += 1;
      else if (s[j] === ')') {
        depth -= 1;
        if (depth === 0) return j + 1;
      }
    }
    return j;
  };
  let i = 0;
  while (i < s.length) {
    const ch = s.charAt(i);
    if (ch === '#') {
      total[0] += 1;
      i = identEnd(i + 1);
    } else if (ch === '.') {
      total[1] += 1;
      i = identEnd(i + 1);
    } else if (ch === '[') {
      total[1] += 1;
      i = s.indexOf(']', i) + 1;
    } else if (ch === ':' && s.charAt(i + 1) === ':') {
      total[2] += 1;
      i = identEnd(i + 2);
      if (s.charAt(i) === '(') i = parensEnd(i);
    } else if (ch === ':') {
      const end = identEnd(i + 1);
      const name = s.slice(i + 1, end);
      if (s.charAt(end) === '(' && ['is', 'not', 'has', 'where'].includes(name)) {
        const close = parensEnd(end);
        if (name !== 'where') {
          const best = splitTopLevel(s.slice(end + 1, close - 1), ',')
            .map(specificity)
            .reduce((a, b) => (a[0] !== b[0] ? (a[0] > b[0] ? a : b) : a[1] !== b[1] ? (a[1] > b[1] ? a : b) : a[2] >= b[2] ? a : b), [0, 0, 0]);
          total[0] += best[0];
          total[1] += best[1];
          total[2] += best[2];
        }
        i = close;
      } else {
        total[1] += 1;
        i = s.charAt(end) === '(' ? parensEnd(end) : end;
      }
    } else if (/[a-zA-Z]/.test(ch)) {
      total[2] += 1;
      i = identEnd(i);
    } else {
      i += 1;
    }
  }
  return total;
}

/**
 * (a) Problems with a token focus selector, empty when it is the (0,2,0) `:is()` form.
 *
 * @param {string} selector
 * @returns {string[]}
 */
function focusSelectorProblems(selector) {
  /** @type {string[]} */
  const problems = [];
  const s = selector.replace(/\s+/g, ' ').trim();
  if (!s.startsWith(':is(')) problems.push('it does not open with `:is(`');
  if (s.includes(':where(')) problems.push('it still uses `:where(`, which leaves the selector at (0,1,0)');
  if (!s.endsWith(':focus-visible')) problems.push('it does not end in `:focus-visible`');
  const inner = /^:is\(([^()]*)\)/.exec(s)?.[1] ?? '';
  const members = splitTopLevel(inner, ',');
  for (const kind of FOCUSABLE_KINDS) {
    if (!members.includes(kind)) problems.push(`it does not list \`${kind}\``);
  }
  const spec = specificity(s);
  if (spec.join(',') !== '0,2,0') problems.push(`it computes to (${spec.join(',')}), not (0,2,0)`);
  return problems;
}

const read = (/** @type {string} */ file) => readFileSync(join(ROOT, file), 'utf8');

/** The token rule that paints the focus ring: its selector ends in :focus-visible. */
function tokenFocusRules() {
  return rulesOf(read(TOKENS_FILE)).filter(
    (r) => /:focus-visible\s*$/.test(r.selector) && declarationsOf(r.body).some(([p, v]) => p === 'box-shadow' && v === 'var(--t-focus-ring)'),
  );
}

// -------------------------------------------------------------------------------------------
// The corpus is real
// -------------------------------------------------------------------------------------------

test('global.css and the token file are present and read', () => {
  const rules = rulesOf(read(GLOBAL_CSS));
  assert.ok(rules.length >= 150, `only ${rules.length} rules were read out of ${GLOBAL_CSS}; the walker is not reading the file`);
  assert.ok(clickableClasses(read(GLOBAL_CSS)).size >= 20, 'fewer than 20 clickable classes found in global.css; the cursor scan is not reading the file');
  assert.equal(tokenFocusRules().length, 1, `${TOKENS_FILE} must carry exactly one focus rule that paints var(--t-focus-ring)`);
});

// -------------------------------------------------------------------------------------------
// The mechanism reddens on the historical defect, and does not cry wolf
// -------------------------------------------------------------------------------------------

test('mechanism (a): the old :where() token selector is (0,1,0) and rejected; the :is() form is (0,2,0) and passes', () => {
  const before = ':where(a, button, input, select, textarea, [tabindex]):focus-visible';
  assert.deepEqual(specificity(before), [0, 1, 0], 'the specificity calculator does not see the :focus-visible outside :where()');
  assert.ok(focusSelectorProblems(before).length > 0, 'the exact selector K-10 replaced was accepted');
  const after = ':is(a, button, input, select, textarea, [tabindex]):focus-visible';
  assert.deepEqual(specificity(after), [0, 2, 0]);
  assert.deepEqual(focusSelectorProblems(after), []);
  assert.deepEqual(specificity('.select-trigger'), [0, 1, 0], 'a single-class resting rule, the kind the old selector lost to');
  assert.ok(focusSelectorProblems(':is(a, button, input):focus-visible').length > 0, 'a selector that drops a focusable kind was accepted');
});

test('mechanism (b)-(d): the pre-K-10 borderless controls are caught, the fixed forms pass', () => {
  const before =
    '.rail-link { display: flex; padding: 4px 16px; }\n' +
    '.help-trigger { width: 24px; border: 0; cursor: pointer; }\n' +
    '.theme-toggle,\n.density-toggle { border: none; cursor: pointer; }\n' +
    '.x-grip { cursor: grab; border: 0; }';
  assert.deepEqual(controlsWithoutBorder(before, ['rail-link', 'help-trigger', 'theme-toggle']), ['rail-link', 'help-trigger', 'theme-toggle']);
  assert.deepEqual(
    borderRemovals(before, {}).map((h) => h.selector),
    ['.help-trigger', '.theme-toggle', '.density-toggle', '.x-grip'],
  );
  assert.deepEqual(borderRemovals(before, { 'x-grip': 'pointer only' }).map((h) => h.selector), ['.help-trigger', '.theme-toggle', '.density-toggle']);

  const after =
    '.rail-link { padding: calc(4px - 1px) calc(16px - 1px); border: 1px solid transparent; }\n' +
    '.help-trigger { border: 1px solid transparent; cursor: pointer; }\n' +
    ':where(.panel--interactive) { border: 1px solid transparent; }\n' +
    'input.field, select.field { border: 1px solid var(--t-border-strong); }\n' +
    '.rail-link:hover { border: 0; }';
  assert.deepEqual(controlsWithoutBorder(after, ['rail-link', 'help-trigger', 'panel--interactive', 'field']), []);
  assert.deepEqual(borderRemovals(after, {}), [], 'a non-clickable class losing its border on hover was flagged');
  assert.deepEqual(
    controlsWithoutBorder('.rail-link:hover { border: 1px solid red; }', ['rail-link']),
    ['rail-link'],
    'a border set only in a hover state was taken for the resting border',
  );
});

// -------------------------------------------------------------------------------------------
// The guard proper
// -------------------------------------------------------------------------------------------

test('(a) the token focus selector is the (0,2,0) :is() form over the six focusable kinds', () => {
  const rule = tokenFocusRules()[0];
  assert.ok(rule !== undefined);
  assert.deepEqual(
    focusSelectorProblems(rule.selector),
    [],
    `the focus rule at ${TOKENS_FILE}:${rule.line} is \`${rule.selector}\`. It must be ` +
      '`:is(a, button, input, select, textarea, [tabindex]):focus-visible`, specificity (0,2,0), so a resting ' +
      'single-class border never outranks the brass border cue.',
  );
});

test('(b) every focusable control class in global.css declares a border for the focus cue to colour', () => {
  const missing = controlsWithoutBorder(read(GLOBAL_CSS), FOCUSABLE_CONTROLS);
  assert.deepEqual(
    missing,
    [],
    'these focusable controls have no border, so the focus rule turns nothing brass and only the 1.15:1 ' +
      'halo arrives. Give the resting rule `border: 1px solid transparent` (take the 1px out of the padding ' +
      `if the box must not move): ${missing.join(', ')}`,
  );
});

test('(c) no rule in global.css takes the border off a clickable control', () => {
  const hits = borderRemovals(read(GLOBAL_CSS), EXEMPT).map((h) => `${GLOBAL_CSS}:${h.line} ${h.selector}`);
  assert.deepEqual(
    hits,
    [],
    'a clickable control loses its border, so the brass focus cue has no edge to arrive on. Use ' +
      '`border-color: transparent` instead, or name the class in EXEMPT with the reason its focus cue ' +
      `lives elsewhere. Found:\n  ${hits.join('\n  ')}`,
  );
});

test('(d) every clickable class in global.css is classified as a bordered control or a named exemption', () => {
  const known = new Set([...FOCUSABLE_CONTROLS, ...Object.keys(EXEMPT)]);
  const unclassified = [...clickableClasses(read(GLOBAL_CSS))].filter((cls) => !known.has(cls)).sort();
  assert.deepEqual(
    unclassified,
    [],
    'global.css makes these classes clickable, and this guard does not know whether they are focus stops. ' +
      'Add each to FOCUSABLE_CONTROLS (and give it a border) or to EXEMPT with its reason: ' +
      unclassified.join(', '),
  );
  for (const cls of Object.keys(EXEMPT)) {
    assert.ok(clickableClasses(read(GLOBAL_CSS)).has(cls), `EXEMPT names .${cls}, which global.css no longer makes clickable; drop the exemption`);
  }
});
