// N04 (D183), Autopilot: a Buchungsregel that earned it books its own lines. The INVARIANTS a non-author
// critic reviews, each named in its test title:
//   I1 no double booking: a re-run, a second scheduler, a reopen followed by a re-grant;
//   I2 ladder precedence: an existing entry outranks the rule;
//   I3 the ceiling is fixed at grant and bound to its currency;
//   I4 a governed granter (or an agent at the door, under every dial) is refused;
//   I5 the suspension hooks: reopen, a changed booking, a granter who lost the right;
//   I6 an edit ends the grant; rules.autobook = off stops every grant at once; revoke.
//
// SYNTHETIC DATA ONLY: invented counterparties on invented IBANs (bank-inbox-support.mjs), every amount
// invented, every statement spelled by hand.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { callTool } from '../../dist/api/mcp.js';
import { bookBankLine, reopenBankLine } from '../../dist/core/banking/bankBooking.js';
import { setBankStandard, readLiveRule } from '../../dist/core/banking/bankStandards.js';
import { createBankAccount } from '../../dist/core/banking/index.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { rejectDraftedAction, approveDraftedAction } from '../../dist/core/agent/draftedActions.js';
import { makeContext } from '../../dist/core/context.js';
import {
  autobookCandidates,
  autobookDigest,
  autobookEligibility,
  autopilotMarkSeen,
  cleanUsesOf,
  grantRuleAutobook,
  revokeRuleAutobook,
  runAutobookStep,
  unseenDigestDays,
} from '../../dist/core/banking/autobook.js';
import { postEntry, softCloseMonth } from '../../dist/core/ledger/index.js';
import { ATTENTION_PROVIDERS } from '../../dist/core/attention/index.js';
import { must, refused, assertClaimInvariantHolds, secondWorkspace, postedBill, SAVINGS_IBAN } from './bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, autopilot, runs, decisionOf, at, entryCount, proposalOf, TELCO, TELCO_IBAN } from './n04-autobook-support.mjs';

afterEach(assertClaimInvariantHolds);

const LATER = '2026-07-20T08:00:00.000Z';
const grant = (t, key = 'grant-1', ruleId = t.ruleId, ctx = t.ctx) => must(grantRuleAutobook(ctx, { standardId: ruleId, idempotencyKey: key }), 'grant').grant;
const earned = (t, amounts = [1100, 1200, 1300]) => debits(t, amounts).map((id) => (bookAsProposed(t, id), id));
const offers = (t) => t.store.db.prepare("SELECT * FROM agent_action WHERE workspace_id = ? AND action_tool = 'grant_rule_autobook' ORDER BY rowid").all(t.workspaceId);
const grantRow = (t, id) => t.store.db.prepare('SELECT * FROM rule_autobook_grant WHERE id = ?').get(id);
const reg = (t, name, input, actor = 'user_1') => getAction(name).run({ ...t.deps, actor }, { workspaceId: t.workspaceId, ...input });
const agentMcp = (t, name, args) => JSON.parse(callTool({ ...t.deps, actor: 'agent' }, name, { workspaceId: t.workspaceId, ...args }).content[0].text);
const setting = (t, key, value, ctx = t.ctx) => must(settingsSet(ctx, { key, value, reason: 'N04 test', idempotencyKey: 's-' + key + '-' + value }));
const runOf = (t, line) => runs(t).find((r) => r.bank_txn_id === line);
const channelOf = (ruleId) => 'autobook:' + ruleId;

/** A world whose rule earned its grant (3 clean uses by a person), granted, the clock moved on. */
function granted(opts) {
  const t = ruleWorld(opts);
  earned(t);
  const g = grant(t);
  at(t, LATER);
  return { ...t, grantId: g.grantId, ap: autopilot(t) };
}

// ================================================================================================
// Eligibility and the clean count
// ================================================================================================

