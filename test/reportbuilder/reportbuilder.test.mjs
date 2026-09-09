/**
 * F01, report builder: the disciplined engine tests.
 *
 * The load-bearing ones the build rule (CLAUDE.md, "the money path is unforgiving" and the F01 brief)
 * demands even though F01 posts nothing:
 *  - EXPORT FIDELITY: a rendered report's figures EQUAL the source read verb's own answer for the same
 *    filter (anti-drift). A report faithful to its source or it is a bug.
 *  - §H-TENANT: a report can never read, run, or mutate another tenant's rows.
 *  - TX-ATOMICITY: a REFUSED save/schedule writes ZERO rows (the C02/D03 bug class).
 *  - §H-IDEMPOTENT: re-running the same key returns the original artifact and writes one run row.
 *
 * All offline against a fresh in-memory store, through the real registry boundary.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { makeContext } from '../../dist/core/context.js';
import { reportsPreview } from '../../dist/core/reportbuilder/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

function caller(deps, workspaceId) {
  return (name, input = {}) => getAction(name).run(deps, { workspaceId, ...input });
}

function seededContacts(call) {
  const names = [
    ['Alpha AG', 'alpha@example.ch'],
    ['Bravo GmbH', 'bravo@example.ch'],
    ['Zürich Zünd, "Söhne"', 'zuend@example.ch'], // umlauts + comma + quote for CSV escaping
  ];
  names.forEach(([name, email], i) =>
    call('create_contact', { partyRole: 'customer', name, email, idempotencyKey: `c-${i}` }),
  );
}

/** Decode a run's CSV artifact: strip the BOM, split RFC-4180 records, parse quoted fields. */
function parseCsv(base64) {
  const text = Buffer.from(base64, 'base64').toString('utf8').replace(/^﻿/, '');
  const records = text.replace(/\r\n$/, '').split('\r\n');
  return records.map((line) => {
    const cells = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return cells;
  });
}

test('F01 export fidelity: a run\'s rendered rows EQUAL the source read verb\'s own answer', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Fidelity GmbH', 'fid-ws');
  const call = caller(deps, workspaceId);
  seededContacts(call);

  const saved = call('reports_save', {
    name: 'Kontaktliste',
    source: 'contacts',
    columns: ['name', 'email'],
    idempotencyKey: 'fid-save',
  });
  assert.equal(saved.ok, true, JSON.stringify(saved));

  const run = call('reports_run', { reportId: saved.report.id, idempotencyKey: 'fid-run' });
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(run.transmitted, false);

  const rows = parseCsv(run.contentBase64);
  assert.deepEqual(rows[0], ['name', 'email'], 'CSV header is the machine-neutral column keys');

  // The source's OWN answer for the same (empty) filter, ordered exactly as the source orders it.
  const source = call('list_contacts', {}).contacts;
  const expected = source.map((c) => [c.name, c.email ?? '']);
  assert.deepEqual(rows.slice(1), expected, 'the report renders exactly what list_contacts computes');
  assert.equal(run.rowCount, source.length);
});

test('F01 CSV escaping round-trips delimiters, quotes and umlauts, with a UTF-8 BOM', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'CSV GmbH', 'csv-ws');
  const call = caller(deps, workspaceId);
  seededContacts(call);

  const saved = call('reports_save', { name: 'CSV', source: 'contacts', columns: ['name'], idempotencyKey: 'csv-save' });
  const run = call('reports_run', { reportId: saved.report.id, idempotencyKey: 'csv-run' });
  const bytes = Buffer.from(run.contentBase64, 'base64');
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'the CSV starts with a UTF-8 BOM');

  const rows = parseCsv(run.contentBase64);
  const names = rows.slice(1).map((r) => r[0]);
  assert.ok(names.includes('Zürich Zünd, "Söhne"'), 'a name with a comma, a quote and umlauts round-trips exactly');
});

