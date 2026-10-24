// A15 money path: D174's two behaviour choices are registry settings (D172), each overridable for one
// run with a required, audited reason.
//
// `dunning.refreeze` (Q1): `re-issue` (default, the critic-passed D174 behaviour: an unsent letter is
// re-frozen without the reversed fee) | `hold` (D169: the frozen demand stands, send holds the letter
// as `fee_reversed`). `dunning.letter_date` (Q9): `run_date` (default) | `today` (a re-issued letter is
// dated the day of the re-issue, fixed at the re-freeze). `dunning_fee_reverse` takes `refreeze` /
// `letterDate` for one run, and needs `overrideReason` for either (`reason_required` on every face).
//
// SYNTHETIC BY CONSTRUCTION: invented names, addresses and amounts; a published-format test QR-IBAN.

import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';
import { fixedClock } from '../../dist/core/clock.js';
import { settingDef } from '../../dist/core/settings/registry.js';
import { freshDeps, mintWorkspace, recordingRelay } from '../api/support.mjs';

const FEE = 3000;
const LATER = '2026-07-23T09:00:00.000Z';
const call = (deps, name, input) => getAction(name).run(deps, input);

function must(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

function world() {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  must(call(deps, 'vat_seed_defaults', { workspaceId }), 'vat_seed_defaults');
  must(call(deps, 'set_vat_method', { workspaceId, vatMethod: 'effektiv', vatAccounting: 'soll' }), 'set_vat_method');
  must(
    call(deps, 'set_creditor_profile', {
      workspaceId,
      creditorName: 'Beispiel Treuhand AG',
      address: { street: 'Seeweg', buildingNo: '7', zip: '6000', town: 'Luzern', country: 'CH' },
      qrIban: 'CH4431999123000889012',
    }),
    'set_creditor_profile',
  );
  must(
    call(deps, 'set_dunning_config', {
      workspaceId,
      levels: [
        { level: 1, daysOverdue: 10, feeMinor: FEE, bookFee: true, feeIncomeAccountId: accId('3600') },
        { level: 2, daysOverdue: 20, feeMinor: 0 },
        { level: 3, daysOverdue: 30, feeMinor: 0 },
      ],
      idempotencyKey: 'cfg',
    }),
    'set_dunning_config',
  );
  return { deps, workspaceId };
}

/** An issued run with one fee-bearing, unsent letter. */
function issuedRun(w, tag = 'A') {
  const { deps, workspaceId } = w;
  const customerId = must(
    call(deps, 'create_contact', {
      workspaceId,
      partyRole: 'customer',
      name: `Kundin ${tag}`,
      address: { street: 'Dorfstrasse', houseNo: '3', zip: '4000', city: 'Basel', country: 'CH' },
      email: `${tag.toLowerCase()}@kundin.example`,
      idempotencyKey: `contact-${tag}`,
    }),
    'create_contact',
  ).contact.id;
  const documentId = must(
    call(deps, 'create_document', {
      workspaceId,
      type: 'invoice',
      contactId: customerId,
      currency: 'CHF',
      dueDate: '2026-06-01',
      lines: [{ description: 'Gartenpflege', unitPriceMinor: 100000, taxCode: 'UST81' }],
      idempotencyKey: `doc-${tag}`,
    }),
    'create_document',
  ).document.id;
  must(call(deps, 'issue_invoice', { workspaceId, invoiceId: documentId, idempotencyKey: `issue-${tag}` }), 'issue_invoice');
  const proposed = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: `p-${tag}` }), 'propose');
  const issued = must(call(deps, 'issue_dunning_run', { workspaceId, runId: proposed.runId, confirmed: true, idempotencyKey: `i-${tag}` }), 'issue');
  const item = issued.items.find((i) => i.documentId === documentId);
  assert.equal(item.demandedFeeMinor, FEE, 'premise: the letter demands the fee');
  return { runId: proposed.runId, customerId, itemId: item.id };
}

