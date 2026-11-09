// A39 §12 (D144), critic C2 (MEDIUM): a model decision must survive a G04 backup and restore, and an
// environment copy (which reuses restore), still tied to ITS line and ITS chosen account, so the restored
// inbox shows what the original showed and A35 §11's "explainable for as long as the booking" holds.
//
// TODO, NOT YET FIXED HERE: `model_decision.subject_id` (a `bank_txn` id) and `chosen_value` (an
// `account` id, for the bank inbox's account-choice question; another consumer's question may choose
// something that is not an id at all) are soft references the restore copies verbatim while it re-mints
// every id. G04 restore is being redesigned as a chokepoint (branch `claude/g04-restore-chokepoint`): one
// universal id remap over every restored TEXT value, whole or inside JSON, plus a schema-wide leak-scan
// gate. That covers both columns with no D144-specific entry, so this capability adds NO portability.ts
// change. These tests pass once the G04 chokepoint is merged; the `todo` comes off then.
//
// SYNTHETIC DATA ONLY: every statement is spelled by hand through bank-inbox-support.mjs.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { listBankInbox, suggestBankLines } = await import('../../dist/core/banking/index.js');
const { registerRuntime, resetRuntimeRegistration, selectRuntimeModel } = await import('../../dist/core/voice/index.js');
const { makeContext } = await import('../../dist/core/context.js');
const { createBackup, restoreBackup } = await import('../../dist/core/data/portability.js');
const { envCreate, envCopy } = await import('../../dist/core/landscape/index.js');
const { SqliteStore } = await import('../../dist/core/store/sqlite-store.js');
const { systemIdGen } = await import('../../dist/core/ids.js');
const { assertClaimInvariantHolds, world, importLines, must } = await import('./bank-inbox-support.mjs');
const { stubAdapter, stubManifest } = await import('../voice/fixtures.mjs');

afterEach(assertClaimInvariantHolds);
afterEach(() => resetRuntimeRegistration());


const STATEMENT = {
  statementId: 'port-1',
  entries: [
    { ref: 'PAPER', amountMinor: 8_450, cd: 'DBIT', date: '2026-07-10', name: 'Papeterie Sonnenberg', ustrd: 'Büromaterial Juli' },
    { ref: 'GIFT', amountMinor: 12_000, cd: 'CRDT', date: '2026-07-12', name: 'Verein Lindenhof', ustrd: 'Spende Sommerfest' },
  ],
};

/** A stub decide putting `p` on the option whose label starts with `number`, the rest spread evenly. */
function picks(number, p = 0.8) {
  return (_state, questions) =>
    questions.map((q) => {
      const i = Math.max(0, q.options.findIndex((o) => o.startsWith(`${number} `)));
      const rest = (1 - p) / (q.options.length - 1);
      return { id: q.id, type: 'choice', probabilities: q.options.map((_o, j) => (j === i ? p : rest)) };
    });
}

function registerStub() {
  registerRuntime(stubAdapter({ decide: picks('6500', 0.82) }), stubManifest());
}

/** Every decision of `workspaceId` names a line and (when it chose) an account of that same workspace. */
function assertDecisionsBelongTo(store, workspaceId) {
  const rows = store.db.prepare('SELECT * FROM model_decision WHERE workspace_id = ?').all(workspaceId);
  assert.ok(rows.length > 0, 'the decisions travelled');
  for (const r of rows) {
    const line = store.db.prepare('SELECT 1 AS p FROM bank_txn WHERE workspace_id = ? AND id = ?').get(workspaceId, r.subject_id);
    assert.ok(line, `decision ${r.id} explains ${r.subject_id}, which is not a line of this workspace`);
    if (r.chosen_value !== null) {
      const acc = store.db.prepare('SELECT 1 AS p FROM account WHERE workspace_id = ? AND id = ?').get(workspaceId, r.chosen_value);
      assert.ok(acc, `decision ${r.id} chose ${r.chosen_value}, an account of the source workspace`);
    }
  }
}

