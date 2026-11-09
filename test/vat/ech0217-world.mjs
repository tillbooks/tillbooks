/**
 * The worlds behind the eCH-0217 export suites.
 *
 * These deliberately mirror `studio-vat-return-world.mjs`, which records the SAME books as Studio
 * fixtures. That file returns recorded PAYLOADS, because a fixture is a recording; this one returns
 * live CONTEXTS, because an export verb has to be called against a workspace. Two files, one book:
 * the seed amounts and tax codes below are copied value for value from the A07 GUI world, so a
 * figure that appears in the exported file and a figure that appears on the A07 screen are the same
 * figure from the same postings, and a disagreement between file and screen is a test failure
 * somewhere rather than a discovery a filer makes at the ESTV.
 *
 * Not production code.
 */

import assert from 'node:assert/strict';

import { makeContext } from '../../dist/core/context.js';
import { postEntry, ledgerPorts } from '../../dist/core/ledger/index.js';
import { buildVatLines } from '../../dist/core/vat/index.js';
import { updateCompanyProfile } from '../../dist/core/setup/companyProfile.js';
import { setup } from './support.mjs';

/** Q2/2026 (quarterly, effektiv) and H1/2026 (semi-annual, Saldo), the two statutory cadences. */
export const Q2 = { periodStart: '2026-04-01', periodEnd: '2026-06-30' };
export const H1 = { periodStart: '2026-01-01', periodEnd: '2026-06-30' };

/**
 * The UID the worlds file under, in the STORED format (`CHE-###.###.###`).
 *
 * This was `CHE-116.281.277` and that is NOT an issuable UID: it fails the mod-11 check digit, so
 * the ESTV would reject it under MWST-0009. It passed only because the exporter pattern-matched
 * `CHE[1-9][0-9]{8}` without validating. The last digit is corrected to 1, which is the check digit
 * the algorithm actually yields for the prefix `11628127`, so the fixture is now a well-formed UID
 * and the check-digit test has something honest to assert against.
 */
export const UID = 'CHE-116.281.271';
export const ORG_NAME = 'Acme GmbH';

function enforcing({ store, workspaceId, clock, ids }) {
  return makeContext(store, {
    workspaceId,
    actor: 'user_1',
    clock,
    ids,
    ...ledgerPorts({ store, workspaceId, ids }),
  });
}

function acc(ctx, number) {
  return ctx.store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, number).id;
}

let key = 0;
const nextKey = (tag) => `ech0217-${tag}-${(key += 1)}`;

function post(ctx, { net, taxCode, date, direction, counter, other }) {
  const lines = buildVatLines(ctx, {
    counterAccount: acc(ctx, counter),
    revenueOrExpenseAccount: acc(ctx, other),
    amountMinor: net,
    amountIsGross: false,
    taxCode,
    direction,
    supplyDate: date,
  });
  const r = postEntry(ctx, { date, source: 'manual', idempotencyKey: nextKey(taxCode), lines });
  assert.equal(r.ok, true, `post failed: ${JSON.stringify(r)}`);
  return r;
}

const sale = (ctx, o) => post(ctx, { date: '2026-05-15', direction: 'output', counter: '1100', other: '3200', ...o });
const purchase = (ctx, o) => post(ctx, { date: '2026-05-20', direction: 'input', counter: '1000', other: '4000', ...o });
const bezug = (ctx, o) => post(ctx, { date: '2026-05-22', direction: 'input', counter: '2000', other: '4000', taxCode: 'BEZUG', ...o });

/** Give the workspace the identity eCH-0217's `generalInformation` requires. */
function identify(ctx, { uid = UID, name = ORG_NAME } = {}) {
  const r = updateCompanyProfile(ctx, { name, ...(uid === null ? {} : { uid }) });
  assert.equal(r.ok, true, `updateCompanyProfile failed: ${JSON.stringify(r)}`);
}

