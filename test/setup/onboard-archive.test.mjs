/**
 * A23, multi-client workspaces: the business rules the conformance floor does not state.
 *
 * The standing gate already holds `onboard_client` and `archive_workspace` to idempotency-on-rows,
 * §H-TENANT and the read/write contract, like every verb in `ACTIONS`. What lives here is what only
 * A23's spec knows:
 *
 *   - onboarding COMPOSES A00/A01/A05/A24: the KMU chart is byte-identical to a bare
 *     create_workspace's, the tax codes arrive exactly when a VAT method does, and the book is born
 *     PROVISIONED (accepted owner rows), never in A24's ungated step-1 state.
 *   - archive = a FLAG: writes refuse with `workspace_archived` at the shared boundary, reads keep
 *     answering, unarchive restores writes, and nothing is ever deleted.
 *   - the roster read is scoped: archived mandates hide unless asked for, and a revoked actor stops
 *     seeing even the mandate's name.
 *   - two client books never bleed into each other (§H-TENANT, the spec's first-order concern).
 *
 * Everything drives the REGISTRY (`getAction(...).run`), not the engine directly, because the
 * boundary (the archived-workspace guard, the A24 gate, the automation emit) is part of what is
 * under test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { NOT_AUTOMATABLE } from '../../dist/core/automation/denylist.js';
import { AUTOMATION_EVENT_IDS } from '../../dist/core/automation/events.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);

function must(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

// --- onboarding composes, never re-implements ---------------------------------------------------

test('onboard_client mints a workspace whose KMU chart is exactly create_workspace\'s', () => {
  const deps = freshDeps();
  const bare = must(call(deps, 'create_workspace', { name: 'Solo GmbH', idempotencyKey: 'cw' }), 'create_workspace');
  const onboarded = must(
    call(deps, 'onboard_client', { name: 'Mandant AG', legalForm: 'ag', idempotencyKey: 'oc' }),
    'onboard_client',
  );
  const chart = (wsId) =>
    deps.store.db
      .prepare('SELECT number, name, type FROM account WHERE workspace_id = ? ORDER BY number')
      .all(wsId);
  const bareChart = chart(bare.workspaceId);
  assert.ok(bareChart.length > 0, 'the KMU seed minted no accounts at all');
  assert.deepEqual(chart(onboarded.workspaceId), bareChart, 'the onboarded chart drifted from the A00/A01 seed');
});

test('onboard_client seeds tax codes and the VAT method exactly when the pair is given', () => {
  const deps = freshDeps();
  const withVat = must(
    call(deps, 'onboard_client', {
      name: 'MWST Mandant AG',
      vatMethod: 'effektiv',
      vatAccounting: 'soll',
      idempotencyKey: 'oc-vat',
    }),
    'onboard_client with VAT',
  );
  const withoutVat = must(
    call(deps, 'onboard_client', { name: 'Verein ohne MWST', idempotencyKey: 'oc-novat' }),
    'onboard_client without VAT',
  );

  const codes = (wsId) =>
    deps.store.db.prepare('SELECT COUNT(*) AS n FROM tax_code WHERE workspace_id = ?').get(wsId).n;
  assert.ok(codes(withVat.workspaceId) > 0, 'a VAT method was given but no tax codes were seeded');
  assert.equal(codes(withoutVat.workspaceId), 0, 'no VAT method was given, yet tax codes were seeded');

  const ws = deps.store.db
    .prepare('SELECT vat_method, vat_accounting FROM workspace WHERE id = ?')
    .get(withVat.workspaceId);
  assert.equal(ws.vat_method, 'effektiv');
  assert.equal(ws.vat_accounting, 'soll');

  // The seeded set is the SAME set vat_seed_defaults answers for a bare workspace: composed, not forked.
  const bare = must(call(deps, 'create_workspace', { name: 'Referenz', idempotencyKey: 'ref' }), 'create_workspace');
  must(call(deps, 'vat_seed_defaults', { workspaceId: bare.workspaceId }), 'vat_seed_defaults');
  const codeSet = (wsId) =>
    deps.store.db.prepare('SELECT code FROM tax_code WHERE workspace_id = ? ORDER BY code').all(wsId).map((r) => r.code);
  assert.deepEqual(codeSet(withVat.workspaceId), codeSet(bare.workspaceId), 'the onboarded tax-code set drifted from A05\'s seed');
});

test('a VAT method without its timing (and the reverse) is refused before anything mints', () => {
  const deps = freshDeps();
  const before = deps.store.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n;
  const missingTiming = call(deps, 'onboard_client', { name: 'Halb AG', vatMethod: 'effektiv', idempotencyKey: 'oc-half1' });
  const missingMethod = call(deps, 'onboard_client', { name: 'Halb AG', vatAccounting: 'soll', idempotencyKey: 'oc-half2' });
  assert.equal(missingTiming.ok, false);
  assert.equal(missingTiming.error, 'invalid_input');
  assert.equal(missingMethod.ok, false);
  assert.equal(missingMethod.error, 'invalid_input');
  assert.equal(
    deps.store.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n,
    before,
    'a refused onboarding minted a workspace anyway',
  );
});

test('onboard_client seats the D13 actors as ACCEPTED owners: the book is born provisioned', () => {
  const deps = freshDeps();
  const res = must(call(deps, 'onboard_client', { name: 'Mandant AG', idempotencyKey: 'oc' }), 'onboard_client');
  const members = deps.store.db
    .prepare(
      `SELECT u.actor_id, m.role, m.accepted_at
         FROM workspace_member m JOIN user u ON u.id = m.user_id
        WHERE m.workspace_id = ? ORDER BY u.actor_id`,
    )
    .all(res.workspaceId);
  assert.ok(members.length > 0, 'the onboarded book has no member rows: it is in A24\'s ungated state');
  for (const m of members) {
    assert.equal(m.role, 'owner', `actor ${m.actor_id} was seated as ${m.role}, not owner`);
    assert.notEqual(m.accepted_at, null, `actor ${m.actor_id} was seated pending, so it holds nothing`);
  }
  assert.ok(
    members.some((m) => m.actor_id === 'agent'),
    'the caller\'s own actor was not seated: the D50 silent-lockout shape',
  );
  // And the audit chain says who claimed it.
  const audit = must(call(deps, 'get_audit_log', { workspaceId: res.workspaceId, entityKind: 'workspace_member' }), 'get_audit_log');
  assert.ok(
    audit.rows.some((e) => e.action === 'claim_owner'),
    'the owner seating left no claim_owner row on the audit chain',
  );
});

test('onboard_client is idempotent per key: one client, however often the instruction is replayed', () => {
  const deps = freshDeps();
  const first = must(call(deps, 'onboard_client', { name: 'Mandant AG', idempotencyKey: 'oc-once' }), 'first call');
  const replay = must(call(deps, 'onboard_client', { name: 'Mandant AG', idempotencyKey: 'oc-once' }), 'replay');
  assert.equal(replay.workspaceId, first.workspaceId, 'the replay minted a second client');
  const n = deps.store.db.prepare('SELECT COUNT(*) AS n FROM workspace WHERE name = ?').get('Mandant AG').n;
  assert.equal(n, 1);
});

// --- archive is a flag, and the boundary makes it read-only -------------------------------------

test('an archived workspace refuses EVERY other write with workspace_archived, keeps answering reads, and unarchive restores it', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  // A posted entry BEFORE archiving, so "the books stay intact" is about real rows.
  must(
    call(deps, 'post_entry', {
      workspaceId,
      date: '2026-03-01',
      source: 'manual',
      idempotencyKey: 'pre',
      lines: [
        { account: accId('6500'), debit: 4200 },
        { account: accId('1000'), credit: 4200 },
      ],
    }),
    'post_entry before archive',
  );

  must(call(deps, 'archive_workspace', { workspaceId, archived: true, idempotencyKey: 'arch' }), 'archive');

  // A write from a DIFFERENT capability refuses at the boundary, before the verb.
  const refused = call(deps, 'create_contact', {
    workspaceId,
    partyRole: 'customer',
    name: 'Zu spät AG',
    idempotencyKey: 'late',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'workspace_archived');
  const posted = call(deps, 'post_entry', {
    workspaceId,
    date: '2026-03-02',
    source: 'manual',
    idempotencyKey: 'late2',
    lines: [
      { account: accId('6500'), debit: 100 },
      { account: accId('1000'), credit: 100 },
    ],
  });
  assert.equal(posted.ok, false);
  assert.equal(posted.error, 'workspace_archived');

  // Reads keep answering: the mandate's books stay readable and exportable (OR 958f).
  const journal = must(call(deps, 'list_journal', { workspaceId }), 'list_journal on archived');
  assert.equal(journal.entries.length, 1, 'the archived book lost its posted entry');
  must(call(deps, 'get_workspace', { workspaceId }), 'get_workspace on archived');

  // Unarchive rides the SAME verb (the one write the guard lets through) and restores writes.
  must(call(deps, 'archive_workspace', { workspaceId, archived: false, idempotencyKey: 'unarch' }), 'unarchive');
  must(
    call(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Wieder da AG', idempotencyKey: 'back' }),
    'write after unarchive',
  );

  // Nothing was ever deleted: the workspace row and its journal survived the whole round trip.
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM workspace WHERE id = ?').get(workspaceId).n, 1);
  assert.equal(
    deps.store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'").get(workspaceId).n,
    1,
  );
});

test('archiving stamps the audit chain, in both directions', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  must(call(deps, 'archive_workspace', { workspaceId, archived: true, idempotencyKey: 'a1' }), 'archive');
  must(call(deps, 'archive_workspace', { workspaceId, archived: false, idempotencyKey: 'a2' }), 'unarchive');
  const audit = must(call(deps, 'get_audit_log', { workspaceId, entityKind: 'workspace' }), 'get_audit_log');
  const actions = audit.rows.map((e) => e.action);
  assert.ok(actions.includes('archive'), 'no archive row on the chain');
  assert.ok(actions.includes('unarchive'), 'no unarchive row on the chain');
  assert.equal(audit.chainVerified, true, 'the archive rows broke the hash chain');
});

// --- the roster read: archived hidden by default, revoked actors scoped out ---------------------

test('list_workspaces hides an archived mandate unless includeArchived asks, and flags it when it does', () => {
  const deps = freshDeps();
  const a = mintWorkspace(deps, 'Aktiv AG', 'ws-a').workspaceId;
  const b = mintWorkspace(deps, 'Archiv AG', 'ws-b').workspaceId;
  must(call(deps, 'archive_workspace', { workspaceId: b, archived: true, idempotencyKey: 'arch-b' }), 'archive');

  const byId = (res) => res.workspaces.map((w) => w.workspaceId);
  const defaults = must(call(deps, 'list_workspaces', {}), 'list default');
  assert.ok(byId(defaults).includes(a));
  assert.ok(!byId(defaults).includes(b), 'an archived mandate still cluttered the default list');

  const all = must(call(deps, 'list_workspaces', { includeArchived: true }), 'list includeArchived');
  assert.ok(byId(all).includes(b), 'includeArchived did not surface the archived mandate');
  const row = all.workspaces.find((w) => w.workspaceId === b);
  assert.equal(row.archived, true);
  assert.equal(all.workspaces.find((w) => w.workspaceId === a).archived, false);
});

test('list_workspaces stops listing a mandate the actor was revoked from; the boundary refuses its reads with role null', () => {
  const deps = freshDeps(); // actor: 'agent'
  const { workspaceId } = mintWorkspace(deps, 'Mandat Muster AG', 'ws-m');
  // Provision through the real path: the first invite seats every D13 actor as accepted owner.
  must(
    call(deps, 'invite_member', {
      workspaceId,
      email: 'extern@treuhand.example',
      role: 'viewer',
      idempotencyKey: 'inv',
    }),
    'invite_member',
  );
  assert.ok(
    must(call(deps, 'list_workspaces', {}), 'list before revoke').workspaces.some((w) => w.workspaceId === workspaceId),
    'a seated owner does not see its own mandate',
  );

  // Revoke the agent's own membership (as studio, so last_owner does not bite).
  const memberId = deps.store.db
    .prepare(
      `SELECT m.id FROM workspace_member m JOIN user u ON u.id = m.user_id
        WHERE m.workspace_id = ? AND u.actor_id = 'agent'`,
    )
    .get(workspaceId).id;
  must(call({ ...deps, actor: 'studio' }, 'revoke_member', { workspaceId, memberId }), 'revoke_member');

  // The roster no longer names the mandate for the revoked actor (revDSG separation)...
  assert.ok(
    !must(call(deps, 'list_workspaces', {}), 'list after revoke').workspaces.some((w) => w.workspaceId === workspaceId),
    'a revoked actor still sees the mandate in the roster',
  );
  // ...while the seated studio still does.
  assert.ok(
    must(call({ ...deps, actor: 'studio' }, 'list_workspaces', {}), 'studio list').workspaces.some(
      (w) => w.workspaceId === workspaceId,
    ),
  );
  // And the boundary tells the revoked actor "not your book": permission_denied with role null.
  const denied = call(deps, 'get_workspace', { workspaceId });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'permission_denied');
  assert.equal(denied.role, null);
});

// --- §H-TENANT: two mandates never bleed --------------------------------------------------------

test('two onboarded client books never bleed into each other (§H-TENANT, the spec\'s first-order concern)', () => {
  const deps = freshDeps();
  const a = must(call(deps, 'onboard_client', { name: 'Mandant A AG', idempotencyKey: 'oc-a' }), 'onboard A').workspaceId;
  const b = must(call(deps, 'onboard_client', { name: 'Mandant B GmbH', idempotencyKey: 'oc-b' }), 'onboard B').workspaceId;
  const accId = (wsId, number) =>
    deps.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(wsId, number).id;

  const post = (wsId, amount, key) =>
    must(
      call(deps, 'post_entry', {
        workspaceId: wsId,
        date: '2026-03-01',
        source: 'manual',
        idempotencyKey: key,
        lines: [
          { account: accId(wsId, '6500'), debit: amount },
          { account: accId(wsId, '1000'), credit: amount },
        ],
      }),
      `post into ${wsId}`,
    );
  const inA = post(a, 1111, 'pa');
  post(b, 2222, 'pb');

  const journalA = must(call(deps, 'list_journal', { workspaceId: a }), 'journal A');
  const journalB = must(call(deps, 'list_journal', { workspaceId: b }), 'journal B');
  assert.equal(journalA.entries.length, 1);
  assert.equal(journalB.entries.length, 1);
  assert.equal(journalA.entries[0].total, 1111, 'client A\'s journal shows a figure that is not its own');
  assert.equal(journalB.entries[0].total, 2222, 'client B\'s journal shows a figure that is not its own');

  // Reading A's entry through B's scope answers not_found, never the row.
  const cross = call(deps, 'get_entry', { workspaceId: b, entryId: inA.entryId });
  assert.equal(cross.ok, false, 'workspace B could read workspace A\'s entry: tenant bleed');

  // Archiving A is invisible to B.
  must(call(deps, 'archive_workspace', { workspaceId: a, archived: true, idempotencyKey: 'arch-a' }), 'archive A');
  must(
    call(deps, 'create_contact', { workspaceId: b, partyRole: 'customer', name: 'B bleibt offen AG', idempotencyKey: 'cb' }),
    'write into B after archiving A',
  );
});

// --- the G01 classification is what the spec says it is -----------------------------------------

test('onboard_client is denied to automation (leg d) and archive_workspace stays automatable with its event pair registered', () => {
  assert.ok(NOT_AUTOMATABLE.has('onboard_client'), 'a rule could mint tenants: onboard_client must be leg (d) denied');
  assert.ok(!NOT_AUTOMATABLE.has('archive_workspace'), 'A23 §6b names archive_workspace an accepted automation action');
  assert.ok(AUTOMATION_EVENT_IDS.includes('workspace.archived'));
  assert.ok(AUTOMATION_EVENT_IDS.includes('workspace.unarchived'));
  assert.ok(!AUTOMATION_EVENT_IDS.includes('workspace.created'), 'workspace.created does not exist; minting it is A00\'s call');
});

test('the archive/unarchive event pair discriminates on the result path: one direction, one event', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const archived = must(call(deps, 'archive_workspace', { workspaceId, archived: true, idempotencyKey: 'e1' }), 'archive');
  assert.equal(archived.archivedWorkspaceId, workspaceId);
  assert.equal(archived.unarchivedWorkspaceId, undefined, 'an archive also carried the unarchive path: both events would fire');
  const unarchived = must(call(deps, 'archive_workspace', { workspaceId, archived: false, idempotencyKey: 'e2' }), 'unarchive');
  assert.equal(unarchived.unarchivedWorkspaceId, workspaceId);
  assert.equal(unarchived.archivedWorkspaceId, undefined, 'an unarchive also carried the archive path: both events would fire');
});

test('a G01 rule on workspace.archived fires when a mandate is archived', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  // The rule reacts by logging an activity on a contact: a side-effect a Treuhänder team would wire.
  const contact = must(
    call(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Mandatsende AG', idempotencyKey: 'c' }),
    'create_contact',
  ).contact.id;
  // Authored as `studio`: an agent-authored rule lands DISABLED by design (P8), and this test is
  // about the event, not the enable gate.
  must(
    call({ ...deps, actor: 'studio' }, 'create_automation_rule', {
      workspaceId,
      name: 'Mandat archiviert: notieren',
      trigger: { event: 'workspace.archived' },
      action: {
        tool: 'contacts_log_activity',
        inputTemplate: { contactId: contact, kind: 'note', body: 'Mandat archiviert.' },
      },
      idempotencyKey: 'rule',
    }),
    'create_automation_rule',
  );
  must(call(deps, 'archive_workspace', { workspaceId, archived: true, idempotencyKey: 'fire' }), 'archive');
  const runs = must(call(deps, 'list_automation_runs', { workspaceId }), 'list_automation_runs');
  assert.equal(runs.runs.length, 1, 'the workspace.archived occurrence did not reach the rule');
  assert.equal(runs.runs[0].event, 'workspace.archived');
  // The FIRED write into the just-archived workspace is refused by the read-only boundary, which is
  // the two guards composing honestly: the event fired, and the archive still means read-only.
  assert.equal(runs.runs[0].status, 'failed');
  assert.equal(runs.runs[0].errorCode, 'workspace_archived');
});
