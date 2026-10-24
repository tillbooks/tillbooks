// @ts-check
/**
 * NO NEW RAW GLYPHS: AN ICON-ONLY CONTROL IS AN `IconButton`, AND EVERY GLYPH LIVES IN ONE MODULE
 * (Ruhig 3, D154, the D-step; DESIGN.md "Icon vocabulary").
 *
 * The D154 audit counted 96 glyph components in 16 files, 20 more files drawing their own inline SVG,
 * and 283 icon-only buttons of which 22 named themselves on hover or focus. The D-step builds the
 * system once (`app/src/components/icons`, `IconButton`); the E-step migrates the surfaces cluster by
 * cluster. Until then this guard holds the line, so the migration only ever shrinks the problem:
 *
 *  1. **No new glyph source.** An `<svg>` JSX element may appear in `app/src/components/icons/` and,
 *     for now, only where the FROZEN_SVG baseline says, as an exact count per file. No new
 *     `glyphs.tsx` file may appear anywhere. A file that adds an `<svg>` reds; a file that loses one
 *     reds too until its baseline is lowered in the same commit, so the ratchet never goes slack.
 *  2. **No new icon-only `<button>`.** A native `<button>` whose children carry a glyph (an `<svg>` or
 *     a `*Glyph` or `*Icon` component) and no text is an icon-only control and must be an `IconButton`, which
 *     forces a vocabulary icon, its accessible name and a tooltip on hover, focus and long press. The
 *     ones that exist are frozen per file in FROZEN_ICON_ONLY_BUTTONS, as an exact count.
 *  3. **A money commit keeps its word** (D154 rule 2). An element carrying `data-money-commit` (the
 *     accent guard's contract) must contain visible text. No baseline: this already holds.
 *  4. **The vocabulary stays closed.** `icons/vocabulary.tsx` holds exactly the twenty-two names DESIGN.md
 *     lists (D154's twelve, D177's five, D180's five), and no money commit or destructive act is among them, so
 *     `IconButton` cannot draw one. The one exception is Ignorieren, by the owner's ruling (D177 point 5):
 *     a bank line's ignore is undone in one click, so it may be a glyph at the row's right edge.
 *  5. **No frosted glass** (DESIGN.md's forbidden list, D154 lost option): no `backdrop-filter` in a
 *     Studio stylesheet or inline style.
 *
 * "Text" is decided conservatively: a non-blank JSX text, or any `{expression}` that is not itself
 * JSX (a variable, a call, a template), counts as text, so a button labelled from a variable is never
 * mistaken for an icon-only one. The parse is TypeScript's own, so a multi-line attribute or an arrow
 * function in a prop cannot hide a button from it.
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
const ICON_MODULE = 'app/src/components/icons/';
/**
 * The chart primitive (D178, brand/DESIGN.md Dependencies): a chart's `<svg>` is data ink, not a glyph,
 * and every chart draws through this one module, so it is exempt from the icon ratchet like the icon
 * module itself. A chart drawn anywhere else still counts against the baseline.
 */
const CHART_MODULE = 'app/src/components/charts/';
const VOCABULARY_FILE = 'app/src/components/icons/vocabulary.tsx';
/** The primitive itself: the one native icon-only `<button>` that is allowed by definition. */
const ICON_BUTTON_FILE = 'app/src/components/IconButton.tsx';
const DESIGN_FILE = 'brand/DESIGN.md';

/**
 * The twelve names of D154 rule 1, the five of D177 and the five of D180 (the Übersicht's edit mode,
 * owner 24.10.2026), in DESIGN.md's order.
 */
const VOCABULARY_NAMES = [
  'Bearbeiten',
  'Anhängen',
  'Kommentieren',
  'Markieren',
  'Kopieren',
  'Herunterladen',
  'Öffnen',
  'Suchen',
  'Filter',
  'Mehr',
  'Schliessen',
  'Info',
  'Aufteilen',
  'Abgleichen',
  'Als Regel speichern',
  'Ignorieren',
  'Position entfernen',
  'Anpassen',
  'Fertig',
  'Ausblenden',
  'Einblenden',
  'Grösse ändern',
];

/** D177 point 5: the one destructive act the owner ruled may be a glyph (it is undone in one click). */
const RULED_GLYPH_ACTS = new Set(['Ignorieren']);

