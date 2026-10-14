/**
 * AN INCOMPLETE CALL TO A GOVERNED VERB IS REFUSED AT THE SEAM, NEVER RUN (D156 critic F1).
 *
 * The defect: `planGoverned` drafted a governed call only when its input passed the draft screen
 * (every schema-required field present and non-blank), and a call that FAILED the screen fell through
 * to `action.run`, on the premise that the verb refuses what its schema requires. The premise was
 * false: `contacts_anonymise {workspaceId, contactId}` with no `idempotencyKey`, or with `''`, erased
 * the contact as the agent with no Vorschlag, and `reports_delete` did the same. An input-keyed verb
 * had the twin hole: dropping the field its rule keyed on (`book_bank_line` without `bankTxnId`) made
 * the rule miss, so the call ran ungoverned.
 *
 * THE SWEEP: for EVERY dial-governed verb (by name, or by an input-keyed rule, driven with an input
 * that rule governs), against the REAL conformance fixture of that verb, omit each schema-required
 * field and then send it as `''`, through the real REST seam as the agent seat. Each call must be
 * refused with `invalid_input` naming the field, traced as a `deny` that carries a dial capability,
 * and leave every non-trace table byte-identical. The full input, the positive control, must draft.
 *
 * HOW IT BITES: restore the old fall-through in `src/api/agent-gate.ts` and every name-keyed verb's
 * omitted-field call is traced `execute` with a null capability (and the verb's own code instead of
 * `invalid_input`), which the sweep names.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { DIAL_CAPABILITY_FOR_ACTION, INPUT_KEYED_DIAL_RULES, dialCapabilitiesForCall } from '../../dist/core/agent/index.js';
import { stateKeyedDialCapabilities } from '../../dist/core/agent/dialMap.js';
import { makeContext } from '../../dist/core/context.js';
import { SCENARIOS, fixture } from '../api/conformance-contract.mjs';

const TRACE_TABLES = new Set(['agent_session', 'agent_turn', 'agent_call']);

/** Every non-trace table, row for row: "no data changed" is this digest staying equal. */
function digest(db) {
  const h = createHash('sha256');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  for (const { name } of tables) {
    if (TRACE_TABLES.has(name)) continue;
    h.update(name);
    for (const row of db.prepare(`SELECT * FROM "${name}"`).all()) h.update(JSON.stringify(row));
  }
  return h.digest('hex');
}

/**
 * An input-keyed verb's conformance scenario is often the UNGOVERNED shape (a routine checklist tick,
 * a draft-only schedule, a rename). These turn it into the shape its rule governs.
 */
const GOVERNED_SHAPE = {
  checklist_item_complete: (input) => ({ ...input, evidence: { kind: 'filed_attestation', filedOn: '2026-07-10' } }),
  create_recurring_schedule: (input) => ({ ...input, autoIssue: true }),
  update_recurring_schedule: (input) => ({ ...input, patch: { ...(input.patch ?? {}), autoIssue: true } }),
  update_bank_account: (input) => ({ ...input, iban: 'CH5604835012345678009' }),
  set_creditor_profile: (input) => ({ ...input, iban: 'CH5604835012345678009' }),
  // D161.3: the MWST number is the governed input of update_company_profile.
  update_company_profile: (input) => ({ ...input, mwstNo: 'CHE-116.281.710 MWST' }),
};

/**
 * D161: a governed verb whose A24 capability the governed seat can never hold (A24 step 0 denies it
 * `manage_agent_dial`). The seam checks A24 before the dial, so its complete input is DENIED with a
 * deny row naming the family, never drafted; the omit and blank sweep still refuses it as not draftable.
 */
const NEVER_HELD_BY_THE_SEAT = { agent_prose_delete: 'manage_agent_dial' };

/**
 * D161: a token verb's TOKEN is its tenant. Without a token naming a live grant there is no workspace
 * to trace or draft in, so the seam hands the call to the verb, which refuses it exactly as it refuses
 * any bad token (`grant_denied`, no oracle). Every other required field of such a verb is swept as usual.
 */
const TOKEN_FIELD = { portal_quote_accept: 'token' };

const GOVERNED_VERBS = [...new Set([...Object.keys(DIAL_CAPABILITY_FOR_ACTION), ...INPUT_KEYED_DIAL_RULES.map((r) => r.action)])].sort();

function governedInput(name, fx) {
  const base = SCENARIOS[name](fx);
  return GOVERNED_SHAPE[name] !== undefined ? GOVERNED_SHAPE[name](base) : { ...base };
}

