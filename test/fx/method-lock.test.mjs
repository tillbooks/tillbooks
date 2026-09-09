// §H-FX, the MWSTV Art. 45 Abs. 5 method lock.
//
// The foundation RECORDED which admissible basis priced a posting (`exchange_rate.method`) and
// enforced nothing. This suite pins the enforcement, and the shape of the enforcement is the whole
// point: in an append-only, local-first ledger "the method cannot be switched" cannot mean "the row
// is immutable", because a brand-new workspace has chosen nothing yet and the turn of the calendar
// year is a legitimate moment to choose again.
//
// The rule that comes out of the statute, fetched 2026-07-25:
//
//   MWSTV Art. 45 Abs. 5 (SR 641.201, Stand 1.1.2025), verbatim: "Das gewählte Vorgehen
//   (Monatsmittel-, Tages- oder Konzernkurs) ist während mindestens einer Steuerperiode
//   beizubehalten."
//   MWSTG Art. 34 Abs. 2 (SR 641.20, Stand 1.1.2025): "Als Steuerperiode gilt das Kalenderjahr."
//   (Abs. 3, the business-year option, carries the Fedlex footnote "Noch nicht in Kraft".)
//   ESTV, "Fremdwährungskurse MWST" (estv.admin.ch/de/mwst-fremdwaehrungskurse, the URL slug is
//   ASCII, the page heading is not), verbatim:
//   "Das gewählte Vorgehen muss während mindestens einer Steuerperiode beibehalten werden. Es ist
//   für die Berechnung der Inlandsteuer, der Bezugsteuer und des Vorsteuerabzugs anzuwenden. Ein
//   Wechsel ist nur auf den Beginn einer neuen Steuerperiode möglich."
//
// So: an election is per calendar year, it carries forward until it is changed, and it may be
// written for a period only while that period (and every period after it) still holds no posted
// foreign-currency entry. Books already made are never re-based.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import {
  recordExchangeRate,
  resolveFxRate,
  setFxMethod,
  getFxMethod,
  electedFxMethod,
  FX_ELECTABLE_METHODS,
  FX_FALLBACK_METHOD,
} from '../../dist/core/fx/index.js';

const AT = '2026-07-16T00:00:00.000Z';

function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const workspaceId = createWorkspace({ store, clock, ids }, { name: 'Nomadik GmbH' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  const accId = (number) =>
    store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number).id;
  return { ctx, store, workspaceId, accId, clock, ids };
}

/** A EUR rate on `asOf` under `method`, recorded straight into the store. */
function eurRate(ctx, over = {}) {
  return recordExchangeRate(ctx, {
    baseCurrency: 'EUR',
    rate: '0.9412',
    asOf: '2026-03-01',
    source: 'manual',
    method: 'daily',
    provenance: 'ESTV Tageskurs (Devisenkurs Verkauf)',
    idempotencyKey: `fx-${over.asOf ?? '2026-03-01'}-${over.method ?? 'daily'}-${over.source ?? 'manual'}`,
    ...over,
  });
}

/** A balanced EUR posting that must find its rate in the store (no explicit rate). */
function eurPost(ctx, accId, over = {}) {
  return postEntry(ctx, {
    date: '2026-03-02',
    description: 'EUR Einkauf',
    source: 'manual',
    currency: 'EUR',
    idempotencyKey: `p-${over.date ?? '2026-03-02'}`,
    lines: [
      { account: accId('6500'), debit: 10000 },
      { account: accId('1000'), credit: 10000 },
    ],
    ...over,
  });
}

// ---------------------------------------------------------------------------
// The election itself
// ---------------------------------------------------------------------------

test('the electable methods are the Art. 45 Abs. 3 / Abs. 4 CHOICES, and `bank` is not one of them', () => {
  // Abs. 3 offers Monatsmittelkurs or Tageskurs; Abs. 4 offers the group rate to group members.
  // Abs. 3bis is not an alternative a taxpayer elects: it is the MANDATED fallback for a currency
  // the ESTV publishes no rate for, so it stays admissible under every election.
  assert.deepEqual([...FX_ELECTABLE_METHODS], ['daily', 'monthly_avg', 'group']);
  assert.equal(FX_FALLBACK_METHOD, 'bank');
  assert.ok(!FX_ELECTABLE_METHODS.includes('bank'), 'Abs. 3bis is a fallback, never an election');
});

