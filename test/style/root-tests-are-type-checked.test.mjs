// @ts-check
/**
 * The COVERAGE RATCHET for the root suites' type check.
 *
 * Sibling of `app-tsconfig-covers-tests.test.mjs`, and the hole it guards was the bigger of the
 * two. The Studio suites were held out of `tsc` by an `exclude` key, which is at least a thing
 * someone could delete. The root suites were held out BY FILE EXTENSION: `tsconfig.json` has
 * `rootDir: "src"` and `include: ["src/**\/*.ts"]`, so every `.mjs` file under `test/` was outside
 * the compiler by construction, and no key anywhere said so. 151 files carrying 1234 assertions when
 * this was written, the ledger and the whole money path among them, were type-checked by nothing at
 * all. Both figures are measurements taken that day, left as they were read; the corpus has grown
 * since, and `FLOOR` rather than this paragraph is what tracks it.
 *
 * `tsconfig.test.json` is the second program that reads them. It sets `allowJs` and leaves
 * `checkJs` FALSE, so a file is judged only once it carries `// @ts-check`. That makes coverage a
 * countable set rather than a claim, which is what this file exists to hold.
 *
 * WHAT IS ASSERTED, AND WHY IT IS SHAPED THIS WAY.
 *
 * Coverage here is partial ON PURPOSE and the ratchet has to say so honestly. Converting the whole
 * corpus is not one unit of work, and a gate that goes green only once every suite is converted is a
 * gate nobody ever turns on. So there are two verdicts, and they answer different failures:
 *
 *  1. RESOLUTION. Every committed `test/**\/*.mjs` appears in the file list the compiler resolves
 *     from `tsconfig.test.json`. This one IS at 100% and must stay there. It is the mechanism-
 *     independent half, taken straight from the app guard: the author of that file found that a
 *     "no `exclude` key" assertion stayed GREEN while a narrowed `include` quietly dropped 38
 *     suites, so it asks the compiler what it will read rather than reading the config's prose.
 *     Narrowing `include` to `test/ledger/**` here would drop 100-odd files with no `exclude` in
 *     sight, and `mechanism: detects` below proves that is caught.
 *
 *  2. COVERAGE. Every file named in `CHECKED` carries the pragma, and the total never falls below
 *     `FLOOR`. This is the ratchet proper. Deleting a `// @ts-check` is a one-character edit that
 *     leaves a file resolved, compiling, and judged by nothing, which is the precise shape of the
 *     original defect. Growing the set means adding to `CHECKED` and raising `FLOOR`, deliberately.
 *
 * HOW IT STAYS NON-VACUOUS. A guard that passes because it found no files, or read the wrong
 * config, is a green light wired to nothing. So the corpus is asserted real, and the mechanism
 * tests re-prove EVERY RUN that the pragma is what makes the compiler judge a file, that `allowJs`
 * is what makes it read one at all, and that an unused `@ts-expect-error` is a build failure. They
 * run against synthetic sources through the REAL resolved compiler options, so they are testing
 * this project's settings and not a convenient stand-in.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import ts from 'typescript';
import { cleanGitEnv } from '../lib/git-env.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CONFIG = join(ROOT, 'tsconfig.test.json');
const CONFIG_REL = 'tsconfig.test.json';

/**
 * The suites that are INSIDE the check and must stay there.
 *
 * Written out one by one rather than as `test/ledger/*.mjs`, because a directory glob would let a
 * new unchecked suite land in a covered directory and quietly lower the ratio while this file
 * stayed green. Adding a file here is the deliberate act that makes its coverage permanent.
 */