/**
 * Acts that never become a glyph alone: the money commits (rule 2: Buchen, Ausstellen, Zahlung buchen,
 * Periode sperren) and the destructive acts D154 sends under Mehr (Stornieren, Löschen, Ignorieren).
 * A German action label ends in its verb ("Zeile löschen", "Zahlung buchen"), so the verb is matched
 * at the end: "Wann du sperren kannst" is an Info, not a commit. Removing a line from a draft
 * ("Position entfernen") is editing, not a destructive act, and is not listed.
 */
const NEVER_A_GLYPH = /(^|\s)(buchen|ausstellen|sperren|stornieren|löschen|loeschen|ignorieren|zahlen)$/i;

/**
 * THE GLYPH-SOURCE BASELINE, measured 14.10.2026 on develop 81549f34 when the D-step landed: `<svg>`
 * JSX elements per file outside `components/icons/`. The fourteen `glyphs.tsx` files and the inline
 * SVGs stay until their cluster migrates in the E-step; the agent that migrates a file lowers or
 * deletes its line in the same commit. Never raise a number and never add a file.
 *
 * @type {Readonly<Record<string, number>>}
 */
const FROZEN_SVG = Object.freeze({
  'app/src/app/RailStatusMenu.tsx': 1,
  'app/src/app/Shell.tsx': 2,
  'app/src/app/identity.tsx': 1,
  // D178 (N6): the rail's glyphs became one frame with a table of shapes (32 frames to 1); the lane's
  // and the tree's inline glyphs moved into it, so FavouritesRail and NavTree draw none of their own.
  'app/src/app/nav-icons.tsx': 1,
  'app/src/components/DensityToggle.tsx': 2,
  'app/src/components/WorkspaceSwitcher.tsx': 1,
  'app/src/components/states/glyphs.tsx': 5,
  'app/src/surfaces/Agent/Agent.tsx': 2,
  'app/src/surfaces/Attention/Attention.tsx': 1,
  // 24 after D167's source glyph pair; 20 since D177 moved Aufteilen, Abgleichen and Ignorieren into the
  // vocabulary and retired the split editor's remove glyph.
  'app/src/surfaces/Bank/glyphs.tsx': 20,
  'app/src/surfaces/Checklists/RunDetail.tsx': 1,
  'app/src/surfaces/Contacts/glyphs.tsx': 10,
  'app/src/surfaces/Correspondence/Correspondence.tsx': 1,
  'app/src/surfaces/Files/SignSection.tsx': 1,
  'app/src/surfaces/Files/glyphs.tsx': 9,
  'app/src/surfaces/Fx/glyphs.tsx': 2,
  'app/src/surfaces/Items/glyphs.tsx': 1,
  'app/src/surfaces/Journal/ArchiveTab.tsx': 1,
  'app/src/surfaces/Journal/Journal.tsx': 1,
  'app/src/surfaces/Journal/glyphs.tsx': 3,
  'app/src/surfaces/Migration/TestmandantPanel.tsx': 1,
  'app/src/surfaces/Onboarding/DemoBanner.tsx': 1,
  'app/src/surfaces/OpenItems/glyphs.tsx': 4,
  'app/src/surfaces/Operations/Diagnostics.tsx': 1,
  'app/src/surfaces/Operations/Trust.tsx': 1,
  'app/src/surfaces/Periods/glyphs.tsx': 5,
  'app/src/surfaces/Reports/glyphs.tsx': 3,
  'app/src/surfaces/Review/glyphs.tsx': 5,
  'app/src/surfaces/Setup/glyphs.tsx': 2,
  'app/src/surfaces/Uebersicht/BankBand.tsx': 4,
  'app/src/surfaces/VatReturn/glyphs.tsx': 5,
  'app/src/surfaces/VatSettings/glyphs.tsx': 1,
});

/**
 * THE ICON-ONLY `<button>` BASELINE, measured with FROZEN_SVG: native buttons per file whose only
 * content is a glyph. Each becomes an `IconButton` (or gains its word) in the E-step; lower the count
 * in the same commit.
 *
 * @type {Readonly<Record<string, number>>}
 */
