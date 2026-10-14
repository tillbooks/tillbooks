// Critic round 2 (non-author) of D144 on `claude/op6-decide` @ af26eabc: probes of the round-1 FIXES,
// aimed at what a fix can newly break. The fingerprint key's lifecycle (minted only when a row is
// recorded, never in a payload, per workspace, gone with a hard delete, randomised by the real env_copy
// path, and pseudonymize holding even when the key is retained), the C1 batch with named ids and
// permissions, the C4 mask against references and amounts, and the C9 guard against a file-level link.
//
// SYNTHETIC DATA ONLY: every statement, name, IBAN and reference below is invented here or is the
// published sample the support file already uses.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installEgressProbe } from '../mail/egress-probe.mjs';

const probe = installEgressProbe();

const { listBankInbox, bookBankLine, suggestBankLines, bankLineDecisionState, createBankAccount } = await import('../../dist/core/banking/index.js');
const { maskIbans } = await import('../../dist/core/banking/bankModelRung.js');
const { registerRuntime, resetRuntimeRegistration, selectRuntimeModel, readDecisionKey, decisionFingerprint } = await import('../../dist/core/voice/index.js');
const { makeContext } = await import('../../dist/core/context.js');
const { ok, err } = await import('../../dist/core/result.js');
const { hardDeleteWorkspace } = await import('../../dist/core/migration/index.js');
const { applySanitization } = await import('../../dist/core/landscape/sanitize.js');
const { envCreate, envCopy } = await import('../../dist/core/landscape/index.js');
const { SqliteStore } = await import('../../dist/core/store/sqlite-store.js');
const { systemIdGen } = await import('../../dist/core/ids.js');
const { run: runEval } = await import('../../scripts/eval/decide-eval.mjs');
const { cleanGitEnv, TEMP_REPO_GIT } = await import('../lib/git-env.mjs');
const { assertClaimInvariantHolds, world, importLines, must, refused, secondWorkspace, MAIN_IBAN } = await import('./bank-inbox-support.mjs');
const { stubAdapter, stubManifest } = await import('../voice/fixtures.mjs');

afterEach(assertClaimInvariantHolds);
afterEach(() => resetRuntimeRegistration());

const STATEMENT = {
  statementId: 'r2-1',
  entries: [
    { ref: 'PAPER', amountMinor: 8_450, cd: 'DBIT', date: '2026-07-10', name: 'Papeterie Sonnenberg', ustrd: 'Büromaterial Juli' },
    { ref: 'GIFT', amountMinor: 12_000, cd: 'CRDT', date: '2026-07-12', name: 'Verein Lindenhof', ustrd: 'Spende Sommerfest' },
  ],
};

function picks(number, p = 0.8) {
  return (_state, questions) =>
    questions.map((q) => {
      const i = Math.max(0, q.options.findIndex((o) => o.startsWith(`${number} `)));
      const rest = (1 - p) / (q.options.length - 1);
      return { id: q.id, type: 'choice', probabilities: q.options.map((_o, j) => (j === i ? p : rest)) };
    });
}

function register(ctx, { select = true } = {}) {
  registerRuntime(stubAdapter({ decide: picks('6500') }), stubManifest());
  if (select) must(selectRuntimeModel(ctx, { modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: `sel-${Math.random()}` }), 'select');
}

const keyRows = (store, ws) => store.db.prepare('SELECT * FROM model_decision_key WHERE workspace_id = ?').all(ws);
const decisionCount = (store, ws) => store.db.prepare('SELECT COUNT(*) AS n FROM model_decision WHERE workspace_id = ?').get(ws).n;

function withGuardsLifted(db, fn) {
  const saved = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL").all().filter((r) => /RAISE\s*\(\s*ABORT/i.test(r.sql));
  for (const r of saved) db.exec(`DROP TRIGGER IF EXISTS "${r.name}"`);
  try {
    return fn();
  } finally {
    for (const r of saved) db.exec(r.sql);
  }
}

// --- C3: the fingerprint key's lifecycle -----------------------------------------------------------