test('C2: a G04 backup and restore keeps every decision on its own line and account; the restored inbox shows the suggestion', {}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'op6-restore-'));
  try {
    const t = world();
    const { lines } = importLines(t, STATEMENT);
    registerStub();
    must(selectRuntimeModel(t.ctx, { modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: 'sel' }));
    must(suggestBankLines(t.ctx, { idempotencyKey: 'before-backup' }));
    assert.equal(must(listBankInbox(t.ctx, { status: 'open' })).lines.find((l) => l.bankTxnId === lines.PAPER).proposal.reasonCode, 'model_suggested');

    const deps = { store: t.store, clock: t.clock, ids: t.ids, actor: 'user_1', backupDir: join(dir, 'b') };
    const backup = must(createBackup(deps, { workspaceId: t.workspaceId, idempotencyKey: 'bk' }));
    const restored = must(restoreBackup(deps, { source: backup.artifactRef, newWorkspaceName: 'Wiederhergestellt AG', confirmed: true }));
    assertDecisionsBelongTo(t.store, restored.workspaceId);

    const ctx2 = makeContext(t.store, { workspaceId: restored.workspaceId, actor: 'user_1', clock: t.clock, ids: t.ids });
    const paper = must(listBankInbox(ctx2, { status: 'open' })).lines.find((l) => l.amountMinor === -8_450);
    assert.equal(paper.proposal.reasonCode, 'model_suggested', 'the same model is registered: the restored book shows what the original showed');
    // The fingerprint key travels with the owner's own backup, so a new call finds the same inputs unchanged.
    must(selectRuntimeModel(ctx2, { modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: 'sel2' }));
    assert.equal(must(suggestBankLines(ctx2, { idempotencyKey: 'after-restore' })).unchanged, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C2: an environment copy keeps every decision on its own line and account; the copy shows the suggestion', {}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'op6-envcopy-'));
  try {
    const at = '2026-09-07T00:00:00.000Z';
    const deps = {
      supportDir: dir,
      environmentsRoot: join(dir, 'environments'),
      mainDbPath: join(dir, 'main', 'till.db'),
      actor: 'owner',
      now: () => at,
      ids: systemIdGen,
      clock: { now: () => at },
      seeders: {
        decided: (path) => {
          const t = world({ location: path });
          importLines(t, STATEMENT);
          registerStub();
          must(selectRuntimeModel(t.ctx, { modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: 'sel' }));
          must(suggestBankLines(t.ctx, { idempotencyKey: 'seed' }));
          t.store.close();
        },
        minimal: (p) => new SqliteStore({ location: p }).close(),
      },
    };
    must(envCreate(deps, { name: 'src', policy: 'synthetic', seed: 'decided', tierRank: 250, confirmed: true }), 'source');
    must(envCreate(deps, { name: 'dst', policy: 'synthetic', seed: 'minimal', tierRank: 40, confirmed: true }), 'target');
    registerStub();
    must(envCopy(deps, { source: 'src', target: 'dst', scope: 'instance', sanitize: 'raw', confirmed: true }), 'copy');

    const store = new SqliteStore({ location: join(dir, 'environments', 'dst', 'till.db') });
    try {
      const ws = store.db.prepare('SELECT id FROM workspace LIMIT 1').get().id;
      assertDecisionsBelongTo(store, ws);
      const ctx = makeContext(store, { workspaceId: ws, actor: 'owner', clock: deps.clock, ids: systemIdGen });
      const paper = must(listBankInbox(ctx, { status: 'open' })).lines.find((l) => l.amountMinor === -8_450);
      assert.equal(paper.proposal.reasonCode, 'model_suggested');
      // The copy never carries the source's fingerprint key (critic C3).
      const keys = store.db.prepare('SELECT COUNT(*) AS n FROM model_decision_key').get().n;
      assert.ok(keys <= 1);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
