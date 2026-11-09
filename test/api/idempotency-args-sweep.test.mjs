/**
 * N01 US-N01.5, the STANDING sweep: §H-IDEMPOTENT "one key, one meaning" over EVERY keyed write verb.
 *
 * Driven off the registry and the conformance scenarios, like the conformance gate itself, so a verb
 * registered next month is held to the rule with nobody editing this file. For each write verb whose
 * scenario carries an `idempotencyKey`, the scenario runs once, and then the SAME key is sent with
 * other arguments, two ways:
 *  - an UNREAD field added (the call takes exactly the replay path an identical retry takes, only its
 *    argument identity differs), and
 *  - every REAL top-level argument the scenario sends, mutated one at a time (the critic's pass: an
 *    amount, an account, a date, a flag, a list), so the money verbs are proven on the arguments they
 *    actually read.
 * Each must answer `idempotency_key_conflict` naming that field, and the whole database must be byte for
 * byte unchanged. The check is the registry's record (`idempotency_args`), taken before the verb runs,
 * so it holds whatever the engine does with its own key (rescoped memo, domain-row replay).
 *
 * Two named lists hold the only verbs left out, each with its reason:
 *  - `NOT_SPENT`: the scenario's first call writes nothing to the book, so no key is spent and a retry
 *    with other arguments is simply another first call.
 *  - `UNCLAIMED`: the call has no AUTHENTICATED workspace to key a record on (a pre-workspace verb, or a
 *    token-authenticated one whose tenant the token decides inside the verb). Keying it on an empty or
 *    caller-named workspace would let an unauthenticated caller pre-claim another's key and answer before
 *    authentication (security review), so its engine-scoped memo decides, as before N01.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ACTIONS, getAction } from '../../dist/api/registry.js';
import { APPROVAL_CONFIRMS_FIELD } from '../../dist/core/agent/dialMap.js';
import { TRANSPORT_ONLY_FIELDS, freeTextFieldsOf } from '../../dist/core/store/idempotencyArgs.js';
import { SCENARIOS, fixture } from './conformance-contract.mjs';

/**
 * The verbs whose scenario's first call writes nothing to the book, so no key is spent. A key is spent
 * by the act's committed write, never by an answer alone: otherwise a preview (`confirm` absent) would
 * spend the key its confirmed call needs.
 */
const NOT_SPENT = {
  ebill_transmit: 'the core has no eBill network: the call answers transmitted:false (cloud_tier) and writes nothing; once a transmitter is wired the transmission writes and spends the key',
  payment_batch_transmit: 'the core has no bank channel in the scenario: the call answers transmitted:false (needs_bank_channel) and writes nothing; a real transmission writes and spends the key',
  prepare_feedback: 'writes its diagnostics bundle to disk only, nothing to the book (G08); its own file-keyed replay answers the first bundle, a diagnostics artefact, not an act on the books',
};

/** Pre-workspace and token-authenticated verbs: never claimed (`ClaimSite`, src/core/store/idempotencyArgs.ts). */
const PRE_WORKSPACE = 'pre-workspace verb: no authenticated workspace to key a claim on; its own engine memo decides';
const UNCLAIMED = {
  create_workspace: PRE_WORKSPACE,
  bootstrap_workspace: PRE_WORKSPACE,
  create_demo_workspace: PRE_WORKSPACE,
  discard_demo_workspace: PRE_WORKSPACE,
  discard_orphan_testmandant: PRE_WORKSPACE,
  onboard_client: PRE_WORKSPACE,
  restore_backup: PRE_WORKSPACE,
  portal_quote_accept: 'token-authenticated: the tenant is the token\'s live grant, resolved inside the verb; its memo is scoped to (grant, quote, key)',
  // N01 critic: a dispatcher holds no outer claim; each item claims its own key (<key>:<bankTxnId>).
  book_bank_lines: 'a dispatcher: every item is one book_bank_line under <idempotencyKey>:<bankTxnId>, claimed and compared there (test/api/n01-agent-ergonomics.test.mjs)',
};

