#!/usr/bin/env node
/**
 * D196 ITEM 9 LIVE VERIFICATION: `reject_drafted_actions`, the batch reject under the owner's grant, proven with
 * real calls against a THROWAWAY `till up` (never the owner's book: a temp TILL_SUPPORT_DIR, a temp TILL_DB_PATH, a
 * port other than 8790, synthetic data invented here). The `verify-d196-live.mjs` shape.
 *
 * The person acts over REST with the Studio key (the human seat); the agent acts over MCP-over-HTTP at `/mcp`
 * with no key, which seats it as the governed `agent`. Every step prints what was sent and what came back.
 *
 * Usage: node scripts/verify-batch-reject-live.mjs <scratch-dir> [port]
 * Needs `npm run build` first.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const scratch = resolve(process.argv[2] ?? join(tmpdir(), `till-batch-reject-verify-${process.pid}`));
const port = Number(process.argv[3] ?? 8812);
if (port === 8790) throw new Error('8790 is the owner\'s Nomadik runtime: pick another port');
const support = join(scratch, 'support');
const dbPath = join(scratch, 'verify.db');
mkdirSync(support, { recursive: true });
if (existsSync(dbPath)) throw new Error(`${dbPath} exists: use a fresh scratch directory`);
const base = `http://127.0.0.1:${port}`;

const log = (line = '') => console.log(line);
const short = (v) => JSON.stringify(v, (k, x) => (k === 'ownerCanGrant' && x && typeof x === 'object' ? { setting: x.setting, value: x.value } : x));
let failures = 0;
const check = (label, cond) => {
  log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures += 1;
};

// --- the throwaway instance ------------------------------------------------------------------------------
const env = { ...process.env, TILL_SUPPORT_DIR: support, TILL_DB_PATH: dbPath, TILL_PORT: String(port), TILL_NO_OPEN: '1', TILL_TICK_MS: '600000' };
const server = spawn(process.execPath, ['bin/till.mjs', 'up', '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
const stop = () => server.kill('SIGTERM');
process.on('exit', stop);

async function waitUp() {
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(join(support, 'studio.key'))) {
      try {
        const r = await fetch(`${base}/api/whoami`, { method: 'POST', body: '{}' });
        if (r.status > 0) return;
      } catch {
        // not yet
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`till up did not start:\n${serverLog}`);
}
await waitUp();
const studioKey = readFileSync(join(support, 'studio.key'), 'utf8').trim();

async function human(verb, input) {
  const r = await fetch(`${base}/api/${verb}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-till-studio-key': studioKey },
    body: JSON.stringify(input),
  });
  return r.json();
}

const agent = new Client({ name: 'batch-reject-verify-agent', version: '1.0.0' });
await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
async function asAgent(verb, input) {
  const r = await agent.callTool({ name: verb, arguments: input });
  return JSON.parse(r.content[0].text);
}

// The book is read (and, for the stated SQL steps, written) through SqliteStore, a second process on the file.
const { SqliteStore } = await import(new URL('../dist/core/store/sqlite-store.js', import.meta.url));
const store = new SqliteStore({ location: dbPath });
const db = store.db;
const q = (sql, ...a) => db.prepare(sql).get(...a);

// --- synthetic fixture --------------------------------------------------------------------------------
log('# D196 item 9 live verification: reject_drafted_actions on a throwaway instance');
log(`till up on ${base}, TILL_SUPPORT_DIR and TILL_DB_PATH under a temp scratch dir. Person: REST + Studio key. Agent: MCP-over-HTTP /mcp, no key.`);
const ws = await human('create_workspace', { name: 'Beispiel Velo GmbH', idempotencyKey: 'br-ws' });
const W = ws.workspaceId;
const acc = (n) => q('SELECT id FROM account WHERE workspace_id = ? AND number = ?', W, n).id;
log(`fixture: workspace ${W} (synthetic), Vorschläge drafted by the agent as post_entry under the default dial (ask)`);

const setSetting = (key, value, k) => human('settings_set', { workspaceId: W, key, value, reason: `verify ${key}=${value}`, idempotencyKey: k });
const setGrant = (value, k) => setSetting('agent.decide_proposals', value, k);
const status = (id) => q('SELECT status, resolved_by AS by, reject_reason AS reason, history_json AS h FROM agent_action WHERE workspace_id = ? AND id = ?', W, id);
const grantEntries = (id) => JSON.parse(status(id).h ?? '[]').filter((e) => e.event === 'decided_under_grant');
const traceRows = (verb) => q('SELECT COUNT(*) AS n FROM agent_call WHERE workspace_id = ? AND verb = ?', W, verb).n;
let seq = 0;
async function drafts(howMany) {
  const ids = [];
  for (let i = 0; i < howMany; i += 1) {
    seq += 1;
    const r = await asAgent('post_entry', {
      workspaceId: W, date: '2026-03-12', description: `Vorschlag ${seq}`, source: 'manual',
      lines: [{ account: acc('6500'), debit: 1000 + seq }, { account: acc('1020'), credit: 1000 + seq }], idempotencyKey: `br-d-${seq}`,
    });
    if (r.drafted !== true) throw new Error(`draft ${seq} did not draft: ${JSON.stringify(r).slice(0, 300)}`);
    ids.push(r.actionId);
  }
  return ids;
}
const REASON = 'Neue Regeln: ich schlage diese Buchungen neu vor.';

// --- (a) off ---------------------------------------------------------------------------------------------
log('\n## (a) agent.decide_proposals = off (the default): the batch refuses before any row is read');
const aIds = await drafts(3);
const aRes = await asAgent('reject_drafted_actions', { workspaceId: W, ids: aIds, reason: REASON });
log(`agent reject_drafted_actions x3 -> ${short({ error: aRes.error, reason: aRes.reason, ownerCanGrant: aRes.ownerCanGrant })}`);
check('refused permission_denied naming agent.decide_proposals', aRes.error === 'permission_denied' && aRes.ownerCanGrant?.setting === 'agent.decide_proposals');
check('all 3 still pending, no single reject ran', aIds.every((id) => status(id).status === 'pending') && traceRows('reject_drafted_action') === 0);

// --- (b) reject level ------------------------------------------------------------------------------------
log('\n## (b) agent.decide_proposals = reject: one call rejects a batch of N');
log(`person settings_set reject -> ok=${(await setGrant('reject', 'g-reject')).ok}`);
const bIds = [...aIds, ...(await drafts(5))];
const bTrace0 = traceRows('reject_drafted_action');
const bNoReason = await asAgent('reject_drafted_actions', { workspaceId: W, ids: bIds });
log(`agent reject_drafted_actions x${bIds.length} WITHOUT a reason -> outcomes=${JSON.stringify(bNoReason.outcomes)}`);
check('no reason under the grant: every id reason_required (agent.reject_reason = required, the default), all pending', bNoReason.outcomes?.reason_required === bIds.length && bIds.every((id) => status(id).status === 'pending'));
// A refused id is a governed single call too, so it lands in the trace like the single verb's refusal does.
check(`each refused id is one traced reject_drafted_action call (${bIds.length})`, traceRows('reject_drafted_action') === bTrace0 + bIds.length);
const bTrace = traceRows('reject_drafted_action');
const bRes = await asAgent('reject_drafted_actions', { workspaceId: W, ids: bIds, reason: REASON });
log(`agent reject_drafted_actions x${bIds.length} with a reason -> ok=${bRes.ok} outcomes=${JSON.stringify(bRes.outcomes)} okCount=${bRes.okCount}`);
check(`all ${bIds.length} rejected by the agent, the reason on every row`, bRes.outcomes?.rejected === bIds.length && bIds.every((id) => status(id).status === 'rejected' && status(id).by === 'agent' && status(id).reason === REASON));
check('one decided_under_grant entry per row naming the grantor and scope reject', bIds.every((id) => grantEntries(id).length === 1 && grantEntries(id)[0].grantedBy === 'studio' && grantEntries(id)[0].scope === 'reject'));
check(`one trace row per id (${bIds.length} new reject_drafted_action calls)`, traceRows('reject_drafted_action') === bTrace + bIds.length);
const bAgain = await asAgent('reject_drafted_actions', { workspaceId: W, ids: bIds, reason: 'ein anderer Grund' });
log(`the same batch again -> outcomes=${JSON.stringify(bAgain.outcomes)}`);
check('idempotent: already_rejected per id, reason not rewritten, one grant entry per row; each id still one traced call', bAgain.outcomes?.already_rejected === bIds.length && bIds.every((id) => status(id).reason === REASON && grantEntries(id).length === 1) && traceRows('reject_drafted_action') === bTrace + 2 * bIds.length);

// --- (c) decide level, mixed batch: an offer and an executed item refused per item ----------------------
log('\n## (c) agent.decide_proposals = decide: a mixed batch, refusals per item');
log(`person settings_set decide -> ok=${(await setGrant('decide', 'g-decide')).ok}`);
const cIds = await drafts(4);
const executed = (await drafts(1))[0];
const ap = await human('approve_drafted_action', { workspaceId: W, actionId: executed });
log(`person approve_drafted_action ${executed} -> ok=${ap.ok} (now executed)`);
// TILL's own offer: drafted by `system` (the rule miner, the Autopilot offer, a Dauerbuchung). Inserted by SQL,
// stated: its organic paths need a rule's history and a scheduler tick; the shape is what the grant reads.
db.prepare("INSERT INTO agent_action (id, workspace_id, actor, dial_capability, action_tool, payload_json, status, created_at) VALUES ('agent_action_sys_offer', ?, 'system', 'post', 'post_entry', ?, 'pending', '2026-03-01T00:00:00Z')")
  .run(W, JSON.stringify({ workspaceId: W, date: '2026-03-12', description: 'TILL Angebot', source: 'manual', lines: [{ account: acc('6500'), debit: 500 }, { account: acc('1020'), credit: 500 }], idempotencyKey: 'br-sys' }));
log('(SQL, stated: one synthetic Vorschlag drafted by system, the actor TILL\'s own offers carry)');
const cBatch = [cIds[0], 'agent_action_sys_offer', executed, cIds[1], 'agent_action_unknown', cIds[2], cIds[3]];
const cRes = await asAgent('reject_drafted_actions', { workspaceId: W, ids: cBatch, reason: REASON });
log(`agent reject_drafted_actions [draft, offer, executed, draft, unknown, draft, draft] -> outcomes=${JSON.stringify(cRes.outcomes)}`);
log(`  per item: ${cRes.items?.map((i) => i.outcome).join(', ')}`);
check('the order of outcomes is rejected, offer_human_only, already_executed, rejected, not_found, rejected, rejected',
  JSON.stringify(cRes.items?.map((i) => i.outcome)) === JSON.stringify(['rejected', 'offer_human_only', 'already_executed', 'rejected', 'not_found', 'rejected', 'rejected']));
check('TILL\'s offer still pending (the person answers it), the executed one still executed', status('agent_action_sys_offer').status === 'pending' && status(executed).status === 'executed');
check('the 4 drafts rejected under the grant decide', cIds.every((id) => status(id).status === 'rejected' && grantEntries(id)[0]?.scope === 'decide'));
const personOffer = await human('reject_drafted_actions', { workspaceId: W, ids: ['agent_action_sys_offer'] });
log(`person reject_drafted_actions [offer] without a reason -> outcomes=${JSON.stringify(personOffer.outcomes)}`);
check('a person keeps full reach: the offer rejected, no reason needed, no grant entry', personOffer.outcomes?.rejected === 1 && status('agent_action_sys_offer').by === 'studio' && grantEntries('agent_action_sys_offer').length === 0);

// --- (d) revoke mid-batch -------------------------------------------------------------------------------
log('\n## (d) revoke MID-BATCH: a person switches the grant off while one batch runs');
log(`person settings_set agent.batch_max_items=400 -> ok=${(await setSetting('agent.batch_max_items', 400, 'g-max')).ok}`);
// The revoke comes from a second process on the book (this script's own connection): the server answers one
// call at a time, so a person's REST settings_set would wait for the batch to finish. Stated, the case (e) shape
// of verify-d196-live.mjs. A second writer commits when it wins SQLite's write lock, not when it is issued (the
// server takes the lock id after id), so the evidence is the count of rejected rows read right AFTER the revoke
// committed: no rejection may outnumber it. Whether the revoke lands inside the batch is timing; up to three
// attempts, each reported.
let landed = false;
for (let attempt = 1; attempt <= 3 && !landed; attempt += 1) {
  await setGrant('decide', `g-decide-mid-${attempt}`);
  const dIds = await drafts(400);
  const inBatch = (st) => q("SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ? AND status = ? AND id IN (SELECT value FROM json_each(?))", W, st, JSON.stringify(dIds)).n;
  const batch = asAgent('reject_drafted_actions', { workspaceId: W, ids: dIds, reason: REASON });
  let issuedAt = null;
  let committedAt = null;
  for (let t = 0; t < 4000 && issuedAt === null; t += 1) {
    const done = inBatch('rejected');
    if (done >= 20) {
      issuedAt = done;
      db.prepare("UPDATE workspace_setting SET value_json = '\"off\"' WHERE workspace_id = ? AND key = 'agent.decide_proposals'").run(W);
      committedAt = inBatch('rejected');
    } else await new Promise((r) => setTimeout(r, 2));
  }
  const dRes = await batch;
  const outcomes = dRes.items?.map((i) => i.outcome) ?? [];
  const firstRefused = outcomes.indexOf('not_permitted');
  const rejected = dRes.outcomes?.rejected ?? 0;
  log(`attempt ${attempt}: (SQL, stated) revoke issued once ${issuedAt} rows were rejected, committed with ${committedAt} rejected; agent reject_drafted_actions x400 -> outcomes=${JSON.stringify(dRes.outcomes)}; first not_permitted at index ${firstRefused}`);
  check(`attempt ${attempt}: no rejection committed after the revoke (rejected outcomes ${rejected} <= rejected rows at the revoke's commit ${committedAt})`, committedAt !== null && rejected <= committedAt);
  check(`attempt ${attempt}: outcomes are rejected, then only not_permitted; the book agrees row for row`,
    outcomes.every((o, i) => o === (firstRefused === -1 || i < firstRefused ? 'rejected' : 'not_permitted')) &&
      inBatch('rejected') === rejected && inBatch('pending') === outcomes.length - rejected &&
      dIds.filter((id) => status(id).status === 'rejected').every((id) => grantEntries(id).length === 1));
  landed = rejected > 0 && firstRefused > 0;
  log(landed ? `  the revoke landed inside the batch: ${rejected} rejected before it, ${outcomes.length - rejected} not_permitted after it` : '  the revoke committed after the batch ended (the second writer waited for the lock); trying again');
}
check('the revoke landed inside one batch within three attempts', landed);

// --- (e) a demoted grantor fails closed ------------------------------------------------------------------
log('\n## (e) a demoted or removed grantor takes the grant with them');
await setGrant('reject', 'g-reject-2');
const inv = await human('invite_member', { workspaceId: W, email: 'grantor@example.invalid', role: 'owner', idempotencyKey: 'e-inv' });
const member = db.prepare("SELECT m.id AS mid, m.user_id AS uid FROM workspace_member m JOIN user u ON u.id = m.user_id WHERE m.workspace_id = ? AND u.email = 'grantor@example.invalid'").get(W);
const eActor = `member:${member.uid}`;
db.prepare('UPDATE user SET actor_id = ? WHERE id = ?').run(eActor, member.uid);
db.prepare("UPDATE workspace_member SET accepted_at = COALESCE(accepted_at, '2026-03-01') WHERE id = ?").run(member.mid);
db.prepare("UPDATE workspace_setting SET updated_by = ? WHERE workspace_id = ? AND key = 'agent.decide_proposals'").run(eActor, W);
log(`person invite_member owner -> ok=${inv.ok}; (SQL, stated: the member accepted, and the stored grant names that member as its signer)`);
const eIds = await drafts(2);
const eOk = await asAgent('reject_drafted_actions', { workspaceId: W, ids: [eIds[0]], reason: REASON });
log(`grant signed by the member (owner): agent batch -> outcomes=${JSON.stringify(eOk.outcomes)}`);
check('in force while its signer holds manage_agent_dial', eOk.outcomes?.rejected === 1);
const demote = await human('set_role', { workspaceId: W, memberId: member.mid, role: 'viewer' });
const eDem = await asAgent('reject_drafted_actions', { workspaceId: W, ids: [eIds[1]], reason: REASON });
log(`person set_role grantor -> viewer: ok=${demote.ok}; agent batch -> ${short({ error: eDem.error, reason: eDem.reason, outcomes: eDem.outcomes })}`);
check('demoted grantor: the batch refuses as a whole, the Vorschlag stays pending', eDem.error === 'permission_denied' && status(eIds[1]).status === 'pending');
const revoke = await human('revoke_member', { workspaceId: W, memberId: member.mid });
const eRem = await asAgent('reject_drafted_actions', { workspaceId: W, ids: [eIds[1]], reason: REASON });
log(`person revoke_member grantor: ok=${revoke.ok}; agent batch -> ${short({ error: eRem.error })}`);
check('removed grantor: still refused, still pending', eRem.error === 'permission_denied' && status(eIds[1]).status === 'pending');

log(`\nRESULT: ${failures === 0 ? 'all checks PASS' : `${failures} check(s) FAIL`}`);
await agent.close();
store.close();
stop();
process.exitCode = failures === 0 ? 0 : 1;