test('F01 §H-TENANT: a report is invisible and un-runnable from another workspace', () => {
  const deps = freshDeps();
  const a = mintWorkspace(deps, 'Tenant A', 'ten-a');
  const b = mintWorkspace(deps, 'Tenant B', 'ten-b');
  const callA = caller(deps, a.workspaceId);
  const callB = caller(deps, b.workspaceId);

  const saved = callA('reports_save', { name: 'A only', source: 'contacts', columns: ['name'], idempotencyKey: 'ten-save' });
  assert.equal(saved.ok, true);

  // B cannot see A's report in its own list, and cannot run, read history, or delete it by id.
  assert.deepEqual(callB('reports_list', {}).reports, []);
  assert.equal(callB('reports_run', { reportId: saved.report.id, idempotencyKey: 'ten-run' }).error, 'report_not_found');
  assert.equal(callB('reports_runs', { reportId: saved.report.id }).error, 'report_not_found');
  assert.equal(callB('reports_delete', { reportId: saved.report.id, idempotencyKey: 'ten-del' }).error, 'report_not_found');
  // A still holds it untouched.
  assert.equal(callA('reports_list', {}).reports.length, 1);
});

test('F01 source RBAC: a caller lacking the source read gate is refused in-engine', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'RBAC GmbH', 'rbac-ws');
  // A context that denies read_master_data (contacts' source gate) but allows everything else.
  const ctx = makeContext(deps.store, {
    workspaceId,
    actor: 'restricted',
    capabilities: { assert: (cap) => (cap === 'read_master_data' ? { ok: false } : { ok: true }) },
  });
  const res = reportsPreview(ctx, { source: 'contacts', columns: ['name'] });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'permission_denied');
  assert.equal(res.capability, 'read_master_data', 'the refusal names the source\'s own gate, not an F01 capability');
});

test('F01 TX-ATOMICITY: a REFUSED save writes ZERO rows', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Atom GmbH', 'atom-ws');
  const call = caller(deps, workspaceId);

  const empty = call('reports_save', { name: 'Leer', source: 'contacts', columns: [], idempotencyKey: 'atom-empty' });
  assert.equal(empty.error, 'columns_empty');
  const badField = call('reports_save', { name: 'Falsch', source: 'contacts', columns: ['name'], filters: [{ field: 'nope', op: 'eq', value: 'x' }], idempotencyKey: 'atom-bad' });
  assert.equal(badField.error, 'invalid_filter_field');
  const badSource = call('reports_save', { name: 'X', source: 'ghost', columns: ['name'], idempotencyKey: 'atom-src' });
  assert.equal(badSource.error, 'unknown_source');

  const count = deps.store.db.prepare('SELECT COUNT(*) AS n FROM saved_reports WHERE workspace_id = ?').get(workspaceId).n;
  assert.equal(count, 0, 'not one refused save left a row behind');
});

test('F01 TX-ATOMICITY: a REFUSED schedule writes ZERO schedule state', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Sched GmbH', 'sch-ws');
  const call = caller(deps, workspaceId);
  const saved = call('reports_save', { name: 'S', source: 'contacts', columns: ['name'], idempotencyKey: 'sch-save' });

  const bad = call('reports_schedule', { reportId: saved.report.id, schedule: { freq: 'yearly', at: '25:00' }, idempotencyKey: 'sch-bad' });
  assert.equal(bad.error, 'invalid_schedule');
  const row = deps.store.db.prepare('SELECT schedule FROM saved_reports WHERE workspace_id = ? AND id = ?').get(workspaceId, saved.report.id);
  assert.equal(row.schedule, null, 'the refused schedule left the report unscheduled');
});

test('F01 §H-IDEMPOTENT: re-running the same key returns the original artifact and one run row', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Idem GmbH', 'idem-ws');
  const call = caller(deps, workspaceId);
  seededContacts(call);
  const saved = call('reports_save', { name: 'I', source: 'contacts', columns: ['name'], idempotencyKey: 'idem-save' });

  const first = call('reports_run', { reportId: saved.report.id, idempotencyKey: 'idem-run' });
  const second = call('reports_run', { reportId: saved.report.id, idempotencyKey: 'idem-run' });
  assert.equal(first.ok, true);
  assert.equal(second.artifactRef, first.artifactRef, 'the replay returns the original artifact ref');
  assert.equal(second.contentBase64, first.contentBase64, 'byte-identical artifact');

  const runs = deps.store.db.prepare('SELECT COUNT(*) AS n FROM report_runs WHERE workspace_id = ? AND report_id = ?').get(workspaceId, saved.report.id).n;
  assert.equal(runs, 1, 'the replay wrote no second run row');
});

