// @ts-check
/**
 * EVERY INNER WRITE UNDER A DERIVED KEY RUNS IN AN INTERNAL SCOPE, OR SAYS IN WRITING WHY NOT (K1).
 *
 * THE DEFECT CLASS (critic, 04.10.2026, reproduced on the year close). A composite verb calls an inner
 * write with a key it DERIVES, from its own key (`${key}:wjp`) or from a row a caller can read before it
 * runs (`accrual:${id}`, `fxreval:${periodEnd}`). When that inner write memoises in the scope of the
 * public verb of the same name (`post_entry`, `create_vendor_bill`, ...), anyone able to call that verb
 * with the derived key FIRST has their write replayed in place of the composite's, and the composite
 * answers ok over it: a year sealed with its P&L never swept, a wage journal "posted" as CHF 1.00.
 *
 * WHAT IT ASSERTS, read from the syntax tree of every `src/` file: each `idempotencyKey` (and the
 * movement keys `verbKey` / `movementKey`) handed to a call as a DERIVED value (a template literal, a
 * `+` concatenation or a `JSON.stringify(...)`, directly or through a local const) is
 *  - lexically inside `store.innerWrite(<composite>, () => ...)`, or an object passed into one; or
 *  - handed to an internal entry point whose scope is a closed literal union, never an input field
 *    (`postEntryInternal`, `postEntryInternalChecked`, `reverseEntryInternal`); or
 *  - handed to `reverseOwnedEntry` (the target is owned, so the public `reverse_entry` refuses it); or
 *  - MINTED: the key carries `ctx.ids.next(...)`, directly or through a const, so no caller can know it; or
 *  - in `DECIDED` below, with the reason, so an exception is a decision on record and never a silence.
 *
 * HOW IT BITES: write `postEntry(ctx, { ..., idempotencyKey: `${input.idempotencyKey}:x` })` anywhere in
 * `src/` and the first test names the file, the line and the key. The analyser is itself checked on
 * synthetic source (the third test), and a `DECIDED` entry that no longer matches any site fails too, so
 * the list cannot rot into a list of things nobody can find.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';

import { cleanGitEnv } from '../lib/git-env.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const KEY_PROPS = new Set(['idempotencyKey', 'verbKey', 'movementKey']);
const SCOPED_CALLEES = new Set(['postEntryInternal', 'postEntryInternalChecked', 'reverseEntryInternal', 'reverseOwnedEntry']);

/**
 * The derived keys that are NOT under an internal scope, each with the reason. Keyed by
 * `<file>|<callee>|<key source text>`; a reason is a statement about the code a reader can check.
 */
