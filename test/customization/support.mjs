/**
 * Shared fixture for the G00 suites.
 *
 * NOT A `.test.mjs`, so the one-level-deep glob `npm test` runs does not pick it up as a suite. The
 * precedent is `test/api/support.mjs`.
 *
 * `RECORD_FACTORIES` IS THE POINT OF THIS FILE AND IT IS DELIBERATELY EXHAUSTIVE. G00's central claim
 * is that a capability opts in with ONE row in `ENTITY_KINDS` and nothing else anywhere. The only
 * honest way to test that is to exercise every registered kind through the real verbs, which means
 * this file owes a way to mint one record of each. `assertEveryKindHasAFactory` then makes a NEW
 * registry row redden the suite until someone adds a factory here, which is the difference between a
 * test that covers the registry and a test that covers whatever the registry held the day it was
 * written.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { getAction } from '../../dist/api/registry.js';
import { ENTITY_KINDS, ENTITY_KIND_IDS } from '../../dist/core/customization/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { tempStoreDir, makeMaildirStore, sampleMessages } from '../mail/fixtures.mjs';

export const call = (deps, name, input) => getAction(name).run(deps, input);
export const count = (deps, sql, ...args) => deps.store.db.prepare(sql).get(...args).n;

/** A structurally valid Swiss IBAN (ISO 13616 mod-97), as the rest of the suite spells it. */
const PLAIN_IBAN = 'CH9300762011623852957';

