/**
 * CRITIC ROUND 5 (confirmation) PROBES on cl-periods: the R4-1 repair (lock_period refuses the seal
 * reasons; `lockPeriodSealed` is the engine-internal writer). Non-author, adversarial.
 *
 * ADOPTED as regression tests for the R5 fix (D152, 04.10.2026): `lockPeriodSealed` upgrades any lock
 * that is not already a seal, writes under its own idempotency scope and answers the row it holds;
 * `vat_mark_filed` reads every month back inside ONE transaction and refuses (rolling the whole filing
 * back) unless each month holds {hard, vat_filed}. The R5-1, R5-1 (consequence) and R5-2 cases assert
 * the fixed outcome unconditionally.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { getAction, ACTIONS } = await import('../../dist/api/registry.js');
const { callTool } = await import('../../dist/api/mcp.js');
const { handleRest } = await import('../../dist/api/rest.js');
const ledgerIndex = await import('../../dist/core/ledger/index.js');
const { SqliteStore } = await import('../../dist/core/store/sqlite-store.js');
const { fixedClock } = await import('../../dist/core/clock.js');
const { sequenceIdGen } = await import('../../dist/core/ids.js');

let seq = 0;
const key = (tag) => `r5-${tag}-${(seq += 1)}`;

function world() {
  const at = '2027-02-15T09:00:00.000Z';
  const store = new SqliteStore({ clock: fixedClock(at) });
  const deps = { store, clock: fixedClock(at), ids: sequenceIdGen(), actor: 'studio' };
  const res = getAction('create_workspace').run(deps, { name: 'R5 GmbH', idempotencyKey: key('ws') });
  assert.equal(res.ok, true, JSON.stringify(res));
  const ws = res.workspaceId;
  const call = (name, input) => getAction(name).run(deps, { workspaceId: ws, ...input });
  const cfg = call('vat_configure', { method: 'effektiv', timing: 'soll', registered: true, idempotencyKey: key('cfg') });
  assert.equal(cfg.ok, true, JSON.stringify(cfg));
  const accId = (n) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws, n).id;
  const posted = call('post_entry', {
    date: '2026-03-01', source: 'manual', description: 'Büromaterial', idempotencyKey: key('post'),
    lines: [{ account: accId('6500'), debit: 5000 }, { account: accId('1000'), credit: 5000 }],
  });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  return { deps, store, ws, call };
}

const lockOf = (w, period) => w.store.db.prepare('SELECT kind, reason FROM period_lock WHERE workspace_id = ? AND period = ?').get(w.ws, period);
const closes = (w) => w.store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'close'").get(w.ws).n;

test('R5 holds: the internal seal writer is on no wire (registry, MCP, REST, ledger index)', () => {
  const w = world();
  assert.equal(ACTIONS.some((a) => /sealed/i.test(a.name) && a.name !== 'checklist_list'), false, ACTIONS.filter((a) => /seal/i.test(a.name)).map((a) => a.name).join(','));
  assert.equal(getAction('lock_period_sealed'), undefined);
  assert.equal('lockPeriodSealed' in ledgerIndex, false);
  for (const reason of ['year_close', 'vat_filed']) {
    for (const kind of ['hard', 'soft']) {
      const period = reason === 'year_close' ? '2026' : '2026-03';
      const mcp = JSON.parse(callTool(w.deps, 'lock_period', { workspaceId: w.ws, period, kind, reason, idempotencyKey: key('m') }).content[0].text);
      assert.equal(mcp.error, 'reserved_lock_reason', JSON.stringify(mcp));
      const rest = handleRest('lock_period', { workspaceId: w.ws, period, kind, reason, idempotencyKey: key('r') }, w.deps);
      assert.equal(rest.body.error, 'reserved_lock_reason', JSON.stringify(rest.body));
    }
  }
  assert.equal(lockOf(w, '2026'), undefined);
  assert.equal(lockOf(w, '2026-03'), undefined);
});

test('R5 holds: a templated automation reason that RESOLVES to year_close fires nothing sealed', () => {
  const w = world();
  const rule = w.call('create_automation_rule', {
    name: 'Jahr sperren',
    trigger: { event: 'contact.created' },
    action: { tool: 'lock_period', inputTemplate: { period: '2026', kind: 'hard', reason: 'year_close{{nothing}}' } },
    enabled: true,
    idempotencyKey: key('rule'),
  });
  assert.equal(rule.ok, true, JSON.stringify(rule));
  assert.equal(w.call('create_contact', { partyRole: 'customer', name: 'Kunde', idempotencyKey: key('c') }).ok, true);
  assert.equal(lockOf(w, '2026'), undefined);
  const run = w.store.db.prepare('SELECT status, error_code FROM automation_run WHERE workspace_id = ? AND rule_id = ?').get(w.ws, rule.rule.ruleId);
  assert.deepEqual({ ...run }, { status: 'failed', error_code: 'reserved_lock_reason' });
});

test('R5 holds: lookalike reasons are ordinary locks, never seals (exact readers), and close_year still seals over them', () => {
  for (const reason of ['Year_Close', 'year_close ', ' year_close', 'year‐close', 'year_clоse', 'YEAR_CLOSE', 'year_close\u0000']) {
    const w = world();
    const r = w.call('lock_period', { period: '2026', kind: 'hard', reason, idempotencyKey: key('lk') });
    assert.equal(r.ok, true, JSON.stringify(r));
    // Not a seal: unlock_period lifts it.
    const u = w.call('unlock_period', { period: '2026', idempotencyKey: key('u') });
    assert.equal(u.ok, true, `${JSON.stringify(reason)} acted as a seal: ${JSON.stringify(u)}`);
    // And over a re-planted lookalike the real close still sweeps and seals.
    w.call('lock_period', { period: '2026', kind: 'hard', reason, idempotencyKey: key('lk2') });
    const cy = w.call('close_year', { year: '2026', idempotencyKey: key('cy') });
    assert.equal(cy.ok, true, `${JSON.stringify(reason)}: ${JSON.stringify(cy)}`);
    assert.equal(closes(w) > 0, true);
    assert.deepEqual({ ...lockOf(w, '2026') }, { kind: 'hard', reason: 'year_close' });
  }
});

test('R5-1 (fixed): vat_mark_filed over ordinary hard month locks seals every month, and answers the rows it holds', () => {
  const w = world();
  // Review's "Periode sperren" (reason treuhaender_review), and a plain hard lock with no reason.
  assert.equal(w.call('lock_period', { period: '2026-02', kind: 'hard', reason: 'treuhaender_review', idempotencyKey: key('lk') }).ok, true);
  assert.equal(w.call('lock_period', { period: '2026-03', kind: 'hard', idempotencyKey: key('lk') }).ok, true);
  const filed = w.call('vat_mark_filed', { period: '2026-Q1', idempotencyKey: key('file') });
  assert.equal(filed.ok, true, JSON.stringify(filed));
  for (const m of ['2026-01', '2026-02', '2026-03']) {
    assert.deepEqual({ ...lockOf(w, m) }, { kind: 'hard', reason: 'vat_filed' }, `${m} holds ${JSON.stringify(lockOf(w, m))}`);
  }
  assert.deepEqual(filed.locks, [
    { period: '2026-01', kind: 'hard', reason: 'vat_filed' },
    { period: '2026-02', kind: 'hard', reason: 'vat_filed' },
    { period: '2026-03', kind: 'hard', reason: 'vat_filed' },
  ]);
});

test('R5-2 (fixed): a public lock_period cannot pre-claim the idempotency key the filing seal will use', () => {
  const w = world();
  const filingKey = key('file');
  assert.equal(w.call('lock_period', { period: '2026-01', kind: 'soft', idempotencyKey: `${filingKey}:2026-01` }).ok, true);
  const filed = w.call('vat_mark_filed', { period: '2026-Q1', idempotencyKey: filingKey });
  assert.equal(filed.ok, true, JSON.stringify(filed));
  assert.deepEqual({ ...lockOf(w, '2026-01') }, { kind: 'hard', reason: 'vat_filed' },
    `January holds ${JSON.stringify(lockOf(w, '2026-01'))} after a filing that answered ok`);
  // A replay of the filing replays the seals and still holds them.
  assert.equal(w.call('vat_mark_filed', { period: '2026-Q1', idempotencyKey: filingKey }).ok, true);
  assert.deepEqual({ ...lockOf(w, '2026-01') }, { kind: 'hard', reason: 'vat_filed' });
});

test('R5-1 (consequence, fixed): after that filing, the period reads as filed and February does not reopen', () => {
  const w = world();
  assert.equal(w.call('lock_period', { period: '2026-02', kind: 'hard', idempotencyKey: key('lk') }).ok, true);
  const filed = w.call('vat_mark_filed', { period: '2026-Q1', idempotencyKey: key('file') });
  assert.equal(filed.ok, true, JSON.stringify(filed));
  const periods = w.call('vat_periods', { year: '2026' });
  assert.equal(periods.ok, true, JSON.stringify(periods));
  const q1 = periods.periods.find((p) => p.label === '2026-Q1' || p.period === '2026-Q1');
  assert.equal(q1?.filed, true, JSON.stringify(q1));
  const unlocked = w.call('unlock_period', { period: '2026-02', idempotencyKey: key('u') });
  assert.equal(unlocked.error, 'hard_lock_sealed', `a month vat_mark_filed sealed was unlocked: ${JSON.stringify(unlocked)}`);
});

test('R5-1 (belt and braces): a month that does not end up {hard, vat_filed} refuses the filing and rolls every month back', () => {
  const w = world();
  // Stand in for any writer that leaves February unsealed: a trigger strips the seal reason from it.
  w.store.db.exec(`CREATE TRIGGER strip_feb_ins AFTER INSERT ON period_lock WHEN NEW.period = '2026-02'
    BEGIN UPDATE period_lock SET reason = NULL WHERE workspace_id = NEW.workspace_id AND period = '2026-02'; END;`);
  const filed = w.call('vat_mark_filed', { period: '2026-Q1', idempotencyKey: key('file') });
  assert.equal(filed.ok, false, JSON.stringify(filed));
  assert.equal(filed.error, 'filing_seal_not_held');
  assert.equal(filed.month, '2026-02');
  // January was written first in the same call and is rolled back with the rest.
  for (const m of ['2026-01', '2026-02', '2026-03']) assert.equal(lockOf(w, m), undefined, `${m} kept ${JSON.stringify(lockOf(w, m))}`);
  assert.equal(w.store.db.prepare("SELECT COUNT(*) AS n FROM idempotency WHERE workspace_id = ? AND verb = 'lock_period_sealed'").get(w.ws).n, 0);
});

test('hardCloseYear cannot be pre-empted: a lock row on the year (soft, hard, any reason) and a pre-claimed key both still seal with the sweep', () => {
  for (const pre of [{ kind: 'soft' }, { kind: 'hard' }, { kind: 'hard', reason: 'treuhaender_review' }]) {
    const w = world();
    const k = key('cy');
    // The public lock uses the very key close_year will use: a different scope, so nothing is replayed.
    assert.equal(w.call('lock_period', { period: '2026', ...pre, idempotencyKey: k }).ok, true);
    const cy = w.call('close_year', { year: '2026', idempotencyKey: k });
    assert.equal(cy.ok, true, `${JSON.stringify(pre)}: ${JSON.stringify(cy)}`);
    assert.ok(closes(w) > 0, 'the seal came with its sweep');
    assert.deepEqual({ ...lockOf(w, '2026') }, { kind: 'hard', reason: 'year_close' });
    assert.equal(w.call('unlock_period', { period: '2026', idempotencyKey: key('u') }).error, 'hard_lock_sealed');
  }
});

test('R6-1: a public post_entry cannot pre-claim the key the year close posts its P&L sweep under', () => {
  const w = world();
  const closeKey = key('close');
  const accId = (n) => w.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(w.ws, n).id;
  // Anyone who knows (or chose) the close key posts an ordinary entry under `<key>:pl` first.
  const decoy = w.call('post_entry', {
    date: '2026-12-31', source: 'manual', description: 'harmlos', idempotencyKey: `${closeKey}:pl`,
    lines: [{ account: accId('1000'), debit: 1 }, { account: accId('1020'), credit: 1 }],
  });
  assert.equal(decoy.ok, true, JSON.stringify(decoy));
  const cy = w.call('close_year', { year: '2026', idempotencyKey: closeKey });
  const sealedNow = lockOf(w, '2026');
  const pl6500 = w.store.db.prepare(
    `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS n FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
      WHERE e.workspace_id = ? AND e.status = 'posted' AND l.account_id = ? AND e.date <= '2026-12-31'`).get(w.ws, accId('6500')).n;
  if (cy.ok) {
    assert.equal(pl6500, 0, `close_year answered ok and sealed ${JSON.stringify(sealedNow)}, but 6500 still holds ${pl6500} in FY 2026 (closingEntryId ${cy.closingEntryId} = decoy ${decoy.entryId})`);
  }
});
