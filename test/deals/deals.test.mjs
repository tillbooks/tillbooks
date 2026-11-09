/**
 * C01, leads & deals: the engine behaviours the spec's §7/§8 promise.
 *
 * Everything drives through the REGISTRY (`getAction(...).run`), never the engine functions bare,
 * so every claim here is made about the same boundary MCP, REST and the Studio share: the tenant
 * check, the A24 gate, the automation emit and the throw guard are all in the loop. The money-path
 * ABSENCE half lives in `no-money-path.test.mjs` beside this file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { eventsEmittedBy, readPath } from '../../dist/core/automation/index.js';
import { weightedMinor } from '../../dist/core/deals/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, workspaceId, input) => getAction(name).run(deps, { workspaceId, ...input });

function world(seed) {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Deals AG', `${seed}-ws`);
  const contact = call(deps, 'create_contact', workspaceId, {
    partyRole: 'customer',
    name: 'Muster AG',
    idempotencyKey: `${seed}-contact`,
  });
  return { deps, workspaceId, contactId: contact.contact.id };
}

const count = (deps, sql, ...args) => deps.store.db.prepare(sql).get(...args).n;

// --- Seeding and the read that writes nothing ---------------------------------------------------

test('C01: deals_list on an unseeded workspace answers empty and writes NOTHING (a read never seeds)', () => {
  const { deps, workspaceId } = world('seed-read');
  const listed = call(deps, 'deals_list', workspaceId, {});
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.pipelines, []);
  assert.deepEqual(listed.deals, []);
  assert.equal(listed.weightedTotalMinor, 0);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM pipeline WHERE workspace_id = ?', workspaceId), 0);
});

test('C01: the FIRST deals_create seeds the default funnel once, and the deal lands in the first open stage', () => {
  const { deps, workspaceId, contactId } = world('seed-write');
  const created = call(deps, 'deals_create', workspaceId, {
    contactId,
    title: 'Website-Relaunch',
    valueMinor: 250000,
    idempotencyKey: 'sw-1',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const board = call(deps, 'deals_list', workspaceId, {});
  assert.equal(board.stages.length, 5);
  assert.deepEqual(
    board.stages.map((s) => [s.name, s.probability, s.outcome]),
    [
      ['Lead', 10, null],
      ['Qualifiziert', 35, null],
      ['Offerte', 60, null],
      ['Gewonnen', 100, 'won'],
      ['Verloren', 0, 'lost'],
    ],
  );
  assert.equal(created.deal.stageId, board.stages[0].id);
  assert.equal(created.deal.probability, 10);
  assert.equal(created.deal.status, 'open');
  // A second create seeds nothing more.
  call(deps, 'deals_create', workspaceId, { contactId, title: 'Zweiter', valueMinor: 1000, idempotencyKey: 'sw-2' });
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM pipeline WHERE workspace_id = ?', workspaceId), 1);
});

test('C01: creating on an unknown contact refuses with contact_not_found, and writes nothing', () => {
  const { deps, workspaceId } = world('no-contact');
  const res = call(deps, 'deals_create', workspaceId, {
    contactId: 'ghost',
    title: 'X',
    valueMinor: 1,
    idempotencyKey: 'nc-1',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'contact_not_found');
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM deal WHERE workspace_id = ?', workspaceId), 0);
});

// --- §H-FX: frozen at capture ------------------------------------------------------------------

test('C01 §H-FX: a EUR create stores the base + rate through the real resolver, frozen thereafter', () => {
  const { deps, workspaceId, contactId } = world('fx');
  call(deps, 'record_exchange_rate', workspaceId, {
    baseCurrency: 'EUR',
    rate: '0.93',
    asOf: '2026-07-15',
    idempotencyKey: 'fx-rate',
  });
  const created = call(deps, 'deals_create', workspaceId, {
    contactId,
    title: 'EU-Projekt',
    valueMinor: 100000,
    currency: 'EUR',
    idempotencyKey: 'fx-1',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.deal.valueMinor, 100000);
  assert.equal(created.deal.valueBaseMinor, 93000);
  assert.equal(created.deal.fxRate, '0.93');

  // A LATER rate never rewrites the row: record a new rate, patch something unrelated.
  call(deps, 'record_exchange_rate', workspaceId, {
    baseCurrency: 'EUR',
    rate: '0.95',
    asOf: '2026-07-16',
    idempotencyKey: 'fx-rate-2',
  });
  const retitled = call(deps, 'deals_update', workspaceId, {
    dealId: created.dealId,
    patch: { title: 'EU-Projekt Phase 2' },
    idempotencyKey: 'fx-2',
  });
  assert.equal(retitled.ok, true);
  assert.equal(retitled.deal.valueBaseMinor, 93000, 'an unrelated patch re-derived the frozen base');
  assert.equal(retitled.deal.fxRate, '0.93', 'an unrelated patch re-derived the frozen rate');

  // A patch NAMING the value re-freezes through the resolver, which now answers the newer rate.
  const repriced = call(deps, 'deals_update', workspaceId, {
    dealId: created.dealId,
    patch: { valueMinor: 200000 },
    idempotencyKey: 'fx-3',
  });
  assert.equal(repriced.ok, true);
  assert.equal(repriced.deal.valueBaseMinor, 190000);
  assert.equal(repriced.deal.fxRate, '0.95');
});

test('C01 §H-FX: a base-currency deal stores base = txn at rate 1, and the trio is never a client input', () => {
  const { deps, workspaceId, contactId } = world('fx-chf');
  const created = call(deps, 'deals_create', workspaceId, {
    contactId,
    title: 'CHF-Deal',
    valueMinor: 55555,
    idempotencyKey: 'fc-1',
  });
  assert.equal(created.deal.valueBaseMinor, 55555);
  assert.equal(created.deal.fxRate, '1');
  // The boundary schema carries no valueBaseMinor/fxRate input at all.
  const schema = getAction('deals_create').inputSchema;
  assert.equal('valueBaseMinor' in schema.properties, false);
  assert.equal('fxRate' in schema.properties, false);
});

test('C01 §H-FX: a missing rate refuses with needs_fx_rate, and the refusal is NOT memoised under the key', () => {
  const { deps, workspaceId, contactId } = world('fx-missing');
  const refused = call(deps, 'deals_create', workspaceId, {
    contactId,
    title: 'EU ohne Kurs',
    valueMinor: 100000,
    currency: 'EUR',
    idempotencyKey: 'fxm-1',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'needs_fx_rate');
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM deal WHERE workspace_id = ?', workspaceId), 0);

  // The caller repairs the state and retries UNDER THE SAME KEY: a memoised refusal would replay
  // stale here, which is exactly what `idempotentWrite` exists to prevent.
  call(deps, 'record_exchange_rate', workspaceId, {
    baseCurrency: 'EUR',
    rate: '0.93',
    asOf: '2026-07-15',
    idempotencyKey: 'fxm-rate',
  });
  const retried = call(deps, 'deals_create', workspaceId, {
    contactId,
    title: 'EU ohne Kurs',
    valueMinor: 100000,
    currency: 'EUR',
    idempotencyKey: 'fxm-1',
  });
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(retried.deal.valueBaseMinor, 93000);
});

// --- The weighted read model -------------------------------------------------------------------

test('C01: weightedMinor is round-once, half away from zero, with no float drift (fuzz vs bigint)', () => {
  // Deterministic linear-congruential fuzz: no seed dependency, reproducible on every run.
  let state = 12345n;
  const next = () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return state;
  };
  for (let i = 0; i < 2000; i++) {
    const value = Number(next() % 100000000n); // up to CHF 1'000'000.00 in Rappen
    const probability = Number(next() % 101n);
    const exact = BigInt(value) * BigInt(probability);
    const quotient = exact / 100n;
    const remainder = exact % 100n;
    const expected = Number(remainder * 2n >= 100n ? quotient + 1n : quotient);
    assert.equal(
      weightedMinor(value, probability),
      expected,
      `weightedMinor(${value}, ${probability}) drifted`,
    );
  }
});

test('C01: the board read sums OPEN deals only, and includeClosed widens the list but never the total', () => {
  const { deps, workspaceId, contactId } = world('weighted');
  const a = call(deps, 'deals_create', workspaceId, { contactId, title: 'A', valueMinor: 100000, idempotencyKey: 'w-a' });
  const b = call(deps, 'deals_create', workspaceId, { contactId, title: 'B', valueMinor: 50000, idempotencyKey: 'w-b' });
  call(deps, 'deals_mark', workspaceId, { dealId: b.dealId, status: 'lost', lostReason: 'Budget', idempotencyKey: 'w-l' });

  const bare = call(deps, 'deals_list', workspaceId, {});
  assert.deepEqual(bare.deals.map((d) => d.id), [a.dealId], 'a closed deal leaked into the default list');
  assert.equal(bare.weightedTotalMinor, weightedMinor(100000, 10));
  assert.equal(bare.baseCurrency, 'CHF');

  const wide = call(deps, 'deals_list', workspaceId, { includeClosed: true });
  assert.equal(wide.deals.length, 2);
  assert.equal(wide.weightedTotalMinor, bare.weightedTotalMinor, 'a closed deal entered the weighted total');
});

// --- Moves and the one door --------------------------------------------------------------------

test('C01: a move re-defaults the probability, a manual override pins it, and the timeline records it', () => {
  const { deps, workspaceId, contactId } = world('move');
  const d = call(deps, 'deals_create', workspaceId, { contactId, title: 'Move', valueMinor: 1000, idempotencyKey: 'm-1' });
  const board = call(deps, 'deals_list', workspaceId, {});
  const qualifiziert = board.stages.find((s) => s.name === 'Qualifiziert');
  const offerte = board.stages.find((s) => s.name === 'Offerte');

  const moved = call(deps, 'deals_move', workspaceId, { dealId: d.dealId, stageId: qualifiziert.id, idempotencyKey: 'm-2' });
  assert.equal(moved.ok, true);
  assert.equal(moved.deal.probability, 35, 'the move did not re-default to the stage probability');

  const pinned = call(deps, 'deals_update', workspaceId, { dealId: d.dealId, patch: { probability: 80 }, idempotencyKey: 'm-3' });
  assert.equal(pinned.deal.probabilityOverridden, true);
  const movedAgain = call(deps, 'deals_move', workspaceId, { dealId: d.dealId, stageId: offerte.id, idempotencyKey: 'm-4' });
  assert.equal(movedAgain.deal.probability, 80, 'a hand-pinned probability was overwritten by a stage move');

  const timeline = call(deps, 'contacts_timeline', workspaceId, { contactId });
  const bodies = timeline.activities.map((a) => a.body);
  assert.ok(bodies.some((b) => b.includes('Phase gewechselt')), `no stage-move note on the timeline: ${bodies}`);
  assert.ok(timeline.activities.every((a) => a.kind === 'note'));
});

test('C01: a stage outside the deal pipeline refuses, and an outcome stage refuses with terminal_stage_use_mark', () => {
  const { deps, workspaceId, contactId } = world('move-guards');
  const d = call(deps, 'deals_create', workspaceId, { contactId, title: 'Guard', valueMinor: 1000, idempotencyKey: 'g-1' });
  const other = call(deps, 'pipelines_upsert', workspaceId, { name: 'Andere', idempotencyKey: 'g-2' });
  const foreign = call(deps, 'pipeline_stages_upsert', workspaceId, {
    pipelineId: other.pipelineId,
    name: 'Fremd',
    idempotencyKey: 'g-3',
  });
  const cross = call(deps, 'deals_move', workspaceId, { dealId: d.dealId, stageId: foreign.stageId, idempotencyKey: 'g-4' });
  assert.equal(cross.error, 'stage_not_in_pipeline');

  const board = call(deps, 'deals_list', workspaceId, {});
  const won = board.stages.find((s) => s.outcome === 'won');
  const terminal = call(deps, 'deals_move', workspaceId, { dealId: d.dealId, stageId: won.id, idempotencyKey: 'g-5' });
  assert.equal(terminal.error, 'terminal_stage_use_mark');
});

test('C01: markDeal is the one door: lost needs a reason, won pins 100 and moves to the outcome stage, open reopens', () => {
  const { deps, workspaceId, contactId } = world('mark');
  const d = call(deps, 'deals_create', workspaceId, { contactId, title: 'Abschluss', valueMinor: 500000, idempotencyKey: 'k-1' });

  const bare = call(deps, 'deals_mark', workspaceId, { dealId: d.dealId, status: 'lost', idempotencyKey: 'k-2' });
  assert.equal(bare.error, 'lost_reason_required');

  const won = call(deps, 'deals_mark', workspaceId, { dealId: d.dealId, status: 'won', idempotencyKey: 'k-3' });
  assert.equal(won.ok, true);
  assert.equal(won.deal.status, 'won');
  assert.equal(won.deal.probability, 100);
  const board = call(deps, 'deals_list', workspaceId, { includeClosed: true });
  assert.equal(won.deal.stageId, board.stages.find((s) => s.outcome === 'won').id);

  // A closed deal refuses ordinary writes until reopened.
  assert.equal(
    call(deps, 'deals_update', workspaceId, { dealId: d.dealId, patch: { title: 'X' }, idempotencyKey: 'k-4' }).error,
    'deal_closed',
  );
  assert.equal(
    call(deps, 'deals_move', workspaceId, { dealId: d.dealId, stageId: board.stages[1].id, idempotencyKey: 'k-5' }).error,
    'deal_closed',
  );

  const reopened = call(deps, 'deals_mark', workspaceId, { dealId: d.dealId, status: 'open', idempotencyKey: 'k-6' });
  assert.equal(reopened.ok, true);
  assert.equal(reopened.deal.status, 'open');
  assert.equal(reopened.deal.stageId, board.stages[0].id, 'the reopen did not land in the first open stage');
  assert.equal(reopened.deal.lostReason, null);
});

// --- The OP8 null-collapse, checked against the verbs' REAL payloads ----------------------------

test('C01 OP8: deal.won/deal.lost resolve from the result exactly when the call closed the deal', () => {
  const { deps, workspaceId, contactId } = world('events');
  const d = call(deps, 'deals_create', workspaceId, { contactId, title: 'Event', valueMinor: 1000, idempotencyKey: 'e-1' });

  const markEvents = eventsEmittedBy('deals_mark');
  assert.deepEqual(markEvents.map((e) => e.event).sort(), ['deal.lost', 'deal.won']);
  const wonDef = markEvents.find((e) => e.event === 'deal.won');
  const lostDef = markEvents.find((e) => e.event === 'deal.lost');

  const input = { dealId: d.dealId, status: 'won', idempotencyKey: 'e-2' };
  const result = call(deps, 'deals_mark', workspaceId, input);
  assert.equal(readPath({ input, result }, wonDef.entityIdPath), d.dealId, 'a genuine win resolved no occurrence');
  assert.equal(readPath({ input, result }, lostDef.entityIdPath), null, 'a win also resolved a loss occurrence');

  // A no-change re-mark is a state assertion: BOTH paths null-collapse and no occurrence exists.
  const again = call(deps, 'deals_mark', workspaceId, { dealId: d.dealId, status: 'won', idempotencyKey: 'e-3' });
  assert.equal(readPath({ input, result: again }, wonDef.entityIdPath), null, 'a re-mark resolved a second win');

  const moveDefs = eventsEmittedBy('deals_move');
  assert.deepEqual(moveDefs.map((e) => e.event), ['deal.stage_changed']);
  assert.equal(moveDefs[0].entityIdPath, 'input.dealId');
});

// --- Activities and the reminder hand-off ------------------------------------------------------

test('C01 OP5: an activity lands on the contact timeline with the dealId stamped, kinds validated at C00', () => {
  const { deps, workspaceId, contactId } = world('act');
  const d = call(deps, 'deals_create', workspaceId, { contactId, title: 'Verlauf', valueMinor: 1000, idempotencyKey: 'a-1' });

  const logged = call(deps, 'deals_log_activity', workspaceId, {
    dealId: d.dealId,
    kind: 'call',
    body: 'Erstgespräch geführt.',
    idempotencyKey: 'a-2',
  });
  assert.equal(logged.ok, true, JSON.stringify(logged));
  assert.equal(logged.taskId, null);
  assert.equal(logged.activity.dealId, d.dealId);

  const invalid = call(deps, 'deals_log_activity', workspaceId, {
    dealId: d.dealId,
    kind: 'unicorn',
    body: 'X',
    idempotencyKey: 'a-3',
  });
  assert.equal(invalid.error, 'invalid_activity_kind');

  const timeline = call(deps, 'contacts_timeline', workspaceId, { contactId });
  assert.ok(timeline.activities.some((a) => a.kind === 'call' && a.dealId === d.dealId));
});

test('C01 OP3: a reminder mints ONE linked E03 task through the dispatch, atomically with the note', () => {
  const { deps, workspaceId, contactId } = world('rem');
  const d = call(deps, 'deals_create', workspaceId, { contactId, title: 'Nachfassen', valueMinor: 1000, idempotencyKey: 'r-1' });

  const logged = call(deps, 'deals_log_activity', workspaceId, {
    dealId: d.dealId,
    kind: 'note',
    body: 'Rückmeldung ausstehend.',
    reminderAt: '2026-09-01T08:00:00.000Z',
    idempotencyKey: 'r-2',
  });
  assert.equal(logged.ok, true, JSON.stringify(logged));
  assert.equal(typeof logged.taskId, 'string');
  const tasks = call(deps, 'tasks_list', workspaceId, { entityKind: 'deal', entityId: d.dealId });
  assert.equal(tasks.tasks.length, 1);
  assert.equal(tasks.tasks[0].id, logged.taskId);
  assert.equal(tasks.tasks[0].reminderAt, '2026-09-01T08:00:00.000Z');

  // A replay under the SAME key mints nothing more (one key covers note + task together).
  const replay = call(deps, 'deals_log_activity', workspaceId, {
    dealId: d.dealId,
    kind: 'note',
    body: 'Rückmeldung ausstehend.',
    reminderAt: '2026-09-01T08:00:00.000Z',
    idempotencyKey: 'r-2',
  });
  assert.equal(replay.ok, true);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM task WHERE workspace_id = ?', workspaceId), 1);

  // A PAST reminder is E03's own refusal, and the OP5 note rolls back WITH it: no half-done write.
  const before = count(deps, 'SELECT COUNT(*) AS n FROM contact_activity WHERE workspace_id = ?', workspaceId);
  const past = call(deps, 'deals_log_activity', workspaceId, {
    dealId: d.dealId,
    kind: 'note',
    body: 'Zu spät.',
    reminderAt: '2020-01-01T08:00:00.000Z',
    idempotencyKey: 'r-3',
  });
  assert.equal(past.error, 'reminder_in_past');
  assert.equal(
    count(deps, 'SELECT COUNT(*) AS n FROM contact_activity WHERE workspace_id = ?', workspaceId),
    before,
    'the OP5 note survived a refused reminder: the composite write is not atomic',
  );
});

// --- The quote hand-off ------------------------------------------------------------------------

test('C01 US-C01.5: to_quote delegates through the dispatch to a REAL quote draft, idempotent on the deal', () => {
  const { deps, workspaceId, contactId } = world('quote');
  const d = call(deps, 'deals_create', workspaceId, { contactId, title: 'Umbau Empfang', valueMinor: 350000, idempotencyKey: 'q-1' });

  const converted = call(deps, 'deals_to_quote', workspaceId, { dealId: d.dealId, idempotencyKey: 'q-2' });
  assert.equal(converted.ok, true, JSON.stringify(converted));
  assert.equal(converted.created, true);

  const doc = call(deps, 'get_document', workspaceId, { documentId: converted.quoteId });
  assert.equal(doc.ok, true);
  assert.equal(doc.document.type, 'quote');
  assert.equal(doc.document.status, 'draft');
  assert.equal(doc.document.contactId, contactId);
  assert.equal(doc.lines.length, 1);
  assert.equal(doc.lines[0].unitPriceMinor, 350000);

  // Idempotent on the DEAL, with or without a key: one quote, ever.
  const again = call(deps, 'deals_to_quote', workspaceId, { dealId: d.dealId, idempotencyKey: 'q-3' });
  assert.equal(again.created, false);
  assert.equal(again.quoteId, converted.quoteId);
  assert.equal(count(deps, `SELECT COUNT(*) AS n FROM document WHERE workspace_id = ? AND type = 'quote'`, workspaceId), 1);

  // And the conversion is on the record (OP5).
  const timeline = call(deps, 'contacts_timeline', workspaceId, { contactId });
  assert.ok(timeline.activities.some((a) => a.body.includes('In Offerte umgewandelt')));
});

// --- §H-TENANT ---------------------------------------------------------------------------------

test('C01 §H-TENANT: every deal verb answers one workspace, never the store', () => {
  const { deps, workspaceId, contactId } = world('tenant');
  const d = call(deps, 'deals_create', workspaceId, { contactId, title: 'Geheim', valueMinor: 1000, idempotencyKey: 't-1' });
  const { workspaceId: other } = mintWorkspace(deps, 'Fremd AG', 'tenant-b');

  // The other workspace sees NO pipeline and NO deal of the first.
  const board = call(deps, 'deals_list', other, {});
  assert.deepEqual(board.pipelines, []);
  assert.deepEqual(board.deals, []);

  // And cannot reach the first workspace's deal by id, through any verb.
  for (const [verb, input] of [
    ['deals_update', { dealId: d.dealId, patch: { title: 'X' }, idempotencyKey: 't-2' }],
    ['deals_move', { dealId: d.dealId, stageId: 'whatever', idempotencyKey: 't-3' }],
    ['deals_mark', { dealId: d.dealId, status: 'won', idempotencyKey: 't-4' }],
    ['deals_log_activity', { dealId: d.dealId, kind: 'note', body: 'X', idempotencyKey: 't-5' }],
    ['deals_to_quote', { dealId: d.dealId, idempotencyKey: 't-6' }],
  ]) {
    const res = call(deps, verb, other, input);
    assert.equal(res.ok, false, `${verb} crossed the tenant boundary`);
    assert.equal(res.error, 'not_found', `${verb} answered ${res.error} instead of not_found`);
  }
  // Nothing in the first workspace moved.
  const intact = call(deps, 'deals_list', workspaceId, {});
  assert.equal(intact.deals[0].title, 'Geheim');
  assert.equal(intact.deals[0].status, 'open');
});

// --- The C00 merge re-point --------------------------------------------------------------------

test('C01: a contact merge re-points the deal to the survivor (the reserved MERGE_REPOINT_FKS row)', () => {
  const { deps, workspaceId, contactId } = world('merge');
  const dup = call(deps, 'create_contact', workspaceId, {
    partyRole: 'customer',
    name: 'Muster AG (Duplikat)',
    idempotencyKey: 'mg-dup',
  });
  const d = call(deps, 'deals_create', workspaceId, {
    contactId: dup.contact.id,
    title: 'Auf dem Duplikat',
    valueMinor: 1000,
    idempotencyKey: 'mg-1',
  });
  const merged = call(deps, 'contacts_merge', workspaceId, {
    sourceId: dup.contact.id,
    targetId: contactId,
    idempotencyKey: 'mg-2',
  });
  assert.equal(merged.ok, true, JSON.stringify(merged));
  const row = deps.store.db
    .prepare('SELECT contact_id FROM deal WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, d.dealId);
  assert.equal(row.contact_id, contactId, 'the merge left the deal pointing at the tombstone');
});
