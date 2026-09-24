// @ts-check
/**
 * EVERY git this repository's tests, tooling and scripts start runs WITHOUT the repository-locating
 * GIT_* variables.
 *
 * WHY. Code here also runs inside a git pre-push hook, where git exports GIT_DIR (and may export
 * GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, GIT_QUARANTINE_PATH, GIT_CONFIG* ...). A git
 * that inherits them works on that repository whatever its cwd or `-C` says, so a temp-repo
 * `git init` or `git config` rewrites the real repository.
 *
 * WHAT IT ASSERTS, read from the syntax tree (so a comment never counts as usage), over every tracked
 * test file, `ops/` and `scripts/`:
 *  - a call that starts git is found however git is named: `'git'`, an absolute path such as
 *    `/usr/bin/git`, a constant holding either, a shell string (`execSync('git init ...')`, `sh -c`),
 *    a shell running the pre-push hook, and a command held in a variable that cannot be resolved (a
 *    wrapper's `cmd`), which could be git;
 *  - such a call passes an `env` that is a clean-environment helper call (`cleanGitEnv`, `gitEnv`,
 *    the gate's `cleanEnv`), or an object literal that spreads one of those and never spreads
 *    `process.env` (a spread after it would put GIT_DIR back);
 *  - the pre-push hook unsets GIT_* before it starts the scanner or the gate, and the gate script
 *    removes them from its own environment before its first git call.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';

import { cleanGitEnv } from '../lib/git-env.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SPAWN = new Set(['execFileSync', 'spawnSync', 'execSync', 'spawn', 'execFile', 'exec']);
const SHELL_STRING = new Set(['execSync', 'exec']);
const HELPERS = new Set(['cleanGitEnv', 'gitEnv', 'cleanEnv']);
const CHILD_PROCESS_OBJECT = /^(cp|childProcess|child_process)$/;
const GIT_WORD = /(^|[\s;&|(`'"])(?:\/[\w./-]*\/)?git(\s|$)/;

/** @param {ts.Node | undefined} node @returns {string | null} */
function literalText(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');
  return null;
}

/**
 * Every call in `source` that starts git and does not hand it a clean environment.
 * @param {string} source @param {string} [file]
 * @returns {string[]}
 */
