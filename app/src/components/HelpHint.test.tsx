import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { I18nProvider } from '../i18n';
import { HelpHint } from './HelpHint';

function renderWithI18n(ui: React.ReactNode) {
  return render(<I18nProvider>{ui}</I18nProvider>);
}

describe('HelpHint', () => {
  it('discloses a titled popover with a learn-more link on click', async () => {
    renderWithI18n(
      <HelpHint
        label="Hilfe zu MWST"
        title="MWST-Modus"
        body="Kurz erklärt."
        learnMore={{ href: 'https://till.example/mwst', label: 'Mehr erfahren' }}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Hilfe zu MWST' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const dialog = screen.getByRole('dialog', { name: 'MWST-Modus' });
    expect(dialog).toHaveTextContent('Kurz erklärt.');
    expect(within(dialog).getByRole('link', { name: /Mehr erfahren/ })).toHaveAttribute(
      'href',
      'https://till.example/mwst',
    );
  });

  it('dismisses on Escape and returns focus to the trigger', async () => {
    renderWithI18n(<HelpHint label="Hilfe" title="Titel" body="Text." />);
    const trigger = screen.getByRole('button', { name: 'Hilfe' });
    await userEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('labels the outward link as leaving the device (help.leavesDevice replaced help.opensNewTab)', async () => {
    renderWithI18n(
      <HelpHint
        label="Hilfe"
        title="Titel"
        body="Text."
        learnMore={{ href: 'https://docs.tillbooks.ch/swiss/mwst', label: 'Dokumentation öffnen' }}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Hilfe' }));
    const link = screen.getByRole('link');
    expect(link).toHaveTextContent('öffnet eine Seite im Internet, dafür brauchst du eine Verbindung');
  });

  it('renders structured citations below the body, never inline', async () => {
    renderWithI18n(
      <HelpHint label="Hilfe" title="Titel" body="Text." articles={['MWSTG Art. 37', 'MWST-Info 12']} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Hilfe' }));
    const list = screen.getByRole('list', { name: 'Rechtsgrundlagen' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('replaces content in place on a seeAlso choice: one dialog, no stack, Esc back to the ORIGINAL trigger', async () => {
    function Host() {
      const [shown, setShown] = React.useState<'a' | 'b'>('a');
      const content =
        shown === 'a'
          ? { title: 'Begriff A', body: 'Körper A.', seeAlso: [{ key: 'b', term: 'Begriff B' }] }
          : { title: 'Begriff B', body: 'Körper B.', seeAlso: [{ key: 'a', term: 'Begriff A' }] };
      return (
        <HelpHint
          label="Begriff A"
          trigger={{ kind: 'term', text: 'Begriff A' }}
          {...content}
          onSeeAlso={() => setShown(shown === 'a' ? 'b' : 'a')}
        />
      );
    }
    renderWithI18n(<Host />);
    const trigger = screen.getByRole('button', { name: 'Begriff A' });
    await userEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Begriff A' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Begriff B' }));
    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toHaveAccessibleName('Begriff B');

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('centred placement renders without a trigger and moves focus into the panel', () => {
    renderWithI18n(
      <HelpHint label="Begriff" title="Zentriert" body="Text." placement="center" open onClose={() => {}} />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Zentriert' });
    expect(dialog).toHaveFocus();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
