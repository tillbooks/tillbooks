// Unit tests for scripts/lib/push-gate.mjs, the lane rules of the pre-push gate (D136), plus a ratchet
// on the hook itself: the gate may get faster, it must not get weaker. Pure, no git.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CONVENTION_DIRS,
  DEVELOP_REF,
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
