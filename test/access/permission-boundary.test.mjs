/**
 * A24, the permission boundary: it cannot be routed around, and a denial writes nothing.
 *
 * WHAT THIS SUITE IS FOR, stated as the thing that would otherwise be missing. A24 does not gate its
 * sixty-nine write verbs one verb at a time; it gates them ONCE, in `ctxAction`'s shared dispatch in
 * `src/api/registry.ts`, after the tenant checks and before the verb. That is the whole design, and
 * it has exactly one failure mode worth losing sleep over: a door that does not go through that
 * dispatch. There are two doors, MCP stdio (`src/api/mcp.ts`) and the REST twins (`src/api/rest.ts`),
 * and BOTH are driven here on every gated write verb the registry holds, derived from `ACTIONS`
 * rather than listed, so a verb appended next month is held to the same rule with nobody editing
 * this file.
 *
 * AND THE SECOND CLAIM, which is the one a `{ ok: false }` cannot make on its own: a denied write
 * leaves the DATABASE unchanged. Every table, every row, compared before and after. A verb that
 * refuses in its answer and writes in its body is the shape of defect a return-value assertion
 * sleeps through, and it is the only shape that matters on an append-only ledger.
 *
 * The actor set is D13's (`src/api/session.ts`): `studio` and `agent` are transports rather than
 * people, and under D50 a provisioning seats both of them as owners. So the fixture below is not a
 * contrivance: it is precisely US-A24.5, an owner narrowing the `agent` actor to a restricted role
 * so that every `till mcp` call is bounded by it. What moved with D50 is the mechanism, from an
 * invite the agent redeems to a `set_role` on the seat it already holds, and the fixture says so.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ACTIONS, getAction } from '../../dist/api/registry.js';
import { callTool } from '../../dist/api/mcp.js';
import { handleRest } from '../../dist/api/rest.js';
import {
  CAPABILITY_FOR_ACTION,
  VIEWER_CAPABILITIES,
  isUngated,
  requiredCapabilitiesFor,
} from '../../dist/core/access/index.js';
import { ENTITY_KIND_IDS } from '../../dist/core/customization/index.js';
import { systemIdGen, sequenceIdGen } from '../../dist/core/ids.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

/** Every row of every table, as a comparable string. Table list from `sqlite_master`, so a table a */
/* future migration adds is covered without touching this harness. */
function snapshot(store) {
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  const out = {};
  for (const t of tables) out[t] = store.db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all();
  return JSON.stringify(out);
}

/**
 * A type-VALID filler for every required field, so the CAPABILITY is the first thing that refuses.
 *
 * `entityKind` gets a REAL kind rather than the generic `'x'`, and the difference is not cosmetic.
 * G00's verbs resolve their capability FROM that value (`readCapabilityForKind`,
 * `editCapabilityForKind`), and both fail closed to `manage_custom_fields` on a kind that does not
 * exist. Fed `'x'`, this harness would measure the fail-closed branch and report it as policy: it
 * did, claiming a viewer is refused `list_field_defs` on `manage_custom_fields`, which is true of
 * nonsense input and false of the product. The value is taken from the engine's own registry so a
 * kind added later is exercised without anyone editing this file.
 */
const A_REAL_ENTITY_KIND = ENTITY_KIND_IDS[0];

