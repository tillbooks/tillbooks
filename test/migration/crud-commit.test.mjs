/**
 * G09, the five CRUD data classes committed through their OWNING verbs (P3): `items`,
 * `chart_of_accounts`, `tax_codes`, `payment_terms`, `bank_accounts`.
 *
 * What these tests hold true, per class: a mapped source row creates EXACTLY ONE target record
 * through the owning verb; a double-commit (same key, and a whole second plan over the same file)
 * creates ZERO extra rows, because the class's match key classifies an already-present row as
 * `willSkip` (US-G09.9, §H-IDEMPOTENT on ROWS); a key match with differing fields is a CONFLICT that
 * blocks the commit engine-side; and every probe is §H-TENANT scoped, so another workspace's rows
 * neither match nor leak.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);
const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};

const count = (deps, wid, table) =>
  deps.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(wid).n;

/** Upload a CSV, link it to a fresh plan, scope ONE class, trial-load: the step is commit-ready. */
function seedCrudStep(deps, wid, seed, dataClass, csv) {
  const up = must(
    call(deps, 'files_upload', {
      workspaceId: wid,
      title: `Import ${seed}`,
      filename: `${seed}.csv`,
      mime: 'text/csv',
      contentBase64: Buffer.from(csv).toString('base64'),
      idempotencyKey: `${seed}-up`,
    }),
    'files_upload',
  );
  const planId = must(
    call(deps, 'migration_create_plan', {
      workspaceId: wid,
      sourceSystem: 'csv',
      cutoverDate: '2026-01-01',
      localePack: 'ch',
      idempotencyKey: `${seed}-plan`,
    }),
    'create_plan',
  ).planId;
  must(call(deps, 'migration_discover_source', { workspaceId: wid, fileIds: [up.file.id], planId }), 'discover');
  const scope = must(
    call(deps, 'migration_set_scope', {
      workspaceId: wid,
      planId,
      classes: [{ dataClass, include: true }],
      idempotencyKey: `${seed}-scope`,
    }),
    'set_scope',
  );
  const stepId = scope.steps[0].stepId;
  must(call(deps, 'migration_trial_load_step', { workspaceId: wid, planId, stepId, idempotencyKey: `${seed}-trial` }), 'trial');
  return { planId, stepId };
}

function ws(seed) {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Übernahme GmbH', `${seed}-ws`);
  return { deps, wid: workspaceId, accId };
}

// --- items --------------------------------------------------------------------------------------

test('G09 CRUD: items commit through create_item, exactly one item per row, zero extra on re-import', () => {
  const { deps, wid } = ws('items');
  const csv = 'sku,name,price\nW-1,Widget,25.00\nS-1,Beratung,150.50\n';
  const before = count(deps, wid, 'item');

  const { planId, stepId } = seedCrudStep(deps, wid, 'it1', 'items', csv);
  const committed = must(call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'it1-commit' }), 'commit');
  assert.equal(committed.created.length, 2, 'two source rows must create two items');
  assert.equal(count(deps, wid, 'item'), before + 2);

  // The owning verb wrote real, validated rows: the price is the parsed Rappen, never re-rounded.
  const widget = deps.store.db
    .prepare('SELECT name, default_unit_price_minor FROM item WHERE workspace_id = ? AND item_sku = ?')
    .get(wid, 'W-1');
  assert.equal(widget.name, 'Widget');
  assert.equal(widget.default_unit_price_minor, 2500, '25.00 CHF must land as 2500 Rappen');

  // Same key: the idempotent replay writes nothing more.
  must(call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'it1-commit' }), 'replay');
  assert.equal(count(deps, wid, 'item'), before + 2, 'a same-key double-commit duplicated items');

  // A WHOLE SECOND PLAN over the same file: the match key (SKU) classifies every row willSkip.
  const second = seedCrudStep(deps, wid, 'it2', 'items', csv);
  const preview = must(call(deps, 'migration_preview_step', { workspaceId: wid, planId: second.planId, stepId: second.stepId }), 'preview');
  assert.equal(preview.willSkip, 2, 'a re-import must classify already-present rows as willSkip');
  assert.equal(preview.willCreate, 0);
  const recommit = must(call(deps, 'migration_commit_step', { workspaceId: wid, planId: second.planId, stepId: second.stepId, idempotencyKey: 'it2-commit' }), 'recommit');
  assert.equal(recommit.created.length, 0, 'a re-import created rows it should have skipped');
  assert.equal(recommit.skipped.length, 2);
  assert.equal(count(deps, wid, 'item'), before + 2, 'a re-import over a second plan duplicated items');
});

