// @ts-check
/**
 * The RENAME GUARD for the engine's success payload, and the ratchet over how many verbs have one.
 *
 * THE DEFECT THIS EXISTS FOR. `src/core/result.ts` declared `Ok` as one open shape for every verb:
 * `{ ok: true }` plus `[key: string]: unknown`. So `postEntry(...).entryId` was `unknown` to the
 * suites, to the MCP layer and to the Studio alike, and renaming that field to `journalEntryId` kept
 * `tsc` green across all three while the drawer rendered `undefined` at runtime. That is the
 * structural root of this repo's longest-running defect family, "the Studio assumed a shape the
 * engine never sends", whose members include a picker rendering "1000 undefined" in a live browser
 * with its unit test green.
 *
 * `Ok<T>` / `Result<T>` close it per verb: a DECLARED payload is a closed object type, so reading a
 * field it does not carry is TS2339 at the call site. `postEntry` is the first verb converted.
 *
 * WHY THIS IS A COMPILER TEST AND NOT AN ASSERTION ABOUT SOURCE TEXT. A guard that greps
 * `postEntry.ts` for the string `Result<PostEntryOk>` proves someone typed it, which is the failure
 * mode this repo has already collected: a compile-time pin that was inert because its file sat
 * outside `tsc` AND its casts erased the types it claimed to hold. So this compiles real consumer
 * code against the REAL emitted `dist/**\/*.d.ts` through the REAL resolved options of
 * `tsconfig.test.json`, and asserts the diagnostics. The technique is taken from
 * `root-tests-are-type-checked.test.mjs`, which proves its own mechanism the same way.
 *
 * WHAT IT DELIBERATELY ALSO ASSERTS: that the same read off an UNDECLARED verb is still silent. That
 * is not a gap being hidden, it is the size of the hole stated as a number. 104 of the 110 verb
 * signatures still return the open `Result`, and for those the runtime narrowers in
 * `test/support/narrow.mjs` are the only thing pinning a payload at all.
 *
 * THE 110 IS RE-MEASURED, NOT INHERITED. The prose in this repo has carried 103, then 108, then 107,
 * each written down as fact and each wrong, because the container signature was miscounted and
 * because nobody re-ran the census after `dist/` changed shape. Run `signatureCensus()` before
 * quoting a number from here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CONFIG = join(ROOT, 'tsconfig.test.json');

/**
 * The pilot verb, and the field the defect family is named after. The string-keyed narrower probe
 * below stays pointed at this one, because `test/support/narrow.mjs` is where the 48 string-named
 * reads live and `entryId` is the field they name.
 */
const PILOT = {
  module: './dist/core/ledger/postEntry.js',
  verb: 'postEntry',
  field: 'entryId',
  absent: 'journalEntryId',
};

/**
 * EVERY verb that has declared its payload, each with a field it carries and a field it does not.
 *
 * A LIST rather than a single pilot, because a floor that only counts is a floor that can be met by
 * a declaration nobody checks. Each entry is compiled twice below: once reading the field it does
 * carry (which must be silent) and once reading a field it does not (which must be TS2339). So
 * adding a row here is the act that puts a conversion under guard, and the count of rows is asserted
 * against the census, so a verb declared and not listed makes this suite red rather than slack.
 *
 * `resolveFxRate` is the ONE rate surface: `postEntry`, `recordPayment`, `issueInvoice` and
 * `getExchangeRate` all price money through it. All four wrote `resolution.resolved as ResolvedRate`
 * to get at the answer, because an open `Result` made the field `unknown`. Those four casts are gone
 * with this declaration, which is the point: an assertion is a promise the compiler stops checking.
 */
