/**
 * C00's dedupe/merge (US-C00.4) and revDSG anonymise (US-C00.6): the two elevated, irreversible-adjacent
 * contact verbs, kept out of A09's CRUD module because both re-point or redact rows the ordinary
 * edit path never touches.
 *
 * MERGE consolidates a duplicate onto a survivor: it re-points every live foreign key that names the
 * source to the target, sets `source.merged_into_id = target.id` (a one-way tombstone), and writes an
 * audit entry naming BOTH rows. It has ZERO LEDGER effect: no `postEntry` call exists in this module
 * (P3, upheld by absence), and the figures, which derive from documents and journal entries, are
 * unchanged because only the contact FK moves.
 *
 * IT IS NOT, HOWEVER, INVISIBLE TO A RENDERED DOCUMENT, and this module used to claim it was. A11
 * persists NO invoice snapshot: `buildQrBill` reads the LIVE contact row on every render, so the QR
 * Ultimate Debtor block, the eBill alternate address and therefore the PDF bytes of an ALREADY-ISSUED
 * invoice follow whatever the contact row says today. A merge changes that row's identity, exactly as
 * `update_contact` alone already does with no merge involved. MWSTG Art. 26 Abs. 2 lit. b makes the
 * recipient's name and place part of the invoice, so this is a real gap: it is A11's, it is recorded
 * as C00 §10 follow-up I1, and the decided repair shape is D52 (a filed artefact becomes a persisted
 * snapshot and the snapshot is authoritative). What is fixed HERE is the false claim.
 *
 * ANONYMISE honours a revDSG deletion request within OR 958f's retention duty: it blanks the personal
 * fields and redacts the activity bodies in one transaction, KEEPING the row ids so posted-document
 * FKs stay intact. It operates on the whole merge IDENTITY (the named contact plus every tombstone
 * that merged into it), because a duplicate's name and address survive the merge in the duplicate's
 * own row. The document rows, their numbers and the journal all survive; what does not survive is the
 * ability to RE-RENDER a payable QR-bill for them, since the debtor address is gone. That is why the
 * guard below refuses while any unsettled receivable or obligation is still live.
 *
 * Both are §H-IDEMPOTENT (a replay returns the stored result and writes nothing) and §H-TENANT (every
 * query is scoped to the workspace; a cross-tenant merge is impossible by construction).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { mapContact, readContact, resolveMergeChain, mergeIdentityRows, employeesOf } from './contact.js';
import type { ContactRow } from './contact.js';
import { DOCUMENT_STATUSES } from './document.js';
import type { DocumentStatus } from './document.js';
// E04's internal erasure hook, called INSIDE the anonymise transaction below (never an MCP tool of
// its own: erasure has ONE entry point, this verb). sales -> mail is a leaf import; the mail module
// imports nothing back from sales, so the graph stays acyclic.
import { purgeMailForContact } from '../mail/index.js';
// E05's internal erasure hook, the same shape one module over: called INSIDE the same transaction,
// BEFORE the mail purge (it needs the mail_message rows to find its own). sales -> voice is a leaf
// import too; voice imports mail and nothing back from sales.
import { purgeVoiceForContact } from '../voice/index.js';
// E06's internal erasure hook, the same single-entry-point rule as the two above: draft-run rows
// are derived from this identity's correspondence and go inside the same transaction.
import { purgeDraftRunsForContact } from '../drafting/index.js';
// A35's internal erasure hook (critic F9, 18.08.2026), the same single-entry-point rule: the agent
// trace records call ARGUMENTS verbatim, so an erased identity's name and email survive in
// `agent_call.args_json` (and possibly in a composer prose turn) unless swept in the same
// transaction. Imported from the trace module directly (it imports only context/result/guards), so
// the sales -> agent edge stays a leaf and the graph stays acyclic.
import { purgeAgentTraceForStrings } from '../agent/trace.js';

/**
 * The live foreign keys that name a contact and can be re-pointed by a merge, TODAY.
 *
 * This list is the merge's re-point surface. It GROWS as clusters land (C01 `deals.contact_id`, B00
 * `projects.contact_id`, E00/E03 link tables), each one adding a row here. It deliberately does NOT
 * include `payment.counterparty_id`: A14 freezes a posted payment with a DB immutability trigger
 * (`payment_no_money_update`), so its counterparty cannot be re-pointed at all. A payment whose
 * counterparty became a tombstone is resolved by `resolveContactRef` on the READ side instead, which
 * is the correct place for an append-only fact to be redirected without being rewritten.
 *
 * `contact.company_contact_id` is here because it is a live FK like any other. Leaving it out left
 * every employee of a merged-away company pointing at a tombstone: the drawer's Personen section
 * named a company `list_contacts` hides, and nothing ever repaired it.
 */
