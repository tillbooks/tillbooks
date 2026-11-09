// A41 security review (07.11.2026), three findings and their fixes, asserted in the ENGINE:
//   S1 a capture read answers bank lines only to a seat that may also read the bank inbox (read_sales);
//   S2 a bank-inbox read answers captured receipts only to a seat that may also read the filing register
//      (read_master_data); the engine evidence follows the same two rights;
//   S3 the evidence's agreement compares AMOUNTS too: the right accounts with another split, or one rule with
//      other asked amounts, never inherit the engine's certainty.
//
// SYNTHETIC BY CONSTRUCTION: invented vendors, IBANs, amounts and dates (a41-beleg-support.mjs).

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { makeContext } from '../../dist/core/context.js';
import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { ok, err } from '../../dist/core/result.js';
import { listBankInbox } from '../../dist/core/banking/index.js';
import { bankLineCandidatesForCaptures } from '../../dist/core/banking/belegMatch.js';
import { STATEMENT_COVERS_SQL } from '../../dist/core/banking/bankInbox.js';
import { evidenceContext, evidenceForBooking, vorschlagEvidenceOf } from '../../dist/core/banking/belegEvidence.js';
import { setBankStandard } from '../../dist/core/banking/bankStandards.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { readBankTxn, readBankTxnDetail } from '../../dist/core/banking/bankLines.js';
import { must, world, secondWorkspace, assertClaimInvariantHolds } from './bank-inbox-support.mjs';
import { receipt, lines } from './a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

const denying = (t, denied) =>
  makeContext(t.store, {
    workspaceId: t.workspaceId,
    actor: 'user_1',
    clock: t.clock,
    ids: t.ids,
    capabilities: { assert: (c) => (denied.includes(c) ? err('permission_denied', { capability: c }) : ok()) },
  });
const inboxLine = (ctx, id) => must(listBankInbox(ctx, { bankTxnId: id, status: 'all' })).lines[0];
const forCaptures = (ctx) => bankLineCandidatesForCaptures(ctx, STATEMENT_COVERS_SQL);

function paired() {
  const t = world();
  const r = receipt(t, { amount: 6100, date: '2026-07-14' });
  const [line] = lines(t, [{ amount: 6100, date: '2026-07-14' }]);
  return { t, r, line };
}

test('S1: the capture side names bank lines only to a seat that may read the bank inbox too', () => {
  const { t, r, line } = paired();
  assert.deepEqual(forCaptures(t.ctx).get(r.captureId).map((c) => c.bankTxnId), [line], 'both rights: the line');
  assert.equal(forCaptures(denying(t, ['read_sales'])).size, 0, 'the capture right alone: nothing');
});

test('S2: the inbox names captured receipts only to a seat that may read the filing register too', () => {
  const { t, r, line } = paired();
  assert.deepEqual(inboxLine(t.ctx, line).belegCandidates.map((g) => g.files[0].fileId), [r.fileId], 'both rights: the receipt');
  assert.deepEqual(inboxLine(denying(t, ['read_master_data']), line).belegCandidates, [], 'the bank right alone: nothing');
});

test('S2: the evidence shows receipt figures only with the filing right, but ALWAYS judges them (no fail-open)', () => {
  const t = world();
  const cp = { name: 'Netzwerk Beispiel AG', iban: 'CH4431999123000889012' };
  const [first] = lines(t, [{ amount: 1000, date: '2026-07-02', ...cp }]);
  must(setBankStandard(t.ctx, { bankTxnId: first, accountId: t.acc('6570'), taxCode: null, idempotencyKey: 'r-s2' }));
  const fits = receipt(t, { amount: 6100, vendor: cp.name, date: '2026-07-14' });
  const off = receipt(t, { amount: 9900, vendor: cp.name, date: '2026-07-14' });
  const [line] = lines(t, [{ amount: 6100, date: '2026-07-14', ...cp }]);
  const payload = (fileId) => ({ bankTxnId: line, target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 6100 }] }, attach: [{ fileId }] });
  const ev = (ctx, fileId) => vorschlagEvidenceOf(ctx, evidenceContext(ctx), payload(fileId));
  // With the right: unchanged.
  assert.equal(ev(t.ctx, fits.fileId).certainty, 'sure');
  assert.equal(ev(t.ctx, fits.fileId).belege.length, 1);
  assert.equal(ev(t.ctx, off.fileId).certainty, 'check');
  const noFiles = denying(t, ['read_master_data']);
  // Without it, the receipts cap the certainty at check (it cannot bulk on what it cannot see), no figure is
  // shown, and the answer is IDENTICAL whether the hidden receipt agrees or not (no side channel).
  const bad = ev(noFiles, off.fileId);
  const good = ev(noFiles, fits.fileId);
  assert.equal(good.certainty, 'check');
  assert.deepEqual(good.reasons, ['agrees', 'belege_not_readable']);
  assert.deepEqual(good.belege, []);
  assert.equal(good.vat, null);
  assert.equal(JSON.stringify(bad), JSON.stringify(good), 'byte-identical for an agreeing and a disagreeing receipt');
  // Without the bank right there is no evidence at all.
  const noBank = denying(t, ['read_sales']);
  assert.equal(ev(noBank, fits.fileId), null);
});

test('S1 §H-TENANT: with every right, another workspace sees neither the receipt nor the line', () => {
  const { t, r } = paired();
  const b = secondWorkspace(t);
  assert.equal(forCaptures(b.ctx).has(r.captureId), false, "this workspace's capture is not the other's");
  assert.equal(forCaptures(b.ctx).size, 0);
  // The inbox side of the tenant rule: a41-beleg-match.test.mjs, "another workspace's receipt never pairs".
});

