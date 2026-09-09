// A19's tri-mapping: engine verb + MCP tool + REST twin, all three or it is not done.
//
// The registry is the single §H-ENUM source of the tool surface and BOTH faces are thin adapters
// over the same `ActionDef.run`, so the claim worth testing is not "the tool exists" but "the two
// faces cannot answer differently, and the REST twin is genuinely reachable by name".
//
// The idempotency case here runs through the MCP face on purpose. An engine-level idempotency test
// proves the verb; it does not prove that the registry wrapper forwards the key rather than
// swallowing it, and a wrapper that dropped `idempotencyKey` would double-post through the exact
// path an agent uses.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { callTool } from '../../dist/api/mcp.js';
import { handleRest } from '../../dist/api/rest.js';
import { getAction, ACTIONS } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { PLAIN_IBAN, QR_IBAN } from './support.mjs';

const A19_TOOLS = [
  'create_bank_account',
  'update_bank_account',
  'set_bank_opening_balance',
  'preview_bank_opening_balance',
  'archive_bank_account',
  'unarchive_bank_account',
  'list_bank_accounts',
  'get_bank_account',
];

function viaMcp(deps, name, input) {
  const res = callTool(deps, name, input);
  assert.equal(res.content[0].type, 'text');
  return JSON.parse(res.content[0].text);
}

/** Create 9100 through the registry, the same way any caller would. */
function seedOpeningAccount(deps, workspaceId) {
  const res = getAction('create_account').run(deps, {
    workspaceId,
    number: '9100',
    name: 'Eröffnungsbilanz',
    type: 'equity',
    idempotencyKey: 'ob-acc',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
}

test('all eight A19 verbs are registered exactly once, and the read verbs are marked read', () => {
  for (const name of A19_TOOLS) {
    const matches = ACTIONS.filter((a) => a.name === name);
    assert.equal(matches.length, 1, `${name} must be registered exactly once, found ${matches.length}`);
    assert.ok(matches[0].summary.length > 0, `${name} needs a description an agent can choose it by`);
  }
  assert.equal(getAction('list_bank_accounts').kind, 'read');
  assert.equal(getAction('get_bank_account').kind, 'read');
  assert.equal(getAction('create_bank_account').kind, 'write');
  assert.equal(getAction('set_bank_opening_balance').kind, 'write');
  // D43/B2. The preview is the READ half of the verb above, and the kind is not a label: `readOnlyHint`
  // is advertised off it, so a preview declared `write` would tell every agent it might post.
  assert.equal(getAction('preview_bank_opening_balance').kind, 'read');
  assert.equal(
    'idempotencyKey' in getAction('preview_bank_opening_balance').inputSchema.properties,
    false,
    'a read takes no idempotency key: a key is a promise about a write that never happens',
  );
  // validate_iban is a pure in-process predicate and must NOT be a tool: pre-validating one IBAN
  // and then storing another is exactly the split this keeps closed.
  assert.equal(getAction('validate_iban'), undefined);
});

test('every A19 verb is reachable through the REST twin by name, never 404', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  for (const name of A19_TOOLS) {
    const res = handleRest(name, { workspaceId }, deps);
    assert.notEqual(res.status, 404, `${name} has no REST twin`);
    assert.ok(res.status === 200 || res.status === 422, `${name} answered ${res.status}`);
  }
});

test('MCP and REST agree across the whole A19 flow, step for step', () => {
  const mcp = freshDeps();
  const rest = freshDeps();
  const mw = mintWorkspace(mcp);
  const rw = mintWorkspace(rest);
  assert.equal(mw.workspaceId, rw.workspaceId, 'the two stores must mint identical ids');
  const workspaceId = mw.workspaceId;
  seedOpeningAccount(mcp, workspaceId);
  seedOpeningAccount(rest, workspaceId);
  const ledgerAccountId = mw.accId('1020');
  assert.equal(ledgerAccountId, rw.accId('1020'));

  const step = (name, input) => {
    const m = viaMcp(mcp, name, input);
    const r = handleRest(name, input, rest).body;
    assert.deepEqual(m, r, `parity mismatch for ${name}: ${JSON.stringify({ m, r })}`);
    return m;
  };

  const created = step('create_bank_account', {
    workspaceId,
    name: 'PostFinance Geschäft',
    iban: PLAIN_IBAN,
    currency: 'CHF',
    ledgerAccountId,
    idempotencyKey: 'ba-1',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const bankAccountId = created.bankAccountId;

  // The preview goes BEFORE the posting, which is the whole sequence it exists for, and it is run
  // through both faces because an agent and the Studio must be shown the same figure.
  const previewed = step('preview_bank_opening_balance', {
    workspaceId,
    bankAccountId,
    amountMinor: 1250000,
    currency: 'CHF',
    date: '2026-01-01',
  });
  assert.equal(previewed.ok, true, JSON.stringify(previewed));
  assert.equal(previewed.baseAmountMinor, 1250000);
  assert.equal(previewed.posts, true);

  const opened = step('set_bank_opening_balance', {
    workspaceId,
    bankAccountId,
    amountMinor: 1250000,
    currency: 'CHF',
    date: '2026-01-01',
    idempotencyKey: 'ob-1',
  });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(opened.posted, true);

  step('update_bank_account', { workspaceId, bankAccountId, name: 'PostFinance Haupt' });
  step('get_bank_account', { workspaceId, bankAccountId });
  step('list_bank_accounts', { workspaceId });
  step('archive_bank_account', { workspaceId, bankAccountId });
  step('list_bank_accounts', { workspaceId, includeArchived: true });
  // The round trip runs through the faces too, because F12's whole point is that a human clicking
  // "Wiederherstellen" in the Studio and an agent calling the tool reach the same verb.
  step('unarchive_bank_account', { workspaceId, bankAccountId });
  const restored = step('list_bank_accounts', { workspaceId });
  assert.equal(restored.bankAccounts.length, 1, 'the unarchived account is back in the default picker');
  assert.equal(restored.bankAccounts[0].archived, false);

  // A rejection must be identical on both faces too, not just a success.
  const bad = step('create_bank_account', {
    workspaceId,
    name: 'Falsch',
    iban: 'CH39 0076 2011 6238 5295 7',
    ledgerAccountId,
    idempotencyKey: 'ba-bad',
  });
  assert.equal(bad.error, 'invalid_iban');
});

test('over REST, the previewed base amount is the base amount the posting then writes', () => {
  // The engine suite pins this agreement in-process. This pins it over the wire an agent uses, on a
  // foreign currency, because the wire is where a preview and its posting could be served by two
  // different code paths without anyone noticing in a diff.
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  seedOpeningAccount(deps, workspaceId);

  const created = handleRest(
    'create_bank_account',
    {
      workspaceId,
      name: 'Raiffeisen EUR',
      iban: PLAIN_IBAN,
      currency: 'EUR',
      ledgerAccountId: accId('1020'),
      idempotencyKey: 'ba-eur',
    },
    deps,
  ).body;
  assert.equal(created.ok, true, JSON.stringify(created));

  const shared = {
    workspaceId,
    bankAccountId: created.bankAccountId,
    amountMinor: 1234567,
    currency: 'EUR',
    date: '2026-01-01',
    fxRate: '0.943712',
  };
  const preview = handleRest('preview_bank_opening_balance', shared, deps);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.fxRate, '0.943712');

  const posted = handleRest('set_bank_opening_balance', { ...shared, idempotencyKey: 'ob-eur' }, deps).body;
  assert.equal(posted.ok, true, JSON.stringify(posted));

  // Read off the LEDGER, not off either verb's return value: a pair that agreed with each other and
  // disagreed with the books would be the worst of the three outcomes.
  const bankLeg = deps.store.db
    .prepare(
      `SELECT l.base_debit_minor AS baseDebit FROM journal_line l
         JOIN account a ON a.id = l.account_id
        WHERE l.entry_id = ? AND a.number = '1020'`,
    )
    .get(posted.entryId);
  assert.equal(bankLeg.baseDebit, preview.body.baseAmountMinor);
});

test('a rejected verb answers 422 on REST and still carries the machine-readable code', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const res = handleRest(
    'create_bank_account',
    { workspaceId, name: 'Falsch', iban: 'nope', ledgerAccountId: accId('1020'), idempotencyKey: 'x' },
    deps,
  );
  assert.equal(res.status, 422, 'a P9 rejection is a 422, never a 500 and never a 200');
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'invalid_iban');
});

