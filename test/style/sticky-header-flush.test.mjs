// @ts-check
/**
 * THE STICKY PAGE HEADER PINS FLUSH UNDER AN OPAQUE BAND: NOTHING SCROLLS VISIBLY ABOVE IT (P6).
 *
 * THE DEFECT THIS EXISTS FOR (01.10.2026). A sticky element resolves `top` against its scroll
 * container's PADDING edge, not its scroll edge. The Studio's one scroll region, `.frame > main`,
 * carries a 24px top padding (64px on the mobile layout, to clear the hamburger), so the sticky
 * SurfaceHeader at `top: 0` pinned 24px below the visible top of main. Every scrolled surface showed
 * its content passing through that open strip ABOVE the header, cut in half by the header's edge
 * (measured on /journal at 1280x800: table rows painted at y 0 to 24 above the title).
 *
 * THE FIX, and what this guard holds:
 *   (a) main's top padding is ONE custom property, `--main-pad-top`, a spacing token, and the
 *       padding reads it. The mobile layout overrides the PROPERTY, never the padding, so the band
 *       and the padding cannot disagree in either layout.
 *   (b) `.frame > main::before` is the strip made opaque: sticky at `calc(-1 * var(--main-pad-top))`
 *       (the scroll edge), exactly `var(--main-pad-top)` tall, pulled into the padding by an equal
 *       negative margin (no flow height, so nothing at rest moves), on the page ground and the
 *       sticky tier.
 *   (c) The SurfaceHeader stays at `top: 0`, so it pins exactly at the band's bottom edge: flush,
 *       opaque, on the same tier, with no border at rest. Its scrolled-state hairline is a 1px
 *       absolutely positioned pseudo-element keyed on `data-stuck`, so stamping it moves no box.
 *   (d) A sticky band that lives under the header offsets by the header's published height
 *       (`--surface-header-height`): the DataTable head and the Review coverage bar. At `top: 0` the
 *       coverage bar shared the header's pin line and painted over the page title.
 *
 * The walker is a comment-blanking brace walker, not a CSS parser: the corpus is hand-written and the
 * properties are about selector shape and declaration values. Synthetic fixtures prove the rules bite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const GLOBAL_CSS = 'app/src/styles/global.css';
const HEADER_CSS = 'app/src/components/SurfaceHeader.css';
const DATATABLE_CSS = 'app/src/components/DataTable.css';
const REVIEW_CSS = 'app/src/surfaces/Review/Review.css';

const MOBILE_MEDIA = '@media (max-width: 767px)';
const PAD = 'var(--main-pad-top)';
const NEG_PAD = 'calc(-1 * var(--main-pad-top))';

/** @param {string} path */
function read(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

/** @typedef {{ selector: string, media: string, decls: Map<string, string> }} StyleRule */

/**
 * Collapse whitespace so `calc( -1*var(--x) )` style spacing differences do not matter.
 *
 * @param {string} value
 */
function norm(value) {
  return value.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
}

/**
 * Every style rule with its enclosing at-rule prelude ('' at top level) and its declarations.
 *
 * @param {string} source
 * @returns {StyleRule[]}
 */
function rulesOf(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  /** @type {StyleRule[]} */
  const out = [];
  /** @type {{ prelude: string, bodyStart: number }[]} */
  const stack = [];
  let preludeStart = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      stack.push({ prelude: norm(text.slice(preludeStart, i)), bodyStart: i + 1 });
      preludeStart = i + 1;
    } else if (ch === '}') {
      const top = stack.pop();
      if (top !== undefined && !top.prelude.startsWith('@')) {
        const media = stack.filter((s) => s.prelude.startsWith('@')).map((s) => s.prelude).join(' ');
        /** @type {Map<string, string>} */
        const decls = new Map();
        for (const decl of text.slice(top.bodyStart, i).split(';')) {
          const colon = decl.indexOf(':');
          if (colon === -1) continue;
          decls.set(decl.slice(0, colon).trim().toLowerCase(), norm(decl.slice(colon + 1)));
        }
        for (const selector of top.prelude.split(',')) out.push({ selector: norm(selector), media, decls });
      }
      preludeStart = i + 1;
    } else if (ch === ';' && stack.length === 0) {
      preludeStart = i + 1;
    }
  }
  return out;
}

