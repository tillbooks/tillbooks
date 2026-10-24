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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  pinnedColumnsFor,
  UNPINNED_COLUMNS,
  pinReadShapes,
  VORSCHLAG_STALE_MESSAGE,
  dialCapabilitiesForVerb,
  enqueueDraftedAction,
  listDraftedActions,
  pinFor,
  entityRefOf,
} from '../../dist/core/agent/index.js';
import { DIAL_CAPABILITY_FOR_ACTION, dialCapabilitiesForCall } from '../../dist/core/agent/dialMap.js';
import { DOCUMENT_STATUSES } from '../../dist/core/sales/document.js';
import { dueDateFor } from '../../dist/core/setup/index.js';
import { SCENARIOS, fixture } from '../api/conformance-contract.mjs';
import { traceTables } from './sql-trace.mjs';
import { AT, mintWorkspace } from '../api/support.mjs';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { syntheticIban, chain, container, mockBank } from '../banking/ebics-support.mjs';

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
  // D175: the conformance scenario books by a Buchungsregel, whose row the DB freezes (an edit
  // supersedes it). The tax-code family is about a code the payload NAMES, so this shape books the very
  // `accounts` target the rule expands to (read from compose_entry), its legs naming their codes. The rule
  // target's own pin is held by 'D175: a book_bank_line rule target ...' below.
  book_bank_line: (fx, base) => {
    const composed = /** @type {any} */ (fx.call('compose_entry', { mode: 'expand', bankTxnId: base.bankTxnId, target: base.target }));
    return { ...base, target: composed.target };
  },
  // D176: the conformance scenario posts typed lines, which name no record; this shape posts the same
  // booking from a Vorlage (6500 asked in Soll, 1000 the rest in Haben), whose row the pin is about.
  post_entry: (fx, base) => {
    const vorlage = /** @type {any} */ (
      fx.call('set_bank_standard', {
        scope: 'manual',
        label: 'Büromaterial bar',
        legs: [
          { accountId: fx.accId('6500'), taxCode: null, side: 'debit', amount: { kind: 'ask', label: 'Betrag' } },
          { accountId: fx.accId('1000'), taxCode: null, side: 'credit', amount: { kind: 'rest' } },
        ],
        idempotencyKey: 'pin-vorlage',
      })
    ).standard;
    const { lines: _lines, ...rest } = base;
    return { ...rest, template: { standardId: vorlage.id, asks: { 0: 5000 } } };
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
  // D176: an append-only record whose every content column the DB freezes (a Buchungsregel) still admits
  // ONE write, its supersession stamp, which is what an edit or a clear does to it. When the pin covers
  // that stamp, stamping it is the change.
  if (spec.columns.includes('superseded_at')) {
    try {
      const n = db.prepare(`UPDATE ${spec.table} SET superseded_at = '2026-12-31T00:00:00Z' WHERE workspace_id = ? AND id = ? AND superseded_at IS NULL`).run(fx.workspaceId, id).changes;
      if (n === 1) return `${spec.table}.superseded_at`;
    } catch {
      // The stamp was refused too: the record cannot change.
    }
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

// --- D175: a book_bank_line rule target pins its Buchungsregel -------------------------------------------

test('D175: a book_bank_line rule target pins its Buchungsregel, every leg code and every account: a change after the proposal makes the approval refuse vorschlag_stale and book nothing', () => {
  // critic D175-C2: `askedCode` changes the MWST code of the ASKED leg (named only inside legs_json),
  // `legAccount` the rest leg's account and `viaAccount` the Durchlaufkonto, each as any ungoverned writer
  // could, straight in the row.
  for (const change of ['edit', 'clear', 'askedCode', 'legAccount', 'viaAccount']) {
    const fx = fixture();
    const input = SCENARIO.book_bank_line(fx);
    assert.equal(input.target.kind, 'rule', 'the conformance scenario books by a rule');
    const drafted = /** @type {Body} */ (enqueueDraftedAction(agentCtx(fx), { actionTool: 'book_bank_line', payload: { ...input, workspaceId: fx.workspaceId } }));
    assert.equal(drafted.ok, true, JSON.stringify(drafted));
    const actionId = /** @type {string} */ (drafted.actionId);
    assert.notEqual(rowOf(fx, actionId).pin_digest, null, 'the proposal is pinned');
    if (change === 'edit') {
      // The person changes the rule (the asked leg moves to 6800): the old row is superseded, a new one lives.
      const rule = /** @type {any} */ (fx.deps.store.db.prepare('SELECT * FROM bank_standard WHERE id = ?').get(input.target.standardId));
      const legs = JSON.parse(rule.legs_json).map((/** @type {any} */ l, /** @type {number} */ i) => (i === 0 ? { ...l, accountId: fx.accId('6570') } : l));
      const edited = /** @type {any} */ (fx.call('set_bank_standard', { bankTxnId: input.bankTxnId, legs, viaAccountId: rule.via_account_id, label: rule.label, idempotencyKey: 'pin-edit' }));
      assert.equal(edited.supersededId, input.target.standardId);
    } else if (change === 'clear') {
      fx.call('clear_bank_standard', { standardId: input.target.standardId, idempotencyKey: 'pin-clear' });
    } else {
      const rule = /** @type {any} */ (fx.deps.store.db.prepare('SELECT * FROM bank_standard WHERE id = ?').get(input.target.standardId));
      const asked = JSON.parse(rule.legs_json).find((/** @type {any} */ l) => l.amount.kind === 'ask');
      const db = fx.deps.store.db;
      const n =
        change === 'askedCode'
          ? db.prepare('UPDATE tax_code SET rate_bp = rate_bp + 100 WHERE workspace_id = ? AND code = ?').run(fx.workspaceId, asked.taxCode).changes
          : db.prepare('UPDATE account SET type = ? WHERE workspace_id = ? AND id = ?').run('liability', fx.workspaceId, change === 'legAccount' ? rule.account_id : rule.via_account_id).changes;
      assert.ok(n >= 1, `${change}: the change was written`);
    }
    const before = businessDigest(fx.deps.store.db);
    const decided = approve(fx, actionId);
    assert.equal(decided.error, 'vorschlag_stale', `${change}: ${JSON.stringify(decided).slice(0, 300)}`);
    assert.equal(businessDigest(fx.deps.store.db), before, `${change}: nothing was booked`);
    assert.equal(rowOf(fx, actionId).status, 'stale');
    fx.deps.store.close();
  }
  // Unchanged, the rule target approves and books.
  const fx = fixture();
  const input = SCENARIO.book_bank_line(fx);
  const drafted = /** @type {Body} */ (enqueueDraftedAction(agentCtx(fx), { actionTool: 'book_bank_line', payload: { ...input, workspaceId: fx.workspaceId } }));
  const decided = approve(fx, /** @type {string} */ (drafted.actionId));
  assert.equal(decided.ok, true, JSON.stringify(decided).slice(0, 300));
  fx.deps.store.close();
});

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

let approvalCensus;
/**
 * Every governed verb's approval, replayed from its conformance scenario (the pin shape where one is
 * needed) and traced: verb -> the tables it read and the statement text per table. Computed once and
 * shared by the table census and the column census below.
 */
function approvalReads() {
  if (approvalCensus !== undefined) return approvalCensus;
  approvalCensus = new Map();
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
      approvalCensus.set(action.name, { reads, readSql });
    } finally {
      fx.deps.store.close();
    }
  }
  return approvalCensus;
}