test('R2 C3: no key is minted by a refusal, a permission denial or a call that records nothing', () => {
  const t = world();
  const { lines } = importLines(t, STATEMENT);
  register(t.ctx, { select: false });
  refused(suggestBankLines(t.ctx, { idempotencyKey: 'no-sel' }), 'needs_model_selection');
  assert.deepEqual(keyRows(t.store, t.workspaceId), [], 'a refusal mints nothing');

  register(t.ctx);
  const noPost = makeContext(t.store, {
    workspaceId: t.workspaceId,
    actor: 'viewer_1',
    clock: t.clock,
    ids: t.ids,
    capabilities: { assert: (cap) => (cap === 'post' ? err('permission_denied', { capability: cap }) : ok()) },
  });
  refused(suggestBankLines(noPost, { idempotencyKey: 'no-post' }), 'permission_denied');
  refused(suggestBankLines(noPost, { bankTxnIds: [lines.PAPER], idempotencyKey: 'no-post-ids' }), 'permission_denied');
  assert.deepEqual(keyRows(t.store, t.workspaceId), [], 'a denied seat mints nothing');
  assert.equal(decisionCount(t.store, t.workspaceId), 0);

  // Both lines booked: the call is ok and records nothing, so it mints nothing either.
  must(bookBankLine(t.ctx, { bankTxnId: lines.PAPER, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 8_450 }] }, idempotencyKey: 'b1' }));
  must(bookBankLine(t.ctx, { bankTxnId: lines.GIFT, target: { kind: 'accounts', legs: [{ accountId: t.acc('3000'), amountMinor: 12_000 }] }, idempotencyKey: 'b2' }));
  const empty = must(suggestBankLines(t.ctx, { bankTxnIds: [lines.PAPER, lines.GIFT], idempotencyKey: 'nothing' }));
  assert.equal(empty.considered, 0);
  assert.deepEqual(keyRows(t.store, t.workspaceId), [], 'nothing recorded, nothing minted');
});

test('R2 C3: the key is per workspace, never in a payload or a memo, and leaves with a hard delete', () => {
  const t = world();
  const { lines } = importLines(t, STATEMENT);
  register(t.ctx);
  const res = must(suggestBankLines(t.ctx, { idempotencyKey: 'k' }));
  const [keyA] = keyRows(t.store, t.workspaceId);
  assert.match(keyA.secret, /^[0-9a-f]{64}$/);
  const inbox = must(listBankInbox(t.ctx, { status: 'all' }));
  const memos = t.store.db.prepare('SELECT result_json FROM idempotency WHERE workspace_id = ?').all(t.workspaceId).map((r) => r.result_json).join('\n');
  const decisions = JSON.stringify(t.store.db.prepare('SELECT * FROM model_decision WHERE workspace_id = ?').all(t.workspaceId));
  for (const [where, text] of [['suggest result', JSON.stringify(res)], ['list_bank_inbox', JSON.stringify(inbox)], ['idempotency memos', memos], ['model_decision rows', decisions]]) {
    assert.equal(text.includes(keyA.secret), false, `the key leaks through ${where}`);
  }
  // The stored fingerprint is the HMAC under THIS key, so the dedupe of the next call works.
  const row = t.store.db.prepare('SELECT * FROM bank_txn WHERE id = ?').get(lines.PAPER);
  const detail = t.store.db.prepare('SELECT * FROM bank_txn_detail WHERE bank_txn_id = ?').get(lines.PAPER);
  const d = t.store.db.prepare('SELECT input_sha256, questions_json FROM model_decision WHERE subject_id = ?').get(lines.PAPER);
  assert.equal(d.input_sha256, decisionFingerprint(keyA.secret, bankLineDecisionState(row, detail), JSON.parse(d.questions_json)));

  // A neighbour mints its own key; the same facts fingerprint differently across the wall.
  const b = secondWorkspace(t);
  must(createBankAccountFor(b));
  importLines(t, { ...STATEMENT, statementId: 'r2-b' }, { ctx: b.ctx, bankAccountId: b.bankAccountId, key: 'imp-b' });
  must(selectRuntimeModel(b.ctx, { modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: 'sel-b' }));
  must(suggestBankLines(b.ctx, { idempotencyKey: 'kb' }));
  const [keyB] = keyRows(t.store, b.workspaceId);
  assert.notEqual(keyB.secret, keyA.secret, 'one key per workspace');
  assert.equal(readDecisionKey(b.ctx), keyB.secret);

  t.store.tx(() => hardDeleteWorkspace(t.ctx, t.workspaceId));
  assert.deepEqual(keyRows(t.store, t.workspaceId), [], 'the key leaves with its workspace');
  assert.equal(keyRows(t.store, b.workspaceId).length, 1, 'the neighbour keeps its own');
});

/** A Bankkonto for the second workspace (the support helper only builds one for the first). */
function createBankAccountFor(b) {
  const r = createBankAccount(b.ctx, { name: 'Konto B', iban: MAIN_IBAN, currency: 'CHF', ledgerAccountId: b.bankId, idempotencyKey: 'ib-b' });
  if (r.ok) b.bankAccountId = r.bankAccountId;
  return r;
}