const CONVERTED = [
  PILOT,
  // A38. The accrual post answers BOTH ids of the pair, and the Studio reads `reversalEntryId` for
  // the "Rückbuchung am" line; `reversalId` is the name `reverseEntry` uses one call down, which is
  // exactly the neighbour a consumer would reach for. The Storno answers the MIRROR pair's ids, so
  // `stornoEntryId` and never `entryId` (that is A, which the Storno does not mint). The release's
  // `openBalanceMinor` is the figure the provisions list renders; `openBalance` is the francs read.
  { module: './dist/core/accruals/accrual.js', verb: 'accrualPost', field: 'reversalEntryId', absent: 'reversalId' },
  { module: './dist/core/accruals/accrual.js', verb: 'accrualReverse', field: 'stornoEntryId', absent: 'entryId' },
  { module: './dist/core/accruals/provision.js', verb: 'provisionRelease', field: 'openBalanceMinor', absent: 'openBalance' },
  // The release undo answers the MIRROR's id as `reversalEntryId` (the Studio's name for the pair's
  // other half); `reversalId` is what `reverseOwnedEntry` answers one call down.
  { module: './dist/core/accruals/provision.js', verb: 'provisionReleaseReverse', field: 'reversalEntryId', absent: 'reversalId' },
  {
    module: './dist/core/fx/rates.js',
    verb: 'resolveFxRate',
    field: 'resolved',
    absent: 'resolvedRate',
  },
  // The A02/A03 front door. `reverseEntry` answers `reversalId` and not `entryId`, which is the
  // pairing the Studio was previously free to get wrong: its two neighbours in the action list both
  // answer `entryId`, and the open `Result` had no opinion about which name arrived.
  {
    module: './dist/core/ledger/reverseEntry.js',
    verb: 'reverseEntry',
    field: 'reversalId',
    absent: 'entryId',
  },
  // The OWNED reversal (A38, critic finding 2026-09-09): the entry point `vat_settlement_reverse`
  // reaches the mirror through, answering the same `reversalId` as `reverseEntry` and never `entryId`.
  { module: './dist/core/ledger/reverseEntry.js', verb: 'reverseOwnedEntry', field: 'reversalId', absent: 'entryId' },
  { module: './dist/core/ledger/draft.js', verb: 'saveDraft', field: 'entryId', absent: 'draftId' },
  // G22's engine-side prompt renderer answers `text` (and the open item ids), never a `runId` the
  // way `checklist_get` does: the MCP handler reads `text`, and a rename there is exactly the
  // prompt-versus-verb drift the parity test exists to stop.
  { module: './dist/core/checklists/prompt.js', verb: 'renderChecklistPrompt', field: 'text', absent: 'prompt' },
  // G22 leg 2's period resolution answers the run's bounds as `periodStart` / `periodEnd` (the
  // names the run row, the prompt and the A07 period read all share), never `start`: the templates
  // and the seeded auto-start rule read these names, and a rename here would silently re-date a run.
  { module: './dist/core/checklists/periods.js', verb: 'resolveChecklistPeriod', field: 'periodStart', absent: 'start' },
  { module: './dist/core/ledger/reads.js', verb: 'getEntry', field: 'entry', absent: 'journalEntry' },
  { module: './dist/core/ledger/reads.js', verb: 'listJournal', field: 'entries', absent: 'rows' },
  // A38's MWST-Saldierung model (D129 leg 2): the ONE function the preview returns and the post writes,
  // so its shape is the contract between the two faces. `lines` is what the poster books; `entries` is
  // the read a caller writes when it mistakes the model for a journal listing.
  { module: './dist/core/accruals/vatSettlement.js', verb: 'settlementModelOf', field: 'lines', absent: 'entries' },
  // A03's lock read. `canManage` is not an arbitrary absent name: it is one of the two fields
  // `Periods.tsx` actually gated its controls on, off a verb that answers `ok({ locks })` and never
  // sent either. Probing the real phantom keeps this row tied to the defect instead of to a
  // plausible-looking stand-in.
  {
    module: './dist/core/ledger/periods.js',
    verb: 'listPeriodLocks',
    field: 'locks',
    absent: 'canManage',
  },
  // A19's opening-balance preview, whose whole reason for existing is that the figure it shows an
  // operator is the figure the posting then writes. `baseAmountMinor` is that figure. The absent name
  // is `baseAmount` rather than something invented: dropping the `Minor` suffix is exactly the read a
  // caller writes when it forgets the amount is integer Rappen and starts treating it as francs, and
  // an open Result would have handed that caller `undefined` at runtime instead of a compile error.
  {
    module: './dist/core/banking/bankAccounts.js',
    verb: 'previewBankOpeningBalance',
    field: 'baseAmountMinor',
    absent: 'baseAmount',
  },
  // A21's scorer, the read both faces and the P8 gate consume. `match` is the payload; the absent
  // name is `score`, which is exactly what the Studio's own view model calls the same shape, so it
  // is the rename a surface author would reach for first and the one that must be a compile error.
  {
    module: './dist/core/banking/qrMatch.js',
    verb: 'matchIncomingByQrr',
    field: 'match',
    absent: 'score',
  },
  // A20's four declared verbs. Each absent name is the plausible rename a surface author would
  // reach for, the same discipline `matchIncomingByQrr` sets: `statementId` (never `id`, which every
  // other row-echoing verb on this surface would shadow), `bankTxnId` (never `txnId`, the shorter
  // form a Studio author copying A21's `creditId` naming would reach for), `entryId` (never
  // `journalEntryId`, the `postEntry`/`reverseEntry` pairing this file's own header warns about), and
  // `matched` (never `matchedTxns`, the plural a caller expecting a bare array elsewhere would guess).
  {
    module: './dist/core/banking/camtReconcile.js',
    verb: 'importCamt',
    field: 'statementId',
    absent: 'id',
  },
  {
    module: './dist/core/banking/camtReconcile.js',
    verb: 'confirmCamtMatch',
    field: 'bankTxnId',
    absent: 'txnId',
  },
  {
    module: './dist/core/banking/camtReconcile.js',
    verb: 'createEntryForTxn',
    field: 'entryId',
    absent: 'journalEntryId',
  },
  {
    module: './dist/core/banking/camtReconcile.js',
    verb: 'listReconciliation',
    field: 'matched',
    absent: 'matchedTxns',
  },
  // F-03 (J3.3): the statement list the Studio's /reconciliation opens a board through. `statements`
  // is the field the surface reads; `items` is the name a caller guesses from the sibling lists.
  {
    module: './dist/core/banking/camtReconcile.js',
    verb: 'listBankStatements',
    field: 'statements',
    absent: 'items',
  },
  // A36's per-txn review emitter. `needsReviewTxnId` is the LOAD-BEARING field: the G01 registry
  // resolves `bank_txn.needs_review` off `result.needsReviewTxnId`, so a rename to the plausible
  // `needsReviewId` would silently null-collapse every occurrence and the event would never fire.
  {
    module: './dist/core/banking/camtReconcile.js',
    verb: 'reviewBankTxn',
    field: 'needsReviewTxnId',
    absent: 'needsReviewId',
  },
  // G03. `workspaceKind` is what the shell demo banner keys on, and `kind` is exactly the read a
  // caller writes after seeing the workspace row's own column name: the open Result would have
  // handed that caller `undefined` and a banner that never renders.
  {
    module: './dist/core/onboarding/progress.js',
    verb: 'getOnboardingProgress',
    field: 'workspaceKind',
    absent: 'kind',
  },
  // The advance echoes the row it wrote. `completed` is the INPUT flag's name; the payload carries
  // the stamped `completedAt`, and confusing the two is the plausible wrong read.
  {
    module: './dist/core/onboarding/progress.js',
    verb: 'advanceOnboardingStep',
    field: 'completedAt',
    absent: 'completed',
  },
  // The demo mint answers `workspaceId` like its create_workspace parent; `demoWorkspaceId` is the
  // near-miss a caller invents from the verb's own name.
  {
    module: './dist/core/onboarding/demo.js',
    verb: 'createDemoWorkspace',
    field: 'workspaceId',
    absent: 'demoWorkspaceId',
  },
  // The discard answers `discardedWorkspaceId` (the discard_testmandant pairing); `workspaceId` is
  // the INPUT field's name and is deliberately not echoed, so reading it back is the wrong read.
  {
    module: './dist/core/onboarding/demo.js',
    verb: 'discardDemoWorkspace',
    field: 'discardedWorkspaceId',
    absent: 'workspaceId',
  },
  // G06's eight verbs, declared at birth. Each absent name is the plausible rename a surface
  // author would reach for: the deliver echoes `notificationId` (never `inboxItemId`, the table's
  // own name), the list answers `items` + `unreadCount` (never `notifications`, the verb's own
  // noun), the mutations echo `notificationId` (never `id`), `markAllRead` answers `markedCount`
  // (never `count`), the preference verbs answer `preference`/`preferences` (never `pref`/`prefs`,
  // the table's abbreviated name), and the digest answers `digestRunId` (never `runId`, the G01
  // automation-run naming one door over).
  {
    module: './dist/core/notifications/notifications.js',
    verb: 'deliverNotification',
    field: 'notificationId',
    absent: 'inboxItemId',
  },
  {
    module: './dist/core/notifications/notifications.js',
    verb: 'listInbox',
    field: 'unreadCount',
    absent: 'notifications',
  },
  {
    module: './dist/core/notifications/notifications.js',
    verb: 'markRead',
    field: 'notificationId',
    absent: 'id',
  },
  {
    module: './dist/core/notifications/notifications.js',
    verb: 'markAllRead',
    field: 'markedCount',
    absent: 'count',
  },
  {
    module: './dist/core/notifications/notifications.js',
    verb: 'archiveNotification',
    field: 'notificationId',
    absent: 'id',
  },
  {
    module: './dist/core/notifications/notifications.js',
    verb: 'setPreference',
    field: 'preference',
    absent: 'pref',
  },
  {
    module: './dist/core/notifications/notifications.js',
    verb: 'listPreferences',
    field: 'preferences',
    absent: 'prefs',
  },
  {
    module: './dist/core/notifications/notifications.js',
    verb: 'runDigest',
    field: 'digestRunId',
    absent: 'runId',
  },
  // M03's move pointer pair. Both answer `ok({ move })` (a `MoveState | null`); `moveState` is the
  // read a caller writes after seeing the type name, and an open Result would have handed it
  // `undefined` instead of a compile error.
  { module: './dist/core/move/state.js', verb: 'getMoveState', field: 'move', absent: 'moveState' },
  {
    module: './dist/core/move/state.js',
    verb: 'advanceMoveStep',
    field: 'move',
    absent: 'moveState',
  },
];

