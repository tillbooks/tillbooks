// N00 environment landscape, PHASE B: the copy + sanitize engine (D126 section 4, findings #1/#5/#6/
// #10/#11, D-ENV-4/5/9). Money-path adjacent, so these tests are written to BITE: a NON-AUTHOR critic
// verifies they are non-vacuous. Every test builds a FILE-backed source environment carrying real-ish
// client data plus every access secret, runs a real copy through the engine, and scans the whole target
// db for the source values. The real ~/.till is never touched: everything lives under a per-test tmp dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  envCreate,
  envCopy,
  envList,
  readLandscape,
  ibanIsValid,
  chTestIban,
} from '../../dist/core/landscape/index.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { createWorkspace } from '../../dist/core/setup/workspace.js';
import { systemIdGen } from '../../dist/core/ids.js';
import { requiredCapabilitiesFor } from '../../dist/core/access/index.js';

// --- distinctive source markers (tokens that appear nowhere else, so a scan is meaningful) ---------

const M = {
  company: 'ZZQCOMPANY_SourceCo',
  contactName: 'ZZQPERSON_Distinctive',
  email: 'zzq.person@realclient.example',
  street: 'ZZQGeheimstrasse',
  city: 'ZZQburg',
  vat: 'CHE-999.888.777',
  iban: 'CH5604835012345678009',
  notes: 'ZZQ_private_free_text_note',
  portalHash: 'ZZQPORTALTOKENHASH0001',
  keyRef: 'ZZQEBICSKEYREF0001',
  bankHashes: 'ZZQBANKKEYHASHES0001',
  consentRef: 'ZZQMANAGEDCONSENT0001',
  transportKey: 'ZZQAGENTTRANSPORT0001',
  acceptHash: 'ZZQACCEPTTOKENHASH0001',
};

const SECRET_MARKERS = [M.portalHash, M.keyRef, M.bankHashes, M.consentRef, M.transportKey, M.acceptHash];
const PII_MARKERS = [M.contactName, M.email, M.street, M.vat, M.iban, M.company, M.notes];

// --- a rich, FK-consistent, balanced source seeder -------------------------------------------------

/** Seed a workspace (via the real engine) plus a contact, bank account, one balanced posted entry, and
 *  a row in every secret-bearing table, all carrying the distinctive markers above. Runs inside
 *  envCreate`s build-then-gate, so an inconsistent or unbalanced seed would itself fail the create. */
