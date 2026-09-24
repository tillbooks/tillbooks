// @ts-check
/**
 * THE TINTED `.btn--accent` COMMITS A POSTING VERB, AND NOTHING ELSE (K-08, D137; the C2 money critic,
 * F2, F5 and F6).
 *
 * DESIGN.md: the accent button "has exactly one role: the commit of a money write (Buchen, Zahlen,
 * Ausstellen), always followed by the C4 confirmation; never a header action and never an export".
 *
 * WHY THIS IS A PER-BUTTON CONTRACT AND NOT A LIST OF FILES. Two rounds of this guard kept a
 * hand-written allow-list of files that could carry an accent, each with a sentence naming the money
 * write it committed. The C2 re-check (F5) measured four of those sentences against the engine and
 * found them false: a credit-note dialog that only creates a draft, an issue confirm for quotes, a
 * report-only valuation run and two stocktake commits with no ledger reach, seven buttons in all. The
 * sentences were prose, so nothing could hold them to the engine. And the list was per FILE (F6), so a
 * listed file could swap a legitimate accent for an illegitimate one unseen, and a class string that
 * did not START with `btn` was invisible to it.
 *
 * THE CONTRACT NOW:
 *
 *  1. The posting verbs come FROM THE ENGINE. `DIAL_CAPABILITY_FOR_ACTION` in
 *     `src/core/agent/dialMap.ts` is the closed map of governed verbs, and its `post` capability is
 *     declared there as "every verb that mints a journal entry". Those verbs are read out of the
 *     source with the TypeScript parser, not restated here.
 *  2. The few posting verbs the dial map files under another capability (`issue`, `pay`, `dun`) or
 *     leaves ungoverned are PROVEN, not asserted: each carries the engine file, line and enclosing
 *     function where it reaches `postEntry` (or `reverseEntry`), hop by hop, and the test reads each
 *     cited line and checks it really is that call inside that function. The list cannot drift into
 *     fiction: a stale line, a renamed function or a call that moved reds the suite.
 *  3. EVERY `btn--accent` token in a Studio source, outside comments and whatever the string shape,
 *     must be the class of a JSX element that declares the verb it commits in
 *     `data-money-commit="<verb> [<verb>...]"`, and every named verb must be a posting verb that the
 *     surface's own directory really calls. A conditional accent, `cond ? 'btn btn--accent' : '...'`,
 *     is allowed only with `data-money-commit={cond ? '<verb>' : undefined}` on the SAME condition,
 *     so the tint and the claim switch together on the one fact. Anything the guard cannot attribute
 *     (a join, a concatenation, a class built in a variable, a `btn--${...}` template) is refused.
 *  4. The reverse holds too: a `data-money-commit` on an element that is not tinted is refused, so
 *     the attribute is present exactly where the accent is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import ts from 'typescript';
import { cleanGitEnv } from '../lib/git-env.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIAL_MAP = 'src/core/agent/dialMap.ts';
const ATTR = 'data-money-commit';

/**
 * A posting verb the dial map does not file under `post`, with the proof that it posts: the chain of
 * calls from the verb's engine function down to the single posting path. Each hop is a cited line in
 * `src/`, the function that line sits in, and the call on that line. The last hop calls `postEntry`
 * or `reverseEntry`; every earlier hop calls the function the next hop sits in.
 *
 * @typedef {{ at: string, fn: string, calls: string }} Hop
 * @typedef {{ verb: string, why: string, hops: Hop[] }} ProvenPostingVerb
 */

