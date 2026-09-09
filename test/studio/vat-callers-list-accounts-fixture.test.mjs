/**
 * The A11-G2 CALLER-suite `list_accounts` drift guard.
 *
 * `app/src/surfaces/Vat/vat-currency-callers.test.tsx` was the last Studio suite still faking
 * `list_accounts` from a hand-written literal. Both of its rows were wrong against the shipped KMU
 * chart, and the ids were invented outright:
 *
 *   `{ id: 'acc_kasse', number: '1000', name: 'Kasse' }`         is `acc_1`,  `Kassenbestand`
 *   `{ id: 'acc_buero', number: '6500', name: 'Büromaterial' }`  is `acc_47`, `Verwaltungs- und Bürokosten`
 *
 * That is not cosmetic here, and the distinction is worth stating because it is exactly the question
 * asked of `test/ledger/journal-list-fx-fixture.test.mjs`, where the same two names appear and the
 * answer is the opposite. `EntryDrawer` renders `{a.number} {a.name}` into every option of its
 * per-line account picker (`EntryDrawer.tsx`), so every recorded name reaches THIS suite's DOM.
 * `list_journal` emits no account names at all, so the raw-SQL names in the fx guard's world reach
 * nothing. A name is a defect where it is rendered and inert where it is not.
 *
 * ## Why this file exists next to `test/accounts/studio-list-accounts-fixture.test.mjs`
 *
 * That guard pins the recording to the engine and lists the suites that render it. This one pins the
 * VAT caller suite, and it re-asserts the recording against the live engine itself rather than
 * leaning on its neighbour staying green. Two guards that both read the live answer cannot drift
 * into agreeing with each other about a world neither one checked.
 *
 * ## Values, absence, and a corpus that cannot be empty
 *
 *   1. VALUES, never keys and kinds. Every name in the old literal was wrong while every KIND
 *      matched, so a shape comparison would have stayed green forever. The same lesson cost six
 *      green runs in `test/sales/invoice-gui-fixture.test.mjs`, where a fixture reading `Zuerich`
 *      sat against a seed reading `Zürich`.
 *   2. ABSENCE, not only presence. The engine sends `name` and has no `label`, and it issues
 *      sequential ids, never a spelled-out `acc_buero`. Asserting the keys that ARE sent would not
 *      have caught either half of what was wrong here.
 *   3. Every scan asserts its own corpus is non-empty, so a renamed file or a broken probe cannot
 *      make this file pass by finding nothing. Where an EMPTY result is the thing being asserted,
 *      it is asserted directly rather than looped over.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { liveListAccounts } from '../accounts/studio-list-accounts-world.mjs';

const SUITE = new URL('../../app/src/surfaces/Vat/vat-currency-callers.test.tsx', import.meta.url);
const RECORDING = new URL('../../app/src/surfaces/Accounts/list-accounts.fixture.json', import.meta.url);

const source = readFileSync(SUITE, 'utf8');
const FIXTURE = JSON.parse(readFileSync(RECORDING, 'utf8'));

/** The keys `mapAccount` plus `listAccounts` actually emit. Checked against the engine below. */
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

test('the suite is readable and really is the VAT caller suite, or every scan below is vacuous', () => {
  assert.ok(source.length > 0, 'the suite file is empty, so nothing below proves anything');
  assert.match(source, /EntryDrawer hands the VAT controls the WORKSPACE base currency/,
    'this guard is pointed at the wrong file: the drawer describe block is gone');
  assert.match(source, /list_accounts/, 'the suite no longer fakes list_accounts, so re-read this guard');
});

test('the VAT caller suite fills its picker from the recording, never a literal of its own', () => {
  assert.match(
    source,
    /list-accounts\.fixture\.json/,
    'the suite must import the recording, or its accounts are hand-typed again',
  );

  // The anchored probe. Two earlier versions of this probe over-matched, and both misses are worth
  // keeping in view because in each case the probe was wrong and the suite was right: searching for
  // NAMES alone flagged `{ name: 'Ertrag', level: 2 }`, a heading's accessible name, and pairing a
  // name with a four-digit number flagged what an operator TYPES into a create form for an account
  // that does not exist yet. What makes a match an existing chart ROW is the `id` in front of it.
  const rows = [
    ...source.matchAll(/id: [^,\n]+,\s*\n?\s*number: '(\d{4})',\s*\n?\s*name: '([^']+)'/g),
  ];
  for (const [, number, name] of rows) {
    const chart = FIXTURE.accounts.find((a) => a.number === number);
    assert.notEqual(chart, undefined, `account ${number} is not in the shipped chart`);
    assert.equal(
      name,
      chart.name,
      `account ${number} is named "${chart.name}" in the shipped chart, not "${name}"`,
    );
  }
});

