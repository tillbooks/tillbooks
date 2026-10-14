// Unit tests for scripts/lib/push-gate.mjs, the lane rules of the pre-push gate (D136), for
// scripts/lib/gate-deps.mjs, the dependencies of the background gate's fresh worktree, plus a ratchet
// on the hook itself: the gate may get faster, it must not get weaker. No git: the dependency tests
// work on synthetic temp directories only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyCiFailure, depsIntact, installedMatchesLock, provideDeps } from '../../scripts/lib/gate-deps.mjs';
import {
  CONVENTION_DIRS,
  DEVELOP_REF,
  UNTESTED_LABEL,
  backgroundVerdict,
  lastVerdict,
  pushWarnings,
  stateLabel,
  classifyPath,
  fastPhases,
  gatedUpdates,
  needlesFor,
  parsePushLines,
  planLane,
  referencesAny,
  satisfiedByCache,
  selectTests,
  stricterLane,
} from '../../scripts/lib/push-gate.mjs';

const SHA = 'a'.repeat(40);
const ZERO = '0'.repeat(40);
const MAIN = 'refs/heads/main';
const STAGING = 'refs/heads/staging';

test('parsePushLines reads the four fields git writes, one update per line', () => {
  assert.deepEqual(parsePushLines(`refs/heads/develop ${SHA} refs/heads/develop ${ZERO}\n\n`), [
    { localRef: 'refs/heads/develop', localSha: SHA, remoteRef: 'refs/heads/develop', remoteSha: ZERO },
  ]);
});

test('gatedUpdates keeps protected branches and drops feature branches and deletions', () => {
  const updates = parsePushLines(
    [
      `refs/heads/develop ${SHA} refs/heads/develop ${SHA}`,
      `refs/heads/claude/x ${SHA} refs/heads/claude/x ${ZERO}`,
      `(delete) ${ZERO} refs/heads/main ${SHA}`,
      `refs/heads/staging ${SHA} refs/heads/staging ${SHA}`,
    ].join('\n'),
  );
  assert.deepEqual(
    gatedUpdates(updates).map((u) => u.remoteRef),
    ['refs/heads/develop', 'refs/heads/staging'],
  );
});

test('classifyPath: the engine is src/, bin/ and the root deps and compiler settings', () => {
  for (const path of ['src/core/ledger/post.ts', 'src/api/serve.ts', 'bin/till.mjs', 'package.json', 'package-lock.json', 'tsconfig.json']) {
    assert.equal(classifyPath(path), 'engine', path);
  }
});

test('classifyPath: Studio, website, docs and the rest', () => {
  assert.equal(classifyPath('app/src/styles/global.css'), 'app');
  assert.equal(classifyPath('app/package.json'), 'app');
  assert.equal(classifyPath('web/src/content/logbuch/the-name.md'), 'web');
  for (const path of ['docs/planning/X.md', 'docs/planning/modernisation/picker.html', 'site-docs/quickstart.mdx', 'CLAUDE.md', 'brand/DESIGN.md']) {
    assert.equal(classifyPath(path), 'docs', path);
  }
  for (const path of ['test/ledger/post.test.mjs', 'test/fixtures/notes.md', 'scripts/run-node-tests.mjs', '.githooks/pre-push', 'brand/tokens/tokens.css', '.gitignore']) {
    assert.equal(classifyPath(path), 'other', path);
  }
});

test('planLane: promotion and engine changes are full; everything else to develop is fast', () => {
  assert.equal(planLane([], DEVELOP_REF), 'none');
  assert.equal(planLane(['docs/a.md'], DEVELOP_REF), 'fast');
  assert.equal(planLane(['app/src/x.tsx', 'test/a.test.mjs', 'web/src/x.astro'], DEVELOP_REF), 'fast');
  assert.equal(planLane(['app/src/x.tsx', 'src/core/ledger/post.ts'], DEVELOP_REF), 'full', 'the money path blocks');
  assert.equal(planLane(['package-lock.json'], DEVELOP_REF), 'full', 'a dependency bump blocks');
  assert.equal(planLane(['docs/a.md'], MAIN), 'full', 'promotion always runs the full gate');
  assert.equal(planLane(['docs/a.md'], STAGING), 'full');
  assert.equal(planLane(null, DEVELOP_REF), 'full', 'an uncomputable change set is full');
  assert.equal(stricterLane('fast', 'full'), 'full');
  assert.equal(stricterLane('full', 'none'), 'full');
});

