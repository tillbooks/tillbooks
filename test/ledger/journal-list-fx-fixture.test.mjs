/**
 * The Studio journal-list FX fixture-versus-engine drift guard (A02, §H-FX).
 *
 * `app/src/surfaces/Journal/journal-list-fx.fixture.json` is what the Studio's jsdom tests render in
 * place of a live `list_journal` response when the subject is currency and the base-currency
 * disclosure. Same contract as `test/sales/studio-fx-document-fixture.test.mjs`: pin every arm to
 * the REAL engine answer, keys and kinds, so a Studio test can never pass green against a shape the
 * engine does not send. This repo has shipped four Studio defects by assuming a key the engine never
 * sends, and the §H-FX group is unusually easy to assume wrong, because its presence is CONDITIONAL
 * and the condition is not the one a reader guesses.
 *
 * The condition is A02's `statesConversionBasis`, which asks about the CURRENCY and nothing else. A
 * JOURNAL entry's arms are not a DOCUMENT's, though, and the two differences are the ones a client
 * gets wrong:
 *
 *   - `currency` itself is UNCONDITIONAL and can be NULL. A document always has a currency column;
 *     a journal entry's currency lives only on its lines, so an entry with no lines has none. A
 *     client that reads `entry.currency` as `string` renders `undefined 0.00`, or worse, quietly
 *     falls back to CHF, which is the exact defect this whole change exists to remove.
 *   - the FX group is `baseTotal` / `fxRate` / `baseCurrency`, NOT `totalBaseMinor`. The journal read
 *     model pairs `total` with `baseTotal` the way it pairs `debit` with `baseDebit`; `list_documents`
 *     pairs `totalMinor` with `totalBaseMinor`. Both are internally consistent, and a client that
 *     copies the document names into the journal surface gets `undefined` at runtime and no type
 *     error, because the field is optional on both.
 *
 * The three FX keys do NOT travel "all three or none", which is the assumption that shipped the
 * document defect: a foreign entry that has not posted carries `baseCurrency` as a string while both
 * figures are null. So this file asserts the arms are DISTINGUISHABLE, not merely present.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { postEntry, saveDraft } from '../../dist/core/ledger/index.js';
import { recordExchangeRate } from '../../dist/core/fx/index.js';
import { getAction } from '../../dist/api/registry.js';

const FIXTURE = JSON.parse(
  readFileSync(new URL('../../app/src/surfaces/Journal/journal-list-fx.fixture.json', import.meta.url), 'utf8'),
);

const AT = '2026-07-16T00:00:00.000Z';
const DATE = '2026-07-16';
const FX_KEYS = ['baseTotal', 'fxRate', 'baseCurrency'];

const keysOf = (obj) => Object.keys(obj).sort();
const kindOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function assertShape(fixture, live, where) {
  assert.deepEqual(keysOf(fixture), keysOf(live), `${where}: key drift`);
  for (const key of Object.keys(live)) {
    assert.equal(kindOf(fixture[key]), kindOf(live[key]), `${where}.${key}: kind drift`);
  }
}

/** A workspace that can really post, with EUR at 0.9412 and USD pegged at exactly 1. */
function world() {
  const clock = fixedClock(AT);
  const store = new SqliteStore({ clock });
  const workspaceId = 'ws_1';
  store.db
    .prepare('INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(workspaceId, 'Nomadik GmbH', 'CHF', '01-01', AT);
  for (const [id, number, name, type] of [
    ['acc_kasse', '1000', 'Kasse', 'asset'],
    ['acc_buero', '6500', 'Büromaterial', 'expense'],
  ]) {
    store.db
      .prepare('INSERT INTO account (id, workspace_id, number, name, type) VALUES (?, ?, ?, ?, ?)')
      .run(id, workspaceId, number, name, type);
  }
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids: sequenceIdGen() });
  for (const [currency, rate] of [
    ['EUR', '0.9412'],
    ['USD', '1'],
    // GBP at 1.005 exists for ONE reason: it is a rate on which `total * rate` in binary floating
    // point disagrees with the ledger. GBP 1.00 posts CHF 1.01 (exact scaled integers, half away
    // from zero) while `100 * 1.005` is 100.49999999999999 and rounds DOWN to CHF 1.00. Without an
    // arm like this, a Studio test asserting "the printed figure is the engine's" passes just as
    // green against a client that multiplied the rate out, because on ordinary rates the two agree.
    ['GBP', '1.005'],
  ]) {
    const res = recordExchangeRate(ctx, {
      baseCurrency: currency,
      rate,
      asOf: '2026-07-15',
      source: 'manual',
      method: 'daily',
      provenance: 'ESTV Tageskurs Verkauf (MWSTV Art. 45 Abs. 3)',
      idempotencyKey: `fx-${currency}`,
    });
    assert.ok(res.ok, JSON.stringify(res));
  }

  const post = (key, ref, currency, amount) => {
    const res = postEntry(ctx, {
      date: DATE,
      ref,
      description: 'Beratung',
      source: 'manual',
      idempotencyKey: key,
      ...(currency !== null ? { currency } : {}),
      lines: [
        { account: 'acc_buero', debit: amount },
        { account: 'acc_kasse', credit: amount },
      ],
    });
    assert.ok(res.ok, JSON.stringify(res));
    return res.entryId;
  };
  const draft = (key, ref, lines) => {
    const res = saveDraft(ctx, { date: DATE, ref, description: 'Beratung', idempotencyKey: key, lines });
    assert.ok(res.ok, JSON.stringify(res));
    return res.entryId;
  };

  // The fixture's own order, so a reader can line the two up without counting.
  const ids = {
    postedForeign: post('a', 'B-101', 'EUR', 162150),
    postedBase: post('b', 'B-102', null, 150000),
    postedPegged: post('c', 'B-103', 'USD', 7000),
    draft: draft('d1', 'B-104', [{ account: 'acc_buero', debit: 4200 }]),
    emptyDraft: draft('d2', 'B-105', []),
    postedRounding: post('e', 'B-106', 'GBP', 100),
  };
  return { ctx, store, workspaceId, ids };
}

