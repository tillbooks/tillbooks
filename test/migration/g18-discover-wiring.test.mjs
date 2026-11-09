/**
 * G18 US-G18.2 / US-G18.3, the discovery WIRING: `migration_discover_source` unpacks a zip bundle and
 * surfaces an xlsx workbook's worksheets, end to end. The pure engine pieces (`unzip`, `parseXlsx`)
 * are proven in their own suites; this proves that `discoverSource` actually USES them, which is the
 * gap the G18 part-2 build left: the members reach E00 as blobs, each classifies as if uploaded alone,
 * the bundle renders as a group, an xlsx surfaces its worksheet catalog and re-parses a chosen sheet,
 * and an xlsx is NOT torn apart as a bundle. §H-TENANT is proven with two workspaces in ONE store.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { writeZip, writeXlsx } from './zipWrite.mjs';

const run = (deps, name, input) => getAction(name).run(deps, input);
const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};

/** Upload raw bytes as an E00 blob and return its fileId. */
function uploadBytes(deps, workspaceId, name, bytes, mime = 'application/octet-stream') {
  const up = must(
    run(deps, 'files_upload', {
      workspaceId,
      filename: name,
      mime,
      contentBase64: Buffer.from(bytes).toString('base64'),
      idempotencyKey: `up-${name}-${Math.random()}`,
    }),
    `files_upload ${name}`,
  );
  return up.file.id;
}

/** A minimal two-worksheet xlsx package (inline strings, so no shared-string table is needed). */
function buildXlsx() {
  const sheetXml = (a, b, r1a, r1b) =>
    `<?xml version="1.0"?><worksheet><sheetData>` +
    `<row r="1"><c r="A1" t="inlineStr"><is><t>${a}</t></is></c><c r="B1" t="inlineStr"><is><t>${b}</t></is></c></row>` +
    `<row r="2"><c r="A2" t="inlineStr"><is><t>${r1a}</t></is></c><c r="B2" t="inlineStr"><is><t>${r1b}</t></is></c></row>` +
    `</sheetData></worksheet>`;
  return writeXlsx({
    '[Content_Types].xml': `<?xml version="1.0"?><Types/>`,
    'xl/workbook.xml':
      `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets><sheet name="Kontakte" sheetId="1" r:id="rId1"/><sheet name="Konten" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':
      `<?xml version="1.0"?><Relationships>` +
      `<Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': sheetXml('Name', 'Ort', 'Muster AG', 'Zürich'),
    'xl/worksheets/sheet2.xml': sheetXml('Konto', 'Titel', '1000', 'Kasse'),
  });
}

