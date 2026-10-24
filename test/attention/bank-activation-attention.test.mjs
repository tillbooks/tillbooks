// The EBICS activation in the attention hub (G15 + A36 §3): `bank_activation` names the owner's act for
// every connection whose bank has not activated the access yet, one item per connection and one sentence
// per lifecycle stretch (send the legs, resend them, sign and post the INI letter and wait), and hands the
// connection over to `bank_keys_review` the moment the bank answered HPB. The two queues never name one
// connection together. The row only links to `/bank-accounts`: every act behind it is a person's.
//
// All fixtures synthetic: an invented host, partner and user id, a synthetic IBAN, the in-process mock
// bank of `test/banking/ebics-support.mjs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { syntheticIban, mockBank, bankCode } from '../banking/ebics-support.mjs';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { makeContext } from '../../dist/core/context.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createBankAccount } from '../../dist/core/banking/index.js';
import { connectBankChannel, disconnectBankChannel } from '../../dist/core/banking/ebics/index.js';
import {
  BANK_ACTIVATION_STATES,
  bankActivationProvider,
  bankActivationStep,
} from '../../dist/core/banking/ebics/attentionProvider.js';
import { ATTENTION_PROVIDERS } from '../../dist/core/attention/index.js';
import { EBICS_CONNECTION_STATE } from '../../dist/core/banking/ebics/enums.js';
import { getAction } from '../../dist/api/registry.js';
import { seatFirstOwner } from '../../dist/core/access/index.js';

function must(res, label) {
  assert.equal(res.ok, true, `${label}: ${JSON.stringify(res)}`);
  return res;
}

let n = 0;

/**
 * One book with one EBICS connection in `state`: `keys_generated` (made without a bank wire),
 * `ini_sent` (the HIA answer was lost), `pending_bank_activation` (both legs landed, the bank has not
 * switched the access on), `ready` (the bank answered HPB: the review is due), `active`, `retired`.
 */
function world(state, { shared } = {}) {
  n += 1;
  const clock = shared?.clock ?? { current: '2026-10-01T08:00:00.000Z', now() { return this.current; } };
  const ids = shared?.ids ?? sequenceIdGen();
  const store = shared?.store ?? new SqliteStore({ clock });
  const base = { store, clock, ids };
  const workspaceId = must(createWorkspace(base, { name: `Synthetische Aktivierung ${n} AG` }), 'workspace').workspaceId;
  const bank = mockBank();
  const wired = state !== 'keys_generated';
  const deps = { ...base, actor: 'studio', ...(wired ? { ebicsTransport: bank.port } : {}) };
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids, ...(wired ? { ebicsTransport: bank.port } : {}) });
  const ledger = store.db.prepare("SELECT id FROM account WHERE workspace_id = ? AND number = '1020'").get(workspaceId).id;
  const accountId = must(
    createBankAccount(ctx, { name: 'Konto Aktivierung', iban: syntheticIban(8100 + n), ledgerAccountId: ledger, idempotencyKey: `ba-${n}` }),
    'account',
  ).bankAccountId;
  if (state === 'ini_sent') bank.nextLeg('HIA', { ok: false, reason: 'network', detail: 'synthetic: the HIA answer was lost' });
  const host = { url: 'https://ebics.example/ebicsweb', hostId: 'SYNTHAKT', partnerId: `PARTNERA${200 + n}`, userId: `USERA${2000 + n}` };
  const connected = connectBankChannel(ctx, { host, routeBankAccountIds: [accountId], confirm: true, idempotencyKey: `c-${n}` });
  const connectionId = connected.connectionId;
  assert.ok(typeof connectionId === 'string', JSON.stringify(connected));
  if (state === 'ready' || state === 'active') {
    const fetched = must(connectBankChannel(ctx, { connectionId, confirm: true }), 'the bank answered HPB');
    if (state === 'active') {
      must(connectBankChannel(ctx, { connectionId, confirm: true, confirmBankKeys: true, expectedBankKeyHashes: fetched.bankKeyHashes }), 'confirm');
    }
  }
  if (state === 'retired' || state === 'blocked') {
    must(disconnectBankChannel(ctx, { connectionId, mode: state === 'retired' ? 'retire' : 'block', confirm: true, idempotencyKey: `d-${n}` }), state);
  }
  const expected = state === 'ready' ? 'pending_bank_activation' : state;
  const stored = store.db.prepare('SELECT state FROM ebics_connection WHERE workspace_id = ? AND id = ?').get(workspaceId, connectionId).state;
  assert.equal(stored, expected, 'the world is in the state asked for');
  return {
    clock,
    store,
    ids,
    deps,
    bank,
    ctx,
    workspaceId,
    connectionId,
    summary: (actor = 'studio') => must(getAction('attention_summary').run({ ...deps, actor }, { workspaceId }), 'attention_summary'),
    list: (input = {}) => must(getAction('attention_list').run(deps, { workspaceId, ...input }), 'attention_list'),
  };
}