/**
 * A verb that has NOT declared one, used to state the limit of this guard honestly.
 *
 * `deleteDraft` rather than `saveDraft` since 2026-07-26. It is not merely the next open verb to
 * hand: it is the one that CANNOT be converted the way the others were. It answers `ok()` with no
 * fields, and an empty payload is not narrower than the open default as far as `PinnedAction` in
 * `src/api/registry.ts` can tell (`OkFields extends {}` is true), so declaring it would raise this
 * census while leaving the wire map unchanged.
 */
const UNDECLARED = { module: './dist/core/ledger/draft.js', verb: 'deleteDraft' };

/** The floor for declared payloads. Raise it, deliberately, with each verb converted. */
const DECLARED_FLOOR = 37;

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
 * A local copy of the helper in `root-tests-are-type-checked.test.mjs` rather than an import: that
 * file is a guard, not a library, and giving it an export surface for this one would couple two
 * independent gates. The duplication is 20 lines and both copies are exercised every run.
 *
 * The sources never touch disk, but they are named UNDER the repo root so `rootDir` accepts them,
 * and everything they import (`dist/`, lib files, `@types/node`) is read normally. That is the whole
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
 * A consumer that reads `field` off whatever `verb` returns, with no engine call at all: the return
 * type is reached through `ReturnType`, so the probe tests the DECLARATION and needs no workspace,
 * no store and no fixture. A parameter rather than an uninitialised `let`, so definite assignment
 * does not add a diagnostic of its own and muddy the verdict.
 *
 * @param {{ module: string, verb: string }} target
 * @param {string} field
 */
