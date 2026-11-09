// @ts-check
/**
 * The Studio's half of the rename guard: a payload the ENGINE declares reaches the STUDIO.
 *
 * THE DEFECT THIS EXISTS FOR. `src/core/result.ts` used to declare one open success shape for every
 * verb, `{ ok: true }` plus `[key: string]: unknown`. It became generic (`Ok<T>` / `Result<T>`) and
 * `postEntry` declared `PostEntryOk`, and `test/style/result-payload-is-declared.test.mjs` proves
 * that a rename is TS2339 across `src/` and the root suites.
 *
 * None of it reached the surface the defect family is NAMED after. `app/src/lib/client.ts`
 * hand-mirrored `Ok`/`Err`/`Result`, index signature and all, so the Studio kept the exact type it
 * had before. Measured on 2026-07-26, on the committed tree, by renaming `entryId` to
 * `journalEntryId` in `PostEntryOk`:
 *
 *     root   npx tsc -p tsconfig.json --noEmit   exit 2, 9 errors
 *     Studio cd app && npx tsc --noEmit          exit 0, 0 errors
 *
 * `cd app && npx tsc --noEmit` was green because it could not see the change, not because it agreed
 * with it. The mirror is gone: the types are imported from the engine (`import type`, erased), and
 * `app/src/lib/payloads.ts` binds each wire action name to the payload read off the verb's own
 * signature. The same rename now costs the Studio 4 errors.
 *
 * WHAT IS ASSERTED, AND WHY IT IS SHAPED THIS WAY.
 *
 * Three failures could each restore the hole, and they need three different assertions:
 *
 *  1. THE MIRROR COMES BACK. Re-declaring an open `Ok` in the Studio, under any name, makes the
 *     declared payload invisible again. Asserted as an OUTCOME, never as source text: a synthetic
 *     Studio consumer that reads a field the payload does not carry is compiled through the REAL
 *     resolved options of `app/tsconfig.json` and must be refused. A grep for the string
 *     `[key: string]: unknown` would pass against a mirror spelled `Record<string, unknown>`.
 *
 *  2. THE IMPORT GOES RUNTIME. The mirror existed for a real reason: the browser cannot load
 *     better-sqlite3, which is native and Node-only. `import type` is what keeps the types and drops
 *     the code.
 *
 *     Measured while writing this file, because the obvious version of that sentence is not true:
 *     `postEntry.ts` does NOT reach `better-sqlite3` at runtime. Its `WorkspaceContext` import is
 *     already type-only, and its runtime closure is 11 pure modules (ledger validation, the VAT era
 *     tables, the FX arithmetic). The Node-only edge is `store/sqlite-store.ts -> better-sqlite3`,
 *     one non-type import away from any of them. So dropping `type` in `payloads.ts` would not
 *     break the browser build today; it would quietly put 11 engine modules in the bundle and leave
 *     the Studio one edge from a build that fails for a reason nobody would connect to this file.
 *     Both are worth failing on, and they need two different tests, which is what is below.
 *
 *     The rule is NOT "the Studio imports nothing from `src/`", and stating it that way would be
 *     both wrong and unenforceable. Two surfaces already import engine modules at runtime on
 *     purpose: `Documents/currency.ts` takes `isQrIban` from `src/core/setup/iban.ts`, and
 *     `Documents/invoice.ts` takes the QR renderer from `src/core/sales/swiss-qr-graphic.ts`, both
 *     pure TypeScript with no Node dependency, so the QR rule on screen and the QR rule on the PDF
 *     are one implementation rather than two that drift. That is the right instinct and it is the
 *     opposite of a mirror.
 *
 *     The first verdict is narrow and exact: the two CONTRACT modules, `client.ts` and
 *     `payloads.ts`, import the engine for types and must emit no engine import at all. The second
 *     is the general property, for every surface: TRANSITIVELY, nothing the Studio pulls in at
 *     runtime may reach a Node builtin or an npm package through engine code. Both are computed
 *     from the EMITTED JavaScript, because a bundler sees what survives transpilation and not what
 *     the source says.
 *
 *  3. THE BINDING ROTS. `ActionPayloads` is counted through the type checker, not by reading the
 *     file, and never falls below the recorded floor.
 *
 * HOW IT STAYS NON-VACUOUS. A guard that passes because it resolved no files, read the wrong config
 * or compiled nothing is a green light wired to nothing, and this repo has collected 14 vacuous
 * LOADING tests, 6 unfalsifiable assertions and a compile-time pin that was inert twice over. So the
 * corpus is asserted real before anything is concluded from it, every empty diagnostics list is
 * backed by `mechanism: the probe is judged at all`, and the one place a SILENT verdict is the
 * expected answer (the open default, which is still what 104 of the 110 verbs return) says so in
 * those words rather than hiding it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, dirname, resolve as resolvePath } from 'node:path';
import { execFileSync } from 'node:child_process';

import ts from 'typescript';
import { cleanGitEnv } from '../lib/git-env.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const APP = join(ROOT, 'app');
const CONFIG = join(APP, 'tsconfig.json');
const CONFIG_REL = 'app/tsconfig.json';

/**
 * The action whose payload the engine declares, and the field the defect family is named after.
 * `postEntry` is the pilot; raising these is the deliberate act that records a conversion.
 */
