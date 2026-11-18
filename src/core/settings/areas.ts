/**
 * D202 (owner, 15.11.2026, pick A): THE TEN AREAS of the Einstellungen, and the one parser of the
 * `agent.settings_sections` setting (the areas the owner lets the agent change without asking).
 *
 * A LEAF MODULE ON PURPOSE (the `hausbuch/sections.ts` precedent): the registry imports the closed names
 * for the setting's default and bounds, the settings verbs judge a new value with `settingsSectionsProblem`
 * before anything is written, and the agent gate reads the stored value with `parseSettingsSections`. It
 * imports nothing, so no side reaches another through it.
 *
 * Each area carries what a person and an agent search it by: its name, its synonyms (a synonym matches every
 * row of the area, so "Bank" finds every bank key) and its pages (the settings screens that are their own
 * page, shown as "Seite" rows). The Studio draws the area with the existing rail glyph named in `icon`.
 */

/** The ten areas, in the order the Einstellungen home shows them (§H-ENUM, single point). */
export const SETTINGS_AREAS = ['firma', 'buchhaltung', 'bank', 'mwst', 'belege', 'verkauf', 'agent', 'darstellung', 'zugriff', 'daten'] as const;
export type SettingsArea = (typeof SETTINGS_AREAS)[number];

export interface AreaText {
  readonly en: string;
  readonly 'de-CH': string;
}

/** A settings screen that is its own page, listed as a row of its area. */
export interface SettingsPage {
  readonly id: string;
  readonly route: string;
  readonly label: AreaText;
  readonly keywords: { readonly en: readonly string[]; readonly 'de-CH': readonly string[] };
}

export interface SettingsAreaDef {
  readonly id: SettingsArea;
  readonly label: AreaText;
  /** A rail glyph name (`app/src/app/nav-icons.tsx`). */
  readonly icon: string;
  readonly keywords: { readonly en: readonly string[]; readonly 'de-CH': readonly string[] };
  readonly pages: readonly SettingsPage[];
}

function page(id: string, route: string, de: string, en: string, kwDe: string[] = [], kwEn: string[] = []): SettingsPage {
  return { id, route, label: { 'de-CH': de, en }, keywords: { 'de-CH': kwDe, en: kwEn } };
}