const FROZEN_ICON_ONLY_BUTTONS = Object.freeze({
  // D178 (N6): move up, move down and rename moved under the row's Mehr menu; the unpin star stays.
  'app/src/app/FavouritesRail.tsx': 1,
  'app/src/app/Shell.tsx': 2,
  // D167 (5ab668a9): the clearable PickerButton's 44px clear control; measured at the undo integration.
  'app/src/components/AccountCombobox.tsx': 1,
  'app/src/components/ConsequenceLine.tsx': 1,
  'app/src/components/DensityToggle.tsx': 1,
  'app/src/components/DetailDrawer.tsx': 1,
  'app/src/components/Modal.tsx': 1,
  'app/src/components/OverflowMenu.tsx': 1,
  'app/src/components/ThemeToggle.tsx': 1,
  'app/src/surfaces/Agent/Agent.tsx': 2,
  // D167 (3864f0c2): the consequence tooltip trigger on the Vorschlag line; measured at the undo integration.
  'app/src/surfaces/Agent/VorschlagLine.tsx': 1,
  'app/src/surfaces/Attention/Attention.tsx': 1,
  'app/src/surfaces/Bank/InfoCard.tsx': 1,
  'app/src/surfaces/Bills/BillEditor.tsx': 1,
  'app/src/surfaces/Bills/Bills.tsx': 1,
  'app/src/surfaces/Contacts/ContactEditor.tsx': 1,
  'app/src/surfaces/Deals/Deals.tsx': 1,
  'app/src/surfaces/Dispatch/Dispatch.tsx': 1,
  'app/src/surfaces/Documents/DocumentEditor.tsx': 1,
  'app/src/surfaces/Documents/EditorInfo.tsx': 1,
  'app/src/surfaces/Inventory/Inventory.tsx': 1,
  'app/src/surfaces/Journal/ComposerParts.tsx': 2,
  'app/src/surfaces/OpenItems/ReconciliationBand.tsx': 2,
  'app/src/surfaces/Operations/HostingJourney.tsx': 1,
  'app/src/surfaces/Operations/SyncHosting.tsx': 1,
  'app/src/surfaces/Operations/Trust.tsx': 1,
  'app/src/surfaces/Payments/PaymentAllocator.tsx': 1,
  'app/src/surfaces/Periods/AccrualEditor.tsx': 1,
  'app/src/surfaces/Purchasing/Purchasing.tsx': 1,
  'app/src/surfaces/Quotes/Quotes.tsx': 1,
  'app/src/surfaces/Reports/TrialBalance.tsx': 1,
  'app/src/surfaces/Review/CoverageBar.tsx': 1,
  'app/src/surfaces/Review/Review.tsx': 3,
  'app/src/surfaces/SalesOrders/SalesOrders.tsx': 1,
  'app/src/surfaces/Setup/CompanyProfile.tsx': 2,
  'app/src/surfaces/Uebersicht/BankBand.tsx': 1,
  'app/src/surfaces/VatReturn/Abstimmung.tsx': 2,
  'app/src/surfaces/VatReturn/JourneyLine.tsx': 2,
  'app/src/surfaces/VatReturn/VatReturn.tsx': 1,
  'app/src/surfaces/VatSettings/VatSettings.tsx': 1,
});

/** The `glyphs.tsx` files that may exist; none may be added. Derived from FROZEN_SVG. */
const FROZEN_GLYPH_FILES = Object.keys(FROZEN_SVG).filter((f) => f.endsWith('/glyphs.tsx'));

/** @returns {string[]} every Studio source path, tracked or new (a new file must not slip past). */
function studioFiles() {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'app/src'], {
    cwd: ROOT,
    maxBuffer: 1 << 28,
    env: cleanGitEnv(),
  })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((f, i, all) => all.indexOf(f) === i);
}

/** @returns {Array<{ file: string, sf: ts.SourceFile }>} the parsed `.tsx` sources, tests excluded. */
export function parsedSources() {
  return studioFiles()
    .filter((f) => f.endsWith('.tsx') && !/\.test\.tsx$/.test(f))
    .map((file) => ({
      file,
      sf: ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
    }));
}

/** @param {ts.JsxOpeningLikeElement | ts.JsxElement} el */
function tagName(el) {
  const opening = ts.isJsxElement(el) ? el.openingElement : el;
  return opening.tagName.getText();
}

/**
 * A glyph: an `<svg>`, or a component named as one. The Studio names its glyph components `*Glyph`
 * and a few rail and band icons `*Icon` (`MoveUpIcon`, `RefreshIcon`); both count (critic F2).
 *
 * @param {string} name
 */
const isGlyphTag = (name) => name === 'svg' || /(Glyph|Icon)$/.test(name);

