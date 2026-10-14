/**
 * WHAT YOU APPROVED IS WHAT RUNS (critic N1, Medium, 11.10.2026): a Vorschlag is pinned to the content
 * of the records its verb will consume, and an approval after that content changed runs nothing.
 *
 * THE DEFECT. An approval replayed a REFERENCE. The agent proposed `issue_invoice {invoiceId}` on a
 * CHF 1,000 draft, rewrote the draft to CHF 99,999 through the ungoverned `update_document`, and the
 * person's approval issued and posted CHF 99,999 while the card had shown only the invoice id. The
 * first test below is that repro, driven over the real REST seam; it fails on a build without the pin.
 *
 * THE POPULATION. Every governed write whose input names a record (a field ending in `Id` or `Ids`)
 * sits in exactly one of `PIN_FOR_VERB` or `NOT_PINNED`, the latter with a reason from a closed set.
 * A newly governed verb with a record id fails here until someone decides which.
 *
 * ONE TEST PER FAMILY. For every record kind in the table, each verb pinned to it is proposed through
 * its conformance scenario, the record is changed underneath (a content column, written straight to
 * the row, the way any ungoverned writer could), and the approval must refuse `vorschlag_stale`, run
 * nothing and void the row. The same proposals approve fine when nothing changed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { handleRest } from '../../dist/api/rest.js';
import { ACTIONS, getAction } from '../../dist/api/registry.js';
import { makeContext } from '../../dist/core/context.js';
import {
  PIN_RECORDS,
  PIN_FOR_VERB,
  NOT_PINNED,
  LIVE_READ_TABLES,
  LIVE_READ_WAIVERS,
  pinnedTablesFor,
  pinReadShapes,
  VORSCHLAG_STALE_MESSAGE,
  dialCapabilitiesForVerb,
  enqueueDraftedAction,
  listDraftedActions,
  pinFor,
} from '../../dist/core/agent/index.js';
import { DIAL_CAPABILITY_FOR_ACTION, dialCapabilitiesForCall } from '../../dist/core/agent/dialMap.js';
import { DOCUMENT_STATUSES } from '../../dist/core/sales/document.js';
import { SCENARIOS, fixture } from '../api/conformance-contract.mjs';
import { traceTables } from './sql-trace.mjs';

/** @typedef {{ ok: boolean, error?: string, [key: string]: unknown }} Body */
/** @typedef {ReturnType<typeof fixture>} Fx */

const REASONS = new Set(['immutable', 'delete', 'payload', 'state', 'governed', 'pinned', 'live']);
/** @type {Record<string, readonly { field: string, record: string }[]>} */
const PINS = PIN_FOR_VERB;
/** @type {Record<string, { table: string, columns: readonly string[], children?: readonly { table: string, fk: string, columns: readonly string[] }[] }>} */
const RECORDS = PIN_RECORDS;
/** @type {Record<string, { reason: string, why: string }>} */
const EXCLUDED = NOT_PINNED;
/** @type {Record<string, (fx: Fx) => Record<string, unknown>>} */
const SCENARIO = SCENARIOS;

/** The record-id fields of a verb's input schema (never the tenant or the key). */
function idFields(/** @type {any} */ action) {
  const props = action.inputSchema?.properties ?? {};
  return Object.keys(props).filter((k) => k !== 'workspaceId' && k !== 'idempotencyKey' && /(Id|Ids)$/.test(k));
}

const GOVERNED_WITH_IDS = ACTIONS.filter((a) => a.kind === 'write' && dialCapabilitiesForVerb(a.name).length > 0 && idFields(a).length > 0);

const TRACE_AND_QUEUE = new Set(['agent_session', 'agent_turn', 'agent_call', 'agent_action', 'idempotency']);

/** Every business table, row for row. */
function businessDigest(/** @type {any} */ db) {
  const h = createHash('sha256');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  for (const { name } of tables) {
    if (TRACE_AND_QUEUE.has(name)) continue;
    h.update(name);
    for (const row of db.prepare(`SELECT * FROM "${name}"`).all()) h.update(JSON.stringify(row));
  }
  return h.digest('hex');
}

const agentCtx = (/** @type {Fx} */ fx) =>
  makeContext(fx.deps.store, { workspaceId: fx.workspaceId, actor: 'agent', clock: fx.deps.clock, ids: fx.deps.ids });

/** The person approves, through the registry verb (A24 gate, boundary, the replay as `studio`). */
const approve = (/** @type {Fx} */ fx, /** @type {string} */ actionId) =>
  /** @type {Body} */ (getAction('approve_drafted_action').run({ ...fx.deps, actor: 'studio' }, { workspaceId: fx.workspaceId, actionId }));

const rowOf = (/** @type {Fx} */ fx, /** @type {string} */ actionId) =>
  /** @type {{ status: string, pin_digest: string | null, pin_json: string | null }} */ (
    fx.deps.store.db.prepare('SELECT status, pin_digest, pin_json FROM agent_action WHERE id = ?').get(actionId)
  );

/**
 * The scenario shapes that name the record the pin is about. The conformance scenario of
 * `create_recurring_schedule` passes lines and no template, and the three-way scenarios leave the
 * candidate order to the engine; these name a template draft and the evaluated order instead.
 * @type {Record<string, (fx: Fx, base: Record<string, any>) => Record<string, unknown>>}
 */
const PIN_SHAPE = {
  create_recurring_schedule: (fx, base) => {
    const doc = /** @type {any} */ (
      fx.call('create_document', {
        type: 'invoice',
        contactId: base.contactId,
        currency: 'CHF',
        lines: [{ description: 'Beratung monatlich', unitPriceMinor: 200000 }],
        idempotencyKey: 'pin-template',
      })
    );
    const { lines: _lines, ...rest } = base;
    return { ...rest, templateDocumentId: doc.document.id };
  },
  match_three_way_create: (_fx, base) => ({ ...base, poId: base.evaluation.poId }),
  // N-d: the cost is read from the item only when the move does not state it.
  stock_move: (_fx, { unitCostMinor: _c, ...rest }) => rest,
  inventory_move: (_fx, { unitCostMinor: _c, ...rest }) => rest,
  inventory_transfer: (_fx, { unitCostMinor: _c, ...rest }) => rest,
  match_three_way_override: (_fx, base) => ({ ...base, poId: base.evaluation.poId }),
  // R2-B2: an entry for a bank line that names its code; the scenario books without VAT.
  create_entry_for_txn: (fx, base) => {
    fx.call('vat_seed_defaults', {});
    return { ...base, taxCode: 'VST-I' };
  },
  // The MWST settings read the workspace's codes; the scenario configures a book that has none yet.
  vat_configure: (fx, base) => {
    fx.call('vat_seed_defaults', {});
    return base;
  },
};

/** Propose `verb` from its conformance scenario as the agent seat would (the seam's own enqueue). */
function propose(/** @type {string} */ verb) {
  const fx = fixture();
  const base = SCENARIO[verb]?.(fx);
  assert.ok(base !== undefined, `${verb} has a conformance scenario`);
  const input = PIN_SHAPE[verb] !== undefined ? PIN_SHAPE[verb](fx, base) : base;
  const drafted = /** @type {Body} */ (enqueueDraftedAction(agentCtx(fx), { actionTool: verb, payload: { ...input, workspaceId: fx.workspaceId } }));
  assert.equal(drafted.ok, true, `${verb}: ${JSON.stringify(drafted)}`);
  return { fx, input, actionId: /** @type {string} */ (drafted.actionId) };
}

/**
 * Change one content column of a pinned record (the primary first, then the others the verb names; on
 * each the row, then its lines), straight in the row. Numbers first (amounts and quantities are what an
 * agent would move), then text. A write a CHECK or a freeze trigger refuses is skipped: a record the DB
 * freezes cannot go stale, and another pinned record of the same verb is tried. Returns what changed,
 * or undefined when nothing could be.
 */
/** The first value a pin-field path names in an input (`a`, `a[]`, `a.b[].c`), or the workspace. */
function firstId(fx, pin, input) {
  if (pin.workspace === true) return fx.workspaceId;
  let current = [input];
  for (const raw of pin.field.split('.')) {
    const each = raw.endsWith('[]');
    const key = each ? raw.slice(0, -2) : raw;
    current = current.flatMap((node) => {
      const v = node !== null && typeof node === 'object' ? node[key] : undefined;
      return each ? (Array.isArray(v) ? v : []) : v === undefined ? [] : [v];
    });
  }
  const flat = current.flatMap((v) => (Array.isArray(v) ? v : [v]));
  return flat.find((v) => typeof v === 'string' && v.length > 0);
}