test('fastPhases: each phase runs only for what can reach it', () => {
  assert.deepEqual(fastPhases(['docs/a.md']), { node: true, appTypecheck: false, appTests: [], appAll: false, web: false });
  const studio = fastPhases(['app/src/surfaces/Journal/Journal.tsx', 'app/src/styles/global.css']);
  assert.equal(studio.appTypecheck, true);
  assert.deepEqual(studio.appTests, ['src/surfaces/Journal/Journal.tsx', 'src/styles/global.css']);
  assert.equal(studio.appAll, false);
  assert.equal(studio.node, true, 'the convention suites scan app/');
  assert.equal(fastPhases(['app/package.json']).appAll, true, 'a Studio dependency change runs every Studio test');
  const site = fastPhases(['web/src/pages/index.astro']);
  assert.equal(site.web, true);
  assert.equal(site.node, false);
  assert.equal(fastPhases(['brand/tokens/tokens.css']).web, true, 'the site reads the tokens');
});

test('needlesFor: directory prefixes, quoted segments and the file name', () => {
  const needles = needlesFor(['docs/planning/DECISIONS.md']);
  for (const needle of ['docs/', 'docs/planning/', "'docs'", '"planning"', 'DECISIONS.md']) {
    assert.ok(needles.includes(needle), needle);
  }
  assert.deepEqual(needlesFor(['CLAUDE.md']), ['CLAUDE.md']);
});

test('referencesAny: a read in code counts, the same words in a comment do not', () => {
  const prose = ['/**', ' * Money-path note (CLAUDE.md): a critic reviews this.', ' */', '// see docs/critique/a14.md', 'const x = 1;'].join('\n');
  assert.equal(referencesAny(prose, needlesFor(['CLAUDE.md'])), false);
  assert.equal(referencesAny(prose, needlesFor(['docs/critique/a14.md'])), false);
  const reads = "const spec = readFileSync(new URL('../../docs/specs/specs/A11-invoice-qr-bill.md', import.meta.url));";
  assert.equal(referencesAny(reads, needlesFor(['docs/specs/specs/A11-invoice-qr-bill.md'])), true);
  assert.equal(referencesAny("const dir = join(ROOT, 'docs', 'planning');", needlesFor(['docs/planning/X.md'])), true);
});

test('selectTests: convention suites always, the changed suites themselves, and suites that read the change', () => {
  const files = [
    'test/style/umlaut-transliteration.test.mjs',
    'test/planning/planning-doc-drift.test.mjs',
    'test/specs/spec-code-drift.test.mjs',
    'test/guidance/help-entries.test.mjs',
    'test/web/social-copy.test.mjs',
    'test/sales/invoice-fx.test.mjs',
    'test/ledger/post.test.mjs',
  ];
  /** @type {Record<string, string>} */
  const sources = {
    'test/web/social-copy.test.mjs': "const KIT = new URL('../../brand/social/PROFILES.md', import.meta.url);",
    'test/sales/invoice-fx.test.mjs': "readFileSync(new URL('../../docs/specs/specs/A11-invoice-qr-bill.md', import.meta.url));",
    'test/ledger/post.test.mjs': ' * CLAUDE.md: posting is idempotent.\nconst n = 1;',
  };
  const read = (/** @type {string} */ f) => sources[f] ?? '';

  assert.deepEqual(selectTests(['docs/planning/MASTER-PROMPT-x.md'], files, read), [
    'test/style/umlaut-transliteration.test.mjs',
    'test/planning/planning-doc-drift.test.mjs',
    'test/specs/spec-code-drift.test.mjs',
    'test/guidance/help-entries.test.mjs',
    'test/sales/invoice-fx.test.mjs', // it reads under docs/
  ]);
  const kit = selectTests(['brand/social/PROFILES.md'], files, read);
  assert.ok(kit.includes('test/web/social-copy.test.mjs'), 'a suite that reads the changed file runs');
  assert.ok(!kit.includes('test/ledger/post.test.mjs'), 'a comment mention is not a read');
  assert.ok(selectTests(['test/ledger/post.test.mjs'], files, read).includes('test/ledger/post.test.mjs'), 'a changed suite runs');
  const site = selectTests(['web/src/pages/index.astro'], files, read);
  assert.ok(site.includes('test/web/social-copy.test.mjs'));
  for (const dir of CONVENTION_DIRS) assert.ok(site.some((f) => f.startsWith(dir)), dir);
});

