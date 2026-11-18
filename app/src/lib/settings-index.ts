/**
 * D202 point 3: ONE SEARCH INDEX for the Einstellungen and for Cmd K.
 *
 * Built from one `settings_list` read: one entry per workspace setting and one per settings page (the
 * "Seite" rows of an area, owner pick B: "bank" finds the Bank page AND the bank settings). Every word comes
 * from the engine (the presentation file, `src/core/settings/presentation.ts`), so an agent reading
 * `settings_list` and a person typing here find a setting by the same words.
 *
 * MATCHING. Lower-cased, accents folded and umlaut spellings joined (ä and a match, and so does a typed
 * two-letter spelling), every
 * token must hit some field (AND). A token scores by the best field it hits: label prefix 100, a word of the
 * label 80, a keyword in either locale 60, a value label 50, the area or sub-heading (and an area synonym) 40,
 * a word of the label in the other locale 35, a part of a label word 30, a word of the description (both
 * locales) or of the key 20. The entry scores the weakest of its tokens, so "bank fremd" ranks the setting
 * that has both words, not one that has "bank" twice.
 *
 * THE CATALOG. `useSettingsCatalog` reads `settings_list` once per workspace and shares the answer between
 * the Einstellungen and the palette. It reads again after every write (`reloadSettingsCatalog`), whenever
 * the window regains focus or the tab becomes visible, and when a reader mounts on an answer older than
 * half a minute: the owner's search for a setting added after the tab opened (D209's
 * `agent.approve_on_owner_word`, 18.11.2026) found nothing, because the first answer was kept for good.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { useClient } from './client-context';
import { isErr, type Err } from './client';

export type Localised = { en: string; 'de-CH': string };
export type Locale = 'en' | 'de-CH';
export type SettingValue = number | boolean | string;
export type SettingSchema =
  | { type: 'integer'; min: number; max: number; unit?: 'days' | 'items' | 'percent' }
  | { type: 'number'; min: number; max: number }
  | { type: 'boolean' }
  | { type: 'string'; maxLength: number }
  | { type: 'enum'; values: string[] };

export interface SettingEntryView {
  key: string;
  value: SettingValue;
  default: SettingValue;
  overridden: boolean;
  schema: SettingSchema;
  owningCapability: string;
  dialCapability: string;
  label: Localised;
  description: Localised;
  humanOnly: boolean;
  askFirst: boolean;
  answered: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  stale?: boolean;
  ignoredStoredValue?: string | null;
  section: string;
  presentation: {
    subgroup: Localised;
    label: Localised;
    valueLabels?: Record<string, Localised>;
    keywords: { en: string[]; 'de-CH': string[] };
    widensAgent?: boolean;
  };
}

export interface SettingsAreaEntry {
  id: string;
  label: Localised;
  icon: string;
  keywords: { en: string[]; 'de-CH': string[] };
  pages: { id: string; route: string; label: Localised; keywords: { en: string[]; 'de-CH': string[] } }[];
  agentMayChange: boolean;
}

export interface SettingsCatalog {
  settings: SettingEntryView[];
  unanswered: string[];
  areas: SettingsAreaEntry[];
}

export function textOf(text: Localised | undefined, locale: Locale): string {
  if (text === undefined) return '';
  return locale === 'en' ? text.en : text['de-CH'];
}

/** The value a list of named values stores when nothing is chosen (the settings verbs refuse an empty value). */
export const SET_NONE = 'none';

/**
 * A value in words: the enum's own label, Ein/Aus for a boolean, the number with its unit, and for the
 * agent's areas (`agent.settings_sections`) the areas' names, never their ids (pass the catalog's areas).
 */
