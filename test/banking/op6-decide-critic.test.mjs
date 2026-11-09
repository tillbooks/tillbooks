// Critic (non-author) of D144, the OP6 `decide()` seam and the A39 model rung (`model_suggested`).
// Adversarial tests: each FINDING test fails on the author's branch (claude/op6-decide @ 2580f1c3) and
// names the finding id of docs/critique/op6-decide-critique.md; each COVERAGE test passes there and
// pins an invariant the author's suites did not reach (a mutation of the code makes it fail).
//
// SYNTHETIC DATA ONLY: every statement is spelled by hand through bank-inbox-support.mjs, every name,
// IBAN and remittance text is invented here (TELCO_IBAN is the support file's invented number).

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installEgressProbe } from '../mail/egress-probe.mjs';

const probe = installEgressProbe();

const {
  listBankInbox,
  bookBankLine,
  suggestBankLines,
  reviewBankTxn,
  bankLineCandidates,
  modelCandidateBase,
  bankLineDecisionState,
} = await import('../../dist/core/banking/index.js');
const { registerRuntime, resetRuntimeRegistration, selectRuntimeModel, decide, decisionInputSha256, recordModelDecision } = await import('../../dist/core/voice/index.js');
const { updateAccount } = await import('../../dist/core/accounts/index.js');
const { hardDeleteWorkspace } = await import('../../dist/core/migration/index.js');
const { makeContext } = await import('../../dist/core/context.js');
const { createBackup, restoreBackup } = await import('../../dist/core/data/portability.js');
const { applySanitization } = await import('../../dist/core/landscape/sanitize.js');
const { run: runEval } = await import('../../scripts/eval/decide-eval.mjs');
const { cleanGitEnv, TEMP_REPO_GIT } = await import('../lib/git-env.mjs');
const { assertClaimInvariantHolds, world, importLines, must, secondWorkspace, TELCO_IBAN } = await import('./bank-inbox-support.mjs');
const { stubAdapter, stubManifest } = await import('../voice/fixtures.mjs');

afterEach(assertClaimInvariantHolds);
afterEach(() => resetRuntimeRegistration());

