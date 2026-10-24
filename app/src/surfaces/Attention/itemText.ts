/**
 * How an attention row and a queue become words, in ONE place for the hub (`/attention`) and the
 * Übersicht list, so the two can never word the same item differently.
 *
 *  - A param named `...At` that carries an ISO instant (the engine sends data, never a rendered date) is
 *    shown in Swiss time as `02.10.2026, 07:02`. A param named `date` or `...Date` carrying a calendar day
 *    (`2026-09-23`) is shown as `23.09.2026` (D150, D178), and a number named `...Minor` beside a `currency`
 *    param as money (`CHF 500.00`). Every other param passes through untouched.
 *  - A queue is named by `attention.queueLabel.<queueId>`; when that key is missing (a queue registered
 *    in the engine before its Studio label landed) the provider's OWN `labelKey` from the payload names
 *    it, and only then a humanised id. A raw dot path never reaches the screen (the
 *    `attention.queueLabel.bank_keys_review` defect). `test/attention/queue-labels.test.mjs` keeps the
 *    primary keys complete; this is the second line.
 */
import { CATALOG, DEFAULT_LOCALE, formatDate, formatMoney, type Locale } from '../../i18n';
import { verbLabel } from './RowDecision';

type T = (key: string, params?: Record<string, string | number>) => string;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `2026-10-02T05:02:00.000Z` -> `02.10.2026, 07:02` (Europe/Zurich, 24h). */
export function formatInstant(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat('de-CH', {
    timeZone: 'Europe/Zurich',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')}.${get('month')}.${get('year')}, ${get('hour')}:${get('minute')}`;
}

/** Format the instant-valued params (`lastCheckAt`, ...) of an item for display; the rest pass through. */
export function formatItemParams(params: Readonly<Record<string, string | number>>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  const currency = typeof params.currency === 'string' && params.currency !== '' ? params.currency : null;
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && key.endsWith('At') && ISO_INSTANT.test(value)) out[key] = formatInstant(value);
    else if (typeof value === 'string' && (key === 'date' || key.endsWith('Date')) && ISO_DAY.test(value)) out[key] = formatDate(value);
    else if (typeof value === 'number' && key.endsWith('Minor') && currency !== null) out[key] = formatMoney(value, currency);
    else out[key] = value;
  }
  return out;
}

export interface WordedItem {
  queueId: string;
  titleKey: string;
  titleParams: Record<string, string | number>;
  subtitleKey?: string;
  subtitleParams?: Record<string, string | number>;
}

export function itemTitle(t: T, item: WordedItem): string {
  return t(item.titleKey, formatItemParams(item.titleParams));
}

/** The subtitle line, or null when the item carries none. A Vorschlag names its verb in words. */
export function itemSubtitle(t: T, item: WordedItem): string | null {
  // D178: the Vorschläge are two queues (bank, and everything else); both name the drafted verb.
  if (item.queueId === 'agent_action' || item.queueId === 'agent_action_bank') return verbLabel(t, String(item.subtitleParams?.tool ?? ''));
  if (item.subtitleKey === undefined) return null;
  return t(item.subtitleKey, formatItemParams(item.subtitleParams ?? {}));
}

function has(locale: Locale, key: string): boolean {
  const lookup = (tree: unknown): boolean => {
    let node = tree;
    for (const part of key.split('.')) {
      if (node === null || typeof node !== 'object') return false;
      node = (node as Record<string, unknown>)[part];
    }
    return typeof node === 'string';
  };
  return lookup(CATALOG[locale]) || lookup(CATALOG[DEFAULT_LOCALE]);
}

/**
 * A queue in words: its `queueLabel`, else the provider's own `labelKey`, else the id made readable.
 * Checked against the catalogue BEFORE translating, so a missing key is a fallback, not a console error.
 */
export function queueName(t: T, locale: Locale, queueId: string, labelKey?: string): string {
  const primary = `attention.queueLabel.${queueId}`;
  if (has(locale, primary)) return t(primary);
  if (labelKey !== undefined && has(locale, labelKey)) return t(labelKey);
  const words = queueId.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
