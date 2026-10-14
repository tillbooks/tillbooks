// A39 §12 (D144), the model rung: `suggest_bank_lines` records a calibrated model's choice among
// code-built candidates, and the inbox shows it as `model_suggested`, ALWAYS `check`. The claims:
// no adapter means exactly today's inbox; every unfit model is refused by name before it is asked;
// the rung shows only what the model registered NOW recorded; nothing is shown that was not recorded
// first; a replay adds no row; a foreign id is `not_found` and moves nothing; the suggested target books
// through `book_bank_line` like any other. All under the OP6 egress probe.
//
// SYNTHETIC DATA ONLY: every statement is spelled by hand in bank-inbox-support.mjs; every name here is
// invented.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installEgressProbe } from '../mail/egress-probe.mjs';

const probe = installEgressProbe();

const {
  listBankInbox,
  bookBankLine,
  suggestBankLines,
  bankLineCandidates,
  modelCandidateBase,
  bankLineDecisionState,
  MODEL_SUGGEST_TOP_K,
  BANK_INBOX_MODEL_LANGUAGES,
} = await import('../../dist/core/banking/index.js');
const { registerRuntime, resetRuntimeRegistration, selectRuntimeModel } = await import('../../dist/core/voice/index.js');
const { NOT_AUTOMATABLE } = await import('../../dist/core/automation/denylist.js');
const { CAPABILITY_FOR_ACTION } = await import('../../dist/core/access/actionCapabilities.js');
const { assertClaimInvariantHolds, world, importLines, must, refused, secondWorkspace, TELCO_IBAN } = await import('./bank-inbox-support.mjs');
const { stubAdapter, stubManifest, stubDecideBlock } = await import('../voice/fixtures.mjs');

afterEach(assertClaimInvariantHolds);
afterEach(() => resetRuntimeRegistration());

const STATEMENT = {
  statementId: 'rung-1',
  entries: [
    { ref: 'PAPER', amountMinor: 8_450, cd: 'DBIT', date: '2026-07-10', name: 'Papeterie Sonnenberg', iban: TELCO_IBAN, ustrd: 'Büromaterial Juli' },
    { ref: 'GIFT', amountMinor: 12_000, cd: 'CRDT', date: '2026-07-12', name: 'Verein Lindenhof', ustrd: 'Spende Sommerfest' },
  ],
};

/** A stub decide that puts `p` on the option whose label starts with `number`, the rest spread evenly. */
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

function register(t, { decide = picks('6500'), row = {}, select = true } = {}) {
  registerRuntime(stubAdapter({ decide }), manifest(row));
  if (select) must(selectRuntimeModel(t.ctx, { modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: `sel-${Math.random()}` }), 'select');
}

function inbox(t) {
  return must(listBankInbox(t.ctx, { status: 'open' }), 'list');
}

function lineOf(t, id) {
  return inbox(t).lines.find((l) => l.bankTxnId === id);
}

const decisionCount = (t) => t.store.db.prepare('SELECT COUNT(*) AS n FROM model_decision WHERE workspace_id = ?').get(t.workspaceId).n;

test('A39 §12: with no adapter the inbox is exactly today\'s, and suggest refuses needs_local_runtime', () => {
  resetRuntimeRegistration();
  const t = world();
  const { lines } = importLines(t, STATEMENT);
  const before = inbox(t);
  assert.equal(lineOf(t, lines.PAPER).proposal.reasonCode, 'no_proposal');
  refused(suggestBankLines(t.ctx, { idempotencyKey: 'k1' }), 'needs_local_runtime');
  assert.equal(decisionCount(t), 0);
  assert.deepEqual(inbox(t), before, 'a refused suggest changes nothing the inbox shows');

  // A refusal is never memoised: the same key succeeds once a runtime is installed.
  register(t);
  const ok = must(suggestBankLines(t.ctx, { idempotencyKey: 'k1' }), 'suggest after install');
  assert.equal(ok.considered, 2);
});