test('US-G18.3: a zip bundle unpacks, registers members as E00 blobs, and classifies each', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);

  const nested = writeZip([{ name: 'inner.csv', content: 'x\n1\n' }]);
  const bundle = writeZip([
    { name: 'contacts.csv', content: 'Name;Ort\nMuster AG;Bern\n', deflate: false },
    { name: 'chart.csv', content: 'Konto;Titel\n1000;Kasse\n', deflate: true },
    { name: 'beleg.pdf', content: Buffer.from('%PDF-1.4 fake beleg') },
    { name: 'nested.zip', content: nested },
  ]);
  const bundleId = uploadBytes(deps, workspaceId, 'export.zip', bundle, 'application/zip');

  const storedBefore = deps.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file WHERE workspace_id = ?').get(workspaceId).n;
  const disc = must(run(deps, 'migration_discover_source', { workspaceId, fileIds: [bundleId] }), 'discover bundle');

  // The bundle is ONE file entry, rendered as a group via members[].
  const bundleEntry = disc.files.find((f) => f.fileId === bundleId);
  assert.ok(bundleEntry, 'the bundle has its own file entry');
  assert.equal(bundleEntry.adapter, 'bundle');
  assert.equal(bundleEntry.members.length, 4, 'four members registered (the failed/nested included)');

  const byName = Object.fromEntries(bundleEntry.members.map((m) => [m.filename, m]));
  // Data members classify as if uploaded alone.
  assert.ok(byName['contacts.csv'].dataClasses.includes('contacts') || byName['contacts.csv'].rowCount === 1);
  assert.equal(byName['contacts.csv'].rowCount, 1, 'contacts.csv parsed one data row');
  assert.equal(byName['chart.csv'].rowCount, 1, 'chart.csv (deflated) parsed one data row');
  // A PDF member is a documents candidate, not an error.
  assert.deepEqual(byName['beleg.pdf'].dataClasses, ['documents']);
  // A nested zip is LISTED, one level only, never recursed.
  assert.deepEqual(byName['nested.zip'].dataClasses, ['documents']);
  assert.ok(byName['nested.zip'].warnings.includes('nested_zip_not_recursed'));

  // Each member reached E00 as its own blob (4 new stored_file rows), and inner.csv was NOT unpacked.
  const storedAfter = deps.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file WHERE workspace_id = ?').get(workspaceId).n;
  assert.equal(storedAfter - storedBefore, 4, 'exactly the four members became blobs, nothing from the nested zip');
  const innerRows = deps.store.db.prepare("SELECT COUNT(*) AS n FROM stored_file WHERE workspace_id = ? AND filename = 'inner.csv'").get(workspaceId).n;
  assert.equal(innerRows, 0, 'the nested zip was not recursed: inner.csv is not a blob');

  // Each registered member is tagged to the bundle.
  for (const m of bundleEntry.members) {
    const tags = JSON.parse(deps.store.db.prepare('SELECT tags FROM stored_file WHERE workspace_id = ? AND id = ?').get(workspaceId, m.fileId).tags);
    assert.ok(tags.includes(bundleId), `member ${m.filename} tagged to the bundle`);
  }
});

test('US-G18.3: a member that fails to inflate is a per-member source_unparseable; the rest classify', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);

  // The corrupt member is FIRST, so its deflate payload sits at a known offset (30 + name length).
  const bundle = Buffer.from(
    writeZip([
      { name: 'bad.csv', content: 'a\n1\n', deflate: true },
      { name: 'good.csv', content: 'Name;Ort\nMuster AG;Bern\n', deflate: false },
    ]),
  );
  const dataStart = 30 + 'bad.csv'.length;
  bundle[dataStart] = 0xff;
  bundle[dataStart + 1] = 0xff;
  const bundleId = uploadBytes(deps, workspaceId, 'broken.zip', bundle, 'application/zip');

  const disc = must(run(deps, 'migration_discover_source', { workspaceId, fileIds: [bundleId] }), 'discover broken bundle');

  const fail = disc.failures.find((f) => f.member === 'bad.csv');
  assert.ok(fail, 'the corrupt member is reported');
  assert.equal(fail.error, 'source_unparseable');

  const bundleEntry = disc.files.find((f) => f.fileId === bundleId);
  const good = bundleEntry.members.find((m) => m.filename === 'good.csv');
  assert.ok(good, 'the good member still classifies');
  assert.equal(good.rowCount, 1);
  // The failed member never became a blob (no bytes to store).
  const badRows = deps.store.db.prepare("SELECT COUNT(*) AS n FROM stored_file WHERE workspace_id = ? AND filename = 'bad.csv'").get(workspaceId).n;
  assert.equal(badRows, 0, 'a member that failed to inflate is not registered');
});

test('US-G18.3: an empty zip discovers as a bundle with zero members', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const bundleId = uploadBytes(deps, workspaceId, 'empty.zip', writeZip([]), 'application/zip');

  const disc = must(run(deps, 'migration_discover_source', { workspaceId, fileIds: [bundleId] }), 'discover empty zip');
  const bundleEntry = disc.files.find((f) => f.fileId === bundleId);
  assert.ok(bundleEntry, 'the empty zip is still a bundle entry');
  assert.equal(bundleEntry.adapter, 'bundle');
  assert.equal(bundleEntry.members.length, 0, 'zero members, and it says so');
});

