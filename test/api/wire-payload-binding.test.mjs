// @ts-check
/**
 * The DISPATCHER's half of the rename guard: a wire action name is bound to a declared payload by
 * the action definition itself, and not by anyone writing the two down side by side.
 *
 * THE DEFECT THIS EXISTS FOR. `src/core/result.ts` made the success payload declarable and
 * `postEntry` declared `PostEntryOk`. `test/style/result-payload-is-declared.test.mjs` proves a
 * renamed field is a compile error across `src/` and the root suites, and
 * `test/style/studio-sees-payloads.test.mjs` proves it reaches the Studio. Both of those are about
 * the VALUE side, and both were satisfied while the last link was still open:
 *
 *     run(deps: ApiDeps, input: ActionInput): Result;      // src/api/registry.ts, before
 *
 * That is the OPEN `Result`, on the single invocation both MCP and REST call. A declared payload
 * died there and never reached the wire at type level, so `app/src/lib/payloads.ts` had to hand-write
 * `post_entry: PayloadOf<typeof postEntry>` and said so in its own comment. The gap that left is
 * narrow and exact: a rename INSIDE the payload reddened everything, but the pairing of a tool name
 * with a verb was checked by nothing at all. Re-point `post_entry` at another verb and the Studio
 * goes on type-checking against a payload the wire no longer sends, which is this repo's longest
 * running defect family ("the Studio assumed a shape the engine never sends") one level up from
 * where its six members were found.
 *
 * WHAT IS ASSERTED, AND WHY EACH ASSERTION IS SHAPED THIS WAY.
 *
 *  1. THE BINDING IS REAL AT RUNTIME. `DECLARED_ACTIONS` names definitions, not strings, and each one
 *     must be the very object `getAction` returns for its own name: identity (`===`), not a shape
 *     comparison. A declared action that is not in the list, or a list entry the list no longer
 *     dispatches, is the exact failure a type-level map cannot see, because the map would be derived
 *     from an object nothing calls.
 *
 *  2. THE BINDING IS REAL AT COMPILE TIME. Asserted as an OUTCOME through the real resolved options
 *     of `tsconfig.test.json` against the REAL emitted `dist/**\/*.d.ts`, never by grepping the
 *     source for `ActionResults`. This repo has already collected a compile-time pin that was inert
 *     twice over: its file sat outside `tsc` AND its casts erased the types it claimed to hold.
 *
 *  3. THE TYPE MAP AND THE RUNTIME LIST AGREE. The keys the checker reports for `ActionResults` are
 *     compared against the names the dispatcher actually carries. A hand-written map would pass every
 *     other test in this file and fail this one.
 *
 *  4. THE OPEN DEFAULT IS STILL OPEN. 104 of the 110 verb signatures still return the open `Result`
 *     and their actions still answer for every field name. That is stated as a measurement, in those
 *     words, rather than left out: a partial capability reported as a complete one is how this whole
 *     family survived six findings.
 *
 * HOW IT STAYS NON-VACUOUS. Every empty diagnostics list is backed by `mechanism: the probe is judged
 * at all`, and the one place silence is the expected answer says so explicitly.
 *
 * EVERY ASSERTION BELOW WAS WATCHED TO FAIL, on 2026-07-26, by breaking what it guards, rebuilding
 * `dist/` and running it. A test nobody has seen red is a claim, and this repo has collected 14
 * vacuous LOADING tests, 6 unfalsifiable assertions and an idempotency check satisfied by a PRIMARY
 * KEY. The mutations, each applied alone and reverted:
 *
 *   rename `entryId` in `PostEntryOk`         reddens the TS2339 pair (and 14 Studio errors, from 5)
 *   `DECLARED_ACTIONS = []`                   reddens corpus, pilot, the TS2339 pair, keys
 *   a look-alike def under the same name      reddens identity only. Builds clean, exit 0.
 *   widen the action back to open `Result`    reddens the TS2339 pair and keys; Studio exit 2
 *   `{ name: 'not_an_action' }` in the list   reddens identity, assignability, keys. Builds clean.
 *   an unconverted action in the declared list reddens identity, keys, and the open-default measurement
 *   loosen `T extends OkFields` to `object`   reddens the interface-trap test
 *
 * The look-alike is the one worth reading twice: it type-checks identically, `tsc -p tsconfig.json`
 * exits 0, and nothing anywhere else notices that the map now describes a definition no caller can
 * reach. It is the reason the first assertion compares object IDENTITY and not shape.
 *
 * The `diagnosticsFor` helper is a third copy of the one in `result-payload-is-declared.test.mjs` and
 * `studio-sees-payloads.test.mjs`, deliberately, for the reason recorded there: those files are
 * guards, not libraries, and giving one an export surface for the others would couple gates that must
 * be able to fail independently. All three copies are exercised every run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { existsSync } from 'node:fs';

import ts from 'typescript';

import { getAction, DECLARED_ACTIONS } from '../../dist/api/registry.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CONFIG = join(ROOT, 'tsconfig.test.json');
const REGISTRY_DTS = join(ROOT, 'dist/api/registry.d.ts');

/**
 * The pilot, and the field the defect family is named after. Raising these is the deliberate act
 * that records a conversion.
 */