/**
 * Walks JSX children. Returns whether any may render text, and records whether a glyph was seen.
 *
 * @param {readonly ts.Node[]} children
 * @param {{ glyph: boolean }} seen
 * @returns {boolean}
 */
function childrenMayHaveText(children, seen) {
  for (const child of children) if (nodeMayHaveText(child, seen)) return true;
  return false;
}

/**
 * @param {ts.Node} node
 * @param {{ glyph: boolean }} seen
 * @returns {boolean}
 */
function nodeMayHaveText(node, seen) {
  if (ts.isJsxText(node)) return node.text.trim() !== '';
  if (ts.isJsxSelfClosingElement(node)) {
    if (isGlyphTag(tagName(node))) seen.glyph = true;
    // A self-closing component other than a glyph may render anything: count it as text.
    return !isGlyphTag(tagName(node));
  }
  if (ts.isJsxElement(node)) {
    if (isGlyphTag(tagName(node))) {
      seen.glyph = true;
      return false;
    }
    return childrenMayHaveText(node.children, seen);
  }
  if (ts.isJsxFragment(node)) return childrenMayHaveText(node.children, seen);
  if (ts.isJsxExpression(node)) {
    if (node.expression === undefined) return false; // a {/* comment */}
    return expressionMayHaveText(node.expression, seen);
  }
  return true;
}

/**
 * Only JSX, or a conditional or `&&` choosing between JSX, is inspected; anything else may be text.
 *
 * @param {ts.Expression} expr
 * @param {{ glyph: boolean }} seen
 * @returns {boolean}
 */
function expressionMayHaveText(expr, seen) {
  if (ts.isParenthesizedExpression(expr)) return expressionMayHaveText(expr.expression, seen);
  if (ts.isJsxElement(expr) || ts.isJsxSelfClosingElement(expr) || ts.isJsxFragment(expr)) return nodeMayHaveText(expr, seen);
  if (ts.isConditionalExpression(expr)) {
    return expressionMayHaveText(expr.whenTrue, seen) || expressionMayHaveText(expr.whenFalse, seen);
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return expressionMayHaveText(expr.right, seen);
  }
  if (expr.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(expr) && expr.text === 'undefined')) return false;
  return true;
}

/**
 * @param {ts.SourceFile} sf
 * @param {(node: ts.Node) => void} visit
 */
function walk(sf, visit) {
  /** @param {ts.Node} node */
  const go = (node) => {
    visit(node);
    ts.forEachChild(node, go);
  };
  go(sf);
}

/** @param {ts.SourceFile} sf @returns {number} the `<svg>` JSX elements in the file. */
export function svgCount(sf) {
  let n = 0;
  walk(sf, (node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && tagName(node) === 'svg') n += 1;
  });
  return n;
}

/**
 * @param {ts.SourceFile} sf
 * @returns {Array<{ line: number, label: string | null }>} the native `<button>`s whose only content is a glyph.
 */
export function iconOnlyButtons(sf) {
  /** @type {Array<{ line: number, label: string | null }>} */
  const hits = [];
  walk(sf, (node) => {
    if (!ts.isJsxElement(node) || tagName(node) !== 'button') return;
    const seen = { glyph: false };
    if (childrenMayHaveText(node.children, seen) || !seen.glyph) return;
    hits.push({ line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, label: attrText(node.openingElement, 'aria-label') });
  });
  return hits;
}

/** @type {Map<string, unknown>} */
const catalogues = new Map();

/** @param {string} path @returns {unknown} the parsed catalogue, or null when the file is absent. */
function catalogue(path) {
  if (!catalogues.has(path)) {
    let tree = null;
    try {
      tree = JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
    } catch {
      tree = null;
    }
    catalogues.set(path, tree);
  }
  return catalogues.get(path);
}

/**
 * The de-CH words for `key` as `t()` would resolve them from `file`: its surface's
 * `messages.de-CH.json` first, then `app/src/i18n/de-CH.json`. Null when neither has the key.
 *
 * @param {string} file
 * @param {string} key
 * @returns {string | null}
 */
function catalogueText(file, key) {
  const surface = /^app\/src\/surfaces\/[^/]+\//.exec(file)?.[0];
  for (const path of [surface ? `${surface}messages.de-CH.json` : null, 'app/src/i18n/de-CH.json']) {
    if (path === null) continue;
    /** @type {unknown} */
    let node = catalogue(path);
    for (const part of key.split('.')) node = node !== null && typeof node === 'object' ? /** @type {Record<string, unknown>} */ (node)[part] : undefined;
    if (typeof node === 'string') return node;
  }
  return null;
}