function mutatePrimary(/** @type {Fx} */ fx, /** @type {string} */ verb, /** @type {Record<string, unknown>} */ input) {
  for (const pin of PINS[verb] ?? []) {
    const id = firstId(fx, pin, input);
    if (typeof id !== 'string') continue;
    const changed = mutateRecord(fx, pin.record, id);
    if (changed !== undefined) return changed;
  }
  return undefined;
}

function mutateRecord(/** @type {Fx} */ fx, /** @type {string} */ record, /** @type {string} */ id) {
  const db = fx.deps.store.db;
  const spec = RECORDS[record];
  /** @param {string} table @param {readonly string[]} columns @param {string} where @param {string} key */
  const tryColumns = (table, columns, where, key) => {
    // The workspace row itself has no workspace_id column: it IS the tenant.
    const row =
      table === 'workspace'
        ? db.prepare(`SELECT rowid AS rid, ${columns.join(', ')} FROM workspace WHERE id = ?`).get(fx.workspaceId)
        : db.prepare(`SELECT rowid AS rid, ${columns.join(', ')} FROM ${table} WHERE workspace_id = ? AND ${where} = ? ORDER BY rowid LIMIT 1`).get(fx.workspaceId, key);
    if (row === undefined) return undefined;
    const ordered = [...columns.filter((c) => typeof row[c] === 'number'), ...columns.filter((c) => typeof row[c] === 'string' && !c.endsWith('_id'))];
    for (const column of ordered) {
      const next = typeof row[column] === 'number' ? row[column] + 1000 : `${row[column]} (geändert)`;
      try {
        if (db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`).run(next, row.rid).changes === 1) return `${table}.${column}`;
      } catch {
        // A CHECK or a freeze trigger refused this column; the next one is tried.
      }
    }
    return undefined;
  };
  const onRow = tryColumns(spec.table, spec.columns, spec.idColumn ?? 'id', id);
  if (onRow !== undefined) return onRow;
  for (const child of spec.children ?? []) {
    const onChild = tryColumns(child.table, child.columns, child.fk, id);
    if (onChild !== undefined) return onChild;
  }
  return undefined;
}

// --- the repro: critic N1 -----------------------------------------------------------------------------

test('N1 REPRO: the agent proposes issuing a CHF 1,000 draft, rewrites it to CHF 99,999, and the approval issues NOTHING', () => {
  const fx = fixture();
  const input = SCENARIO.issue_invoice(fx);
  const agent = { ...fx.deps, actor: 'agent' };
  const doc = () =>
    /** @type {{ status: string, subtotal_minor: number }} */ (
      fx.deps.store.db.prepare('SELECT status, subtotal_minor FROM document WHERE id = ?').get(input.invoiceId)
    );
  assert.equal(doc().status, 'draft');
  const proposedNet = doc().subtotal_minor;

  const drafted = /** @type {Body} */ (handleRest('issue_invoice', input, agent).body);
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));

  // After the Vorschlag is queued, the agent rewrites the draft (update_document is ungoverned).
  const rewrite = /** @type {Body} */ (
    handleRest(
      'update_document',
      { workspaceId: fx.workspaceId, documentId: input.invoiceId, patch: { lines: [{ description: 'Beratung', quantity: 1, unitPriceMinor: 9999900 }] } },
      agent,
    ).body
  );
  assert.equal(rewrite.ok, true, JSON.stringify(rewrite));
  assert.equal(rewrite.drafted, undefined, 'the rewrite itself is ungoverned, which is the premise of N1');
  assert.equal(doc().subtotal_minor, 9999900);

  const before = businessDigest(fx.deps.store.db);
  const decided = approve(fx, /** @type {string} */ (drafted.actionId));
  assert.equal(decided.ok, false, `the approval must refuse, got ${JSON.stringify(decided)}`);
  assert.equal(decided.error, 'vorschlag_stale');
  assert.deepEqual(decided.message, VORSCHLAG_STALE_MESSAGE, 'the refusal carries the sentence in EN and de-CH');
  assert.equal(doc().status, 'draft', 'nothing issued');
  const posted = /** @type {{ n: number }} */ (fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(fx.workspaceId));
  assert.equal(posted.n, 0, 'nothing posted');
  assert.equal(businessDigest(fx.deps.store.db), before, 'the refusal wrote no business row');
  assert.equal(rowOf(fx, /** @type {string} */ (drafted.actionId)).status, 'stale', 'the Vorschlag is void, not approved');

  // The card showed the figure the agent proposed, frozen at the proposal.
  const figures = JSON.parse(/** @type {string} */ (rowOf(fx, /** @type {string} */ (drafted.actionId)).pin_json));
  assert.equal(figures.amountMinor, proposedNet);
  assert.equal(figures.currency, 'CHF');
  assert.equal(figures.number, null, 'a draft has no number yet');

  // A second approval of the void row refuses the same way and still runs nothing.
  assert.equal(approve(fx, /** @type {string} */ (drafted.actionId)).error, 'vorschlag_stale');
  assert.equal(doc().status, 'draft');
  fx.deps.store.close();
});

test('D161 named shapes over the real verbs: po_send after po_upsert, goods_receipt_post after goods_receipt_upsert_lines', () => {
  {
    const { fx, input, actionId } = propose('po_send');
    const lines = /** @type {{ item_id: string }[]} */ (fx.deps.store.db.prepare('SELECT item_id FROM po_line WHERE po_id = ?').all(input.poId));
    const edited = /** @type {Body} */ (
      handleRest(
        'po_upsert',
        { workspaceId: fx.workspaceId, poId: input.poId, lines: [{ itemId: lines[0]?.item_id, qty: 400, unitPriceRappen: 10000 }], idempotencyKey: 'pin-po-edit' },
        { ...fx.deps, actor: 'agent' },
      ).body
    );
    assert.equal(edited.ok, true, JSON.stringify(edited));
    const decided = approve(fx, actionId);
    assert.equal(decided.error, 'vorschlag_stale', JSON.stringify(decided));
    const po = /** @type {{ status: string }} */ (fx.deps.store.db.prepare('SELECT status FROM purchase_order WHERE id = ?').get(input.poId));
    assert.notEqual(po.status, 'sent', 'the edited order was not sent');
    fx.deps.store.close();
  }
  {
    const { fx, input, actionId } = propose('goods_receipt_post');
    const line = /** @type {{ id: string }} */ (fx.deps.store.db.prepare('SELECT id FROM goods_receipt_doc_line WHERE gr_id = ?').get(input.grId));
    const edited = /** @type {Body} */ (
      handleRest(
        'goods_receipt_upsert_lines',
        { workspaceId: fx.workspaceId, grId: input.grId, ops: [{ op: 'change', lineId: line.id, qty: 1 }], idempotencyKey: 'pin-gr-edit' },
        { ...fx.deps, actor: 'agent' },
      ).body
    );
    assert.equal(edited.ok, true, JSON.stringify(edited));
    const decided = approve(fx, actionId);
    assert.equal(decided.error, 'vorschlag_stale', JSON.stringify(decided));
    const gr = /** @type {{ status: string }} */ (fx.deps.store.db.prepare('SELECT status FROM goods_receipt_doc WHERE id = ?').get(input.grId));
    assert.equal(gr.status, 'draft', 'the edited receipt was not posted');
    fx.deps.store.close();
  }
});

// --- the population ------------------------------------------------------------------------------------

test('POPULATION: every governed write that names a record is pinned or excluded with a reason, exactly once', () => {
  const missing = [];
  const both = [];
  for (const action of GOVERNED_WITH_IDS) {
    const pinned = PINS[action.name] !== undefined;
    const excluded = EXCLUDED[action.name] !== undefined;
    if (!pinned && !excluded) missing.push(`${action.name} (${idFields(action).join(', ')})`);
    if (pinned && excluded) both.push(action.name);
  }
  assert.deepEqual(missing, [], 'a governed verb that names a record must be pinned (PIN_FOR_VERB) or excluded with a reason (NOT_PINNED)');
  assert.deepEqual(both, []);
});

test('POPULATION: no stale entries, every reason is from the closed set, every pinned field is a real input field', () => {
  const governed = new Map(GOVERNED_WITH_IDS.map((a) => [a.name, a]));
  const problems = [];
  for (const [verb, entry] of Object.entries(EXCLUDED)) {
    if (!governed.has(verb)) problems.push(`NOT_PINNED.${verb}: not a governed write with a record id`);
    if (!REASONS.has(entry.reason)) problems.push(`NOT_PINNED.${verb}: reason ${entry.reason}`);
    if (typeof entry.why !== 'string' || entry.why.length < 15) problems.push(`NOT_PINNED.${verb}: no real why`);
  }
  const governedWrites = new Map(ACTIONS.filter((a) => a.kind === 'write' && dialCapabilitiesForVerb(a.name).length > 0).map((a) => [a.name, a]));
  for (const [verb, fields] of Object.entries(PINS)) {
    // A pin may also cover a governed write with NO record id: what it reads live (round 2).
    const action = governedWrites.get(verb);
    if (action === undefined) {
      problems.push(`PIN_FOR_VERB.${verb}: not a governed write`);
      continue;
    }
    if (fields.length === 0) problems.push(`PIN_FOR_VERB.${verb}: no field`);
    const props = Object.keys(action.inputSchema?.properties ?? {});
    for (const { field, workspace, record } of fields) {
      const head = field?.split('.')[0]?.replace(/\[\]$/, '');
      if (workspace !== true && (head === undefined || !props.includes(head))) problems.push(`PIN_FOR_VERB.${verb}.${field}: not an input field of the verb`);
      if (RECORDS[record] === undefined) problems.push(`PIN_FOR_VERB.${verb}.${field}: unknown record ${record}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('POPULATION BITES: a governed verb dropped from both maps is named', () => {
  const victim = 'issue_invoice';
  const pins = { ...PINS };
  delete pins[victim];
  const named = GOVERNED_WITH_IDS.filter((a) => pins[a.name] === undefined && EXCLUDED[a.name] === undefined).map((a) => a.name);
  assert.deepEqual(named, [victim]);
});

test('every table a pin reads carries workspace_id and every listed column (§H-TENANT on every read)', () => {
  const fx = fixture();
  const db = fx.deps.store.db;
  const problems = [];
  for (const { table, columns, self } of pinReadShapes()) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    // The workspace row itself is read by the context's own tenant id (the one table without the column).
    if (self === true ? table !== 'workspace' : !have.has('workspace_id')) problems.push(`${table} has no workspace_id`);
    for (const c of columns) if (!have.has(c)) problems.push(`${table}.${c} does not exist`);
  }
  fx.deps.store.close();
  assert.deepEqual(problems, []);
});

// --- one test per family -------------------------------------------------------------------------------

/** @type {Map<string, string[]>} record kind -> the verbs pinned to it as their primary record */
const FAMILIES = new Map();
for (const [verb, fields] of Object.entries(PINS)) {
  const kind = fields[0]?.record;
  if (kind === undefined) continue;
  FAMILIES.set(kind, [...(FAMILIES.get(kind) ?? []), verb]);
}

test('every record kind in the table is pinned by at least one verb', () => {
  const used = new Set(Object.values(PINS).flatMap((fields) => fields.map((f) => f.record)));
  assert.deepEqual(Object.keys(RECORDS).filter((k) => !used.has(k)), []);
});

for (const [kind, verbs] of FAMILIES) {
  test(`FAMILY ${kind}: a change after the proposal makes the approval refuse vorschlag_stale and run nothing (${verbs.join(', ')})`, () => {
    const failures = [];
    for (const verb of verbs) {
      const { fx, input, actionId } = propose(verb);
      if (rowOf(fx, actionId).pin_digest === null) {
        failures.push(`${verb}: the proposal was not pinned`);
        fx.deps.store.close();
        continue;
      }
      const changed = mutatePrimary(fx, verb, input);
      if (changed === undefined) {
        failures.push(`${verb}: no content column could be changed`);
        fx.deps.store.close();
        continue;
      }
      const before = businessDigest(fx.deps.store.db);
      const decided = approve(fx, actionId);
      if (decided.error !== 'vorschlag_stale') failures.push(`${verb} after ${changed}: ${JSON.stringify(decided).slice(0, 200)}`);
      if (businessDigest(fx.deps.store.db) !== before) failures.push(`${verb}: the refusal wrote business rows`);
      if (rowOf(fx, actionId).status !== 'stale') failures.push(`${verb}: row is ${rowOf(fx, actionId).status}, not stale`);
      fx.deps.store.close();
    }
    assert.deepEqual(failures, []);
  });

  test(`FAMILY ${kind}: an unchanged record still approves and runs (${verbs.join(', ')})`, () => {
    const failures = [];
    for (const verb of verbs) {
      const { fx, actionId } = propose(verb);
      const decided = approve(fx, actionId);
      if (decided.ok !== true) failures.push(`${verb}: ${JSON.stringify(decided).slice(0, 240)}`);
      else if (rowOf(fx, actionId).status !== 'executed') failures.push(`${verb}: row is ${rowOf(fx, actionId).status}`);
      fx.deps.store.close();
    }
    assert.deepEqual(failures, []);
  });
}

// --- replay and idempotency ------------------------------------------------------------------------------

test('IDEMPOTENT: approving an executed pinned Vorschlag twice returns the same result and writes nothing', () => {
  const { fx, actionId } = propose('issue_invoice');
  const first = approve(fx, actionId);
  assert.equal(first.ok, true, JSON.stringify(first));
  const after = businessDigest(fx.deps.store.db);
  const second = approve(fx, actionId);
  assert.deepEqual(second, first.result, 'the stored result of the replay');
  assert.equal(businessDigest(fx.deps.store.db), after);
  fx.deps.store.close();
});

test('IDEMPOTENT: the agent re-sending the same key after the approval gets the stored result, never a second proposal', () => {
  const fx = fixture();
  const input = SCENARIO.issue_invoice(fx);
  const agent = { ...fx.deps, actor: 'agent' };
  const drafted = /** @type {Body} */ (handleRest('issue_invoice', input, agent).body);
  const approved = approve(fx, /** @type {string} */ (drafted.actionId));
  assert.equal(approved.ok, true, JSON.stringify(approved));
  const again = /** @type {Body} */ (handleRest('issue_invoice', input, agent).body);
  assert.equal(again.drafted, undefined, JSON.stringify(again));
  assert.equal(again.ok, true);
  const rows = /** @type {{ n: number }} */ (fx.deps.store.db.prepare("SELECT COUNT(*) AS n FROM agent_action WHERE action_tool = 'issue_invoice'").get());
  assert.equal(rows.n, 1);
  fx.deps.store.close();
});

test('CRASH-SAFE: a replay that committed before its status flip is approvable again, although the act changed the record', () => {
  const { fx, input, actionId } = propose('issue_invoice');
  const first = approve(fx, actionId);
  assert.equal(first.ok, true, JSON.stringify(first));
  // A process death between the replay and the flip: the verb committed, the row still reads pending.
  fx.deps.store.db.prepare("UPDATE agent_action SET status = 'pending', result_json = NULL, resolved_at = NULL, resolved_by = NULL WHERE id = ?").run(actionId);
  const entries = () => /** @type {{ n: number }} */ (fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(fx.workspaceId)).n;
  const posted = entries();
  const again = approve(fx, actionId);
  assert.equal(again.ok, true, `the re-approve settles, got ${JSON.stringify(again)}`);
  assert.equal(entries(), posted, 'the replay posted nothing a second time');
  assert.equal(rowOf(fx, actionId).status, 'executed');
  const doc = /** @type {{ status: string }} */ (fx.deps.store.db.prepare('SELECT status FROM document WHERE id = ?').get(input.invoiceId));
  assert.equal(doc.status, 'issued');
  fx.deps.store.close();
});

test('PROPOSE AGAIN: the same key after a change voids the old Vorschlag and queues one with the figures as they are now', () => {
  const fx = fixture();
  const input = SCENARIO.issue_invoice(fx);
  const agent = { ...fx.deps, actor: 'agent' };
  const first = /** @type {Body} */ (handleRest('issue_invoice', input, agent).body);
  handleRest(
    'update_document',
    { workspaceId: fx.workspaceId, documentId: input.invoiceId, patch: { lines: [{ description: 'Beratung', quantity: 1, unitPriceMinor: 250000 }] } },
    agent,
  );
  const second = /** @type {Body} */ (handleRest('issue_invoice', input, agent).body);
  assert.equal(second.drafted, true, JSON.stringify(second));
  assert.notEqual(second.actionId, first.actionId, 'a new Vorschlag, not the void one');
  assert.equal(rowOf(fx, /** @type {string} */ (first.actionId)).status, 'stale');
  assert.equal(JSON.parse(/** @type {string} */ (rowOf(fx, /** @type {string} */ (second.actionId)).pin_json)).amountMinor, 250000);
  // The same key once more, nothing changed: the pending one answers (J3.10, no duplicate).
  const third = /** @type {Body} */ (handleRest('issue_invoice', input, agent).body);
  assert.equal(third.actionId, second.actionId);
  assert.equal(third.replayed, true);
  const approved = approve(fx, /** @type {string} */ (second.actionId));
  assert.equal(approved.ok, true, JSON.stringify(approved));
  fx.deps.store.close();
});

test('THE QUEUE READ: figures frozen at the proposal, changedSinceProposal on a pending row, stale rows listed under their status', () => {
  const { fx, input, actionId } = propose('issue_invoice');
  const ctx = makeContext(fx.deps.store, { workspaceId: fx.workspaceId, actor: 'studio', clock: fx.deps.clock, ids: fx.deps.ids });
  const list = (/** @type {string} */ status) => /** @type {any} */ (listDraftedActions(ctx, { status })).actions;
  const [pending] = list('pending');
  assert.equal(pending.actionId, actionId);
  assert.equal(pending.changedSinceProposal, false);
  assert.equal(pending.figures.record, 'document');
  assert.equal(typeof pending.figures.counterparty, 'string');
  assert.equal(pending.figures.lineCount, 1);
  assert.equal(pending.figures.amountBasis, 'net');

  fx.deps.store.db.prepare('UPDATE document_line SET unit_price_minor = unit_price_minor + 1 WHERE document_id = ?').run(input.invoiceId);
  assert.equal(list('pending')[0].changedSinceProposal, true, 'the card can say so before anyone clicks');
  assert.equal(approve(fx, actionId).error, 'vorschlag_stale');
  assert.equal(list('pending').length, 0);
  assert.equal(list('stale')[0].actionId, actionId);
  fx.deps.store.close();
});

test('a reject of a void Vorschlag refuses the same way and changes nothing', () => {
  const { fx, input, actionId } = propose('issue_invoice');
  fx.deps.store.db.prepare('UPDATE document_line SET unit_price_minor = unit_price_minor + 1 WHERE document_id = ?').run(input.invoiceId);
  assert.equal(approve(fx, actionId).error, 'vorschlag_stale');
  const rejected = /** @type {Body} */ (getAction('reject_drafted_action').run({ ...fx.deps, actor: 'studio' }, { workspaceId: fx.workspaceId, actionId }));
  assert.equal(rejected.error, 'vorschlag_stale');
  assert.equal(rowOf(fx, actionId).status, 'stale');
  fx.deps.store.close();
});

test('the drafting actor cannot use an approval attempt to void its own proposal', () => {
  const { fx, input, actionId } = propose('issue_invoice');
  fx.deps.store.db.prepare('UPDATE document_line SET unit_price_minor = unit_price_minor + 1 WHERE document_id = ?').run(input.invoiceId);
  const self = /** @type {Body} */ (
    getAction('approve_drafted_action').run({ ...fx.deps, actor: 'agent' }, { workspaceId: fx.workspaceId, actionId })
  );
  assert.notEqual(self.ok, true);
  assert.notEqual(self.error, 'vorschlag_stale');
  assert.equal(rowOf(fx, actionId).status, 'pending');
  fx.deps.store.close();
});

test('a Vorschlag for a verb that needs no pin carries none and approves as before', () => {
  const { fx, actionId } = propose('record_payment');
  const row = rowOf(fx, actionId);
  assert.equal(row.pin_digest, null);
  assert.equal(row.pin_json, null);
  fx.deps.store.close();
});

test('THE HUB ROW: the attention item of a pinned Vorschlag carries its frozen figures and whether the record changed', () => {
  const { fx, input } = propose('issue_invoice');
  const hubRow = () =>
    getAction('attention_summary')
      .run({ ...fx.deps, actor: 'studio' }, { workspaceId: fx.workspaceId })
      .top.find((item) => item.queueId === 'agent_action');
  const before = hubRow();
  assert.ok(before !== undefined, 'the Vorschlag reaches the hub');
  assert.equal(before.figures.amountBasis, 'net');
  assert.equal(before.figures.lineCount, 1);
  assert.equal(before.changedSinceProposal, undefined);
  fx.deps.store.db.prepare('UPDATE document_line SET unit_price_minor = unit_price_minor + 1 WHERE document_id = ?').run(input.invoiceId);
  assert.equal(hubRow().changedSinceProposal, true);
  fx.deps.store.close();
});

// --- critic round 2: the rows an act READS LIVE ------------------------------------------------------
//
// The round-2 FAIL was a class, not two bugs: the pin hashed the record a verb names but not the rows
// the act reads when it executes (the recipient's email, the tax code's rate). The structural test
// below holds the class from the SQL itself. It runs every FREE (ungoverned, workspace-scoped) write on
// its conformance scenario and records which tables each one CHANGES (UPDATE, DELETE, REPLACE, upsert:
// a row that was already there), then replays every governed verb's approval and records which tables
// it READS. A table read live that a free verb can change must be covered by the verb's pin, classified
// in LIVE_READ_TABLES with a reason a free change cannot alter the act, or carry a per-verb reason.

/** Update paths a scenario's create does not reach, run after it (the second call is the upsert). */
const UPDATE_PATHS = {
  // N-c: the employee's update path; the scenario only creates the employee.
  hr_employee_upsert: (input, first) => ({ ...input, employee: { ...input.employee, id: first.employeeId, lastName: 'Neu' }, idempotencyKey: 'pin-upd' }),
};

/**
 * The admissible values of a free-text field whose schema does not enumerate them, read from the
 * engine's own enum (so it stays true): a status a transition names. Every other field is generic.
 */
const FIELD_VOCABULARY = { to: DOCUMENT_STATUSES };

/**
 * A second starting record for a verb whose scenario record has no free branch at all: the scenario of
 * `transition_document` is a draft invoice, whose only edges (issued, cancelled) are governed; an
 * ISSUED invoice has the free ones (sent, and onward).
 */
const ALTERNATE_BASES = {
  transition_document: (fx) => ({ documentId: SCENARIO.send_invoice(fx).invoiceId, to: 'sent' }),
};

/** Synthetic values for a schema property the scenario left out (critic round 3, N1). */
function syntheticValues(schema, prop) {
  if (FIELD_VOCABULARY[prop] !== undefined) return FIELD_VOCABULARY[prop];
  if (schema === null || typeof schema !== 'object') return [];
  if (Array.isArray(schema.enum)) return schema.enum;
  if (schema.type === 'string') return ['Census AG'];
  if (schema.type === 'boolean') return [true, false];
  if (schema.type === 'integer' || schema.type === 'number') return [1];
  return [];
}

/** Every subset of `items` with at most `max` members (the empty one included). */
function subsets(items, max) {
  const out = [[]];
  for (const item of items) {
    for (const prior of [...out]) if (prior.length < max) out.push([...prior, item]);
  }
  return out;
}

/**
 * CRITIC ROUND 3, N1: the FREE branches of an input-keyed verb. The census used to skip every verb with
 * a dial rule, so `update_company_profile` without `mwstNo`, `set_creditor_profile` without the IBAN,
 * `transition_document` on an ungoverned edge and the like were never traced. The shapes are derived
 * from INPUT_KEYED_DIAL_RULES generically, so a new rule is covered without a line here: start from the
 * conformance scenario, drop up to three top-level fields (and up to two keys of a nested object), add
 * each schema property the scenario left out with a synthetic value, and keep every shape for which NO
 * rule's `when` matches (`dialCapabilitiesForCall` answers nothing). Each such shape is then CALLED over
 * the real seam as the agent, so a shape the seam refuses (undraftable, permission) changes nothing.
 */
function predicateDodgingShapes(action, base) {
  const name = action.name;
  const shapes = [];
  const seen = new Set();
  const keep = (shape) => {
    const key = JSON.stringify(shape);
    if (seen.has(key)) return;
    seen.add(key);
    if (dialCapabilitiesForCall(name, shape).length === 0) shapes.push(shape);
  };
  const without = (obj, drop) => Object.fromEntries(Object.entries(obj).filter(([k]) => !drop.includes(k)));
  const keys = Object.keys(base).filter((k) => k !== 'workspaceId' && k !== 'idempotencyKey');
  for (const drop of subsets(keys, 3)) keep(without(base, drop));
  for (const k of keys) {
    const nested = base[k];
    if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) continue;
    for (const drop of subsets(Object.keys(nested), 2)) if (drop.length > 0) keep({ ...base, [k]: without(nested, drop) });
  }
  const props = action.inputSchema?.properties ?? {};
  for (const shape of [...shapes]) {
    for (const [prop, schema] of Object.entries(props)) {
      if (prop in shape || prop === 'workspaceId' || prop === 'idempotencyKey') continue;
      for (const value of syntheticValues(schema, prop)) keep({ ...shape, [prop]: value });
    }
  }
  // A field the scenario DOES set, whose vocabulary is known, tried at each value (a transition's edge).
  for (const shape of [...shapes, base]) {
    for (const prop of Object.keys(FIELD_VOCABULARY)) {
      if (!(prop in shape)) continue;
      for (const value of FIELD_VOCABULARY[prop]) keep({ ...shape, [prop]: value });
    }
  }
  return shapes.slice(0, 60);
}

/** The input-keyed verbs whose free branch the census reached (N1, round 3). */
const FREE_BRANCHES = new Set();

let freeCensus;
/** Statement text of every free mutation, per table, for the column-scoped classifications. */
const freeMutationSql = new Map();
/** table -> the free verbs that change rows already there. */
function freeMutations() {
  if (freeCensus !== undefined) return freeCensus;
  freeCensus = new Map();
  const note = (table, verb, sqls) => {
    if (!(freeCensus.get(table) ?? []).includes(verb)) freeCensus.set(table, [...(freeCensus.get(table) ?? []), verb]);
    if (!freeMutationSql.has(table)) freeMutationSql.set(table, new Set());
    for (const sql of sqls ?? []) freeMutationSql.get(table).add(sql);
  };
  // N1 (round 3): the free branches of every input-keyed verb, called over the seam as the agent.
  for (const action of ACTIONS) {
    if (action.kind !== 'write' || DIAL_CAPABILITY_FOR_ACTION[action.name] !== undefined) continue;
    if (dialCapabilitiesForVerb(action.name).length === 0) continue;
    if (action.inputSchema?.properties?.workspaceId === undefined) continue;
    const scenario = SCENARIO[action.name];
    if (scenario === undefined) continue;
    let fx;
    try {
      fx = fixture();
      const base = { ...scenario(fx), workspaceId: fx.workspaceId };
      const agent = { ...fx.deps, actor: 'agent' };
      const alternate = ALTERNATE_BASES[action.name]?.(fx);
      const shapes = [...predicateDodgingShapes(action, base), ...(alternate === undefined ? [] : predicateDodgingShapes(action, { ...alternate, workspaceId: fx.workspaceId }))];
      shapes.forEach((shape, i) => {
        const body = { ...shape, workspaceId: fx.workspaceId };
        if ('idempotencyKey' in (action.inputSchema?.properties ?? {})) body.idempotencyKey = `census-${action.name}-${i}`;
        const traced = traceTables(fx.deps.store.db, () => handleRest(action.name, body, agent).body);
        if (traced.result?.ok !== true || traced.result?.drafted === true) return;
        for (const table of traced.mutates) {
          note(table, action.name, traced.mutateSql.get(table));
          FREE_BRANCHES.add(action.name);
        }
      });
    } catch {
      // A scenario that cannot run outside the conformance harness says nothing about mutation.
    } finally {
      try {
        fx?.deps.store.close();
      } catch {
        // already closed
      }
    }
  }
  for (const action of ACTIONS) {
    if (action.kind !== 'write' || dialCapabilitiesForVerb(action.name).length > 0) continue;
    // A pre-workspace verb mints or restores a NEW workspace; it changes no row of this one.
    if (action.inputSchema?.properties?.workspaceId === undefined) continue;
    const scenario = SCENARIO[action.name];
    if (scenario === undefined) continue;
    let fx;
    try {
      fx = fixture();
      const input = { ...scenario(fx), workspaceId: fx.workspaceId };
      const call = (body) => traceTables(fx.deps.store.db, () => getAction(action.name).run({ ...fx.deps, actor: 'agent' }, body));
      const runs = [call(input)];
      if (typeof input.idempotencyKey === 'string') runs.push(call({ ...input, idempotencyKey: `${input.idempotencyKey}-again` }));
      if (UPDATE_PATHS[action.name] !== undefined) runs.push(call(UPDATE_PATHS[action.name](input, runs[0].result)));
      for (const run of runs) for (const table of run.mutates) note(table, action.name, run.mutateSql.get(table));
    } catch {
      // A scenario that cannot run outside the conformance harness says nothing about mutation.
    } finally {
      try {
        fx?.deps.store.close();
      } catch {
        // already closed
      }
    }
  }
  return freeCensus;
}

/**
 * Whether the statements an act ran against a table read the columns a column-scoped classification
 * binds (`columns`), or any column (`*`). An unscoped classification binds every read.
 */
function readsScopedColumns(policy, sqls) {
  if (policy.columns === undefined) return true;
  return [...(sqls ?? [])].some((sql) => /\bSELECT\s+\*|\.\*/i.test(sql) || policy.columns.some((c) => new RegExp(`\\b${c}\\b`, 'i').test(sql)));
}

test('LIVE READS (structural): every table a governed act reads that a free verb can change is pinned or classified', () => {
  const free = freeMutations();
  assert.ok(free.get('contact')?.includes('update_contact'), 'the census sees update_contact change a contact');
  assert.ok(free.get('tax_code')?.includes('vat_code_upsert'), 'the census sees vat_code_upsert change a code (its update path)');
  assert.ok(free.get('employee')?.includes('hr_employee_upsert'), 'the census sees hr_employee_upsert change an employee (N-c)');
  const problems = [];
  const read = new Map();
  const readSqlOf = new Map();
  for (const action of ACTIONS) {
    if (action.kind !== 'write' || dialCapabilitiesForVerb(action.name).length === 0) continue;
    const scenario = SCENARIO[action.name];
    if (scenario === undefined) continue;
    const fx = fixture();
    try {
      const base = scenario(fx);
      const input = { ...(PIN_SHAPE[action.name] !== undefined ? PIN_SHAPE[action.name](fx, base) : base), workspaceId: fx.workspaceId };
      const drafted = enqueueDraftedAction(agentCtx(fx), { actionTool: action.name, payload: input });
      const { reads, readSql } = traceTables(fx.deps.store.db, () => approve(fx, drafted.actionId));
      read.set(action.name, reads);
      readSqlOf.set(action.name, readSql);
      const covered = PINS[action.name] !== undefined ? pinnedTablesFor(action.name) : new Set();
      for (const table of reads) {
        if (!free.has(table)) continue;
        const policy = LIVE_READ_TABLES[table];
        if (policy === undefined) {
          problems.push(`${action.name} reads ${table}, which ${free.get(table).join(', ')} change(s) freely: classify it in LIVE_READ_TABLES`);
        } else if (
          policy.policy === 'pin' &&
          readsScopedColumns(policy, readSql.get(table)) &&
          !covered.has(table) &&
          LIVE_READ_WAIVERS[action.name]?.[table] === undefined
        ) {
          problems.push(`${action.name} reads ${table} live (free: ${free.get(table).join(', ')}) and its pin does not cover it`);
        }
      }
    } finally {
      fx.deps.store.close();
    }
  }
  if (problems.length > 0) console.log(`LIVE READ PROBLEMS\n${problems.join('\n')}`);
  assert.ok(read.get('send_invoice')?.has('contact'), 'the trace sees send_invoice read the contact (R2-B1)');
  assert.ok(read.get('issue_invoice')?.has('tax_code'), 'the trace sees issue_invoice read the tax code (R2-B2)');
  // N1 (round 3): the census reaches the free branches of the input-keyed verbs, and with them the
  // workspace identity an issued invoice, a reminder and a payment file print.
  assert.ok(free.get('workspace')?.includes('update_company_profile'), 'the census sees update_company_profile (without mwstNo) change the workspace');
  assert.ok(free.get('workspace')?.includes('set_creditor_profile'), 'the census sees set_creditor_profile (without the IBAN) change the workspace');
  assert.ok(readsScopedColumns(LIVE_READ_TABLES.workspace, readSqlOf.get('issue_invoice')?.get('workspace')), 'issue_invoice reads the printed identity');
  assert.deepEqual(problems, []);
});

test('the census traces the free branch of every input-keyed verb whose scenario can dodge its rules', () => {
  freeMutations();
  console.log('FREE BRANCHES', [...FREE_BRANCHES].sort().join(' '));
  for (const verb of ['update_company_profile', 'set_creditor_profile', 'update_bank_account', 'update_recurring_schedule', 'create_recurring_schedule', 'checklist_item_complete', 'update_automation_rule', 'transition_document']) {
    assert.ok(FREE_BRANCHES.has(verb), `${verb}: its free branch was reached`);
  }
});

test('a column-scoped table classification only binds an act that reads those columns', () => {
  const policy = { policy: 'pin', columns: ['creditor_name', 'name'] };
  assert.equal(readsScopedColumns(policy, new Set(['SELECT base_currency FROM workspace WHERE id = ?'])), false);
  assert.equal(readsScopedColumns(policy, new Set(['SELECT name, uid FROM workspace WHERE id = ?'])), true);
  assert.equal(readsScopedColumns(policy, new Set(['SELECT * FROM workspace WHERE id = ?'])), true);
  assert.equal(readsScopedColumns({ policy: 'pin' }, new Set(['SELECT base_currency FROM workspace WHERE id = ?'])), true);
});

test('LIVE READS BITE: dropping the contact from the document pin leaves send_invoice uncovered', () => {
  const covered = new Set([...pinnedTablesFor('send_invoice')].filter((t) => t !== 'contact'));
  assert.equal(LIVE_READ_TABLES.contact.policy, 'pin');
  assert.equal(covered.has('contact'), false);
  assert.equal(pinnedTablesFor('send_invoice').has('contact'), true);
  assert.equal(pinnedTablesFor('issue_invoice').has('tax_code'), true);
});

test('every LIVE_READ_TABLES entry names a real table and carries a reason', () => {
  const fx = fixture();
  const tables = new Set(fx.deps.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  fx.deps.store.close();
  const problems = [];
  for (const [table, entry] of Object.entries(LIVE_READ_TABLES)) {
    if (!tables.has(table)) problems.push(`${table}: no such table`);
    if (typeof entry.why !== 'string' || entry.why.length < 20) problems.push(`${table}: no real why`);
  }
  assert.deepEqual(problems, []);
});

// --- one mutation test per dependency kind (and the critic's three probes as tests) ---------------------

/** Propose over the real REST seam as the agent, run `change` as the agent, then the person approves. */
function proposeChangeApprove(fx, verb, input, change) {
  const agent = { ...fx.deps, actor: 'agent' };
  const drafted = handleRest(verb, input, agent).body;
  assert.equal(drafted.drafted, true, `${verb}: ${JSON.stringify(drafted).slice(0, 200)}`);
  const changed = change(agent);
  assert.equal(changed.ok, true, `the free change runs: ${JSON.stringify(changed).slice(0, 200)}`);
  assert.equal(changed.drafted, undefined, 'the change itself is free, which is the premise');
  return { decided: approve(fx, drafted.actionId), actionId: drafted.actionId };
}

test('p9 RECIPIENT (R2-B1): the agent proposes send_invoice, rewrites the customer email, and the approval sends NOTHING', () => {
  const fx = fixture();
  const box = [];
  fx.deps.emailRelay = {
    send: (m) => {
      box.push(m.to);
      return { ok: true };
    },
  };
  const { confirmed: _c, email: _e, ...input } = SCENARIO.send_invoice(fx);
  const contactId = fx.deps.store.db.prepare('SELECT contact_id FROM document WHERE id = ?').get(input.invoiceId).contact_id;
  const proposedTo = fx.deps.store.db.prepare('SELECT email FROM contact WHERE id = ?').get(contactId).email;
  const { decided, actionId } = proposeChangeApprove(fx, 'send_invoice', input, (agent) =>
    handleRest('update_contact', { workspaceId: fx.workspaceId, contactId, patch: { email: 'drop@attacker.example' } }, agent).body,
  );
  assert.equal(decided.error, 'vorschlag_stale', JSON.stringify(decided).slice(0, 300));
  assert.deepEqual(box, [], 'nothing was sent, least of all to the rewritten address');
  assert.equal(fx.deps.store.db.prepare('SELECT sent_to_email FROM document WHERE id = ?').get(input.invoiceId).sent_to_email, null);
  assert.equal(JSON.parse(rowOf(fx, actionId).pin_json).recipient, proposedTo, 'the card showed the recipient the person approved');
  fx.deps.store.close();
});

test('p12 DUNNING RECIPIENT (R2-B1): send_dunning_run after the debtors\' emails changed sends NOTHING', () => {
  const fx = fixture();
  const box = [];
  fx.deps.emailRelay = {
    send: (m) => {
      box.push(m.to);
      return { ok: true };
    },
  };
  const { confirmed: _c, ...input } = SCENARIO.send_dunning_run(fx);
  const debtors = fx.deps.store.db.prepare('SELECT DISTINCT debtor_id FROM dunning_item WHERE run_id = ?').all(input.runId);
  assert.ok(debtors.length > 0);
  const { decided } = proposeChangeApprove(fx, 'send_dunning_run', input, (agent) => {
    let last;
    for (const { debtor_id } of debtors) {
      last = handleRest('update_contact', { workspaceId: fx.workspaceId, contactId: debtor_id, patch: { email: 'drop@attacker.example' } }, agent).body;
    }
    return last;
  });
  assert.equal(decided.error, 'vorschlag_stale', JSON.stringify(decided).slice(0, 300));
  assert.deepEqual(box, []);
  fx.deps.store.close();
});

test('p11 TAX RATE (R2-B2): the rate of the line\'s code changes after the proposal, and the approval issues NOTHING', () => {
  const fx = fixture();
  const ws = fx.workspaceId;
  const input = SCENARIO.issue_invoice(fx);
  const agent = { ...fx.deps, actor: 'agent' };
  getAction('update_company_profile').run({ ...fx.deps, actor: 'studio' }, { workspaceId: ws, mwstNo: 'CHE-116.281.710 MWST' });
  fx.deps.store.db.prepare('UPDATE workspace SET vat_registered = 1 WHERE id = ?').run(ws);
  const tc = fx.deps.store.db.prepare("SELECT kind, rate_bp, esa_form_line FROM tax_code WHERE workspace_id = ? AND code = 'UST81'").get(ws);
  const made = handleRest('vat_code_upsert', { workspaceId: ws, code: 'UXX', kind: tc.kind, rateBp: 810, formLine: tc.esa_form_line, label: 'Normal' }, agent).body;
  assert.equal(made.ok, true, JSON.stringify(made));
  const repointed = handleRest(
    'update_document',
    { workspaceId: ws, documentId: input.invoiceId, patch: { lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UXX' }] } },
    agent,
  ).body;
  assert.equal(repointed.ok, true, JSON.stringify(repointed));
  const { decided, actionId } = proposeChangeApprove(fx, 'issue_invoice', input, () =>
    handleRest('vat_code_upsert', { workspaceId: ws, code: 'UXX', kind: tc.kind, rateBp: 0, formLine: tc.esa_form_line, label: 'Normal' }, agent).body,
  );
  assert.equal(decided.error, 'vorschlag_stale', JSON.stringify(decided).slice(0, 300));
  assert.equal(fx.deps.store.db.prepare('SELECT status FROM document WHERE id = ?').get(input.invoiceId).status, 'draft');
  const figures = JSON.parse(rowOf(fx, actionId).pin_json);
  assert.equal(figures.amountMinor, 100000);
  assert.equal(figures.taxMinor, 8100, 'the card showed the VAT at the rate the person approved');
  assert.equal(figures.grossMinor, 108100);
  fx.deps.store.close();
});

test('ITEM COST (N-d): a stock move that omits its cost goes stale when the item cost changes', () => {
  const fx = fixture();
  const { unitCostMinor: _c, ...input } = SCENARIO.stock_move(fx);
  const { decided } = proposeChangeApprove(fx, 'stock_move', input, (agent) =>
    handleRest('update_item', { workspaceId: fx.workspaceId, itemId: input.itemId, patch: { costPriceMinor: 999900 } }, agent).body,
  );
  assert.equal(decided.error, 'vorschlag_stale', JSON.stringify(decided).slice(0, 300));
  fx.deps.store.close();
});

test('ITEM COST (N-d): a move that states its own cost is not pinned to the item', () => {
  const fx = fixture();
  const withCost = { ...SCENARIO.stock_move(fx), workspaceId: fx.workspaceId };
  const drafted = enqueueDraftedAction(agentCtx(fx), { actionTool: 'stock_move', payload: withCost });
  assert.equal(rowOf(fx, drafted.actionId).pin_digest, null);
  fx.deps.store.close();
});

test('PAYEE (N-c): a reimbursement goes stale when the employee is re-pointed to another payee contact', () => {
  const fx = fixture();
  const input = SCENARIO.expense_claim_reimburse(fx);
  const employeeId = fx.deps.store.db.prepare('SELECT employee_id FROM expense_claim WHERE id = ?').get(input.claimId).employee_id;
  const other = fx.call('create_contact', { partyRole: 'vendor', name: 'Fremdes Konto', idempotencyKey: 'pin-payee' }).contact.id;
  const { decided } = proposeChangeApprove(fx, 'expense_claim_reimburse', input, (agent) =>
    handleRest(
      'hr_employee_upsert',
      {
        workspaceId: fx.workspaceId,
        employee: { id: employeeId, firstName: 'Alex', lastName: 'Muster', employmentPct: 80, startsOn: '2026-01-01', contactId: other },
        idempotencyKey: 'pin-repoint',
      },
      agent,
    ).body,
  );
  assert.equal(decided.error, 'vorschlag_stale', JSON.stringify(decided).slice(0, 300));
  fx.deps.store.close();
});

test('ACCOUNT MAPPING: issuing a dunning run goes stale when the fee income account changes after the proposal', () => {
  const fx = fixture();
  const level = (feeIncomeAccountId) => [
    { level: 1, daysOverdue: 10, feeMinor: 3000, bookFee: true, feeIncomeAccountId, showInterest: true, interestBp: 500 },
    { level: 2, daysOverdue: 20, feeMinor: 0 },
    { level: 3, daysOverdue: 30, feeMinor: 0 },
  ];
  const { confirmed: _c, ...input } = SCENARIO.issue_dunning_run(fx);
  const fee3200 = fx.accId('3200');
  const person = getAction('set_dunning_config').run({ ...fx.deps, actor: 'studio' }, { workspaceId: fx.workspaceId, levels: level(fee3200), idempotencyKey: 'pin-fee-0' });
  assert.equal(person.ok, true, JSON.stringify(person).slice(0, 200));
  const other = fx.deps.store.db.prepare("SELECT id FROM account WHERE workspace_id = ? AND number LIKE '3%' AND id <> ? AND archived = 0 ORDER BY number LIMIT 1").get(fx.workspaceId, fee3200).id;
  const { decided } = proposeChangeApprove(fx, 'issue_dunning_run', input, (agent) =>
    handleRest('set_dunning_config', { workspaceId: fx.workspaceId, levels: level(other), idempotencyKey: 'pin-fee-1' }, agent).body,
  );
  assert.equal(decided.error, 'vorschlag_stale', JSON.stringify(decided).slice(0, 300));
  fx.deps.store.close();
});

test('MIGRATION (N-b): a master-data commit goes stale when the plan\'s map changes after the proposal', () => {
  const fx = fixture();
  const input = { ...SCENARIO.migration_commit_step(fx), workspaceId: fx.workspaceId };
  const drafted = enqueueDraftedAction(agentCtx(fx), { actionTool: 'migration_commit_step', payload: input });
  const changed = getAction('migration_set_map').run(
    { ...fx.deps, actor: 'agent' },
    { workspaceId: fx.workspaceId, planId: input.planId, kind: 'account', entries: [{ source: '1010', sourceName: 'Kasse', balanceMinor: 0, target: '1000' }], idempotencyKey: 'pin-map' },
  );
  assert.equal(changed.ok, true, JSON.stringify(changed).slice(0, 200));
  const decided = approve(fx, drafted.actionId);
  assert.equal(decided.error, 'vorschlag_stale', JSON.stringify(decided).slice(0, 300));
  fx.deps.store.close();
});

test('N-a: draft_regenerate with overwriteEdits is a person\'s choice: the governed seat is refused needs_a_person', () => {
  const fx = fixture();
  const input = { ...SCENARIO.draft_regenerate(fx), workspaceId: fx.workspaceId };
  const refused = getAction('draft_regenerate').run({ ...fx.deps, actor: 'agent' }, { ...input, overwriteEdits: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'needs_a_person', JSON.stringify(refused).slice(0, 200));
  fx.deps.store.close();
});

// --- critic round 3, N1: the printed identity of the workspace ---------------------------------------

test('p16 IDENTITY (round 3): after the proposal the agent renames the company and the payee; the approval issues NOTHING', () => {
  const fx = fixture();
  const ws = fx.workspaceId;
  const input = SCENARIO.issue_invoice(fx);
  const agent = { ...fx.deps, actor: 'agent' };
  const drafted = handleRest('issue_invoice', input, agent).body;
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  const renamed = handleRest('update_company_profile', { workspaceId: ws, name: 'Andere Firma AG', uid: 'CHE-109.322.551' }, agent).body;
  assert.equal(renamed.ok, true, JSON.stringify(renamed));
  assert.equal(renamed.drafted, undefined, 'the rename is free, which is the premise');
  const payee = handleRest(
    'set_creditor_profile',
    { workspaceId: ws, creditorName: 'Andere Firma AG', address: { street: 'Gasse', buildingNo: '9', zip: '1000', town: 'Lausanne', country: 'CH' } },
    agent,
  ).body;
  assert.equal(payee.ok, true, JSON.stringify(payee));
  assert.equal(payee.drafted, undefined, 'the payee change without an IBAN is free, which is the premise');
  const decided = approve(fx, drafted.actionId);
  assert.equal(decided.error, 'vorschlag_stale', JSON.stringify(decided).slice(0, 300));
  const doc = fx.deps.store.db.prepare('SELECT status, number FROM document WHERE id = ?').get(input.invoiceId);
  assert.equal(doc.status, 'draft');
  assert.equal(doc.number, null);
  fx.deps.store.close();
});

test('the printed identity is pinned by every act that renders or transmits', () => {
  for (const verb of [
    'issue_invoice',
    'issue_credit_note',
    'send_invoice',
    'transition_document',
    'quotes_send',
    'issue_dunning_run',
    'send_dunning_run',
    'generate_pain001',
    'payment_batch_transmit',
    'po_send',
    'sign_requests_send',
    'delivery_note_issue',
    'ebill_transmit',
    'portal_grant_send',
    'vendor_portal_remittance_create',
    'bank_channel_connect',
  ]) {
    assert.ok(pinnedTablesFor(verb).has('workspace'), `${verb} pins the workspace identity`);
  }
});

test('a rename alone makes a pending send stale, and a change the identity does not print does not', () => {
  const fx = fixture();
  const { confirmed: _c, email: _e, ...input } = SCENARIO.send_invoice(fx);
  const drafted = enqueueDraftedAction(agentCtx(fx), { actionTool: 'send_invoice', payload: { ...input, workspaceId: fx.workspaceId } });
  // posting_auto_issue is not identity: the pin does not move.
  fx.deps.store.db.prepare('UPDATE workspace SET posting_auto_issue = posting_auto_issue WHERE id = ?').run(fx.workspaceId);
  assert.equal(listDraftedActions(makeContext(fx.deps.store, { workspaceId: fx.workspaceId, actor: 'studio', clock: fx.deps.clock, ids: fx.deps.ids }), {}).actions[0].changedSinceProposal, false);
  getAction('update_company_profile').run({ ...fx.deps, actor: 'agent' }, { workspaceId: fx.workspaceId, name: 'Umbenannt AG' });
  assert.equal(approve(fx, drafted.actionId).error, 'vorschlag_stale');
  fx.deps.store.close();
});

// --- D163: the due date an issue or an expense derives ---------------------------------------------------

const issuedDoc = (/** @type {Fx} */ fx, /** @type {string} */ id) =>
  /** @type {{ status: string, due_date: string | null, issue_date: string | null }} */ (
    fx.deps.store.db.prepare('SELECT status, due_date, issue_date FROM document WHERE id = ?').get(id)
  );

test('D163 TERMS: the agent proposes issue_invoice, changes the workspace default Zahlungsfrist, and the approval issues NOTHING', () => {
  const fx = fixture();
  const input = SCENARIO.issue_invoice(fx);
  assert.equal(issuedDoc(fx, input.invoiceId).due_date, null, 'the draft names no due date, so the issue derives it');
  const { decided, actionId } = proposeChangeApprove(fx, 'issue_invoice', input, (agent) =>
    handleRest('update_company_profile', { workspaceId: fx.workspaceId, defaultPaymentTermsDays: 365 }, agent).body,
  );
  assert.equal(decided.error, 'vorschlag_stale', JSON.stringify(decided).slice(0, 300));
  assert.equal(issuedDoc(fx, input.invoiceId).status, 'draft', 'nothing was issued');
  assert.equal(rowOf(fx, actionId).status, 'stale');
  fx.deps.store.close();
});

test('D163 TERMS: the agent proposes issue_invoice, changes the customer\'s own Zahlungsfrist, and the approval issues NOTHING', () => {
  const fx = fixture();
  const input = SCENARIO.issue_invoice(fx);
  const contactId = fx.deps.store.db.prepare('SELECT contact_id FROM document WHERE id = ?').get(input.invoiceId).contact_id;
  const { decided } = proposeChangeApprove(fx, 'issue_invoice', input, (agent) =>
    handleRest('update_contact', { workspaceId: fx.workspaceId, contactId, patch: { paymentTermsDays: 365 } }, agent).body,
  );
  assert.equal(decided.error, 'vorschlag_stale', JSON.stringify(decided).slice(0, 300));
  assert.equal(issuedDoc(fx, input.invoiceId).status, 'draft');
  fx.deps.store.close();
});

test('D163 INTENT: the due date the issue derives does not move the pin, so the issued invoice digests as the draft did', () => {
  const { fx, input, actionId } = propose('issue_invoice');
  const payload = { ...input, workspaceId: fx.workspaceId };
  const before = pinFor(agentCtx(fx), 'issue_invoice', payload)?.digest;
  assert.equal(before, rowOf(fx, actionId).pin_digest, 'the stored pin is the pin of the draft');
  const first = approve(fx, actionId);
  assert.equal(first.ok, true, JSON.stringify(first));
  const doc = issuedDoc(fx, input.invoiceId);
  assert.equal(doc.status, 'issued');
  assert.equal(typeof doc.due_date, 'string', 'the issue wrote the derived due date');
  assert.equal(pinFor(agentCtx(fx), 'issue_invoice', payload)?.digest, before, 'the derived date reads as the unset date the draft carried');
  // Mutation check: a due date the derivation does NOT give is content again.
  fx.deps.store.db.prepare("UPDATE document SET due_date = '2099-01-01' WHERE id = ?").run(input.invoiceId);
  assert.notEqual(pinFor(agentCtx(fx), 'issue_invoice', payload)?.digest, before);
  fx.deps.store.close();
});

test('D163 INTENT: an explicit due date stays content, and moving it after the proposal makes the issue stale', () => {
  const fx = fixture();
  const input = SCENARIO.issue_invoice(fx);
  const agent = { ...fx.deps, actor: 'agent' };
  const set = /** @type {Body} */ (handleRest('update_document', { workspaceId: fx.workspaceId, documentId: input.invoiceId, patch: { dueDate: '2026-12-31' } }, agent).body);
  assert.equal(set.ok, true, JSON.stringify(set));
  const { decided } = proposeChangeApprove(fx, 'issue_invoice', input, (a) =>
    handleRest('update_document', { workspaceId: fx.workspaceId, documentId: input.invoiceId, patch: { dueDate: '2027-06-30' } }, a).body,
  );
  assert.equal(decided.error, 'vorschlag_stale', JSON.stringify(decided).slice(0, 300));
  assert.equal(issuedDoc(fx, input.invoiceId).status, 'draft');
  fx.deps.store.close();
});

test('D163 INTENT: an explicit due date survives the issue, and a crashed approval still settles', () => {
  const fx = fixture();
  const input = SCENARIO.issue_invoice(fx);
  const agent = { ...fx.deps, actor: 'agent' };
  handleRest('update_document', { workspaceId: fx.workspaceId, documentId: input.invoiceId, patch: { dueDate: '2026-12-31' } }, agent);
  const drafted = /** @type {Body} */ (handleRest('issue_invoice', input, agent).body);
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  const actionId = /** @type {string} */ (drafted.actionId);
  assert.equal(approve(fx, actionId).ok, true);
  assert.equal(issuedDoc(fx, input.invoiceId).due_date, '2026-12-31', 'the stated date is kept');
  fx.deps.store.db.prepare("UPDATE agent_action SET status = 'pending', result_json = NULL, resolved_at = NULL, resolved_by = NULL WHERE id = ?").run(actionId);
  assert.equal(approve(fx, actionId).ok, true, 'the re-approve settles');
  assert.equal(rowOf(fx, actionId).status, 'executed');
  fx.deps.store.close();
});

test('D163 TERMS: the agent proposes record_expense, changes the workspace default Zahlungsfrist, and the approval books NOTHING', () => {
  const fx = fixture();
  const { dueDate: _d, ...input } = /** @type {Record<string, unknown>} */ (SCENARIO.record_expense(fx));
  const bills = () => /** @type {{ n: number }} */ (fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM vendor_bill WHERE workspace_id = ?').get(fx.workspaceId)).n;
  const before = bills();
  const { decided } = proposeChangeApprove(fx, 'record_expense', input, (agent) =>
    handleRest('update_company_profile', { workspaceId: fx.workspaceId, defaultPaymentTermsDays: 90 }, agent).body,
  );
  assert.equal(decided.error, 'vorschlag_stale', JSON.stringify(decided).slice(0, 300));
  assert.equal(bills(), before, 'no bill was recorded');
  fx.deps.store.close();
});

// --- D164: the document-level Leistungsdatum every undated line is priced at ------------------------------

test('D164 DATE: the agent proposes issue_invoice, moves the document-level Leistungsdatum into another rate era, and the approval issues NOTHING', () => {
  const fx = fixture();
  const input = SCENARIO.issue_invoice(fx);
  const { decided, actionId } = proposeChangeApprove(fx, 'issue_invoice', input, (agent) =>
    handleRest('update_document', { workspaceId: fx.workspaceId, documentId: input.invoiceId, patch: { supplyDate: '2023-06-30' } }, agent).body,
  );
  assert.equal(decided.error, 'vorschlag_stale', JSON.stringify(decided).slice(0, 300));
  assert.equal(issuedDoc(fx, input.invoiceId).status, 'draft', 'nothing was issued');
  assert.equal(rowOf(fx, actionId).status, 'stale');
  fx.deps.store.close();
});

test('D164 CARD: the VAT the card shows is priced at the document-level Leistungsdatum, as the issue prices it', () => {
  const fx = fixture();
  const input = SCENARIO.issue_invoice(fx);
  const agent = { ...fx.deps, actor: 'agent' };
  const set = /** @type {Body} */ (handleRest('update_document', { workspaceId: fx.workspaceId, documentId: input.invoiceId, patch: { supplyDate: '2023-06-30' } }, agent).body);
  assert.equal(set.ok, true, JSON.stringify(set));
  const drafted = /** @type {Body} */ (handleRest('issue_invoice', input, agent).body);
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  const card = JSON.parse(/** @type {string} */ (rowOf(fx, /** @type {string} */ (drafted.actionId)).pin_json));
  assert.equal(card.amountMinor, 100000);
  assert.equal(card.taxMinor, 7700, `a 2023 supply at the 7.7% the issue posts, got ${JSON.stringify(card)}`);
  const approved = approve(fx, /** @type {string} */ (drafted.actionId));
  assert.equal(approved.ok, true, JSON.stringify(approved));
  const posted = /** @type {{ tax_minor: number }} */ (fx.deps.store.db.prepare('SELECT tax_minor FROM document WHERE id = ?').get(input.invoiceId));
  assert.equal(posted.tax_minor, card.taxMinor, 'the card showed what was posted');
  fx.deps.store.close();
});