test('LIVE READS (structural): every table a governed act reads that a free verb can change is pinned or classified', () => {
  const free = freeMutations();
  assert.ok(free.get('contact')?.includes('update_contact'), 'the census sees update_contact change a contact');
  assert.ok(free.get('tax_code')?.includes('vat_code_upsert'), 'the census sees vat_code_upsert change a code (its update path)');
  assert.ok(free.get('employee')?.includes('hr_employee_upsert'), 'the census sees hr_employee_upsert change an employee (N-c)');
  const problems = [];
  const read = new Map();
  const readSqlOf = new Map();
  for (const [verb, { reads, readSql }] of approvalReads()) {
    read.set(verb, reads);
    readSqlOf.set(verb, readSql);
    const covered = PINS[verb] !== undefined ? pinnedTablesFor(verb) : new Set();
    for (const table of reads) {
      if (!free.has(table)) continue;
      const policy = LIVE_READ_TABLES[table];
      if (policy === undefined) {
        problems.push(`${verb} reads ${table}, which ${free.get(table).join(', ')} change(s) freely: classify it in LIVE_READ_TABLES`);
      } else if (
        policy.policy === 'pin' &&
        readsScopedColumns(policy, readSql.get(table)) &&
        !covered.has(table) &&
        LIVE_READ_WAIVERS[verb]?.[table] === undefined
      ) {
        problems.push(`${verb} reads ${table} live (free: ${free.get(table).join(', ')}) and its pin does not cover it`);
      }
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

/** Every column of `table` that one of `sqls` names (all of them on a `SELECT *` or `x.*`). */
function columnsRead(db, table, sqls) {
  const all = db.prepare(`PRAGMA table_info("${table}")`).all().map((r) => r.name);
  const out = new Set();
  for (const sql of sqls ?? []) {
    const star = /\bSELECT\s+\*|\.\*/i.test(sql);
    for (const c of all) if (star || new RegExp(`\\b${c}\\b`, 'i').test(sql)) out.add(c);
  }
  return out;
}

/**
 * B-1 (independent critic, 13.10.2026): the census above is TABLE-level, so a new column on a table a
 * verb already pins stays green although the act reads it and the pin does not digest it. That is the
 * mechanism of the D162 x D164 merge HIGH: `supply_date` reached `document`, issue_invoice priced at it,
 * and only two hand-written tests noticed when it was dropped from DOCUMENT_COLUMNS. Here every column an
 * approved act's SQL names on a table its pin covers (a `pin` table a free verb changes, within the
 * classification's column scope) must be digested by the pin or carry a reason in UNPINNED_COLUMNS.
 * The column match is textual and over-approximates (a `SELECT *` reads every column), which fails
 * toward demanding a reason, never toward a silent pass.
 */
function columnCensus(exclusions = UNPINNED_COLUMNS, pinned = pinnedColumnsFor) {
  const free = freeMutations();
  const fx = fixture();
  const db = fx.deps.store.db;
  const problems = new Map();
  try {
    for (const [verb, { readSql }] of approvalReads()) {
      if (PINS[verb] === undefined) continue;
      for (const [table, digested] of pinned(verb)) {
        const policy = LIVE_READ_TABLES[table];
        if (policy?.policy !== 'pin' || !free.has(table)) continue;
        for (const column of columnsRead(db, table, readSql.get(table))) {
          if (digested.has(column) || column === 'workspace_id' || column === 'id') continue;
          if (policy.columns !== undefined && !policy.columns.includes(column)) continue;
          if (exclusions[table]?.[column] !== undefined) continue;
          const key = `${table}.${column}`;
          problems.set(key, [...(problems.get(key) ?? []), verb]);
        }
      }
    }
  } finally {
    fx.deps.store.close();
  }
  return problems;
}

test('LIVE READS (columns, B-1): every column an act reads of a table its pin covers is digested or carries a reason', () => {
  const problems = columnCensus();
  const lines = [...problems].sort().map(([k, verbs]) => `${k}: ${verbs.join(' ')}`);
  if (lines.length > 0) console.log(`UNPINNED COLUMN READS\n${lines.join('\n')}`);
  assert.deepEqual(lines, []);
});

test('LIVE READS (columns) BITE: the census reports document.supply_date when the document pin drops it (the D162 x D164 HIGH)', () => {
  const withoutSupplyDate = (verb) => {
    const m = pinnedColumnsFor(verb);
    m.get('document')?.delete('supply_date');
    return m;
  };
  const problems = columnCensus(UNPINNED_COLUMNS, withoutSupplyDate);
  assert.ok(problems.get('document.supply_date')?.includes('issue_invoice'), JSON.stringify([...problems]));
  assert.equal(pinnedColumnsFor('issue_invoice').get('document')?.has('supply_date'), true, 'the live pin digests it');
});

test('every UNPINNED_COLUMNS entry names a real column, and carries a reason', () => {
  const fx = fixture();
  const db = fx.deps.store.db;
  const problems = [];
  try {
    for (const [table, columns] of Object.entries(UNPINNED_COLUMNS)) {
      const real = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((r) => r.name));
      if (real.size === 0) problems.push(`${table}: no such table`);
      for (const [column, why] of Object.entries(columns)) {
        if (!real.has(column)) problems.push(`${table}.${column}: no such column`);
        if (typeof why !== 'string' || why.length < 20) problems.push(`${table}.${column}: no real why`);
      }
    }
  } finally {
    fx.deps.store.close();
  }
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

// --- D165: a crash between the committed act and the status flip (independent critic C, 13.10.2026) -------
//
// Approving replays the verb (its own transaction) and then flips the row to `executed` (a second write).
// A process death between the two leaves the row pending while the act committed. The re-approve must
// settle it: replay idempotently and end `executed` with the result and the trace backlink. Until D165
// the check asked whether the verb had memoised under (stored key, approved verb), but many verbs file
// their record under another verb's name or a derived key (issue_invoice under transition_document with
// [invoiceId, key], inventory_valuation_post under an _internal scope, gl_archive_import under migstep_),
// so a committed act that moved its own pin was voided as `stale`: "never executed" on a posted entry.
// The census below drives every pinned verb through that crash and asserts the row settles.

/**
 * A PROCESS DEATH, simulated on the store. Once `dead` is set, every `prepare` and every new store
 * transaction throws, as nothing runs in a process that is gone (statements prepared and cached before
 * the death still run; the critic's probes had the same limit). Two moments:
 *  - `flip`: the approval's status flip, i.e. after the whole act;
 *  - `mid`: right after the FIRST outermost transaction of the replay whose commit mark says the act
 *    RAN, i.e. after the first step of an act that commits step by step (D165 round 2, critic finding 1);
 *  - a number N: right after the Nth transaction that stamped the mark at all, a refusal's own
 *    bookkeeping included (the round-2 critic's sweep SW). In this mode the
 *    email transport is dead too: a send after the death throws, as no mail leaves a process that is
 *    gone. `Infinity` never dies and only counts (`marks`).
 */
function withDeath(/** @type {Fx} */ fx, /** @type {'flip' | 'mid' | number} */ moment, /** @type {() => any} */ fn) {
  const store = /** @type {any} */ (fx.deps.store);
  const db = store.db;
  const original = { prepare: db.prepare, tx: store.tx, snapshotTx: store.snapshotTx };
  let dead = false;
  let flipReached = false;
  let markInThisTx = false;
  let ranInThisTx = false;
  let marks = 0;
  const relay = /** @type {any} */ (fx.deps).emailRelay;
  if (typeof moment === 'number' && relay !== undefined) {
    /** @type {any} */ (fx.deps).emailRelay = {
      ...relay,
      send: (/** @type {any} */ m) => {
        if (dead) die();
        return relay.send(m);
      },
    };
  }
  const die = () => {
    dead = true;
    throw new Error(`simulated process death (${moment})`);
  };
  db.prepare = function dying(/** @type {string} */ sql) {
    if (dead) die();
    if (/SET status = 'executed'/.test(sql) && /agent_action/.test(sql)) {
      flipReached = true;
      if (moment === 'flip') die();
    }
    if (/committed_pin = \?/.test(sql)) markInThisTx = true;
    if (/committed_at = COALESCE/.test(sql)) ranInThisTx = true;
    return original.prepare.call(this, sql);
  };
  for (const name of /** @type {const} */ (['tx', 'snapshotTx'])) {
    store[name] = function dyingTx(/** @type {() => any} */ body) {
      if (dead) die();
      const outermost = !db.inTransaction;
      if (outermost) {
        markInThisTx = false;
        ranInThisTx = false;
      }
      const result = original[name].call(this, body);
      if (outermost && ranInThisTx && moment === 'mid') dead = true; // committed; the process ends here
      if (outermost && markInThisTx) {
        marks += 1;
        if (marks === moment) dead = true;
      }
      return result;
    };
  }
  try {
    let result;
    try {
      result = fn();
    } catch (e) {
      if (!dead) throw e;
    }
    return { result, died: dead, beforeFlip: !flipReached, marks };
  } finally {
    db.prepare = original.prepare;
    store.tx = original.tx;
    store.snapshotTx = original.snapshotTx;
    /** @type {any} */ (fx.deps).emailRelay = relay;
  }
}

/** Row counts per business table: equal counts after a crash and a re-approve as after a clean approve. */
function businessCounts(/** @type {any} */ db) {
  const out = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    if (TRACE_AND_QUEUE.has(name)) continue;
    const n = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n;
    if (n > 0) out[name] = n;
  }
  return out;
}

/**
 * The shapes the census crashes, per verb: the conformance scenario as it is, and the pin shape where
 * one exists (the critic's probe ran the bare scenario: `vat_configure` on a book with no codes yet),
 * plus A1-1 (an explicit due date that equals the one the issue derives).
 * @type {{ name: string, verb: string, shape: (fx: Fx, base: Record<string, any>) => Record<string, any> }[]}
 */
const CRASH_CASES = [
  ...Object.keys(PIN_FOR_VERB)
    .filter((verb) => SCENARIO[verb] !== undefined)
    .sort()
    .flatMap((verb) => [
      { name: verb, verb, shape: (_fx, base) => base },
      ...(PIN_SHAPE[verb] !== undefined ? [{ name: `${verb} (pin shape)`, verb, shape: PIN_SHAPE[verb] }] : []),
    ]),
  {
    name: 'issue_invoice (A1-1: explicit due date equal to the derived one)',
    verb: 'issue_invoice',
    shape: (fx, base) => {
      const doc = fx.deps.store.db.prepare('SELECT contact_id FROM document WHERE id = ?').get(base.invoiceId);
      const today = fx.deps.clock.now().slice(0, 10);
      const dueDate = dueDateFor(agentCtx(fx), { contactId: doc.contact_id, documentDate: today });
      const set = fx.call('update_document', { documentId: base.invoiceId, patch: { dueDate } });
      assert.equal(set.ok, true, JSON.stringify(set));
      return base;
    },
  },
];

/** Propose a case as the agent seat over the REST seam (so the drafting call exists for the backlink). */
function proposeCase(/** @type {(typeof CRASH_CASES)[number]} */ c) {
  const fx = fixture();
  const input = { ...c.shape(fx, SCENARIO[c.verb](fx)), workspaceId: fx.workspaceId };
  if (typeof input.idempotencyKey !== 'string' && 'idempotencyKey' in (getAction(c.verb).inputSchema?.properties ?? {})) input.idempotencyKey = `crash-${c.verb}`;
  const drafted = /** @type {Body} */ (handleRest(c.verb, input, { ...fx.deps, actor: 'agent' }).body);
  return { fx, input, drafted };
}

/**
 * One census run: propose, die at `moment`, then (per `after`) leave everything as it is, change a
 * pinned record the way any ungoverned writer could (`changed`), or strip the commit mark as a row that
 * crashed under a build from before D165 would carry none (`unmarked`), and approve again.
 */
function crashRun(/** @type {(typeof CRASH_CASES)[number]} */ c, /** @type {'flip' | 'mid' | number} */ moment, /** @type {'none' | 'changed' | 'unmarked'} */ after, /** @type {any} */ clean = undefined) {
  const { name, verb } = c;
  const { fx, input, drafted } = proposeCase(c);
  try {
    if (drafted.drafted !== true) return { name, verb, outcome: 'not_drafted', detail: JSON.stringify(drafted).slice(0, 160) };
    const actionId = /** @type {string} */ (drafted.actionId);
    const before = businessDigest(fx.deps.store.db);
    const death = withDeath(fx, moment, () => approve(fx, actionId));
    if (!death.died) return { name, verb, outcome: 'act_refused', detail: JSON.stringify(death.result).slice(0, 160) };
    const afterCrash = businessDigest(fx.deps.store.db);
    // An act the death cut short leaves other row counts than a clean approve does.
    const incomplete = clean !== undefined && JSON.stringify(businessCounts(fx.deps.store.db)) !== JSON.stringify(clean);
    const crashRow = /** @type {any} */ (fx.deps.store.db.prepare('SELECT status, committed_at FROM agent_action WHERE id = ?').get(actionId));
    let changed;
    if (after === 'changed') {
      changed = mutatePrimary(fx, verb, input);
      if (changed === undefined) return { name, verb, outcome: 'unchangeable' };
    }
    if (after === 'unmarked') fx.deps.store.db.prepare('UPDATE agent_action SET committed_at = NULL, committed_pin = NULL WHERE id = ?').run(actionId);
    const beforeReapprove = businessDigest(fx.deps.store.db);
    const again = approve(fx, actionId);
    const afterReapprove = businessDigest(fx.deps.store.db);
    const row = /** @type {{ status: string, result_json: string | null }} */ (
      fx.deps.store.db.prepare('SELECT status, result_json FROM agent_action WHERE id = ?').get(actionId)
    );
    const call = /** @type {{ entity_ref: string | null, resolved_by: string | null } | undefined} */ (
      fx.deps.store.db.prepare('SELECT entity_ref, resolved_by FROM agent_call WHERE workspace_id = ? AND agent_action_id = ?').get(fx.workspaceId, actionId)
    );
    return {
      name,
      verb,
      outcome: again.ok === true && row.status === 'executed' ? 'settled' : again.error === 'vorschlag_stale' && row.status === 'stale' ? 'stale' : 'other',
      detail: again.ok === true ? row.status : `${again.error} (${row.status})`,
      midAct: moment !== 'flip' && incomplete,
      sends: sendsOf(fx),
      actCommitted: afterCrash !== before,
      pendingAndMarkedAfterCrash: crashRow.status === 'pending' && (afterCrash === before || crashRow.committed_at !== null),
      reapproveWroteNothing: afterReapprove === beforeReapprove,
      counts: businessCounts(fx.deps.store.db),
      result: again.ok === true ? again : undefined,
      storedResult: row.result_json,
      call,
      changed,
    };
  } finally {
    fx.deps.store.close();
  }
}

/** The mails the scenario's recording transport has handed over so far (undefined without one). */
function sendsOf(/** @type {Fx} */ fx) {
  const relay = /** @type {any} */ (fx.deps).emailRelay;
  return Array.isArray(relay?.sent) ? relay.sent.length : undefined;
}

/** The same case approved with no crash: the row counts, the marked transactions and the mails. */
function cleanRun(/** @type {(typeof CRASH_CASES)[number]} */ c) {
  const { fx, drafted } = proposeCase(c);
  try {
    if (drafted.drafted !== true) return undefined;
    const run = withDeath(fx, Infinity, () => approve(fx, /** @type {string} */ (drafted.actionId)));
    return run.result?.ok === true ? { counts: businessCounts(fx.deps.store.db), marks: run.marks, sends: sendsOf(fx) } : undefined;
  } finally {
    fx.deps.store.close();
  }
}

/** The same case approved with no crash: the row counts a completed act leaves. */
function cleanCounts(/** @type {(typeof CRASH_CASES)[number]} */ c) {
  const { fx, drafted } = proposeCase(c);
  try {
    if (drafted.drafted !== true) return undefined;
    const done = approve(fx, /** @type {string} */ (drafted.actionId));
    return done.ok === true ? businessCounts(fx.deps.store.db) : undefined;
  } finally {
    fx.deps.store.close();
  }
}

function settledProblems(/** @type {any} */ r) {
  const problems = [];
  if (r.storedResult === null) problems.push(`${r.name}: no stored result`);
  if (r.call === undefined || r.call.resolved_by === null) problems.push(`${r.name}: the drafting call has no backlink`);
  const ref = entityRefOf(r.result.result);
  if (r.call !== undefined && ref !== undefined && r.call.entity_ref !== ref) problems.push(`${r.name}: backlink ${r.call.entity_ref} is not the result's ${ref}`);
  return problems;
}

test('D165 CRASH CENSUS: a death after the act settles `executed` with result and backlink; nothing is written twice', () => {
  const rows = CRASH_CASES.map((c) => crashRun(c, 'flip', 'none'));
  const crashed = rows.filter((r) => r.outcome === 'settled' || r.outcome === 'stale' || r.outcome === 'other');
  const notSettled = crashed.filter((r) => r.outcome !== 'settled').map((r) => `${r.name}: ${r.detail}`);
  console.log(`CRASH CENSUS (flip): ${rows.length} cases over ${new Set(rows.map((r) => r.verb)).size} pinned verbs, ${crashed.length} died after their act, ${crashed.length - notSettled.length} settled`);
  for (const r of rows.filter((x) => !crashed.includes(x))) console.log(`  not reached: ${r.name} ${r.outcome} ${r.detail}`);
  if (notSettled.length > 0) console.log(`NOT SETTLED\n${notSettled.join('\n')}`);
  const problems = [];
  for (const r of crashed) {
    if (!r.pendingAndMarkedAfterCrash) problems.push(`${r.name}: the death did not leave the row pending and marked`);
    if (r.outcome !== 'settled') continue;
    if (!r.reapproveWroteNothing) problems.push(`${r.name}: the re-approve wrote business rows a second time`);
    problems.push(...settledProblems(r));
  }
  assert.ok(crashed.length >= 60, `the census reaches the crash window for the pinned verbs (got ${crashed.length})`);
  // The undo verbs added after D165 are named, so a lost pin or scenario cannot drop them out of the
  // census unnoticed (the D141.3 follow-up: D168 expense_claim_reverse, D169 dunning_fee_reverse,
  // D170 asset_transaction_reverse).
  for (const verb of ['expense_claim_reverse', 'dunning_fee_reverse', 'asset_transaction_reverse']) {
    assert.equal(rows.find((r) => r.verb === verb)?.outcome, 'settled', `${verb} reaches the crash window and settles`);
  }
  assert.deepEqual([...notSettled, ...problems], []);
});

test('D165 CRASH CENSUS (mid-act, critic finding 1): a death after the FIRST committed step settles to exactly what a clean approve leaves', () => {
  const rows = CRASH_CASES.map((c) => {
    const clean = cleanCounts(c);
    return { ...crashRun(c, 'mid', 'none', clean), clean };
  });
  const crashed = rows.filter((r) => r.outcome === 'settled' || r.outcome === 'stale' || r.outcome === 'other');
  const midAct = crashed.filter((r) => r.midAct);
  console.log(`CRASH CENSUS (mid): ${crashed.length} died after their first committed step, ${midAct.length} of them with the act cut short (${midAct.map((r) => r.name).join(', ')}), ${crashed.filter((r) => r.outcome === 'settled').length} settled`);
  const problems = [];
  for (const r of crashed) {
    // send_invoice's own design: a death after its 'dispatching' attempt and before the transport
    // answered cannot tell whether the mail left, so it answers send_outcome_unknown and keeps the row
    // pending for a person to check, never sending twice (A10 M18). Not a settle, and not a defect.
    if (r.verb === 'send_invoice' && r.detail === 'send_outcome_unknown (pending)') continue;
    if (r.outcome !== 'settled') {
      problems.push(`${r.name}: ${r.detail}`);
      continue;
    }
    problems.push(...settledProblems(r));
    // A dunning letter whose death fell after its transport answers that debtor send_outcome_unknown
    // and never sends it twice (A15, the dispatching marker): no `sent` log row, by design.
    if (/** @type {any} */ (r.result).result?.outcomes?.some((o) => o.outcome === 'send_outcome_unknown')) continue;
    if (r.clean !== undefined && JSON.stringify(r.counts) !== JSON.stringify(r.clean)) problems.push(`${r.name}: rows ${JSON.stringify(r.counts)} differ from a clean approve's ${JSON.stringify(r.clean)}`);
  }
  assert.ok(crashed.length >= 60, `the mid-act census reaches the window (got ${crashed.length})`);
  assert.deepEqual(problems, []);
});

test('D165 CRASH CENSUS (changed, critic finding 1): after a death at either moment, a pinned record changed by somebody else voids the row and the rest of the act never runs', () => {
  const problems = [];
  let reached = 0;
  for (const moment of /** @type {const} */ (['flip', 'mid'])) {
    for (const c of CRASH_CASES) {
      const r = crashRun(c, moment, 'changed', moment === 'mid' ? cleanCounts(c) : undefined);
      if (r.outcome !== 'settled' && r.outcome !== 'stale' && r.outcome !== 'other') continue;
      reached += 1;
      // The person's approval must not run anything on the changed record: the re-approve writes
      // nothing. It may settle only by replaying a completed act (the verb's own memo), which writes
      // nothing either.
      if (!r.reapproveWroteNothing) problems.push(`${moment} ${r.name}: the re-approve wrote after ${r.changed} changed (${r.detail})`);
      if (r.outcome === 'other' && !(r.verb === 'send_invoice' && r.detail === 'send_outcome_unknown (pending)')) problems.push(`${moment} ${r.name}: ${r.detail}`);
      if (r.midAct && r.outcome !== 'stale') problems.push(`${moment} ${r.name}: a half-run act settled over ${r.changed}`);
    }
  }
  console.log(`CRASH CENSUS (changed): ${reached} runs reached the window with a changed record`);
  assert.ok(reached >= 100, `reached ${reached}`);
  assert.deepEqual(problems, []);
});

test('D165 CRASH SWEEP (r2 finding 2): a death after EVERY marked transaction of a multi-step act settles to what a clean approve leaves, and a change after it voids the rest', () => {
  // The mid census dies after the FIRST marked transaction only. An act that commits in several
  // (a dunning send, a mailed invoice, a migration step) can die after any of them, and the round-2
  // critic's sweep SW found the one that lost a row there (a dunning letter's `sent_at` and its G05
  // `sent` log row were two transactions). Here every such act dies after each transaction that stamped
  // the mark (a refusal's own bookkeeping, which stamps the pin but not `committed_at`, included), with
  // the transport dead too; then it is approved again as it is
  // (it must settle to a clean approve's rows, never mailing more than a clean approve does), or after
  // somebody else changed a pinned record (it must write nothing and send nothing, and a death before
  // the last transaction must void the row).
  const problems = [];
  const split = [];
  let reached = 0;
  for (const c of CRASH_CASES) {
    const clean = cleanRun(c);
    if (clean === undefined || clean.marks < 2) continue;
    split.push(`${c.name} (${clean.marks})`);
    for (let k = 1; k <= clean.marks; k += 1) {
      for (const after of /** @type {const} */ (['none', 'changed'])) {
        const r = crashRun(c, k, after, clean.counts);
        if (r.outcome !== 'settled' && r.outcome !== 'stale' && r.outcome !== 'other') {
          problems.push(`${c.name} death ${k}/${clean.marks} ${after}: never reached the window (${r.outcome} ${r.detail ?? ''})`);
          continue;
        }
        reached += 1;
        const at = `${c.name} death ${k}/${clean.marks} ${after}`;
        if (r.sends !== undefined && clean.sends !== undefined && r.sends > clean.sends) problems.push(`${at}: ${r.sends} mails, a clean approve sends ${clean.sends}`);
        // A death after the transport was reached and before it answered is unknown by design (A10 M18,
        // A15's dispatching marker): never sent twice, not a settle and not a defect.
        const unknown =
          (r.verb === 'send_invoice' && r.detail === 'send_outcome_unknown (pending)') ||
          /** @type {any} */ (r.result)?.result?.outcomes?.some((/** @type {any} */ o) => o.outcome === 'send_outcome_unknown') === true;
        if (after === 'none') {
          if (r.outcome !== 'settled' && !unknown) problems.push(`${at}: ${r.detail}`);
          else if (r.outcome === 'settled') {
            problems.push(...settledProblems(r).map((p) => `${at}: ${p}`));
            if (!unknown && JSON.stringify(r.counts) !== JSON.stringify(clean.counts)) problems.push(`${at}: rows ${JSON.stringify(r.counts)} differ from a clean approve's ${JSON.stringify(clean.counts)}`);
          }
        } else {
          if (!r.reapproveWroteNothing) problems.push(`${at}: the re-approve wrote after ${r.changed} changed (${r.detail})`);
          if (k < clean.marks && r.outcome === 'settled') problems.push(`${at}: a half-run act settled over ${r.changed}`);
          if (r.outcome === 'other' && !unknown) problems.push(`${at}: ${r.detail}`);
        }
      }
    }
  }
  console.log(`CRASH SWEEP: acts with more than one marked transaction: ${split.join(', ')}; ${reached} runs reached the window`);
  assert.ok(split.some((s) => s.startsWith('send_dunning_run')), 'the sweep reaches the dunning send');
  assert.ok(reached >= 10, `reached ${reached}`);
  assert.deepEqual(problems, []);
});

test('D165 CRASH CENSUS (unmarked, critic finding 3): a row that crashed under a pre-D165 build settles at least as often as on develop, through the verb\'s own completed memo', () => {
  const rows = CRASH_CASES.map((c) => crashRun(c, 'flip', 'unmarked'));
  const crashed = rows.filter((r) => r.outcome === 'settled' || r.outcome === 'stale' || r.outcome === 'other');
  const settled = crashed.filter((r) => r.outcome === 'settled');
  console.log(`CRASH CENSUS (unmarked): ${crashed.length} died after their act, ${settled.length} settled without a mark; not settled: ${crashed.filter((r) => r.outcome !== 'settled').map((r) => r.name).join(', ')}`);
  const problems = crashed.filter((r) => !r.reapproveWroteNothing).map((r) => `${r.name}: the re-approve wrote business rows a second time`);
  for (const verb of ['delivery_note_issue', 'goods_receipt_post', 'goods_receipt_accept_lines', 'migration_commit_step', 'po_amendment_apply', 'requisition_approve', 'time_lock']) {
    const r = crashed.find((x) => x.name === verb);
    if (r !== undefined && r.outcome !== 'settled') problems.push(`${verb}: settled on develop 36c2d3e0, ${r.detail} here`);
  }
  assert.ok(settled.length >= 62, `develop 36c2d3e0 settled 62 unmarked; got ${settled.length}`);
  assert.deepEqual(problems, []);
});

test('D165: a refused replay leaves no commit mark, so a later approval still faces the pin', () => {
  // A refusal that COMMITS a write before it answers (critic finding 6: the locked-period refusal wrote
  // nothing, so it passed with the refusal-clear deleted): send_invoice with no relay configured logs
  // a degraded dispatch row and refuses needs_email_config. The row the refusal marked is unmarked.
  const fx = fixture();
  const { confirmed: _c, email: _e, ...input } = SCENARIO.send_invoice(fx);
  const relay = fx.deps.emailRelay;
  fx.deps.emailRelay = undefined;
  const agent = { ...fx.deps, actor: 'agent' };
  const drafted = /** @type {Body} */ (handleRest('send_invoice', input, agent).body);
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  const actionId = /** @type {string} */ (drafted.actionId);
  const logs = () => /** @type {any} */ (fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM dispatches').get()).n;
  const logsBefore = logs();
  const refused = approve(fx, actionId);
  assert.equal(refused.error, 'needs_email_config', JSON.stringify(refused).slice(0, 200));
  assert.equal(logs(), logsBefore + 1, 'the refusal committed its degraded log row (the premise)');
  const after = /** @type {any} */ (fx.deps.store.db.prepare('SELECT status, committed_at, committed_pin, pin_digest FROM agent_action WHERE id = ?').get(actionId));
  assert.equal(after.status, 'pending');
  assert.equal(after.committed_at, null, 'a refusal that wrote only its own log says the act never ran');
  // The log row is the act's own bookkeeping: the pin it left (unchanged) is stamped, nothing more.
  assert.ok(after.committed_pin === null || after.committed_pin === after.pin_digest, `the stamp is the approved pin: ${after.committed_pin}`);
  const contactId = fx.deps.store.db.prepare('SELECT contact_id FROM document WHERE id = ?').get(input.invoiceId).contact_id;
  const changed = /** @type {Body} */ (handleRest('update_contact', { workspaceId: fx.workspaceId, contactId, patch: { email: 'drop@attacker.example' } }, agent).body);
  assert.equal(changed.ok, true, JSON.stringify(changed));
  fx.deps.emailRelay = relay;
  const decided = approve(fx, actionId);
  assert.equal(decided.error, 'vorschlag_stale', JSON.stringify(decided).slice(0, 300));
  fx.deps.store.close();
});

test('D165: the commit mark is written inside the act\'s transaction and rolls back with it', () => {
  const fx = fixture();
  const store = fx.deps.store;
  const db = store.db;
  db.exec('CREATE TABLE d165_probe (n INTEGER)');
  let marks = 0;
  const mark = () => {
    marks += 1;
    db.prepare('INSERT INTO d165_probe (n) VALUES (-1)').run();
  };
  const count = (/** @type {number} */ n) => /** @type {{ c: number }} */ (db.prepare('SELECT COUNT(*) AS c FROM d165_probe WHERE n = ?').get(n)).c;
  // A transaction that writes and commits: the mark commits with it.
  store.withCommitMark(mark, () => store.tx(() => db.prepare('INSERT INTO d165_probe (n) VALUES (1)').run()));
  assert.equal(count(-1), 1);
  // A bare write is wrapped by the chokepoint, so it is marked too.
  store.withCommitMark(mark, () => db.prepare('INSERT INTO d165_probe (n) VALUES (2)').run());
  assert.equal(count(-1), 2);
  // A transaction that throws: neither its write nor its mark survives.
  assert.throws(() => store.withCommitMark(mark, () => store.tx(() => {
    db.prepare('INSERT INTO d165_probe (n) VALUES (3)').run();
    throw new Error('abort');
  })));
  assert.equal(count(3), 0);
  assert.equal(count(-1), 2, 'the mark rolled back with the act');
  // A transaction that writes nothing is not marked, and nothing is marked once the call returns.
  const before = marks;
  store.withCommitMark(mark, () => store.tx(() => db.prepare('SELECT 1').get()));
  db.prepare('INSERT INTO d165_probe (n) VALUES (4)').run();
  assert.equal(marks, before);
  store.close();
});

test('D165: a send whose relay fails is unmarked again, so a recipient rewritten before the retry voids it', () => {
  const fx = fixture();
  const { confirmed: _c, email: _e, ...input } = SCENARIO.send_invoice(fx);
  // After the scenario, which wires its own recording relay.
  const box = [];
  let relayUp = false;
  fx.deps.emailRelay = {
    send: (m) => {
      if (!relayUp) return { ok: false, reason: 'relay_unavailable' };
      box.push(m.to);
      return { ok: true };
    },
  };
  const agent = { ...fx.deps, actor: 'agent' };
  const drafted = /** @type {Body} */ (handleRest('send_invoice', input, agent).body);
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  const actionId = /** @type {string} */ (drafted.actionId);
  const failed = approve(fx, actionId);
  assert.equal(failed.ok, false, `the relay is down: ${JSON.stringify(failed).slice(0, 200)}`);
  assert.equal(rowOf(fx, actionId).status, 'pending');
  assert.equal(/** @type {any} */ (fx.deps.store.db.prepare('SELECT committed_at FROM agent_action WHERE id = ?').get(actionId)).committed_at, null);
  const contactId = fx.deps.store.db.prepare('SELECT contact_id FROM document WHERE id = ?').get(input.invoiceId).contact_id;
  const changed = /** @type {Body} */ (handleRest('update_contact', { workspaceId: fx.workspaceId, contactId, patch: { email: 'drop@attacker.example' } }, agent).body);
  assert.equal(changed.ok, true, JSON.stringify(changed));
  relayUp = true;
  const decided = approve(fx, actionId);
  assert.equal(decided.error, 'vorschlag_stale', JSON.stringify(decided).slice(0, 300));
  assert.deepEqual(box, [], 'nothing was sent to the rewritten address');
  fx.deps.store.close();
});

test('D165: after a crash, the agent proposing the same key again is answered with the committed row, which then settles', () => {
  // vat_configure on a book with no codes: its own act moves its pin (it seeds the codes), which is
  // what made the same-key re-proposal void the committed row before the commit mark.
  const fx = fixture();
  const input = SCENARIO.vat_configure(fx);
  const agent = { ...fx.deps, actor: 'agent' };
  const drafted = /** @type {Body} */ (handleRest('vat_configure', input, agent).body);
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  const actionId = /** @type {string} */ (drafted.actionId);
  const death = withDeath(fx, 'flip', () => approve(fx, actionId));
  assert.equal(death.died, true, 'the act committed before the death');
  const listed = /** @type {any} */ (getAction('list_drafted_actions').run({ ...fx.deps, actor: 'studio' }, { workspaceId: fx.workspaceId })).actions.find((a) => a.actionId === actionId);
  assert.equal(listed.changedSinceProposal, false, 'the card does not call the committed act\'s own change a change');
  assert.equal(typeof listed.committedAt, 'string', 'the card says the act already ran');
  const again = /** @type {Body} */ (handleRest('vat_configure', input, agent).body);
  assert.equal(again.actionId, actionId, `the same row answers: ${JSON.stringify(again)}`);
  assert.equal(rowOf(fx, actionId).status, 'pending', 'never voided over a committed act');
  const settled = approve(fx, actionId);
  assert.equal(settled.ok, true, JSON.stringify(settled).slice(0, 300));
  assert.equal(rowOf(fx, actionId).status, 'executed');
  fx.deps.store.close();
});

/** Two overdue debtors with an issued dunning run (synthetic by construction), as the critic's probe D. */
function twoDebtorRun(/** @type {Fx} */ fx) {
  return debtorRun(fx, ['a@debtor.example', 'b@debtor.example']);
}

/** One overdue debtor per email, with an issued dunning run (synthetic by construction). */
function debtorRun(/** @type {Fx} */ fx, /** @type {string[]} */ emails) {
  fx.call('vat_seed_defaults', {});
  fx.call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  fx.call('set_creditor_profile', {
    creditorName: 'Conformance GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });
  const debtors = [];
  for (const [i, email] of emails.entries()) {
    const c = /** @type {any} */ (fx.call('create_contact', {
      partyRole: 'customer',
      name: `Schuldner ${i + 1} AG`,
      address: { street: 'Musterstrasse', houseNo: `${i + 1}`, zip: '3000', city: 'Bern', country: 'CH' },
      email,
      idempotencyKey: `d-contact-${i}`,
    }));
    const doc = /** @type {any} */ (fx.call('create_document', {
      type: 'invoice', contactId: c.contact.id, currency: 'CHF', dueDate: '2026-06-01',
      lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }], idempotencyKey: `d-doc-${i}`,
    }));
    fx.call('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: `d-issue-${i}` });
    debtors.push(c.contact.id);
  }
  const proposed = /** @type {any} */ (fx.call('propose_dunning_run', { idempotencyKey: 'd-propose' }));
  const issued = /** @type {any} */ (fx.call('issue_dunning_run', { runId: proposed.runId, confirmed: true, idempotencyKey: 'd-issue' }));
  assert.equal(issued.ok, true, JSON.stringify(issued).slice(0, 200));
  return { runId: proposed.runId, debtors };
}

test('D165 PROBE D (critic finding 1): a dunning send that died after the first debtor never sends the second to an address rewritten after the death', () => {
  const fx = fixture();
  const { runId, debtors } = twoDebtorRun(fx);
  const box = [];
  fx.deps.emailRelay = { send: (m) => { box.push(m.to); return { ok: true }; } };
  const agent = { ...fx.deps, actor: 'agent' };
  const drafted = /** @type {Body} */ (handleRest('send_dunning_run', { workspaceId: fx.workspaceId, runId, confirmed: true, idempotencyKey: 'd-send' }, agent).body);
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  const actionId = /** @type {string} */ (drafted.actionId);
  const death = withDeath(fx, 'mid', () => approve(fx, actionId));
  assert.equal(death.died, true);
  assert.equal(death.beforeFlip, true, 'the death fell inside the act');
  assert.equal(box.length, 1, `one letter left before the death: ${JSON.stringify(box)}`);
  const first = box[0];
  const other = debtors.find((d) => fx.deps.store.db.prepare('SELECT email FROM contact WHERE id = ?').get(d).email !== first);
  const changed = /** @type {Body} */ (handleRest('update_contact', { workspaceId: fx.workspaceId, contactId: other, patch: { email: 'drop@attacker.example' } }, agent).body);
  assert.equal(changed.ok, true, JSON.stringify(changed));
  const card = /** @type {any} */ (getAction('list_drafted_actions').run({ ...fx.deps, actor: 'studio' }, { workspaceId: fx.workspaceId })).actions.find((a) => a.actionId === actionId);
  assert.equal(card.changedSinceProposal, true, 'the card shows the change');
  assert.equal(typeof card.committedAt, 'string', 'and that the act already ran in part');
  const decided = approve(fx, actionId);
  assert.equal(decided.error, 'vorschlag_stale', JSON.stringify(decided).slice(0, 300));
  assert.deepEqual(box, [first], 'nothing went to the rewritten address');
  const row = /** @type {any} */ (fx.deps.store.db.prepare('SELECT status, committed_at FROM agent_action WHERE id = ?').get(actionId));
  assert.equal(row.status, 'stale');
  assert.equal(typeof row.committed_at, 'string', 'the record keeps that the act ran in part');
  fx.deps.store.close();
});

test('D165 PROBE D (control): the same death with nothing changed completes the run on re-approve, each letter once', () => {
  const fx = fixture();
  const { runId } = twoDebtorRun(fx);
  const box = [];
  fx.deps.emailRelay = { send: (m) => { box.push(m.to); return { ok: true }; } };
  const drafted = /** @type {Body} */ (handleRest('send_dunning_run', { workspaceId: fx.workspaceId, runId, confirmed: true, idempotencyKey: 'd-send' }, { ...fx.deps, actor: 'agent' }).body);
  const actionId = /** @type {string} */ (drafted.actionId);
  const death = withDeath(fx, 'mid', () => approve(fx, actionId));
  assert.equal(death.beforeFlip, true);
  const settled = approve(fx, actionId);
  assert.equal(settled.ok, true, JSON.stringify(settled).slice(0, 300));
  assert.deepEqual([...box].sort(), ['a@debtor.example', 'b@debtor.example']);
  assert.equal(rowOf(fx, actionId).status, 'executed');
  fx.deps.store.close();
});

test('D165 PROBE S (critic finding 2): a send reconciled after a death records the address the mail left for, not a rewrite since', () => {
  const fx = fixture();
  const { confirmed: _c, email: _e, ...input } = SCENARIO.send_invoice(fx);
  const box = [];
  fx.deps.emailRelay = { send: (m) => { box.push(m.to); return { ok: true }; } };
  const human = { ...fx.deps, actor: 'studio' };
  const body = { ...input, workspaceId: fx.workspaceId, confirmed: true, idempotencyKey: 's-1' };
  const contactId = fx.deps.store.db.prepare('SELECT contact_id FROM document WHERE id = ?').get(input.invoiceId).contact_id;
  const original = fx.deps.store.db.prepare('SELECT email FROM contact WHERE id = ?').get(contactId).email;
  // The death falls on the first statement of the post-send records: the mail left, the attempt says so.
  const db = /** @type {any} */ (fx.deps.store.db);
  const prepare = db.prepare;
  let dead = false;
  db.prepare = function dying(/** @type {string} */ sql) {
    if (dead || /UPDATE document SET sent_to_email/.test(sql)) {
      dead = true;
      throw new Error('simulated process death after the transport');
    }
    return prepare.call(this, sql);
  };
  try {
    getAction('send_invoice').run(human, body);
  } catch {
    // the process is gone
  } finally {
    db.prepare = prepare;
  }
  assert.deepEqual(box, [original]);
  const rewrite = /** @type {Body} */ (getAction('update_contact').run(human, { workspaceId: fx.workspaceId, contactId, patch: { email: 'drop@attacker.example' } }));
  assert.equal(rewrite.ok, true, JSON.stringify(rewrite));
  const retried = /** @type {Body} */ (getAction('send_invoice').run(human, body));
  assert.equal(retried.ok, true, JSON.stringify(retried).slice(0, 300));
  assert.deepEqual(box, [original], 'the reconcile sends nothing again');
  assert.equal(fx.deps.store.db.prepare('SELECT sent_to_email FROM document WHERE id = ?').get(input.invoiceId).sent_to_email, original);
  fx.deps.store.close();
});

test('D165 (critic finding 4): a row whose act committed before a death cannot be recorded as rejected', () => {
  const fx = fixture();
  const input = SCENARIO.vat_configure(fx);
  const agent = { ...fx.deps, actor: 'agent' };
  const drafted = /** @type {Body} */ (handleRest('vat_configure', input, agent).body);
  const actionId = /** @type {string} */ (drafted.actionId);
  assert.equal(withDeath(fx, 'flip', () => approve(fx, actionId)).died, true);
  const rejected = /** @type {Body} */ (getAction('reject_drafted_action').run({ ...fx.deps, actor: 'studio' }, { workspaceId: fx.workspaceId, actionId }));
  assert.equal(rejected.error, 'already_executed', JSON.stringify(rejected));
  assert.equal(rowOf(fx, actionId).status, 'pending');
  const again = /** @type {Body} */ (handleRest('vat_configure', input, agent).body);
  assert.equal(again.actionId, actionId);
  assert.equal(again.status, 'pending');
  assert.equal(approve(fx, actionId).ok, true);
  assert.equal(rowOf(fx, actionId).status, 'executed');
  fx.deps.store.close();
});

// --- D165 follow-ups (independent critic, round 2, 13.10.2026) ----------------------------------------

test('D165 PROBE TR (r2 finding 1): a dunning send that throws after a letter left keeps its mark, so it cannot be recorded as rejected', () => {
  const fx = fixture();
  const { runId } = debtorRun(fx, ['a@debtor.example', 'b@debtor.example', 'c@debtor.example']);
  const box = [];
  let calls = 0;
  let hangUp = true;
  fx.deps.emailRelay = {
    send: (/** @type {{ to: string }} */ m) => {
      calls += 1;
      // A socket hang-up on the second letter: the transport throws instead of answering.
      if (hangUp && calls === 2) throw new Error('socket hang up');
      box.push(m.to);
      return { ok: true };
    },
  };
  const drafted = /** @type {Body} */ (handleRest('send_dunning_run', { workspaceId: fx.workspaceId, runId, confirmed: true, idempotencyKey: 'tr-send' }, { ...fx.deps, actor: 'agent' }).body);
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  const actionId = /** @type {string} */ (drafted.actionId);
  const failed = approve(fx, actionId);
  assert.equal(failed.error, 'unexpected_error', JSON.stringify(failed).slice(0, 300));
  assert.equal(failed.partial, true, 'the registry says the call wrote before it threw (the premise)');
  assert.deepEqual(box, ['a@debtor.example'], 'the first letter left before the throw');
  const row = /** @type {any} */ (fx.deps.store.db.prepare('SELECT status, committed_at, committed_pin FROM agent_action WHERE id = ?').get(actionId));
  assert.equal(row.status, 'pending');
  assert.equal(typeof row.committed_at, 'string', 'the act ran in part: the mark stays');
  const card = /** @type {any} */ (getAction('list_drafted_actions').run({ ...fx.deps, actor: 'studio' }, { workspaceId: fx.workspaceId })).actions.find((a) => a.actionId === actionId);
  assert.equal(typeof card.committedAt, 'string', 'the card says the act already ran in part');
  const rejected = /** @type {Body} */ (getAction('reject_drafted_action').run({ ...fx.deps, actor: 'studio' }, { workspaceId: fx.workspaceId, actionId }));
  assert.equal(rejected.error, 'already_executed', `never recorded as rejected over a letter that left: ${JSON.stringify(rejected)}`);
  assert.equal(rowOf(fx, actionId).status, 'pending');
  // The transport recovers: the re-approve completes the run on the approved records, each letter at
  // most once (the debtor whose transport threw stays send_outcome_unknown, A15's dispatching marker).
  hangUp = false;
  const done = approve(fx, actionId);
  assert.equal(done.ok, true, JSON.stringify(done).slice(0, 300));
  assert.deepEqual(box, ['a@debtor.example', 'c@debtor.example']);
  assert.equal(rowOf(fx, actionId).status, 'executed');
  fx.deps.store.close();
});

/**
 * Two processes on one book (D12): two `SqliteStore` connections on one file. A is the process whose
 * approval commits the act and dies; B is the other one, which read the row before A's commit landed.
 * B's ids carry their own prefix, as two processes never share an id sequence.
 */
function twoConnections() {
  const dir = mkdtempSync(join(tmpdir(), 'd165-cas-'));
  const location = join(dir, 'book.db');
  const clock = fixedClock(AT);
  const a = { store: new SqliteStore({ location, clock }), clock, ids: sequenceIdGen(), actor: 'agent' };
  const { workspaceId } = mintWorkspace(a);
  const fxA = /** @type {Fx} */ (/** @type {unknown} */ ({ deps: a, workspaceId, call: (/** @type {string} */ name, /** @type {any} */ input) => getAction(name).run(a, { workspaceId, ...input }) }));
  const bIds = sequenceIdGen();
  const b = { store: new SqliteStore({ location, clock }), clock, ids: { next: (/** @type {string} */ p) => `b${bIds.next(p)}` }, actor: 'studio' };
  const fxB = /** @type {Fx} */ (/** @type {unknown} */ ({ deps: b, workspaceId, call: (/** @type {string} */ name, /** @type {any} */ input) => getAction(name).run(b, { workspaceId, ...input }) }));
  return {
    fxA,
    fxB,
    close() {
      a.store.close();
      b.store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * On B's connection, the first statement matching `pattern` reads its row(s) and THEN, before B sees the
 * answer, runs `meanwhile` (A's approval, dying at its flip): B judges a row A has since committed.
 */
function interleaveOnRead(/** @type {Fx} */ fxB, /** @type {RegExp} */ pattern, /** @type {() => void} */ meanwhile) {
  const db = /** @type {any} */ (fxB.deps.store.db);
  const prepare = db.prepare;
  let fired = false;
  db.prepare = function interleaving(/** @type {string} */ sql) {
    const stmt = prepare.call(this, sql);
    if (fired || !pattern.test(sql)) return stmt;
    return {
      get: (/** @type {unknown[]} */ ...args) => {
        const row = stmt.get(...args);
        fired = true;
        meanwhile();
        return row;
      },
    };
  };
  return () => {
    db.prepare = prepare;
    return fired;
  };
}

test('D165 PROBE CAS (r2 finding 4): an approval whose void loses the race to a committed act answers from the row, never vorschlag_stale over it', () => {
  // vat_configure on a book with no codes: its act moves its own pin, and it has no completed memo
  // under (stored key, verb), so only the mark tells B that the act committed.
  const { fxA, fxB, close } = twoConnections();
  try {
    const input = SCENARIO.vat_configure(fxA);
    const drafted = /** @type {Body} */ (handleRest('vat_configure', input, { ...fxA.deps, actor: 'agent' }).body);
    assert.equal(drafted.drafted, true, JSON.stringify(drafted));
    const actionId = /** @type {string} */ (drafted.actionId);
    let died = false;
    const restore = interleaveOnRead(fxB, /^SELECT \* FROM agent_action WHERE workspace_id = \? AND id = \?$/, () => {
      died = withDeath(fxA, 'flip', () => approve(fxA, actionId)).died;
    });
    let answer;
    try {
      answer = approve(fxB, actionId);
    } finally {
      assert.equal(restore(), true, 'B read the row before A committed (the premise)');
    }
    assert.equal(died, true, 'A committed the act and died before its flip (the premise)');
    const row = /** @type {any} */ (fxB.deps.store.db.prepare('SELECT status, committed_at FROM agent_action WHERE id = ?').get(actionId));
    assert.notEqual(answer.error, 'vorschlag_stale', `B never calls a committed act void: ${JSON.stringify(answer).slice(0, 300)}`);
    assert.equal(answer.ok, true, JSON.stringify(answer).slice(0, 300));
    assert.equal(row.status, 'executed', 'B completed the approval on the act A committed');
    assert.equal(typeof row.committed_at, 'string');
  } finally {
    close();
  }
});

test('D165 PROBE CAS (r2 finding 4): a same-key re-proposal whose void loses the race never mints a second pending row', () => {
  // The draft seam enqueues inside an IMMEDIATE transaction, so through it the other process cannot
  // commit between this read and the void (A would wait out the busy timeout). The engine seam itself
  // must still hold when called outside one: driven directly here.
  const { fxA, fxB, close } = twoConnections();
  try {
    const input = SCENARIO.vat_configure(fxA);
    const drafted = /** @type {Body} */ (handleRest('vat_configure', input, { ...fxA.deps, actor: 'agent' }).body);
    assert.equal(drafted.drafted, true, JSON.stringify(drafted));
    const actionId = /** @type {string} */ (drafted.actionId);
    let died = false;
    const restore = interleaveOnRead(fxB, /idempotency_key = \? AND status <> 'stale'/, () => {
      died = withDeath(fxA, 'flip', () => approve(fxA, actionId)).died;
    });
    const payload = JSON.parse(/** @type {any} */ (fxB.deps.store.db.prepare('SELECT payload_json FROM agent_action WHERE id = ?').get(actionId)).payload_json);
    let again;
    try {
      again = /** @type {Body} */ (enqueueDraftedAction(agentCtx(fxB), { actionTool: 'vat_configure', payload }));
    } finally {
      assert.equal(restore(), true, 'B read the row before A committed (the premise)');
    }
    assert.equal(died, true, 'A committed the act and died before its flip (the premise)');
    const rows = /** @type {any[]} */ (fxB.deps.store.db.prepare("SELECT id, status FROM agent_action WHERE workspace_id = ? AND action_tool = 'vat_configure'").all(fxB.workspaceId));
    assert.deepEqual(rows.map((r) => ({ ...r })), [{ id: actionId, status: 'pending' }], `one row, still pending: ${JSON.stringify(again).slice(0, 300)}`);
    assert.equal(again.ok, true, `a re-judged answer, never store_busy: ${JSON.stringify(again).slice(0, 300)}`);
    assert.equal(again.replayed, true);
    assert.equal(again.actionId, actionId, 'the committed row answers the re-proposal');
    assert.equal(approve(fxB, actionId).ok, true);
    assert.equal(rowOf(fxB, actionId).status, 'executed');
  } finally {
    close();
  }
});

test('D165 PROBE CAS (r2 finding 4): a row that moves again on the second judgement answers store_busy, runs nothing and stays pending', () => {
  // A mark that keeps moving under the judgement (another process replaying the row right now). Here
  // the mark is moved by hand on A's connection after each of B's reads, to a pin nobody left, so
  // every judgement B makes is "changed" and every void misses: the re-judgement is bounded to one.
  const { fxA, fxB, close } = twoConnections();
  try {
    const input = SCENARIO.vat_configure(fxA);
    const drafted = /** @type {Body} */ (handleRest('vat_configure', input, { ...fxA.deps, actor: 'agent' }).body);
    const actionId = /** @type {string} */ (drafted.actionId);
    assert.equal(withDeath(fxA, 'flip', () => approve(fxA, actionId)).died, true);
    const move = fxA.deps.store.db.prepare('UPDATE agent_action SET committed_pin = ? WHERE id = ?');
    move.run('moved-0', actionId);
    const db = /** @type {any} */ (fxB.deps.store.db);
    const prepare = db.prepare;
    let reads = 0;
    db.prepare = function moving(/** @type {string} */ sql) {
      const stmt = prepare.call(this, sql);
      if (!/^SELECT \* FROM agent_action WHERE workspace_id = \? AND id = \?$/.test(sql)) return stmt;
      return {
        get: (/** @type {unknown[]} */ ...args) => {
          const row = stmt.get(...args);
          reads += 1;
          move.run(`moved-${reads}`, actionId);
          return row;
        },
      };
    };
    const before = businessDigest(fxB.deps.store.db);
    let answer;
    try {
      answer = approve(fxB, actionId);
    } finally {
      db.prepare = prepare;
    }
    assert.equal(answer.error, 'store_busy', JSON.stringify(answer).slice(0, 300));
    assert.equal(answer.retryable, true);
    assert.equal(reads, 2, 'judged once, and once again on the row as it was then, never more');
    assert.equal(businessDigest(fxB.deps.store.db), before, 'nothing ran');
    assert.equal(rowOf(fxB, actionId).status, 'pending');
  } finally {
    close();
  }
});

// --- D165 follow-ups, round 2 (critic `docs/critique/d165-followups-2026-10-14-critique.md` on
// `origin/critic/d165-followups-2026-10-14`): a refusal's own bookkeeping never marks, so a mark is
// kept whenever the attempt committed one (the default fails CLOSED), and nothing clears a mark. -------

const reject = (/** @type {Fx} */ fx, /** @type {string} */ actionId) =>
  /** @type {Body} */ (getAction('reject_drafted_action').run({ ...fx.deps, actor: 'studio' }, { workspaceId: fx.workspaceId, actionId }));
const markOf = (/** @type {Fx} */ fx, /** @type {string} */ actionId) =>
  /** @type {{ status: string, committed_at: string | null, committed_pin: string | null }} */ ({
    ...fx.deps.store.db.prepare('SELECT status, committed_at, committed_pin FROM agent_action WHERE id = ?').get(actionId),
  });
const mustOk = (/** @type {any} */ res, /** @type {string} */ label) => {
  assert.equal(res.ok, true, `${label}: ${JSON.stringify(res).slice(0, 300)}`);
  return res;
};

const EBICS_HOST = { url: 'https://ebics.example/ebicsweb', hostId: 'SYNTHHST', partnerId: 'PARTNER77', userId: 'USER0077' };

test('D165 PROBE BS (follow-up critic finding 1): an approved bank_sync that imports a waiting statement and then answers a refusal keeps its mark and cannot be rejected', () => {
  const fx = fixture();
  const bank = mockBank();
  /** @type {any} */ (fx.deps).ebicsTransport = bank.port;
  const iban = syntheticIban(41);
  const accountId = mustOk(fx.call('create_bank_account', { name: 'Konto 41', iban, currency: 'CHF', ledgerAccountId: fx.accId('1020'), idempotencyKey: 'bs-ba' }), 'account').bankAccountId;
  const statements = chain({ iban, firstSeq: 1, firstDate: '2026-10-01', opening: 50000, days: [[{ minor: 100 }], [{ minor: 200 }], [{ minor: 300 }]] });
  mustOk(fx.call('import_camt', { bankAccountId: accountId, xml: statements[0].xml, idempotencyKey: 'bs-bridge' }), 'bridge');
  const c = mustOk(fx.call('bank_channel_connect', { host: EBICS_HOST, routeBankAccountIds: [accountId], confirm: true, idempotencyKey: 'bs-c' }), 'connect');
  const fetched = mustOk(fx.call('bank_channel_connect', { connectionId: c.connectionId, confirm: true, idempotencyKey: 'bs-f' }), 'fetch');
  mustOk(fx.call('bank_channel_connect', { connectionId: c.connectionId, confirm: true, confirmBankKeys: true, expectedBankKeyHashes: fetched.bankKeyHashes, idempotencyKey: 'bs-k' }), 'confirm');
  // Statement 3 arrives over the channel before 2: it waits on the gap (A36).
  bank.offer(container([statements[2].xml]));
  const first = mustOk(fx.call('bank_sync', { connectionId: c.connectionId, idempotencyKey: 'bs-press-1' }), 'press 1');
  assert.deepEqual(first.statements.map((/** @type {any} */ s) => s.outcome), ['gap_refused']);
  // The owner fills the gap by hand.
  mustOk(fx.call('import_camt', { bankAccountId: accountId, xml: statements[1].xml, idempotencyKey: 'bs-hand-2' }), 'hand 2');
  const statementsNow = () => /** @type {any} */ (fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM bank_statement WHERE workspace_id = ? AND bank_account_id = ?').get(fx.workspaceId, accountId)).n;
  const before = statementsNow();
  // The agent proposes a sync; the person approves it while the bank is unreachable.
  const drafted = /** @type {Body} */ (handleRest('bank_sync', { workspaceId: fx.workspaceId, connectionId: c.connectionId, idempotencyKey: 'bs-agent' }, { ...fx.deps, actor: 'agent' }).body);
  assert.equal(drafted.drafted, true, JSON.stringify(drafted).slice(0, 300));
  const actionId = /** @type {string} */ (drafted.actionId);
  bank.nextDownload({ ok: false, reason: 'transport_error', detail: 'ECONNRESET' });
  const answered = approve(fx, actionId);
  assert.equal(answered.error, 'channel_unreachable', JSON.stringify(answered).slice(0, 300));
  assert.deepEqual(/** @type {any} */ (answered).statements.map((/** @type {any} */ s) => s.outcome), ['imported'], 'the approval imported the waiting statement (the premise)');
  assert.equal(statementsNow(), before + 1);
  const row = markOf(fx, actionId);
  assert.equal(row.status, 'pending');
  assert.equal(typeof row.committed_at, 'string', 'the act ran in part: its mark stays');
  const rejected = reject(fx, actionId);
  assert.equal(rejected.error, 'already_executed', `never rejected over an imported statement: ${JSON.stringify(rejected)}`);
  assert.equal(markOf(fx, actionId).status, 'pending');
  fx.deps.store.close();
});

test('D165 PROBE OVR (follow-up critic finding 3): a refusal log and a lock lost before any letter left leave no mark, so the row stays rejectable', () => {
  const fx = fixture();
  const { runId, debtors } = debtorRun(fx, ['a@debtor.example', 'b@debtor.example']);
  // The first debtor (by id) has no email: its outcome is a degraded log row, a refusal's own record.
  fx.deps.store.db.prepare('UPDATE contact SET email = NULL WHERE id = ?').run([...debtors].sort()[0]);
  const box = [];
  fx.deps.emailRelay = { send: (/** @type {{ to: string }} */ m) => { box.push(m.to); return { ok: true }; } };
  const drafted = /** @type {Body} */ (handleRest('send_dunning_run', { workspaceId: fx.workspaceId, runId, confirmed: true, idempotencyKey: 'ovr-send' }, { ...fx.deps, actor: 'agent' }).body);
  assert.equal(drafted.drafted, true, JSON.stringify(drafted).slice(0, 300));
  const actionId = /** @type {string} */ (drafted.actionId);
  // The second debtor's `dispatching` marker loses the write lock to another process (D12): the driver
  // throws SQLITE_BUSY after its busy timeout, before any transport call.
  const db = /** @type {any} */ (fx.deps.store.db);
  const prepare = db.prepare;
  let thrown = false;
  db.prepare = function busyOnce(/** @type {string} */ sql) {
    const stmt = prepare.call(this, sql);
    if (thrown || !/UPDATE dunning_item SET send_error = \?/.test(sql)) return stmt;
    return new Proxy(stmt, {
      get(target, prop) {
        if (prop !== 'run') {
          const v = Reflect.get(target, prop);
          return typeof v === 'function' ? v.bind(target) : v;
        }
        return (/** @type {unknown[]} */ ...args) => {
          if (args[0] === 'dispatching' && !thrown) {
            thrown = true;
            throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
          }
          return target.run(...args);
        };
      },
    });
  };
  let answered;
  try {
    answered = approve(fx, actionId);
  } finally {
    db.prepare = prepare;
  }
  assert.equal(thrown, true, 'the lock was lost at the dispatching marker (the premise)');
  assert.equal(answered.error, 'store_busy', JSON.stringify(answered).slice(0, 300));
  assert.deepEqual(box, [], 'nothing left the building');
  assert.equal(markOf(fx, actionId).committed_at, null, 'only a refusal record committed: no mark');
  const rejected = reject(fx, actionId);
  assert.equal(rejected.ok, true, JSON.stringify(rejected));
  assert.equal(markOf(fx, actionId).status, 'rejected');
  fx.deps.store.close();
});

test('D165 PROBE CLR (follow-up critic finding 2): a second process\'s refusal never erases the mark the first one committed with the act', () => {
  const { fxA, fxB, close } = twoConnections();
  try {
    fxA.call('vat_seed_defaults', {});
    fxA.call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
    fxA.call('set_creditor_profile', {
      creditorName: 'Conformance GmbH',
      address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
      qrIban: 'CH4431999123000889012',
    });
    const c = /** @type {any} */ (fxA.call('create_contact', {
      partyRole: 'customer', name: 'Rechnung AG',
      address: { street: 'Musterstrasse', houseNo: '5', zip: '3000', city: 'Bern', country: 'CH' },
      email: 'billing@rechnung.example', idempotencyKey: 'clr-c',
    }));
    const doc = /** @type {any} */ (fxA.call('create_document', {
      type: 'invoice', contactId: c.contact.id, currency: 'CHF',
      lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }], idempotencyKey: 'clr-d',
    }));
    const drafted = /** @type {Body} */ (handleRest('issue_invoice', { workspaceId: fxA.workspaceId, invoiceId: doc.document.id, idempotencyKey: 'clr-issue' }, { ...fxA.deps, actor: 'agent' }).body);
    assert.equal(drafted.drafted, true, JSON.stringify(drafted).slice(0, 300));
    const actionId = /** @type {string} */ (drafted.actionId);
    // B (a second process) approves: it reads the row unmarked, and its replay's first write waits out
    // the busy timeout behind A, whose approval of the same row commits the act meanwhile and dies
    // before its status flip.
    const storeB = /** @type {any} */ (fxB.deps.store);
    const txB = storeB.tx;
    let fired = false;
    let aCommitted = false;
    storeB.tx = function busyBehindA(/** @type {() => any} */ body) {
      if (fired) return txB.call(this, body);
      fired = true;
      aCommitted = withDeath(fxA, 'flip', () => approve(fxA, actionId)).died;
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    };
    let answered;
    try {
      answered = approve(fxB, actionId);
    } finally {
      storeB.tx = txB;
    }
    assert.equal(aCommitted, true, 'A issued the invoice and died before its flip (the premise)');
    assert.equal(/** @type {any} */ (fxB.deps.store.db.prepare('SELECT status FROM document WHERE id = ?').get(doc.document.id)).status, 'issued');
    assert.equal(answered.error, 'store_busy', JSON.stringify(answered).slice(0, 300));
    const row = markOf(fxB, actionId);
    assert.equal(row.status, 'pending');
    assert.equal(typeof row.committed_at, 'string', 'A\'s mark survives B\'s refusal');
    const rejected = reject(fxB, actionId);
    assert.equal(rejected.error, 'already_executed', `never rejected over an issued invoice: ${JSON.stringify(rejected)}`);
    const settled = approve(fxB, actionId);
    assert.equal(settled.ok, true, JSON.stringify(settled).slice(0, 300));
    assert.equal(markOf(fxB, actionId).status, 'executed');
  } finally {
    close();
  }
});

test('D165 store: a refusal\'s bookkeeping stamps the mark with ran=false, a business write with ran=true, and commitMarkNow forces ran=true', () => {
  const fx = fixture();
  const store = /** @type {any} */ (fx.deps.store);
  const db = store.db;
  db.exec('CREATE TABLE d165_scope (n INTEGER)');
  /** @type {boolean[]} */
  let calls = [];
  const mark = (/** @type {boolean} */ ran) => {
    calls.push(ran);
    db.prepare('INSERT INTO d165_scope (n) VALUES (-1)').run();
  };
  const write = (/** @type {number} */ n) => db.prepare('INSERT INTO d165_scope (n) VALUES (?)').run(n);
  const run = (/** @type {() => void} */ fn) => {
    calls = [];
    store.withCommitMark(mark, fn);
    return calls;
  };
  // Bookkeeping alone: stamped, never "ran".
  assert.deepEqual(run(() => store.withoutCommitMark(() => write(1))), [false]);
  // A business write: ran.
  assert.deepEqual(run(() => write(2)), [true]);
  // One transaction with both: ran, once.
  assert.deepEqual(run(() => store.tx(() => { store.withoutCommitMark(() => write(3)); write(4); })), [true]);
  // An enclosing transaction whose only write is a nested bookkeeping transaction: the inner one stamps
  // ran=false, and the enclosing one counts neither that write nor the inner stamp as the act running.
  assert.deepEqual(run(() => store.tx(() => store.withoutCommitMark(() => store.tx(() => write(5))))), [false, false]);
  // The same with the scope INSIDE the nested transaction: the nested one stamps ran=false at depth 0,
  // and that stamp's own write is bookkeeping too, never the enclosing transaction's act.
  assert.deepEqual(run(() => store.tx(() => store.tx(() => store.withoutCommitMark(() => write(7))))), [false, false]);
  // A transaction that writes nothing stamps nothing; commitMarkNow forces one ran=true stamp.
  assert.deepEqual(run(() => store.tx(() => db.prepare('SELECT 1').get())), []);
  assert.deepEqual(run(() => store.commitMarkNow()), [true]);
  assert.deepEqual(run(() => store.withoutCommitMark(() => store.commitMarkNow())), [], 'never inside bookkeeping');
  // Outside withCommitMark it does nothing.
  calls = [];
  store.commitMarkNow();
  store.withoutCommitMark(() => write(6));
  assert.deepEqual(calls, []);
  store.close();
});

test('D165: a migration commit its gate refuses after the check stays rejectable, the check being the gate\'s own record', () => {
  const fx = fixture();
  const d = SCENARIO.migration_declare_control_total(fx);
  mustOk(fx.call('migration_declare_control_total', d), 'declare');
  mustOk(fx.call('migration_trial_load_step', { planId: d.planId, stepId: d.stepId, idempotencyKey: 'mcr-trial' }), 'trial');
  const drafted = /** @type {Body} */ (handleRest('migration_commit_step', { workspaceId: fx.workspaceId, planId: d.planId, stepId: d.stepId, idempotencyKey: 'mcr-1' }, { ...fx.deps, actor: 'agent' }).body);
  assert.equal(drafted.drafted, true, JSON.stringify(drafted).slice(0, 300));
  const actionId = /** @type {string} */ (drafted.actionId);
  const checks = () => /** @type {any} */ (fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM migration_check WHERE workspace_id = ?').get(fx.workspaceId)).n;
  const checksBefore = checks();
  const refused = approve(fx, actionId);
  assert.equal(refused.error, 'check_failed', JSON.stringify(refused).slice(0, 300));
  assert.equal(checks(), checksBefore + 1, 'the gate recorded its check (the premise)');
  assert.equal(markOf(fx, actionId).committed_at, null, 'the commit never ran');
  assert.equal(mustOk(reject(fx, actionId), 'reject').status, 'rejected');
  fx.deps.store.close();
});

test('D165: a send_invoice whose transport throws leaves the outcome unknown, so the mark stays and reject refuses', () => {
  const fx = fixture();
  const { confirmed: _c, email: _e, ...input } = SCENARIO.send_invoice(fx);
  fx.deps.emailRelay = { send: () => { throw new Error('socket hang up'); } };
  const drafted = /** @type {Body} */ (handleRest('send_invoice', input, { ...fx.deps, actor: 'agent' }).body);
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  const actionId = /** @type {string} */ (drafted.actionId);
  const thrown = approve(fx, actionId);
  assert.equal(thrown.error, 'unexpected_error', JSON.stringify(thrown).slice(0, 300));
  assert.equal(typeof markOf(fx, actionId).committed_at, 'string', 'a mail that may have left marks the act');
  assert.equal(reject(fx, actionId).error, 'already_executed');
  fx.deps.store.close();
});

test('D165: a dunning send whose FIRST transport call throws marks the act, so reject refuses', () => {
  const fx = fixture();
  const { runId } = debtorRun(fx, ['a@debtor.example']);
  fx.deps.emailRelay = { send: () => { throw new Error('socket hang up'); } };
  const drafted = /** @type {Body} */ (handleRest('send_dunning_run', { workspaceId: fx.workspaceId, runId, confirmed: true, idempotencyKey: 'th-send' }, { ...fx.deps, actor: 'agent' }).body);
  const actionId = /** @type {string} */ (drafted.actionId);
  assert.equal(approve(fx, actionId).error, 'unexpected_error');
  assert.equal(typeof markOf(fx, actionId).committed_at, 'string');
  assert.equal(reject(fx, actionId).error, 'already_executed');
  fx.deps.store.close();
});

test('D165: a dunning send that dies after its dispatching intent, before the transport, never ran: the row stays rejectable', () => {
  const fx = fixture();
  const { runId } = debtorRun(fx, ['a@debtor.example']);
  const box = [];
  fx.deps.emailRelay = { send: (/** @type {{ to: string }} */ m) => { box.push(m.to); return { ok: true }; } };
  const drafted = /** @type {Body} */ (handleRest('send_dunning_run', { workspaceId: fx.workspaceId, runId, confirmed: true, idempotencyKey: 'di-send' }, { ...fx.deps, actor: 'agent' }).body);
  const actionId = /** @type {string} */ (drafted.actionId);
  // The first transaction the replay stamps is the intent; the death falls right after it.
  assert.equal(withDeath(fx, 1, () => approve(fx, actionId)).died, true);
  assert.deepEqual(box, [], 'the transport was never reached');
  assert.equal(/** @type {any} */ (fx.deps.store.db.prepare('SELECT send_error FROM dunning_item WHERE run_id = ?').get(runId)).send_error, 'dispatching', 'the intent committed (the premise)');
  assert.equal(markOf(fx, actionId).committed_at, null, 'an intent is not the act');
  assert.equal(mustOk(reject(fx, actionId), 'reject').status, 'rejected');
  fx.deps.store.close();
});

test('D165 r2 finding 2 (follow-up M12): a debtor\'s no_email and send_failed outcomes land with their log row or not at all', () => {
  for (const kind of /** @type {const} */ (['no_email', 'send_failed'])) {
    const fx = fixture();
    const { runId, debtors } = debtorRun(fx, ['a@debtor.example']);
    if (kind === 'no_email') fx.deps.store.db.prepare('UPDATE contact SET email = NULL WHERE id = ?').run(debtors[0]);
    fx.deps.emailRelay = { send: () => ({ ok: false, reason: 'relay_unavailable' }) };
    // The outcome's log row fails to insert: its state must roll back with it.
    const db = /** @type {any} */ (fx.deps.store.db);
    const prepare = db.prepare;
    db.prepare = function failingLog(/** @type {string} */ sql) {
      if (/INSERT INTO dispatches/.test(sql)) throw new Error('log row refused');
      return prepare.call(this, sql);
    };
    let thrown = false;
    try {
      fx.call('send_dunning_run', { runId, confirmed: true, idempotencyKey: `m12-${kind}` });
    } catch {
      thrown = true;
    } finally {
      db.prepare = prepare;
    }
    const state = /** @type {any} */ (fx.deps.store.db.prepare('SELECT send_error FROM dunning_item WHERE run_id = ?').get(runId)).send_error;
    assert.ok(state === null || state === 'dispatching', `${kind}: the outcome rolled back with its log row (send_error ${state}, threw ${thrown})`);
    assert.equal(/** @type {any} */ (fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM dispatches WHERE dunning_run_id = ?').get(runId)).n, 0);
    fx.deps.store.close();
  }
});

test('D165: an approved bank_sync that imports nothing and refuses stays rejectable, its sync lease being its own bookkeeping', () => {
  const fx = fixture();
  const bank = mockBank();
  /** @type {any} */ (fx.deps).ebicsTransport = bank.port;
  const iban = syntheticIban(42);
  const accountId = mustOk(fx.call('create_bank_account', { name: 'Konto 42', iban, currency: 'CHF', ledgerAccountId: fx.accId('1020'), idempotencyKey: 'bn-ba' }), 'account').bankAccountId;
  const c = mustOk(fx.call('bank_channel_connect', { host: EBICS_HOST, routeBankAccountIds: [accountId], confirm: true, idempotencyKey: 'bn-c' }), 'connect');
  const fetched = mustOk(fx.call('bank_channel_connect', { connectionId: c.connectionId, confirm: true, idempotencyKey: 'bn-f' }), 'fetch');
  mustOk(fx.call('bank_channel_connect', { connectionId: c.connectionId, confirm: true, confirmBankKeys: true, expectedBankKeyHashes: fetched.bankKeyHashes, idempotencyKey: 'bn-k' }), 'confirm');
  const drafted = /** @type {Body} */ (handleRest('bank_sync', { workspaceId: fx.workspaceId, connectionId: c.connectionId, idempotencyKey: 'bn-agent' }, { ...fx.deps, actor: 'agent' }).body);
  assert.equal(drafted.drafted, true, JSON.stringify(drafted).slice(0, 300));
  const actionId = /** @type {string} */ (drafted.actionId);
  bank.nextDownload({ ok: false, reason: 'transport_error', detail: 'ECONNRESET' });
  const answered = approve(fx, actionId);
  assert.equal(answered.error, 'channel_unreachable', JSON.stringify(answered).slice(0, 300));
  assert.equal(markOf(fx, actionId).committed_at, null, 'only the lease was written and released');
  assert.equal(mustOk(reject(fx, actionId), 'reject').status, 'rejected');
  fx.deps.store.close();
});

// --- The security review of the D165 merge (orchestrator addendum, 14.10.2026): TOCTOU between approve
// and reject in two processes, and fail-open state drift in the dunning and invoice send paths. --------

test('D165 PROBE RJ (security review, TOCTOU): a reject that read the row before another process committed its act never records rejected over it', () => {
  const { fxA, fxB, close } = twoConnections();
  try {
    const input = SCENARIO.vat_configure(fxA);
    const drafted = /** @type {Body} */ (handleRest('vat_configure', input, { ...fxA.deps, actor: 'agent' }).body);
    const actionId = /** @type {string} */ (drafted.actionId);
    let died = false;
    const restore = interleaveOnRead(fxB, /^SELECT \* FROM agent_action WHERE workspace_id = \? AND id = \?$/, () => {
      died = withDeath(fxA, 'flip', () => approve(fxA, actionId)).died;
    });
    let answer;
    try {
      answer = reject(fxB, actionId);
    } finally {
      assert.equal(restore(), true, 'B read the row before A committed (the premise)');
    }
    assert.equal(died, true, 'A committed the act and died before its flip (the premise)');
    assert.equal(answer.error, 'already_executed', `B answers from the row: ${JSON.stringify(answer)}`);
    assert.equal(markOf(fxB, actionId).status, 'pending');
    assert.equal(approve(fxB, actionId).ok, true);
    assert.equal(markOf(fxB, actionId).status, 'executed');
  } finally {
    close();
  }
});

test('D165 PROBE AR (security review, TOCTOU): an approval whose row another process rejects after its checks commits nothing of the act', () => {
  const { fxA, fxB, close } = twoConnections();
  try {
    const input = SCENARIO.vat_configure(fxA);
    const drafted = /** @type {Body} */ (handleRest('vat_configure', input, { ...fxA.deps, actor: 'agent' }).body);
    const actionId = /** @type {string} */ (drafted.actionId);
    /** @type {Body | undefined} */
    let rejected;
    const restore = interleaveOnRead(fxB, /^SELECT \* FROM agent_action WHERE workspace_id = \? AND id = \?$/, () => {
      rejected = reject(fxA, actionId);
    });
    const before = businessDigest(fxB.deps.store.db);
    let answer;
    try {
      answer = approve(fxB, actionId);
    } finally {
      assert.equal(restore(), true, 'B read the row while it was pending (the premise)');
    }
    assert.equal(/** @type {any} */ (rejected).ok, true, `A rejected first: ${JSON.stringify(rejected)}`);
    assert.equal(answer.error, 'already_rejected', `B answers from the row: ${JSON.stringify(answer).slice(0, 300)}`);
    assert.equal(businessDigest(fxB.deps.store.db), before, 'nothing of the act committed over the rejection');
    assert.deepEqual(markOf(fxB, actionId), { status: 'rejected', committed_at: null, committed_pin: null });
  } finally {
    close();
  }
});

test('D165 PROBE DBL (follow-up critic finding 6; security review, dunning state drift): two processes approving one dunning Vorschlag at once never send a letter twice', () => {
  const { fxA, fxB, close } = twoConnections();
  try {
    const { runId } = debtorRun(fxA, ['a@debtor.example', 'b@debtor.example']);
    /** @type {string[]} */
    const box = [];
    let nested = false;
    /** @type {any} */ (fxB.deps).emailRelay = { send: (/** @type {{ to: string }} */ m) => { box.push(`B:${m.to}`); return { ok: true }; } };
    const drafted = /** @type {Body} */ (handleRest('send_dunning_run', { workspaceId: fxA.workspaceId, runId, confirmed: true, idempotencyKey: 'dbl-send' }, { ...fxA.deps, actor: 'agent' }).body);
    assert.equal(drafted.drafted, true, JSON.stringify(drafted).slice(0, 300));
    const actionId = /** @type {string} */ (drafted.actionId);
    // A's first letter is on the wire (outside any transaction) when B's approval of the same row runs.
    /** @type {any} */ (fxA.deps).emailRelay = {
      send: (/** @type {{ to: string }} */ m) => {
        if (!nested) {
          nested = true;
          approve(fxB, actionId);
        }
        box.push(`A:${m.to}`);
        return { ok: true };
      },
    };
    const done = approve(fxA, actionId);
    const to = box.map((s) => s.slice(2)).sort();
    assert.deepEqual(to, ['a@debtor.example', 'b@debtor.example'], `each letter exactly once: ${JSON.stringify(box)}`);
    assert.equal(done.ok, true, JSON.stringify(done).slice(0, 300));
    assert.equal(markOf(fxA, actionId).status, 'executed');
    const items = /** @type {any[]} */ (fxA.deps.store.db.prepare('SELECT sent_at, send_error FROM dunning_item WHERE run_id = ?').all(runId));
    assert.ok(items.every((i) => i.sent_at !== null), `both letters recorded sent: ${JSON.stringify(items)}`);
  } finally {
    close();
  }
});

test('D165 PROBE RC (security review, invoice state drift): a send whose mail left reconciles on retry although the customer email was cleared since', () => {
  const fx = fixture();
  const { confirmed: _c, email: _e, ...input } = SCENARIO.send_invoice(fx);
  const box = [];
  fx.deps.emailRelay = { send: (/** @type {{ to: string }} */ m) => { box.push(m.to); return { ok: true }; } };
  const human = { ...fx.deps, actor: 'studio' };
  const body = { ...input, workspaceId: fx.workspaceId, confirmed: true, idempotencyKey: 'rc-1' };
  const contactId = fx.deps.store.db.prepare('SELECT contact_id FROM document WHERE id = ?').get(input.invoiceId).contact_id;
  const original = fx.deps.store.db.prepare('SELECT email FROM contact WHERE id = ?').get(contactId).email;
  // The death falls on the first statement of the post-send records: the mail left, the attempt says so.
  const db = /** @type {any} */ (fx.deps.store.db);
  const prepare = db.prepare;
  let dead = false;
  db.prepare = function dying(/** @type {string} */ sql) {
    if (dead || /UPDATE document SET sent_to_email/.test(sql)) {
      dead = true;
      throw new Error('simulated process death after the transport');
    }
    return prepare.call(this, sql);
  };
  try {
    getAction('send_invoice').run(human, body);
  } catch {
    // the process is gone
  } finally {
    db.prepare = prepare;
  }
  assert.deepEqual(box, [original]);
  fx.deps.store.db.prepare('UPDATE contact SET email = NULL WHERE id = ?').run(contactId);
  const retried = /** @type {Body} */ (getAction('send_invoice').run(human, body));
  assert.equal(retried.ok, true, `the mail left, so the retry records it: ${JSON.stringify(retried).slice(0, 300)}`);
  assert.equal(retried.transmitted, true);
  assert.deepEqual(box, [original], 'nothing sent again');
  const doc = /** @type {any} */ (fx.deps.store.db.prepare('SELECT status, sent_to_email FROM document WHERE id = ?').get(input.invoiceId));
  assert.deepEqual({ ...doc }, { status: 'sent', sent_to_email: original });
  fx.deps.store.close();
});

test('D165 PROBE AR0 (security review, TOCTOU): an approval whose act writes nothing never claims executed over a row another process rejected meanwhile', () => {
  const { fxA, fxB, close } = twoConnections();
  try {
    const { runId } = debtorRun(fxA, ['a@debtor.example']);
    /** @type {any} */ (fxA.deps).emailRelay = { send: () => ({ ok: true }) };
    /** @type {any} */ (fxB.deps).emailRelay = { send: () => ({ ok: true }) };
    // The run is sent already, so the approved replay transmits nothing and writes nothing.
    mustOk(fxA.call('send_dunning_run', { runId, confirmed: true, idempotencyKey: 'ar0-direct' }), 'direct send');
    const drafted = /** @type {Body} */ (handleRest('send_dunning_run', { workspaceId: fxA.workspaceId, runId, confirmed: true, idempotencyKey: 'ar0-agent' }, { ...fxA.deps, actor: 'agent' }).body);
    assert.equal(drafted.drafted, true, JSON.stringify(drafted).slice(0, 300));
    const actionId = /** @type {string} */ (drafted.actionId);
    const restore = interleaveOnRead(fxB, /^SELECT \* FROM agent_action WHERE workspace_id = \? AND id = \?$/, () => {
      mustOk(reject(fxA, actionId), 'A rejects');
    });
    let answer;
    try {
      answer = approve(fxB, actionId);
    } finally {
      assert.equal(restore(), true);
    }
    assert.equal(answer.error, 'already_rejected', `B answers from the row: ${JSON.stringify(answer).slice(0, 300)}`);
    assert.equal(markOf(fxB, actionId).status, 'rejected');
  } finally {
    close();
  }
});

// --- D165 follow-ups, round 3 (critic round 2 on `3adbbb8e`, `docs/critique/d165-followups-2026-10-14-critique.md`
// on `origin/critic/d165-followups-2026-10-14`): no failing-closed row may be left undecidable. ---------

/** G09 opening-balances step over two real accounts, declared and trial-loaded (synthetic, as test/migration). */
function seedOpeningStep(/** @type {Fx} */ fx, /** @type {string} */ seed) {
  const accounts = /** @type {any} */ (mustOk(fx.call('list_accounts', {}), 'list_accounts')).accounts;
  const [a, b] = accounts;
  const csv = `account,debitMinor,creditMinor\n${a.number},100000,0\n${b.number},0,100000\n`;
  const up = mustOk(fx.call('files_upload', { title: `Eröffnung ${seed}`, filename: `${seed}.csv`, mime: 'text/csv', contentBase64: Buffer.from(csv).toString('base64'), idempotencyKey: `${seed}-up` }), 'upload');
  const planId = mustOk(fx.call('migration_create_plan', { sourceSystem: 'csv', cutoverDate: '2026-01-01', localePack: 'ch', idempotencyKey: `${seed}-plan` }), 'plan').planId;
  mustOk(fx.call('migration_discover_source', { fileIds: [up.file.id], planId }), 'discover');
  const stepId = mustOk(fx.call('migration_set_scope', { planId, classes: [{ dataClass: 'opening_balances', include: true }], idempotencyKey: `${seed}-scope` }), 'scope').steps[0].stepId;
  mustOk(fx.call('migration_declare_control_total', { planId, stepId, kind: 'trial_balance_matches_source', scope: a.number, declaredMinor: 100000, idempotencyKey: `${seed}-a` }), 'declare a');
  mustOk(fx.call('migration_declare_control_total', { planId, stepId, kind: 'trial_balance_matches_source', scope: b.number, declaredMinor: -100000, idempotencyKey: `${seed}-b` }), 'declare b');
  mustOk(fx.call('migration_trial_load_step', { planId, stepId, idempotencyKey: `${seed}-trial` }), 'trial');
  return { planId, stepId };
}

test('D165 PROBE STK-MIG (critic r2 R2-1): a refusal the act memoises is not the act, so the row stays rejectable', () => {
  const fx = fixture();
  const { planId, stepId } = seedOpeningStep(fx, 'stk');
  const staged = mustOk(fx.call('migration_commit_step', { planId, stepId, idempotencyKey: 'stk-stage' }), 'stage');
  assert.equal(staged.staged, true);
  fx.deps.store.db.prepare('UPDATE migration_plan SET backup_ref = ? WHERE id = ?').run('backup-1', planId);
  mustOk(fx.call('migration_record_approval', { planId, stepId, checkHash: staged.checkHash, idempotencyKey: 'stk-appr' }), 'approval');
  const drafted = /** @type {Body} */ (handleRest('migration_commit_step', { workspaceId: fx.workspaceId, planId, stepId, idempotencyKey: 'stk-agent' }, { ...fx.deps, actor: 'agent' }).body);
  assert.equal(drafted.drafted, true, JSON.stringify(drafted).slice(0, 300));
  const actionId = /** @type {string} */ (drafted.actionId);
  // Meanwhile the prior year is closed (the hard `year_close` lock): the commit's own A04 call refuses
  // `carried_forward`, inside the commit's memoised route.
  fx.deps.store.db.prepare("INSERT INTO period_lock (workspace_id, period, kind, locked_at, locked_by, reason) VALUES (?, '2025', 'hard', ?, 'studio', 'year_close')").run(fx.workspaceId, AT);
  const before = businessDigest(fx.deps.store.db);
  const first = approve(fx, actionId);
  assert.equal(first.error, 'carried_forward', JSON.stringify(first).slice(0, 300));
  const memo = /** @type {any} */ (fx.deps.store.db.prepare("SELECT COUNT(*) AS n FROM idempotency WHERE workspace_id = ? AND key = 'stk-agent'").get(fx.workspaceId)).n;
  assert.equal(memo, 1, 'the route memoised its refusal (the premise)');
  assert.equal(businessDigest(fx.deps.store.db), before, 'nothing of the act committed');
  assert.equal(markOf(fx, actionId).committed_at, null, 'a memo is never the act');
  assert.equal(mustOk(reject(fx, actionId), 'reject').status, 'rejected');
  fx.deps.store.close();
});

test('D165 PROBE STK-INV (critic r2 R2-2): a send_invoice approval whose transport threw settles executed on re-approve with the unknown outcome as its result', () => {
  const fx = fixture();
  const { confirmed: _c, email: _e, ...base } = SCENARIO.send_invoice(fx);
  let throwIt = true;
  const box = [];
  fx.deps.emailRelay = { send: (/** @type {{ to: string }} */ m) => { if (throwIt) throw new Error('smtp timeout'); box.push(m.to); return { ok: true }; } };
  const drafted = /** @type {Body} */ (handleRest('send_invoice', { ...base, workspaceId: fx.workspaceId, idempotencyKey: 'inv-agent' }, { ...fx.deps, actor: 'agent' }).body);
  assert.equal(drafted.drafted, true, JSON.stringify(drafted).slice(0, 300));
  const actionId = /** @type {string} */ (drafted.actionId);
  assert.equal(approve(fx, actionId).error, 'unexpected_error');
  assert.equal(typeof markOf(fx, actionId).committed_at, 'string', 'the mail may have left: marked (the premise)');
  assert.equal(reject(fx, actionId).error, 'already_executed');
  throwIt = false;
  const dials = () => JSON.stringify(fx.deps.store.db.prepare('SELECT * FROM agent_dial WHERE workspace_id = ? ORDER BY capability').all(fx.workspaceId));
  const dialsBefore = dials();
  // The person ticks "künftig automatisch" on the re-approve that settles it (critic r3 R3-3): a send
  // nobody knows happened never earns the agent automatic sends.
  const again = /** @type {Body} */ (getAction('approve_drafted_action').run({ ...fx.deps, actor: 'studio' }, { workspaceId: fx.workspaceId, actionId, allowFuture: true }));
  assert.equal(again.ok, true, `the re-approve settles the row: ${JSON.stringify(again).slice(0, 300)}`);
  assert.equal(/** @type {any} */ (again).result.error, 'send_outcome_unknown', 'its result says the outcome is unknown');
  // Critic r3 R3-1: the answer says so at the top, not only nested, so neither a person nor an agent
  // reads it as a sent invoice.
  assert.equal(again.outcomeUnknown, true, JSON.stringify(again).slice(0, 300));
  assert.equal(again.outcomeCode, 'send_outcome_unknown');
  assert.equal(again.granted, undefined, 'no standing grant on an unknown outcome');
  assert.equal(dials(), dialsBefore, 'the dial is unchanged');
  assert.deepEqual(box, [], 'and nothing was sent again');
  assert.equal(markOf(fx, actionId).status, 'executed');
  const stored = JSON.parse(/** @type {any} */ (fx.deps.store.db.prepare('SELECT result_json FROM agent_action WHERE id = ?').get(actionId)).result_json);
  assert.equal(stored.error, 'send_outcome_unknown', 'the record says the outcome is unknown, never that it was sent');
  fx.deps.store.close();
});

test('D165: a send_outcome_unknown on a row this approval never marked stays a refusal (nothing of the act ran here)', () => {
  const fx = fixture();
  const { confirmed: _c, email: _e, ...base } = SCENARIO.send_invoice(fx);
  fx.deps.emailRelay = { send: () => { throw new Error('smtp timeout'); } };
  // A direct send under the same key left the attempt at `dispatching` before the agent proposed it.
  const direct = /** @type {Body} */ (getAction('send_invoice').run({ ...fx.deps, actor: 'studio' }, { ...base, workspaceId: fx.workspaceId, confirmed: true, idempotencyKey: 'inv-shared' }));
  assert.equal(direct.error, 'unexpected_error', JSON.stringify(direct).slice(0, 300));
  const drafted = /** @type {Body} */ (handleRest('send_invoice', { ...base, workspaceId: fx.workspaceId, idempotencyKey: 'inv-shared' }, { ...fx.deps, actor: 'agent' }).body);
  const actionId = /** @type {string} */ (drafted.actionId);
  const answered = approve(fx, actionId);
  assert.equal(answered.error, 'send_outcome_unknown', JSON.stringify(answered).slice(0, 300));
  assert.deepEqual(markOf(fx, actionId), { status: 'pending', committed_at: null, committed_pin: null });
  assert.equal(mustOk(reject(fx, actionId), 'reject').status, 'rejected');
  fx.deps.store.close();
});

test('D165 (critic r2 R2-1 sweep): a portal quote accept denied at its grant fence audits the denial as bookkeeping, so the row stays rejectable', () => {
  const fx = fixture();
  const input = SCENARIO.portal_quote_accept(fx);
  const drafted = /** @type {Body} */ (handleRest('portal_quote_accept', { ...input, workspaceId: fx.workspaceId }, { ...fx.deps, actor: 'agent' }).body);
  assert.equal(drafted.drafted, true, JSON.stringify(drafted).slice(0, 300));
  const actionId = /** @type {string} */ (drafted.actionId);
  // The grant lapses before the person decides: the accept is denied at FENCE 0, which audits the denial.
  const grantId = /** @type {any} */ (fx.deps.store.db.prepare("SELECT id FROM portal_grant WHERE workspace_id = ? ORDER BY rowid DESC LIMIT 1").get(fx.workspaceId)).id;
  fx.deps.store.db.prepare("UPDATE portal_grant SET expires_at = '2026-01-01' WHERE id = ?").run(grantId);
  const audits = () => /** @type {any} */ (fx.deps.store.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ? AND action = 'deny'").get(fx.workspaceId)).n;
  const before = audits();
  const denied = approve(fx, actionId);
  assert.equal(denied.ok, false, JSON.stringify(denied).slice(0, 300));
  assert.notEqual(denied.error, 'vorschlag_stale', 'the grant expiry is not pinned: the fence decides (the premise)');
  assert.equal(audits(), before + 1, `the denial was audited (the premise): ${denied.error}`);
  assert.equal(markOf(fx, actionId).committed_at, null, 'a denial is not the act');
  assert.equal(mustOk(reject(fx, actionId), 'reject').status, 'rejected');
  fx.deps.store.close();
});