/**
 * The `foreignUnposted` arm, which needs its OWN workspace: a book kept in EUR.
 *
 * A journal entry is foreign-and-unposted when its rows carry a currency the book is not kept in and
 * nothing has posted. This arm used to be reached through a DEFECT, and that defect is now fixed:
 * `saveDraft` stamped the literal 'CHF' instead of `baseCurrencyOf(ctx)`, so every draft in a non-CHF
 * book claimed to be foreign. It now writes the base currency (see
 * `test/ledger/draft-base-currency.test.mjs`).
 *
 * ## So this arm is no longer reachable through the engine's verbs, and is built deliberately
 *
 * Exactly two statements insert into `journal_line`: `saveDraft`, which now always writes the base
 * currency, and `writePostedEntry`, which may write any currency but flips the entry to `posted` in
 * the same transaction. There is therefore no committed state in which a FOREIGN row belongs to a
 * DRAFT entry, and no sequence of verbs produces one.
 *
 * The arm is kept anyway, and constructed on purpose, because the read model still EMITS this shape
 * for such a row and the Studio still has to render it. It is the shape an "all three keys or none"
 * type gets wrong (`baseCurrency` a string while both figures are null), and without it
 * `listedBaseTotal`'s runtime check that `baseTotal` is a NUMBER is a guard nothing can fail. It is
 * also the shape `saveDraft` will produce the day it learns to take a currency, which is when this
 * becomes the ordinary way to draft a EUR entry again.
 *
 * The construction is engine-made except for the ONE column under test: `saveDraft` writes the entry
 * and its line, then the line's currency is moved off the base by hand. The entry is a draft, so
 * `journal_line_no_update_posted` does not fire, and nothing here can reach a posted row.
 */