test('A39 §12: every unfit model is refused by name before any line is decided', () => {
  const t = world();
  importLines(t, STATEMENT);
  register(t, { select: false });
  refused(suggestBankLines(t.ctx, { idempotencyKey: 'a' }), 'needs_model_selection');
  register(t, { row: { languages: ['de', 'en', 'it'] } });
  const lang = refused(suggestBankLines(t.ctx, { idempotencyKey: 'b' }), 'unsupported_model_language');
  assert.deepEqual(lang.need, [...BANK_INBOX_MODEL_LANGUAGES]);
  assert.deepEqual([...BANK_INBOX_MODEL_LANGUAGES], ['de', 'fr'], 'D144 item 2: German AND French');
  register(t, { row: { decide: stubDecideBlock({ calibration: { method: 'none yet', measured: false, ece: null, evaluatedOn: null } }) } });
  assert.equal(refused(suggestBankLines(t.ctx, { idempotencyKey: 'c' }), 'needs_decide_model').reason, 'calibration_unmeasured');
  register(t, { row: { decide: stubDecideBlock({ questionTypes: ['noul'] }) } });
  assert.equal(refused(suggestBankLines(t.ctx, { idempotencyKey: 'd' }), 'needs_decide_model').reason, 'question_type_unsupported');
  registerRuntime(stubAdapter({ decide: undefined }), manifest());
  assert.equal(refused(suggestBankLines(t.ctx, { idempotencyKey: 'e' }), 'needs_decide_model').reason, 'adapter_has_no_decide');
  assert.equal(decisionCount(t), 0, 'no refusal recorded a decision');
  // Even a decision recorded earlier stays silent while an unfit model is registered.
  register(t);
  must(suggestBankLines(t.ctx, { idempotencyKey: 'f' }));
  register(t, { row: { languages: ['de', 'en'] } });
  assert.equal(inbox(t).lines.every((l) => l.proposal.reasonCode !== 'model_suggested'), true);
});

test('A39 §12: the model suggests, the record comes first, the rung reads check and never sure', () => {
  const t = world();
  const { lines } = importLines(t, STATEMENT);
  register(t, { decide: picks('6500', 0.82) });
  const res = must(suggestBankLines(t.ctx, { idempotencyKey: 's1' }), 'suggest');
  assert.equal(res.modelRef, 'stub-4b-q4');
  assert.equal(res.modelSha256, 'a'.repeat(64));
  assert.equal(res.considered, 2);
  assert.equal(res.suggested, 2);
  assert.equal(res.belowFloor, 0);
  assert.equal(decisionCount(t), 2, 'one recorded decision per line, before anything showed it');

  const paper = lineOf(t, lines.PAPER);
  assert.equal(paper.proposal.reasonCode, 'model_suggested');
  assert.equal(paper.proposal.certainty, 'check', 'a probability is not a reference');
  assert.equal(paper.attention, 'needs', 'D142: a model line counts under "needs you", never "sure"');
  assert.deepEqual(paper.proposal.target, { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 8_450 }] });
  assert.equal(paper.proposal.reasonParams.accountId, t.acc('6500'));
  assert.equal(paper.proposal.reasonParams.probability, 0.82);
  assert.equal(paper.proposal.reasonParams.modelRef, 'stub-4b-q4');
  assert.ok(paper.proposal.reasonParams.candidates >= 2 && paper.proposal.reasonParams.candidates <= MODEL_SUGGEST_TOP_K);
  const row = t.store.db.prepare('SELECT * FROM model_decision WHERE id = ?').get(paper.proposal.reasonParams.decisionId);
  assert.equal(row.subject_id, lines.PAPER);
  assert.equal(row.model_sha256, 'a'.repeat(64));
  assert.equal(row.chosen_value, t.acc('6500'));
  const q = JSON.parse(row.questions_json)[0];
  assert.equal(q.type, 'choice');
  assert.ok(q.options[0].startsWith('6500 '), 'the shared stem (Büro) ranks 6500 first when the book has no history');
  assert.equal(JSON.parse(row.answers_json)[0].probabilities.length, q.options.length, 'every probability is on record');
  assert.equal(/CH44|IBAN/i.test(row.questions_json + row.answers_json), false, 'no IBAN reaches the record');

  // A credit is offered income accounts: the 6500 pick falls back to the first candidate, still check.
  const gift = lineOf(t, lines.GIFT);
  assert.equal(gift.proposal.certainty, 'check');
  const giftRow = t.store.db.prepare('SELECT questions_json FROM model_decision WHERE id = ?').get(gift.proposal.reasonParams.decisionId);
  assert.ok(JSON.parse(giftRow.questions_json)[0].options.every((o) => o.startsWith('3')), 'money in: income candidates only (no history yet)');

  // The suggested target books like any other target.
  const booked = must(bookBankLine(t.ctx, { bankTxnId: lines.PAPER, target: paper.proposal.target, idempotencyKey: 'book-paper' }), 'book');
  assert.ok(booked.entryId);
  assert.equal(lineOf(t, lines.PAPER), undefined, 'the line is booked and leaves the open list');
});

