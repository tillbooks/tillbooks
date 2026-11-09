/**
 * C01's MONEY-PATH ABSENCE, asserted structurally: a deal's value is an estimate, never a ledger
 * row, so the deals engine must be INCAPABLE of posting rather than merely polite about it.
 *
 * The probe reads the SOURCE off disk and greps imports, and it proves itself non-vacuous by
 * finding the same symbols where they legitimately live (the invariant every structural guard in
 * this repo carries: a probe that matches nothing anywhere asserts nothing). The behavioural half
 * rides beside it: a full deal lifecycle leaves the journal exactly as it found it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const DEALS_DIR = fileURLToPath(new URL('../../src/core/deals/', import.meta.url));

const FORBIDDEN = [
  // The single posting path and the settlement half: a deals module importing either is a deal
  // becoming a ledger row, which is the boundary the spec's §4 draws (P3: nothing to post).
  'postEntry',
  'recordPayment',
  '/ledger/',
  '/payments/',
];

/** Every import statement of one source, so a docblock MENTIONING a symbol cannot trip the probe. */
function importsOf(text) {
  return [...text.matchAll(/^import[\s\S]*?from\s+'[^']+';/gm)].map((m) => m[0]);
}

test('C01 P3: the deals engine imports neither the posting path nor the settlement half', () => {
  const sources = readdirSync(DEALS_DIR).filter((f) => f.endsWith('.ts'));
  assert.ok(sources.length >= 5, `the probe found only ${sources.length} deals sources; the path is wrong`);
  for (const file of sources) {
    const imports = importsOf(readFileSync(`${DEALS_DIR}${file}`, 'utf8')).join('\n');
    for (const forbidden of FORBIDDEN) {
      assert.equal(
        imports.includes(forbidden),
        false,
        `src/core/deals/${file} imports ${forbidden}: the deals engine has grown a money path`,
      );
    }
  }
  // Non-vacuous: the SAME probe finds the symbols where they legitimately live.
  const registryImports = importsOf(
    readFileSync(fileURLToPath(new URL('../../src/api/registry.ts', import.meta.url)), 'utf8'),
  ).join('\n');
  assert.ok(registryImports.includes('postEntry'), 'the probe cannot find the postEntry import even in the registry');
  assert.ok(registryImports.includes('/ledger/'), 'the probe cannot find a ledger import even in the registry');
  const paymentImports = importsOf(
    readFileSync(fileURLToPath(new URL('../../src/api/payment-actions.ts', import.meta.url)), 'utf8'),
  ).join('\n');
  assert.ok(paymentImports.includes('recordPayment'), 'the probe cannot find recordPayment even in payment-actions');
});

test('C01 P3: a full deal lifecycle writes NOT ONE journal row', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Kein Buchungssatz AG', 'nmp-ws');
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });

  const contact = call('create_contact', { partyRole: 'customer', name: 'Muster AG', idempotencyKey: 'nmp-c' });
  const journalRows = () =>
    deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n;
  const before = journalRows();

  const d = call('deals_create', { contactId: contact.contact.id, title: 'Estimate only', valueMinor: 999999, idempotencyKey: 'nmp-1' });
  assert.equal(d.ok, true, JSON.stringify(d));
  const board = call('deals_list', {});
  call('deals_move', { dealId: d.dealId, stageId: board.stages[1].id, idempotencyKey: 'nmp-2' });
  call('deals_update', { dealId: d.dealId, patch: { valueMinor: 888888 }, idempotencyKey: 'nmp-3' });
  call('deals_log_activity', { dealId: d.dealId, kind: 'note', body: 'Kein Geld bewegt.', idempotencyKey: 'nmp-4' });
  call('deals_mark', { dealId: d.dealId, status: 'won', idempotencyKey: 'nmp-5' });
  call('deals_mark', { dealId: d.dealId, status: 'open', idempotencyKey: 'nmp-6' });
  call('pipelines_upsert', { name: 'Zweite', idempotencyKey: 'nmp-7' });

  assert.equal(journalRows(), before, 'a deal verb posted into the journal');

  // The ONE legal route to money: to_quote mints a DRAFT document (still no posting; A10/A11 own
  // everything after this moment, behind their own gates).
  const converted = call('deals_to_quote', { dealId: d.dealId, idempotencyKey: 'nmp-8' });
  assert.equal(converted.ok, true);
  assert.equal(journalRows(), before, 'converting to a quote DRAFT posted into the journal');
});