test('the suite invents no account id, which is what `acc_buero` was', () => {
  const issued = new Set(FIXTURE.accounts.map((a) => a.id));
  assert.ok(issued.size > 0, 'the recording issues no ids, so this comparison is vacuous');

  // An empty result is the ASSERTION here, not the corpus, so it is stated directly rather than
  // looped over: a loop over nothing would pass for the wrong reason. `selectOptions` matches on the
  // option VALUE, which is `account.id`, so a hand-spelled id silently selects nothing at all.
  const invented = [...source.matchAll(/'(acc_[A-Za-z0-9_]+)'/g)]
    .map(([, id]) => id)
    .filter((id) => !issued.has(id));
  assert.deepEqual(
    invented,
    [],
    'these ids are spelled out in the suite but the engine never issues them; ' +
      'resolve accounts by NUMBER off the recording instead',
  );
});

test('every account the suite resolves by number is one the LIVE engine really sends', () => {
  const live = liveListAccounts();
  assert.ok(live.accounts.length > 0, 'the live chart is empty, so nothing below proves anything');

  const numbers = [...source.matchAll(/account\('(\d{4})'\)/g)].map(([, number]) => number);
  assert.ok(
    numbers.length > 0,
    'the suite resolves no account by number, so the probe is broken or the suite regressed',
  );

  for (const number of numbers) {
    const row = live.accounts.find((a) => a.number === number);
    assert.notEqual(row, undefined, `the suite resolves account ${number}, which the engine does not send`);

    // VALUES. The whole defect was that the kinds matched and the names did not.
    const recorded = FIXTURE.accounts.find((a) => a.number === number);
    assert.notEqual(recorded, undefined, `the recording has no account ${number}`);
    assert.deepEqual(recorded, row, `account ${number}: the recording and the engine disagree`);
    assert.equal(
      recorded.name,
      row.name,
      `account ${number} is named "${row.name}" by the engine, and the picker renders that name`,
    );
  }
});

test('the recording this suite renders IS the live answer, value for value', () => {
  const live = liveListAccounts();

  assert.equal(FIXTURE.accounts.length, live.accounts.length, 'the recording lost or gained rows');
  assert.ok(FIXTURE.accounts.length > 0, 'an empty recording would make every loop here pass by iterating nothing');

  // The picker renders EVERY row, so every row is pinned, and pinned by value. Re-run
  // `node test/accounts/capture-studio-list-accounts.mjs` when this fails for a deliberate change.
  assert.deepEqual(FIXTURE, live, 'the recording and the engine disagree: re-run the capture script');
});

test('the engine sends `name` and no `label`, and neither does the recording', () => {
  const live = liveListAccounts();
  assert.ok(live.accounts.length > 0, 'the live chart is empty, so the loop below asserts nothing');

  for (const row of live.accounts) {
    assert.equal(typeof row.name, 'string', `${row.number}: the picker renders this`);
    assert.ok(row.name.length > 0, `${row.number}: an empty name reaches the option as a bare number`);
    assert.equal(
      'label' in row,
      false,
      `${row.number}: list_accounts answers \`name\`, so anything reading \`label\` renders ` +
        '"1000 undefined" the way PaymentAllocator did',
    );
  }

  for (const row of FIXTURE.accounts) {
    assert.equal(
      'label' in row,
      false,
      `${row.number}: the recording must not carry a key the engine does not send`,
    );
  }

  // The key list is itself checked against the engine, so it cannot rot into an allowlist that
  // quietly stopped describing the response.
  assert.deepEqual(Object.keys(live.accounts[0]).sort(), ENGINE_KEYS);

  // And no ACCOUNT literal in the suite may carry the invented key either.
  //
  // This probe took two tries, and the first one was wrong in the same way the two before it were.
  // Searching the suite for `label:` anywhere after its `list_accounts` fake flagged
  // `{ code: 'UST81', ..., label: 'Normalsatz 8.1%' }`: `label` is a real and correct key on a TAX
  // CODE, and the suite was right. Only an ACCOUNT row may not carry it, so the probe is anchored on
  // the four-digit `number` that makes a literal an account in the first place.
  const accountLiterals = [...source.matchAll(/\{[^{}]*\bnumber: '\d{4}'[^{}]*\}/g)].map(([m]) => m);
  const carryingLabel = accountLiterals.filter((literal) => /\blabel:/.test(literal));
  assert.deepEqual(
    carryingLabel,
    [],
    'an account literal in the suite names `label`, which is the sixth defect returning',
  );
});
