/**
 * EVERY VERB THAT CAN MINT A JOURNAL ENTRY IS DIAL-GOVERNED, OR SAYS IN WRITING WHY NOT.
 *
 * `dialMap.ts` states the rule: a verb that mints an entry (an original posting or a reversing one)
 * belongs under the `post` dial capability, or under the family whose act it is (`issue`, `pay`,
 * `close-period`, `go-live`). A hand-kept map is only as good as the last person who remembered it,
 * and on 28.09.2026 the governance check found nine write verbs that could mint an entry at the
 * default `ask` with no Vorschlag, `void_vendor_bill` the first of them. This file makes the rule
 * STRUCTURAL: it derives the minting verbs from the code, so the next verb that reaches `postEntry`
 * fails here the moment it is registered, before anyone writes a behavioural test for it.
 *
 * HOW THE MINTING SET IS DERIVED (in `scripts/lib/posting-graph.mjs` since D159, shared with the
 * reversibility prefill). The TypeScript checker builds a reference graph over `src/`: a unit
 * (a function, a method, an arrow bound to a name or an object property) points at every `src/`
 * symbol it names anywhere in its body, nested closures included. A contextually typed object
 * property implements its interface member, so a call through `DocumentPoster.onIssue` reaches the
 * invoice poster's `onIssue`. The minting set is everything that reaches `postEntry` in
 * `src/core/ledger/postEntry.ts`, the ONE posting path (P3). A registry verb mints when its handler
 * names a minting symbol. This over-approximates on purpose (a shared engine function like
 * `transitionDocument` mints on some edges and not on others), and every over-approximation is
 * answered in `NOT_GOVERNED` below with the reason, so it is a decision on record, never a silence.
 *
 * WHAT IT CANNOT SEE: a verb that runs another verb by NAME through an `ActionInvoker` (G01 firings,
 * A12's recurring tick, the approval replay). The invoked verb is dispatched internally, outside the
 * transport seam, by design. Those verbs are pinned in `INVOKER_VERBS` below, so a new one fails
 * here until someone has said why it is safe. Two narrower limits, measured by the non-author critic
 * (28.09.2026) and unused today: a reference made at MODULE level, outside any named unit, belongs to
 * no unit (today only the three document posters, which reach the graph through their interface
 * members instead), and an invoker holder is recognised by the names `invokerFor` / `invoke` and by
 * `firingAction`, so an invoker bound under another name would be missed.
 *
 * HOW IT BITES: delete `void_vendor_bill` from `DIAL_CAPABILITY_FOR_ACTION` and the first test names
 * it. The analyser is itself checked: it must find the whole registry (a new constructor shape
 * cannot hide verbs) and it must classify the known minting verbs as minting (a broken graph that
 * finds nothing cannot pass).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { ACTIONS } from '../../dist/api/registry.js';
import { DIAL_CAPABILITY_FOR_ACTION, INPUT_KEYED_DIAL_RULES } from '../../dist/core/agent/index.js';
// D159: the analyser lives in a shared module so the reversibility prefill reads the same graph.
import { analysePostingGraph } from '../../scripts/lib/posting-graph.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The minting verbs the dial does not govern, each with the reason. A reason is a statement about
 * the code, checkable by a reader; "not needed" is not one.
 */
const NOT_GOVERNED = {
  // `set_opening_balances` left this list under D158: it is governed under `post`, and the seam runs
  // the verb's own checks before it drafts, so A04's parity holds (test/agent/dial-covers-d158.test.mjs).
  // Reads. A read verb is never dial-governed; these two only reach a minting symbol on a branch a
  // read cannot take.
  preview_opening_import: 'read: importMigration with dryRun true returns before setOpeningBalances',
  // D178 E3 (A39 §17.5): the bank preview of a settlement, contact or Spesen target runs the booking to
  // read its verdict and lines, inside a transaction it always rolls back (`dryRunCapture` in
  // bankBooking.ts, the D177-C1 dry run), so nothing it posts survives (test/banking/e3-preview.test.mjs
  // asserts every row count, the memo and the audit chain unchanged).
  compose_entry: 'read: composeBankLine runs a settlement booking inside a transaction it always rolls back (dryRunCapture)',
  // Pre-workspace: it mints the tenant it posts into, and that tenant is a demo that can never go
  // productive (G03). There is no dial to consult before the workspace exists.
  create_demo_workspace: 'depsAction: posts only into the demo tenant it mints, which can never go productive',
  // C02 quotes: every call reaches `transitionDocument` on a row read `type = 'quote'`, whose poster
  // is the no-op; the minting edge is the invoice/credit-note poster, which a quote never takes.
  // `quotes_accept` left this list under D161: it is governed under `issue` by an input-keyed rule.
  quotes_decline: "transitionDocument on a type='quote' row only (no-op poster)",
  quotes_expire_sweep: "transitionDocument on type='quote' rows only (no-op poster)",
  quotes_revise: "transitionDocument on a type='quote' row only (no-op poster)",
  // `portal_quote_accept` left this list too: governed under `issue`, the seam resolving its token (D161).
};

