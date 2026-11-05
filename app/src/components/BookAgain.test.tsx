/**
 * N02 R1, the shared confirm of a second booking of a receipt: the card's warning, the alertdialog
 * (reason required, stays open with the reason on a refused retry, axe clean), and which refusals are a
 * question at all (`override` hint under `confirm`; never under `refuse`).
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { useEffect } from 'react';

import { I18nProvider } from '../i18n';
import type { Err } from '../lib/client';
import { isBookAgainRefusal, parseReceiptHolders } from '../lib/receiptHolders';
import { ReceiptHolderNotice, useBookAgain, type BookAgainRetry } from './BookAgain';

const HOLDERS = [
  { entityKind: 'journal_entry', entityId: 'je_1', reservedBy: null },
  { entityKind: 'drafted_action', entityId: 'act_2', reservedBy: 'act_2' },
];
const CONFIRMABLE: Err = { ok: false, error: 'receipt_already_booked', holders: HOLDERS, override: 'bookAgain with overrideReason' };

function Harness({ refusal, retry }: { refusal: Err; retry: BookAgainRetry }) {
  const { ask, dialog } = useBookAgain();
  useEffect(() => {
    ask(refusal, retry);
  }, [ask, refusal, retry]);
  return <>{dialog}</>;
}

describe('BookAgain (N02 R1)', () => {
  it('only a refusal with the override hint is a question', () => {
    expect(isBookAgainRefusal(CONFIRMABLE)).toBe(true);
    expect(isBookAgainRefusal({ ok: false, error: 'receipt_already_booked', holders: HOLDERS, setting: 'files.duplicate_beleg' })).toBe(false);
    expect(isBookAgainRefusal({ ok: false, error: 'holders_changed' })).toBe(false);
    expect(parseReceiptHolders([{ entityKind: 'payment', entityId: 7 }, 'noise', { entityId: 'x' }])).toEqual([{ entityKind: 'payment', entityId: null, reservedBy: null }]);
  });

  it('the card warning names where the receipt is booked, each kind once', () => {
    render(
      <I18nProvider>
        <ReceiptHolderNotice holders={[...HOLDERS, { entityKind: 'journal_entry', entityId: 'je_3', reservedBy: null }]} />
      </I18nProvider>,
    );
    expect(screen.getByText('Dieser Beleg ist bereits gebucht (Buchung, anderer Vorschlag, wartet).')).toBeInTheDocument();
  });

  it('asks for the reason, keeps it on a refused retry, and closes once the retry landed', async () => {
    const sent: unknown[] = [];
    let answer: Err | null = { ok: false, error: 'store_busy', retryable: true };
    const retry: BookAgainRetry = async (confirmation) => {
      sent.push(confirmation);
      return answer;
    };
    const { container } = render(
      <I18nProvider>
        <Harness refusal={CONFIRMABLE} retry={retry} />
      </I18nProvider>,
    );
    const dialog = await screen.findByRole('alertdialog', { name: 'Beleg schon gebucht' });
    expect(within(dialog).getByText('je_1')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Trotzdem buchen' }));
    expect(within(dialog).getByText('Gib einen Grund an.')).toBeInTheDocument();
    expect(sent).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText('Grund'), { target: { value: '  Zwei Positionen  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Trotzdem buchen' }));
    await waitFor(() => expect(sent).toEqual([{ bookAgain: true, overrideReason: 'Zwei Positionen' }]));
    // Refused: the dialog stays with the reason intact.
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect((within(dialog).getByLabelText('Grund') as HTMLTextAreaElement).value).toBe('  Zwei Positionen  ');
    answer = null;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Trotzdem buchen' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });
});