const STATEMENT = {
  statementId: 'crit-1',
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

function manifest(rowPatch = {}) {
  const rows = stubManifest();
  rows[0] = { ...rows[0], ...rowPatch };
  return rows;
}

function register(t, { decide: fn = picks('6500'), row = {}, adapter = {} } = {}) {
  registerRuntime(stubAdapter({ decide: fn, ...adapter }), manifest(row));
  if (t !== null) must(selectRuntimeModel(t.ctx, { modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: `sel-${Math.random()}` }), 'select');
}

const lineOf = (ctx, id) => must(listBankInbox(ctx, { status: 'open', limit: 200 }), 'list').lines.find((l) => l.bankTxnId === id);
const decisionsOf = (t, ws = t.workspaceId) => t.store.db.prepare('SELECT * FROM model_decision WHERE workspace_id = ? ORDER BY rowid').all(ws);

/** One decision row in `workspaceId`, through the real recorder. */
function recordDecisionFor(t, workspaceId) {
  const ctx = makeContext(t.store, { workspaceId, actor: 'user_2', clock: t.clock, ids: t.ids });
  const q = { id: 'account', type: 'choice', text: 'Welches Konto?', options: ['6500 A', '6570 B'] };
  return recordModelDecision(ctx, {
    consumer: 'bank_inbox',
    subjectKind: 'bank_txn',
    subjectId: 'bt_none',
    runtimeId: 'stub-local',
    modelRef: 'stub-4b-q4',
    modelSha256: 'a'.repeat(64),
    inputSha256: decisionInputSha256('{}', [q]),
    questions: [q],
    answers: [{ id: 'account', type: 'choice', probabilities: [0.6, 0.4] }],
    chosenValue: null,
    chosenProbability: 0.6,
  });
}

/** Run `fn` with every RAISE(ABORT) guard trigger lifted, as `env_copy` does on its building db. */
function withGuardsLifted(db, fn) {
  const saved = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL").all().filter((r) => /RAISE\s*\(\s*ABORT/i.test(r.sql));
  for (const r of saved) db.exec(`DROP TRIGGER IF EXISTS "${r.name}"`);
  try {
    return fn();
  } finally {
    for (const r of saved) db.exec(r.sql);
  }
}

// --- FINDINGS (fail on the author's branch) -------------------------------------------------------

test('OP6-C1 (MEDIUM): suggest_bank_lines reaches the lines beyond its first batch on the next call', () => {
  const t = world();
  const entries = Array.from({ length: 52 }, (_, i) => ({
    ref: `L${String(i).padStart(2, '0')}`,
    amountMinor: 1_000 + i,
    cd: 'DBIT',
    date: `2026-07-${String(1 + (i % 28)).padStart(2, '0')}`,
    name: `Lieferant Nummer ${i}`,
  }));
  importLines(t, { statementId: 'many', entries });
  register(t);
  const first = must(suggestBankLines(t.ctx, { idempotencyKey: 'batch-1' }), 'first call');
  assert.equal(first.considered, 50);
  assert.equal(first.remaining, 2, 'two lines wait for the next call, as the Studio toast tells the person');
  // The Studio says "Weitere 2 Zeilen warten: drück nochmals auf «Konten vorschlagen»". Pressing again:
  const second = must(suggestBankLines(t.ctx, { idempotencyKey: 'batch-2' }), 'second call');
  const decided = new Set(decisionsOf(t).map((r) => r.subject_id));
  assert.equal(
    decided.size,
    52,
    `the second call must decide the 2 waiting lines; it re-walked the first 50 as "unchanged" (unchanged=${second.unchanged}, remaining=${second.remaining})`,
  );
});

// Round 2 (30.09.2026): C2 is a RECORDED DEPENDENCY on the G04 restore id chokepoint (G04 §0c, branch
// `claude/g04-restore-chokepoint`), not a D144 fix: that chokepoint remaps every restored TEXT value that
// names a source id, `subject_id` and `chosen_value` included. `todo` until it merges, then it must pass.

test('OP6-C2 (MEDIUM): a G04 backup and restore keeps every decision tied to its own line and account', {}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'op6-critic-restore-'));
  try {
    const t = world();
    const { lines } = importLines(t, STATEMENT);
    register(t, { decide: picks('6500', 0.82) });
    must(suggestBankLines(t.ctx, { idempotencyKey: 'before-backup' }), 'suggest');
    assert.equal(lineOf(t.ctx, lines.PAPER).proposal.reasonCode, 'model_suggested');

    const deps = { store: t.store, clock: t.clock, ids: t.ids, actor: 'user_1', backupDir: join(dir, 'b') };
    const backup = must(createBackup(deps, { workspaceId: t.workspaceId, idempotencyKey: 'bk' }), 'backup');
    const restored = must(restoreBackup(deps, { source: backup.artifactRef, newWorkspaceName: 'Wiederhergestellt AG', confirmed: true }), 'restore');
    const ws = restored.workspaceId;
    const rows = decisionsOf(t, ws);
    assert.equal(rows.length, 2, 'both decisions travel with the backup');
    for (const r of rows) {
      const line = t.store.db.prepare('SELECT 1 AS p FROM bank_txn WHERE workspace_id = ? AND id = ?').get(ws, r.subject_id);
      assert.ok(line, `the restored decision ${r.id} explains line ${r.subject_id}, which is not a line of the restored workspace (A35 §11: explainable as long as the booking)`);
      if (r.chosen_value !== null) {
        const acc = t.store.db.prepare('SELECT 1 AS p FROM account WHERE workspace_id = ? AND id = ?').get(ws, r.chosen_value);
        assert.ok(acc, `the restored decision chose ${r.chosen_value}, an account of the SOURCE workspace`);
      }
    }
    const ctx2 = makeContext(t.store, { workspaceId: ws, actor: 'user_1', clock: t.clock, ids: t.ids });
    const paper = must(listBankInbox(ctx2, { status: 'open' })).lines.find((l) => l.amountMinor === -8_450);
    assert.equal(paper.proposal.reasonCode, 'model_suggested', 'the same model is registered: the restored book shows what the original showed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OP6-C3 (MEDIUM): a pseudonymized copy keeps no fingerprint that re-identifies the masked counterparty', () => {
  const t = world();
  const { lines } = importLines(t, {
    statementId: 'pseudo',
    entries: [{ ref: 'CARD', amountMinor: 4_590, cd: 'DBIT', date: '2026-07-15', name: 'Blumenladen Aurora Seefeld' }],
  });
  register(t);
  must(suggestBankLines(t.ctx, { idempotencyKey: 'ps' }), 'suggest');
  // What env_copy's `pseudonymize` level does to the copy (D126, landscape/sanitize.ts).
  withGuardsLifted(t.store.db, () => applySanitization(t.store.db, { level: 'pseudonymize', workspaceIds: [t.workspaceId] }));
  const row = t.store.db.prepare('SELECT * FROM bank_txn WHERE id = ?').get(lines.CARD);
  const detail = t.store.db.prepare('SELECT * FROM bank_txn_detail WHERE bank_txn_id = ?').get(lines.CARD);
  assert.notEqual(detail.counterparty_name, 'Blumenladen Aurora Seefeld', 'precondition: the copy masked the name');
  const decision = t.store.db.prepare('SELECT input_sha256, questions_json FROM model_decision WHERE subject_id = ?').get(lines.CARD);
  const questions = JSON.parse(decision.questions_json);
  // An attacker holding only the copy and a list of Swiss business names (Zefix has them all):
  const dictionary = ['Migros', 'Coop City', 'Papeterie Sonnenberg', 'Blumenladen Aurora Seefeld', 'Garage Brunner'];
  const reidentified = dictionary.filter(
    (name) => decisionInputSha256(bankLineDecisionState(row, { ...detail, counterparty_name: name }), questions) === decision.input_sha256,
  );
  assert.deepEqual(reidentified, [], 'input_sha256 is an unsalted hash of the real counterparty: a dictionary recovers it from the pseudonymized copy');
});

test('OP6-C4 (LOW): the state a model reads carries no IBAN, even one quoted in the remittance text', () => {
  const t = world();
  const grouped = TELCO_IBAN.replace(/(.{4})/g, '$1 ').trim();
  const { lines } = importLines(t, {
    statementId: 'iban-in-text',
    entries: [{ ref: 'REFUND', amountMinor: 20_000, cd: 'DBIT', date: '2026-07-18', name: 'Muster Treuhand', ustrd: `Rückzahlung Kaution auf ${grouped}` }],
  });
  const row = t.store.db.prepare('SELECT * FROM bank_txn WHERE id = ?').get(lines.REFUND);
  const detail = t.store.db.prepare('SELECT * FROM bank_txn_detail WHERE bank_txn_id = ?').get(lines.REFUND);
  const state = bankLineDecisionState(row, detail);
  assert.equal(
    state.replace(/\s+/g, '').includes(TELCO_IBAN),
    false,
    `A39 §12 "The model never sees an IBAN"; E05 §10.3 relies on the same builder. State: ${state}`,
  );
});

test('OP6-C5a (LOW): a tie at the floor is not a suggestion', () => {
  const t = world();
  const { lines } = importLines(t, STATEMENT);
  // The model cannot tell the first two candidates apart: 50 % each.
  register(t, { decide: (_s, qs) => qs.map((q) => ({ id: q.id, type: 'choice', probabilities: q.options.map((_o, j) => (j < 2 ? 0.5 : 0)) })) });
  must(suggestBankLines(t.ctx, { idempotencyKey: 'tie' }));
  assert.notEqual(
    lineOf(t.ctx, lines.PAPER).proposal.reasonCode,
    'model_suggested',
    'a coin flip between two accounts is shown as "the model suggests X, 50 % likely"; the argmax merely took the code-ranked first',
  );
});

test('OP6-C5b (LOW): the probability an agent reads on list_bank_inbox never reads 1', () => {
  const t = world();
  const { lines } = importLines(t, STATEMENT);
  register(t, { decide: picks('6500', 0.99996) });
  must(suggestBankLines(t.ctx, { idempotencyKey: 'near-one' }));
  const p = lineOf(t.ctx, lines.PAPER).proposal;
  assert.equal(p.certainty, 'check');
  assert.ok(p.reasonParams.probability < 1, `reasonParams.probability reads ${p.reasonParams.probability}: an agent reads a certainty the Studio caps at 99 %`);
});

test('OP6-C6a (LOW): the one door refuses a sparse distribution', () => {
  const CHOICE = { id: 'account', type: 'choice', text: 'Welches Konto?', options: ['6500 Büromaterial', '6200 Fahrzeugaufwand', '6570 Informatik'] };
  registerRuntime(
    stubAdapter({
      decide: (_s, qs) => {
        const ps = [1];
        ps.length = qs[0].options.length; // [1, <hole>, <hole>]: every() and reduce() skip the holes
        return [{ id: qs[0].id, type: 'choice', probabilities: ps }];
      },
    }),
    stubManifest(),
  );
  const sparse = decide({ state: 'Papeterie', questions: [CHOICE] });
  assert.equal(sparse.ok, false, `a distribution with holes passed the fail-closed check: ${JSON.stringify(sparse)}`);
});

test('OP6-C6b (LOW): an adapter cannot rewrite the options the decision record says it was offered', () => {
  const t = world();
  const { lines } = importLines(t, STATEMENT);
  register(t, {
    decide: (s, qs) => {
      const out = picks('6500', 0.9)(s, qs);
      qs[0].options[1] = '1020 Bank'; // an adapter scribbling on the question it was handed
      return out;
    },
  });
  must(suggestBankLines(t.ctx, { idempotencyKey: 'scribble' }));
  const rec = t.store.db.prepare('SELECT questions_json FROM model_decision WHERE subject_id = ?').get(lines.PAPER);
  const recorded = JSON.parse(rec.questions_json)[0].options;
  assert.equal(recorded.includes('1020 Bank'), false, `the audit record says the model was offered the bank ledger: ${JSON.stringify(recorded)}`);
});

test('OP6-C7 (LOW): the same weights under a renamed ref either show their decision or decide again', () => {
  const t = world();
  const { lines } = importLines(t, STATEMENT);
  register(t, { decide: picks('6500', 0.82) });
  must(suggestBankLines(t.ctx, { idempotencyKey: 'v1' }));
  assert.equal(lineOf(t.ctx, lines.PAPER).proposal.reasonCode, 'model_suggested');
  // The companion renames the row; the pinned sha256 (the weights) is the same.
  registerRuntime(stubAdapter({ decide: picks('6500', 0.82), modelRef: 'stub-4b-q4-v2' }), manifest({ modelRef: 'stub-4b-q4-v2' }));
  const res = must(suggestBankLines(t.ctx, { idempotencyKey: 'v2' }));
  const shown = lineOf(t.ctx, lines.PAPER).proposal.reasonCode;
  assert.ok(
    !(res.suggested > 0 && shown !== 'model_suggested'),
    `suggest reports suggested=${res.suggested} (unchanged=${res.unchanged}) but the line reads ${shown}: findModelDecision keys on the sha, the rung on ref + sha`,
  );
});

test('OP6-C8 (LOW): a model guess does not switch off the A36 human-review signal of a line', () => {
  const t = world();
  const { lines } = importLines(t, STATEMENT);
  const before = must(reviewBankTxn(t.ctx, { bankTxnId: lines.PAPER, idempotencyKey: 'rv-before' })).needsReview;
  assert.equal(before, true, 'precondition: an unplaced line needs review');
  register(t, { decide: picks('6500', 0.55) });
  must(suggestBankLines(t.ctx, { idempotencyKey: 'rv' }));
  const after = must(reviewBankTxn(t.ctx, { bankTxnId: lines.PAPER, idempotencyKey: 'rv-after' })).needsReview;
  assert.equal(after, true, 'nobody checked the model\'s 55 % guess, yet bank_txn.needs_review no longer fires for the line');
});

test('OP6-C9 (LOW): the evaluation harness never writes through a symlink into an un-ignored directory', async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'op6-critic-eval-')));
  try {
    const env = cleanGitEnv(TEMP_REPO_GIT);
    execFileSync('git', ['init', '-q', repo], { env });
    writeFileSync(join(repo, '.gitignore'), 'private/\n');
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'docs', 'readme.md'), 'tracked\n');
    execFileSync('git', ['-C', repo, 'add', '.gitignore', 'docs/readme.md'], { env });
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'seed'], { env });
    mkdirSync(join(repo, 'private'));
    writeFileSync(join(repo, 'private', 'set.jsonl'), `${JSON.stringify({ id: 'r1', state: 'Kiosk', options: ['a', 'b'], answer: 0 })}\n`);
    // An ignored name that is a link into the tracked tree.
    symlinkSync(join(repo, 'docs'), join(repo, 'private', 'out'));
    let refused = false;
    try {
      await runEval(['--data', join(repo, 'private', 'set.jsonl'), '--out', join(repo, 'private', 'out'), '--baseline', 'uniform']);
    } catch {
      refused = true;
    }
    const leaked = existsSync(join(repo, 'docs', 'metrics.json'));
    const status = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { env, encoding: 'utf8' });
    assert.ok(refused || !leaked, `the harness wrote into docs/ (git status: ${status.trim()}), a path git would commit`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('OP6-C10 (LOW): a decision is not shown under a label the model never scored', () => {
  const t = world();
  const { lines } = importLines(t, STATEMENT);
  register(t, { decide: picks('6500', 0.82) });
  must(suggestBankLines(t.ctx, { idempotencyKey: 'label' }));
  assert.equal(lineOf(t.ctx, lines.PAPER).proposal.reasonCode, 'model_suggested');
  // The account the model chose is repurposed: same id, same number, another meaning.
  must(updateAccount(t.ctx, { accountId: t.acc('6500'), name: 'Privatbezüge Inhaber' }), 'rename');
  const p = lineOf(t.ctx, lines.PAPER).proposal;
  const rec = t.store.db.prepare('SELECT questions_json FROM model_decision WHERE id = ?').get(p.reasonParams.decisionId);
  const scored = rec === undefined ? [] : JSON.parse(rec.questions_json)[0].options;
  assert.ok(
    p.reasonCode !== 'model_suggested' || scored.includes('6500 Privatbezüge Inhaber'),
    `the inbox shows "the model suggests 6500 Privatbezüge Inhaber, 82 %"; the model scored ${JSON.stringify(scored[0])}`,
  );
});

// --- COVERAGE (pass on the author's branch; a mutation makes them fail) ---------------------------

test('coverage: a disposable workspace holding decisions can still be hard-deleted, and the wall stands after', () => {
  const t = world();
  importLines(t, STATEMENT);
  register(t);
  must(suggestBankLines(t.ctx, { idempotencyKey: 'hd' }));
  const b = secondWorkspace(t);
  assert.ok(decisionsOf(t).length > 0);
  t.store.tx(() => hardDeleteWorkspace(t.ctx, t.workspaceId));
  assert.equal(decisionsOf(t).length, 0, 'the decisions went with the workspace');
  // The append-only wall is back for every other workspace.
  recordDecisionFor(t, b.workspaceId);
  assert.throws(() => t.store.db.prepare('DELETE FROM model_decision WHERE workspace_id = ?').run(b.workspaceId), /append-only/);
});


test('coverage: `sure` is unreachable by a model, even at probability 1 and on every read', () => {
  const t = world();
  const { lines } = importLines(t, STATEMENT);
  register(t, { decide: picks('6500', 1) });
  must(suggestBankLines(t.ctx, { idempotencyKey: 'one' }));
  for (const id of [lines.PAPER, lines.GIFT]) {
    const l = lineOf(t.ctx, id);
    assert.equal(l.proposal.reasonCode, 'model_suggested');
    assert.equal(l.proposal.certainty, 'check');
    assert.equal(l.attention, 'needs');
  }
});

test('coverage: §H-TENANT on the read side: a forged decision of another workspace, or naming its account, never shows', () => {
  const t = world();
  const { lines } = importLines(t, STATEMENT);
  register(t);
  const b = secondWorkspace(t);
  const forge = (workspaceId, subjectId, chosen) =>
    t.store.db
      .prepare(
        `INSERT INTO model_decision (id, workspace_id, consumer, subject_kind, subject_id, runtime_id, model_ref, model_sha256, input_sha256,
           questions_json, answers_json, chosen_value, chosen_probability, created_by, created_at)
         VALUES (?, ?, 'bank_inbox', 'bank_txn', ?, 'stub-local', 'stub-4b-q4', ?, 'x', '[]', '[]', ?, 0.9, 'forger', '2026-07-31T00:00:00Z')`,
      )
      .run(`md_forged_${Math.random()}`, workspaceId, subjectId, 'a'.repeat(64), chosen);
  // B holds a decision about A's line: A must not read it.
  forge(b.workspaceId, lines.PAPER, t.acc('6500'));
  assert.equal(lineOf(t.ctx, lines.PAPER).proposal.reasonCode, 'no_proposal', 'a neighbour\'s record never speaks in this workspace');
  // A holds a decision whose chosen account belongs to B: hidden, never booked across the wall.
  forge(t.workspaceId, lines.GIFT, b.acc('3000'));
  assert.equal(lineOf(t.ctx, lines.GIFT).proposal.reasonCode, 'no_proposal', 'a foreign account is never a candidate');
});

test('coverage: history never smuggles a control account, a bank ledger or an archived account into the candidates', () => {
  const t = world();
  const { lines } = importLines(t, {
    statementId: 'hist',
    entries: [
      { ref: 'H1', amountMinor: 1_000, cd: 'DBIT', date: '2026-07-01', name: 'Alpha' },
      { ref: 'H2', amountMinor: 2_000, cd: 'DBIT', date: '2026-07-02', name: 'Beta' },
      { ref: 'H3', amountMinor: 3_000, cd: 'DBIT', date: '2026-07-03', name: 'Gamma' },
    ],
  });
  const book = (id, number, amount, key) => must(bookBankLine(t.ctx, { bankTxnId: id, target: { kind: 'accounts', legs: [{ accountId: t.acc(number), amountMinor: amount }] }, idempotencyKey: key }), `book ${number}`);
  book(lines.H1, '2000', 1_000, 'h1');
  book(lines.H2, '1100', 2_000, 'h2');
  book(lines.H3, '6570', 3_000, 'h3');
  t.store.db.prepare('UPDATE account SET archived = 1 WHERE workspace_id = ? AND id = ?').run(t.workspaceId, t.acc('6570'));
  const cands = bankLineCandidates(modelCandidateBase(t.ctx), { credit_debit: 'DBIT', payer_name: null }, { counterparty_name: 'Delta', remittance_text: null }, 8);
  const banned = ['1020', '1100', '2000', '1170', '1171', '2200', '6570'].map((n) => t.acc(n));
  assert.deepEqual(cands.filter((c) => banned.includes(c.accountId)).map((c) => c.label), []);
  assert.ok(cands.length >= 2);
});

test('OP6: none of the above opened a socket', () => {
  assert.deepEqual(probe.violations, []);
});
