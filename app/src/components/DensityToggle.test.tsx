import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { I18nProvider } from '../i18n';
import { DensityProvider } from '../app/density';
import { DensityToggle } from './DensityToggle';

function renderToggle(initial: 'komfortabel' | 'kompakt' = 'komfortabel') {
  return render(
    <I18nProvider>
      <DensityProvider initialDensity={initial}>
        <DensityToggle />
      </DensityProvider>
    </I18nProvider>,
  );
}

describe('DensityToggle', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-density');
  });

  it('carries an accessible name and is not pressed in Komfortabel', () => {
    renderToggle('komfortabel');
    // In Komfortabel the control offers to switch TO the compact view.
    const button = screen.getByRole('button', { name: 'Kompakte Ansicht' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
  });

  it('names the return trip and is pressed in Kompakt', () => {
    renderToggle('kompakt');
    const button = screen.getByRole('button', { name: 'Komfortable Ansicht' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });

  it('flips the density, its label and aria-pressed on click', async () => {
    renderToggle('komfortabel');
    await userEvent.click(screen.getByRole('button', { name: 'Kompakte Ansicht' }));

    const button = screen.getByRole('button', { name: 'Komfortable Ansicht' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement.getAttribute('data-density')).toBe('kompakt');
  });
});
