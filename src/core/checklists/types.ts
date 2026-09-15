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
 * resolves the MWST pair from the period end and, on a `year` run, the annual-reconciliation pair and
 * the GV rule from the fiscal year end (which IS the period end there, spec §10.3).
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
  | 'vat_payment_60'
  /**
   * The ordentliche Generalversammlung within six months of the fiscal year end: Art. 699 Abs. 2 OR
   * for the AG, Art. 805 OR for the GmbH (which points at the AG's rules). The same calendar day six
   * months on, clamped to the month's last day (31.12. -> 30.06.). Resolvable only from a `year` period.
   */
  | 'gv_6_months';

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
 * never on-screen text (the label comes from i18n). The three lock checks (leg 2, spec §10.4) read
 * A03's `period_lock` the way `list_period_locks` does.
 */
export const CHECKLIST_CHECK_KEYS = [
  'no_drafts',
  'bank_reconciled',
  'no_missing_tax_codes',
  'vat_return_computed',
  'abstimmung_resolved',
  'period_locked_vat_filed',
  'lock_on_month',
  'soft_lock_on_year',
  'seal_on_year',
] as const;
export type ChecklistCheckKey = (typeof CHECKLIST_CHECK_KEYS)[number];

/**
 * How an item is proven done (the documentation word is "item kind", spec §10.1). `check` flips live
 * and is never written; `verb_result` binds the hash the engine computed when it re-ran the verb;
 * `signoff` is the append-only human half; `filed_attestation` is the sign-off kind that carries a
 * date for the unobservable ePortal step. Leg 2 adds four: `choice` (a bounded answer that governs
 * inclusion), `preview` (a hash-bound read), `posting` (a DERIVATION from the ledger through a probe:
 * the domain verb is the act and the checklist engine never posts), and `validation` (a named
 * plausibility check with a formula, `block` or `warn`).
 */
export const CHECKLIST_EVIDENCE_KINDS = [
  'check',
  'verb_result',
  'signoff',
  'filed_attestation',
  'choice',
  'preview',
  'posting',
  'validation',
] as const;
export type ChecklistEvidenceKind = (typeof CHECKLIST_EVIDENCE_KINDS)[number];

/**
 * The sign-off kinds `checklist_signoff.kind` admits (the §H-ENUM single source). Leg 2 adds
 * `statements_signoff` (hash-bound to the statements anchor), `validation_acknowledged` (the ONE
 * acknowledgement mechanism, hash-bound to the validation's figures) and `gv_attestation` (dated, the
 * `filed_attestation` shape, hash-bound to the anchor like every acknowledgement).
 */
export const CHECKLIST_SIGNOFF_KINDS = [
  'abstimmung_reviewed',
  'filed_attestation',
  'settlement_booked',
  'statements_signoff',
  'validation_acknowledged',
  'gv_attestation',
] as const;
export type ChecklistSignoffKind = (typeof CHECKLIST_SIGNOFF_KINDS)[number];

/**
 * Which period a template instantiates over. `vat_period` reads A07's `vat_periods`; `month` is a
 * calendar month `YYYY-MM`; `year` is the fiscal year A03's `fiscalYearOf` labels, bounded by
 * `workspace.fiscal_year_start`. (`none` was deleted in leg 2: no template used it.)
 */
export const CHECKLIST_PERIOD_KINDS = ['vat_period', 'month', 'year'] as const;
export type ChecklistPeriodKind = (typeof CHECKLIST_PERIOD_KINDS)[number];

/**
 * What the run's evidence binds to (spec §10.2, F8). `vat_return` is A07's computed return (the
 * `vat_period` template); `statements` is the canonical projection of the posted ledger over the
 * period (`statementsHashOf`), the anchor of the close templates.
 */
export const CHECKLIST_ANCHORS = ['vat_return', 'statements'] as const;
export type ChecklistAnchor = (typeof CHECKLIST_ANCHORS)[number];

/** What a `choice` item can derive its answer from, until a human overrules it. */
export const CHECKLIST_DERIVE_KEYS = ['legal_form', 'vat_method', 'has_fc_positions', 'has_assets'] as const;
export type ChecklistDeriveKey = (typeof CHECKLIST_DERIVE_KEYS)[number];

/** How the run's period maps onto a preview or posting verb's input (spec §10.1). */
export const CHECKLIST_VERB_INPUT_KEYS = ['period', 'periodEnd', 'year', 'lastMonth'] as const;
export type ChecklistVerbInputKey = (typeof CHECKLIST_VERB_INPUT_KEYS)[number];

/**
 * How a `posting` row sees its artefact (spec §10.4). A probe reads the ledger and the domain tables
 * and never writes; `found === null` is `unavailable` with a reason (the A38 probes answer `needs_a38`
 * until that capability lands).
 */
