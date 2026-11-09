// A36 §4.7 (D150), the non-author critic round 1 on the statement gaps: each finding pinned by a test
// that fails without its fix. Synthetic fixtures only (`ebics-support.mjs`). Money-path invariant tests
// are reviewed by a non-author (CLAUDE.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setup } from './support.mjs';
import { syntheticIban, camt053, container, mockBank } from './ebics-support.mjs';
import { createBankAccount, confirmStatementGap, statementGaps } from '../../dist/core/banking/index.js';
import { importCamt } from '../../dist/core/banking/camtReconcile.js';
import { connectBankChannel, syncBankChannel, pendingGapStatements, readStatementGaps } from '../../dist/core/banking/ebics/index.js';
import { bankStatementGapProvider } from '../../dist/core/banking/attentionProviders.js';
import { getAction } from '../../dist/api/registry.js';
import { makeContext } from '../../dist/core/context.js';

function must(res, label) {
  assert.equal(res.ok, true, `${label}: ${JSON.stringify(res)}`);
  return res;
}

let seq = 0;
function account(t, n) {
  seq += 1;
  return must(
    createBankAccount(t.ctx, { name: `Konto ${n}`, iban: syntheticIban(n), ledgerAccountId: t.acc('1020'), idempotencyKey: `ba-${n}-${seq}` }),
    'create_bank_account',
  ).bankAccountId;
}

function imp(t, bankAccountId, xml) {
  seq += 1;
  return must(importCamt(t.ctx, { bankAccountId, xml, idempotencyKey: `imp-${seq}` }), 'import');
}

function acks(t) {
  return t.store.db.prepare('SELECT * FROM bank_statement_gap_ack WHERE workspace_id = ? ORDER BY rowid').all(t.workspaceId);
}

function fedWorld(t, n) {
  const id = account(t, n);
  const bank = mockBank();
  const ctx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: t.clock, ids: t.ids, ebicsTransport: bank.port });
  seq += 1;
  const host = { url: 'https://ebics.example/ebicsweb', hostId: 'SYNTHHST', partnerId: `PARTNERC${seq}`, userId: `USERC${seq}` };
  const c = must(connectBankChannel(ctx, { host, routeBankAccountIds: [id], confirm: true, idempotencyKey: `c-${seq}` }), 'connect');
  const fetched = must(connectBankChannel(ctx, { connectionId: c.connectionId, confirm: true }), 'fetch');
  must(connectBankChannel(ctx, { connectionId: c.connectionId, confirm: true, confirmBankKeys: true, expectedBankKeyHashes: fetched.bankKeyHashes }), 'keys');
  return { id, iban: syntheticIban(n), bank, ctx, connectionId: c.connectionId };
}

test('H1: a chained gap with a refused download inside cannot be confirmed, and the item says money is missing', () => {
  const t = setup();
  const w = fedWorld(t, 61);
  const s182 = imp(t, w.id, camt053({ iban: w.iban, seq: 182, date: '2026-09-22', opening: 40000 }));
  const s187 = imp(t, w.id, camt053({ iban: w.iban, seq: 187, date: '2026-09-29', opening: 40000 }));
  // ZKB delivers 184, which opens CHF 3.00 above 182's close: a gap_refused inside the chained hole.
  w.bank.offer(container([camt053({ iban: w.iban, seq: 184, date: '2026-09-24', opening: 40300 })]));
  const press = must(syncBankChannel(w.ctx, { connectionId: w.connectionId, idempotencyKey: 'h1-press' }), 'press');
  assert.deepEqual(press.statements.map((s) => s.outcome), ['gap_refused']);

  const [gap] = readStatementGaps(w.ctx);
  assert.deepEqual([gap.chains, gap.confirmable, gap.unexplained, gap.refused.map((r) => [r.number, r.differenceMinor])], [true, false, true, [[184, 300]]]);
  const input = { bankAccountId: w.id, afterStatementId: s182.statementId, beforeStatementId: s187.statementId, reason: 'leer', confirmed: true };
  assert.equal(confirmStatementGap(w.ctx, { ...input, idempotencyKey: 'h1-1' }, pendingGapStatements(w.ctx)).error, 'gap_has_waiting_statement');
  // The registry door passes the channel's statements itself.
  const deps = { store: t.store, clock: t.clock, ids: t.ids, actor: 'studio', ebicsTransport: w.bank.port };
  assert.equal(getAction('confirm_statement_gap').run(deps, { workspaceId: t.workspaceId, ...input, idempotencyKey: 'h1-2' }).error, 'gap_has_waiting_statement');
  assert.equal(acks(t).length, 0);
  // The item stays, offers no confirmation, and names the unexplained amount.
  const [item] = bankStatementGapProvider.list(w.ctx, { limit: 5 });
  assert.deepEqual(item.decisionOptions.map((o) => o.id), ['open']);
  assert.equal(item.subtitleKey, 'attention.item.bankStatementGap.subtitleWaitingInside');
  assert.deepEqual([item.subtitleParams.waiting, item.subtitleParams.differenceMinor], [184, 300]);
  assert.equal(item.reasonCode, 'gap_unexplained');
});