const PILOT = { action: 'post_entry', field: 'entryId', absent: 'journalEntryId' };

/**
 * An action that has NOT declared a payload, used to state the limit of this guard honestly.
 *
 * `delete_draft` rather than `save_draft` since 2026-07-26, and it is not merely the next open one
 * to hand. `deleteDraft` answers `ok()` with NO fields, and an empty payload cannot be pinned by
 * `PinnedAction`: `OkFields extends {}` is true, so the filter reads an empty declared payload as
 * the open default and drops it from the map. It is the one A02 verb that stays here by
 * construction rather than by not having been reached yet.
 */
const UNDECLARED = { action: 'delete_draft' };

/**
 * The floor for actions bound to a declared payload at the dispatcher. It never falls.
 *
 * Raised 5 to 6 on 2026-07-26 by `list_period_locks`, and the raise IS the record of the conversion:
 * the number moves in the same commit as the verb, or the ratchet is a decoration.
 */
const DECLARED_FLOOR = 6;

/**
 * The resolved compiler options of `tsconfig.test.json`, read through TypeScript's own JSONC parser
 * because that file carries comments.
 */
function testOptions() {
  const read = ts.readConfigFile(CONFIG, ts.sys.readFile);
  assert.equal(read.error, undefined, 'tsconfig.test.json does not parse: nothing below can be trusted');
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT);
  assert.deepEqual(
    parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')),
    [],
    'tsconfig.test.json resolved with errors',
  );
  return parsed.options;
}

/**
 * Diagnostics for synthetic sources compiled through the real options.
 *
 * The sources never touch disk, but they are named UNDER the repo root so `rootDir` accepts them, and
 * everything they import (`dist/`, lib files, `@types/node`) is read normally. That is the whole
 * point: the verdict comes from the emitted declarations, not from a stand-in.
 *
 * @param {Record<string, string>} sources repo-relative name to contents
 * @returns {{ code: number, text: string, file: string }[]}
 */
