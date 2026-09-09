/**
 * The `vat_period` template: one MWST-Abrechnungsperiode from open books to a filed, locked, paid
 * return, as shipped product data (spec G22 §4).
 *
 * Nine items in journey order. Three are live system checks that nobody ticks (the ledger knows),
 * two are agent verb items whose evidence the engine binds by re-running the verb, three are human
 * sign-offs (the bridge review, the ePortal attestation with a date, the payment), and one is the
 * `vat_mark_filed` lock read live off A03. The three items that may never be skipped are the computed
 * return, the lock and the payment: the canon can be waived consciously elsewhere, never there.
 *
 * DEADLINES. Items 7 to 9 carry the statutory rules (`vat_filing_60`, Art. 71 Abs. 1 MWSTG;
 * `vat_payment_60`, Art. 86 Abs. 1 MWSTG; both 60 days after the period end, verified 2026-09-09
 * against https://www.estv.admin.ch/de/mwst-bezahlen which quotes both and links
 * https://www.fedlex.admin.ch/eli/cc/2009/615/de#art_71 and #art_86). The 30/45/55-day interior
 * offsets are product pacing, not law, and items 1 to 3 inherit item 4's date so a fresh run never
 * opens with three overdue rows.
 *
 * ITEM 9 IS A HUMAN SIGN-OFF, decided after reading `src/core/vat/abrechnung.ts`: A07 posts nothing
 * (`markVatPeriodFiled` mints no entry) and the engine has no settlement posting verb, so there is no
 * filed line and no bank link from which a `vat_settlement_posted` check could be derived.
 */

import type { ChecklistTemplate } from '../types.js';

export const VAT_PERIOD_TEMPLATE_ID = 'vat_period';

const VAT_PERIOD: ChecklistTemplate = {
  templateId: VAT_PERIOD_TEMPLATE_ID,
  kind: 'vat_period',
  label: 'MWST-Periode',
  description:
    'Eine MWST-Abrechnungsperiode von den offenen Büchern bis zur eingereichten, gesperrten und ' +
    'bezahlten Abrechnung: drei Prüfungen, die das System selbst erfüllt, die berechnete Abrechnung, ' +
    'die geprüfte Abstimmung, der eCH-0217-Export, die Bestätigung der Einreichung im ePortal, die ' +
    'Sperre der Periode und die Zahlung.',
  periodKind: 'vat_period',
  items: [
    {
      itemId: 'no_drafts',
      title: 'Keine Entwürfe bis Periodenende',
      ownerKind: 'system',
      evidenceKind: 'check',
      check: 'no_drafts',
      deepLink: '/journal',
      dueLikeItemId: 'vat_return_computed',
    },
    {
      itemId: 'bank_reconciled',
      title: 'Bank abgestimmt',
      ownerKind: 'system',
      evidenceKind: 'check',
      check: 'bank_reconciled',
      deepLink: '/reconciliation',
      dueLikeItemId: 'vat_return_computed',
    },
    {
      itemId: 'tax_codes_complete',
      title: 'Steuercodes vollständig',
      ownerKind: 'system',
      evidenceKind: 'check',
      check: 'no_missing_tax_codes',
      deepLink: '/journal',
      dueLikeItemId: 'vat_return_computed',
    },
    {
      itemId: 'vat_return_computed',
      title: 'Abrechnung berechnet',
      ownerKind: 'agent',
      evidenceKind: 'verb_result',
      verb: 'vat_return',
      deepLink: '/mwst',
      prerequisiteItemIds: ['no_drafts', 'bank_reconciled', 'tax_codes_complete'],
      dueOffsetDays: 30,
      undeletable: true,
    },
    {
      itemId: 'abstimmung_reviewed',
      title: 'Abstimmung geprüft',
      ownerKind: 'human',
      evidenceKind: 'signoff',
      signoffKind: 'abstimmung_reviewed',
      precondition: 'abstimmung_resolved',
      deepLink: '/mwst',
      prerequisiteItemId: 'vat_return_computed',
      dueOffsetDays: 45,
    },
    {
      itemId: 'ech0217_exported',
      title: 'eCH-0217 exportiert',
      ownerKind: 'agent',
      evidenceKind: 'verb_result',
      verb: 'vat_export_ech0217',
      deepLink: '/mwst',
      prerequisiteItemId: 'abstimmung_reviewed',
      dueOffsetDays: 55,
    },
    {
      itemId: 'eportal_filed',
      title: 'Im ESTV ePortal eingereicht',
      ownerKind: 'human',
      evidenceKind: 'filed_attestation',
      signoffKind: 'filed_attestation',
      deepLink: '/mwst',
      prerequisiteItemId: 'ech0217_exported',
      deadlineRule: 'vat_filing_60',
    },
    {
      itemId: 'period_locked',
      title: 'MWST-Periode sperren',
      ownerKind: 'human',
      evidenceKind: 'check',
      check: 'period_locked_vat_filed',
      verb: 'vat_mark_filed',
      deepLink: '/mwst',
      prerequisiteItemId: 'eportal_filed',
      deadlineRule: 'vat_filing_60',
      undeletable: true,
    },
    {
      itemId: 'settlement_booked',
      title: 'Zahlung oder Gutschrift verbucht',
      ownerKind: 'human',
      evidenceKind: 'signoff',
      signoffKind: 'settlement_booked',
      requiresEvidenceRef: true,
      deepLink: '/reconciliation',
      prerequisiteItemId: 'period_locked',
      deadlineRule: 'vat_payment_60',
      undeletable: true,
    },
  ],
};

export const VAT_PERIOD_TEMPLATE: ChecklistTemplate = VAT_PERIOD;