const queue = (summary, queueId) => summary.queues.find((q) => q.queueId === queueId);
const itemsOf = (summary, queueId) => summary.top.filter((i) => i.queueId === queueId);

test('the step per lifecycle state: every pre-active state maps to exactly one sentence', () => {
  assert.deepEqual(
    BANK_ACTIVATION_STATES.map((s) => [s, bankActivationStep(s)]),
    [
      ['draft', 'send_legs'],
      ['keys_generated', 'send_legs'],
      ['ini_sent', 'resend_legs'],
      ['pending_bank_activation', 'sign_letter'],
    ],
  );
  // The states it speaks for are real lifecycle values, and exactly the ones before `active`.
  const active = EBICS_CONNECTION_STATE.indexOf('active');
  assert.deepEqual([...BANK_ACTIVATION_STATES], EBICS_CONNECTION_STATE.slice(0, active));
});

test('the provider is registered, reads under pay, and links to a routed surface', () => {
  const registered = ATTENTION_PROVIDERS.find((p) => p.queueId === 'bank_activation');
  // D178: registered through `withKind`, a copy carrying the kind, with the provider's own functions.
  assert.equal(registered.count, bankActivationProvider.count);
  assert.equal(registered.list, bankActivationProvider.list);
  assert.equal(registered.kind, 'do');
  assert.equal(registered.readCapability, 'pay');
  assert.equal(registered.deepLinkRoute, '/bank-accounts');
  assert.equal(registered.area, 'bank');
  assert.equal(registered.labelKey, 'attention.queue.bankActivation');
});

test('keys_generated: send INI and HIA, then sign the letter (due, a link only)', () => {
  const w = world('keys_generated');
  const s = w.summary();
  assert.equal(queue(s, 'bank_activation')?.count, 1);
  assert.equal(queue(s, 'bank_activation')?.labelKey, 'attention.queue.bankActivation', 'the summary carries the label key');
  assert.equal(queue(s, 'bank_keys_review'), undefined);
  const [item] = itemsOf(s, 'bank_activation');
  assert.equal(item.entityId, w.connectionId);
  assert.equal(item.entityKind, 'ebics_connection');
  assert.equal(item.reasonCode, 'send_legs');
  assert.equal(item.urgency, 'due');
  assert.equal(item.titleKey, 'attention.item.bankActivation.sendLegs.title');
  assert.deepEqual(item.titleParams, { bank: 'SYNTHAKT' });
  assert.equal(item.subtitleKey, 'attention.item.bankActivation.sendLegs.subtitle');
  assert.deepEqual(item.deepLink, { route: '/bank-accounts', params: {} });
  assert.deepEqual(
    item.decisionOptions.map((o) => [o.id, o.verb, o.role, o.labelKey]),
    [['open', null, 'link', 'attention.act.openBankAccounts']],
    'the row offers no write: sending the legs and the letter are a person acts',
  );
});