test('eligibility: a complete IBAN rule can earn it; ask, ignore, name key, via, own account and the mode cannot', () => {
  const t = ruleWorld();
  const rule = (id) => readLiveRule(t.ctx, id);
  assert.deepEqual(autobookEligibility(t.ctx, rule(t.ruleId)), { eligible: true, kind: 'complete' });
  setting(t, 'bank.buchungsregel_mode', 'suggest');
  assert.deepEqual(autobookEligibility(t.ctx, rule(t.ruleId)), { eligible: false, reason: 'mode_not_bulk' });
  setting(t, 'bank.buchungsregel_mode', 'bulk');
  const [print] = debits(t, [2500], { name: 'Druckhaus Muster GmbH', iban: 'CH4431999123000889013' });
  const asks = must(
    setBankStandard(t.ctx, { bankTxnId: print, legs: [{ accountId: t.acc('6600'), amount: { kind: 'ask', label: 'Druck' } }, { accountId: t.acc('6500'), amount: { kind: 'rest' } }], idempotencyKey: 'r-ask' }),
  ).standard.id;
  assert.deepEqual(autobookEligibility(t.ctx, rule(asks)), { eligible: false, reason: 'asks_amount' });
  const [named] = debits(t, [700], { name: 'Kiosk Ecke', iban: null });
  const byName = must(setBankStandard(t.ctx, { bankTxnId: named, accountId: t.acc('6500'), taxCode: null, idempotencyKey: 'r-name' })).standard.id;
  assert.deepEqual(autobookEligibility(t.ctx, rule(byName)), { eligible: false, reason: 'name_key' });
  const [ign] = debits(t, [900], { name: 'Spende Verein', iban: 'CH4431999123000889014' });
  const ignore = must(setBankStandard(t.ctx, { bankTxnId: ign, outcome: 'ignore', ignoreReason: 'other', idempotencyKey: 'r-ign' })).standard.id;
  assert.deepEqual(autobookEligibility(t.ctx, rule(ignore)), { eligible: false, reason: 'ignore_rule' });
  const [own] = debits(t, [5000], { name: 'Sparkonto', iban: SAVINGS_IBAN });
  const transfer = must(setBankStandard(t.ctx, { bankTxnId: own, accountId: t.acc('6500'), taxCode: null, idempotencyKey: 'r-own' })).standard.id;
  must(createBankAccount(t.ctx, { name: 'Sparkonto', iban: SAVINGS_IBAN, currency: 'CHF', ledgerAccountId: t.acc('1060'), idempotencyKey: 'ba-sav' }));
  assert.deepEqual(autobookEligibility(t.ctx, rule(transfer)), { eligible: false, reason: 'own_account' }, 'own-account transfers never autobook (D139 section 7)');
  const via = must(reg(t, 'create_account', { number: '1095', name: 'Durchlaufkonto Telco', type: 'asset', idempotencyKey: 'via' })).accountId;
  const viaRule = must(setBankStandard(t.ctx, { standardId: t.ruleId, accountId: t.acc('6570'), taxCode: null, viaAccountId: via, idempotencyKey: 'r-via' })).standard.id;
  assert.deepEqual(autobookEligibility(t.ctx, rule(viaRule)), { eligible: false, reason: 'via_account' });
  const listed = must(autobookCandidates(t.ctx)).rules;
  assert.equal(listed.find((r) => r.standardId === byName).ineligibleReason, 'name_key');
  assert.equal(listed.find((r) => r.standardId === viaRule).grantable, false);
});

test('eligibility: a computed rule earns it only under bank.buchungsregel_computed_mode = bulk', () => {
  const t = ruleWorld();
  const [pay] = debits(t, [10000], { name: 'Zahlungsdienst Beispiel', iban: 'CH4431999123000889015' });
  const computed = must(
    setBankStandard(t.ctx, {
      bankTxnId: pay,
      legs: [
        { accountId: t.acc('6900'), amount: { kind: 'factor', label: 'Gebühr', num: 3, den: 100 } },
        { accountId: t.acc('6500'), amount: { kind: 'rest' } },
      ],
      idempotencyKey: 'r-comp',
    }),
  ).standard.id;
  assert.deepEqual(autobookEligibility(t.ctx, readLiveRule(t.ctx, computed)), { eligible: false, reason: 'mode_not_bulk' });
  setting(t, 'bank.buchungsregel_computed_mode', 'bulk');
  assert.deepEqual(autobookEligibility(t.ctx, readLiveRule(t.ctx, computed)), { eligible: true, kind: 'computed' });
});

test('clean count: unchanged live bookings of the current version; a changed booking resets it and a reopened one leaves it', () => {
  const t = ruleWorld();
  earned(t, [1100, 1200]);
  assert.equal(cleanUsesOf(t.ctx, t.ruleId).uses.length, 2);
  const [c] = debits(t, [1300]);
  must(bookBankLine(t.ctx, { bankTxnId: c, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 1300 }] }, idempotencyKey: 'changed' }));
  assert.equal(decisionOf(t, c).rule_changed, 1);
  assert.equal(cleanUsesOf(t.ctx, t.ruleId).uses.length, 0, 'a changed booking resets the clean count');
  at(t, LATER);
  const [d, e] = earned(t, [1400, 1500]);
  assert.equal(cleanUsesOf(t.ctx, t.ruleId).uses.length, 2);
  must(reopenBankLine(t.ctx, { bankTxnId: e, reason: 'falsch', idempotencyKey: 're-e' }));
  assert.deepEqual(cleanUsesOf(t.ctx, t.ruleId).uses.map((u) => u.bankTxnId), [d]);
});

// ================================================================================================
// The offer
// ================================================================================================