/**
 * @param {ts.JsxOpeningLikeElement} opening
 * @param {string} name
 * @returns {string | null} a literal attribute's value (a template's literal parts), or null.
 */
function attrText(opening, name) {
  for (const prop of opening.attributes.properties) {
    if (!ts.isJsxAttribute(prop) || prop.name.getText() !== name || prop.initializer === undefined) continue;
    if (ts.isStringLiteral(prop.initializer)) return prop.initializer.text;
    const expr = ts.isJsxExpression(prop.initializer) ? prop.initializer.expression : undefined;
    if (expr && ts.isStringLiteralLike(expr)) return expr.text;
    // A template: its literal parts, so `Zeile ${n} löschen` still reads as "Zeile … löschen".
    if (expr && ts.isTemplateExpression(expr)) return [expr.head.text, ...expr.templateSpans.map((s) => s.literal.text)].join(' … ');
    // `t('key')`: the German catalogue's words, the surface's own messages before the global ones.
    if (expr && ts.isCallExpression(expr) && expr.expression.getText() === 't') {
      const key = expr.arguments[0];
      if (key && ts.isStringLiteralLike(key)) return catalogueText(opening.getSourceFile().fileName, key.text);
    }
    return null;
  }
  return null;
}

/**
 * @param {ts.JsxOpeningLikeElement} opening
 * @param {string} name
 */
function hasAttr(opening, name) {
  return opening.attributes.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText() === name);
}

/** @param {Record<string, number>} actual @param {Readonly<Record<string, number>>} frozen @param {string} what */
function ratchet(actual, frozen, what) {
  const problems = [];
  for (const [file, n] of Object.entries(actual)) {
    const allowed = frozen[file] ?? 0;
    if (n > allowed) problems.push(`${file}: ${n} ${what}, the baseline allows ${allowed}. Use the shared icon module and IconButton instead.`);
    if (n < allowed) problems.push(`${file}: ${n} ${what}, below its baseline of ${allowed}. Lower the baseline to ${n} in this commit.`);
  }
  for (const [file, allowed] of Object.entries(frozen)) {
    if (!(file in actual)) problems.push(`${file}: 0 ${what} (or the file is gone), baseline ${allowed}. Delete its baseline line in this commit.`);
  }
  return problems;
}

