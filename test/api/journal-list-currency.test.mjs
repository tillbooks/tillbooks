/**
 * MCP-first: an AGENT reading the journal over the tool surface can denominate what it reads.
 *
 * The currency and base-currency figures on `list_journal` were added because the Studio journal
 * list could not label its money. The Studio is ONE client of that verb and not the reason the field
 * exists: TILL is agent-native, so the test that matters is the one that goes through `callTool`,
 * the same path an MCP client takes, and finds the same figures the ledger holds.
 *
 * `callTool` serialises the Result to a JSON content block, so this also proves the shape survives
 * the wire: a `null` currency stays null rather than disappearing the way `undefined` would, which
 * is the difference between an agent seeing "this entry has no lines" and seeing nothing at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callTool } from '../../dist/api/mcp.js';
import { freshDeps, mintWorkspace } from './support.mjs';

const DATE = '2026-07-16';

/** The Result an MCP tool call carries, parsed back out of its JSON content block. */
function call(deps, tool, input) {
  const res = callTool(deps, tool, input);
  const block = res.content?.[0];
  assert.equal(block?.type, 'text', `${tool} must answer with a text content block`);
  return JSON.parse(block.text);
}

function world() {
  // `freshDeps` IS an ApiDeps: its own in-memory store, a pinned clock and a deterministic id
  // sequence, so the figures below are the ones a reader can check by hand.
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);

  // A35: the fixture actor is the agent seat, whose post_entry now routes through the dial at the
  // transports; grant post -> auto so the fixture posts rather than drafts (the D103 ceremony).
  const dial = call({ ...deps, actor: 'studio' }, 'set_agent_dial', { workspaceId, capability: 'post', level: 'auto', idempotencyKey: 'dial-post' });
  assert.ok(dial.ok, JSON.stringify(dial));

  const rate = call(deps, 'record_exchange_rate', {
    workspaceId,
    baseCurrency: 'EUR',
    rate: '0.9412',
    asOf: '2026-07-15',
    source: 'manual',
    method: 'daily',
    provenance: 'ESTV Tageskurs Verkauf (MWSTV Art. 45 Abs. 3)',
    idempotencyKey: 'fx-eur',
  });
  assert.ok(rate.ok, JSON.stringify(rate));

  const posted = call(deps, 'post_entry', {
    workspaceId,
    date: DATE,
    ref: 'B-201',
    description: 'Beratung Kunde EU',
    source: 'manual',
    currency: 'EUR',
    idempotencyKey: 'eur-1',
    lines: [
      { account: accId('6500'), debit: 162150 },
      { account: accId('1000'), credit: 162150 },
    ],
  });
  assert.ok(posted.ok, JSON.stringify(posted));

  const empty = call(deps, 'save_draft', { workspaceId, date: DATE, ref: 'B-202', lines: [], idempotencyKey: 'd-1' });
  assert.ok(empty.ok, JSON.stringify(empty));

  return { deps, workspaceId, foreignId: posted.entryId, emptyId: empty.entryId };
}

/** What the LEDGER holds, straight out of SQLite. The only authority in this file. */
function ledgerFigures(deps, entryId) {
  const rows = deps.store.db
    .prepare('SELECT currency, debit_minor, base_debit_minor, fx_rate FROM journal_line WHERE entry_id = ?')
    .all(entryId);
  return {
    currency: rows[0]?.currency ?? null,
    rate: rows[0]?.fx_rate ?? null,
    debitTotal: rows.reduce((sum, r) => sum + r.debit_minor, 0),
    baseDebitTotal: rows.reduce((sum, r) => sum + r.base_debit_minor, 0),
  };
}

test('an agent calling list_journal over MCP gets the currency and the base figures the LEDGER holds', () => {
  const { deps, workspaceId, foreignId } = world();
  const res = call(deps, 'list_journal', { workspaceId });
  assert.ok(res.ok, JSON.stringify(res));

  const row = res.entries.find((e) => e.id === foreignId);
  const ledger = ledgerFigures(deps, foreignId);
  assert.equal(row.currency, ledger.currency, 'the agent is told which currency the total is in');
  assert.equal(row.total, ledger.debitTotal);
  assert.equal(row.baseTotal, ledger.baseDebitTotal, 'and the base total the posting stamped');
  assert.equal(row.fxRate, ledger.rate, 'and the rate, as the ledger string');
  assert.equal(row.baseCurrency, 'CHF');

  // Without the currency the agent has an integer and two plausible readings of it. A tool that
  // hands back a bare number for money is a tool that invites the caller to guess the unit.
  assert.notEqual(row.baseTotal, row.total, 'EUR 1621.50 at 0.9412 is not CHF 1621.50');
});

test('a null currency survives the JSON wire, so an agent can tell "no lines" from "no field"', () => {
  const { deps, workspaceId, emptyId } = world();
  const res = call(deps, 'list_journal', { workspaceId });
  const row = res.entries.find((e) => e.id === emptyId);

  // `undefined` would vanish in `JSON.stringify` and reach the agent as an absent key,
  // indistinguishable from an older engine that never sent one. `null` is a statement.
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'currency'), true, 'the key survives serialisation');
  assert.equal(row.currency, null, 'and says, explicitly, that this entry denominates nothing');
  assert.equal(row.total, 0);
});

test('the rate reaches the agent as a STRING, never a float that has already lost precision', () => {
  const { deps, workspaceId, foreignId } = world();
  const row = call(deps, 'list_journal', { workspaceId }).entries.find((e) => e.id === foreignId);
  assert.equal(typeof row.fxRate, 'string', 'the ledger holds up to 12 decimals; a JSON number does not');
  assert.equal(typeof row.baseTotal, 'number', 'the figures stay integer minor units');
  assert.equal(Number.isInteger(row.baseTotal), true);
});
