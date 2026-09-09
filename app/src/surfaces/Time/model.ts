/**
 * The Time surface's data shapes and the two engine-enum mirrors it renders from.
 *
 * `TIME_STATUSES` and `RATE_CARD_SCOPES` are MIRRORED, NOT INVENTED (`src/core/time/enums.ts`);
 * both pairings are registered in `test/style/studio-mirrors-engine-enums.test.mjs`, so a drift
 * reddens the gate rather than shipping a status or a scope the engine refuses.
 */

export const TIME_STATUSES = ['open', 'submitted', 'approved', 'locked', 'billed'] as const;
export type TimeStatus = (typeof TIME_STATUSES)[number];

/**
 * The status glyphs (spec §6): paired with the label always, never colour or glyph alone.
 *
 * Every value is a geometric TEXT glyph, never an emoji: brand/DESIGN.md's forbidden list bans
 * "emoji as section markers or status" and the owner has banned it by name. `locked` used the raw
 * padlock emoji (U+1F512); it is a sealed-box glyph now, in the same text-presentation family as the
 * others. The lock-marker idiom elsewhere (Periods, the Time lock button) is the shared LockGlyph
 * SVG, but this record is consumed as a plain string inside `<span>{STATUS_GLYPHS[...]}</span>` in
 * Time.tsx, so an SVG component cannot go here; the padlock guard
 * (`app/src/surfaces/no-padlock-emoji.test.ts`) keeps the emoji from returning.
 */
export const STATUS_GLYPHS: Record<TimeStatus, string> = {
  open: '▷',
  submitted: '⇧',
  approved: '✓',
  locked: '▣',
  billed: 'ⓕ',
};

export const RATE_CARD_SCOPES = ['client', 'project', 'employee', 'default'] as const;
export type RateCardScope = (typeof RATE_CARD_SCOPES)[number];

export interface TimeEntry {
  id: string;
  userId: string;
  projectId: string;
  phaseId: string | null;
  startedAt: string;
  endedAt: string | null;
  minutes: number | null;
  billable: boolean;
  notes: string | null;
  status: TimeStatus;
  rateMinor: number;
  rateCurrency: string;
  rateScope: string;
}

export interface RateCard {
  id: string;
  scope: RateCardScope;
  scopeRef: string | null;
  rateMinor: number;
  currency: string;
  validFrom: string;
  validTo: string | null;
}

/** Read the engine's list payload defensively: a shape this surface cannot read is a failed READ. */
export function parseEntries(body: unknown): { entries: TimeEntry[]; totalMinutes: number; billableMinor: number } | null {
  if (body === null || typeof body !== 'object') return null;
  const raw = (body as { entries?: unknown }).entries;
  if (!Array.isArray(raw)) return null;
  const entries: TimeEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') return null;
    const e = item as Record<string, unknown>;
    if (typeof e.id !== 'string' || typeof e.projectId !== 'string' || typeof e.status !== 'string') return null;
    entries.push({
      id: e.id,
      userId: typeof e.userId === 'string' ? e.userId : '',
      projectId: e.projectId,
      phaseId: typeof e.phaseId === 'string' ? e.phaseId : null,
      startedAt: typeof e.startedAt === 'string' ? e.startedAt : '',
      endedAt: typeof e.endedAt === 'string' ? e.endedAt : null,
      minutes: typeof e.minutes === 'number' ? e.minutes : null,
      billable: e.billable === true,
      notes: typeof e.notes === 'string' ? e.notes : null,
      status: (TIME_STATUSES as readonly string[]).includes(e.status) ? (e.status as TimeStatus) : 'open',
      rateMinor: typeof e.rateMinor === 'number' ? e.rateMinor : 0,
      rateCurrency: typeof e.rateCurrency === 'string' ? e.rateCurrency : 'CHF',
      rateScope: typeof e.rateScope === 'string' ? e.rateScope : 'default',
    });
  }
  const totalMinutes = typeof (body as { totalMinutes?: unknown }).totalMinutes === 'number' ? ((body as { totalMinutes: number }).totalMinutes) : 0;
  const billableMinor = typeof (body as { billableMinor?: unknown }).billableMinor === 'number' ? ((body as { billableMinor: number }).billableMinor) : 0;
  return { entries, totalMinutes, billableMinor };
}

export function parseRateCards(body: unknown): RateCard[] {
  const raw = (body as { rateCards?: unknown })?.rateCards;
  if (!Array.isArray(raw)) return [];
  const cards: RateCard[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    if (typeof c.id !== 'string' || typeof c.scope !== 'string' || typeof c.rateMinor !== 'number') continue;
    cards.push({
      id: c.id,
      scope: (RATE_CARD_SCOPES as readonly string[]).includes(c.scope) ? (c.scope as RateCardScope) : 'default',
      scopeRef: typeof c.scopeRef === 'string' ? c.scopeRef : null,
      rateMinor: c.rateMinor,
      currency: typeof c.currency === 'string' ? c.currency : 'CHF',
      validFrom: typeof c.validFrom === 'string' ? c.validFrom : '',
      validTo: typeof c.validTo === 'string' ? c.validTo : null,
    });
  }
  return cards;
}

/** Minutes as "H:MM" for the sheet, locale-neutral by design (a duration is not a date). */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}