test('R2 C3: pseudonymize holds even when the copy RETAINS the key (the owner-only retainSecrets override)', () => {
  const t = world();
  const { lines } = importLines(t, {
    statementId: 'retain',
    entries: [{ ref: 'CARD', amountMinor: 4_590, cd: 'DBIT', date: '2026-07-15', name: 'Blumenladen Aurora Seefeld' }],
  });
  register(t.ctx);
  must(suggestBankLines(t.ctx, { idempotencyKey: 'rt' }));
  // retainSecrets: the secret floor does NOT run, only the sanitization.
  withGuardsLifted(t.store.db, () => applySanitization(t.store.db, { level: 'pseudonymize', workspaceIds: [t.workspaceId] }));
  const key = readDecisionKey(t.ctx);
  assert.ok(key, 'the key was retained');
  const row = t.store.db.prepare('SELECT * FROM bank_txn WHERE id = ?').get(lines.CARD);
  const detail = t.store.db.prepare('SELECT * FROM bank_txn_detail WHERE bank_txn_id = ?').get(lines.CARD);
  const d = t.store.db.prepare('SELECT input_sha256, questions_json FROM model_decision WHERE subject_id = ?').get(lines.CARD);
  const questions = JSON.parse(d.questions_json);
  const dictionary = ['Migros', 'Coop City', 'Blumenladen Aurora Seefeld', 'Garage Brunner'];
  const hit = dictionary.filter((name) => decisionFingerprint(key, bankLineDecisionState(row, { ...detail, counterparty_name: name }), questions) === d.input_sha256);
  assert.deepEqual(hit, [], 'with the key in hand, the copy still confirms no guessed name');
});