function consumerReading(target, field) {
  return (
    '// @ts-check\n' +
    `import { ${target.verb} } from '${target.module}';\n` +
    '\n' +
    `/** @param {ReturnType<typeof ${target.verb}>} result */\n` +
    'export function read(result) {\n' +
    `  return result.${field};\n` +
    '}\n'
  );
}

/**
 * A consumer that reads a field through the shared narrower instead of by property access:
 * `id(result, 'entryId', 'postEntry')`.
 *
 * This is the OTHER half, and it is the half a property-access probe would miss entirely. 48 reads
 * across the root suites name their field as a STRING, where TS2339 has nothing to fire on. `id` is
 * keyed to `keyof T`, so a declared payload makes a wrong name a TS2345 argument error there too.
 *
 * @param {string} field
 */
function narrowerReading(field) {
  return (
    '// @ts-check\n' +
    `import { ${PILOT.verb} } from '${PILOT.module}';\n` +
    "import { id } from './test/support/narrow.mjs';\n" +
    '\n' +
    `/** @param {ReturnType<typeof ${PILOT.verb}>} result */\n` +
    'export function read(result) {\n' +
    `  return id(result, '${field}', '${PILOT.verb}');\n` +
    '}\n'
  );
}

/**
 * The one `): Result<...>;` in `dist/` that is NOT a verb making a promise: `ActionDef.run` in
 * `src/api/registry.ts`, whose payload is the interface's own type PARAMETER.
 *
 * It has to be named and subtracted, or the ratchet stops meaning what it says. When `ActionDef`
 * became generic on 2026-07-26 this signature flipped from `): Result;` to `): Result<T>;`, and the
 * census read 2 declared where exactly one VERB had been converted. `DECLARED_FLOOR` is 1, so from
 * that moment `postEntry` could have lost its payload entirely and this suite would still have gone
 * green: a container's parameter would have been standing in for the conversion it is meant to
 * count. Nothing about the dispatcher's change was wrong; the census was measuring the wrong thing,
 * and had been all along (the same line was previously counted among the OPEN signatures, which is
 * why the total has always been one higher than the number of verbs).
 */
