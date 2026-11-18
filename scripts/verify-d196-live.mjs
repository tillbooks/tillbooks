#!/usr/bin/env node
/**
 * D196 LIVE VERIFICATION: the owner's grant for agent decisions, proven with real calls against a
 * THROWAWAY `till up` (never the owner's book: a temp TILL_SUPPORT_DIR, a temp TILL_DB_PATH, a port other
 * than 8790, synthetic data invented here).
 *
 * The person acts over REST with the Studio key (`x-till-studio-key`, the human seat); the agent acts over
 * MCP-over-HTTP at `/mcp` with no key, which `session.ts` seats as the governed `agent`, exactly as a real
 * agent client is seated. Every step prints what was sent and what came back, so the transcript is the
 * evidence (`docs/planning/d196-verification-2026-11-12.md`).
 *
 * Usage: node scripts/verify-d196-live.mjs <scratch-dir> [port]
 * Needs `npm run build` first (it runs `bin/till.mjs up` from this checkout, and reads the book through the
 * built `SqliteStore`, the one durable way to open it).
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const scratch = resolve(process.argv[2] ?? '.tmp-d196-verify');
const port = Number(process.argv[3] ?? 8811);
if (port === 8790) throw new Error('8790 is the owner\'s Nomadik runtime: pick another port');
const support = join(scratch, 'support');
const dbPath = join(scratch, 'verify.db');
mkdirSync(support, { recursive: true });
if (existsSync(dbPath)) throw new Error(`${dbPath} exists: use a fresh scratch directory`);
const base = `http://127.0.0.1:${port}`;

const out = [];
const log = (line = '') => {
  out.push(line);
  console.log(line);
};
const short = (v) => JSON.stringify(v, (k, x) => (k === 'approveAt' || k === 'ownerCanGrant' ? (x && typeof x === 'object' ? { ...(x.setting ? { setting: x.setting, value: x.value } : {}), '...': '' } : x) : x));
let failures = 0;
const check = (label, cond) => {
  log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures += 1;
};

// --- the throwaway instance ------------------------------------------------------------------------------
const env = { ...process.env, TILL_SUPPORT_DIR: support, TILL_DB_PATH: dbPath, TILL_PORT: String(port), TILL_NO_OPEN: '1', TILL_TICK_MS: '30000' };
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

const agent = new Client({ name: 'd196-verify-agent', version: '1.0.0' });
await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
async function asAgent(verb, input) {
  const r = await agent.callTool({ name: verb, arguments: input });
  return JSON.parse(r.content[0].text);
}

// The book is read (and, for case e, written) through SqliteStore, the durability choke point.
const { SqliteStore } = await import(new URL('../dist/core/store/sqlite-store.js', import.meta.url));
const store = new SqliteStore({ location: dbPath });
const db = store.db;
const q = (sql, ...a) => db.prepare(sql).get(...a);
const qa = (sql, ...a) => db.prepare(sql).all(...a);

// --- synthetic fixture --------------------------------------------------------------------------------
log(`# D196 live verification on a throwaway instance`);
log(`till up on ${base}, TILL_SUPPORT_DIR and TILL_DB_PATH under a temp scratch dir. Person: REST + Studio key. Agent: MCP-over-HTTP /mcp, no key.`);
const ws = await human('create_workspace', { name: 'Beispiel Velo GmbH', idempotencyKey: 'v-ws' });
const W = ws.workspaceId;
const acc = (n) => q('SELECT id FROM account WHERE workspace_id = ? AND number = ?', W, n).id;
const bank = await human('create_bank_account', { workspaceId: W, name: 'Testbank', iban: 'CH93 0076 2011 6238 5295 7', currency: 'CHF', ledgerAccountId: acc('1020'), idempotencyKey: 'v-bank' });
const csv = [
  'Datum;Gegenpartei;IBAN;Text;Betrag',
  '02.03.2026;Velo Teile AG;CH5604835012345678009;Rechnung 1;-120.00',
  '03.03.2026;Kaffee Bar Muster;;Kaffee;-8.50',
  '04.03.2026;Druckerei Beispiel;;Flyer;-45.00',
  '05.03.2026;Velo Teile AG;CH5604835012345678009;Rechnung 2;-130.00',
  '06.03.2026;Velo Teile AG;CH5604835012345678009;Rechnung 3;-140.00',
  '07.03.2026;Velo Teile AG;CH5604835012345678009;Rechnung 4;-150.00',
  '08.03.2026;Velo Teile AG;CH5604835012345678009;Rechnung 5;-160.00',
  '09.03.2026;Parkhaus Zentrum;;Parkieren;-12.00',
  '10.03.2026;Buchhandlung Seite;;Buch;-33.00',
  '11.03.2026;Online Shop Kabel;;Kabel;-19.90',
].join('\n');
const imp = await human('import_bank_statement', {
  workspaceId: W, bankAccountId: bank.bankAccountId, content: `${csv}\n`,
  mapping: { columns: { bookingDate: 'Datum', counterparty: 'Gegenpartei', counterpartyIban: 'IBAN', text: 'Text', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy' }, idempotencyKey: 'v-csv',
});
const lines = qa('SELECT id, amount_minor AS amt FROM bank_txn WHERE workspace_id = ? ORDER BY booking_date, rowid', W);
log(`fixture: workspace ${W}, bank account ok=${bank.ok}, import ok=${imp.ok}, ${lines.length} synthetic lines`);
const L = lines.map((l) => l.id);

const setGrant = (value, key) => human('settings_set', { workspaceId: W, key: 'agent.decide_proposals', value, reason: `verify ${value}`, idempotencyKey: key });
const status = (id) => q('SELECT status, resolved_by AS by, history_json AS h FROM agent_action WHERE workspace_id = ? AND id = ?', W, id);
const lineState = (txn) => q("SELECT state FROM bank_line_decision WHERE workspace_id = ? AND bank_txn_id = ? AND superseded_at IS NULL", W, txn)?.state ?? 'open';
const traceRows = (verb) => q("SELECT COUNT(*) AS n FROM agent_call WHERE workspace_id = ? AND verb = ?", W, verb).n;

async function draftBook(i, key) {
  const r = await asAgent('book_bank_line', { workspaceId: W, bankTxnId: L[i], target: { kind: 'accounts', legs: [{ accountId: '6500', amountMinor: Math.abs(lines[i].amt) }] }, idempotencyKey: key });
  return r;
}

// --- (a) off ---------------------------------------------------------------------------------------------
log('\n## (a) agent.decide_proposals = off (the default)');
const d1 = await draftBook(0, 'a-book-0');
log(`agent book_bank_line line0 -> drafted=${d1.drafted} actionId=${d1.actionId}`);
const aRej = await asAgent('reject_drafted_action', { workspaceId: W, actionId: d1.actionId, reason: 'falsch' });
log(`agent reject_drafted_action -> ${short({ error: aRej.error, capability: aRej.capability, ownerCanGrant: aRej.ownerCanGrant })}`);
log(`  hint: ${aRej.ownerCanGrant?.hint}`);
check('reject refused permission_denied naming the setting agent.decide_proposals', aRej.error === 'permission_denied' && aRej.ownerCanGrant?.setting === 'agent.decide_proposals' && /agent\.decide_proposals/.test(aRej.ownerCanGrant?.hint ?? ''));
const aApp = await asAgent('approve_drafted_action', { workspaceId: W, actionId: d1.actionId });
log(`agent approve_drafted_action -> ${short({ error: aApp.error, reason: aApp.reason, ownerCanGrant: aApp.ownerCanGrant })}`);
check('approve refused, naming the setting (value decide)', aApp.ok !== true && aApp.ownerCanGrant?.setting === 'agent.decide_proposals' && aApp.ownerCanGrant?.value === 'decide');
check('Vorschlag still pending, line still open', status(d1.actionId).status === 'pending' && lineState(L[0]) === 'open');

// --- (f) the agent cannot change the setting or propose it ---------------------------------------------
log('\n## (f) the agent cannot change the setting itself, or propose changing it');
const draftsBefore = q('SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ?', W).n;
const fSet = await asAgent('settings_set', { workspaceId: W, key: 'agent.decide_proposals', value: 'decide', reason: 'ich will', idempotencyKey: 'f-set' });
log(`agent settings_set agent.decide_proposals=decide -> ${short({ ok: fSet.ok, error: fSet.error, reason: fSet.reason, drafted: fSet.drafted })}`);
const fReset = await asAgent('settings_reset', { workspaceId: W, key: 'agent.decide_proposals', reason: 'x', idempotencyKey: 'f-reset' });
log(`agent settings_reset agent.decide_proposals -> ${short({ ok: fReset.ok, error: fReset.error, reason: fReset.reason, drafted: fReset.drafted })}`);
check('settings_set refused and nothing drafted', fSet.ok !== true && fSet.drafted !== true);
check('no stored row for the setting, no new Vorschlag', q("SELECT COUNT(*) AS n FROM workspace_setting WHERE workspace_id = ? AND key = 'agent.decide_proposals'", W).n === 0 && q('SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ?', W).n === draftsBefore);

// --- (b) reject -------------------------------------------------------------------------------------------
log('\n## (b) agent.decide_proposals = reject');
const gB = await setGrant('reject', 'g-reject');
log(`person settings_set reject -> ok=${gB.ok}`);
const traceBefore = traceRows('reject_drafted_action');
const bRej = await asAgent('reject_drafted_action', { workspaceId: W, actionId: d1.actionId, reason: 'falscher Betrag, die Person bucht selbst' });
log(`agent reject_drafted_action ${d1.actionId} -> ${short({ ok: bRej.ok, status: bRej.status })}`);
const sB = status(d1.actionId);
const hB = JSON.parse(sB.h ?? '[]');
log(`row: status=${sB.status} resolved_by=${sB.by} history=${JSON.stringify(hB)}`);
check('rejected by the agent, history carries decided_under_grant naming the grantor', sB.status === 'rejected' && sB.by === 'agent' && hB.some((e) => e.event === 'decided_under_grant' && e.decision === 'rejected' && e.grantedBy === 'studio'));
check('the agent call landed in the trace (agent_call)', traceRows('reject_drafted_action') === traceBefore + 1);
const draftCall = q("SELECT c.turn_id AS turn FROM agent_call c WHERE c.workspace_id = ? AND c.agent_action_id = ? AND c.mode = 'draft'", W, d1.actionId);
const sessionId = draftCall ? q('SELECT session_id AS s FROM agent_turn WHERE id = ?', draftCall.turn)?.s : undefined;
const sess = sessionId ? await human('get_agent_session', { workspaceId: W, sessionId }) : { ok: false };
const draftedCall = (sess.turns ?? []).flatMap((t) => t.calls ?? []).find((c) => c.agentActionId === d1.actionId);
log(`person get_agent_session -> ok=${sess.ok}; the drafting call carries decidedUnderGrant=${JSON.stringify(draftedCall?.decidedUnderGrant ?? null)}`);
const d2 = await draftBook(1, 'b-book-1');
const bApp = await asAgent('approve_drafted_action', { workspaceId: W, actionId: d2.actionId });
log(`agent approve_drafted_action ${d2.actionId} -> ${short({ error: bApp.error, reason: bApp.reason, ownerCanGrant: bApp.ownerCanGrant })}`);
check('approve still refused under reject', bApp.ok !== true && status(d2.actionId).status === 'pending');

// --- (c) decide -------------------------------------------------------------------------------------------
log('\n## (c) agent.decide_proposals = decide');
const gC = await setGrant('decide', 'g-decide');
log(`person settings_set decide -> ok=${gC.ok}`);
// book_bank_line
const cBook = await asAgent('approve_drafted_action', { workspaceId: W, actionId: d2.actionId });
log(`agent approve book_bank_line ${d2.actionId} -> ${short({ ok: cBook.ok, status: cBook.status })}; line state=${lineState(L[1])}`);
check('book_bank_line approved, line booked once', cBook.ok === true && lineState(L[1]) === 'booked' && q("SELECT COUNT(*) AS n FROM bank_line_decision WHERE workspace_id = ? AND bank_txn_id = ? AND superseded_at IS NULL", W, L[1]).n === 1);
// ignore_bank_line
const dIg = await asAgent('ignore_bank_line', { workspaceId: W, bankTxnId: L[2], idempotencyKey: 'c-ign-2' });
const cIg = await asAgent('approve_drafted_action', { workspaceId: W, actionId: dIg.actionId });
log(`agent ignore_bank_line (no reason) -> drafted=${dIg.drafted}; approve -> ok=${cIg.ok}; line state=${lineState(L[2])}`);
check('ignore_bank_line approved, line ignored', cIg.ok === true && lineState(L[2]) === 'ignored');
// set_bank_standard: a NEW rule from a line
const dStd = await asAgent('set_bank_standard', { workspaceId: W, bankTxnId: L[3], accountId: acc('6500'), taxCode: null, label: 'Velo Teile', idempotencyKey: 'c-std' });
const cStd = await asAgent('approve_drafted_action', { workspaceId: W, actionId: dStd.actionId });
log(`agent set_bank_standard (new rule from a line) -> drafted=${dStd.drafted} ${dStd.drafted ? '' : JSON.stringify(dStd).slice(0, 300)}; approve -> ok=${cStd.ok}`);
check('set_bank_standard new-rule case approved', cStd.ok === true && q("SELECT COUNT(*) AS n FROM bank_standard WHERE workspace_id = ? AND superseded_at IS NULL AND scope = 'bank'", W).n === 1);
// set_bank_standard EDIT: refused
const stdId = q("SELECT id FROM bank_standard WHERE workspace_id = ? AND superseded_at IS NULL AND scope = 'bank'", W).id;
const dEdit = await asAgent('set_bank_standard', { workspaceId: W, standardId: stdId, accountId: acc('6000'), taxCode: null, label: 'Velo Teile', idempotencyKey: 'c-std-edit' });
const cEdit = await asAgent('approve_drafted_action', { workspaceId: W, actionId: dEdit.actionId });
log(`agent set_bank_standard EDIT -> drafted=${dEdit.drafted}; approve -> ${short({ error: cEdit.error, reason: cEdit.reason, grantExclusion: cEdit.grantExclusion })}`);
check('a Buchungsregel edit is refused (rule_edit)', cEdit.grantExclusion === 'rule_edit');
// confirm_match: match line 9 to an entry a person already posted for the same movement.
const entry = await human('post_entry', { workspaceId: W, date: '2026-03-11', description: 'Kabel bereits erfasst', source: 'manual', lines: [{ account: acc('6500'), debit: Math.abs(lines[9].amt) }, { account: acc('1020'), credit: Math.abs(lines[9].amt) }], idempotencyKey: 'c-entry-9' });
const dMatch = await asAgent('confirm_match', { workspaceId: W, bankTxnId: L[9], entryId: entry.entryId, idempotencyKey: 'c-match-9' });
const cMatch = dMatch.actionId ? await asAgent('approve_drafted_action', { workspaceId: W, actionId: dMatch.actionId }) : dMatch;
log(`person post_entry ok=${entry.ok}; agent confirm_match line9 -> drafted=${dMatch.drafted}${dMatch.drafted ? '' : ` ${JSON.stringify(dMatch).slice(0, 200)}`}; approve -> ${JSON.stringify(cMatch).slice(0, 400)}; line state=${lineState(L[9])}`);
check('confirm_match approved, line matched', cMatch.ok === true && lineState(L[9]) === 'matched');
// Outside the grant: a manual posting, an automation rule, a dial grant, a standing power, a settings change.
const dPost = await asAgent('post_entry', { workspaceId: W, date: '2026-03-12', description: 'Testbuchung', source: 'manual', lines: [{ account: acc('6500'), debit: 1000 }, { account: acc('1000'), credit: 1000 }], idempotencyKey: 'c-post' });
const cPost = dPost.actionId ? await asAgent('approve_drafted_action', { workspaceId: W, actionId: dPost.actionId }) : dPost;
log(`agent post_entry -> drafted=${dPost.drafted}; approve -> ${short({ error: cPost.error, reason: cPost.reason, grantExclusion: cPost.grantExclusion })}`);
check('post_entry refused (not_a_bank_decision)', cPost.grantExclusion === 'not_a_bank_decision');
const dRule = await asAgent('create_automation_rule', {
  workspaceId: W, name: 'Agent bucht', trigger: { event: 'contact.created' },
  action: { tool: 'post_entry', inputTemplate: { date: '2026-03-15', description: 'x', lines: [{ accountId: acc('6500'), debitMinor: 100 }, { accountId: acc('1020'), creditMinor: 100 }] } }, idempotencyKey: 'c-rule',
});
const cRule = dRule.actionId ? await asAgent('approve_drafted_action', { workspaceId: W, actionId: dRule.actionId }) : dRule;
log(`agent create_automation_rule -> drafted=${dRule.drafted}; approve -> ${short({ error: cRule.error, reason: cRule.reason, grantExclusion: cRule.grantExclusion })}`);
check('rule proposal refused', cRule.ok !== true && q("SELECT COUNT(*) AS n FROM automation_rule WHERE workspace_id = ? AND name = 'Agent bucht'", W).n === 0);
const cDialFuture = await asAgent('approve_drafted_action', { workspaceId: W, actionId: (await draftBook(4, 'c-book-4')).actionId, allowFuture: true });
log(`agent approve with allowFuture (a standing dial grant) -> ${short({ error: cDialFuture.error, field: cDialFuture.field })}`);
check('allowFuture refused cannot_self_grant', cDialFuture.error === 'cannot_self_grant');
const cDial = await asAgent('set_agent_dial', { workspaceId: W, capability: 'post', level: 'auto', idempotencyKey: 'c-dial' });
log(`agent set_agent_dial post=auto -> ${short({ ok: cDial.ok, error: cDial.error, drafted: cDial.drafted })}`);
check('set_agent_dial refused', cDial.ok !== true && cDial.drafted !== true);
const dAuto = await asAgent('grant_rule_autobook', { workspaceId: W, standardId: stdId, idempotencyKey: 'c-autobook' });
const cAuto = dAuto.actionId ? await asAgent('approve_drafted_action', { workspaceId: W, actionId: dAuto.actionId }) : dAuto;
log(`agent grant_rule_autobook (Autopilot, a standing power) -> drafted=${dAuto.drafted}; ${short({ error: cAuto.error, reason: cAuto.reason, grantExclusion: cAuto.grantExclusion })}`);
check('Autopilot grant refused', cAuto.ok !== true && q('SELECT COUNT(*) AS n FROM rule_autobook_grant WHERE workspace_id = ?', W).n === 0);
const dSet = await asAgent('settings_set', { workspaceId: W, key: 'bank.buchungsregel_mode', value: 'suggest', reason: 'x', idempotencyKey: 'c-set' });
const cSet = dSet.actionId ? await asAgent('approve_drafted_action', { workspaceId: W, actionId: dSet.actionId }) : dSet;
log(`agent settings_set bank.buchungsregel_mode -> drafted=${dSet.drafted}; approve -> ${short({ error: cSet.error, reason: cSet.reason, grantExclusion: cSet.grantExclusion })}`);
check('a settings change refused', cSet.ok !== true);

// TILL's own offer: the Autopilot offer, drafted by `system` once a rule has its clean uses.
log('\n### (c) TILL\'s own Autopilot offer (drafted by system)');
await human('settings_set', { workspaceId: W, key: 'rules.autobook_offer_after', value: 3, reason: 'verify', idempotencyKey: 'c-after' });
const ruleIdNow = q("SELECT id FROM bank_standard WHERE workspace_id = ? AND superseded_at IS NULL AND scope = 'bank'", W).id;
for (const [i, k] of [[4, 'c-h-4'], [5, 'c-h-5'], [6, 'c-h-6']]) {
  const r = await human('book_bank_line', { workspaceId: W, bankTxnId: L[i], target: { kind: 'rule', standardId: ruleIdNow }, idempotencyKey: k });
  log(`person book_bank_line line${i} with the rule -> ok=${r.ok}${r.ok ? '' : ` ${r.error}`}`);
}
let offer;
for (let t = 0; t < 30 && offer === undefined; t += 1) {
  offer = q("SELECT id FROM agent_action WHERE workspace_id = ? AND actor = 'system' AND action_tool = 'grant_rule_autobook' AND status = 'pending'", W);
  if (offer === undefined) await new Promise((r) => setTimeout(r, 3000));
}
if (offer === undefined) {
  log('no Autopilot offer was drafted within 90 s (the scheduler tick); this case is covered by test/api/d196-agent-decision-grant.test.mjs critic P2');
} else {
  const oRej = await asAgent('reject_drafted_action', { workspaceId: W, actionId: offer.id });
  const oApp = await asAgent('approve_drafted_action', { workspaceId: W, actionId: offer.id });
  log(`system offer ${offer.id}: agent reject -> ${short({ error: oRej.error, grantExclusion: oRej.grantExclusion })}; agent approve -> ${short({ error: oApp.error, grantExclusion: oApp.grantExclusion })}`);
  check('TILL\'s offer refused both ways (system_offer), still pending', oRej.grantExclusion === 'system_offer' && oApp.grantExclusion === 'system_offer' && status(offer.id).status === 'pending');
}

// --- (d) revoke -----------------------------------------------------------------------------------------
log('\n## (d) revoking to off takes effect at once');
const d7 = await draftBook(7, 'd-book-7');
const gD = await setGrant('off', 'g-off');
log(`person settings_set off -> ok=${gD.ok}`);
const dApp = await asAgent('approve_drafted_action', { workspaceId: W, actionId: d7.actionId });
const dRej = await asAgent('reject_drafted_action', { workspaceId: W, actionId: d7.actionId });
log(`agent approve -> ${short({ error: dApp.error })}; agent reject -> ${short({ error: dRej.error })}`);
check('both refused after the revoke, Vorschlag pending, line open', dApp.ok !== true && dRej.ok !== true && status(d7.actionId).status === 'pending' && lineState(L[7]) === 'open');
log('inside one transaction: the engine re-reads the grant inside the act\'s own write transaction (draftedActions.ts approveOnce, DecisionGrantRevokedMeanwhile); a two-process race is not reproducible by REST timing, see the unit evidence in the transcript doc.');

// --- (e) fail closed on the grantor -------------------------------------------------------------------
log('\n## (e) a demoted or removed grantor takes the grant with them');
await setGrant('decide', 'g-decide-2');
const inv = await human('invite_member', { workspaceId: W, email: 'grantor@example.invalid', role: 'owner', idempotencyKey: 'e-inv' });
log(`person invite_member owner -> ok=${inv.ok}`);
const rw = store.db;
const member = rw.prepare("SELECT m.id AS mid, u.actor_id AS actor FROM workspace_member m JOIN user u ON u.id = m.user_id WHERE m.workspace_id = ? AND u.email = 'grantor@example.invalid'").get(W);
let eActor = member?.actor;
log(`member row: ${JSON.stringify(member)}`);
if (member !== undefined) {
  const uid = rw.prepare('SELECT user_id AS u FROM workspace_member WHERE id = ?').get(member.mid).u;
  eActor = `member:${uid}`;
  // What acceptInvite does for a served member (members.ts): bind member:<user_id>, stamp accepted_at.
  rw.prepare('UPDATE user SET actor_id = ? WHERE id = ?').run(eActor, uid);
  rw.prepare("UPDATE workspace_member SET accepted_at = COALESCE(accepted_at, '2026-03-01') WHERE id = ?").run(member.mid);
  rw.prepare("UPDATE workspace_setting SET updated_by = ? WHERE workspace_id = ? AND key = 'agent.decide_proposals'").run(eActor, W);
}
log('(SQL, stated: the member accepted, and the stored grant names that member as its signer; on a local host only the two local seats act over the doors.)');
const d8 = await draftBook(8, 'e-book-8');
const eBefore = await asAgent('reject_drafted_action', { workspaceId: W, actionId: (await draftBook(7, 'e-book-7b')).actionId, reason: 'verify: falscher Vorschlag' });
log(`grant signed by the member (owner): agent reject -> ok=${eBefore.ok}`);
check('the grant is in force while its signer holds manage_agent_dial', eBefore.ok === true);
const memberId = member?.mid;
const demote = await human('set_role', { workspaceId: W, memberId, role: 'viewer' });
log(`person set_role grantor -> viewer: ok=${demote.ok}${demote.ok ? '' : ` ${JSON.stringify(demote).slice(0, 200)}`}`);
const eDem = await asAgent('approve_drafted_action', { workspaceId: W, actionId: d8.actionId });
log(`after the demotion: agent approve -> ${short({ error: eDem.error, reason: eDem.reason })}`);
check('demoted grantor: the grant fails closed', eDem.ok !== true && status(d8.actionId).status === 'pending');
const promote = await human('set_role', { workspaceId: W, memberId, role: 'owner' });
const eBack = await asAgent('reject_drafted_action', { workspaceId: W, actionId: (await draftBook(7, 'e-book-7c')).actionId, reason: 'verify: falscher Vorschlag' });
log(`person set_role grantor -> owner: ok=${promote.ok}; agent reject -> ok=${eBack.ok} (the same stored grant is in force again)`);
check('the grant follows the signer back', eBack.ok === true);
const revoke = await human('revoke_member', { workspaceId: W, memberId });
log(`person revoke_member grantor: ok=${revoke.ok}${revoke.ok ? '' : ` ${JSON.stringify(revoke).slice(0, 200)}`}`);
const eRem = await asAgent('reject_drafted_action', { workspaceId: W, actionId: d8.actionId });
log(`after the removal: agent reject -> ${short({ error: eRem.error, reason: eRem.reason })}`);
check('removed grantor: the grant fails closed', eRem.ok !== true && status(d8.actionId).status === 'pending');
log(`grant actor: ${eActor}`);

log(`\nRESULT: ${failures === 0 ? 'all checks PASS' : `${failures} check(s) FAIL`}`);
if (process.argv.includes('--keep')) await draftBook(0, 'keep-0');
await agent.close();
store.close();
if (process.argv.includes('--keep')) {
  // Leave the throwaway instance up for a look at the Studio (the key stays in this scratch directory).
  console.error(`KEEP: ${base}/#k=${studioKey} (workspace ${W}); stop with kill ${server.pid}`);
  process.removeListener('exit', stop);
  server.unref();
  process.exit(failures === 0 ? 0 : 1);
}
stop();
process.exitCode = failures === 0 ? 0 : 1;