test('A39 §12: a reversal-flagged line reads check, and the ladder above the rung still wins', () => {
  const t = world();
  const { lines } = importLines(t, {
    statementId: 'rung-2',
    entries: [
      { ref: 'RV', amountMinor: 3_000, cd: 'CRDT', date: '2026-07-14', name: 'Kiosk Brunnen', reversal: true },
      { ref: 'HIST1', amountMinor: 5_000, cd: 'DBIT', date: '2026-07-02', name: 'Druckerei Alpenblick', iban: TELCO_IBAN },
    ],
  });
  // History for the telco IBAN: book HIST1 to 6570 by hand, so a later line from it is `learned`.
  must(bookBankLine(t.ctx, { bankTxnId: lines.HIST1, target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 5_000 }] }, idempotencyKey: 'h1' }));
  const { lines: more } = importLines(t, {
    statementId: 'rung-3',
    from: '2026-08-01',
    to: '2026-08-31',
    seqNb: '2',
    entries: [{ ref: 'HIST2', amountMinor: 5_500, cd: 'DBIT', date: '2026-08-03', name: 'Druckerei Alpenblick', iban: TELCO_IBAN }],
  });
  register(t, { decide: picks('3000', 0.95) });
  const res = must(suggestBankLines(t.ctx, { idempotencyKey: 'r1' }));
  assert.equal(res.skipped.has_proposal, 1, 'the learned line is not put to the model');
  assert.equal(res.considered, 1);
  assert.equal(lineOf(t, more.HIST2).proposal.reasonCode, 'history');
  const rv = lineOf(t, lines.RV);
  assert.equal(rv.proposal.reasonCode, 'model_suggested');
  assert.equal(rv.proposal.certainty, 'check');

  // Money-out candidates put this book's own booked account first.
  const base = modelCandidateBase(t.ctx);
  const cands = bankLineCandidates(base, { credit_debit: 'DBIT', payer_name: null }, { counterparty_name: 'X', remittance_text: null }, 8);
  assert.equal(cands[0].accountId, t.acc('6570'), 'history first');
  assert.ok(cands.length <= 8);
  const banned = ['1020', '1100', '2000', '1170', '1171', '2200'].map((n) => t.acc(n));
  assert.equal(cands.some((c) => banned.includes(c.accountId)), false, 'never a bank ledger, a control account or a VAT account');
});

test('A39 §12: a replay adds no row; a new key on the same input is unchanged; a guess below 50 % shows nothing', () => {
  const t = world();
  const { lines } = importLines(t, STATEMENT);
  register(t);
  const first = must(suggestBankLines(t.ctx, { idempotencyKey: 'x1' }));
  const n = decisionCount(t);
  assert.deepEqual(must(suggestBankLines(t.ctx, { idempotencyKey: 'x1' })), first, 'the same key replays its answer');
  const second = must(suggestBankLines(t.ctx, { idempotencyKey: 'x2' }));
  assert.equal(second.unchanged, 2);
  assert.equal(decisionCount(t), n, 'idempotent on ROWS, not just on keys');

  const t2 = world();
  const { lines: l2 } = importLines(t2, STATEMENT);
  register(t2, { decide: picks('6500', 0.4) });
  const low = must(suggestBankLines(t2.ctx, { idempotencyKey: 'low' }));
  assert.equal(low.belowFloor, 2);
  assert.equal(low.suggested, 0);
  assert.equal(decisionCount(t2), 2, 'the guess is recorded');
  assert.equal(lineOf(t2, l2.PAPER).proposal.reasonCode, 'no_proposal', 'and shows nothing');
  assert.ok(lines.PAPER);
});

