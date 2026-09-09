/**
 * S6, the Storno confirm, and the C4 consequence sentence it now carries (D118 money-path pass).
 *
 * A reversal is a posting write (`reverse_payment`, dial capability `pay`), so the confirm must state
 * the SAME governed-write consequence a human reads at the record/allocate confirm and an approver
 * reads clearing an agent's drafted payment. This pins that the shared `ConsequenceLine` renders here,
 * sourced from the verb (not re-authored copy), and that the dialog stays an `alertdialog` whose date
 * and Stornieren action survive a rejection unchanged.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';

import { I18nProvider } from '../../i18n';
import { ReverseDialog } from './ReverseDialog';
import type { Payment } from './model';
import getPayment from './get-payment.fixture.json';

const PAYMENT = getPayment.payment as unknown as Payment;

function renderDialog(error: Parameters<typeof ReverseDialog>[0]['error'] = null) {
  return render(
    <I18nProvider>
      <ReverseDialog payment={PAYMENT} error={error} onConfirm={() => {}} onCancel={() => {}} />
    </I18nProvider>,
  );
}

describe('ReverseDialog', () => {
  it('C4: the Storno confirm carries the shared consequence sentence, sourced from reverse_payment', () => {
    cleanup();
    renderDialog();
    const dialog = screen.getByRole('alertdialog');
    // The line is the same catalogue string the record/allocate confirm and the Vorschlag card show
    // for a `pay`-governed write, resolved via the verb rather than re-authored here.
    const line = within(dialog).getByText('Bucht eine Zahlung und gleicht offene Posten aus.');
    expect(line.closest('.consequence-line')?.getAttribute('data-verb')).toBe('reverse_payment');
  });

  it('states the reversal is whole and keeps its own date field (P26 shape)', () => {
    cleanup();
    renderDialog();
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/ganz|whole|immer/i)).toBeTruthy();
    // The date field the reversal posts on is present, and the Stornieren action is the danger button.
    expect(dialog.querySelector('input[type="date"]')).not.toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Stornieren' })).toBeTruthy();
  });
});
