/**
 * The `year_close` template: one fiscal year from the open books to the sealed year, as shipped
 * product data (spec G22 §10.5, the design doc §8, D129). Anchor `statements`, period kind `year`.
 *
 * The journey in blocks: two derived choices (Rechtsform, MWST-Methode) that govern inclusion; the
 * three live checks; the block validations on the months, the open items and the bank; the four
 * posting pairs (FX, Abschreibungen, Abgrenzungen, Rückstellungen), each a preview bound by hash and
 * a posting the ledger proves through its probe, each with its owner verb's reversal; the MWST
 * block (the per-period settlement, MWST-KONTEN-NULL, the declared-equals-books warning, the
 * Umsatzabstimmung with its statutory 180-day deadline and the optional Berichtigung); the tax
 * provision for a GmbH or AG; the statements block; the sign-off bound to the statements hash; the
 * optional Treuhänder handover; the soft lock; the GV attestation with its six-month rule; the seal;
 * and the dossier exports.
 *
 * DEADLINES. Three items carry statutory rules, verified 2026-09-09 (`deadlines.ts`):
 * `umsatzabstimmung_180` and `berichtigung_240` (Art. 72 Abs. 1 MWSTG, the Berichtigung within 180
 * days of the fiscal-year end and its correction return within 240 days; fedlex SR 641.20) and
 * `gv_6_months` (Art. 699 Abs. 2 OR for the AG, Art. 805 OR for the GmbH: the ordentliche
 * Generalversammlung within six months of the fiscal year end; SR 220). The 150-day and 180-day
 * interior offsets are product pacing, not law: the sign-off sits a month before the
 * Umsatzabstimmung deadline, and items 1 to 14 inherit its date so a fresh run never opens with a
 * wall of overdue rows.
 *
 * THE SEAL. Item `year_sealed` is `close_year`: sealed and irreversible (D129 Q1). It has no reverse
 * verb, its row says so in the consequence sentence, and every posting item before it has its
 * owner verb's undo. It waits on the statements sign-off, the soft lock, the GV attestation (when
 * included) and every block validation.
 *
 * INCLUSION. `legal_form` in {gmbh, ag} includes the tax provision, the Kapitalverlust check and the
 * GV; `vat_method` in {effektiv, saldo} includes the MWST block (Q3: a Saldo workspace settles
 * through 3809); the four yes/no choices include their pairs. Excluded rows fold under their choice
 * and count as settled.
 */

import type { ChecklistChoiceOption, ChecklistTemplate, ChecklistTemplateItem } from '../types.js';

export const YEAR_CLOSE_TEMPLATE_ID = 'year_close';

export const YES_NO: readonly ChecklistChoiceOption[] = [
  { id: 'yes', labelKey: 'checklists.choice.yes', consequenceKey: 'checklists.choice.yes.consequence' },
  { id: 'no', labelKey: 'checklists.choice.no', consequenceKey: 'checklists.choice.no.consequence' },
];

export const LEGAL_FORM_OPTIONS: readonly ChecklistChoiceOption[] = [
  { id: 'einzelfirma', labelKey: 'checklists.choice.legalForm.einzelfirma', consequenceKey: 'checklists.choice.legalForm.einzelfirma.consequence' },
  { id: 'gmbh', labelKey: 'checklists.choice.legalForm.gmbh', consequenceKey: 'checklists.choice.legalForm.gmbh.consequence' },
  { id: 'ag', labelKey: 'checklists.choice.legalForm.ag', consequenceKey: 'checklists.choice.legalForm.ag.consequence' },
];

export const VAT_METHOD_OPTIONS: readonly ChecklistChoiceOption[] = [
  { id: 'effektiv', labelKey: 'checklists.choice.vatMethod.effektiv', consequenceKey: 'checklists.choice.vatMethod.effektiv.consequence' },
  { id: 'saldo', labelKey: 'checklists.choice.vatMethod.saldo', consequenceKey: 'checklists.choice.vatMethod.saldo.consequence' },
  { id: 'none', labelKey: 'checklists.choice.vatMethod.none', consequenceKey: 'checklists.choice.vatMethod.none.consequence' },
];