function diagnosticsFor(sources) {
  const options = testOptions();
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

/**
 * A WIRE consumer: it names an action the way a caller does, as a string key, and reads a field off
 * whatever that action answers with. No engine call, no store, no fixture. This is the read that was
 * unjudgeable before `ActionResults` existed, because the tool name and the payload had no type-level
 * connection to each other.
 *
 * @param {string} action
 * @param {string} field
 */
function wireConsumerReading(action, field) {
  return (
    '// @ts-check\n' +
    `/** @param {import('./dist/api/registry.js').ActionResults['${action}']} payload */\n` +
    'export function read(payload) {\n' +
    `  return payload.${field};\n` +
    '}\n'
  );
}

// -------------------------------------------------------------------------------------------
// The corpus is real
// -------------------------------------------------------------------------------------------

test('the corpus is real: the dispatcher emitted declarations and carries a declared action', () => {
  assert.ok(
    existsSync(REGISTRY_DTS),
    `${relative(ROOT, REGISTRY_DTS)} does not exist. \`npm test\` builds dist first (pretest); if ` +
      'this fails, the build did not run and every verdict below would be about nothing.',
  );
  assert.ok(
    Array.isArray(DECLARED_ACTIONS) && DECLARED_ACTIONS.length > 0,
    '`DECLARED_ACTIONS` is empty or is not an array. It is the source `ActionResults` is derived ' +
      'from, so an empty one makes every compile-time verdict below vacuous.',
  );
});

// -------------------------------------------------------------------------------------------
// 1. The binding is real at runtime
// -------------------------------------------------------------------------------------------

test('every declared action IS the object the dispatcher runs under that name', () => {
  // Identity, not shape. `ActionResults` is derived from these objects; if the list dispatches a
  // DIFFERENT definition under the same name, the whole map describes something nobody calls, and no
  // amount of type checking downstream would notice.
  const detached = DECLARED_ACTIONS.filter((action) => getAction(action.name) !== action);
  assert.deepEqual(
    detached.map((a) => a.name),
    [],
    'a declared action is not the definition the registry dispatches under its own name. Either it ' +
      'was dropped from the ACTIONS list, or the list now holds a second definition with that name. ' +
      'Every payload derived from it describes an action nothing invokes.',
  );

  // And the names really are the wire names, resolvable through the same lookup both adapters use.
  for (const action of DECLARED_ACTIONS) {
    assert.notEqual(
      getAction(action.name),
      undefined,
      `\`${action.name}\` is not in the registry at all, so neither MCP nor REST exposes it`,
    );
  }
});

test('the pilot is among them, and it is the action the wire calls `post_entry`', () => {
  // `names` is `"post_entry"[]`, not `string[]`, which is the tool identity arriving as a LITERAL on
  // the type: that is the half `app/src/lib/payloads.ts` could not derive before. Written with
  // `filter` rather than `includes` for exactly that reason, since `includes` on a literal array
  // refuses a `string` argument, and widening it back with a cast would throw away the evidence.
  const matches = DECLARED_ACTIONS.filter((action) => action.name === PILOT.action);
  assert.equal(
    matches.length,
    1,
    `\`${PILOT.action}\` is no longer a declared action, or is declared twice. Declared: ` +
      `${DECLARED_ACTIONS.map((a) => String(a.name)).join(', ') || '(none)'}`,
  );
});

// -------------------------------------------------------------------------------------------
// 2. The binding is real at compile time
// -------------------------------------------------------------------------------------------

test('mechanism: the probe is judged at all, so a silent verdict means silence and not blindness', () => {
  const found = diagnosticsFor({
    'probe-obviously-wrong.mjs': "// @ts-check\nexport const bad = (1).toFixed('not a number');\n",
  });
  assert.ok(
    found.some((d) => d.code === 2345),
    'a source with an unambiguous type error reported nothing: the probe is not being checked, and ' +
      `every empty result below proves nothing. Got: ${JSON.stringify(found)}`,
  );

  const unpragmad = diagnosticsFor({
    'probe-no-pragma.mjs': "export const bad = (1).toFixed('not a number');\n",
  });
  assert.deepEqual(unpragmad, [], 'a .mjs without `// @ts-check` was judged: the probes must carry the pragma');
});

test('a field the declared payload does not carry is a compile error AT THE WIRE', () => {
  // The scenario, reached the way a caller reaches it: by naming the tool, not the verb. Before
  // `ActionDef.run` carried its payload there was no type to write on the left of this read at all.
  const found = diagnosticsFor({
    'probe-wire-renamed-field.mjs': wireConsumerReading(PILOT.action, PILOT.absent),
  });
  assert.ok(
    found.some((d) => d.code === 2339 && d.text.includes(PILOT.absent)),
    `reading a field \`${PILOT.action}\`'s payload does not declare was NOT a compile error at the ` +
      'wire. Either `ActionDef.run` has gone back to returning the open `Result`, or the action was ' +
      `dropped from \`DECLARED_ACTIONS\`. Got: ${JSON.stringify(found)}`,
  );
});

test('and the field it DOES declare still reads clean, so the guard is not just refusing everything', () => {
  const found = diagnosticsFor({
    'probe-wire-declared-field.mjs': wireConsumerReading(PILOT.action, PILOT.field),
  });
  assert.deepEqual(
    found,
    [],
    `reading \`${PILOT.field}\` off \`${PILOT.action}\`'s payload produced diagnostics. Either the ` +
      'field was renamed without this guard being updated, or the probe is broken and the test ' +
      'above is passing for the wrong reason.',
  );
});

test('a declared action is still assignable to the open ActionDef, which is what makes this additive', () => {
  // The claim the whole change rests on: `ActionDef<'post_entry', PostEntryOk>` goes on sitting in a
  // `readonly ActionDef[]` beside the 104 undeclared ones. `src/core/result.ts` records the trap that
  // makes this non-obvious (an interface is denied the implicit index signature, so an
  // interface-declared payload would break exactly this), so it is proved rather than assumed.
  const found = diagnosticsFor({
    'probe-assignable.mjs':
      '// @ts-check\n' +
      "import { DECLARED_ACTIONS } from './dist/api/registry.js';\n" +
      '\n' +
      "/** @type {readonly import('./dist/api/registry.js').ActionDef[]} */\n" +
      'export const widened = DECLARED_ACTIONS;\n',
  });
  assert.deepEqual(
    found,
    [],
    'a declared action is no longer assignable to the open `ActionDef`. The change has stopped being ' +
      'additive: the undeclared actions cannot share a list with it, and `ACTIONS` itself will ' +
      `not type. Got: ${JSON.stringify(found)}`,
  );
});

test('an interface-declared payload is refused, which is the trap src/core/result.ts records', () => {
  // Not decoration, and not a restatement of `result.ts`'s own note: it is that note checked against
  // the CONTAINER this change added. `Ok<T>` constrains `T` to `Record<string, unknown>`, and
  // TypeScript grants the implicit index signature to anonymous object types while withholding it
  // from interfaces, so a payload declared as an interface fails the constraint outright. Proving the
  // refusal is what stops the next conversion reaching for `interface FooOk { ... }` and then
  // reaching for a cast to get past the wall it hits.
  const refused = diagnosticsFor({
    'probe-interface-payload.ts':
      "import type { ActionDef } from './dist/api/registry.js';\n" +
      '\n' +
      'interface InterfaceOk {\n' +
      '  readonly entryId: string;\n' +
      '}\n' +
      '\n' +
      "export type Bad = ActionDef<'x', InterfaceOk>;\n",
  });
  assert.ok(
    refused.some((d) => d.code === 2344),
    'an INTERFACE was accepted as a declared payload. That means `ActionDef`\'s payload parameter no ' +
      'longer carries the `OkFields` constraint, and with it goes the guarantee that a declared ' +
      'action stays assignable to the open `ActionDef`. See the note in `src/core/result.ts`. ' +
      `Got: ${JSON.stringify(refused)}`,
  );

  // And the type-ALIAS spelling of the identical shape is accepted, so the test above is about the
  // interface and not about the probe failing to compile for some unrelated reason.
  const accepted = diagnosticsFor({
    'probe-alias-payload.ts':
      "import type { ActionDef } from './dist/api/registry.js';\n" +
      '\n' +
      'type AliasOk = {\n' +
      '  readonly entryId: string;\n' +
      '};\n' +
      '\n' +
      "export type Good = ActionDef<'x', AliasOk>;\n",
  });
  assert.deepEqual(
    accepted,
    [],
    'the type-ALIAS spelling of a declared payload was refused too, so the refusal above is not ' +
      `about interfaces at all and proves nothing. Got: ${JSON.stringify(accepted)}`,
  );
});

// -------------------------------------------------------------------------------------------
// 3. The type map and the runtime list agree
// -------------------------------------------------------------------------------------------

test('the keys of ActionResults are exactly the actions the dispatcher declares', () => {
  // Read through the type checker, then compared against the RUNTIME list. A hand-written map, or one
  // that silently lost an entry to the `PinnedAction` filter (a payload that widened back to the open
  // shape), passes every other test in this file and fails here.
  const options = testOptions();
  const program = ts.createProgram([REGISTRY_DTS], options);
  const source = program.getSourceFile(REGISTRY_DTS);
  assert.ok(source !== undefined, `${relative(ROOT, REGISTRY_DTS)} is not in the program`);

  const declaration = source.statements.find(
    /** @returns {statement is import('typescript').TypeAliasDeclaration} */
    (statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === 'ActionResults',
  );
  assert.ok(declaration !== undefined, '`ActionResults` is not declared in the emitted registry types');

  const checker = program.getTypeChecker();
  const keys = checker
    .getTypeAtLocation(declaration.name)
    .getProperties()
    .map((p) => p.getName())
    .sort();

  assert.deepEqual(
    keys,
    DECLARED_ACTIONS.map((a) => a.name).sort(),
    'the type map and the dispatcher disagree about which actions declare a payload. The map is ' +
      'meant to be DERIVED from `DECLARED_ACTIONS`; if it has drifted, something is restating the ' +
      'binding by hand, or an entry lost its declaration and was filtered out silently.',
  );

  assert.ok(
    keys.length >= DECLARED_FLOOR,
    `${keys.length} action(s) bound to a declared payload at the dispatcher, and the recorded floor ` +
      `is ${DECLARED_FLOOR}. Conversion is per verb and lands one slice at a time; it does not go ` +
      'backwards. Raise DECLARED_FLOOR when you convert more, never lower it.',
  );
});

// -------------------------------------------------------------------------------------------
// 4. The size of the remaining hole, stated as a measurement
// -------------------------------------------------------------------------------------------

test('an UNDECLARED action has no entry at the wire at all: this is the hole that is left', () => {
  // Not a wish, a measurement. 104 of the 110 verb signatures still return the open `Result`, so
  // their actions are not in the map and naming one is an error about the KEY, not about the field.
  // This test fails the day `delete_draft` gains an entry, which cannot happen until `PinnedAction`
  // learns to tell an empty declared payload from the open default.
  assert.equal(
    DECLARED_ACTIONS.find((a) => a.name === UNDECLARED.action),
    undefined,
    `${UNDECLARED.action} appears to have declared its payload. Good: raise DECLARED_FLOOR and point ` +
      'this probe at an action that still returns the open Result.',
  );

  const found = diagnosticsFor({
    'probe-wire-open-payload.mjs': wireConsumerReading(UNDECLARED.action, 'fieldThatDoesNotExist'),
  });
  assert.ok(
    found.some((d) => d.code === 2339),
    `naming \`${UNDECLARED.action}\` in \`ActionResults\` produced no diagnostic. If that action now ` +
      'has an entry, the measurement above is stale. Got: ' +
      JSON.stringify(found),
  );
});