// --- chart_of_accounts --------------------------------------------------------------------------

test('G09 CRUD: chart_of_accounts commits through create_account with KMU-derived types; an exact seed match skips; a differing match blocks', () => {
  const { deps, wid } = ws('coa');
  const before = count(deps, wid, 'account');
  // Two NEW accounts plus one row identical to the seeded 1000 (name matches the KMU seed exactly).
  const csv = 'Konto,Bezeichnung\n1021,Postkonto\n6650,Werbedrucksachen\n1000,Kassenbestand\n';

  const { planId, stepId } = seedCrudStep(deps, wid, 'coa1', 'chart_of_accounts', csv);
  const committed = must(call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'coa1-commit' }), 'commit');
  assert.equal(committed.created.length, 2, 'two new numbers must create two accounts');
  assert.equal(committed.skipped.length, 1, 'the exact seed match must skip, not duplicate');
  assert.equal(count(deps, wid, 'account'), before + 2);

  // The type came from the KMU number range, mirroring the seed's own mapping.
  const post = deps.store.db.prepare('SELECT type FROM account WHERE workspace_id = ? AND number = ?').get(wid, '1021');
  assert.equal(post.type, 'asset');
  const werbung = deps.store.db.prepare('SELECT type FROM account WHERE workspace_id = ? AND number = ?').get(wid, '6650');
  assert.equal(werbung.type, 'expense');

  // A number hit with a DIFFERING name is a conflict, and an unresolved conflict blocks engine-side.
  const clash = seedCrudStep(deps, wid, 'coa2', 'chart_of_accounts', 'Konto,Bezeichnung\n1000,Portokasse\n');
  const refused = call(deps, 'migration_commit_step', { workspaceId: wid, planId: clash.planId, stepId: clash.stepId, idempotencyKey: 'coa2-commit' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'unresolved_conflicts');
  assert.equal(count(deps, wid, 'account'), before + 2, 'a blocked commit must write nothing');
});

// --- tax_codes ----------------------------------------------------------------------------------

test('G09 CRUD: tax_codes commit through vat_code_upsert (percent parsed to bp), idempotent on re-import', () => {
  const { deps, wid } = ws('tax');
  deps.store.db.prepare('UPDATE workspace SET vat_registered = 1 WHERE id = ?').run(wid);
  const before = count(deps, wid, 'tax_code');
  const csv = 'code,satz,art,ziffer\nMIG81,8.1,Umsatz,302\nMIGVS,8.1,Vorsteuer,400\n';

  const { planId, stepId } = seedCrudStep(deps, wid, 'tx1', 'tax_codes', csv);
  const committed = must(call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'tx1-commit' }), 'commit');
  assert.equal(committed.created.length, 2);
  assert.equal(count(deps, wid, 'tax_code'), before + 2);

  const row = deps.store.db.prepare('SELECT kind, rate_bp, esa_form_line FROM tax_code WHERE workspace_id = ? AND code = ?').get(wid, 'MIG81');
  assert.equal(row.kind, 'output', 'the de-CH kind word Umsatz must map onto A05\'s enum');
  assert.equal(row.rate_bp, 810, '8.1 percent must land as 810 basis points, never re-rounded');
  assert.equal(row.esa_form_line, '302');

  // Re-import over a second plan: the code match key classifies both rows willSkip; zero extra.
  const second = seedCrudStep(deps, wid, 'tx2', 'tax_codes', csv);
  const recommit = must(call(deps, 'migration_commit_step', { workspaceId: wid, planId: second.planId, stepId: second.stepId, idempotencyKey: 'tx2-commit' }), 'recommit');
  assert.equal(recommit.created.length, 0);
  assert.equal(recommit.skipped.length, 2);
  assert.equal(count(deps, wid, 'tax_code'), before + 2, 'a tax-code re-import duplicated codes');
});