test('the green cache: only the full gate plus the website build stands in for the full lane', () => {
  assert.equal(satisfiedByCache('fast', new Set(['fast'])), true);
  assert.equal(satisfiedByCache('fast', new Set(['gate', 'web'])), true);
  assert.equal(satisfiedByCache('fast', new Set(['gate'])), false);
  assert.equal(satisfiedByCache('full', new Set(['fast'])), false, 'a fast pass never stands in for the gate');
  assert.equal(satisfiedByCache('full', new Set(['gate'])), false);
  assert.equal(satisfiedByCache('full', new Set(['gate', 'web'])), true);
});

test('ratchet: the gate can get faster, not weaker', () => {
  const hook = readFileSync(new URL('../../.githooks/pre-push', import.meta.url), 'utf8');
  assert.match(hook, /exec node scripts\/pre-push-gate\.mjs/);

  const cli = readFileSync(new URL('../../scripts/pre-push-gate.mjs', import.meta.url), 'utf8');
  // The full lane (engine changes, staging, main, and the background run) is still the whole old gate.
  assert.match(cli, /phase\('npm run gate', 'npm', \['run', 'gate'\]/);
  assert.match(cli, /phase\('web build', 'npm', \['run', 'build', '--prefix', 'web'\]/);
  assert.match(cli, /phase\('check:aeo', 'npm', \['run', 'check:aeo', '--prefix', 'web'\]/);
  // A green record from the working tree is only trusted when it IS the commit under test.
  assert.match(cli, /if \(!workingTreeIs\(sha\)\) return false;/);

  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['gate:unlocked'], 'npm run check && npm run gate:studio', 'the substance of the gate');
  assert.equal(pkg.scripts.gate, 'node scripts/pre-push-gate.mjs --with-lock npm run gate:unlocked');
  assert.equal(pkg.scripts.check, 'npm run typecheck && npm run check:style && npm test');
  assert.equal(pkg.scripts.postgate, 'node scripts/pre-push-gate.mjs --record gate');
});

// ---- The background gate's dependencies. On 30.09.2026 a docs-only push was recorded RED after 9s on
// `sh: tsc: command not found`, although nothing had been tested. Synthetic directories only.

/**
 * A synthetic lockfile for `label`: one ordinary package whose version, tarball and hash follow the
 * label, and one optional package for another platform, which npm leaves out of an installed tree.
 * @param {string} label @param {{ hidden?: boolean }} [options] `hidden`: npm's record of the installed
 *   tree (`node_modules/.package-lock.json`), which has no root entry and no uninstalled optional.
 */
function lockJson(label, { hidden = false } = {}) {
  const packages = {
    ...(hidden ? {} : { '': { name: 'fixture', version: '0.0.0' } }),
    'node_modules/fixture-dep': {
      version: `1.0.0-${label.replace(/[^a-z0-9]/gi, '')}`,
      resolved: `https://registry.example/fixture-dep/-/${encodeURIComponent(label)}.tgz`,
      integrity: `sha512-${Buffer.from(label).toString('base64')}`,
    },
    ...(hidden ? {} : { 'node_modules/@fixture/other-platform': { version: '1.0.0', optional: true, os: ['plan9'] } }),
  };
  return `${JSON.stringify({ name: 'fixture', version: '0.0.0', lockfileVersion: 3, requires: true, packages }, null, 2)}\n`;
}

/**
 * A synthetic checkout: a package.json, a lockfile and, optionally, an installed node_modules per dir.
 * `installedFrom` names the lockfile the installed tree was made from (default: `lock`); `record: false`
 * leaves npm's record of the installed tree out.
 * @param {string} root
 * @param {Record<string, { lock: string, installed?: boolean, installedFrom?: string, record?: boolean }>} dirs
 */
function fakeCheckout(root, dirs) {
  for (const [dir, { lock, installed, installedFrom, record = true }] of Object.entries(dirs)) {
    const at = join(root, dir);
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, 'package.json'), JSON.stringify({ name: `fixture-${dir === '.' ? 'root' : dir}`, version: '0.0.0' }));
    writeFileSync(join(at, 'package-lock.json'), lockJson(lock));
    if (installed) {
      mkdirSync(join(at, 'node_modules', '.bin'), { recursive: true });
      if (record) writeFileSync(join(at, 'node_modules', '.package-lock.json'), lockJson(installedFrom ?? lock, { hidden: true }));
    }
  }
}