const setSetting = (w, key, value, idem = `s-${key}-${value}`) =>
  must(call(w.deps, 'settings_set', { workspaceId: w.workspaceId, key, value, reason: 'Testfall', idempotencyKey: idem }), `set ${key}`);
const reverse = (w, runId, key, extra = {}) =>
  call(w.deps, 'dunning_fee_reverse', { workspaceId: w.workspaceId, runId, reason: 'Gebühr erlassen', idempotencyKey: key, ...extra });
const demanded = (w, id) => w.deps.store.db.prepare('SELECT demanded_fee_minor AS d FROM dunning_item WHERE id = ?').get(id).d;
const audits = (w, action) =>
  w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ? AND action = ?').get(w.workspaceId, action).n;
const view = (w, runId) => must(call(w.deps, 'get_dunning_run', { workspaceId: w.workspaceId, runId }), 'get');
const tableCount = (w) => w.deps.store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;

/** The letter's visible text: every content stream of the PDF, inflated when it is compressed. */
function pdfText(w, runId, debtorId) {
  const raw = Buffer.from(must(call(w.deps, 'get_dunning_pdf', { workspaceId: w.workspaceId, runId, debtorId }), 'pdf').pdf.base64, 'base64');
  let text = raw.toString('latin1');
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw.toString('latin1'))) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    try {
      text += inflateSync(raw.subarray(start, end)).toString('latin1');
    } catch {
      /* an uncompressed or binary stream: already in `text` */
    }
  }
  return text;
}

test('D174 registry: dunning.refreeze is re-issue | hold (default re-issue), dunning.letter_date is run_date | today (default run_date); both owned by dun', () => {
  const r = settingDef('dunning.refreeze');
  assert.deepEqual(r.schema, { type: 'enum', values: ['re-issue', 'hold'] });
  assert.equal(r.default, 're-issue', 'the default is the critic-passed behaviour');
  const d = settingDef('dunning.letter_date');
  assert.deepEqual(d.schema, { type: 'enum', values: ['run_date', 'today'] });
  assert.equal(d.default, 'run_date');
  for (const s of [r, d]) {
    assert.equal(s.owningCapability, 'dun');
    assert.equal(s.dialCapability, 'dun', 'drafted under the family dunning_fee_reverse and send use');
  }
});

test('D174 hold: the reversal re-freezes nothing; send holds the letter as fee_reversed; no table was added', () => {
  const w = world();
  const tables = tableCount(w);
  setSetting(w, 'dunning.refreeze', 'hold');
  const r = issuedRun(w);
  const res = must(reverse(w, r.runId, 'h-1'), 'reverse');
  assert.deepEqual(res.lettersReissuedItemIds, []);
  assert.equal(res.refreeze, 'hold');
  assert.equal(res.overridden, undefined, 'the setting, not an override');
  assert.equal(demanded(w, r.itemId), FEE, 'the frozen demand stands');
  assert.equal(audits(w, 'refreeze_without_fee'), 0);
  assert.equal(view(w, r.runId).items[0].changeSinceIssue, 'fee_reversed');
  const relay = recordingRelay();
  w.deps.emailRelay = relay;
  const sent = must(call(w.deps, 'send_dunning_run', { workspaceId: w.workspaceId, runId: r.runId, confirmed: true, idempotencyKey: 'h-send' }), 'send');
  assert.equal(relay.sent.length, 0, 'the held letter does not leave (the lazy path honours hold too)');
  assert.equal(demanded(w, r.itemId), FEE, 'send re-froze nothing');
  assert.notEqual(sent.outcomes[0].outcome, 'sent');
  assert.equal(tableCount(w), tables, 'D172: a registry entry, never a new table');
});

test('D174 re-issue (the default, unset): the unsent letter is re-frozen and dated the run date', () => {
  const w = world();
  const r = issuedRun(w);
  w.deps.clock = fixedClock(LATER);
  const res = must(reverse(w, r.runId, 'd-1'), 'reverse');
  assert.deepEqual(res.lettersReissuedItemIds, [r.itemId]);
  assert.equal(res.refreeze, 're-issue');
  assert.equal(res.letterDate, 'run_date');
  assert.equal(demanded(w, r.itemId), 0);
  const v = view(w, r.runId);
  assert.equal(v.debtors[0].letterDate, '2026-07-16');
  assert.match(pdfText(w, r.runId, r.customerId), /16\.07\.2026/);
});