test('ini_sent: resend what the bank has not confirmed (due)', () => {
  const w = world('ini_sent');
  const [item] = itemsOf(w.summary(), 'bank_activation');
  assert.equal(item.reasonCode, 'resend_legs');
  assert.equal(item.urgency, 'due');
  assert.equal(item.titleKey, 'attention.item.bankActivation.resendLegs.title');
  assert.equal(item.subtitleKey, 'attention.item.bankActivation.resendLegs.subtitle');
});

test('pending_bank_activation: sign and post the INI letter, then the live state (open)', () => {
  const w = world('pending_bank_activation');
  const [before] = itemsOf(w.summary(), 'bank_activation');
  assert.equal(before.reasonCode, 'sign_letter');
  assert.equal(before.urgency, 'open', 'waiting on paper and on the bank is the lowest urgency');
  assert.equal(before.titleKey, 'attention.item.bankActivation.signLetter.title');
  assert.equal(before.subtitleKey, 'attention.item.bankActivation.signLetter.subtitleNoCheck', 'no bank answer yet: no date');
  assert.deepEqual(before.subtitleParams, { bank: 'SYNTHAKT' });

  // A person (or the daily check) asks the bank; it answers "not yet" (091002): that IS a check.
  w.clock.current = '2026-10-02T05:02:00.000Z';
  w.bank.nextHpb(bankCode('091002', 'technical'));
  const asked = connectBankChannel(w.ctx, { connectionId: w.connectionId, confirm: true });
  assert.equal(asked.ok, false);
  const [after] = itemsOf(w.summary(), 'bank_activation');
  assert.equal(after.subtitleKey, 'attention.item.bankActivation.signLetter.subtitle');
  assert.deepEqual(after.subtitleParams, { bank: 'SYNTHAKT', lastCheckAt: '2026-10-02T05:02:00.000Z' });
  assert.equal(after.reasonCode, 'sign_letter', 'still the same step: the bank has not switched on');
});

test('an attempt the bank never answered is not a check: no date is claimed', () => {
  const w = world('pending_bank_activation');
  w.bank.nextHpb({ ok: false, reason: 'network', detail: 'synthetic: no answer' });
  connectBankChannel(w.ctx, { connectionId: w.connectionId, confirm: true });
  const [item] = itemsOf(w.summary(), 'bank_activation');
  assert.equal(item.subtitleKey, 'attention.item.bankActivation.signLetter.subtitleNoCheck');
});

test('the bank answered HPB: the connection moves to bank_keys_review, never both queues at once', () => {
  const w = world('ready');
  const s = w.summary();
  assert.equal(queue(s, 'bank_activation'), undefined, 'no activation item once the bank is ready');
  assert.equal(queue(s, 'bank_keys_review')?.count, 1);
  const rows = s.top.filter((i) => i.entityId === w.connectionId);
  assert.equal(rows.length, 1, 'one connection, one row');
  assert.equal(rows[0].collapsedWithQueueId, undefined, 'nothing had to be collapsed');
});

test('active, retired and blocked connections are in neither queue', () => {
  for (const state of ['active', 'retired', 'blocked']) {
    const s = world(state).summary();
    assert.equal(queue(s, 'bank_activation'), undefined, `${state}: no activation item`);
    assert.equal(queue(s, 'bank_keys_review'), undefined, `${state}: no review item`);
  }
});

test('the count is the true number of connections, not the page: two activations, a page of one', () => {
  const w = world('pending_bank_activation');
  // A second contract in the same book, made without a wire: keys_generated.
  const ctx = makeContext(w.store, { workspaceId: w.workspaceId, actor: 'user_1', clock: w.clock, ids: w.ids });
  const ledger = w.store.db.prepare("SELECT id FROM account WHERE workspace_id = ? AND number = '1020'").get(w.workspaceId).id;
  const second = must(
    createBankAccount(ctx, { name: 'Konto Zwei', iban: syntheticIban(8999), ledgerAccountId: ledger, idempotencyKey: 'ba-second' }),
    'second account',
  ).bankAccountId;
  const made = connectBankChannel(ctx, {
    host: { url: 'https://ebics.example/ebicsweb', hostId: 'SYNTHZWEI', partnerId: 'PARTNERZ1', userId: 'USERZ1' },
    routeBankAccountIds: [second],
    confirm: true,
    idempotencyKey: 'c-second',
  });
  assert.ok(typeof made.connectionId === 'string', JSON.stringify(made));
  assert.equal(bankActivationProvider.count(w.ctx), 2);
  assert.equal(bankActivationProvider.list(w.ctx, { limit: 1 }).length, 1);
  assert.equal(queue(w.summary(), 'bank_activation')?.count, 2);
  const page = w.list({ queueId: 'bank_activation' }).items;
  // Ranked across the queue by urgency: the unsent legs (due) lead the letter (open).
  assert.deepEqual(page.map((i) => i.reasonCode), ['send_legs', 'sign_letter']);
});