const MERGE_REPOINT_FKS: readonly { table: string; column: string }[] = [
  { table: 'document', column: 'contact_id' },
  { table: 'contact_activity', column: 'contact_id' },
  { table: 'contact', column: 'company_contact_id' },
  // B00 (the line this list's own comment reserved): a project names its client, and a project whose
  // client merged away would show a contact `list_contacts` hides. A project row is master data, not
  // an append-only financial fact, so the re-point is legal where A14's frozen payment row is not.
  { table: 'project', column: 'contact_id' },
  // C01 (the other line this list's own comment reserved, by name): a deal names the contact being
  // courted, and a deal whose contact merged away would render a card for a tombstone
  // `list_contacts` hides. A deal row is pre-financial CRM state, never an append-only fact, so
  // the re-point is legal for the same reason B00's is.
  { table: 'deal', column: 'contact_id' },
  // E04 (the "E00/E03 link tables" family this list's own comment reserved): the mail index
  // resolves senders to contacts, and an indexed thread whose person merged away would keep
  // naming a tombstone `list_contacts` hides. Both rows are DERIVED index state, never an
  // append-only financial fact, so the re-point is legal for the same reason B00's and C01's are;
  // a later reindex re-derives the same answer because `resolveContact` skips tombstones.
  { table: 'mail_message', column: 'contact_id' },
  { table: 'mail_thread', column: 'contact_id' },
];

/**
 * Merge the source contact into the target. Idempotent, transactional, and financially inert.
 *
 * Guards, in order: a contact cannot be merged into itself; the target must be a live contact (not a
 * tombstone); a source that employs people cannot be absorbed by a PERSON, or the re-point would
 * write employer links that `validateEmployer` refuses to accept; re-submitting a merge whose source
 * already points at this target is a no-op returning the same result.
 *
 * A CROSS-ROLE MERGE PROMOTES THE SURVIVOR TO `both` rather than being refused, and the reasoning is
 * the Swiss book rather than the type system: buying from and selling to the same firm is ordinary, so
 * a customer row and a vendor row for one company is the single most common legitimate duplicate. The
 * consolidated party genuinely IS both, `both` is the value A09 has for saying so, and widening a role
 * takes nothing away. It matters because `party_role` is what `planPayment` reads to stamp
 * `counterparty_kind`, and a survivor left at `vendor` would stamp `supplier` on a customer's later
 * over-payment, which `listOpenItems` filters out of the OP-Liste. The promotion is REPORTED in the
 * result, never applied in silence.
 */
