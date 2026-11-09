// @ts-check
/**
 * A MONEY FIELD KEEPS ITS TABULAR FIGURES (D137, the C2 money critic, findings F1 and F3).
 *
 * THE DEFECT THIS EXISTS FOR. Round 2 Part D moved the booking form's Soll and Haben inputs onto the
 * shared `input.field` control (K-15). That block states `font: inherit` at specificity (0,1,1), and
 * the `font` shorthand resets `font-variant-numeric` and `font-feature-settings`. The field's own
 * tabular class, `.journal-line-amount` at (0,1,0), lost the cascade, so the composer typed money in
 * proportional figures ("111111.11" 54.02px against "888888.88" 73.39px in the same field). Six more
 * money inputs carried `.t-num` or `.item-num` with the same result. A rule that loses the cascade is
 * valid CSS, so nothing in the suite could see it.
 *
 * THE RULES, stated as source properties so an editor nobody opened in a test is still judged:
 *   (a) `app/src/styles/global.css` carries a restore rule `input.field:is(<classes>)` that declares
 *       `font-variant-numeric: tabular-nums` AND `font-feature-settings: 'tnum' 1`.
 *   (b) That rule OUTRANKS every Studio rule whose subject is a `.field` and which states the `font`
 *       shorthand, or `font-variant-numeric` / `font-feature-settings` set to anything but tabular
 *       (a rule that itself asks for tabular figures is no threat): strictly higher specificity, or
 *       equal specificity and later in the same sheet. So no sheet order can take the figures away.
 *   (c) Every `className="..."` literal in a Studio `.tsx` that carries `field` together with a class
 *       the Studio CSS makes tabular (a rule declaring `tabular-nums` whose subject names that class)
 *       names at least one class the restore rule lists. A new money field with a new tabular class
 *       fails here until the restore rule covers it.
 *   (d) Every Studio `<input>` whose className literal carries `field` and which declares
 *       `inputMode="decimal"` (the Studio's mark for an amount it parses) is covered: the restore rule
 *       lists `[inputmode='decimal']`, or the field names a listed class. Twenty-nine decimal fields
 *       with a bare `field` class were proportional before this clause (the C2 money critic, O1).
 *
 * A jsdom test cannot see the cascade, so this reads selector shape and specificity. The browser
 * measurement lives in the round 2 flow; the "bites" tests below prove the scan fails the pre-fix CSS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import ts from 'typescript';
import { cleanGitEnv } from '../lib/git-env.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const GLOBAL_CSS = 'app/src/styles/global.css';
const TOKENS_CSS = 'brand/tokens/tokens.css';

/** @param {string} source */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** @param {string} suffix @returns {string[]} */
function tracked(suffix) {
  return execFileSync('git', ['ls-files', '-z', 'app/src'], { cwd: ROOT, maxBuffer: 1 << 28, env: cleanGitEnv() })
    .toString('utf8')
    .split('\0')
    .filter((f) => f.endsWith(suffix));
}

/** @typedef {{ file: string, selector: string, body: string, offset: number }} StyleRule */

/**
 * Every style rule (selector list, declaration body, offset of the brace), including those inside
 * `@media` / `@supports`. At-rule preludes are not returned.
 * @param {string} file
 * @param {string} source
 * @returns {StyleRule[]}
 */
function rulesOf(file, source) {
  const text = withoutComments(source);
  /** @type {StyleRule[]} */
  const out = [];
  /** @type {{ prelude: string, bodyStart: number, isAt: boolean }[]} */
  const stack = [];
  let preludeStart = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      const prelude = text.slice(preludeStart, i).trim();
      stack.push({ prelude, bodyStart: i + 1, isAt: prelude.startsWith('@') });
      preludeStart = i + 1;
    } else if (ch === '}') {
      const top = stack.pop();
      if (top !== undefined && !top.isAt) out.push({ file, selector: top.prelude, body: text.slice(top.bodyStart, i), offset: top.bodyStart });
      preludeStart = i + 1;
    } else if (ch === ';') {
      preludeStart = i + 1;
    }
  }
  return out;
}

/**
 * Split on `separator` at bracket depth 0 only.
 * @param {string} text @param {(ch: string) => boolean} isSeparator
 * @returns {string[]}
 */
function splitTopLevel(text, isSeparator) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    if (depth === 0 && isSeparator(ch)) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** @param {string} list */
const selectorsOf = (list) => splitTopLevel(list, (ch) => ch === ',');