export function valueWords(
  s: Pick<SettingEntryView, 'schema' | 'presentation'> & { key?: string },
  value: SettingValue,
  locale: Locale,
  areas: readonly Pick<SettingsAreaEntry, 'id' | 'label'>[] = [],
): string {
  if (s.key === 'agent.settings_sections' && typeof value === 'string') {
    const ids = value.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
    if (ids.length === 0) return locale === 'en' ? 'None' : 'Keine';
    return ids.map((id) => textOf(areas.find((a) => a.id === id)?.label, locale) || id).join(', ');
  }
  if (s.schema.type === 'enum' && typeof value === 'string') return textOf(s.presentation.valueLabels?.[value], locale) || value;
  // A list whose values have words (`agent.owner_word_excluded`): each name in words.
  if (s.schema.type === 'string' && typeof value === 'string' && s.presentation.valueLabels !== undefined) {
    const ids = value.split(',').map((x) => x.trim()).filter((x) => x.length > 0 && x !== SET_NONE);
    if (ids.length === 0) return locale === 'en' ? 'None' : 'Keine';
    return ids.map((id) => textOf(s.presentation.valueLabels?.[id], locale) || id).join(', ');
  }
  if (s.schema.type === 'boolean') return value === true ? (locale === 'en' ? 'On' : 'Ein') : locale === 'en' ? 'Off' : 'Aus';
  if (s.schema.type === 'integer' && s.schema.unit !== undefined && typeof value === 'number') {
    const unit = { days: locale === 'en' ? 'days' : 'Tage', items: '', percent: '%' }[s.schema.unit];
    return unit === '' ? String(value) : `${value} ${unit}`;
  }
  if (s.schema.type === 'string' && value === '') return locale === 'en' ? 'None' : 'Keine';
  return String(value);
}

/**
 * The registry description as a person reads it on the label's tooltip. The registry writes it for an agent
 * too, so it names enum values by their ids ("off (Standard): ...", "propose_split: ..."): each id becomes
 * its value label where it stands as a value (before a colon, before "(Standard)", inside parentheses, or
 * anywhere when it carries an underscore), so no English enum value reaches the screen (DESIGN.md "Plain
 * German"). The registry's own "Only a person can change this." goes: the row says it in its own words.
 */
export function plainDescription(s: Pick<SettingEntryView, 'schema' | 'presentation' | 'description'>, locale: Locale): string {
  let text = textOf(s.description, locale);
  text = text.replace(/\s*(Nur eine Person kann das ändern\.|Only a person can change this\.)/g, '').trim();
  if (s.schema.type !== 'enum') return text;
  const ids = [...s.schema.values].sort((a, b) => b.length - a.length);
  for (const id of ids) {
    const words = textOf(s.presentation.valueLabels?.[id], locale);
    if (words === '' || words === id) continue;
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const edge = '(?<![\\p{L}\\p{N}_])';
    const end = '(?![\\p{L}\\p{N}_])';
    const where = id.includes('_') ? `${edge}${esc}${end}` : `${edge}${esc}(?=\\s*(?::|\\((?:Standard|default)\\)))|(?<=\\()${esc}(?=\\))`;
    text = text.replace(new RegExp(where, 'gu'), words);
  }
  return text;
}

// --- the index ----------------------------------------------------------------------------------------

export interface SettingsIndexEntry {
  kind: 'setting' | 'page';
  /** The setting key or the page id. */
  id: string;
  area: string;
  areaLabel: string;
  subgroup: string;
  label: string;
  /** The value in force in words (settings only). */
  current: string;
  valueLabels: string[];
  /** The setting's own synonyms, both locales. */
  keywords: string[];
  areaKeywords: string[];
  /** The label in the other locale. */
  otherLabel: string;
  /** The registry description, both locales (settings only). */
  descriptions: string[];
  /** The key's parts: `agent.approve_on_owner_word` reads agent, approve, on, owner, word. */
  keyWords: string[];
  /** Where a hit opens: `/settings/<area>?focus=<key>`, or the page's own route. */
  route: string;
}

function other(locale: Locale): Locale {
  return locale === 'en' ? 'de-CH' : 'en';
}

