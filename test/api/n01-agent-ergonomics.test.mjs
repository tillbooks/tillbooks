// @ts-nocheck
/**
 * N01, AGENT ERGONOMICS: the invariants, measured on rows (spec N01 §2, §7; D183).
 *
 * Written for a NON-AUTHOR critic to read: each test names the invariant it holds and counts the rows that
 * prove it, never a returned `ok` alone.
 *
 *  - US-N01.1  an account NUMBER resolves to its id at the input boundary; a valid id never resolves to
 *              another account; a number that names nothing refuses `invalid_account`; §H-TENANT holds.
 *  - US-N01.3  prevalidation REFUSES an invalid agent write and DRAFTS NOTHING (agent_action rows = 0),
 *              and the screen itself writes nothing.
 *  - US-N01.4  an unknown field warns (default), refuses (nothing runs) or is ignored, by seat; an
 *              internal invoke is never checked.
 *  - US-N01.6  batch items are INDEPENDENT: refused items stay untouched, booked items are booked once,
 *              each item is its own Vorschlag under a draft dial, the bound refuses before any item runs.
 *  - US-N01.7  approvals are PER ITEM: a resolved id answers already_resolved and is not run again.
 *  - US-N01.8  agentReason rides on the Vorschlag and never on the act; undo hints only where unambiguous.
 *  - US-N01.9  call_tool runs through the same governed door, and refuses the verbs with their own door.
 *  - US-N01.2  compose_entry items answers the single call's verdict per item and writes nothing.
 *
 * All data is synthetic (the seeded KMU chart of a fresh in-memory workspace).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { normalizeAccountRefs, didYouMean } from '../../dist/api/input-boundary.js';
import { makeContext } from '../../dist/core/context.js';
import { freshDeps, mintWorkspace, manualPost } from './support.mjs';

const rest = (deps, name, input) => handleRest(name, input, deps).body;
const mcp = (deps, name, input) => JSON.parse(callTool(deps, name, input).content[0].text);
const asStudio = (deps) => ({ ...deps, actor: 'studio' });
const asAgent = (deps) => ({ ...deps, actor: 'agent' });

const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;
const entries = (deps, ws) => count(deps.store.db, "SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'", ws);
const lines = (deps, ws) => count(deps.store.db, 'SELECT COUNT(*) AS n FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id WHERE e.workspace_id = ?', ws);
const drafts = (deps, ws, tool) =>
  tool === undefined
    ? count(deps.store.db, 'SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ?', ws)
    : count(deps.store.db, 'SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ? AND action_tool = ?', ws, tool);

const AGENT_TABLES = new Set(['agent_session', 'agent_turn', 'agent_call', 'agent_action']);
/** Every business table, row for row. */
function digest(db) {
  const h = createHash('sha256');
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    if (AGENT_TABLES.has(name)) continue;
    h.update(name);
    for (const row of db.prepare(`SELECT * FROM "${name}"`).all()) h.update(JSON.stringify(row));
  }
  return h.digest('hex');
}

/** A Studio-minted workspace (the human seat books; the agent seat is governed and drafts at ask). */
function world(seed = 'n01') {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Muster GmbH', `${seed}-ws`);
  return { deps, ws: workspaceId, accId };
}

function setSetting(w, key, value) {
  const r = getAction('settings_set').run(asStudio(w.deps), { workspaceId: w.ws, key, value, reason: 'N01 test', idempotencyKey: `set-${key}-${value}` });
  assert.equal(r.ok, true, JSON.stringify(r));
}

