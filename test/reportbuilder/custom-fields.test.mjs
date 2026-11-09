/**
 * F01 §6b: G00 extends F01 rather than F01 growing a second reporting system. A custom field defined
 * via G00's `defineField` on a source's entity kind (here `contact`) appears automatically as a
 * `cf:<key>` column in `reports_sources`/`reports_preview` and renders its stored value, with ZERO
 * F01 code change. And an OR 958f retention link (retain) on an accounting-record source files the
 * artifact into E00 and stores the document link.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

function caller(deps, workspaceId) {
  return (name, input = {}) => getAction(name).run(deps, { workspaceId, ...input });
}

test('F01 cf: a G00 custom field on contact becomes a selectable, renderable report column', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'CF GmbH', 'cf-ws');
  const call = caller(deps, workspaceId);

  const c = call('create_contact', { partyRole: 'customer', name: 'Segment AG', idempotencyKey: 'cf-c1' });
  const def = call('define_field', {
    entityKind: 'contact',
    key: 'segment',
    labelI18n: { 'de-CH': 'Segment', en: 'Segment' },
    type: 'select',
    options: ['Gross', 'Klein'],
    idempotencyKey: 'cf-def',
  });
  assert.equal(def.ok, true, JSON.stringify(def));
  // A field authored by a non-studio actor lands as a P8 draft; confirm it so it is live and a report
  // may compose it (a draft field must not silently appear in an export).
  if (def.fieldDef.draft) {
    call('confirm_field', { fieldDefId: def.fieldDef.fieldDefId, idempotencyKey: 'cf-conf' });
  }
  call('set_field_value', { entityKind: 'contact', entityId: c.contact.id, fieldKey: 'segment', value: 'Gross', idempotencyKey: 'cf-val' });

  // The column appears in the source registry the moment the field is defined, no F01 change.
  const sources = call('reports_sources', {}).sources.find((s) => s.id === 'contacts');
  const cfCol = sources.columns.find((col) => col.key === 'cf:segment');
  assert.ok(cfCol, 'cf:segment is published on the contacts source');
  assert.equal(cfCol.custom, true);

  // A preview projects the stored value for the row that has it.
  const preview = call('reports_preview', { source: 'contacts', columns: ['name', 'cf:segment'] });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const row = preview.rows.find((r) => r.name === 'Segment AG');
  assert.equal(row['cf:segment'], 'Gross', 'the custom field value renders in the report');

  // And it filters exactly like a base column.
  const filtered = call('reports_preview', {
    source: 'contacts',
    columns: ['name', 'cf:segment'],
    filters: [{ field: 'cf:segment', op: 'eq', value: 'Gross' }],
  });
  assert.equal(filtered.rowCount, 1);
});

test('F01 retain: an accounting-record run files its artifact into E00 and stores the link', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Retain GmbH', 'ret-ws');
  const call = caller(deps, workspaceId);

  const saved = call('reports_save', {
    name: 'Offene Debitoren',
    source: 'ar_open_items', // accounting_record: true
    columns: ['customerName', 'openMinor'],
    format: 'pdf',
    idempotencyKey: 'ret-save',
  });
  assert.equal(saved.ok, true, JSON.stringify(saved));

  const run = call('reports_run', { reportId: saved.report.id, retain: true, idempotencyKey: 'ret-run' });
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(run.retained, true, 'an accounting-record source retains when asked');
  assert.ok(typeof run.documentId === 'string' && run.documentId.length > 0, 'the E00 file link is stored');

  // The artifact is a real PDF.
  const pdf = Buffer.from(run.contentBase64, 'base64');
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-', 'the retained artifact is a valid PDF');

  // A non-accounting source does NOT retain even when asked.
  const nonRec = call('reports_save', { name: 'Kontakte', source: 'contacts', columns: ['name'], idempotencyKey: 'ret-nonrec-save' });
  const nonRun = call('reports_run', { reportId: nonRec.report.id, retain: true, idempotencyKey: 'ret-nonrec-run' });
  assert.equal(nonRun.retained, false, 'a non-accounting source never retains');
  assert.equal(nonRun.documentId, null);
});