// --- payment_terms ------------------------------------------------------------------------------

test('G09 CRUD: payment_terms commit through update_contact; a missing contact fails its row, never invents a party', () => {
  const { deps, wid } = ws('terms');
  must(call(deps, 'create_contact', { workspaceId: wid, name: 'Muster AG', partyRole: 'customer', idempotencyKey: 'c-1' }), 'create_contact');
  const contactsBefore = count(deps, wid, 'contact');
  const csv = 'kunde,tage\nMuster AG,30\nUnbekannt GmbH,60\n';

  const { planId, stepId } = seedCrudStep(deps, wid, 'pt1', 'payment_terms', csv);
  const committed = must(call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'pt1-commit' }), 'commit');
  assert.equal(committed.created.length, 1, 'the known contact must take the imported terms');
  assert.equal(committed.failed.length, 1, 'the unknown contact must fail its row');
  assert.equal(committed.failed[0].reason, 'contact_not_found');
  assert.equal(count(deps, wid, 'contact'), contactsBefore, 'a payment-terms import must never create a contact');

  const c = deps.store.db.prepare('SELECT payment_terms_days FROM contact WHERE workspace_id = ? AND name = ?').get(wid, 'Muster AG');
  assert.equal(c.payment_terms_days, 30);

  // Re-import: contact+days now match exactly, so the row skips and nothing changes.
  const second = seedCrudStep(deps, wid, 'pt2', 'payment_terms', 'kunde,tage\nMuster AG,30\n');
  const recommit = must(call(deps, 'migration_commit_step', { workspaceId: wid, planId: second.planId, stepId: second.stepId, idempotencyKey: 'pt2-commit' }), 'recommit');
  assert.equal(recommit.created.length, 0);
  assert.equal(recommit.skipped.length, 1);
});

// --- bank_accounts ------------------------------------------------------------------------------

test('G09 CRUD: bank_accounts commit through create_bank_account keyed on IBAN; a missing ledger account fails honestly', () => {
  const { deps, wid, accId } = ws('bank');
  const before = count(deps, wid, 'bank_account');
  // The KMU seed carries 1020 (asset): the row names it as the ledger link.
  const csv = 'name,iban,währung,konto\nUBS Geschäftskonto,CH9300762011623852957,CHF,1020\n';

  const { planId, stepId } = seedCrudStep(deps, wid, 'bk1', 'bank_accounts', csv);
  const committed = must(call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'bk1-commit' }), 'commit');
  assert.equal(committed.created.length, 1);
  assert.equal(count(deps, wid, 'bank_account'), before + 1);
  const row = deps.store.db
    .prepare('SELECT name, iban, currency, ledger_account_id FROM bank_account WHERE workspace_id = ?')
    .get(wid);
  assert.equal(row.iban, 'CH9300762011623852957');
  assert.equal(row.currency, 'CHF');
  assert.equal(row.ledger_account_id, accId('1020'), 'the ledger link must resolve the mapped account NUMBER to its id');

  // Re-import: the IBAN match key skips; zero extra.
  const second = seedCrudStep(deps, wid, 'bk2', 'bank_accounts', csv);
  const recommit = must(call(deps, 'migration_commit_step', { workspaceId: wid, planId: second.planId, stepId: second.stepId, idempotencyKey: 'bk2-commit' }), 'recommit');
  assert.equal(recommit.created.length, 0);
  assert.equal(recommit.skipped.length, 1);
  assert.equal(count(deps, wid, 'bank_account'), before + 1, 'a bank-account re-import duplicated the account');

  // A row naming NO usable ledger account fails with the reason named, never a guessed link.
  const bad = seedCrudStep(deps, wid, 'bk3', 'bank_accounts', 'name,iban,währung\nZweitkonto,CH5604835012345678009,CHF\n');
  const failedCommit = must(call(deps, 'migration_commit_step', { workspaceId: wid, planId: bad.planId, stepId: bad.stepId, idempotencyKey: 'bk3-commit' }), 'commit');
  assert.equal(failedCommit.created.length, 0);
  assert.equal(failedCommit.failed.length, 1);
  assert.equal(failedCommit.failed[0].reason, 'needs_ledger_account');
  assert.equal(count(deps, wid, 'bank_account'), before + 1, 'a failed row must write nothing');
});

