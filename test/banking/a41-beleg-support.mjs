// A41 (D184) test support: captured receipts beside a bank world. SYNTHETIC BY CONSTRUCTION: every vendor,
// IBAN, amount and date is invented here; the receipt bytes are a few made-up PNG-header bytes per receipt.

import { captureIntake, captureExtract } from '../../dist/core/purchase/index.js';
import { getAction } from '../../dist/api/registry.js';
import { confirmableStateOf } from '../../dist/core/banking/belegAssignment.js';
import { importLines, must } from './bank-inbox-support.mjs';

// --- A41.3 re-cut v2 (D184): the person's receipt verbs, through the registry -------------------------

let vk = 0;
/** Run one registry verb as `actor` (a person by default) and answer its result. */
export function verb(t, name, input, actor = 'user_1') {
  vk += 1;
  return getAction(name).run({ ...t.deps, actor }, { workspaceId: t.workspaceId, idempotencyKey: `a41v-${name}-${vk}`, ...input });
}

/** What a person sees of a capture and confirms: its bytes and every engine field (`expected`). */
export function seenOf(t, captureId, ctx = t.ctx) {
  return { captureId, expected: confirmableStateOf(ctx, captureId) };
}

/** A person confirms a receipt's figures as they see them now ("Zahlen bestätigen"). */
export function confirmFigures(t, r) {
  return must(verb(t, 'confirm_capture_figures', { captures: [seenOf(t, r.captureId)] }), 'confirm');
}

/** A person (or `actor`) assigns receipts to a line ("Anhängen"). */
export function assignBeleg(t, line, fileIds, actor = 'user_1') {
  return verb(t, 'assign_beleg', { bankTxnId: line, fileIds }, actor);
}

/** A captured receipt whose figures a person confirmed. */
export function confirmedReceipt(t, spec) {
  const r = receipt(t, spec);
  confirmFigures(t, r);
  return r;
}

/** Every assignment row of a line, oldest first. */
export const assignmentsOf = (t, line) =>
  t.store.db.prepare('SELECT * FROM beleg_assignment WHERE workspace_id = ? AND bank_txn_id = ? ORDER BY created_at, rowid').all(t.workspaceId, line);

/** The line's active assignment row, or undefined. */
export const activeOf = (t, line) => t.store.db.prepare("SELECT * FROM beleg_assignment WHERE workspace_id = ? AND bank_txn_id = ? AND state = 'active'").get(t.workspaceId, line);

export const VENDOR = 'Wolkenhaus AG';
export const VENDOR_IBAN = 'CH5800791123000889012';

let seq = 0;
/** Distinct bytes per receipt (the capture queue dedupes on the hash). */
const raster = (n) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, (n >> 8) & 0xff, n & 0xff, 7, 41]).toString('base64');

/**
 * Capture one receipt and state its fields as the agent would (`capture_extract source: agent`). Answers
 * `{ captureId, fileId }`. `amount` in Rappen; `vat` the printed VAT in Rappen, or undefined.
 */
export function receipt(t, { amount, currency = 'CHF', vendor = VENDOR, date = '2026-07-18', due, iban, vat, ctx = t.ctx } = {}) {
  seq += 1;
  const intake = must(captureIntake(ctx, { contentBase64: raster(seq), mime: 'image/png', filename: `beleg-${seq}.png`, idempotencyKey: `a41-in-${seq}` }), 'intake');
  const fields = [
    { key: 'amount', value: { minor: amount, currency }, confidence: 'high' },
    { key: 'currency', value: currency, confidence: 'high' },
    ...(vendor !== null ? [{ key: 'vendor_name', value: vendor, confidence: 'high' }] : []),
    ...(date !== null ? [{ key: 'invoice_date', value: date, confidence: 'high' }] : []),
    ...(due !== undefined ? [{ key: 'due_date', value: due, confidence: 'high' }] : []),
    ...(iban !== undefined ? [{ key: 'iban', value: iban, confidence: 'high' }] : []),
    ...(vat !== undefined ? [{ key: 'vat_amount', value: { minor: vat, currency }, confidence: 'high' }] : []),
  ];
  must(captureExtract(ctx, { captureId: intake.captureId, source: 'agent', fields, idempotencyKey: `a41-ex-${seq}` }), 'extract');
  const row = t.store.db.prepare('SELECT document_id FROM captures WHERE id = ?').get(intake.captureId);
  return { captureId: intake.captureId, fileId: row.document_id };
}

let st = 0;
/** Import debit lines; answers their ids in order. `lines[]`: `{ amount, name?, iban?, date?, ustrd?, cd? }`. */
export function lines(t, specs, opts = {}) {
  st += 1;
  // Each statement covers only its own lines' days, so two statements never overlap (an overlap would flag
  // a possible duplicate): give every call its own dates.
  const dates = specs.map((s) => s.date ?? '2026-07-20').sort();
  const res = importLines(
    t,
    {
      statementId: `A41-${st}`,
      seqNb: String(st),
      from: dates[0],
      to: dates[dates.length - 1],
      entries: specs.map((s, i) => ({
        ref: `A41S${st}L${i + 1}`,
        cd: s.cd ?? 'DBIT',
        name: s.name ?? 'WOLKENHAUS AG 8001',
        ...(s.iban !== undefined ? { iban: s.iban } : {}),
        amountMinor: s.amount,
        date: s.date ?? '2026-07-20',
        ...(s.ustrd !== undefined ? { ustrd: s.ustrd } : {}),
      })),
    },
    opts,
  );
  return specs.map((_, i) => res.lines[`A41S${st}L${i + 1}`]);
}