/**
 * The healthy effektiv book: two output rates, Bezugsteuer, and two Vorsteuer Ziffern.
 *
 * Deliberately more than one of everything. A one-rate, one-Ziffer book agrees with a wrong formula
 * by luck, which is how three filing-grade defects reached A07's critic reporting `reconciled: true`.
 */
export function effektivWorld({ identified = true } = {}) {
  const world = setup({ method: 'effektiv', timing: 'soll' });
  const ctx = enforcing(world);
  if (identified) identify(ctx);
  sale(ctx, { net: 4_400_000, taxCode: 'UST81' }); //     Normalsatz 8,1%, Ziffer 303
  sale(ctx, { net: 220_000, taxCode: 'UST26' }); //       Reduziert 2,6%, Ziffer 313
  sale(ctx, { net: 200_000, taxCode: 'EXPORT0' }); //     Befreit, Ziffer 220, no tax
  purchase(ctx, { net: 2_100_000, taxCode: 'VST-M' }); // Ziffer 400
  purchase(ctx, { net: 400_000, taxCode: 'VST-I' }); //   Ziffer 405
  bezug(ctx, { net: 100_000 }); //                        Ziffer 383 owed, deducted on 400
  return ctx;
}

/** A one-rate Saldo workspace: Ziffer 323 only, and no Vorsteuer block at all (Art. 37). */
export function saldoWorld() {
  const world = setup({ method: 'saldo', timing: 'soll', saldoRates: [{ rateBp: 620 }] });
  const ctx = enforcing(world);
  identify(ctx);
  sale(ctx, { net: 4_400_000, taxCode: 'UST81', date: '2026-03-15' });
  sale(ctx, { net: 220_000, taxCode: 'UST26', date: '2026-05-15' });
  return ctx;
}

/** Two Saldosteuersätze: the `saldo_activity_split_required` refusal F11 is being built to close. */
export function saldoSplitWorld() {
  const world = setup({ method: 'saldo', timing: 'soll', saldoRates: [{ rateBp: 620 }, { rateBp: 530 }] });
  const ctx = enforcing(world);
  identify(ctx);
  sale(ctx, { net: 4_400_000, taxCode: 'UST81', date: '2026-03-15' });
  return ctx;
}

/** Effektiv on IST timing: the engine refuses rather than handing an Ist filer the Soll figures. */
export function istWorld() {
  const world = setup({ method: 'effektiv', timing: 'ist' });
  const ctx = enforcing(world);
  identify(ctx);
  return ctx;
}

/** No MWST configuration at all. */
export function unconfiguredWorld() {
  const ctx = enforcing(setup({ registered: false }));
  identify(ctx);
  return ctx;
}

/**
 * A CREDIT period: more Vorsteuer than Umsatzsteuer, so the ESTV owes the business.
 *
 * eCH-0217 Kap. 4.4 Tabelle 1 gives `payableTax` both signs ("Zu bezahlender Betrag (positives
 * Vorzeichen), resp. Guthaben der steuerpflichtigen Person (negatives Vorzeichen)"), and there was
 * no credit test anywhere. A sign inversion here turns a refund into a bill of the same size and
 * the schema accepts it either way, so nothing would have caught it.
 */
export function creditWorld() {
  const world = setup({ method: 'effektiv', timing: 'soll' });
  const ctx = enforcing(world);
  identify(ctx);
  sale(ctx, { net: 100_000, taxCode: 'UST81' }); //          a little output tax
  purchase(ctx, { net: 5_000_000, taxCode: 'VST-M' }); //     a lot of input tax
  purchase(ctx, { net: 2_000_000, taxCode: 'VST-I' });
  return ctx;
}

/** Registered and configured, nothing posted: a NIL return, which is a real and filable thing. */
export function emptyWorld() {
  const ctx = enforcing(setup({ method: 'effektiv', timing: 'soll' }));
  identify(ctx);
  return ctx;
}
