/**
 * The Projects surface's data shapes and the two engine-enum mirrors it renders from.
 *
 * `PROJECT_STATUSES` is MIRRORED, NOT INVENTED (`src/core/projects/enums.ts`); the pairing is
 * registered in `test/style/studio-mirrors-engine-enums.test.mjs`, so a drift reddens the gate
 * rather than shipping a status the engine refuses. `NEXT_STATUSES` restates the transition table
 * as "what may this status become": a drift here costs an `invalid_transition` rejection the
 * operator can read, never a silent wrong write.
 */

export const PROJECT_STATUSES = ['draft', 'active', 'on_hold', 'closed'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** The legal next statuses per current status (the engine's PROJECT_TRANSITIONS, regrouped). */
export const NEXT_STATUSES: Record<ProjectStatus, readonly ProjectStatus[]> = {
  draft: ['active'],
  active: ['on_hold', 'closed'],
  on_hold: ['active', 'closed'],
  closed: ['active'],
};

/** The status glyphs (spec §6): paired with the label always, never colour or glyph alone. */
export const STATUS_GLYPHS: Record<ProjectStatus, string> = {
  draft: '◇',
  active: '▶',
  on_hold: '⏸',
  closed: '✓',
};

export interface Project {
  id: string;
  code: string;
  name: string;
  contactId: string;
  status: ProjectStatus;
  currency: string;
  budgetMinor: number;
  budgetHours: number;
  budgetBaseMinor: number | null;
  fxRate: string | null;
  startsOn: string | null;
  endsOn: string | null;
  parentId: string | null;
}

export interface Phase {
  id: string;
  projectId: string;
  name: string;
  sort: number;
  budgetMinor: number;
  budgetHours: number;
  milestoneOn: string | null;
  doneAt: string | null;
}

export interface PhaseStanding {
  phaseId: string;
  name: string;
  milestoneOn: string | null;
  doneAt: string | null;
  budgetMinor: number;
  budgetHours: number;
  actualCostMinor: number;
  actualHours: number;
  remainingMinor: number;
  remainingHours: number;
  overBudget: boolean;
}

export interface BudgetActual {
  budgetMinor: number;
  budgetHours: number;
  actualCostMinor: number;
  actualHours: number;
  remainingMinor: number;
  remainingHours: number;
  overBudget: boolean;
  currency: string;
  phases: PhaseStanding[];
}

export interface ContactOption {
  id: string;
  name: string;
}

/** A fresh per-click idempotency key (the Items surface idiom). */
export function idemKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Parse a decimal money string ("1'234.50", "1234,5") into integer Rappen, or null when it is not
 * an amount. Integer arithmetic on the split halves (P2): no float ever touches the Rappen.
 */
export function parseAmountToMinor(text: string): number | null {
  const cleaned = text.replace(/['\s]/g, '').replace(',', '.');
  if (cleaned.length === 0) return null;
  const m = /^(\d+)(?:\.(\d{0,2}))?$/.exec(cleaned);
  if (m === null) return null;
  const whole = Number(m[1]);
  const rappen = Number((m[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(whole * 100 + rappen)) return null;
  return whole * 100 + rappen;
}

/** Order projects for the nested list: roots by code, each followed by its children by code. */
export function nestProjects(projects: readonly Project[]): { project: Project; isChild: boolean }[] {
  const byParent = new Map<string, Project[]>();
  const roots: Project[] = [];
  const ids = new Set(projects.map((p) => p.id));
  for (const p of projects) {
    // A child whose parent is filtered OUT of the current list renders as a root: hiding it with an
    // absent parent would make a status filter silently swallow sub-projects.
    if (p.parentId !== null && ids.has(p.parentId)) {
      const list = byParent.get(p.parentId) ?? [];
      list.push(p);
      byParent.set(p.parentId, list);
    } else {
      roots.push(p);
    }
  }
  const byCode = (a: Project, b: Project) => a.code.localeCompare(b.code);
  const out: { project: Project; isChild: boolean }[] = [];
  const push = (p: Project, isChild: boolean) => {
    out.push({ project: p, isChild });
    for (const child of (byParent.get(p.id) ?? []).sort(byCode)) push(child, true);
  };
  for (const root of roots.sort(byCode)) push(root, false);
  return out;
}