function richSeeder(markers = M) {
  return (path) => {
    const store = new SqliteStore({ location: path });
    const db = store.db;
    const at = '2026-01-01T00:00:00.000Z';
    const created = createWorkspace(
      { store, clock: { now: () => at }, ids: systemIdGen, actor: 'seed' },
      { name: markers.company },
    );
    if (!created.ok) throw new Error('seed: createWorkspace failed');
    const wsId = created.workspaceId;
    const acct = db.prepare('SELECT id FROM account WHERE workspace_id = ? LIMIT 1').get(wsId).id;

    const contactId = systemIdGen.next('contact');
    db.prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, address_street, address_house_no, address_zip, address_city, address_country, email, vat_number, created_at, kind)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(contactId, wsId, 'customer', markers.contactName, markers.street, '7', '8001', markers.city, 'CH', markers.email, markers.vat, at, 'company');

    db.prepare(`INSERT INTO bank_account (id, workspace_id, name, iban, ledger_account_id, created_at) VALUES (?,?,?,?,?,?)`).run(
      systemIdGen.next('bank'),
      wsId,
      'Hauptkonto',
      markers.iban,
      acct,
      at,
    );

    // A balanced posted entry: lines first (parent absent, so the immutability trigger allows), then the
    // entry as `posted`, with FK checks deferred to commit (the portability restore technique).
    const entryId = systemIdGen.next('entry');
    db.pragma('defer_foreign_keys = ON');
    db.transaction(() => {
      db.prepare(`INSERT INTO journal_line (id, entry_id, account_id, currency, base_debit_minor, base_credit_minor) VALUES (?,?,?,?,?,?)`).run(
        systemIdGen.next('jl'), entryId, acct, 'CHF', 12345, 0,
      );
      db.prepare(`INSERT INTO journal_line (id, entry_id, account_id, currency, base_debit_minor, base_credit_minor) VALUES (?,?,?,?,?,?)`).run(
        systemIdGen.next('jl'), entryId, acct, 'CHF', 0, 12345,
      );
      db.prepare(`INSERT INTO journal_entry (id, workspace_id, date, status, source, created_at, description) VALUES (?,?,?,?,?,?,?)`).run(
        entryId, wsId, '2026-01-15', 'posted', 'manual', at, markers.notes,
      );
    })();

    // Every secret-bearing table (A33/A37/F02/F03 + agent + document), carrying the distinctive secrets.
    db.prepare(
      `INSERT INTO portal_grant (id, workspace_id, contact_id, kind, token_hash, scopes, expires_at, local_artifact_json, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(systemIdGen.next('pg'), wsId, contactId, 'customer', markers.portalHash, '[]', '2030-01-01', '{}', 'seed', at, at);
    db.prepare(
      `INSERT INTO ebics_connection (id, workspace_id, host_url, host_id, partner_id, user_id_ebics, state, key_ref, bank_key_hashes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(systemIdGen.next('eb'), wsId, 'https://ebics.example', 'HOSTID', 'PARTNER', 'USERID', 'active', markers.keyRef, markers.bankHashes, at, at);
    db.prepare(
      `INSERT INTO managed_connection (id, workspace_id, provider, bank_ref, state, consent_ref, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    ).run(systemIdGen.next('mc'), wsId, 'blink', 'BANKREF', 'active', markers.consentRef, at, at);
    db.prepare(`INSERT INTO agent_session (id, workspace_id, actor, transport_key, started_at, last_at) VALUES (?,?,?,?,?,?)`).run(
      systemIdGen.next('as'), wsId, 'agent', markers.transportKey, at, at,
    );
    db.prepare(
      `INSERT INTO document (id, workspace_id, type, status, created_at, accept_token_hash, sent_to_email, notes) VALUES (?,?,?,?,?,?,?,?)`,
    ).run(systemIdGen.next('doc'), wsId, 'invoice', 'draft', at, markers.acceptHash, markers.email, markers.notes);

    store.close();
  };
}

// --- helpers ---------------------------------------------------------------------------------------

function tmp() {
  return mkdtempSync(join(tmpdir(), 'till-copy-'));
}

function makeDeps(dir, seeders) {
  return {
    supportDir: dir,
    environmentsRoot: join(dir, 'environments'),
    mainDbPath: join(dir, 'main', 'till.db'),
    actor: 'owner',
    now: () => '2026-09-07T00:00:00.000Z',
    seeders: seeders ?? { minimal: (p) => { const s = new SqliteStore({ location: p }); s.close(); } },
    ids: systemIdGen,
    clock: { now: () => '2026-09-07T00:00:00.000Z' },
  };
}

/** Every `table.column` in the db whose text (cast) contains `needle`. A full-db forensic scan. */
function scanForValue(dbPath, needle) {
  const store = new SqliteStore({ location: dbPath });
  try {
    const db = store.db;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
    const hits = [];
    for (const t of tables) {
      const cols = db.pragma(`table_info("${t}")`);
      for (const c of cols) {
        try {
          const row = db.prepare(`SELECT 1 FROM "${t}" WHERE CAST("${c.name}" AS TEXT) LIKE ? LIMIT 1`).get(`%${needle}%`);
          if (row) hits.push(`${t}.${c.name}`);
        } catch {
          // a column that cannot be cast/scanned is not a hiding place for an ASCII marker
        }
      }
    }
    return hits;
  } finally {
    store.close();
  }
}

/** Create a source env (rich) and a bare target env, return their names + the deps + dir. */
function scenario({ sourceRank = 250, targetRank = 40, targetSeed } = {}) {
  const dir = tmp();
  const seeders = { rich: richSeeder(), minimal: (p) => { const s = new SqliteStore({ location: p }); s.close(); } };
  if (targetSeed) seeders.keeper = targetSeed;
  const deps = makeDeps(dir, seeders);
  const src = envCreate(deps, { name: 'src', policy: 'synthetic', seed: 'rich', tierRank: sourceRank, confirmed: true });
  assert.equal(src.ok, true, `source create: ${JSON.stringify(src)}`);
  const tgt = envCreate(deps, { name: 'dst', policy: 'synthetic', seed: targetSeed ? 'keeper' : 'minimal', tierRank: targetRank, confirmed: true });
  assert.equal(tgt.ok, true, `target create: ${JSON.stringify(tgt)}`);
  return { dir, deps, srcPath: join(dir, 'environments', 'src', 'till.db'), dstPath: join(dir, 'environments', 'dst', 'till.db') };
}

function srcWorkspaceId(srcPath) {
  const s = new SqliteStore({ location: srcPath });
  try {
    return s.db.prepare('SELECT id FROM workspace LIMIT 1').get().id;
  } finally {
    s.close();
  }
}

// --- IBAN generator sanity (the pseudonymize replacement must be a VALID CH IBAN) ------------------

test('copy/iban: validator accepts a known CH IBAN, rejects a tampered one, and every generated test IBAN is valid', () => {
  assert.equal(ibanIsValid('CH9300762011623852957'), true);
  assert.equal(ibanIsValid('CH9300762011623852958'), false);
  for (const id of ['a', 'contact_1', 'contact_2', 'workspace_x', 'bank_9']) {
    const iban = chTestIban(id);
    assert.equal(iban.length, 21, iban);
    assert.equal(iban.slice(0, 2), 'CH');
    assert.equal(ibanIsValid(iban), true, `generated ${iban} must be a valid CH IBAN`);
  }
  assert.equal(chTestIban('stable'), chTestIban('stable'), 'deterministic per id');
});

// --- E10 SECRETS: the floor holds at EVERY sanitization level --------------------------------------

for (const level of ['raw', 'pseudonymize', 'structure_synthetic']) {
  test(`copy/secrets: no source secret survives a ${level} copy (D-ENV-5 floor)`, () => {
    const { dir, deps, srcPath, dstPath } = scenario();
    try {
      // Sanity: the source really holds every secret, so the assertion below is non-vacuous.
      for (const secret of SECRET_MARKERS) {
        assert.ok(scanForValue(srcPath, secret).length > 0, `source must contain ${secret} for the test to bite`);
      }
      const res = envCopy(deps, { source: 'src', target: 'dst', scope: 'instance', sanitize: level, confirmed: true });
      assert.equal(res.ok, true, `copy: ${JSON.stringify(res)}`);
      for (const secret of SECRET_MARKERS) {
        assert.deepEqual(scanForValue(dstPath, secret), [], `${secret} must NOT survive a ${level} copy, found in: ${scanForValue(dstPath, secret)}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// --- E10 PII: no source name/address/IBAN/email survives a pseudonymized copy ----------------------

test('copy/pii: no source name, address, IBAN, email or VAT number survives a pseudonymized copy', () => {
  const { dir, deps, srcPath, dstPath } = scenario();
  try {
    for (const pii of PII_MARKERS) {
      assert.ok(scanForValue(srcPath, pii).length > 0, `source must contain ${pii}`);
    }
    const res = envCopy(deps, { source: 'src', target: 'dst', sanitize: 'pseudonymize', confirmed: true });
    assert.equal(res.ok, true, JSON.stringify(res));
    for (const pii of PII_MARKERS) {
      assert.deepEqual(scanForValue(dstPath, pii), [], `${pii} must not survive pseudonymize, found in ${scanForValue(dstPath, pii)}`);
    }
    // Structure is KEPT: a contact row still exists, and its IBAN is a valid CH test IBAN.
    const store = new SqliteStore({ location: dstPath });
    try {
      const contacts = store.db.prepare('SELECT COUNT(*) AS n FROM contact').get().n;
      assert.equal(contacts, 1, 'the contact row is kept (structure), only its identity masked');
      const iban = store.db.prepare('SELECT iban FROM bank_account LIMIT 1').get().iban;
      assert.equal(ibanIsValid(iban), true, `the replacement IBAN ${iban} must be a valid CH IBAN`);
      assert.notEqual(iban, M.iban);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- raw keeps PII (D-ENV-4 default) but still neutralizes secrets ---------------------------------

test('copy/raw: a raw copy keeps the books verbatim but still neutralizes every secret', () => {
  const { dir, deps, dstPath } = scenario();
  try {
    const res = envCopy(deps, { source: 'src', target: 'dst', sanitize: 'raw', confirmed: true });
    assert.equal(res.ok, true, JSON.stringify(res));
    // Raw keeps the client data:
    assert.ok(scanForValue(dstPath, M.contactName).length > 0, 'raw keeps the contact name');
    assert.ok(scanForValue(dstPath, M.iban).length > 0, 'raw keeps the IBAN');
    // ...but the floor still holds:
    for (const secret of SECRET_MARKERS) {
      assert.deepEqual(scanForValue(dstPath, secret), [], `${secret} must be neutralized even at raw`);
    }
    assert.equal(res.secrets, 'neutralized');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the owner-only retainSecrets override (D-ENV-5 lift) ------------------------------------------

test('copy/retain: the owner-only retainSecrets override keeps secrets, and A24 gates it owner-only', () => {
  // A24: retainSecrets resolves to the owner-only landscape.retain_secrets; without it, landscape.manage.
  assert.deepEqual(requiredCapabilitiesFor('env_copy', { retainSecrets: true }), ['landscape.retain_secrets']);
  assert.deepEqual(requiredCapabilitiesFor('env_copy', {}), ['landscape.manage']);
  assert.deepEqual(requiredCapabilitiesFor('env_copy', { sanitize: 'raw' }), ['landscape.manage']);

  const { dir, deps, dstPath } = scenario();
  try {
    const res = envCopy(deps, { source: 'src', target: 'dst', sanitize: 'raw', retainSecrets: true, confirmed: true });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.secrets, 'retained_owner_override');
    // With the floor lifted, the raw clone retains the secrets (the full-fidelity debug case).
    assert.ok(scanForValue(dstPath, M.keyRef).length > 0, 'retainSecrets keeps the EBICS key_ref');
    assert.ok(scanForValue(dstPath, M.consentRef).length > 0, 'retainSecrets keeps the managed consent_ref');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- H-TENANT: a mandate-scoped copy touches ONLY that workspace ----------------------------------

test('copy/tenant: a mandate-scoped copy touches only its workspace; others in the target are untouched', () => {
  const KEEPER = 'ZZQKEEPER_untouched_contact';
  const keeperSeeder = (path) => {
    const store = new SqliteStore({ location: path });
    const created = createWorkspace({ store, clock: { now: () => '2026-02-02T00:00:00.000Z' }, ids: systemIdGen, actor: 'seed' }, { name: 'Keeper Workspace' });
    const wsId = created.workspaceId;
    store.db.prepare('INSERT INTO contact (id, workspace_id, party_role, name, created_at, kind) VALUES (?,?,?,?,?,?)').run(
      systemIdGen.next('contact'), wsId, 'customer', KEEPER, '2026-02-02T00:00:00.000Z', 'company',
    );
    store.close();
  };
  const { dir, deps, srcPath, dstPath } = scenario({ targetSeed: keeperSeeder });
  try {
    const srcWs = srcWorkspaceId(srcPath);
    const res = envCopy(deps, { source: 'src', target: 'dst', scope: `mandate:${srcWs}`, sanitize: 'pseudonymize', confirmed: true });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.summary.workspacesCopied, 1, 'only the one mandate was copied');
    // The pre-existing workspace`s contact is byte-untouched:
    assert.ok(scanForValue(dstPath, KEEPER).length > 0, 'the keeper workspace contact must be untouched');
    // The copied mandate is present but masked (its source name gone):
    assert.deepEqual(scanForValue(dstPath, M.contactName), [], 'the copied mandate is pseudonymized');
    const store = new SqliteStore({ location: dstPath });
    try {
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n, 2, 'keeper + the copied mandate');
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- build-then-swap: a failed copy leaves the prior target intact (E2a) ---------------------------

test('copy/forgiveness: a mid-copy failure leaves the prior target intact and selectable', () => {
  const { dir, deps, srcPath, dstPath } = scenario();
  try {
    // First copy succeeds: the target now holds the client data.
    const first = envCopy(deps, { source: 'src', target: 'dst', sanitize: 'raw', confirmed: true });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.ok(scanForValue(dstPath, M.contactName).length > 0, 'target populated by the first copy');

    // Corrupt the SOURCE: unbalance a posted entry so the restore`s pre-commit invariant gate throws.
    // (Drop the source`s own immutability trigger first, since the source is a throwaway fixture here.)
    const s = new SqliteStore({ location: srcPath });
    s.db.exec('DROP TRIGGER IF EXISTS journal_line_no_update_posted');
    s.db.prepare('UPDATE journal_line SET base_credit_minor = base_credit_minor + 1 WHERE base_credit_minor > 0').run();
    s.close();

    // The second copy must FAIL (not throw) and leave the first copy`s target intact.
    const second = envCopy(deps, { source: 'src', target: 'dst', sanitize: 'raw', confirmed: true });
    assert.equal(second.ok, false, `a copy of an unbalanced source must be refused: ${JSON.stringify(second)}`);
    assert.ok(scanForValue(dstPath, M.contactName).length > 0, 'the prior target survives a failed copy');
    assert.equal(existsSync(dstPath + '.building'), false, 'no half-written .building file is left behind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- idempotence: re-running yields an independent, re-minted clone (no doubling) ------------------

test('copy/idempotence: re-running an instance copy yields one re-minted clone, not a doubled ledger', () => {
  const { dir, deps, srcPath, dstPath } = scenario();
  try {
    const srcWs = srcWorkspaceId(srcPath);
    envCopy(deps, { source: 'src', target: 'dst', sanitize: 'raw', confirmed: true });
    const second = envCopy(deps, { source: 'src', target: 'dst', sanitize: 'raw', confirmed: true });
    assert.equal(second.ok, true, JSON.stringify(second));
    const store = new SqliteStore({ location: dstPath });
    try {
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n, 1, 'exactly one workspace (rebuilt, not appended)');
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry').get().n, 1, 'one posted entry, not doubled');
      const tgtWs = store.db.prepare('SELECT id FROM workspace LIMIT 1').get().id;
      assert.notEqual(tgtWs, srcWs, 'the workspace id is re-minted, not copied verbatim');
      // The re-minted ledger still balances.
      const sums = store.db.prepare("SELECT COALESCE(SUM(base_debit_minor),0) d, COALESCE(SUM(base_credit_minor),0) c FROM journal_line").get();
      assert.equal(sums.d, sums.c, 'the copied ledger balances');
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- tier rank + target=main refusals (finding #10, E7) -------------------------------------------

test('copy/tier-rank: env_copy refuses a source at or below the target rank, and refuses target=main', () => {
  const { dir, deps } = scenario({ sourceRank: 40, targetRank: 250 });
  try {
    // Source (40) is BELOW target (250): a lateral/up copy is refused.
    const up = envCopy(deps, { source: 'src', target: 'dst', sanitize: 'raw', confirmed: true });
    assert.equal(up.ok, false);
    assert.equal(up.error, 'copy_not_down', JSON.stringify(up));

    // target = main is refused categorically (main is protected against copy INTO).
    const intoMain = envCopy(deps, { source: 'src', target: 'main', sanitize: 'raw', confirmed: true });
    assert.equal(intoMain.ok, false);
    assert.equal(intoMain.error, 'environment_protected', JSON.stringify(intoMain));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- cross-channel: refuse when the source schema generation is newer than the target (finding #6) --

test('copy/cross-channel: a source whose schema generation is newer than the target is refused', () => {
  const { dir, deps, srcPath } = scenario();
  try {
    // Bump the source db`s stored generation beyond this build.
    const s = new SqliteStore({ location: srcPath });
    s.db.pragma('user_version = 999999');
    s.close();
    const res = envCopy(deps, { source: 'src', target: 'dst', sanitize: 'raw', confirmed: true });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'source_schema_newer', JSON.stringify(res));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- P8: an unconfirmed copy returns the plan and changes nothing ---------------------------------

test('copy/p8: an unconfirmed env_copy returns the exact plan and changes nothing', () => {
  const { dir, deps, dstPath } = scenario();
  try {
    const plan = envCopy(deps, { source: 'src', target: 'dst', scope: 'instance', sanitize: 'pseudonymize' });
    assert.equal(plan.ok, true);
    assert.equal(plan.staged, true);
    assert.equal(plan.plan.source, 'src');
    assert.equal(plan.plan.target, 'dst');
    assert.equal(plan.plan.scope, 'instance');
    assert.equal(plan.plan.sanitize, 'pseudonymize');
    assert.equal(plan.plan.secrets, 'neutralized');
    assert.equal(plan.plan.workspacesAffected, 1);
    // Nothing was written: the target still holds only its bootstrap (minimal) content, no copied data.
    const store = new SqliteStore({ location: dstPath });
    try {
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n, 0, 'the unconfirmed plan wrote nothing');
    } finally {
      store.close();
    }
    // And the landscape still records dst as its original synthetic policy (unchanged).
    const file = readLandscape(dir);
    assert.equal(file.environments.dst.data_policy, 'synthetic');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- structure_synthetic: PII gone, amounts replaced, ledger still balances ------------------------

test('copy/structure: structure_synthetic removes all PII, replaces amounts, and keeps the ledger balanced', () => {
  const { dir, deps, dstPath } = scenario();
  try {
    const res = envCopy(deps, { source: 'src', target: 'dst', sanitize: 'structure_synthetic', confirmed: true });
    assert.equal(res.ok, true, JSON.stringify(res));
    for (const pii of PII_MARKERS) {
      assert.deepEqual(scanForValue(dstPath, pii), [], `${pii} must not survive structure_synthetic`);
    }
    const store = new SqliteStore({ location: dstPath });
    try {
      // The chart of accounts survives (structure kept).
      assert.ok(store.db.prepare('SELECT COUNT(*) AS n FROM account').get().n > 0, 'chart of accounts kept');
      // Amounts were replaced (scaled), but every posted entry still balances.
      const line = store.db.prepare('SELECT base_debit_minor d FROM journal_line WHERE base_debit_minor > 0 LIMIT 1').get();
      assert.notEqual(line.d, 12345, 'the source amount was replaced');
      const sums = store.db.prepare("SELECT COALESCE(SUM(base_debit_minor),0) d, COALESCE(SUM(base_credit_minor),0) c FROM journal_line").get();
      assert.equal(sums.d, sums.c, 'the ledger still balances after the synthetic amount scale');
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- env_list still reads after a copy (the landscape records the refresh) -------------------------

test('copy/record: after a copy the target is recorded as a copy-policy env sourced from src', () => {
  const { dir, deps } = scenario();
  try {
    envCopy(deps, { source: 'src', target: 'dst', sanitize: 'pseudonymize', confirmed: true });
    const file = readLandscape(dir);
    assert.equal(file.environments.dst.data_policy, 'copy');
    assert.equal(file.environments.dst.source_env, 'src');
    assert.equal(file.environments.dst.sanitization, 'pseudonymize');
    assert.notEqual(file.environments.dst.last_refresh_at, null);
    // env_list still verifies the (now larger) audit chain and renders.
    const list = envList(deps);
    assert.equal(list.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- FINDING #1 (E8 mandate refresh): a second copy REPLACES, never doubles ------------------------
// A mandate refresh must dedup the prior copy by a STABLE source-provenance key, NOT by the maskable
// workspace.name. Before the fix: pseudonymize/structure_synthetic masked the name, so the refresh`s
// name-match found nothing and restoreBackup APPENDED a duplicate (silent doubling, ok:true); raw threw
// SQLITE_CONSTRAINT_TRIGGER (posted rows deleted without suspending the immutability triggers). This
// test bites at BOTH raw and pseudonymize.

const KEEPER_NAME = 'ZZQKEEPER_untouched_contact';
function keeperSeederFor() {
  return (path) => {
    const store = new SqliteStore({ location: path });
    const created = createWorkspace(
      { store, clock: { now: () => '2026-02-02T00:00:00.000Z' }, ids: systemIdGen, actor: 'seed' },
      { name: 'Keeper Workspace' },
    );
    const wsId = created.workspaceId;
    store.db.prepare('INSERT INTO contact (id, workspace_id, party_role, name, created_at, kind) VALUES (?,?,?,?,?,?)').run(
      systemIdGen.next('contact'), wsId, 'customer', KEEPER_NAME, '2026-02-02T00:00:00.000Z', 'company',
    );
    store.close();
  };
}

for (const level of ['raw', 'pseudonymize']) {
  test(`copy/refresh-twice: a ${level} mandate refresh REPLACES the prior copy (no double, no throw, H-TENANT)`, () => {
    const { dir, deps, srcPath, dstPath } = scenario({ targetSeed: keeperSeederFor() });
    try {
      const srcWs = srcWorkspaceId(srcPath);
      // First copy of the mandate into dst (alongside the keeper workspace).
      const first = envCopy(deps, { source: 'src', target: 'dst', scope: `mandate:${srcWs}`, sanitize: level, confirmed: true });
      assert.equal(first.ok, true, `first copy: ${JSON.stringify(first)}`);

      // REFRESH: a second copy of the SAME source mandate. Must replace, not append.
      const second = envCopy(deps, { source: 'src', target: 'dst', scope: `mandate:${srcWs}`, sanitize: level, confirmed: true });
      assert.equal(second.ok, true, `refresh copy must succeed (not throw / wrong-success): ${JSON.stringify(second)}`);
      assert.equal(second.summary.workspacesCopied, 1, 'the refresh copied exactly the one mandate');

      const store = new SqliteStore({ location: dstPath });
      try {
        // Exactly the keeper + ONE copied mandate: the prior copy was replaced, not doubled.
        assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n, 2, 'keeper + one copied mandate, undoubled');
        assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry').get().n, 1, 'one posted entry, not doubled');
        // Instance-wide money totals are undoubled (the source posted 12345/12345 once).
        const sums = store.db.prepare('SELECT COALESCE(SUM(base_debit_minor),0) d, COALESCE(SUM(base_credit_minor),0) c FROM journal_line').get();
        assert.equal(sums.d, 12345, 'debit total undoubled after the refresh');
        assert.equal(sums.c, 12345, 'credit total undoubled after the refresh');
        assert.equal(sums.d, sums.c, 'the refreshed ledger still balances');
        // H-TENANT: the pre-existing keeper workspace is untouched by the refresh.
        assert.ok(scanForValue(dstPath, KEEPER_NAME).length > 0, 'the keeper workspace survives both copies');
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// --- FINDING #2: a copy is never primed to egress (publishing forced OFF, epoch re-minted) ---------

const SRC_EPOCH = 'ZZQEPOCH_SOURCE_0001';
function publishingSeeder() {
  return (path) => {
    const store = new SqliteStore({ location: path });
    const created = createWorkspace(
      { store, clock: { now: () => '2026-03-03T00:00:00.000Z' }, ids: systemIdGen, actor: 'seed' },
      { name: 'Publishing Workspace' },
    );
    const wsId = created.workspaceId;
    // The source has publishing ON under a live epoch (M02 dial).
    store.db
      .prepare('INSERT INTO sync_publish_state (workspace_id, publishing, epoch, contract_version, enabled_at, enabled_by) VALUES (?,1,?,?,?,?)')
      .run(wsId, SRC_EPOCH, 'v1', '2026-03-03T00:00:00.000Z', 'owner');
    store.close();
  };
}

test('copy/publish-dial: a copy inherits publishing=0 and a re-minted epoch (never egresses under the live epoch)', () => {
  const dir = tmp();
  const seeders = {
    pub: publishingSeeder(),
    minimal: (p) => { const s = new SqliteStore({ location: p }); s.close(); },
  };
  const deps = makeDeps(dir, seeders);
  try {
    assert.equal(envCreate(deps, { name: 'src', policy: 'synthetic', seed: 'pub', tierRank: 250, confirmed: true }).ok, true);
    assert.equal(envCreate(deps, { name: 'dst', policy: 'synthetic', seed: 'minimal', tierRank: 40, confirmed: true }).ok, true);
    const srcPath = join(dir, 'environments', 'src', 'till.db');
    const dstPath = join(dir, 'environments', 'dst', 'till.db');

    // Sanity: the source really is publishing under SRC_EPOCH, so the assertions below bite.
    const src = new SqliteStore({ location: srcPath });
    let srcState;
    try {
      srcState = src.db.prepare('SELECT publishing, epoch FROM sync_publish_state LIMIT 1').get();
    } finally {
      src.close();
    }
    assert.equal(srcState.publishing, 1, 'source publishing is ON for the test to bite');
    assert.equal(srcState.epoch, SRC_EPOCH);

    const res = envCopy(deps, { source: 'src', target: 'dst', sanitize: 'raw', confirmed: true });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.summary.publishWorkspacesReset, 1, 'the copied workspace`s dial was reset');
    assert.equal(res.summary.publishEpochsReminted, 1, 'the copied workspace`s epoch was re-minted');

    const dst = new SqliteStore({ location: dstPath });
    try {
      const state = dst.db.prepare('SELECT publishing, epoch FROM sync_publish_state LIMIT 1').get();
      assert.ok(state, 'the copy carries the (reset) publish-state row');
      assert.equal(state.publishing, 0, 'the copy must NOT inherit an enabled egress dial');
      assert.notEqual(state.epoch, SRC_EPOCH, 'the copy must NOT carry the source live epoch');
      assert.notEqual(state.epoch, null, 'a workspace that had a stream keeps a (fresh) epoch');
    } finally {
      dst.close();
    }

    // The SOURCE is never mutated: it still publishes under its original epoch.
    const src2 = new SqliteStore({ location: srcPath });
    try {
      const after = src2.db.prepare('SELECT publishing, epoch FROM sync_publish_state LIMIT 1').get();
      assert.equal(after.publishing, 1, 'the source dial is untouched');
      assert.equal(after.epoch, SRC_EPOCH, 'the source epoch is untouched');
    } finally {
      src2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- FINDING #3: the shipped copy target retains the posted-immutability triggers ------------------

test('copy/immutability-triggers: the copied target keeps all five posted_immutable triggers', () => {
  const { dir, deps, dstPath } = scenario();
  try {
    const res = envCopy(deps, { source: 'src', target: 'dst', sanitize: 'raw', confirmed: true });
    assert.equal(res.ok, true, JSON.stringify(res));
    const expected = [
      'journal_entry_no_update_posted',
      'journal_entry_no_delete_posted',
      'journal_line_no_insert_posted',
      'journal_line_no_update_posted',
      'journal_line_no_delete_posted',
    ];
    const store = new SqliteStore({ location: dstPath });
    try {
      const present = new Set(
        store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((r) => r.name),
      );
      for (const t of expected) {
        assert.ok(present.has(t), `the copy target must retain the ${t} trigger (append-only ledger)`);
      }
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
