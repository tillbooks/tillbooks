/**
 * B00 US-B00.4, the §H-FX seam of the budget-vs-actual read model.
 *
 * REGRESSION (kaizen code2-f2): the top-level standing used to subtract BASE-currency actuals from a
 * PROJECT-currency budget and then tag the result with the project currency. For a non-base-currency
 * project that mixes two currencies into `remainingMinor` / `overBudget` and mislabels the figure. The
 * cost seam answers base Rappen by contract (`costSeams.ts`), so the budget side must be base too: the
 * snapshotted `budget_base_minor` (the same figure `baseBudgetOf` feeds the subtree rollup), tagged
 * with the workspace base currency. This suite pins that the headline standing and the subtree rollup
 * report the SAME base figures for one non-base project.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { registerCostSource } from '../../dist/core/projects/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

function world(seed) {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const contact = call('create_contact', {
    partyRole: 'customer',
    name: 'Projekt Kunde AG',
    idempotencyKey: `${seed}-contact`,
  });
  assert.equal(contact.ok, true, JSON.stringify(contact));
  return { deps, workspaceId, call, contactId: contact.contact.id };
}

test('B00 §H-FX: the top-level standing of a non-base project is base Rappen, consistent with the rollup', () => {
  const w = world('bac');

  // A EUR project: budget 1000.00 EUR, snapshotted at 0.93 to 930.00 CHF base.
  const p = w.call('project_create', {
    name: 'Euro Projekt',
    contactId: w.contactId,
    currency: 'EUR',
    budgetMinor: 100000,
    fxRate: '0.93',
    idempotencyKey: 'bac-create',
  });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.project.budgetBaseMinor, 93000, 'precondition: the EUR budget snapshots to 93000 base Rappen');

  // A registered cost source attributes 500.00 in BASE Rappen to THIS project only (the seam contract:
  // sources answer base-currency Rappen). Scoping the attribution to p.project.id keeps it tenant-safe
  // and leaves every other project in this process at zero (§H-TENANT).
  const ACTUAL_BASE_MINOR = 50000;
  registerCostSource({
    id: 'bac_test_base_cost',
    actuals: (_ctx, project) =>
      project.id === p.project.id ? [{ phaseId: null, costMinor: ACTUAL_BASE_MINOR, hours: 0 }] : [],
  });

  const solo = w.call('project_budget_actual', { projectId: p.project.id });
  assert.equal(solo.ok, true, JSON.stringify(solo));

  // The headline standing must be in BASE: budget = the snapshot (93000), NOT the EUR face (100000).
  assert.equal(solo.budgetMinor, 93000, 'the top-level budget must be the base snapshot, not the EUR face value');
  assert.equal(solo.currency, 'CHF', 'the top-level standing must be tagged with the base currency');
  // remaining is now a same-currency subtraction: 93000 base - 50000 base = 43000 base.
  assert.equal(solo.remainingMinor, 93000 - ACTUAL_BASE_MINOR);
  assert.equal(solo.overBudget, false);

  // The subtree rollup already reports base. The headline and the rollup must agree on one base figure.
  const rolled = w.call('project_budget_actual', { projectId: p.project.id, includeSubprojects: true });
  assert.equal(rolled.ok, true, JSON.stringify(rolled));
  assert.equal(rolled.subtree.budgetBaseMinor, 93000);
  assert.equal(rolled.subtree.actualCostMinor, ACTUAL_BASE_MINOR);
  assert.equal(
    rolled.budgetMinor,
    rolled.subtree.budgetBaseMinor,
    'the top-level budget and the subtree base budget disagree: one side is still project currency',
  );
  assert.equal(
    rolled.remainingMinor,
    rolled.subtree.remainingBaseMinor,
    'the top-level remaining and the subtree base remaining disagree: mixed currency subtraction',
  );
});