export function mergeContacts(
  ctx: WorkspaceContext,
  input: { sourceId: string; targetId: string; idempotencyKey?: string },
): Result {
  if (input.sourceId === input.targetId) return err('self_merge', { contactId: input.sourceId });

  const source = readContact(ctx, input.sourceId);
  if (source === undefined) return err('not_found', { contactId: input.sourceId });
  const target = readContact(ctx, input.targetId);
  if (target === undefined) return err('not_found', { contactId: input.targetId });
  if (target.merged_into_id !== null) return err('target_merged', { targetId: input.targetId });

  // The employer FK is re-pointed below, so the target has to be able to HOLD it. A person absorbing
  // a company with employees would leave links the ordinary edit path rejects (US-C00.1).
  if (target.kind !== 'company') {
    const employees = employeesOf(ctx, input.sourceId);
    if (employees.length > 0) {
      return err('employer_must_be_company', {
        targetId: input.targetId,
        reason: 'source_has_employees',
        employeeCount: employees.length,
      });
    }
  }

  const run = (): Result => {
    // A source already merged into THIS target is a completed merge: settle to the same answer
    // rather than re-pointing a second time (§H-IDEMPOTENT, even without a key).
    const current = readContact(ctx, input.sourceId) as ContactRow;
    if (current.merged_into_id === input.targetId) {
      return ok({
        merged: { sourceId: input.sourceId, targetId: input.targetId, repointed: {}, partyRole: target.party_role, partyRolePromoted: false },
        contact: mapContact(target),
      });
    }
    if (current.merged_into_id !== null) {
      return err('already_merged', { sourceId: input.sourceId, into: current.merged_into_id });
    }

    const promoteRole = current.party_role !== target.party_role;
    const repointed: Record<string, number> = {};
    const tx = ctx.store.db.transaction(() => {
      for (const fk of MERGE_REPOINT_FKS) {
        const res = ctx.store.db
          .prepare(`UPDATE ${fk.table} SET ${fk.column} = ? WHERE workspace_id = ? AND ${fk.column} = ?`)
          .run(input.targetId, ctx.workspaceId, input.sourceId);
        // Keyed by table AND column: `contact` now contributes a row, and a bare table key would let
        // a second contact-owned FK silently overwrite this one's count.
        repointed[`${fk.table}.${fk.column}`] = res.changes;
      }
      // A survivor that was itself employed by the source would now name ITSELF as its employer, a
      // link the ordinary edit path rejects and nothing else would ever repair. Cleared, not left.
      ctx.store.db
        .prepare('UPDATE contact SET company_contact_id = NULL WHERE workspace_id = ? AND id = ? AND company_contact_id = ?')
        .run(ctx.workspaceId, input.targetId, input.targetId);
      if (promoteRole) {
        ctx.store.db
          .prepare("UPDATE contact SET party_role = 'both' WHERE workspace_id = ? AND id = ?")
          .run(ctx.workspaceId, input.targetId);
      }
      ctx.store.db
        .prepare('UPDATE contact SET merged_into_id = ? WHERE workspace_id = ? AND id = ?')
        .run(input.targetId, ctx.workspaceId, input.sourceId);
    });
    tx();

    // TWO ROWS, because a merge happens to TWO contacts and the tamper-evident trail has to name
    // both. One row on the target said only "something was merged into this survivor": WHICH
    // duplicate was consumed, the fact an auditor asking about a vanished contact actually needs,
    // was nowhere in the chain. The source row comes first because it is the one being retired.
    const at = ctx.clock.now();
    ctx.audit.record({ entityKind: 'contact', entityId: input.sourceId, action: 'contact_merge', actor: ctx.actor, at });
    ctx.audit.record({ entityKind: 'contact', entityId: input.targetId, action: 'contact_merge', actor: ctx.actor, at });

    const survivor = readContact(ctx, input.targetId) as ContactRow;
    return ok({
      merged: {
        sourceId: input.sourceId,
        targetId: input.targetId,
        repointed,
        partyRole: survivor.party_role,
        partyRolePromoted: promoteRole,
      },
      contact: mapContact(survivor),
    });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'contacts_merge', run);
  }
  return run();
}

/** The value a blanked personal name is replaced with (revDSG erasure, US-C00.6). */
const ANONYMISED_NAME = 'Anonymisiert';
/** The value a redacted activity body is replaced with. */
const REDACTED_BODY = '[anonymisiert]';

/**
 * The document statuses that still BIND one of the parties, and therefore block an erasure.
 *
 * revDSG grants a right to erasure; it does not compel one against an overriding interest, and an
 * unpaid claim is the textbook overriding interest. OR 958f Abs. 3 requires a retained business
 * record to stay readable for the whole retention period, and a live receivable whose debtor identity
 * has been blanked is not readable in the sense that matters: `buildQrBill` then fails
 * `needs_customer_address`, the PDF loses its payment part and `send_invoice` refuses, so the claim
 * survives in the Debitorenbuch as an amount nobody can be asked to pay.
 *
 * `draft` was the ONLY status this guard blocked on, against a twelve-value §H-ENUM, so an ISSUED and
 * unpaid invoice erased its own debtor. The line is now "does this document still bind either party":
 *
 *  - `draft` an unfinished document the operator has not decided about;
 *  - `issued`, `sent`, `partially_paid` a posted invoice with money still outstanding;
 *  - `accepted` a quote the customer has accepted and that is awaiting conversion;
 *  - `confirmed` an order both sides have agreed and that is awaiting invoicing.
 *
 * Everything else is terminal or carries its liveness on a successor document that blocks in its own
 * right: `settled` (paid in full), `declined`, `cancelled` (reversed, §H-AUDIT), `expired`,
 * `converted` and `superseded`. Those are retained under OR 958f and left untouched.
 *
 * The classification is TOTAL over `DOCUMENT_STATUSES` and asserted as such by test, so a thirteenth
 * status cannot join the enum without someone deciding which side of the erasure line it falls on.
 */
