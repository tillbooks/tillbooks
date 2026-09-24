// Pure planning logic for the pre-push gate (`scripts/pre-push-gate.mjs`).
//
// No git and no filesystem in here: every input is passed in, so the rules are unit-tested in
// `test/scripts/push-gate.test.mjs` instead of being discovered on a slow push.
//
// THE MODEL (D136, 23.09.2026, amending D57/D59). The whole gate used to run, blocking, on every push
// to develop: ~6 minutes on a quiet box and 20+ when parallel sessions gated at once. Now:
//  - `staging` and `main` (promotion): the FULL gate, blocking. A tree that already passed it is not
//    run again.
//  - `develop`, touching the ENGINE (`src/`, `bin/`, root deps and tsconfig): the FULL gate, blocking.
//    The engine is the money path, and nothing unproven lands on it.
//  - `develop`, anything else: a FAST lane (about 1 to 3 minutes) runs what the change can break
//    directly, then the full gate runs in the BACKGROUND on the pushed commit and reports green or red.
// When in doubt a path is treated as engine: the default is the strict gate.

export const DEVELOP_REF = 'refs/heads/develop';
export const PROMOTION_REFS = ['refs/heads/staging', 'refs/heads/main'];
export const PROTECTED_REFS = [DEVELOP_REF, ...PROMOTION_REFS];

/** Suites that guard docs, planning facts and conventions (they scan app/, docs/ and the rest). */
export const CONVENTION_DIRS = ['test/style/', 'test/planning/', 'test/specs/', 'test/guidance/'];

/** The engine: the money path, its CLI and the dependencies and compiler settings it runs on. */
const ENGINE_PREFIXES = ['src/', 'bin/'];
const ENGINE_FILES = ['package.json', 'package-lock.json', 'tsconfig.json'];

/** Studio files `vitest related` can follow through the module graph. */
const APP_SOURCE = /\.(ts|tsx|js|jsx|mjs|css)$/;

/** @param {string} sha */
export function isZeroSha(sha) {
  return !/[^0]/.test(sha);
}

/**
 * The lines git writes to a pre-push hook's stdin: `<local ref> <local sha> <remote ref> <remote sha>`.
 * @param {string} text
 */
export function parsePushLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [localRef = '', localSha = '', remoteRef = '', remoteSha = ''] = line.split(/\s+/);
      return { localRef, localSha, remoteRef, remoteSha };
    });
}

/**
 * The updates the gate judges: pushes to a protected branch that are not branch deletions.
 * @param {ReturnType<typeof parsePushLines>} updates
 */
export function gatedUpdates(updates) {
  return updates.filter((u) => PROTECTED_REFS.includes(u.remoteRef) && !isZeroSha(u.localSha));
}

/**
 * What kind of path this is.
 *  - `engine`: `src/`, `bin/`, root `package.json`/`package-lock.json`/`tsconfig.json`.
 *  - `app`: the Studio (`app/`).
 *  - `web`: the website (`web/`, markdown included: it is site content).
 *  - `docs`: documentation no build consumes (`docs/`, `site-docs/`, markdown outside code roots).
 *  - `other`: tests, scripts, hooks, brand assets, tooling config.
 * @param {string} path
 * @returns {'engine' | 'app' | 'web' | 'docs' | 'other'}
 */
export function classifyPath(path) {
  if (ENGINE_FILES.includes(path) || ENGINE_PREFIXES.some((p) => path.startsWith(p))) return 'engine';
  if (path.startsWith('app/')) return 'app';
  if (path.startsWith('web/')) return 'web';
  if (path.startsWith('docs/') || path.startsWith('site-docs/')) return 'docs';
  const codeRoot = ['test/', 'scripts/', 'ops/', 'packaging/', '.githooks/', '.github/', '.claude/'];
  if (path.endsWith('.md') && !codeRoot.some((p) => path.startsWith(p))) return 'docs';
  return 'other';
}

/**
 * The lane for one push. `null` paths (the change set could not be computed) is always `full`.
 * @param {string[] | null} paths
 * @param {string} remoteRef
 * @returns {'none' | 'fast' | 'full'}
 */
