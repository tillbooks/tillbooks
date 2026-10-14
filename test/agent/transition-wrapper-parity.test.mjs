/**
 * CRITIC B1 (claude/rmap-land): A GOVERNED WRAPPER IS NOT GOVERNED WHILE ITS ENGINE EDGE IS FREE.
 *
 * `transition_document` is A10's engine verb. Every wrapper that moves a document (`issue_invoice`,
 * `quotes_accept`, `quotes_send`, ...) reaches its status through `transitionDocument`, so a governed
 * wrapper whose status the engine verb reaches ungoverned is a bypass: an agent names the engine verb and
 * no Vorschlag is made. That is how `transition_document {to:'accepted'}` made a sent quote binding with no
 * Vorschlag on MCP, REST, the plugin bridge and automation rules, and (because the bare edge skipped
 * `acceptQuote`) past its expiry, unstamped, with its customer link still live.
 *
 * THE RULE: for every status a GOVERNED wrapper reaches through `transitionDocument`, the engine verb to
 * that status is governed at the wrapper's tier or stricter, unless `UNGOVERNED_EDGE` gives the reason the
 * wrapper's governance is about something the bare edge does not do.
 *
 * WHY THIS GUARD AND NOT A NARROWER `uncovered()` IN dial-covers-d161: that coverage rule reads the map per
 * VERB, and the map has no per-input row, so it cannot know which inputs of an input-keyed verb carry the
 * tagged consequence. This suite is the per-edge guard instead: the wrapper table is checked against the
 * source (a new `transitionDocument(..., to: '<status>')` call site fails here until it is classified), the
 * rule is a function of the maps it is handed, and the bite test removes the accepted rule and is named.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { makeContext } from '../../dist/core/context.js';
import { runPluginToolCall } from '../../dist/core/plugins/sandbox.js';
import { governedDialCapability } from '../../dist/core/agent/ruleTier.js';
import {
  DIAL_SEVERITY,
  INPUT_KEYED_DIAL_RULES,
  dialCapabilitiesForCall,
  dialCapabilitiesForVerb,
} from '../../dist/core/agent/dialMap.js';
import { fixture } from '../api/conformance-contract.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Every verb that reaches a status through `transitionDocument`, the statuses it reaches, and the source
 * file holding the call (checked below against the literal in that file).
 */
const WRAPPER_EDGES = {
  issue_invoice: { statuses: ['issued'], file: 'src/core/sales/invoice.ts' },
  run_due_recurring: { statuses: ['issued'], file: 'src/core/sales/invoice.ts' },
  issue_credit_note: { statuses: ['issued'], file: 'src/core/sales/creditNote.ts' },
  send_invoice: { statuses: ['sent'], file: 'src/core/sales/invoice.ts' },
  ebill_transmit: { statuses: ['sent'], file: 'src/core/sales/ebill.ts' },
  quotes_send: { statuses: ['issued', 'sent'], file: 'src/core/sales/quotes.ts' },
  quotes_accept: { statuses: ['accepted'], file: 'src/core/sales/quotes.ts' },
  portal_quote_accept: { statuses: ['accepted'], file: 'src/core/sales/quotes.ts' },
  quotes_decline: { statuses: ['declined'], file: 'src/core/sales/quotes.ts' },
  quotes_expire_sweep: { statuses: ['expired'], file: 'src/core/sales/quotes.ts' },
  quotes_revise: { statuses: ['superseded'], file: 'src/core/sales/quotes.ts' },
};

/** The edges a governed wrapper reaches that the bare engine verb may take ungoverned, each with why. */
const UNGOVERNED_EDGE = {
  sent:
    'send_invoice, ebill_transmit and quotes_send are governed for what leaves TILL (the email, the eBill, the customer accept link); the bare edge only marks the status and transmits nothing, mints no token',
};

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** Every literal status passed to `transitionDocument(ctx, { ... to: '<status>' ... })` in src/, by file. */
function census() {
  const found = new Map();
  for (const path of sourceFiles(join(ROOT, 'src'))) {
    const text = readFileSync(path, 'utf8');
    for (const m of text.matchAll(/transitionDocument\(\s*ctx,\s*\{([^}]*)\}/g)) {
      const to = /\bto:\s*'([a-z_]+)'/.exec(m[1]);
      if (to === null) continue;
      const file = relative(ROOT, path);
      if (!found.has(file)) found.set(file, new Set());
      found.get(file).add(to[1]);
    }
  }
  return found;
}