const CONTAINER_SIGNATURE = '): Result<T>;';

/**
 * Every `): Result...;` the emitted declarations carry, split by whether a payload is named.
 *
 * Walks `dist/` from disk rather than asking git for it: `dist/` is gitignored, so every `git
 * ls-files` spelling of this returns an empty list and a census of nothing, passing.
 */
function signatureCensus() {
  const declarations = readdirSync(join(ROOT, 'dist'), { recursive: true, encoding: 'utf8' }).filter((f) =>
    f.endsWith('.d.ts'),
  );

  let open = 0;
  let declared = 0;
  let containers = 0;
  for (const file of declarations) {
    const text = readFileSync(join(ROOT, 'dist', file), 'utf8');
    // Only a RETURN position counts. `=> Result` inside a parameter type (the registry's `call`
    // helpers) is not a verb's own promise about what it sends back.
    for (const match of text.matchAll(/\): Result(<[^;]*>)?;/g)) {
      if (match[0] === CONTAINER_SIGNATURE) containers += 1;
      else if (match[1] === undefined) open += 1;
      else declared += 1;
    }
  }
  return { open, declared, containers, total: open + declared };
}

// -------------------------------------------------------------------------------------------
// The corpus is real
// -------------------------------------------------------------------------------------------

test('the corpus is real: dist carries emitted declarations and the pilot is among them', () => {
  const pilot = join(ROOT, 'dist/core/ledger/postEntry.d.ts');
  assert.ok(
    existsSync(pilot),
    `${relative(ROOT, pilot)} does not exist. \`npm test\` builds dist first (pretest); if this ` +
      'fails, the build did not run and every verdict below would be about nothing.',
  );

  const census = signatureCensus();
  assert.ok(
    census.total >= 100,
    `only ${census.total} \`): Result\` signatures found across dist: the census regex is not ` +
      'matching the emitted declarations, so the ratchet below is scenery',
  );

  // The subtraction is asserted, not trusted. If a second generic container appears the count below
  // is quietly wrong again, and if the dispatcher's `run` stops matching, `declared` silently gains
  // one and the ratchet goes slack by exactly the amount it is meant to measure.
  assert.equal(
    census.containers,
    1,
    `${census.containers} generic \`${CONTAINER_SIGNATURE}\` signatures in dist, expected exactly ` +
      'one (`ActionDef.run`). A container parameterised over its payload is not a verb declaring ' +
      'one, and counting it as such is how this ratchet would pass with the pilot reverted.',
  );
});