function scratch() {
  const base = mkdtempSync(join(tmpdir(), 'till-gate-deps-test-'));
  return { main: join(base, 'main'), worktree: join(base, 'worktree'), done: () => rmSync(base, { recursive: true, force: true }) };
}

/** @param {string} cwd  a stand-in for `npm ci`: it installs an empty node_modules */
function fakeCi(cwd) {
  mkdirSync(join(cwd, 'node_modules', '.bin'), { recursive: true });
  return true;
}

test('provideDeps: an identical lockfile symlinks the main checkout node_modules (the fast path)', () => {
  const s = scratch();
  try {
    fakeCheckout(s.main, { '.': { lock: 'root-v1', installed: true }, app: { lock: 'app-v1', installed: true }, web: { lock: 'web-v1', installed: true } });
    fakeCheckout(s.worktree, { '.': { lock: 'root-v1' }, app: { lock: 'app-v1' }, web: { lock: 'web-v1' } });
    /** @type {string[]} */
    const installs = [];
    const result = provideDeps({ worktree: s.worktree, source: s.main, runCi: (cwd) => (installs.push(cwd), fakeCi(cwd)) });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(installs, [], 'no install when every lockfile matches');
    assert.deepEqual(result.steps.map((step) => `${step.dir}:${step.how}`), ['.:linked', 'app:linked', 'web:linked']);
    for (const dir of ['.', 'app', 'web']) {
      const modules = join(s.worktree, dir, 'node_modules');
      assert.ok(lstatSync(modules).isSymbolicLink(), `${dir}/node_modules is a link`);
      assert.equal(readlinkSync(modules), realpathSync(join(s.main, dir, 'node_modules')));
    }
    assert.equal(depsIntact(s.worktree, result.steps), true);
  } finally {
    s.done();
  }
});

test('provideDeps: a lockfile that differs from the main checkout runs npm ci in that directory only', () => {
  const s = scratch();
  try {
    fakeCheckout(s.main, { '.': { lock: 'root-v1', installed: true }, app: { lock: 'app-v1', installed: true }, web: { lock: 'web-v1', installed: true } });
    fakeCheckout(s.worktree, { '.': { lock: 'root-v1' }, app: { lock: 'app-v2, a bumped dependency' }, web: { lock: 'web-v1' } });
    /** @type {string[]} */
    const installs = [];
    const result = provideDeps({ worktree: s.worktree, source: s.main, runCi: (cwd) => (installs.push(cwd), fakeCi(cwd)) });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(installs, [join(s.worktree, 'app')]);
    assert.deepEqual(result.steps.map((step) => `${step.dir}:${step.how}`), ['.:linked', 'app:installed', 'web:linked']);
    assert.equal(lstatSync(join(s.worktree, 'app', 'node_modules')).isSymbolicLink(), false, 'a real install, not a link');
  } finally {
    s.done();
  }
});

test('provideDeps: a main checkout without node_modules, or no main checkout, means npm ci', () => {
  const s = scratch();
  try {
    fakeCheckout(s.main, { '.': { lock: 'same' } });
    fakeCheckout(s.worktree, { '.': { lock: 'same' } });
    /** @type {string[]} */
    const installs = [];
    const result = provideDeps({ worktree: s.worktree, source: s.main, dirs: ['.'], runCi: (cwd) => (installs.push(cwd), fakeCi(cwd)) });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.steps.map((step) => step.how), ['installed']);
    assert.equal(installs.length, 1);
  } finally {
    s.done();
  }
  const t = scratch();
  try {
    fakeCheckout(t.worktree, { '.': { lock: 'same' } });
    const result = provideDeps({ worktree: t.worktree, source: null, dirs: ['.'], runCi: fakeCi });
    assert.deepEqual(result.steps.map((step) => step.how), ['installed']);
  } finally {
    t.done();
  }
});