test('rule 1: an <svg> appears only in the shared icon module, or where the frozen baseline says', () => {
  /** @type {Record<string, number>} */
  const actual = {};
  for (const { file, sf } of parsedSources()) {
    if (file.startsWith(ICON_MODULE) || file.startsWith(CHART_MODULE)) continue;
    const n = svgCount(sf);
    if (n > 0) actual[file] = n;
  }
  const problems = ratchet(actual, FROZEN_SVG, '<svg> element(s)');
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('rule 1: no new glyphs.tsx file appears; the frozen ones only go away', () => {
  const glyphFiles = studioFiles().filter((f) => /(^|\/)glyphs\.tsx$/.test(f));
  const added = glyphFiles.filter((f) => !FROZEN_GLYPH_FILES.includes(f));
  assert.deepEqual(added, [], `new glyphs.tsx file(s): ${added.join(', ')}. Add the glyph to app/src/components/icons instead.`);
});

test('rule 2: a native icon-only <button> is not added; IconButton is the one icon-only control', () => {
  /** @type {Record<string, number>} */
  const actual = {};
  for (const { file, sf } of parsedSources()) {
    if (file === ICON_BUTTON_FILE) continue;
    const n = iconOnlyButtons(sf).length;
    if (n > 0) actual[file] = n;
  }
  const problems = ratchet(actual, FROZEN_ICON_ONLY_BUTTONS, 'icon-only <button>(s)');
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('rule 3: an element that commits money (data-money-commit) carries visible text', () => {
  const problems = [];
  for (const { file, sf } of parsedSources()) {
    walk(sf, (node) => {
      if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return;
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      if (!hasAttr(opening, 'data-money-commit')) return;
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      if (ts.isJsxSelfClosingElement(node)) {
        problems.push(`${file}:${line}: a money commit with no children shows no word`);
        return;
      }
      if (!childrenMayHaveText(node.children, { glyph: false })) problems.push(`${file}:${line}: a money commit with only a glyph`);
    });
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('rule 3: no icon-only control is named after a money commit or a destructive act', () => {
  const problems = [];
  for (const { file, sf } of parsedSources()) {
    for (const hit of iconOnlyButtons(sf)) {
      if (hit.label !== null && NEVER_A_GLYPH.test(hit.label)) problems.push(`${file}:${hit.line}: "${hit.label}" is a glyph alone`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('rule 4: the vocabulary holds exactly the names of D154, D177 and D180, and DESIGN.md lists them', () => {
  const source = readFileSync(join(ROOT, VOCABULARY_FILE), 'utf8');
  const names = [...source.matchAll(/^\s+\w+: \{ name: '([^']+)', glyph: \w+ \},$/gm)].map((m) => m[1]);
  assert.deepEqual(names, VOCABULARY_NAMES, `${VOCABULARY_FILE} must list exactly the D154 vocabulary, in order`);
  for (const name of names) {
    if (RULED_GLYPH_ACTS.has(name ?? '')) continue;
    assert.doesNotMatch(name ?? '', NEVER_A_GLYPH, `${name} may never be a glyph alone`);
  }
  const design = readFileSync(join(ROOT, DESIGN_FILE), 'utf8');
  const section = design.slice(design.indexOf('### Icon vocabulary'));
  assert.ok(design.includes('### Icon vocabulary'), `${DESIGN_FILE} must carry the "Icon vocabulary" section`);
  for (const name of VOCABULARY_NAMES) assert.ok(section.includes(name), `${DESIGN_FILE} "Icon vocabulary" must name ${name}`);
});

test('rule 5: no frosted glass (backdrop-filter) anywhere in the Studio', () => {
  const hits = studioFiles()
    .filter((f) => /\.(css|tsx?)$/.test(f))
    .filter((f) => /backdrop-?filter/i.test(readFileSync(join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')));
  assert.deepEqual(hits, [], `frosted glass is on DESIGN.md's forbidden list: ${hits.join(', ')}`);
});

// --- the guard bites: synthetic sources, parsed the same way -------------------------------------

/** @param {string} code */
const parse = (code) => ts.createSourceFile('probe.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

test('the detector: a glyph-only button is caught, a worded or variable-labelled one is not', () => {
  const caught = parse(`export const A = () => (<>
    <button type="button" aria-label="Löschen" onClick={() => go(a > b)}><TrashGlyph size={16} /></button>
    <button type="button" aria-label="X"><svg viewBox="0 0 24 24"><path d="M0 0" /></svg></button>
    <button type="button" aria-label="Y">{open ? <ChevronDownGlyph /> : <ChevronRightGlyph />}</button>
    <button type="button" aria-label="Z">{busy && <SpinnerGlyph />}{/* note */}</button>
  </>);`);
  const hits = iconOnlyButtons(caught);
  assert.equal(hits.length, 4, JSON.stringify(hits));
  assert.equal(hits[0]?.label, 'Löschen');
  assert.match(hits[0]?.label ?? '', NEVER_A_GLYPH);

  const clean = parse(`export const B = () => (<>
    <button type="button"><PlusGlyph /> Zeile</button>
    <button type="button"><PlusGlyph />{label}</button>
    <button type="button"><PlusGlyph /><span>Neu</span></button>
    <button type="button"><Badge count={n} /><PlusGlyph /></button>
    <button type="button">Buchen</button>
    <IconButton icon="close" context="Ohne Buchen" />
  </>);`);
  assert.deepEqual(iconOnlyButtons(clean), []);
  assert.equal(svgCount(caught), 1);
});

test('the ratchet reds on a rise, on a fall without a lowered baseline, and on a vanished file', () => {
  assert.equal(ratchet({ a: 2 }, { a: 2 }, 'x').length, 0);
  assert.match(ratchet({ a: 3 }, { a: 2 }, 'x')[0] ?? '', /baseline allows 2/);
  assert.match(ratchet({ a: 1 }, { a: 2 }, 'x')[0] ?? '', /Lower the baseline to 1/);
  assert.match(ratchet({ b: 1 }, {}, 'x')[0] ?? '', /baseline allows 0/);
  assert.match(ratchet({}, { a: 2 }, 'x')[0] ?? '', /Delete its baseline line/);
});
