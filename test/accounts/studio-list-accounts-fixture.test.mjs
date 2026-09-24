/**
 * The A01 STUDIO `list_accounts` fixture-versus-engine drift guard.
 *
 * This closes the mechanism behind a defect family this repo has now shipped six times: "the Studio
 * assumed a shape the engine never sends". The sixth member was `PaymentAllocator.tsx` rendering
 * `${account.number} ${account.label}` and printing "1000 undefined" in a live browser, because
 * `list_accounts` answers `name` and has no `label` key at all. The unit test stayed green because
 * its hand-written fixture set BOTH keys, and a fixture more generous than the engine is what lets
 * this family recur.
 *
 * `test/payments/studio-payments-fixture.test.mjs` armed the guard for the Payments surface. Three
 * more surfaces consumed `list_accounts` from hand-written literals with no guard at all: Journal,
 * Items and Accounts. They now share ONE fixture, and that fixture is a recording rather than a
 * literal (`capture-studio-list-accounts.mjs`).
 *
 * ## Three halves, and all of them have to hold
 *
 *   1. PRESENT: the recording is the live answer, value for value. Not keys and kinds. The
 *      `test/sales/invoice-gui-fixture.test.mjs` lesson is that a keys-and-kinds comparison let a
 *      fixture spelling Zürich in ASCII sit against a seed spelling it with the umlaut and pass 6/6
 *      green. That is precisely the drift found here: every account name in all three surfaces was
 *      wrong, and every kind matched.
 *   2. ABSENT: the engine does NOT send `label`. The present half alone would not have caught the
 *      sixth defect, because `name` was there all along.
 *   3. DECLARED: the `Account` interface each surface re-declares for the browser bundle names only
 *      keys the engine really sends. This is the half that fails at the TYPE, before a fixture is
 *      even written.
 *
 * Every scan asserts its own corpus is non-empty, so a broken glob or a renamed file cannot make
 * this file pass by finding nothing. The suite scan goes further and DERIVES its corpus from the
 * tree (every Studio suite that mentions the verb), because the hand-written list it replaced went
 * stale the first time a sixth suite was armed. See that test for why the selecting property has to
 * be a different one from the asserted property.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { KMU_CORE_SEED } from '../../dist/core/accounts/index.js';
import { liveListAccounts, POSTED_DEBIT, POSTED_CREDIT } from './studio-list-accounts-world.mjs';
import { cleanGitEnv } from '../lib/git-env.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const APP = new URL('../../app/src/surfaces/', import.meta.url);
const FIXTURE = JSON.parse(readFileSync(new URL('Accounts/list-accounts.fixture.json', APP), 'utf8'));

/** The keys `mapAccount` (`src/core/accounts/accounts.ts`) plus `listAccounts` actually emit. */
const ENGINE_KEYS = [
  'archived',
  'costCenterAllowed',
  'id',
  'inUse',
  'name',
  'number',
  'type',
  'vatCodeDefault',
  'workspaceId',
];

/**
 * Every file that re-declares an account row for the browser bundle. The Studio cannot import engine
 * code (better-sqlite3 is native and Node-only), so each surface writes the shape out by hand, which
 * is exactly where an invented key gets in.
 */
const DECLARATIONS = [
  ['Journal/types.ts', 'Account'],
  ['Items/model.ts', 'Account'],
  ['Accounts/model.ts', 'Account'],
];

/** The field names of `export interface <name> { ... }`, read as text. */
function declaredFields(relative, interfaceName) {
  const source = readFileSync(new URL(relative, APP), 'utf8');
  const opened = source.indexOf(`export interface ${interfaceName} {`);
  assert.notEqual(opened, -1, `${relative}: no \`export interface ${interfaceName}\` to read`);
  const start = source.indexOf('{', opened) + 1;
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, `${relative}: \`${interfaceName}\` has no closing brace on its own line`);
  const body = source.slice(start, end);
  const fields = [...body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm)].map(([, field]) => field);
  assert.ok(fields.length > 0, `${relative}: \`${interfaceName}\` declares no fields, so the scan is broken`);
  return fields;
}