test('A39 §12: the rung shows only the model registered NOW; unregistered, the inbox is exactly today\'s', () => {
  const t = world();
  const { lines } = importLines(t, STATEMENT);
  resetRuntimeRegistration();
  const baseline = inbox(t);
  register(t);
  must(suggestBankLines(t.ctx, { idempotencyKey: 'm1' }));
  assert.equal(lineOf(t, lines.PAPER).proposal.reasonCode, 'model_suggested');
  // Other weights under the same ref: the old numbers never speak for them.
  registerRuntime(stubAdapter({ decide: picks('6500') }), manifest({ sha256: 'd'.repeat(64) }));
  assert.equal(lineOf(t, lines.PAPER).proposal.reasonCode, 'no_proposal');
  resetRuntimeRegistration();
  assert.deepEqual(inbox(t), baseline, 'no adapter: byte-for-byte the inbox it was');
});

test('A39 §12: a model failing mid-batch records nothing; a foreign or unknown id is not_found and moves nothing', () => {
  const t = world();
  const { lines } = importLines(t, STATEMENT);
  let calls = 0;
  register(t, {
    decide: (s, qs) => {
      calls += 1;
      if (calls === 2) throw new Error('out of memory');
      return picks('6500')(s, qs);
    },
  });
  const failed = refused(suggestBankLines(t.ctx, { idempotencyKey: 'f1' }), 'decide_failed');
  assert.equal(failed.reason, 'adapter_threw');
  assert.equal(decisionCount(t), 0, 'all or nothing');

  const b = secondWorkspace(t);
  refused(suggestBankLines(b.ctx, { bankTxnIds: [lines.PAPER], idempotencyKey: 'foreign' }), 'not_found');
  refused(suggestBankLines(b.ctx, { bankAccountId: t.bankAccountId, idempotencyKey: 'foreign-acc' }), 'not_found');
  refused(suggestBankLines(t.ctx, { bankTxnIds: [], idempotencyKey: 'empty' }), 'invalid_input');
  refused(suggestBankLines(t.ctx, { idempotencyKey: '' }), 'invalid_input');
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM model_decision').get().n, 0);

  // Named ids that are not open are counted, not decided.
  register(t);
  must(bookBankLine(t.ctx, { bankTxnId: lines.GIFT, target: { kind: 'accounts', legs: [{ accountId: t.acc('3000'), amountMinor: 12_000 }] }, idempotencyKey: 'g' }));
  const named = must(suggestBankLines(t.ctx, { bankTxnIds: [lines.PAPER, lines.GIFT], idempotencyKey: 'named' }));
  assert.equal(named.skipped.not_open, 1);
  assert.equal(named.considered, 1);
});

test('A39 §12: the state the model reads carries no IBAN; the verb is G01-denied and rides post', () => {
  const t = world();
  const { lines } = importLines(t, STATEMENT);
  const row = t.store.db.prepare('SELECT * FROM bank_txn WHERE id = ?').get(lines.PAPER);
  const detail = t.store.db.prepare('SELECT * FROM bank_txn_detail WHERE bank_txn_id = ?').get(lines.PAPER);
  const state = JSON.parse(bankLineDecisionState(row, detail));
  assert.deepEqual(Object.keys(state).sort(), ['amount', 'bookingDate', 'counterparty', 'currency', 'direction', 'referenceKind', 'remittance']);
  assert.equal(state.direction, 'out');
  assert.equal(state.amount, '84.50');
  assert.equal(JSON.stringify(state).includes(TELCO_IBAN), false);
  assert.equal(NOT_AUTOMATABLE.has ? NOT_AUTOMATABLE.has('suggest_bank_lines') : [...NOT_AUTOMATABLE].includes('suggest_bank_lines'), true);
  assert.equal(CAPABILITY_FOR_ACTION.suggest_bank_lines, 'post');
});