function snapshot(store) {
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  const out = {};
  for (const t of tables) out[t] = store.db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all();
  return JSON.stringify(out);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Another value of the same kind, or undefined when there is no obvious one (an object). */
function mutate(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v + 1 : v * 2;
  if (typeof v === 'boolean') return !v;
  if (typeof v === 'string') {
    if (DAY.test(v)) {
      const d = new Date(`${v}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    }
    return `${v} anders`;
  }
  if (Array.isArray(v)) return v.length > 1 ? v.slice(0, -1) : [...v, ...v];
  if (v !== null && typeof v === 'object') return { ...v, n01Mutated: true };
  return undefined;
}

const NEVER_ARGUMENTS = new Set(['workspaceId', 'idempotencyKey', ...TRANSPORT_ONLY_FIELDS]);

/** Every write verb with a keyed scenario, and the fields a real-argument mutation may change. */
function keyedVerbs() {
  const out = [];
  for (const action of ACTIONS.filter((a) => a.kind === 'write')) {
    const scenario = SCENARIOS[action.name];
    if (scenario === undefined) continue;
    const fx = fixture();
    try {
      const input = scenario(fx);
      if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) continue;
      // A verb's own free text is not compared under the default policy (`idempotency.hash_free_text`).
      const freeText = freeTextFieldsOf(action.name);
      const fields = Object.keys(input).filter((f) => !NEVER_ARGUMENTS.has(f) && !freeText.includes(f) && f !== APPROVAL_CONFIRMS_FIELD[action.name]);
      out.push({ action, scenario, fields });
    } finally {
      fx.deps.store.close();
    }
  }
  return out;
}

/** Run the scenario, then `variant(input)` under the same key; report what the second call did. */
function probe(action, scenario, variant) {
  const fx = fixture();
  try {
    const input = scenario(fx);
    const first = action.run(fx.deps, input);
    if (first.ok !== true) return { skipped: `the scenario's first call failed: ${first.error}` };
    // By verb and key: a pre-workspace verb (`create_workspace`) and a token verb record under the
    // workspace they act in, which is not always the fixture's.
    const spent = fx.deps.store.db
      .prepare('SELECT COUNT(*) AS n FROM idempotency_args WHERE verb = ? AND caller_key = ?')
      .get(action.name, input.idempotencyKey).n;
    const second = variant(input);
    if (second === undefined) return { skipped: 'no mutation for this value' };
    const before = snapshot(fx.deps.store);
    const res = action.run(fx.deps, second.input);
    return { spent: spent === 1, res, field: second.field, wrote: snapshot(fx.deps.store) !== before };
  } finally {
    fx.deps.store.close();
  }
}

test('every keyed write verb spends its key on its act, and refuses it with an UNREAD field added', () => {
  const problems = [];
  let refused = 0;
  const verbs = keyedVerbs();
  for (const { action, scenario } of verbs) {
    const r = probe(action, scenario, (input) => ({ input: { ...input, n01ArgsProbe: 'other arguments' }, field: 'n01ArgsProbe' }));
    if (r.skipped !== undefined) continue; // conformance rule 8 reports a scenario that cannot succeed
    if (r.wrote) problems.push(`${action.name}: the same-key probe WROTE to the database`);
    if (action.name in NOT_SPENT || action.name in UNCLAIMED) {
      if (r.spent) problems.push(`${action.name}: now records its key; remove it from its list`);
      continue;
    }
    if (!r.spent) problems.push(`${action.name}: its first call spent no key (no idempotency_args row)`);
    if (r.res.ok === false && r.res.error === 'idempotency_key_conflict' && JSON.stringify(r.res.fields) === '["n01ArgsProbe"]') refused += 1;
    else problems.push(`${action.name}: a spent key with other arguments answered ${JSON.stringify(r.res).slice(0, 160)}`);
  }
  for (const name of [...Object.keys(NOT_SPENT), ...Object.keys(UNCLAIMED)]) {
    if (getAction(name) === undefined) problems.push(`${name}: listed but not a registered verb`);
  }
  assert.deepEqual(problems, []);
  assert.equal(refused, verbs.length - Object.keys(NOT_SPENT).length - Object.keys(UNCLAIMED).length, 'every spent key refused');
  console.log(`# unread-field pass: ${refused} of ${verbs.length} keyed write verbs refused`);
  assert.ok(refused > 380, `the sweep must be real: ${refused} verbs refused`);
});

test('every REAL argument of every keyed write verb, mutated under the spent key, refuses naming it and writes nothing', () => {
  const problems = [];
  let refused = 0;
  for (const { action, scenario, fields } of keyedVerbs()) {
    if (action.name in NOT_SPENT || action.name in UNCLAIMED) continue;
    for (const field of fields) {
      const r = probe(action, scenario, (input) => {
        const mv = mutate(input[field]);
        return mv === undefined ? undefined : { input: { ...input, [field]: mv }, field };
      });
      if (r.skipped !== undefined) continue;
      if (r.wrote) problems.push(`${action.name}.${field}: the mutated call WROTE to the database`);
      if (r.res.ok === false && r.res.error === 'idempotency_key_conflict' && JSON.stringify(r.res.fields) === JSON.stringify([field])) refused += 1;
      else problems.push(`${action.name}.${field}: answered ${JSON.stringify(r.res).slice(0, 160)}`);
    }
  }
  assert.deepEqual(problems, []);
  console.log(`# mutation pass: ${refused} real-argument mutations refused`);
  assert.ok(refused > 850, `the mutation pass must be real: ${refused} mutations refused`);
});

test('every ENUM-valued argument (a closed code, a coded reason included) changed to another value refuses naming it', () => {
  const problems = [];
  let refused = 0;
  for (const { action, scenario } of keyedVerbs()) {
    if (action.name in NOT_SPENT || action.name in UNCLAIMED) continue;
    for (const [field, spec] of Object.entries(action.inputSchema.properties)) {
      const values = Array.isArray(spec?.enum) ? spec.enum : undefined;
      if (values === undefined || values.length < 2) continue;
      const r = probe(action, scenario, (input) => {
        if (!(field in input)) return undefined;
        const other = values.find((v) => v !== input[field]);
        return { input: { ...input, [field]: other }, field };
      });
      if (r.skipped !== undefined) continue;
      if (r.wrote) problems.push(`${action.name}.${field}: wrote`);
      if (r.res.ok === false && r.res.error === 'idempotency_key_conflict' && JSON.stringify(r.res.fields) === JSON.stringify([field])) refused += 1;
      else problems.push(`${action.name}.${field}: answered ${JSON.stringify(r.res).slice(0, 160)}`);
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(refused >= 3, `the enum pass must be real: ${refused} refused`);
});

test('CRITIC: a coded reason changed under a spent key refuses (stock_move, provision_create, ignore_bank_line)', () => {
  for (const [verb, other] of [['stock_move', 'issue'], ['stock_move', 'adjust'], ['provision_create', 'prozess'], ['ignore_bank_line', 'duplicate']]) {
    const r = probe(getAction(verb), SCENARIOS[verb], (input) => (input.reason === other ? undefined : { input: { ...input, reason: other }, field: 'reason' }));
    assert.equal(r.skipped, undefined, `${verb}: ${r.skipped}`);
    assert.equal(r.res.error, 'idempotency_key_conflict', `${verb} reason=${other}: ${JSON.stringify(r.res)}`);
    assert.deepEqual(r.res.fields, ['reason']);
    assert.equal(r.wrote, false);
  }
});

test('the money verbs the critic reproduced refuse on the argument that moves money', () => {
  const cases = [
    ['record_expense', 'amountMinor'],
    ['create_entry_for_txn', 'contraAccountId'],
    ['mark_batch_paid', 'valueDate'],
    ['expense_claim_reimburse', 'bankAccountId'],
    ['record_payment', 'amountMinor'],
    ['book_bank_line', 'text'],
    ['create_vendor_bill', 'amountMinor'],
  ];
  for (const [verb, field] of cases) {
    const r = probe(getAction(verb), SCENARIOS[verb], (input) => {
      assert.ok(field in input, `${verb}: the scenario sends no ${field}`);
      return { input: { ...input, [field]: mutate(input[field]) }, field };
    });
    assert.equal(r.skipped, undefined, `${verb}: ${r.skipped}`);
    assert.equal(r.res.error, 'idempotency_key_conflict', `${verb}.${field}: ${JSON.stringify(r.res)}`);
    assert.deepEqual(r.res.fields, [field]);
    assert.equal(r.wrote, false, `${verb}.${field}: wrote`);
  }
});

test('an approval replay never false-conflicts: the confirm field it injects is not an argument', () => {
  // `approveDraftedAction` replays the drafted payload with the verb's confirm field set to true. A
  // later same-key call WITHOUT the field (the agent's own retry) must not be told the key means
  // something else. Driven over every confirm-gated verb that has a keyed scenario.
  const problems = [];
  let driven = 0;
  for (const [verb, field] of Object.entries(APPROVAL_CONFIRMS_FIELD)) {
    const action = getAction(verb);
    const scenario = SCENARIOS[verb];
    if (action === undefined || scenario === undefined) continue;
    const fx = fixture();
    try {
      const input = scenario(fx);
      if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) continue;
      const approvedReplay = action.run(fx.deps, { ...input, [field]: true });
      if (approvedReplay.ok !== true) continue;
      driven += 1;
      const { [field]: _dropped, ...withoutField } = input;
      for (const retry of [withoutField, { ...input, [field]: true }]) {
        const res = action.run(fx.deps, retry);
        if (res.ok === false && res.error === 'idempotency_key_conflict') {
          problems.push(`${verb}: a retry ${field in retry ? 'with' : 'without'} ${field} false-conflicted`);
        }
      }
    } finally {
      fx.deps.store.close();
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(driven >= 5, `the check must drive real verbs: ${driven}`);
});
