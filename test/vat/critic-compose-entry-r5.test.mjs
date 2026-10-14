// Critic round 5: the supply-date rule (owner 02.10.2026, keep the stored Leistungsdatum) seen from A07.
// Every workspace, account and figure is synthetic.
//
// A December 2023 sale saved as a draft, reopened through the Studio's own reopen path, moved past a locked
// December by the period way out (booking date 2024-01-01) and posted. The Q1 2024 return must declare it on
// the LEGACY Ziffer 302 at 7.7%, never on 303 at 8.1%.
//  - R5-A07-a: the draft stated its supply date (the composer's own save): holds.
//  - R5-A07-b: the draft stated none (an agent Vorschlag, priced at its entry date 15.12.2023): FAILS on HEAD,
//    the reopen re-prices it at the new booking date and the return files it on 303 (finding R5-S1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { postEntry, saveDraft, getEntry, ledgerPorts, lockPeriod } from '../../dist/core/ledger/index.js';
import { composeEntry } from '../../dist/core/ledger/compose.js';
import { computeVatReturn } from '../../dist/core/vat/index.js';
import { makeContext } from '../../dist/core/context.js';
import { setup } from './support.mjs';

const MODEL = pathToFileURL(fileURLToPath(new URL('../../app/src/surfaces/Journal/composerModel.ts', import.meta.url))).href;
const { reopenState, composerRequest } = await import(MODEL);

function world() {
  const w = setup({ method: 'effektiv' });
  const ctx = makeContext(w.store, { workspaceId: w.workspaceId, actor: 'user_1', clock: w.clock, ids: w.ids, ...ledgerPorts({ store: w.store, workspaceId: w.workspaceId, ids: w.ids }) });
  const accounts = w.store.db.prepare('SELECT id, number, type FROM account WHERE workspace_id = ?').all(w.workspaceId);
  const byNumber = (n) => accounts.find((a) => a.number === n).id;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return { ...w, ctx, byNumber, accountOf: (id) => byId.get(id) };
}

function moveAndPost(w, statedSupply, key) {
  // 1'077.00 gross UST81 in the 7.7% era: net 1'000.00, tax 77.00.
  const sale = { account: w.byNumber('3400'), credit: 100000, taxCode: 'UST81', taxBase: 100000, taxAmount: 7700, ...(statedSupply ? { supplyDate: '2023-12-15' } : {}) };
  const draft = saveDraft(w.ctx, { date: '2023-12-15', lines: [{ account: w.byNumber('1100'), debit: 107700 }, sale, { account: w.byNumber('2200'), credit: 7700 }], idempotencyKey: key });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  const stored = getEntry(w.ctx, { entryId: draft.entryId }).lines;
  const d = composeEntry(w.ctx, { mode: 'decompose', date: '2023-12-15', lines: stored });
  const state = reopenState(d, w.accountOf);
  // The period-lock way out: the booking date moves to the first open day, nothing else is touched.
  const request = composerRequest({ face: state.face, satz: state.satz ?? null, lines: state.lines, manualLock: state.manualLock }, w.accountOf, '2024-01-01');
  const answer = composeEntry(w.ctx, { mode: 'expand', date: '2024-01-01', entryId: draft.entryId, lines: request.lines });
  assert.deepEqual(answer.verdict, { ok: true }, JSON.stringify(answer.verdict));
  const posted = postEntry(w.ctx, { entryId: draft.entryId, date: '2024-01-01', source: 'manual', idempotencyKey: `${key}-p`, lines: answer.lines });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  const r = computeVatReturn(w.ctx, { periodStart: '2024-01-01', periodEnd: '2024-03-31' });
  assert.equal(r.ok, true, JSON.stringify(r));
  return { z302: r.lines.find((l) => l.code === '302'), z303: r.lines.find((l) => l.code === '303') };
}

test('R5-A07-a: a saved line WITH a stated supply date, moved by the way out, files on legacy 302 at 7.7%', () => {
  const w = world();
  assert.equal(lockPeriod(w.ctx, { period: '2023-12', kind: 'soft', idempotencyKey: 'lock' }).ok, true);
  const { z302, z303 } = moveAndPost(w, true, 'stated');
  assert.equal(z302?.taxMinor, 7700);
  assert.equal(z303, undefined);
});

test('R5-A07-b: a saved Vorschlag line with NO supply date (priced at its entry date 15.12.2023), moved by the way out, files on legacy 302 at 7.7%', () => {
  const w = world();
  assert.equal(lockPeriod(w.ctx, { period: '2023-12', kind: 'soft', idempotencyKey: 'lock' }).ok, true);
  const { z302, z303 } = moveAndPost(w, false, 'unstated');
  assert.deepEqual({ z302: z302?.taxMinor ?? null, z303: z303?.taxMinor ?? null }, { z302: 7700, z303: null });
});