test('the sweep reaches every governed verb, each with a conformance fixture and a governed input', () => {
  const missing = GOVERNED_VERBS.filter((name) => SCENARIOS[name] === undefined);
  assert.deepEqual(missing, [], 'a governed verb with no conformance scenario cannot be swept');
  for (const name of GOVERNED_VERBS) {
    const fx = fixture();
    const input = governedInput(name, fx);
    // Critic round 3 (N2): a book-keyed rule (`whenBook`) governs against the book, not the input alone.
    const ctx = makeContext(fx.deps.store, { workspaceId: fx.workspaceId, actor: 'agent', clock: fx.deps.clock, ids: fx.deps.ids });
    const governs = dialCapabilitiesForCall(name, input).length > 0 || stateKeyedDialCapabilities(ctx, name, { ...input, workspaceId: fx.workspaceId }).length > 0;
    assert.ok(governs, `${name}: the swept input is one the dial governs`);
    fx.deps.store.close();
  }
});

test('SWEEP: omitting or blanking any schema-required field of a governed verb is refused at the seam, traced as deny, and changes nothing', () => {
  const failures = [];
  let calls = 0;
  for (const name of GOVERNED_VERBS) {
    const required = getAction(name).inputSchema.required.filter((f) => f !== 'workspaceId');
    for (const field of required) {
      for (const variant of ['omit', 'blank']) {
        const fx = fixture();
        const input = governedInput(name, fx);
        if (variant === 'omit') delete input[field];
        else input[field] = '';
        const before = digest(fx.deps.store.db);
        const res = handleRest(name, input, { ...fx.deps, actor: 'agent' }).body;
        calls += 1;
        const rows = fx.deps.store.db.prepare('SELECT mode, ok, dial_capability, decision_reason FROM agent_call WHERE verb = ?').all(name);
        const label = `${name} ${variant} ${field}`;
        if (TOKEN_FIELD[name] === field) {
          if (res.ok !== false || res.error !== 'grant_denied') failures.push(`${label}: answered ${JSON.stringify(res).slice(0, 160)}`);
          if (rows.length !== 0) failures.push(`${label}: traced without a tenant`);
          if (fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM agent_action').get().n !== 0) failures.push(`${label}: queued`);
          fx.deps.store.close();
          continue;
        }
        if (res.ok !== false || res.error !== 'invalid_input' || res.field !== field) failures.push(`${label}: answered ${JSON.stringify(res).slice(0, 160)}`);
        if (rows.some((r) => r.mode === 'execute' && r.dial_capability === null)) failures.push(`${label}: ran ungoverned (execute, no dial capability)`);
        if (!rows.some((r) => r.mode === 'deny' && r.dial_capability !== null && r.decision_reason === 'not_draftable')) failures.push(`${label}: no deny row with a capability`);
        if (digest(fx.deps.store.db) !== before) failures.push(`${label}: data changed`);
        fx.deps.store.close();
      }
    }
  }
  assert.ok(calls > 300, `the sweep is real (${calls} calls)`);
  assert.deepEqual(failures, []);
});

test('POSITIVE CONTROL: the complete governed input of every governed verb drafts and changes no business data', () => {
  const failures = [];
  for (const name of GOVERNED_VERBS) {
    const fx = fixture();
    const input = governedInput(name, fx);
    const res = handleRest(name, input, { ...fx.deps, actor: 'agent' }).body;
    if (NEVER_HELD_BY_THE_SEAT[name] !== undefined) {
      const rows = fx.deps.store.db.prepare('SELECT mode, dial_capability FROM agent_call WHERE verb = ?').all(name);
      if (res.error !== 'permission_denied' || res.capability !== NEVER_HELD_BY_THE_SEAT[name]) failures.push(`${name}: ${JSON.stringify(res).slice(0, 160)}`);
      if (rows.length !== 1 || rows[0].mode !== 'deny' || rows[0].dial_capability === null) failures.push(`${name}: traced as ${JSON.stringify(rows)}`);
    } else if (res.drafted !== true) failures.push(`${name}: ${JSON.stringify(res).slice(0, 160)}`);
    fx.deps.store.close();
  }
  assert.deepEqual(failures, []);
});

test('the F1 repro: contacts_anonymise and reports_delete with no key or a blank key erase nothing, at the seam and in the engine', () => {
  for (const name of ['contacts_anonymise', 'reports_delete']) {
    for (const key of [undefined, '']) {
      const fx = fixture();
      const input = { ...SCENARIOS[name](fx) };
      if (key === undefined) delete input.idempotencyKey;
      else input.idempotencyKey = key;
      const before = digest(fx.deps.store.db);
      const seam = handleRest(name, input, { ...fx.deps, actor: 'agent' }).body;
      assert.equal(seam.error, 'invalid_input', `${name} key=${JSON.stringify(key)} at the seam: ${JSON.stringify(seam)}`);
      // The engine refuses it too, for a caller that never meets the seam (a person, an embedder).
      const engine = getAction(name).run({ ...fx.deps, actor: 'studio' }, input);
      assert.equal(engine.error, 'invalid_input', `${name} key=${JSON.stringify(key)} in the engine: ${JSON.stringify(engine)}`);
      assert.equal(engine.field, 'idempotencyKey');
      assert.equal(digest(fx.deps.store.db), before, `${name}: nothing erased`);
      fx.deps.store.close();
    }
  }
});