export function buildSettingsIndex(catalog: SettingsCatalog, locale: Locale): SettingsIndexEntry[] {
  const out: SettingsIndexEntry[] = [];
  for (const area of catalog.areas) {
    const areaLabel = textOf(area.label, locale);
    const areaKeywords = [...area.keywords[locale], ...(locale === 'en' ? [] : area.keywords.en)];
    for (const s of catalog.settings.filter((x) => x.section === area.id)) {
      out.push({
        kind: 'setting',
        id: s.key,
        area: area.id,
        areaLabel,
        subgroup: textOf(s.presentation.subgroup, locale),
        label: textOf(s.presentation.label, locale),
        current: valueWords(s, s.value, locale, catalog.areas),
        valueLabels: Object.values(s.presentation.valueLabels ?? {}).map((l) => textOf(l, locale)),
        keywords: [...(s.presentation.keywords[locale] ?? []), ...(s.presentation.keywords[other(locale)] ?? [])],
        areaKeywords,
        otherLabel: textOf(s.presentation.label, other(locale)),
        descriptions: [textOf(s.description, locale), textOf(s.description, other(locale))].filter((d) => d !== ''),
        keyWords: s.key.split(/[._-]+/).filter((w) => w.length > 0),
        route: `/settings/${area.id}?focus=${encodeURIComponent(s.key)}`,
      });
    }
    for (const p of area.pages) {
      out.push({
        kind: 'page',
        id: p.id,
        area: area.id,
        areaLabel,
        subgroup: '',
        label: textOf(p.label, locale),
        current: '',
        valueLabels: [],
        keywords: [...(p.keywords[locale] ?? []), ...(p.keywords[other(locale)] ?? [])],
        areaKeywords,
        otherLabel: textOf(p.label, other(locale)),
        descriptions: [],
        keyWords: [],
        route: p.route,
      });
    }
  }
  return out;
}

/** Lower case, accents folded, umlaut spellings joined: "Grösse" and "grosse" are one word, as is the spelling with an e. */
export function foldText(text: string): string {
  return text
    .toLowerCase()
    .replace(/ae/g, 'a')
    .replace(/oe/g, 'o')
    .replace(/ue/g, 'u')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss');
}

const WORD = /[^\p{L}\p{N}]+/u;

const wordStarts = (texts: readonly string[], token: string) => texts.some((t) => foldText(t).split(WORD).some((w) => w.startsWith(token)));

function tokenScore(token: string, e: SettingsIndexEntry): number {
  const label = foldText(e.label);
  if (label.startsWith(token)) return 100;
  if (label.split(WORD).some((w) => w.startsWith(token))) return 80;
  if (wordStarts(e.keywords, token)) return 60;
  if (wordStarts(e.valueLabels, token)) return 50;
  if (wordStarts([e.areaLabel, e.subgroup, ...e.areaKeywords], token)) return 40;
  if (wordStarts([e.otherLabel], token)) return 35;
  if (label.includes(token)) return 30;
  if (wordStarts(e.descriptions, token) || e.keyWords.some((w) => foldText(w).startsWith(token))) return 20;
  return 0;
}

export interface SettingsHit {
  entry: SettingsIndexEntry;
  score: number;
}

/** The entries that match every token, best first (a page before a setting at the same score). */
export function searchSettings(index: readonly SettingsIndexEntry[], query: string): SettingsHit[] {
  const tokens = foldText(query).split(WORD).filter((t) => t.length > 0);
  if (tokens.length === 0) return [];
  const hits: SettingsHit[] = [];
  for (const entry of index) {
    let score = Infinity;
    for (const token of tokens) {
      const s = tokenScore(token, entry);
      if (s === 0) {
        score = 0;
        break;
      }
      score = Math.min(score, s);
    }
    if (score > 0 && score !== Infinity) hits.push({ entry, score });
  }
  return hits.sort((a, b) => b.score - a.score || Number(b.entry.kind === 'page') - Number(a.entry.kind === 'page') || a.entry.label.localeCompare(b.entry.label));
}

/** The span of `text` the query matched first, for the highlight (folded positions equal raw ones here). */
export function matchSpan(text: string, query: string): [number, number] | null {
  const lower = text.toLowerCase();
  for (const token of query.toLowerCase().split(WORD).filter((t) => t.length > 0)) {
    const at = lower.indexOf(token);
    if (at >= 0) return [at, at + token.length];
  }
  return null;
}