test('offer: drafted once as system with no dial family after N clean uses; a rejection is never asked again for that version', () => {
  const t = ruleWorld();
  const { tick } = autopilot(t);
  earned(t, [1100, 1200]);
  tick();
  assert.equal(offers(t).length, 0, 'two clean uses are not enough at 3');
  earned(t, [1300]);
  tick();
  tick();
  const [offer] = offers(t);
  assert.equal(offers(t).length, 1, 'one offer, however often the tick runs');
  assert.deepEqual(
    { actor: offer.actor, dial: offer.dial_capability, status: offer.status, key: offer.idempotency_key },
    { actor: 'system', dial: null, status: 'pending', key: 'autobook-offer:' + t.ruleId + ':0:1950CHF' },
  );
  const facts = JSON.parse(offer.payload_json).offerFacts;
  assert.deepEqual({ cleanUses: facts.cleanUses, ceilingMinor: facts.ceilingMinor, currency: facts.currency }, { cleanUses: 3, ceilingMinor: 1950, currency: 'CHF' });
  must(rejectDraftedAction(t.ctx, { actionId: offer.id, reason: 'lieber selbst' }));
  earned(t, [1400]);
  tick();
  assert.equal(offers(t).length, 1, 'the rejected offer answers every later tick for this version');
});

test('offer: approving it grants the rule as the approving person, with the ceiling it showed', () => {
  const t = ruleWorld();
  const { tick } = autopilot(t);
  earned(t);
  tick();
  const [offer] = offers(t);
  const approver = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'studio', clock: t.clock, ids: t.ids });
  must(approveDraftedAction(approver, (tool, input, actor) => getAction(tool).run({ ...t.deps, actor }, input), { actionId: offer.id }));
  const row = t.store.db.prepare('SELECT * FROM rule_autobook_grant WHERE workspace_id = ?').get(t.workspaceId);
  assert.deepEqual({ by: row.granted_by, rule: row.standard_id, ceiling: row.amount_ceiling_minor, currency: row.ceiling_currency }, { by: 'studio', rule: t.ruleId, ceiling: 1950, currency: 'CHF' });
});

// ================================================================================================
// The grant
// ================================================================================================

test('I4 grant: an agent seat is refused human_only directly, through the door at every dial, and proposes nothing', () => {
  const t = ruleWorld();
  earned(t);
  const agentCtx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: t.clock, ids: t.ids });
  refused(grantRuleAutobook(agentCtx, { standardId: t.ruleId, idempotencyKey: 'ag-1' }), 'human_only');
  assert.equal(agentMcp(t, 'grant_rule_autobook', { standardId: t.ruleId, idempotencyKey: 'ag-2' }).error, 'human_only');
  for (const capability of ['post', 'pay', 'customize', 'issue']) {
    must(reg(t, 'set_agent_dial', { capability, level: 'auto', idempotencyKey: 'dial-' + capability }, 'studio'));
    assert.equal(agentMcp(t, 'grant_rule_autobook', { standardId: t.ruleId, idempotencyKey: 'ag-' + capability }).error, 'human_only');
  }
  const human = [['rules.autobook', 'off'], ['rules.autobook_offer_after', 3], ['rules.autobook_amount_headroom', 900], ['rules.autobook_suspend_on_change', 'off'], ['rules.autobook_scope', 'open_lines'], ['recurring.auto_generate', 'honour_auto_issue']];
  for (const [key, value] of human) {
    assert.equal(agentMcp(t, 'settings_set', { key, value, reason: 'mehr Autonomie', idempotencyKey: 'ho-' + key }).error, 'human_only', key);
  }
  assert.equal(t.store.db.prepare("SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ? AND actor = 'agent'").get(t.workspaceId).n, 0, 'no Vorschlag from the agent');
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM rule_autobook_grant').get().n, 0);
});

test('grant: refused when off, not earned, or without a person-confirmed use; a second grant answers the first', () => {
  const t = ruleWorld();
  earned(t, [1100, 1200]);
  refused(grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: 'ne' }), 'autobook_not_earned');
  const t2 = ruleWorld();
  const agentCtx = makeContext(t2.store, { workspaceId: t2.workspaceId, actor: 'agent', clock: t2.clock, ids: t2.ids });
  for (const id of debits(t2, [1100, 1200, 1300])) bookAsProposed(t2, id, agentCtx);
  assert.equal(cleanUsesOf(t2.ctx, t2.ruleId).uses.length, 3);
  refused(grantRuleAutobook(t2.ctx, { standardId: t2.ruleId, idempotencyKey: 'nh' }), 'autobook_no_human_use');
  earned(t, [1300]);
  setting(t, 'rules.autobook', 'off');
  refused(grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: 'off' }), 'autobook_off');
  setting(t, 'rules.autobook', 'offer');
  const first = grant(t, 'g-a');
  const second = must(grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: 'g-b' }));
  assert.equal(second.alreadyGranted, true);
  assert.equal(second.grant.grantId, first.grantId);
  refused(grantRuleAutobook(t.ctx, { standardId: 'bstd_nowhere', idempotencyKey: 'nf' }), 'rule_not_found');
});