function foreignUnpostedWorld() {
  const clock = fixedClock(AT);
  const store = new SqliteStore({ clock });
  const workspaceId = 'ws_eur';
  store.db
    .prepare('INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(workspaceId, 'Nomadik GmbH', 'EUR', '01-01', AT);
  store.db
    .prepare('INSERT INTO account (id, workspace_id, number, name, type) VALUES (?, ?, ?, ?, ?)')
    .run('acc_buero', workspaceId, '6500', 'Büromaterial', 'expense');
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids: sequenceIdGen() });
  const res = saveDraft(ctx, {
    date: DATE,
    ref: 'B-107',
    description: 'Beratung',
    idempotencyKey: 'd3',
    lines: [{ account: 'acc_buero', debit: 4200 }],
  });
  assert.ok(res.ok, JSON.stringify(res));
  // The one hand-made column. `base_debit_minor` is deliberately left as `saveDraft` wrote it (a
  // literal copy of `debit_minor`, no rate behind it), because that is what the read model's
  // `status = 'posted'` fence exists to refuse to report as a conversion.
  store.db.prepare('UPDATE journal_line SET currency = ? WHERE entry_id = ?').run('CHF', res.entryId);
  return { ctx, store, workspaceId, id: res.entryId };
}

function liveRows(ctx, workspaceId) {
  const res = getAction('list_journal').run(ctx, { workspaceId });
  assert.ok(res.ok, JSON.stringify(res));
  return res.entries;
}

/** Every arm the fixture depicts, live, keyed the way the fixture keys them. */
function liveArms() {
  const chf = world();
  const rows = liveRows(chf.ctx, chf.workspaceId);
  const arms = {};
  for (const arm of Object.keys(chf.ids)) arms[arm] = rows.find((e) => e.id === chf.ids[arm]);
  const eur = foreignUnpostedWorld();
  arms.foreignUnposted = liveRows(eur.ctx, eur.workspaceId).find((e) => e.id === eur.id);
  return arms;
}

test('every arm of the Studio journal-list fixture matches the live list_journal, keys and kinds', () => {
  const live = liveArms();
  assert.deepEqual(keysOf(FIXTURE), keysOf(live), 'the fixture depicts exactly the arms these worlds build');
  for (const arm of Object.keys(live)) {
    assert.notEqual(live[arm], undefined, `${arm} is missing from list_journal`);
    assertShape(FIXTURE[arm], live[arm], `list_journal(${arm})`);
  }
});

