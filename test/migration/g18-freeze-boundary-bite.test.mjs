/**
 * BITE PROBE for the R2 freeze boundary. The author's R2 test uses Stichtag 2024-07-01, whose month
 * is the FIRST month of its quarter, so the `< stichtagMonth` vs `<= stichtagMonth` boundary is
 * indistinguishable there (Aug/Sep still exceed it). This probe uses a Stichtag in the LAST month of
 * a quarter (2024-09-15), where the boundary genuinely decides whether the Stichtag's OWN quarter is
 * sealed. With the correct `<` it stays unsealed; a `<=` regression seals it and this probe FAILS.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const must = (res, what) => { assert.equal(res.ok, true, `${what}: ${JSON.stringify(res)}`); return res; };

function world(seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  deps.backupDir = mkdtempSync(join(tmpdir(), `till-bite-${seed}-`));
  const { workspaceId } = mintWorkspace(deps, 'Quelle GmbH', `${seed}-ws`);
  return { deps, call: (name, input) => getAction(name).run(deps, { workspaceId, ...input }) };
}

test('BITE: a Stichtag in the LAST month of a quarter leaves that quarter (the opening-entry period) unsealed', () => {
  const { deps, call } = world('bite');
  const planId = must(call('migration_create_plan', { sourceSystem: 'csv', cutoverDate: '2024-09-15', localePack: 'ch', idempotencyKey: 'bite-plan' }), 'plan').planId;
  const tId = must(call('migration_create_testmandant', { planId, idempotencyKey: 'bite-t' }), 't').workspaceId;
  must(call('update_company_profile', { workspaceId: tId, legalForm: 'gmbh', uid: 'CHE-116.281.271', mwstNo: 'CHE-116.281.271 MWST' }), 'profile');
  must(call('vat_configure', { workspaceId: tId, method: 'effektiv', timing: 'soll', registered: true, asOf: '2023-01-01', vatNumber: 'CHE-116.281.271 MWST', idempotencyKey: 'bite-cfg' }), 'cfg');
  const name = must(call('get_company_profile', { workspaceId: tId }), 'get').profile.name;

  const promoted = must(call('go_productive', { planId, confirmedName: name, idempotencyKey: 'bite-go' }), 'promote');
  const frozen = new Set(promoted.frozenPeriods);
  // 2024-Q3 = [Jul,Aug,Sep] contains the Stichtag month (Sep). It must NOT be frozen: the opening
  // entry dated 2024-09-15 lives in Sep. A `<=` boundary would seal Sep and the opening entry's period.
  assert.ok(!frozen.has('2024-Q3'), '2024-Q3 contains the Stichtag month and must stay unsealed');
  const sealed = new Set(deps.store.db.prepare("SELECT period FROM period_lock WHERE workspace_id = ? AND reason = 'vat_filed'").all(tId).map((r) => r.period));
  assert.ok(!sealed.has('2024-09'), 'September 2024 (the Stichtag/opening-entry month) is NOT sealed');
  // And the belt-and-braces: 2024-Q2 (wholly before) IS frozen, so the probe is non-vacuous.
  assert.ok(frozen.has('2024-Q2'), '2024-Q2 is wholly before the Stichtag and IS frozen (probe non-vacuous)');
});