test('A39 §12 (critic C1): decided lines never fill the batch, so remaining reaches 0 and a third call adds nothing', () => {
  const t = world();
  const entries = Array.from({ length: 53 }, (_, i) => ({
    ref: `B${String(i).padStart(2, '0')}`,
    amountMinor: 2_000 + i,
    cd: 'DBIT',
    date: `2026-07-${String(1 + (i % 28)).padStart(2, '0')}`,
    name: `Lieferant Probe ${i}`,
  }));
  importLines(t, { statementId: 'batch', entries });
  register(t);
  const first = must(suggestBankLines(t.ctx, { idempotencyKey: 'c1-a' }));
  assert.equal(first.remaining, 3);
  const second = must(suggestBankLines(t.ctx, { idempotencyKey: 'c1-b' }));
  assert.equal(second.remaining, 0, 'the waiting lines are reached, the toast stops asking');
  assert.equal(second.unchanged, 50);
  assert.equal(decisionCount(t), 53);
  const third = must(suggestBankLines(t.ctx, { idempotencyKey: 'c1-c' }));
  assert.equal(third.remaining, 0);
  assert.equal(third.unchanged, 53);
  assert.equal(decisionCount(t), 53, 'idempotent on rows');
  // Named ids: up to a page (200) is accepted, more is refused.
  refused(suggestBankLines(t.ctx, { bankTxnIds: Array.from({ length: 201 }, (_, i) => `x${i}`), idempotencyKey: 'c1-d' }), 'invalid_input');
});

test('A39 §12 (critic C3): the stored fingerprint is keyed; a copy randomises the key and pseudonymize re-derives it', async () => {
  const { decisionInputSha256, decisionFingerprint, readDecisionKey } = await import('../../dist/core/voice/index.js');
  const { applySanitization } = await import('../../dist/core/landscape/sanitize.js');
  const { neutralizeSecrets } = await import('../../dist/core/landscape/secrets.js');
  const t = world();
  const { lines } = importLines(t, { statementId: 'keyed', entries: [{ ref: 'CARD', amountMinor: 4_590, cd: 'DBIT', date: '2026-07-15', name: 'Blumenladen Aurora Seefeld' }] });
  assert.equal(readDecisionKey(t.ctx), undefined, 'no key before the first decision');
  register(t);
  must(suggestBankLines(t.ctx, { idempotencyKey: 'k1' }));
  const key = readDecisionKey(t.ctx);
  assert.match(key, /^[0-9a-f]{64}$/, '256 random bits');
  const row = t.store.db.prepare('SELECT * FROM bank_txn WHERE id = ?').get(lines.CARD);
  const detail = t.store.db.prepare('SELECT * FROM bank_txn_detail WHERE bank_txn_id = ?').get(lines.CARD);
  const decision = t.store.db.prepare('SELECT id, input_sha256, questions_json FROM model_decision WHERE subject_id = ?').get(lines.CARD);
  const questions = JSON.parse(decision.questions_json);
  const state = bankLineDecisionState(row, detail);
  assert.notEqual(decision.input_sha256, decisionInputSha256(state, questions), 'never the plain digest a dictionary recomputes');
  assert.equal(decision.input_sha256, decisionFingerprint(key, state, questions), 'the HMAC under the workspace key');
  // Dedupe still works under the key: a new call finds the same input unchanged.
  assert.equal(must(suggestBankLines(t.ctx, { idempotencyKey: 'k2' })).unchanged, 1);

  // What env_copy does to its building db: the secret floor randomises the key, pseudonymize re-derives.
  const lift = (fn) => {
    const saved = t.store.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%RAISE%ABORT%'").all();
    for (const r of saved) t.store.db.exec(`DROP TRIGGER IF EXISTS "${r.name}"`);
    try {
      return fn();
    } finally {
      for (const r of saved) t.store.db.exec(r.sql);
    }
  };
  lift(() => neutralizeSecrets(t.store.db, [t.workspaceId]));
  assert.notEqual(readDecisionKey(t.ctx), key, 'a copy never carries the source key');
  lift(() => applySanitization(t.store.db, { level: 'pseudonymize', workspaceIds: [t.workspaceId] }));
  const after = t.store.db.prepare('SELECT input_sha256 FROM model_decision WHERE id = ?').get(decision.id).input_sha256;
  assert.notEqual(after, decision.input_sha256);
  assert.notEqual(after, decisionFingerprint(key, state, questions), 'even the source key cannot confirm a guess against the copy');
});