export function uncleanGitCalls(source, file = 'probe.mjs') {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  /** @type {Map<string, ts.Expression>} */
  const consts = new Map();
  const collect = (/** @type {ts.Node} */ n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) consts.set(n.name.text, n.initializer);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const resolveExpr = (/** @type {ts.Expression | undefined} */ e, depth = 0) => (e && ts.isIdentifier(e) && consts.has(e.text) && depth < 5 ? resolveExpr(consts.get(e.text), depth + 1) : e);
  const isGitName = (/** @type {string} */ s) => s === 'git' || /\/git$/.test(s);
  const isHelperCall = (/** @type {ts.Expression | undefined} */ e) => !!e && ts.isCallExpression(e) && ts.isIdentifier(e.expression) && HELPERS.has(e.expression.text);
  const isProcessEnv = (/** @type {ts.Expression} */ e) => ts.isPropertyAccessExpression(e) && e.name.text === 'env' && ts.isIdentifier(e.expression) && e.expression.text === 'process';
  const cleanEnv = (/** @type {ts.Expression | undefined} */ raw) => {
    const e = resolveExpr(raw);
    if (!e) return false;
    if (isHelperCall(e)) return true;
    if (ts.isObjectLiteralExpression(e)) {
      const spreads = e.properties.filter(ts.isSpreadAssignment).map((p) => resolveExpr(p.expression) ?? p.expression);
      if (spreads.some(isProcessEnv)) return false;
      return spreads.some(isHelperCall);
    }
    return false;
  };
  /** @type {string[]} */
  const bad = [];
  const visit = (/** @type {ts.Node} */ n) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee) ? callee.text
        : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && CHILD_PROCESS_OBJECT.test(callee.expression.text) ? callee.name.text : null;
      if (name && SPAWN.has(name)) {
        const first = n.arguments[0];
        const resolved = resolveExpr(first);
        const text = literalText(resolved);
        let git = false;
        if (SHELL_STRING.has(name)) git = text === null ? true : GIT_WORD.test(text);
        else if (text !== null) {
          if (isGitName(text)) git = true;
          else if (/^(?:\/[\w/]*\/)?(?:sh|bash|zsh)$/.test(text)) {
            const args = n.arguments[1];
            const words = args && ts.isArrayLiteralExpression(args) ? args.elements.map((a) => literalText(a) ?? a.getText(sf)).join(' ') : args ? args.getText(sf) : '';
            git = GIT_WORD.test(words) || /pre-push/.test(words);
          }
        } else if (resolved && ts.isIdentifier(resolved)) git = true; // an unresolved command could be git
        if (git) {
          const optionsArg = SHELL_STRING.has(name) ? n.arguments[1] : n.arguments.find((a, i) => i > 0 && ts.isObjectLiteralExpression(resolveExpr(a) ?? a));
          const options = resolveExpr(optionsArg);
          const env = options && ts.isObjectLiteralExpression(options)
            ? options.properties.find((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText(sf) === 'env')
            : undefined;
          const envExpr = env && ts.isPropertyAssignment(env) ? env.initializer : env && ts.isShorthandPropertyAssignment(env) ? env.name : undefined;
          if (!cleanEnv(envExpr)) {
            const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
            bad.push(`${file}:${line + 1}  ${n.getText(sf).replace(/\s+/g, ' ').slice(0, 110)}`);
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return bad;
}

/** @param {string[]} specs */
function tracked(specs) {
  return execFileSync('git', ['ls-files', '-z', '--', ...specs], { cwd: ROOT, env: cleanGitEnv(), maxBuffer: 1 << 28 })
    .toString('utf8').split('\0').filter(Boolean);
}

test('every test, tool and script that runs git hands it a clean environment', () => {
  const files = tracked(['test', 'app/src', 'ops', 'scripts'])
    .filter((f) => /\.(m?js|cjs|tsx?)$/.test(f) && existsSync(join(ROOT, f)));
  assert.ok(files.length > 100, 'the corpus is the test tree plus ops/ and scripts/');
  const bad = files.flatMap((f) => uncleanGitCalls(readFileSync(join(ROOT, f), 'utf8'), f));
  assert.deepEqual(bad, [], 'run git with cleanGitEnv() (tests), gitEnv() (ops, scripts) or cleanEnv() (the gate): inside a hook, anything else can hit the real repository');
});

test('the hook unsets GIT_* before it starts anything; the gate strips them before its first git call', () => {
  const hook = readFileSync(join(ROOT, '.githooks/pre-push'), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const unset = hook.search(/unset "\$git_var"/);
  assert.ok(unset > 0, 'the hook unsets every non-transport GIT_* variable');
  assert.ok(unset < hook.indexOf('node "$scanner"'), 'before the scanner');
  assert.ok(unset < hook.indexOf('exec node scripts/pre-push-gate.mjs'), 'before the gate');
  assert.match(hook, /--repo "\$repo_root"/, 'the scanner is told the repository explicitly');
  const gate = readFileSync(join(ROOT, 'scripts/pre-push-gate.mjs'), 'utf8');
  const strip = gate.indexOf("if (key.startsWith('GIT_') && !GIT_TRANSPORT.has(key)) delete process.env[key]");
  assert.ok(strip > 0, 'the gate deletes every non-transport GIT_* variable from its own environment');
  assert.ok(strip < gate.search(/execFileSync\('git'/), 'before its first git call');
});

test('the mechanism: every way of naming git is seen, a comment is not usage, a process.env spread is caught', () => {
  const flagged = [
    "execFileSync('git', ['init', '-q', repo]);",
    "spawnSync('/usr/bin/git', ['config', 'core.bare', 'true'], { cwd: t });",
    "const GIT = 'git'; execFileSync(GIT, ['init'], { cwd: t });",
    "execSync('git init -q && git add -A', { cwd: out });",
    'execSync(`cd ${dir} && git init`, { shell: "/bin/bash" });',
    "spawnSync('sh', ['-c', 'git init -q x'], {});",
    "spawnSync('sh', ['.githooks/pre-push', 'origin', url], { env: process.env });",
    "execFileSync('git', ['init'], { env: { ...process.env, ...cleanGitEnv() } });",
    "execFileSync('git', ['init'], { env: { ...cleanGitEnv(), ...process.env } });",
    "execFileSync('git', ['init'], { cwd: t }); // env: cleanGitEnv() in a comment is not usage",
    "const run = (cmd, a) => execFileSync(cmd, a, { encoding: 'utf8' });",
    "cp.spawnSync('git', ['init']);",
  ];
  for (const s of flagged) assert.equal(uncleanGitCalls(s).length, 1, s);
  const clean = [
    "execFileSync('git', ['init', '-q', repo], { env: cleanGitEnv() });",
    "execFileSync('git', ['init'], { env: cleanGitEnv(TEMP_REPO_GIT), cwd: t });",
    "const env = { ...cleanGitEnv(), GIT_DIR: decoy }; spawnSync('sh', ['.githooks/pre-push'], { env });",
    "execSync('git status', { cwd: ROOT, env: gitEnv() });",
    "spawnSync(process.execPath, ['x.mjs'], { env: process.env });",
    "execFileSync('node', ['x.mjs']);",
    "const m = /x/.exec(line);",
    "spawnSync(cmd, args, { env: { ...cleanEnv(), ...options.env } });",
  ];
  for (const s of clean) assert.deepEqual(uncleanGitCalls(s), [], s);
});
