// Dependencies for a gate that runs in a fresh git worktree (the background full gate, D136).
//
// WHY. A fresh worktree has no node_modules at the root, in `app/` or in `web/`, and a worktree outside
// the repository directory inherits none through Node's upward lookup. On 30.09.2026 the background
// gate for a docs-only commit linked node_modules from the PUSHING checkout, a linked worktree that its
// session removed right after the push: the first `tsc` ran, the second found nothing
// (`sh: tsc: command not found`) and the run was recorded RED although nothing had been tested.
//
// THE RULE. Per directory with a package.json: when the lockfile at the commit under test is
// byte-identical to the main checkout's lockfile, and the main checkout's INSTALLED tree is that
// lockfile (npm's own record of it, `node_modules/.package-lock.json`, critic LD-3), symlink it (fast
// path); otherwise `npm ci` in that directory. A failure here is an ENVIRONMENT error, reported as
// such, never a red gate, with one exception (critic LD-1): when the commit changed the lockfile and
// `npm ci` refuses it for a reason that is the commit's own (EUSAGE, ETARGET, EINTEGRITY), the commit
// broke its install, and that is red.
//
// Filesystem only, no git: the install itself is injected (`runCi`), so the rules are unit-tested in
// `test/scripts/push-gate.test.mjs` on synthetic directories.

import { existsSync, readFileSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

/** The directories with their own package.json and lockfile. */
export const DEP_DIRS = ['.', 'app', 'web'];

/** @typedef {{ dir: string, how: 'linked' | 'installed' | 'none' }} DepStep */
/** @typedef {boolean | { ok: boolean, output?: string }} CiOutcome  what `runCi` answers */

/**
 * npm error codes that mean the lockfile or package.json at the commit cannot be installed, whatever
 * the machine: out of sync (EUSAGE), a version that does not exist (ETARGET), a wrong hash (EINTEGRITY).
 * Everything else (the network, the disk, missing tooling) is the environment.
 */
const COMMIT_CI_CODES = ['EUSAGE', 'ETARGET', 'EINTEGRITY'];

/** npm's own error code line: `npm error code X` since npm 10, `npm ERR! code X` before. */
const CI_CODE_LINE = /^npm (?:error|ERR!) code (\S+)/m;

/** @param {string} output @returns {string | undefined} */
function ciCode(output) {
  return CI_CODE_LINE.exec(output)?.[1];
}

/**
 * Critic LD-1: whose fault an `npm ci` failure is, read from npm's own error code line.
 * @param {string} output @returns {'commit' | 'environment'}
 */
export function classifyCiFailure(output) {
  const code = ciCode(output);
  return code !== undefined && COMMIT_CI_CODES.includes(code) ? 'commit' : 'environment';
}

/** The fields an installed package is identified by. */
const INSTALL_FIELDS = ['version', 'resolved', 'integrity', 'link'];

/**
 * Critic LD-3: whether the node_modules in `dir` was installed from `dir`'s package-lock.json. npm
 * records the installed tree in `node_modules/.package-lock.json`. It matches when every installed
 * package is in the lockfile with the same version, tarball, hash and link, and every package of the
 * lockfile is installed unless it is optional (another platform's binary is never installed). No
 * record, or one that cannot be read, is no match.
 * @param {string} dir
 */
export function installedMatchesLock(dir) {
  /** @type {Record<string, Record<string, unknown>>} */
  let locked;
  /** @type {Record<string, Record<string, unknown>>} */
  let installed;
  try {
    locked = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')).packages;
    installed = JSON.parse(readFileSync(join(dir, 'node_modules', '.package-lock.json'), 'utf8')).packages;
  } catch {
    return false;
  }
  if (typeof locked !== 'object' || locked === null || typeof installed !== 'object' || installed === null) return false;
  for (const [path, entry] of Object.entries(installed)) {
    const want = locked[path];
    if (path === '' || want === undefined) return false;
    if (INSTALL_FIELDS.some((field) => want[field] !== entry[field])) return false;
  }
  for (const [path, entry] of Object.entries(locked)) {
    if (path === '' || Object.hasOwn(installed, path)) continue;
    if (entry.optional !== true && entry.devOptional !== true) return false;
  }
  return true;
}

/** @param {string} path */
function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** @param {string} a @param {string} b */
function sameBytes(a, b) {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/** @param {string} dir */
function label(dir) {
  return dir === '.' ? 'root' : `${dir}/`;
}

/**
 * Give `worktree` a usable node_modules in each of `dirs`.
 * @param {{
 *   worktree: string,
 *   source: string | null,
 *   runCi: (cwd: string) => CiOutcome,
 *   dirs?: string[],
 * }} options  `source` is the main checkout (null when there is none); `runCi` runs `npm ci` in a
 *   directory and says whether it succeeded, with npm's output when it has it.
 * @returns {{ ok: boolean, steps: DepStep[], error?: string, cause?: 'commit' | 'environment' }}
 *   `cause` on a failure: `commit` when the commit's own lockfile cannot be installed (critic LD-1).
 */
export function provideDeps({ worktree, source, runCi, dirs = DEP_DIRS }) {
  /** @type {DepStep[]} */
  const steps = [];
  for (const dir of dirs) {
    const target = join(worktree, dir);
    if (!existsSync(join(target, 'package.json'))) {
      steps.push({ dir, how: 'none' });
      continue;
    }
    const modules = join(target, 'node_modules');
    const from = source === null ? null : join(source, dir, 'node_modules');
    const sourceLock = source === null ? null : join(source, dir, 'package-lock.json');
    const sameLock = sourceLock !== null && sameBytes(join(target, 'package-lock.json'), sourceLock);
    const reusable = from !== null && sameLock && isDir(from) && installedMatchesLock(join(source ?? '', dir));
    if (reusable) {
      try {
        symlinkSync(realpathSync(from), modules);
      } catch (error) {
        return { ok: false, steps, error: `${label(dir)}: could not link ${from}: ${/** @type {Error} */ (error).message}` };
      }
      steps.push({ dir, how: 'linked' });
    } else {
      const outcome = runCi(target);
      if (!(typeof outcome === 'boolean' ? outcome : outcome.ok)) {
        const output = typeof outcome === 'boolean' ? '' : (outcome.output ?? '');
        // Critic LD-1: only a lockfile the commit CHANGED can be the commit's fault; the main
        // checkout's own lockfile failing says nothing about this commit.
        const changed = sourceLock !== null && existsSync(sourceLock) && !sameLock;
        const cause = changed ? classifyCiFailure(output) : 'environment';
        const code = ciCode(output);
        const error =
          cause === 'commit'
            ? `${label(dir)}: install failed at this commit (npm ci ${code}: its package-lock.json cannot be installed)`
            : `${label(dir)}: npm ci failed${code === undefined ? '' : ` (${code})`}`;
        return { ok: false, steps, error, cause };
      }
      steps.push({ dir, how: 'installed' });
    }
    if (!isDir(modules)) return { ok: false, steps, error: `${label(dir)}: no node_modules after ${steps[steps.length - 1]?.how}` };
  }
  return { ok: true, steps };
}

/**
 * Whether every node_modules `provideDeps` provided still resolves. A link into a checkout whose
 * node_modules was removed or reinstalled while the gate ran dangles, and a failure then says nothing
 * about the code.
 * @param {string} worktree @param {DepStep[]} steps
 */
export function depsIntact(worktree, steps) {
  return steps.every((step) => step.how === 'none' || isDir(join(worktree, step.dir, 'node_modules')));
}