/** Two open debit lines on one Bankkonto, from one CSV statement on two days (synthetic). */
function openLines(w, seed = 'bl', amounts = [2500, 1200, 800]) {
  const created = getAction('create_bank_account').run(asStudio(w.deps), {
    workspaceId: w.ws,
    name: 'Kantonalbank Kontokorrent',
    iban: 'CH93 0076 2011 6238 5295 7',
    currency: 'CHF',
    ledgerAccountId: w.accId('1020'),
    idempotencyKey: `${seed}-bank`,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const rows = amounts.map((a, i) => `0${i + 2}.03.2026;Lieferant ${i + 1};-${(a / 100).toFixed(2)}`).join('\n');
  const imported = getAction('import_bank_statement').run(asStudio(w.deps), {
    workspaceId: w.ws,
    bankAccountId: created.bankAccountId,
    content: `Datum;Text;Betrag\n${rows}\n`,
    mapping: { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy' },
    idempotencyKey: `${seed}-csv`,
  });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  return w.deps.store.db
    .prepare('SELECT id FROM bank_txn WHERE workspace_id = ? AND bank_account_id = ? ORDER BY booking_date')
    .all(w.ws, created.bankAccountId)
    .map((r) => r.id);
}

const lineState = (w, bankTxnId) =>
  getAction('list_bank_inbox').run(asStudio(w.deps), { workspaceId: w.ws, bankTxnId, status: 'all' }).lines[0].state;

// --- US-N01.1: account numbers at the input boundary ----------------------------------------------------

test('US-N01.1: a line named by its NUMBER posts, and the stored line carries the resolved id', () => {
  const w = world('num');
  const posted = rest(asStudio(w.deps), 'post_entry', {
    workspaceId: w.ws,
    date: '2026-03-01',
    source: 'manual',
    idempotencyKey: 'num-1',
    lines: [{ account: '6500', debit: 5000 }, { account: '1000', credit: 5000 }],
  });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  const stored = w.deps.store.db.prepare('SELECT account_id FROM journal_line WHERE entry_id = ? ORDER BY rowid').all(posted.entryId).map((r) => r.account_id);
  assert.deepEqual(stored, [w.accId('6500'), w.accId('1000')]);
  // The same act named by ids replays it: a number and its id are the SAME arguments (US-N01.5).
  const byIds = rest(asStudio(w.deps), 'post_entry', { workspaceId: w.ws, ...manualPost(w.accId, 'num-1') });
  assert.equal(byIds.ok, false, 'manualPost differs in date/description, so it is another call');
  const sameByIds = rest(asStudio(w.deps), 'post_entry', {
    workspaceId: w.ws,
    date: '2026-03-01',
    source: 'manual',
    idempotencyKey: 'num-1',
    lines: [{ account: w.accId('6500'), debit: 5000 }, { account: w.accId('1000'), credit: 5000 }],
  });
  assert.equal(sameByIds.ok, true, JSON.stringify(sameByIds));
  assert.equal(sameByIds.entryId, posted.entryId, 'the id form replays the number form');
  assert.equal(entries(w.deps, w.ws), 1);
  w.deps.store.close();
});

test('US-N01.1: a number that names no account refuses invalid_account naming it, and writes nothing', () => {
  const w = world('nine');
  const before = digest(w.deps.store.db);
  for (const face of [rest, mcp]) {
    const refused = face(asStudio(w.deps), 'post_entry', {
      workspaceId: w.ws,
      date: '2026-03-01',
      source: 'manual',
      idempotencyKey: 'nine-1',
      lines: [{ account: '9999', debit: 100 }, { account: '1000', credit: 100 }],
    });
    assert.equal(refused.error, 'invalid_account', JSON.stringify(refused));
    assert.equal(refused.account, '9999');
    assert.equal(refused.field, 'lines[0].account');
  }
  assert.equal(digest(w.deps.store.db), before);
  w.deps.store.close();
});

test('US-N01.1: a valid account ID always resolves to that account, even when another account\'s NUMBER reads the same', () => {
  const w = world('collide');
  const id6500 = w.accId('6500');
  // An account whose number IS the id of 6500: the resolver must never pick it for that id.
  const squat = getAction('create_account').run(asStudio(w.deps), { workspaceId: w.ws, number: id6500, name: 'Kollision', type: 'expense', idempotencyKey: 'collide-acct' });
  assert.equal(squat.ok, true, JSON.stringify(squat));
  assert.notEqual(squat.accountId, id6500);
  const posted = rest(asStudio(w.deps), 'post_entry', {
    workspaceId: w.ws,
    date: '2026-03-01',
    source: 'manual',
    idempotencyKey: 'collide-1',
    lines: [{ account: id6500, debit: 700 }, { account: '1000', credit: 700 }],
  });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  const first = w.deps.store.db.prepare('SELECT account_id FROM journal_line WHERE entry_id = ? ORDER BY rowid LIMIT 1').get(posted.entryId).account_id;
  assert.equal(first, id6500, 'the id names 6500, never the account numbered like it');
  // Pure: an input whose references are all ids comes back as the SAME object (nothing rewritten).
  const ctx = makeContext(w.deps.store, { workspaceId: w.ws, actor: 'studio', clock: w.deps.clock, ids: w.deps.ids });
  const allIds = { workspaceId: w.ws, lines: [{ account: id6500, debit: 1 }, { account: w.accId('1000'), credit: 1 }] };
  const normalized = normalizeAccountRefs(ctx, getAction('post_entry').inputSchema, allIds);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.input, allIds, 'ids pass through untouched (same object)');
  w.deps.store.close();
});

test('US-N01.1 §H-TENANT: a number resolves inside the workspace only, and another tenant\'s id is never adopted', () => {
  const w = world('tenant');
  const other = mintWorkspace(w.deps, 'Fremde GmbH', 'tenant-b');
  const ctxB = makeContext(w.deps.store, { workspaceId: other.workspaceId, actor: 'studio', clock: w.deps.clock, ids: w.deps.ids });
  const schema = getAction('post_entry').inputSchema;
  const inB = normalizeAccountRefs(ctxB, schema, { workspaceId: other.workspaceId, lines: [{ account: '6500', debit: 1 }] });
  assert.equal(inB.input.lines[0].account, other.accId('6500'), "B's 6500, never A's");
  const foreign = normalizeAccountRefs(ctxB, schema, { workspaceId: other.workspaceId, lines: [{ account: w.accId('6500'), debit: 1 }] });
  assert.equal(foreign.input.lines[0].account, w.accId('6500'), "A's id is left to the verb, never mapped to B's account");
  const refused = rest(asStudio(w.deps), 'post_entry', {
    workspaceId: other.workspaceId,
    date: '2026-03-01',
    source: 'manual',
    idempotencyKey: 'tenant-1',
    lines: [{ account: w.accId('6500'), debit: 100 }, { account: '1000', credit: 100 }],
  });
  assert.equal(refused.ok, false, 'the verb refuses a foreign id as before');
  assert.equal(entries(w.deps, w.ws) + entries(w.deps, other.workspaceId), 0);
  w.deps.store.close();
});

test('US-N01.1: ledger.account_numbers = ids_only passes a number through, and the verb answers as before', () => {
  const w = world('idsonly');
  setSetting(w, 'ledger.account_numbers', 'ids_only');
  const refused = rest(asStudio(w.deps), 'post_entry', {
    workspaceId: w.ws,
    date: '2026-03-01',
    source: 'manual',
    idempotencyKey: 'io-1',
    lines: [{ account: '6500', debit: 100 }, { account: '1000', credit: 100 }],
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.field, undefined, 'the boundary did not answer: the verb did');
  assert.equal(entries(w.deps, w.ws), 0);
  w.deps.store.close();
});

test('US-N01.1: the annotated verbs take numbers: book_bank_line legs, set_bank_standard, record_expense', () => {
  const w = world('verbs');
  const [txn] = openLines(w, 'verbs', [2500]);
  const booked = rest(asStudio(w.deps), 'book_bank_line', { workspaceId: w.ws, bankTxnId: txn, target: { kind: 'accounts', legs: [{ accountId: '6500', amountMinor: 2500 }] }, idempotencyKey: 'v-bbl' });
  assert.equal(booked.ok, true, JSON.stringify(booked));
  const leg = w.deps.store.db.prepare('SELECT account_id FROM journal_line WHERE entry_id = ? AND debit_minor > 0').get(booked.entryId).account_id;
  assert.equal(leg, w.accId('6500'));
  const vendor = getAction('create_contact').run(asStudio(w.deps), { workspaceId: w.ws, partyRole: 'vendor', name: 'Papeterie Muster', idempotencyKey: 'v-vendor' });
  const expense = rest(asStudio(w.deps), 'record_expense', { workspaceId: w.ws, vendorId: vendor.contact.id, billDate: '2026-03-05', amountMinor: 1000, expenseAccountId: '6500', idempotencyKey: 'v-exp' });
  assert.equal(expense.ok, true, JSON.stringify(expense));
  const bill = w.deps.store.db.prepare('SELECT expense_account_id AS a FROM vendor_bill WHERE id = ?').get(expense.vendorBillId);
  assert.equal(bill.a, w.accId('6500'));
  w.deps.store.close();
});

test('US-N01.1: a governed draft stores ids, so the Vorschlag holds what the verb will see', () => {
  const w = world('draftids');
  const drafted = rest(asAgent(w.deps), 'post_entry', {
    workspaceId: w.ws,
    date: '2026-03-01',
    source: 'manual',
    idempotencyKey: 'di-1',
    lines: [{ account: '6500', debit: 100 }, { account: '1000', credit: 100 }],
  });
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  const payload = JSON.parse(w.deps.store.db.prepare('SELECT payload_json FROM agent_action WHERE id = ?').get(drafted.actionId).payload_json);
  assert.deepEqual(payload.lines.map((l) => l.account), [w.accId('6500'), w.accId('1000')]);
  const refused = rest(asAgent(w.deps), 'post_entry', {
    workspaceId: w.ws,
    date: '2026-03-01',
    source: 'manual',
    idempotencyKey: 'di-2',
    lines: [{ account: '9999', debit: 100 }, { account: '1000', credit: 100 }],
  });
  assert.equal(refused.error, 'invalid_account');
  assert.equal(drafts(w.deps, w.ws, 'post_entry'), 1, 'the refused number drafted nothing');
  w.deps.store.close();
});

// --- US-N01.3: prevalidation refuses, and drafts NOTHING ------------------------------------------------

test('US-N01.3: an invalid agent post_entry is refused with the verb\'s own answer and creates NO Vorschlag', () => {
  const w = world('pv');
  const locked = getAction('lock_period').run(asStudio(w.deps), { workspaceId: w.ws, period: '2026-01', kind: 'hard', idempotencyKey: 'pv-lock' });
  assert.equal(locked.ok, true, JSON.stringify(locked));
  const cases = [
    { lines: [{ account: '6500', debit: 100 }, { account: '1000', credit: 90 }] }, // unbalanced
    { lines: [{ account: 'acc_nope', debit: 100 }, { account: '1000', credit: 100 }] }, // an id that names nothing
    { lines: [{ account: '6500', debit: 100 }] }, // one line
    { date: '2026-01-15', lines: [{ account: '6500', debit: 100 }, { account: '1000', credit: 100 }] }, // a locked period
  ];
  for (const [i, c] of cases.entries()) {
    const input = { workspaceId: w.ws, date: '2026-03-01', source: 'manual', idempotencyKey: `pv-${i}`, ...c };
    const direct = getAction('post_entry').run(asStudio(w.deps), { ...input, idempotencyKey: `pv-direct-${i}` });
    const agent = rest(asAgent(w.deps), 'post_entry', input);
    assert.equal(agent.ok, false, JSON.stringify(agent));
    assert.equal(agent.drafted, undefined);
    assert.equal(agent.error, direct.error, `case ${i}: the screen answers what the verb answers`);
  }
  assert.equal(drafts(w.deps, w.ws), 0, 'not one Vorschlag');
  assert.equal(entries(w.deps, w.ws), 0);
  // A valid entry still drafts (the screen is no blanket refusal), and posts nothing until approved.
  const ok = rest(asAgent(w.deps), 'post_entry', { workspaceId: w.ws, ...manualPost(w.accId, 'pv-ok') });
  assert.equal(ok.drafted, true, JSON.stringify(ok));
  assert.equal(drafts(w.deps, w.ws), 1);
  assert.equal(entries(w.deps, w.ws), 0);
  w.deps.store.close();
});

test('US-N01.3 IT BITES: without the screen the same invalid agent entries WOULD be queued as Vorschläge', () => {
  for (const verb of ['post_entry', 'record_expense']) {
    const w = world(`bite-${verb}`);
    const action = getAction(verb);
    const screen = action.prevalidate;
    assert.equal(typeof screen, 'function', `${verb} declares its screen`);
    let input;
    if (verb === 'post_entry') {
      input = { workspaceId: w.ws, date: '2026-03-01', source: 'manual', idempotencyKey: 'bite-1', lines: [{ account: '6500', debit: 100 }, { account: '1000', credit: 90 }] };
    } else {
      const vendor = getAction('create_contact').run(asStudio(w.deps), { workspaceId: w.ws, partyRole: 'vendor', name: 'Papeterie Muster', idempotencyKey: 'bite-vendor' });
      input = { workspaceId: w.ws, vendorId: vendor.contact.id, billDate: '2026-03-05', amountMinor: 1000, expenseAccountId: '3200', idempotencyKey: 'bite-1' };
    }
    try {
      action.prevalidate = undefined;
      const unscreened = rest(asAgent(w.deps), verb, input);
      assert.equal(unscreened.drafted, true, `${verb}: the dial alone drafts it, so the screen is what refuses`);
    } finally {
      action.prevalidate = screen;
    }
    assert.equal(drafts(w.deps, w.ws, verb), 1);
    w.deps.store.close();
  }
});

test('US-N01.3: the post_entry screen is pure (not one row written) and passes a key the verb would replay', () => {
  const w = world('pure');
  const action = getAction('post_entry');
  const valid = { workspaceId: w.ws, ...manualPost(w.accId, 'pure-1') };
  const before = digest(w.deps.store.db);
  const changes = count(w.deps.store.db, 'SELECT total_changes() AS n');
  assert.equal(action.prevalidate(asAgent(w.deps), valid), undefined);
  assert.equal(action.prevalidate(asAgent(w.deps), { ...valid, lines: valid.lines.slice(0, 1) }).error, 'unbalanced');
  assert.equal(count(w.deps.store.db, 'SELECT total_changes() AS n'), changes, 'not one row, not even rolled back');
  assert.equal(digest(w.deps.store.db), before);
  assert.equal(action.run(asStudio(w.deps), valid).ok, true);
  assert.equal(action.prevalidate(asAgent(w.deps), valid), undefined, 'a spent key with the same arguments replays');
  w.deps.store.close();
});

test('US-N01.3: an invalid agent record_expense is refused with the verb\'s own answer and creates NO Vorschlag', () => {
  const w = world('rx');
  const vendor = getAction('create_contact').run(asStudio(w.deps), { workspaceId: w.ws, partyRole: 'vendor', name: 'Papeterie Muster', idempotencyKey: 'rx-vendor' });
  const base = { workspaceId: w.ws, vendorId: vendor.contact.id, billDate: '2026-03-05', amountMinor: 1000 };
  const lock = getAction('lock_period').run(asStudio(w.deps), { workspaceId: w.ws, period: '2026-01', kind: 'hard', idempotencyKey: 'rx-lock' });
  assert.equal(lock.ok, true, JSON.stringify(lock));
  const cases = [
    { ...base, expenseAccountId: '3200', idempotencyKey: 'rx-1' }, // revenue, not an expense account
    { ...base, expenseAccountId: '2000', idempotencyKey: 'rx-2' }, // the Kreditoren account
  ];
  cases.push({ ...base, billDate: '2026-01-15', expenseAccountId: '6500', idempotencyKey: 'rx-3' }); // locked period
  for (const c of cases) {
    const direct = getAction('record_expense').run(asStudio(w.deps), { ...c, idempotencyKey: `${c.idempotencyKey}-d` });
    const agent = rest(asAgent(w.deps), 'record_expense', c);
    assert.equal(agent.ok, false, JSON.stringify(agent));
    assert.equal(agent.error, direct.error, `${c.idempotencyKey}: the screen answers what the verb answers`);
  }
  assert.equal(drafts(w.deps, w.ws, 'record_expense'), 0);
  assert.equal(count(w.deps.store.db, 'SELECT COUNT(*) AS n FROM vendor_bill WHERE workspace_id = ?', w.ws), 0);
  const ok = rest(asAgent(w.deps), 'record_expense', { ...base, expenseAccountId: '6500', idempotencyKey: 'rx-ok' });
  assert.equal(ok.drafted, true, JSON.stringify(ok));
  w.deps.store.close();
});

// --- US-N01.4: unknown fields -------------------------------------------------------------------------

test('US-N01.4: an unknown field warns by default with the closest name, and the call still runs', () => {
  const w = world('uf');
  const res = rest(asStudio(w.deps), 'post_entry', { workspaceId: w.ws, ...manualPost(w.accId, 'uf-1'), lnes: [] });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.warnings, [{ code: 'unknown_field', field: 'lnes', didYouMean: 'lines' }]);
  const drafted = mcp(asAgent(w.deps), 'post_entry', { workspaceId: w.ws, ...manualPost(w.accId, 'uf-2'), descripton: 'x' });
  assert.equal(drafted.drafted, true);
  assert.deepEqual(drafted.warnings, [{ code: 'unknown_field', field: 'descripton', didYouMean: 'description' }]);
  // An internal invoke (action.run: approval replay, G01, scheduler) is never checked.
  const internal = getAction('post_entry').run(asStudio(w.deps), { workspaceId: w.ws, ...manualPost(w.accId, 'uf-3'), lnes: [] });
  assert.equal(internal.warnings, undefined);
  // Transport fields and the tenant are never unknown.
  const clean = rest(asStudio(w.deps), 'list_accounts', { workspaceId: w.ws, agentReason: 'Kontenplan lesen' });
  assert.equal(clean.warnings, undefined);
  w.deps.store.close();
});

test('US-N01.4: under refuse the agent call refuses unknown_field and NOTHING runs; the Studio setting is its own', () => {
  const w = world('ufr');
  setSetting(w, 'mcp.unknown_fields_agent', 'refuse');
  const before = digest(w.deps.store.db);
  const refused = rest(asAgent(w.deps), 'post_entry', { workspaceId: w.ws, ...manualPost(w.accId, 'ufr-1'), lnes: [] });
  assert.equal(refused.error, 'unknown_field', JSON.stringify(refused));
  assert.equal(refused.field, 'lnes');
  assert.equal(refused.didYouMean, 'lines');
  assert.equal(drafts(w.deps, w.ws), 0, 'no Vorschlag');
  assert.equal(digest(w.deps.store.db), before);
  // The Studio seat reads mcp.unknown_fields_studio (still warn).
  const studio = rest(asStudio(w.deps), 'post_entry', { workspaceId: w.ws, ...manualPost(w.accId, 'ufr-2'), lnes: [] });
  assert.equal(studio.ok, true);
  assert.equal(studio.warnings[0].field, 'lnes');
  setSetting(w, 'mcp.unknown_fields_studio', 'ignore');
  const quiet = rest(asStudio(w.deps), 'post_entry', { workspaceId: w.ws, ...manualPost(w.accId, 'ufr-3'), lnes: [] });
  assert.equal(quiet.ok, true);
  assert.equal(quiet.warnings, undefined);
  w.deps.store.close();
});

test('US-N01.4: didYouMean picks the near name and declines to guess', () => {
  assert.equal(didYouMean('lnes', ['lines', 'date']), 'lines');
  assert.equal(didYouMean('accountid', ['accountId', 'amountMinor']), 'accountId');
  assert.equal(didYouMean('zzzzzz', ['lines', 'date']), null);
});

// --- US-N01.6: batches, never all or nothing -----------------------------------------------------------

test('US-N01.6: book_bank_lines books the good items, leaves the refused one untouched, and replays as one', () => {
  const w = world('bbl');
  const [t1, t2, t3] = openLines(w, 'bbl');
  const input = {
    workspaceId: w.ws,
    idempotencyKey: 'batch-1',
    items: [
      { bankTxnId: t1, target: { kind: 'accounts', legs: [{ accountId: '6500', amountMinor: 2500 }] } },
      { bankTxnId: t2, target: { kind: 'accounts', legs: [{ accountId: '9999', amountMinor: 1200 }] } },
      { bankTxnId: t3, target: { kind: 'accounts', legs: [{ accountId: '6500', amountMinor: 800 }] } },
    ],
  };
  const first = rest(asStudio(w.deps), 'book_bank_lines', input);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(first.items.map((i) => i.ok), [true, false, true]);
  assert.equal(first.items[1].refusal.error, 'invalid_account');
  assert.deepEqual([first.okCount, first.refusedCount], [2, 1]);
  assert.deepEqual([lineState(w, t1), lineState(w, t2), lineState(w, t3)], ['booked', 'open', 'booked']);
  assert.equal(entries(w.deps, w.ws), 2);
  const rowsBefore = lines(w.deps, w.ws);
  // Each item is ONE book_bank_line under <batchKey>:<bankTxnId>: its undo is the single verb's.
  assert.deepEqual(first.items[0].result.undo, { tool: 'reopen_bank_line', args: { workspaceId: w.ws, bankTxnId: t1 } });
  const again = rest(asStudio(w.deps), 'book_bank_lines', input);
  assert.deepEqual(again.items.map((i) => i.ok), [true, false, true]);
  assert.equal(again.items[0].result.entryId, first.items[0].result.entryId, 'replayed, not booked twice');
  assert.equal(entries(w.deps, w.ws), 2);
  assert.equal(lines(w.deps, w.ws), rowsBefore);
  // The item key is a public key that refuses other arguments (US-N01.5).
  const squat = rest(asStudio(w.deps), 'book_bank_line', { workspaceId: w.ws, bankTxnId: t1, target: { kind: 'accounts', legs: [{ accountId: '6800', amountMinor: 2500 }] }, idempotencyKey: `batch-1:${t1}` });
  assert.equal(squat.error, 'idempotency_key_conflict', JSON.stringify(squat));
  // N01 critic (low): the batch holds no outer claim; the same batch key resent with one item runs that
  // item under ITS key, which refuses again (it wrote nothing) and books nothing twice.
  const other = rest(asStudio(w.deps), 'book_bank_lines', { ...input, items: [input.items[1]] });
  assert.equal(other.ok, true, JSON.stringify(other));
  assert.equal(other.items[0].refusal.error, 'invalid_account');
  assert.equal(entries(w.deps, w.ws), 2);
  // A number and its id are the same item arguments (the item claim hashes the resolved input).
  const byId = rest(asStudio(w.deps), 'book_bank_lines', { ...input, items: [{ ...input.items[0], target: { kind: 'accounts', legs: [{ accountId: w.accId('6500'), amountMinor: 2500 }] }, agentReason: 'reworded' }] });
  assert.equal(byId.items[0].result.entryId, first.items[0].result.entryId, 'replayed under the item key');
  assert.equal(entries(w.deps, w.ws), 2);
  w.deps.store.close();
});

test('US-N01.6: under a draft dial each item is its OWN Vorschlag and nothing is booked', () => {
  const w = world('bbld');
  const [t1, t2] = openLines(w, 'bbld', [2500, 1200]);
  const res = mcp(asAgent(w.deps), 'book_bank_lines', {
    workspaceId: w.ws,
    idempotencyKey: 'bd-1',
    agentReason: 'Lieferantenrechnungen vom März',
    items: [
      { bankTxnId: t1, target: { kind: 'accounts', legs: [{ accountId: '6500', amountMinor: 2500 }] } },
      { bankTxnId: t2, target: { kind: 'accounts', legs: [{ accountId: '6500', amountMinor: 1200 }] } },
    ],
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.draftedCount, 2);
  assert.equal(drafts(w.deps, w.ws, 'book_bank_line'), 2, 'two Vorschläge, one per line');
  assert.equal(drafts(w.deps, w.ws, 'book_bank_lines'), 0, 'never the batch as one');
  assert.equal(entries(w.deps, w.ws), 0);
  const listed = getAction('list_drafted_actions').run(asStudio(w.deps), { workspaceId: w.ws });
  assert.deepEqual(listed.actions.map((a) => a.agentReason), ['Lieferantenrechnungen vom März', 'Lieferantenrechnungen vom März']);
  w.deps.store.close();
});

test('US-N01.6: more items than agent.batch_max_items refuses batch_too_large before ANY item runs; [] is invalid_input', () => {
  const w = world('cap');
  const txns = openLines(w, 'cap');
  setSetting(w, 'agent.batch_max_items', 2);
  const before = digest(w.deps.store.db);
  const items = txns.map((t) => ({ bankTxnId: t, target: { kind: 'accounts', legs: [{ accountId: '6500', amountMinor: 100 }] } }));
  const refused = rest(asStudio(w.deps), 'book_bank_lines', { workspaceId: w.ws, idempotencyKey: 'cap-1', items });
  assert.equal(refused.error, 'batch_too_large', JSON.stringify(refused));
  assert.deepEqual([refused.count, refused.max], [3, 2]);
  const posts = rest(asStudio(w.deps), 'post_entries', { workspaceId: w.ws, items: [1, 2, 3].map((i) => manualPost(w.accId, `cap-p${i}`)) });
  assert.equal(posts.error, 'batch_too_large');
  assert.equal(digest(w.deps.store.db), before, 'nothing ran');
  assert.equal(rest(asStudio(w.deps), 'book_bank_lines', { workspaceId: w.ws, idempotencyKey: 'cap-2', items: [] }).error, 'invalid_input');
  assert.equal(rest(asStudio(w.deps), 'post_entries', { workspaceId: w.ws, items: [] }).error, 'invalid_input');
  w.deps.store.close();
});

test('US-N01.6: post_entries items are independent, each under its own key', () => {
  const w = world('pes');
  const input = {
    workspaceId: w.ws,
    items: [
      manualPost(w.accId, 'pes-a'),
      { ...manualPost(w.accId, 'pes-b'), lines: [{ account: '6500', debit: 1 }] }, // unbalanced
      { ...manualPost(w.accId, 'pes-c', 300), idempotencyKey: undefined }, // no key
      manualPost(w.accId, 'pes-a', 999), // a key the batch already used
      { ...manualPost(w.accId, 'pes-e', 400), lines: [{ account: '6500', debit: 400 }, { account: '1000', credit: 400 }] },
    ],
  };
  const res = rest(asStudio(w.deps), 'post_entries', input);
  assert.deepEqual(res.items.map((i) => i.ok), [true, false, false, false, true]);
  assert.equal(res.items[1].refusal.error, 'unbalanced');
  assert.equal(res.items[2].refusal.error, 'invalid_input');
  assert.equal(res.items[3].refusal.error, 'duplicate_in_batch');
  assert.equal(entries(w.deps, w.ws), 2);
  const again = rest(asStudio(w.deps), 'post_entries', input);
  assert.deepEqual(again.items.map((i) => i.ok), [true, false, false, false, true]);
  assert.equal(entries(w.deps, w.ws), 2, 'each item replayed its own act');
  w.deps.store.close();
});

test('US-N01.6 permission: a viewer is denied every item exactly as the single call, and nothing moves', () => {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Zugriff GmbH', 'pv-ws');
  getAction('invite_member').run(deps, { workspaceId, email: 'pv@muster.ch', role: 'viewer', idempotencyKey: 'pv-invite' });
  const seat = getAction('list_members').run(deps, { workspaceId }).members.find((m) => m.actorId === 'agent');
  assert.equal(getAction('set_role').run(deps, { workspaceId, memberId: seat.memberId, role: 'viewer' }).ok, true);
  const before = digest(deps.store.db);
  const single = rest(asAgent(deps), 'post_entry', { workspaceId, ...manualPost(accId, 'pv-1') });
  const batch = rest(asAgent(deps), 'post_entries', { workspaceId, items: [manualPost(accId, 'pv-2')] });
  const viaCallTool = rest(asAgent(deps), 'call_tool', { name: 'post_entry', args: { workspaceId, ...manualPost(accId, 'pv-3') } });
  assert.equal(single.error, 'permission_denied');
  assert.equal(batch.error, 'permission_denied', JSON.stringify(batch));
  assert.equal(viaCallTool.error, 'permission_denied', JSON.stringify(viaCallTool));
  assert.equal(digest(deps.store.db), before);
  deps.store.close();
});

// --- US-N01.7: approvals per item ----------------------------------------------------------------------

test('US-N01.7: approve_drafted_actions approves each id as its own act; a resolved one answers already_resolved', () => {
  const w = world('apr');
  const txns = openLines(w, 'apr');
  const ids = txns.map((t, i) => rest(asAgent(w.deps), 'book_bank_line', { workspaceId: w.ws, bankTxnId: t, target: { kind: 'accounts', legs: [{ accountId: '6500', amountMinor: [2500, 1200, 800][i] }] }, idempotencyKey: `apr-${i}` }).actionId);
  const single = getAction('approve_drafted_action').run(asStudio(w.deps), { workspaceId: w.ws, actionId: ids[2] });
  assert.equal(single.ok, true, JSON.stringify(single));
  assert.equal(entries(w.deps, w.ws), 1);
  const res = rest(asStudio(w.deps), 'approve_drafted_actions', { workspaceId: w.ws, ids });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.items.map((i) => i.ok), [true, true, false]);
  assert.equal(res.items[2].refusal.error, 'already_resolved');
  assert.equal(res.items[2].refusal.status, 'executed');
  assert.equal(entries(w.deps, w.ws), 3, 'two more, the resolved one not again');
  const statuses = w.deps.store.db.prepare('SELECT status FROM agent_action WHERE workspace_id = ? ORDER BY created_at, id').all(w.ws).map((r) => r.status);
  assert.deepEqual(statuses, ['executed', 'executed', 'executed']);
  const twice = rest(asStudio(w.deps), 'approve_drafted_actions', { workspaceId: w.ws, ids });
  assert.deepEqual(twice.items.map((i) => i.refusal?.error), ['already_resolved', 'already_resolved', 'already_resolved']);
  assert.equal(entries(w.deps, w.ws), 3);
  w.deps.store.close();
});

test('US-N01.7: the agent seat can never approve a batch, and nothing is read or run', () => {
  const w = world('apra');
  const id = rest(asAgent(w.deps), 'post_entry', { workspaceId: w.ws, ...manualPost(w.accId, 'apra-1') }).actionId;
  const res = getAction('approve_drafted_actions').run(asAgent(w.deps), { workspaceId: w.ws, ids: [id] });
  assert.equal(res.ok, false);
  assert.ok(['cannot_self_approve', 'permission_denied'].includes(res.error), JSON.stringify(res));
  assert.equal(entries(w.deps, w.ws), 0);
  assert.equal(w.deps.store.db.prepare('SELECT status FROM agent_action WHERE id = ?').get(id).status, 'pending');
  w.deps.store.close();
});

// --- US-N01.8: agentReason and undo hints --------------------------------------------------------------

test('US-N01.8: agentReason is stored on the Vorschlag, never part of the act, and bounded at 500', () => {
  const w = world('ar');
  const input = { workspaceId: w.ws, ...manualPost(w.accId, 'ar-1'), agentReason: 'Quittung Büromaterial vom 1. März' };
  const drafted = rest(asAgent(w.deps), 'post_entry', input);
  assert.equal(drafted.drafted, true);
  const listed = getAction('list_drafted_actions').run(asStudio(w.deps), { workspaceId: w.ws });
  assert.equal(listed.actions[0].agentReason, 'Quittung Büromaterial vom 1. März');
  // A reworded reason is the same act: the same Vorschlag, never a second one.
  const reworded = rest(asAgent(w.deps), 'post_entry', { ...input, agentReason: 'Büromaterial (Quittung)' });
  assert.equal(reworded.actionId, drafted.actionId);
  assert.equal(drafts(w.deps, w.ws), 1);
  const long = rest(asAgent(w.deps), 'post_entry', { ...input, idempotencyKey: 'ar-2', agentReason: 'x'.repeat(501) });
  assert.equal(long.error, 'invalid_input');
  assert.equal(long.field, 'agentReason');
  assert.equal(drafts(w.deps, w.ws), 1);
  // Every governed write declares it; a read never does.
  assert.ok('agentReason' in getAction('post_entry').inputSchema.properties);
  assert.ok(!('agentReason' in getAction('list_journal').inputSchema.properties));
  w.deps.store.close();
});

test('US-N01.8: undo hints only where unambiguous, never on a draft, and off by setting', () => {
  const w = world('undo');
  const posted = rest(asStudio(w.deps), 'post_entry', { workspaceId: w.ws, ...manualPost(w.accId, 'u-1') });
  assert.deepEqual(posted.undo, { tool: 'reverse_entry', args: { workspaceId: w.ws, entryId: posted.entryId } });
  const drafted = rest(asAgent(w.deps), 'post_entry', { workspaceId: w.ws, ...manualPost(w.accId, 'u-2') });
  assert.equal(drafted.undo, undefined);
  const account = rest(asStudio(w.deps), 'create_account', { workspaceId: w.ws, number: '6999', name: 'Diverses', type: 'expense', idempotencyKey: 'u-acct' });
  assert.equal(account.undo, undefined, 'no guessed inverse');
  setSetting(w, 'agent.undo_hints', 'off');
  const quiet = rest(asStudio(w.deps), 'post_entry', { workspaceId: w.ws, ...manualPost(w.accId, 'u-3') });
  assert.equal(quiet.undo, undefined);
  w.deps.store.close();
});

// --- US-N01.9: call_tool -------------------------------------------------------------------------------

test('US-N01.9: call_tool runs the named verb through the same governed door (a governed write drafts)', () => {
  const w = world('ct');
  const drafted = mcp(asAgent(w.deps), 'call_tool', { name: 'post_entry', args: { workspaceId: w.ws, ...manualPost(w.accId, 'ct-1') } });
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  assert.deepEqual(drafted.calledTool, { name: 'post_entry', kind: 'write', reversibility: 'correctable', consequenceTag: 'books' });
  assert.equal(drafts(w.deps, w.ws, 'post_entry'), 1);
  assert.equal(entries(w.deps, w.ws), 0);
  const read = mcp(asAgent(w.deps), 'call_tool', { name: 'list_accounts', args: { workspaceId: w.ws, search: '6500' } });
  assert.equal(read.accounts[0].number, '6500');
  w.deps.store.close();
});

test('US-N01.9: call_tool refuses the verbs that keep their own door, and unknown names', () => {
  const w = world('ctx');
  const before = digest(w.deps.store.db);
  for (const [name, reason] of [['bank_sync', 'async'], ['portal_quote_accept', 'token_workspace'], ['env_reset', 'instance_wide'], ['call_tool', 'recursive']]) {
    const res = rest(asStudio(w.deps), 'call_tool', { name, args: { workspaceId: w.ws } });
    assert.equal(res.error, 'call_tool_not_dispatchable', `${name}: ${JSON.stringify(res)}`);
    assert.equal(res.reason, reason);
  }
  assert.equal(rest(asStudio(w.deps), 'call_tool', { name: 'no_such_verb', args: {} }).error, 'unknown_action');
  assert.equal(rest(asStudio(w.deps), 'call_tool', { name: 'list_accounts', args: 'x' }).error, 'invalid_input');
  assert.equal(digest(w.deps.store.db), before);
  w.deps.store.close();
});

// --- US-N01.2: compose_entry items ---------------------------------------------------------------------

test('US-N01.2: compose_entry items answers each item exactly as the single call, and writes nothing', () => {
  const w = world('ci');
  const single = { mode: 'expand', date: '2026-03-01', lines: [{ account: '6500', side: 'debit', amount: 10810, gross: true, taxCode: 'VST-M' }, { account: '1020', credit: 10810 }] };
  getAction('vat_seed_defaults').run(asStudio(w.deps), { workspaceId: w.ws });
  const bad = { mode: 'expand', date: '2026-03-01', lines: [{ account: '6500', debit: 100 }, { account: '1020', credit: 90 }] };
  const before = digest(w.deps.store.db);
  const changes = count(w.deps.store.db, 'SELECT total_changes() AS n');
  const res = rest(asStudio(w.deps), 'compose_entry', { workspaceId: w.ws, items: [single, bad, { mode: 'expand', date: '2026-03-01', lines: [{ account: '9999', debit: 1 }] }] });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(count(w.deps.store.db, 'SELECT total_changes() AS n'), changes, 'a read writes nothing');
  assert.equal(digest(w.deps.store.db), before);
  const alone = rest(asStudio(w.deps), 'compose_entry', { workspaceId: w.ws, ...single });
  assert.deepEqual(res.items[0].result, alone, 'item 0 is the single call');
  assert.equal(res.items[1].verdict.error, 'unbalanced');
  assert.equal(res.items[2].refusal.error, 'invalid_account');
  assert.deepEqual([res.count, res.bookable, res.notBookable], [3, 1, 2]);
  w.deps.store.close();
});

// --- N01 critic round 1 -------------------------------------------------------------------------------

test('critic 1 (HIGH): the plugin bridge refuses every dispatcher, and an install refuses a dispatcher scope', async () => {
  const { runPluginToolCall, isDispatcherTool } = await import('../../dist/core/plugins/index.js');
  const w = world('plug');
  const before = digest(w.deps.store.db);
  const invoke = (tool, input, actor) => getAction(tool).run({ ...w.deps, actor }, input);
  const cases = {
    post_entries: { workspaceId: w.ws, items: [manualPost(w.accId, 'pl-1')] },
    book_bank_lines: { workspaceId: w.ws, items: [], idempotencyKey: 'pl-2' },
    call_tool: { name: 'post_entry', args: { workspaceId: w.ws, ...manualPost(w.accId, 'pl-3') } },
    approve_drafted_actions: { workspaceId: w.ws, ids: ['x'] },
  };
  for (const [tool, input] of Object.entries(cases)) {
    assert.equal(isDispatcherTool(tool), true, tool);
    assert.equal(getAction(tool).dispatches, true, `${tool} declares dispatches`);
    const res = runPluginToolCall(invoke, { grantedScopes: [`mcp_tool:${tool}`], pluginActor: 'studio', tool, input });
    assert.equal(res.error, 'capability_forbidden', `${tool}: ${JSON.stringify(res)}`);
    assert.equal(res.reason, 'dispatcher');
  }
  assert.equal(digest(w.deps.store.db), before, 'nothing ran');
  const others = ACTIONS_DISPATCHING();
  assert.deepEqual(others.sort(), Object.keys(cases).sort(), 'exactly the four dispatch');
  w.deps.store.close();
});

function ACTIONS_DISPATCHING() {
  return ['post_entries', 'book_bank_lines', 'call_tool', 'approve_drafted_actions', 'post_entry', 'compose_entry', 'book_bank_line'].filter((n) => getAction(n).dispatches === true);
}

test('critic 2 (MEDIUM): the batch approval keeps the bank-line reach and refuses under attention.approval_batch_mode = single', () => {
  const w = world('reach');
  const [t1] = openLines(w, 'reach', [2500]);
  const bank = rest(asAgent(w.deps), 'book_bank_line', { workspaceId: w.ws, bankTxnId: t1, target: { kind: 'accounts', legs: [{ accountId: '6500', amountMinor: 2500 }] }, idempotencyKey: 'r-1' }).actionId;
  const post = rest(asAgent(w.deps), 'post_entry', { workspaceId: w.ws, ...manualPost(w.accId, 'r-2') }).actionId;
  const res = rest(asStudio(w.deps), 'approve_drafted_actions', { workspaceId: w.ws, ids: [bank, post] });
  assert.deepEqual(res.items.map((i) => i.ok), [true, false]);
  assert.equal(res.items[1].refusal.error, 'not_batchable');
  assert.equal(w.deps.store.db.prepare('SELECT status FROM agent_action WHERE id = ?').get(post).status, 'pending', 'the post_entry Vorschlag never ran');
  assert.equal(entries(w.deps, w.ws), 1);
  setSetting(w, 'attention.approval_batch_mode', 'single');
  const single = rest(asStudio(w.deps), 'approve_drafted_actions', { workspaceId: w.ws, ids: [post] });
  assert.equal(single.error, 'not_batchable');
  assert.equal(single.reason, 'approval_batch_mode_single');
  assert.equal(entries(w.deps, w.ws), 1);
  w.deps.store.close();
});

test('critic 4 (LOW): a compose_entry item meets the unknown-field check, warn by default and refuse by setting', () => {
  const w = world('cuf');
  const item = { mode: 'expand', date: '2026-03-01', lines: [{ account: '6500', debit: 1 }, { account: '1000', credit: 1 }], lnes: [] };
  const warned = rest(asStudio(w.deps), 'compose_entry', { workspaceId: w.ws, items: [item] });
  assert.deepEqual(warned.items[0].warnings, [{ code: 'unknown_field', field: 'lnes', didYouMean: 'lines' }]);
  setSetting(w, 'mcp.unknown_fields_studio', 'refuse');
  const refused = rest(asStudio(w.deps), 'compose_entry', { workspaceId: w.ws, items: [item] });
  assert.equal(refused.items[0].refusal.error, 'unknown_field');
  w.deps.store.close();
});

test('critic 5 (LOW): a caller the verb denies never learns the workspace\'s unknown-field setting', () => {
  const w = world('ufa');
  setSetting(w, 'mcp.unknown_fields_studio', 'ignore');
  // Provision the book (an invite flips it to member mode), so a non-member is denied by A24.
  assert.equal(getAction('invite_member').run(asStudio(w.deps), { workspaceId: w.ws, email: 'ufa@muster.ch', role: 'viewer', idempotencyKey: 'ufa-invite' }).ok, true);
  const stranger = { ...w.deps, actor: 'member:stranger' };
  const res = rest(stranger, 'post_entry', { workspaceId: w.ws, ...manualPost(w.accId, 'ufa-1'), lnes: [] });
  assert.equal(res.error, 'permission_denied', JSON.stringify(res));
  // The book's own setting (ignore) is not applied to a caller the verb denies: it gets the default (warn).
  assert.deepEqual(res.warnings, [{ code: 'unknown_field', field: 'lnes', didYouMean: 'lines' }]);
  w.deps.store.close();
});

test('pre-existing (critic): record_expense posts a foreign bill at the fxRate it was given, and refuses a malformed one', () => {
  const w = world('fx');
  const vendor = getAction('create_contact').run(asStudio(w.deps), { workspaceId: w.ws, partyRole: 'vendor', name: 'Fournisseur Muster SA', idempotencyKey: 'fx-v' });
  const base = { workspaceId: w.ws, vendorId: vendor.contact.id, billDate: '2026-03-05', amountMinor: 10000, currency: 'EUR', expenseAccountId: '6500' };
  const posted = rest(asStudio(w.deps), 'record_expense', { ...base, fxRate: '0.95', idempotencyKey: 'fx-1' });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  const rate = w.deps.store.db.prepare('SELECT fx_rate FROM vendor_bill WHERE id = ?').get(posted.vendorBillId).fx_rate;
  assert.equal(Number(rate), 0.95);
  const lineRate = w.deps.store.db.prepare("SELECT l.fx_rate FROM journal_line l JOIN vendor_bill b ON b.entry_id = l.entry_id WHERE b.id = ? LIMIT 1").get(posted.vendorBillId).fx_rate;
  assert.equal(Number(lineRate), 0.95);
  const bad = rest(asStudio(w.deps), 'record_expense', { ...base, fxRate: 'about one', idempotencyKey: 'fx-2' });
  assert.equal(bad.error, 'invalid_input');
  assert.equal(bad.field, 'fxRate');
  w.deps.store.close();
});