test('a fresh workspace has elected NOTHING, and nothing is enforced until it does', () => {
  const { ctx } = setup();
  const read = getFxMethod(ctx, { taxPeriod: '2026' });
  assert.equal(read.ok, true);
  assert.equal(read.method, null);
  assert.equal(electedFxMethod(ctx, '2026-03-02'), null);
  // Both bases resolve, because the workspace has not claimed one.
  assert.equal(eurRate(ctx, { method: 'daily' }).ok, true);
  assert.equal(eurRate(ctx, { method: 'monthly_avg', asOf: '2026-03-01', source: 'rate_api' }).ok, true);
});

test('setFxMethod records the election for a calendar-year Steuerperiode and reads back', () => {
  const { ctx } = setup();
  const set = setFxMethod(ctx, { method: 'monthly_avg', taxPeriod: '2026' });
  assert.equal(set.ok, true);
  assert.equal(set.taxPeriod, '2026');
  assert.equal(set.method, 'monthly_avg');
  assert.equal(set.changed, true);

  const read = getFxMethod(ctx, { date: '2026-08-04' });
  assert.equal(read.method, 'monthly_avg');
  assert.equal(read.taxPeriod, '2026');
  assert.equal(read.electedFor, '2026', 'the election that governs is the one for this very period');
  assert.equal(read.locked, false, 'no foreign-currency entry is posted yet');
});

test('setFxMethod defaults the Steuerperiode to the year of the clock, not to a guess', () => {
  const { ctx } = setup();
  const set = setFxMethod(ctx, { method: 'daily' });
  assert.equal(set.taxPeriod, '2026', 'the pinned clock is 2026-07-16');
});

test('setFxMethod refuses a method that is not an Art. 45 election, `bank` included', () => {
  const { ctx } = setup();
  for (const method of ['bank', 'ecb', 'mid', '']) {
    const res = setFxMethod(ctx, { method, taxPeriod: '2026' });
    assert.equal(res.ok, false, `${method} must not be electable`);
    assert.ok(['invalid_fx_method', 'invalid_input'].includes(res.error), `got ${res.error}`);
  }
});

test('setFxMethod refuses a Steuerperiode that is not a calendar year', () => {
  const { ctx } = setup();
  for (const taxPeriod of ['2026-01', '26', 'Q1', '02026']) {
    const res = setFxMethod(ctx, { method: 'daily', taxPeriod });
    assert.equal(res.ok, false, `${taxPeriod} is not a Steuerperiode`);
    assert.equal(res.error, 'invalid_input');
    assert.equal(res.field, 'taxPeriod');
  }
});

test('re-electing the SAME method is a settled no-op, so a retry is safe', () => {
  const { ctx, store } = setup();
  setFxMethod(ctx, { method: 'daily', taxPeriod: '2026' });
  const before = store.db.prepare('SELECT * FROM fx_method_election').all();
  const again = setFxMethod(ctx, { method: 'daily', taxPeriod: '2026' });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.deepEqual(store.db.prepare('SELECT * FROM fx_method_election').all(), before);
});

// ---------------------------------------------------------------------------
// The lock: what "cannot be switched mid-Steuerperiode" actually means
// ---------------------------------------------------------------------------

test('the election is FREE to change while the period holds no posted foreign-currency entry', () => {
  const { ctx } = setup();
  setFxMethod(ctx, { method: 'daily', taxPeriod: '2026' });
  const switched = setFxMethod(ctx, { method: 'monthly_avg', taxPeriod: '2026' });
  assert.equal(switched.ok, true, 'nothing has been priced yet: the choice is still open');
  assert.equal(switched.method, 'monthly_avg');
  assert.equal(getFxMethod(ctx, { taxPeriod: '2026' }).method, 'monthly_avg');
});

test('a CHF-only ledger does not lock the election: a base-currency entry converts nothing', () => {
  const { ctx, accId } = setup();
  setFxMethod(ctx, { method: 'daily', taxPeriod: '2026' });
  const chf = postEntry(ctx, {
    date: '2026-03-02',
    description: 'Büromaterial',
    source: 'manual',
    idempotencyKey: 'chf-1',
    lines: [
      { account: accId('6500'), debit: 5000 },
      { account: accId('1000'), credit: 5000 },
    ],
  });
  assert.equal(chf.ok, true);
  assert.equal(setFxMethod(ctx, { method: 'monthly_avg', taxPeriod: '2026' }).ok, true);
});

