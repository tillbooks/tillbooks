/**
 * The QUARANTINE guard: every Studio test source is inside the Studio type check.
 *
 * `app/tsconfig.json` used to carry
 * `"exclude": ["src/**\/*.test.ts", "src/**\/*.test.tsx", "src/test-setup.ts"]`, added wholesale in
 * cf2ba72 with no reason recorded. The whole app suite, 50 files and 613 tests, was therefore
 * type-checked by nothing, and CI's `npx tsc --noEmit` walked straight past all of it while
 * reporting success. That is worse than having no check, because it reads as one.
 *
 * What the hole was hiding is why this file exists rather than a line in a review checklist:
 *
 *  - The Payments suite's "compile-time pin", written explicitly so the `1000 undefined` defect
 *    could not recur, was inert twice over: excluded from `tsc`, AND routing all 23 fixtures through
 *    `as never`, which erases the argument type. 22 of the 23 casts were hiding nothing at all.
 *  - Recorded engine fixtures did not satisfy `RestResponse`, because a JSON module types
 *    `"ok": true` as `boolean` rather than the literal. Every "pin the recording into a canned
 *    response" site was unchecked, which is the exact opposite of what recording a fixture is for.
 *  - 49 spies asserted on arguments their own type said did not exist: `vi.fn(() => ok())` infers an
 *    empty-tuple `mock.calls`, so `toHaveBeenCalledWith(...)` was checking nothing.
 *  - Stale vitest-1 generics, dead since the vitest 2 upgrade and never noticed.
 *
 * None of that is exotic. It is the ordinary decay of code nobody compiles. The exclusion was
 * emptied file by file and then deleted outright, and "we agreed not to put it back" is not a guard.
 *
 * WHAT IS ASSERTED, AND WHY IT IS THE STRONGER OF THE TWO CANDIDATES.
 *
 * The obvious guard is "`app/tsconfig.json` has no `exclude` key". It is legible and it names the
 * exact thing that went wrong, so it is asserted below and it fails with the history attached. But
 * on its own it is a guard against ONE SPELLING of the mistake. Narrowing `include` to
 * `["src/**\/*.ts"]` drops every `.tsx` suite with no `exclude` in sight; moving the suites under a
 * project reference, or listing `files` explicitly, does the same. Each of those is a plausible
 * edit, none of them looks like a quarantine, and all of them restore the hole.
 *
 * So the load-bearing assertion is the outcome, not the spelling: **every `*.test.ts` and
 * `*.test.tsx` under `app/src` that git knows about appears in the file list TypeScript resolves
 * from that config.** It is mechanism-independent by construction, because it asks the compiler what
 * it will actually read rather than reading the config's prose. The `exclude` check rides along as
 * the more readable failure for the case that is most likely.
 *
 * HOW THE CONFIG IS PARSED, WHICH IS NOT A DETAIL.
 *
 * `app/tsconfig.json` carries comments (it explains, in the file, why there is no exclusion), so it
 * is JSONC and `JSON.parse` THROWS on it. A guard that swallowed that and moved on would pass
 * against a config it never read, which is the failure mode this guard exists to prevent, committed
 * by the guard itself. There is no hand-rolled comment stripper here either: this reads the config
 * with `ts.readConfigFile`, the compiler's own parser, and resolves the globs with
 * `ts.parseJsonConfigFileContent`, the compiler's own resolver. The parse error and the resolver's
 * errors are both asserted empty, so an unreadable config fails loudly instead of quietly.
 * `mechanism: JSONC` below proves the difference on a synthetic string rather than on the real file,
 * so that deleting the comments one day cannot redden a test that has nothing to do with them.
 *
 * HOW IT STAYS NON-VACUOUS. A guard that passes because it found no suites, or resolved no files,
 * or read the wrong config, is worse than no guard: it is a green light wired to nothing. So the
 * corpus is asserted real (50-odd suites, named ones present, a three-figure program), and
 * `mechanism: detects` re-runs the whole verdict against three deliberately holed configs EVERY RUN.
 * If the detector ever stops detecting, that fails here rather than the day someone refills the
 * quarantine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const APP = join(ROOT, 'app');
const CONFIG = join(APP, 'tsconfig.json');
const CONFIG_REL = 'app/tsconfig.json';

/**
 * Suites that must be inside the check, from git rather than from a directory walk.
 *
 * git is the right source: it is the same set CI checks out, it ignores build output and stray
 * scratch files, and a suite that is not committed is not a suite anyone else has.
 */