/** @type {readonly ProvenPostingVerb[]} */
export const PROVEN_POSTING_VERBS = [
  {
    verb: 'issue_invoice',
    why: 'the A10 onIssue delegate posts the balanced VAT entry when the invoice issues',
    hops: [{ at: 'src/core/sales/invoice.ts:263', fn: 'buildInvoicePosting', calls: 'postEntry' }],
  },
  {
    verb: 'issue_credit_note',
    why: 'the A13 onIssue delegate posts the mirror entry when the credit note issues',
    hops: [{ at: 'src/core/sales/creditNote.ts:939', fn: 'buildCreditNotePosting', calls: 'postEntry' }],
  },
  {
    verb: 'set_bank_opening_balance',
    why: 'posts the bank opening balance against 9100 as one balanced entry',
    hops: [{ at: 'src/core/banking/bankAccounts.ts:521', fn: 'setBankOpeningBalance', calls: 'postEntry' }],
  },
  {
    verb: 'mark_batch_paid',
    why: 'books one outgoing payment per item through A14 recordPayment',
    hops: [
      { at: 'src/core/banking/pain001.ts:1074', fn: 'markBatchPaid', calls: 'recordPayment' },
      { at: 'src/core/payments/payment.ts:2000', fn: 'recordPayment', calls: 'postEntry' },
    ],
  },
  {
    verb: 'issue_dunning_run',
    why: 'books the Mahngebühr of each fee-bearing item at issue (and on the C8 recovery)',
    hops: [{ at: 'src/core/dunning/run.ts:747', fn: 'issueUnit', calls: 'postEntry' }],
  },
  {
    verb: 'asset_opening_balance',
    why: 'posts the opening cost and accumulated depreciation of a migrated asset',
    hops: [{ at: 'src/core/assets/ledger.ts:495', fn: 'assetOpeningBalance', calls: 'postEntry' }],
  },
];

/** Verbs the C2 money critic measured as booking nothing. Pinned so none of them creeps back in. */
const KNOWN_NON_POSTING = ['create_credit_note', 'stock_run_valuation', 'stock_stocktake_commit', 'inventory_stocktake_commit', 'transition_document', 'convert_document'];

/** The one posting path: every journal entry the engine mints goes through one of these two. */
const POSTING_PATH = new Set(['postEntry', 'reverseEntry']);

/** @param {string} rel @returns {ts.SourceFile} */
function parse(rel, source = readFileSync(join(ROOT, rel), 'utf8')) {
  return ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/**
 * The verbs the engine itself declares as minting a journal entry: the `post` capability of the
 * closed dial map, read from its source with the TypeScript parser.
 * @returns {Set<string>}
 */
function engineDeclaredPostingVerbs() {
  const sf = parse(DIAL_MAP);
  /** @type {Set<string>} */
  const verbs = new Set();
  let found = false;
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'DIAL_CAPABILITY_FOR_ACTION' &&
      node.initializer !== undefined &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      found = true;
      for (const prop of node.initializer.properties) {
        if (!ts.isPropertyAssignment(prop)) throw new Error(`${DIAL_MAP}: a non-literal entry in DIAL_CAPABILITY_FOR_ACTION; teach this guard to read it`);
        const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
        if (key === null || !ts.isStringLiteral(prop.initializer)) throw new Error(`${DIAL_MAP}: an entry this guard cannot read: ${prop.getText(sf)}`);
        if (prop.initializer.text === 'post') verbs.add(key);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!found) throw new Error(`${DIAL_MAP} no longer declares DIAL_CAPABILITY_FOR_ACTION as an object literal`);
  return verbs;
}

/** @returns {Set<string>} every posting verb: the engine's own `post` set plus the proven ones */
function postingVerbs() {
  const verbs = engineDeclaredPostingVerbs();
  for (const p of PROVEN_POSTING_VERBS) verbs.add(p.verb);
  return verbs;
}

/**
 * The nearest named function declaration around a position (arrow callbacks inside it do not count).
 * @param {ts.SourceFile} sf @param {number} pos @returns {string | null}
 */
function enclosingFunctionName(sf, pos) {
  /** @type {string | null} */
  let name = null;
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (pos < node.getStart(sf) || pos >= node.getEnd()) return;
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name !== undefined && ts.isIdentifier(node.name)) name = node.name.text;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return name;
}

/**
 * Check one proven verb against the engine source. Returns the list of what does not hold.
 * @param {ProvenPostingVerb} proof @param {(rel: string) => string} read @returns {string[]}
 */
