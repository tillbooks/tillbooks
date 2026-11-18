/**
 * D209 amendment: a list setting whose values have words (`agent.owner_word_excluded`, the dial families the
 * owner's word never approves) is the shared multi-select of its named values (the redesign's control for
 * `agent.settings_sections`), never a raw text field. SYNTHETIC.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { I18nProvider } from '../../i18n';
import type { SettingEntryView } from '../../lib/settings-index';
import { SettingControl, shapeOf } from './SettingControl';

const T = (en: string, de: string) => ({ en, 'de-CH': de });

const EXCLUDED = {
  key: 'agent.owner_word_excluded',
  schema: { type: 'string', maxLength: 200 },
  presentation: {
    area: 'agent',
    subgroup: T('Allowed', 'Darf'),
    label: T('Always your click, even on your word', 'Immer dein Klick, auch auf dein Wort'),
    valueLabels: { 'vat-file': T('File VAT', 'MWST einreichen'), share: T('Share', 'Freigeben'), 'plugin-install': T('Plugins', 'Plugins') },
    keywords: { en: [], 'de-CH': [] },
  },
} as unknown as SettingEntryView;

describe('SettingControl, a list of named values', () => {
  it('is the set shape; a text without value words stays a text field', () => {
    expect(shapeOf(EXCLUDED, 'de-CH')).toBe('set');
    expect(shapeOf({ ...EXCLUDED, presentation: { ...EXCLUDED.presentation, valueLabels: undefined } } as SettingEntryView, 'de-CH')).toBe('text');
  });

  it('shows the chosen names on the trigger, ticks each value, and unticking writes the list without it', async () => {
    const onChange = vi.fn();
    render(
      <I18nProvider>
        <SettingControl setting={EXCLUDED} value="vat-file,plugin-install,share" areas={[]} labelId="l" disabled={false} locale="de-CH" onChange={onChange} />
      </I18nProvider>,
    );
    const pick = screen.getByRole('combobox', { name: 'Immer dein Klick, auch auf dein Wort' });
    expect(pick).toHaveTextContent('MWST einreichen, Freigeben, Plugins');
    await userEvent.click(pick);
    await userEvent.click(screen.getByRole('option', { name: 'Freigeben' }));
    expect(onChange).toHaveBeenCalledWith('vat-file,plugin-install');
  });

  it('nothing chosen is stored as none, never an empty value the settings verbs refuse, and reads Keine', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <I18nProvider>
        <SettingControl setting={EXCLUDED} value="share" areas={[]} labelId="l" disabled={false} locale="de-CH" onChange={onChange} />
      </I18nProvider>,
    );
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(screen.getByRole('option', { name: 'Freigeben' }));
    expect(onChange).toHaveBeenCalledWith('none');
    rerender(
      <I18nProvider>
        <SettingControl setting={EXCLUDED} value="none" areas={[]} labelId="l" disabled={false} locale="de-CH" onChange={onChange} />
      </I18nProvider>,
    );
    expect(screen.getByRole('combobox')).toHaveTextContent('Keine');
  });
});