function committedSuites() {
  return execFileSync('git', ['ls-files', 'app/src/**/*.test.ts', 'app/src/**/*.test.tsx'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

/** The raw config object, read by the compiler's own JSONC parser. Throws if it will not parse. */
function readConfig() {
  const read = ts.readConfigFile(CONFIG, ts.sys.readFile);
  assert.equal(
    read.error,
    undefined,
    `${CONFIG_REL} does not parse: ${read.error === undefined ? '' : ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`,
  );
  assert.ok(
    read.config !== null && typeof read.config === 'object',
    `${CONFIG_REL} parsed to ${typeof read.config}, not an object: this guard would be asserting on nothing`,
  );
  return read.config;
}

/** The files TypeScript will actually read for a given config object, repo-relative and sorted. */
function programFiles(config) {
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, APP);
  assert.deepEqual(
    parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')),
    [],
    `${CONFIG_REL} resolved with errors, so its file list cannot be trusted`,
  );
  return parsed.fileNames.map((f) => relative(ROOT, f)).sort();
}

/** The suites git knows about that the config leaves out. The verdict, reusable on a mutated config. */
function uncheckedSuites(config) {
  const inProgram = new Set(programFiles(config));
  return committedSuites().filter((suite) => !inProgram.has(suite));
}

/**
 * What a mutation costs, ON TOP of whatever the real config already loses.
 *
 * The mechanism tests must answer "does the detector still detect", and that question has to stay
 * answerable while the verdict below is RED. Measured absolutely they would simply restate the
 * verdict: hole the real config and all of them fail too, three failures for one cause, none of
 * them about the detector. Measured as a delta they fail only when a mutation stops costing
 * anything, which is the one thing they are for.
 */
function newlyUnchecked(config, baseline) {
  const already = new Set(baseline);
  return uncheckedSuites(config).filter((suite) => !already.has(suite));
}

// ---------------------------------------------------------------------------------------------
// The corpus is real
// ---------------------------------------------------------------------------------------------

test('the corpus is real: the suites exist and the config resolves a program', () => {
  const suites = committedSuites();
  assert.ok(
    suites.length >= 48,
    `only ${suites.length} app test files found: the glob is wrong, and every assertion below is vacuous`,
  );
  // Named files, so a glob that silently matched a different tree cannot pass this.
  for (const named of [
    'app/src/surfaces/Setup/CompanyProfile.test.tsx',
    'app/src/surfaces/Payments/Payments.test.tsx',
    'app/src/lib/client.test.ts',
  ]) {
    assert.ok(suites.includes(named), `${named} is missing from the corpus: the glob is not reaching it`);
  }

  const files = programFiles(readConfig());
  assert.ok(files.length > 100, `the config resolves only ${files.length} files: it is not reading app/src`);
  assert.ok(
    files.some((f) => f.startsWith('app/src/')),
    'the resolved program contains nothing under app/src: the wrong config was read',
  );
});

// ---------------------------------------------------------------------------------------------
// The mechanism proves itself, every run
// ---------------------------------------------------------------------------------------------

test('mechanism: JSONC defeats JSON.parse, and the compiler parser is why this guard reads anything', () => {
  const jsonc = '{\n  // a comment, which tsconfig allows and JSON does not\n  "include": ["src"]\n}\n';
  assert.throws(
    () => JSON.parse(jsonc),
    SyntaxError,
    'JSON.parse accepted a comment: the premise of this guard has changed, re-read it',
  );

  // The compiler's parser reads it. `readConfigFile` takes a path, so hand it this text directly
  // through the reader argument rather than writing a temp file.
  const read = ts.readConfigFile('/synthetic/tsconfig.json', () => jsonc);
  assert.equal(read.error, undefined, 'ts.readConfigFile could not read JSONC');
  assert.deepEqual(read.config.include, ['src']);

  // And the real file is genuinely of that kind, so this is not a hypothetical: it is why the guard
  // is written the way it is. Asserted on the READ, never on the presence of comments, so stripping
  // the comments some day is not a test failure.
  assert.ok(readConfig().include !== undefined, `${CONFIG_REL} did not yield an include list`);
});

test('mechanism: detects a quarantine, however it is spelled', () => {
  const real = readConfig();
  const baseline = uncheckedSuites(real);
  const target = 'app/src/surfaces/Setup/CompanyProfile.test.tsx';

  // 1. The spelling that actually happened, and the one this file is named after.
  const excluded = newlyUnchecked({ ...real, exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx'] }, baseline);
  assert.ok(excluded.length >= 48 - baseline.length, `a blanket exclude cost only ${excluded.length} suites`);
  assert.ok(
    excluded.includes(target) || baseline.includes(target),
    `${target} survived a blanket exclude: the detector is broken`,
  );

  // 2. One file, which is what the quarantine had shrunk to. A detector that only notices the
  //    blanket would have waved this through on 2026-07-26.
  assert.deepEqual(
    newlyUnchecked({ ...real, exclude: [relative(APP, join(ROOT, target))] }, baseline),
    baseline.includes(target) ? [] : [target],
    'a single-file exclusion is not detected, which is exactly the state this guard was written in',
  );

  // 3. NO exclude at all: `include` narrowed to `.ts`, which drops every `.tsx` suite silently. This
  //    is the case the "no exclude key" check alone cannot see, and the reason the verdict is
  //    phrased as an outcome. Proved on 2026-07-26 by really editing the file: the narrowed include
  //    left 38 suites unchecked while the `exclude` test below stayed GREEN.
  const narrowed = newlyUnchecked({ ...real, include: ['src/**/*.ts'] }, baseline);
  assert.ok(
    narrowed.length > 0 && narrowed.every((f) => f.endsWith('.tsx')),
    `narrowing include to .ts cost ${narrowed.length} suites, expected the .tsx ones`,
  );
  assert.ok(
    narrowed.includes(target) || baseline.includes(target),
    `${target} survived a .tsx-dropping include: the detector is broken`,
  );
});

// ---------------------------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------------------------

test('no app test source is outside the Studio type check', () => {
  const unchecked = uncheckedSuites(readConfig());
  assert.deepEqual(
    unchecked,
    [],
    `${unchecked.length} app test source(s) are not in the ${CONFIG_REL} program:\n  ` +
      unchecked.join('\n  ') +
      `\n\nA test file the compiler never reads is a test file whose types assert nothing, and a ` +
      '`@ts-expect-error` in one is a comment. This was the state of the whole app suite until ' +
      '2026-07-26. If a suite will not compile, THAT is the finding: fix the suite. Do not put it ' +
      'back outside the check, by an `exclude`, by narrowing `include`, or by any other route.',
  );
});

test('app/tsconfig.json carries no exclude key at all', () => {
  // Redundant with the verdict above by design: it is the legible failure for the likely mistake,
  // and it refuses an EMPTY exclusion too. A quarantine standing open with nothing in it is an
  // invitation, and the next file lands in it without anyone deciding anything.
  assert.equal(
    readConfig().exclude,
    undefined,
    `${CONFIG_REL} has an \`exclude\` key. It carried one from cf2ba72 until 2026-07-26, holding ` +
      'the entire app suite out of the type checker while CI reported a passing `tsc --noEmit`. ' +
      'The key is meant to stay absent. Fix the file that will not compile instead.',
  );
});

test('the check the suites are inside is a real one', () => {
  // Being in the program buys nothing if the program is not judging anything. Both flags below are
  // load bearing on the errors this quarantine was actually hiding: the recorded-fixture widening
  // (`Type 'boolean' is not assignable to type 'true'`) is a strict-mode assignability error, and
  // the unused `waitFor` import was TS6133 from `noUnusedLocals`. Turning either off would empty
  // the check while leaving every file nominally inside it.
  const options = readConfig().compilerOptions;
  assert.equal(options.strict, true, `${CONFIG_REL} must keep \`strict\`: without it the check is scenery`);
  assert.equal(
    options.noUnusedLocals,
    true,
    `${CONFIG_REL} must keep \`noUnusedLocals\`: it is what caught the dead import in CompanyProfile.test.tsx`,
  );
});

test('the guard is reading the config it names', () => {
  // Cheap, and it catches the one failure a green guard cannot otherwise distinguish from success:
  // a path that drifted and now points at the root config, which has a legitimate `exclude`.
  const raw = readFileSync(CONFIG, 'utf8');
  assert.ok(raw.includes('"jsx"'), `${CONFIG_REL} has no jsx option: this is not the Studio config`);
  assert.notEqual(
    CONFIG,
    join(ROOT, 'tsconfig.json'),
    'the guard is pointed at the ROOT config, whose `exclude` is legitimate',
  );
});