// --- the shared catalog -----------------------------------------------------------------------------------

type CatalogState = { workspaceId: string | null; catalog: SettingsCatalog | null; error: Err | null; loading: boolean };

let state: CatalogState = { workspaceId: null, catalog: null, error: null, loading: false };
const listeners = new Set<() => void>();
let loader: ((workspaceId: string) => Promise<void>) | null = null;
/** When the catalog in hand was read; a reader mounting on an older one reads again. */
let loadedAt = 0;
/** Every read gets a number; an answer overtaken by a newer read is dropped. */
let readSeq = 0;
const STALE_MS = 30_000;
let refreshBound = false;

/** Read again when the person comes back to the window: a setting may have been added or changed meanwhile. */
function bindRefresh(): void {
  if (refreshBound || typeof window === 'undefined') return;
  refreshBound = true;
  const refresh = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (state.loading) return;
    reloadSettingsCatalog();
  };
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
}

function publish(next: CatalogState) {
  state = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Read `settings_list` again (after a write), for every reader at once. */
export function reloadSettingsCatalog(): void {
  if (loader !== null && state.workspaceId !== null) void loader(state.workspaceId);
}

/** For tests: forget the cached catalog. */
export function resetSettingsCatalogForTests(): void {
  state = { workspaceId: null, catalog: null, error: null, loading: false };
  loader = null;
  loadedAt = 0;
}

export function parseCatalog(body: unknown): SettingsCatalog | null {
  const b = body as Partial<SettingsCatalog> | null;
  if (b === null || typeof b !== 'object' || !Array.isArray(b.settings)) return null;
  return { settings: b.settings, unanswered: Array.isArray(b.unanswered) ? b.unanswered : [], areas: Array.isArray(b.areas) ? b.areas : [] };
}

/** The settings of a workspace, read once and shared; `reload` reads again. */
export function useSettingsCatalog(workspaceId: string | null): { catalog: SettingsCatalog | null; error: Err | null; loading: boolean; reload: () => void } {
  const client = useClient();
  const snapshot = useSyncExternalStore(subscribe, () => state);
  const load = useCallback(
    async (ws: string) => {
      const mine = (readSeq += 1);
      publish({ ...state, workspaceId: ws, loading: true, ...(state.workspaceId !== ws ? { catalog: null, error: null } : {}) });
      const { body } = await client.call('settings_list', { workspaceId: ws });
      if (state.workspaceId !== ws || mine !== readSeq) return;
      if (isErr(body)) {
        publish({ workspaceId: ws, catalog: state.catalog, error: body, loading: false });
        return;
      }
      loadedAt = Date.now();
      publish({ workspaceId: ws, catalog: parseCatalog(body), error: null, loading: false });
    },
    [client],
  );
  useEffect(() => {
    loader = load;
    bindRefresh();
    if (workspaceId === null) return;
    const stale = state.catalog !== null && Date.now() - loadedAt > STALE_MS;
    if (state.workspaceId !== workspaceId || ((state.catalog === null || stale) && !state.loading)) void load(workspaceId);
  }, [workspaceId, load]);
  const mine = snapshot.workspaceId === workspaceId;
  return {
    catalog: mine ? snapshot.catalog : null,
    error: mine ? snapshot.error : null,
    loading: !mine || snapshot.loading,
    reload: () => {
      if (workspaceId !== null) void load(workspaceId);
    },
  };
}

/** Kept for a reader that only wants the index (the palette). */
export function useSettingsIndex(workspaceId: string | null, locale: Locale): SettingsIndexEntry[] {
  const { catalog } = useSettingsCatalog(workspaceId);
  const [index, setIndex] = useState<SettingsIndexEntry[]>([]);
  useEffect(() => setIndex(catalog === null ? [] : buildSettingsIndex(catalog, locale)), [catalog, locale]);
  return index;
}