/**
 * The verbs that hold an `ActionInvoker` and can therefore run other verbs by name, internally and
 * outside the seam. Each is safe for a stated reason; a new one fails the invoker test below.
 */
const INVOKER_VERBS = {
  approve_drafted_action: 'the human approval replay itself: it is what a Vorschlag waits for',
  run_due_recurring: 'A12: replays schedules a human authored; each tick runs as the schedule author, and an agent seat\'s own call drafts under issue (D161)',
  deals_log_activity: 'C03: invokes the task/activity verbs only, none of which mints an entry',
  deals_to_quote: 'C03: invokes quotes_create only (src/core/deals/quoteSeam.ts), which mints nothing',
};

/** Verbs the analyser MUST classify as minting, or the graph is broken. */
const KNOWN_MINTING = ['post_entry', 'reverse_entry', 'issue_invoice', 'post_vendor_bill', 'void_vendor_bill', 'record_payment', 'reverse_payment'];

const VERBS = analysePostingGraph(ROOT);
const KIND = new Map(ACTIONS.map((a) => [a.name, a.kind]));
const INPUT_KEYED = new Set(INPUT_KEYED_DIAL_RULES.map((r) => r.action));
const governed = (name) => DIAL_CAPABILITY_FOR_ACTION[name] !== undefined || INPUT_KEYED.has(name);

test('the analyser sees the whole registry and classifies the known minting verbs as minting', () => {
  const missing = ACTIONS.map((a) => a.name).filter((n) => !VERBS.has(n));
  assert.deepEqual(missing, [], 'every registered verb is found by the static pass (a new constructor shape would hide verbs)');
  for (const name of KNOWN_MINTING) {
    assert.equal(VERBS.get(name)?.mints, true, `${name} reaches postEntry: if this fails the reference graph is broken`);
  }
});

test('every verb that can mint a journal entry is dial-governed, or NOT_GOVERNED says why', () => {
  const ungoverned = [...VERBS]
    .filter(([name, v]) => v.mints && !governed(name) && NOT_GOVERNED[name] === undefined)
    .map(([name, v]) => `${name} (${KIND.get(name)}, ${v.file})`);
  assert.deepEqual(
    ungoverned,
    [],
    'these verbs reach postEntry but have no entry in DIAL_CAPABILITY_FOR_ACTION (src/core/agent/dialMap.ts), no input-keyed rule, and no written reason in NOT_GOVERNED: an agent at the default ask would mint an entry with no Vorschlag',
  );
});

test('NOT_GOVERNED holds no stale reason: each entry still mints and is still ungoverned', () => {
  for (const name of Object.keys(NOT_GOVERNED)) {
    assert.ok(VERBS.has(name), `${name}: NOT_GOVERNED names a registered verb`);
    assert.equal(VERBS.get(name).mints, true, `${name}: no longer reaches postEntry, drop it from NOT_GOVERNED`);
    assert.equal(governed(name), false, `${name}: is governed now, drop it from NOT_GOVERNED`);
  }
});

test('every verb holding an ActionInvoker is pinned in INVOKER_VERBS with its reason', () => {
  const holders = [...VERBS].filter(([, v]) => v.invokes).map(([name]) => name);
  const firing = holders.filter((n) => INVOKER_VERBS[n] === undefined && !isG01Firing(n));
  assert.deepEqual(firing, [], 'a new verb runs other verbs by name: add it to INVOKER_VERBS with why that dispatch cannot mint around the dial');
  for (const name of Object.keys(INVOKER_VERBS)) {
    assert.ok(holders.includes(name), `${name}: no longer holds an invoker, drop it from INVOKER_VERBS`);
  }
});

/**
 * The G01 firing verbs are collected by construction in `automation-actions.ts` (`firingVerbs`) and
 * gated by A24's `assertActionInvokersAreGated`; a rule fires only what its author could run, the G01
 * denylist keeps the governing acts out of any rule, and since the critic's R3-2 (D141.5) an agent seat
 * cannot enable a rule, create one that starts enabled, or repoint a rule's trigger, condition or action
 * without a Vorschlag, so every firing rule has a human behind it. They are recognised by file.
 */
function isG01Firing(name) {
  return VERBS.get(name)?.file === join('src', 'api', 'automation-actions.ts');
}