test('once a foreign-currency entry is POSTED in the period, the basis for that period is settled', () => {
  const { ctx, accId } = setup();
  setFxMethod(ctx, { method: 'daily', taxPeriod: '2026' });
  eurRate(ctx, { method: 'daily' });
  assert.equal(eurPost(ctx, accId).ok, true);

  const refused = setFxMethod(ctx, { method: 'monthly_avg', taxPeriod: '2026' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'fx_method_locked');
  assert.equal(refused.taxPeriod, '2026');
  assert.equal(refused.electedMethod, 'daily');
  assert.equal(refused.submittedMethod, 'monthly_avg');
  assert.equal(refused.earliestChangeablePeriod, '2027', 'a change is only possible at the start of a new period');
  assert.match(String(refused.reason), /Steuerperiode/);

  // Re-asserting the SAME method is still fine: it changes nothing, so it cannot be a switch.
  assert.equal(setFxMethod(ctx, { method: 'daily', taxPeriod: '2026' }).ok, true);
  assert.equal(getFxMethod(ctx, { taxPeriod: '2026' }).locked, true);
});

test('the turn of the calendar year is a legitimate switch, even with a full year of FX behind it', () => {
  const { ctx, accId } = setup();
  setFxMethod(ctx, { method: 'daily', taxPeriod: '2026' });
  eurRate(ctx, { method: 'daily' });
  assert.equal(eurPost(ctx, accId).ok, true);

  const next = setFxMethod(ctx, { method: 'monthly_avg', taxPeriod: '2027' });
  assert.equal(next.ok, true, 'MWSTV Art. 45 Abs. 5 binds one period, not forever');
  assert.equal(getFxMethod(ctx, { date: '2026-12-31' }).method, 'daily');
  assert.equal(getFxMethod(ctx, { date: '2027-01-01' }).method, 'monthly_avg');
});

test('an election carries FORWARD until it is changed: no annual re-election is required', () => {
  const { ctx } = setup();
  setFxMethod(ctx, { method: 'monthly_avg', taxPeriod: '2026' });
  const later = getFxMethod(ctx, { taxPeriod: '2029' });
  assert.equal(later.method, 'monthly_avg');
  assert.equal(later.electedFor, '2026', 'the read names the period the election was actually made for');
  assert.equal(electedFxMethod(ctx, '2029-06-01').method, 'monthly_avg');
});

test('a period BEFORE the first election is unelected, never back-filled', () => {
  const { ctx } = setup();
  setFxMethod(ctx, { method: 'daily', taxPeriod: '2026' });
  assert.equal(getFxMethod(ctx, { taxPeriod: '2025' }).method, null);
  assert.equal(electedFxMethod(ctx, '2025-12-31'), null);
});

test('a period cannot be re-based from BEHIND a posted foreign-currency entry either', () => {
  const { ctx, accId } = setup();
  eurRate(ctx, { method: 'daily' });
  assert.equal(eurPost(ctx, accId).ok, true, 'posted with no election in force');
  // 2026 now holds FX books. Electing 2026 retroactively would claim a basis for entries already
  // priced, and electing 2025 would do the same by carry-forward.
  assert.equal(setFxMethod(ctx, { method: 'monthly_avg', taxPeriod: '2026' }).error, 'fx_method_locked');
  assert.equal(setFxMethod(ctx, { method: 'monthly_avg', taxPeriod: '2025' }).error, 'fx_method_locked');
  assert.equal(setFxMethod(ctx, { method: 'monthly_avg', taxPeriod: '2027' }).ok, true);
});

// ---------------------------------------------------------------------------
// The enforcement: a posting cannot be priced by a method the workspace is not on
// ---------------------------------------------------------------------------

test('recordExchangeRate refuses a rate declaring a basis the workspace is not on', () => {
  const { ctx } = setup();
  setFxMethod(ctx, { method: 'monthly_avg', taxPeriod: '2026' });
  const refused = eurRate(ctx, { method: 'daily' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'fx_method_not_elected');
  assert.equal(refused.electedMethod, 'monthly_avg');
  assert.equal(refused.method, 'daily');
  assert.equal(refused.taxPeriod, '2026');
  assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS c FROM exchange_rate').get().c, 0, 'nothing landed');
});

test('the Abs. 3bis bank fallback stays admissible under EVERY election', () => {
  const { ctx, accId } = setup();
  setFxMethod(ctx, { method: 'monthly_avg', taxPeriod: '2026' });
  // A currency the ESTV publishes no rate for: Art. 45 Abs. 3bis mandates a domestic bank's daily
  // selling rate, so refusing it would make a legitimate transaction unbookable.
  const bank = eurRate(ctx, { method: 'bank' });
  assert.equal(bank.ok, true, 'Abs. 3bis is not an election a workspace can be "off"');
  assert.equal(eurPost(ctx, accId).ok, true);
});

test('an UNDECLARED rate is not refused, and the resolution reports the basis it did not name', () => {
  const { ctx, accId } = setup();
  setFxMethod(ctx, { method: 'monthly_avg', taxPeriod: '2026' });
  const undeclared = eurRate(ctx, { method: undefined, idempotencyKey: 'fx-undeclared' });
  assert.equal(undeclared.ok, true, 'TILL cannot refuse a basis a rate never claimed');
  const resolved = resolveFxRate(ctx, { currency: 'EUR', date: '2026-03-02' });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.resolved.rateMethod, null);
  assert.equal(eurPost(ctx, accId).ok, true);
});

test('a POSTING is refused when the only admissible rate declares the wrong basis', () => {
  const { ctx, accId } = setup();
  // The rate lands first, under no election: a workspace can elect after it has rates on file.
  eurRate(ctx, { method: 'daily' });
  setFxMethod(ctx, { method: 'monthly_avg', taxPeriod: '2027' });

  const refused = eurPost(ctx, accId, { date: '2027-03-02', idempotencyKey: 'p-2027' });
  assert.equal(refused.ok, false);
  assert.ok(
    ['fx_method_not_elected', 'needs_fx_rate'].includes(refused.error),
    `a 2027 posting must not be priced by a 2026 daily rate, got ${refused.error}`,
  );
  assert.equal(ctx.store.db.prepare("SELECT COUNT(*) AS c FROM journal_entry WHERE status='posted'").get().c, 0);
});

test('resolveFxRate refuses a stored rate whose declared basis is not the elected one', () => {
  const { ctx } = setup();
  eurRate(ctx, { method: 'daily', asOf: '2027-03-01' });
  setFxMethod(ctx, { method: 'monthly_avg', taxPeriod: '2027' });
  const res = resolveFxRate(ctx, { currency: 'EUR', date: '2027-03-02' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'fx_method_not_elected');
  assert.equal(res.electedMethod, 'monthly_avg');
  assert.equal(res.method, 'daily');
  assert.match(String(res.reason), /record_exchange_rate|import_exchange_rates/);
});

test('an EXPLICIT rate is not silently coerced: it declares no basis and stays the callers assertion', () => {
  const { ctx, accId } = setup();
  setFxMethod(ctx, { method: 'monthly_avg', taxPeriod: '2026' });
  const posted = eurPost(ctx, accId, { fxRate: '0.9412', idempotencyKey: 'p-explicit' });
  assert.equal(posted.ok, true, 'a bank advice or a group rate typed by hand is still postable');
  assert.equal(posted.fxRate, '0.9412');
});

test('a REVERSAL is never blocked by the method lock: a correction must always be bookable', () => {
  const { ctx, accId } = setup();
  eurRate(ctx, { method: 'daily' });
  const posted = eurPost(ctx, accId);
  assert.equal(posted.ok, true);
  // The books are now locked to `daily` for 2026 by the posting, but suppose the operator elects
  // 2027 differently and then has to reverse the 2026 entry: the reversal carries the original
  // currency and rate and must not be refused.
  setFxMethod(ctx, { method: 'monthly_avg', taxPeriod: '2027' });
  const reversed = postEntry(ctx, {
    date: '2026-03-05',
    description: 'Storno EUR Einkauf',
    source: 'reversal',
    currency: 'EUR',
    fxRate: '0.9412',
    reversesEntryId: posted.entryId,
    idempotencyKey: 'rev-1',
    lines: [
      { account: accId('6500'), credit: 10000 },
      { account: accId('1000'), debit: 10000 },
    ],
  });
  assert.equal(reversed.ok, true, `a correction must never be blocked: ${JSON.stringify(reversed)}`);
});

test('§H-TENANT: one workspace election never reaches another', () => {
  const { ctx, store, clock, ids } = setup();
  const otherId = createWorkspace({ store, clock, ids }, { name: 'Zweite GmbH' }).workspaceId;
  const other = makeContext(store, { workspaceId: otherId, actor: 'user_2', clock, ids });

  setFxMethod(ctx, { method: 'monthly_avg', taxPeriod: '2026' });
  assert.equal(getFxMethod(other, { taxPeriod: '2026' }).method, null);
  assert.equal(eurRate(other, { method: 'daily' }).ok, true, 'the neighbour is unaffected');
});