// -------------------------------------------------------------------------------------------
// The mechanism proves itself, every run
// -------------------------------------------------------------------------------------------

/**
 * The two codes TypeScript uses for "this property does not exist on that type".
 *
 * TS2339 is the plain refusal. TS2551 is the SAME refusal with a spelling suggestion attached, and
 * the checker picks it whenever the absent name is close enough to a real one. Measured here on
 * 2026-07-26: `journalEntryId` against `PostEntryOk` reports 2339, while `resolvedRate` against
 * `ResolveFxRateOk` reports 2551, "Did you mean 'resolved'?". A probe that accepts only 2339 fails
 * on the more realistic rename, which is the wrong way round, and it fails by accusing the code
 * rather than itself. Both codes are the guard firing.
 */
const PROPERTY_DOES_NOT_EXIST = [2339, 2551];

for (const target of CONVERTED) {
  test(`a DECLARED payload makes a renamed field a compile error at the call site: ${target.verb}`, () => {
    // The exact scenario the defect family is named for: someone renames a field in the engine, and
    // every consumer that still reads the old name must stop compiling. `absent` stands in for the
    // new name; what is asserted is that a field the payload does not carry is refused.
    const found = diagnosticsFor({ 'probe-renamed-field.mjs': consumerReading(target, target.absent) });
    assert.ok(
      found.some((d) => PROPERTY_DOES_NOT_EXIST.includes(d.code) && d.text.includes(target.absent)),
      `reading a field \`${target.verb}\`'s payload does not declare was NOT a compile error. The ` +
        'payload declaration is gone, inert, or widened back to an index signature, and with it the ' +
        'only thing standing between a renamed engine field and an `undefined` in the Studio. Got: ' +
        JSON.stringify(found),
    );
  });

  test(`and the field it DOES declare still reads clean, so the guard is not just refusing everything: ${target.verb}`, () => {
    const found = diagnosticsFor({ 'probe-declared-field.mjs': consumerReading(target, target.field) });
    assert.deepEqual(
      found,
      [],
      `reading \`${target.field}\`, which \`${target.verb}\`'s payload declares, produced ` +
        'diagnostics. Either the field was renamed without this guard being updated, or the probe is ' +
        'broken and the test above is passing for the wrong reason.',
    );
  });
}

test('the string-keyed narrower is keyed too, so the 48 `id(result, "field")` reads are covered', () => {
  const found = diagnosticsFor({ 'probe-narrower-wrong-key.mjs': narrowerReading('journalEntryId') });
  assert.ok(
    found.some((d) => d.code === 2345 && d.text.includes('journalEntryId')),
    'naming a field the declared payload does not carry was accepted by `id`. That is the escape ' +
      'hatch a property-access guard cannot see: a field name passed as a string. `id` must stay ' +
      `keyed to \`keyof T\`. Got: ${JSON.stringify(found)}`,
  );

  const clean = diagnosticsFor({ 'probe-narrower-right-key.mjs': narrowerReading(PILOT.field) });
  assert.deepEqual(clean, [], `\`id(result, '${PILOT.field}')\` errored, so the test above proves nothing`);
});