test('D174 letter_date today: the re-issued letter carries the re-issue day, and a later change of the setting re-dates nothing', () => {
  const w = world();
  setSetting(w, 'dunning.letter_date', 'today');
  const r = issuedRun(w);
  w.deps.clock = fixedClock(LATER);
  const res = must(reverse(w, r.runId, 't-1'), 'reverse');
  assert.equal(res.letterDate, 'today');
  assert.equal(audits(w, 'refreeze_without_fee_redated'), 1);
  assert.equal(view(w, r.runId).debtors[0].letterDate, '2026-07-23');
  assert.equal(view(w, r.runId).debtors[0].reissuedWithoutFee, true);
  const text = pdfText(w, r.runId, r.customerId);
  assert.match(text, /23\.07\.2026/, 'the letter shows the re-issue day');
  // The choice is fixed at the re-freeze: switching back does not re-date the letter.
  setSetting(w, 'dunning.letter_date', 'run_date', 'back');
  assert.equal(view(w, r.runId).debtors[0].letterDate, '2026-07-23');
});

test('D174 override: refreeze/letterDate for one run need an audited reason, written into the mirror; the setting is unchanged', () => {
  const w = world();
  setSetting(w, 'dunning.refreeze', 'hold');
  const r = issuedRun(w);
  w.deps.clock = fixedClock(LATER);
  const entries = () => w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(w.workspaceId).n;
  const before = entries();
  for (const extra of [{ refreeze: 're-issue' }, { letterDate: 'today' }, { refreeze: 're-issue', overrideReason: '   ' }]) {
    assert.equal(reverse(w, r.runId, `bad-${JSON.stringify(extra)}`, extra).error, 'reason_required', JSON.stringify(extra));
  }
  assert.equal(reverse(w, r.runId, 'bad-v', { refreeze: 'maybe', overrideReason: 'x' }).error, 'invalid_input');
  assert.equal(reverse(w, r.runId, 'bad-r', { overrideReason: 'ohne Schalter' }).error, 'invalid_input');
  assert.equal(entries(), before, 'a refused override writes nothing');
  assert.equal(demanded(w, r.itemId), FEE);

  const res = must(reverse(w, r.runId, 'o-1', { refreeze: 're-issue', letterDate: 'today', overrideReason: 'Kundin hat angerufen' }), 'override');
  assert.equal(res.overridden, true);
  assert.equal(res.overrideReason, 'Kundin hat angerufen');
  assert.deepEqual(res.lettersReissuedItemIds, [r.itemId]);
  assert.equal(demanded(w, r.itemId), 0);
  assert.equal(audits(w, 'refreeze_override'), 1, 'the override is its own audit row');
  const desc = w.deps.store.db.prepare('SELECT description FROM journal_entry WHERE id = ?').get(res.reversalEntryId).description;
  assert.match(desc, /Kundin hat angerufen/, 'the reason stands in the immutable mirror');
  assert.equal(view(w, r.runId).debtors[0].letterDate, '2026-07-23');
  assert.equal(must(call(w.deps, 'settings_get', { workspaceId: w.workspaceId, key: 'dunning.refreeze' }), 'get').setting.value, 'hold', 'the workspace setting is untouched');
});