test('the fixture arms carry DISTINCT ids, because the Studio renders them in one table', () => {
  // Learned the hard way while writing this: `foreignUnposted` comes from a second workspace, and a
  // second workspace with its own sequence generator reissues `entry_1`. The Studio keys journal
  // rows by id, so two arms sharing one id is a React key collision that breaks the whole table, not
  // a cosmetic clash. Cheap to assert, and it fails at the fixture rather than in a jsdom timeout.
  const ids = Object.values(FIXTURE).map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate entry ids across the fixture arms: ${ids.join(', ')}`);
});

test('the foreignUnposted arm really is two-of-three, which is what breaks an all-or-none type', () => {
  const { ctx, store, workspaceId, id } = foreignUnpostedWorld();
  const row = liveRows(ctx, workspaceId).find((e) => e.id === id);

  // `baseCurrency` is a STRING while both figures are null. A guard keyed on `baseCurrency` alone
  // would render a base total of null (or "EUR 0.00"), which is a figure the books have never held.
  assert.equal(kindOf(row.baseCurrency), 'string', 'the book knows its own currency before anything posts');
  assert.equal(row.baseTotal, null, 'nothing posted, so there is no converted figure');
  assert.equal(row.fxRate, null, 'and no rate was stamped to report it at');
  assert.equal(FIXTURE.foreignUnposted.baseCurrency, row.baseCurrency);
  assert.equal(FIXTURE.foreignUnposted.baseTotal, null, 'the fixture must depict this arm honestly');
  assert.equal(FIXTURE.foreignUnposted.fxRate, null);

  // The row state this arm depicts, asserted against SQLite so the arm cannot rot into depicting
  // something else: a line whose currency is off the book's base, carrying an UNCONVERTED copy of
  // the transaction amount in the base column. `saveDraft` writes that copy with no rate behind it,
  // which is why the read model fences the FIGURES to `status = 'posted'` while the LABEL is not.
  const rows = store.db.prepare('SELECT currency, base_debit_minor FROM journal_line WHERE entry_id = ?').all(id);
  assert.notEqual(rows[0].currency, 'EUR', 'the arm needs a row off the base currency, or it is not this arm');
  assert.equal(rows[0].currency, 'CHF');
  assert.equal(rows[0].base_debit_minor, 4200, 'the amount is copied into the base column, unconverted');
  assert.notEqual(row.baseTotal, 4200, 'which is exactly the figure the read model refuses to report');
});

test('the CHF world alone would leave the two-of-three arm untested, so it is built separately', () => {
  const { ctx, workspaceId } = world();
  for (const row of liveRows(ctx, workspaceId)) {
    const twoOfThree = has(row, 'baseCurrency') && row.baseTotal === null;
    assert.equal(twoOfThree, false, `${row.ref}: no CHF-book entry reaches the two-of-three arm`);
  }
});

test('the arms are DISTINGUISHABLE by currency and the FX keys, which is what the Studio branches on', () => {
  const { ctx, workspaceId, ids } = world();
  const rows = liveRows(ctx, workspaceId);
  const live = (arm) => rows.find((e) => e.id === ids[arm]);

  // Arm 1: an entry with NO lines. `currency` is null, so the Studio must render no money at all
  // rather than a denominated zero. This arm has no document counterpart.
  const empty = live('emptyDraft');
  assert.equal(empty.currency, null, 'no rows means no currency to report');
  assert.equal(empty.total, 0);
  assert.equal(FIXTURE.emptyDraft.currency, null, 'the fixture must depict the lineless arm honestly');
  assert.equal(FIXTURE.emptyDraft.total, 0);
  for (const key of FX_KEYS) assert.equal(has(empty, key), false, `a lineless entry must not carry ${key}`);

  // Arm 2: base currency. The group is absent entirely, so a Studio guard reading `entry.baseCurrency`
  // gets undefined and must render one figure. The LABEL is still there, which is the whole change.
  for (const arm of ['postedBase', 'draft']) {
    const row = live(arm);
    assert.equal(kindOf(row.currency), 'string', `${arm}: the total is labelled even with nothing to convert`);
    for (const key of FX_KEYS) {
      assert.equal(has(row, key), false, `${arm}: a base-currency entry must not carry ${key}`);
      assert.equal(has(FIXTURE[arm], key), false, `the ${arm} fixture must not carry ${key} either`);
    }
  }

  // Arm 3: posted foreign. All three carry values, and `baseTotal` is a CONVERTED figure rather than
  // a copy of the transaction total under another name.
  const foreign = live('postedForeign');
  assert.equal(kindOf(foreign.baseTotal), 'number');
  assert.equal(kindOf(foreign.fxRate), 'string', 'the rate stays a string: a number here has already lost precision');
  assert.notEqual(foreign.baseTotal, foreign.total, 'EUR at 0.9412 is not the same number of francs');
  assert.equal(FIXTURE.postedForeign.baseTotal, foreign.baseTotal, 'the fixture base total drifted');
  assert.equal(FIXTURE.postedForeign.fxRate, foreign.fxRate, 'the fixture rate string drifted');
  assert.equal(FIXTURE.postedForeign.total, foreign.total, 'the fixture transaction total drifted');
  assert.equal(FIXTURE.postedForeign.currency, foreign.currency, 'the fixture currency drifted');

  // Arm 3 at parity: the two figures coincide, which is exactly why the CURRENCY and the RATE have
  // to be stated separately. A row that only compared the numbers could not tell this from arm 2.
  const pegged = live('postedPegged');
  assert.equal(pegged.fxRate, '1', 'A02 stamps the basis even at parity');
  assert.equal(pegged.baseTotal, pegged.total, 'at parity the figures coincide');
  assert.notEqual(pegged.currency, pegged.baseCurrency, 'and the currencies still differ, which is the whole gate');
  assert.equal(FIXTURE.postedPegged.fxRate, pegged.fxRate);
  assert.equal(FIXTURE.postedPegged.baseTotal, pegged.baseTotal);
  assert.equal(FIXTURE.postedPegged.currency, pegged.currency);
});

test('the rounding arm really DIVERGES from total x rate, or the Studio guard it feeds is vacuous', () => {
  const { ctx, workspaceId, ids } = world();
  const row = liveRows(ctx, workspaceId).find((e) => e.id === ids.postedRounding);

  // The arm exists to make a wrong client observable, so its divergence is asserted rather than
  // trusted. Drop this and the Studio test that prints "CHF 1.01" would pass against a browser that
  // computed the figure itself: on ordinary rates the shortcut and the ledger agree, and a guard
  // that only ever sees agreeing numbers cannot fail.
  const shortcut = Math.round(row.total * Number(row.fxRate));
  assert.equal(row.baseTotal, 101, 'GBP 1.00 at 1.005 posts CHF 1.01 in exact scaled integers');
  assert.equal(shortcut, 100, 'and 100 * 1.005 in binary floating point rounds DOWN to CHF 1.00');
  assert.notEqual(row.baseTotal, shortcut, 'the two must differ, or this arm proves nothing');
  assert.equal(FIXTURE.postedRounding.baseTotal, row.baseTotal, 'the fixture must carry the LEDGER figure');
  assert.equal(FIXTURE.postedRounding.total, row.total);
  assert.equal(FIXTURE.postedRounding.fxRate, row.fxRate);
});

test('the fixture base total is the LEDGER base total, so the Studio never multiplies a rate out', () => {
  const { ctx, store, workspaceId, ids } = world();
  const rows = liveRows(ctx, workspaceId);
  const foreign = rows.find((e) => e.id === ids.postedForeign);
  const ledger = store.db
    .prepare('SELECT debit_minor, base_debit_minor, currency, fx_rate FROM journal_line WHERE entry_id = ?')
    .all(ids.postedForeign);
  const ledgerBase = ledger.reduce((sum, r) => sum + r.base_debit_minor, 0);
  const ledgerTxn = ledger.reduce((sum, r) => sum + r.debit_minor, 0);

  // The point of the whole exercise: the figure the Studio prints came off the posted rows. If the
  // fixture and the ledger ever disagree, the fixture is what a Studio test would keep believing.
  assert.equal(FIXTURE.postedForeign.baseTotal, ledgerBase, 'the fixture must quote the posted base debits');
  assert.equal(FIXTURE.postedForeign.total, ledgerTxn, 'and the posted transaction debits');
  assert.equal(foreign.baseTotal, ledgerBase);
  assert.equal(FIXTURE.postedForeign.currency, ledger[0].currency, 'and the currency the rows carry');
});

test('no arm of the fixture carries fxRateAsOf or the DOCUMENT key names', () => {
  const { ctx, workspaceId, ids } = world();
  const rows = liveRows(ctx, workspaceId);
  for (const arm of Object.keys(ids)) {
    const live = rows.find((e) => e.id === ids[arm]);
    // A validity date in the fixture would license the Studio to display a guess: `journal_line` has
    // no `rate_as_of` column, so the engine cannot report one without re-resolving from a mutable
    // store, and a rate imported later would hand back a date that never priced this entry.
    assert.equal(has(FIXTURE[arm], 'fxRateAsOf'), false, `${arm}: the fixture must not carry fxRateAsOf`);
    assert.equal(live.fxRateAsOf, undefined, `${arm}: the engine sends none either`);
    // `list_documents` names are a live hazard: they are optional there too, so copying them into a
    // journal component is undefined at runtime with no type error to catch it.
    for (const key of ['totalBaseMinor', 'totalMinor']) {
      assert.equal(has(FIXTURE[arm], key), false, `${arm}: ${key} is a list_documents name, not a list_journal one`);
      assert.equal(has(live, key), false, `${arm}: the engine does not send ${key} either`);
    }
  }
});