test('the same read off an UNDECLARED verb is still silent: this is the size of the remaining hole', () => {
  // Not a wish, a measurement. `saveDraft` still returns the open `Result`, whose index signature
  // answers for every field name, so the identical mistake against it is invisible. This test fails
  // the day `saveDraft` declares a payload, which is the day to raise DECLARED_FLOOR and delete it.
  const found = diagnosticsFor({ 'probe-open-payload.mjs': consumerReading(UNDECLARED, 'fieldThatDoesNotExist') });
  assert.deepEqual(
    found,
    [],
    `${UNDECLARED.verb} appears to have declared its payload. Good: move it into the declared set, ` +
      `raise DECLARED_FLOOR, and point this probe at a verb that still returns the open Result.`,
  );
});

test('mechanism: the probe is judged at all, so a silent verdict means silence and not blindness', () => {
  // Everything above reads a deepEqual of [] as proof. That reading is only safe if this compiler
  // configuration actually reports errors in a synthetic .mjs, which is what a wrong probe path or a
  // dropped `// @ts-check` would quietly take away.
  const found = diagnosticsFor({
    'probe-obviously-wrong.mjs': '// @ts-check\nexport const bad = (1).toFixed(\'not a number\');\n',
  });
  assert.ok(
    found.some((d) => d.code === 2345),
    `a source with an unambiguous type error reported nothing: the probe is not being checked, and ` +
      `every empty result above proves nothing. Got: ${JSON.stringify(found)}`,
  );

  const unpragmad = diagnosticsFor({ 'probe-no-pragma.mjs': 'export const bad = (1).toFixed(\'not a number\');\n' });
  assert.deepEqual(unpragmad, [], 'a .mjs without `// @ts-check` was judged: the probes must carry the pragma');
});

// -------------------------------------------------------------------------------------------
// The ratchet
// -------------------------------------------------------------------------------------------

test('the count of verbs with a declared payload never falls', () => {
  const { declared, open, total } = signatureCensus();
  assert.ok(
    declared >= DECLARED_FLOOR,
    `${declared} of ${total} verb signatures declare a success payload, and the recorded floor is ` +
      `${DECLARED_FLOOR}. Conversion is per verb and lands one slice at a time; it does not go ` +
      'backwards. If a verb genuinely lost its payload, that is the finding.',
  );
  // Stated, not asserted upward: this is a starting position, and pretending otherwise in a green
  // test is how a partial capability gets reported as a complete one.
  assert.ok(
    open > 0,
    `every one of the ${total} signatures now declares a payload. If that is real, delete this ` +
      'assertion and the undeclared probe above with it.',
  );
});

test('every declared payload is under a rename probe, so the floor counts guards and not annotations', () => {
  // The floor above counts SIGNATURES. On its own that is satisfied by a `Result<FooOk>` nothing
  // reads, which is a type annotation and not a guard: the brief for this work says so in as many
  // words, and this repo has already shipped a compile-time pin that was inert twice over. Tying the
  // census to `CONVERTED` means a verb can only be counted once a probe above compiles a real read
  // against it, in both directions.
  const { declared } = signatureCensus();
  assert.equal(
    declared,
    CONVERTED.length,
    `${declared} verb signatures declare a payload but ${CONVERTED.length} are listed in ` +
      '`CONVERTED`. A declared payload nobody probes is an annotation. Add the verb to `CONVERTED` ' +
      'with a field it carries and a field it does not, and raise `DECLARED_FLOOR` to match.',
  );
  assert.equal(
    CONVERTED.length,
    DECLARED_FLOOR,
    `\`DECLARED_FLOOR\` is ${DECLARED_FLOOR} and ${CONVERTED.length} verbs are probed. The floor is ` +
      'the recorded number: raise it in the same commit as the conversion.',
  );
});
