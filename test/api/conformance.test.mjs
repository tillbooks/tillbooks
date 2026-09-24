/**
 * D14.2, the MCP conformance gate.
 *
 * This is NOT a suite over today's 51 verbs. It is a STANDING CI gate: every rule below is derived
 * from `ACTIONS`, so a verb appended to the registry next month is held to the identical contract
 * with nobody editing this file, and it goes RED if it breaks it. The only per-verb knowledge lives
 * in `conformance-contract.mjs`, which a human must consciously edit (see the note there).
 *
 * The contract a verb must satisfy, and why each rule earns its place:
 *
 *  1. IDENTITY (§H-ENUM). The tool name is a stable external contract, so it is unique, snake_case,
 *     and identical on the wire to its registry name. A description that is missing, duplicated or
 *     one word is a defect: it is the only thing an agent has to choose the verb with.
 *  2. SCHEMA. `inputSchema` is a well-formed object schema whose `required` names are all declared.
 *     An agent that cannot trust the schema falls back to guessing arguments.
 *  3. HONEST ANNOTATIONS. `readOnlyHint` defaults to FALSE in the MCP spec, so a read verb must SAY
 *     it is read-only, and a write verb must never claim it. Asserted on the real wire, and the
 *     claim is then TESTED (rule 4), because an untested hint is marketing.
 *  4. READ MEANS READ. Every read verb is called and the whole database is compared before and
 *     after. A read verb that writes is the failure mode a client cannot defend against.
 *  5. STRUCTURED ERRORS. Garbage in gives `{ok:false, error:'<stable code>'}`. Never a throw, never
 *     a promise, never `unexpected_error` (which means an exception escaped the verb into the catch
 *     guard), and never a stack trace or a filesystem path in the payload.
 *  6. TENANT DISCIPLINE. A ctx verb with a missing tenant is `invalid_input` and with an unknown one
 *     is `workspace_not_found`. Two distinct codes, and never a silent `ok` on a typo'd tenant.
 *  7. THE FACES AGREE. The same call through the registry, through MCP `callTool` and through REST
 *     returns the identical Result, and a domain rejection is never an MCP protocol error.
 *  8. IDEMPOTENCY, the headline. Every write verb is called TWICE with the identical input and the
 *     database is compared row by row. A key-carrying verb must replay: both calls ok, identical
 *     results, not one row different anywhere. This is the money path, so rule 9 counts the rows of
 *     `post_entry` by hand as well rather than trusting a snapshot to have noticed.
 * 10. APPEND-ONLY, guarded at the layer that enforces it. Immutability is not a TypeScript check, it
 *     is five BEFORE triggers in `schema.ts`, so the rule asserts the TRIGGERS are present and still
 *     abort. A sweep of the verbs would be vacuous: the database refuses before a verb gets a say.
 * 11. REVERSAL SYMMETRY. Every entry carrying `reverses_entry_id` nets its original back to zero,
 *     account by account, in base minor units. Derived from the DATA, so a capability that invents
 *     its own reversal path is covered without anyone knowing the path exists.
 * 12. §H-TENANT, isolation and not merely rejection. Rule 6 covers the tenant that is missing or
 *     unknown. This covers the tenant that is real and WRONG, which is the shape a leak actually
 *     takes: valid workspace, valid session, entity ids belonging to somebody else.
 *
 * RULES 10 TO 12 ARE PROVEN BY MUTATION (D85). `invariant-mutation.test.mjs` breaks each one and
 * proves it goes red, driving the SAME detectors from `invariants.mjs` that these rules drive. A
 * money-path assertion nobody has watched fail is the vacuous kind, and the vacuous kind reports
 * safety it never measured.
 *
 * TWO OF CLAUDE.md's FIVE INVARIANTS ARE DELIBERATELY ABSENT, because each was already standing here
 * and a second copy is not a second guarantee. Idempotent-on-rows IS rule 8. Balanced (debits equal
 * credits) is structural in `postEntry.ts`, the one door every posting verb goes through.
 *
 * Everything runs offline against fresh in-memory stores.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { ACTIONS, getAction } from '../../dist/api/registry.js';
import { callTool, makeApiDeps } from '../../dist/api/mcp.js';
import { createMcpHttpHandler } from '../../dist/api/mcp-http.js';
import { handleRest } from '../../dist/api/rest.js';
import { freshDeps, mintWorkspace, manualPost } from './support.mjs';
import {
  tenantSnapshot,
  reversalViolations,
  tenantViolations,
} from './invariants.mjs';
import {
  SCENARIOS,
  READ_SCENARIOS,
  READ_SCENARIO_FLOOR,
  READ_WRITE_CARVEOUTS,
  IDEMPOTENCY_KEY_EXEMPT,
  AUDIT_TABLES,
  fixture,
} from './conformance-contract.mjs';

// --- Shared helpers ----------------------------------------------------------------------------

/** A ctx verb is one whose schema requires a tenant. Derived, so a new verb classifies itself. */
const isCtx = (action) => action.inputSchema.required.includes('workspaceId');

/** Write verbs and read verbs, derived from the registry rather than listed. */
const writes = () => ACTIONS.filter((a) => a.kind === 'write');
const reads = () => ACTIONS.filter((a) => a.kind === 'read');

/**
 * Every row of every table, as a comparable string. The table list comes from `sqlite_master`, so a
 * table added by a future migration is covered without touching this harness.
 */
function snapshotByTable(store, { skip = [] } = {}) {
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name)
    .filter((name) => !skip.includes(name));
  const out = {};
  for (const t of tables) out[t] = store.db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all();
  return out;
}

function snapshot(store, opts) {
  return JSON.stringify(snapshotByTable(store, opts));
}

