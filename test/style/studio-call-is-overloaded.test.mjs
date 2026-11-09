/**
 * THE LAST LINK: `TillClient.call` resolves a declared action name to that action's payload.
 *
 * WHY THIS SUITE EXISTS SEPARATELY FROM `studio-sees-payloads.test.mjs`. That suite proves the
 * payload MAP is real: `Ok<ActionPayloads['post_entry']>` refuses a field the engine renamed, the
 * types are the engine's own, and no engine module reaches the bundle. Every one of its verdicts was
 * green on 2026-07-26 while the Studio consumed NONE of it. `call` was typed
 * `(action: string, ...) => Promise<RestResponse>`, `RestResponse`'s payload defaulted to the open
 * `OkFields`, and `OkFields` carries an index signature that answers for every field name. So
 * `ActionPayloads` was correct, derived, guarded, and read by exactly one file
 * (`lib/test-support.ts`, for canned doubles) while all 83 real call sites went on seeing the open
 * shape.
 *
 * That is what let `Journal.tsx` read `body.canPost` off `list_journal` for the life of the surface.
 * `grep -rn canPost src/` finds nothing: the engine has never sent the field, `listJournal` answers
 * `ok({ entries })`, and `undefined !== false` is `true`, so the gate on Post, Save draft and Reverse
 * stood open in every build that ever shipped. A guard on the map could not see it, because the
 * defect was not in the map. It was in the one type that decided whether anything consumed the map.
 *
 * So the assertions below are about `call` itself, and they are the ones that would have gone red on
 * `canPost` alone. If someone widens the first overload back to `string`, or deletes it, the map stays
 * perfect and every other guard in this repo stays green: only this file fails.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const APP = join(ROOT, 'app');
const CONFIG = join(APP, 'tsconfig.json');
const CONFIG_REL = 'app/tsconfig.json';

/**
 * The action the probes are written against, and a field it does NOT carry.
 *
 * `list_journal` and `canPost` deliberately, because that is the real defect this link caught rather
 * than a synthetic stand-in: the payload is `{ entries }` and `canPost` is the phantom the Studio
 * used to read off it.
 */
const PILOT = { action: 'list_journal', field: 'entries', absent: 'canPost' };

/**
 * The two codes TypeScript uses for "this property does not exist on that type".
 *
 * TS2339 is the plain refusal; TS2551 is the same refusal with a spelling suggestion attached, which
 * the checker prefers whenever the absent name is close to a real one. A rename (the realistic case)
 * tends to produce 2551, so a probe accepting only 2339 fails on the very scenario it exists for, and
 * fails by accusing the code rather than itself. Both codes are the guard firing.
 */
const PROPERTY_DOES_NOT_EXIST = [2339, 2551];

/** The resolved compiler options of `app/tsconfig.json` (JSONC: it carries comments). */
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
 * Named UNDER `app/` so their relative imports resolve exactly as a real Studio module's would, and
 * everything they reach (`app/src/lib/*`, the engine source, `@types/*`) is read from disk. The
 * verdict therefore comes from the real files and not from a restatement of them.
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
 * A Studio surface that awaits `client.call(<action>)` and reads `field` off the success body.
 *
 * Reached through `TillClient` itself, never through `ActionPayloads`, which is the entire point: the
 * old suite's probe named the payload type directly and so could not tell a consumed map from an
 * ignored one. This probe goes the way a surface goes.
 *
 * @param {string} action
 * @param {string} field
 */
function surfaceReading(action, field) {
  return (
    "import type { TillClient } from './src/lib/client';\n" +
    "import { isErr } from './src/lib/client';\n" +
    '\n' +
    'export async function read(client: TillClient) {\n' +
    `  const { body } = await client.call('${action}', {});\n` +
    '  if (isErr(body)) return undefined;\n' +
    `  return body.${field};\n` +
    '}\n'
  );
}

// -------------------------------------------------------------------------------------------
// The corpus is real
// -------------------------------------------------------------------------------------------