test('S3: the right accounts with another split, or a rule with other asked amounts, are check; identical inherits', () => {
  const t = world();
  const cp = { name: 'Agentur Beispiel AG', iban: 'CH5800791123000889012' };
  const [first] = lines(t, [{ amount: 1000, date: '2026-05-02', ...cp }]);
  // A two-leg rule: 6600 asked, 6500 the rest.
  const ruleId = must(
    setBankStandard(t.ctx, {
      bankTxnId: first,
      legs: [
        { accountId: t.acc('6600'), amount: { kind: 'ask', label: 'Druck' } },
        { accountId: t.acc('6500'), amount: { kind: 'rest' } },
      ],
      idempotencyKey: 'r-split',
    }),
  ).standard.id;
  const [line] = lines(t, [{ amount: 9000, date: '2026-05-10', ...cp }]);
  const row = readBankTxn(t.ctx, line);
  const ev = (target) => evidenceForBooking(t.ctx, evidenceContext(t.ctx), row, readBankTxnDetail(t.ctx, line), null, target, undefined);
  const engineRule = ev({ kind: 'rule', standardId: ruleId, asks: { 0: 4000 } });
  // The engine's own proposal asks for the amount (rule_needs_amount): an agent filling it in is not the
  // engine's figure, so it can never inherit a certainty the engine did not give.
  assert.equal(engineRule.engine.reasonCode, 'rule_needs_amount');
  assert.equal(engineRule.agrees, false);
  assert.equal(engineRule.certainty, 'check');
  // A complete one-leg rule on another counterparty: identical inherits; a split over the same account set does not.
  const cp2 = { name: 'Leitung Beispiel AG', iban: 'CH4431999123000889012' };
  const [first2] = lines(t, [{ amount: 1000, date: '2026-05-03', ...cp2 }]);
  must(setBankStandard(t.ctx, { bankTxnId: first2, accountId: t.acc('6570'), taxCode: null, idempotencyKey: 'r-one' }));
  const [line2] = lines(t, [{ amount: 9000, date: '2026-05-11', ...cp2 }]);
  const row2 = readBankTxn(t.ctx, line2);
  const ev2 = (target) => evidenceForBooking(t.ctx, evidenceContext(t.ctx), row2, readBankTxnDetail(t.ctx, line2), null, target, undefined);
  const same = ev2({ kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 9000 }] });
  assert.equal(same.agrees, true);
  assert.equal(same.certainty, 'sure');
  const split = ev2({ kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 5000 }, { accountId: t.acc('6570'), amountMinor: 4000 }] });
  assert.equal(split.agrees, false, 'same account, another split');
  assert.equal(split.certainty, 'check');
  assert.deepEqual(split.reasons, ['differs_from_engine']);
});

test('S3 (critic r1 B3): the same accounts and leg count with the amounts swapped never inherit; the engine\'s own split does', () => {
  const t = world();
  must(settingsSet(t.ctx, { key: 'bank.buchungsregel_computed_mode', value: 'bulk', reason: 'A41 test', idempotencyKey: 'cm-s3' }));
  const cp = { name: 'Tausch Beispiel AG', iban: 'CH4431999123000889012' };
  const [first] = lines(t, [{ amount: 1000, date: '2026-05-02', ...cp }]);
  const ruleId = must(
    setBankStandard(t.ctx, {
      bankTxnId: first,
      legs: [
        { accountId: t.acc('6600'), amount: { kind: 'factor', label: 'Drittel', num: 1, den: 3 } },
        { accountId: t.acc('6500'), amount: { kind: 'rest' } },
      ],
      idempotencyKey: 'r-s3',
    }),
  ).standard.id;
  const [line] = lines(t, [{ amount: 9000, date: '2026-05-10', ...cp }]);
  const row = readBankTxn(t.ctx, line);
  const ev = (target) => evidenceForBooking(t.ctx, evidenceContext(t.ctx), row, readBankTxnDetail(t.ctx, line), null, target, undefined);
  const ownSplit = ev({ kind: 'accounts', legs: [{ accountId: t.acc('6600'), amountMinor: 3000 }, { accountId: t.acc('6500'), amountMinor: 6000 }] });
  assert.equal(ownSplit.engine.certainty, 'sure');
  assert.equal(ownSplit.agrees, true, 'the engine\'s own amounts, as accounts');
  assert.equal(ownSplit.certainty, 'sure');
  const swapped = ev({ kind: 'accounts', legs: [{ accountId: t.acc('6600'), amountMinor: 6000 }, { accountId: t.acc('6500'), amountMinor: 3000 }] });
  assert.equal(swapped.agrees, false, 'amounts swapped between the same two accounts');
  assert.equal(swapped.certainty, 'check');
  assert.deepEqual(swapped.reasons, ['differs_from_engine']);
});

test('critic r1 G1 (kept without A41.3): no agent may widen a belege.* setting, even under an open customize dial', () => {
  const t = world();
  must(getAction('set_agent_dial').run({ ...t.deps, actor: 'studio' }, { workspaceId: t.workspaceId, capability: 'customize', level: 'auto', idempotencyKey: 'dial-c' }));
  for (const [key, value] of [['belege.vat_delta_tolerance_rappen', 500], ['belege.match_fx_tolerance_pct', 20], ['belege.match_date_window_days', 60], ['belege.match_mode', 'off']]) {
    const res = handleRest('settings_set', { workspaceId: t.workspaceId, key, value, reason: 'Agent', idempotencyKey: `ag-${key}` }, { ...t.deps, actor: 'agent' }).body;
    assert.equal(res.error, 'human_only', `${key}: ${JSON.stringify(res)}`);
  }
});
