// A34 export, privacy (AHV), and read-model behaviour.
//
//   - the export is gated on hr.manage; AHV inclusion is CAPABILITY-derived (hr.sensitive), and its
//     absence is stated in the artifact, never silent (revDSG Art. 6, the E02 says-so rule)
//   - the AHV property (tripwire 1): NO produced artifact carries an AHV number unless the actor held
//     hr.sensitive, and every AHV-less artifact names the omission
//   - the stored artifact's READ-BACK is gated exactly like the employee data it holds (E00 seam)
//   - first export = full master, empty mutations; a later export counts only what changed
//   - the export is idempotent on ROWS; no_employees and forbidden refuse cleanly
//   - list_payroll_handoffs returns the typed export/posting union

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { payrollHandoffExport, wageJournalPost, listPayrollHandoffs } from '../../dist/core/payroll/index.js';
import { getFileContent } from '../../dist/core/files/index.js';
import { upsertEmployee } from '../../dist/core/hr/index.js';
import { setup, addEmployee, capCtx, counts, wageLines, fixedClock } from './support.mjs';

const AHV = '756.1234.5678.97';

function artifactJson(ctx, fileId) {
  const content = getFileContent(ctx, { fileId });
  assert.equal(content.ok, true, `getFileContent failed: ${JSON.stringify(content)}`);
  return JSON.parse(Buffer.from(content.contentBase64, 'base64').toString('utf8'));
}