export const CHECKLIST_PROBE_KEYS = [
  'fx_revaluation_posted',
  'depreciation_charged',
  'accruals_posted',
  'provisions_posted',
  'tax_provision_posted',
  'vat_settlement_posted',
  'lock_on_month',
  'soft_lock_on_year',
  'seal_on_year',
] as const;
export type ChecklistProbeKey = (typeof CHECKLIST_PROBE_KEYS)[number];

/** The named plausibility checks a `validation` item evaluates, each with a formula (spec §10.4). */
export const CHECKLIST_VALIDATION_KEYS = [
  'locks_on_all_months',
  'open_items_debtors',
  'bank_balance_matches',
  'open_items_creditors',
  'accruals_reversed',
  'depreciation_within_limit',
  'vat_accounts_zero',
  'vat_declared_equals_books',
  'umsatzabstimmung',
  'tax_provision_plausible',
  'balance_equation',
  'prior_year_comparison',
  'capital_loss',
] as const;
export type ChecklistValidationKey = (typeof CHECKLIST_VALIDATION_KEYS)[number];

/** A `block` validation holds the run; a `warn` one is acknowledged by a hash-bound sign-off. */
export const CHECKLIST_VALIDATION_SEVERITIES = ['block', 'warn'] as const;
export type ChecklistValidationSeverity = (typeof CHECKLIST_VALIDATION_SEVERITIES)[number];

/** One bounded answer of a `choice` item. Labels and consequences are i18n keys, never text. */
export interface ChecklistChoiceOption {
  readonly id: string;
  readonly labelKey: string;
  readonly consequenceKey: string;
}

/** One checklist item: the template of one `checklist_run_item`. */
export interface ChecklistTemplateItem extends RunbookTemplateItemBase {
  readonly evidenceKind: ChecklistEvidenceKind;
  /** The live check that IS this item's state (`evidenceKind: 'check'`). */
  readonly check?: ChecklistCheckKey;
  /** A check that must pass before a sign-off item may be completed (item 5's bridge). */
  readonly precondition?: ChecklistCheckKey;
  /**
   * The registry verb an agent calls for this item: re-run to bind the evidence (`verb_result`,
   * `preview`), or the domain WRITE the human or agent calls under its own gate (`posting`, and item 8's
   * `check` that acts through `vat_mark_filed`).
   */
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

  // --- Leg 2 (spec §10.1) ---
  /** `choice`: two to four bounded answers. */
  readonly options?: readonly ChecklistChoiceOption[];
  /** `choice`: the engine answers from the books until a human overrules (re-derived on every read). */
  readonly derive?: ChecklistDeriveKey;
  /** `choice`: a PRE-SELECTED radio, never an answer; the row stays open until "Antwort speichern". */
  readonly defaultOptionId?: string;
  /** `preview` / `posting`: how the run's period maps onto the verb's input. */
  readonly verbInput?: ChecklistVerbInputKey;
  /** `preview`: a JSON pointer into the read whose emptiness means "nothing to do" (`/positions`). */
  readonly emptyWhen?: string;
  /** `posting`: the verb that reverses the artefact (a reversing entry, never an edit). */
  readonly reverseVerb?: string;
  /** `posting`: how the engine sees the posted artefact. */
  readonly probe?: ChecklistProbeKey;
  /** `posting`: the paired preview item (an implicit prerequisite, and the partner of `excluded`). */
  readonly previewOf?: string;
  /** `validation`: the named check. */
  readonly validation?: ChecklistValidationKey;
  /** `validation`: `block` holds the run, `warn` is acknowledged. */
  readonly severity?: ChecklistValidationSeverity;
  /** `validation`: where a human fixes it (a route, possibly with a query). */
  readonly fixLink?: string;
  /**
   * Included only while the governing `choice` carries this answer (or one of these answers: "GmbH" is
   * `legal_form` in {gmbh, ag}, "MWST-pflichtig" is `vat_method` in {effektiv, saldo}, spec §10.1 as
   * reconciled at the N4 build); `excluded` by derivation otherwise.
   */
  readonly includedWhen?: { readonly itemId: string; readonly optionId: string | readonly string[] };
}

/** One shipped checklist template. */
export interface ChecklistTemplate {
  readonly templateId: string;
  /** `vat_period` today; `month_close`, `year_close` and `cutover` are the named later kinds. */
  readonly kind: string;
  readonly label: string;
  readonly description: string;
  readonly periodKind: ChecklistPeriodKind;
  /** What the run's hash-bound evidence measures against (spec §10.2). */
  readonly anchor: ChecklistAnchor;
  readonly items: readonly ChecklistTemplateItem[];
}

/** Every prerequisite of an item, the single field and the list merged, in template order. */
export function prerequisitesOf(item: ChecklistTemplateItem): readonly string[] {
  const out: string[] = [];
  if (item.prerequisiteItemId !== undefined) out.push(item.prerequisiteItemId);
  for (const id of item.prerequisiteItemIds ?? []) if (!out.includes(id)) out.push(id);
  if (item.previewOf !== undefined && !out.includes(item.previewOf)) out.push(item.previewOf);
  return out;
}
