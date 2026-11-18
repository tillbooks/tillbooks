// A34 money path: the reason and the audit of a non-regular payroll run (D173, owner decision Q14,
// 15.10.2026; D204, 16.11.2026).
//
// D204 (A03 §11): no run is refused for a missing reason, and `payroll.nonregular_reason` is retired: the
// registry no longer lists it, settings_list does not offer it, and settings_set refuses it unknown_setting. The reason, when given, goes
// into the entry description. EVERY non-regular post writes one audit row whose entity kind names the run kind
// (`payroll_run_bonus`, `payroll_run_thirteenth`, `payroll_run_correction`), whatever the setting; a
// replay writes no second one. Q13: supplementary with a non-regular run stays allowed.
//
// SYNTHETIC BY CONSTRUCTION: no employee, no name, no AHV number; an invented aggregate on the shipped
// KMU chart.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { wageJournalPost } from '../../dist/core/payroll/index.js';
import { settingsSet } from '../../dist/core/settings/index.js';
import { settingDef } from '../../dist/core/settings/registry.js';
import { getAction } from '../../dist/api/registry.js';
import { assertWhoWhen, assertPermission } from '../support/d204.mjs';
import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';

/** The MCP face through the transport dispatch (`runGoverned`), as an agent host calls it. */
const mcpCall = (deps, input) => JSON.parse(callTool(deps, 'wage_journal_post', input).content[0].text);
import { fixture } from '../api/conformance-contract.mjs';
import { makeContext } from '../../dist/core/context.js';
import { setup, counts, wageLines, secondWorkspace } from './support.mjs';

const DATE = '2026-12-05';
const KEY = 'payroll.nonregular_reason';
const KINDS = ['bonus', 'thirteenth', 'correction'];
const AUDIT = { bonus: 'payroll_run_bonus', thirteenth: 'payroll_run_thirteenth', correction: 'payroll_run_correction' };

function must(res, what = 'call') {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}
const post = (ctx, key, extra = {}) =>
  wageJournalPost(ctx, { lines: wageLines(), entryDate: DATE, confirm: true, idempotencyKey: key, ...extra });
const preview = (ctx, extra = {}) => wageJournalPost(ctx, { lines: wageLines(), entryDate: DATE, idempotencyKey: 'pv', ...extra });
const audits = (t, kind) =>
  t.store.db.prepare('SELECT entity_id AS id, actor FROM audit_log WHERE workspace_id = ? AND entity_kind = ? ORDER BY rowid').all(t.workspaceId, kind);
const description = (t, entryId) => t.store.db.prepare('SELECT description FROM journal_entry WHERE id = ?').get(entryId).description;

for (const mode of ['default']) {
  test(`D204 payroll setting ${mode}: each kind posts without a reason, the preview too, and the run-kind audit row names who and when`, () => {
    const t = setup();
    for (const kind of KINDS) {
      for (const blank of [undefined, '', '  ']) {
        const extra = { runKind: kind, ...(blank === undefined ? {} : { runKindReason: blank }), description: 'Lohn' };
        const auditBefore = audits(t, AUDIT[kind]).length;
        const res = must(post(t.ctx, `${kind}-${String(blank)}`, extra), `${mode}/${kind} without a reason`);
        must(preview(t.ctx, extra), `${mode}/${kind} preview`);
        assert.equal(res.runKindReason, undefined, 'no reason echoed when none was given');
        assert.equal(description(t, res.postedEntryId), 'Lohn', 'what was posted, with no empty reason note');
        const rows = audits(t, AUDIT[kind]);
        assert.equal(rows.length, auditBefore + 1, `${mode}/${kind}: one audit row for the run`);
        const row = t.store.db.prepare('SELECT actor, at FROM audit_log WHERE workspace_id = ? AND entity_kind = ? AND entity_id = ?').get(t.workspaceId, AUDIT[kind], res.wageJournalPostId);
        assertWhoWhen(row.actor, row.at, t.ctx.actor);
      }
      const withReason = must(post(t.ctx, `${kind}-r`, { runKind: kind, runKindReason: 'Nachzahlung Dezember', description: 'Lohn' }), `${mode}/${kind} with a reason`);
      assert.equal(withReason.runKindReason, 'Nachzahlung Dezember');
      assert.match(description(t, withReason.postedEntryId), /^Lohn \((Bonus|13\. Monatslohn|Korrektur): Nachzahlung Dezember\)$/);
    }
    assertPermission('wage_journal_post');
  });
}