test('LOW 2, §H-TENANT: two books with identical statements; a gap and its confirmation in one never reach the other', async () => {
  const { createWorkspace } = await import('../../dist/core/setup/index.js');
  const t = setup();
  const otherWs = createWorkspace(t.deps, { name: 'Zwilling Synthetik AG' }).workspaceId;
  const other = makeContext(t.store, { workspaceId: otherWs, actor: 'user_1', clock: t.clock, ids: t.ids });
  const ledgerB = t.store.db.prepare("SELECT id FROM account WHERE workspace_id = ? AND number = '1020'").get(otherWs).id;
  const iban = syntheticIban(68);
  const a = account(t, 68);
  const b = must(createBankAccount(other, { name: 'Konto 68', iban, ledgerAccountId: ledgerB, idempotencyKey: 'ba-twin' }), 'twin').bankAccountId;
  const day = (n, d) => camt053({ iban, seq: n, date: d, opening: 500 });
  const a1 = imp(t, a, day(1, '2026-04-01'));
  const a3 = imp(t, a, day(3, '2026-04-03'));
  const b1 = must(importCamt(other, { bankAccountId: b, xml: day(1, '2026-04-01'), idempotencyKey: 'twin-1' }), 'b1');
  const b3 = must(importCamt(other, { bankAccountId: b, xml: day(3, '2026-04-03'), idempotencyKey: 'twin-3' }), 'b3');
  must(confirmStatementGap(t.ctx, { bankAccountId: a, afterStatementId: a1.statementId, beforeStatementId: a3.statementId, reason: 'leer', confirmed: true, idempotencyKey: 'same-key' }, []), 'confirm A');
  assert.deepEqual(statementGaps(t.ctx), [], 'A confirmed');
  assert.deepEqual(statementGaps(other).map((g) => g.bankAccountId), [b], "B's gap stays open");
  // B cannot act on A's rows, nor A's key replay into B.
  assert.equal(confirmStatementGap(other, { bankAccountId: a, afterStatementId: a1.statementId, beforeStatementId: a3.statementId, reason: 'x', confirmed: true, idempotencyKey: 'x-1' }, []).error, 'not_found');
  assert.equal(confirmStatementGap(other, { bankAccountId: b, afterStatementId: a1.statementId, beforeStatementId: a3.statementId, reason: 'x', confirmed: true, idempotencyKey: 'x-2' }, []).error, 'gap_not_found');
  const replay = must(confirmStatementGap(other, { bankAccountId: b, afterStatementId: b1.statementId, beforeStatementId: b3.statementId, reason: 'leer', confirmed: true, idempotencyKey: 'same-key' }, []), 'B own');
  assert.equal(replay.bankAccountId, b, 'the same key in B is B\'s own act');
  assert.equal(bankStatementGapProvider.count(other), 0);
});

