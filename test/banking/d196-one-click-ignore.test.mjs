// @ts-nocheck
/**
 * D196 point 2, ONE-CLICK IGNORE: `ignore_bank_line` takes the reason as OPTIONAL, measured on rows.
 *
 *  - no reason: the line is ignored with the workspace's `bank.ignore_default_reason` (default `other`),
 *    on both doors, with or without a note;
 *  - the setting decides the default;
 *  - backward compatible: a caller that sends one of the closed reasons keeps it, an unknown one still
 *    refuses `invalid_input` and writes nothing;
 *  - an agent's ignore without a reason drafts, and the approval ignores with the default.
 *
 * All data is synthetic (a fresh in-memory workspace and an invented CSV statement).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const rest = (deps, name, input) => handleRest(name, input, deps).body;
const mcp = (deps, name, input) => JSON.parse(callTool(deps, name, input).content[0].text);
const asStudio = (deps) => ({ ...deps, actor: 'studio' });
const asAgent = (deps) => ({ ...deps, actor: 'agent' });

function world(seed, amounts = [2500, 1200, 800, 400]) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId: ws, accId } = mintWorkspace(deps, 'Muster GmbH', `${seed}-ws`);
  const created = getAction('create_bank_account').run(asStudio(deps), {
    workspaceId: ws, name: 'Kantonalbank Kontokorrent', iban: 'CH93 0076 2011 6238 5295 7', currency: 'CHF', ledgerAccountId: accId('1020'), idempotencyKey: `${seed}-bank`,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const rows = amounts.map((a, i) => `0${i + 2}.03.2026;Lieferant ${i + 1};-${(a / 100).toFixed(2)}`).join('\n');
  const imported = getAction('import_bank_statement').run(asStudio(deps), {
    workspaceId: ws, bankAccountId: created.bankAccountId, content: `Datum;Text;Betrag\n${rows}\n`,
    mapping: { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy' }, idempotencyKey: `${seed}-csv`,
  });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  const txns = deps.store.db.prepare('SELECT id FROM bank_txn WHERE workspace_id = ? ORDER BY booking_date').all(ws).map((r) => r.id);
  return { deps, ws, txns };
}

const decision = (w, txn) =>
  w.deps.store.db
    .prepare("SELECT ignore_reason, note FROM bank_line_decision WHERE workspace_id = ? AND bank_txn_id = ? AND target_kind = 'ignore' ORDER BY rowid DESC LIMIT 1")
    .get(w.ws, txn);
const decisions = (w) => w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM bank_line_decision WHERE workspace_id = ?').get(w.ws).n;

test('no reason: one call ignores the line with the default reason (other), on both doors, the note optional', () => {
  const w = world('d');
  const a = rest(asStudio(w.deps), 'ignore_bank_line', { workspaceId: w.ws, bankTxnId: w.txns[0], idempotencyKey: 'd-1' });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.reason, 'other');
  assert.deepEqual(decision(w, w.txns[0]), { ignore_reason: 'other', note: null });

  const b = mcp(asStudio(w.deps), 'ignore_bank_line', { workspaceId: w.ws, bankTxnId: w.txns[1], note: 'Kaution zurück', idempotencyKey: 'd-2' });
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.deepEqual(decision(w, w.txns[1]), { ignore_reason: 'other', note: 'Kaution zurück' });

  // A blank reason is no reason (the one-click caller that sends an empty field).
  const c = rest(asStudio(w.deps), 'ignore_bank_line', { workspaceId: w.ws, bankTxnId: w.txns[2], reason: '', idempotencyKey: 'd-3' });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(decision(w, w.txns[2]).ignore_reason, 'other');

  // A same-key retry replays, writing nothing.
  const before = decisions(w);
  assert.equal(rest(asStudio(w.deps), 'ignore_bank_line', { workspaceId: w.ws, bankTxnId: w.txns[0], idempotencyKey: 'd-1' }).ok, true);
  assert.equal(decisions(w), before);
  w.deps.store.close();
});

test('the setting bank.ignore_default_reason decides the default', () => {
  const w = world('s');
  const set = getAction('settings_set').run(asStudio(w.deps), { workspaceId: w.ws, key: 'bank.ignore_default_reason', value: 'booked_elsewhere', reason: 'Treuhänder bucht', idempotencyKey: 's-set' });
  assert.equal(set.ok, true, JSON.stringify(set));
  const r = rest(asStudio(w.deps), 'ignore_bank_line', { workspaceId: w.ws, bankTxnId: w.txns[0], idempotencyKey: 's-1' });
  assert.equal(r.reason, 'booked_elsewhere');
  assert.equal(decision(w, w.txns[0]).ignore_reason, 'booked_elsewhere');
  w.deps.store.close();
});

test('backward compatible: a named closed reason is kept; an unknown one refuses and writes nothing', () => {
  const w = world('b');
  const r = rest(asStudio(w.deps), 'ignore_bank_line', { workspaceId: w.ws, bankTxnId: w.txns[0], reason: 'duplicate', note: 'zweimal geliefert', idempotencyKey: 'b-1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(decision(w, w.txns[0]), { ignore_reason: 'duplicate', note: 'zweimal geliefert' });
  const before = decisions(w);
  const bad = rest(asStudio(w.deps), 'ignore_bank_line', { workspaceId: w.ws, bankTxnId: w.txns[1], reason: 'weil', idempotencyKey: 'b-2' });
  assert.equal(bad.error, 'invalid_input');
  assert.equal(bad.field, 'reason');
  const wrongType = rest(asStudio(w.deps), 'ignore_bank_line', { workspaceId: w.ws, bankTxnId: w.txns[1], reason: 7, idempotencyKey: 'b-3' });
  assert.equal(wrongType.error, 'invalid_input');
  assert.equal(decisions(w), before);
  w.deps.store.close();
});

test('an agent ignore without a reason drafts, and the approval ignores with the default', () => {
  const w = world('a');
  const d = rest(asAgent(w.deps), 'ignore_bank_line', { workspaceId: w.ws, bankTxnId: w.txns[0], idempotencyKey: 'a-1' });
  assert.equal(d.drafted, true, JSON.stringify(d));
  assert.equal(decision(w, w.txns[0]), undefined, 'nothing decided before the approval');
  const ok = rest(asStudio(w.deps), 'approve_drafted_action', { workspaceId: w.ws, actionId: d.actionId });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(decision(w, w.txns[0]).ignore_reason, 'other');
  w.deps.store.close();
});
