/**
 * G22's MCP prompts, over the REAL MCP wire (an in-memory transport pair around `buildMcpServer`, the
 * same `Server` both the stdio and the StreamableHTTP faces build): `prompts/list` offers one prompt
 * per template with the two arguments, and `prompts/get` renders from `checklist_get` under the
 * session actor, so the prompt's open items EQUAL the verb's open items, in order (spec §2 row 2.3).
 * With no run the prompt names `checklist_start` and the period and invents no state (row 2.4); an
 * unknown prompt is a protocol error; a verb refusal is rendered verbatim.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildMcpServer, renderPromptOverActions } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};

function world(seed, { configured = true } = {}) {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Prompt GmbH', `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  if (configured) {
    must(call('vat_seed_defaults', {}), 'seed');
    must(call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' }), 'method');
  }
  return { deps, wid: workspaceId, call };
}

async function connected(deps) {
  const server = buildMcpServer(deps, { pinnedActor: 'agent' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'g22-prompt-probe', version: '0.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

/** The item ids the prompt text names, in text order: the `(itemId X` tokens. */
function itemIdsIn(text) {
  return [...text.matchAll(/\(itemId ([a-z_0-9]+)/g)].map((m) => m[1]);
}

test('prompts/list offers one prompt per shipped template with workspaceId (required) and period (optional)', async () => {
  const w = world('list');
  const { client, close } = await connected(w.deps);
  try {
    const { prompts } = await client.listPrompts();
    const names = prompts.filter((p) => p.name.startsWith('checklist_')).map((p) => p.name);
    assert.deepEqual(names, ['checklist_vat_period', 'checklist_month_close', 'checklist_year_close'], 'the three shipped templates, in picker order, and never the test fixture');
    for (const [name, label] of [['checklist_vat_period', /MWST-Periode/], ['checklist_month_close', /Monatsabschluss/], ['checklist_year_close', /Jahresabschluss/]]) {
      const prompt = prompts.find((p) => p.name === name);
      assert.ok(prompt, `${name} is offered`);
      assert.deepEqual(prompt.arguments.map((a) => [a.name, a.required]), [['workspaceId', true], ['period', false]]);
      assert.match(prompt.description, label);
    }
  } finally {
    await close();
  }
});

test('prompts/get with no run names checklist_start and the period, and invents no state', async () => {
  const w = world('norun');
  const { client, close } = await connected(w.deps);
  try {
    const res = await client.getPrompt({ name: 'checklist_vat_period', arguments: { workspaceId: w.wid, period: '2026-Q2' } });
    const text = res.messages[0].content.text;
    assert.match(text, /No "MWST-Periode" checklist run exists for 2026-Q2/);
    assert.match(text, /checklist_start \{workspaceId: "/);
    assert.equal(itemIdsIn(text).length, 0);
    // No period argument: the last ended period at the fixture clock (2026-07-16) is 2026-Q2.
    const dflt = await client.getPrompt({ name: 'checklist_vat_period', arguments: { workspaceId: w.wid } });
    assert.match(dflt.messages[0].content.text, /for 2026-Q2 \(2026-04-01 to 2026-06-30\)/);
  } finally {
    await close();
  }
});

test('parity: the prompt lists exactly the open items checklist_get returns, in the same order, as the walk progresses', async () => {
  const w = world('parity');
  const started = must(w.call('checklist_start', { templateId: 'vat_period', period: '2026-Q2', idempotencyKey: 'p-start' }), 'start');
  const { client, close } = await connected(w.deps);
  try {
    const expectOpen = async () => {
      const view = must(w.call('checklist_get', { runId: started.runId }), 'get');
      const wanted = view.items.filter((i) => i.status === 'open').map((i) => i.itemId);
      const res = await client.getPrompt({ name: 'checklist_vat_period', arguments: { workspaceId: w.wid, period: '2026-Q2' } });
      const text = res.messages[0].content.text;
      assert.deepEqual(itemIdsIn(text), wanted, `prompt open items equal checklist_get open items:\n${text}`);
      assert.match(text, new RegExp(`run ${started.runId}, status ${view.status}`));
      return { text, view };
    };
    const first = await expectOpen();
    // The three system checks pass on an empty book, so the first open item is the agent verb item
    // and the prompt names the verb and the completion call for it.
    assert.match(first.text, /call vat_return \{workspaceId: "/);
    assert.match(first.text, /the next actionable one is vat_return_computed/);
    must(w.call('checklist_item_complete', { runId: started.runId, itemId: 'vat_return_computed', idempotencyKey: 'p-4' }), '4');
    must(w.call('checklist_item_complete', { runId: started.runId, itemId: 'abstimmung_reviewed', idempotencyKey: 'p-5' }), '5');
    const mid = await expectOpen();
    assert.match(mid.text, /Done: 5\./);
    must(w.call('checklist_item_skip', { runId: started.runId, itemId: 'ech0217_exported', reason: 'Von Hand.', idempotencyKey: 'p-6' }), 'skip 6');
    const later = await expectOpen();
    assert.match(later.text, /Skipped: 1\./);
    assert.match(later.text, /filed_attestation/);
  } finally {
    await close();
  }
});

test('parity on the close templates: month_close and year_close prompts list exactly the open items checklist_get returns, with the line shapes per kind and the per-period settlement calls', async () => {
  const w = world('close-parity');
  const { client, close } = await connected(w.deps);
  try {
    const expectOpen = async (name, templateId, period) => {
      const started = must(w.call('checklist_start', { templateId, period, idempotencyKey: `cp-${templateId}` }), `start ${templateId}`);
      const view = must(w.call('checklist_get', { runId: started.runId }), 'get');
      const wanted = view.items.filter((i) => i.status === 'open').map((i) => i.itemId);
      const res = await client.getPrompt({ name, arguments: { workspaceId: w.wid, period } });
      const text = res.messages[0].content.text;
      assert.deepEqual(itemIdsIn(text), wanted, `${templateId}: prompt open items equal checklist_get open items:\n${text}`);
      return { text, view, runId: started.runId };
    };
    // The month: the pre-selected Nein is not an answer, the lock is a posting with its undo.
    const month = await expectOpen('checklist_month_close', 'month_close', '2026-06');
    assert.match(month.text, /Pre-selected: no \(not an answer until saved\)/);
    assert.match(month.text, /post through close_month \{workspaceId: "[^"]+", period: "2026-06", idempotencyKey\}.*Reverse with reopen_month/);
    assert.match(month.text, /Excluded by a choice: \d+\./);
    // The year (2025, the last ended year at the fixture clock): the derived choices, the settlement
    // row with its per-period table (Q1 to Q4 of 2025 not filed, so every period waits), the seal.
    const year = await expectOpen('checklist_year_close', 'year_close', '2025');
    assert.match(year.text, /\(itemId vat_settled[^)]*\): post through vat_settlement_post per period under that verb's own gate/);
    assert.match(year.text, /Not filed yet, waits on the MWST-Periode run: 2025-Q1, 2025-Q2, 2025-Q3, 2025-Q4\./);
    assert.match(year.text, /Geschäftsjahr abschliessen \(itemId year_sealed, due 2026-06-30\): waits on/);
    assert.match(year.text, /validation locks_on_all_months \(formula checklists\.validation\.locks_on_all_months\.formula\), result fail, blocks the close until it passes/);
    assert.match(year.text, /a bounded choice, options yes \| no\. No answer yet\. Answer with checklist_item_complete/);
    assert.doesNotMatch(year.text, /needs_a38/);
    // The settlement line names the calls once the quarters are filed.
    for (const q of ['2025-Q1', '2025-Q2', '2025-Q3', '2025-Q4']) must(w.call('vat_mark_filed', { period: q, idempotencyKey: `cp-file-${q}` }), `file ${q}`);
    const filed = await client.getPrompt({ name: 'checklist_year_close', arguments: { workspaceId: w.wid, period: '2025' } });
    assert.doesNotMatch(filed.messages[0].content.text, /itemId vat_settled/, 'an empty year holds vacuously once filed: the row is done and leaves the open list');
    const settled = must(w.call('checklist_get', { runId: year.runId }), 'get year').items.find((i) => i.itemId === 'vat_settled');
    assert.equal(settled.status, 'done');
    assert.deepEqual(settled.probeResult.detail.periods.map((p) => [p.label, p.nothingToSettle]), [['2025-Q1', true], ['2025-Q2', true], ['2025-Q3', true], ['2025-Q4', true]]);
    assert.match(year.text, /Banksaldo per Jahresende laut Bankauszug \(itemId bank_balance_typed[^)]*\): a sign-off through checklist_item_complete .*evidence.ref is the closing balance per the bank statement/);
  } finally {
    await close();
  }
});

test('the prompt rides the session actor: a verb refusal renders verbatim, an unknown prompt is a protocol error', async () => {
  const bare = world('bare', { configured: false });
  const { client, close } = await connected(bare.deps);
  try {
    const res = await client.getPrompt({ name: 'checklist_vat_period', arguments: { workspaceId: bare.wid, period: '2026-Q2' } });
    assert.match(res.messages[0].content.text, /refused .*"needs_vat_config"/);
    await assert.rejects(client.getPrompt({ name: 'checklist_no_such_template', arguments: { workspaceId: bare.wid } }), /unknown_prompt|not found|Unknown/i);
  } finally {
    await close();
  }
});

test('renderPromptOverActions is the exact path the handler uses (exported like callTool)', () => {
  const w = world('direct');
  const started = must(w.call('checklist_start', { templateId: 'vat_period', period: '2026-Q2', idempotencyKey: 'd-start' }), 'start');
  const rendered = renderPromptOverActions({ ...w.deps, actor: 'agent' }, 'checklist_vat_period', { workspaceId: w.wid, period: '2026-Q2' });
  assert.match(rendered.text, new RegExp(`run ${started.runId}`));
  const view = must(w.call('checklist_get', { runId: started.runId }), 'get');
  assert.deepEqual(itemIdsIn(rendered.text), view.items.filter((i) => i.status === 'open').map((i) => i.itemId));
});