test('pay gates it: a read-only member is not told about an act they could not take', () => {
  const w = world('keys_generated');
  must({ ok: seatFirstOwner(makeContext(w.store, { workspaceId: w.workspaceId, actor: 'bookkeeper', clock: w.clock, ids: w.ids })) !== undefined }, 'seat');
  assert.equal(queue(w.summary('bookkeeper'), 'bank_activation')?.count, 1, 'an owner who may pay sees it');
  w.store.db
    .prepare('UPDATE workspace_member SET role = ? WHERE workspace_id = ? AND user_id = (SELECT id FROM user WHERE actor_id = ?)')
    .run('viewer', w.workspaceId, 'bookkeeper');
  assert.equal(queue(w.summary('bookkeeper'), 'bank_activation'), undefined, 'a viewer does not');
});

// --- §H-TENANT ---------------------------------------------------------------------------------------------

test('§H-TENANT: another workspace connections and forged rows never reach this hub', () => {
  const a = world('pending_bank_activation');
  const b = world('keys_generated', { shared: { store: a.store, clock: a.clock, ids: a.ids } });
  // Each book sees exactly its own connection.
  assert.deepEqual(itemsOf(a.summary(), 'bank_activation').map((i) => i.entityId), [a.connectionId]);
  assert.deepEqual(itemsOf(b.summary(), 'bank_activation').map((i) => i.entityId), [b.connectionId]);
  // A forged HPB ok filed under B but naming A's connection neither readies A nor dates its check.
  a.store.db
    .prepare(
      `INSERT INTO ebics_order_log (id, workspace_id, connection_id, order_ref, direction, order_type, status, occurred_at)
       VALUES ('ebord_forged_b', ?, ?, 'HPB', 'download', 'HPB', 'ok', '2026-10-01T09:00:00.000Z')`,
    )
    .run(b.workspaceId, a.connectionId);
  const [item] = itemsOf(a.summary(), 'bank_activation');
  assert.equal(item.reasonCode, 'sign_letter', "B's row does not make A ready");
  assert.equal(item.subtitleKey, 'attention.item.bankActivation.signLetter.subtitleNoCheck', "B's row is not A's check");
  assert.equal(queue(a.summary(), 'bank_keys_review'), undefined);
  // And a context of workspace A reading the provider directly counts only A.
  assert.equal(bankActivationProvider.count(a.ctx), 1);
});

test('§H-TENANT, at the source: every query of the EBICS attention providers is fenced by workspace_id', () => {
  const src = readFileSync(new URL('../../src/core/banking/ebics/attentionProvider.ts', import.meta.url), 'utf8');
  const queries = [...src.matchAll(/`(\s*SELECT[\s\S]*?)`/g)].map((m) => m[1]);
  assert.ok(queries.length >= 2, 'the probe found the queries it guards');
  for (const q of queries) {
    for (const from of q.matchAll(/FROM\s+(\w+)(?:\s+(\w+))?/g)) {
      const alias = from[2] !== undefined && !/^(WHERE|ORDER|JOIN)$/i.test(from[2]) ? from[2] : from[1];
      assert.match(q, new RegExp(`(${alias}\\.)?workspace_id\\s*=`), `the read of ${from[1]} is fenced: ${q}`);
    }
  }
});
