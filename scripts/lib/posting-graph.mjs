// @ts-check
// THE POSTING-GRAPH ANALYSER: which registered verbs can mint a journal entry, derived from the code.
//
// Moved here from `test/agent/dial-covers-entry-minting.test.mjs` (D159) so the guard and the
// reversibility prefill (`scripts/reversibility-prefill.mjs`) read ONE analysis. The method, the
// over-approximation and the blind spots are stated in that test's header; nothing about them
// changed in the move.
//
// HOW. The TypeScript checker builds a reference graph over `src/`: a unit (a function, a method, an
// arrow bound to a name or an object property) points at every `src/` symbol it names anywhere in its
// body, nested closures included. A contextually typed object property implements its interface
// member, so a call through `DocumentPoster.onIssue` reaches the invoice poster's `onIssue`. The
// minting set is everything that reaches `postEntry` or `postEntryInternal` in `src/core/ledger/postEntry.ts`, the ONE
// posting path (P3). A registry verb mints when its handler names a minting symbol.
//
// Per verb it answers `{ mints, invokes, file, coreModules }`: `invokes` when the handler holds an
// `ActionInvoker` (`invokerFor` / `invoke`, or a G01 `firingAction`), `file` the repo-relative
// `src/api/*.ts` that registers it, and `coreModules` the `src/core/<dir>` names the handler's own
// symbols are declared in (the verb's engine home, used for grouping, never for a verdict).

import { join, relative, sep } from 'node:path';

import ts from 'typescript';

/**
 * @typedef {{ mints: boolean, invokes: boolean, file: string, coreModules: string[] }} VerbFacts
 */

/**
 * Analyse the repository at `root` (the directory holding `tsconfig.json`).
 * @param {string} root
 * @returns {Map<string, VerbFacts>}
 */