const PILOT = { action: 'post_entry', field: 'entryId', absent: 'journalEntryId' };

/**
 * The floor for actions bound in `ActionPayloads`. Raise it, deliberately, with each verb converted.
 *
 * Raised 5 to 6 on 2026-07-26 by `list_period_locks`, whose declaration turned the Studio's two
 * phantom permission reads (`canManage`, `canUnlock`) into TS2339.
 */
const BOUND_FLOOR = 6;

/** The module that must be the single source of the Studio's `Result` types. */
const ENGINE_RESULT = join(ROOT, 'src/core/result.ts');

/**
 * The resolved compiler options of `app/tsconfig.json`, read through TypeScript's own JSONC parser
 * (the file carries comments, so `JSON.parse` throws on it) and its own resolver.
 */
function appOptions() {
  const read = ts.readConfigFile(CONFIG, ts.sys.readFile);
  assert.equal(read.error, undefined, `${CONFIG_REL} does not parse: nothing below can be trusted`);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, APP);
  assert.deepEqual(
    parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')),
    [],
    `${CONFIG_REL} resolved with errors, so its options cannot be trusted`,
  );
  return parsed.options;
}

/**
 * Diagnostics for synthetic Studio sources compiled through the REAL app options.
 *
 * The technique is the one in `result-payload-is-declared.test.mjs` and
 * `root-tests-are-type-checked.test.mjs`, pointed at the app program instead of the root one. The
 * sources never touch disk but are named UNDER `app/`, so their relative imports resolve exactly as
 * a real Studio module's would, and everything they reach (`app/src/lib/*`, the engine source,
 * `@types/*`) is read normally. That is the whole point: the verdict comes from the real files.
 *
 * @param {Record<string, string>} sources app-relative name to contents
 * @returns {{ code: number, text: string, file: string }[]}
 */
function diagnosticsFor(sources) {
  const options = appOptions();
  /** @type {Map<string, string>} */
  const synthetic = new Map(Object.entries(sources).map(([name, text]) => [join(APP, name), text]));
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
      file: d.file === undefined ? '' : relative(APP, d.file.fileName),
    }));
}

/**
 * A Studio consumer that reads `field` off the success body of `post_entry`, reached through
 * `ActionPayloads` so the probe tests the BINDING and not a type it names itself.
 *
 * @param {string} field
 */
function consumerReading(field) {
  return (
    "import type { Ok } from './src/lib/client';\n" +
    "import type { ActionPayloads } from './src/lib/payloads';\n" +
    '\n' +
    `export function read(body: Ok<ActionPayloads['${PILOT.action}']>) {\n` +
    `  return body.${field};\n` +
    '}\n'
  );
}