test('I3 ceiling: fixed at grant from the largest person-confirmed clean use in its currency; later bookings never ratchet it', () => {
  const t = granted();
  assert.deepEqual({ c: grantRow(t, t.grantId).amount_ceiling_minor, cur: grantRow(t, t.grantId).ceiling_currency }, { c: 1950, cur: 'CHF' });
  const [big] = debits(t, [9000]);
  bookAsProposed(t, big);
  assert.equal(grantRow(t, t.grantId).amount_ceiling_minor, 1950, 'the money columns are frozen on the row');
  assert.throws(() => t.store.db.prepare('UPDATE rule_autobook_grant SET amount_ceiling_minor = 99999 WHERE id = ?').run(t.grantId), /only the suspension/);
  assert.throws(() => t.store.db.prepare("UPDATE rule_autobook_grant SET ceiling_currency = 'EUR' WHERE id = ?").run(t.grantId), /only the suspension/);
  const [edge, over] = debits(t, [1950, 1951]);
  t.ap.tick();
  assert.equal(decisionOf(t, edge)?.channel, channelOf(t.ruleId));
  assert.equal(decisionOf(t, over), undefined);
  assert.equal(runOf(t, over)?.reason, 'over_ceiling');
});

test('I3 currency: a line of the rule in another currency than the ceiling is never booked automatically', () => {
  const t = granted();
  must(reg(t, 'create_account', { number: '1025', name: 'Bank EUR', type: 'asset', currency: 'EUR', idempotencyKey: 'eur-acc' }));
  const eur = must(createBankAccount(t.ctx, { name: 'Konto EUR', iban: 'CH5604835012345678009', currency: 'EUR', ledgerAccountId: t.acc('1025'), idempotencyKey: 'ba-eur' })).bankAccountId;
  const party = '<RltdPties><Cdtr><Pty><Nm>' + TELCO + '</Nm></Pty></Cdtr><CdtrAcct><Id><IBAN>' + TELCO_IBAN + '</IBAN></Id></CdtrAcct></RltdPties>';
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">',
    '<BkToCstmrStmt><GrpHdr><MsgId>EUR-1-msg</MsgId><CreDtTm>2026-07-20T08:00:00</CreDtTm></GrpHdr>',
    '<Stmt><Id>EUR-1</Id><ElctrncSeqNb>1</ElctrncSeqNb>',
    '<FrToDt><FrDtTm>2026-07-15T00:00:00</FrDtTm><ToDtTm>2026-07-15T23:59:59</ToDtTm></FrToDt>',
    '<Acct><Id><IBAN>CH5604835012345678009</IBAN></Id></Acct>',
    '<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">100.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>',
    '<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">88.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>',
    '<Ntry><NtryRef>EUR-N1</NtryRef><Amt Ccy="EUR">12.00</Amt><CdtDbtInd>DBIT</CdtDbtInd>',
    '<Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-07-15</Dt></BookgDt><ValDt><Dt>2026-07-15</Dt></ValDt>',
    '<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>ICDT</Cd><SubFmlyCd>OTHR</SubFmlyCd></Fmly></Domn></BkTxCd>',
    '<NtryDtls><TxDtls>' + party + '</TxDtls></NtryDtls></Ntry>',
    '</Stmt></BkToCstmrStmt></Document>',
  ].join('\n');
  const res = must(getAction('import_camt').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, bankAccountId: eur, xml, idempotencyKey: 'eur-imp' }), 'EUR import');
  const line = t.store.db.prepare('SELECT id FROM bank_txn WHERE workspace_id = ? AND statement_id = ?').get(t.workspaceId, res.statementId).id;
  t.ap.tick();
  assert.equal(decisionOf(t, line), undefined, 'the EUR line is not booked');
  assert.equal(runOf(t, line)?.reason, 'currency', JSON.stringify(runs(t)));
});

// ================================================================================================
// The step
// ================================================================================================

test('step: books a new line of a granted rule as the granter, keyed and channelled; lines from before the grant wait', () => {
  const t = ruleWorld();
  earned(t);
  const [before] = debits(t, [1400]);
  const g = grant(t);
  at(t, LATER);
  const [fresh] = debits(t, [1500]);
  const ap = autopilot(t);
  ap.tick();
  const d = decisionOf(t, fresh);
  assert.deepEqual(
    { state: d.state, by: d.created_by, channel: d.channel, rule: d.proposed_rule_id, changed: d.rule_changed },
    { state: 'booked', by: 'user_1', channel: channelOf(t.ruleId), rule: t.ruleId, changed: 0 },
  );
  const memo = t.store.db.prepare("SELECT key FROM idempotency WHERE workspace_id = ? AND verb = 'book_bank_line'").all(t.workspaceId).map((r) => r.key);
  assert.ok(memo.includes(JSON.stringify(['book_bank_line', fresh, 'autobook:' + g.grantId + ':' + fresh])), 'booked under autobook:<grant>:<line>');
  assert.equal(decisionOf(t, before), undefined, 'new_lines: a line imported before the grant waits for a person');
  assert.equal(runs(t).filter((r) => r.bank_txn_id === before).length, 0);
  setting(t, 'rules.autobook_scope', 'open_lines');
  ap.tick();
  assert.equal(decisionOf(t, before)?.channel, channelOf(t.ruleId));
  assert.throws(() => t.store.db.prepare('UPDATE bank_line_decision SET channel = NULL WHERE bank_txn_id = ?').run(fresh), /only the supersession/);
});

