/**
 * The hand-rolled confirm dialogs rise in the middle exactly like the shared `Modal` (D122 D-I, the
 * Reveal moment): `motion-reveal--center` on the panel, and its parts on the `data-motion-item`
 * stagger, capped at three steps. The animation itself is CSS (motion.css) and the reduced-motion
 * kill switch in tokens.css zeroes it, so this holds only the hooks the CSS keys on.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { I18nProvider } from '../i18n';
import { ConfirmDialog as AccountsConfirm } from '../surfaces/Accounts/ConfirmDialog';
import { ConfirmDialog as PaymentsConfirm } from '../surfaces/Payments/ConfirmDialog';
import { PostConfirmDialog } from '../surfaces/Payments/PostConfirmDialog';

const noop = () => undefined;

function steps(dialog: HTMLElement): (string | null)[] {
  return Array.from(dialog.querySelectorAll('[data-motion-item]'), (el) => el.getAttribute('data-motion-item'));
}

describe('the hand-rolled dialogs take the Modal reveal', () => {
  it('the Konten confirm: centre reveal, message then actions', () => {
    render(
      <I18nProvider>
        <AccountsConfirm message="Konto löschen?" confirmLabel="Löschen" onConfirm={noop} onCancel={noop} />
      </I18nProvider>,
    );
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveClass('motion-reveal--center');
    expect(steps(dialog)).toEqual(['1', '2']);
  });

  it('the Zahlungen confirm: centre reveal, message then actions', () => {
    render(
      <I18nProvider>
        <PaymentsConfirm message="Zahlung stornieren?" confirmLabel="Stornieren" onConfirm={noop} onCancel={noop} />
      </I18nProvider>,
    );
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveClass('motion-reveal--center');
    expect(steps(dialog)).toEqual(['1', '2']);
  });

  it('the posting confirm: centre reveal, message, detail and actions on the three steps', () => {
    render(
      <I18nProvider>
        <PostConfirmDialog amount="CHF 120.00" onConfirm={noop} onCancel={noop} />
      </I18nProvider>,
    );
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveClass('motion-reveal--center');
    expect(steps(dialog)).toEqual(['1', '2', '3']);
  });
});
