/**
 * Non-author critic probes, round 3 (critic/phase0-installable-r1) against the remediation at
 * `claude/phase0-installable` head 8fa9e452. Defects are written as the CORRECT behaviour and marked
 * `todo`; the rest pin what this round verified. All values are synthetic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};

const IBAN_A = 'CH9300762011623852957';
const IBAN_B = 'CH5604835012345678009';

function book(seed, deps = freshDeps()) {
  deps.actor = 'studio';
  deps.backupDir = mkdtempSync(join(tmpdir(), `till-r3-${seed}-`));
  const { workspaceId } = mintWorkspace(deps, 'Beispiel GmbH', `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const vendor = (name, key) => {
    const v = must(call('create_contact', { partyRole: 'vendor', name, idempotencyKey: key }), `vendor ${key}`);
    return v.contactId ?? v.contact?.id;
  };
  return { deps, workspaceId, call, vendor, agent: { ...deps, actor: 'agent' } };
}

// --- (5) payloadLabels ----------------------------------------------------------------------------

test('r3 (5): payloadLabels is tenant-scoped and additive: another workspace\'s contact name never shows, the replayed payload is unchanged', () => {
  const deps = freshDeps();
  const a = book('lab-a', deps);
  const b = book('lab-b', deps);
  const own = a.vendor('Lieferant Eigen AG', 'va');
  const foreign = b.vendor('Geheim Fremd AG', 'vb');
  must(a.call('set_creditor_bank_profile', { vendorId: own, iban: IBAN_A, idempotencyKey: 'h-a' }), 'human sets A');

  const d1 = handleRest('set_creditor_bank_profile', { workspaceId: a.workspaceId, vendorId: own, iban: IBAN_B, idempotencyKey: 'ag-1' }, a.agent).body;
  assert.equal(d1.drafted, true, JSON.stringify(d1));
  // A draft naming ANOTHER workspace's contact id: the gate may draft it (the verb refuses at replay),
  // but the card must not learn the foreign name.
  const d2 = handleRest('set_creditor_bank_profile', { workspaceId: a.workspaceId, vendorId: foreign, iban: IBAN_B, idempotencyKey: 'ag-2' }, a.agent).body;

  const listed = must(a.call('list_drafted_actions', {}), 'list').actions;
  const mine = listed.find((x) => x.payload.idempotencyKey === 'ag-1');
  assert.equal(mine.payloadLabels.vendorId, 'Lieferant Eigen AG');
  assert.equal(mine.payload.vendorId, own, 'the payload still carries the id the approval replays');
  assert.equal('payloadLabels' in mine.payload, false);
  const other = listed.find((x) => x.payload.idempotencyKey === 'ag-2');
  if (other !== undefined) assert.equal(other.payloadLabels.vendorId, undefined, 'no foreign name leaks');
  assert.doesNotMatch(JSON.stringify(listed), /Geheim Fremd/);
  assert.ok(d2.drafted === true || d2.ok === false);

  // Approval replays the stored payload: the vendor's IBAN changes, nothing else.
  must(a.call('approve_drafted_action', { actionId: d1.actionId }), 'approve');
  const stored = deps.store.db.prepare('SELECT iban FROM creditor_bank_profile WHERE workspace_id = ? AND contact_id = ?').get(a.workspaceId, own);
  assert.equal(stored.iban, IBAN_B);
});

test('r3 (5) advisory, pinned: the label is the vendor\'s CURRENT name, which the agent seat may rename without a human', () => {
  const w = book('spoof');
  const real = w.vendor('Hauptlieferant AG', 'v-real');
  must(w.call('set_creditor_bank_profile', { vendorId: real, iban: IBAN_A, idempotencyKey: 'h-real' }), 'human sets');
  const draft = handleRest('set_creditor_bank_profile', { workspaceId: w.workspaceId, vendorId: real, iban: IBAN_B, idempotencyKey: 'ag-real' }, w.agent).body;
  assert.equal(draft.drafted, true);
  const renamed = handleRest('update_contact', { workspaceId: w.workspaceId, contactId: real, patch: { name: 'Testlieferant (Demo)' } }, w.agent).body;
  assert.equal(renamed.ok, true, 'update_contact is not dial-governed');
  const card = must(w.call('list_drafted_actions', {}), 'list').actions.find((x) => x.actionId === draft.actionId);
  assert.equal(card.payloadLabels.vendorId, 'Testlieferant (Demo)', 'the approver reads the name the agent chose');
});

// --- (2) one rule set: a remaining path that stores what the QR-bill refuses -------------------------

test(
  'r3 R3-1: a migration contacts step whose preview is clean also commits (the preview runs the QR value rules the commit now enforces)',
  { todo: 'LOW: previewStep (src/core/migration/steps.ts:200) checks only a non-empty name and trialLoadStep (:309) reports every row created, while commitStep imports through importContacts -> createContact, which now refuses a name over 70 characters (or a non-alpha-2 country) for the WHOLE file' },
  () => {
    const w = book('mig');
    const long = `Wohnbaugenossenschaft ${'Seeblick und Sonnenhalde '.repeat(3)}Männedorf`;
    assert.ok(long.length > 70);
    const csv = `name,email\n"${long}",info@beispiel.invalid\nKurz AG,kurz@beispiel.invalid\n`;
    const fileId = must(w.call('files_upload', { title: 'Kontakte', filename: 'kontakte.csv', mime: 'text/csv', contentBase64: Buffer.from(csv).toString('base64'), idempotencyKey: 'mig-up' }), 'upload').file.id;
    const planId = must(w.call('migration_create_plan', { sourceSystem: 'csv', cutoverDate: '2026-06-30', localePack: 'ch', idempotencyKey: 'mig-plan' }), 'plan').planId;
    must(w.call('migration_discover_source', { fileIds: [fileId], planId }), 'discover');
    w.deps.store.db.prepare("UPDATE migration_source_file SET data_classes = '[\"contacts\"]' WHERE plan_id = ?").run(planId);
    const scope = must(w.call('migration_set_scope', { planId, classes: [{ dataClass: 'contacts', include: true }], idempotencyKey: 'mig-scope' }), 'scope');
    const stepId = scope.steps.find((s) => s.dataClass === 'contacts').stepId;
    const preview = must(w.call('migration_preview_step', { planId, stepId }), 'preview');
    const previewClean = (preview.errors ?? preview.preview?.errors ?? []).length === 0;
    const trial = w.call('migration_trial_load_step', { planId, stepId, idempotencyKey: 'mig-trial' });
    const commit = w.call('migration_commit_step', { planId, stepId, idempotencyKey: 'mig-commit' });
    // Either the preview names the row, or the commit succeeds; a clean preview followed by a refused
    // whole step is the defect.
    assert.ok(!previewClean || commit.ok === true, `preview clean, then trial=${JSON.stringify(trial).slice(0, 160)} commit=${JSON.stringify(commit).slice(0, 200)}`);
  },
);