function must(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

/**
 * The G20 shared open project: only one may be open per workspace, and the registry test seeds every
 * kind in ONE workspace, so the three G20 factories find-or-create rather than each minting one.
 */
function ensureOpenProject(deps, workspaceId, seed) {
  const listed = must(call(deps, 'implementation_project_list', { workspaceId }), 'implementation_project_list');
  const open = listed.projects.find((p) => p.phase !== 'closed');
  if (open !== undefined) return open.projectId;
  return must(
    call(deps, 'implementation_project_create', {
      workspaceId,
      sourceSystem: 'bexio',
      cutoverDate: '2027-06-30',
      mwstMethod: 'effektiv',
      idempotencyKey: `${seed}-impl-project`,
    }),
    'implementation_project_create',
  ).projectId;
}

/**
 * One record of each registered kind, minted through that capability's own verb.
 *
 * Never by INSERT. A hand-written row would let this suite keep passing over a kind whose real
 * creation path had changed, and `entityExists` would then be checked against a record shape the
 * product no longer produces.
 */
export const RECORD_FACTORIES = {
  contact: (deps, workspaceId, seed) =>
    must(
      call(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Muster AG', idempotencyKey: `${seed}-contact` }),
      'create_contact',
    ).contact.id,

  item: (deps, workspaceId, seed) =>
    must(
      call(deps, 'create_item', { workspaceId, name: 'Beratung', defaultUnitPriceMinor: 15000, idempotencyKey: `${seed}-item` }),
      'create_item',
    ).item.id,

  bank_account: (deps, workspaceId, seed, accId) =>
    must(
      call(deps, 'create_bank_account', {
        workspaceId,
        name: 'Hauptkonto',
        iban: PLAIN_IBAN,
        ledgerAccountId: accId('1020'),
        idempotencyKey: `${seed}-bank`,
      }),
      'create_bank_account',
    ).bankAccountId,

  // The KMU seed already minted these, so the "creation path" for an account in a fresh workspace is
  // the workspace itself. Read back through the verb rather than off the table.
  account: (deps, workspaceId) => {
    const listed = must(call(deps, 'list_accounts', { workspaceId, search: '1000' }), 'list_accounts');
    const row = listed.accounts.find((a) => a.number === '1000');
    assert.ok(row !== undefined, 'the KMU seed did not mint account 1000');
    return row.accountId ?? row.id;
  },

  cost_center: (deps, workspaceId, seed) =>
    must(
      call(deps, 'create_cost_center', { workspaceId, code: 'KS1', name: 'Vertrieb', idempotencyKey: `${seed}-cc` }),
      'create_cost_center',
    ).costCenterId,

  document: (deps, workspaceId, seed) =>
    must(call(deps, 'create_document', { workspaceId, type: 'invoice', idempotencyKey: `${seed}-doc` }), 'create_document')
      .document.id,

  // A14's `bankAccountId` is the LEDGER account the money moved on (an asset account such as 1020
  // Bankkonto), not an A19 `bank_account` row id. The name reads like the latter and is not, which is
  // worth stating here rather than rediscovering.
  payment: (deps, workspaceId, seed, accId) => {
    // A payment that settles nothing is parked as a Guthaben, and a Guthaben has to belong to
    // somebody: A14 answers `needs_counterparty` rather than parking money against nobody.
    const counterpartyId = must(
      call(deps, 'create_contact', {
        workspaceId,
        partyRole: 'customer',
        name: 'Zahler AG',
        idempotencyKey: `${seed}-payer`,
      }),
      'create_contact',
    ).contact.id;
    return must(
      call(deps, 'record_payment', {
        workspaceId,
        direction: 'incoming',
        date: '2026-03-01',
        amountMinor: 10000,
        bankAccountId: accId('1020'),
        counterpartyKind: 'customer',
        counterpartyId,
        // A payment moves money, so the caller states that deliberately on every call.
        intent: 'post_payment',
        idempotencyKey: `${seed}-payment`,
      }),
      'record_payment',
    ).paymentId;
  },

  journal_entry: (deps, workspaceId, seed, accId) =>
    must(
      call(deps, 'post_entry', {
        workspaceId,
        date: '2026-03-01',
        source: 'manual',
        idempotencyKey: `${seed}-entry`,
        lines: [
          { account: accId('6500'), debit: 5000 },
          { account: accId('1000'), credit: 5000 },
        ],
      }),
      'post_entry',
    ).entryId,

  // A17. A DRAFT bill, deliberately: the point of the factory is a row that exists, and drafting one
  // needs no VAT configuration and touches no period lock, so this stays the cheapest honest record.
  // The contact carries `partyRole: 'vendor'`, because A17 refuses a customer-only party with
  // `needs_vendor`.
  vendor_bill: (deps, workspaceId, seed, accId) => {
    const vendorId = must(
      call(deps, 'create_contact', {
        workspaceId,
        partyRole: 'vendor',
        name: 'Lieferant GmbH',
        idempotencyKey: `${seed}-vendor`,
      }),
      'create_contact',
    ).contact.id;
    return must(
      call(deps, 'create_vendor_bill', {
        workspaceId,
        vendorId,
        billDate: '2026-03-01',
        amountMinor: 108100,
        expenseAccountId: accId('6500'),
        idempotencyKey: `${seed}-bill`,
      }),
      'create_vendor_bill',
    ).vendorBillId;
  },

  // A15. A PROPOSED run, minted through the real escalation path: an issued invoice due 2026-06-01
  // is 45 days overdue at the fixture clock (2026-07-16), so it proposes at level 1 under the
  // shipped thresholds. VAT is seeded because `issue_invoice` posts the balanced VAT entry.
  dunning_run: (deps, workspaceId, seed, accId) => {
    must(call(deps, 'vat_seed_defaults', { workspaceId }), 'vat_seed_defaults');
    must(call(deps, 'set_vat_method', { workspaceId, vatMethod: 'effektiv', vatAccounting: 'soll' }), 'set_vat_method');
    const customerId = must(
      call(deps, 'create_contact', {
        workspaceId,
        partyRole: 'customer',
        name: 'Mahnkunde AG',
        idempotencyKey: `${seed}-debtor`,
      }),
      'create_contact',
    ).contact.id;
    const documentId = must(
      call(deps, 'create_document', {
        workspaceId,
        type: 'invoice',
        contactId: customerId,
        currency: 'CHF',
        dueDate: '2026-06-01',
        lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
        idempotencyKey: `${seed}-doc`,
      }),
      'create_document',
    ).document.id;
    must(call(deps, 'issue_invoice', { workspaceId, invoiceId: documentId, idempotencyKey: `${seed}-issue` }), 'issue_invoice');
    return must(
      call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: `${seed}-run` }),
      'propose_dunning_run',
    ).runId;
  },

  // A21. A recorded incoming credit in the Abgleich queue: the cheapest honest row, because
  // recording posts nothing and needs only an A19 Bankkonto to land on. The register is REUSED
  // when the `bank_account` factory already minted one in this workspace (the IBAN is unique per
  // workspace, so a second create with the same sample would refuse with duplicate_iban); the SIX
  // sample QR-IBAN keeps the two factories collision-free when this one runs first.
  reconciliation_match: (deps, workspaceId, seed, accId) => {
    const existing = must(call(deps, 'list_bank_accounts', { workspaceId }), 'list_bank_accounts');
    let bankAccountId = existing.bankAccounts.find((a) => a.archived !== true)?.id;
    if (bankAccountId === undefined) {
      bankAccountId = must(
        call(deps, 'create_bank_account', {
          workspaceId,
          name: 'PostFinance Geschäft',
          iban: 'CH44 3199 9123 0008 8901 2',
          currency: 'CHF',
          ledgerAccountId: accId('1020'),
          idempotencyKey: `${seed}-bank`,
        }),
        'create_bank_account',
      ).bankAccountId;
    }
    return must(
      call(deps, 'record_incoming_credit', {
        workspaceId,
        bankAccountId,
        amountMinor: 108100,
        valueDate: '2026-03-01',
        idempotencyKey: `${seed}-credit`,
      }),
      'record_incoming_credit',
    ).credit.creditId;
  },

  // A12. A minimal monthly schedule; the anchor is any valid date because nothing here ticks it.
  recurring_schedule: (deps, workspaceId, seed) => {
    const contactId = must(
      call(deps, 'create_contact', {
        workspaceId,
        partyRole: 'customer',
        name: 'Serie AG',
        idempotencyKey: `${seed}-serie-contact`,
      }),
      'create_contact',
    ).contact.id;
    return must(
      call(deps, 'create_recurring_schedule', {
        workspaceId,
        contactId,
        lines: [{ description: 'Beratung', unitPriceMinor: 100000 }],
        interval: 'monthly',
        anchorDate: '2026-08-01',
        idempotencyKey: `${seed}-schedule`,
      }),
      'create_recurring_schedule',
    ).schedule.id;
  },

  // A18. A DRAFT batch over one posted, open bill: the cheapest honest row, and it needs the whole
  // chain a real payment run needs (a debtor account, a posted bill, and the vendor's creditor
  // IBAN), because `create_payment_batch` validates all three before it writes anything.
  payment_batch: (deps, workspaceId, seed, accId) => {
    const vendorId = must(
      call(deps, 'create_contact', {
        workspaceId,
        partyRole: 'vendor',
        name: 'Zahllauf Lieferant GmbH',
        idempotencyKey: `${seed}-vendor`,
      }),
      'create_contact',
    ).contact.id;
    const billId = must(
      call(deps, 'create_vendor_bill', {
        workspaceId,
        vendorId,
        billDate: '2026-03-01',
        amountMinor: 108100,
        expenseAccountId: accId('6500'),
        idempotencyKey: `${seed}-bill`,
      }),
      'create_vendor_bill',
    ).vendorBillId;
    must(call(deps, 'post_vendor_bill', { workspaceId, vendorBillId: billId, idempotencyKey: `${seed}-post` }), 'post_vendor_bill');
    // REUSE an existing Bankkonto when this workspace's `bank_account` factory already minted one
    // (the IBAN is unique per workspace, the `reconciliation_match` factory's own pattern).
    const existingAccounts = must(call(deps, 'list_bank_accounts', { workspaceId }), 'list_bank_accounts');
    let bankAccountId = existingAccounts.bankAccounts.find((a) => a.archived !== true && a.receiveOnly !== true)?.id;
    if (bankAccountId === undefined) {
      bankAccountId = must(
        call(deps, 'create_bank_account', {
          workspaceId,
          name: 'Kontokorrent',
          iban: PLAIN_IBAN,
          ledgerAccountId: accId('1020'),
          idempotencyKey: `${seed}-bank`,
        }),
        'create_bank_account',
      ).bankAccountId;
    }
    // A PLAIN IBAN, deliberately: a QR-IBAN creditor would need a valid QRR on the bill, which this
    // minimal factory does not set (`create_vendor_bill` here passes no `vendorReference`).
    must(
      call(deps, 'set_creditor_bank_profile', {
        workspaceId,
        vendorId,
        iban: PLAIN_IBAN,
        idempotencyKey: `${seed}-profile`,
      }),
      'set_creditor_bank_profile',
    );
    return must(
      call(deps, 'create_payment_batch', {
        workspaceId,
        bankAccountId,
        itemIds: [billId],
        executionDate: '2026-03-15',
        idempotencyKey: `${seed}-batch`,
      }),
      'create_payment_batch',
    ).batchId;
  },

  automation_rule: (deps, workspaceId, seed) =>
    must(
      call(deps, 'create_automation_rule', {
        workspaceId,
        name: 'Beleg anlegen',
        trigger: { event: 'contact.created' },
        action: { tool: 'create_document', inputTemplate: { type: 'invoice' } },
        idempotencyKey: `${seed}-rule`,
      }),
      'create_automation_rule',
    ).rule.ruleId,

  // A20. A single DBIT entry imported from a minimal camt.053 fixture: cheaper than a CRDT (which
  // would route through A21's queue and needs a second factory's worth of setup). Reuses an existing
  // Bankkonto (the `reconciliation_match` precedent) so two factories running in one workspace never
  // collide on `duplicate_iban`, else mints its own with a THIRD IBAN distinct from the other two
  // factories' samples.
  bank_txn: (deps, workspaceId, seed, accId) => {
    const existing = must(call(deps, 'list_bank_accounts', { workspaceId }), 'list_bank_accounts');
    let account = existing.bankAccounts.find((a) => a.archived !== true);
    if (account === undefined) {
      const created = must(
        call(deps, 'create_bank_account', {
          workspaceId,
          name: 'Kontokorrent',
          iban: 'CH56 0483 5012 3456 7800 9',
          ledgerAccountId: accId('1020'),
          idempotencyKey: `${seed}-bank`,
        }),
        'create_bank_account',
      );
      account = must(call(deps, 'get_bank_account', { workspaceId, bankAccountId: created.bankAccountId }), 'get_bank_account')
        .bankAccount;
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
<BkToCstmrStmt><GrpHdr><MsgId>${seed}-msg</MsgId><CreDtTm>2026-03-05T08:00:00</CreDtTm></GrpHdr>
<Stmt><Id>${seed}-stmt</Id><ElctrncSeqNb>1</ElctrncSeqNb>
<FrToDt><FrDtTm>2026-03-01T00:00:00</FrDtTm><ToDtTm>2026-03-01T23:59:59</ToDtTm></FrToDt>
<Acct><Id><IBAN>${account.iban}</IBAN></Id></Acct>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">960.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Ntry><NtryRef>${seed}-ntry</NtryRef><Amt Ccy="CHF">40.00</Amt><CdtDbtInd>DBIT</CdtDbtInd>
<Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-03-01</Dt></BookgDt><ValDt><Dt>2026-03-01</Dt></ValDt>
<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>ICDT</Cd><SubFmlyCd>OTHR</SubFmlyCd></Fmly></Domn></BkTxCd>
</Ntry></Stmt></BkToCstmrStmt></Document>`;
    const imported = must(
      call(deps, 'import_camt', { workspaceId, bankAccountId: account.id, xml, idempotencyKey: `${seed}-import` }),
      'import_camt',
    );
    const listed = must(call(deps, 'list_reconciliation', { workspaceId, statementId: imported.statementId }), 'list_reconciliation');
    const row = [...listed.matched, ...listed.unmatched, ...listed.partial].find((t) => t.entryRef === `${seed}-ntry`);
    assert.ok(row !== undefined, 'import_camt did not produce the fixture entry');
    return row.bankTxnId;
  },

  // A23. The workspace the whole fixture already runs in IS a record of this kind, minted through
  // the real `create_workspace` by `mintWorkspace`: its "creation path" is the fixture itself, the
  // `account` factory's reasoning one registry over.
  workspace: (deps, workspaceId) => workspaceId,

  // G07. The attachment-only saved-search hook rides the workspace table's self-tenant shape (spec
  // §4), so its one record is the workspace itself: the A23 factory's reasoning, one kind over.
  global_search: (deps, workspaceId) => workspaceId,

  // G10. A Zuordnungsvorlage, minted through the real verbs: a map is set with `migration_set_map`
  // and snapshotted with `migration_save_map_template`, whose `templateId` IS the record id for
  // this kind. The `migration_plan` row is the ONE seeded precondition, because the verb that
  // creates a plan is G09's and does not exist yet: the row here is the seam G10's spec defines,
  // seeded through the store exactly the way `test/api/conformance-contract.mjs` seeds its own
  // `migration_plan` rows (its comment says to switch to `migration_create_plan` when G09 lands).
  migration_map_template: (deps, workspaceId, seed) => {
    deps.store.db
      .prepare(
        `INSERT INTO migration_plan (id, workspace_id, status, source_adapter, locale_pack, data_class, created_at)
         VALUES (?, ?, 'draft', 'csv', 'ch', NULL, ?)`,
      )
      .run(`${seed}-plan`, workspaceId, deps.clock.now());
    must(
      call(deps, 'migration_set_map', {
        workspaceId,
        planId: `${seed}-plan`,
        kind: 'account',
        entries: [{ source: '1010', sourceName: 'Kasse', balanceMinor: 120000, target: '1000' }],
        idempotencyKey: `${seed}-map`,
      }),
      'migration_set_map',
    );
    return must(
      call(deps, 'migration_save_map_template', {
        workspaceId,
        planId: `${seed}-plan`,
        name: 'Standard Kassen-Zuordnung',
        sourceSystem: 'csv',
        kinds: ['account'],
        idempotencyKey: `${seed}-tpl`,
      }),
      'migration_save_map_template',
    ).templateId;
  },

  // G09. A migration PLAN, minted through the real `migration_create_plan`: the plan-creating verb
  // is G09's own now (G10's seam seeded the row directly because this verb did not yet exist). A
  // past Übernahmestichtag keeps `cutover_in_future` from refusing it.
  migration_plan: (deps, workspaceId, seed) =>
    must(
      call(deps, 'migration_create_plan', {
        workspaceId,
        sourceSystem: 'bexio',
        cutoverDate: '2026-01-01',
        localePack: 'ch',
        idempotencyKey: `${seed}-plan`,
      }),
      'migration_create_plan',
    ).planId,

  // G09. A migration STEP, minted through the real `migration_set_scope`, whose first returned step
  // IS the record id for this kind. A plan is the seeded precondition, created through its own verb,
  // and `contacts` is the cheapest first-scope class (non-money, no chart or VAT setup).
  migration_step: (deps, workspaceId, seed) => {
    const planId = must(
      call(deps, 'migration_create_plan', {
        workspaceId,
        sourceSystem: 'bexio',
        cutoverDate: '2026-01-01',
        localePack: 'ch',
        idempotencyKey: `${seed}-step-plan`,
      }),
      'migration_create_plan',
    ).planId;
    const scoped = must(
      call(deps, 'migration_set_scope', {
        workspaceId,
        planId,
        classes: [{ dataClass: 'contacts', include: true }],
        idempotencyKey: `${seed}-step-scope`,
      }),
      'migration_set_scope',
    );
    return scoped.steps[0].stepId;
  },

  // G11. A persisted Eröffnungsprüfung, minted through the real `migration_check_step` over a plan
  // and step created through their own verbs, whose `checkId` IS the record id for this kind.
  migration_check: (deps, workspaceId, seed) => {
    const planId = must(
      call(deps, 'migration_create_plan', {
        workspaceId,
        sourceSystem: 'bexio',
        cutoverDate: '2026-01-01',
        localePack: 'ch',
        idempotencyKey: `${seed}-check-plan`,
      }),
      'migration_create_plan',
    ).planId;
    const scoped = must(
      call(deps, 'migration_set_scope', {
        workspaceId,
        planId,
        classes: [{ dataClass: 'contacts', include: true }],
        idempotencyKey: `${seed}-check-scope`,
      }),
      'migration_set_scope',
    );
    const checked = must(
      call(deps, 'migration_check_step', {
        workspaceId,
        planId,
        stepId: scoped.steps[0].stepId,
        against: 'testmandant',
        idempotencyKey: `${seed}-check-run`,
      }),
      'migration_check_step',
    );
    return checked.checkId;
  },

  // G19. An extraction manifest, minted through the real `migration_set_manifest` over a bexio plan
  // created through its own verb, whose `manifestId` IS the record id for this kind.
  migration_extraction_manifest: (deps, workspaceId, seed) => {
    const planId = must(
      call(deps, 'migration_create_plan', {
        workspaceId,
        sourceSystem: 'bexio',
        cutoverDate: '2026-01-01',
        localePack: 'ch',
        idempotencyKey: `${seed}-manifest-plan`,
      }),
      'migration_create_plan',
    ).planId;
    return must(
      call(deps, 'migration_set_manifest', {
        workspaceId,
        planId,
        idempotencyKey: `${seed}-manifest`,
      }),
      'migration_set_manifest',
    ).manifestId;
  },

  // G13. A gl_archive_entry, minted through the REAL import chain: the export uploaded as the E00
  // Beleg, a plan created and discovered over it, the gl_history class scoped in, and
  // `gl_archive_import` writing the archive rows. Never an INSERT: the entry this factory returns
  // is exactly the record the product produces, trigger-protected and provenance-linked.
  gl_archive_entry: (deps, workspaceId, seed) => {
    const csv = [
      'Datum,BelegNr,Konto,Soll,Haben,Buchungstext',
      '2019-03-05,B-1,1000,10000,0,Bareinnahme',
      '2019-03-05,B-1,3400,0,10000,Ertrag',
      '',
    ].join('\n');
    const uploaded = must(
      call(deps, 'files_upload', {
        workspaceId,
        contentBase64: Buffer.from(csv, 'utf8').toString('base64'),
        filename: 'gl-history.csv',
        mime: 'text/csv',
        idempotencyKey: `${seed}-glfile`,
      }),
      'files_upload',
    );
    const planId = must(
      call(deps, 'migration_create_plan', {
        workspaceId,
        sourceSystem: 'bexio',
        cutoverDate: '2026-01-01',
        localePack: 'ch',
        idempotencyKey: `${seed}-glplan`,
      }),
      'migration_create_plan',
    ).planId;
    must(
      call(deps, 'migration_discover_source', { workspaceId, planId, fileIds: [uploaded.file.id] }),
      'migration_discover_source',
    );
    const scoped = must(
      call(deps, 'migration_set_scope', {
        workspaceId,
        planId,
        classes: [{ dataClass: 'gl_history', include: true }],
        idempotencyKey: `${seed}-glscope`,
      }),
      'migration_set_scope',
    );
    const stepId = scoped.steps.find((s) => s.dataClass === 'gl_history').stepId;
    must(
      call(deps, 'gl_archive_import', { workspaceId, planId, stepId, idempotencyKey: `${seed}-glimp` }),
      'gl_archive_import',
    );
    return deps.store.db
      .prepare('SELECT id FROM gl_archive_entry WHERE workspace_id = ? ORDER BY id LIMIT 1')
      .get(workspaceId).id;
  },

  // B00. A project, minted through the real `project_create` over a C00 contact created through its
  // own verb (the `recurring_schedule` factory's shape).
  project: (deps, workspaceId, seed) => {
    const contactId = must(
      call(deps, 'create_contact', {
        workspaceId,
        partyRole: 'customer',
        name: 'Projekt Kunde AG',
        idempotencyKey: `${seed}-proj-contact`,
      }),
      'create_contact',
    ).contact.id;
    return must(
      call(deps, 'project_create', {
        workspaceId,
        name: 'Website Relaunch',
        contactId,
        budgetMinor: 500000,
        idempotencyKey: `${seed}-project`,
      }),
      'project_create',
    ).project.id;
  },

  // B00. A phase, minted through the real `project_phase_add` over a project created the same way.
  project_phase: (deps, workspaceId, seed) => {
    const contactId = must(
      call(deps, 'create_contact', {
        workspaceId,
        partyRole: 'customer',
        name: 'Phasen Kunde AG',
        idempotencyKey: `${seed}-phase-contact`,
      }),
      'create_contact',
    ).contact.id;
    const projectId = must(
      call(deps, 'project_create', {
        workspaceId,
        name: 'Umbau Büro',
        contactId,
        idempotencyKey: `${seed}-phase-project`,
      }),
      'project_create',
    ).project.id;
    return must(
      call(deps, 'project_phase_add', {
        workspaceId,
        projectId,
        name: 'Konzept',
        budgetMinor: 100000,
        idempotencyKey: `${seed}-phase`,
      }),
      'project_phase_add',
    ).phase.id;
  },

  // A25. An `entry_review` row is the sidecar A25 hangs on a posted journal entry. The cheapest
  // honest record is a real posted entry (the `journal_entry` factory's shape) flagged through the
  // real `flag_entry` verb, whose `reviewId` IS the record id for this kind.
  entry_review: (deps, workspaceId, seed, accId) => {
    const entryId = must(
      call(deps, 'post_entry', {
        workspaceId,
        date: '2026-03-01',
        source: 'manual',
        idempotencyKey: `${seed}-entry`,
        lines: [
          { account: accId('6500'), debit: 5000 },
          { account: accId('1000'), credit: 5000 },
        ],
      }),
      'post_entry',
    ).entryId;
    return must(
      call(deps, 'flag_entry', { workspaceId, entryId, reason: 'Beleg prüfen', idempotencyKey: `${seed}-flag` }),
      'flag_entry',
    ).reviewId;
  },

  // E03. A task through its own creation verb; `taskId` IS the record id for this kind.
  task: (deps, workspaceId, seed) =>
    must(
      call(deps, 'tasks_create', {
        workspaceId,
        title: 'Offerte nachfassen',
        assigneeUserId: 'agent',
        dueAt: '2026-09-30',
        idempotencyKey: `${seed}-task`,
      }),
      'tasks_create',
    ).taskId,

  // B01. A time entry through the real verbs: a C00 contact, a B00 project, a default rate card
  // (time_log refuses with no_rate_defined until one exists), then one logged hour.
  time_entry: (deps, workspaceId, seed) => {
    const contactId = must(
      call(deps, 'create_contact', {
        workspaceId,
        partyRole: 'customer',
        name: 'Zeit Kunde AG',
        idempotencyKey: `${seed}-time-contact`,
      }),
      'create_contact',
    ).contact.id;
    const projectId = must(
      call(deps, 'project_create', {
        workspaceId,
        name: 'Zeiterfassung',
        contactId,
        idempotencyKey: `${seed}-time-project`,
      }),
      'project_create',
    ).project.id;
    must(
      call(deps, 'rate_card_upsert', {
        workspaceId,
        scope: 'default',
        rateMinor: 15000,
        validFrom: '2026-01-01',
        idempotencyKey: `${seed}-time-rate`,
      }),
      'rate_card_upsert',
    );
    return must(
      call(deps, 'time_log', {
        workspaceId,
        userId: 'agent',
        projectId,
        startedAt: '2026-07-10T09:00:00.000Z',
        minutes: 60,
        idempotencyKey: `${seed}-time-entry`,
      }),
      'time_log',
    ).entry.id;
  },

  // C01. A deal through its own creation verb over a C00 contact created through its own; the first
  // deal write also seeds the default pipeline, which is the real production path.
  deal: (deps, workspaceId, seed) => {
    const contactId = must(
      call(deps, 'create_contact', {
        workspaceId,
        partyRole: 'customer',
        name: 'Funnel AG',
        idempotencyKey: `${seed}-deal-contact`,
      }),
      'create_contact',
    ).contact.id;
    return must(
      call(deps, 'deals_create', {
        workspaceId,
        contactId,
        title: 'Website-Relaunch',
        valueMinor: 250000,
        idempotencyKey: `${seed}-deal`,
      }),
      'deals_create',
    ).dealId;
  },

  // D01 inventory / stock: a location and a stocktake session, both OP3 kinds. The stocktake needs a
  // frozen book position to exist, so mint an item + a receipt movement first, then open a session.
  stock_location: (deps, workspaceId, seed) =>
    must(
      call(deps, 'stock_location_upsert', { workspaceId, name: 'Hauptlager', idempotencyKey: `${seed}-loc` }),
      'stock_location_upsert',
    ).location.id,

  stocktake: (deps, workspaceId, seed) => {
    const item = must(
      call(deps, 'create_item', { workspaceId, name: 'Widget', defaultUnitPriceMinor: 5000, idempotencyKey: `${seed}-item` }),
      'create_item',
    ).item.id;
    const loc = must(
      call(deps, 'stock_location_upsert', { workspaceId, name: 'Lager', idempotencyKey: `${seed}-loc` }),
      'stock_location_upsert',
    ).location.id;
    must(
      call(deps, 'stock_move', {
        workspaceId,
        itemId: item,
        locationId: loc,
        qty: 10,
        reason: 'receipt',
        unitCostMinor: 2000,
        movedAt: '2026-03-01',
        idempotencyKey: `${seed}-recv`,
      }),
      'stock_move',
    );
    return must(
      call(deps, 'stock_stocktake_open', { workspaceId, frozenAt: '2026-03-31', idempotencyKey: `${seed}-take` }),
      'stock_stocktake_open',
    ).session.id;
  },

  // C02 quotes / proposals: a quote (a document type='quote') and one of its lines, both OP3 kinds.
  // The line factory reads the created quote back so the value hangs on a real document_line row.
  quote: (deps, workspaceId, seed) => {
    const contactId = must(
      call(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Offerte AG', idempotencyKey: `${seed}-q-contact` }),
      'create_contact',
    ).contact.id;
    return must(
      call(deps, 'quotes_create', {
        workspaceId,
        contactId,
        validUntil: '2027-01-31',
        lines: [{ description: 'Beratung', unitPriceMinor: 15000 }],
        idempotencyKey: `${seed}-quote`,
      }),
      'quotes_create',
    ).document.id;
  },

  quote_line: (deps, workspaceId, seed) => {
    const contactId = must(
      call(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Offerte GmbH', idempotencyKey: `${seed}-ql-contact` }),
      'create_contact',
    ).contact.id;
    const quoteId = must(
      call(deps, 'quotes_create', {
        workspaceId,
        contactId,
        lines: [{ description: 'Position', unitPriceMinor: 8000 }],
        idempotencyKey: `${seed}-ql-quote`,
      }),
      'quotes_create',
    ).document.id;
    return must(call(deps, 'quotes_get', { workspaceId, quoteId }), 'quotes_get').lines[0].id;
  },

  // D03 sales orders & delivery notes: a sales order (its own table) and a delivery note, both OP3
  // kinds. The order carries one free-text (service) line, which needs no stock; the note needs a
  // confirmed order with a stock line, so mint an item + location + receipt, order it, confirm, then
  // draft the note (draft is enough to hang a custom field on it).
  sales_order: (deps, workspaceId, seed) => {
    const contactId = must(
      call(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Auftrag AG', idempotencyKey: `${seed}-so-contact` }),
      'create_contact',
    ).contact.id;
    return must(
      call(deps, 'sales_order_create', {
        workspaceId,
        contactId,
        lines: [{ description: 'Montage', quantityMilli: 1000, unitPriceMinor: 12000 }],
        idempotencyKey: `${seed}-so`,
      }),
      'sales_order_create',
    ).salesOrder.id;
  },

  delivery_note: (deps, workspaceId, seed) => {
    const item = must(
      call(deps, 'create_item', { workspaceId, name: 'Widget', defaultUnitPriceMinor: 5000, idempotencyKey: `${seed}-dn-item` }),
      'create_item',
    ).item.id;
    deps.store.db
      .prepare('UPDATE item SET track_stock = 1 WHERE workspace_id = ? AND id = ?')
      .run(workspaceId, item);
    const loc = must(
      call(deps, 'stock_location_upsert', { workspaceId, name: 'Lager', idempotencyKey: `${seed}-dn-loc` }),
      'stock_location_upsert',
    ).location.id;
    must(
      call(deps, 'stock_move', { workspaceId, itemId: item, locationId: loc, qty: 10, reason: 'receipt', unitCostMinor: 2000, movedAt: '2026-03-01', idempotencyKey: `${seed}-dn-recv` }),
      'stock_move',
    );
    const orderId = must(
      call(deps, 'sales_order_create', { workspaceId, lines: [{ itemId: item, quantityMilli: 3000, unitPriceMinor: 5000 }], idempotencyKey: `${seed}-dn-order` }),
      'sales_order_create',
    ).salesOrder.id;
    must(call(deps, 'sales_order_confirm', { workspaceId, salesOrderId: orderId, idempotencyKey: `${seed}-dn-confirm` }), 'sales_order_confirm');
    return must(
      call(deps, 'delivery_note_create', { workspaceId, salesOrderId: orderId, locationId: loc, idempotencyKey: `${seed}-dn-note` }),
      'delivery_note_create',
    ).deliveryNote.id;
  },

  // D02 purchasing: a purchase order (its own table). Needs a supplier contact and one item line with
  // an explicit price (draft is enough to hang a custom field on it).
  po: (deps, workspaceId, seed) => {
    const supplier = must(
      call(deps, 'create_contact', { workspaceId, partyRole: 'vendor', name: 'Lieferant GmbH', idempotencyKey: `${seed}-po-supplier` }),
      'create_contact',
    ).contact.id;
    const item = must(
      call(deps, 'create_item', { workspaceId, name: 'Rohstoff', defaultUnitPriceMinor: 4000, idempotencyKey: `${seed}-po-item` }),
      'create_item',
    ).item.id;
    return must(
      call(deps, 'po_upsert', {
        workspaceId,
        supplierContactId: supplier,
        lines: [{ itemId: item, qty: 5, unitPriceRappen: 4000 }],
        idempotencyKey: `${seed}-po`,
      }),
      'po_upsert',
    ).poId;
  },

  // E02 HR-lite: an employee is minted directly; an absence and a claim each need an employee first.
  employee: (deps, workspaceId, seed) =>
    must(
      call(deps, 'hr_employee_upsert', {
        workspaceId,
        employee: { firstName: 'Alex', lastName: 'Muster', employmentPct: 80, startsOn: '2026-01-01' },
        idempotencyKey: `${seed}-emp`,
      }),
      'hr_employee_upsert',
    ).employeeId,

  absence: (deps, workspaceId, seed) => {
    const employeeId = must(
      call(deps, 'hr_employee_upsert', {
        workspaceId,
        employee: { firstName: 'Robin', lastName: 'Beispiel', employmentPct: 100, startsOn: '2026-01-01' },
        idempotencyKey: `${seed}-abs-emp`,
      }),
      'hr_employee_upsert',
    ).employeeId;
    return must(
      call(deps, 'hr_absence_record', { workspaceId, employeeId, kind: 'vacation', fromDate: '2026-07-01', toDate: '2026-07-05', idempotencyKey: `${seed}-abs` }),
      'hr_absence_record',
    ).absenceId;
  },

  expense_claim: (deps, workspaceId, seed) => {
    const employeeId = must(
      call(deps, 'hr_employee_upsert', {
        workspaceId,
        employee: { firstName: 'Sam', lastName: 'Kläger', employmentPct: 60, startsOn: '2026-01-01' },
        idempotencyKey: `${seed}-clm-emp`,
      }),
      'hr_employee_upsert',
    ).employeeId;
    return must(
      call(deps, 'expense_claim_create', { workspaceId, employeeId, title: 'Reise Zürich', idempotencyKey: `${seed}-clm` }),
      'expense_claim_create',
    ).claimId;
  },

  // B04 retainers & mandates: a mandate through its own creation verb over a C00 contact created
  // through its own. The retainer is the OP3 attachment surface; the drawdown ledger is internal.
  retainer: (deps, workspaceId, seed) => {
    const contactId = must(
      call(deps, 'create_contact', {
        workspaceId,
        partyRole: 'customer',
        name: 'Mandat Kunde AG',
        idempotencyKey: `${seed}-ret-contact`,
      }),
      'create_contact',
    ).contact.id;
    return must(
      call(deps, 'retainer_create', {
        workspaceId,
        contactId,
        period: 'monthly',
        feeRappen: 250000,
        includedHours: 10,
        rollover: false,
        startsOn: '2026-01-01',
        idempotencyKey: `${seed}-ret`,
      }),
      'retainer_create',
    ).retainer.id;
  },

  // E01 e-signature: a draft sign request through its own creation verb, over an E00 file and a
  // C00 contact each created through their own (the signer must carry an email or the engine
  // refuses with signer_email_missing).
  sign_request: (deps, workspaceId, seed) => {
    const fileId = must(
      call(deps, 'files_upload', {
        workspaceId,
        title: 'Vertrag',
        filename: 'vertrag.pdf',
        mime: 'application/pdf',
        contentBase64: Buffer.from(`%PDF-1.4 ${seed} vertrag`).toString('base64'),
        idempotencyKey: `${seed}-sig-file`,
      }),
      'files_upload',
    ).file.id;
    const signerContactId = must(
      call(deps, 'create_contact', {
        workspaceId,
        partyRole: 'customer',
        name: 'Unterzeichner AG',
        email: 'unterschrift@example.ch',
        idempotencyKey: `${seed}-sig-contact`,
      }),
      'create_contact',
    ).contact.id;
    return must(
      call(deps, 'sign_requests_create', {
        workspaceId,
        fileId,
        signerContactId,
        signatureLevel: 'ses',
        idempotencyKey: `${seed}-sig-req`,
      }),
      'sign_requests_create',
    ).signRequestId;
  },

  // F02 customer portal: a draft grant through its own creation verb, over a C00 contact created
  // through its own. The `all_invoices` scope needs no pre-existing invoice (it belongs to the
  // contact by definition), so the factory mints exactly one contact and one grant.
  portal_grant: (deps, workspaceId, seed) => {
    const contactId = must(
      call(deps, 'create_contact', {
        workspaceId,
        partyRole: 'customer',
        name: 'Portal Kundin AG',
        email: 'portal@example.ch',
        idempotencyKey: `${seed}-portal-contact`,
      }),
      'create_contact',
    ).contact.id;
    return must(
      call(deps, 'portal_grant_create', {
        workspaceId,
        contactId,
        scopes: [{ kind: 'all_invoices' }],
        expiresAt: '2099-12-31',
        idempotencyKey: `${seed}-portal-grant`,
      }),
      'portal_grant_create',
    ).grantId;
  },

  // F01 report builder: a saved report over the always-present `contacts` source, then one run of it.
  // The run is the OP3 attachment surface (report_runs.id); saving the definition and running it both
  // go through F01's own verbs, so this factory proves the kind end to end the way the others do.
  report_run: (deps, workspaceId, seed) => {
    const report = must(
      call(deps, 'reports_save', {
        workspaceId,
        name: 'Kontaktliste',
        source: 'contacts',
        columns: ['name'],
        idempotencyKey: `${seed}-rep-save`,
      }),
      'reports_save',
    ).report.id;
    return must(
      call(deps, 'reports_run', {
        workspaceId,
        reportId: report,
        idempotencyKey: `${seed}-rep-run`,
      }),
      'reports_run',
    ).artifactRef;
  },

  // E04 local mail store: a thread through the real path (connect a fixture Maildir on disk, then
  // reindex derives it). The suite's generic per-kind field test uses type `select`, which is
  // inside the kind's declared `fieldTypes` slice; the free-form refusal has its own E04 suite.
  mail_thread: (deps, workspaceId, seed) => {
    const root = tempStoreDir(`till-g00-${seed}-`);
    makeMaildirStore(root, sampleMessages());
    const accountId = must(
      call(deps, 'mail_connect', {
        workspaceId,
        adapter: 'thunderbird',
        storePath: root,
        address: 'praxis@example.ch',
        idempotencyKey: `${seed}-mail-conn`,
      }),
      'mail_connect',
    ).accountId;
    must(call(deps, 'mail_reindex', { workspaceId, accountId, idempotencyKey: `${seed}-mail-re` }), 'mail_reindex');
    const threads = must(call(deps, 'mail_threads_list', { workspaceId, accountId }), 'mail_threads_list');
    return threads.items[0].id;
  },

  // F03 vendor portal: a remittance advice over a real outgoing supplier payment settling a posted
  // A17 bill. Every step goes through F03's/A14's/A17's own verbs, so the factory proves the kind end
  // to end the way the others do. VAT is seeded because posting the bill books the balanced VST entry.
  remittance_advice: (deps, workspaceId, seed, accId) => {
    must(call(deps, 'vat_seed_defaults', { workspaceId }), 'vat_seed_defaults');
    must(call(deps, 'set_vat_method', { workspaceId, vatMethod: 'effektiv', vatAccounting: 'soll' }), 'set_vat_method');
    const vendorId = must(
      call(deps, 'create_contact', { workspaceId, partyRole: 'vendor', name: 'Lieferant GmbH', idempotencyKey: `${seed}-ra-vendor` }),
      'create_contact',
    ).contact.id;
    const billId = must(
      call(deps, 'create_vendor_bill', {
        workspaceId,
        vendorId,
        billDate: '2026-03-01',
        amountMinor: 108100,
        amountIsGross: true,
        taxCode: 'VST-M',
        expenseAccountId: accId('6500'),
        idempotencyKey: `${seed}-ra-bill`,
      }),
      'create_vendor_bill',
    ).vendorBillId;
    must(call(deps, 'post_vendor_bill', { workspaceId, vendorBillId: billId, idempotencyKey: `${seed}-ra-post` }), 'post_vendor_bill');
    const paymentId = must(
      call(deps, 'record_payment', {
        workspaceId,
        direction: 'outgoing',
        date: '2026-03-20',
        amountMinor: 108100,
        bankAccountId: accId('1020'),
        allocations: [{ vendorBillId: billId, amountMinor: 108100 }],
        intent: 'post_payment',
        idempotencyKey: `${seed}-ra-pay`,
      }),
      'record_payment',
    ).paymentId;
    return must(
      call(deps, 'vendor_portal_remittance_create', { workspaceId, paymentId, idempotencyKey: `${seed}-ra-adv` }),
      'vendor_portal_remittance_create',
    ).adviceId;
  },
  // G04. A real backup goes through `create_backup`, which writes an artifact bundle to disk, so the
  // factory points `deps.backupDir` at a fresh temp directory (the conformance fixture's shape) so the
  // suite never touches the developer's real ~/.till, then returns the `backups` row's id.
  backup: (deps, workspaceId, seed) => {
    deps.backupDir = tempStoreDir();
    return must(
      call(deps, 'create_backup', { workspaceId, idempotencyKey: `${seed}-bk` }),
      'create_backup',
    ).backupId;
  },

  // G05: a document template, minted through its own verb. The OP3 row is what gives templates
  // custom fields, saved views and the E00 logo link in one line, and this factory is what makes
  // the generic suites exercise that claim.
  document_template: (deps, workspaceId, seed) =>
    must(
      call(deps, 'create_document_template', {
        workspaceId,
        documentKind: 'invoice',
        name: 'Briefpapier',
        idempotencyKey: `${seed}-doctpl`,
      }),
      'create_document_template',
    ).template.templateId,

  // G06: one delivered inbox item through the real OP8 action target. The recipient is the fixture
  // actor itself, so the self-scoped reads over the row stay legal; `task.due` because it is the
  // registry event the spec's own worked example fires.
  inbox_item: (deps, workspaceId, seed) =>
    must(
      call(deps, 'notifications_deliver', {
        workspaceId,
        userId: deps.actor,
        event: 'task.due',
        summaryI18nKey: 'notifications.summary.task_due',
        summaryParams: { title: 'Offerte nachfassen' },
        idempotencyKey: `${seed}-inbox`,
      }),
      'notifications_deliver',
    ).notificationId,
  // G02: one installed plugin through the real install verb (never an INSERT). A zero-capability,
  // zero-permission manifest whose pinned sha256 matches its payload and whose compat_range admits
  // the current core, so it installs clean (status installed) and the custom-field/saved-view reads
  // over the row stay legal.
  plugin: (deps, workspaceId, seed) => {
    const payload = `plugin-payload-${seed}`;
    const sha256 = createHash('sha256').update(payload).digest('hex');
    return must(
      call(deps, 'install_plugin', {
        workspaceId,
        source: 'local',
        packageRef: {
          manifest: {
            name: `Sample Extension ${seed}`,
            version: '1.0.0',
            compat_range: '^1.0.0',
            sha256,
            capabilities: [],
            permissions: { requested: [] },
          },
          payload,
        },
        idempotencyKey: `${seed}-plugin`,
      }),
      'install_plugin',
    ).plugin.id;
  },
  // G05 §10: one REAL send-log row through the cheapest honest send, `quotes_send`'s designed
  // artifact-only completion (no relay needed, no P8 confirmation on a quote send), never an
  // INSERT. The row read back is the newest `artifact_created` dispatch of this workspace.
  dispatch: (deps, workspaceId, seed) => {
    const contactId = must(
      call(deps, 'create_contact', {
        workspaceId,
        partyRole: 'customer',
        name: 'Versandprotokoll AG',
        idempotencyKey: `${seed}-dsp-contact`,
      }),
      'create_contact',
    ).contact.id;
    const quote = must(
      call(deps, 'quotes_create', {
        workspaceId,
        contactId,
        validUntil: '2027-01-31',
        lines: [{ description: 'Leistung', unitPriceMinor: 20000 }],
        idempotencyKey: `${seed}-dsp-quote`,
      }),
      'quotes_create',
    ).document.id;
    must(call(deps, 'quotes_send', { workspaceId, quoteId: quote, idempotencyKey: `${seed}-dsp-send` }), 'quotes_send');
    const listed = must(call(deps, 'list_dispatches', { workspaceId }), 'list_dispatches');
    assert.ok(listed.dispatches.length > 0, 'quotes_send did not append a dispatches row');
    return listed.dispatches[0].dispatchId;
  },

  // A31: a capture (Belegeingang queue row). A QR-less document is enough for a custom-field target:
  // it lands one `needs_review` capture with no extraction fields, which is exactly the annotation
  // surface OP7 attaches to (a custom field never expresses a CAPTURE_FIELD_KEY value).
  capture: (deps, workspaceId, seed) =>
    must(
      call(deps, 'capture_document', {
        workspaceId,
        contentBase64: Buffer.from(`%PDF-1.4 ${seed}`).toString('base64'),
        mime: 'application/pdf',
        filename: `${seed}.pdf`,
        idempotencyKey: `${seed}-cap`,
      }),
      'capture_document',
    ).captureId,

  // A32. One eBill delivery, minted end to end through A32's own verb. VAT is seeded because
  // `issue_invoice` posts the balanced VAT entry, and the creditor profile + a structured, e-mailed
  // customer are set because `ebill_prepare` builds A11's QR-bill (with the eBill AltPmt element) and
  // refuses without them. The delivery is `prepared`; it posts nothing.
  ebill_delivery: (deps, workspaceId, seed) => {
    must(call(deps, 'vat_seed_defaults', { workspaceId }), 'vat_seed_defaults');
    must(call(deps, 'set_vat_method', { workspaceId, vatMethod: 'effektiv', vatAccounting: 'soll' }), 'set_vat_method');
    must(
      call(deps, 'set_creditor_profile', {
        workspaceId,
        creditorName: 'eBill GmbH',
        address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
        qrIban: 'CH4431999123000889012',
      }),
      'set_creditor_profile',
    );
    const customerId = must(
      call(deps, 'create_contact', {
        workspaceId,
        partyRole: 'customer',
        name: 'eBill Kunde AG',
        address: { street: 'Musterstrasse', houseNo: '5', zip: '3000', city: 'Bern', country: 'CH' },
        email: 'billing@ebill-kunde.example',
        idempotencyKey: `${seed}-cust`,
      }),
      'create_contact',
    ).contact.id;
    const documentId = must(
      call(deps, 'create_document', {
        workspaceId,
        type: 'invoice',
        contactId: customerId,
        currency: 'CHF',
        lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
        idempotencyKey: `${seed}-doc`,
      }),
      'create_document',
    ).document.id;
    must(call(deps, 'issue_invoice', { workspaceId, invoiceId: documentId, idempotencyKey: `${seed}-issue` }), 'issue_invoice');
    return must(
      call(deps, 'ebill_prepare', { workspaceId, invoiceId: documentId, idempotencyKey: `${seed}-prep` }),
      'ebill_prepare',
    ).delivery.id;
  },
  // A34: a payroll hand-off export record. One employee is enough for a non-empty roster (the export
  // refuses `no_employees` on an empty one); `payroll_handoff_export` then lands one
  // `payroll_handoff_exports` row, which is the OP7 annotation surface (spec §6b). No AHV column is
  // needed for the custom-field target, so the minimal roster row (no ahvNr) is deliberate.
  payroll_handoff: (deps, workspaceId, seed) => {
    must(
      call(deps, 'hr_employee_upsert', {
        workspaceId,
        employee: { firstName: 'Alex', lastName: 'Muster', employmentPct: 80, startsOn: '2026-01-01' },
        idempotencyKey: `${seed}-emp`,
      }),
      'hr_employee_upsert',
    );
    return must(
      call(deps, 'payroll_handoff_export', { workspaceId, idempotencyKey: `${seed}-exp` }),
      'payroll_handoff_export',
    ).exportId;
  },
  // A33: an EBICS connection is the OP7 annotation target (a contract number, the relationship
  // manager as a contact_ref, spec §6b). connect over a registered bank account, no transport wired,
  // lands one `ebics_connection` row in state keys_generated (the local ceremony work), whose id the
  // custom-field seam attaches to. confirm:true satisfies the in-engine P8 gate.
  ebics_connection: (deps, workspaceId, seed, accId) => {
    // Reuse any bank account already in the workspace (the `bank_account` kind's factory makes one in
    // the shared "every kind" workspace); mint one only if none exists, so no IBAN ever collides.
    const existing = deps.store.db.prepare('SELECT id FROM bank_account WHERE workspace_id = ? LIMIT 1').get(workspaceId);
    const bankAccountId =
      existing?.id ??
      must(
        call(deps, 'create_bank_account', {
          workspaceId,
          name: 'EBICS Kontokorrent',
          iban: 'CH93 0076 2011 6238 5295 7',
          currency: 'CHF',
          ledgerAccountId: accId('1020'),
          idempotencyKey: `${seed}-ba`,
        }),
        'create_bank_account',
      ).bankAccountId;
    return must(
      call(deps, 'bank_channel_connect', {
        workspaceId,
        host: { url: 'https://ebics.example/ebics', hostId: 'EBICSHST', partnerId: 'PARTNER01', userId: 'USER0001' },
        routeBankAccountIds: [bankAccountId],
        confirm: true,
        idempotencyKey: `${seed}-conn`,
      }),
      'bank_channel_connect',
    ).connectionId;
  },
  // A33: an `ebics_order` is a row of the append-only order log (`ebics_order_log`, the registry maps
  // the kind to that table). No verb mints one without a live transport (INI/HIA/BTU orders arrive
  // over the wire), so the factory seeds one directly: the point is a row of that kind for the OP7
  // custom-field target (spec §6b's saved views over the order log), not a full ceremony.
  ebics_order: (deps, workspaceId, seed, accId) => {
    const connectionId = RECORD_FACTORIES.ebics_connection(deps, workspaceId, `${seed}-oc`, accId);
    const id = `ebord_${seed}`;
    deps.store.db
      .prepare(
        `INSERT INTO ebics_order_log
           (id, workspace_id, connection_id, order_ref, direction, order_type, status, occurred_at)
         VALUES (?, ?, ?, ?, 'download', 'BTD', 'ok', ?)`,
      )
      .run(id, workspaceId, connectionId, `${id}-ref`, deps.clock.now());
    return id;
  },
  // A37: a `managed_connection` is a bLink consent row (the A33 ebics_connection twin one rail over).
  // No verb mints one without the owner-gated relay port wired (connect returns cloud_tier with the
  // tier off, by design, spec §3), so the factory seeds one directly: the point is a row of that kind
  // for the OP7 custom-field target and the §6b saved-view target, not a full consent walk.
  managed_connection: (deps, workspaceId, seed) => {
    const id = `mconn_${seed}`;
    const at = deps.clock.now();
    deps.store.db
      .prepare(
        `INSERT INTO managed_connection
           (id, workspace_id, provider, bank_ref, state, scopes, created_at, updated_at)
         VALUES (?, ?, 'blink', ?, 'consent_pending', '["ais"]', ?, ?)`,
      )
      .run(id, workspaceId, `bankref-${seed}`, at, at);
    return id;
  },
  // A37: a `managed_order` is a row of the append-only order log (`managed_order_log`, the registry
  // maps the kind to that table). No verb mints one without a live relay, so the factory seeds one
  // directly, the `ebics_order` shape one rail over.
  managed_order: (deps, workspaceId, seed) => {
    const connectionId = RECORD_FACTORIES.managed_connection(deps, workspaceId, `${seed}-oc`);
    const id = `mgord_${seed}`;
    deps.store.db
      .prepare(
        `INSERT INTO managed_order_log
           (id, workspace_id, connection_id, order_ref, direction, kind, status, occurred_at)
         VALUES (?, ?, ?, ?, 'download', 'statements', 'ok', ?)`,
      )
      .run(id, workspaceId, connectionId, `${id}-ref`, deps.clock.now());
    return id;
  },

  // H00: a fixed-asset category is created through its own verb, carrying the three GL accounts the
  // KMU seed already mints (asset 1500, the accumulated-depreciation contra on asset 1510, expense
  // 6800) and a straight-line useful life, which the default method requires. The code is derived
  // from the seed and capped at 20 chars so repeated calls in one workspace never collide.
  asset_category: (deps, workspaceId, seed, accId) =>
    must(
      call(deps, 'asset_category_create', {
        workspaceId,
        code: `AC-${seed}`.slice(0, 20),
        name: 'Maschinen',
        depreciationMethod: 'straight_line',
        usefulLifeMonths: 60,
        glAssetAccountId: accId('1500'),
        glAccumDeprAccountId: accId('1510'),
        glDeprExpenseAccountId: accId('6800'),
        idempotencyKey: `${seed}-assetcat`,
      }),
      'asset_category_create',
    ).category.id,

  // H01: a fixed asset is created through its own verb FROM a freshly minted category, so the record a
  // custom field or saved view hangs on is a real row of the current workspace. The category code is
  // derived from the seed and capped so repeated calls never collide.
  asset: (deps, workspaceId, seed, accId) => {
    const categoryId = must(
      call(deps, 'asset_category_create', {
        workspaceId,
        code: `ACA-${seed}`.slice(0, 20),
        name: 'Maschinen',
        depreciationMethod: 'straight_line',
        usefulLifeMonths: 60,
        glAssetAccountId: accId('1500'),
        glAccumDeprAccountId: accId('1510'),
        glDeprExpenseAccountId: accId('6800'),
        idempotencyKey: `${seed}-asset-cat`,
      }),
      'asset_category_create',
    ).category.id;
    return must(
      call(deps, 'asset_create', {
        workspaceId,
        categoryId,
        name: 'Maschine',
        acquisitionDate: '2026-03-15',
        acquisitionCostRappen: 500000,
        idempotencyKey: `${seed}-asset`,
      }),
      'asset_create',
    ).asset.id;
  },
  // I00: a requisition is created through its own verb as a draft with one free-text line. It posts
  // nothing and needs no GL accounts; the number is minted by the engine and the id is what the G00
  // custom-field seam hangs a value on.
  requisition: (deps, workspaceId, seed) =>
    must(
      call(deps, 'requisition_upsert', {
        workspaceId,
        neededBy: '2026-09-01',
        urgency: 'normal',
        description: `Bedarf ${seed}`,
        lines: [{ description: 'Position', qtyMilli: 1000, estimatedUnitCostRappen: 100 }],
        idempotencyKey: `${seed}-requisition`,
      }),
      'requisition_upsert',
    ).requisition.id,
  // J00 warehouses: a warehouse is an OP3 kind on manage_master_data. One warehouse_create, code
  // derived from the seed and capped at 20 chars so repeated calls in one workspace never collide.
  warehouse: (deps, workspaceId, seed) =>
    must(
      call(deps, 'warehouse_create', {
        workspaceId,
        code: `WH-${seed}`.slice(0, 20),
        name: 'Zentrallager',
        idempotencyKey: `${seed}-warehouse`,
      }),
      'warehouse_create',
    ).warehouse.id,
  // J01 lot: a lot is an OP3 kind on manage_master_data. A lot needs a lot-tracked item first, so the
  // factory mints a stockable item, sets its tracking_mode to 'lot' (zero on-hand, so the guard
  // passes), and creates one lot. The lot id is what the G00 custom-field seam hangs a value on.
  lot: (deps, workspaceId, seed) => {
    const itemId = must(
      call(deps, 'create_item', {
        workspaceId,
        name: `Charge-Artikel ${seed}`,
        defaultUnitPriceMinor: 1000,
        trackStock: true,
        idempotencyKey: `${seed}-lot-item`,
      }),
      'create_item',
    ).item.id;
    must(
      call(deps, 'item_set_tracking_mode', { workspaceId, itemId, mode: 'lot', idempotencyKey: `${seed}-lot-mode` }),
      'item_set_tracking_mode',
    );
    return must(
      call(deps, 'lot_create', { workspaceId, itemId, number: `L-${seed}`.slice(0, 60), idempotencyKey: `${seed}-lot` }),
      'lot_create',
    ).lot.id;
  },
  // J01 serial: the lot shape one register over, on a serial-tracked item.
  serial: (deps, workspaceId, seed) => {
    const itemId = must(
      call(deps, 'create_item', {
        workspaceId,
        name: `Serien-Artikel ${seed}`,
        defaultUnitPriceMinor: 1000,
        trackStock: true,
        idempotencyKey: `${seed}-serial-item`,
      }),
      'create_item',
    ).item.id;
    must(
      call(deps, 'item_set_tracking_mode', { workspaceId, itemId, mode: 'serial', idempotencyKey: `${seed}-serial-mode` }),
      'item_set_tracking_mode',
    );
    return must(
      call(deps, 'serial_create', { workspaceId, itemId, number: `S-${seed}`.slice(0, 60), idempotencyKey: `${seed}-serial` }),
      'serial_create',
    ).serial.id;
  },
  // H05: a fixed-asset location is an OP3 kind on manage_master_data. One asset_location_create, code
  // derived from the seed and capped at 30 chars so repeated calls in one workspace never collide. The
  // location id is what the G00 custom-field seam hangs a value on.
  asset_location: (deps, workspaceId, seed) =>
    must(
      call(deps, 'asset_location_create', {
        workspaceId,
        code: `LOC-${seed}`.slice(0, 30),
        name: 'Werkhalle',
        idempotencyKey: `${seed}-asset-location`,
      }),
      'asset_location_create',
    ).location.id,
  // I02 goods receipt: the receipt document is an OP3 kind on manage_master_data. It needs a world
  // (a supplier, a stockable item, a SENT purchase order with open quantity), so the factory mints
  // that through D02's own verbs and then opens ONE draft receipt. A draft is enough for the G00
  // seam: a custom field annotates the document, and nothing here has to move stock.
  goods_receipt: (deps, workspaceId, seed) => {
    const supplierContactId = must(
      call(deps, 'create_contact', { workspaceId, partyRole: 'vendor', name: 'Lieferant GmbH', idempotencyKey: `${seed}-vendor` }),
      'create_contact',
    ).contact.id;
    const itemId = must(
      call(deps, 'create_item', { workspaceId, name: `Rohstoff ${seed}`, defaultUnitPriceMinor: 1000, trackStock: true, idempotencyKey: `${seed}-item` }),
      'create_item',
    ).item.id;
    const poId = must(
      call(deps, 'po_upsert', {
        workspaceId,
        supplierContactId,
        lines: [{ itemId, qty: 4, unitPriceRappen: 1000 }],
        idempotencyKey: `${seed}-po`,
      }),
      'po_upsert',
    ).poId;
    must(call(deps, 'po_send', { workspaceId, poId, idempotencyKey: `${seed}-send` }), 'po_send');
    return must(
      call(deps, 'goods_receipt_create', {
        workspaceId,
        poId,
        receivedAt: '2026-03-04',
        idempotencyKey: `${seed}-goods-receipt`,
      }),
      'goods_receipt_create',
    ).goodsReceipt.id;
  },

  // G20 implementation projects: the project, a task on it and a human sign-off are all OP3 kinds on
  // manage_implementation. A future cutover avoids cutover_in_past (the support clock is 2026-07-16).
  // Only ONE project may be open per workspace, and the G00 registry test seeds every kind in ONE
  // workspace, so the task/sign-off factories FIND-OR-CREATE the shared open project rather than
  // minting a second one (which would refuse project_already_open).
  implementation_project: (deps, workspaceId, seed) => ensureOpenProject(deps, workspaceId, seed),

  implementation_task: (deps, workspaceId, seed) => {
    const projectId = ensureOpenProject(deps, workspaceId, `${seed}-task`);
    return must(
      call(deps, 'implementation_task_set', {
        workspaceId,
        projectId,
        fields: { phase: 'discovery', title: 'Exportliste anlegen', ownerKind: 'agent' },
        idempotencyKey: `${seed}-impl-task`,
      }),
      'implementation_task_set',
    ).task.taskId;
  },

  implementation_signoff: (deps, workspaceId, seed) => {
    // A sign-off is a HUMAN act; the support workspace runs as `studio`, so it is admitted.
    const projectId = ensureOpenProject(deps, workspaceId, `${seed}-sig`);
    return must(
      call(deps, 'implementation_signoff_record', {
        workspaceId,
        projectId,
        kind: 'conversion_date',
        evidenceRef: 'beleg-stichtag',
        idempotencyKey: `${seed}-impl-signoff`,
      }),
      'implementation_signoff_record',
    ).signoffId;
  },
};

/**
 * The guard that makes this suite cover the REGISTRY rather than a snapshot of it.
 *
 * A capability that adds its row to `ENTITY_KINDS` and nothing else is exactly the case G00 promises
 * costs one line. This assertion is what turns that promise into a thing the build checks.
 */
export function assertEveryKindHasAFactory() {
  const missing = ENTITY_KIND_IDS.filter((kind) => RECORD_FACTORIES[kind] === undefined);
  assert.deepEqual(
    missing,
    [],
    `a kind was added to ENTITY_KINDS with no record factory here, so it is registered but untested: ${missing.join(', ')}`,
  );
  const stale = Object.keys(RECORD_FACTORIES).filter((kind) => !ENTITY_KIND_IDS.includes(kind));
  assert.deepEqual(stale, [], `a factory names a kind the registry no longer holds: ${stale.join(', ')}`);
  assert.ok(ENTITY_KINDS.length > 0, 'the registry is empty, so every loop below is vacuous');
}

/** Mint one record of `kind` and hand back its id. */
export function makeRecord(deps, workspaceId, kind, seed, accId) {
  const factory = RECORD_FACTORIES[kind];
  assert.ok(factory !== undefined, `no record factory for kind ${kind}`);
  const id = factory(deps, workspaceId, `${seed}-${kind}`, accId);
  assert.equal(typeof id, 'string', `the factory for ${kind} returned ${typeof id} instead of an id`);
  assert.ok(id.length > 0, `the factory for ${kind} returned an empty id`);
  return id;
}

/** A fresh workspace on its own store, claimed by `actor`. */
export function workspace(seed, actor = 'studio') {
  const deps = freshDeps();
  deps.actor = actor;
  const { workspaceId, accId } = mintWorkspace(deps, 'Anpassung GmbH', `${seed}-ws`);
  return { deps, workspaceId, accId };
}

/** A label object satisfying G00's required-locale rule, in the de-CH `Sie` register. */
export function label(text) {
  return { 'de-CH': text, en: text };
}
