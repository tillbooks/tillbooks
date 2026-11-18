// @ts-nocheck
/**
 * D196 re-cut, the two bank holes the critics found, measured ON ROWS (synthetic data only):
 *  - paper critic H2: `book_bank_line` with `refundVat` keeps a receipt's VAT; an `attach` files the draft
 *    under `close-period`, which hid its `vat-file`. Under the grant the agent's approval refuses both ways
 *    and the 2200 balance does not move.
 *  - code critic H1: an agent-approved Buchungsregel EDIT vacated a text slot, so a person's Autopilot rule
 *    booked those lines unattended after a revoke. Under the grant an edit refuses `rule_edit`, and the line
 *    stays unbooked after the tick.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleRest } from '../../dist/api/rest.js';
import { getAction } from '../../dist/api/registry.js';
import { bookBankLine } from '../../dist/core/banking/index.js';
import { setBankStandard } from '../../dist/core/banking/bankStandards.js';
import { grantRuleAutobook } from '../../dist/core/banking/autobook.js';
import { settingsSet } from '../../dist/core/settings/index.js';
import { world, importLines, must, balanceOf } from './bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, autopilot, decisionOf, at } from './n04-autobook-support.mjs';

const PDF = Buffer.from('%PDF-1.4\n% invented refund note\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n', 'latin1').toString('base64');

function refundWorld() {
  const t = world();
  must(settingsSet(t.ctx, { key: 'bank.anzahlung_vat', value: true, reason: 'Art. 40 MWSTG', idempotencyKey: 'vat-on' }), 'setting');
  must(settingsSet(t.ctx, { key: 'bank.anzahlung_vat_refund', value: 'refuse', reason: 'Test', idempotencyKey: 'refund-setting' }), 'setting');
  const line = importLines(t, { statementId: 'e3v', from: '2026-09-01', to: '2026-09-30', entries: [{ ref: 'AN', amountMinor: 108100, cd: 'CRDT', date: '2026-09-20', name: 'Muster AG', ustrd: 'Anzahlung Projekt' }] }).lines['AN'];
  must(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'contact', contactId: t.customerId }, idempotencyKey: 'b' }), 'receipt');
  const rf = importLines(t, { statementId: 'e3v-rf', from: '2026-10-01', to: '2026-10-31', entries: [{ ref: 'RF', amountMinor: 108100, cd: 'DBIT', date: '2026-10-10', name: 'Muster AG' }] }).lines;
  return { t, rf };
}

for (const withAttach of [false, true]) {
  test(`paper critic H2: a VAT-refund booking waits for a person under the grant (attach=${withAttach})`, () => {
    const { t, rf } = refundWorld();
    const ws = t.workspaceId;
    const person = { ...t.deps, actor: 'studio' };
    const agent = { ...t.deps, actor: 'agent' };
    assert.equal(getAction('settings_set').run(person, { workspaceId: ws, key: 'agent.decide_proposals', value: 'decide', reason: 'Test', idempotencyKey: 'grant' }).ok, true);
    const up = getAction('files_upload').run(person, { workspaceId: ws, title: 'Rückzahlungsbeleg', filename: 'rf.pdf', mime: 'application/pdf', contentBase64: PDF, idempotencyKey: 'up' });
    assert.equal(up.ok, true, JSON.stringify(up));
    const d = handleRest('book_bank_line', {
      workspaceId: ws, bankTxnId: rf['RF'],
      target: { kind: 'contact', contactId: t.customerId, refundVat: 'keep', overrideReason: 'Kunde bleibt' },
      idempotencyKey: `a-${withAttach}`,
      ...(withAttach ? { attach: [{ fileId: up.file.id }] } : {}),
    }, agent).body;
    assert.equal(d.drafted, true, JSON.stringify(d));
    const before = balanceOf(t.store, ws, '2200');
    const a = handleRest('approve_drafted_action', { workspaceId: ws, actionId: d.actionId }, agent).body;
    assert.equal(a.grantExclusion, 'excluded_family', JSON.stringify(a));
    assert.equal(balanceOf(t.store, ws, '2200'), before, '2200 unchanged');
    assert.equal(t.store.db.prepare('SELECT status FROM agent_action WHERE id = ?').get(d.actionId).status, 'pending');
  });
}

test('code critic H1: a Buchungsregel edit waits for a person, so a person\'s Autopilot rule never takes the vacated lines', () => {
  const t = ruleWorld();
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  // The person's text rule T for the same counterparty: device purchases go to 1500, never to 6570.
  const [tline] = debits(t, [900], { ustrd: 'Geraet Kauf' });
  const T = must(setBankStandard(t.ctx, { bankTxnId: tline, accountId: t.acc('1500'), taxCode: null, matchText: 'Geraet', idempotencyKey: 'tx-rule' })).standard.id;
  must(grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: 'g1' }));
  const person = { ...t.deps, actor: t.ctx.actor };
  const agent = { ...t.deps, actor: 'agent' };
  let k = 0;
  const set = (value) => assert.equal(getAction('settings_set').run(person, { workspaceId: t.workspaceId, key: 'agent.decide_proposals', value, reason: 'Test', idempotencyKey: `s${++k}` }).ok, true);
  set('decide');
  const d = handleRest('set_bank_standard', { workspaceId: t.workspaceId, standardId: T, accountId: t.acc('1500'), taxCode: null, matchText: 'zzqx', idempotencyKey: 'agent-edit' }, agent).body;
  assert.equal(d.drafted, true, JSON.stringify(d));
  const a = handleRest('approve_drafted_action', { workspaceId: t.workspaceId, actionId: d.actionId }, agent).body;
  assert.equal(a.grantExclusion, 'rule_edit', JSON.stringify(a));
  set('off');
  at(t, '2026-07-20T08:00:00.000Z');
  const [fresh] = debits(t, [1250], { ustrd: 'Geraet Kauf Laptop' });
  autopilot(t).tick();
  assert.equal(decisionOf(t, fresh), undefined, 'the device line is not booked unattended');
});

test('a NEW Buchungsregel saved from a line stays approvable under the grant (the founder\'s case)', () => {
  const t = ruleWorld();
  const [line] = debits(t, [4200], { ustrd: 'Kontoführung Oktober' });
  const person = { ...t.deps, actor: t.ctx.actor };
  const agent = { ...t.deps, actor: 'agent' };
  assert.equal(getAction('settings_set').run(person, { workspaceId: t.workspaceId, key: 'agent.decide_proposals', value: 'decide', reason: 'Test', idempotencyKey: 'grant' }).ok, true);
  const d = handleRest('set_bank_standard', { workspaceId: t.workspaceId, bankTxnId: line, accountId: t.acc('6570'), taxCode: null, matchText: 'Kontoführung', idempotencyKey: 'agent-new' }, agent).body;
  assert.equal(d.drafted, true, JSON.stringify(d));
  const a = handleRest('approve_drafted_action', { workspaceId: t.workspaceId, actionId: d.actionId }, agent).body;
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.status, 'executed');
});

test('confirming critic M1: a new Vorlage that takes over a person\'s Vorlage waits for a person under the grant', async () => {
  const { setVorlageSchedule } = await import('../../dist/core/ledger/vorlageSchedule.js');
  const t = world();
  const leg = (number, side, amount) => ({ accountId: t.acc(number), taxCode: null, side, amount });
  const V = must(setBankStandard(t.ctx, { scope: 'manual', label: 'Miete', legs: [leg('6000', 'debit', { kind: 'ask', label: 'Miete' }), leg('2800', 'credit', { kind: 'rest' })], idempotencyKey: 'v-miete' })).standard.id;
  must(setVorlageSchedule(t.ctx, { vorlageId: V, every: 'month', anchorDay: 28, start: '2026-01-01', mode: 'post', asks: { 0: 250000 }, idempotencyKey: 'sched' }));
  const person = { ...t.deps, actor: t.ctx.actor };
  const agent = { ...t.deps, actor: 'agent' };
  assert.equal(getAction('settings_set').run(person, { workspaceId: t.workspaceId, key: 'agent.decide_proposals', value: 'decide', reason: 'Test', idempotencyKey: 'grant' }).ok, true);
  const d = handleRest('set_bank_standard', { workspaceId: t.workspaceId, scope: 'manual', label: 'Miete', replaceStandardId: V, legs: [leg('6500', 'debit', { kind: 'ask', label: 'Miete' }), leg('2800', 'credit', { kind: 'rest' })], idempotencyKey: 'agent-vorlage' }, agent).body;
  assert.equal(d.drafted, true, JSON.stringify(d));
  const a = handleRest('approve_drafted_action', { workspaceId: t.workspaceId, actionId: d.actionId }, agent).body;
  assert.equal(a.grantExclusion, 'rule_edit', JSON.stringify(a));
  assert.equal(t.store.db.prepare('SELECT superseded_at FROM bank_standard WHERE id = ?').get(V).superseded_at, null, 'the person\'s Vorlage stands');
});