/**
 * The rules for one exact selector inside one media context.
 *
 * @param {StyleRule[]} rules
 * @param {string} selector
 * @param {string} media
 */
function rulesFor(rules, selector, media = '') {
  return rules.filter((r) => r.selector === selector && r.media === media);
}

/**
 * The value one selector declares for one property in one media context (the last one wins).
 *
 * @param {StyleRule[]} rules
 * @param {string} selector
 * @param {string} property
 * @param {string} media
 * @returns {string | undefined}
 */
function valueOf(rules, selector, property, media = '') {
  let value;
  for (const rule of rulesFor(rules, selector, media)) {
    const v = rule.decls.get(property);
    if (v !== undefined) value = v;
  }
  return value;
}

/**
 * Rule (a) over one stylesheet: the base main rule declares the token-valued property and reads it
 * as its top padding, and the mobile rule overrides the property and never the padding. Returns the
 * list of violations, so a fixture can prove it bites.
 *
 * @param {string} source
 * @returns {string[]}
 */
function mainPaddingViolations(source) {
  const rules = rulesOf(source);
  const problems = [];
  const base = valueOf(rules, '.frame > main', '--main-pad-top');
  if (base === undefined || !/^var\(--t-space-[0-9-]+\)$/.test(base)) {
    problems.push(`.frame > main must declare --main-pad-top as one spacing token, found ${String(base)}`);
  }
  const padding = valueOf(rules, '.frame > main', 'padding');
  const paddingTop = valueOf(rules, '.frame > main', 'padding-top');
  const top = paddingTop ?? (padding === undefined ? undefined : padding.split(' ')[0]);
  if (top !== PAD) problems.push(`.frame > main must take its top padding from ${PAD}, found ${String(top)}`);
  const mobile = valueOf(rules, '.frame > main', '--main-pad-top', MOBILE_MEDIA);
  if (mobile === undefined) problems.push(`the mobile layout must override --main-pad-top on .frame > main`);
  else if (/\d(px|rem|em)\b/.test(mobile)) problems.push(`the mobile --main-pad-top restates a length: ${mobile}`);
  for (const rule of rules.filter((r) => r.selector === '.frame > main' && r.media !== '')) {
    for (const prop of ['padding', 'padding-top', 'padding-block', 'padding-block-start']) {
      if (rule.decls.has(prop)) problems.push(`${rule.media} sets ${prop} on .frame > main; override --main-pad-top instead`);
    }
  }
  return problems;
}

/**
 * Rule (b) over one stylesheet: the mask is the strip, sticky at the scroll edge, opaque, flowless.
 *
 * @param {string} source
 * @returns {string[]}
 */
function maskViolations(source) {
  const rules = rulesOf(source);
  const sel = '.frame > main::before';
  /** @type {[string, string][]} */
  const expected = [
    ['position', 'sticky'],
    ['top', NEG_PAD],
    ['margin-top', NEG_PAD],
    ['height', PAD],
    ['background', 'var(--t-bg)'],
    ['z-index', 'var(--t-z-sticky)'],
    ['display', 'block'],
  ];
  const problems = [];
  if (valueOf(rules, sel, 'content') === undefined) problems.push(`${sel} declares no content, so it never renders`);
  for (const [prop, want] of expected) {
    const got = valueOf(rules, sel, prop);
    if (got !== want) problems.push(`${sel} ${prop} must be ${want}, found ${String(got)}`);
  }
  return problems;
}