const severity = (cap) => {
  const i = DIAL_SEVERITY.indexOf(cap);
  return i === -1 ? DIAL_SEVERITY.length : i;
};

/** The parity rule, as a function of the rules it is handed, so the bite test can weaken them. */
function bypasses(rules = INPUT_KEYED_DIAL_RULES) {
  const out = [];
  for (const [wrapper, { statuses }] of Object.entries(WRAPPER_EDGES)) {
    const wrapperCaps = dialCapabilitiesForVerb(wrapper);
    if (wrapperCaps.length === 0) continue;
    for (const to of statuses) {
      if (UNGOVERNED_EDGE[to] !== undefined) continue;
      const edgeCaps = dialCapabilitiesForCall('transition_document', { documentId: 'doc_x', to }, rules);
      if (edgeCaps.length === 0) out.push(`${wrapper} -> ${to}: transition_document to ${to} is not governed`);
      else if (severity(edgeCaps[0]) > severity(wrapperCaps[0])) {
        out.push(`${wrapper} -> ${to}: transition_document governs it under ${edgeCaps[0]}, looser than ${wrapperCaps[0]}`);
      }
    }
  }
  return out.sort();
}

test('the wrapper table is the source: every literal transitionDocument status is classified, every claimed one exists', () => {
  const found = census();
  const claimedByFile = new Map();
  for (const { statuses, file } of Object.values(WRAPPER_EDGES)) {
    if (!claimedByFile.has(file)) claimedByFile.set(file, new Set());
    for (const s of statuses) claimedByFile.get(file).add(s);
  }
  const unclassified = [];
  for (const [file, statuses] of found) {
    for (const s of statuses) if (!claimedByFile.get(file)?.has(s)) unclassified.push(`${file}: to '${s}'`);
  }
  assert.deepEqual(unclassified, [], 'a transitionDocument call site whose wrapper verb is not in WRAPPER_EDGES');
  const phantom = [];
  for (const [file, statuses] of claimedByFile) {
    for (const s of statuses) if (!found.get(file)?.has(s)) phantom.push(`${file}: to '${s}'`);
  }
  assert.deepEqual(phantom, [], 'WRAPPER_EDGES claims an edge its file does not take');
  for (const wrapper of Object.keys(WRAPPER_EDGES)) assert.ok(getAction(wrapper), `${wrapper}: a registered verb`);
});

test('every status a governed wrapper reaches is governed on transition_document, at the wrapper tier or stricter', () => {
  assert.deepEqual(bypasses(), []);
  assert.deepEqual(dialCapabilitiesForCall('transition_document', { documentId: 'doc_x', to: 'accepted' }), ['issue']);
});

test('IT BITES: without the accepted rule, quotes_accept and portal_quote_accept are named', () => {
  const weakened = INPUT_KEYED_DIAL_RULES.filter((r) => !(r.action === 'transition_document' && r.when({ documentId: 'd', to: 'accepted' })));
  assert.equal(weakened.length, INPUT_KEYED_DIAL_RULES.length - 1);
  assert.deepEqual(bypasses(weakened), [
    'portal_quote_accept -> accepted: transition_document to accepted is not governed',
    'quotes_accept -> accepted: transition_document to accepted is not governed',
  ]);
});

// --- the edge, measured on every face -----------------------------------------------------------------