/**
 * The names of the tables whose rows differ between two per-table snapshots. Used by the D96
 * carve-out: a read verb blessed to write a bounded set of tables is judged by WHICH tables it
 * changed, not merely whether it changed anything.
 */
function changedTables(beforeObj, afterObj) {
  const names = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]);
  const changed = [];
  for (const n of names) {
    if (JSON.stringify(beforeObj[n]) !== JSON.stringify(afterObj[n])) changed.push(n);
  }
  return changed.sort();
}

/**
 * Collect failures instead of stopping at the first one, then assert once. A gate that names all
 * eleven broken verbs in one run is worth far more to the person fixing them than one that names the
 * alphabetically first.
 */
function collector() {
  const failures = [];
  return {
    check(condition, message) {
      if (!condition) failures.push(message);
    },
    done(rule) {
      assert.equal(failures.length, 0, `${rule}:\n  ${failures.join('\n  ')}`);
    },
  };
}

/**
 * A type-VALID filler for every required field except the tenant, derived from the schema. Used by
 * the rules that want to isolate ONE fault (a missing tenant, an unknown tenant) without the other
 * arguments failing first for an unrelated reason.
 */
function validFiller(action, workspaceId) {
  const out = {};
  for (const field of action.inputSchema.required) {
    if (field === 'workspaceId') {
      if (workspaceId !== undefined) out[field] = workspaceId;
      continue;
    }
    const declared = action.inputSchema.properties[field]?.type;
    if (declared === 'integer') out[field] = 1;
    else if (declared === 'boolean') out[field] = true;
    else if (declared === 'array') out[field] = [];
    else if (declared === 'object') out[field] = {};
    else out[field] = 'x';
  }
  return out;
}

/**
 * The hostile inputs every verb is subjected to, built from its OWN schema so a new verb gets a
 * tailored battery for free. These are the shapes a real MCP client can put on the wire: the schema
 * is advertised to the client, not enforced by it.
 */
function hostileInputs(action, workspaceId) {
  const req = action.inputSchema.required;
  const withReq = (value) =>
    Object.fromEntries(req.map((k) => [k, k === 'workspaceId' ? workspaceId : value]));
  return [
    ['no arguments at all', {}],
    ['tenant only, every other required field missing', { workspaceId }],
    ['required fields null', withReq(null)],
    ['required fields a number where a name was wanted', withReq(123)],
    ['required fields an array', withReq([])],
    ['required fields an object', withReq({})],
    ['required fields the empty string', withReq('')],
    ['required fields a boolean', withReq(true)],
    ['a deeply nested object where a scalar was wanted', withReq({ a: { b: { c: [1, 2, 3] } } })],
    ['an unknown extra field alongside nothing else', { workspaceId, __not_a_field__: 'x' }],
  ];
}

