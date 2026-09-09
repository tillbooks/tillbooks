/**
 * G22 checklists: the shared runbook template types, and the checklist extension over them.
 *
 * The base shapes moved here from `src/core/migration/runbooks/types.ts` (G20), which re-exports
 * them unchanged: G20's cutover canon is a list of `RunbookTemplateItem`s with a `phase`, and a
 * checklist template is a list of `ChecklistTemplateItem`s with a check, a verb, an evidence kind and
 * a deep link. Both stand on `RunbookTemplateItemBase`, so the two families share one vocabulary for
 * owner, due date, prerequisite, evidence and the undeletable mark without either forking the other.
 *
 * Nothing here is workspace data: a template is shipped with the software (the G10/G20 precedent),
 * read by verbs, never re-typed by a consultant into markdown.
 */

/** The phases a G20 task can belong to (kept in sync with PHASES in project.ts by the G20 §7 guard). */
export type RunbookPhase =
  | 'discovery'
  | 'extraction'
  | 'mapping'
  | 'rehearsal'
  | 'cutover'
  | 'parallel_run'
  | 'live';

/** Who acts on an item. Human-only sign-offs are enforced at the verb, not here. */
export type RunbookOwnerKind = 'human' | 'agent' | 'system';

/**
 * The statutory-deadline rules whose due date is a function of a period or fiscal year rather than
 * a plain offset. G20 resolves the first three from the fiscal year and the cutover date; G22
 * resolves the last two from the MWST period end.
 */
export type DeadlineRule =
  /** MWSTG: annual reconciliation of filed returns against the annual accounts, within 180 days of
   *  fiscal-year end. */
  | 'umsatzabstimmung_180'
  /** Art. 72 MWSTG: a Berichtigung (correction of the annual reconciliation) within 240 days. */
  | 'berichtigung_240'
  /** For a cutover early in the year: the PRIOR-year Umsatzabstimmung, whose evidence resolves against
   *  a G13 archive query (the archive's statutory argument made operational, US-G20.3). */
  | 'prior_year_umsatzabstimmung'
  /**
   * Art. 71 Abs. 1 MWSTG (SR 641.20): "Die Abrechnung muss jeweils innert 60 Tagen nach Ablauf der
   * entsprechenden Abrechnungsperiode unaufgefordert eingereicht werden." Period end + 60 days.
   * Verified 2026-09-09 against the ESTV's own page https://www.estv.admin.ch/de/mwst-bezahlen,
   * which quotes the sentence and links https://www.fedlex.admin.ch/eli/cc/2009/615/de#art_71
   * (fedlex itself is JavaScript-gated and its data export answered 404).
   */
  | 'vat_filing_60'
  /**
   * Art. 86 Abs. 1 MWSTG: the tax for the Abrechnungsperiode is paid within 60 days after its end
   * (the same ESTV sentence continues "und bezahlt werden (Art. 86 Abs. 1 MWSTG)", linking
   * https://www.fedlex.admin.ch/eli/cc/2009/615/de#art_86). Period end + 60 days.
   */
  | 'vat_payment_60';

/** The fields a G20 task and a G22 item share. */
export interface RunbookTemplateItemBase {
  /** Stable id within the template, written to the instantiated row. */
  readonly itemId: string;
  readonly title: string;
  readonly ownerKind: RunbookOwnerKind;
  readonly ownerRef?: string;
  /** Days relative to the anchor (cutover date for G20, period end for G22). Ignored when a rule is set. */
  readonly dueOffsetDays?: number;
  /** The item this one waits on (its `itemId`), refused as `prerequisite_open` while that is open. */
  readonly prerequisiteItemId?: string;
  /** What evidence the item requires (a fileId, a check id, a sign-off kind, an archive query). */
  readonly evidenceKind?: string;
  readonly contingency?: string;
  /** Undeletable: only skipped (G22) or `not_applicable` (G20) with a recorded reason, never dropped. */
  readonly undeletable?: boolean;
  /** A statutory deadline whose due date the engine computes, not an offset. */
  readonly deadlineRule?: DeadlineRule;
}