// --- §H-TENANT ----------------------------------------------------------------------------------

test('G09 CRUD: the match-key probe is workspace-scoped, so another tenant\'s rows neither match nor block (§H-TENANT)', () => {
  const deps = freshDeps();
  const { workspaceId: a } = mintWorkspace(deps, 'Mandant A', 'crud-a');
  const { workspaceId: b } = mintWorkspace(deps, 'Mandant B', 'crud-b');
  // Workspace B already owns an item with the same SKU and name the import carries.
  must(call(deps, 'create_item', { workspaceId: b, name: 'Widget', sku: 'W-1', defaultUnitPriceMinor: 2500, idempotencyKey: 'b-item' }), 'b item');
  const bItems = count(deps, b, 'item');

  const csv = 'sku,name,price\nW-1,Widget,25.00\n';
  const seedIn = (wid, seed) => seedCrudStep(deps, wid, seed, 'items', csv);
  const { planId, stepId } = seedIn(a, 'tenant');
  const preview = must(call(deps, 'migration_preview_step', { workspaceId: a, planId, stepId }), 'preview');
  assert.equal(preview.willCreate, 1, "B's identical item must not make A's row a skip: the probe crossed the fence");
  const committed = must(call(deps, 'migration_commit_step', { workspaceId: a, planId, stepId, idempotencyKey: 'tenant-commit' }), 'commit');
  assert.equal(committed.created.length, 1);
  assert.equal(count(deps, a, 'item'), 1, "the import must land in A");
  assert.equal(count(deps, b, 'item'), bItems, "the import must not touch B");
});

// --- The G10 applied column map drives the row shape --------------------------------------------

test('G09 CRUD: the applied column map (G10) translates arbitrary source headers before the alias fallback', () => {
  const { deps, wid } = ws('map');
  const before = count(deps, wid, 'item');
  // Headers no alias knows: only the plan's column map can decode them.
  const csv = 'ColA,ColB,ColC\nP-9,Spezialteil,12.35\n';
  const { planId, stepId } = seedCrudStep(deps, wid, 'map1', 'items', csv);
  must(
    call(deps, 'migration_set_map', {
      workspaceId: wid,
      planId,
      kind: 'column',
      entries: [
        { source: 'ColA', target: 'sku' },
        { source: 'ColB', target: 'name' },
        { source: 'ColC', target: 'price' },
      ],
      idempotencyKey: 'map1-map',
    }),
    'set_map',
  );
  const committed = must(call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'map1-commit' }), 'commit');
  assert.equal(committed.created.length, 1);
  assert.equal(count(deps, wid, 'item'), before + 1);
  const item = deps.store.db.prepare('SELECT name, default_unit_price_minor FROM item WHERE workspace_id = ? AND item_sku = ?').get(wid, 'P-9');
  assert.equal(item.name, 'Spezialteil');
  assert.equal(item.default_unit_price_minor, 1235);
});