export function planLane(paths, remoteRef) {
  if (paths === null) return 'full';
  if (paths.length === 0) return 'none';
  if (remoteRef !== DEVELOP_REF) return 'full';
  if (paths.some((p) => classifyPath(p) === 'engine')) return 'full';
  return 'fast';
}

/** @param {'none' | 'fast' | 'full'} a @param {'none' | 'fast' | 'full'} b */
export function stricterLane(a, b) {
  const rank = { none: 0, fast: 1, full: 2 };
  return rank[b] > rank[a] ? b : a;
}

/**
 * What the fast lane runs for a change set.
 *  - `node`: the dist build and the selected node suites, for anything outside `web/` (the
 *    convention suites scan app/ and docs/ too).
 *  - `appTypecheck` + `appTests`: `tsc -b` and `vitest related` on the changed Studio sources; when a
 *    Studio file is not a source (a package.json, a config) `appAll` runs the whole Studio suite.
 *  - `web`: the website build and check:aeo, for `web/` and `brand/` (the site reads the tokens).
 * @param {string[]} paths
 */
export function fastPhases(paths) {
  const app = paths.filter((p) => p.startsWith('app/'));
  return {
    node: paths.some((p) => !p.startsWith('web/')),
    appTypecheck: app.length > 0,
    appTests: app.filter((p) => APP_SOURCE.test(p)).map((p) => p.slice('app/'.length)),
    appAll: app.some((p) => !APP_SOURCE.test(p)),
    web: paths.some((p) => p.startsWith('web/') || p.startsWith('brand/')),
  };
}

/**
 * Strings that give away a test reading one of the changed paths: every directory prefix
 * (`docs/`, `docs/planning/`), every segment as a quoted word (`'docs'`, which catches
 * `join(ROOT, 'docs', 'planning')`), and the file name itself.
 * @param {string[]} paths
 */
export function needlesFor(paths) {
  /** @type {Set<string>} */
  const needles = new Set();
  for (const path of paths) {
    const segments = path.split('/');
    const base = segments.pop() ?? '';
    let prefix = '';
    for (const segment of segments) {
      prefix += `${segment}/`;
      needles.add(prefix);
      for (const quote of ["'", '"', '`']) needles.add(`${quote}${segment}${quote}`);
    }
    if (base) needles.add(base);
  }
  return [...needles];
}

/**
 * True when a CODE line of `source` mentions a needle on a line that carries a string literal.
 * Comment lines are skipped (this repo writes block comments with a leading `*`), because most
 * mentions of `CLAUDE.md` in a suite are prose, not reads. A trailing comment on a code line can
 * still match; that only adds a suite, it never drops one.
 * @param {string} source
 * @param {string[]} needles
 */
export function referencesAny(source, needles) {
  for (const line of source.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    if (!/['"`]/.test(line)) continue;
    if (needles.some((needle) => line.includes(needle))) return true;
  }
  return false;
}

/**
 * The node suites the fast lane runs: every convention suite, `test/web/` when the site changed,
 * every changed suite itself, and any other suite whose code references a changed path.
 * @param {string[]} paths
 * @param {string[]} testFiles
 * @param {(file: string) => string} readSource
 */
export function selectTests(paths, testFiles, readSource) {
  const needles = needlesFor(paths);
  const dirs = fastPhases(paths).web ? [...CONVENTION_DIRS, 'test/web/'] : CONVENTION_DIRS;
  const changed = new Set(paths);
  return testFiles.filter(
    (file) =>
      changed.has(file) || dirs.some((dir) => file.startsWith(dir)) || referencesAny(readSource(file), needles),
  );
}

/**
 * Whether a tree's green records already cover a lane. `gate` is `npm run gate`; `web` is the website
 * build plus check:aeo; `fast` is a passed fast lane. The full gate and the website build together
 * cover everything the fast lane checks.
 * @param {'fast' | 'full'} lane
 * @param {Set<string>} kinds
 */
export function satisfiedByCache(lane, kinds) {
  const full = kinds.has('gate') && kinds.has('web');
  return lane === 'full' ? full : full || kinds.has('fast');
}