function checkProof(proof, read) {
  const misses = [];
  if (proof.hops.length === 0) misses.push(`${proof.verb}: no hop cited`);
  proof.hops.forEach((hop, i) => {
    const [file, lineText] = hop.at.split(':');
    const lineNo = Number(lineText);
    if (file === undefined || !file.startsWith('src/') || !Number.isInteger(lineNo)) {
      misses.push(`${proof.verb}: hop ${i + 1} cites '${hop.at}', not a src/ file:line`);
      return;
    }
    const source = read(file);
    const lines = source.split('\n');
    const line = lines[lineNo - 1] ?? '';
    const call = new RegExp(`\\b${hop.calls}\\(`);
    const sf = parse(file, source);
    const pos = lines.slice(0, lineNo - 1).reduce((n, l) => n + l.length + 1, 0) + line.search(/\S|$/);
    const trimmed = line.trim();
    if (!call.test(line) || trimmed.startsWith('//') || trimmed.startsWith('*')) {
      // Say where the call went, so a moved line is re-cited rather than guessed.
      const hint = lines.findIndex((l, j) => call.test(l) && !/^\s*(\/\/|\*)/.test(l) && enclosingFunctionName(sf, lines.slice(0, j).reduce((n, x) => n + x.length + 1, 0) + l.search(/\S|$/)) === hop.fn);
      misses.push(`${proof.verb}: ${hop.at} does not call ${hop.calls}(${hint >= 0 ? `; ${hop.fn} calls it at ${file}:${hint + 1}` : `, and ${hop.fn} in ${file} no longer calls it at all`}`);
      return;
    }
    const fn = enclosingFunctionName(sf, pos);
    if (fn !== hop.fn) misses.push(`${proof.verb}: ${hop.at} sits in ${fn ?? 'no named function'}, not ${hop.fn}`);
    const next = proof.hops[i + 1];
    if (next !== undefined && next.fn !== hop.calls) misses.push(`${proof.verb}: hop ${i + 1} calls ${hop.calls}, but hop ${i + 2} is in ${next.fn}`);
    if (next === undefined && !POSTING_PATH.has(hop.calls)) misses.push(`${proof.verb}: the last hop calls ${hop.calls}, not postEntry or reverseEntry`);
  });
  return misses;
}

// --- The Studio scan --------------------------------------------------------------------------------

/** The accent token, wherever it sits in a class list. */
const ACCENT_TOKEN = /(?:^|[^\w-])btn--accent(?![\w-])/;
/** A variant spelled by interpolation or concatenation (`btn--${v}`, `'btn btn--' + v`). */
const OPEN_VARIANT = /(?:^|[^\w-])btn--$/;

/** @param {ts.Node} node @returns {ts.Node} */
function outerOf(node) {
  let n = node.parent;
  while (n !== undefined && ts.isParenthesizedExpression(n)) n = n.parent;
  return n;
}

