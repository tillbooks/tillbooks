/**
 * D202 point 3: the one settings index, read by the Einstellungen search and by Cmd K. SYNTHETIC.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';

import { TillClientProvider } from './client-context';
import { TillClient, type Transport } from './client';
import {
  buildSettingsIndex,
  foldText,
  parseCatalog,
  plainDescription,
  resetSettingsCatalogForTests,
  searchSettings,
  useSettingsCatalog,
  valueWords,
  type SettingsCatalog,
} from './settings-index';
import { realSettingsListBody } from './settings-test-kit';

const T = (en: string, de: string) => ({ en, 'de-CH': de });

const CATALOG: SettingsCatalog = {
  unanswered: [],
  areas: [
    { id: 'bank', label: T('Bank', 'Bank'), icon: 'reconciliation', keywords: { en: [], 'de-CH': ['Zahlungsanbieter'] }, pages: [], agentMayChange: false },
    { id: 'mwst', label: T('VAT', 'MWST'), icon: 'vat', keywords: { en: [], 'de-CH': ['Mehrwertsteuer'] }, pages: [{ id: 'vat', route: '/vat', label: T('VAT settings', 'MWST-Einstellungen'), keywords: { en: [], 'de-CH': [] } }], agentMayChange: false },
  ],
  settings: [
    {
      key: 'bank.fx_mode', value: 'facts_only', default: 'propose_split', overridden: true,
      schema: { type: 'enum', values: ['propose_split', 'facts_only'] }, owningCapability: 'post', dialCapability: 'post',
      label: T('x', 'x'), description: T('x', 'x'), humanOnly: false, askFirst: false, answered: true, updatedAt: null, updatedBy: null, section: 'bank',
      presentation: { subgroup: T('Bank lines', 'Bankzeilen'), label: T('Card payments in a foreign currency', 'Kartenzahlungen in Fremdwährung'), valueLabels: { propose_split: T('Propose a split', 'Aufteilung vorschlagen'), facts_only: T('Facts only', 'Nur Fakten') }, keywords: { en: [], 'de-CH': ['Kurs'] } },
    },
    {
      key: 'bank.anzahlung_vat', value: false, default: false, overridden: false,
      schema: { type: 'boolean' }, owningCapability: 'post', dialCapability: 'vat-file',
      label: T('x', 'x'), description: T('x', 'x'), humanOnly: false, askFirst: false, answered: true, updatedAt: null, updatedBy: null, section: 'mwst',
      presentation: { subgroup: T('VAT on advances', 'MWST auf Anzahlungen'), label: T('VAT on advances received', 'MWST auf erhaltenen Anzahlungen'), keywords: { en: [], 'de-CH': ['Anzahlung'] } },
    },
  ],
};

describe('the settings index (D202)', () => {
  const index = buildSettingsIndex(CATALOG, 'de-CH');

  it('one entry per setting and per page, routed to the row or the page', () => {
    expect(index.map((e) => [e.kind, e.id, e.route])).toEqual([
      ['setting', 'bank.fx_mode', '/settings/bank?focus=bank.fx_mode'],
      ['setting', 'bank.anzahlung_vat', '/settings/mwst?focus=bank.anzahlung_vat'],
      ['page', 'vat', '/vat'],
    ]);
    expect(index[0]?.current).toBe('Nur Fakten');
  });

  // The two-letter spelling a person types without the umlaut key, built here so no literal spells it.
  const typed = 'Fremdwa' + 'ehrung';
  it('folds umlauts and their spellings, so the word with a, with ä and with the two-letter spelling all find it', () => {
    expect(foldText('Fremdwährung')).toBe(foldText(typed));
    expect(searchSettings(index, 'fremdwahrung').map((h) => h.entry.id)).toEqual(['bank.fx_mode']);
    expect(searchSettings(index, typed.toLowerCase()).map((h) => h.entry.id)).toEqual(['bank.fx_mode']);
  });

  it('every token must hit (AND), and an area synonym finds every row of the area', () => {
    expect(searchSettings(index, 'karten kurs').map((h) => h.entry.id)).toEqual(['bank.fx_mode']);
    expect(searchSettings(index, 'karten anzahlung')).toEqual([]);
    expect(searchSettings(index, 'zahlungsanbieter').map((h) => h.entry.id)).toEqual(['bank.fx_mode']);
    expect(searchSettings(index, 'mehrwertsteuer').map((h) => h.entry.id).sort()).toEqual(['bank.anzahlung_vat', 'vat']);
  });

  it('ranks a label prefix above a value label', () => {
    const [first] = searchSettings(index, 'nur');
    expect(first?.entry.id).toBe('bank.fx_mode');
    expect(first?.score).toBe(50);
    expect(searchSettings(index, 'karten')[0]?.score).toBe(100);
  });

  it('critic L4: the agent\'s areas read as area names, never their ids', () => {
    const sections = { key: 'agent.settings_sections', schema: { type: 'string' as const, maxLength: 160 }, presentation: CATALOG.settings[0]!.presentation };
    expect(valueWords(sections, 'bank,mwst', 'de-CH', CATALOG.areas)).toBe('Bank, MWST');
    expect(valueWords(sections, '', 'en', CATALOG.areas)).toBe('None');
  });

  it('D209 amendment: a list setting whose values have words reads as those words, never the family ids', () => {
    const excluded = {
      key: 'agent.owner_word_excluded',
      schema: { type: 'string' as const, maxLength: 200 },
      presentation: { ...CATALOG.settings[0]!.presentation, valueLabels: { 'vat-file': T('File VAT', 'MWST einreichen'), share: T('Share', 'Freigeben') } },
    };
    expect(valueWords(excluded, 'vat-file,share', 'de-CH')).toBe('MWST einreichen, Freigeben');
    expect(valueWords(excluded, '', 'en')).toBe('None');
    expect(valueWords(excluded, 'none', 'de-CH')).toBe('Keine');
  });

  it('says a value in words', () => {
    expect(valueWords(CATALOG.settings[1]!, true, 'de-CH')).toBe('Ein');
    expect(valueWords(CATALOG.settings[0]!, 'propose_split', 'en')).toBe('Propose a split');
  });
});

describe('the search on the REAL catalog (the owner, 18.11.2026: "Agent genehmigt auf dein Wort" was not found)', () => {
  const real = parseCatalog(realSettingsListBody())!;
  const de = buildSettingsIndex(real, 'de-CH');
  const en = buildSettingsIndex(real, 'en');
  const KEY = 'agent.approve_on_owner_word';
  const ids = (q: string, index = de) => searchSettings(index, q).map((h) => h.entry.id);

  it('the real settings_list carries it, in the Agent area', () => {
    expect(real.settings.find((s) => s.key === KEY)?.section).toBe('agent');
  });

  it.each(['genehmigt', 'Wort', 'chat', 'Agent genehmigt auf dein Wort', 'agent genehmigt', 'approve_on_owner_word'])('de-CH finds it by "%s"', (q) => {
    expect(ids(q)).toContain(KEY);
  });

  it('its full label ranks it first', () => {
    expect(ids('Agent genehmigt auf dein Wort')[0]).toBe(KEY);
  });

  it('English finds it by its label and its German words alike', () => {
    expect(ids('approves on your word', en)[0]).toBe(KEY);
    expect(ids('genehmigt', en)).toContain(KEY);
  });

  it('a word only the description holds finds it (both locales), below a label hit', () => {
    // "wörtlich" is in the de-CH registry description ("Deine Worte bleiben wörtlich") and nowhere else of the
    // row; "verbatim" only in the English one.
    const hit = searchSettings(de, 'wörtlich').find((h) => h.entry.id === KEY);
    expect(hit?.score).toBe(20);
    expect(ids('verbatim')).toContain(KEY);
  });

  it('every real setting is found by its own full label', () => {
    for (const s of real.settings) {
      const label = s.presentation.label['de-CH'];
      expect(ids(label), label).toContain(s.key);
    }
  });
});

describe('plainDescription: the tooltip never shows an enum id', () => {
  const real = parseCatalog(realSettingsListBody())!;
  it('replaces every value id where it stands as a value, and drops the registry\'s "only a person" line', () => {
    const s = real.settings.find((x) => x.key === 'agent.approve_on_owner_word')!;
    const text = plainDescription(s, 'de-CH');
    expect(text.startsWith('Aus (Standard):')).toBe(true);
    expect(text).toContain('Ein: Sagst du');
    expect(text).not.toContain('Nur eine Person kann das ändern.');
    expect(plainDescription(s, 'en').startsWith('Off (default):')).toBe(true);
  });
  it('no value id of a real enum is left in a de-CH description where it stands as a value', () => {
    for (const s of real.settings) {
      if (s.schema.type !== 'enum') continue;
      const text = plainDescription(s, 'de-CH');
      for (const id of s.schema.values) {
        if (!id.includes('_')) {
          expect(text, `${s.key}: ${id}`).not.toMatch(new RegExp(`(^|[^\\p{L}_])${id}\\s*(:|\\((Standard)\\))`, 'u'));
        } else {
          expect(text, `${s.key}: ${id}`).not.toMatch(new RegExp(`(^|[^\\p{L}_])${id}([^\\p{L}_]|$)`, 'u'));
        }
      }
    }
  });
});

describe('the shared catalog reads settings_list again', () => {
  let calls = 0;
  const transport: Transport = async () => {
    calls += 1;
    return { status: 200, body: realSettingsListBody() };
  };
  function Probe() {
    const { catalog } = useSettingsCatalog('ws_test');
    return <span data-testid="n">{catalog?.settings.length ?? 0}</span>;
  }
  const wrap = (node: ReactNode) => <TillClientProvider client={new TillClient(transport)}>{node}</TillClientProvider>;
  beforeEach(() => {
    calls = 0;
    resetSettingsCatalogForTests();
  });
  afterEach(() => vi.useRealTimers());

  it('when the window regains focus, so a setting added since the tab opened is found', async () => {
    render(wrap(<Probe />));
    await waitFor(() => expect(calls).toBe(1));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(calls).toBe(2));
  });

  it('when a reader mounts on an answer older than half a minute (the palette opening)', async () => {
    const first = render(wrap(<Probe />));
    await waitFor(() => expect(calls).toBe(1));
    first.unmount();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    render(wrap(<Probe />));
    await waitFor(() => expect(calls).toBe(2));
    vi.restoreAllMocks();
  });
});