test('provideDeps: a failed npm ci is an environment error, and a link that vanishes mid-run is caught', () => {
  const s = scratch();
  try {
    fakeCheckout(s.main, { '.': { lock: 'a', installed: true } });
    fakeCheckout(s.worktree, { '.': { lock: 'b' } });
    const failed = provideDeps({ worktree: s.worktree, source: s.main, dirs: ['.'], runCi: () => false });
    assert.equal(failed.ok, false);
    assert.match(failed.error ?? '', /npm ci/);
    assert.equal(failed.cause, 'environment', 'a failure with no npm error code says nothing about the commit');
    const silent = provideDeps({ worktree: s.worktree, source: s.main, dirs: ['.'], runCi: () => true });
    assert.equal(silent.ok, false, 'an install that claims success but leaves no node_modules is not trusted');
  } finally {
    s.done();
  }
  const t = scratch();
  try {
    fakeCheckout(t.main, { '.': { lock: 'a', installed: true } });
    fakeCheckout(t.worktree, { '.': { lock: 'a' } });
    const linked = provideDeps({ worktree: t.worktree, source: t.main, dirs: ['.'], runCi: () => false });
    assert.equal(linked.ok, true, linked.error);
    // The checkout the link points into loses its node_modules while the gate runs.
    rmSync(join(t.main, 'node_modules'), { recursive: true, force: true });
    assert.equal(depsIntact(t.worktree, linked.steps), false);
  } finally {
    t.done();
  }
});

// ---- Critic LD-3 (D143 landing review): the link fast path trusts the main checkout's INSTALLED tree, not
// only its lockfile file. A main checkout that pulled a lockfile change and never ran `npm ci` would
// otherwise gate the new commit on the old tree.

test('provideDeps (LD-3): a main checkout whose installed tree is not its lockfile is not linked; npm ci runs', () => {
  const s = scratch();
  try {
    fakeCheckout(s.main, { '.': { lock: 'root-v2', installed: true, installedFrom: 'root-v1' } });
    fakeCheckout(s.worktree, { '.': { lock: 'root-v2' } });
    /** @type {string[]} */
    const installs = [];
    const result = provideDeps({ worktree: s.worktree, source: s.main, dirs: ['.'], runCi: (cwd) => (installs.push(cwd), fakeCi(cwd)) });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.steps.map((step) => step.how), ['installed'], 'a stale installed tree is never linked');
    assert.deepEqual(installs, [join(s.worktree, '.')]);
  } finally {
    s.done();
  }
  const t = scratch();
  try {
    // No record of the installed tree at all: it cannot be shown to match, so it is not linked.
    fakeCheckout(t.main, { '.': { lock: 'root-v1', installed: true, record: false } });
    fakeCheckout(t.worktree, { '.': { lock: 'root-v1' } });
    const result = provideDeps({ worktree: t.worktree, source: t.main, dirs: ['.'], runCi: fakeCi });
    assert.deepEqual(result.steps.map((step) => step.how), ['installed']);
  } finally {
    t.done();
  }
});

test('installedMatchesLock (LD-3): compares the fields npm installs by; an uninstalled optional is no mismatch', () => {
  const s = scratch();
  try {
    fakeCheckout(s.main, { '.': { lock: 'v1', installed: true } });
    assert.equal(installedMatchesLock(s.main), true, 'the other-platform optional is absent from the tree, and that is fine');
    const hidden = join(s.main, 'node_modules', '.package-lock.json');
    const record = JSON.parse(readFileSync(hidden, 'utf8'));
    record.packages['node_modules/fixture-dep'].integrity = 'sha512-tampered';
    writeFileSync(hidden, JSON.stringify(record));
    assert.equal(installedMatchesLock(s.main), false, 'another hash is another package');
    record.packages['node_modules/fixture-dep'] = JSON.parse(lockJson('v1', { hidden: true })).packages['node_modules/fixture-dep'];
    record.packages['node_modules/extraneous'] = { version: '9.9.9' };
    writeFileSync(hidden, JSON.stringify(record));
    assert.equal(installedMatchesLock(s.main), false, 'a package the lockfile does not name');
    delete record.packages['node_modules/extraneous'];
    delete record.packages['node_modules/fixture-dep'];
    writeFileSync(hidden, JSON.stringify(record));
    assert.equal(installedMatchesLock(s.main), false, 'a required package that is not installed');
    writeFileSync(hidden, 'not json');
    assert.equal(installedMatchesLock(s.main), false);
  } finally {
    s.done();
  }
});