/** @param {ts.Expression} expr @returns {ts.Expression} */
function unwrap(expr) {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/** @param {ts.Node} node @returns {node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral} */
function isPlainString(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

/** @param {ts.JsxAttributes} attrs @param {string} name @returns {ts.JsxAttribute | undefined} */
function attribute(attrs, name) {
  for (const p of attrs.properties) if (ts.isJsxAttribute(p) && p.name.getText() === name) return p;
  return undefined;
}

/**
 * The verbs each directory's non-test sources call: every string literal that is the FIRST argument
 * of a call (`client.call('post_entry', ...)`, `write('asset_dispose', ...)`, `run('...')`).
 * @param {Array<{ file: string, sf: ts.SourceFile }>} parsed @returns {Map<string, Set<string>>}
 */
function calledVerbsByDir(parsed) {
  /** @type {Map<string, Set<string>>} */
  const byDir = new Map();
  for (const { file, sf } of parsed) {
    const set = byDir.get(dirname(file)) ?? new Set();
    byDir.set(dirname(file), set);
    /** @param {ts.Node} node */
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const first = node.arguments[0];
        if (first !== undefined && isPlainString(first) && /^[a-z][a-z0-9_]*$/.test(first.text)) set.add(first.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return byDir;
}

/**
 * @typedef {{ file: string, line: number, verbs: string[] }} Site
 * @param {Array<{ file: string, source: string }>} files
 * @param {Set<string>} posting
 * @returns {{ misses: string[], sites: Site[] }}
 */
function verdict(files, posting) {
  const parsed = files.map(({ file, source }) => ({ file, sf: parse(file, source) }));
  const called = calledVerbsByDir(parsed);
  /** @type {string[]} */
  const misses = [];
  /** @type {Site[]} */
  const sites = [];
  /** @type {Set<ts.JsxAttribute>} the `data-money-commit` attributes an accent accounted for */
  const claimed = new Set();

  for (const { file, sf } of parsed) {
    const where = (/** @type {ts.Node} */ n) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
    const surfaceCalls = called.get(dirname(file)) ?? new Set();

    /** @param {ts.StringLiteral | ts.NoSubstitutionTemplateLiteral} lit @param {ts.Node} at */
    const checkVerbs = (lit, at) => {
      const verbs = lit.text.trim().split(/\s+/).filter(Boolean);
      if (verbs.length === 0) misses.push(`${where(at)}: ${ATTR} names no verb`);
      for (const v of verbs) {
        if (!posting.has(v)) misses.push(`${where(at)}: ${ATTR} names '${v}', which is not a posting verb (the engine's dial 'post' set or a proven one)`);
        else if (!surfaceCalls.has(v)) misses.push(`${where(at)}: ${ATTR} names '${v}', which no source in ${dirname(file)} calls`);
      }
      return verbs;
    };

    /** @param {ts.Node} lit */
    const attribute_ = (lit) => {
      const up = outerOf(lit);
      /** @type {ts.JsxAttribute | undefined} */
      let classAttr;
      /** @type {ts.ConditionalExpression | undefined} */
      let cond;
      if (up !== undefined && ts.isJsxAttribute(up)) classAttr = up;
      else if (up !== undefined && ts.isConditionalExpression(up) && (unwrap(up.whenTrue) === lit || unwrap(up.whenFalse) === lit)) {
        cond = up;
        const holder = outerOf(up);
        if (holder !== undefined && ts.isJsxExpression(holder) && holder.parent !== undefined && ts.isJsxAttribute(holder.parent)) classAttr = holder.parent;
      }
      if (classAttr === undefined || classAttr.name.getText(sf) !== 'className') {
        return `${where(lit)}: a btn--accent this guard cannot attribute (only a className="..." literal or a className={cond ? '...' : '...'} ternary can carry the accent)`;
      }
      const onTrue = cond !== undefined && unwrap(cond.whenTrue) === lit;
      if (cond !== undefined) {
        const other = unwrap(onTrue ? cond.whenFalse : cond.whenTrue);
        if (!isPlainString(other) || ACCENT_TOKEN.test(other.text)) return `${where(lit)}: the other branch of an accent ternary must be a plain class string without the accent`;
      }
      const money = attribute(classAttr.parent, ATTR);
      if (money === undefined || money.initializer === undefined) return `${where(lit)}: btn--accent without ${ATTR}="<posting verb>" on the same element`;
      claimed.add(money);
      const init = money.initializer;
      if (cond === undefined) {
        if (!ts.isStringLiteral(init)) return `${where(money)}: an unconditional accent needs a literal ${ATTR}="<verb>"`;
        sites.push({ file, line: sf.getLineAndCharacterOfPosition(lit.getStart(sf)).line + 1, verbs: checkVerbs(init, money) });
        return null;
      }
      const claim = ts.isJsxExpression(init) && init.expression !== undefined ? unwrap(init.expression) : undefined;
      if (claim === undefined || !ts.isConditionalExpression(claim)) {
        return `${where(money)}: a conditional accent needs ${ATTR}={<same condition> ? ... : ...}`;
      }
      const norm = (/** @type {ts.Node} */ n) => n.getText(sf).replace(/\s+/g, ' ');
      if (norm(claim.condition) !== norm(cond.condition)) {
        return `${where(money)}: ${ATTR} switches on '${norm(claim.condition)}' but the accent on '${norm(cond.condition)}'; the tint and the claim must share one condition`;
      }
      const same = unwrap(onTrue ? claim.whenTrue : claim.whenFalse);
      const rest = unwrap(onTrue ? claim.whenFalse : claim.whenTrue);
      if (!isPlainString(same)) return `${where(money)}: the accent branch of ${ATTR} must name the verb as a literal`;
      if (!(ts.isIdentifier(rest) && rest.text === 'undefined')) return `${where(money)}: the non-accent branch of ${ATTR} must be undefined (the attribute is present exactly where the accent is)`;
      sites.push({ file, line: sf.getLineAndCharacterOfPosition(lit.getStart(sf)).line + 1, verbs: checkVerbs(same, money) });
      return null;
    };

    /** @param {ts.Node} node */
    const visit = (node) => {
      const text =
        isPlainString(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)
          ? node.text
          : null;
      if (text !== null) {
        if (OPEN_VARIANT.test(text)) misses.push(`${where(node)}: a btn-- variant spelled by interpolation or concatenation hides it from this guard`);
        if (ACCENT_TOKEN.test(text)) {
          const miss = isPlainString(node) ? attribute_(node) : `${where(node)}: a btn--accent this guard cannot attribute (inside a template or text)`;
          if (miss !== null) misses.push(miss);
        }
      }
      if (ts.isJsxAttribute(node) && node.name.getText(sf) === ATTR && !claimed.has(node)) pendingClaims.push({ node, where: where(node) });
      ts.forEachChild(node, visit);
    };
    /** @type {Array<{ node: ts.JsxAttribute, where: string }>} */
    const pendingClaims = [];
    visit(sf);
    for (const c of pendingClaims) if (!claimed.has(c.node)) misses.push(`${c.where}: ${ATTR} on an element that carries no btn--accent`);
  }
  return { misses, sites };
}

/** @returns {Array<{ file: string, source: string }>} */
function studioSources() {
  return execFileSync('git', ['ls-files', '-z', 'app/src'], { cwd: ROOT, maxBuffer: 1 << 28, env: cleanGitEnv() })
    .toString('utf8')
    .split('\0')
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((file) => ({ file, source: readFileSync(join(ROOT, file), 'utf8') }));
}

// --- The engine side --------------------------------------------------------------------------------

test('the engine declares its posting verbs: the dial map post set is read, not restated', () => {
  const declared = engineDeclaredPostingVerbs();
  for (const v of ['post_entry', 'reverse_entry', 'post_vendor_bill', 'inventory_valuation_post', 'vat_settlement_post']) {
    assert.ok(declared.has(v), `${DIAL_MAP} no longer files ${v} under post`);
  }
  assert.ok(declared.size >= 20, `only ${declared.size} post verbs read from ${DIAL_MAP}; the parse lost entries`);
});

test('every proven posting verb really reaches postEntry at the cited line, and is a registered write', () => {
  const orientation = readFileSync(join(ROOT, 'docs/ORIENTATION.md'), 'utf8');
  const declared = engineDeclaredPostingVerbs();
  const read = (/** @type {string} */ rel) => readFileSync(join(ROOT, rel), 'utf8');
  const misses = [];
  for (const proof of PROVEN_POSTING_VERBS) {
    if (declared.has(proof.verb)) misses.push(`${proof.verb}: the engine already files it under post; drop the proof`);
    const row = orientation.split('\n').find((l) => l.startsWith(`| \`${proof.verb}\` | `));
    if (row === undefined) misses.push(`${proof.verb}: not a registered verb (no row in docs/ORIENTATION.md)`);
    else {
      if (!row.startsWith(`| \`${proof.verb}\` | write |`)) misses.push(`${proof.verb}: registered, but not as a write`);
      const firstFile = proof.hops[0]?.at.split(':')[0] ?? '';
      if (!row.includes(`\`${firstFile}\``)) misses.push(`${proof.verb}: its first hop ${firstFile} is not the verb's engine file`);
    }
    misses.push(...checkProof(proof, read));
  }
  assert.deepEqual(misses, []);
});

test('the proof check bites: a moved line, a wrong function and a non-posting last hop all fail', () => {
  const read = (/** @type {string} */ rel) => readFileSync(join(ROOT, rel), 'utf8');
  const moved = checkProof({ verb: 'x', why: '', hops: [{ at: 'src/core/sales/invoice.ts:1', fn: 'buildInvoicePosting', calls: 'postEntry' }] }, read);
  assert.equal(moved.length, 1, moved.join('\n'));
  assert.match(moved[0] ?? '', /buildInvoicePosting calls it at src\/core\/sales\/invoice\.ts:\d+/);
  const wrongFn = checkProof({ verb: 'x', why: '', hops: [{ at: 'src/core/sales/invoice.ts:263', fn: 'issueInvoice', calls: 'postEntry' }] }, read);
  assert.match(wrongFn.join('\n'), /sits in buildInvoicePosting, not issueInvoice/);
  const notPosting = checkProof({ verb: 'x', why: '', hops: [{ at: 'src/core/banking/pain001.ts:1074', fn: 'markBatchPaid', calls: 'recordPayment' }] }, read);
  assert.match(notPosting.join('\n'), /the last hop calls recordPayment, not postEntry or reverseEntry/);
});

test('the verbs the C2 critic measured as booking nothing are not posting verbs', () => {
  const posting = postingVerbs();
  assert.deepEqual(KNOWN_NON_POSTING.filter((v) => posting.has(v)), []);
});

// --- The Studio side --------------------------------------------------------------------------------

test('every btn--accent in the Studio commits a posting verb its surface calls', () => {
  const files = studioSources();
  assert.ok(files.some((f) => f.file === 'app/src/surfaces/Journal/EntryDrawer.tsx'), 'the scan did not find the composer');
  const { misses, sites } = verdict(files, postingVerbs());
  assert.deepEqual(misses, []);
  assert.ok(
    sites.some((s) => s.file === 'app/src/surfaces/Journal/EntryDrawer.tsx' && s.verbs.includes('post_entry')),
    'the composer "Buchen" was not attributed to post_entry',
  );
});

/** A surface fixture that really calls the verbs the fixtures name. */
const CALLS = "client.call('post_entry', {}); client.call('create_credit_note', {});";

/** @param {string} jsx @returns {string[]} */
function missesFor(jsx, file = 'app/src/surfaces/X/X.tsx') {
  return verdict([{ file, source: `${CALLS}\nconst v = <div>${jsx}</div>;` }], postingVerbs()).misses;
}

test('the guard admits the two honest shapes', () => {
  assert.deepEqual(missesFor('<button className="btn btn--accent" data-money-commit="post_entry" />'), []);
  assert.deepEqual(missesFor("<button className={posts ? 'btn btn--accent' : 'btn btn--primary'} data-money-commit={posts ? 'post_entry' : undefined} />"), []);
  assert.deepEqual(missesFor("<button className={rev ? 'btn btn--danger' : 'btn btn--accent'} data-money-commit={rev ? undefined : 'post_entry'} />"), []);
  assert.deepEqual(missesFor('{/* the tinted `.btn--accent` is for money */}<button className="btn btn--primary" />'), []);
});

test('the guard bites: the two F6 bypasses fail', () => {
  const prefixed = missesFor('<button className="recurring-x btn btn--accent">Speichern</button>');
  assert.equal(prefixed.length, 1, prefixed.join('\n'));
  assert.match(prefixed[0] ?? '', /without data-money-commit/);
  const joined = missesFor("<button className={['btn', 'btn--accent'].join(' ')}>Speichern</button>");
  assert.equal(joined.length, 1, joined.join('\n'));
  assert.match(joined[0] ?? '', /cannot attribute/);
});

test('the guard bites: a non-posting verb annotated as a money commit fails', () => {
  const draft = missesFor('<button className="btn btn--accent" data-money-commit="create_credit_note">Entwurf erstellen</button>');
  assert.equal(draft.length, 1, draft.join('\n'));
  assert.match(draft[0] ?? '', /'create_credit_note', which is not a posting verb/);
  const invented = missesFor('<button className="btn btn--accent" data-money-commit="post_entry stock_run_valuation" />');
  assert.match(invented.join('\n'), /'stock_run_valuation', which is not a posting verb/);
});

test('the guard bites: every other shape it cannot hold to a verb fails', () => {
  const cases = /** @type {Array<[string, RegExp]>} */ ([
    ['<button className={`btn btn--${variant}`} />', /interpolation or concatenation/],
    ["<button className={'btn btn--' + variant} />", /interpolation or concatenation/],
    ["<button className={cls} />{void (cls = 'btn btn--accent')}", /cannot attribute/],
    ["<button className={a ? 'btn btn--accent' : 'btn btn--primary'} data-money-commit={b ? 'post_entry' : undefined} />", /must share one condition/],
    ["<button className={a ? 'btn btn--accent' : 'btn btn--primary'} data-money-commit=\"post_entry\" />", /conditional accent needs/],
    ["<button className={a ? 'btn btn--accent' : 'btn btn--primary'} data-money-commit={a ? 'post_entry' : 'reverse_entry'} />", /must be undefined/],
    ['<button className="btn btn--primary" data-money-commit="post_entry" />', /carries no btn--accent/],
    ['<button className="btn btn--accent" data-money-commit="reverse_entry" />', /which no source in app\/src\/surfaces\/X calls/],
  ]);
  for (const [jsx, why] of cases) {
    const misses = missesFor(jsx);
    assert.ok(misses.length > 0, `passed but must fail: ${jsx}`);
    assert.match(misses.join('\n'), why, jsx);
  }
});

test('the guard bites on the real pre-fix buttons: the F5 accents fail as they were', () => {
  const posting = postingVerbs();
  const all = studioSources();
  /** @param {string} file @param {string} from @param {string} to */
  const mutate = (file, from, to) => {
    const i = all.findIndex((f) => f.file === file);
    const source = all[i]?.source ?? '';
    assert.ok(source.includes(from), `${file} moved; point this test at it again`);
    const copy = [...all];
    copy[i] = { file, source: source.replace(from, to) };
    return verdict(copy, posting).misses;
  };
  // The credit-note dialog as it was: the accent on "Entwurf erstellen", with the draft verb claimed.
  const credit = mutate(
    'app/src/surfaces/Documents/CreditNoteDialog.tsx',
    'className="btn btn--primary"\n            disabled={busy || overCap || nothingSelected}',
    'className="btn btn--accent"\n            data-money-commit="create_credit_note"\n            disabled={busy || overCap || nothingSelected}',
  );
  assert.match(credit.join('\n'), /'create_credit_note', which is not a posting verb/);
  // The report-only valuation run as it was: an accent with nothing to attribute it to.
  const valuation = mutate(
    'app/src/surfaces/Inventory/Inventory.tsx',
    `className="btn btn--secondary" onClick={() => void runValuation()}`,
    `className="btn btn--accent" onClick={() => void runValuation()}`,
  );
  assert.equal(valuation.length, 1, valuation.join('\n'));
  assert.match(valuation[0] ?? '', /Inventory\.tsx:\d+: btn--accent without data-money-commit/);
  // The issue confirm as it was: unconditional, so a quote's confirm wore the money tint.
  const issue = mutate(
    'app/src/surfaces/Documents/IssueDialog.tsx',
    "className={posts ? 'btn btn--accent' : 'btn btn--primary'}",
    'className="btn btn--accent"',
  );
  assert.match(issue.join('\n'), /IssueDialog\.tsx:\d+: an unconditional accent needs a literal/);
});