const CHECKED = [
  // This guard itself, which would be a poor advertisement for the check if it sat outside it.
  'test/style/root-tests-are-type-checked.test.mjs',
  // Its sibling: the rename guard over the engine's declared success payloads.
  'test/style/result-payload-is-declared.test.mjs',
  // And the Studio's half of the same guard: a declared payload reaches `app/`, type-only.
  'test/style/studio-sees-payloads.test.mjs',
  // And the guard that keeps every source file readable by `grep` in the first place.
  'test/style/binary-source-files.test.mjs',
  // The §H-ENUM mirror guard: a list the Studio offers is the list the engine admits.
  'test/style/studio-mirrors-engine-enums.test.mjs',
  // The wire half of the payload ratchet. It carried the pragma without being recorded here, which
  // is the leak this list exists to stop: a file can lose a pragma it was never on the hook for.
  'test/api/wire-payload-binding.test.mjs',
  // The shared narrowers every converted suite reaches for.
  'test/support/narrow.mjs',
  // A02, the single posting path.
  'test/ledger/support.mjs',
  'test/ledger/draft-base-currency.test.mjs',
  'test/ledger/draft.test.mjs',
  'test/ledger/draft-currency-migration.test.mjs',
  'test/ledger/get-entry-base-currency.test.mjs',
  'test/ledger/hardening.test.mjs',
  'test/ledger/hardening2.test.mjs',
  'test/ledger/hardening4.test.mjs',
  'test/ledger/immutability.test.mjs',
  'test/ledger/journal-list-fx.test.mjs',
  'test/ledger/p3-guard.test.mjs',
  'test/ledger/post-entry.test.mjs',
  'test/ledger/properties.test.mjs',
  'test/ledger/reads.test.mjs',
  'test/ledger/reverse.test.mjs',
  // A03, the audit trail, period locks and the year-close.
  'test/ledger/a03-support.mjs',
  'test/ledger/a03-review-regressions.test.mjs',
  'test/ledger/a03-tripwires.test.mjs',
  'test/ledger/audit-log.test.mjs',
  'test/ledger/periods.test.mjs',
  'test/ledger/year-close.test.mjs',
  'test/ledger/year-close-currency.test.mjs',
  'test/ledger/year-close-query-plan.test.mjs',
];

/**
 * The total that may never fall. A DELIBERATE CONSTANT, like `DECLARED_FLOOR` in
 * `result-payload-is-declared.test.mjs` and `BOUND_FLOOR` in `studio-sees-payloads.test.mjs`.
 *
 * It used to be `CHECKED.length`, which reads like the tidy spelling and is the one shape a ratchet
 * must never take: a floor derived from the list it polices cannot police it. Appending to `CHECKED`
 * raised the floor silently, so the "raise it deliberately" instruction below described nothing. Far
 * worse, DELETING an entry LOWERED the floor by exactly the amount that had just been lost, so
 * removing a covered suite together with its file left both sides of `covered.length >= FLOOR`
 * falling in step and the guard green through the one event it exists to catch. An assertion that
 * moves with its subject is satisfied by construction, which is this repo's signature failure.
 *
 * 29, measured on the committed tree: `git ls-files 'test/**\/*.mjs'` carries 167 suites and 29 of
 * them open with the pragma. Raise it, by hand, in the same commit that converts the next one.
 */
const FLOOR = 30;

