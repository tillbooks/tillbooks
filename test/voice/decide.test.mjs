/**
 * D144, E05 §10: `decide()`, the "System One" door on the OP6 seam. The manifest's two new fields sit
 * under the same fail-closed registration gate as the licence and the pinned sha256; the core door
 * refuses by name before it asks a model anything unfit, and it validates what a model answers
 * FAIL-CLOSED (a distribution that does not add up is not a probability); the decision record is
 * append-only by trigger. All under the OP6 egress probe: nothing here may open a socket.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installEgressProbe } from '../mail/egress-probe.mjs';

const probe = installEgressProbe();

const { makeContext } = await import('../../dist/core/context.js');
const {
  registerRuntime,
  resetRuntimeRegistration,
  decide,
  decideModel,
  recordModelDecision,
  findModelDecision,
  latestModelDecisions,
  decisionInputSha256,
  DECIDE_QUESTION_TYPES,
  VOICE_TABLES,
} = await import('../../dist/core/voice/index.js');
const { freshDeps, mintWorkspace } = await import('../api/support.mjs');
const { stubAdapter, stubManifest, stubDecideBlock } = await import('./fixtures.mjs');

const CHOICE = { id: 'account', type: 'choice', text: 'Welches Konto?', options: ['6500 Büromaterial', '6200 Fahrzeugaufwand', '6570 Informatik'] };

function manifestWith(patch) {
  const rows = stubManifest();
  rows[0] = { ...rows[0], ...patch };
  return rows;
}

function registerStub(adapterPatch = {}, rowPatch = {}) {
  registerRuntime(stubAdapter(adapterPatch), manifestWith(rowPatch));
}

test('D144 §H-ENUM: the three System One question types, single-sourced', () => {
  assert.deepEqual([...DECIDE_QUESTION_TYPES], ['noul', 'choice', 'score']);
  assert.equal(VOICE_TABLES.includes('model_decision'), true, 'the decision record is a voice table, held to its guards');
});

test('D144 manifest gate: languages and decide are validated fail-closed at registration, naming the rule', () => {
  resetRuntimeRegistration();
  const refusesWith = (patch, rule) =>
    assert.throws(() => registerRuntime(stubAdapter(), manifestWith(patch)), (e) => e instanceof Error && e.message.includes(rule), rule);
  refusesWith({ languages: [] }, 'languages that are not a non-empty list');
  refusesWith({ languages: ['DE'] }, 'not an ISO 639-1 code');
  refusesWith({ languages: ['deu'] }, 'not an ISO 639-1 code');
  refusesWith({ languages: ['de', 'de'] }, 'a language twice');
  refusesWith({ languages: undefined }, 'declares decide but no languages');
  refusesWith({ decide: stubDecideBlock({ questionTypes: [] }) }, 'questionTypes');
  refusesWith({ decide: stubDecideBlock({ questionTypes: ['multi'] }) }, 'questionTypes');
  refusesWith({ decide: stubDecideBlock({ maxChoices: 1 }) }, 'maxChoices outside 2..255');
  refusesWith({ decide: stubDecideBlock({ maxChoices: 256 }) }, 'maxChoices outside 2..255');
  refusesWith({ decide: stubDecideBlock({ maxChoices: 2.5 }) }, 'maxChoices outside 2..255');
  refusesWith({ decide: stubDecideBlock({ calibration: undefined }) }, 'without a calibration');
  refusesWith({ decide: stubDecideBlock({ calibration: { method: '', measured: false, ece: null, evaluatedOn: null } }) }, 'names no calibration method');
  refusesWith({ decide: stubDecideBlock({ calibration: { method: 'x', measured: true, ece: null, evaluatedOn: 'set' } }) }, 'without an expected calibration error');
  refusesWith({ decide: stubDecideBlock({ calibration: { method: 'x', measured: true, ece: 1.5, evaluatedOn: 'set' } }) }, 'without an expected calibration error');
  refusesWith({ decide: stubDecideBlock({ calibration: { method: 'x', measured: true, ece: 0.1, evaluatedOn: '' } }) }, 'what it was measured on');
  refusesWith({ decide: stubDecideBlock({ calibration: { method: 'x', measured: false, ece: 0.1, evaluatedOn: null } }) }, 'it says was not measured');
  assert.equal(decideModel({ questionTypes: ['choice'] }).error, 'needs_local_runtime', 'a refused registration registers nothing');
  // Positive control: the stub manifest itself passes, and a row without either field still does.
  registerRuntime(stubAdapter(), stubManifest());
  registerRuntime(stubAdapter(), manifestWith({ languages: undefined, decide: undefined }));
  resetRuntimeRegistration();
});

test('D144 door: every unfit model is refused BY NAME before it is asked anything', () => {
  resetRuntimeRegistration();
  const asked = [];
  const spy = (state, qs) => {
    asked.push(state);
    return stubAdapter().decide(state, qs);
  };
  assert.equal(decide({ state: 'x', questions: [CHOICE] }).error, 'needs_local_runtime', 'no adapter: never a cloud fallback');

  registerStub({ decide: undefined });
  let r = decide({ state: 'x', questions: [CHOICE] });
  assert.equal(r.error, 'needs_decide_model');
  assert.equal(r.reason, 'adapter_has_no_decide');

  registerStub({ decide: spy, modelRef: 'not-in-manifest' });
  assert.equal(decide({ state: 'x', questions: [CHOICE] }).reason, 'model_not_in_manifest');

  registerStub({ decide: spy }, { decide: undefined });
  assert.equal(decide({ state: 'x', questions: [CHOICE] }).reason, 'manifest_declares_no_decide');

  registerStub({ decide: spy }, { decide: stubDecideBlock({ questionTypes: ['noul'] }) });
  r = decide({ state: 'x', questions: [CHOICE] });
  assert.equal(r.reason, 'question_type_unsupported');
  assert.equal(r.questionType, 'choice');

  registerStub({ decide: spy }, { languages: ['de', 'en'] });
  r = decide({ state: 'x', questions: [CHOICE], requireLanguages: ['de', 'fr'] });
  assert.equal(r.error, 'unsupported_model_language');
  assert.deepEqual(r.need, ['de', 'fr']);
  assert.deepEqual(r.have, ['de', 'en']);

  registerStub({ decide: spy }, { decide: stubDecideBlock({ calibration: { method: 'none yet', measured: false, ece: null, evaluatedOn: null } }) });
  assert.equal(decide({ state: 'x', questions: [CHOICE], requireMeasuredCalibration: true }).reason, 'calibration_unmeasured');
  assert.equal(decide({ state: 'x', questions: [CHOICE] }).ok, true, 'without the requirement an unmeasured row may answer');
  asked.length = 0;

  registerStub({ decide: spy }, { decide: stubDecideBlock({ maxChoices: 2 }) });
  assert.equal(decide({ state: 'x', questions: [CHOICE] }).field, 'questions[0].options', 'more options than the row admits');
  assert.equal(decide({ state: 'x', questions: [CHOICE, CHOICE] }).error, 'invalid_input', 'a duplicated question id');
  assert.equal(decide({ state: '', questions: [CHOICE] }).field, 'state');
  assert.equal(decide({ state: 'x'.repeat(9000), questions: [CHOICE] }).field, 'state');
  assert.equal(decide({ state: 'x', questions: [] }).field, 'questions');
  assert.equal(decide({ state: 'x', questions: [{ ...CHOICE, options: ['a', 'a'] }] }).field, 'questions[0].options');
  assert.equal(decide({ state: 'x', questions: [{ id: 'q', type: 'noul', text: ' ' }] }).field, 'questions[0].text');
  assert.deepEqual(asked, [], 'a refusal never reached the model');
  resetRuntimeRegistration();
});

test('D144 door: a model answer is validated fail-closed; a small drift is renormalised, a real one refused', () => {
  const answerWith = (fn) => {
    registerStub({ decide: fn });
    return decide({ state: 'Büromaterial Papeterie', questions: [CHOICE] });
  };
  const good = answerWith((s, qs) => stubAdapter().decide(s, qs));
  assert.equal(good.ok, true);
  assert.equal(good.modelRef, 'stub-4b-q4');
  assert.equal(good.modelSha256, 'a'.repeat(64), 'the pinned sha256 travels with every answer');
  assert.equal(good.runtimeId, 'stub-local');
  const ps = good.answers[0].probabilities;
  assert.ok(Math.abs(ps.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.ok(ps[0] > ps[1] && ps[0] > ps[2], 'the stub picks the option sharing a word with the state');

  const drift = answerWith(() => [{ id: 'account', type: 'choice', probabilities: [0.5004, 0.3, 0.2] }]);
  assert.equal(drift.ok, true);
  assert.ok(Math.abs(drift.answers[0].probabilities.reduce((a, b) => a + b, 0) - 1) < 1e-12, 'renormalised');

  const reason = (fn) => answerWith(fn).reason;
  assert.equal(reason(() => [{ id: 'account', type: 'choice', probabilities: [0.6, 0.3, 0.2] }]), 'probabilities_do_not_sum');
  assert.equal(reason(() => [{ id: 'account', type: 'choice', probabilities: [0.5, 0.5] }]), 'answer_malformed');
  assert.equal(reason(() => [{ id: 'account', type: 'choice', probabilities: [Number.NaN, 0.5, 0.5] }]), 'answer_malformed');
  assert.equal(reason(() => [{ id: 'account', type: 'choice', probabilities: [1.2, -0.1, -0.1] }]), 'answer_malformed');
  // Critic C6a: a sparse array's holes are skipped by every() and reduce(); indexed, they are refused.
  const sparse = [1];
  sparse.length = 3;
  assert.equal(reason(() => [{ id: 'account', type: 'choice', probabilities: sparse }]), 'answer_malformed');
  assert.equal(reason(() => [{ id: 'account', type: 'noul', probability: 0.5 }]), 'answer_malformed');
  assert.equal(reason(() => []), 'answer_missing');
  assert.equal(reason(() => 'yes'), 'answer_malformed');
  assert.equal(reason(() => [{ id: 'other', type: 'choice', probabilities: [1, 0, 0] }]), 'answer_for_unknown_question');
  assert.equal(
    reason(() => [
      { id: 'account', type: 'choice', probabilities: [1, 0, 0] },
      { id: 'account', type: 'choice', probabilities: [1, 0, 0] },
    ]),
    'answer_duplicated',
  );
  const threw = answerWith(() => {
    throw new Error('metal device lost');
  });
  assert.equal(threw.error, 'decide_failed');
  assert.equal(threw.reason, 'adapter_threw');
  assert.equal(threw.message, 'metal device lost');
  resetRuntimeRegistration();
});

test('D144 door (critic C6b): the adapter works on a copy, so it cannot rewrite the questions of its caller', () => {
  registerStub({
    decide: (s, qs) => {
      const out = stubAdapter().decide(s, qs);
      qs[0].options[1] = '1020 Bank';
      qs[0].text = 'rewritten';
      return out;
    },
  });
  const question = { id: 'account', type: 'choice', text: 'Welches Konto?', options: ['6500 Büromaterial', '6200 Fahrzeugaufwand'] };
  const r = decide({ state: 'Büromaterial', questions: [question] });
  assert.equal(r.ok, true);
  assert.deepEqual(question, { id: 'account', type: 'choice', text: 'Welches Konto?', options: ['6500 Büromaterial', '6200 Fahrzeugaufwand'] });
  resetRuntimeRegistration();
});

test('D144 door: noul and score answer in their own shapes, in question order', () => {
  registerStub();
  const r = decide({
    state: 'Rechnung dringend',
    questions: [
      { id: 'urgent', type: 'noul', text: 'Ist das dringend?' },
      { id: 'level', type: 'score', text: 'Wie dringend?', levels: ['tief', 'mittel', 'dringend'] },
    ],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.answers.map((a) => [a.id, a.type]), [['urgent', 'noul'], ['level', 'score']]);
  assert.equal(r.answers[0].probability, 0.5);
  assert.equal(r.answers[1].probabilities.length, 3);
  resetRuntimeRegistration();
});

test('D144 record: append-only by trigger, tenant-scoped, keyed by the input fingerprint', () => {
  const deps = freshDeps();
  const a = mintWorkspace(deps);
  const b = mintWorkspace(deps, 'Beta AG', 'ws-b');
  const ctxA = makeContext(deps.store, { workspaceId: a.workspaceId, actor: 'owner', clock: deps.clock, ids: deps.ids });
  const ctxB = makeContext(deps.store, { workspaceId: b.workspaceId, actor: 'owner', clock: deps.clock, ids: deps.ids });
  const inputSha256 = decisionInputSha256('{"x":1}', [CHOICE]);
  assert.equal(inputSha256, decisionInputSha256('{"x":1}', [CHOICE]), 'deterministic');
  assert.notEqual(inputSha256, decisionInputSha256('{"x":2}', [CHOICE]), 'the state is in the fingerprint');
  const input = {
    consumer: 'bank_inbox',
    subjectKind: 'bank_txn',
    subjectId: 'bt_1',
    runtimeId: 'stub-local',
    modelRef: 'stub-4b-q4',
    modelSha256: 'a'.repeat(64),
    inputSha256,
    questions: [CHOICE],
    answers: [{ id: 'account', type: 'choice', probabilities: [0.7, 0.2, 0.1] }],
    chosenValue: 'acc_1',
    chosenProbability: 0.7,
  };
  const id = recordModelDecision(ctxA, input);
  const key = { consumer: 'bank_inbox', subjectKind: 'bank_txn', subjectId: 'bt_1', modelRef: 'stub-4b-q4', modelSha256: 'a'.repeat(64), inputSha256 };
  assert.equal(findModelDecision(ctxA, key).id, id);
  assert.equal(findModelDecision(ctxB, key), undefined, '§H-TENANT: the neighbour sees nothing');
  assert.equal(findModelDecision(ctxA, { ...key, modelRef: 'stub-4b-q4-v2' }), undefined, 'critic C7: another ref is another model, same weights or not');
  assert.equal(latestModelDecisions(ctxB, { consumer: 'bank_inbox', subjectKind: 'bank_txn', modelRef: 'stub-4b-q4', modelSha256: 'a'.repeat(64) }).size, 0);
  const row = deps.store.db.prepare('SELECT * FROM model_decision WHERE id = ?').get(id);
  assert.equal(row.created_by, 'owner');
  assert.deepEqual(JSON.parse(row.answers_json)[0].probabilities, [0.7, 0.2, 0.1]);
  assert.throws(() => deps.store.db.prepare('UPDATE model_decision SET chosen_value = NULL WHERE id = ?').run(id), /append-only/);
  assert.throws(() => deps.store.db.prepare('DELETE FROM model_decision WHERE id = ?').run(id), /append-only/);
  // The newest decision per subject wins for the read side.
  const later = recordModelDecision(ctxA, { ...input, inputSha256: decisionInputSha256('{"x":2}', [CHOICE]), chosenValue: 'acc_2' });
  const latest = latestModelDecisions(ctxA, { consumer: 'bank_inbox', subjectKind: 'bank_txn', modelRef: 'stub-4b-q4', modelSha256: 'a'.repeat(64) });
  assert.equal(latest.get('bt_1').id, later);
  assert.equal(latestModelDecisions(ctxA, { consumer: 'bank_inbox', subjectKind: 'bank_txn', modelRef: 'stub-4b-q4', modelSha256: 'b'.repeat(64) }).size, 0, 'another weights file sees none');
});

test('D144 OP6: none of the above opened a socket', () => {
  assert.deepEqual(probe.violations, []);
});