// ---- Critic LD-1 (D143 landing review): an npm ci failure the COMMIT caused is RED, not "not tested".

test('classifyCiFailure (LD-1): EUSAGE, ETARGET and EINTEGRITY are the commit; network, disk and tooling are the environment', () => {
  for (const code of ['EUSAGE', 'ETARGET', 'EINTEGRITY']) {
    assert.equal(classifyCiFailure(`npm error code ${code}\nnpm error something`), 'commit', code);
    assert.equal(classifyCiFailure(`npm ERR! code ${code}\n`), 'commit', `${code}, npm 9 and older`);
  }
  for (const code of ['ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EACCES', 'ENOSPC', 'ENOENT', 'ENOTCACHED']) {
    assert.equal(classifyCiFailure(`npm error code ${code}\n`), 'environment', code);
  }
  assert.equal(classifyCiFailure(''), 'environment', 'no output: nothing to blame the commit for');
  assert.equal(classifyCiFailure('sh: npm: command not found'), 'environment');
  assert.equal(classifyCiFailure('a log line that merely mentions EUSAGE'), 'environment', "only npm's own error code line counts");
});

test("provideDeps (LD-1): the commit's own lockfile failing npm ci is cause \"commit\"; the same lockfile as main is not", () => {
  const s = scratch();
  try {
    fakeCheckout(s.main, { '.': { lock: 'root-v1', installed: true } });
    fakeCheckout(s.worktree, { '.': { lock: 'root-v2, out of sync' } });
    const eusage = 'npm error code EUSAGE\nnpm error `npm ci` can only install packages when your package.json and package-lock.json are in sync.\n';
    const broken = provideDeps({ worktree: s.worktree, source: s.main, dirs: ['.'], runCi: () => ({ ok: false, output: eusage }) });
    assert.equal(broken.ok, false);
    assert.equal(broken.cause, 'commit');
    assert.match(broken.error ?? '', /install failed at this commit/);
    assert.match(broken.error ?? '', /EUSAGE/);
    const offline = provideDeps({ worktree: s.worktree, source: s.main, dirs: ['.'], runCi: () => ({ ok: false, output: 'npm error code ENOTFOUND\n' }) });
    assert.equal(offline.cause, 'environment', 'the network is not the commit');
    const fine = provideDeps({ worktree: s.worktree, source: s.main, dirs: ['.'], runCi: (cwd) => ({ ok: fakeCi(cwd), output: '' }) });
    assert.equal(fine.ok, true, fine.error);
  } finally {
    s.done();
  }
  const t = scratch();
  try {
    // The lockfile is the main checkout's own (npm ci only ran because main has no node_modules): the
    // commit did not change it, so even EUSAGE is not this commit's fault.
    fakeCheckout(t.main, { '.': { lock: 'same' } });
    fakeCheckout(t.worktree, { '.': { lock: 'same' } });
    const result = provideDeps({ worktree: t.worktree, source: t.main, dirs: ['.'], runCi: () => ({ ok: false, output: 'npm error code EUSAGE\n' }) });
    assert.equal(result.cause, 'environment');
  } finally {
    t.done();
  }
});

test('backgroundVerdict (LD-1): an install the commit broke is RED and never moves develop-green', () => {
  assert.deepEqual(backgroundVerdict({ depsOk: false, depsCause: 'commit', gateOk: false }), { state: 'red', moveGreen: false });
  assert.deepEqual(backgroundVerdict({ depsOk: false, depsCause: 'environment', gateOk: false }), { state: 'untested', moveGreen: false });
});