// ================================================================================================
// I1 no double booking
// ================================================================================================

test('I1 re-run: a second tick and a second scheduler over the same book book a line once, with one run row', () => {
  const t = granted();
  const [line] = debits(t, [1500]);
  const before = entryCount(t);
  t.ap.tick();
  t.ap.tick();
  autopilot(t).tick();
  assert.equal(entryCount(t) - before, 1, 'one entry, whatever ran how often');
  assert.equal(runs(t).filter((r) => r.bank_txn_id === line).length, 1, 'each (grant, line) is decided once');
  assert.equal(decisionOf(t, line).channel, channelOf(t.ruleId));
  assert.throws(
    () => t.store.db.prepare("INSERT INTO autobook_run (id, workspace_id, run_at, day, bank_txn_id, grant_id, outcome) VALUES ('x', ?, ?, '2026-07-20', ?, ?, 'booked')").run(t.workspaceId, LATER, line, t.grantId),
    /UNIQUE/,
    'the schema itself refuses a second booked row for the line',
  );
});

test('I1 reopen and re-grant: an autobooked line that a person reopened is never booked automatically again', () => {
  const t = granted();
  const [line] = debits(t, [1500]);
  t.ap.tick();
  must(reopenBankLine(t.ctx, { bankTxnId: line, reason: 'falsch zugeordnet', idempotencyKey: 're-auto' }));
  assert.equal(decisionOf(t, line), undefined, 'the line is open again');
  const g1 = grantRow(t, t.grantId);
  assert.deepEqual({ reason: g1.suspended_reason, set: g1.suspended_at !== null }, { reason: 'reopened', set: true }, 'the undo paused the grant');
  assert.equal(cleanUsesOf(t.ctx, t.ruleId).uses.length, 0, 'the suspension reset the clean count');
  refused(grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: 'g-again-early' }), 'autobook_not_earned');
  at(t, '2026-07-21T08:00:00.000Z');
  earned(t, [1110, 1120, 1130]);
  const g2 = grant(t, 'grant-2');
  assert.notEqual(g2.grantId, t.grantId);
  setting(t, 'rules.autobook_scope', 'open_lines');
  at(t, '2026-07-22T08:00:00.000Z');
  t.ap.tick();
  t.ap.tick();
  assert.equal(decisionOf(t, line), undefined, 'the reopened line stays with the person (open_lines books the rest of the backlog)');
  assert.equal(runs(t).filter((r) => r.bank_txn_id === line && r.outcome === 'booked').length, 1);
  assert.equal(runs(t).filter((r) => r.bank_txn_id === line).length, 1, 'the second grant never even looks at it');
});

// ================================================================================================
// I2 ladder precedence
// ================================================================================================

test('I2 ladder: an existing entry on the bank account outranks the granted rule; the line stays a proposal', () => {
  const t = granted();
  must(postEntry(t.ctx, { date: '2026-03-02', source: 'manual', description: 'von Hand Telco', idempotencyKey: 'manual-telco', lines: [{ account: t.acc('6570'), debit: 1600 }, { account: t.acc('1020'), credit: 1600 }] }));
  const [line] = debits(t, [1600], { from: '2026-03-02' });
  assert.match(proposalOf(t, line).reasonCode, /^existing_entry/, 'the inbox proposes the entry, not the rule');
  t.ap.tick();
  assert.equal(decisionOf(t, line), undefined, 'not booked: a second booking of a paid amount would double it');
  assert.deepEqual({ reason: runOf(t, line).reason, detail: runOf(t, line).detail }, { reason: 'outranked', detail: proposalOf(t, line).reasonCode });
});

test('I2 ladder: a posted vendor bill the line names by reference outranks the granted rule', () => {
  const t = granted();
  postedBill(t, { grossMinor: 1700, seed: 'telco-bill', vendorName: TELCO, vendorReference: 'RG-2026-555' });
  const [line] = debits(t, [1700], { ustrd: 'RG-2026-555' });
  assert.equal(proposalOf(t, line).reasonCode, 'vendor_bill_reference');
  t.ap.tick();
  assert.equal(decisionOf(t, line), undefined);
  assert.equal(runOf(t, line).reason, 'outranked');
});

// ================================================================================================
// I4 the granter at run time
// ================================================================================================