/** The subject (last) compound of a complex selector. @param {string} selector */
function subjectOf(selector) {
  const compounds = splitTopLevel(selector.replace(/\s*([>+~])\s*/g, ' '), (ch) => /\s/.test(ch));
  return compounds[compounds.length - 1] ?? '';
}

/**
 * Specificity [ids, classes, types] of a complex selector, with `:is/:not/:has` taking their most
 * specific argument and `:where` counting zero (Selectors Level 4).
 * @param {string} selector
 * @returns {[number, number, number]}
 */
function specificity(selector) {
  /** @type {[number, number, number]} */
  const s = [0, 0, 0];
  let i = 0;
  const text = selector;
  /** @param {[number, number, number]} add */
  const plus = (add) => {
    s[0] += add[0];
    s[1] += add[1];
    s[2] += add[2];
  };
  const readParens = () => {
    let depth = 0;
    const start = i;
    for (; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          return text.slice(start + 1, i - 1);
        }
      }
    }
    return text.slice(start + 1);
  };
  while (i < text.length) {
    const ch = text[i] ?? '';
    if (ch === '#') {
      s[0] += 1;
      i += 1;
      while (i < text.length && /[\w-]/.test(text[i] ?? '')) i += 1;
    } else if (ch === '.') {
      s[1] += 1;
      i += 1;
      while (i < text.length && /[\w-]/.test(text[i] ?? '')) i += 1;
    } else if (ch === '[') {
      s[1] += 1;
      while (i < text.length && text[i] !== ']') i += 1;
      i += 1;
    } else if (ch === ':') {
      const element = text[i + 1] === ':';
      i += element ? 2 : 1;
      const start = i;
      while (i < text.length && /[\w-]/.test(text[i] ?? '')) i += 1;
      const name = text.slice(start, i).toLowerCase();
      const args = text[i] === '(' ? readParens() : null;
      if (element) s[2] += 1;
      else if (name === 'where') {
        /* zero */
      } else if (name === 'is' || name === 'not' || name === 'has' || name === 'matches') {
        /** @type {[number, number, number]} */
        let best = [0, 0, 0];
        for (const arg of selectorsOf(args ?? '')) {
          const a = specificity(arg);
          if (compare(a, best) > 0) best = a;
        }
        plus(best);
      } else s[1] += 1;
    } else if (/[a-zA-Z]/.test(ch)) {
      s[2] += 1;
      while (i < text.length && /[\w-]/.test(text[i] ?? '')) i += 1;
    } else i += 1;
  }
  return s;
}

/** @param {number[]} a @param {number[]} b */
function compare(a, b) {
  for (let k = 0; k < 3; k += 1) if ((a[k] ?? 0) !== (b[k] ?? 0)) return (a[k] ?? 0) - (b[k] ?? 0);
  return 0;
}

/** The classes named directly in a compound (not inside a functional pseudo-class). @param {string} compound */
function ownClasses(compound) {
  const flat = compound.replace(/\([^()]*\)/g, '()');
  return [...flat.matchAll(/\.([\w-]+)/g)].map((m) => m[1] ?? '');
}

/** @param {string} body @param {RegExp} prop */
const declares = (body, prop) => body.split(';').some((d) => prop.test(d));

