/**
 * F5-C1: the denylist is enforced AT FIRE TIME, on the retry, and on stored rows, asserted on ROWS.
 *
 * These are the critic's own adversarial probes (`docs/critique/f5-critic.md`, 30.07.2026), adopted
 * as permanent regression tests with the polarity flipped: each probe DEMONSTRATED the escape, and
 * each test here asserts the repair. The defect class is the one this suite must never sleep
 * through again: `isNotAutomatable` had exactly two call sites, the save path and the catalogue
 * filter, so a rule stored BEFORE a denylist entry (every one of the 19 F5/D65 additions was a
 * legal, saveable action one commit earlier) kept firing at 03:00, and the critic sealed a fiscal
 * year with one (`close_year`, `status ok`, and `unlock_period` refuses `year_close` by design, so
 * nothing walks it back).
 *
 * Every test asserts the DATABASE, not the Result: the `automation_run` row's status and code, and
 * the target's own table unchanged. A verb that refuses in its answer and writes in its body is the
 * shape this repo keeps being bitten by.
 *
 * The stored rule is planted the way the critic planted it: saved through the PUBLIC verb with a
 * legal action, then its `action_tool` column rewritten, which reproduces on today's store exactly
 * the row `createAutomationRule` wrote the day before the denylist entry existed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAction } from '../../dist/api/registry.js';
import { NOT_AUTOMATABLE } from '../../dist/core/automation/rules.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);

function workspace(seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Verlauf AG', `${seed}-ws`);
  return { deps, workspaceId, accId };
}

const runRows = (deps, workspaceId) =>
  deps.store.db
    .prepare(
      `SELECT rule_id, status, error_code, action_tool FROM automation_run
        WHERE workspace_id = ? ORDER BY started_at, id`,
    )
    .all(workspaceId);

/** A rule saved through the public verb, then aimed at a denied verb the way a pre-F5 row would be. */
function storeLegacyRule(deps, workspaceId, { event, tool, template }) {
  const created = call(deps, 'create_automation_rule', {
    workspaceId,
    name: 'aus der Zeit vor F5',
    trigger: { event },
    action: { tool: 'contacts_tag', inputTemplate: { contactId: 'x', segments: ['a'] } },
    idempotencyKey: `legacy-${tool}`,
  });
  assert.equal(created.ok, true, `fixture setup failed: ${JSON.stringify(created)}`);
  deps.store.db
    .prepare('UPDATE automation_rule SET action_tool = ?, action_input = ? WHERE workspace_id = ? AND id = ?')
    .run(tool, JSON.stringify(template), workspaceId, created.rule.ruleId);
  return created.rule.ruleId;
}

/** The one assertion shape every probe shares: refused in the Verlauf, with the stable code. */
function assertRefusedRun(rows, ruleId, tool) {
  assert.equal(rows.length, 1, `exactly one firing was expected: ${JSON.stringify(rows)}`);
  assert.equal(rows[0].rule_id, ruleId);
  assert.equal(rows[0].action_tool, tool);
  assert.equal(rows[0].status, 'failed', `the fire path executed a denied verb: ${JSON.stringify(rows)}`);
  assert.equal(rows[0].error_code, 'action_not_automatable');
}