const DECIDED = {
  // --- Writers with a fixed scope of their own (landed with cl-periods, critic R5-2/R6-1). ------------
  'src/core/vat/abrechnung.ts|lockPeriodSealed|`${input.idempotencyKey}:${month}`':
    'lockPeriodSealed memoises under its own scope (lock_period_sealed), which no public verb writes, and the filing reads every month back as {hard, vat_filed}',

  // --- A namespaced memo of the verb's own (merge with develop at 27195a66, D157/D161). ---------------
  'src/core/portal/vendorPortal.ts|createVendorGrant|scopedKey':
    "createVendorGrant memoises under vendor_portal_grant, which only this verb writes and always as [\"vendor\",K]; the legacy portal_grant_create replay is handed out only when the stored grant is a vendor grant, and portal_grant_create can no longer mint one (D157), so a customer squat is refused, never adopted",

  // --- The delegated route of a composite that runs whole inside innerWrite. -------------------------
  'src/core/migration/steps.ts|setOpeningBalances|`migstep:${step.id}:${idempotencyKey}`':
    "commitRoute runs only inside innerWrite('migration_commit_step') (commitStep)",
  'src/core/migration/steps.ts|importContacts|`migstep:${step.id}:${idempotencyKey}`':
    "commitRoute runs only inside innerWrite('migration_commit_step') (commitStep)",
  'src/core/migration/steps.ts|markVatPeriodFiled|`migstep:${step.id}:${idempotencyKey}:${period}`':
    "commitRoute runs only inside innerWrite('migration_commit_step') (commitStep)",
  'src/core/migration/steps.ts|linkFile|`migstep:${step.id}:${idempotencyKey}:${f.file_id}`':
    "commitRoute runs only inside innerWrite('migration_commit_step') (commitStep)",
  'src/core/migration/steps.ts|importCamt|`migstep:${step.id}:${idempotencyKey}:${f.file_id}`':
    "commitRoute runs only inside innerWrite('migration_commit_step') (commitStep)",
  'src/core/migration/crudCommit.ts|createAccount|rowKey':
    "commitCrudRows is reached only from commitRoute, inside innerWrite('migration_commit_step')",
  'src/core/migration/crudCommit.ts|upsertTaxCode|rowKey':
    "commitCrudRows is reached only from commitRoute, inside innerWrite('migration_commit_step')",
  'src/core/migration/crudCommit.ts|createBankAccount|rowKey':
    "commitCrudRows is reached only from commitRoute, inside innerWrite('migration_commit_step')",
  'src/core/migration/crudCommit.ts|updateBankAccount|rowKey':
    "commitCrudRows is reached only from commitRoute, inside innerWrite('migration_commit_step')",

  // --- Stock movements: the replay identity is the stock_movement row, and it is verified (K1). -------
  'src/core/inventory/adjust.ts|mintAdjustment|`${key}:${i}`':
    'inventoryMove replays a key only for the SAME movement (sameMovement, K1) and refuses idempotency_key_conflict otherwise; the adjustment row key is unique, a taken one throws inside the batch transaction',
  'src/core/inventory/adjust.ts|mintAdjustment|`${key}:rev:${i}`':
    'inventoryMove replays a key only for the SAME movement (sameMovement, K1); the adjustment row key is unique, a taken one throws inside the transaction',
  'src/core/inventory/adjust.ts|mintAdjustment|`adj:${key}`':
    'inventoryMove replays a key only for the SAME movement (sameMovement, K1) and refuses idempotency_key_conflict otherwise',
  'src/core/inventory/adjust.ts|mintAdjustment|`adjb:${key}:${i}`':
    'inventoryMove replays a key only for the SAME movement (sameMovement, K1) and refuses idempotency_key_conflict otherwise',
  'src/core/inventory/adjust.ts|mintAdjustment|`adjrev:${key}:${i}`':
    'inventoryMove replays a key only for the SAME movement (sameMovement, K1) and refuses idempotency_key_conflict otherwise',
  'src/core/inventory/movement.ts|insertMovement|inKey':
    'a raw insert, not a replay: a taken key throws the stock_movement unique index inside the transfer transaction, no row is adopted',
  'src/core/inventory/stocktake.ts|inventoryMove|`stk:${session.id}:${l.id}`':
    'inventoryMove replays a key only for the SAME movement (sameMovement, K1) and refuses idempotency_key_conflict otherwise',
  'src/core/procurement/receipt.ts|inventoryMove|`gr:${line.id}:receipt`':
    'inventoryMove replays a key only for the SAME movement (sameMovement, K1) and refuses idempotency_key_conflict otherwise',
  'src/core/procurement/receipt.ts|inventoryMove|`gr:${line.id}:reversal`':
    'inventoryMove replays a key only for the SAME movement (sameMovement, K1) and refuses idempotency_key_conflict otherwise',
  'src/core/procurement/landed_cost.ts|inventoryMove|`${v.id}:conf:${t.id}`':
    'inventoryMove replays a key only for the SAME movement (sameMovement, K1) and refuses idempotency_key_conflict otherwise',
  'src/core/procurement/landed_cost.ts|inventoryMove|`${v.id}:rev:${t.id}`':
    'inventoryMove replays a key only for the SAME movement (sameMovement, K1) and refuses idempotency_key_conflict otherwise',
  'src/core/sales/deliveryNotes.ts|recordStockMove|`${key}#${dl.id}`':
    'recordStockMove replays a key only for the SAME movement (sameStockMove, K1) and refuses idempotency_key_conflict otherwise',
  'src/core/purchase/receipts.ts|recordStockMove|moveKey':
    'recordStockMove replays a key only for the SAME movement (sameStockMove, K1) and refuses idempotency_key_conflict otherwise',
  'src/core/stock/movements.ts|insertMovement|`${input.idempotencyKey}#in`':
    'a raw insert, not a replay: a taken key throws the stock_movement unique index inside recordStockMove\'s transaction, no row is adopted',
  'src/core/stock/stocktake.ts|insertMovement|`${input.idempotencyKey}-ln-${l.id}`':
    'a raw insert, not a replay: a taken key throws the stock_movement unique index inside the commit transaction, no row is adopted',

  // --- Payments: the A20/A21 rule (bankBooking.ts module note). ---------------------------------------
  'src/core/banking/bankBooking.ts|recordPayment|`bankline-${row.id}-g${generation}`':
    "A20/A21: the payment's raw key is unique per workspace (a squat refuses idempotency_key_conflict), the memo key folds in the money side, and the line-state guard stops a second booking",
  'src/core/banking/camtReconcile.ts|recordPayment|`camt-confirm-${row.id}-g${lineGeneration(ctx, row.id)}`':
    "A20/A21: the payment's raw key is unique per workspace (a squat refuses), the memo key folds in the money side",
  'src/core/banking/qrMatch.ts|recordPayment|`qr-apply-${row.id}-g${generation}`':
    "A20/A21: the payment's raw key is unique per workspace (a squat refuses), the memo key folds in the money side",
  'src/core/banking/pain001.ts|recordPayment|`pain001-item-${item.id}`':
    "A20/A21: the payment's raw key is unique per workspace (a squat refuses), the memo key folds in the money side",
  'src/core/banking/qrMatch.ts|reversePayment|`qr-override-${row.id}-${row.payment_id}`':
    'critic A39-7: a payment already reversed by hand is accepted as the fact the override follows, so a reversal under this key changes nothing the override would not accept anyway',

  // --- Bank files: the key names a delivered statement. -----------------------------------------------
  'src/core/banking/ebics/channel.ts|importCamt|`a36-${conn.id}-${p.member.sha}`':
    'the key carries the content hash of a member the bank delivered in this call; a squatter would need the statement bytes before the download',
  'src/core/banking/importCamtFiles.ts|importCamt|`camt-files:${bankAccountId}:${sha256(p.xml)}`':
    'the key IS the content hash of the statement handed in; a replay under it names the same statement',
  'src/core/banking/statementImport.ts|importCamt|`stmt-file:${account.id}:${sha256(p.xml)}`':
    'D178: the key IS the content hash of the statement handed in (the import_camt_files rule); a replay under it names the same statement',
  'src/core/banking/duplicateDecision.ts|ignoreBankLine|`resolve-duplicate:${bankTxnId}:${key}`':
    'D178 point 19: the ignore IS the duplicate answer of this line under the caller\'s own key, inside its memoised transaction; a replay under it names the same answer',
  'src/core/banking/managed/channel.ts|importCamt|`a37-${conn.id}-${persistedId}`':
    'persistedId is the document the relay file was stored as in this call (minted), so no caller holds the key first',
  'src/core/banking/managed/channel.ts|generatePain001|`a37-transmit-${batchId}`':
    'generate_pain001 is a deterministic re-render (byte-identical regeneration, scoped per batch); a replay returns the same file',

  // --- The reversal's own posting. ------------------------------------------------------------------
  'src/core/ledger/reverseEntry.ts|postEntry|scopedKey':
    "the mirror posts with source 'reversal', which post_entry refuses on the wire, so only reverse() writes the reverse_entry scope; its key embeds the target (and, for reverseEntryInternal, the internal scope)",

  // --- Not an inner write. ----------------------------------------------------------------------------
  'src/core/attention/providers.ts|options.push|`attention:apply:${ctx.workspaceId}:${creditId}:${suggestedInvoiceId}:${mode}:${generation}`':
    'an Attention OPTION: the input of a verb a human may choose to run, not a write this code performs',
  'src/core/attention/providers.ts|options.push|`attention:dismiss:${ctx.workspaceId}:${creditId}:${generation}`':
    'an Attention OPTION: the input of a verb a human may choose to run, not a write this code performs',
  'src/core/attention/providers.ts|runs.slice(0, opts.limit).map|`attention:issue:${ctx.workspaceId}:${runId}`':
    'an Attention OPTION: the input of a verb a human may choose to run, not a write this code performs',
  'src/core/attention/providers.ts|rows.map|`attention:resolve:${ctx.workspaceId}:${r.entry_id}:${r.review_id}`':
    'an Attention OPTION: the input of a verb a human may choose to run, not a write this code performs',
  'src/core/banking/attentionProviders.ts|options.push|`attention:confirm-gap:${ctx.workspaceId}:${gap.gapId}:${ackGeneration(ctx, gap)}`':
    'an Attention OPTION: the input of a verb a human may choose to run, not a write this code performs',

  // --- Known and decided elsewhere. -------------------------------------------------------------------
  'src/core/recurring/recurring.ts|invoke|tickKey':
    'D141 (critics F1/F2/R2, 28.09.2026): the tick checks provenance itself (a fresh create, or a run row naming the document with its fingerprint) and auto-issues only its own unchanged draft; the recurring rebuild (D141.6) removes the class',
  'src/core/recurring/recurring.ts|invoke|`recurring_issue:${row.id}:${period}`':
    'D141: the issue runs only on a draft the tick created and verified by fingerprint (see the create entry)',
  'src/core/migration/archive.ts|deleteFile|`glpurge:${recordId}:${fileId}`':
    "recordId is minted in the same transaction (ctx.ids.next('glpurge')) before the loop, so no caller holds the key first",
};