function sentQuote(validUntil = '2027-01-31') {
  const fx = fixture();
  const c = fx.call('create_contact', { partyRole: 'customer', name: 'Annahme AG', idempotencyKey: 's1' });
  const q = fx.call('quotes_create', { contactId: c.contact.id, validUntil, lines: [{ description: 'Leistung', unitPriceMinor: 20000 }], idempotencyKey: 's2' });
  const sent = fx.call('quotes_send', { quoteId: q.document.id, idempotencyKey: 's3' });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const row = () => fx.deps.store.db.prepare('SELECT status, accepted_by, accept_token_hash IS NOT NULL AS tokenLive FROM document WHERE id = ?').get(q.document.id);
  return { fx, quoteId: q.document.id, row };
}

test('the agent seat: transition_document to accepted is a Vorschlag under issue over MCP and REST, and the quote stays sent', () => {
  const { fx, quoteId, row } = sentQuote();
  const agent = { ...fx.deps, actor: 'agent' };
  const viaMcp = JSON.parse(callTool(agent, 'transition_document', { workspaceId: fx.workspaceId, documentId: quoteId, to: 'accepted', idempotencyKey: 'm1' }).content[0].text);
  assert.equal(viaMcp.drafted, true, JSON.stringify(viaMcp));
  assert.equal(viaMcp.dialCapability, 'issue');
  const viaRest = handleRest('transition_document', { workspaceId: fx.workspaceId, documentId: quoteId, to: 'accepted', idempotencyKey: 'r1' }, agent).body;
  assert.equal(viaRest.drafted, true, JSON.stringify(viaRest));
  assert.deepEqual({ ...row() }, { status: 'sent', accepted_by: null, tokenLive: 1 });
  fx.deps.store.close();
});

test('the plugin bridge refuses the edge needs_a_person, and an automation rule firing it is tiered at issue', () => {
  const { fx, quoteId, row } = sentQuote();
  const invoke = (tool, input, actor) => getAction(tool).run({ ...fx.deps, actor }, input);
  const viaPlugin = runPluginToolCall(invoke, {
    grantedScopes: ['mcp_tool:transition_document'],
    pluginActor: 'studio',
    tool: 'transition_document',
    input: { workspaceId: fx.workspaceId, documentId: quoteId, to: 'accepted' },
  });
  assert.equal(viaPlugin.ok, false, JSON.stringify(viaPlugin));
  assert.equal(viaPlugin.reason, 'needs_a_person');
  assert.equal(row().status, 'sent');
  const ctx = makeContext(fx.deps.store, { workspaceId: fx.workspaceId, actor: 'agent', clock: fx.deps.clock, ids: fx.deps.ids });
  const tier = governedDialCapability(ctx, 'create_automation_rule', {
    workspaceId: fx.workspaceId,
    name: 'Annehmen',
    trigger: { event: 'contact.created' },
    action: { tool: 'transition_document', inputTemplate: { documentId: quoteId, to: 'accepted' } },
  });
  assert.equal(tier, 'issue');
  fx.deps.store.close();
});

test('a person naming the engine verb gets quotes_accept: an expired quote refuses, a live one is stamped and its link spent', () => {
  const lapsed = sentQuote();
  lapsed.fx.deps.store.db.prepare("UPDATE document SET valid_until = '2026-01-31' WHERE id = ?").run(lapsed.quoteId);
  const person = { ...lapsed.fx.deps, actor: 'studio' };
  const refused = getAction('transition_document').run(person, { workspaceId: lapsed.fx.workspaceId, documentId: lapsed.quoteId, to: 'accepted', idempotencyKey: 'p1' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'quote_expired', JSON.stringify(refused));
  assert.deepEqual({ ...lapsed.row() }, { status: 'sent', accepted_by: null, tokenLive: 1 });
  lapsed.fx.deps.store.close();

  const live = sentQuote();
  const human = { ...live.fx.deps, actor: 'studio' };
  const input = { workspaceId: live.fx.workspaceId, documentId: live.quoteId, to: 'accepted', idempotencyKey: 'p2' };
  const accepted = getAction('transition_document').run(human, input);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.document.status, 'accepted');
  assert.deepEqual({ ...live.row() }, { status: 'accepted', accepted_by: 'studio', tokenLive: 0 });
  // The same key replays the same answer and writes nothing twice.
  assert.deepEqual(getAction('transition_document').run(human, input), accepted);
  live.fx.deps.store.close();
});