test('C1 adopted: a stored rule naming unlock_period is refused at fire time, and the lock survives', () => {
  const { deps, workspaceId } = workspace('c1');
  assert.equal(
    call(deps, 'lock_period', { workspaceId, period: '2026-03', kind: 'hard', idempotencyKey: 'c1-lock' }).ok,
    true,
  );
  const ruleId = storeLegacyRule(deps, workspaceId, {
    event: 'contact.created',
    tool: 'unlock_period',
    template: { period: '2026-03' },
  });
  assert.ok(NOT_AUTOMATABLE.has('unlock_period'));

  assert.equal(
    call(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Auslöser AG', idempotencyKey: 'c1-c' }).ok,
    true,
  );

  assertRefusedRun(runRows(deps, workspaceId), ruleId, 'unlock_period');
  const locks = call(deps, 'list_period_locks', { workspaceId });
  assert.equal(locks.locks.length, 1, 'the hard lock must survive the refused firing');
  assert.equal(locks.locks[0].period, '2026-03');
});

test('C2 adopted: set_role from a stored rule is refused, and the member keeps the role', () => {
  const { deps, workspaceId } = workspace('c2');
  assert.equal(
    call(deps, 'invite_member', { workspaceId, email: 'buchhalterin@muster.ch', role: 'bookkeeper', idempotencyKey: 'c2-i' }).ok,
    true,
  );
  const victim = call(deps, 'list_members', { workspaceId }).members.find((m) => m.role === 'bookkeeper');
  assert.ok(victim !== undefined);

  const ruleId = storeLegacyRule(deps, workspaceId, {
    event: 'contact.created',
    tool: 'set_role',
    template: { memberId: victim.memberId, role: 'viewer' },
  });
  assert.equal(
    call(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Auslöser 2 AG', idempotencyKey: 'c2-c' }).ok,
    true,
  );

  assertRefusedRun(runRows(deps, workspaceId), ruleId, 'set_role');
  const after = call(deps, 'list_members', { workspaceId }).members.find((m) => m.memberId === victim.memberId);
  assert.equal(after.role, 'bookkeeper', 'an automation demoted a member');
});

test('C7 adopted: close_year from a stored rule is refused, and NO year seal exists afterwards', () => {
  const { deps, workspaceId } = workspace('c7');
  const ruleId = storeLegacyRule(deps, workspaceId, {
    event: 'contact.created',
    tool: 'close_year',
    template: { year: '2026' },
  });
  assert.equal(
    call(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Auslöser 3 AG', idempotencyKey: 'c7-c' }).ok,
    true,
  );

  assertRefusedRun(runRows(deps, workspaceId), ruleId, 'close_year');
  // The row assertion that matters most: the irreversible seal was never written.
  const locks = call(deps, 'list_period_locks', { workspaceId });
  assert.deepEqual(locks.locks, [], 'an automation sealed a fiscal year');
});

test('C9 adopted: create_workspace from a stored rule is refused, and no tenant is minted', () => {
  const { deps, workspaceId } = workspace('c9');
  const before = deps.store.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n;
  const ruleId = storeLegacyRule(deps, workspaceId, {
    event: 'contact.created',
    tool: 'create_workspace',
    template: { name: 'Schatten GmbH' },
  });
  assert.equal(
    call(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Auslöser 5 AG', idempotencyKey: 'c9-c' }).ok,
    true,
  );

  assertRefusedRun(runRows(deps, workspaceId), ruleId, 'create_workspace');
  const after = deps.store.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n;
  assert.equal(after, before, 'an automation minted a tenant');
});

test('C3 adopted: retry_automation_run refuses to re-drive a denied verb and settles the stuck row', () => {
  const { deps, workspaceId } = workspace('c3');
  assert.equal(
    call(deps, 'lock_period', { workspaceId, period: '2026-04', kind: 'hard', idempotencyKey: 'c3-lock' }).ok,
    true,
  );
  storeLegacyRule(deps, workspaceId, {
    event: 'contact.created',
    tool: 'unlock_period',
    template: { period: '2026-04' },
  });
  assert.equal(
    call(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'A', idempotencyKey: 'c3-c' }).ok,
    true,
  );
  const row = deps.store.db
    .prepare('SELECT id FROM automation_run WHERE workspace_id = ?')
    .get(workspaceId);
  // Put the row into the stuck state a crash would leave, which is the only state retry accepts.
  deps.store.db.prepare("UPDATE automation_run SET status = 'running', error_code = NULL WHERE id = ?").run(row.id);

  const retried = call(deps, 'retry_automation_run', { workspaceId, runId: row.id });
  assert.equal(retried.ok, false);
  assert.equal(retried.error, 'action_not_automatable');

  // The row is SETTLED, not left running forever: a stuck row nobody can finish is the hex-editor
  // problem the retry exists to solve.
  const settled = deps.store.db.prepare('SELECT status, error_code FROM automation_run WHERE id = ?').get(row.id);
  assert.equal(settled.status, 'failed');
  assert.equal(settled.error_code, 'action_not_automatable');
  const locks = call(deps, 'list_period_locks', { workspaceId });
  assert.equal(locks.locks.length, 1, 'the retry re-drove a denied verb');
});

test('C8 adopted (D65 leg f): set_creditor_profile refuses to SAVE and a stored rule refuses to FIRE', () => {
  const { deps, workspaceId } = workspace('c8');

  // The save half: the critic's exploit rule must no longer be storable at all.
  const created = call(deps, 'create_automation_rule', {
    workspaceId,
    name: 'QR-IBAN umleiten',
    trigger: { event: 'contact.created' },
    action: {
      tool: 'set_creditor_profile',
      inputTemplate: {
        creditorName: 'Kritik AG',
        address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8001', town: 'Zürich', country: 'CH' },
        iban: 'CH9300762011623852957',
      },
    },
    idempotencyKey: 'c8-rule',
  });
  assert.equal(created.ok, false, 'a rule may not name the payee IBAN as its action');
  assert.equal(created.error, 'action_not_automatable');

  // The fire half: a rule stored before the leg existed is refused, and the payee IBAN is untouched.
  const ruleId = storeLegacyRule(deps, workspaceId, {
    event: 'contact.created',
    tool: 'set_creditor_profile',
    template: {
      creditorName: 'Kritik AG',
      address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8001', town: 'Zürich', country: 'CH' },
      iban: 'CH9300762011623852957',
    },
  });
  assert.equal(
    call(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Auslöser 4 AG', idempotencyKey: 'c8-c' }).ok,
    true,
  );
  assertRefusedRun(runRows(deps, workspaceId), ruleId, 'set_creditor_profile');
  const iban = deps.store.db
    .prepare('SELECT creditor_iban FROM workspace WHERE id = ?')
    .get(workspaceId).creditor_iban;
  assert.equal(iban, null, 'an unattended rule rewrote the payee IBAN');
});

test('D65 leg f: update_bank_account refuses to save as a rule action too', () => {
  const { deps, workspaceId } = workspace('d65');
  const created = call(deps, 'create_automation_rule', {
    workspaceId,
    name: 'Bankdaten umleiten',
    trigger: { event: 'contact.created' },
    action: { tool: 'update_bank_account', inputTemplate: { bankAccountId: 'x', iban: 'CH9300762011623852957' } },
    idempotencyKey: 'd65-rule',
  });
  assert.equal(created.ok, false);
  assert.equal(created.error, 'action_not_automatable');
});

test('F5-R4: the enable toggle refuses a stored denied action, so the migration state holds', () => {
  // The re-critic's finding: create and patch were checked, the TOGGLE was not, so a rule in the
  // exact post-migration state (stored denied action, enabled = 0) answered ok:true and the
  // generation-6 work was undone with one call. The fire path neutralised it, but a rule that is
  // enabled and can never run is a lie on the Automations surface. Asserted on the ROW.
  const { deps, workspaceId } = workspace('r4');
  const ruleId = storeLegacyRule(deps, workspaceId, {
    event: 'contact.created',
    tool: 'close_year',
    template: { year: '2026' },
  });
  // The exact post-migration state: stored denied action, disabled.
  deps.store.db
    .prepare('UPDATE automation_rule SET enabled = 0 WHERE workspace_id = ? AND id = ?')
    .run(workspaceId, ruleId);

  const enabled = call(deps, 'enable_automation_rule', { workspaceId, ruleId });
  assert.equal(enabled.ok, false, `the enable toggle re-armed a denied rule: ${JSON.stringify(enabled)}`);
  assert.equal(enabled.error, 'action_not_automatable');
  assert.equal(enabled.tool, 'close_year');

  const row = deps.store.db
    .prepare('SELECT enabled FROM automation_rule WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, ruleId);
  assert.equal(row.enabled, 0, 'the refused enable flipped the flag anyway');

  // And the stop direction is untouched: disable still answers ok on the same rule, because an
  // over-closed stop button is the failure mode G01 was designed against.
  const disabled = call(deps, 'disable_automation_rule', { workspaceId, ruleId });
  assert.equal(disabled.ok, true, JSON.stringify(disabled));
});

test('generation 6: a stored rule naming a denied verb is DISABLED on open, with an audit line, once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-denylist-migration-'));
  const location = join(dir, 'till.db');
  try {
    const clock = fixedClock('2026-07-30T00:00:00.000Z');
    let store = new SqliteStore({ clock, location });
    const deps = { store, clock, ids: sequenceIdGen(), actor: 'studio' };
    const { workspaceId } = mintWorkspace(deps, 'Migration AG', 'mig-ws');

    // One rule that stays legal, one that predates its denylist entry.
    const legal = call(deps, 'create_automation_rule', {
      workspaceId,
      name: 'Erlaubt',
      trigger: { event: 'contact.created' },
      action: { tool: 'contacts_tag', inputTemplate: { contactId: 'x', segments: ['a'] } },
      idempotencyKey: 'mig-legal',
    });
    assert.equal(legal.ok, true);
    const denied = call(deps, 'create_automation_rule', {
      workspaceId,
      name: 'Jahr abschliessen',
      trigger: { event: 'contact.created' },
      action: { tool: 'contacts_tag', inputTemplate: {} },
      idempotencyKey: 'mig-denied',
    });
    assert.equal(denied.ok, true);
    store.db
      .prepare('UPDATE automation_rule SET action_tool = ?, action_input = ? WHERE id = ?')
      .run('close_year', JSON.stringify({ year: '2026' }), denied.rule.ruleId);

    // Rewind the generation marker to the pre-F5 value, exactly the state an upgraded file is in.
    store.db.pragma('user_version = 5');
    store.close();

    // The upgrade: reopening applies generation 6.
    store = new SqliteStore({ clock, location });
    const reopened = { store, clock, ids: sequenceIdGen(), actor: 'studio' };

    const rows = store.db
      .prepare('SELECT id, enabled, action_tool FROM automation_rule ORDER BY created_at')
      .all();
    const deniedRow = rows.find((r) => r.id === denied.rule.ruleId);
    const legalRow = rows.find((r) => r.id === legal.rule.ruleId);
    assert.equal(deniedRow.enabled, 0, 'the migration must disable a rule naming a denied verb');
    assert.equal(legalRow.enabled, 1, 'the migration must not touch a legal rule');

    // The audit line is real, attributed to the system, and the CHAIN still verifies.
    const audit = call(reopened, 'get_audit_log', { workspaceId, entityKind: 'automation_rule' });
    assert.equal(audit.ok, true, JSON.stringify(audit));
    assert.equal(audit.chainVerified, true, 'the migration broke the audit chain');
    const line = audit.rows.find((e) => e.entityId === denied.rule.ruleId);
    assert.ok(line !== undefined, 'the disable owes an audit line');
    assert.equal(line.action, 'disable');
    assert.equal(line.actor, 'system');

    // Idempotent: a second open (generation already 6) changes nothing and appends nothing.
    store.close();
    store = new SqliteStore({ clock, location });
    const again = { store, clock, ids: sequenceIdGen(), actor: 'studio' };
    const audit2 = call(again, 'get_audit_log', { workspaceId, entityKind: 'automation_rule' });
    assert.equal(audit2.rows.length, audit.rows.length, 'the migration re-ran on a current file');
    assert.equal(audit2.chainVerified, true);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