/** Start the MCP HTTP face on loopback. Nothing leaves 127.0.0.1, so the suite stays offline. */
async function withWire(body) {
  const { deps, store } = makeApiDeps();
  const handler = createMcpHttpHandler(deps);
  const http = createServer((req, res) => {
    void handler.handleRequest(req, res);
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address();
  const client = new Client({ name: 'conformance-probe', version: '0.0.0' }, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    await body({ client, deps });
  } finally {
    await client.close();
    await handler.closeAll();
    // Force-close lingering keep-alive / SSE sockets so `http.close()` resolves instead of blocking on
    // an idle StreamableHTTP client (which wedges the node test runner's per-file child on exit).
    const httpClosed = new Promise((resolve) => http.close(resolve));
    http.closeAllConnections();
    await httpClosed;
    store.close();
  }
}

// --- Rule 1, identity (§H-ENUM) ----------------------------------------------------------------

test('conformance: every verb has a stable snake_case name and a usable description', () => {
  const c = collector();
  const seenNames = new Set();
  const seenSummaries = new Map();
  for (const a of ACTIONS) {
    c.check(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(a.name), `${a.name}: a tool name must be snake_case`);
    c.check(!seenNames.has(a.name), `${a.name}: duplicate tool name`);
    seenNames.add(a.name);

    c.check(a.kind === 'read' || a.kind === 'write', `${a.name}: kind must be read or write`);
    c.check(typeof a.run === 'function', `${a.name}: run must be a function`);

    const s = a.summary;
    c.check(typeof s === 'string' && s.length >= 12, `${a.name}: description is missing or too short`);
    c.check(typeof s === 'string' && s.trim().split(/\s+/).length >= 3, `${a.name}: description is not a sentence`);
    c.check(typeof s === 'string' && /^[A-Z]/.test(s), `${a.name}: description should start with a capital`);
    c.check(typeof s === 'string' && s.trim().endsWith('.'), `${a.name}: description should end in a full stop`);
    const twin = seenSummaries.get(s);
    c.check(twin === undefined, `${a.name}: shares its description with ${twin} (an agent cannot tell them apart)`);
    seenSummaries.set(s, a.name);

    c.check(getAction(a.name) === a, `${a.name}: getAction does not resolve to this action`);
  }
  c.done('identity');
});

test('conformance: a verb named like a read is a read, and one named like a write is a write', () => {
  // A mislabelled kind is invisible in review and lies to every client through `readOnlyHint`.
  const READ_PREFIXES = ['get_', 'list_'];
  const WRITE_PREFIXES = ['create_', 'update_', 'delete_', 'archive_', 'unarchive_', 'set_', 'post_', 'save_'];
  const c = collector();
  for (const a of ACTIONS) {
    if (READ_PREFIXES.some((p) => a.name.startsWith(p))) {
      c.check(a.kind === 'read', `${a.name}: named like a read but declared ${a.kind}`);
    }
    if (WRITE_PREFIXES.some((p) => a.name.startsWith(p))) {
      c.check(a.kind === 'write', `${a.name}: named like a write but declared ${a.kind}`);
    }
  }
  c.done('name and kind agreement');
});

// --- Rule 2, schema ----------------------------------------------------------------------------

test('conformance: every verb declares a well-formed input schema', () => {
  const c = collector();
  for (const a of ACTIONS) {
    const s = a.inputSchema;
    c.check(s !== null && typeof s === 'object', `${a.name}: no input schema`);
    if (s === null || typeof s !== 'object') continue;
    c.check(s.type === 'object', `${a.name}: an MCP inputSchema must be type object`);
    c.check(s.properties !== null && typeof s.properties === 'object', `${a.name}: properties must be an object`);
    c.check(Array.isArray(s.required), `${a.name}: required must be an array`);
    c.check(typeof s.additionalProperties === 'boolean', `${a.name}: additionalProperties must be declared`);
    if (!Array.isArray(s.required)) continue;
    c.check(new Set(s.required).size === s.required.length, `${a.name}: required lists a field twice`);
    for (const field of s.required) {
      c.check(typeof field === 'string', `${a.name}: a required entry is not a string`);
      c.check(field in s.properties, `${a.name}: requires "${field}" but never declares it in properties`);
    }
    for (const [field, spec] of Object.entries(s.properties)) {
      c.check(spec !== null && typeof spec === 'object', `${a.name}.${field}: a property must be a schema object`);
      c.check(
        spec !== null && typeof spec === 'object' && ('type' in spec || 'oneOf' in spec || 'anyOf' in spec),
        `${a.name}.${field}: a property must declare a type`,
      );
    }
  }
  c.done('input schema');
});

test('conformance: a ctx verb requires its tenant and a pre-workspace verb never does', () => {
  // Derived from the tenant invariant §H-TENANT: a verb that touches workspace-scoped rows without
  // requiring a workspace id is either cross-tenant or crashing, and both are worse than a rejection.
  const c = collector();
  for (const a of ACTIONS) {
    const declaresTenant = 'workspaceId' in a.inputSchema.properties;
    const requiresTenant = a.inputSchema.required.includes('workspaceId');
    c.check(
      declaresTenant === requiresTenant,
      `${a.name}: declares workspaceId=${declaresTenant} but requires it=${requiresTenant} (an optional tenant is a cross-tenant read waiting to happen)`,
    );
  }
  c.done('tenant declaration');
});

// --- Rule 3, honest annotations on the real wire -----------------------------------------------

test('conformance: tools/list advertises exactly the registry, name for name, with honest hints', async () => {
  await withWire(async ({ client }) => {
    const { tools } = await client.listTools();
    const c = collector();
    const advertised = new Map(tools.map((t) => [t.name, t]));

    c.check(
      tools.length === ACTIONS.length,
      `the wire advertises ${tools.length} tools, the registry defines ${ACTIONS.length}`,
    );
    for (const t of tools) {
      c.check(getAction(t.name) !== undefined, `${t.name}: advertised over MCP but absent from the registry`);
    }
    for (const a of ACTIONS) {
      const t = advertised.get(a.name);
      c.check(t !== undefined, `${a.name}: in the registry but never advertised over tools/list`);
      if (t === undefined) continue;
      // §H-ENUM: the advertised name IS the registry name. A translation layer here is a rename
      // waiting to break every stored agent prompt.
      c.check(t.name === a.name, `${a.name}: advertised as ${t.name}`);
      // A35 (critic F11): a dial-governed verb advertises its consequence sentence to the MCP
      // client, appended to the summary; every other verb advertises the summary verbatim.
      const expectedDescription =
        a.consequence === undefined ? a.summary : `${a.summary} CONSEQUENCE: ${a.consequence}`;
      c.check(t.description === expectedDescription, `${a.name}: the advertised description drifted from the registry`);
      c.check(t.inputSchema?.type === 'object', `${a.name}: the advertised schema is not an object schema`);
      c.check(
        JSON.stringify(t.inputSchema?.required ?? []) === JSON.stringify(a.inputSchema.required),
        `${a.name}: the advertised required list drifted from the registry`,
      );
      // MCP defaults readOnlyHint to false, so silence means "this writes". A read verb that stays
      // silent is under-claiming and a write verb that claims it is lying.
      const hint = t.annotations?.readOnlyHint;
      if (a.kind === 'read') c.check(hint === true, `${a.name}: a read verb must advertise readOnlyHint`);
      else c.check(hint !== true, `${a.name}: a write verb must not advertise readOnlyHint`);
    }
    c.done('tools/list');
  });
});

// --- Rule 4, read means read -------------------------------------------------------------------

test('conformance: no read verb mutates the database, on the happy path or the rejecting one', () => {
  const c = collector();
  for (const a of reads()) {
    const fx = fixture();
    // Two shapes: the tenant alone (the happy read), and the tenant plus bogus ids (the rejecting
    // read). A read verb must be inert on both, including the path where it decides to reject.
    const inputs = [
      isCtx(a) ? { workspaceId: fx.workspaceId } : {},
      Object.fromEntries(
        a.inputSchema.required.map((k) => [k, k === 'workspaceId' ? fx.workspaceId : 'no_such_id']),
      ),
    ];
    for (const input of inputs) {
      const before = snapshot(fx.deps.store);
      a.run(fx.deps, input);
      const after = snapshot(fx.deps.store);
      c.check(before === after, `${a.name}: a read verb changed the database (input ${JSON.stringify(input)})`);
    }
    fx.deps.store.close();
  }
  c.done('read-only honesty');
});

test('conformance: a read verb driven on REAL data still writes nothing, and answers the same twice', () => {
  // The rule above proves a read is inert when it REJECTS and when the workspace is empty, because
  // those are the only inputs a machine can invent. This one proves it on the happy path, which is
  // the shape a "read" defect actually takes: a verb that writes only when it succeeds passes the
  // rule above untouched. The inputs come from `READ_SCENARIOS`, which is opt-in, so this rule grows
  // one verb at a time rather than landing red on forty.
  const c = collector();
  const readNames = new Set(reads().map((a) => a.name));
  for (const [name, scenario] of Object.entries(READ_SCENARIOS)) {
    c.check(readNames.has(name), `${name}: has a read scenario but is not a read verb in the registry`);
    const action = getAction(name);
    if (action === undefined || action.kind !== 'read') continue;

    const fx = fixture();
    const input = scenario(fx);
    // The snapshot is taken AFTER the scenario's own setup writes, so what is compared is the verb
    // under test and not its fixture.
    const beforeObj = snapshotByTable(fx.deps.store);
    const before = JSON.stringify(beforeObj);
    const first = action.run(fx.deps, input);
    c.check(first.ok === true, `${name}: the read scenario's call must succeed, got ${JSON.stringify(first)}`);

    const carveout = READ_WRITE_CARVEOUTS[name];
    if (carveout !== undefined) {
      // THE ONE BLESSED READ-VERB WRITER (D96): `egress_self_test` proves the local-first claim by
      // running the real E04 -> E06 draft loop under the hard egress probe, which PERSISTS a local
      // draft. The exception is BOUNDED to exactly the named tables: every table that changed must be
      // in the carve-out, so a money, ledger or audit row it touched is NOT in the set and FAILS
      // here. No other read verb is a key in `READ_WRITE_CARVEOUTS`, so this branch is unreachable
      // for them and the rule below is not loosened for anything else. The identical-answer check
      // does NOT apply: a fresh local draft on each press is the behaviour, not a defect (the verb
      // takes no idempotency key on purpose).
      const allowed = new Set(carveout);
      const changed = changedTables(beforeObj, snapshotByTable(fx.deps.store));
      for (const t of changed) {
        c.check(
          allowed.has(t),
          `${name}: the blessed read-verb writer touched \`${t}\`, outside its carve-out {${carveout.join(', ')}} (a read verb may write ONLY the tables D96 blessed)`,
        );
      }
      // Non-vacuous: the carve-out is a live exception only if the verb actually wrote the draft. A
      // scenario that fell through to `needs_setup` would change nothing and silently un-test the
      // exception, which is the exact silence D96 set out to remove.
      c.check(
        changed.length > 0,
        `${name}: the blessed read-verb writer wrote NOTHING, so its carve-out is untested (its scenario did not reach the real draft loop)`,
      );
      fx.deps.store.close();
      continue;
    }

    const second = action.run(fx.deps, input);
    c.check(
      JSON.stringify(second) === JSON.stringify(first),
      `${name}: a read answered differently the second time (${JSON.stringify(second)} vs ${JSON.stringify(first)})`,
    );
    // The WHOLE database, audit tables included: an audit row is a write however small.
    c.check(snapshot(fx.deps.store) === before, `${name}: a read verb CHANGED the database on its happy path`);
    fx.deps.store.close();
  }
  c.done('read-only honesty on real data');
});

test('conformance: egress_self_test (D96) is the ONE blessed read-verb writer and writes ONLY a local draft', () => {
  // D96. `egress_self_test` STAYS a read verb (gated on `egress.read`, held by every role including a
  // viewer) because the offline proof is a trust feature everyone must be able to run. To PROVE the
  // local-first claim it runs the REAL E04 -> E06 draft loop under the hard egress probe, which
  // persists a LOCAL draft (draft_run + mail_draft). The generic "no read writes on real data" rule
  // above passed it before D96 only because no scenario drove it against a set-up workspace, so it
  // hit `needs_setup` and stayed inert. This test converts "passes because unexercised" into "passes
  // because asserted": on a fully set-up workspace it must pass with zero sockets AND write EXACTLY
  // the local draft, touching no money, ledger, or audit row.
  const c = collector();
  const carveout = READ_WRITE_CARVEOUTS.egress_self_test;
  assert.ok(carveout !== undefined, 'egress_self_test must carry a D96 read-write carve-out');
  const allowed = new Set(carveout);

  const fx = fixture();
  const input = READ_SCENARIOS.egress_self_test(fx);
  const beforeObj = snapshotByTable(fx.deps.store);
  const result = getAction('egress_self_test').run(fx.deps, input);

  // The claim, measured: the loop ran end to end (envelope ok) and opened zero sockets, with no
  // offender named. `passed` is the test verdict, distinct from the envelope's `ok` on purpose.
  c.check(result.ok === true, `egress_self_test did not pass on a set-up workspace: ${JSON.stringify(result)}`);
  c.check(result.passed === true, `egress_self_test.passed is not true: ${JSON.stringify(result)}`);
  c.check(result.socketsOpened === 0, `egress_self_test opened ${result.socketsOpened} socket(s) on a clean run`);
  c.check(
    JSON.stringify(result.offenders ?? []) === '[]',
    `egress_self_test named egress offenders on a clean run: ${JSON.stringify(result.offenders)}`,
  );

  // EXACTLY a local draft: the set of tables it changed is precisely the carve-out. "Nothing more"
  // is the narrowness (a money/ledger/audit write would show up here and fail); "nothing less" proves
  // the loop actually persisted the draft rather than short-circuiting, so the proof is not vacuous.
  const changed = new Set(changedTables(beforeObj, snapshotByTable(fx.deps.store)));
  for (const t of changed) {
    c.check(allowed.has(t), `egress_self_test wrote \`${t}\`, outside its {${carveout.join(', ')}} carve-out`);
  }
  for (const t of carveout) {
    c.check(changed.has(t), `egress_self_test did not write \`${t}\`: the local draft was not persisted, so the proof is vacuous`);
  }

  fx.deps.store.close();
  c.done('egress_self_test carve-out (D96)');
});

test('the count of read verbs driven on real data never falls', () => {
  // LOW 4 from the critic on this branch. Opt-in is the right call (mandatory would land red on
  // forty verbs at once, and a gate that lands red teaches people to skip it), but opt-in with no
  // floor means a scenario deleted or commented out is a SILENCE: the verb drops back to being
  // covered only by the rule that never reaches its happy path, which is the exact gap this rule was
  // built to close. A RENAMED scenario is NOT one this floor catches, because the count is unchanged;
  // the cross-check below that every scenario name is a read verb in the registry catches that one.
  //
  // The repo already owns the answer to this shape, and this branch raised it: `DECLARED_FLOOR` in
  // `test/style/result-payload-is-declared.test.mjs` is a monotonic ratchet on an opt-in list. This
  // is the same instrument. The floor is a RECORDED number, so it is raised in the same commit as
  // the scenario it counts, and lowering it is a visible edit in a reviewed diff rather than a
  // deletion nobody sees.
  const covered = Object.keys(READ_SCENARIOS).length;
  assert.ok(
    covered >= READ_SCENARIO_FLOOR,
    `${covered} read verbs are driven on real data and the recorded floor is ${READ_SCENARIO_FLOOR}. ` +
      'Coverage lands one verb at a time and does not go backwards. If a scenario was genuinely ' +
      'removed because its verb was, remove it from the floor in the same commit and say why.',
  );
  assert.equal(
    covered,
    READ_SCENARIO_FLOOR,
    `\`READ_SCENARIO_FLOOR\` is ${READ_SCENARIO_FLOOR} and ${covered} read verbs have a scenario. ` +
      'The floor is the recorded number: raise it in the same commit as the scenario you add.',
  );
  // Stated rather than asserted upward, for the reason `DECLARED_FLOOR` states it: this is a
  // starting position, and a green test that implied otherwise would report a partial capability as
  // a complete one.
  const uncovered = reads().filter((a) => !(a.name in READ_SCENARIOS)).length;
  assert.ok(
    uncovered > 0,
    'every read verb now has a real-data scenario. If that is real, delete this assertion and make ' +
      'the rule above mandatory, which is what the opt-in was always a staging post for.',
  );
});

// --- Rule 5, structured errors -----------------------------------------------------------------

test('conformance: garbage input gives a structured error, never a throw and never a leak', () => {
  const c = collector();
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);

  for (const a of ACTIONS) {
    for (const [label, input] of hostileInputs(a, workspaceId)) {
      const where = `${a.name} [${label}]`;
      let result;
      try {
        result = a.run(deps, input);
      } catch (e) {
        c.check(false, `${where}: THREW instead of returning a Result (${e && e.message})`);
        continue;
      }
      c.check(result !== null && typeof result === 'object', `${where}: did not return a Result object`);
      if (result === null || typeof result !== 'object') continue;
      c.check(typeof result.then !== 'function', `${where}: returned a promise; both adapters are synchronous`);
      c.check(typeof result.ok === 'boolean', `${where}: a Result must carry a boolean ok`);
      if (result.ok) continue;

      c.check(typeof result.error === 'string' && result.error.length > 0, `${where}: a rejection needs an error code`);
      c.check(
        typeof result.error === 'string' && /^[a-z][a-z0-9_]*$/.test(result.error),
        `${where}: "${result.error}" is not a stable machine-readable code`,
      );
      // `unexpected_error` is the catch-all the registry stamps when an exception escaped a verb. It
      // is never a legitimate answer to a bad ARGUMENT: it means the input reached code that was not
      // expecting it, and the caller is handed an internal failure they cannot act on.
      c.check(
        result.error !== 'unexpected_error',
        `${where}: an exception escaped the verb (${result.message}); bad input must be a named rejection`,
      );

      // Nothing internal may cross the boundary to an untrusted client.
      const payload = JSON.stringify(result);
      c.check(!payload.includes('\\n    at '), `${where}: leaks a stack trace`);
      c.check(!/[/\\](Users|home|node_modules|dist)[/\\]/.test(payload), `${where}: leaks a filesystem path`);
      c.check(!payload.includes('SqliteError'), `${where}: leaks the database driver`);
      c.check(!payload.includes('SELECT '), `${where}: leaks SQL`);
    }
  }
  deps.store.close();
  c.done('structured errors');
});

// --- Rule 6, tenant discipline -----------------------------------------------------------------

test('conformance: a missing tenant and an unknown tenant get distinct codes, never a silent ok', () => {
  const c = collector();
  const deps = freshDeps();
  mintWorkspace(deps);

  for (const a of ACTIONS.filter(isCtx)) {
    // Type-valid filler, so the ONLY thing wrong with each call below is the tenant.
    const filler = validFiller(a, undefined);

    const missing = a.run(deps, filler);
    c.check(missing.ok === false, `${a.name}: returned ok with NO tenant at all`);
    c.check(missing.error === 'invalid_input', `${a.name}: a missing tenant should be invalid_input, saw ${missing.error}`);

    const blank = a.run(deps, { ...filler, workspaceId: '' });
    c.check(blank.ok === false, `${a.name}: returned ok on a blank tenant`);
    c.check(blank.error === 'invalid_input', `${a.name}: a blank tenant should be invalid_input, saw ${blank.error}`);

    const unknown = a.run(deps, { ...filler, workspaceId: 'ws_does_not_exist' });
    c.check(unknown.ok === false, `${a.name}: returned ok on a tenant that does not exist`);
    c.check(
      unknown.error === 'workspace_not_found',
      `${a.name}: an unknown tenant should be workspace_not_found, saw ${unknown.error}`,
    );
    // The two must stay DISTINCT: a client retries a typo, but it fixes a missing argument.
    c.check(missing.error !== unknown.error, `${a.name}: cannot tell a missing tenant from an unknown one`);
  }
  deps.store.close();
  c.done('tenant discipline');
});

// --- Rule 7, the faces agree -------------------------------------------------------------------

test('conformance: registry, MCP callTool and REST return the identical Result for the same call', () => {
  const c = collector();
  for (const a of ACTIONS) {
    // Three IDENTICAL worlds, one per face, because a call mutates and the faces must not share a
    // store. `freshDeps` pins the clock and the id sequence, so all three mint the same workspace id
    // and the same input is genuinely the same input on all three.
    const fx = fixture();
    const rest = freshDeps();
    const restWs = mintWorkspace(rest).workspaceId;
    const mcp = freshDeps();
    const mcpWs = mintWorkspace(mcp).workspaceId;
    assert.equal(restWs, fx.workspaceId, 'the three faces must be given identical worlds');
    assert.equal(mcpWs, fx.workspaceId, 'the three faces must be given identical worlds');

    for (const [label, input] of hostileInputs(a, fx.workspaceId)) {
      const where = `${a.name} [${label}]`;
      const viaRegistry = a.run(fx.deps, input);
      const viaRest = handleRest(a.name, input, rest);
      const call = callTool(mcp, a.name, input);
      const viaMcp = JSON.parse(call.content[0].text);

      c.check(
        JSON.stringify(viaRest.body.ok) === JSON.stringify(viaRegistry.ok),
        `${where}: REST and the registry disagree on the outcome`,
      );
      c.check(viaRest.body.error === viaRegistry.error, `${where}: REST error ${viaRest.body.error} vs ${viaRegistry.error}`);
      c.check(viaMcp.ok === viaRegistry.ok, `${where}: MCP and the registry disagree on the outcome`);
      c.check(viaMcp.error === viaRegistry.error, `${where}: MCP error ${viaMcp.error} vs ${viaRegistry.error}`);
      // A domain rejection is a normal result the agent reads, not a protocol failure. Setting
      // isError here would make every business "no" look like a broken server.
      c.check(call.isError === undefined, `${where}: a domain rejection was raised as an MCP protocol error`);
      c.check(call.content.length === 1 && call.content[0].type === 'text', `${where}: not a single JSON text block`);
      // The REST status mapping is part of the contract too.
      c.check(
        viaRest.status === (viaRegistry.ok ? 200 : 422),
        `${where}: REST status ${viaRest.status} does not match the outcome`,
      );
    }
    fx.deps.store.close();
    rest.store.close();
    mcp.store.close();
  }
  c.done('face parity');
});

// --- Rule 8, idempotency, the headline ---------------------------------------------------------

test('conformance: every write verb is exercised by the contract, and the contract has no rot', () => {
  // This is the rule that makes the gate STANDING. A write verb appended to the registry with no
  // scenario fails here, which forces the author to say how it is called before it can ship.
  const c = collector();
  const writeNames = new Set(writes().map((a) => a.name));
  for (const a of writes()) {
    c.check(a.name in SCENARIOS, `${a.name}: is a write verb with no scenario in conformance-contract.mjs`);
  }
  for (const name of Object.keys(SCENARIOS)) {
    c.check(writeNames.has(name), `${name}: has a scenario but is not a write verb in the registry (stale contract)`);
  }
  for (const name of Object.keys(IDEMPOTENCY_KEY_EXEMPT)) {
    c.check(writeNames.has(name), `${name}: is exempted from §H-IDEMPOTENT but is not a write verb (stale exemption)`);
    const action = getAction(name);
    c.check(
      action === undefined || !('idempotencyKey' in action.inputSchema.properties),
      `${name}: is on the exemption list but DOES take an idempotency key; remove the exemption`,
    );
    c.check(
      typeof IDEMPOTENCY_KEY_EXEMPT[name] === 'string' && IDEMPOTENCY_KEY_EXEMPT[name].length > 20,
      `${name}: an exemption needs a real written reason`,
    );
  }
  c.done('contract coverage');
});

test('conformance: every write verb takes an idempotency key, or is consciously exempted (H-IDEMPOTENT)', () => {
  const c = collector();
  for (const a of writes()) {
    const takesKey = 'idempotencyKey' in a.inputSchema.properties;
    c.check(
      takesKey || a.name in IDEMPOTENCY_KEY_EXEMPT,
      `${a.name}: a write verb must take an idempotencyKey (H-IDEMPOTENT), or be added to IDEMPOTENCY_KEY_EXEMPT with a reason`,
    );
  }
  c.done('idempotency key declaration');
});

test('conformance: calling a write verb TWICE with the same input moves the ledger once', () => {
  const c = collector();
  for (const a of writes()) {
    const scenario = SCENARIOS[a.name];
    if (scenario === undefined) continue; // already failed above; do not double-report.
    const fx = fixture();
    const input = scenario(fx);
    const takesKey = 'idempotencyKey' in a.inputSchema.properties;
    // A key-carrying verb replays its stored result and touches NOTHING. A key-exempt verb genuinely
    // re-runs, so a second audit row is correct; its BUSINESS state still must not move.
    const skip = takesKey ? [] : [...AUDIT_TABLES];

    const first = a.run(fx.deps, input);
    c.check(first.ok === true, `${a.name}: the scenario's first call must succeed, got ${JSON.stringify(first)}`);
    if (first.ok !== true) {
      fx.deps.store.close();
      continue;
    }

    const between = snapshot(fx.deps.store, { skip });
    const second = a.run(fx.deps, input);

    if (takesKey) {
      c.check(second.ok === true, `${a.name}: replaying an idempotency key must succeed, got ${JSON.stringify(second)}`);
      c.check(
        JSON.stringify(second) === JSON.stringify(first),
        `${a.name}: the replay returned a DIFFERENT result (${JSON.stringify(second)} vs ${JSON.stringify(first)})`,
      );
    }

    const after = snapshot(fx.deps.store, { skip });
    c.check(
      between === after,
      `${a.name}: the second call with the same input CHANGED the database; a duplicate delivery double-counted`,
    );
    fx.deps.store.close();
  }
  c.done('double-call safety');
});

// --- Rule 9, the money path, counted by hand ---------------------------------------------------

test('conformance: post_entry twice on one key writes ONE entry and TWO lines, over the real MCP wire', async () => {
  // The headline case of D14.2, driven the way an agent actually drives it: over MCP, and asserted
  // on the ROWS rather than on the return value, because a verb that returns the right id while
  // writing a second entry is exactly the bug this is here to catch.
  await withWire(async ({ client, deps }) => {
    const created = await client.callTool({
      name: 'create_workspace',
      arguments: { name: 'Doppelbuchung GmbH', idempotencyKey: 'ws-1' },
    });
    const { workspaceId } = JSON.parse(created.content[0].text);
    const accId = (number) =>
      deps.store.db
        .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
        .get(workspaceId, number).id;

    // A35: the transport dispatch routes the AGENT seat's `post_entry` through the dial, and every
    // dial ships at `ask`, so an ungranted post over the wire drafts instead of posting. This test is
    // about the KEYED double-post on the ROWS, so it exercises the D103 grant ceremony first (an
    // attributed, per-capability `set_agent_dial` to `auto`), which is exactly how a real workspace
    // arms an agent to post. The drafting path has its own suite (test/agent/agent-gate.test.mjs).
    // F1: the wire client resolves to the AGENT seat, which may never write its own dial, so the
    // grant is performed as the studio seat through the registry (the D103 ceremony), and the wire
    // then drives the granted agent.
    const granted = getAction('set_agent_dial').run(
      { ...deps, actor: 'studio' },
      { workspaceId, capability: 'post', level: 'auto', idempotencyKey: 'wire-grant' },
    );
    assert.equal(granted.ok, true, 'the grant must land before the wire post');

    const args = {
      workspaceId,
      date: '2026-03-01',
      description: 'Büromaterial bar bezahlt',
      source: 'manual',
      idempotencyKey: 'the-same-key',
      lines: [
        { account: accId('6500'), debit: 5000 },
        { account: accId('1000'), credit: 5000 },
      ],
    };

    const one = JSON.parse((await client.callTool({ name: 'post_entry', arguments: args })).content[0].text);
    const two = JSON.parse((await client.callTool({ name: 'post_entry', arguments: args })).content[0].text);

    assert.equal(one.ok, true, 'the first post must succeed');
    assert.equal(two.ok, true, 'a retry on the same key must succeed, not reject');
    assert.equal(two.entryId, one.entryId, 'the retry must replay the ORIGINAL entry id');

    const entries = deps.store.db
      .prepare("SELECT * FROM journal_entry WHERE workspace_id = ? AND status = 'posted'")
      .all(workspaceId);
    assert.equal(entries.length, 1, 'a double-post wrote a SECOND journal entry: the ledger double-counted');

    const lines = deps.store.db
      .prepare('SELECT * FROM journal_line WHERE entry_id = ?')
      .all(one.entryId);
    assert.equal(lines.length, 2, 'the replay must not append lines to the original entry');

    // And the money still balances, in integer Rappen (§H-LEDGER).
    const debit = lines.reduce((sum, l) => sum + l.debit_minor, 0);
    const credit = lines.reduce((sum, l) => sum + l.credit_minor, 0);
    assert.equal(debit, 5000);
    assert.equal(credit, debit, 'the entry must balance');
  });
});

// --- Rules 10 to 12, the money-path invariants (D85) --------------------------------------------
//
// WHY THESE THREE AND NOT FIVE. CLAUDE.md names five money-path invariants. Two of them were
// already standing rules here before this section existed and adding them again would have bought a
// second copy rather than a second guarantee:
//
//   - IDEMPOTENT ON ROWS is rule 8. Every write verb is already called twice and the database is
//     already compared row by row.
//   - BALANCED (debits equal credits) is enforced STRUCTURALLY in `postEntry.ts`, which is the one
//     door every posting verb goes through, so no capability can bypass it and a test could only
//     re-observe the impossible.
//
// The other three had no standing rule anywhere. Each one below is derived from `ACTIONS` and the
// SCENARIOS table, so a capability that lands next month is held to all three with nobody editing
// this file. That property IS the point: it is what makes an invariant a floor rather than a thing
// each capability agent has to remember, and it is why this is three rules on the existing gate
// instead of a second harness beside it.
//
// PROVEN BY MUTATION, not by assumption. `test/api/invariant-mutation.test.mjs` breaks each of the
// three in the real engine and proves the rule goes red. A green assertion that cannot fail is the
// exact failure mode the non-author rule in CLAUDE.md exists to prevent.

// --- Rule 10, append-only, guarded where it is actually enforced ------------------------------

test('conformance: the posted-immutability triggers exist and really abort (append-only)', () => {
  // APPEND-ONLY IS NOT ENFORCED IN TYPESCRIPT. It is enforced by five BEFORE triggers in
  // `schema.ts`, which RAISE(ABORT, 'posted_immutable') on any update or delete of a posted entry
  // or its lines. That is a much stronger guarantee than any engine check: it holds against a
  // capability with a raw handle on the database, and it cannot be forgotten by a new verb.
  //
  // WHICH IS EXACTLY WHY THE RULE HERE IS NOT "call every write verb and see if history moved".
  // That sweep can never go red: the database refuses before the verb gets a say, so it would
  // report safety it did not measure, which is the one thing a money-path assertion must never do.
  // The real exposure is a MIGRATION that drops or narrows a trigger, so this asserts the mechanism
  // rather than re-observing the impossible: the triggers are present, and each one still bites.
  const fx = fixture();
  const posted = fx.call('post_entry', manualPost(fx.accId, 'trigger-guard'));
  assert.equal(posted.ok, true, 'the seed post must succeed');

  const triggers = new Set(
    fx.deps.store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
      .all()
      .map((r) => r.name),
  );
  const c = collector();
  for (const t of [
    'journal_entry_no_update_posted',
    'journal_entry_no_delete_posted',
    'journal_line_no_insert_posted',
    'journal_line_no_update_posted',
    'journal_line_no_delete_posted',
  ]) {
    c.check(triggers.has(t), `${t}: the immutability trigger is GONE; posted entries are editable`);
  }

  // Presence is not the claim. Each of the three shapes is attempted for real, because a trigger
  // whose WHEN clause a migration narrowed is still present and no longer protects anything.
  const attempts = [
    ['UPDATE a posted entry', () => fx.deps.store.db.prepare('UPDATE journal_entry SET description = ? WHERE id = ?').run('edited', posted.entryId)],
    ['DELETE a posted entry', () => fx.deps.store.db.prepare('DELETE FROM journal_entry WHERE id = ?').run(posted.entryId)],
    ['UPDATE a posted line', () => fx.deps.store.db.prepare('UPDATE journal_line SET debit_minor = 1 WHERE entry_id = ?').run(posted.entryId)],
    ['DELETE a posted line', () => fx.deps.store.db.prepare('DELETE FROM journal_line WHERE entry_id = ?').run(posted.entryId)],
    ['INSERT a line onto a posted entry', () => fx.deps.store.db.prepare('INSERT INTO journal_line (id, entry_id, account_id, debit_minor, credit_minor, currency) VALUES (?,?,?,?,?,?)').run('smuggled', posted.entryId, fx.accId('1000'), 1, 0, 'CHF')],
  ];
  for (const [what, attempt] of attempts) {
    let aborted = false;
    try {
      attempt();
    } catch (e) {
      aborted = /posted_immutable/.test(String(e.message ?? e));
    }
    c.check(aborted, `${what}: succeeded, or failed for the wrong reason; the ledger is not append-only`);
  }
  fx.deps.store.close();
  c.done('append-only enforcement');
});

// --- Rule 11, reversal symmetry ----------------------------------------------------------------

test('conformance: every reversal exactly negates the entry it reverses, line for line', () => {
  // Derived from the DATA, not from verb names: any entry carrying `reverses_entry_id` is a
  // reversal, however it was produced. A capability that invents its own reversal path is covered
  // without knowing the path exists, which name-matching on `reverse_*` could never do.
  const c = collector();
  for (const a of writes()) {
    const scenario = SCENARIOS[a.name];
    if (scenario === undefined) continue;
    const fx = fixture();
    a.run(fx.deps, scenario(fx));

    for (const v of reversalViolations(fx.deps.store)) c.check(false, `${a.name}: ${v}`);

    fx.deps.store.close();
  }
  c.done('reversal symmetry');
});

// --- Rule 12, §H-TENANT: isolation, not just rejection -----------------------------------------

test('conformance: a verb aimed at tenant B can never move tenant A rows (§H-TENANT)', () => {
  // Rule 6 covers the tenant that is MISSING or UNKNOWN. This covers the tenant that is real and
  // WRONG, which is the shape a leak actually takes: valid workspace, valid session, entity ids
  // belonging to somebody else. The verb may reject or it may write B-scoped rows; what it may
  // never do is touch A.
  const c = collector();
  for (const a of writes()) {
    const scenario = SCENARIOS[a.name];
    if (scenario === undefined) continue;
    const fx = fixture();
    const input = scenario(fx);
    if (typeof input.workspaceId !== 'string') {
      fx.deps.store.close();
      continue; // a pre-workspace verb has no tenant to confuse.
    }

    // Build A's real state first, so the ids handed to B below are ids that genuinely exist.
    const first = a.run(fx.deps, input);
    if (first.ok !== true) {
      fx.deps.store.close();
      continue; // rule 8 already reports a scenario that cannot succeed.
    }
    const aBefore = tenantSnapshot(fx.deps.store, input.workspaceId);

    const other = mintWorkspace(fx.deps, 'Fremde GmbH', 'tenant-b');
    a.run(fx.deps, { ...input, workspaceId: other.workspaceId });

    const leaked = tenantViolations(aBefore, tenantSnapshot(fx.deps.store, input.workspaceId), a.name);
    for (const v of leaked) c.check(false, `${v}; §H-TENANT is not enforced on this verb`);
    fx.deps.store.close();
  }
  c.done('cross-tenant isolation');
});
