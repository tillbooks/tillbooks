/**
 * B00, the projects master: the business rules the conformance floor does not derive.
 *
 * The conformance gate already holds §H-TENANT isolation, idempotent-on-rows and the double-call
 * settle over every registered verb, so nothing here restates those. What this suite owns is B00's
 * OWN rules: the full transition matrix, the parent-cycle guard, code uniqueness and the auto
 * suggestion, the draft-only delete census, the closed-project freeze, the phase-budget warning,
 * the §H-FX budget snapshot (taken, kept, re-taken only on a budget/currency edit), budget-actual
 * purity, the close-guard seam, the reopen audit trail, and the structural absence of any posting
 * path in `src/core/projects/`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getAction } from '../../dist/api/registry.js';
import { PROJECT_STATUSES, PROJECT_TRANSITIONS } from '../../dist/core/projects/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

/** A fresh world: its own store, one workspace, a seeded contact, and a bound call helper. */
function world(seed = 'b00') {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const contact = call('create_contact', {
    partyRole: 'customer',
    name: 'Projekt Kunde AG',
    idempotencyKey: `${seed}-contact`,
  });
  assert.equal(contact.ok, true, JSON.stringify(contact));
  return { deps, workspaceId, accId, call, contactId: contact.contact.id };
}

function mkProject(w, seed, extra = {}) {
  const res = w.call('project_create', {
    name: `Projekt ${seed}`,
    contactId: w.contactId,
    idempotencyKey: `${seed}-create`,
    ...extra,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.project;
}

// ---------------------------------------------------------------------------------------------
// Creation rules
// ---------------------------------------------------------------------------------------------

test('B00: create validates the contact, the dates, and the budget shape', () => {
  const w = world('crea');

  const noContact = w.call('project_create', { name: 'X', contactId: 'nope', idempotencyKey: 'c-1' });
  assert.equal(noContact.ok, false);
  assert.equal(noContact.error, 'contact_not_found');

  const badDates = w.call('project_create', {
    name: 'X',
    contactId: w.contactId,
    startsOn: '2026-09-01',
    endsOn: '2026-08-01',
    idempotencyKey: 'c-2',
  });
  assert.equal(badDates.error, 'invalid_dates');

  const negBudget = w.call('project_create', {
    name: 'X',
    contactId: w.contactId,
    budgetMinor: -1,
    idempotencyKey: 'c-3',
  });
  assert.equal(negBudget.error, 'invalid_input');
  assert.equal(negBudget.field, 'budgetMinor');

  // A budget of zero is legal: "no budget set, hours-only" (US-B00.1 boundary).
  const zero = mkProject(w, 'zero', { budgetMinor: 0 });
  assert.equal(zero.budgetMinor, 0);
  assert.equal(zero.status, 'draft');
});

test('B00: the code is auto-suggested P-0001 upward, editable, and unique per workspace', () => {
  const w = world('code');
  const first = mkProject(w, 'one');
  const second = mkProject(w, 'two');
  assert.equal(first.code, 'P-0001');
  assert.equal(second.code, 'P-0002');

  const named = mkProject(w, 'named', { code: 'KUNDE-7' });
  assert.equal(named.code, 'KUNDE-7');

  const dup = w.call('project_create', {
    name: 'Doppelt',
    contactId: w.contactId,
    code: 'P-0001',
    idempotencyKey: 'code-dup',
  });
  assert.equal(dup.ok, false);
  assert.equal(dup.error, 'code_taken');

  // A SECOND workspace may reuse the code: uniqueness is per tenant (§H-TENANT).
  const other = mintWorkspace(w.deps, 'Zweite GmbH', 'code-ws2');
  const otherContact = getAction('create_contact').run(w.deps, {
    workspaceId: other.workspaceId,
    partyRole: 'customer',
    name: 'Andere AG',
    idempotencyKey: 'code-c2',
  });
  const reused = getAction('project_create').run(w.deps, {
    workspaceId: other.workspaceId,
    name: 'Gleicher Code',
    contactId: otherContact.contact.id,
    code: 'P-0001',
    idempotencyKey: 'code-p2',
  });
  assert.equal(reused.ok, true, JSON.stringify(reused));
});

// ---------------------------------------------------------------------------------------------
// The transition matrix, exhaustively
// ---------------------------------------------------------------------------------------------

test('B00: every (from, to) status pair answers exactly what the transition table says', () => {
  // Drive a project INTO each `from` via legal transitions, then attempt every `to`.
  const routes = {
    draft: [],
    active: ['active'],
    on_hold: ['active', 'on_hold'],
    closed: ['active', 'closed'],
  };
  let n = 0;
  for (const from of PROJECT_STATUSES) {
    for (const to of PROJECT_STATUSES) {
      const w = world(`tm-${from}-${to}`);
      const p = mkProject(w, `tm-${from}-${to}`);
      for (const [i, step] of routes[from].entries()) {
        const moved = w.call('project_set_status', { projectId: p.id, status: step, idempotencyKey: `tm-r-${i}` });
        assert.equal(moved.ok, true, `route to ${from} broke at ${step}: ${JSON.stringify(moved)}`);
      }
      const res = w.call('project_set_status', { projectId: p.id, status: to, idempotencyKey: 'tm-x' });
      const legal = PROJECT_TRANSITIONS.some((t) => t.from === from && t.to === to);
      if (legal) {
        assert.equal(res.ok, true, `${from}→${to} should be legal: ${JSON.stringify(res)}`);
        assert.equal(res.project.status, to);
      } else {
        assert.equal(res.ok, false, `${from}→${to} should be illegal`);
        assert.equal(res.error, 'invalid_transition', `${from}→${to} answered ${res.error}`);
      }
      n += 1;
    }
  }
  assert.equal(n, PROJECT_STATUSES.length ** 2, 'the matrix loop did not cover every pair');
});

test('B00: reopening a closed project writes the audit trail', () => {
  const w = world('reopen');
  const p = mkProject(w, 'reopen');
  w.call('project_set_status', { projectId: p.id, status: 'active', idempotencyKey: 'ro-1' });
  w.call('project_set_status', { projectId: p.id, status: 'closed', idempotencyKey: 'ro-2' });
  const reopened = w.call('project_set_status', { projectId: p.id, status: 'active', idempotencyKey: 'ro-3' });
  assert.equal(reopened.ok, true, JSON.stringify(reopened));

  const log = w.call('get_audit_log', { entityKind: 'project' });
  assert.equal(log.ok, true, JSON.stringify(log));
  const entry = log.rows.find((e) => e.action === 'reopen' && e.entityId === p.id);
  assert.ok(entry !== undefined, 'the reopen left no project/reopen audit entry');
  assert.equal(entry.actor, 'agent', 'the reopen is not attributed to the session actor');
});

test('B00: a registered close guard blocks the close (the B01 seam), and disarms cleanly', async () => {
  // The seam itself: register a guard, watch it bite. The registry is module-global and has no
  // unregister (B01 never unregisters), so the guard is ARMED only inside this test: later closes in
  // this same process pass through it as a no-op.
  const { registerCloseGuard } = await import('../../dist/core/projects/index.js');
  const w = world('guard');
  const p = mkProject(w, 'guard');
  w.call('project_set_status', { projectId: p.id, status: 'active', idempotencyKey: 'g-1' });

  let armed = true;
  let saw = null;
  registerCloseGuard((ctx, project) => {
    if (!armed) return undefined;
    saw = project.id;
    return { ok: false, error: 'project_has_open_time', projectId: project.id };
  });
  try {
    const blocked = w.call('project_set_status', { projectId: p.id, status: 'closed', idempotencyKey: 'g-2' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error, 'project_has_open_time');
    assert.equal(saw, p.id, 'the guard never saw the project it was registered for');
    const still = w.call('project_get', { projectId: p.id });
    assert.equal(still.project.status, 'active', 'a blocked close moved the status anyway');
  } finally {
    armed = false;
  }
  const closed = w.call('project_set_status', { projectId: p.id, status: 'closed', idempotencyKey: 'g-3' });
  assert.equal(closed.ok, true, 'with no guard blocking, the close must pass');
});

// ---------------------------------------------------------------------------------------------
// Sub-projects: the parent tree
// ---------------------------------------------------------------------------------------------

test('B00: the parent must exist in the SAME workspace, and a cycle is refused by name', () => {
  const w = world('tree');
  const parent = mkProject(w, 'parent');
  const child = mkProject(w, 'child', { parentId: parent.id });
  assert.equal(child.parentId, parent.id);

  // Cross-tenant parent: not found (§H-TENANT), never linked.
  const other = mintWorkspace(w.deps, 'Fremde GmbH', 'tree-ws2');
  const otherContact = getAction('create_contact').run(w.deps, {
    workspaceId: other.workspaceId,
    partyRole: 'customer',
    name: 'Fremd AG',
    idempotencyKey: 'tree-c2',
  });
  const cross = getAction('project_create').run(w.deps, {
    workspaceId: other.workspaceId,
    name: 'Quer',
    contactId: otherContact.contact.id,
    parentId: parent.id,
    idempotencyKey: 'tree-cross',
  });
  assert.equal(cross.ok, false);
  assert.equal(cross.error, 'parent_not_found');

  // Self-reference and descendant-as-parent are both cycles.
  const selfRef = w.call('project_update', {
    projectId: parent.id,
    patch: { parentId: parent.id },
    idempotencyKey: 'tree-self',
  });
  assert.equal(selfRef.error, 'parent_cycle');
  const descendant = w.call('project_update', {
    projectId: parent.id,
    patch: { parentId: child.id },
    idempotencyKey: 'tree-desc',
  });
  assert.equal(descendant.error, 'parent_cycle');
});

// ---------------------------------------------------------------------------------------------
// Delete: draft-only, and the census
// ---------------------------------------------------------------------------------------------

test('B00: delete is draft-only, refuses children and OP3 references, and takes the draft phases with it', () => {
  const w = world('del');

  // Non-draft refuses.
  const activeP = mkProject(w, 'del-active');
  w.call('project_set_status', { projectId: activeP.id, status: 'active', idempotencyKey: 'del-a1' });
  const notDraft = w.call('project_delete', { projectId: activeP.id, idempotencyKey: 'del-a2' });
  assert.equal(notDraft.ok, false);
  assert.equal(notDraft.error, 'not_draft');

  // A draft parent with a child refuses.
  const parent = mkProject(w, 'del-parent');
  const child = mkProject(w, 'del-child', { parentId: parent.id });
  const hasChildren = w.call('project_delete', { projectId: parent.id, idempotencyKey: 'del-p1' });
  assert.equal(hasChildren.error, 'has_children');

  // A draft carrying a custom-field value refuses (the OP3 census).
  const tagged = mkProject(w, 'del-tagged');
  const defined = w.call('define_field', {
    entityKind: 'project',
    key: 'projekttyp',
    labelI18n: { 'de-CH': 'Projekttyp', en: 'Project type' },
    type: 'text',
    idempotencyKey: 'del-def',
  });
  assert.equal(defined.ok, true, JSON.stringify(defined));
  // The `agent` actor defines fields as P8 drafts: release it so the value write is accepted.
  const confirmed = w.call('confirm_field', { fieldDefId: defined.fieldDef.fieldDefId, idempotencyKey: 'del-conf' });
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  const set = w.call('set_field_value', {
    entityKind: 'project',
    entityId: tagged.id,
    fieldKey: 'projekttyp',
    value: 'Festpreis',
    idempotencyKey: 'del-set',
  });
  assert.equal(set.ok, true, JSON.stringify(set));
  const referenced = w.call('project_delete', { projectId: tagged.id, idempotencyKey: 'del-t1' });
  assert.equal(referenced.ok, false);
  assert.equal(referenced.error, 'project_referenced');
  assert.deepEqual(referenced.refs, ['custom_field_value']);

  // A clean draft with phases deletes, phases included, in one act.
  const clean = w.call('project_delete', { projectId: child.id, idempotencyKey: 'del-c1' });
  assert.equal(clean.ok, true, JSON.stringify(clean));
  const doomed = mkProject(w, 'del-phased');
  const ph = w.call('project_phase_add', { projectId: doomed.id, name: 'Konzept', idempotencyKey: 'del-ph' });
  assert.equal(ph.ok, true);
  const gone = w.call('project_delete', { projectId: doomed.id, idempotencyKey: 'del-d1' });
  assert.equal(gone.ok, true, JSON.stringify(gone));
  const orphans = w.deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM project_phase WHERE workspace_id = ? AND project_id = ?')
    .get(w.workspaceId, doomed.id);
  assert.equal(orphans.n, 0, 'deleting the draft left orphaned phase rows');
});

// ---------------------------------------------------------------------------------------------
// Phases: the closed freeze, the warning, and the milestone assertion
// ---------------------------------------------------------------------------------------------

test('B00: a closed project refuses every phase write, and the budget warning warns without blocking', () => {
  const w = world('ph');
  const p = mkProject(w, 'ph', { budgetMinor: 100000 });

  const first = w.call('project_phase_add', {
    projectId: p.id,
    name: 'Konzept',
    budgetMinor: 60000,
    idempotencyKey: 'ph-1',
  });
  assert.equal(first.ok, true);
  assert.deepEqual(first.warnings, [], 'a within-budget phase warned');

  const second = w.call('project_phase_add', {
    projectId: p.id,
    name: 'Umsetzung',
    budgetMinor: 60000,
    milestoneOn: '2026-10-01',
    idempotencyKey: 'ph-2',
  });
  assert.equal(second.ok, true, 'exceeding the envelope must WARN, never block (US-B00.2)');
  assert.deepEqual(second.warnings, ['phase_budgets_exceed_project']);

  // Milestone done is a state assertion: the second call reports alreadyDone with the date kept.
  const done = w.call('project_phase_done', { phaseId: second.phase.id, doneAt: '2026-10-02', idempotencyKey: 'ph-d1' });
  assert.equal(done.ok, true);
  assert.equal(done.phase.doneAt, '2026-10-02');
  const again = w.call('project_phase_done', { phaseId: second.phase.id, doneAt: '2026-11-11' });
  assert.equal(again.ok, true);
  assert.equal(again.alreadyDone, true);
  assert.equal(again.phase.doneAt, '2026-10-02', 'a repeat re-stamped the milestone date');

  // Freeze on closed.
  w.call('project_set_status', { projectId: p.id, status: 'active', idempotencyKey: 'ph-s1' });
  w.call('project_set_status', { projectId: p.id, status: 'closed', idempotencyKey: 'ph-s2' });
  for (const [verb, input] of [
    ['project_phase_add', { projectId: p.id, name: 'Nachtrag' }],
    ['project_phase_update', { phaseId: first.phase.id, patch: { name: 'Umbenannt' } }],
    ['project_phase_done', { phaseId: first.phase.id }],
    ['project_update', { projectId: p.id, patch: { name: 'Umbenannt' } }],
  ]) {
    const res = w.call(verb, { ...input, idempotencyKey: `ph-frozen-${verb}` });
    assert.equal(res.ok, false, `${verb} succeeded on a closed project`);
    assert.equal(res.error, 'project_closed', `${verb} answered ${res.error}`);
  }
});

// ---------------------------------------------------------------------------------------------
// §H-FX: the budget snapshot
// ---------------------------------------------------------------------------------------------

test('B00: a non-base budget snapshots base Rappen + rate, and re-rates only when told to', () => {
  const w = world('fx');

  // No rate recorded and none passed: the create refuses rather than guessing (§H-FX).
  const noRate = w.call('project_create', {
    name: 'Euro Projekt',
    contactId: w.contactId,
    currency: 'EUR',
    budgetMinor: 100000,
    idempotencyKey: 'fx-0',
  });
  assert.equal(noRate.ok, false);
  assert.equal(noRate.error, 'needs_fx_rate');

  // An explicit rate wins and is snapshotted with the converted base amount.
  const p = mkProject(w, 'fx', { currency: 'EUR', budgetMinor: 100000, fxRate: '0.93' });
  assert.equal(p.budgetBaseMinor, 93000);
  assert.equal(p.fxRate, '0.93');

  // An edit that touches NEITHER currency nor budget keeps the snapshot exactly (never re-rate).
  const renamed = w.call('project_update', {
    projectId: p.id,
    patch: { name: 'Euro Projekt II' },
    idempotencyKey: 'fx-1',
  });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.project.budgetBaseMinor, 93000);
  assert.equal(renamed.project.fxRate, '0.93');

  // A budget edit re-snapshots (here with a fresh explicit rate).
  const rebudget = w.call('project_update', {
    projectId: p.id,
    patch: { budgetMinor: 200000, fxRate: '0.95' },
    idempotencyKey: 'fx-2',
  });
  assert.equal(rebudget.ok, true, JSON.stringify(rebudget));
  assert.equal(rebudget.project.budgetBaseMinor, 190000);
  assert.equal(rebudget.project.fxRate, '0.95');

  // A base-currency project stores NO base copy at all.
  const chf = mkProject(w, 'fx-chf', { budgetMinor: 50000 });
  assert.equal(chf.budgetBaseMinor, null);
  assert.equal(chf.fxRate, null);
});

// ---------------------------------------------------------------------------------------------
// Budget vs actual: pure, zero-actual today, and the base rollup
// ---------------------------------------------------------------------------------------------

test('B00: budget_actual is a pure read (identical twice, writes nothing) with the promised shape', () => {
  const w = world('ba');
  const p = mkProject(w, 'ba', { budgetMinor: 300000, budgetHours: 40 });
  w.call('project_phase_add', { projectId: p.id, name: 'Konzept', budgetMinor: 100000, idempotencyKey: 'ba-ph' });

  const before = w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get();
  const first = w.call('project_budget_actual', { projectId: p.id });
  const second = w.call('project_budget_actual', { projectId: p.id });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(second, first, 'two consecutive reads over unchanged data differ: something cached or wrote');

  // The US-B00.4 shape, and the pre-B01 zero actuals.
  assert.equal(first.budgetMinor, 300000);
  assert.equal(first.budgetHours, 40);
  assert.equal(first.actualCostMinor, 0);
  assert.equal(first.actualHours, 0);
  assert.equal(first.remainingMinor, 300000);
  assert.equal(first.remainingHours, 40);
  assert.equal(first.overBudget, false);
  assert.equal(first.phases.length, 1);
  assert.equal(first.phases[0].budgetMinor, 100000);
  assert.equal(first.phases[0].actualCostMinor, 0);

  // Writes nothing: row counts across every B00-adjacent table are unchanged.
  const after = w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get();
  assert.equal(after.n, before.n, 'a READ verb wrote an audit row');
});

test('B00: the subtree rollup sums BASE Rappen across a mixed-currency tree', () => {
  const w = world('roll');
  const parent = mkProject(w, 'roll-parent', { budgetMinor: 100000 });
  mkProject(w, 'roll-chf', { parentId: parent.id, budgetMinor: 50000 });
  mkProject(w, 'roll-eur', { parentId: parent.id, currency: 'EUR', budgetMinor: 100000, fxRate: '0.93' });

  const solo = w.call('project_budget_actual', { projectId: parent.id });
  assert.equal(solo.subtree, undefined, 'the rollup must be opt-in');

  const rolled = w.call('project_budget_actual', { projectId: parent.id, includeSubprojects: true });
  assert.equal(rolled.ok, true, JSON.stringify(rolled));
  assert.equal(rolled.subtree.projectCount, 3);
  // 100000 (parent, base) + 50000 (child, base) + 93000 (EUR child's SNAPSHOT, not a re-rate).
  assert.equal(rolled.subtree.budgetBaseMinor, 243000);
  assert.equal(rolled.subtree.actualCostMinor, 0);
  assert.equal(rolled.subtree.overBudget, false);
});

// ---------------------------------------------------------------------------------------------
// Saved views (G00) and the list filters
// ---------------------------------------------------------------------------------------------

test('B00: project_list filters, and a saved view merges UNDER explicit filters', () => {
  const w = world('list');
  const a = mkProject(w, 'list-a', { code: 'A-1' });
  const b = mkProject(w, 'list-b', { code: 'B-1' });
  w.call('project_set_status', { projectId: b.id, status: 'active', idempotencyKey: 'ls-1' });

  const drafts = w.call('project_list', { status: 'draft' });
  assert.deepEqual(drafts.projects.map((p) => p.id), [a.id]);

  const byQuery = w.call('project_list', { query: 'list-b' });
  assert.deepEqual(byQuery.projects.map((p) => p.id), [b.id]);

  const view = w.call('create_saved_view', {
    entityKind: 'project',
    name: 'Aktive Projekte',
    filters: { status: 'active' },
    idempotencyKey: 'ls-view',
  });
  assert.equal(view.ok, true, JSON.stringify(view));
  const viewed = w.call('project_list', { savedViewId: view.savedView.viewId });
  assert.deepEqual(viewed.projects.map((p) => p.id), [b.id]);
  // An explicit filter WINS over the stored one.
  const overridden = w.call('project_list', { savedViewId: view.savedView.viewId, status: 'draft' });
  assert.deepEqual(overridden.projects.map((p) => p.id), [a.id]);
});

// ---------------------------------------------------------------------------------------------
// C00 integration: the merge re-point line B00 owed
// ---------------------------------------------------------------------------------------------

test('B00: a contact merge re-points project.contact_id to the survivor (C00 §0)', () => {
  const w = world('merge');
  const dupe = w.call('create_contact', { partyRole: 'customer', name: 'Doppelt AG', idempotencyKey: 'mg-dupe' });
  assert.equal(dupe.ok, true);
  const p = w.call('project_create', {
    name: 'Beim Duplikat',
    contactId: dupe.contact.id,
    idempotencyKey: 'mg-proj',
  });
  assert.equal(p.ok, true, JSON.stringify(p));

  const merged = w.call('contacts_merge', {
    sourceId: dupe.contact.id,
    targetId: w.contactId,
    idempotencyKey: 'mg-1',
  });
  assert.equal(merged.ok, true, JSON.stringify(merged));

  const after = w.call('project_get', { projectId: p.project.id });
  assert.equal(
    after.project.contactId,
    w.contactId,
    'the merge left the project pointing at a tombstoned contact',
  );
});

// ---------------------------------------------------------------------------------------------
// Structural: no posting path
// ---------------------------------------------------------------------------------------------

test('B00: nothing under src/core/projects/ imports a posting or payment path', () => {
  const dir = fileURLToPath(new URL('../../src/core/projects/', import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 5, `only ${files.length} sources found: the probe is aimed wrong`);
  for (const file of files) {
    const text = readFileSync(dir + file, 'utf8');
    // IMPORT statements only: a docblock may NAME postEntry while promising not to import it, and a
    // probe that flags the promise is the probe over-matching (ORIENTATION trap: check your probe).
    for (const importLine of text.matchAll(/import[\s\S]{0,200}?from\s+'([^']+)'/g)) {
      const spec = importLine[1];
      assert.ok(
        !spec.includes('/ledger/') && !spec.includes('/payments/'),
        `${file} imports ${spec}: B00 must never open a posting or payment path (P3, spec §4)`,
      );
    }
    for (const symbol of ['postEntry(', 'recordPayment(', 'reverseEntry(']) {
      assert.ok(!text.includes(symbol), `${file} CALLS ${symbol}): B00 must never post (P3, spec §4)`);
    }
  }
});