test('I4 step: a grant held by a governed seat books nothing and pauses; a granter who lost post pauses too', () => {
  const t = granted();
  t.store.db.prepare('UPDATE rule_autobook_grant SET revoked_at = ? WHERE id = ?').run(LATER, t.grantId);
  // A grant row an agent could never have made through any door (I4 grant), planted to prove the step's own check.
  t.store.db
    .prepare("INSERT INTO rule_autobook_grant (id, workspace_id, standard_id, granted_by, granted_at, amount_ceiling_minor, ceiling_currency, clean_uses) VALUES ('agrant_planted', ?, ?, 'agent', ?, 1950, 'CHF', 3)")
    .run(t.workspaceId, t.ruleId, LATER);
  at(t, '2026-07-21T08:00:00.000Z');
  const [line] = debits(t, [1500]);
  t.ap.tick();
  assert.equal(decisionOf(t, line), undefined);
  assert.equal(grantRow(t, 'agrant_planted').suspended_reason, 'granter_lost_capability');

  const u = granted();
  const [other] = debits(u, [1500]);
  const report = runAutobookStep(makeContext(u.store, { workspaceId: u.workspaceId, actor: 'system', clock: u.clock, ids: u.ids }), {
    book: () => assert.fail('a granter without post never books'),
    holdsPost: () => false,
  });
  assert.deepEqual(report.suspended, [{ grantId: u.grantId, reason: 'granter_lost_capability' }]);
  assert.equal(decisionOf(u, other), undefined);
});

// ================================================================================================
// I5 the suspension hooks
// ================================================================================================

test('I5 changed booking: a person changing the rule proposal pauses the grant (setting on) and always resets the count', () => {
  const t = granted();
  const [changed] = debits(t, [1500]);
  must(bookBankLine(t.ctx, { bankTxnId: changed, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 1500 }] }, idempotencyKey: 'chg' }));
  assert.equal(grantRow(t, t.grantId).suspended_reason, 'changed_booking');
  const [next] = debits(t, [1500]);
  t.ap.tick();
  assert.equal(decisionOf(t, next), undefined, 'a paused grant books nothing');

  const u = granted();
  setting(u, 'rules.autobook_suspend_on_change', 'off');
  const [c2] = debits(u, [1500]);
  must(bookBankLine(u.ctx, { bankTxnId: c2, target: { kind: 'accounts', legs: [{ accountId: u.acc('6500'), amountMinor: 1500 }] }, idempotencyKey: 'chg2' }));
  assert.equal(grantRow(u, u.grantId).suspended_at, null, 'off: the grant stands');
  assert.equal(cleanUsesOf(u.ctx, u.ruleId).uses.length, 0, 'the changed use resets the count either way');
});

test('I5 reopen of a MANUAL booking of the rule leaves the grant alone; an automatic booking carries no payment to reverse', () => {
  const t = granted();
  const [manual] = debits(t, [1500]);
  bookAsProposed(t, manual);
  must(reopenBankLine(t.ctx, { bankTxnId: manual, reason: 'nochmals', idempotencyKey: 're-man' }));
  assert.equal(grantRow(t, t.grantId).suspended_at, null);
  const [auto] = debits(t, [1500]);
  t.ap.tick();
  // A rule books accounts and never settles a document, so an automatic booking carries no payment: the
  // reverse_payment hook (payment.ts) has nothing of it to undo today, and the reopen door is the undo.
  assert.equal(decisionOf(t, auto).payment_id, null);
});

// ================================================================================================
// I6 edit, off, revoke
// ================================================================================================

test('I6 an edit of the rule ends its grant; rules.autobook = off stops every grant until a person switches it back; revoke ends it', () => {
  const t = granted();
  setting(t, 'rules.autobook', 'off');
  const [whileOff] = debits(t, [1500]);
  t.ap.tick();
  assert.equal(decisionOf(t, whileOff), undefined, 'off books nothing');
  assert.equal(runs(t).length, 0);
  assert.equal(must(autobookCandidates(t.ctx)).rules.find((r) => r.standardId === t.ruleId).grant.state, 'stopped');
  setting(t, 'rules.autobook', 'offer');
  t.ap.tick();
  assert.equal(decisionOf(t, whileOff).channel, channelOf(t.ruleId), 'switched back, the grant resumes');

  must(revokeRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: 'rev' }));
  const [afterRevoke] = debits(t, [1500]);
  t.ap.tick();
  assert.equal(decisionOf(t, afterRevoke), undefined, 'revoked books nothing');

  const u = granted();
  const edited = must(setBankStandard(u.ctx, { standardId: u.ruleId, accountId: u.acc('6500'), taxCode: null, idempotencyKey: 'edit' })).standard.id;
  assert.notEqual(edited, u.ruleId);
  const [afterEdit] = debits(u, [1500]);
  u.ap.tick();
  assert.equal(decisionOf(u, afterEdit), undefined, 'the edited rule is a new version without a grant');
  assert.equal(must(autobookCandidates(u.ctx)).rules.find((r) => r.standardId === edited).grant?.state, 'ended', 'the card shows the old grant as ended');
});

