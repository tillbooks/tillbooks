/**
 * F11: a FILED Saldo period does not move when a later ESTV approval is recorded.
 *
 * WHY THIS IS THE SHARPEST CLAIM IN THE CAPABILITY. Under the effektive Methode every posted line
 * carries its own tax code and its own rate, so a return recomputes from evidence stamped on the
 * journal and a later config change cannot reach it. Under the Saldosteuersatzmethode NO RATE IS
 * EVER STAMPED ON A LINE. The return multiplies the period's gross turnover by the rate that
 * GOVERNED that period, and the only record of which rate that was is
 * `vat_saldo_generations`. So the approval history is not a convenience view: it is the entire
 * evidentiary basis for a figure a person has already signed and sent to the ESTV.
 *
 * That makes the failure mode specific and silent. Record a Neuzuteilung today, recompute last
 * half-year, and a correct engine answers exactly what was filed while a wrong one answers a
 * different number with nothing refusing, warning, or recording that it moved. The previous attempt
 * at this capability failed in precisely that shape (a filed CHF 67.02 became CHF 81.00 on a
 * different Ziffer), which is why the assertions below compare the WHOLE return and the WHOLE
 * eCH-0217 document rather than a headline figure.
 *
 * MWSTG (SR 641.20) Art. 34 Abs. 2: the Steuerperiode is the calendar year. Art. 35 Abs. 1: "Bei der
 * Abrechnung nach Saldosteuersätzen (Art. 37 Abs. 1 und 2) erfolgt die Abrechnung halbjährlich", so
 * the filed period here is `2026-H1`.
 *
 * The arithmetic is the same café `test/vat/saldo-multirate.test.mjs` builds and hand-computes from
 * MWSTV Art. 84 Abs. 3 and Art. 88 Abs. 1: two approved rates, three Tätigkeiten, one round per RATE.
 * The figures are restated in the fixture below so this file can be read on its own.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { parseXml } from './ech0217-xsd.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);

/** The first element with this local name, anywhere in the document. */
function findDeep(node, local) {
  if (node.local === local) return node;
  for (const child of node.children) {
    const hit = findDeep(child, local);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

const H1 = { periodStart: '2026-01-01', periodEnd: '2026-06-30' };

/** Every journal row in the workspace, as a comparable string. Append-only means these never move. */
function journal(deps, workspaceId) {
  const entries = deps.store.db
    .prepare('SELECT * FROM journal_entry WHERE workspace_id = ? ORDER BY id')
    .all(workspaceId);
  const lines = deps.store.db
    .prepare(
      `SELECT l.* FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.workspace_id = ? ORDER BY l.id`,
    )
    .all(workspaceId);
  return JSON.stringify({ entries, lines });
}

/**
 * The café, built through the registry so the capability boundary is exercised on the way in.
 *
 *   Restauration  6.2%  Ertragskonto 3200
 *   Bankett       6.2%  Ertragskonto 3400   (a second Tätigkeit at the SAME rate, Art. 86 Abs. 3)
 *   Ablieferung   3.7%  Ertragskonto 3000
 *
 * Turnover, all Leistungsdatum 15.05.2026, all at the Normalsatz 8.1% (the Saldo flat rate applies to
 * the consideration INCLUDING tax, MWSTG Art. 37 Abs. 2):
 *
 *   3200 net 12'400.00 -> gross 1'340'440 Rappen
 *   3400 net  2'000.00 -> gross   216'200
 *   3000 net  3'150.00 -> gross   340'515
 *
 *   6.2%  1'556'640 * 620 / 10'000 =  96'511.68 ->  96'512   (Ziffer 323)
 *   3.7%    340'515 * 370 / 10'000 =  12'599.06 ->  12'599   (Ziffer 333)
 *   payable                                        109'111 Rappen = CHF 1'091.11
 */
function cafe(seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Café Bewilligung GmbH', `${seed}-ws`);

  // eCH-0217 refuses to build a declaration without the UID, so the profile carries one. The check
  // digit is real (mod 11, weights 5,4,3,2,7,6,5,4): a transposed digit is schema-valid and fails at
  // the ESTV portal under MWST-0009, so the export validates it rather than only the shape.
  const profile = call(deps, 'update_company_profile', { workspaceId, uid: 'CHE-116.281.271' });
  assert.equal(profile.ok, true, `update_company_profile failed: ${JSON.stringify(profile)}`);

  const cfg = call(deps, 'vat_configure', {
    workspaceId,
    method: 'saldo',
    timing: 'soll',
    registered: true,
    asOf: '2026-01-01',
    vatNumber: 'CHE-116.281.271 MWST',
    saldoRates: [{ rateBp: 620 }, { rateBp: 370 }],
    saldoActivities: [
      { activityId: 'restauration', name: 'Restauration', activityCode: '00123', rateBp: 620, accounts: ['3200'] },
      { activityId: 'bankett', name: 'Bankett', activityCode: '00124', rateBp: 620, accounts: ['3400'] },
      { activityId: 'ablieferung', name: 'Ablieferung', activityCode: '00125', rateBp: 370, accounts: ['3000'] },
    ],
    idempotencyKey: `${seed}-cfg`,
  });
  assert.equal(cfg.ok, true, `vat_configure failed: ${JSON.stringify(cfg)}`);

  let n = 0;
  const sale = (number, netMinor) => {
    n += 1;
    const preview = call(deps, 'vat_preview', {
      workspaceId,
      amountMinor: netMinor,
      amountIsGross: false,
      taxCode: 'UST81',
      supplyDate: '2026-05-15',
    });
    assert.equal(preview.ok, true, `vat_preview failed: ${JSON.stringify(preview)}`);
    const posted = call(deps, 'post_entry', {
      workspaceId,
      date: '2026-05-15',
      source: 'manual',
      idempotencyKey: `${seed}-sale-${n}`,
      lines: [
        { account: accId('1100'), debit: preview.grossMinor },
        {
          account: accId(number),
          credit: netMinor,
          taxCode: 'UST81',
          supplyDate: '2026-05-15',
        },
        { account: accId('2200'), credit: preview.taxMinor },
      ],
    });
    assert.equal(posted.ok, true, `post_entry failed: ${JSON.stringify(posted)}`);
  };

  sale('3200', 1240000);
  sale('3400', 200000);
  sale('3000', 315000);

  return { deps, workspaceId, accId };
}

/** Record a LATER ESTV approval, the way a Neuzuteilung reads: a new generation from a stated day. */
function regrant(deps, workspaceId, validFrom, rates, seed) {
  const res = call(deps, 'vat_configure', {
    workspaceId,
    method: 'saldo',
    timing: 'soll',
    registered: true,
    asOf: validFrom,
    saldoRates: rates,
    saldoActivities: [
      { activityId: 'restauration', name: 'Restauration', activityCode: '00123', rateBp: rates[0].rateBp, accounts: ['3200'] },
      { activityId: 'bankett', name: 'Bankett', activityCode: '00124', rateBp: rates[0].rateBp, accounts: ['3400'] },
      { activityId: 'ablieferung', name: 'Ablieferung', activityCode: '00125', rateBp: rates[1].rateBp, accounts: ['3000'] },
    ],
    saldoGrant: { validFrom },
    idempotencyKey: seed,
  });
  return res;
}

test('F11: the H1 figures are the hand-computed ones before anything is filed', () => {
  // The baseline this whole file compares against. Asserted on VALUES, because a suite in which
  // every key and kind matched once let eight wrong account names through.
  const { deps, workspaceId } = cafe('fp-base');
  const ret = call(deps, 'vat_return', { workspaceId, ...H1 });
  assert.equal(ret.ok, true, JSON.stringify(ret));
  assert.equal(ret.method, 'saldo');

  const ziff = (code) => ret.lines.find((l) => l.code === code);
  assert.equal(ziff('200').baseMinor, 1897155);
  assert.equal(ziff('299').baseMinor, 1897155);
  // H1/2026 files under the Beiblatt regime, so the two per-rate accumulations (96'512 at 6.2% on
  // 1'556'640 and 12'599 at 3.7% on 340'515) declare on ONE Ziffer, whose base is the whole of
  // Ziffer 299 by definition (MWST-Info 12 Ziff. 18.1.4, A07 §3.1a).
  assert.equal(ziff('323').baseMinor, ziff('299').baseMinor, 'Ziffer 323 declares the whole of Ziffer 299');
  assert.equal(ziff('323').baseMinor, 1897155);
  assert.equal(ziff('323').taxMinor, 109111, '96512 (6.2% accumulation) + 12599 (3.7%)');
  assert.equal(ziff('333'), undefined, 'the 2. Satz Ziffer is not a box on this period’s form');
  assert.equal(ret.payableMinor, 109111);
  assert.equal(ret.creditMinor, 0);
});

test('F11: a filed period keeps every figure when a LATER approval is recorded', () => {
  const { deps, workspaceId } = cafe('fp-later');

  const filedReturn = call(deps, 'vat_return', { workspaceId, ...H1 });
  assert.equal(filedReturn.ok, true, JSON.stringify(filedReturn));
  const filedExport = call(deps, 'vat_export_ech0217', { workspaceId, ...H1 });
  assert.equal(filedExport.ok, true, JSON.stringify(filedExport));
  const journalBefore = journal(deps, workspaceId);

  const filed = call(deps, 'vat_mark_filed', { workspaceId, period: '2026-H1', idempotencyKey: 'fp-later-file' });
  assert.equal(filed.ok, true, JSON.stringify(filed));
  assert.equal(filed.reason, 'vat_filed');
  assert.deepEqual(filed.months, ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']);

  const periods = call(deps, 'vat_periods', { workspaceId, year: '2026' });
  assert.equal(periods.ok, true);
  assert.equal(periods.method, 'saldo', 'MWSTG Art. 35 Abs. 1: Saldo files half-yearly');
  assert.deepEqual(
    periods.periods.map((p) => [p.label, p.filed]),
    [
      ['2026-H1', true],
      ['2026-H2', false],
    ],
  );

  // The ESTV grants new Saldosteuersätze from the start of the NEXT half-year. This is the exact
  // move that broke the previous attempt at this capability.
  const re = regrant(deps, workspaceId, '2026-07-01', [{ rateBp: 680 }, { rateBp: 450 }], 'fp-later-regrant');
  assert.equal(re.ok, true, `the lawful Neuzuteilung was refused: ${JSON.stringify(re)}`);

  const again = call(deps, 'vat_return', { workspaceId, ...H1 });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.deepEqual(again.lines, filedReturn.lines, 'a filed period recomputed to DIFFERENT Ziffern');
  assert.equal(again.payableMinor, filedReturn.payableMinor, 'a filed period recomputed to a different payable');
  assert.equal(again.creditMinor, filedReturn.creditMinor);
  assert.deepEqual(again.saldoActivities, filedReturn.saldoActivities);

  // The statutory artefact, whole. A person signs for the figures in this file.
  const exportAgain = call(deps, 'vat_export_ech0217', { workspaceId, ...H1 });
  assert.equal(exportAgain.ok, true, JSON.stringify(exportAgain));
  assert.equal(exportAgain.xml, filedExport.xml, 'the eCH-0217 document for a filed period changed');

  // Append-only: recording an approval writes no journal row and edits none.
  assert.equal(journal(deps, workspaceId), journalBefore, 'recording an approval touched the journal');
});

test('F11: the history says WHICH approval governed the filed period, and closes the predecessor', () => {
  // The evidence half. Under Saldo this is the only record of the rate a filed figure was computed
  // with, so it must survive the Neuzuteilung rather than being overwritten by it.
  const { deps, workspaceId } = cafe('fp-hist');
  assert.equal(call(deps, 'vat_mark_filed', { workspaceId, period: '2026-H1', idempotencyKey: 'fp-hist-file' }).ok, true);
  assert.equal(
    regrant(deps, workspaceId, '2026-07-01', [{ rateBp: 680 }, { rateBp: 450 }], 'fp-hist-regrant').ok,
    true,
  );

  const gens = call(deps, 'vat_saldo_generations', { workspaceId });
  assert.equal(gens.ok, true, JSON.stringify(gens));
  assert.equal(gens.generations.length, 2, 'the superseded approval must survive as a closed generation');

  const [first, second] = gens.generations;
  assert.deepEqual(
    first.rates.map((r) => r.rateBp),
    [620, 370],
    'the approval that governed the filed period must still read 6.2% and 3.7%',
  );
  assert.equal(first.validTo, '2026-06-30', 'the predecessor must be closed the day before the new one starts');
  assert.deepEqual(first.rates.map((r) => r.formLine), ['323', '333']);

  assert.equal(second.validFrom, '2026-07-01');
  assert.equal(second.validTo, null, 'the newest approval is open-ended');
  assert.deepEqual(
    second.rates.map((r) => r.rateBp),
    [680, 450],
  );
});

test('F11: the NEW approval governs its own half-year, so the change is not simply ignored', () => {
  // The other direction, and it is not a formality: an engine that answered the filed figure by
  // never reading the new generation at all would pass every assertion above. H2 must move.
  const { deps, workspaceId, accId } = cafe('fp-next');
  assert.equal(
    regrant(deps, workspaceId, '2026-07-01', [{ rateBp: 680 }, { rateBp: 450 }], 'fp-next-regrant').ok,
    true,
  );

  const preview = call(deps, 'vat_preview', {
    workspaceId,
    amountMinor: 100000,
    amountIsGross: false,
    taxCode: 'UST81',
    supplyDate: '2026-09-15',
  });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const posted = call(deps, 'post_entry', {
    workspaceId,
    date: '2026-09-15',
    source: 'manual',
    idempotencyKey: 'fp-next-sale',
    lines: [
      { account: accId('1100'), debit: preview.grossMinor },
      { account: accId('3200'), credit: 100000, taxCode: 'UST81', supplyDate: '2026-09-15' },
      { account: accId('2200'), credit: preview.taxMinor },
    ],
  });
  assert.equal(posted.ok, true, JSON.stringify(posted));

  const h2 = call(deps, 'vat_return', { workspaceId, periodStart: '2026-07-01', periodEnd: '2026-12-31' });
  assert.equal(h2.ok, true, JSON.stringify(h2));
  // net 1'000.00 at 8.1% -> gross 108'100 Rappen. 108'100 * 680 / 10'000 = 7'350.8 -> 7'351.
  const ziff = (code) => h2.lines.find((l) => l.code === code);
  assert.equal(ziff('323').baseMinor, 108100);
  assert.equal(ziff('323').taxMinor, 7351, 'H2 must be computed at the NEW 6.8%, not at the old 6.2%');
  assert.equal(h2.payableMinor, 7351);
});

test('F11: an approval landing inside a FILED period is refused, and the period stays reproducible', () => {
  // THIS TEST USED TO ASSERT THE DEFECT AS A FEATURE. It said "recording the approval itself is
  // lawful", accepted the grant, and then read the resulting
  // `saldo_rates_changed_within_period` as the safety property. It is not: a half-year two
  // approvals govern has no computable return AT ALL, so what the old assertions actually pinned was
  // a filed period becoming permanently unproducible. The artefact a person signed and sent could no
  // longer be re-derived for an audit or a Korrekturabrechnung, and the write that did it was
  // accepted without a word. The foundations-wave critic found it; this is the corrected contract.
  const { deps, workspaceId } = cafe('fp-inside');
  const filedReturn = call(deps, 'vat_return', { workspaceId, ...H1 });
  assert.equal(filedReturn.ok, true);
  assert.equal(call(deps, 'vat_mark_filed', { workspaceId, period: '2026-H1', idempotencyKey: 'fp-inside-file' }).ok, true);

  const mid = regrant(deps, workspaceId, '2026-04-01', [{ rateBp: 680 }, { rateBp: 450 }], 'fp-inside-regrant');
  assert.equal(mid.ok, false, `a grant reaching into a filed period must refuse: ${JSON.stringify(mid)}`);
  assert.equal(mid.error, 'saldo_grant_filed');
  assert.equal(mid.validFrom, '2026-04-01');
  // Named by VALUE, because a refusal that cannot say WHICH months it collided with leaves the
  // operator to guess the date that would have worked.
  assert.deepEqual(mid.filedMonths, ['2026-04', '2026-05', '2026-06']);

  // THE POINT OF THE REFUSAL: the filed period still computes, to the same figure it was filed at.
  const after = call(deps, 'vat_return', { workspaceId, ...H1 });
  assert.equal(after.ok, true, `the filed period must remain computable: ${JSON.stringify(after)}`);
  assert.equal(after.payableMinor, filedReturn.payableMinor);
  assert.equal(after.payableMinor, 109111);
  assert.equal(call(deps, 'vat_export_ech0217', { workspaceId, ...H1 }).ok, true, 'the filed eCH-0217 file must still be producible');
});

test('F11: an approval dated to the START of a filed period is refused, so the filed figure cannot move', () => {
  // The variant the critic did not test, and the worse of the two: dated to the first day of the
  // filed half, ONE approval still governs it, so nothing refuses downstream and the figure simply
  // moves. Measured before the guard: payable 109'111 became 106'727. It is also the LIKELIER shape,
  // because MWST-Info 12 Ziff. 15.6 dates a retroactive ESTV grant to "den Beginn der laufenden
  // Steuerperiode", never to a day inside a period.
  const { deps, workspaceId } = cafe('fp-start');
  const filedReturn = call(deps, 'vat_return', { workspaceId, ...H1 });
  assert.equal(filedReturn.ok, true);
  assert.equal(filedReturn.payableMinor, 109111);
  assert.equal(call(deps, 'vat_mark_filed', { workspaceId, period: '2026-H1', idempotencyKey: 'fp-start-file' }).ok, true);

  const retro = regrant(deps, workspaceId, '2026-01-01', [{ rateBp: 620 }, { rateBp: 300 }], 'fp-start-regrant');
  assert.equal(retro.ok, false, `a grant from the first filed day must refuse: ${JSON.stringify(retro)}`);
  assert.equal(retro.error, 'saldo_grant_filed');

  const after = call(deps, 'vat_return', { workspaceId, ...H1 });
  assert.equal(after.ok, true);
  assert.equal(after.payableMinor, 109111, 'the filed figure must not move');
  assert.notEqual(after.payableMinor, 106727, 'this is the figure the unguarded regrant produced');
});

test('F11: a grant from the first UNFILED day is still accepted, so the guard opens no new dead end', () => {
  // The other half of the contract, and the one that makes the refusal honest rather than a wall. A
  // guard that also blocked the lawful move would just relocate the dead end.
  const { deps, workspaceId } = cafe('fp-next');
  const filedReturn = call(deps, 'vat_return', { workspaceId, ...H1 });
  assert.equal(filedReturn.ok, true);
  assert.equal(call(deps, 'vat_mark_filed', { workspaceId, period: '2026-H1', idempotencyKey: 'fp-next-file' }).ok, true);

  const next = regrant(deps, workspaceId, '2026-07-01', [{ rateBp: 620 }, { rateBp: 300 }], 'fp-next-regrant');
  assert.equal(next.ok, true, `the first unfiled day must remain grantable: ${JSON.stringify(next)}`);

  const after = call(deps, 'vat_return', { workspaceId, ...H1 });
  assert.equal(after.ok, true);
  assert.equal(after.payableMinor, 109111, 'a later approval never reaches back into a filed period');
});

test('F11: the in-place refusal hands over the first unfiled DAY instead of a rule to apply', () => {
  // The hint on `saldo_generation_filed` used to say "record a NEW approval from the day it takes
  // effect" with no constraint on that day, which routed people straight into the grant defect above.
  // It now names the date, and that date is the one the test above proves is accepted.
  const { deps, workspaceId } = cafe('fp-hint');
  assert.equal(call(deps, 'vat_mark_filed', { workspaceId, period: '2026-H1', idempotencyKey: 'fp-hint-file' }).ok, true);

  const rewrite = call(deps, 'vat_configure', {
    workspaceId,
    method: 'saldo',
    timing: 'soll',
    registered: true,
    saldoRates: [{ rateBp: 680 }, { rateBp: 370 }],
    saldoActivities: [
      { activityId: 'restauration', name: 'Restauration', activityCode: '00123', rateBp: 680, accounts: ['3200'] },
      { activityId: 'bankett', name: 'Bankett', activityCode: '00124', rateBp: 680, accounts: ['3400'] },
      { activityId: 'ablieferung', name: 'Ablieferung', activityCode: '00125', rateBp: 370, accounts: ['3000'] },
    ],
    idempotencyKey: 'fp-hint-rewrite',
  });
  assert.equal(rewrite.ok, false);
  assert.equal(rewrite.error, 'saldo_generation_filed');
  assert.equal(rewrite.firstUnfiledFrom, '2026-07-01', 'the refusal names the day, by value');
});

test('F11: a mid-period approval on an UNFILED period still refuses the return (defence in depth)', () => {
  // `saldo_rates_changed_within_period` must stay reachable. Nothing is filed here, so the grant is
  // lawful to record, and the half-year it splits still has no single set of rates governing it.
  const { deps, workspaceId } = cafe('fp-split');
  const mid = regrant(deps, workspaceId, '2026-04-01', [{ rateBp: 680 }, { rateBp: 450 }], 'fp-split-regrant');
  assert.equal(mid.ok, true, `nothing is filed, so recording the approval is lawful: ${JSON.stringify(mid)}`);

  const straddled = call(deps, 'vat_return', { workspaceId, ...H1 });
  assert.equal(straddled.ok, false, 'a half-year governed by two approvals must not resolve to one figure');
  assert.equal(straddled.error, 'saldo_rates_changed_within_period');
  assert.equal(call(deps, 'vat_export_ech0217', { workspaceId, ...H1 }).ok, false, 'the export must refuse too');
});

test('F11: marking a period filed twice on one key locks its six months ONCE', () => {
  // §H-IDEMPOTENT on the one statutory statement in the product. Counted on `period_lock` rows,
  // because a duplicate lock per month is invisible in the returned Result.
  const { deps, workspaceId } = cafe('fp-idem');
  const input = { workspaceId, period: '2026-H1', idempotencyKey: 'fp-idem-file' };

  const first = call(deps, 'vat_mark_filed', input);
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = call(deps, 'vat_mark_filed', input);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(JSON.stringify(second), JSON.stringify(first));

  const locks = deps.store.db
    .prepare("SELECT period FROM period_lock WHERE workspace_id = ? AND kind = 'hard' AND reason = 'vat_filed' ORDER BY period")
    .all(workspaceId)
    .map((r) => r.period);
  assert.deepEqual(locks, ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']);
});

test('F11: a filed period is sealed, so its turnover cannot be edited, only reversed', () => {
  // The append-only half, stated where it bites hardest. A filing applies A03's HARD lock, so the
  // only lawful correction to a filed half-year is a reversing entry in an open period, never an
  // edit of the entries the figure was computed from.
  const { deps, workspaceId, accId } = cafe('fp-seal');
  const before = journal(deps, workspaceId);
  assert.equal(call(deps, 'vat_mark_filed', { workspaceId, period: '2026-H1', idempotencyKey: 'fp-seal-file' }).ok, true);

  const intoSealed = call(deps, 'post_entry', {
    workspaceId,
    date: '2026-05-20',
    source: 'manual',
    idempotencyKey: 'fp-seal-post',
    lines: [
      { account: accId('6500'), debit: 5000 },
      { account: accId('1000'), credit: 5000 },
    ],
  });
  assert.equal(intoSealed.ok, false, 'a posting landed inside a filed half-year');
  assert.equal(journal(deps, workspaceId), before, 'the refused post still wrote to the journal');

  // Unlocking a filing seal is refused as well: the lock is the record that a statement was made.
  const unlocked = call(deps, 'unlock_period', { workspaceId, period: '2026-05', idempotencyKey: 'fp-seal-unlock' });
  assert.equal(unlocked.ok, false, 'a filing seal was unlocked');

  // The lawful correction is a reversal, and it lands in an OPEN period.
  const target = deps.store.db
    .prepare("SELECT id FROM journal_entry WHERE workspace_id = ? AND status = 'posted' ORDER BY id LIMIT 1")
    .get(workspaceId).id;
  const reversed = call(deps, 'reverse_entry', {
    workspaceId,
    entryId: target,
    date: '2026-07-15',
    idempotencyKey: 'fp-seal-reverse',
  });
  assert.equal(reversed.ok, true, `the lawful correction was refused: ${JSON.stringify(reversed)}`);
  const original = deps.store.db.prepare('SELECT * FROM journal_entry WHERE id = ?').get(target);
  assert.equal(original.status, 'posted', 'the reversal mutated the original entry instead of mirroring it');
});

test('F11: the exported eCH-0217 carries the per-Tätigkeit VALUES, not merely the right elements', () => {
  // The last link, and the reason it is asserted on values. A person signs for what is IN this file
  // and uploads it to the ESTV. `test/vat/saldo-multirate.test.mjs` pins the arithmetic inside the
  // engine; nothing until here proved that the same francs come out the other end of the mapper. The
  // known way for this to go wrong quietly is a document where every element name and every kind
  // matches and every figure is somebody else's.
  //
  // eCH-0217 v2.0.0 Kap. 5.3.11: from 01.01.2025 a Saldo declaration reports turnover PER TÄTIGKEIT,
  // each row carrying the ESTV's five-character `activityID`, its `taxRate`, and the `turnover` in
  // francs. It carries no per-row TAX figure at all: the ESTV recomputes, which is exactly why a
  // per-activity tax number would be an invention with nowhere to go.
  const { deps, workspaceId } = cafe('fp-xml');
  const exported = call(deps, 'vat_export_ech0217', { workspaceId, ...H1 });
  assert.equal(exported.ok, true, JSON.stringify(exported));

  const doc = parseXml(exported.xml);
  const method = findDeep(doc, 'simpleTaxRateMethod');
  assert.ok(method !== undefined, 'a 2025+ Saldo period must be declared as simpleTaxRateMethod');

  const rows = method.children
    .filter((c) => c.local === 'suppliesPerTaxRate')
    .map((row) => Object.fromEntries(row.children.map((c) => [c.local, c.text.trim()])));

  // Three Tätigkeiten, each at ITS OWN rate and its own gross turnover in francs. 1'340'440 /
  // 216'200 / 340'515 Rappen are the figures the fixture header computes.
  //
  // Keyed by `activityID` rather than compared as an ordered list, deliberately. The engine emits
  // the rows sorted by (rate position, activityId), so the two 6.2% rows come out as bankett before
  // restauration, which is not the order they were configured in. eCH-0217 states no ordering
  // requirement for `suppliesPerTaxRate`, so pinning that sort would assert an implementation detail
  // and redden on a change that moved no money. What must not move is which figure sits against
  // which approved Tätigkeitscode.
  assert.equal(rows.length, 3, 'one row per Tätigkeit, and no row invented or dropped');
  assert.deepEqual(
    Object.fromEntries(rows.map((r) => [r.activityID, r])),
    {
      '00123': { activityID: '00123', taxRate: '6.20', turnover: '13404.40' },
      '00124': { activityID: '00124', taxRate: '6.20', turnover: '2162.00' },
      '00125': { activityID: '00125', taxRate: '3.70', turnover: '3405.15' },
    },
  );

  // And the rows cross-foot to the taxable total the return reports on Ziffer 299.
  const summed = rows.reduce((n, r) => n + Math.round(Number(r.turnover) * 100), 0);
  const ret = call(deps, 'vat_return', { workspaceId, ...H1 });
  assert.equal(summed, ret.lines.find((l) => l.code === '299').baseMinor);
  assert.equal(summed, 1897155);

  // The document survives a later approval unchanged, which is the same claim as the one above made
  // on the artefact rather than on the read model.
  assert.equal(
    regrant(deps, workspaceId, '2026-07-01', [{ rateBp: 680 }, { rateBp: 450 }], 'fp-xml-regrant').ok,
    true,
  );
  const again = call(deps, 'vat_export_ech0217', { workspaceId, ...H1 });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.xml, exported.xml);
});