test('D174 override without a reason: reason_required on the REST face and the MCP face, also for an agent seat, and nothing is drafted', () => {
  const w = world();
  const r = issuedRun(w);
  const input = { workspaceId: w.workspaceId, runId: r.runId, reason: 'Gebühr erlassen', refreeze: 'hold' };
  for (const actor of ['studio', 'agent']) {
    const deps = { ...w.deps, actor };
    const rest = handleRest('dunning_fee_reverse', { ...input, idempotencyKey: `rest-${actor}` }, deps).body;
    assert.equal(rest.error, 'reason_required', `REST ${actor}: ${JSON.stringify(rest)}`);
    const mcp = JSON.parse(callTool(deps, 'dunning_fee_reverse', { ...input, overrideReason: '', idempotencyKey: `mcp-${actor}` }).content[0].text);
    assert.equal(mcp.error, 'reason_required', `MCP ${actor}: ${JSON.stringify(mcp)}`);
  }
  const drafted = w.deps.store.db.prepare("SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ? AND action_tool = 'dunning_fee_reverse'").get(w.workspaceId).n;
  assert.equal(drafted, 0, 'no Vorschlag that could only fail at approval');
  assert.equal(demanded(w, r.itemId), FEE);
  const okRest = handleRest('dunning_fee_reverse', { ...input, overrideReason: 'Brief bleibt liegen', idempotencyKey: 'rest-ok' }, { ...w.deps, actor: 'studio' }).body;
  assert.equal(okRest.ok, true, JSON.stringify(okRest));
  assert.equal(okRest.refreeze, 'hold');
  assert.equal(demanded(w, r.itemId), FEE, 'the override held the letter');
});

test('D174 settings on REST: settings_set and settings_get carry the dunning keys', () => {
  const w = world();
  const deps = { ...w.deps, actor: 'studio' };
  const set = handleRest('settings_set', { workspaceId: w.workspaceId, key: 'dunning.letter_date', value: 'today', reason: 'Testfall', idempotencyKey: 'rs' }, deps).body;
  assert.equal(set.ok, true, JSON.stringify(set));
  const bad = handleRest('settings_set', { workspaceId: w.workspaceId, key: 'dunning.refreeze', value: 'reissue', reason: 'Testfall', idempotencyKey: 'rb' }, deps).body;
  assert.equal(bad.ok, false, 'only the enum values');
  const got = handleRest('settings_get', { workspaceId: w.workspaceId, key: 'dunning.letter_date' }, deps).body;
  assert.equal(got.setting.value, 'today');
  // The Studio's dialog reads the settings in force off the config read.
  const cfg = handleRest('get_dunning_config', { workspaceId: w.workspaceId }, deps).body;
  assert.deepEqual(cfg.settings, { refreeze: 're-issue', letterDate: 'today' });
});