// ================================================================================================
// Period, digest, seen
// ================================================================================================

test('a line in a closed month is not booked (period_locked); the digest lists booked and not booked, and Gesehen closes the day', () => {
  const t = granted();
  must(softCloseMonth(t.ctx, { period: '2026-02', idempotencyKey: 'close-feb' }));
  const [locked] = debits(t, [1500], { from: '2026-02-10' });
  const [fine] = debits(t, [1400], { from: '2026-04-06' });
  const [big] = debits(t, [9999], { from: '2026-04-20' });
  t.ap.tick();
  assert.equal(runOf(t, locked).reason, 'period_locked');
  const digest = must(autobookDigest(t.ctx, { date: '2026-07-20' }));
  assert.deepEqual(digest.booked.map((l) => [l.bankTxnId, l.stands]), [[fine, true]]);
  assert.deepEqual(new Set(digest.notBooked.map((l) => l.reason)), new Set(['period_locked', 'over_ceiling']));
  assert.ok(digest.notBooked.some((l) => l.bankTxnId === big));
  assert.deepEqual(unseenDigestDays(t.ctx).map((d) => d.day), ['2026-07-20']);
  must(autopilotMarkSeen(t.ctx, { kind: 'digest', ref: '2026-07-20' }));
  assert.deepEqual(unseenDigestDays(t.ctx), [], 'Gesehen closes the card for everyone');
  assert.equal(must(autobookDigest(t.ctx, { date: '2026-07-20' })).seen, true);
  assert.deepEqual(must(autobookDigest(t.ctx, { date: '2026-07-19' })).booked, [], 'an empty day has nothing to show');
  must(reopenBankLine(t.ctx, { bankTxnId: fine, reason: 'Rückgängig', idempotencyKey: 'undo' }));
  assert.equal(must(autobookDigest(t.ctx, { date: '2026-07-20' })).booked[0].stands, false, 'Rückgängig shows on the digest line');
});

test('tenant: another workspace sees none of the grant, the runs or the digest', () => {
  const t = granted();
  debits(t, [1500]);
  t.ap.tick();
  const b = secondWorkspace(t);
  assert.deepEqual(must(autobookDigest(b.ctx, { date: '2026-07-20' })).booked, []);
  refused(revokeRuleAutobook(b.ctx, { standardId: t.ruleId, idempotencyKey: 'x' }), 'rule_not_found');
});

// ================================================================================================
// Pendenzen: the offer's facts, the digest card, the Dauerbuchung notes
// ================================================================================================

test('Pendenzen: the offer carries its facts and its two answers; the digest card lists the day and closes on Gesehen', () => {
  const t = ruleWorld();
  const ap = autopilot(t);
  earned(t);
  ap.tick();
  const queue = (id) => ATTENTION_PROVIDERS.find((p) => p.queueId === id);
  const offerItem = [...queue('agent_action').list(t.ctx, { limit: 50 }), ...queue('agent_action_bank').list(t.ctx, { limit: 50 })].find((i) => i.autobookOffer !== undefined);
  assert.deepEqual(offerItem.autobookOffer, { standardId: t.ruleId, counterparty: TELCO, label: offerItem.autobookOffer.label, cleanUses: 3, ceilingMinor: 1950, currency: 'CHF' });
  assert.deepEqual(offerItem.decisionOptions.map((o) => [o.id, o.labelKey]), [['approve', 'attention.autobookOffer.grant'], ['reject', 'attention.autobookOffer.dismiss']], 'no "allow in future": nothing to allow');
  grant(t);
  at(t, LATER);
  const [line] = debits(t, [1500]);
  const [big] = debits(t, [9000]);
  ap.tick();
  const [card] = queue('autopilot').list(t.ctx, { limit: 10 });
  assert.equal(card.entityId, '2026-07-20');
  assert.deepEqual(card.titleParams, { count: 1 });
  assert.deepEqual(card.autobookDigest.lines.map((l) => [l.bankTxnId, l.entryId !== null, l.reason, l.grantLive]), [
    [line, true, null, true],
    [big, false, 'over_ceiling', true],
  ]);
  assert.deepEqual(card.decisionOptions.map((o) => [o.verb, o.input]), [['autopilot_mark_seen', { kind: 'digest', ref: '2026-07-20' }]]);
  must(reg(t, 'autopilot_mark_seen', { kind: 'digest', ref: '2026-07-20' }));
  assert.deepEqual(queue('autopilot').list(t.ctx, { limit: 10 }), [], 'Gesehen: no card');
});

// ================================================================================================
// Critic N04 round 1 (the probes P1 to P3, and findings 4 and 5), regression tests
// ================================================================================================