test('the recording IS the live list_accounts answer, value for value', () => {
  const live = liveListAccounts();

  // Corpus, asserted before anything is compared: an empty chart would make every loop below pass
  // by iterating nothing, which is the shape of the vacuous test this repo keeps finding.
  assert.equal(
    live.accounts.length,
    KMU_CORE_SEED.length,
    'the world must answer with the whole shipped KMU chart',
  );
  assert.ok(live.accounts.length > 0, 'the live chart is empty, so nothing below proves anything');
  assert.equal(FIXTURE.accounts.length, live.accounts.length, 'the recording lost or gained rows');

  // Values, not keys and kinds. `assertShape`-style comparisons are what let a Zürich spelled in
  // ASCII pass against one spelled with the umlaut for six green runs, and the drift this guard was
  // written to catch was entirely in the NAMES: `Kasse` against `Kassenbestand`, and five more.
  assert.deepEqual(FIXTURE, live, 'the recording and the engine disagree: re-run the capture script');
});

test('the engine sends `name` and does NOT send `label`, which is the sixth defect pinned', () => {
  const live = liveListAccounts();

  for (const account of live.accounts) {
    assert.equal(typeof account.name, 'string', `${account.number}: the picker renders this`);
    assert.ok(account.name.length > 0, `${account.number}: an empty name reaches the screen as blank`);
    assert.equal(
      'label' in account,
      false,
      `${account.number}: list_accounts answers \`name\`, so anything reading \`label\` renders ` +
        '"1000 undefined" the way PaymentAllocator did',
    );
  }

  // The recording must not be more generous than the engine either: a fixture carrying `label` is
  // how the Payments unit test stayed green through the whole defect.
  for (const account of FIXTURE.accounts) {
    assert.equal(
      'label' in account,
      false,
      `${account.number}: the recording must not carry a key the engine does not send`,
    );
  }

  // The key list this file asserts against is itself checked against the engine, so it cannot rot
  // into an allowlist that quietly stopped describing the response.
  assert.deepEqual(Object.keys(live.accounts[0]).sort(), ENGINE_KEYS);
});

test('`inUse` really has two arms, or Archive-XOR-Delete is only ever tested one way', () => {
  const live = liveListAccounts();
  const used = live.accounts.filter((account) => account.inUse).map((account) => account.number);
  const free = live.accounts.filter((account) => !account.inUse).map((account) => account.number);

  // The posted entry is what makes the distinction real. Without it every row is `inUse: false`, the
  // Studio offers the destructive path on every account, and no fixture would ever show it.
  assert.deepEqual(used.sort(), [POSTED_DEBIT, POSTED_CREDIT].sort(), 'only the posted accounts are in use');
  assert.ok(free.length > 0, 'no free account left, so the Delete arm has nothing to render');
});

test('every surface that re-declares an account row names only keys the engine sends', () => {
  assert.ok(DECLARATIONS.length > 0, 'the declaration list is empty, so this test asserts nothing');

  for (const [relative, interfaceName] of DECLARATIONS) {
    const fields = declaredFields(relative, interfaceName);

    // The type-level half of the sixth defect. `PaymentAllocator` was typed against the payments read
    // model's `BankAccountRef` (`{id, number, label}`) while it rendered an A01 `list_accounts` row.
    assert.equal(
      fields.includes('label'),
      false,
      `${relative}: \`label\` is a payments BankAccountRef key, not a list_accounts one`,
    );

    const invented = fields.filter((field) => !ENGINE_KEYS.includes(field));
    assert.deepEqual(
      invented,
      [],
      `${relative}: \`${interfaceName}\` declares fields list_accounts never sends`,
    );

    // And the three the surfaces actually render, so a declaration cannot shrink to nothing and pass.
    for (const required of ['id', 'number', 'name']) {
      assert.ok(fields.includes(required), `${relative}: \`${interfaceName}\` must declare ${required}`);
    }
  }
});

