/**
 * Auto-start (spec G22 §10.8, D129): option B, a daily rule and a defaulting verb. `checklist_start`
 * accepts a missing `period` and picks the last ended period of the template's kind; a seeded
 * `schedule.daily` rule calls it for `month_close` and for `vat_period`, and the natural-key
 * idempotency (`created:false`) makes the daily firing start each period exactly once. The start
 * lands on the first tick after the period ends; a workspace whose tick never runs starts nothing,
 * the same truth every schedule rule carries today.
 *
 * `seedDefaultChecklistRules` follows `seedBuiltinRoles`: `INSERT ... WHERE NOT EXISTS` on the rule
 * id, so a rule the owner DISABLED (`disable_automation_rule`) is never re-enabled: the seed keys on
 * the id, not on `enabled`. The author is the creating actor (the A24 gate the fire path runs under).
 * `createWorkspace` makes the call since the N4 landing (2026-09-10), the day the `month_close`
 * template existed.
 *
 * THE ID CARRIES THE WORKSPACE. `automation_rule.id` is a global PRIMARY KEY (unlike `role_def.id`,
 * which is unique per workspace), so a fixed `builtin:checklist_autostart:month_close` could exist
 * ONCE per store and the second workspace on a shared file could not be created at all (measured at
 * the N4 build: `create_workspace` threw on the second tenant). The stored id is therefore
 * `<prefix>:<workspaceId>`; `CHECKLIST_AUTOSTART_RULE_IDS` keeps the PREFIXES the spec names, and
 * `checklistAutostartTemplateOf` reads a run's `created_by` back to the template it was seeded for.
 *
 * `year_close` has no seeded rule: the year close is started deliberately (D129). A rule naming
 * `checklist_start` with `templateId: 'year_close'` is refused at rule creation with
 * `template_not_automatable`, the `NOT_AUTOMATABLE` shape keyed on the input; the denylist module
 * (`src/core/automation/denylist.ts`) carries the same pair so it stays import-free, and
 * `test/checklists/g22-engine-kinds.test.mjs` asserts the two agree.
 */

import type { WorkspaceContext } from '../context.js';

/** The refusal code a rule naming a deliberately started template gets at definition time. */
export const TEMPLATE_NOT_AUTOMATABLE_CODE = 'template_not_automatable';

/** The templates no rule may start (mirrored in `NOT_AUTOMATABLE_INPUTS` of the denylist). */
export const NOT_AUTOMATABLE_TEMPLATE_IDS: readonly string[] = ['year_close'];

/** The seeded rule id PREFIXES, keyed by template; the stored id is `<prefix>:<workspaceId>`. */
export const CHECKLIST_AUTOSTART_RULE_IDS = {
  month_close: 'builtin:checklist_autostart:month_close',
  vat_period: 'builtin:checklist_autostart:vat_period',
} as const;

/** The stored id of a workspace's seeded rule for a template. */
export function checklistAutostartRuleId(workspaceId: string, templateId: keyof typeof CHECKLIST_AUTOSTART_RULE_IDS): string {
  return `${CHECKLIST_AUTOSTART_RULE_IDS[templateId]}:${workspaceId}`;
}

/**
 * The template a seeded rule id (a run's `created_by`, spec §10.8) was seeded for, or undefined for
 * any other creator. The provenance line's word ("Regel Monatsabschluss") comes from this.
 */
export function checklistAutostartTemplateOf(ruleId: string | null | undefined): keyof typeof CHECKLIST_AUTOSTART_RULE_IDS | undefined {
  if (typeof ruleId !== 'string') return undefined;
  for (const [templateId, prefix] of Object.entries(CHECKLIST_AUTOSTART_RULE_IDS)) {
    if (ruleId.startsWith(`${prefix}:`)) return templateId as keyof typeof CHECKLIST_AUTOSTART_RULE_IDS;
  }
  return undefined;
}

export interface ChecklistAutostartRule {
  readonly id: string;
  readonly templateId: keyof typeof CHECKLIST_AUTOSTART_RULE_IDS;
  /** The rule's name in the Automations list (de-CH, the product's own vocabulary). */
  readonly name: string;
}

export const CHECKLIST_AUTOSTART_RULES: readonly ChecklistAutostartRule[] = [
  { id: CHECKLIST_AUTOSTART_RULE_IDS.month_close, templateId: 'month_close', name: 'Monatsabschluss automatisch starten' },
  { id: CHECKLIST_AUTOSTART_RULE_IDS.vat_period, templateId: 'vat_period', name: 'MWST-Periode automatisch starten' },
];

/** The trigger every seeded rule fires on. */
export const CHECKLIST_AUTOSTART_TRIGGER = 'schedule.daily';

/**
 * Seed the two default rules for a workspace, once. Returns the ids it inserted (an existing row,
 * enabled or not, is left exactly as it is).
 */
export function seedDefaultChecklistRules(ctx: WorkspaceContext): { seeded: string[] } {
  const now = ctx.clock.now();
  const insert = ctx.store.db.prepare(
    `INSERT INTO automation_rule
       (id, workspace_id, name, trigger_event, condition, action_tool, action_input, enabled, archived, created_by, last_fired_at, created_at, updated_at)
     SELECT ?, ?, ?, ?, 'null', 'checklist_start', ?, 1, 0, ?, NULL, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM automation_rule WHERE workspace_id = ? AND id = ?)`,
  );
  const seeded: string[] = [];
  for (const rule of CHECKLIST_AUTOSTART_RULES) {
    const id = checklistAutostartRuleId(ctx.workspaceId, rule.templateId);
    const res = insert.run(
      id,
      ctx.workspaceId,
      rule.name,
      CHECKLIST_AUTOSTART_TRIGGER,
      JSON.stringify({ templateId: rule.templateId }),
      ctx.actor,
      now,
      now,
      ctx.workspaceId,
      id,
    );
    if (Number(res.changes) > 0) seeded.push(id);
  }
  return { seeded };
}