test('D174 replay: the setting is read after the replay, so a replay answers the stored result and writes nothing', () => {
  const w = world();
  const r = issuedRun(w);
  const first = must(reverse(w, r.runId, 'rp-1'), 'reverse');
  assert.deepEqual(first.lettersReissuedItemIds, [r.itemId]);
  setSetting(w, 'dunning.refreeze', 'hold');
  const auditsBefore = w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ?').get(w.workspaceId).n;
  const replay = must(reverse(w, r.runId, 'rp-1'), 'replay');
  assert.deepEqual(replay.lettersReissuedItemIds, first.lettersReissuedItemIds);
  assert.equal(replay.refreeze, 're-issue', 'the stored answer, not the new setting');
  assert.equal(w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ?').get(w.workspaceId).n, auditsBefore, 'idempotent on ROWS');
  assert.equal(reverse(w, r.runId, 'rp-2').error, 'already_reversed', 'a new key posts no second mirror');
});

test('D174 tenant: one workspace setting never governs another workspace', () => {
  const w = world();
  const r = issuedRun(w);
  // The second book sets hold and the today date; the first book's reversal still follows its defaults.
  const other = mintWorkspace(w.deps, 'Fremd GmbH', 'ws-2');
  must(call(w.deps, 'settings_set', { workspaceId: other.workspaceId, key: 'dunning.refreeze', value: 'hold', reason: 'x', idempotencyKey: 'o1' }), 'set other');
  must(call(w.deps, 'settings_set', { workspaceId: other.workspaceId, key: 'dunning.letter_date', value: 'today', reason: 'x', idempotencyKey: 'o2' }), 'set other');
  w.deps.clock = fixedClock(LATER);
  const res = must(reverse(w, r.runId, 'tn-1'), 'reverse');
  assert.equal(res.refreeze, 're-issue');
  assert.equal(res.letterDate, 'run_date');
  assert.deepEqual(res.lettersReissuedItemIds, [r.itemId]);
  assert.equal(view(w, r.runId).debtors[0].letterDate, '2026-07-16');
  // And the other workspace cannot reverse this run under its own settings.
  assert.equal(call(w.deps, 'dunning_fee_reverse', { workspaceId: other.workspaceId, runId: r.runId, reason: 'x', idempotencyKey: 'tn-2' }).error, 'not_found');
});

test('D174 critic r1: a per-run hold override is honoured by send: nothing leaves and the fee stays demanded', () => {
  const w = world();
  const r = issuedRun(w);
  must(reverse(w, r.runId, 'ho-1', { refreeze: 'hold', overrideReason: 'Kundin klärt Gebühr' }), 'hold override');
  assert.equal(demanded(w, r.itemId), FEE);
  const relay = recordingRelay();
  w.deps.emailRelay = relay;
  must(call(w.deps, 'send_dunning_run', { workspaceId: w.workspaceId, runId: r.runId, confirmed: true, idempotencyKey: 'ho-send' }), 'send');
  assert.equal(relay.sent.length, 0, 'the held letter does not leave');
  assert.equal(demanded(w, r.itemId), FEE, 'send re-froze nothing');
  assert.equal(audits(w, 'refreeze_without_fee'), 0);
});

test('D174 critic r1: setting hold at the reversal, switched to re-issue before send: the letter stays held', () => {
  const w = world();
  setSetting(w, 'dunning.refreeze', 'hold');
  const r = issuedRun(w);
  must(reverse(w, r.runId, 'sw-1'), 'reverse under hold');
  setSetting(w, 'dunning.refreeze', 're-issue', 'sw-back');
  const relay = recordingRelay();
  w.deps.emailRelay = relay;
  must(call(w.deps, 'send_dunning_run', { workspaceId: w.workspaceId, runId: r.runId, confirmed: true, idempotencyKey: 'sw-send' }), 'send');
  assert.equal(relay.sent.length, 0);
  assert.equal(demanded(w, r.itemId), FEE, 'the choice was made at the reversal');
});

/**
 * A foreign book's rows that collide with this run on every non-tenant key: a copy of this run's item
 * under another workspace (same run id and debtor, its own id) and an audit row in that workspace on
 * it. Only the `workspace_id` predicates on the audit side keep them out.
 */
function forgeForeign(w, itemId, actions) {
  const other = mintWorkspace(w.deps, 'Fremd GmbH', 'ws-forged');
  const db = w.deps.store.db;
  const cols = db.prepare('PRAGMA table_info(dunning_item)').all().map((c) => c.name);
  const sel = cols.map((c) => (c === 'id' ? "id || '-foreign'" : c === 'workspace_id' ? '?' : c)).join(', ');
  db.pragma?.('foreign_keys = OFF');
  db.prepare(`INSERT INTO dunning_item (${cols.join(', ')}) SELECT ${sel} FROM dunning_item WHERE id = ?`).run(other.workspaceId, itemId);
  for (const action of actions) {
    db.prepare('INSERT INTO audit_log (id, workspace_id, entity_kind, entity_id, action, actor, at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)')
      .run(`forged-${action}`, other.workspaceId, 'dunning_item', `${itemId}-foreign`, action, 'x', '2026-08-30T00:00:00.000Z', 'forged');
  }
}

test('D174 critic r1 §H-TENANT: another book\'s re-freeze rows never date or mark this book\'s letter', () => {
  const w = world();
  const r = issuedRun(w);
  forgeForeign(w, r.itemId, ['refreeze_without_fee_redated', 'refreeze_without_fee']);
  const v = view(w, r.runId);
  assert.equal(v.debtors[0].letterDate, '2026-07-16', 'letterDateOf reads only this book');
  assert.equal(v.debtors[0].reissuedWithoutFee, false, 'the reissued query reads only this book');
  assert.equal(v.items[0].reissuedWithoutFee, false);
});
