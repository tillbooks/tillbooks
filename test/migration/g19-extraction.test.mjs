/**
 * G19, the extraction companion core: the guide registry, the export-completeness manifest and the
 * five MCP verbs. Offline, against a fresh in-memory store.
 *
 * The invariant assertions (spec §7): every guide item names a valid rung and at least one data
 * class or statutory:true; the bexio guide covers all 16 PHASE1 rows and 4 module questions (a
 * fixture diff so the seed cannot silently shrink); the guides import no socket and no node:fs; the
 * letter template renders with the revDSG Art. 28 limits paragraph present (so the overclaim cannot
 * ship by edit); hasCompanion is false for every guide (no gate-clearance recorded); completeness
 * excludes not_used; cross-workspace fileIds and inverted date ranges refuse.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getAction } from '../../dist/api/registry.js';
import {
  EXTRACTION_GUIDES,
  extractionGuideDef,
  guideHasCompanion,
  guideItemIsWellFormed,
  deadlineOf,
  DATENHERAUSGABE_LETTER,
} from '../../dist/core/migration/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};
const refuse = (res, error, what) => {
  assert.equal(res.ok, false, `${what} should have refused: ${JSON.stringify(res)}`);
  assert.equal(res.error, error, `${what} wrong error: ${JSON.stringify(res)}`);
  return res;
};

function world(seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Quelle GmbH', `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  return { deps, wid: workspaceId, call };
}

function uploadFile(call, seed) {
  return must(
    call('files_upload', {
      filename: `${seed}.csv`,
      mime: 'text/csv',
      contentBase64: Buffer.from('a,b\n1,2\n', 'utf8').toString('base64'),
      idempotencyKey: `${seed}-file`,
    }),
    'files_upload',
  ).file.id;
}

// --- The guide registry -------------------------------------------------------------------------

test('G19: generic and bexio guides ship, and every item is well-formed', () => {
  const ids = EXTRACTION_GUIDES.map((g) => g.sourceSystem);
  assert.ok(ids.includes('generic'), 'the generic fallback guide ships');
  assert.ok(ids.includes('bexio'), 'the bexio guide ships');
  for (const guide of EXTRACTION_GUIDES) {
    for (const item of guide.items) {
      assert.equal(guideItemIsWellFormed(item), true, `${guide.sourceSystem}/${item.id} is malformed`);
    }
  }
});

test('G19: the bexio guide covers all 16 PHASE1 rows plus the 4 module questions (seed cannot shrink)', () => {
  const bexio = extractionGuideDef('bexio');
  const EXPECTED_EXPORT_ROWS = [
    'contacts',
    'chart_of_accounts',
    'items',
    'tax_codes',
    'payment_terms',
    'bank_accounts',
    'opening_balances',
    'open_items_ar',
    'open_items_ap',
    'vat_returns',
    'vat_settings',
    'annual_accounts',
    'journal',
    'bank_statements',
    'belege',
    'number_ranges',
  ];
  const EXPECTED_MODULE_QUESTIONS = ['module_fixed_assets', 'module_inventory', 'module_payroll', 'module_multi_currency'];
  const present = new Set(bexio.items.map((i) => i.id));
  for (const id of [...EXPECTED_EXPORT_ROWS, ...EXPECTED_MODULE_QUESTIONS]) {
    assert.ok(present.has(id), `bexio guide is missing the seeded item ${id}`);
  }
  assert.equal(EXPECTED_EXPORT_ROWS.length, 16, 'PHASE1 has 16 export rows');
  // The four module questions carry the moduleQuestion prompt.
  for (const id of EXPECTED_MODULE_QUESTIONS) {
    const item = bexio.items.find((i) => i.id === id);
    assert.ok(typeof item.moduleQuestion === 'string' && item.moduleQuestion.length > 0, `${id} needs a moduleQuestion`);
  }
});

test('G19: no guide claims a companion (no gate-clearance recorded), so hasCompanion is false', () => {
  for (const guide of EXTRACTION_GUIDES) {
    assert.equal(guideHasCompanion(guide), false, `${guide.sourceSystem} must not claim a companion`);
    assert.equal(guide.companionGateClearedRef, undefined, `${guide.sourceSystem} carries no gate-clearance ref`);
  }
});

test('G19: the belege item is a gated rung (3/4), so the browser companion is proposed, not promised', () => {
  const bexio = extractionGuideDef('bexio');
  const belege = bexio.items.find((i) => i.id === 'belege');
  assert.ok(belege.rung === 3 || belege.rung === 4, 'belege sits on the companion rung');
});

test('G19: the bexio deletion clock is a verify-against-your-contract fact (30 days), not a law', () => {
  const bexio = extractionGuideDef('bexio');
  assert.equal(bexio.deletionClock.days, 30);
  assert.ok(/[Vv]ertrag|AGB/.test(bexio.deletionClock.verifyAgainst), 'names what to verify against');
});

test('G19: guide modules import no node:fs and no socket (pure shipped data)', () => {
  const dir = fileURLToPath(new URL('../../src/core/migration/guides/', import.meta.url));
  for (const e of readdirSync(dir)) {
    if (!e.endsWith('.ts')) continue;
    const src = readFileSync(`${dir}${e}`, 'utf8');
    const importsFs = /(?:import[^\n]*from\s*|require\(\s*)['"](?:node:)?fs['"]/.test(src);
    const importsNet = /(?:import[^\n]*from\s*|require\(\s*)['"](?:node:)?(?:net|http|https|dgram|tls)['"]/.test(src);
    assert.equal(importsFs, false, `${e} reads the filesystem; guides are pure data`);
    assert.equal(importsNet, false, `${e} opens a socket; guides are pure data`);
  }
});

// --- The Datenherausgabe letter -----------------------------------------------------------------

test('G19: the letter template renders with the revDSG Art. 28 limits paragraph in every locale', () => {
  for (const locale of ['de-CH', 'fr', 'it', 'en']) {
    const l = DATENHERAUSGABE_LETTER[locale];
    assert.ok(typeof l.limitsParagraph === 'string' && l.limitsParagraph.length > 20, `${locale} has a limits paragraph`);
    assert.ok(/28/.test(l.limitsParagraph), `${locale} limits paragraph cites Art. 28`);
  }
});

test('G19: the de-CH letter uses real umlauts and no ß (Swiss German)', () => {
  const de = DATENHERAUSGABE_LETTER['de-CH'];
  const all = [de.subject, ...de.body, de.limitsParagraph].join('\n');
  assert.ok(/[äöü]/.test(all), 'the de-CH letter uses real umlauts');
  assert.equal(/ß/.test(all), false, 'Swiss German has no ß');
});

// --- The guide reads (verbs) --------------------------------------------------------------------

test('G19: migration_list_extraction_guides lists the shipped guides', () => {
  const { call } = world('list-guides');
  const res = must(call('migration_list_extraction_guides', {}), 'list guides');
  const ids = res.guides.map((g) => g.sourceSystem);
  assert.ok(ids.includes('generic') && ids.includes('bexio'));
  assert.equal(res.guides.find((g) => g.sourceSystem === 'bexio').hasCompanion, false);
});

test('G19: migration_get_extraction_guide falls back to generic, strict refuses an unknown system', () => {
  const { call } = world('get-guide');
  const bexio = must(call('migration_get_extraction_guide', { sourceSystem: 'bexio' }), 'bexio guide');
  assert.equal(bexio.fellBack, false);
  assert.ok(bexio.guide.items.length > 0);
  const fallback = must(call('migration_get_extraction_guide', { sourceSystem: 'sage50' }), 'unknown -> generic');
  assert.equal(fallback.fellBack, true);
  assert.equal(fallback.guide.sourceSystem, 'generic');
  refuse(call('migration_get_extraction_guide', { sourceSystem: 'sage50', strict: true }), 'unknown_source_system', 'strict unknown');
});

// --- The manifest -------------------------------------------------------------------------------

function planFor(call, seed, sourceSystem = 'bexio') {
  return must(
    call('migration_create_plan', { sourceSystem, cutoverDate: '2024-07-01', localePack: 'ch', idempotencyKey: `${seed}-plan` }),
    'plan',
  ).planId;
}

test('G19: setManifest instantiates one item per guide row at status open, idempotent on its key', () => {
  const { call } = world('set-manifest');
  const planId = planFor(call, 'sm');
  const bexio = extractionGuideDef('bexio');
  const created = must(call('migration_set_manifest', { planId, sourceAccessUntil: '2024-08-01', idempotencyKey: 'sm-1' }), 'set manifest');
  assert.equal(created.items.length, bexio.items.length, 'one item per guide row');
  assert.ok(created.items.every((i) => i.status === 'open'));
  // Idempotent: same key replays the same manifest id.
  const again = must(call('migration_set_manifest', { planId, idempotencyKey: 'sm-1' }), 'replay');
  assert.equal(again.manifestId, created.manifestId);
});

test('G19: setManifestItem records status/evidence and completeness excludes not_used', () => {
  const { call } = world('set-item');
  const planId = planFor(call, 'si');
  const fileId = uploadFile(call, 'si');
  must(call('migration_set_manifest', { planId, idempotencyKey: 'si-m' }), 'set manifest');
  const rec = must(
    call('migration_set_manifest_item', { planId, itemId: 'contacts', status: 'exported', fileIds: [fileId], rowCount: 42, dateFrom: '2020-01-01', dateTo: '2024-06-30', idempotencyKey: 'si-1' }),
    'record item',
  );
  assert.equal(rec.item.status, 'exported');
  assert.deepEqual(rec.item.fileIds, [fileId]);
  assert.equal(rec.item.rowCount, 42);
  assert.equal(rec.item.updatedBy, 'studio', 'the write is stamped (§H-AUDIT)');
  // not_used drops the item from the denominator.
  const before = rec.completeness.denominator;
  const notUsed = must(call('migration_set_manifest_item', { planId, itemId: 'module_payroll', status: 'not_used', idempotencyKey: 'si-2' }), 'mark not_used');
  assert.equal(notUsed.completeness.denominator, before - 1, 'not_used leaves the denominator');
  assert.equal(notUsed.completeness.notUsed, 1);
});

test('G19: setManifestItem refuses a cross-workspace fileId (§H-TENANT) and an inverted date range', () => {
  const other = world('other');
  const foreignFile = uploadFile(other.call, 'foreign');
  const { call } = world('refuse');
  const planId = planFor(call, 're');
  must(call('migration_set_manifest', { planId, idempotencyKey: 're-m' }), 'set manifest');
  refuse(call('migration_set_manifest_item', { planId, itemId: 'contacts', status: 'exported', fileIds: [foreignFile], idempotencyKey: 're-x' }), 'file_not_found', 'cross-workspace fileId');
  refuse(call('migration_set_manifest_item', { planId, itemId: 'contacts', status: 'exported', dateFrom: '2024-06-30', dateTo: '2020-01-01', idempotencyKey: 're-d' }), 'invalid_date_range', 'inverted range');
  refuse(call('migration_set_manifest_item', { planId, itemId: 'no_such_item', status: 'exported', idempotencyKey: 're-u' }), 'unknown_manifest_item', 'unknown item');
  refuse(call('migration_set_manifest_item', { planId, itemId: 'contacts', status: 'nonsense', idempotencyKey: 're-s' }), 'invalid_input', 'bad status');
});

test('G19: getManifest returns completeness and the deletion-clock deadline; null before creation', () => {
  const { call } = world('get-manifest');
  const planId = planFor(call, 'gm');
  const empty = must(call('migration_get_manifest', { planId }), 'before create');
  assert.equal(empty.manifest, null, 'no manifest yet returns manifest:null');
  must(call('migration_set_manifest', { planId, sourceAccessUntil: '2024-07-15', idempotencyKey: 'gm-m' }), 'set manifest');
  const got = must(call('migration_get_manifest', { planId }), 'after create');
  assert.ok(got.manifest !== null);
  assert.equal(got.deadline.sourceAccessUntil, '2024-07-15');
  assert.equal(typeof got.deadline.daysRemaining, 'number');
});

test('G19: the deadline computation is signed across the boundary (future, today, past)', () => {
  assert.equal(deadlineOf('2024-07-15', '2024-07-01T10:00:00Z').daysRemaining, 14);
  assert.equal(deadlineOf('2024-07-01', '2024-07-01T10:00:00Z').daysRemaining, 0);
  assert.equal(deadlineOf('2024-06-20', '2024-07-01T10:00:00Z').daysRemaining, -11);
  assert.equal(deadlineOf(null, '2024-07-01T10:00:00Z'), null);
});

test('G19: readiness warns (never blocks) on an incomplete manifest and an expiring deadline', () => {
  const { deps, wid, call } = world('readiness');
  const planId = planFor(call, 'rd');
  // A near deadline (the fixture clock's "today" plus a few days) and an untouched manifest.
  const today = deps.clock.now().slice(0, 10);
  const soon = new Date(Date.parse(`${today}T00:00:00Z`) + 5 * 86_400_000).toISOString().slice(0, 10);
  must(call('migration_set_manifest', { planId, sourceAccessUntil: soon, idempotencyKey: 'rd-m' }), 'set manifest');
  const ready = must(call('migration_readiness', { planId }), 'readiness');
  const warningKinds = ready.warnings.map((w) => w.item);
  assert.ok(warningKinds.includes('extraction_incomplete'), 'an incomplete manifest warns');
  assert.ok(warningKinds.includes('source_access_expiring'), 'a near deadline warns');
  // The commit gate's blocking legs are untouched by these warnings.
  const incomplete = ready.warnings.find((w) => w.item === 'extraction_incomplete');
  assert.ok(Array.isArray(incomplete.openItems) && incomplete.openItems.length > 0, 'the warning names the open items');
  void wid;
});

test('G19: a full manifest reports complete; the completing write names the moment once', () => {
  const { call } = world('complete');
  const planId = planFor(call, 'cp', 'generic');
  const created = must(call('migration_set_manifest', { planId, idempotencyKey: 'cp-m' }), 'set manifest');
  // Mark every item not_used except one, then export the last: the last write flips complete.
  const items = created.items;
  for (let i = 0; i < items.length - 1; i += 1) {
    must(call('migration_set_manifest_item', { planId, itemId: items[i].itemId, status: 'not_used', idempotencyKey: `cp-nu-${i}` }), 'not_used');
  }
  const last = items[items.length - 1].itemId;
  const flip = must(call('migration_set_manifest_item', { planId, itemId: last, status: 'exported', idempotencyKey: 'cp-last' }), 'export last');
  assert.equal(flip.completeness.complete, true, 'the manifest is complete');
  assert.equal(flip.completedManifestId, created.manifestId, 'the completing write names the manifest (null-collapse)');
});