/** @param {ts.Node} n */
const unwrap = (n) => {
  let e = n;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
};

/**
 * Every derived key in `source` that is not under an internal scope, as `<file>|<callee>|<key text>`
 * plus its line.
 * @param {string} source @param {string} file
 * @returns {{ id: string, line: number }[]}
 */
export function unscopedDerivedKeys(source, file) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  /** @type {Map<string, ts.Expression>} */
  const consts = new Map();
  /** names referenced inside an innerWrite callback, for objects built beside the call */
  const passedIntoInner = new Set();
  const isInnerWriteCall = (/** @type {ts.Node} */ n) =>
    ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'innerWrite';
  const collect = (/** @type {ts.Node} */ n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) consts.set(n.name.text, n.initializer);
    if (isInnerWriteCall(n)) {
      const walk = (/** @type {ts.Node} */ m) => {
        if (ts.isIdentifier(m)) passedIntoInner.add(m.text);
        ts.forEachChild(m, walk);
      };
      for (const a of /** @type {ts.CallExpression} */ (n).arguments) walk(a);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const resolve = (/** @type {ts.Expression} */ e, depth = 0) => {
    const u = unwrap(e);
    return ts.isIdentifier(u) && consts.has(u.text) && depth < 5 ? resolve(/** @type {ts.Expression} */ (consts.get(u.text)), depth + 1) : u;
  };
  const isMintCall = (/** @type {ts.Node} */ n) =>
    ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'next' &&
    ts.isPropertyAccessExpression(n.expression.expression) && n.expression.expression.name.text === 'ids';
  /** is this expression a minted id: `ctx.ids.next(...)`, or a const initialised to exactly that? */
  const isMinted = (/** @type {ts.Node} */ n) => {
    const u = unwrap(n);
    if (isMintCall(u)) return true;
    return ts.isIdentifier(u) && consts.has(u.text) && isMintCall(unwrap(/** @type {ts.Expression} */ (consts.get(u.text))));
  };
  /**
   * Does the KEY carry a minted component, so no caller can know it first? Read structurally: a
   * template or a `+` with a minted part, a `JSON.stringify([...])` with a minted element, and a
   * conditional only when every derived branch is minted.
   * @returns {boolean}
   */
  const minted = (/** @type {ts.Expression} */ e) => {
    const r = resolve(e);
    if (isMinted(r)) return true;
    if (ts.isTemplateExpression(r)) return r.templateSpans.some((sp) => isMinted(sp.expression));
    if (ts.isBinaryExpression(r) && r.operatorToken.kind === ts.SyntaxKind.PlusToken) return minted(r.left) || minted(r.right);
    if (ts.isConditionalExpression(r)) return [r.whenTrue, r.whenFalse].every((b) => !derived(b) || minted(b));
    if (ts.isCallExpression(r) && r.arguments[0] !== undefined) {
      const arg = unwrap(r.arguments[0]);
      return ts.isArrayLiteralExpression(arg) && arg.elements.some((el) => isMinted(el));
    }
    return false;
  };
  /** @returns {boolean} */
  const derived = (/** @type {ts.Expression} */ e) => {
    const r = resolve(e);
    if (ts.isTemplateExpression(r)) return true;
    if (ts.isBinaryExpression(r) && r.operatorToken.kind === ts.SyntaxKind.PlusToken) return true;
    if (ts.isConditionalExpression(r)) return derived(r.whenTrue) || derived(r.whenFalse);
    if (ts.isCallExpression(r) && ts.isPropertyAccessExpression(r.expression) && r.expression.getText(sf) === 'JSON.stringify') return true;
    return false;
  };
  /** @type {{ id: string, line: number }[]} */
  const out = [];
  const consider = (/** @type {ts.Node} */ node, /** @type {ts.Expression} */ value) => {
    if (!derived(value) || minted(value)) return;
    /** @type {ts.CallExpression | undefined} */
    let call;
    /** @type {ts.Node | undefined} */
    let p = node.parent;
    let objectConst = null;
    while (p) {
      if (ts.isCallExpression(p) && !call && p.arguments.some((a) => a.pos <= node.pos && node.end <= a.end)) call = p;
      if (isInnerWriteCall(p)) return;
      if (!call && !objectConst && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) objectConst = p.name.text;
      p = p.parent;
    }
    if (call && ts.isIdentifier(call.expression) && SCOPED_CALLEES.has(call.expression.text)) return;
    if (objectConst !== null && passedIntoInner.has(objectConst)) return;
    const callee = call ? call.expression.getText(sf).replace(/\s+/g, ' ') : '(no call)';
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push({ id: `${file}|${callee}|${value.getText(sf).replace(/\s+/g, ' ')}`, line: line + 1 });
  };
  const visit = (/** @type {ts.Node} */ n) => {
    if (ts.isPropertyAssignment(n) && KEY_PROPS.has(n.name.getText(sf))) consider(n, n.initializer);
    if (ts.isShorthandPropertyAssignment(n) && KEY_PROPS.has(n.name.text)) consider(n, n.name);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && KEY_PROPS.has(n.left.name.text)) {
      consider(n, n.right);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function srcFiles() {
  return execFileSync('git', ['ls-files', '-z', '--', 'src'], { cwd: ROOT, env: cleanGitEnv(), maxBuffer: 1 << 26 })
    .toString('utf8')
    .split('\0')
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
}

const found = srcFiles().flatMap((f) => unscopedDerivedKeys(readFileSync(join(ROOT, f), 'utf8'), f));

test('every derived inner-write key in src/ runs under an internal scope, is minted, or is decided in writing', () => {
  assert.ok(found.length > 0 || Object.keys(DECIDED).length > 0, 'the analyser saw the corpus');
  const undecided = found.filter((f) => !(f.id in DECIDED)).map((f) => `${f.id}  (line ${f.line})`);
  assert.deepEqual(
    undecided,
    [],
    'run the inner write inside ctx.store.innerWrite(<composite>, ...) or post it with postEntryInternal(Checked); a key derived from a key or an id a caller can read is a key a caller can claim first (K1)',
  );
});

test('every DECIDED entry still names a real site (the list cannot rot)', () => {
  const ids = new Set(found.map((f) => f.id));
  // The PENDING entries name code another branch rewrites; once it lands they are deleted with it.
  const stale = Object.keys(DECIDED).filter((k) => !ids.has(k) && !DECIDED[/** @type {keyof typeof DECIDED} */ (k)].startsWith('PENDING'));
  assert.deepEqual(stale, []);
});

test('the analyser: a derived key outside a scope bites; inside one, minted, or scoped, it does not', () => {
  const bites = [
    'postEntry(ctx, { date, source: "manual", lines, idempotencyKey: `${input.idempotencyKey}:x` });',
    'createVendorBill(ctx, { vendorId, idempotencyKey: `vb:${row.id}` });',
    'const k = `${key}:pl`; postEntry(ctx, { idempotencyKey: k });',
    'linkFile(ctx, { fileId, idempotencyKey: JSON.stringify(["x", row.id]) });',
    'f(ctx, { idempotencyKey: input.idempotencyKey + ":x" });',
    'g(ctx, { ...(k === undefined ? {} : { idempotencyKey: `${k}:w` }) });',
    'poInput.idempotencyKey = `${input.idempotencyKey}:po`; poUpsert(ctx, poInput);',
  ];
  for (const s of bites) assert.equal(unscopedDerivedKeys(s, 'probe.ts').length, 1, s);
  const quiet = [
    'ctx.store.innerWrite("x", () => postEntry(ctx, { idempotencyKey: `${input.idempotencyKey}:x` }));',
    'postEntryInternalChecked(ctx, { idempotencyKey: `${input.idempotencyKey}:x` }, "x_internal");',
    'reverseOwnedEntry(ctx, { entryId, idempotencyKey: `rev:${row.id}` }, "owner");',
    'postEntry(ctx, { idempotencyKey: `invoice-post-${doc.id}-${ctx.ids.next("ipk")}` });',
    'const runId = ctx.ids.next("r"); uploadFile(ctx, { idempotencyKey: `${runId}-file` });',
    'postEntry(ctx, { idempotencyKey: input.idempotencyKey });',
    'const a = { idempotencyKey: `${input.idempotencyKey}:${d}` }; ctx.store.innerWrite("x", () => createPaymentBatch(ctx, a));',
  ];
  for (const s of quiet) assert.deepEqual(unscopedDerivedKeys(s, 'probe.ts'), [], s);
});