/** Every Studio suite tracked by git. The corpus the selector below narrows. */
function studioSuites() {
  return execFileSync('git', ['ls-files', 'app/src/surfaces'], { env: cleanGitEnv(), cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((path) => path.endsWith('.test.tsx'));
}

/**
 * The five surfaces this guard was armed on. A FLOOR, not an inventory.
 *
 * The difference is the whole point of the change below. As an inventory the list claimed to name
 * every suite on the recording and was wrong within a day; as a floor it only says these must never
 * fall out of the derived corpus, which stays true however many suites are added.
 */
const ARMED_ON = [
  'app/src/surfaces/Journal/Journal.test.tsx',
  'app/src/surfaces/Journal/EntryDrawer.base-currency.test.tsx',
  'app/src/surfaces/Items/Items.test.tsx',
  'app/src/surfaces/Items/Items.base-currency.test.tsx',
  'app/src/surfaces/Accounts/Accounts.test.tsx',
];

test('every Studio suite that consumes list_accounts renders the recording, never a literal of its own', () => {
  // This was a hand-written list of five and it went stale the first time a sixth suite was armed:
  // `Vat/vat-currency-callers.test.tsx` was pulled onto the recording in 362f45f and never added
  // here. Nothing went unguarded (`test/studio/vat-callers-list-accounts-fixture.test.mjs` covers
  // that suite), but a list that reads as an inventory and is not one is worse than no list: the
  // next reader concludes the Vat suite still hand-types its accounts.
  //
  // WHY THE CORPUS IS SELECTED BY A DIFFERENT PROPERTY THAN THE ONE ASSERTED, which is the only
  // interesting decision here. The lazy derivation is "every suite that imports the recording", and
  // it is worth nothing: this test would then assert that the files importing the recording import
  // the recording. It would pass just as green on a repo where every suite had been reverted to
  // hand-typed literals, because the corpus would be empty and the loop would iterate nothing. That
  // is the vacuous shape this file's own header warns about.
  //
  // So the corpus is selected by CONSUMPTION (the suite mentions the `list_accounts` verb) and the
  // assertion is about SOURCING (it must render the recording). The two are independent, so a suite
  // that starts calling `list_accounts` with rows of its own invention joins the corpus and goes
  // red on its own, which the hand-written list could only manage if someone remembered a line.
  const tracked = studioSuites();
  const suites = tracked.filter((path) => readFileSync(join(ROOT, path), 'utf8').includes('list_accounts'));

  assert.ok(tracked.length > 20, `only ${tracked.length} Studio suites tracked: the glob is wrong`);
  assert.ok(suites.length >= ARMED_ON.length, `only ${suites.length} suites consume list_accounts`);

  // The selector has to SELECT. If every Studio suite matched, "mentions list_accounts" would be a
  // property nothing lacks, and the scan below would be an accident rather than a choice. Same
  // reasoning as the load-bearing checks in `test/style/umlaut-transliteration.test.mjs`.
  assert.ok(
    suites.length < tracked.length,
    'every tracked Studio suite mentions list_accounts, so the selector selects nothing: re-check it',
  );

  // ...and the surfaces this guard was actually written for cannot drop out of the corpus, whatever
  // the selector does later.
  for (const armed of ARMED_ON) {
    assert.ok(suites.includes(armed), `${armed} fell out of the derived corpus: the selector is broken`);
  }

  for (const relative of suites) {
    const source = readFileSync(join(ROOT, relative), 'utf8');
    // TWO recordings satisfy this, and they are named rather than pattern-matched.
    //
    // A01's `list-accounts.fixture.json` is the original, pinned by this file. A19 records the same
    // verb WITH archived rows, because an archived 9100 Eröffnungsbilanz must never be reported as
    // missing, and that recording is pinned value for value by
    // `test/banking/studio-bank-accounts-fixture.test.mjs`. Both are engine answers; neither is
    // hand-typed, which is the property this guard exists to hold.
    //
    // Named, not globbed, on purpose: a pattern like `/list-accounts.*\.fixture\.json/` would let a
    // suite satisfy the guard with any file it invented and called a fixture, which is the exact
    // failure mode ("the fixture agrees with the author rather than with the engine") that the
    // recordings exist to close. A third recording joins this list only alongside its own pin.
    assert.match(
      source,
      /list-accounts\.fixture\.json|list-accounts-with-9100\.fixture\.json/,
      `${relative}: must import a PINNED recording, or its accounts are hand-typed again`,
    );
    // Any account ROW still written out by hand is checked against the chart, name and all.
    //
    // The probe took two tries, and both misses are worth keeping in view, because in each case the
    // probe was wrong and the suite was right. Searching for the invented NAMES alone flagged
    // `{ name: 'Ertrag', level: 2 }`, a heading's accessible name. Pairing the name with a
    // four-digit `number` then flagged `{ number: '3400', name: 'Beratungsertrag' }`, which is what
    // an operator TYPES into the create form for an account that does not exist yet. What makes a
    // match an existing row rather than either of those is the `id` in front of it.
    for (const [, number, name] of source.matchAll(
      /id: [^,\n]+,\s*\n?\s*number: '(\d{4})',\s*\n?\s*name: '([^']+)'/g,
    )) {
      const chart = FIXTURE.accounts.find((account) => account.number === number);
      assert.notEqual(chart, undefined, `${relative}: account ${number} is not in the shipped chart`);
      assert.equal(
        name,
        chart.name,
        `${relative}: account ${number} is named "${chart.name}" in the shipped chart, not "${name}"`,
      );
    }
  }
});
