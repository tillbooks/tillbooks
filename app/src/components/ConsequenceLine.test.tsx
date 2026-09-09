/**
 * C4 (D118): the ConsequenceLine renders the SAME catalogue sentence the Vorschlag card shows, and
 * renders nothing for a verb the dial does not govern.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { I18nProvider } from '../i18n';
import { ConsequenceLine } from './ConsequenceLine';

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
    // The exact `agent.consequence.post` de-CH string the Vorschlag card also shows.
    expect(screen.getByText('Bucht unwiderruflich ins Journal. Die einzige Korrektur ist eine Stornobuchung.')).toBeTruthy();
  });

  it('renders the statutory-filing sentence for vat_mark_filed', () => {
    renderLine('vat_mark_filed');
    expect(
      screen.getByText('Meldet die MWST-Periode als eingereicht. Eine eingereichte Periode ist abgeschlossen.'),
    ).toBeTruthy();
  });

  it('renders the shared sentence for a newly-mapped verb via its capability (lock_period -> close-period)', () => {
    renderLine('lock_period');
    // lock_period maps to the new close-period capability, so it shows `agent.consequence.close-period`.
    expect(
      screen.getByText('Versiegelt eine Rechnungsperiode gegen weitere Buchungen. Ein harter Abschluss lässt sich nicht wieder öffnen.'),
    ).toBeTruthy();
  });

  it('renders the go-live sentence for the migration cutover verb (go_productive)', () => {
    renderLine('go_productive');
    expect(
      screen.getByText('Überträgt die Migrationsdaten in die echten Bücher. Der Umstieg lässt sich nicht rückgängig machen.'),
    ).toBeTruthy();
  });

  it('renders nothing for a verb the dial does not govern', () => {
    const { container } = renderLine('list_journal');
    expect(container.querySelector('.consequence-line')).toBeNull();
  });
});