test('mechanism: the probe is judged at all, so a clean verdict means agreement and not blindness', () => {
  // The trap this repo has been bitten by more than once: a probe that is never type-checked reports
  // "no errors" forever. On 2026-07-26 a scratch probe placed at `app/probe.ts` compiled clean while
  // returning a mutable array from a readonly one, because `app/tsconfig.json` includes only `src`.
  // A deliberate error proves the pipeline reaches this source before anything reads silence as a
  // verdict.
  const found = diagnosticsFor({
    'probe-mechanism.ts': 'export const broken: number = "not a number";\n',
  });
  assert.ok(
    found.some((d) => d.code === 2322),
    'a deliberately ill-typed probe produced no TS2322, so these synthetic sources are not being ' +
      `type-checked and every other verdict in this file is silence mistaken for agreement. Got: ${JSON.stringify(found)}`,
  );
});

// -------------------------------------------------------------------------------------------
// The overload does its job
// -------------------------------------------------------------------------------------------

test('a field the action does NOT declare is a compile error at a Studio call site', () => {
  const found = diagnosticsFor({
    'probe-absent-field.ts': surfaceReading(PILOT.action, PILOT.absent),
  });
  assert.ok(
    found.some((d) => PROPERTY_DOES_NOT_EXIST.includes(d.code) && d.text.includes(PILOT.absent)),
    `reading \`${PILOT.absent}\` off \`${PILOT.action}\` was NOT a compile error. \`call\` has been ` +
      'widened back to a bare `string`, or its first overload is gone, and with it the only thing ' +
      'that ties a Studio call site to the payload the engine actually sends. This is the exact ' +
      'state the Studio was in until 2026-07-26, when a permission gate read a field the engine ' +
      `has never sent and stood open for the life of the surface. Got: ${JSON.stringify(found)}`,
  );
});

test('and the field it DOES declare still reads clean, so the guard is not just refusing everything', () => {
  const found = diagnosticsFor({
    'probe-declared-field.ts': surfaceReading(PILOT.action, PILOT.field),
  });
  assert.deepEqual(
    found,
    [],
    `reading \`${PILOT.field}\`, which \`${PILOT.action}\` DOES declare, produced diagnostics. A guard ` +
      'that refuses every field is not proving the binding, it is just broken, and the test above ' +
      `would pass on a payload of nothing at all. Got: ${JSON.stringify(found)}`,
  );
});

test('the overload is ADDITIVE: an undeclared action keeps the open body it always had', () => {
  // 104 of the engine's 110 result signatures are still open, and the Studio calls plenty of them.
  // If the second overload were lost, every one of those call sites would stop compiling at once, so
  // this is not a formality: it is the assertion that says the change was safe to land at all.
  const found = diagnosticsFor({
    'probe-open-action.ts': surfaceReading('list_accounts', 'accounts'),
  });
  assert.deepEqual(
    found,
    [],
    'reading a field off an UNDECLARED action produced diagnostics. The open fallback overload on ' +
      '`call` is gone, so the 104 verbs that have not declared a payload are no longer callable the ' +
      `way they always were. Declaring a payload must stay a per-verb decision. Got: ${JSON.stringify(found)}`,
  );
});

test('a call site passing a string VARIABLE still resolves, and still sees the open body', () => {
  // `useSaver` in `Setup/CompanyProfile.tsx` and `runWrite` in `Periods/Periods.tsx` both dispatch an
  // action held in a `string`. A first overload keyed on `keyof ActionPayloads` must not capture
  // them: a bare `string` is not assignable to that union, so they have to fall to the open
  // signature. If they stopped resolving, the overload would be a source-breaking change wearing an
  // additive label.
  const found = diagnosticsFor({
    'probe-dynamic-action.ts':
      "import type { TillClient } from './src/lib/client';\n" +
      "import { isErr } from './src/lib/client';\n" +
      '\n' +
      'export async function write(client: TillClient, action: string) {\n' +
      '  const { body } = await client.call(action, { workspaceId: "ws" });\n' +
      '  return isErr(body) ? undefined : body.anything;\n' +
      '}\n',
  });
  assert.deepEqual(
    found,
    [],
    'dispatching an action held in a `string` no longer type-checks. The open overload on `call` has ' +
      'been narrowed or removed, and the two dynamic dispatchers in the Studio (`useSaver`, ' +
      `\`runWrite\`) are broken by it. Got: ${JSON.stringify(found)}`,
  );
});