test('backgroundVerdict: missing dependencies are NOT TESTED, never red, and never move develop-green', () => {
  assert.deepEqual(backgroundVerdict({ depsOk: false, gateOk: false }), { state: 'untested', moveGreen: false });
  assert.deepEqual(backgroundVerdict({ depsOk: true, gateOk: false, depsIntactAfter: false }), { state: 'untested', moveGreen: false });
  assert.deepEqual(backgroundVerdict({ depsOk: true, gateOk: false, depsIntactAfter: true }), { state: 'red', moveGreen: false });
  assert.deepEqual(backgroundVerdict({ depsOk: true, gateOk: true, depsIntactAfter: true }), { state: 'green', moveGreen: true });
});

test('gate:status and the push warning say "not tested (environment)" and keep the last tested verdict', () => {
  assert.equal(UNTESTED_LABEL, 'not tested (environment)');
  assert.equal(stateLabel('untested'), UNTESTED_LABEL);
  assert.equal(stateLabel('red'), 'RED');
  assert.equal(stateLabel(undefined), 'none yet');

  const untested = { state: 'untested', subject: 'abc1234 docs: synthetic', at: '2026-09-30T08:01:19.436Z', reason: 'root: npm ci failed', log: '/tmp/x.log' };
  const lines = pushWarnings(untested).join('\n');
  assert.match(lines, /not tested \(environment\)/);
  assert.match(lines, /root: npm ci failed/);
  assert.doesNotMatch(lines, /\bRED\b/, 'an environment failure is not a red develop');

  // An environment failure must not hide a red develop that WAS tested.
  const red = { state: 'red', sha: 'b'.repeat(40), subject: 'b000000 fix: synthetic', at: '2026-09-29T10:00:00.000Z', log: '/tmp/r.log' };
  assert.deepEqual(lastVerdict(red), { state: 'red', sha: red.sha, subject: red.subject, at: red.at, log: red.log });
  assert.deepEqual(lastVerdict({ ...untested, verdict: lastVerdict(red) }), lastVerdict(red), 'carried through a later run');
  assert.equal(lastVerdict({}), undefined);
  const both = pushWarnings({ ...untested, verdict: lastVerdict(red) }).join('\n');
  assert.match(both, /not tested \(environment\)/);
  assert.match(both, /last tested verdict is RED/);

  assert.match(pushWarnings(red).join('\n'), /develop is RED/);
  assert.deepEqual(pushWarnings({ state: 'green' }), []);

  // Critic LD-2: a push that never landed (`skipped`) must not hide the red verdict it carries.
  const skipped = { state: 'skipped', subject: 'c000000 docs: synthetic', at: '2026-09-30T09:00:00.000Z', reason: 'the push never landed on origin/develop' };
  const carried = pushWarnings({ ...skipped, verdict: lastVerdict(red) }).join('\n');
  assert.match(carried, /last tested verdict for develop is RED: b000000 fix: synthetic/);
  assert.match(carried, /fix forward first\. Log: \/tmp\/r\.log/);
  const greenVerdict = { state: 'green', sha: 'c'.repeat(40), subject: 'c fix', at: skipped.at, log: '/tmp/g.log' };
  assert.deepEqual(pushWarnings({ ...skipped, verdict: greenVerdict }), [], 'a skipped push over a green verdict says nothing');
  assert.deepEqual(pushWarnings(skipped), []);
});

test('ratchet: the background gate takes dependencies from the main checkout; an untested run leaves develop-green alone', () => {
  const cli = readFileSync(new URL('../../scripts/pre-push-gate.mjs', import.meta.url), 'utf8');
  assert.match(cli, /provideDeps\(\{ worktree: dir, source: MAIN/);
  // Critic LD-1: a dependency failure goes through the verdict, so an install the commit broke is red.
  assert.match(cli, /backgroundVerdict\(\{ depsOk: false, depsCause: deps\.cause, gateOk: false \}\)/);
  const start = cli.indexOf('function markUntested');
  assert.ok(start >= 0, 'markUntested exists');
  const body = cli.slice(start, cli.indexOf('\n}\n', start));
  assert.doesNotMatch(body, /GREEN_REF|update-ref/, 'an untested run never moves develop-green');
});