test('R2 C3: the real env_copy path randomises the key and never carries a source fingerprint into a pseudonymized copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'op6-r2-envcopy-'));
  try {
    const at = '2026-09-07T00:00:00.000Z';
    let sourceKey;
    let sourceFingerprints = [];
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
          register(t.ctx);
          must(suggestBankLines(t.ctx, { idempotencyKey: 'seed' }));
          sourceKey = readDecisionKey(t.ctx);
          sourceFingerprints = t.store.db.prepare('SELECT input_sha256 AS f FROM model_decision').all().map((r) => r.f);
          t.store.close();
        },
        minimal: (p) => new SqliteStore({ location: p }).close(),
      },
    };
    must(envCreate(deps, { name: 'src', policy: 'synthetic', seed: 'decided', tierRank: 250, confirmed: true }), 'source');
    must(envCreate(deps, { name: 'raw', policy: 'synthetic', seed: 'minimal', tierRank: 40, confirmed: true }), 'raw target');
    must(envCreate(deps, { name: 'pseudo', policy: 'synthetic', seed: 'minimal', tierRank: 30, confirmed: true }), 'pseudo target');
    must(envCopy(deps, { source: 'src', target: 'raw', scope: 'instance', sanitize: 'raw', confirmed: true }), 'raw copy');
    must(envCopy(deps, { source: 'src', target: 'pseudo', scope: 'instance', sanitize: 'pseudonymize', confirmed: true }), 'pseudo copy');
    assert.ok(sourceKey && sourceFingerprints.length === 2);
    for (const name of ['raw', 'pseudo']) {
      const store = new SqliteStore({ location: join(dir, 'environments', name, 'till.db') });
      try {
        const keys = store.db.prepare('SELECT secret FROM model_decision_key').all().map((r) => r.secret);
        assert.equal(keys.length, 1, `${name}: the key row travels`);
        assert.notEqual(keys[0], sourceKey, `${name}: randomised, never the source key`);
        assert.match(keys[0], /^[0-9a-f]{64}$/, `${name}: still a usable 256-bit key`);
        if (name === 'pseudo') {
          const copied = store.db.prepare('SELECT input_sha256 AS f FROM model_decision').all().map((r) => r.f);
          assert.equal(copied.length, 2);
          assert.equal(copied.some((f) => sourceFingerprints.includes(f)), false, 'no source fingerprint survives pseudonymize');
        }
      } finally {
        store.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- C1: named ids, the cap, permissions -----------------------------------------------------------

test('R2 C1: a page of named ids is worked through in batches of 50; a foreign id moves nothing', () => {
  const t = world();
  const entries = Array.from({ length: 120 }, (_, i) => ({
    ref: `N${String(i).padStart(3, '0')}`,
    amountMinor: 3_000 + i,
    cd: 'DBIT',
    date: `2026-07-${String(1 + (i % 28)).padStart(2, '0')}`,
    name: `Lieferant Seite ${i}`,
  }));
  const { lines } = importLines(t, { statementId: 'page', entries });
  const ids = Object.values(lines);
  assert.equal(ids.length, 120);
  register(t.ctx);
  const first = must(suggestBankLines(t.ctx, { bankTxnIds: [...ids, ids[0]], idempotencyKey: 'p1' }));
  assert.deepEqual([first.considered, first.remaining], [50, 70]);
  const second = must(suggestBankLines(t.ctx, { bankTxnIds: ids, idempotencyKey: 'p2' }));
  assert.deepEqual([second.considered, second.unchanged, second.remaining], [100, 50, 20]);
  const third = must(suggestBankLines(t.ctx, { bankTxnIds: ids, idempotencyKey: 'p3' }));
  assert.deepEqual([third.unchanged, third.remaining], [100, 0]);
  assert.equal(decisionCount(t.store, t.workspaceId), 120);

  const b = secondWorkspace(t);
  const before = decisionCount(t.store, t.workspaceId);
  refused(suggestBankLines(t.ctx, { bankTxnIds: [...ids.slice(0, 199), 'btxn_elsewhere'], idempotencyKey: 'foreign' }), 'not_found');
  refused(suggestBankLines(b.ctx, { bankTxnIds: ids.slice(0, 200), idempotencyKey: 'from-b' }), 'not_found');
  assert.equal(decisionCount(t.store, t.workspaceId), before);
  assert.deepEqual(keyRows(t.store, b.workspaceId), [], 'the neighbour minted nothing');
});

// --- C4: the mask against what must survive it ------------------------------------------------------

test('R2 C4: the IBAN mask keeps references, amounts and dates, and masks every spacing and case of an IBAN', () => {
  const keep = [
    'RF18 5390 0754 7034',
    'rf18 5390 0754 7034',
    'RF18539007547034',
    '21 00000 00003 13947 14300 09017',
    '210000000003139471430009017',
    "CHF 1'234.50",
    'EUR 12 345.00',
    'Betrag 8450.00 per 31.07.2026',
    'Rechnung 2026-0034, Kunde 100234, Auftrag 55501234',
    'UID CHE-123.456.789 MWST',
  ];
  for (const s of keep) assert.equal(maskIbans(s), s, `must survive: ${s}`);
  const mask = [
    ['Kaution CH93 0076 2011 6238 5295 7 zurück', 'Kaution [IBAN] zurück'],
    ['ch9300762011623852957', '[IBAN]'],
    ['IBAN:CH9300762011623852957.', 'IBAN:[IBAN].'],
    ['an DE89 3704 0044 0532 0130 00 bis 31.07.', 'an [IBAN] bis 31.07.'],
    ['LI21 0881 0000 2324 013A A', '[IBAN]'],
  ];
  for (const [s, want] of mask) assert.equal(maskIbans(s), want, `must mask: ${s}`);
});

// --- C9: a link at the FILE level, below the judged directory ----------------------------------------

test('R2 C9: the harness never writes through a result FILE that links into a committable directory', async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'op6-r2-eval-')));
  try {
    const env = cleanGitEnv(TEMP_REPO_GIT);
    execFileSync('git', ['init', '-q', repo], { env });
    writeFileSync(join(repo, '.gitignore'), 'private/\n');
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'docs', 'readme.md'), 'tracked\n');
    execFileSync('git', ['-C', repo, 'add', '.gitignore', 'docs/readme.md'], { env });
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'seed'], { env });
    mkdirSync(join(repo, 'private', 'out'), { recursive: true });
    writeFileSync(join(repo, 'private', 'set.jsonl'), `${JSON.stringify({ id: 'r1', state: 'Kiosk', options: ['a', 'b'], answer: 0 })}\n`);
    // The directory is a real, ignored one; the result FILE inside it is a link into docs/.
    symlinkSync(join(repo, 'docs', 'metrics.json'), join(repo, 'private', 'out', 'metrics.json'));
    let refusedRun = false;
    try {
      await runEval(['--data', join(repo, 'private', 'set.jsonl'), '--out', join(repo, 'private', 'out'), '--baseline', 'uniform']);
    } catch {
      refusedRun = true;
    }
    const leaked = existsSync(join(repo, 'docs', 'metrics.json'));
    const status = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { env, encoding: 'utf8' });
    assert.ok(refusedRun || !leaked, `the harness wrote through private/out/metrics.json into docs/ (git status: ${status.trim()})`);
    if (leaked) assert.ok(readFileSync(join(repo, 'docs', 'metrics.json'), 'utf8').length > 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('R2 OP6: none of the above opened a socket', () => {
  assert.deepEqual(probe.violations, []);
});