test('F01 empty result: a filter matching nothing is a valid ok run (row_count 0, header-only CSV)', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Empty GmbH', 'empty-ws');
  const call = caller(deps, workspaceId);
  seededContacts(call);
  const saved = call('reports_save', {
    name: 'Nichts',
    source: 'contacts',
    columns: ['name'],
    filters: [{ field: 'name', op: 'eq', value: 'Niemand der existiert' }],
    idempotencyKey: 'empty-save',
  });
  const run = call('reports_run', { reportId: saved.report.id, idempotencyKey: 'empty-run' });
  assert.equal(run.ok, true);
  assert.equal(run.rowCount, 0, 'an empty period is a valid, auditable result, not an error');
  const rows = parseCsv(run.contentBase64);
  assert.equal(rows.length, 1, 'a header row and nothing else');
});

test('F01 duplicate drops the schedule and recipients; delete removes definition and history', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Dup GmbH', 'dup-ws');
  const call = caller(deps, workspaceId);
  const saved = call('reports_save', { name: 'Original', source: 'contacts', columns: ['name'], idempotencyKey: 'dup-save' });
  call('reports_schedule', {
    reportId: saved.report.id,
    schedule: { freq: 'weekly', at: '09:00', weekday: 1 },
    recipients: ['kunde@example.ch'],
    idempotencyKey: 'dup-sched',
  });
  call('reports_run', { reportId: saved.report.id, idempotencyKey: 'dup-run' });

  const copy = call('reports_duplicate', { reportId: saved.report.id, idempotencyKey: 'dup-dup' });
  assert.equal(copy.ok, true);
  assert.equal(copy.report.schedule, null, 'the copy carries no schedule');
  assert.deepEqual(copy.report.recipients, [], 'the copy carries no recipients');
  assert.match(copy.report.name, /\(Kopie\)$/);
  // The copy has no run history of its own.
  assert.deepEqual(call('reports_runs', { reportId: copy.report.id }).runs, []);

  // Delete the original: its definition and its one run row are gone; the copy survives.
  const del = call('reports_delete', { reportId: saved.report.id, idempotencyKey: 'dup-del' });
  assert.equal(del.ok, true);
  assert.equal(call('reports_runs', { reportId: saved.report.id }).error, 'report_not_found');
  const orphanRuns = deps.store.db.prepare('SELECT COUNT(*) AS n FROM report_runs WHERE workspace_id = ? AND report_id = ?').get(workspaceId, saved.report.id).n;
  assert.equal(orphanRuns, 0, 'the run history went with the definition');
  assert.equal(call('reports_list', {}).reports.length, 1, 'the copy remains');
});

test('F01 schedule delivery stays cloud-tier in the OSS core; clearing it keeps the report', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Cloud GmbH', 'cloud-ws');
  const call = caller(deps, workspaceId);
  const saved = call('reports_save', { name: 'Zeitplan', source: 'contacts', columns: ['name'], idempotencyKey: 'cl-save' });

  const scheduled = call('reports_schedule', {
    reportId: saved.report.id,
    schedule: { freq: 'monthly', at: '06:30', dayOfMonth: 1 },
    recipients: ['treuhand@example.ch'],
    idempotencyKey: 'cl-sched',
  });
  assert.equal(scheduled.ok, true);
  assert.equal(scheduled.delivery.active, false, 'the OSS core never activates delivery on its own');
  assert.equal(scheduled.delivery.reason, 'cloud_tier');
  assert.equal(scheduled.report.deliveryActive, false);

  const cleared = call('reports_schedule', { reportId: saved.report.id, schedule: null, idempotencyKey: 'cl-clear' });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.report.schedule, null, 'clearing the schedule keeps the report and drops the cadence');
});