/** Every committed `.mjs` under `test/`, from git rather than a directory walk. */
function committedSuites() {
  return execFileSync('git', ['ls-files', 'test/**/*.mjs'], { env: cleanGitEnv(), cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

/** The raw config object, read by the compiler's own JSONC parser. `tsconfig.test.json` has comments. */
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

/** What `ts.parseJsonConfigFileContent` makes of a config object: file list plus resolved options. */
function parseConfig(config) {
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, ROOT);
  assert.deepEqual(
    parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')),
    [],
    `${CONFIG_REL} resolved with errors, so nothing below can be trusted`,
  );
  return parsed;
}

/** The files TypeScript will actually read for a config object, repo-relative and sorted. */
function programFiles(config) {
  return parseConfig(config)
    .fileNames.map((f) => relative(ROOT, f))
    .sort();
}

/** The committed suites a config leaves out of its program entirely. */
function unresolvedSuites(config) {
  const inProgram = new Set(programFiles(config));
  return committedSuites().filter((suite) => !inProgram.has(suite));
}

/** Whether a file opts in to being judged. The pragma must be the FIRST line, as TypeScript reads it. */
function carriesPragma(repoRelative) {
  return /^\/\/ @ts-check\r?\n/.test(readFileSync(join(ROOT, repoRelative), 'utf8'));
}

/**
 * Diagnostics for synthetic sources compiled through a given set of options.
 *
 * The files never touch disk, but they are named UNDER the repo root so `rootDir` accepts them.
 * Everything else (lib files, `@types/node`) is read normally, because the point is to exercise the
 * real options rather than an approximation of them.
 *
 * @param {Record<string, string>} sources repo-relative name to contents
 * @param {ts.CompilerOptions} options
 * @returns {{ code: number, text: string, file: string }[]}
 */
function diagnosticsFor(sources, options) {
  /** @type {Map<string, string>} */
  const synthetic = new Map(Object.entries(sources).map(([name, text]) => [join(ROOT, name), text]));
  const host = ts.createCompilerHost(options, true);
  const readReal = host.readFile.bind(host);
  const getReal = host.getSourceFile.bind(host);
  const existsReal = host.fileExists.bind(host);

  host.readFile = (name) => synthetic.get(name) ?? readReal(name);
  host.fileExists = (name) => synthetic.has(name) || existsReal(name);
  host.writeFile = () => {};
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) => {
    const text = synthetic.get(name);
    return text === undefined
      ? getReal(name, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(name, text, languageVersion, true);
  };

  const program = ts.createProgram([...synthetic.keys()], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file !== undefined && synthetic.has(d.file.fileName))
    .map((d) => ({
      code: d.code,
      text: ts.flattenDiagnosticMessageText(d.messageText, ' '),
      file: d.file === undefined ? '' : relative(ROOT, d.file.fileName),
    }));
}

/** A source with one unambiguous type error and no imports, so nothing but the options decides. */
const WRONG = "export const bad = (1).toFixed('not a number');\n";

// -------------------------------------------------------------------------------------------
// The corpus is real
// -------------------------------------------------------------------------------------------

test('the corpus is real: the suites exist and the config resolves a program over them', () => {
  const suites = committedSuites();
  assert.ok(
    suites.length >= 145,
    `only ${suites.length} root test files found: the glob is wrong, and every assertion below is vacuous`,
  );
  // Named files, so a glob that silently matched a different tree cannot pass this.
  for (const named of ['test/ledger/post-entry.test.mjs', 'test/vat/abrechnung.test.mjs', 'test/fx/rate-math.test.mjs']) {
    assert.ok(suites.includes(named), `${named} is missing from the corpus: the glob is not reaching it`);
  }

  const files = programFiles(readConfig());
  assert.ok(files.length > 140, `${CONFIG_REL} resolves only ${files.length} files: it is not reading test/`);
  assert.ok(
    files.some((f) => f.startsWith('test/ledger/')),
    'the resolved program contains nothing under test/ledger: the wrong config was read',
  );
});

test('the guard is reading the config it names, not the root one', () => {
  const raw = readFileSync(CONFIG, 'utf8');
  assert.ok(raw.includes('"allowJs"'), `${CONFIG_REL} has no allowJs option: this is not the test config`);
  assert.notEqual(CONFIG, join(ROOT, 'tsconfig.json'), 'the guard is pointed at the ROOT config');
});

// -------------------------------------------------------------------------------------------
// The mechanism proves itself, every run
// -------------------------------------------------------------------------------------------

test('mechanism: `// @ts-check` is what makes the compiler judge a file, and it is really off by default', () => {
  const { options } = parseConfig(readConfig());
  assert.equal(options.checkJs, false, 'this project opts in per file; if `checkJs` is on, re-read this guard');

  const without = diagnosticsFor({ 'probe-plain.mjs': WRONG }, options);
  assert.deepEqual(without, [], 'a file with no pragma reported an error: `checkJs` is not off after all');

  const withPragma = diagnosticsFor({ 'probe-checked.mjs': `// @ts-check\n${WRONG}` }, options);
  assert.ok(
    withPragma.some((d) => d.code === 2345),
    `the pragma bought nothing: expected TS2345, got ${JSON.stringify(withPragma)}`,
  );
});

test('mechanism: an UNUSED `@ts-expect-error` fails the build, which is half the value of the check', () => {
  // `p3-guard.test.mjs` and `hardening2.test.mjs` carry directives that are second guards, not
  // suppressions: they go unused the day the engine's public surface widens, and THAT is when they
  // must fail. If TS2578 ever stops firing, those guards are decoration and this fails first.
  const { options } = parseConfig(readConfig());
  const stale = diagnosticsFor(
    { 'probe-stale.mjs': '// @ts-check\n// @ts-expect-error nothing below is wrong\nexport const fine = 1 + 1;\n' },
    options,
  );
  assert.ok(
    stale.some((d) => d.code === 2578),
    `an unused @ts-expect-error was not reported: expected TS2578, got ${JSON.stringify(stale)}`,
  );

  // And a USED one is silent, so the directive is a real escape hatch and not a permanent failure.
  const used = diagnosticsFor({ 'probe-used.mjs': `// @ts-check\n// @ts-expect-error\n${WRONG}` }, options);
  assert.deepEqual(used, [], `a justified @ts-expect-error still errored: ${JSON.stringify(used)}`);
});

test('mechanism: `allowJs` is what lets the compiler read a .mjs at all', () => {
  const { options } = parseConfig(readConfig());
  assert.equal(options.allowJs, true, `${CONFIG_REL} must keep allowJs: without it the program is empty`);

  const blind = diagnosticsFor({ 'probe-noallowjs.mjs': `// @ts-check\n${WRONG}` }, { ...options, allowJs: false });
  assert.deepEqual(blind, [], 'a .mjs was still judged with allowJs off: the premise of this config has changed');
});

test('mechanism: detects a narrowed include, which is how the app guard was fooled', () => {
  const real = readConfig();
  const baseline = unresolvedSuites(real);

  // The failure mode that has actually happened once in this repo: no `exclude` anywhere, the
  // `include` simply stops reaching most of the tree.
  const narrowed = unresolvedSuites({ ...real, include: ['test/ledger/**/*.mjs'] });
  const newlyLost = narrowed.filter((f) => !baseline.includes(f));
  assert.ok(
    newlyLost.length > 100,
    `narrowing include to test/ledger cost only ${newlyLost.length} suites: the detector is broken`,
  );
  assert.ok(
    newlyLost.includes('test/vat/abrechnung.test.mjs'),
    'the VAT suites survived an include narrowed to test/ledger: the detector is broken',
  );

  // And the spelling that fooled nobody yet but would: an outright exclusion.
  const excluded = unresolvedSuites({ ...real, exclude: ['test/ledger'] });
  assert.ok(
    excluded.some((f) => f.startsWith('test/ledger/')),
    'excluding test/ledger cost nothing: the detector is broken',
  );
});

test('the check the suites are inside is a real one', () => {
  // Being resolved buys nothing if the program is judging nothing. `strict` is what turns the
  // engine's opaque `Ok` payload into an `unknown` a suite has to prove before reading, and
  // `noUnusedLocals` is what found the dead `twoLines` helper the first time anything compiled it.
  const { options } = parseConfig(readConfig());
  assert.equal(options.strict, true, `${CONFIG_REL} must keep \`strict\`: without it the check is scenery`);
  assert.equal(options.noUnusedLocals, true, `${CONFIG_REL} must keep \`noUnusedLocals\``);
  assert.equal(options.noUncheckedIndexedAccess, true, `${CONFIG_REL} must keep \`noUncheckedIndexedAccess\``);
});

// -------------------------------------------------------------------------------------------
// The verdicts
// -------------------------------------------------------------------------------------------

test('every root test source is RESOLVED by the type-check config', () => {
  const unresolved = unresolvedSuites(readConfig());
  assert.deepEqual(
    unresolved,
    [],
    `${unresolved.length} root test source(s) are not in the ${CONFIG_REL} program:\n  ` +
      unresolved.join('\n  ') +
      `\n\nThis half must stay at 100%, whatever the coverage below is. A file the compiler does ` +
      'not resolve cannot be opted in at all, so its `// @ts-check` would be a comment and its ' +
      '`@ts-expect-error` would be a comment too. Do not narrow `include`, and do not add an ' +
      '`exclude`: convert the file instead.',
  );
});

test('every suite recorded as covered still carries `// @ts-check`', () => {
  const missing = CHECKED.filter((f) => !carriesPragma(f));
  assert.deepEqual(
    missing,
    [],
    `${missing.length} file(s) recorded as type-checked have lost their pragma:\n  ` +
      missing.join('\n  ') +
      '\n\nDeleting `// @ts-check` is a one-character edit that leaves the file resolved, ' +
      'compiling, and judged by nothing: the exact shape of the defect this whole config exists ' +
      'to close. If the file will not compile, THAT is the finding. Fix the file.',
  );
});

test('coverage never ratchets down', () => {
  // The RECORD first. `covered` is read off the disk, so deleting an entry from `CHECKED` while its
  // file keeps the pragma moves nothing below and would slip through: the list would quietly stop
  // being the register it claims to be, and the file it forgot could then lose its pragma with only
  // the count to notice. Now the floor judges the list as well as the disk.
  assert.ok(
    CHECKED.length >= FLOOR,
    `CHECKED records ${CHECKED.length} file(s) and the floor is ${FLOOR}. An entry was removed from ` +
      'the list. This list only ever grows: if the suite it named is genuinely gone, delete the ' +
      'entry AND lower FLOOR in the same commit, deliberately, with the deletion explained.',
  );

  const covered = committedSuites().filter(carriesPragma);
  assert.ok(
    covered.length >= FLOOR,
    `only ${covered.length} of ${committedSuites().length} root test files carry \`// @ts-check\`, ` +
      `and the recorded floor is ${FLOOR}. Coverage here is partial ON PURPOSE and grows one suite ` +
      'at a time, but it never shrinks. Raise FLOOR when you convert more; never lower it.',
  );
  // Every recorded file is genuinely in the corpus, so a typo in CHECKED cannot inflate the floor.
  const corpus = new Set(committedSuites());
  const phantom = CHECKED.filter((f) => !corpus.has(f));
  assert.deepEqual(phantom, [], `CHECKED names ${phantom.length} file(s) git does not have: ${phantom.join(', ')}`);
});