function validFiller(action, workspaceId) {
  const out = {};
  for (const field of action.inputSchema.required) {
    if (field === 'workspaceId') {
      out[field] = workspaceId;
      continue;
    }
    if (field === 'entityKind') {
      out[field] = A_REAL_ENTITY_KIND;
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

/** The write verbs the boundary really gates: ctx verbs with a capability rather than an exemption. */
function gatedCtxWrites() {
  return ACTIONS.filter(
    (a) =>
      a.kind === 'write' &&
      a.inputSchema.required.includes('workspaceId') &&
      CAPABILITY_FOR_ACTION[a.name] !== undefined &&
      !isUngated(CAPABILITY_FOR_ACTION[a.name]),
  );
}

/**
 * A workspace whose owner is `studio` and in which the `agent` actor holds `role`.
 *
 * The flow is the product's own, and D50 changed which flow that is. `invite_member` seats EVERY
 * D13 actor as an accepted owner (that is the moment the workspace stops being ungated) and writes
 * the invitee's pending row. So the agent is already a member with a row of its own, and narrowing
 * it is `set_role` on that row rather than an invite it redeems: one call, from the Members surface,
 * on an identity the operator can see. That IS US-A24.5 after D50, and it is the only route left,
 * because a seated actor now answers `actor_already_member` to `accept_invite`.
 *
 * Nothing here writes a row by hand, so a change to that flow reddens this fixture rather than
 * leaving it asserting against a world the engine no longer produces.
 */
function workspaceWhereAgentHolds(role, seed = 'pb') {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Zugriff GmbH', `${seed}-ws`);

  const invited = getAction('invite_member').run(deps, {
    workspaceId,
    email: `${seed}@muster.ch`,
    role,
    idempotencyKey: `${seed}-invite`,
  });
  assert.equal(invited.ok, true, `invite failed: ${JSON.stringify(invited)}`);

  const listed = getAction('list_members').run(deps, { workspaceId });
  assert.equal(listed.ok, true, `list_members failed: ${JSON.stringify(listed)}`);
  const seat = listed.members.find((m) => m.actorId === 'agent');
  assert.ok(seat !== undefined, 'the flip did not seat the agent, so there is no row to narrow');

  const narrowed = getAction('set_role').run(deps, { workspaceId, memberId: seat.memberId, role });
  assert.equal(narrowed.ok, true, `set_role failed: ${JSON.stringify(narrowed)}`);

  deps.actor = 'agent';
  return { deps, workspaceId, accId, memberId: invited.memberId };
}

/**
 * Does a VIEWER hold every capability this verb declares for this input?
 *
 * DERIVED RATHER THAN LISTED, and the difference is what this suite learned on 29.07.2026. It used
 * to assert a flat "every gated write refuses a viewer", which was true only because the population
 * was self-selected: a verb a viewer may legitimately call had to be `ungated` to stay out of the
 * set, and `ungated` is exactly the declaration the wave critic showed nobody audits. Two verbs then
 * gained a real gate on a READ domain (`create_saved_view`, whose old exemption let a NON-MEMBER
 * write a `saved_view` row into somebody else's tenant), and a viewer holds read domains, so the
 * flat claim went red on a verb that had just become SAFER.
 *
 * The claim it is replaced with is stronger, not weaker, and it is two claims rather than one:
 * a viewer is refused every verb whose declared capabilities it LACKS, and a NON-MEMBER is refused
 * every gated write there is. The second one is the security property, it is universal, and nothing
 * asserted it before.
 */
function viewerHoldsAllOf(action, workspaceId) {
  return requiredCapabilitiesFor(action.name, validFiller(action, workspaceId)).every((c) =>
    VIEWER_CAPABILITIES.includes(c),
  );
}

test('A24: a gated write refuses a viewer wherever the viewer lacks it, and writes NOTHING', () => {
  const { deps, workspaceId } = workspaceWhereAgentHolds('viewer', 'pb-view');
  const verbs = gatedCtxWrites().filter((a) => !viewerHoldsAllOf(a, workspaceId));
  // Non-vacuous by construction: a filter that silently matched nothing would pass every assertion
  // below without calling a single verb.
  assert.ok(verbs.length > 40, `only ${verbs.length} gated ctx writes were derived; the filter is wrong`);

  const failures = [];
  for (const action of verbs) {
    const before = snapshot(deps.store);
    const res = action.run(deps, validFiller(action, workspaceId));
    if (res.ok !== false || res.error !== 'permission_denied') {
      failures.push(`${action.name}: a viewer got ${JSON.stringify(res)} instead of permission_denied`);
    }
    if (snapshot(deps.store) !== before) {
      failures.push(`${action.name}: the DENIED call still changed the database`);
    }
  }
  assert.deepEqual(failures, []);
});

test('A24: a NON-MEMBER is refused EVERY gated write, with no exception for a read domain', () => {
  // The universal claim, and the one the critic's two findings both broke. A viewer may legitimately
  // hold a read domain and therefore legitimately pass a verb gated on one; a non-member holds
  // NOTHING, so there is no verb in this population it may pass, and no filter belongs here.
  const { deps, workspaceId } = workspaceWhereAgentHolds('viewer', 'pb-nonmember');
  deps.actor = 'niemand';
  const failures = [];
  for (const action of gatedCtxWrites()) {
    const before = snapshot(deps.store);
    const res = action.run(deps, validFiller(action, workspaceId));
    if (res.ok !== false || res.error !== 'permission_denied') {
      failures.push(`${action.name}: a NON-MEMBER got ${JSON.stringify(res)} instead of permission_denied`);
    }
    if (res.role !== null) {
      failures.push(`${action.name}: the rejection reports role ${JSON.stringify(res.role)}, not null`);
    }
    if (snapshot(deps.store) !== before) {
      failures.push(`${action.name}: a NON-MEMBER's denied call still changed the database`);
    }
  }
  assert.deepEqual(failures, []);
});

test('A24: the rejection names the missing capability and the role, on every gated write', () => {
  // Two facts the Studio says differently and therefore must be able to tell apart: which capability
  // was missing, and which role the actor holds. `role: null` means "not a member at all".
  const { deps, workspaceId } = workspaceWhereAgentHolds('viewer', 'pb-shape');
  const failures = [];
  // Same derivation as the refusal test above: a verb a viewer may legitimately pass produces no
  // rejection to inspect the shape of.
  for (const action of gatedCtxWrites().filter((a) => !viewerHoldsAllOf(a, workspaceId))) {
    const res = action.run(deps, validFiller(action, workspaceId));
    if (typeof res.capability !== 'string' || res.capability.length === 0) {
      failures.push(`${action.name}: the rejection names no capability (${JSON.stringify(res)})`);
    }
    if (res.role !== 'viewer') {
      failures.push(`${action.name}: the rejection reports role ${JSON.stringify(res.role)}, not 'viewer'`);
    }
  }
  assert.deepEqual(failures, []);
});

test('A24: BOTH agent doors deny identically, and neither writes: MCP callTool and the REST twin', () => {
  // The claim under test is structural rather than incidental: both faces resolve an `ActionDef` out
  // of the same `ACTIONS` array and call the same `run`, so a check in that dispatch cannot be routed
  // around by choosing the other face. Asserted on EVERY gated write rather than on a sample, because
  // "there is no third door" is only worth as much as the verbs it was checked on.
  //
  // Driven as a NON-MEMBER rather than as a viewer, which widens the population back to EVERY gated
  // write. A viewer legitimately passes a verb gated on a read domain (`create_saved_view`), so a
  // viewer would have to be filtered here exactly as it is above, and the verbs filtered out would be
  // the ones never checked for a second door. A non-member holds nothing, so nothing is filtered.
  const { deps, workspaceId } = workspaceWhereAgentHolds('viewer', 'pb-doors');
  deps.actor = 'niemand';
  const failures = [];
  for (const action of gatedCtxWrites()) {
    const input = validFiller(action, workspaceId);

    const before = snapshot(deps.store);
    const mcp = JSON.parse(callTool(deps, action.name, input).content[0].text);
    const afterMcp = snapshot(deps.store);
    const rest = handleRest(action.name, input, deps);
    const afterRest = snapshot(deps.store);

    if (mcp.error !== 'permission_denied') {
      failures.push(`${action.name}: MCP callTool answered ${JSON.stringify(mcp)}`);
    }
    if (rest.body.error !== 'permission_denied') {
      failures.push(`${action.name}: the REST twin answered ${JSON.stringify(rest.body)}`);
    }
    // A domain rejection is a 422 on REST and a normal Result on MCP: never a protocol error, never
    // a 500. A face that turned a denial into a crash would be a face with different semantics.
    if (rest.status !== 422) {
      failures.push(`${action.name}: the REST twin gave status ${rest.status}, not 422`);
    }
    if (JSON.stringify(mcp) !== JSON.stringify(rest.body)) {
      failures.push(`${action.name}: the two doors disagreed (${JSON.stringify(mcp)} vs ${JSON.stringify(rest.body)})`);
    }
    if (afterMcp !== before) failures.push(`${action.name}: the denied MCP call wrote to the database`);
    if (afterRest !== before) failures.push(`${action.name}: the denied REST call wrote to the database`);
  }
  assert.deepEqual(failures, []);
});

test('A24: the ungated stop button rests on unguessable ids, and here is the id property', () => {
  // THE UNSTATED PREMISE OF AN EXEMPTION, ASSERTED. `disable_automation_rule` is deliberately
  // ungated: a stop button that requires a permission is not a stop button, disabling only ever
  // PREVENTS a write, and re-enabling is gated, so the open direction is the safe one. That argument
  // is sound, and the wave critic noted it holds only because a rule can be stopped by its `ruleId`
  // and nothing else, and a `ruleId` is not enumerable. Nothing anywhere asserted that.
  //
  // It is exactly the shape of thing this remediation exists because of: an exemption resting on a
  // property that is true today, written down nowhere, and one `sequenceIdGen`-style convenience
  // away from being false. If `systemIdGen` ever became a counter, a stranger could stop every rule
  // in a workspace by walking `arule_1`, `arule_2`, and the reasoning above would still read fine.
  const ids = Array.from({ length: 64 }, () => systemIdGen.next('arule'));
  assert.equal(new Set(ids).size, ids.length, 'systemIdGen repeated an id');
  const uuidV4 = /^arule_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const notUuid = ids.filter((id) => !uuidV4.test(id));
  assert.deepEqual(notUuid, [], 'a rule id that is not a v4 UUID is a rule id somebody can guess');
  // Non-vacuous: the sequence generator the FIXTURES use would fail the line above, which is what
  // makes it a real assertion about production rather than a shape that anything would satisfy.
  assert.ok(!uuidV4.test(sequenceIdGen().next('arule')), 'the probe cannot tell the two generators apart');
});

test('A24: a denied post_entry leaves the JOURNAL empty, counted by hand rather than by snapshot', () => {
  // The snapshot above is the general claim; this is the money path counted the way the conformance
  // gate counts `post_entry`, because a snapshot is only ever as good as the tables it enumerated.
  const { deps, workspaceId, accId } = workspaceWhereAgentHolds('viewer', 'pb-post');
  const input = {
    workspaceId,
    date: '2026-03-01',
    description: 'Büromaterial bar bezahlt',
    source: 'manual',
    idempotencyKey: 'denied-1',
    lines: [
      { account: accId('6500'), debit: 5000 },
      { account: accId('1000'), credit: 5000 },
    ],
  };

  const denied = getAction('post_entry').run(deps, input);
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'permission_denied');
  assert.equal(denied.capability, 'post');

  const entries = deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?')
    .get(workspaceId);
  assert.equal(entries.n, 0, 'the denied post wrote a journal entry');
  // `journal_line` carries no `workspace_id` of its own: the tenant reaches it through its entry.
  const lines = deps.store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.workspace_id = ?`,
    )
    .get(workspaceId);
  assert.equal(lines.n, 0, 'the denied post wrote journal lines');
  // And no idempotency receipt either: a stored refusal would make the retry, once the grant
  // arrives, replay the denial forever.
  const receipts = deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM idempotency WHERE workspace_id = ? AND key = 'denied-1'")
    .get(workspaceId);
  assert.equal(receipts.n, 0, 'the denied post left an idempotency receipt behind');
});

test('A24: a viewer READS the books, and the reads it is refused are named one by one', () => {
  // UPDATED FOR D50, and this is the assertion the decision moved, so what it used to say is worth
  // stating. It used to be "a viewer reads the WHOLE book, and the only gated reads are G08
  // diagnostics", which was a true description of an engine that gated no read at all: a viewer read
  // everything because EVERYONE did, non-members included, and the wave critic exported the ledger to
  // prove it. Reads are gated per domain now, so the claim becomes narrower and sharper: a viewer
  // holds every read domain except the two it is deliberately denied.
  //
  // The exceptions stay an INVENTORY rather than a skip list, for exactly the reason the original
  // gave: if a THIRD read ever starts refusing a viewer, that is a policy change somebody must make
  // on purpose, and `assert.deepEqual([])` would have hidden it.
  //
  //   read_members       a viewer looks at the books; who else has access is governance. This is the
  //                      capability D50 was decided for, and the role it makes possible is a
  //                      Treuhänder who sees the books and not the member list.
  //   diagnostics.read   a deliberate second gate since G08 shipped, long before any of this.
  //                      Recorded diagnostics carry journal material and `viewer` has never held it.
  //   read_file_content  THE THIRD ONE, added 30.07.2026 (E00 F7, owner-decided), and this comment is
  //                      the "somebody must do it on purpose" the note above asks for. `viewer` holds
  //                      `read_master_data`, so it could LIST stored files and also download every byte
  //                      of them: the E00 critic reproduced a read-only invite fetching a payload with
  //                      an AHV number in it. The list stays open (seeing that a voucher exists is a
  //                      master-data read); the BYTES are their own capability, which no anchor grants.
  //                      Per-file classification was offered and declined: `hr.sensitive` stays reserved
  //                      for E02 / A34.
  const { deps, workspaceId } = workspaceWhereAgentHolds('viewer', 'pb-read');
  const reads = ACTIONS.filter((a) => a.kind === 'read' && a.inputSchema.required.includes('workspaceId'));
  assert.ok(reads.length > 20, `only ${reads.length} ctx reads were derived; the filter is wrong`);

  const denied = [];
  for (const action of reads) {
    const res = action.run(deps, validFiller(action, workspaceId));
    // A read may legitimately refuse for a domain reason (an unknown id in the filler). Only a
    // PERMISSION refusal is what this rule is about.
    if (res.ok === false && res.error === 'permission_denied') {
      denied.push(action.name);
      assert.ok(
        res.capability === 'read_members' ||
          res.capability === 'diagnostics.read' ||
          res.capability === 'read_file_content' ||
          // A26: the RAW dial view is owner-facing (`get_agent_dial` gated on `manage_agent_dial`), so
          // a viewer is refused it exactly as it is refused the member list. `whoami` still surfaces
          // the resolved levels a viewer's own capabilities admit, so this closes no oversight it had.
          res.capability === 'manage_agent_dial' ||
          // A25: the three filing exports are reads with a WRITE-grade consequence (each hands a file
          // to someone outside the workspace), so each is gated ALL-OF `['export','read_books']`. A
          // viewer holds `read_books` but NOT the `export` fiduciary right, so it is refused the bulk
          // export exactly as the A25 spec intends: a role that reads the books on screen does not
          // thereby gain a filing-grade extract. The single-statement A08 read it already had is
          // unaffected. This is a policy someone made on purpose, per the note above.
          res.capability === 'export' ||
          // G10: the three migration-map reads (`suggest`/`get`/`list templates`) gate on
          // `manage_import` like the writes they prepare, per the spec's own permission-denied
          // states (§2 US-G10.1): a migration map names how a client's whole chart and tax world
          // will land in the books, which is import-scoped work rather than a general bookkeeping
          // read, and `viewer` has never held it. The two catalog reads stay ungated (no
          // workspaceId), so the viewer's picture of what the SOFTWARE can do is untouched. This
          // is a policy someone made on purpose, per the note above.
          res.capability === 'manage_import' ||
          // E03: the task queue and the reminder poll gate on `tasks.read`, which is deliberately
          // NOT in the viewer anchor (`capabilities.ts`): a read-only invite looks at the BOOKS,
          // and the operational to-do queue (who is chasing whom by when) is work, not books. A
          // workspace that wants a viewer to see it grants a custom role, the expressiveness D50
          // paid for. This is a policy someone made on purpose, per the note above.
          res.capability === 'tasks.read' ||
          // B01: the timesheet reads gate on `time.read`, the E03 reasoning one register over:
          // who worked which hours on which client is operational work (and, under ArG Art. 46, a
          // personnel record), not books, and `time.read` is deliberately NOT in the viewer
          // anchor. A workspace that wants a viewer to see it grants a custom role. This is a
          // policy someone made on purpose, per the note above.
          res.capability === 'time.read' ||
          // C01: the pipeline board gates on `deals.read`, which is deliberately NOT in the viewer
          // anchor (`capabilities.ts`): a read-only invite looks at the BOOKS, and the sales
          // funnel (who is being courted for how much, and why a deal was lost) is relationship
          // work, not books. A workspace that wants a viewer to see it grants a custom role, the
          // E03 argument one register over. A policy someone made on purpose, per the note above.
          res.capability === 'deals.read' ||
          // B02: the unbilled-time preview and the WIP report gate on `billing.read`, deliberately
          // NOT in the viewer anchor (`capabilities.ts`, the `time.read`/`deals.read` shape): the
          // unbilled pile and the earned-but-unbilled figure are operational billing tooling, not
          // books, and a workspace that wants a viewer to see WIP grants a custom role. All three
          // editable built-ins hold it (the Treuhänder reads WIP at month-end); the viewer does not.
          // A policy someone made on purpose, per the note above.
          res.capability === 'billing.read' ||
          // B03: the four costing reads gate on `costing.read`, deliberately NOT in the viewer
          // anchor (`capabilities.ts`, the `billing.read` shape one register over): project
          // profitability is management reporting whose cost basis will carry employee pay-rate
          // data once the OP1 cost-rate column lands (the revDSG data-minimization gate, spec B03
          // §3), and a workspace that wants a viewer to see margins grants a custom role. All
          // three editable built-ins hold it. A policy someone made on purpose, per the note above.
          res.capability === 'costing.read' ||
          // E02: the personnel, absence and Spesen reads gate on `hr.read`, which is deliberately NOT
          // in the viewer anchor (`capabilities.ts`): a read-only invite looks at the BOOKS, and
          // personnel records, sick-leave (health data) and a colleague's Spesen are heightened-
          // sensitivity operational data, not books. The list/get reads additionally self-scope to
          // the caller's own rows. A workspace that wants a viewer to see HR grants a custom role, the
          // E03/B01 argument one register over. A policy someone made on purpose, per the note above.
          res.capability === 'hr.read' ||
          // F01: the report-builder metadata reads gate on `reports.read`, deliberately NOT in the
          // viewer anchor (`capabilities.ts`, the `billing.read`/`costing.read` shape): a workspace's
          // own saved analytics reads and their run history are operational tooling, not books, and a
          // workspace that wants a viewer to see them grants a custom role. All three editable
          // built-ins hold the trio. A policy someone made on purpose, per the note above.
          res.capability === 'reports.read' ||
          // E04: the four mail reads gate on `mail.read`, the STRICTEST absence from the viewer
          // anchor: the index is Art. 321 correspondence, so no anchor and no editable built-in
          // except `agent` holds it (`capabilities.ts`). A read-only invite looks at the BOOKS,
          // and a client's confidential mail is the clearest possible case of not-the-books. A
          // policy someone made on purpose, per the note above.
          res.capability === 'mail.read' ||
          // E05: the five voice reads gate on `voice.read`, the E04 reasoning one register over:
          // a voice profile is DERIVED from Art. 321 correspondence and `voice_retrieve` hands
          // back exemplar bodies read out of that mail, so no anchor and no editable built-in
          // except `agent` holds it (`capabilities.ts`). A policy someone made on purpose.
          res.capability === 'voice.read' ||
          // G04: `list_backups` gates on `manage_data_export`, deliberately NOT in the viewer anchor
          // (`capabilities.ts`, group governance): the backup history is a record of who put the WHOLE
          // workspace into a portable file, export-scoped governance work rather than a general
          // bookkeeping read. A workspace that wants a viewer to see it grants a custom role. A policy
          // someone made on purpose, per the note above.
          res.capability === 'manage_data_export' ||
          // G02: `preview_plugin_install` gates on `manage_plugins`, owner-only by default and NOT in
          // the viewer anchor. It is a READ (it persists nothing) but it inherits the domain of the
          // write it previews (the D50 preview-inherits rule): parsing an untrusted third-party
          // manifest to review the scopes it wants is the install DECISION, scoped to those who can
          // install. The four other G02 reads (list/get/search/getEntry) ride `read_master_data`, so
          // a viewer browses the panel read-only. A policy on purpose, per the note above.
          res.capability === 'manage_plugins' ||
          // M02: the three RAW stream reads gate on `sync.read`, deliberately NOT in the viewer anchor
          // (`capabilities.ts`, group reading): the publish stream is an INTEGRATION feed for the
          // managed runtime, not a bookkeeping read, and a workspace that wants a consumer to read it
          // grants a narrow custom role holding exactly `sync.read`. `get_sync_contract` stays on
          // `read_master_data` (any member sees the publish posture), so the viewer's picture of
          // whether the books publish is untouched. A policy someone made on purpose, per the note above.
          res.capability === 'sync.read' ||
          // G20: `implementation_project_get` and `implementation_parallel_status` gate on
          // `manage_implementation`, owner-only by default and NOT in the viewer anchor: reading a
          // client's cutover project end to end (its phases, sign-offs and filed-figure reconciliation)
          // is governing work over the implementation, not a bookkeeping read. The roster metadata
          // read (`implementation_project_list`) stays on `read_master_data`, so a member composes the
          // cross-client roster; the DETAIL reads are the governing right. A policy someone made on
          // purpose, per the note above.
          res.capability === 'manage_implementation',
        `${action.name} refused a viewer on ${res.capability}, which is not one of the deliberate exceptions`,
      );
    }
  }
  assert.deepEqual(denied.sort(), [
    // B02's two reads, on `billing.read`, which no anchor grants (see the exception note above).
    'billing_unbilled_preview',
    'billing_wip_report',
    // B03's four costing reads, on `costing.read`, which no anchor grants (see the exception note
    // above).
    'costing_budget_vs_actual',
    'costing_drilldown',
    'costing_pl_list',
    'costing_project_pl',
    // C01's board read, on `deals.read`, which no anchor grants (see the exception note above).
    'deals_list',
    // E06's run list, on `mail.read` like the four E04 reads below: a draft run is correspondence
    // metadata plus the draft body read from the same store (see the mail.read exception note above).
    'draft_list',
    // E02's two Spesen reads, on `hr.read`, which no anchor grants (see the exception note above).
    'expense_claim_get',
    'expense_claim_list',
    'export_journal',
    'export_statements',
    'export_vat',
    'files_get_content',
    'get_agent_dial',
    'get_diagnostics',
    // G13: the archive PREVIEW renders the not-yet-imported source export, which is plan material
    // (`manage_import`, like G09's own preview below), not the books; the three ARCHIVE reads
    // (`gl_archive_query`/`_account_history`/`_periods`) stay on `read_books` and a viewer keeps
    // them, because the archive IS the books, historical or not (G13 spec §0 correction 5).
    'gl_archive_preview',
    // E02's three personnel reads, on `hr.read`, which no anchor grants (see the exception note above).
    'hr_absence_list',
    'hr_employee_get',
    'hr_employee_list',
    // G20, the two implementation-project DETAIL reads, on `manage_implementation`, which no anchor
    // grants: reading a cutover project end to end and its filed-figure reconciliation is governing
    // work over the implementation, not a bookkeeping read. The roster metadata read
    // (`implementation_project_list`) stays on `read_master_data`, so it is NOT here.
    'implementation_parallel_status',
    'implementation_project_get',
    // G04's backup history read, on `manage_data_export`, which no anchor grants (see the exception
    // note above).
    'list_backups',
    'list_feedback',
    'list_members',
    // A34's payroll hand-off history read, on `hr.read` (the export/posting union is personnel-data,
    // the E02 reasoning), which no anchor grants (see the exception note above).
    'list_payroll_handoffs',
    'list_roles',
    // E04's four mail reads, on `mail.read`, which no anchor grants (see the exception note above):
    // the mail index is Art. 321 correspondence, the strictest read domain in the product.
    'mail_accounts_list',
    'mail_drafts_list',
    'mail_thread_get',
    'mail_threads_list',
    // G09, the migration harness's five reads: discovery, the plan, the plan roster, the preview and
    // the readiness checklist all gate on `manage_import` like the writes they prepare (spec §3: a
    // plan names how a whole foreign book lands in the ledger, so reading one is import-scoped work).
    // A viewer has never held `manage_import`, so it is refused all five. A policy on purpose.
    // G12, the Testmandant's two reads: the two-workspace diff and `migration_get_testmandant` both
    // gate on `manage_import` like the rest of the import domain (spec §3: a Testmandant is trial
    // material, not real books a viewer may read). A viewer has never held `manage_import`.
    'migration_diff_testmandant_to_live',
    'migration_discover_source',
    // G11, the Eröffnungsprüfung's three reads: the persisted check, the check history and the
    // Prüfbericht export gate on `manage_import` like the writes that produce them (spec §3: a
    // check names how a client's whole opening position ties to a foreign book, so reading one is
    // import-scoped work). A viewer has never held `manage_import`. A policy on purpose.
    'migration_export_check',
    'migration_get_check',
    // G19, the extraction manifest read: `migration_get_manifest` gates on `manage_import` like the
    // rest of the import domain (an export manifest names how a whole foreign book leaves the old
    // system, so reading one is import-scoped work). A viewer has never held `manage_import`. The two
    // extraction-GUIDE reads stay ungated (no workspaceId), so they never enter this ctx-read set.
    'migration_get_manifest',
    'migration_get_map',
    'migration_get_plan',
    'migration_get_testmandant',
    'migration_list_checks',
    'migration_list_map_templates',
    'migration_list_plans',
    'migration_preview_step',
    'migration_readiness',
    'migration_suggest_map',
    // G21: `preview_open_items` computes the open-items control tie-out, import-scoped work on
    // `manage_import` like the rest of the migration reads (spec §3), so a viewer is refused it.
    'preview_open_items',
    // G02: `preview_plugin_install` gates on `manage_plugins`, owner-only, so a viewer is refused it
    // (the D50 preview-inherits rule: previewing an untrusted install is the install decision). The
    // other four G02 reads ride `read_master_data`, so a viewer keeps them.
    'preview_plugin_install',
    // F01's three metadata reads, on `reports.read`, which no anchor grants (see the exception note
    // above): the saved-report list, the source registry and the run history are operational analytics
    // tooling, not books, so a viewer is refused them. `reports_preview` is NOT here: it is ungated at
    // the boundary and asserts the composed source's own read gate in the engine instead.
    'reports_list',
    'reports_runs',
    'reports_sources',
    // B04's two reads (burn-down + Mandate list), on `billing.read`, which no anchor grants: a
    // retainer is a billing surface (the B02 reasoning), so a viewer is refused them exactly as it is
    // refused the unbilled preview and WIP report above. A policy on purpose, per the note above.
    'retainer_burndown',
    'retainer_list',
    // E05's two runtime reads, on `voice.read` (see the exception note above): which local model
    // runs over confidential mail is part of the same correspondence story, so they sit in the
    // same strictest read domain as the profile reads below.
    'runtime_catalog',
    'runtime_status',
    // M02's three raw stream reads, on `sync.read`, which no anchor grants (see the exception note
    // above): the publish stream is an integration feed for the managed runtime, not the books.
    'sync_artifact_read',
    'sync_stream_read',
    'sync_stream_status',
    // E03's two reads, on `tasks.read`, which no anchor grants (see the exception note above).
    'tasks_list',
    'tasks_reminders_due',
    // B01's two reads, on `time.read`, which no anchor grants (see the exception note above).
    'time_list',
    'time_resolve_rate',
    // E05's three voice reads, on `voice.read`, which no anchor grants (see the exception note
    // above): the profile is derived from Art. 321 correspondence and retrieval returns bodies.
    'voice_profile_get',
    'voice_profiles_list',
    'voice_retrieve',
  ]);

  // And the LIST side really is still open, so the cut above is between the row and the bytes rather
  // than between E00 and everyone else. Without this, denying the whole capability would pass too.
  assert.equal(getAction('files_search').run(deps, { workspaceId }).ok, true);
  assert.equal(getAction('folders_list').run(deps, { workspaceId }).ok, true);
});

test('A24: a NON-MEMBER of a provisioned workspace reads nothing, which is the D50 repair', () => {
  // The critic's finding, asserted as its repair and across the whole read surface rather than the
  // nine verbs the report happened to list. Every one of these answered `ok` before D50, including
  // `export_statement`, which is a complete CSV of the ledger handed to somebody with no membership
  // at all while `revoke_member` promised in its own summary to have removed their access.
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Zugriff GmbH', 'pb-nonmember-ws');
  const invited = getAction('invite_member').run(deps, {
    workspaceId,
    email: 'pb-nonmember@muster.ch',
    role: 'bookkeeper',
    idempotencyKey: 'pb-nonmember-invite',
  });
  assert.equal(invited.ok, true, `invite failed: ${JSON.stringify(invited)}`);

  // A genuine stranger. It cannot be `agent` any more: D50 seats that one as an owner, so a probe
  // that still used it would be measuring an owner and reporting it as a non-member.
  deps.actor = 'treuhand:mueller';

  const reads = ACTIONS.filter((a) => a.kind === 'read' && a.inputSchema.required.includes('workspaceId'));

  // The reads a non-member IS allowed, derived from the declarations rather than hand-listed, so a
  // future exemption cannot be missed here. Deriving alone would silently absorb a new one, so the
  // INVENTORY is pinned as well: adding a third is a policy change somebody must make on purpose.
  //
  //   whoami            a caller has to be able to learn that it holds nothing, or the Studio
  //                     cannot render the denial it is about to receive.
  //   preview_feedback  its write twin `prepare_feedback` is ungated because reporting a bug is not
  //                     a privilege, and gating the preview would silence exactly the restricted
  //                     user most likely to hit one.
  //   dashboard_overview, dashboard_tile
  //                     F00's two reads span six read domains at once, so no single capability can
  //                     gate them without lying in one direction or the other. They are ungated at
  //                     the boundary ON PURPOSE and enforce per-tile RBAC inside the engine
  //                     (`src/core/dashboards/dashboards.ts` asserts it): a caller holding no read
  //                     capability gets an empty overview, and `dashboard_tile` refuses per tile.
  //   reports_preview   F01's live preview computes a REPORT_SOURCES read model like the dashboards
  //                     do, so it is ungated at the boundary ON PURPOSE and asserts the composed
  //                     source's own read gate inside the engine (`assertSourceReadable` in
  //                     `core/reportbuilder/reports.ts`): a non-member holding no read domain is
  //                     refused with the source's own capability, never handed the source's rows.
  //   notifications_list, notifications_list_preferences
  //                     G06's queue is self-scoped STRUCTURALLY inside the engine (spec §5: an
  //                     inbox is not a shared mailbox, and there is no cross-user read a role
  //                     capability could grant): both bind every row to the CALLER's own user_id
  //                     and refuse a foreign `userId` with `forbidden`, so a stranger is handed at
  //                     most its own empty inbox and the synthesised defaults, zero rows of anyone
  //                     else's. `test/notifications/notifications.test.mjs` asserts the fence.
  //   search_global     G07 spans nine read domains at once (the F00 argument restated for search):
  //                     the engine asserts each searchable kind's own read capability and silently
  //                     OMITS refused kinds (`src/core/search/searchGlobal.ts`), so a caller holding
  //                     no read domain gets an empty result set and never a row it could not open.
  //   attention_summary, attention_list
  //                     G15's attention hub composes several module work queues, each behind its own
  //                     read domain, so no single boundary capability can gate it (the F00 argument
  //                     applied per queue). The engine filters each provider by its own read
  //                     capability before composing (`src/core/attention/compose.ts`): a non-member
  //                     holding no read domain gets `{ visibleQueues: 0, total: null, queues: [],
  //                     top: [] }` from the summary and an empty page from the list, zero rows of
  //                     anyone's work.
  const exempt = reads
    .filter((a) => isUngated(CAPABILITY_FOR_ACTION[a.name]))
    .map((a) => a.name)
    .sort();
  assert.deepEqual(
    exempt,
    [
      'attention_list',
      'attention_summary',
      'dashboard_overview',
      'dashboard_tile',
      'notifications_list',
      'notifications_list_preferences',
      'preview_feedback',
      'reports_preview',
      'search_global',
      'whoami',
    ],
    'the set of ungated ctx reads changed'
  );

  const leaked = [];
  for (const action of reads) {
    const res = action.run(deps, validFiller(action, workspaceId));
    if (res.ok === false && res.error === 'permission_denied') {
      assert.equal(res.role, null, `${action.name} reported a role for somebody who is not a member`);
      continue;
    }
    if (!exempt.includes(action.name)) leaked.push(action.name);
  }
  assert.deepEqual(leaked, [], 'these reads answered somebody with no membership in this workspace');

  const me = getAction('whoami').run(deps, { workspaceId });
  assert.equal(me.ok, true, 'whoami must answer a non-member, or nothing can tell them why they are refused');
  assert.equal(me.isMember, false);
  assert.equal(me.role, null);
  assert.deepEqual([...me.capabilities], []);
});

test('A24: a role holding exactly one capability may use that verb and no other', () => {
  // The narrowest useful custom role, which is also the sharpest test of the map: `post` is granted,
  // `manage_chart` is not, and both verbs sit behind the same boundary in the same dispatch.
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Nur Buchen GmbH', 'pb-one-ws');

  const role = getAction('define_role').run(deps, {
    workspaceId,
    name: 'Nur Buchen',
    capabilities: ['post'],
    idempotencyKey: 'pb-one-role',
  });
  assert.equal(role.ok, true, JSON.stringify(role));
  // `define_role` deliberately does NOT provision: reshaping a bundle nobody holds yet must not be
  // the act that locks a workspace down.
  const invited = getAction('invite_member').run(deps, {
    workspaceId,
    email: 'nurbuchen@muster.ch',
    role: role.roleId,
    idempotencyKey: 'pb-one-invite',
  });
  assert.equal(invited.ok, true, JSON.stringify(invited));

  // The invite seated both D13 actors as owners (D50), so the narrow role goes onto the agent's own
  // seat. Redeeming the token as `agent` is no longer available: a seated actor answers
  // `actor_already_member`, which `provisioning-flip.test.mjs` asserts directly.
  const seat = getAction('list_members')
    .run(deps, { workspaceId })
    .members.find((m) => m.actorId === 'agent');
  assert.ok(seat !== undefined, 'the flip did not seat the agent, so there is no row to narrow');
  const narrowed = getAction('set_role').run(deps, {
    workspaceId,
    memberId: seat.memberId,
    role: role.roleId,
  });
  assert.equal(narrowed.ok, true, JSON.stringify(narrowed));

  deps.actor = 'agent';

  const posted = getAction('post_entry').run(deps, {
    workspaceId,
    date: '2026-03-01',
    source: 'manual',
    idempotencyKey: 'pb-one-post',
    lines: [
      { account: accId('6500'), debit: 5000 },
      { account: accId('1000'), credit: 5000 },
    ],
  });
  assert.equal(posted.ok, true, `the granted capability was refused: ${JSON.stringify(posted)}`);

  // The number is asserted ABSENT from the seeded chart first. The first draft of this used 6600,
  // which the KMU seed already ships, so the count-after assertion read the seed's own row as the
  // refused write and failed against correct code. Check the probe before blaming the engine.
  const NEW_NUMBER = '6919';
  const seeded = deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM account WHERE workspace_id = ? AND number = ?')
    .get(workspaceId, NEW_NUMBER);
  assert.equal(seeded.n, 0, `the KMU seed already ships ${NEW_NUMBER}: pick a number it does not`);

  const refused = getAction('create_account').run(deps, {
    workspaceId,
    number: NEW_NUMBER,
    name: 'Werbung',
    type: 'expense',
    idempotencyKey: 'pb-one-acct',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'permission_denied');
  assert.equal(refused.capability, 'manage_chart');
  assert.equal(refused.role, role.roleId);
  const accounts = deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM account WHERE workspace_id = ? AND number = ?')
    .get(workspaceId, NEW_NUMBER);
  assert.equal(accounts.n, 0, 'the refused create_account wrote the account anyway');
});

test('A24: a custom role cannot mint a capability the registry does not hold', () => {
  // The structural half of "a role is a named subset of the registry". There is no input that mints a
  // new capability, so there is no input that mints a bypass.
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Erfinder GmbH', 'pb-mint-ws');

  const res = getAction('define_role').run(deps, {
    workspaceId,
    name: 'Allmacht',
    capabilities: ['post', 'unlock_everything'],
    idempotencyKey: 'pb-mint',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'unknown_capability');
  assert.equal(res.capability, 'unlock_everything', 'the rejection must name the offending capability');
  const roles = deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM role_def WHERE workspace_id = ? AND is_builtin = 0')
    .get(workspaceId);
  assert.equal(roles.n, 0, 'the refused define_role wrote a custom role anyway');
});

test('A24: `owner` and `viewer` cannot be shadowed by a role_def row, even one written by hand', () => {
  // The two anchors short-circuit BEFORE any `role_def` query, so a row named `owner` or `viewer`
  // that arrived by a bug, a migration or a text editor cannot change either answer. `define_role`
  // rejects both by name as well, but that is the policy half; this is the structural half, and it is
  // the half that still holds when the policy half is wrong.
  const { deps, workspaceId } = workspaceWhereAgentHolds('viewer', 'pb-anchor');

  const refused = getAction('define_role').run(deps, {
    workspaceId,
    roleId: 'viewer',
    name: 'viewer',
    capabilities: ['post'],
    idempotencyKey: 'pb-anchor-define',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'permission_denied', 'a viewer cannot even attempt it');

  // Now write the shadowing row directly, which is the case no verb can produce and no policy can
  // stop. The resolver must still answer `viewer` = nothing.
  deps.store.db
    .prepare(
      `INSERT INTO role_def (id, workspace_id, name, capabilities_json, is_builtin, archived, created_by, created_at, updated_at)
       VALUES ('viewer', ?, 'viewer', '["post","manage_chart"]', 0, 0, 'hand', '2026-01-01', '2026-01-01')`,
    )
    .run(workspaceId);

  const stillDenied = getAction('post_entry').run(deps, {
    workspaceId,
    date: '2026-03-01',
    source: 'manual',
    idempotencyKey: 'pb-anchor-post',
    lines: [],
  });
  assert.equal(stillDenied.ok, false);
  assert.equal(stillDenied.error, 'permission_denied', 'a hand-written role_def row shadowed the viewer anchor');
});

test('A24: EVERY verb in the registry declares a gate or an explicit exemption with a reason', () => {
  // `assertEveryActionIsGated` already runs at module load, so an undeclared verb is a crash on
  // import rather than an open door. Restated here as an assertion because a load-time throw proves
  // the check RAN, not that the exemptions are honest: an `ungated()` with an empty reason satisfies
  // the loader and defeats the point of making an exemption a value rather than an absence.
  //
  // WIDENED FROM WRITES TO EVERY VERB (D50). The old version filtered to `kind === 'write'`, which
  // means it agreed with the loader that forty-nine reads needed no rule, and would have passed
  // green on the day a non-member exported the ledger. A guard scoped to half the surface is a guard
  // that certifies the half nobody was worried about.
  const failures = [];
  for (const a of ACTIONS) {
    const rule = CAPABILITY_FOR_ACTION[a.name];
    if (rule === undefined) {
      failures.push(`${a.name}: is a registered verb with no rule in CAPABILITY_FOR_ACTION`);
      continue;
    }
    if (isUngated(rule) && (typeof rule.reason !== 'string' || rule.reason.length < 20)) {
      failures.push(`${a.name}: is ungated with no real written reason`);
    }
    // A capability declared on a PRE-WORKSPACE verb can never be enforced: there is no tenant on the
    // input to resolve it against. It would read on the Roles tab as a gate and gate nothing.
    if (!isUngated(rule) && !a.inputSchema.required.includes('workspaceId')) {
      failures.push(`${a.name}: declares a capability but carries no workspaceId to enforce it against`);
    }
  }
  const names = new Set(ACTIONS.map((x) => x.name));
  for (const name of Object.keys(CAPABILITY_FOR_ACTION)) {
    if (!names.has(name)) failures.push(`${name}: has a capability rule but is not a registered verb`);
  }
  assert.deepEqual(failures, []);
});

test('A24: the contacts.merge ALL-OF, driven as every role shape the F5 critic measured (F5-C3)', () => {
  // The split's whole claim is the ALL-OF: `contacts_merge` and `contacts_anonymise` declare
  // ['manage_master_data', 'contacts.merge'], so EITHER name alone must refuse and only the pair
  // may act. The critic measured this matrix by hand and found it correct; this test is that
  // matrix as a permanent engine-side assertion, because until now the only evidence was a Studio
  // component test measuring the courtesy gate, plus guards that would pass equally well if the map
  // still said `manage_master_data` alone.
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Merge Matrix AG', 'pb-merge-ws');

  const alpha = getAction('create_contact').run(deps, {
    workspaceId,
    partyRole: 'customer',
    name: 'Alpha AG',
    idempotencyKey: 'pb-merge-a',
  });
  const beta = getAction('create_contact').run(deps, {
    workspaceId,
    partyRole: 'customer',
    name: 'Beta AG',
    idempotencyKey: 'pb-merge-b',
  });
  assert.equal(alpha.ok && beta.ok, true);

  const defineRole = (name, capabilities, key) => {
    const res = getAction('define_role').run(deps, { workspaceId, name, capabilities, idempotencyKey: key });
    assert.equal(res.ok, true, `${name}: ${JSON.stringify(res)}`);
    return res.roleId;
  };
  const coarseOnly = defineRole('Nur Stammdaten', ['read_master_data', 'manage_master_data'], 'pb-merge-r1');
  // The orphan grant A24 must answer for: `define_role` accepts the elevated right ALONE (it is a
  // registry member), and the ALL-OF is what keeps that role inert rather than an escalation.
  const mergeOnly = defineRole('Nur Merge', ['read_master_data', 'contacts.merge'], 'pb-merge-r2');
  const pair = defineRole(
    'Stammdaten plus Merge',
    ['read_master_data', 'manage_master_data', 'contacts.merge'],
    'pb-merge-r3',
  );

  // Provision (the invite seats both D13 actors, D50), then narrow the agent seat per shape.
  const invited = getAction('invite_member').run(deps, {
    workspaceId,
    email: 'matrix@muster.ch',
    role: coarseOnly,
    idempotencyKey: 'pb-merge-invite',
  });
  assert.equal(invited.ok, true, JSON.stringify(invited));
  const seat = getAction('list_members')
    .run(deps, { workspaceId })
    .members.find((m) => m.actorId === 'agent');
  assert.ok(seat !== undefined);

  const contactCount = () =>
    deps.store.db.prepare('SELECT COUNT(*) AS n FROM contact WHERE workspace_id = ?').get(workspaceId).n;
  const asRole = (role) => {
    const res = getAction('set_role').run(deps, { workspaceId, memberId: seat.memberId, role });
    assert.equal(res.ok, true, `set_role ${role}: ${JSON.stringify(res)}`);
    deps.actor = 'agent';
  };

  // The DENIED shapes first, each asserted on the refusal AND on the rows: the tombstone column
  // stays empty and the contact names survive, so a verb that refused in its answer and wrote in
  // its body cannot pass.
  const deniedShapes = [
    ['coarse grant alone', coarseOnly],
    ['elevated right alone', mergeOnly],
    ['treuhaender', 'treuhaender'],
    ['viewer', 'viewer'],
  ];
  for (const [label, role] of deniedShapes) {
    asRole(role);
    const merged = getAction('contacts_merge').run(deps, {
      workspaceId,
      sourceId: beta.contact.id,
      targetId: alpha.contact.id,
      idempotencyKey: `pb-merge-m-${role}`,
    });
    const anonymised = getAction('contacts_anonymise').run(deps, {
      workspaceId,
      contactId: alpha.contact.id,
      idempotencyKey: `pb-merge-x-${role}`,
    });
    deps.actor = 'studio';
    assert.equal(merged.ok, false, `${label} merged: ${JSON.stringify(merged)}`);
    assert.equal(merged.error, 'permission_denied', label);
    assert.equal(anonymised.ok, false, `${label} anonymised: ${JSON.stringify(anonymised)}`);
    assert.equal(anonymised.error, 'permission_denied', label);
    const tombstones = deps.store.db
      .prepare('SELECT COUNT(*) AS n FROM contact WHERE workspace_id = ? AND merged_into_id IS NOT NULL')
      .get(workspaceId).n;
    assert.equal(tombstones, 0, `${label}: a refused merge wrote a tombstone`);
    const names = deps.store.db
      .prepare('SELECT name FROM contact WHERE workspace_id = ? ORDER BY name')
      .all(workspaceId)
      .map((r) => r.name);
    assert.deepEqual(names, ['Alpha AG', 'Beta AG'], `${label}: a refused verb altered a contact`);
  }

  // The built-ins that hold the pair really do act, and so does the custom pair role: without this
  // half the split would be a wall rather than a gate. `bookkeeper` merges, the custom pair
  // anonymises the survivor, and both leave the rows the verbs promise.
  asRole('bookkeeper');
  const merged = getAction('contacts_merge').run(deps, {
    workspaceId,
    sourceId: beta.contact.id,
    targetId: alpha.contact.id,
    idempotencyKey: 'pb-merge-do',
  });
  deps.actor = 'studio';
  assert.equal(merged.ok, true, `bookkeeper holds the pair and was refused: ${JSON.stringify(merged)}`);
  assert.equal(contactCount(), 2, 'a merge deletes nothing: the source becomes a tombstone');

  asRole(pair);
  const anonymised = getAction('contacts_anonymise').run(deps, {
    workspaceId,
    contactId: alpha.contact.id,
    idempotencyKey: 'pb-merge-anon',
  });
  deps.actor = 'studio';
  assert.equal(anonymised.ok, true, `the custom pair role was refused: ${JSON.stringify(anonymised)}`);
  const survivor = deps.store.db
    .prepare('SELECT name FROM contact WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, alpha.contact.id);
  assert.notEqual(survivor.name, 'Alpha AG', 'the anonymise left the personal name in place');
});