export const SETTINGS_AREA_DEFS: readonly SettingsAreaDef[] = [
  {
    id: 'firma',
    label: { 'de-CH': 'Firma', en: 'Company' },
    icon: 'setup',
    keywords: { 'de-CH': ['Firmenprofil', 'Adresse', 'UID', 'Geschäftsjahr', 'Arbeitsbereich', 'Firma'], en: ['company profile', 'address', 'fiscal year', 'workspace'] },
    pages: [
      page('setup', '/setup', 'Firmenprofil', 'Company profile', ['Adresse', 'UID', 'IBAN', 'Logo', 'Arbeitsbereiche'], ['address', 'logo', 'workspaces']),
      page('customization', '/customization', 'Anpassung', 'Customization', ['Felder', 'eigene Felder', 'Ansichten'], ['custom fields', 'views']),
    ],
  },
  {
    id: 'buchhaltung',
    label: { 'de-CH': 'Buchhaltung', en: 'Accounting' },
    icon: 'journal',
    keywords: { 'de-CH': ['Journal', 'Buchung', 'Belegnummer', 'Lohn', 'Anlagen', 'Checkliste', 'Fremdwährung'], en: ['journal', 'posting', 'voucher number', 'payroll', 'assets', 'checklist'] },
    pages: [],
  },
  {
    id: 'bank',
    label: { 'de-CH': 'Bank', en: 'Bank' },
    icon: 'reconciliation',
    keywords: {
      'de-CH': ['Bankkonto', 'Bankzeile', 'Zahlungen', 'Kontoauszug', 'camt', 'EBICS', 'CSV', 'Stripe', 'Twint', 'Zahlungsanbieter', 'Buchungsregel'],
      en: ['bank account', 'bank line', 'payments', 'statement', 'payment provider', 'booking rule'],
    },
    pages: [],
  },
  {
    id: 'mwst',
    label: { 'de-CH': 'MWST', en: 'VAT' },
    icon: 'vat',
    keywords: { 'de-CH': ['Mehrwertsteuer', 'Steuer', 'Vorsteuer', 'Saldosatz', 'MWST-Code'], en: ['VAT', 'tax', 'input tax', 'flat rate'] },
    pages: [page('vat', '/vat', 'MWST-Einstellungen', 'VAT settings', ['Abrechnungsmethode', 'Saldosatz', 'effektiv'], ['method', 'flat rate'])],
  },
  {
    id: 'belege',
    label: { 'de-CH': 'Belege', en: 'Receipts' },
    icon: 'files',
    keywords: { 'de-CH': ['Beleg', 'Quittung', 'Rechnung', 'Belegeingang', 'Ablage', 'Datei', 'Scan'], en: ['receipt', 'invoice', 'inbox', 'file', 'scan'] },
    pages: [],
  },
  {
    id: 'verkauf',
    label: { 'de-CH': 'Verkauf', en: 'Sales' },
    icon: 'documents',
    keywords: { 'de-CH': ['Rechnung', 'Mahnung', 'Mahnwesen', 'Serienrechnung', 'Vorlage', 'Versand', 'Mail', 'E-Mail'], en: ['invoice', 'dunning', 'recurring', 'template', 'dispatch', 'email'] },
    pages: [
      page('document-templates', '/document-templates', 'Vorlagen', 'Templates', ['Rechnungsvorlage', 'Layout'], ['invoice template', 'layout']),
      page('dispatch', '/dispatch', 'Versand', 'Dispatch', ['Mailtext', 'E-Mail'], ['mail text', 'email']),
      page('writing-style', '/writing-style', 'Schreibstil', 'Writing style', ['Ton', 'Anrede', 'Korrespondenz'], ['tone', 'correspondence']),
    ],
  },
  {
    id: 'agent',
    label: { 'de-CH': 'Agent und Automatik', en: 'Agent and automation' },
    icon: 'agent',
    keywords: {
      'de-CH': ['Agent', 'KI', 'Assistent', 'Claude', 'Vorschlag', 'Freigabe', 'Autopilot', 'Automatik', 'Regel', 'MCP'],
      en: ['agent', 'AI', 'assistant', 'proposal', 'approval', 'autopilot', 'automation', 'rule'],
    },
    pages: [
      page('agent', '/agent', 'Was der Agent darf', 'What the agent may do', ['Berechtigungen', 'Regler', 'Dial'], ['permissions', 'dial']),
      page('hausbuch', '/hausbuch', 'Hausbuch', 'House book', ['Notizen', 'Hausregeln'], ['notes', 'house rules']),
      page('automations', '/automations', 'Automatisierungen', 'Automations', ['Regeln', 'Auslöser'], ['rules', 'triggers']),
      page('extensions', '/extensions', 'Erweiterungen', 'Extensions', ['Plugin', 'Erweiterung'], ['plugin']),
    ],
  },
  {
    id: 'darstellung',
    label: { 'de-CH': 'Darstellung', en: 'Display' },
    icon: 'personal',
    keywords: { 'de-CH': ['Ansicht', 'Neuigkeiten', 'Update', 'Design', 'Thema', 'dunkel', 'Dichte'], en: ['view', "what's new", 'update', 'theme', 'dark', 'density'] },
    pages: [page('my-settings', '/my-settings', 'Meine Einstellungen', 'My settings', ['persönlich', 'Thema', 'Dichte', 'Sprache'], ['personal', 'theme', 'density'])],
  },
  {
    id: 'zugriff',
    label: { 'de-CH': 'Zugriff', en: 'Access' },
    icon: 'members',
    keywords: { 'de-CH': ['Mitglieder', 'Rollen', 'Rechte', 'Benutzer', 'Treuhänder'], en: ['members', 'roles', 'rights', 'users'] },
    pages: [page('members', '/members', 'Mitglieder und Rollen', 'Members and roles', ['einladen', 'Rolle'], ['invite', 'role'])],
  },
  {
    id: 'daten',
    label: { 'de-CH': 'Daten', en: 'Data' },
    icon: 'migration',
    keywords: { 'de-CH': ['Sicherung', 'Backup', 'Sync', 'Datenübernahme', 'Import', 'Umgebung', 'Diagnose', 'Idempotenz'], en: ['backup', 'sync', 'migration', 'import', 'environment', 'diagnostics'] },
    pages: [
      page('operations', '/operations', 'Betrieb', 'Operations', ['Sicherung', 'Backup', 'Sync', 'Diagnose'], ['backup', 'sync', 'diagnostics']),
      page('migration', '/migration', 'Datenübernahme', 'Migration', ['bexio', 'Import'], ['import']),
      page('environments', '/environments', 'Umgebungen', 'Environments', ['Test', 'Entwicklung'], ['test', 'develop']),
    ],
  },
];

export function isSettingsArea(value: unknown): value is SettingsArea {
  return typeof value === 'string' && (SETTINGS_AREAS as readonly string[]).includes(value);
}

// --- `agent.settings_sections` -----------------------------------------------------------------------

/** The longest stored value: every area once, with commas and room for spaces. */
export const SETTINGS_SECTIONS_MAX_LENGTH = 160;

function tokensOf(value: string): string[] {
  return value
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Why a value cannot be `agent.settings_sections`, or null when it can. EMPTY IS ALLOWED (it is the default:
 * no area). Every name must be an area, none twice. The settings verbs answer a problem as
 * `invalid_setting_value`.
 */
export function settingsSectionsProblem(value: unknown): { reason: 'not_a_list' | 'unknown_area' | 'repeated_area'; area?: string } | null {
  if (typeof value !== 'string') return { reason: 'not_a_list' };
  const seen = new Set<string>();
  for (const t of tokensOf(value)) {
    if (!isSettingsArea(t)) return { reason: 'unknown_area', area: t };
    if (seen.has(t)) return { reason: 'repeated_area', area: t };
    seen.add(t);
  }
  return null;
}

/**
 * The areas a stored value names. A value that does not parse (a row written by hand, a name a later build
 * retired) reads as NO area: the permission fails closed, never open.
 */
export function parseSettingsSections(value: unknown): SettingsArea[] {
  if (settingsSectionsProblem(value) !== null) return [];
  const named = new Set(tokensOf(value as string));
  return SETTINGS_AREAS.filter((a) => named.has(a));
}