/** "GmbH" in the spec tables: a GmbH or an AG (the Einzelfirma is taxed personally and holds no GV). */
export const GMBH_OR_AG = { itemId: 'legal_form', optionId: ['gmbh', 'ag'] } as const;
/** "MWST-pflichtig": effektiv or Saldo (D129 Q3, a Saldo workspace settles too). */
export const VAT_REGISTERED = { itemId: 'vat_method', optionId: ['effektiv', 'saldo'] } as const;
const FC = { itemId: 'has_fc_positions', optionId: 'yes' } as const;
const ASSETS = { itemId: 'has_assets', optionId: 'yes' } as const;
const ACCRUALS = { itemId: 'accruals_needed', optionId: 'yes' } as const;
const PROVISIONS = { itemId: 'provisions_needed', optionId: 'yes' } as const;

/** The sign-off every row before it paces on (`dueLikeItemId`). */
const SIGNOFF = 'statements_signed';

/** The block validations of the year: the seal and the sign-off wait on every one of them. */
export const YEAR_CLOSE_BLOCK_VALIDATIONS: readonly string[] = [
  'month_closes_done',
  'open_items_debtors',
  'open_items_creditors',
  'bank_balance_matches',
  'accruals_reversed_next_year',
  'vat_accounts_zero',
  'balance_equation',
];

/** The posting rows the sign-off waits on (an excluded pair counts as settled). */
export const YEAR_CLOSE_POSTINGS_BEFORE_SIGNOFF: readonly string[] = [
  'fx_posted',
  'depreciation_posted',
  'accruals_posted',
  'provisions_posted',
  'vat_settled',
  'tax_provision_posted',
];