/** One G20 runbook item: the template of one `implementation_task`. */
export interface RunbookTemplateItem extends RunbookTemplateItemBase {
  readonly phase: RunbookPhase;
}

/** One shipped G20 runbook template. */
export interface RunbookTemplate {
  readonly templateId: string;
  readonly label: string;
  readonly description: string;
  readonly items: readonly RunbookTemplateItem[];
}

// --- The checklist extension (G22) ---------------------------------------------------------------

/**
 * The named engine checks a checklist item may evaluate live. Each composes EXISTING reads (A02,
 * A20/A21, A26, A07, A03) and recomputes no figure of its own; the key is a tooltip in the Studio,
 * never on-screen text (the label comes from i18n).
 */
export const CHECKLIST_CHECK_KEYS = [
  'no_drafts',
  'bank_reconciled',
  'no_missing_tax_codes',
  'vat_return_computed',
  'abstimmung_resolved',
  'period_locked_vat_filed',
] as const;
export type ChecklistCheckKey = (typeof CHECKLIST_CHECK_KEYS)[number];

/**
 * How an item is proven done. `check` flips live and is never written; `verb_result` binds the hash
 * the engine computed when it re-ran the verb; `signoff` is the append-only human half; and
 * `filed_attestation` is the sign-off kind that carries a date for the unobservable ePortal step.
 */
export const CHECKLIST_EVIDENCE_KINDS = ['check', 'verb_result', 'signoff', 'filed_attestation'] as const;
export type ChecklistEvidenceKind = (typeof CHECKLIST_EVIDENCE_KINDS)[number];

/** The sign-off kinds `checklist_signoff.kind` admits (the §H-ENUM single source). */
export const CHECKLIST_SIGNOFF_KINDS = ['abstimmung_reviewed', 'filed_attestation', 'settlement_booked'] as const;
export type ChecklistSignoffKind = (typeof CHECKLIST_SIGNOFF_KINDS)[number];

/** Which period a template instantiates over. `vat_period` reads A07's `vat_periods`. */
export type ChecklistPeriodKind = 'vat_period' | 'month' | 'year' | 'none';

/** One checklist item: the template of one `checklist_run_item`. */
export interface ChecklistTemplateItem extends RunbookTemplateItemBase {
  readonly evidenceKind: ChecklistEvidenceKind;
  /** The live check that IS this item's state (`evidenceKind: 'check'`). */
  readonly check?: ChecklistCheckKey;
  /** A check that must pass before a sign-off item may be completed (item 5's bridge). */
  readonly precondition?: ChecklistCheckKey;
  /** The registry verb an agent calls for this item; the engine re-runs it to bind the evidence. */
  readonly verb?: string;
  /** The Studio route the row opens (the owning surface), for `link` actions. */
  readonly deepLink?: string;
  /** Inherit another item's due date (items 1 to 3 inherit item 4's, plan finding 3). */
  readonly dueLikeItemId?: string;
  /** Several prerequisites (item 4 waits on the three checks). Merged with `prerequisiteItemId`. */
  readonly prerequisiteItemIds?: readonly string[];
  /** The sign-off kind a `signoff` / `filed_attestation` item records. */
  readonly signoffKind?: ChecklistSignoffKind;
  /** A `signoff` item that needs a reference the caller supplies (item 9: the bank transaction). */
  readonly requiresEvidenceRef?: boolean;
}

/** One shipped checklist template. */
export interface ChecklistTemplate {
  readonly templateId: string;
  /** `vat_period` today; `month_close`, `year_close` and `cutover` are the named later kinds. */
  readonly kind: string;
  readonly label: string;
  readonly description: string;
  readonly periodKind: ChecklistPeriodKind;
  readonly items: readonly ChecklistTemplateItem[];
}

/** Every prerequisite of an item, the single field and the list merged, in template order. */
export function prerequisitesOf(item: ChecklistTemplateItem): readonly string[] {
  const out: string[] = [];
  if (item.prerequisiteItemId !== undefined) out.push(item.prerequisiteItemId);
  for (const id of item.prerequisiteItemIds ?? []) if (!out.includes(id)) out.push(id);
  return out;
}