export const UNSETTLED_DOCUMENT_STATUSES: readonly DocumentStatus[] = [
  'draft',
  'issued',
  'sent',
  'accepted',
  'confirmed',
  'partially_paid',
];

/** The other half of the partition, exported so the totality check has both sides to compare. */
export const TERMINAL_DOCUMENT_STATUSES: readonly DocumentStatus[] = DOCUMENT_STATUSES.filter(
  (s) => !(UNSETTLED_DOCUMENT_STATUSES as readonly string[]).includes(s),
);

/**
 * Anonymise a contact on a valid revDSG deletion request, bounded by OR 958f (US-C00.6).
 *
 * A TOMBSTONE IS REFUSED, not followed. This is the one place where the merge-chain walk that every
 * other verb needs would be actively wrong: resolving S to T and erasing would blank the SURVIVOR, a
 * live party carrying every relationship the merge consolidated onto it, on the strength of a request
 * naming a retired id. An erasure cannot be undone, so erasing more than was asked for is the one
 * mistake with no repair. The rejection names the survivor, and erasing the survivor erases the whole
 * identity: `mergeIdentityRows` gathers the survivor plus every tombstone that merged into it, so the
 * duplicate's own name, email and address go with it. Nothing is left unerasable and nothing is erased
 * by surprise.
 *
 * Refuses while ANY row of that identity still carries an unsettled receivable or obligation (see
 * `UNSETTLED_DOCUMENT_STATUSES`). Posted, settled documents are retained (OR 958f) and untouched.
 *
 * The E04 local-correspondence purge is LIVE (2026-08-05): `purgeMailForContact` runs INSIDE this
 * verb's transaction, erasing the mail index rows (threads, messages, drafts, and the custom
 * field values hung on those threads) that reference the erased identity, because a mail index
 * keyed to a person IS personal data (revDSG Art. 6) and leaving it behind would make this
 * erasure a lie. The mail STORE on disk is untouched: TILL erases what TILL derived. A purge
 * failure aborts the whole anonymise rather than half-erasing (`test/mail/erasure-coverage.test.mjs`
 * holds the coverage to E04's own table list). The G05 `dispatches` redaction remains the
 * build-time-asserted extension when that cluster ships; its tables do not exist today.
 */
