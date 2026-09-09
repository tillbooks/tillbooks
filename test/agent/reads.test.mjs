/**
 * A26 the read models: `ledger_qa`, `month_end_checklist`, `detect_anomalies`.
 *
 * These are pure reads (readOnlyHint), so the conformance gate already proves they never mutate. These
 * assertions prove they ANSWER: the Q&A classifies and reconciles a turnover figure to the ledger, the
 * checklist surfaces dangling drafts and the honest A22 not_available item, and anomaly detection flags
 * a seeded duplicate and a stale draft without auto-correcting.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { classifyQuestion } from '../../dist/core/agent/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

function call(deps, workspaceId, name, input) {
  return getAction(name).run(deps, { workspaceId, ...input });
}

function incomeAccount(deps, workspaceId) {
  return deps.store.db
    .prepare("SELECT number FROM account WHERE workspace_id = ? AND type = 'income' LIMIT 1")
    .get(workspaceId).number;
}

test('classifyQuestion maps de-CH and en phrasings to intents', () => {
  assert.equal(classifyQuestion('Umsatz Q2?'), 'revenue');
  assert.equal(classifyQuestion('what was our revenue'), 'revenue');
  assert.equal(classifyQuestion('offene Posten?'), 'open_items');
  assert.equal(classifyQuestion('outstanding receivables'), 'open_items');
  assert.equal(classifyQuestion('MWST fällig?'), 'vat');
  assert.equal(classifyQuestion('how is the weather'), 'unknown');
});

test('ledger_qa: turnover reconciles to the posted income accounts to the Rappen', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const income = incomeAccount(deps, workspaceId);

  // Post CHF 842.00 of revenue: debit cash, credit the income account.
  const posted = call(deps, workspaceId, 'post_entry', {
    date: '2026-04-15',
    source: 'manual',
    idempotencyKey: 'rev-1',
    lines: [
      { account: accId('1000'), debit: 84200 },
      { account: accId(income), credit: 84200 },
    ],
  });
  assert.equal(posted.ok, true, JSON.stringify(posted));

  const qa = call(deps, workspaceId, 'ledger_qa', { question: 'Umsatz 2026?', periodStart: '2026-01-01', periodEnd: '2026-12-31' });
  assert.equal(qa.ok, true);
  assert.equal(qa.intent, 'revenue');
  assert.equal(qa.figures.revenueMinor, 84200);
  assert.ok(qa.entryIds.length >= 1, 'a drill-down entry id is returned');
  deps.store.close();
});

test('ledger_qa: a VAT question without a period is refused, never guessed', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const res = call(deps, workspaceId, 'ledger_qa', { question: 'MWST?' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'needs_period');
  deps.store.close();
});

test('month_end_checklist: dangling drafts are surfaced and FX revaluation is honestly not_available', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  call(deps, workspaceId, 'save_draft', {
    date: '2026-03-10',
    lines: [
      { account: accId('6500'), debit: 4200 },
      { account: accId('1000'), credit: 4200 },
    ],
    idempotencyKey: 'draft-1',
  });

  const res = call(deps, workspaceId, 'month_end_checklist', { period: '2026-03' });
  assert.equal(res.ok, true);
  const drafts = res.items.find((i) => i.kind === 'dangling_drafts');
  assert.ok(drafts && drafts.count >= 1, 'the pending draft is on the checklist');
  const fx = res.items.find((i) => i.kind === 'fx_revaluation');
  assert.equal(fx.status, 'not_available', 'A22 revaluation is reported as not built, not silently dropped');
  deps.store.close();
});

test('month_end_checklist rejects a malformed period', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const res = call(deps, workspaceId, 'month_end_checklist', { period: '2026' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_input');
  deps.store.close();
});

test('detect_anomalies: a seeded duplicate and a stale draft are flagged, never auto-corrected', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  // Two identical postings on the same day and amount: a probable duplicate.
  for (const key of ['dup-a', 'dup-b']) {
    call(deps, workspaceId, 'post_entry', {
      date: '2026-02-02',
      source: 'manual',
      idempotencyKey: key,
      lines: [
        { account: accId('6500'), debit: 12300 },
        { account: accId('1000'), credit: 12300 },
      ],
    });
  }
  call(deps, workspaceId, 'save_draft', {
    date: '2026-02-05',
    lines: [
      { account: accId('6500'), debit: 100 },
      { account: accId('1000'), credit: 100 },
    ],
    idempotencyKey: 'stale-1',
  });

  const res = call(deps, workspaceId, 'detect_anomalies', {});
  assert.equal(res.ok, true);
  const kinds = res.anomalies.map((a) => a.kind);
  assert.ok(kinds.includes('probable_duplicate'), 'the duplicate is flagged');
  assert.ok(kinds.includes('stale_draft'), 'the lingering draft is flagged');
  const dup = res.anomalies.find((a) => a.kind === 'probable_duplicate');
  assert.equal(dup.entryIds.length, 2, 'both sides of the duplicate are named');

  // A read: it changed no posted rows into anything (the two duplicates are still both posted).
  const posted = deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'")
    .get(workspaceId);
  assert.equal(posted.n, 2, 'anomaly detection never auto-corrects');
  deps.store.close();
});