test('A39 §12 (critic C10): the scored label is recorded, and a renamed or renumbered choice is not shown', async () => {
  const { updateAccount } = await import('../../dist/core/accounts/index.js');
  const t = world();
  const { lines } = importLines(t, STATEMENT);
  register(t, { decide: picks('6500', 0.82) });
  must(suggestBankLines(t.ctx, { idempotencyKey: 'lbl' }));
  const p = lineOf(t, lines.PAPER).proposal;
  const row = t.store.db.prepare('SELECT chosen_label FROM model_decision WHERE id = ?').get(p.reasonParams.decisionId);
  assert.equal(row.chosen_label, '6500 Verwaltungs- und Bürokosten');
  must(updateAccount(t.ctx, { accountId: t.acc('6500'), name: 'Privatbezüge Inhaber' }), 'rename');
  assert.equal(lineOf(t, lines.PAPER).proposal.reasonCode, 'no_proposal', 'the 82 % belonged to another meaning');
  // Renamed back, the recorded label matches again and the suggestion returns.
  must(updateAccount(t.ctx, { accountId: t.acc('6500'), name: 'Verwaltungs- und Bürokosten' }), 'rename back');
  assert.equal(lineOf(t, lines.PAPER).proposal.reasonCode, 'model_suggested');
});

test('A39 §12 (critic C5a): a tie at the top is recorded with no choice and shows nothing', () => {
  const t = world();
  const { lines } = importLines(t, STATEMENT);
  register(t, { decide: (_s, qs) => qs.map((q) => ({ id: q.id, type: 'choice', probabilities: q.options.map((_o, j) => (j < 2 ? 0.5 : 0)) })) });
  const res = must(suggestBankLines(t.ctx, { idempotencyKey: 'tie' }));
  assert.equal(res.suggested, 0);
  assert.equal(res.belowFloor, 2);
  const row = t.store.db.prepare('SELECT chosen_value, chosen_label FROM model_decision WHERE subject_id = ?').get(lines.PAPER);
  assert.deepEqual({ ...row }, { chosen_value: null, chosen_label: null });
  assert.equal(lineOf(t, lines.PAPER).proposal.reasonCode, 'no_proposal');
});

test('A39 §12 (critic C5b): the probability on the MCP read is floored and never reads 1', () => {
  const t = world();
  const { lines } = importLines(t, STATEMENT);
  register(t, { decide: picks('6500', 0.99996) });
  must(suggestBankLines(t.ctx, { idempotencyKey: 'near-one' }));
  assert.equal(lineOf(t, lines.PAPER).proposal.reasonParams.probability, 0.9999);
  const t2 = world();
  const { lines: l2 } = importLines(t2, STATEMENT);
  register(t2, { decide: picks('6500', 0.82349) });
  must(suggestBankLines(t2.ctx, { idempotencyKey: 'floor' }));
  assert.equal(lineOf(t2, l2.PAPER).proposal.reasonParams.probability, 0.8234, 'floored, never rounded up');
});