test('D173 Q14 audit: every non-regular post writes exactly one audit row naming its kind; a replay writes none', () => {
  const t = setup();
  for (const kind of KINDS) {
    const p = must(post(t.ctx, `a-${kind}`, { runKind: kind }), kind);
    assert.deepEqual(audits(t, AUDIT[kind]).map((a) => a.id), [p.wageJournalPostId], `${kind}: one row, on the posting`);
    assert.equal(audits(t, AUDIT[kind])[0].actor, t.ctx.actor, `${kind}: the actor`);
    const before = counts(t.store, t.workspaceId);
    must(post(t.ctx, `a-${kind}`, { runKind: kind }), `${kind} replay`);
    assert.equal(audits(t, AUDIT[kind]).length, 1, `${kind}: the replay writes no second audit row`);
    assert.deepEqual(counts(t.store, t.workspaceId), before);
  }
  // A regular post writes no run-kind audit row, and a regular run takes no run-kind reason.
  const reg = must(post(t.ctx, 'reg'));
  for (const kind of KINDS) assert.ok(!audits(t, AUDIT[kind]).some((a) => a.id === reg.wageJournalPostId));
  assert.equal(post(t.ctx, 'reg-r', { runKindReason: 'wozu' }).error, 'invalid_input');
});

test('D173 Q14 §H-TENANT: each book audits its own runs', () => {
  const t = setup();
  const other = secondWorkspace(t);
  must(wageJournalPost(other.ctx, { lines: wageLines(), entryDate: DATE, confirm: true, runKind: 'correction', idempotencyKey: 'o' }), 'other book');
  assert.equal(audits(t, AUDIT.correction).length, 0, 'the other book\'s audit row is not here');
  must(post(t.ctx, 'c', { runKind: 'correction' }), 'this book, no reason');
  assert.equal(audits(t, AUDIT.correction).length, 1);
});

test('D173 Q13: supplementary with a non-regular run stays allowed, both reasons kept', () => {
  const t = setup();
  const p = must(post(t.ctx, 's', { runKind: 'correction', runKindReason: 'Satz falsch', supplementary: true, supplementaryReason: 'zweite Korrektur', description: 'Lohn' }));
  assert.equal(description(t, p.postedEntryId), 'Lohn (Nachtragsbuchung: zweite Korrektur; Korrektur: Satz falsch)');
  assert.equal(audits(t, 'payroll_supplementary').length, 1);
  assert.equal(audits(t, AUDIT.correction).length, 1);
});

test('D204 payroll faces: a reasonless correction run goes through on REST and MCP, preview included, in any mode', () => {
  const fx = fixture();
  const lines = [
    { accountNumber: '5000', debitMinor: 500000 },
    { accountNumber: '5700', debitMinor: 50000 },
    { accountNumber: '2260', creditMinor: 550000 },
  ];
  const ctx = makeContext(fx.deps.store, { workspaceId: fx.workspaceId, actor: 'studio', clock: fx.deps.clock, ids: fx.deps.ids });
  const human = { ...fx.deps, actor: 'studio' };
  const base = { workspaceId: fx.workspaceId, lines, entryDate: DATE, confirm: true, runKind: 'correction' };
  const rest = handleRest('wage_journal_post', { ...base, idempotencyKey: 'f-rest' }, human).body;
  assert.equal(typeof rest.wageJournalPostId, 'string', JSON.stringify(rest));
  const mcp = mcpCall(human, { ...base, runKindReason: '   ', idempotencyKey: 'f-mcp' });
  assert.equal(typeof mcp.wageJournalPostId, 'string', JSON.stringify(mcp));
  const pv = handleRest('wage_journal_post', { ...base, confirm: undefined, idempotencyKey: 'f-pv' }, human).body;
  assert.equal(pv.ok, true, JSON.stringify(pv));
  // The agent seat drafts the reasonless run (never refused); a replay answers the same Vorschlag.
  const drafted = handleRest('wage_journal_post', { ...base, idempotencyKey: 'f-agent' }, fx.deps).body;
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  const again = handleRest('wage_journal_post', { ...base, idempotencyKey: 'f-agent' }, fx.deps).body;
  assert.deepEqual({ ...again, replayed: undefined }, { ...drafted, replayed: undefined });
  assert.equal(getAction('wage_journal_post').inputSchema.properties.runKindReason.type, 'string');
  // REST and MCP replay the executed original.
  assert.deepEqual(handleRest('wage_journal_post', { ...base, idempotencyKey: 'f-rest' }, human).body, rest, 'REST replays');
});

test('D204 retired: payroll.nonregular_reason is not in the registry, settings_list does not offer it, settings_set refuses it', () => {
  assert.equal(settingDef(KEY), undefined, 'the registry no longer lists it');
  const fx = fixture();
  const ctx = makeContext(fx.deps.store, { workspaceId: fx.workspaceId, actor: 'studio', clock: fx.deps.clock, ids: fx.deps.ids });
  const listed = getAction('settings_list').run({ ...fx.deps, actor: 'studio' }, { workspaceId: fx.workspaceId });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(listed.settings.some((x) => x.key === KEY), false, 'settings_list does not offer it');
  assert.equal(settingsSet(ctx, { key: KEY, value: 'all', idempotencyKey: 'retired' }).error, 'unknown_setting');
});