test('fixtures: the walker catches the pre-fix stylesheet and passes the fixed shape', () => {
  const before = `
    .frame > main { overflow: auto; padding: var(--t-space-3); }
    @media (max-width: 767px) {
      .frame > main { padding-top: calc(var(--t-space-3) + 2.5rem); }
    }`;
  const beforeProblems = mainPaddingViolations(before);
  assert.ok(beforeProblems.some((p) => p.includes('must declare --main-pad-top')), beforeProblems.join('\n'));
  assert.ok(beforeProblems.some((p) => p.includes('sets padding-top')), beforeProblems.join('\n'));
  assert.ok(maskViolations(before).length > 0, 'a stylesheet with no mask must fail the mask rule');

  const restated = `
    .frame > main { --main-pad-top: var(--t-space-3); padding: var(--main-pad-top) var(--t-space-3); }
    @media (max-width: 767px) { .frame > main { --main-pad-top: 64px; } }`;
  assert.ok(mainPaddingViolations(restated).some((p) => p.includes('restates a length')));

  const offByOne = `
    .frame > main::before { content: ''; display: block; position: sticky; top: 0;
      margin-top: calc(-1 * var(--main-pad-top)); height: var(--main-pad-top);
      background: var(--t-bg); z-index: var(--t-z-sticky); }`;
  assert.deepEqual(maskViolations(offByOne), ['.frame > main::before top must be calc(-1 * var(--main-pad-top)), found 0']);

  const fixed = `
    .frame > main { --main-pad-top: var(--t-space-3); padding: var(--main-pad-top) var(--t-space-3) var(--t-space-3); }
    .frame > main::before { content: ''; display: block; position: sticky;
      top: calc(-1 * var(--main-pad-top)); z-index: var(--t-z-sticky); height: var(--main-pad-top);
      margin-top: calc(-1 * var(--main-pad-top)); background: var(--t-bg); }
    @media (max-width: 767px) { .frame > main { --main-pad-top: var(--t-space-8); } }`;
  assert.deepEqual(mainPaddingViolations(fixed), []);
  assert.deepEqual(maskViolations(fixed), []);
});

test("(a) main's top padding is one token-valued custom property, and mobile overrides only that", () => {
  assert.deepEqual(mainPaddingViolations(read(GLOBAL_CSS)), []);
});

test('(b) the mask covers exactly the top padding, pinned at the scroll edge, opaque and flowless', () => {
  const css = read(GLOBAL_CSS);
  assert.deepEqual(maskViolations(css), []);
  // It spans the padding box sideways too: the negative inline margin equals main's inline padding.
  const rules = rulesOf(css);
  const inline = valueOf(rules, '.frame > main', 'padding')?.split(' ')[1];
  assert.ok(inline !== undefined, '.frame > main states its inline padding in the padding shorthand');
  assert.equal(valueOf(rules, '.frame > main::before', 'margin-inline'), `calc(-1 * ${inline})`);
});

test('(c) the SurfaceHeader pins at top 0, flush under the mask, opaque, with no hairline at rest', () => {
  const rules = rulesOf(read(HEADER_CSS));
  const header = '.surface-header';
  assert.equal(valueOf(rules, header, 'position'), 'sticky');
  assert.equal(valueOf(rules, header, 'top'), '0', 'top: 0 is the band bottom: the mask ends at the padding edge');
  assert.equal(valueOf(rules, header, 'z-index'), 'var(--t-z-sticky)', 'the header shares the mask tier');
  assert.equal(valueOf(rules, header, 'background'), 'var(--t-bg)', 'the header is on the same ground as the mask');
  for (const prop of ['border', 'border-bottom', 'border-block-end', 'box-shadow']) {
    assert.equal(valueOf(rules, header, prop), undefined, `${header} carries no ${prop} at rest`);
  }
  // The hairline: an absolutely positioned 1px line on the header's own bottom edge, coloured only
  // under data-stuck, so turning it on changes no box.
  assert.equal(valueOf(rules, `${header}::after`, 'position'), 'absolute');
  assert.equal(valueOf(rules, `${header}::after`, 'height'), '1px');
  assert.equal(valueOf(rules, `${header}::after`, 'bottom'), '0');
  assert.equal(valueOf(rules, `${header}::after`, 'background'), 'transparent');
  assert.equal(valueOf(rules, `${header}[data-stuck]::after`, 'background'), 'var(--t-border)');
});

test('(d) the sticky bands under the header offset by its published height', () => {
  const offset = 'var(--surface-header-height, 0px)';
  assert.equal(valueOf(rulesOf(read(DATATABLE_CSS)), '.data-table thead th', 'top'), offset);
  const review = rulesOf(read(REVIEW_CSS));
  assert.equal(valueOf(review, '.rv-coverage', 'position'), 'sticky');
  assert.equal(valueOf(review, '.rv-coverage', 'top'), offset, 'the coverage bar pins under the header, not over it');
});