test('the MCP face forwards the idempotency key: a replayed opening balance posts ONE entry', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  seedOpeningAccount(deps, workspaceId);

  const created = viaMcp(deps, 'create_bank_account', {
    workspaceId,
    name: 'PostFinance Geschäft',
    iban: PLAIN_IBAN,
    ledgerAccountId: accId('1020'),
    idempotencyKey: 'ba-1',
  });
  assert.equal(created.ok, true, JSON.stringify(created));

  const args = {
    workspaceId,
    bankAccountId: created.bankAccountId,
    amountMinor: 1250000,
    currency: 'CHF',
    date: '2026-01-01',
    idempotencyKey: 'ob-1',
  };
  const first = viaMcp(deps, 'set_bank_opening_balance', args);
  const second = viaMcp(deps, 'set_bank_opening_balance', args);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.entryId, first.entryId);

  // Counted in ROWS, through the same database an agent would leave behind. A wrapper that dropped
  // the key would return {ok:true} twice here and this is the only assertion that would notice.
  const entries = deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'")
    .get(workspaceId).n;
  assert.equal(entries, 1, 'one opening balance, one posted entry');
  const bankRows = deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM bank_account WHERE workspace_id = ?')
    .get(workspaceId).n;
  assert.equal(bankRows, 1);
});

test('a QR-IBAN registered through MCP reports receiveOnly, so A18 cannot pick it to debit', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const created = viaMcp(deps, 'create_bank_account', {
    workspaceId,
    name: 'QR Konto',
    iban: QR_IBAN,
    ledgerAccountId: accId('1020'),
    idempotencyKey: 'ba-qr',
  });
  assert.equal(created.isQrIban, true);
  const read = viaMcp(deps, 'get_bank_account', { workspaceId, bankAccountId: created.bankAccountId });
  assert.equal(read.bankAccount.receiveOnly, true);
});

test('§H-TENANT holds at the API edge: a neighbouring workspace cannot read the account', () => {
  const deps = freshDeps();
  const a = mintWorkspace(deps, 'Acme GmbH', 'ws-a');
  const b = mintWorkspace(deps, 'Nachbar AG', 'ws-b');
  const created = viaMcp(deps, 'create_bank_account', {
    workspaceId: a.workspaceId,
    name: 'PostFinance Geschäft',
    iban: PLAIN_IBAN,
    ledgerAccountId: a.accId('1020'),
    idempotencyKey: 'ba-1',
  });
  assert.equal(created.ok, true, JSON.stringify(created));

  const stolen = viaMcp(deps, 'get_bank_account', {
    workspaceId: b.workspaceId,
    bankAccountId: created.bankAccountId,
  });
  assert.equal(stolen.ok, false);
  assert.equal(stolen.error, 'bank_account_not_found');
  assert.deepEqual(viaMcp(deps, 'list_bank_accounts', { workspaceId: b.workspaceId }).bankAccounts, []);
});