test('A34: export WITH hr.sensitive includes AHV; the record and artifact both say so', () => {
  const t = setup();
  addEmployee(t.ctx, { ahvNr: AHV }, 'e1');
  const mgr = capCtx(t, 'mgr', ['hr.manage', 'hr.sensitive']);

  const res = payrollHandoffExport(mgr, { format: 'json', idempotencyKey: 'exp-1' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.ahvIncluded, true);
  assert.equal(res.employeeCount, 1);
  assert.equal(res.mutationCount, 0, 'the first export has an empty mutations section');

  const doc = artifactJson(mgr, res.artifactDocumentId);
  assert.equal(doc.header.ahvIncluded, true);
  assert.equal(doc.employees[0].ahvNr, AHV, 'the raw AHV number is in the artifact');
  assert.ok(doc.header.firstExport, 'the first export declares itself');
});

test('A34 tripwire 1: export WITHOUT hr.sensitive omits AHV and NAMES the omission (never silent)', () => {
  const t = setup();
  addEmployee(t.ctx, { ahvNr: AHV }, 'e1');
  const clerk = capCtx(t, 'clerk', ['hr.manage']); // no hr.sensitive

  const res = payrollHandoffExport(clerk, { format: 'json', idempotencyKey: 'exp-2' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.ahvIncluded, false);
  assert.equal(res.ahvExcludedReason, 'missing_hr_sensitive');

  const doc = artifactJson(clerk, res.artifactDocumentId);
  assert.equal(doc.header.ahvIncluded, false);
  assert.equal(doc.header.ahvExcludedReason, 'missing_hr_sensitive', 'the artifact header names WHY AHV is absent');
  assert.equal(doc.employees[0].ahvNr, undefined, 'no AHV column exists in the artifact');
  // The bytes carry no trace of the number, not even masked.
  const raw = Buffer.from(getFileContent(clerk, { fileId: res.artifactDocumentId }).contentBase64, 'base64').toString('utf8');
  assert.equal(raw.includes('756.1234'), false, 'the AHV digits appear nowhere in the artifact');
});

test('A34 tripwire 1 (property): across the actor matrix, AHV is present IFF the actor held hr.sensitive', () => {
  for (const grants of [['hr.manage', 'hr.sensitive'], ['hr.manage']]) {
    const t = setup();
    addEmployee(t.ctx, { ahvNr: AHV }, 'e1');
    const actor = capCtx(t, 'a', grants);
    const res = payrollHandoffExport(actor, { format: 'json', idempotencyKey: 'exp-m' });
    assert.equal(res.ok, true, JSON.stringify(res));
    const raw = Buffer.from(getFileContent(actor, { fileId: res.artifactDocumentId }).contentBase64, 'base64').toString('utf8');
    const hasAhv = raw.includes('756.1234.5678.97');
    assert.equal(hasAhv, grants.includes('hr.sensitive'), `AHV presence must equal hr.sensitive for grants ${grants}`);
    if (!hasAhv) assert.ok(raw.includes('missing_hr_sensitive'), 'an AHV-less artifact must name the omission');
  }
});

test('A34 E00 seam: reading a payroll_handoff artifact is gated like the employee data it holds', () => {
  const t = setup();
  addEmployee(t.ctx, { ahvNr: AHV }, 'e1');

  // Exported WITH AHV: read-back needs hr.manage AND hr.sensitive.
  const mgr = capCtx(t, 'mgr', ['hr.manage', 'hr.sensitive']);
  const withAhv = payrollHandoffExport(mgr, { format: 'json', idempotencyKey: 'exp-a' });
  assert.equal(withAhv.ok, true, JSON.stringify(withAhv));
  const fid = withAhv.artifactDocumentId;

  assert.equal(getFileContent(mgr, { fileId: fid }).ok, true, 'the sensitive holder reads it');
  const noSensitive = getFileContent(capCtx(t, 'clerk', ['hr.manage']), { fileId: fid });
  assert.equal(noSensitive.ok, false);
  assert.equal(noSensitive.error, 'forbidden');
  assert.equal(noSensitive.capability, 'hr.sensitive', 'an AHV artifact needs hr.sensitive to read back');
  const noManage = getFileContent(capCtx(t, 'reader', ['hr.read']), { fileId: fid });
  assert.equal(noManage.error, 'forbidden');
  assert.equal(noManage.capability, 'hr.manage', 'a payroll_handoff document needs hr.manage to read back');

  // Exported WITHOUT AHV: hr.manage alone reads it back (no sensitive gate).
  const clerk = capCtx(t, 'clerk', ['hr.manage']);
  const noAhv = payrollHandoffExport(clerk, { format: 'json', idempotencyKey: 'exp-b' });
  assert.equal(getFileContent(clerk, { fileId: noAhv.artifactDocumentId }).ok, true, 'a no-AHV artifact reads back on hr.manage alone');
});

test('A34: mutations are computed against the previous export; a change since is counted, an unchanged roster is not', () => {
  const t = setup();
  const { employeeId } = addEmployee(t.ctx, { ahvNr: AHV }, 'e1');
  const mgr = capCtx(t, 'mgr', ['hr.manage', 'hr.sensitive']);

  const first = payrollHandoffExport(mgr, { format: 'json', idempotencyKey: 'exp-1' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.mutationCount, 0);

  // A re-run with NOTHING changed reports zero mutations, honestly.
  const laterSame = capCtx(t, 'mgr', ['hr.manage', 'hr.sensitive'], { clock: fixedClock('2026-07-20T00:00:00.000Z') });
  const second = payrollHandoffExport(laterSame, { format: 'json', idempotencyKey: 'exp-2' });
  assert.equal(second.mutationCount, 0, 'no change since the last export -> mutationCount 0');

  // Change the employee on a later day, then export again: exactly one mutation.
  const change = upsertEmployee(t.at('2026-08-01T00:00:00.000Z'), { employee: { id: employeeId, firstName: 'Alexandra' }, idempotencyKey: 'chg' });
  assert.equal(change.ok, true, JSON.stringify(change));
  const third = payrollHandoffExport(
    capCtx(t, 'mgr', ['hr.manage', 'hr.sensitive'], { clock: fixedClock('2026-08-02T00:00:00.000Z') }),
    { format: 'json', idempotencyKey: 'exp-3' },
  );
  assert.equal(third.mutationCount, 1, 'the changed employee is the one mutation');
  assert.equal(third.previousExportId, second.exportId, 'the export chains to its predecessor');
  const doc = artifactJson(capCtx(t, 'mgr', ['hr.manage', 'hr.sensitive']), third.artifactDocumentId);
  assert.equal(doc.mutations.length, 1);
  assert.equal(doc.mutations[0].firstName, 'Alexandra');
});

test('A34: the export is idempotent on ROWS (same key -> one export, one file)', () => {
  const t = setup();
  addEmployee(t.ctx, { ahvNr: AHV }, 'e1');
  const mgr = capCtx(t, 'mgr', ['hr.manage', 'hr.sensitive']);
  const before = counts(t.store, t.workspaceId);

  const a = payrollHandoffExport(mgr, { format: 'json', idempotencyKey: 'exp-dup' });
  const mid = counts(t.store, t.workspaceId);
  const b = payrollHandoffExport(mgr, { format: 'json', idempotencyKey: 'exp-dup' });
  assert.equal(a.exportId, b.exportId, 'the replay returns the original export record');
  assert.equal(a.artifactDocumentId, b.artifactDocumentId, 'and the original artifact');
  const after = counts(t.store, t.workspaceId);
  assert.equal(after.exports, mid.exports, 'no second export row');
  assert.equal(after.files, mid.files, 'no second artifact file');
  assert.equal(mid.exports, before.exports + 1);
});

test('A34: no_employees and forbidden refuse cleanly (nothing written)', () => {
  const t = setup();
  const mgr = capCtx(t, 'mgr', ['hr.manage', 'hr.sensitive']);
  const empty = payrollHandoffExport(mgr, { format: 'json', idempotencyKey: 'exp-empty' });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'no_employees');

  addEmployee(t.ctx, {}, 'e1');
  const reader = capCtx(t, 'reader', ['hr.read']); // no hr.manage
  const forbidden = payrollHandoffExport(reader, { format: 'json', idempotencyKey: 'exp-f' });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.error, 'forbidden');
  assert.equal(counts(t.store, t.workspaceId).exports, 0, 'nothing was written');
});

test('A34: list_payroll_handoffs returns the typed export/posting union, newest first', () => {
  const t = setup();
  addEmployee(t.ctx, { ahvNr: AHV }, 'e1');
  const mgr = capCtx(t, 'mgr', ['hr.manage', 'hr.sensitive']);
  payrollHandoffExport(mgr, { format: 'json', idempotencyKey: 'exp-1' });
  wageJournalPost(t.ctx, { lines: wageLines(), entryDate: '2026-07-05', confirm: true, idempotencyKey: 'wjp-1' });

  const list = listPayrollHandoffs(t.ctx, {});
  assert.equal(list.ok, true, JSON.stringify(list));
  assert.equal(list.total, 2);
  const types = list.handoffs.map((r) => r.type).sort();
  assert.deepEqual(types, ['export', 'posting']);
  const posting = list.handoffs.find((r) => r.type === 'posting');
  assert.ok(posting.postedEntryId, 'the posting row carries the posted entry id');
  const exp = list.handoffs.find((r) => r.type === 'export');
  assert.equal(exp.ahvIncluded, true);
  assert.ok(exp.artifactDocumentId, 'the export row carries the artifact link');
});
