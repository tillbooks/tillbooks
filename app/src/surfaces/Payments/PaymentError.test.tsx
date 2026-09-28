/**
 * Critic R5-1 on the money path: a payment the engine SAVED WHOLE before a newer TILL moved the book on
 * (`schema_newer_than_runtime`, `partial`, `completed`) must never read "Die Zahlung konnte nicht
 * gebucht werden." beside a button that posts it again. The drawer's `PostConfirm` path passes
 * `onRetry={() => void post()}`, and after the update a hand re-entry would record a second payment.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { I18nProvider } from '../../i18n';
import type { Err } from '../../lib/client';
import { PaymentError } from './PaymentError';

const NEWER = { ok: false as const, error: 'schema_newer_than_runtime', action: 'record_payment', bookGeneration: 8, buildGeneration: 7, path: '/x/book.db' };

function renderError(error: Err, onRetry?: () => void) {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <PaymentError error={error} currency="CHF" {...(onRetry !== undefined ? { onRetry } : {})} />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe('PaymentError, a book a newer TILL moved on (critic R5-1)', () => {
  it('a payment saved whole says it is saved, never "could not be posted", and offers no repeat', () => {
    cleanup();
    renderError({ ...NEWER, partial: true, completed: true }, vi.fn());
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Diese Aktion ist gespeichert.');
    expect(alert).toHaveTextContent('Wiederhole die Aktion nicht, sonst entsteht sie doppelt.');
    expect(alert).not.toHaveTextContent('Die Zahlung konnte nicht gebucht werden.');
    expect(screen.queryByRole('button', { name: 'Erneut versuchen' })).toBeNull();
  });

  it('a payment saved in part says so and keeps the retry; one refused before writing says nothing changed', () => {
    cleanup();
    const onRetry = vi.fn();
    const { unmount } = renderError({ ...NEWER, partial: true, completed: false }, onRetry);
    expect(screen.getByRole('alert')).toHaveTextContent('Bis dahin hatte dieses TILL einen Teil der Aktion gespeichert, den Rest nicht.');
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeInTheDocument();
    unmount();
    renderError({ ...NEWER, partial: false, completed: false }, onRetry);
    expect(screen.getByRole('alert')).toHaveTextContent('Die Datei wurde nicht verändert.');
  });

  it('keeps its own sentence and parameters for its own codes', () => {
    cleanup();
    renderError({ ok: false, error: 'period_locked', period: '2026-07' });
    expect(screen.getByRole('alert')).toHaveTextContent('2026-07');
  });

  it('A39 (critic M3): an owned_by refusal names the bank line and links to it, never "could not be posted"', () => {
    cleanup();
    renderError({ ok: false, error: 'owned_by', verb: 'reopen_bank_line', bankTxnId: 'btxn_7', entryId: 'entry_3' });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Diese Zahlung gehört zu einer Bankzeile.');
    // Re-critic L1: a matched or run payment is NOT reversed by taking the line back; the sentence says so.
    expect(alert).toHaveTextContent('eine dort nur abgeglichene stornierst du danach hier');
    expect(alert).not.toHaveTextContent('Die Zahlung konnte nicht gebucht werden.');
    expect(screen.getByRole('link', { name: 'Bankzeile zeigen' })).toHaveAttribute('href', '/bank?tab=booked&line=btxn_7');
  });
});
