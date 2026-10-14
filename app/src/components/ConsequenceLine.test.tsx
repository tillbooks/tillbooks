/**
 * C4 (D118): the ConsequenceLine renders the SAME sentence the Vorschlag card shows (D156: the engine's
 * one consequence catalogue, projected into command-source.generated.json), and renders nothing for a
 * verb that carries no engine consequence.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { I18nProvider } from '../i18n';
import { ConsequenceLine } from './ConsequenceLine';
import { consequenceSentence } from '../lib/approval-tiers';

const de = (verb: string): string => consequenceSentence(verb, 'de-CH') as string;

function renderLine(verb: string) {
  return render(
    <I18nProvider>
      <ConsequenceLine verb={verb} />
    </I18nProvider>,
  );
}

describe('ConsequenceLine', () => {
  it('renders the de-CH consequence sentence for a money-path verb', () => {
    renderLine('post_entry');
    // The engine's post-family sentence (post_entry has no entry of its own), as the owner wrote it (D156).
    expect(screen.getByText('Bucht das in deine Buchhaltung. Ist es falsch, korrigierst du es mit einer Korrekturbuchung; das Original bleibt sichtbar.')).toBeTruthy();
  });

  it('renders the statutory-filing sentence for vat_mark_filed', () => {
    renderLine('vat_mark_filed');
    expect(screen.getByText(de('vat_mark_filed'))).toBeTruthy();
    expect(de('vat_mark_filed')).toMatch(/^Hält fest, dass du diese MWST-Periode bei der ESTV eingereicht hast/);
  });

  it('renders the verb\'s own sentence when it has one (lock_period)', () => {
    renderLine('lock_period');
    // lock_period carries its own entry: a plain hard lock CAN be lifted with the unlock right.
    expect(screen.getByText(de('lock_period'))).toBeTruthy();
    expect(de('lock_period')).toContain('eine harte nur von jemandem mit dem Recht dazu');
  });

  it('renders the go-live sentence for the migration cutover verb (go_productive)', () => {
    renderLine('go_productive');
    expect(screen.getByText(de('go_productive'))).toBeTruthy();
  });

  it('renders nothing for a verb that carries no engine consequence', () => {
    const { container } = renderLine('list_journal');
    expect(container.querySelector('.consequence-line')).toBeNull();
  });
});

describe('ConsequenceLine, the tooltip variant (A1 composer)', () => {
  it('puts the same sentence behind a named (i) button, as a real tooltip, and a hidden copy for a describedby', () => {
    render(
      <I18nProvider>
        <ConsequenceLine verb="post_entry" variant="tooltip" triggerLabel="Was Buchen bewirkt" describedById="why" />
      </I18nProvider>,
    );
    const trigger = screen.getByRole('button', { name: 'Was Buchen bewirkt' });
    const tip = document.getElementById(trigger.getAttribute('aria-describedby') ?? '');
    expect(tip?.getAttribute('role')).toBe('tooltip');
    expect(tip?.textContent).toBe('Bucht das in deine Buchhaltung. Ist es falsch, korrigierst du es mit einer Korrekturbuchung; das Original bleibt sichtbar.');
    expect(document.getElementById('why')?.textContent).toBe(tip?.textContent);
    expect(trigger.hasAttribute('title')).toBe(false);
  });

  it('still renders nothing for an ungoverned verb, and the default stays the quiet line', () => {
    const { container } = render(
      <I18nProvider>
        <ConsequenceLine verb="list_journal" variant="tooltip" triggerLabel="x" />
        <ConsequenceLine verb="post_entry" />
      </I18nProvider>,
    );
    expect(container.querySelector('.consequence-tip')).toBeNull();
    expect(container.querySelector('p.consequence-line')).not.toBeNull();
  });
});