export function anonymiseContact(
  ctx: WorkspaceContext,
  input: { contactId: string; idempotencyKey?: string },
): Result {
  const contact = readContact(ctx, input.contactId);
  if (contact === undefined) return err('not_found', { contactId: input.contactId });
  if (contact.merged_into_id !== null) {
    return err('contact_merged', {
      contactId: input.contactId,
      survivorId: resolveMergeChain(ctx, contact).id,
      reason: 'anonymise_the_survivor_to_erase_this_identity',
    });
  }

  // The whole identity: the survivor plus every tombstone that merged into it. A merge leaves the
  // duplicate's personal fields in the duplicate's own row, so an erasure scoped to one row reports a
  // success it did not deliver.
  const identity = mergeIdentityRows(ctx, input.contactId);
  const idPlaceholders = identity.map(() => '?').join(', ');
  const statusPlaceholders = UNSETTLED_DOCUMENT_STATUSES.map(() => '?').join(', ');

  const openDocs = ctx.store.db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM document
        WHERE workspace_id = ? AND contact_id IN (${idPlaceholders})
          AND status IN (${statusPlaceholders})
        GROUP BY status`,
    )
    .all(ctx.workspaceId, ...identity, ...UNSETTLED_DOCUMENT_STATUSES) as { status: string; n: number }[];
  if (openDocs.length > 0) {
    return err('open_documents', {
      contactId: input.contactId,
      count: openDocs.reduce((n, row) => n + row.n, 0),
      statuses: openDocs.map((row) => row.status).sort(),
      blockingStatuses: [...UNSETTLED_DOCUMENT_STATUSES],
      reason: 'an_unsettled_claim_is_an_overriding_interest_revDSG_OR958f_Abs3',
    });
  }

  // The strings this erasure must reach EVERYWHERE, captured before the UPDATE overwrites them:
  // the identity's names and emails as stored. The trace sweep below runs on these values.
  const erasedStrings = (
    ctx.store.db
      .prepare(`SELECT name, email FROM contact WHERE workspace_id = ? AND id IN (${idPlaceholders})`)
      .all(ctx.workspaceId, ...identity) as { name: string | null; email: string | null }[]
  )
    .flatMap((row) => [row.name, row.email])
    .filter((v): v is string => typeof v === 'string' && v !== ANONYMISED_NAME);

  const run = (): Result => {
    let mailPurged = { threads: 0, messages: 0, drafts: 0, fieldValues: 0 };
    let voicePurged = { exemplars: 0 };
    let draftRunsPurged = { draftRuns: 0 };
    let tracePurged = { redacted: 0 };
    const tx = ctx.store.db.transaction(() => {
      ctx.store.db
        .prepare(
          `UPDATE contact SET
             name = ?, email = NULL,
             address_street = NULL, address_house_no = NULL, address_zip = NULL,
             address_city = NULL, address_country = NULL,
             vat_number = NULL, roles = '[]', segments = '[]'
           WHERE workspace_id = ? AND id IN (${idPlaceholders})`,
        )
        .run(ANONYMISED_NAME, ctx.workspaceId, ...identity);
      ctx.store.db
        .prepare(
          `UPDATE contact_activity SET body = ?
            WHERE workspace_id = ? AND contact_id IN (${idPlaceholders})`,
        )
        .run(REDACTED_BODY, ctx.workspaceId, ...identity);
      // E05 (spec §7 erasure-coverage): the voice exemplars embedded from this identity's mail go
      // FIRST, in the same transaction, because the purge needs the `mail_message` rows the E04
      // sweep below is about to erase. An embedding is deleted with a DELETE, which is the whole
      // reason retrieval beat fine-tuning (revDSG Art. 32 selects the architecture).
      voicePurged = purgeVoiceForContact(ctx, identity);
      // E06 (spec §8 revDSG fixture): the draft-run rows hung on this identity's threads go BEFORE
      // the E04 sweep too, because the purge needs the `mail_thread` rows to find its own.
      draftRunsPurged = purgeDraftRunsForContact(ctx, identity);
      // E04 (US-E04.5): the mail index rows referencing this identity go IN THE SAME TRANSACTION,
      // so a purge failure fails the whole anonymise rather than half-erasing. The mail store on
      // disk stays untouched: TILL erases what TILL derived.
      mailPurged = purgeMailForContact(ctx, identity);
      // A35 (critic F9): the agent trace recorded this identity's name/email verbatim in call
      // arguments (create_contact, update_contact, any verb that named them) and possibly in a
      // composer prose turn. Same transaction, same all-or-nothing rule as the three purges above.
      tracePurged = purgeAgentTraceForStrings(ctx, erasedStrings);
    });
    tx();

    // One chain row per ROW erased, in identity order (the survivor first). An erasure that touched
    // three rows and recorded one would leave two of them with no trace that they were ever erased.
    const at = ctx.clock.now();
    for (const id of identity) {
      ctx.audit.record({ entityKind: 'contact', entityId: id, action: 'contact_anonymise', actor: ctx.actor, at });
    }

    return ok({
      contact: mapContact(readContact(ctx, input.contactId) as ContactRow),
      /** Every row erased, so the caller can see the tombstones went with the survivor. */
      anonymisedContactIds: identity,
      /** The E04 mail-index rows that went with the person (US-E04.5): counts, so the erasure is inspectable. */
      mailPurged,
      /** The E05 voice exemplars embedded from that mail (spec §7): the DELETE a fine-tune could never offer. */
      voicePurged,
      /** The E06 draft runs hung on that mail (spec §8 revDSG fixture): metadata about the person's threads. */
      draftRunsPurged,
      /** The A35 trace rows whose recorded arguments (or prose) named the person (critic F9). */
      tracePurged,
    });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'contacts_anonymise', run);
  }
  return run();
}
