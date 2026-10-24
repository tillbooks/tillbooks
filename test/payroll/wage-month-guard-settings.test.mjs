// A34 money path: the month guard is a setting, and a supplementary call overrides it (D173, owner
// decisions Q7 + Q8, 15.10.2026).
//
// `payroll.month_guard` (registry `src/core/settings/registry.ts`): `refuse` (default, Q7), `warn`
// (posts, the result names the standing posting(s)), `off` (no check). `supplementary: true` with a
// non-blank `supplementaryReason` skips the guard for one call, audited, the reason in the entry
// description; without a reason it is refused `reason_required` on every face.
//
// SYNTHETIC BY CONSTRUCTION: no employee, no name, no AHV number; an invented aggregate on the shipped
// KMU chart.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { wageJournalPost } from '../../dist/core/payroll/index.js';
import { settingsSet } from '../../dist/core/settings/index.js';
import { settingDef } from '../../dist/core/settings/registry.js';
import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { fixture } from '../api/conformance-contract.mjs';
import { setup, counts, wageLines, secondWorkspace } from './support.mjs';

const DATE = '2026-07-05';
const KEY = 'payroll.month_guard';

function must(res, what = 'call') {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

const post = (ctx, key, extra = {}) =>
  wageJournalPost(ctx, { lines: wageLines(), entryDate: DATE, confirm: true, idempotencyKey: key, ...extra });

const setGuard = (ctx, value, key = `g-${value}`) =>
  must(settingsSet(ctx, { key: KEY, value, reason: 'Testfall', idempotencyKey: key }), `set ${value}`);

const description = (store, entryId) => store.db.prepare('SELECT description FROM journal_entry WHERE id = ?').get(entryId).description;
const auditRows = (store, workspaceId, kind) =>
  store.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ? AND entity_kind = ?').get(workspaceId, kind).n;

test('D173 registry: payroll.month_guard is refuse | warn | off, default refuse, owned by post, drafted under post', () => {
  const s = settingDef(KEY);
  assert.deepEqual(s.schema, { type: 'enum', values: ['refuse', 'warn', 'off'] });
  assert.equal(s.default, 'refuse');
  assert.equal(s.owningCapability, 'post', 'the capability wage_journal_post needs');
  assert.equal(s.dialCapability, 'post', 'the family wage_journal_post drafts under, never cheaper');
});

test('D173 setting refuse (explicit): a second regular post for the month is refused and writes nothing', () => {
  const t = setup();
  setGuard(t.ctx, 'warn', 'w');
  setGuard(t.ctx, 'refuse', 'r');
  must(post(t.ctx, 'a'));
  const before = counts(t.store, t.workspaceId);
  const again = post(t.ctx, 'b');
  assert.equal(again.error, 'month_already_posted');
  assert.deepEqual(counts(t.store, t.workspaceId), before);
});

test('D173 setting warn: the second post goes through and its result names the standing posting', () => {
  const t = setup();
  setGuard(t.ctx, 'warn');
  const first = must(post(t.ctx, 'a'));
  assert.equal(first.warnings, undefined, 'nothing stands yet, no warning');
  const pv = must(wageJournalPost(t.ctx, { lines: wageLines(), entryDate: DATE, idempotencyKey: 'pv' }), 'preview');
  assert.equal(pv.warnings[0].code, 'month_already_posted', 'the preview warns before the confirm');
  const before = counts(t.store, t.workspaceId);
  const second = must(post(t.ctx, 'b'), 'warned post');
  assert.equal(counts(t.store, t.workspaceId).postings, before.postings + 1, 'posted');
  assert.equal(second.warnings.length, 1);
  assert.equal(second.warnings[0].code, 'month_already_posted');
  assert.equal(second.warnings[0].month, '2026-07');
  assert.deepEqual(second.warnings[0].standing.map((s) => s.wageJournalPostId), [first.wageJournalPostId]);
  // Replay of the warned post returns the stored result, warning included, and writes nothing.
  const after = counts(t.store, t.workspaceId);
  const replay = must(post(t.ctx, 'b'), 'replay');
  assert.equal(replay.wageJournalPostId, second.wageJournalPostId);
  assert.deepEqual(replay.warnings, second.warnings);
  assert.deepEqual(counts(t.store, t.workspaceId), after, 'idempotent on ROWS');
});

test('D173 setting off: no check, no warning', () => {
  const t = setup();
  setGuard(t.ctx, 'off');
  must(post(t.ctx, 'a'));
  const second = must(post(t.ctx, 'b'), 'unchecked post');
  assert.equal(second.warnings, undefined);
  const pv = must(wageJournalPost(t.ctx, { lines: wageLines(), entryDate: DATE, idempotencyKey: 'pv' }));
  assert.equal(pv.warnings, undefined);
  assert.equal(counts(t.store, t.workspaceId).postings, 2);
});

test('D173 setting §H-TENANT: a workspace set to off does not unguard another workspace', () => {
  const t = setup();
  const other = secondWorkspace(t);
  setGuard(other.ctx, 'off');
  must(post(other.ctx, 'o-1'));
  must(post(other.ctx, 'o-2'), 'the other book is off: its second post goes through');
  must(post(t.ctx, 'a'));
  assert.equal(post(t.ctx, 'b').error, 'month_already_posted', 'the default still refuses here');
});

test('D173 supplementary: with a reason it posts next to the standing journal, audited, reason in the description', () => {
  const t = setup();
  must(post(t.ctx, 'a'));
  const auditBefore = auditRows(t.store, t.workspaceId, 'payroll_supplementary');
  const sup = must(post(t.ctx, 'b', { supplementary: true, supplementaryReason: 'Nachzahlung Überstunden', description: 'Lohn Juli' }), 'supplementary');
  assert.equal(sup.supplementary, true);
  assert.equal(sup.supplementaryReason, 'Nachzahlung Überstunden');
  assert.equal(sup.warnings, undefined, 'the guard is skipped, not warned');
  assert.equal(description(t.store, sup.postedEntryId), 'Lohn Juli (Nachtragsbuchung: Nachzahlung Überstunden)');
  assert.equal(auditRows(t.store, t.workspaceId, 'payroll_supplementary'), auditBefore + 1, 'one audit row');
  // The override is for that call only: the next regular call is refused again.
  assert.equal(post(t.ctx, 'c').error, 'month_already_posted');
  // Replay writes nothing a second time.
  const before = counts(t.store, t.workspaceId);
  must(post(t.ctx, 'b', { supplementary: true, supplementaryReason: 'Nachzahlung Überstunden', description: 'Lohn Juli' }));
  assert.deepEqual(counts(t.store, t.workspaceId), before);
  assert.equal(auditRows(t.store, t.workspaceId, 'payroll_supplementary'), auditBefore + 1);
});

test('D173 supplementary without a reason: reason_required on the engine, preview included, writing nothing', () => {
  const t = setup();
  must(post(t.ctx, 'a'));
  const before = counts(t.store, t.workspaceId);
  for (const reason of [undefined, '', '   ']) {
    const extra = reason === undefined ? { supplementary: true } : { supplementary: true, supplementaryReason: reason };
    assert.equal(post(t.ctx, `x${String(reason).length}`, extra).error, 'reason_required');
    const pv = wageJournalPost(t.ctx, { lines: wageLines(), entryDate: DATE, idempotencyKey: 'pv', ...extra });
    assert.equal(pv.error, 'reason_required', 'the preview refuses too');
  }
  // Even with the guard off, a reasonless supplementary call is refused (the reason is the audit).
  setGuard(t.ctx, 'off');
  assert.equal(post(t.ctx, 'y', { supplementary: true }).error, 'reason_required');
  assert.equal(post(t.ctx, 'z', { supplementaryReason: 'ohne Schalter' }).error, 'invalid_input');
  assert.deepEqual(counts(t.store, t.workspaceId), before);
});

test('D173 supplementary without a reason: reason_required on the REST face and the MCP registry face', () => {
  const fx = fixture();
  const lines = [
    { accountNumber: '5000', debitMinor: 500000 },
    { accountNumber: '5700', debitMinor: 50000 },
    { accountNumber: '2260', creditMinor: 550000 },
  ];
  const base = { workspaceId: fx.workspaceId, lines, entryDate: DATE, confirm: true };
  must(fx.call('wage_journal_post', { ...base, idempotencyKey: 'f-1' }), 'first');
  const rest = handleRest('wage_journal_post', { ...base, supplementary: true, idempotencyKey: 'f-rest' }, fx.deps).body;
  assert.equal(rest.error, 'reason_required', JSON.stringify(rest));
  const mcp = getAction('wage_journal_post').run(fx.deps, { ...base, supplementary: true, supplementaryReason: ' ', idempotencyKey: 'f-mcp' });
  assert.equal(mcp.error, 'reason_required', JSON.stringify(mcp));
  const okRest = handleRest('wage_journal_post', { ...base, supplementary: true, supplementaryReason: 'Bonus nachgereicht', idempotencyKey: 'f-ok' }, fx.deps).body;
  assert.equal(okRest.ok, true, JSON.stringify(okRest));
});