export function analysePostingGraph(root) {
  const SRC = join(root, 'src') + sep;
  const API = join(root, 'src', 'api') + sep;
  const CORE = join(root, 'src', 'core') + sep;

  const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile).config, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();

  /** @param {ts.Symbol | undefined} sym */
  const resolve = (sym) => {
    if (sym !== undefined && sym.flags & ts.SymbolFlags.Alias) {
      try {
        return checker.getAliasedSymbol(sym);
      } catch {
        return sym;
      }
    }
    return sym;
  };
  /** @param {ts.Declaration} decl */
  const inSrc = (decl) => decl.getSourceFile().fileName.startsWith(SRC);

  // reverse edges: callee -> callers (a unit that NAMES the callee).
  /** @type {Map<ts.Symbol, Set<ts.Symbol>>} */
  const callers = new Map();
  /** @param {ts.Symbol} from @param {ts.Symbol} to */
  const link = (from, to) => {
    let set = callers.get(to);
    if (set === undefined) callers.set(to, (set = new Set()));
    set.add(from);
  };

  /** @param {ts.Node} node */
  const unitOf = (node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name !== undefined) return checker.getSymbolAtLocation(node.name);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const p = node.parent;
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return checker.getSymbolAtLocation(p.name);
      if (ts.isPropertyAssignment(p)) return checker.getSymbolAtLocation(p.name);
    }
    return undefined;
  };
  // An object-literal property or method whose literal is contextually typed IMPLEMENTS that
  // type's member: a caller of the member reaches the implementation.
  /** @param {ts.MethodDeclaration | ts.PropertyAssignment} member @param {ts.Symbol} sym */
  const noteImplementation = (member, sym) => {
    const literal = member.parent;
    if (!ts.isObjectLiteralExpression(literal) || member.name === undefined || !ts.isIdentifier(member.name)) return;
    const contextual = checker.getContextualType(literal);
    const declared = contextual?.getProperty(member.name.text);
    if (declared !== undefined && declared !== sym) link(declared, sym);
  };

  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.startsWith(SRC)) continue;
    /** @type {ts.Symbol[]} */
    const stack = [];
    /** @param {ts.Node} node */
    const visit = (node) => {
      const unit = unitOf(node);
      if (unit !== undefined) {
        stack.push(unit);
        if (ts.isMethodDeclaration(node)) noteImplementation(node, unit);
        else if (ts.isPropertyAssignment(node.parent)) noteImplementation(node.parent, unit);
      }
      if (ts.isIdentifier(node) && stack.length > 0) {
        const target = resolve(checker.getSymbolAtLocation(node));
        const top = stack[stack.length - 1];
        if (top !== undefined && target?.declarations?.some(inSrc)) link(top, target);
      }
      ts.forEachChild(node, visit);
      if (unit !== undefined) stack.pop();
    };
    visit(sf);
  }

  // The ONE posting path has two doors (K1 / critic R6-1): `postEntry`, and `postEntryInternal`, the same
  // posting under an engine-internal idempotency scope that composites use for their sub-entries. Both
  // are roots; a verb reaching either mints.
  /** @type {ts.Symbol[]} */
  const roots = [];
  const postEntryFile = program.getSourceFile(join(root, 'src/core/ledger/postEntry.ts'));
  if (postEntryFile !== undefined) {
    ts.forEachChild(postEntryFile, (n) => {
      if (ts.isFunctionDeclaration(n) && n.name !== undefined && (n.name.text === 'postEntry' || n.name.text === 'postEntryInternal')) {
        const sym = checker.getSymbolAtLocation(n.name);
        if (sym !== undefined) roots.push(sym);
      }
    });
  }
  if (roots.length !== 2) {
    throw new Error('postEntry and postEntryInternal are not both declared in src/core/ledger/postEntry.ts: the posting graph has no root');
  }

  const minting = new Set(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const next = queue.pop();
    if (next === undefined) break;
    for (const caller of callers.get(next) ?? []) {
      if (!minting.has(caller)) {
        minting.add(caller);
        queue.push(caller);
      }
    }
  }

  // Every registered verb: `ctxAction` / `depsAction` / `firingAction` with a literal name.
  /** @type {Map<string, VerbFacts>} */
  const verbs = new Map();
  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.startsWith(API)) continue;
    /** @param {ts.Node} node */
    const visit = (node) => {
      const first = ts.isCallExpression(node) ? node.arguments[0] : undefined;
      if (ts.isCallExpression(node) && node.arguments.length >= 2 && first !== undefined && ts.isStringLiteral(first)) {
        const callee = node.expression.getText(sf);
        if (/(^|\.)(ctxAction|depsAction|firingAction)$/.test(callee)) {
          const handler = node.arguments[node.arguments.length - 1];
          let mints = false;
          let invokes = false;
          /** @type {Map<string, number>} */
          const modules = new Map();
          /** @param {ts.Node} n */
          const walk = (n) => {
            if (ts.isIdentifier(n)) {
              if (n.text === 'invokerFor' || n.text === 'invoke') invokes = true;
              const sym = resolve(checker.getSymbolAtLocation(n));
              if (sym !== undefined && minting.has(sym)) mints = true;
              for (const decl of sym?.declarations ?? []) {
                const file = decl.getSourceFile().fileName;
                if (!file.startsWith(CORE)) continue;
                const dir = file.slice(CORE.length).split('/')[0];
                if (dir !== undefined && !dir.endsWith('.ts')) modules.set(dir, (modules.get(dir) ?? 0) + 1);
              }
            }
            ts.forEachChild(n, walk);
          };
          if (handler !== undefined) walk(handler);
          // firingAction wraps invokerFor itself (automation-actions.ts), so each firing verb holds one.
          if (/(^|\.)firingAction$/.test(callee)) invokes = true;
          const coreModules = [...modules].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([dir]) => dir);
          verbs.set(first.text, { mints, invokes, file: relative(root, sf.fileName), coreModules });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return verbs;
}