const TABULAR = /^\s*font-variant-numeric\s*:\s*tabular-nums\s*$/;
const TNUM = /^\s*font-feature-settings\s*:\s*['"]tnum['"]\s*(1|on)?\s*$/;
/** A declaration that takes tabular figures away: the `font` shorthand, or either longhand set to anything but tabular. */
const resets = (/** @type {string} */ body) =>
  body.split(';').some((d) => /^\s*font\s*:/.test(d) || (/^\s*font-(variant-numeric|feature-settings)\s*:/.test(d) && !TABULAR.test(d) && !TNUM.test(d)));

/**
 * The restore rule: a selector `input.field:is(...)` that declares tabular figures, with its covered
 * classes, specificity and position.
 * @param {StyleRule[]} globalRules
 */
function restoreRule(globalRules) {
  for (const rule of globalRules) {
    for (const sel of selectorsOf(rule.selector)) {
      const m = /^input\.field:is\(([^()]*)\)$/.exec(sel.replace(/\s+/g, ' ').trim());
      if (m === null) continue;
      if (!declares(rule.body, TABULAR)) continue;
      const classes = selectorsOf(m[1] ?? '').map((c) => c.replace(/^\./, ''));
      return { rule, sel, classes, spec: specificity(sel), tnum: declares(rule.body, TNUM) };
    }
  }
  return null;
}

/**
 * The verdict for a set of sheets: a list of human-readable misses (empty = pass).
 * @param {Map<string, string>} sheets repo-relative path -> source
 * @param {Array<{ file: string, value: string }>} classNames
 * @param {DecimalField[]} decimals the `.field` inputs typed `inputMode="decimal"`
 */
function verdict(sheets, classNames, decimals = []) {
  const misses = [];
  /** @type {StyleRule[]} */
  const all = [];
  for (const [file, src] of sheets) all.push(...rulesOf(file, src));
  const restore = restoreRule(all.filter((r) => r.file === GLOBAL_CSS));
  if (restore === null) return ['(a) global.css has no `input.field:is(...)` rule declaring font-variant-numeric: tabular-nums'];
  if (!restore.tnum) misses.push("(a) the restore rule does not declare font-feature-settings: 'tnum' 1");

  // (b) it outranks every rule on a `.field` subject that resets the numeric variant.
  for (const rule of all) {
    if (rule === restore.rule || !resets(rule.body)) continue;
    for (const sel of selectorsOf(rule.selector)) {
      if (!ownClasses(subjectOf(sel)).includes('field')) continue;
      const c = compare(restore.spec, specificity(sel));
      const later = rule.file === restore.rule.file && restore.rule.offset > rule.offset;
      if (c < 0 || (c === 0 && !later)) {
        misses.push(`(b) ${rule.file} \`${sel}\` [${specificity(sel)}] resets the figures and is not outranked by \`${restore.sel}\` [${restore.spec}]`);
      }
    }
  }

  // (c) every field literal with a tabular class names a class the restore rule covers.
  const tabularClasses = new Set();
  for (const rule of all) {
    if (!declares(rule.body, TABULAR)) continue;
    for (const sel of selectorsOf(rule.selector)) for (const c of ownClasses(subjectOf(sel))) tabularClasses.add(c);
  }
  const covered = new Set(restore.classes);
  for (const { file, value } of classNames) {
    const tokens = value.split(/\s+/).filter(Boolean);
    if (!tokens.includes('field')) continue;
    const tabular = tokens.filter((t) => t !== 'field' && tabularClasses.has(t));
    if (tabular.length > 0 && !tokens.some((t) => covered.has(t))) {
      misses.push(`(c) ${file}: className="${value}" asks for tabular figures via ${tabular.join(', ')}, which \`${restore.sel}\` does not list`);
    }
  }

  // (d) every decimal `.field` input is covered, by the keyboard hint or by a listed class.
  const byHint = restore.classes.some((c) => /^\[inputmode=(['"]?)decimal\1\]$/i.test(c.replace(/\s+/g, '')));
  for (const d of decimals) {
    if (!byHint && !d.classes.some((c) => covered.has(c))) {
      misses.push(`(d) ${d.file}:${d.line}: a decimal field (className="${d.classes.join(' ')}") that \`${restore.sel}\` does not cover`);
    }
  }
  return misses;
}

/** @typedef {{ file: string, line: number, classes: string[] }} DecimalField */

/**
 * Every `<input>` in a Studio `.tsx` with a literal className carrying `field` and a literal
 * `inputMode="decimal"`, read through the TypeScript parser so attribute order and line breaks do not
 * matter.
 * @returns {DecimalField[]}
 */
function decimalFields() {
  /** @type {DecimalField[]} */
  const out = [];
  for (const f of tracked('.tsx')) {
    if (/\.test\.tsx$/.test(f)) continue;
    const sf = ts.createSourceFile(f, readFileSync(join(ROOT, f), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    /** @param {ts.Node} node */
    const visit = (node) => {
      if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(sf) === 'input') {
        /** @type {Record<string, string>} */
        const lit = {};
        for (const a of node.attributes.properties) {
          if (ts.isJsxAttribute(a) && a.initializer !== undefined && ts.isStringLiteral(a.initializer)) lit[a.name.getText(sf)] = a.initializer.text;
        }
        const classes = (lit.className ?? '').split(/\s+/).filter(Boolean);
        if (lit.inputMode === 'decimal' && classes.includes('field')) {
          out.push({ file: f, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, classes });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

function studioSheets() {
  /** @type {Map<string, string>} */
  const sheets = new Map();
  for (const f of [...tracked('.css'), TOKENS_CSS]) sheets.set(f, readFileSync(join(ROOT, f), 'utf8'));
  return sheets;
}

function studioClassNames() {
  const out = [];
  for (const f of tracked('.tsx')) {
    if (/\.test\.tsx$/.test(f)) continue;
    const src = readFileSync(join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/className="([^"]*)"/g)) out.push({ file: f, value: m[1] ?? '' });
  }
  return out;
}

test('every money field keeps tabular figures over the input.field font reset', () => {
  const classNames = studioClassNames();
  assert.ok(
    classNames.some((c) => c.value.split(/\s+/).includes('journal-line-amount')),
    'the scan found no Soll/Haben field, so it is reading the wrong files',
  );
  const decimals = decimalFields();
  assert.ok(decimals.length >= 30, `only ${decimals.length} decimal .field inputs found; the scan is reading the wrong files`);
  assert.deepEqual(verdict(studioSheets(), classNames, decimals), []);
});

test('the guard bites: the restore rule without the decimal hint fails (d) on the bare decimal fields', () => {
  const sheets = studioSheets();
  const src = sheets.get(GLOBAL_CSS) ?? '';
  const stripped = src.replace(/,\s*\[inputmode='decimal'\]/, '');
  assert.notEqual(stripped, src, 'could not locate the decimal hint in the restore rule');
  sheets.set(GLOBAL_CSS, stripped);
  const misses = verdict(sheets, studioClassNames(), decimalFields());
  assert.ok(misses.length >= 25, `only ${misses.length} misses without the hint`);
  assert.ok(misses.every((m) => m.startsWith('(d) ')), misses.join('\n'));
  // A decimal field that names a listed class stays covered without the hint.
  assert.deepEqual(verdict(sheets, [], [{ file: 'app/src/X.tsx', line: 1, classes: ['field', 't-num'] }]), []);
});

test('the guard bites: global.css without the restore rule fails', () => {
  const sheets = studioSheets();
  const src = sheets.get(GLOBAL_CSS) ?? '';
  const stripped = src.replace(/input\.field:is\([^)]*\)\s*\{[^}]*\}/g, '');
  assert.notEqual(stripped, src, 'could not locate the restore rule to strip');
  sheets.set(GLOBAL_CSS, stripped);
  assert.ok(verdict(sheets, studioClassNames()).length > 0, 'the pre-fix CSS passed the guard');
});

test('the guard bites: a same-specificity restore placed BEFORE a later .field font reset fails (b)', () => {
  const sheets = new Map([
    [GLOBAL_CSS, "input.field:is(.t-num) { font-variant-numeric: tabular-nums; font-feature-settings: 'tnum' 1; }\ninput.field.t-num { font: inherit; }"],
  ]);
  const misses = verdict(sheets, []);
  assert.equal(misses.length, 1, misses.join('\n'));
  assert.match(misses[0] ?? '', /^\(b\)/);
});

test('the guard bites: a field with a tabular class the restore rule does not list fails (c)', () => {
  const sheets = new Map([
    [GLOBAL_CSS, "input.field { font: inherit; }\ninput.field:is(.t-num) { font-variant-numeric: tabular-nums; font-feature-settings: 'tnum' 1; }"],
    ['app/src/x.css', '.new-amount { font-variant-numeric: tabular-nums; }'],
  ]);
  const misses = verdict(sheets, [{ file: 'app/src/X.tsx', value: 'field new-amount' }]);
  assert.equal(misses.length, 1, misses.join('\n'));
  assert.match(misses[0] ?? '', /^\(c\)/);
  assert.deepEqual(verdict(sheets, [{ file: 'app/src/X.tsx', value: 'field new-amount t-num' }]), []);
});

test('specificity reads :is as its most specific argument and :where as zero', () => {
  assert.deepEqual(specificity('input.field'), [0, 1, 1]);
  assert.deepEqual(specificity('input.field:is(.t-num, .t-money)'), [0, 2, 1]);
  assert.deepEqual(specificity(':where(button, input) .x'), [0, 1, 0]);
  assert.deepEqual(specificity('input.field:hover:not(:disabled)'), [0, 3, 1]);
});