test('US-G18.2: an xlsx surfaces its worksheet catalog and parses the first sheet by default', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const xlsxId = uploadBytes(
    deps,
    workspaceId,
    'buch.xlsx',
    buildXlsx(),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );

  const disc = must(run(deps, 'migration_discover_source', { workspaceId, fileIds: [xlsxId] }), 'discover xlsx');
  const entry = disc.files.find((f) => f.fileId === xlsxId);
  assert.ok(entry, 'the xlsx classifies');
  assert.equal(entry.adapter, 'xlsx');
  assert.deepEqual(entry.worksheets, ['Kontakte', 'Konten'], 'every worksheet is named, in workbook order');
  assert.equal(entry.worksheet, 'Kontakte', 'the first worksheet is the default');
  assert.deepEqual(entry.headers, ['Name', 'Ort'], 'the first sheet parsed');
  assert.equal(entry.rowCount, 1);
});

test('US-G18.2: a chosen non-default worksheet re-parses', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const xlsxId = uploadBytes(
    deps,
    workspaceId,
    'buch.xlsx',
    buildXlsx(),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );

  const disc = must(
    run(deps, 'migration_discover_source', { workspaceId, fileIds: [xlsxId], sheets: { [xlsxId]: 'Konten' } }),
    'discover xlsx with a sheet choice',
  );
  const entry = disc.files.find((f) => f.fileId === xlsxId);
  assert.equal(entry.worksheet, 'Konten', 'the chosen sheet is the one parsed');
  assert.deepEqual(entry.headers, ['Konto', 'Titel'], 'the chosen sheet re-parsed');
});

test('US-G18.2/3 disambiguation: an xlsx is NOT unpacked as a bundle', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const storedBefore = deps.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file WHERE workspace_id = ?').get(workspaceId).n;
  const xlsxId = uploadBytes(
    deps,
    workspaceId,
    'buch.xlsx',
    buildXlsx(),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );

  const disc = must(run(deps, 'migration_discover_source', { workspaceId, fileIds: [xlsxId] }), 'discover xlsx');
  const entry = disc.files.find((f) => f.fileId === xlsxId);
  assert.equal(entry.adapter, 'xlsx', 'the xlsx took the xlsx path, not the bundle path');
  assert.equal(entry.members, undefined, 'an xlsx has no members[]: it is not a bundle');
  // Only the xlsx blob itself exists; no OOXML part (e.g. xl/workbook.xml) was registered as a blob.
  const storedAfter = deps.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file WHERE workspace_id = ?').get(workspaceId).n;
  assert.equal(storedAfter - storedBefore, 1, 'the xlsx is one blob, not a folder of unpacked parts');
});

test('§H-TENANT BITE: a bundle fileId from workspace B cannot be discovered (or unpacked) from workspace A', () => {
  const deps = freshDeps();
  const { workspaceId: wsA } = mintWorkspace(deps, 'Alpha GmbH', 'ws-a');
  const { workspaceId: wsB } = mintWorkspace(deps, 'Beta GmbH', 'ws-b');
  assert.notEqual(wsA, wsB);

  const bundle = writeZip([{ name: 'contacts.csv', content: 'Name;Ort\nMuster AG;Bern\n' }]);
  const bundleIdB = uploadBytes(deps, wsB, 'export.zip', bundle, 'application/zip');

  const storedABefore = deps.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file WHERE workspace_id = ?').get(wsA).n;
  const disc = must(run(deps, 'migration_discover_source', { workspaceId: wsA, fileIds: [bundleIdB] }), 'cross-tenant discover call itself returns ok');

  // The foreign fileId is refused, not classified, and NOTHING was unpacked into A.
  assert.equal(disc.files.length, 0, 'no cross-tenant file classified');
  const fail = disc.failures.find((f) => f.fileId === bundleIdB);
  assert.ok(fail, 'the foreign fileId is a failure');
  assert.equal(fail.error, 'source_integrity_mismatch');
  const storedAAfter = deps.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file WHERE workspace_id = ?').get(wsA).n;
  assert.equal(storedAAfter, storedABefore, 'the refused cross-tenant call minted NO member blob in A');
});
