/**
 * The `month_close` template: one calendar month from the open books to the soft month lock, as
 * shipped product data (spec G22 §10.6, D129). Anchor `statements`, period kind `month`.
 *
 * The A26 month-end checklist seeded as template rows (the three live checks, the two open-items
 * warnings), plus the A22 FX line as a preview and posting pair (the revaluation auto-reverses on
 * the first of the next month), the optional Abgrenzungen pair (a choice with "Nein" pre-selected,
 * open until saved: the common answer in one click, never an undefined middle) and the soft lock
 * (`close_month`, reversed by `reopen_month`). The ten-day offset is product pacing, not law.
 *
 * This template is AUTO-STARTED by the seeded daily rule (`autostart.ts`): `checklist_start` with
 * no period picks the last ended month, and the natural-key idempotency starts each month once. The
 * last fiscal month of a year that carries a live `year_close` run is not started
 * (`year_close_in_progress` in `runs.ts`): the year's row 4 covers the months and its seal is the
 * December lock.
 */

import type { ChecklistTemplate, ChecklistTemplateItem } from '../types.js';
import { VAT_METHOD_OPTIONS, VAT_REGISTERED, YES_NO } from './yearClose.js';

export const MONTH_CLOSE_TEMPLATE_ID = 'month_close';

const FC = { itemId: 'has_fc_positions', optionId: 'yes' } as const;
const ACCRUALS = { itemId: 'accruals_needed', optionId: 'yes' } as const;

/** Product pacing: ten days after the month end. */
const PACING_DAYS = 10;

const ITEMS: readonly ChecklistTemplateItem[] = [
  {
    itemId: 'vat_method',
    title: 'MWST-Methode',
    ownerKind: 'system',
    evidenceKind: 'choice',
    derive: 'vat_method',
    options: VAT_METHOD_OPTIONS,
    deepLink: '/vat',
  },
  {
    itemId: 'no_drafts',
    title: 'Keine Entwürfe bis Monatsende',
    ownerKind: 'system',
    evidenceKind: 'check',
    check: 'no_drafts',
    deepLink: '/journal',
    dueOffsetDays: PACING_DAYS,
  },
  {
    itemId: 'bank_reconciled',
    title: 'Bank abgestimmt',
    ownerKind: 'system',
    evidenceKind: 'check',
    check: 'bank_reconciled',
    deepLink: '/reconciliation',
    dueOffsetDays: PACING_DAYS,
  },
  {
    itemId: 'tax_codes_complete',
    title: 'Steuercodes vollständig',
    ownerKind: 'system',
    evidenceKind: 'check',
    check: 'no_missing_tax_codes',
    deepLink: '/journal',
    includedWhen: VAT_REGISTERED,
    dueOffsetDays: PACING_DAYS,
  },
  {
    itemId: 'open_items_debtors',
    title: 'Offene Kundenrechnungen stimmen mit 1100',
    ownerKind: 'system',
    evidenceKind: 'validation',
    validation: 'open_items_debtors',
    severity: 'warn',
    fixLink: '/journal?account=1100',
    dueOffsetDays: PACING_DAYS,
  },
  {
    itemId: 'open_items_creditors',
    title: 'Offene Lieferantenrechnungen stimmen mit 2000',
    ownerKind: 'system',
    evidenceKind: 'validation',
    validation: 'open_items_creditors',
    severity: 'warn',
    fixLink: '/journal?account=2000',
    dueOffsetDays: PACING_DAYS,
  },
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
    dueOffsetDays: PACING_DAYS,
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
    dueOffsetDays: PACING_DAYS,
  },
  {
    itemId: 'accruals_needed',
    title: 'Abgrenzungen für diesen Monat?',
    ownerKind: 'human',
    evidenceKind: 'choice',
    options: YES_NO,
    defaultOptionId: 'no',
    deepLink: '/periods',
    dueOffsetDays: PACING_DAYS,
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
    dueOffsetDays: PACING_DAYS,
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
    dueOffsetDays: PACING_DAYS,
  },
  {
    itemId: 'lock_on_month',
    title: 'Monat abschliessen',
    ownerKind: 'human',
    evidenceKind: 'posting',
    verb: 'close_month',
    reverseVerb: 'reopen_month',
    verbInput: 'period',
    probe: 'lock_on_month',
    deepLink: '/periods',
    prerequisiteItemIds: ['no_drafts', 'bank_reconciled', 'tax_codes_complete'],
    dueOffsetDays: PACING_DAYS,
  },
];

export const MONTH_CLOSE_TEMPLATE: ChecklistTemplate = {
  templateId: MONTH_CLOSE_TEMPLATE_ID,
  kind: 'month_close',
  label: 'Monatsabschluss',
  description:
    'Ein Monat von den offenen Büchern bis zur weichen Sperre: drei Prüfungen, die das System selbst ' +
    'erfüllt, die offenen Posten gegen die Konten, die Fremdwährungsbewertung und die Abgrenzungen ' +
    'mit Vorschau und Buchung, und der Monatsabschluss, der sich wieder öffnen lässt. Startet ' +
    'automatisch, sobald ein Monat vorbei ist.',
  periodKind: 'month',
  anchor: 'statements',
  items: ITEMS,
};