test('A39 §12 (critic C7): the same weights under a renamed ref decide again, and the inbox shows that decision', () => {
  const t = world();
  const { lines } = importLines(t, STATEMENT);
  register(t, { decide: picks('6500', 0.82) });
  must(suggestBankLines(t.ctx, { idempotencyKey: 'v1' }));
  registerRuntime(stubAdapter({ decide: picks('6500', 0.82), modelRef: 'stub-4b-q4-v2' }), manifest({ modelRef: 'stub-4b-q4-v2' }));
  const res = must(suggestBankLines(t.ctx, { idempotencyKey: 'v2' }));
  assert.equal(res.unchanged, 0, 'nothing is unchanged for a model the reader has never seen');
  assert.equal(res.suggested, 2);
  const p = lineOf(t, lines.PAPER).proposal;
  assert.equal(p.reasonCode, 'model_suggested');
  assert.equal(p.reasonParams.modelRef, 'stub-4b-q4-v2');
});

test('A39 §12 (critic C8): a line whose only proposal is a model guess still raises the A36 review signal', async () => {
  const { reviewBankTxn, lineNeedsReview, proposalContext } = await import('../../dist/core/banking/index.js');
  const t = world();
  const { lines } = importLines(t, STATEMENT);
  register(t, { decide: picks('6500', 0.9) });
  must(suggestBankLines(t.ctx, { idempotencyKey: 'rv' }));
  assert.equal(lineOf(t, lines.PAPER).proposal.reasonCode, 'model_suggested');
  assert.equal(must(reviewBankTxn(t.ctx, { bankTxnId: lines.PAPER, idempotencyKey: 'rv-1' })).needsReview, true);
  // Even a caller that hands in a context built WITH the rung gets the same answer.
  const row = t.store.db.prepare('SELECT * FROM bank_txn WHERE id = ?').get(lines.PAPER);
  assert.equal(lineNeedsReview(t.ctx, row, undefined, proposalContext(t.ctx)), true);
});

test('A39 §12 (critic C4): an IBAN quoted in the remittance text never reaches the model', async () => {
  const { maskIbans } = await import('../../dist/core/banking/bankModelRung.js');
  const grouped = TELCO_IBAN.replace(/(.{4})/g, '$1 ').trim();
  assert.equal(maskIbans(`Rückzahlung Kaution auf ${grouped} danke`), 'Rückzahlung Kaution auf [IBAN] danke');
  assert.equal(maskIbans(`IBAN ${TELCO_IBAN}.`), 'IBAN [IBAN].');
  assert.equal(maskIbans('Rechnung 2026-0034 vom 12.07.'), 'Rechnung 2026-0034 vom 12.07.', 'ordinary text is untouched');
  assert.equal(maskIbans('RF18 5390 0754 7034'), 'RF18 5390 0754 7034', 'a creditor reference is not an account');
  const t = world();
  const { lines } = importLines(t, {
    statementId: 'iban-text',
    entries: [{ ref: 'REFUND', amountMinor: 20_000, cd: 'DBIT', date: '2026-07-18', name: 'Muster Treuhand', ustrd: `Rückzahlung Kaution auf ${grouped}` }],
  });
  const row = t.store.db.prepare('SELECT * FROM bank_txn WHERE id = ?').get(lines.REFUND);
  const detail = t.store.db.prepare('SELECT * FROM bank_txn_detail WHERE bank_txn_id = ?').get(lines.REFUND);
  const state = JSON.parse(bankLineDecisionState(row, detail));
  assert.equal(state.remittance, 'Rückzahlung Kaution auf [IBAN]');
});

test('A39 §12 (owner 30.09.2026): the measured calibration is recorded with the decision and read beside the percent', () => {
  const t = world();
  const { lines } = importLines(t, STATEMENT);
  register(t, { decide: picks('6500', 0.82) });
  must(suggestBankLines(t.ctx, { idempotencyKey: 'cal' }));
  const p = lineOf(t, lines.PAPER).proposal;
  assert.equal(p.reasonParams.ece, 0.05, 'the stub row declares a measured ECE of 0.05');
  const row = t.store.db.prepare('SELECT calibration_json FROM model_decision WHERE id = ?').get(p.reasonParams.decisionId);
  assert.deepEqual(JSON.parse(row.calibration_json), { method: 'stub: deterministic word overlap', measured: true, ece: 0.05, evaluatedOn: 'a synthetic stub set' });
});

test('A39 §12 OP6: none of the above opened a socket', () => {
  assert.deepEqual(probe.violations, []);
});