test('F1 (P1) a line a person reopened after booking it by hand stays with the person; the next tick never books it', () => {
  const t = granted();
  const [line] = debits(t, [1500]);
  bookAsProposed(t, line);
  must(reopenBankLine(t.ctx, { bankTxnId: line, reason: 'Privatanteil, neu buchen', idempotencyKey: 're-man-p1' }));
  t.ap.tick();
  t.ap.tick();
  assert.equal(decisionOf(t, line), undefined, 'the line stays open for the person');
  assert.equal(runs(t).filter((r) => r.bank_txn_id === line).length, 0, 'the autopilot never even looks at it');
  setting(t, 'rules.autobook_scope', 'open_lines');
  t.ap.tick();
  assert.equal(decisionOf(t, line), undefined, 'not under open_lines either');
});

test('F2 (P3) the offer binds the ceiling it showed: approving after it moved refuses offer_stale, the tick re-drafts it with the fresh figures', () => {
  const t = ruleWorld();
  const { tick } = autopilot(t);
  earned(t);
  tick();
  const [first] = offers(t);
  assert.equal(JSON.parse(first.payload_json).offerFacts.ceilingMinor, 1950);
  bookAsProposed(t, debits(t, [90000])[0]);
  const approver = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'studio', clock: t.clock, ids: t.ids });
  const invoke = (tool, input, actor) => getAction(tool).run({ ...t.deps, actor }, input);
  const res = approveDraftedAction(approver, invoke, { actionId: first.id });
  assert.equal(JSON.stringify(res).includes('offer_stale'), true, JSON.stringify(res));
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM rule_autobook_grant WHERE workspace_id = ?').get(t.workspaceId).n, 0, 'nothing was switched on');
  tick();
  const pending = offers(t).filter((o) => o.status === 'pending');
  assert.equal(pending.length, 1, 'one fresh offer, the old one voided');
  assert.notEqual(pending[0].id, first.id);
  assert.equal(JSON.parse(pending[0].payload_json).offerFacts.ceilingMinor, 135000);
  // The rule card's switch carries what it showed the same way.
  refused(grantRuleAutobook(t.ctx, { standardId: t.ruleId, offerFacts: { standardId: t.ruleId, counterparty: TELCO, label: null, cleanUses: 4, ceilingMinor: 1, currency: 'CHF' }, idempotencyKey: 'sw' }), 'offer_stale');
  must(approveDraftedAction(approver, invoke, { actionId: pending[0].id }));
  assert.equal(t.store.db.prepare('SELECT amount_ceiling_minor AS c FROM rule_autobook_grant WHERE workspace_id = ?').get(t.workspaceId).c, 135000, 'the grant is exactly what the card showed');
});

test('F3 (P2) an agent cannot close the digest for everyone: autopilot_mark_seen is human-only, a person can', () => {
  const t = granted();
  debits(t, [1500]);
  t.ap.tick();
  const viaMcp = agentMcp(t, 'autopilot_mark_seen', { kind: 'digest', ref: '2026-07-20' });
  assert.equal(viaMcp.ok, false, JSON.stringify(viaMcp));
  assert.equal(viaMcp.error, 'human_only');
  const agentCtx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: t.clock, ids: t.ids });
  refused(autopilotMarkSeen(agentCtx, { kind: 'digest', ref: '2026-07-20' }), 'human_only');
  assert.equal(must(autobookDigest(t.ctx, { date: '2026-07-20' })).seen, false, 'the card is still there for the people');
  must(reg(t, 'autopilot_mark_seen', { kind: 'digest', ref: '2026-07-20' }));
  assert.equal(must(autobookDigest(t.ctx, { date: '2026-07-20' })).seen, true);
});

test('F4 a lost race (another tick decided a line meanwhile) skips the line: no throw, no second run row', () => {
  const t = granted();
  const [a, b] = debits(t, [1500, 1600]);
  const base = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'system', clock: t.clock, ids: t.ids });
  let raced = false;
  // The "other process": after this step read its candidate lines and before it takes the write lock for the
  // first one (the period check sits in between), a second tick runs to the end and decides both lines.
  const periods = Object.create(base.periods);
  periods.assertOpen = (date) => {
    if (!raced) {
      raced = true;
      t.ap.tick();
    }
    return base.periods.assertOpen(date);
  };
  const report = runAutobookStep({ ...base, periods }, { holdsPost: () => true, book: (actor, input) => getAction('book_bank_line').run({ ...t.deps, actor }, input) });
  assert.equal(raced, true);
  assert.deepEqual(report.notBooked, [], JSON.stringify(report));
  for (const line of [a, b]) {
    assert.equal(runs(t).filter((r) => r.bank_txn_id === line).length, 1, `${line}: one run row`);
    assert.equal(decisionOf(t, line).channel, channelOf(t.ruleId));
  }
});