test('LOW 2, §H-TENANT at the source: every query of the gap model and the bank attention providers is fenced', async () => {
  const { readFileSync } = await import('node:fs');
  for (const file of ['../../src/core/banking/statementGaps.ts', '../../src/core/banking/attentionProviders.ts', '../../src/core/banking/importCamtFiles.ts']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    const queries = [...src.matchAll(/[`'"](\s*(?:SELECT|INSERT|UPDATE|DELETE)\b[\s\S]*?)[`'"]\s*[,)]/g)].map((m) => m[1]);
    assert.ok(queries.length >= 1, `${file}: the probe found the queries it guards`);
    for (const q of queries) {
      // The book version counter reads SQLite's own change counters, no tenant data.
      if (/pragma_data_version/.test(q)) continue;
      if (/^\s*INSERT/.test(q)) {
        assert.match(q, /workspace_id/, `${file}: the write stamps workspace_id: ${q}`);
        continue;
      }
      for (const from of q.matchAll(/FROM\s+(\w+)(?:\s+(\w+))?/g)) {
        const alias = from[2] !== undefined && !/^(WHERE|ORDER|JOIN)$/i.test(from[2]) ? from[2] : from[1];
        assert.match(q, new RegExp(`(${alias}\\.)?workspace_id\\s*=`), `${file}: the read of ${from[1]} is fenced: ${q}`);
      }
    }
  }
});

test('LOW 1: the confirmation table refuses UPDATE and DELETE at the database', () => {
  const t = setup();
  const id = account(t, 67);
  const iban = syntheticIban(67);
  const s1 = imp(t, id, camt053({ iban, seq: 1, date: '2026-04-01', opening: 0 }));
  const s3 = imp(t, id, camt053({ iban, seq: 3, date: '2026-04-03', opening: 0 }));
  must(confirmStatementGap(t.ctx, { bankAccountId: id, afterStatementId: s1.statementId, beforeStatementId: s3.statementId, reason: 'leer', confirmed: true, idempotencyKey: 'l1' }, []), 'confirm');
  assert.throws(() => t.store.db.prepare("UPDATE bank_statement_gap_ack SET action = 'revoke' WHERE workspace_id = ?").run(t.workspaceId), /immutable/);
  assert.throws(() => t.store.db.prepare('DELETE FROM bank_statement_gap_ack WHERE workspace_id = ?').run(t.workspaceId), /never deleted/);
  assert.deepEqual(acks(t).map((r) => r.action), ['confirm']);
});

test('LOW 6: the latest ack row decides by insertion order, whatever the clock said', async () => {
  const { fixedClock } = await import('../../dist/core/clock.js');
  const t = setup();
  const id = account(t, 69);
  const iban = syntheticIban(69);
  const s1 = imp(t, id, camt053({ iban, seq: 1, date: '2026-04-01', opening: 0 }));
  const s3 = imp(t, id, camt053({ iban, seq: 3, date: '2026-04-03', opening: 0 }));
  const input = { bankAccountId: id, afterStatementId: s1.statementId, beforeStatementId: s3.statementId, confirmed: true };
  const at = (iso) => makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: fixedClock(iso), ids: t.ids });
  must(confirmStatementGap(at('2026-10-02T10:00:00.000Z'), { ...input, reason: 'leer', idempotencyKey: 'o-1' }, []), 'confirm');
  // A second machine whose clock runs behind withdraws it a moment later.
  const { revokeStatementGapConfirmation } = await import('../../dist/core/banking/index.js');
  must(revokeStatementGapConfirmation(at('2026-10-02T09:00:00.000Z'), { ...input, reason: 'doch nicht', idempotencyKey: 'o-2' }, []), 'revoke');
  assert.equal(statementGaps(t.ctx).length, 1, 'the withdrawal, written last, decides: the gap is open');
});

test('LOW 7: a reused call key with other files is not answered with the first report', async () => {
  const { importCamtFiles } = await import('../../dist/core/banking/index.js');
  const t = setup();
  const id = account(t, 70);
  const iban = syntheticIban(70);
  const first = must(importCamtFiles(t.ctx, { bankAccountId: id, files: [{ name: 'a', xml: camt053({ iban, seq: 1, date: '2026-04-01', opening: 0 }) }], idempotencyKey: 'k' }), 'first');
  assert.deepEqual(first.statements.map((s) => [s.number, s.outcome]), [[1, 'imported']]);
  const second = must(importCamtFiles(t.ctx, { bankAccountId: id, files: [{ name: 'b', xml: camt053({ iban, seq: 2, date: '2026-04-02', opening: 0 }) }], idempotencyKey: 'k' }), 'second');
  assert.deepEqual(second.statements.map((s) => [s.number, s.outcome]), [[2, 'imported']], 'the second file is imported and reported');
  // The same key with the same files is still a replay.
  const again = importCamtFiles(t.ctx, { bankAccountId: id, files: [{ name: 'b', xml: camt053({ iban, seq: 2, date: '2026-04-02', opening: 0 }) }], idempotencyKey: 'k' });
  assert.deepEqual(again, second);
});

test('M2: a split statement in the books is a present number; one with a page missing is named incomplete, never "missing"', () => {
  const t = setup();
  const whole = account(t, 65);
  const iw = syntheticIban(65);
  imp(t, whole, camt053({ iban: iw, seq: 4, date: '2026-05-04', opening: 1000 }));
  imp(t, whole, camt053({ iban: iw, seq: 5, date: '2026-05-05', opening: 1000, entries: [{ minor: 200 }], page: { number: 1, last: false } }));
  imp(t, whole, camt053({ iban: iw, seq: 5, date: '2026-05-05', opening: 1200, entries: [{ minor: 300 }], page: { number: 2, last: true } }));
  imp(t, whole, camt053({ iban: iw, seq: 6, date: '2026-05-06', opening: 1500 }));
  assert.deepEqual(statementGaps(t.ctx, { bankAccountId: whole }), [], 'statement 5 is in the books, in two pages');

  const part = account(t, 66);
  const ip = syntheticIban(66);
  imp(t, part, camt053({ iban: ip, seq: 4, date: '2026-05-04', opening: 1000 }));
  imp(t, part, camt053({ iban: ip, seq: 5, date: '2026-05-05', opening: 1000, entries: [{ minor: 200 }], page: { number: 1, last: false } }));
  imp(t, part, camt053({ iban: ip, seq: 7, date: '2026-05-07', opening: 1500 }));
  const gaps = statementGaps(t.ctx, { bankAccountId: part });
  assert.deepEqual(gaps.map((g) => [g.after.number, g.before.number, g.missing, g.after.incomplete === true, g.chains, g.confirmable]), [[5, 7, [{ year: 2026, from: 6, to: 6 }], true, false, false]]);
  const [item] = bankStatementGapProvider.list(t.ctx, { limit: 5 });
  assert.deepEqual([item.subtitleKey, item.subtitleParams.incomplete], ['attention.item.bankStatementGap.subtitleIncomplete', 5]);
});

test('M1: a year turn to number 1 is a gap when days are missing or the balances do not chain, and never an empty range', () => {
  const t = setup();
  // 29.12.2025 to 5.1.2026, chained: 30.12 and 31.12 may be missing.
  const a = account(t, 62);
  imp(t, a, camt053({ iban: syntheticIban(62), seq: 250, date: '2025-12-29', opening: 7000 }));
  imp(t, a, camt053({ iban: syntheticIban(62), seq: 1, date: '2026-01-05', opening: 7000 }));
  // 31.12.2025 to 2.1.2026, chained: only the holiday 1.1 lies between, a normal year end.
  const b = account(t, 63);
  imp(t, b, camt053({ iban: syntheticIban(63), seq: 251, date: '2025-12-31', opening: 100 }));
  imp(t, b, camt053({ iban: syntheticIban(63), seq: 1, date: '2026-01-02', opening: 100 }));
  // An unchained year turn to 1, the very next day: money is missing whatever the dates say.
  const c = account(t, 64);
  imp(t, c, camt053({ iban: syntheticIban(64), seq: 200, date: '2025-12-31', opening: 100 }));
  imp(t, c, camt053({ iban: syntheticIban(64), seq: 1, date: '2026-01-02', opening: 900 }));

  const gaps = statementGaps(t.ctx);
  const ga = gaps.find((g) => g.bankAccountId === a);
  assert.deepEqual([ga.missing, ga.oldYearTailUnknown, ga.chains, ga.missingDates], [[], true, true, { from: '2025-12-30', to: '2026-01-04' }]);
  assert.equal(gaps.find((g) => g.bankAccountId === b), undefined, 'a normal year end is no gap');
  const gc = gaps.find((g) => g.bankAccountId === c);
  assert.deepEqual([gc.missing, gc.chains, gc.differenceMinor, gc.confirmable], [[], false, 800, false]);

  const items = bankStatementGapProvider.list(t.ctx, { limit: 5 });
  const ia = items.find((i) => i.titleParams.after === '250/2025');
  assert.equal(ia.titleKey, 'attention.item.bankStatementGap.titleUnknownDays');
  assert.ok(items.every((i) => i.titleKey.includes('Unknown') || i.titleParams.range !== ''), 'no title renders an empty range');
});