/** Every committed source under `app/src`, from git rather than a directory walk. */
function committedAppSources() {
  return execFileSync('git', ['ls-files', 'app/src/**/*.ts', 'app/src/**/*.tsx'], { env: cleanGitEnv(),
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

/**
 * The module specifiers a source imports or re-exports that resolve OUTSIDE `app/`.
 *
 * Read off the compiler's own AST rather than by regex: a specifier inside a comment or a string is
 * not an import, and this guard's whole verdict rests on the difference. Path-relative resolution is
 * enough here, because an engine import is by construction a relative one that climbs out of `app/`.
 *
 * @param {string} file absolute path
 * @param {string} text
 * @returns {string[]}
 */
function escapingSpecifiers(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
  /** @type {string[]} */
  const found = [];
  for (const statement of source.statements) {
    const specifier =
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
    if (specifier === undefined || !specifier.startsWith('.')) continue;
    const target = resolvePath(dirname(file), specifier);
    if (!target.startsWith(APP + '/')) found.push(specifier);
  }
  return found;
}

/**
 * The JavaScript a source becomes, transpiled the way a bundler transpiles it: one file at a time,
 * no type information, which is exactly why `import type` has to be spelled out for it to be erased.
 *
 * @param {string} file absolute path
 * @param {string} text
 */
function emitted(file, text) {
  return ts.transpileModule(text, { compilerOptions: appOptions(), fileName: file }).outputText;
}

/** Every app source that names an engine module, with its specifiers and its emitted JavaScript. */
function engineImporters() {
  return committedAppSources()
    .map((rel) => {
      const file = join(ROOT, rel);
      const text = readFileSync(file, 'utf8');
      return { rel, file, text, specifiers: escapingSpecifiers(file, text) };
    })
    .filter((entry) => entry.specifiers.length > 0);
}

/**
 * Every module specifier a file still imports AFTER transpilation, which is what a bundler follows.
 *
 * Reading the emitted JavaScript rather than the AST is deliberate and it is the difference between
 * this guard working and not: `import type` leaves no trace there, and neither does an import whose
 * every named binding turned out to be a type. Both are exactly the cases that must NOT count.
 *
 * @param {string} file absolute path
 * @returns {string[]}
 */
function runtimeSpecifiers(file) {
  const text = readFileSync(file, 'utf8');
  const out = ts.transpileModule(text, { compilerOptions: appOptions(), fileName: file }).outputText;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
  /** @type {string[]} */
  const kept = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
    if (out.includes(`'${specifier.text}'`) || out.includes(`"${specifier.text}"`)) kept.push(specifier.text);
  }
  return kept;
}

/**
 * Walk the runtime import graph out of `start` and report everything it reaches that a browser
 * cannot load: a bare specifier (a Node builtin, or an npm package the Studio never asked for), a
 * file inside `node_modules`, or a specifier that does not resolve at all.
 *
 * `better-sqlite3` is four hops from `postEntry.ts` (`../context.js` -> `../store/sqlite-store.js`),
 * so this is not a hypothetical rule looking for a violation: it is the exact edge that would break
 * the browser build, stated once, in the place it can be checked.
 *
 * @param {string} start absolute path of an engine module the Studio imports at runtime
 * @returns {string[]} human-readable `from -> specifier` edges
 */
function nodeOnlyReach(start) {
  const options = appOptions();
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const offenders = [];
  /** @type {string[]} */
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    for (const specifier of runtimeSpecifiers(file)) {
      const edge = `${relative(ROOT, file)} -> ${specifier}`;
      if (!specifier.startsWith('.')) {
        offenders.push(edge);
        continue;
      }
      const resolved = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule;
      if (resolved === undefined || resolved.resolvedFileName.includes('/node_modules/')) {
        offenders.push(edge);
        continue;
      }
      queue.push(resolved.resolvedFileName);
    }
  }
  return offenders;
}

// ---------------------------------------------------------------------------------------------
// The corpus is real
// ---------------------------------------------------------------------------------------------

test('the corpus is real: the Studio imports the engine, and the engine module it imports exists', () => {
  const sources = committedAppSources();
  assert.ok(
    sources.length >= 100,
    `only ${sources.length} app sources found: the glob is wrong, and every verdict below is vacuous`,
  );

  const importers = engineImporters().map((e) => e.rel);
  assert.ok(
    importers.includes('app/src/lib/client.ts'),
    'app/src/lib/client.ts imports nothing from outside app/. It hand-mirrored the engine `Result` ' +
      'types until 2026-07-26, and a mirror is what made the Studio blind to a declared payload. ' +
      `Engine importers found: ${importers.join(', ') || '(none at all)'}`,
  );
  assert.ok(
    importers.includes('app/src/lib/payloads.ts'),
    'app/src/lib/payloads.ts imports nothing from outside app/, so it cannot be reading any payload ' +
      'off a verb signature. That file is the binding this whole guard is about.',
  );

  // The specifier really lands on the engine's `result.ts`, asked of the compiler's own resolver
  // rather than assumed from the path text. A guard pointed at a stale `dist/` or at a copy inside
  // `app/` would pass everything below while proving nothing about the engine.
  const options = appOptions();
  const resolved = ts.resolveModuleName(
    '../../../src/core/result',
    join(APP, 'src/lib/client.ts'),
    options,
    ts.sys,
  ).resolvedModule;
  assert.equal(
    resolved?.resolvedFileName,
    ENGINE_RESULT,
    `the Studio's \`Result\` specifier resolves to ${resolved?.resolvedFileName ?? '(nothing)'}, ` +
      `not to ${relative(ROOT, ENGINE_RESULT)}. The types the Studio checks against are not the ` +
      "engine's, whatever the import line says.",
  );
});

// ---------------------------------------------------------------------------------------------
// The mechanism proves itself, every run
// ---------------------------------------------------------------------------------------------

test('mechanism: the probe is judged at all, so a silent verdict means silence and not blindness', () => {
  const found = diagnosticsFor({ 'probe-obviously-wrong.ts': "export const bad: number = 'not a number';\n" });
  assert.ok(
    found.some((d) => d.code === 2322),
    'a source with an unambiguous type error reported nothing: the probe is not being compiled, and ' +
      `every empty result below proves nothing. Got: ${JSON.stringify(found)}`,
  );
});

test('mechanism: a value import survives transpilation, so an absent one is really absent', () => {
  // The verdict below reads "no engine specifier in the emitted JS" as proof of erasure. That
  // reading is only safe if this transpiler would have KEPT a runtime import, which is the one thing
  // a wrong `module` setting or an over-eager elision would quietly take away.
  const file = join(APP, 'src/lib/probe-value-import.ts');
  const out = emitted(
    file,
    "import { ok } from '../../../src/core/result';\nexport const made = ok({ entryId: 'je_1' });\n",
  );
  assert.ok(
    out.includes('../../../src/core/result'),
    `a genuine value import of the engine was elided from the emitted JavaScript, so the bundle ` +
      `verdict below cannot tell erasure from blindness. Emitted:\n${out}`,
  );

  // And the type-only spelling of the same import is gone, which is the property the Studio relies on.
  const erased = emitted(
    file,
    "import type { Ok } from '../../../src/core/result';\nexport type Body = Ok;\n",
  );
  assert.ok(
    !erased.includes('../../../src/core/result'),
    `\`import type\` was NOT erased by the transpiler. The premise of app/src/lib/client.ts has ` +
      `changed and the bundle may now carry engine code. Emitted:\n${erased}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 1. The declared payload reaches the Studio
// ---------------------------------------------------------------------------------------------

test('a DECLARED payload makes a renamed field a compile error in the STUDIO', () => {
  // The exact scenario, on the surface the defect family is named after: someone renames `entryId`
  // in the ledger and the Studio must stop compiling. On the committed tree of 2026-07-26 this same
  // rename cost the Studio nothing at all: exit 0, zero errors, while `src/` took 9.
  const found = diagnosticsFor({ 'probe-renamed-field.ts': consumerReading(PILOT.absent) });
  assert.ok(
    found.some((d) => d.code === 2339 && d.text.includes(PILOT.absent)),
    `reading a field \`${PILOT.action}\`'s payload does not declare was NOT a compile error in the ` +
      'Studio. Either `app/src/lib/client.ts` has gone back to hand-mirroring an open `Ok` (however ' +
      'it is spelled), or `app/src/lib/payloads.ts` no longer reads the payload off the verb. Either ' +
      `way the Studio is blind again. Got: ${JSON.stringify(found)}`,
  );
});

test('and the field it DOES declare still reads clean, so the guard is not just refusing everything', () => {
  const found = diagnosticsFor({ 'probe-declared-field.ts': consumerReading(PILOT.field) });
  assert.deepEqual(
    found,
    [],
    `reading \`${PILOT.field}\`, which the payload declares, produced diagnostics in the Studio. ` +
      'Either the field was renamed without this guard being updated, or the probe is broken and the ' +
      'test above is passing for the wrong reason.',
  );
});

test('the OPEN default is still open: this is the size of the remaining hole, not a gap being hidden', () => {
  // Not a wish, a measurement. 106 of the 107 verb signatures still return the open `Result`, whose
  // index signature answers for every field name, so the identical mistake against any of them is
  // invisible in the Studio exactly as it always was. Making `Ok`'s default closed would break every
  // undeclared surface at once, which is why the engine's change was additive and why this is here.
  const found = diagnosticsFor({
    'probe-open-payload.ts':
      "import type { Ok } from './src/lib/client';\n" +
      '\n' +
      'export function read(body: Ok) {\n' +
      '  return body.fieldThatDoesNotExist;\n' +
      '}\n',
  });
  assert.deepEqual(
    found,
    [],
    'the open `Ok` default has become closed. That is a much bigger change than this guard covers: ' +
      'every Studio surface reading an undeclared verb would now need its payload declared first. ' +
      `Got: ${JSON.stringify(found)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 2. The bundle gains no engine code
// ---------------------------------------------------------------------------------------------

test('the Result and payload contract is erased: neither module reaches the bundle', () => {
  // The two files this whole change is about. They import the engine for TYPES only. Losing the
  // `type` keyword here would not fail the browser build (measured: `postEntry`'s runtime closure is
  // 11 pure modules), which is exactly why it needs its own test: the failure would be silent, the
  // bundle would grow, and the Studio would sit one non-type import away from pulling in SQLite.
  const contract = ['app/src/lib/client.ts', 'app/src/lib/payloads.ts'];
  const kept = contract
    .map((rel) => ({ rel, specifiers: runtimeSpecifiers(join(ROOT, rel)).filter((s) => s.includes('/src/')) }))
    .filter((entry) => entry.specifiers.length > 0);

  assert.deepEqual(
    kept,
    [],
    'the Studio now imports the engine at RUNTIME from a contract module:\n  ' +
      kept.map((k) => `${k.rel}: ${k.specifiers.join(', ')}`).join('\n  ') +
      '\n\nUse `import type`, which the compiler erases. This is the reason `client.ts` hand-mirrored ' +
      'the `Result` types until 2026-07-26, and the mirror is exactly what made the Studio blind to a ' +
      'declared payload. Measured that day: replacing the mirror with type-only imports left the vite ' +
      'build at 462 modules transformed with byte-identical output, same content hash on all five ' +
      'assets. That is the bar a type-only import has to keep meeting.',
  );
});

test('nothing the Studio pulls in at runtime reaches Node-only code through the engine', () => {
  // The load-bearing verdict, and the mechanism-independent one. Sharing a PURE engine module with
  // the browser is right and two surfaces already do it: `Documents/currency.ts` takes the IBAN
  // rules, `Documents/invoice.ts` takes the QR renderer, so the rule on screen and the rule on the
  // PDF are one implementation. What must never happen is a runtime import that drags a Node
  // builtin or an npm package in behind it, and only the transitive closure can tell those apart.
  /** @type {{ rel: string, specifier: string, reaches: string[] }[]} */
  const offenders = [];
  for (const entry of engineImporters()) {
    for (const specifier of runtimeSpecifiers(entry.file)) {
      if (!entry.specifiers.includes(specifier)) continue;
      const resolved = ts.resolveModuleName(specifier, entry.file, appOptions(), ts.sys).resolvedModule;
      const reaches =
        resolved === undefined ? ['(does not resolve at all)'] : nodeOnlyReach(resolved.resolvedFileName);
      if (reaches.length > 0) offenders.push({ rel: entry.rel, specifier, reaches });
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'a Studio surface imports an engine module at runtime that reaches code a browser cannot load:\n  ' +
      offenders.map((o) => `${o.rel} -> ${o.specifier}\n    via ${o.reaches.join('\n    via ')}`).join('\n  ') +
      '\n\nEither reach it with `import type` (erased, no runtime dependency), or move the pure part ' +
      'of that engine module into a leaf the browser can load. Do not re-declare it in the Studio: a ' +
      'hand-mirrored copy is how "the Studio assumed a shape the engine never sends" happened six times.',
  );
});

test('mechanism: the closure detector really sees the SQLite edge it exists for', () => {
  // The verdict above reads an empty offender list as proof. That reading is only safe if the walk
  // finds `better-sqlite3` when a Node-only module IS imported at runtime, which is what a broken
  // resolver, a stopped-too-early walk or a wrong emitted-JS read would silently take away.
  const store = nodeOnlyReach(join(ROOT, 'src/core/store/sqlite-store.ts'));
  assert.ok(
    store.some((edge) => edge.includes('better-sqlite3')),
    'walking the runtime imports of `sqlite-store.ts` did not reach `better-sqlite3`. Either the ' +
      'engine no longer stores through it (re-point this probe at whatever is Node-only now), or the ' +
      `walk is broken and the verdict above is vacuous. Reached: ${JSON.stringify(store)}`,
  );

  // And the walk measures the GRAPH, not the path: two modules under the same `src/core/` come back
  // clean, so the verdict above is not simply flagging everything the Studio names.
  assert.deepEqual(
    nodeOnlyReach(ENGINE_RESULT),
    [],
    'src/core/result.ts now reaches Node-only code. It has had zero imports since it was written, ' +
      'and the detector reporting otherwise means it is flagging by path rather than by graph.',
  );
  assert.deepEqual(
    nodeOnlyReach(join(ROOT, 'src/core/ledger/postEntry.ts')),
    [],
    'the pilot verb now reaches Node-only code at RUNTIME. It did not on 2026-07-26: its ' +
      "`WorkspaceContext` import is type-only and its runtime closure is 11 pure modules. If that " +
      'changed, the type-only import in `app/src/lib/payloads.ts` went from tidy to load-bearing, ' +
      'and the note at the top of this file should say so.',
  );
});

// ---------------------------------------------------------------------------------------------
// 3. The ratchet
// ---------------------------------------------------------------------------------------------

test('the count of actions bound to a declared payload never falls', () => {
  // Counted through the type checker rather than by reading the file, so a binding that is present
  // in the text but broken (a payload that resolved to `never`, an `ActionPayloads` shadowed by
  // another declaration) is not counted as one.
  const options = appOptions();
  const entry = join(APP, 'src/lib/payloads.ts');
  const program = ts.createProgram([entry], options);
  const source = program.getSourceFile(entry);
  assert.ok(source !== undefined, 'app/src/lib/payloads.ts is not in the program: the binding is gone');

  const checker = program.getTypeChecker();
  const declaration = source.statements.find(
    /** @returns {statement is import('typescript').InterfaceDeclaration} */
    (statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === 'ActionPayloads',
  );
  assert.ok(declaration !== undefined, '`ActionPayloads` is not declared in app/src/lib/payloads.ts');

  const bound = checker
    .getTypeAtLocation(declaration.name)
    .getProperties()
    .map((p) => p.getName());
  assert.ok(
    bound.includes(PILOT.action),
    `\`ActionPayloads\` no longer binds \`${PILOT.action}\`, which is the pilot action and the ` +
      `first that declared a payload. Bound: ${bound.join(', ') || '(nothing)'}`,
  );
  assert.ok(
    bound.length >= BOUND_FLOOR,
    `${bound.length} action(s) bound to a declared payload, and the recorded floor is ` +
      `${BOUND_FLOOR}. Conversion is per verb and lands one slice at a time; it does not go ` +
      'backwards. Raise BOUND_FLOOR when you convert more, never lower it.',
  );
});

test('the guard is reading the config it names', () => {
  // Cheap, and it catches the one failure a green guard cannot otherwise distinguish from success:
  // a path that drifted and now points at the ROOT config, which has no `jsx` and a different `include`.
  const raw = readFileSync(CONFIG, 'utf8');
  assert.ok(raw.includes('"jsx"'), `${CONFIG_REL} has no jsx option: this is not the Studio config`);
  assert.notEqual(CONFIG, join(ROOT, 'tsconfig.json'), 'the guard is pointed at the ROOT config');
});