const ITEMS: readonly ChecklistTemplateItem[] = [
  // --- The choices that govern the journey ---------------------------------------------------------
  {
    itemId: 'legal_form',
    title: 'Rechtsform',
    ownerKind: 'system',
    evidenceKind: 'choice',
    derive: 'legal_form',
    options: LEGAL_FORM_OPTIONS,
    deepLink: '/setup',
  },
  {
    itemId: 'vat_method',
    title: 'MWST-Methode',
    ownerKind: 'system',
    evidenceKind: 'choice',
    derive: 'vat_method',
    options: VAT_METHOD_OPTIONS,
    deepLink: '/vat',
  },
  // --- The live checks -----------------------------------------------------------------------------
  {
    itemId: 'no_drafts',
    title: 'Keine Entwürfe bis Jahresende',
    ownerKind: 'system',
    evidenceKind: 'check',
    check: 'no_drafts',
    deepLink: '/journal',
    dueLikeItemId: SIGNOFF,
  },
  {
    itemId: 'bank_reconciled',
    title: 'Bank abgestimmt',
    ownerKind: 'system',
    evidenceKind: 'check',
    check: 'bank_reconciled',
    deepLink: '/reconciliation',
    dueLikeItemId: SIGNOFF,
  },
  {
    itemId: 'tax_codes_complete',
    title: 'Steuercodes vollständig',
    ownerKind: 'system',
    evidenceKind: 'check',
    check: 'no_missing_tax_codes',
    deepLink: '/journal',
    includedWhen: VAT_REGISTERED,
    dueLikeItemId: SIGNOFF,
  },
  // --- The block validations on the books ----------------------------------------------------------
  {
    itemId: 'month_closes_done',
    title: 'Monate abgeschlossen',
    ownerKind: 'system',
    evidenceKind: 'validation',
    validation: 'locks_on_all_months',
    severity: 'block',
    fixLink: '/periods',
    dueLikeItemId: SIGNOFF,
  },
  {
    itemId: 'open_items_debtors',
    title: 'Offene Kundenrechnungen stimmen mit 1100',
    ownerKind: 'system',
    evidenceKind: 'validation',
    validation: 'open_items_debtors',
    severity: 'block',
    fixLink: '/journal?account=1100',
    dueLikeItemId: SIGNOFF,
  },
  {
    itemId: 'open_items_creditors',
    title: 'Offene Lieferantenrechnungen stimmen mit 2000',
    ownerKind: 'system',
    evidenceKind: 'validation',
    validation: 'open_items_creditors',
    severity: 'block',
    fixLink: '/journal?account=2000',
    dueLikeItemId: SIGNOFF,
  },
  {
    itemId: 'bank_balance_matches',
    title: 'Bankauszug per Jahresende stimmt',
    ownerKind: 'system',
    evidenceKind: 'validation',
    validation: 'bank_balance_matches',
    severity: 'block',
    fixLink: '/reconciliation',
    prerequisiteItemId: 'bank_reconciled',
    dueLikeItemId: SIGNOFF,
  },
  {
    itemId: 'bank_balance_typed',
    title: 'Banksaldo per Jahresende laut Bankauszug',
    ownerKind: 'human',
    evidenceKind: 'signoff',
    signoffKind: 'validation_acknowledged',
    requiresEvidenceRef: true,
    deepLink: '/reconciliation',
    dueLikeItemId: SIGNOFF,
  },
  // --- Fremdwährungen (A22) ------------------------------------------------------------------------
  {
    itemId: 'has_fc_positions',
    title: 'Fremdwährungspositionen vorhanden?',
    ownerKind: 'system',
    evidenceKind: 'choice',
    derive: 'has_fc_positions',
    options: YES_NO,
  },
  {
    itemId: 'fx_preview',
    title: 'Fremdwährungsbewertung: Vorschau',
    ownerKind: 'human',
    evidenceKind: 'preview',
    verb: 'fx_revaluation',
    verbInput: 'periodEnd',
    emptyWhen: '/positions',
    deepLink: '/fx',
    prerequisiteItemId: 'has_fc_positions',
    includedWhen: FC,
    dueLikeItemId: SIGNOFF,
  },
  {
    itemId: 'fx_posted',
    title: 'Fremdwährungsbewertung gebucht',
    ownerKind: 'human',
    evidenceKind: 'posting',
    verb: 'post_fx_revaluation',
    reverseVerb: 'fx_revaluation_reverse',
    verbInput: 'periodEnd',
    probe: 'fx_revaluation_posted',
    previewOf: 'fx_preview',
    deepLink: '/fx',
    includedWhen: FC,
    dueLikeItemId: SIGNOFF,
  },
  // --- Abschreibungen (H04) ------------------------------------------------------------------------
  {
    itemId: 'has_assets',
    title: 'Anlagen vorhanden?',
    ownerKind: 'system',
    evidenceKind: 'choice',
    derive: 'has_assets',
    options: YES_NO,
  },
  {
    itemId: 'depreciation_preview',
    title: 'Abschreibungen: Vorschau',
    ownerKind: 'human',
    evidenceKind: 'preview',
    verb: 'asset_depreciation_preview',
    verbInput: 'lastMonth',
    deepLink: '/depreciation-runs',
    prerequisiteItemId: 'has_assets',
    includedWhen: ASSETS,
    dueLikeItemId: SIGNOFF,
  },
  {
    itemId: 'depreciation_posted',
    title: 'Abschreibungen gebucht',
    ownerKind: 'human',
    evidenceKind: 'posting',
    verb: 'asset_depreciation_run_post',
    reverseVerb: 'asset_depreciation_run_reverse',
    verbInput: 'lastMonth',
    probe: 'depreciation_charged',
    previewOf: 'depreciation_preview',
    deepLink: '/depreciation-runs',
    includedWhen: ASSETS,
    dueLikeItemId: SIGNOFF,
  },
  {
    itemId: 'depreciation_within_limit',
    title: 'Abschreibungen im erlaubten Rahmen',
    ownerKind: 'system',
    evidenceKind: 'validation',
    validation: 'depreciation_within_limit',
    severity: 'warn',
    fixLink: '/depreciation-runs',
    prerequisiteItemId: 'depreciation_posted',
    includedWhen: ASSETS,
    dueLikeItemId: SIGNOFF,
  },
  // --- Abgrenzungen (A38) --------------------------------------------------------------------------
  {
    itemId: 'accruals_needed',
    title: 'Aufwände oder Erträge, die ins nächste Jahr gehören?',
    ownerKind: 'human',
    evidenceKind: 'choice',
    options: YES_NO,
    deepLink: '/periods',
    dueLikeItemId: SIGNOFF,
  },
  {
    itemId: 'accruals_preview',
    title: 'Abgrenzungen: Vorschau',
    ownerKind: 'human',
    evidenceKind: 'preview',
    verb: 'accrual_list',
    verbInput: 'periodEnd',
    deepLink: '/periods',
    prerequisiteItemId: 'accruals_needed',
    includedWhen: ACCRUALS,
    dueLikeItemId: SIGNOFF,
  },
  {
    itemId: 'accruals_posted',
    title: 'Abgrenzungen gebucht',
    ownerKind: 'human',
    evidenceKind: 'posting',
    verb: 'accrual_post',
    reverseVerb: 'accrual_reverse',
    verbInput: 'periodEnd',
    probe: 'accruals_posted',
    previewOf: 'accruals_preview',
    deepLink: '/periods',
    includedWhen: ACCRUALS,
    dueLikeItemId: SIGNOFF,
  },
  {
    itemId: 'accruals_reversed_next_year',
    title: 'Rückbuchung im neuen Jahr vorhanden',
    ownerKind: 'system',
    evidenceKind: 'validation',
    validation: 'accruals_reversed',
    severity: 'block',
    fixLink: '/journal?account=1300',
    prerequisiteItemId: 'accruals_posted',
    includedWhen: ACCRUALS,
    dueLikeItemId: SIGNOFF,
  },
  // --- Rückstellungen (A38) ------------------------------------------------------------------------
  {
    itemId: 'provisions_needed',
    title: 'Rückstellungen bilden oder bestehende auflösen?',
    ownerKind: 'human',
    evidenceKind: 'choice',
    options: YES_NO,
    deepLink: '/periods',
    dueLikeItemId: SIGNOFF,
  },
  {
    itemId: 'provisions_preview',
    title: 'Rückstellungen: Vorschau',
    ownerKind: 'human',
    evidenceKind: 'preview',
    verb: 'provision_list',
    verbInput: 'periodEnd',
    deepLink: '/periods',
    prerequisiteItemId: 'provisions_needed',
    includedWhen: PROVISIONS,
    dueLikeItemId: SIGNOFF,
  },
  {
    itemId: 'provisions_posted',
    title: 'Rückstellungen gebucht oder aufgelöst',
    ownerKind: 'human',
    evidenceKind: 'posting',
    verb: 'provision_post',
    reverseVerb: 'provision_reverse',
    verbInput: 'periodEnd',
    probe: 'provisions_posted',
    previewOf: 'provisions_preview',
    deepLink: '/periods',
    includedWhen: PROVISIONS,
    dueLikeItemId: SIGNOFF,
  },
  // --- MWST (A38, A07) -----------------------------------------------------------------------------
  {
    itemId: 'vat_settled',
    title: 'MWST-Konten saldiert',
    ownerKind: 'human',
    evidenceKind: 'posting',
    verb: 'vat_settlement_post',
    reverseVerb: 'vat_settlement_reverse',
    verbInput: 'year',
    probe: 'vat_settlement_posted',
    deepLink: '/mwst',
    includedWhen: VAT_REGISTERED,
    dueLikeItemId: SIGNOFF,
  },
  {
    itemId: 'vat_accounts_zero',
    title: 'MWST-Konten per Jahresende auf null',
    ownerKind: 'system',
    evidenceKind: 'validation',
    validation: 'vat_accounts_zero',
    severity: 'block',
    fixLink: '/mwst',
    prerequisiteItemId: 'vat_settled',
    includedWhen: VAT_REGISTERED,
    dueLikeItemId: SIGNOFF,
  },
  {
    itemId: 'vat_declared_equals_books',
    title: 'MWST-Abrechnung stimmt mit den Konten überein',
    ownerKind: 'system',
    evidenceKind: 'validation',
    validation: 'vat_declared_equals_books',
    severity: 'warn',
    fixLink: '/mwst',
    prerequisiteItemId: 'vat_settled',
    includedWhen: VAT_REGISTERED,
    dueLikeItemId: SIGNOFF,
  },
  {
    itemId: 'umsatzabstimmung',
    title: 'Umsatzabstimmung geprüft',
    ownerKind: 'human',
    evidenceKind: 'validation',
    validation: 'umsatzabstimmung',
    severity: 'warn',
    fixLink: '/mwst',
    prerequisiteItemId: 'vat_declared_equals_books',
    includedWhen: VAT_REGISTERED,
    deadlineRule: 'umsatzabstimmung_180',
    undeletable: true,
  },
  {
    itemId: 'berichtigung_filed',
    title: 'Berichtigungsabrechnung eingereicht',
    ownerKind: 'human',
    evidenceKind: 'filed_attestation',
    signoffKind: 'filed_attestation',
    deepLink: '/mwst',
    prerequisiteItemId: 'umsatzabstimmung',
    includedWhen: VAT_REGISTERED,
    deadlineRule: 'berichtigung_240',
  },
  // --- Steuerrückstellung (A38, GmbH and AG) -------------------------------------------------------
  {
    itemId: 'tax_provision_preview',
    title: 'Steuerrückstellung: Vorschau',
    ownerKind: 'human',
    evidenceKind: 'preview',
    verb: 'tax_provision_preview',
    verbInput: 'periodEnd',
    emptyWhen: '/proposedMinor',
    deepLink: '/periods',
    prerequisiteItemIds: ['accruals_posted', 'provisions_posted'],
    includedWhen: GMBH_OR_AG,
    dueLikeItemId: SIGNOFF,
  },
  {
    itemId: 'tax_provision_posted',
    title: 'Steuerrückstellung gebucht',
    ownerKind: 'human',
    evidenceKind: 'posting',
    verb: 'provision_post',
    reverseVerb: 'provision_reverse',
    verbInput: 'periodEnd',
    probe: 'tax_provision_posted',
    previewOf: 'tax_provision_preview',
    deepLink: '/periods',
    includedWhen: GMBH_OR_AG,
    dueLikeItemId: SIGNOFF,
  },
  {
    itemId: 'tax_provision_plausible',
    title: 'Steuerrückstellung plausibel',
    ownerKind: 'system',
    evidenceKind: 'validation',
    validation: 'tax_provision_plausible',
    severity: 'warn',
    fixLink: '/periods',
    prerequisiteItemId: 'tax_provision_posted',
    includedWhen: GMBH_OR_AG,
    dueLikeItemId: SIGNOFF,
  },
  // --- The statements ------------------------------------------------------------------------------
  {
    itemId: 'balance_equation',
    title: 'Bilanz stimmt',
    ownerKind: 'system',
    evidenceKind: 'validation',
    validation: 'balance_equation',
    severity: 'block',
    fixLink: '/journal',
    dueLikeItemId: SIGNOFF,
  },
  {
    itemId: 'prior_year_comparison',
    title: 'Vorjahresvergleich',
    ownerKind: 'system',
    evidenceKind: 'validation',
    validation: 'prior_year_comparison',
    severity: 'warn',
    fixLink: '/reports',
    dueLikeItemId: SIGNOFF,
  },
  {
    itemId: 'capital_loss_check',
    title: 'Kein Kapitalverlust',
    ownerKind: 'system',
    evidenceKind: 'validation',
    validation: 'capital_loss',
    severity: 'warn',
    fixLink: '/reports',
    includedWhen: GMBH_OR_AG,
    dueLikeItemId: SIGNOFF,
  },
  {
    itemId: SIGNOFF,
    title: 'Bilanz und Erfolgsrechnung freigegeben',
    ownerKind: 'human',
    evidenceKind: 'signoff',
    signoffKind: 'statements_signoff',
    deepLink: '/reports',
    prerequisiteItemIds: [...YEAR_CLOSE_BLOCK_VALIDATIONS, ...YEAR_CLOSE_POSTINGS_BEFORE_SIGNOFF],
    dueOffsetDays: 150,
    undeletable: true,
  },
  // --- After the sign-off --------------------------------------------------------------------------
  {
    itemId: 'treuhaender_handover',
    title: 'Unterlagen an den Treuhänder übergeben',
    ownerKind: 'agent',
    evidenceKind: 'verb_result',
    verb: 'prepare_period',
    verbInput: 'period',
    deepLink: '/review',
    prerequisiteItemId: SIGNOFF,
    dueOffsetDays: 150,
  },
  {
    itemId: 'soft_lock_on_year',
    title: 'Bücher vorläufig gesperrt',
    ownerKind: 'human',
    evidenceKind: 'posting',
    verb: 'lock_period',
    reverseVerb: 'unlock_period',
    verbInput: 'period',
    probe: 'soft_lock_on_year',
    deepLink: '/periods',
    prerequisiteItemId: SIGNOFF,
    dueOffsetDays: 150,
  },
  {
    itemId: 'gv_approved',
    title: 'Generalversammlung hat die Jahresrechnung genehmigt',
    ownerKind: 'human',
    evidenceKind: 'signoff',
    signoffKind: 'gv_attestation',
    deepLink: '/reports',
    prerequisiteItemId: SIGNOFF,
    includedWhen: GMBH_OR_AG,
    deadlineRule: 'gv_6_months',
  },
  {
    itemId: 'year_sealed',
    title: 'Geschäftsjahr abschliessen',
    ownerKind: 'human',
    evidenceKind: 'posting',
    verb: 'close_year',
    verbInput: 'year',
    probe: 'seal_on_year',
    deepLink: '/periods',
    prerequisiteItemIds: [SIGNOFF, 'soft_lock_on_year', 'gv_approved', ...YEAR_CLOSE_BLOCK_VALIDATIONS],
    deadlineRule: 'gv_6_months',
    undeletable: true,
  },
  {
    itemId: 'archive_exported',
    title: 'Abschlussdossier exportiert',
    ownerKind: 'agent',
    evidenceKind: 'verb_result',
    verb: 'export_statements',
    verbInput: 'period',
    deepLink: '/review',
    prerequisiteItemId: 'year_sealed',
    dueOffsetDays: 180,
  },
  {
    itemId: 'journal_exported',
    title: 'Journal exportiert',
    ownerKind: 'agent',
    evidenceKind: 'verb_result',
    verb: 'export_journal',
    verbInput: 'period',
    deepLink: '/review',
    prerequisiteItemId: 'year_sealed',
    dueOffsetDays: 180,
  },
];

export const YEAR_CLOSE_TEMPLATE: ChecklistTemplate = {
  templateId: YEAR_CLOSE_TEMPLATE_ID,
  kind: 'year_close',
  label: 'Jahresabschluss',
  description:
    'Ein Geschäftsjahr von den offenen Büchern bis zum versiegelten Jahr: die Prüfungen, die das ' +
    'System selbst erfüllt, die Fremdwährungsbewertung, die Abschreibungen, die Abgrenzungen und ' +
    'Rückstellungen mit Vorschau und Buchung, die Saldierung der MWST-Konten mit der ' +
    'Umsatzabstimmung, die Steuerrückstellung, die Plausibilitätsprüfungen, die Freigabe von Bilanz ' +
    'und Erfolgsrechnung, die Generalversammlung und der endgültige Abschluss.',
  periodKind: 'year',
  anchor: 'statements',
  items: ITEMS,
};
