/**
 * N02 R1, the shared confirm of a second booking of a receipt: the card's warning, the alertdialog
 * (reason required, stays open with the reason on a refused retry, axe clean), and which refusals are a
 * question at all (`override` hint under `confirm`; never under `refuse`).
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { useEffect, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';

import { I18nProvider } from '../i18n';
import { TillClient, type Err, type RestResponse, type Transport } from '../lib/client';
import { TillClientProvider } from '../lib/client-context';
import { WorkspaceProvider } from '../app/workspace';
import { hasHeldMarker, isBookAgainRefusal, isReceiptAssignedRefusal, parseAssignmentHolders, parseReceiptHolders } from '../lib/receiptHolders';
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

describe('A41.3 re-cut v3: a receipt assigned to a bank line (receipt_assigned)', () => {
  const ASSIGNED: Err = { ok: false, error: 'receipt_assigned', holders: [{ bankTxnId: 'bt_7', assignmentId: 'ba_7', source: 'person' }] };

  function withEngine(ui: ReactNode, calls: { action: string; input: Record<string, unknown> }[], release: RestResponse = { status: 200, body: { ok: true, bankTxnId: 'bt_7', releasedAssignmentId: 'ba_7', alreadyReleased: false } }) {
    const transport: Transport = async (action, input) => {
      calls.push({ action, input });
      if (action === 'list_bank_inbox')
        return { status: 200, body: { ok: true, lines: [{ bankTxnId: 'bt_7', bookingDate: '2026-10-14', amountMinor: -1_250, currency: 'CHF', counterparty: { name: 'Wolkenhaus Hosting AG', iban: null } }], summary: [] } };
      if (action === 'release_beleg') return release;
      return { status: 404, body: { ok: false, error: 'unknown_action' } };
    };
    return render(
      <MemoryRouter>
        <TillClientProvider client={new TillClient(transport)}>
          <I18nProvider initialLocale="de-CH">
            <WorkspaceProvider initialId="ws_test">{ui}</WorkspaceProvider>
          </I18nProvider>
        </TillClientProvider>
      </MemoryRouter>,
    );
  }

  it('names the line that holds it; Lösen releases it there, and only then Nochmals sends the act again, once', async () => {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    const sent: unknown[] = [];
    const retry: BookAgainRetry = async (confirmation) => {
      sent.push(confirmation);
      return null;
    };
    withEngine(<Harness refusal={ASSIGNED} retry={retry} />, calls);
    const dialog = await screen.findByRole('alertdialog', { name: 'Beleg einer Bankzeile zugeordnet' });
    expect(await within(dialog).findByText(/Bankzeile vom 14\.10\.2026, Wolkenhaus Hosting AG, CHF\s?-?12\.50/)).toBeInTheDocument();
    expect(within(dialog).getByText('von dir zugeordnet')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Bankzeile öffnen' })).toHaveAttribute('href', '/bank?line=bt_7');
    // Nothing is sent again before the person released the receipt and asked for it.
    expect(within(dialog).queryByRole('button', { name: 'Nochmals' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lösen' }));
    await waitFor(() => expect(calls.find((c) => c.action === 'release_beleg')?.input).toMatchObject({ workspaceId: 'ws_test', bankTxnId: 'bt_7' }));
    expect(sent).toEqual([]);
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Nochmals' }));
    await waitFor(() => expect(sent).toEqual([undefined]));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('a refused release is said, and the act is never sent again; closing sends nothing', async () => {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    const sent: unknown[] = [];
    const retry: BookAgainRetry = async (confirmation) => {
      sent.push(confirmation);
      return null;
    };
    withEngine(<Harness refusal={ASSIGNED} retry={retry} />, calls, { status: 403, body: { ok: false, error: 'human_only' } });
    const dialog = await screen.findByRole('alertdialog', { name: 'Beleg einer Bankzeile zugeordnet' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lösen' }));
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Nochmals' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(sent).toEqual([]);
  });

  it('the holder kind beleg_assignment has its words on a card, and the refusal parses defensively', () => {
    render(
      <I18nProvider>
        <ReceiptHolderNotice holders={[{ entityKind: 'beleg_assignment', entityId: 'ba_7', reservedBy: null }]} />
      </I18nProvider>,
    );
    expect(screen.getByText('Dieser Beleg ist einer Bankzeile zugeordnet.')).toBeInTheDocument();
    expect(screen.queryByText(/bereits gebucht/)).toBeNull();
    expect(isReceiptAssignedRefusal(ASSIGNED)).toBe(true);
    expect(isReceiptAssignedRefusal({ ok: false, error: 'receipt_already_booked', holders: [] })).toBe(false);
    expect(parseAssignmentHolders([{ bankTxnId: 'bt_1', source: 'machine' }, { source: 'person' }])).toEqual([{ bankTxnId: 'bt_1', assignmentId: null, source: null }]);
  });
});

describe('A41.3 v3: the drafted card names the assignment hold and offers Lösen', () => {
  it('a beleg_assignment holder with its bank line: the line in words, its link, Lösen (release_beleg)', async () => {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    const transport: Transport = async (action, input) => {
      calls.push({ action, input });
      if (action === 'list_bank_inbox')
        return { status: 200, body: { ok: true, lines: [{ bankTxnId: 'bt_7', bookingDate: '2026-10-14', amountMinor: -1_250, currency: 'CHF', counterparty: { name: 'Wolkenhaus Hosting AG', iban: null } }], summary: [] } };
      if (action === 'release_beleg') return { status: 200, body: { ok: true, bankTxnId: 'bt_7', releasedAssignmentId: 'ba_7', alreadyReleased: false } };
      return { status: 404, body: { ok: false, error: 'unknown_action' } };
    };
    const holders = parseReceiptHolders([{ entityKind: 'beleg_assignment', entityId: 'ba_7', reservedBy: null, assignmentId: 'ba_7', bankTxnId: 'bt_7', source: 'engine_unique' }]);
    render(
      <MemoryRouter>
        <TillClientProvider client={new TillClient(transport)}>
          <I18nProvider initialLocale="de-CH">
            <WorkspaceProvider initialId="ws_test">
              <ReceiptHolderNotice holders={holders} />
            </WorkspaceProvider>
          </I18nProvider>
        </TillClientProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText('Dieser Beleg ist einer Bankzeile zugeordnet.')).toBeInTheDocument();
    expect(screen.queryByText(/bereits gebucht/)).toBeNull();
    expect(await screen.findByText(/Bankzeile vom 14\.10\.2026, Wolkenhaus Hosting AG/)).toBeInTheDocument();
    expect(screen.getByText('von TILL zugeordnet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Bankzeile öffnen' })).toHaveAttribute('href', '/bank?line=bt_7');
    fireEvent.click(screen.getByRole('button', { name: 'Lösen' }));
    await waitFor(() => expect(calls.find((c) => c.action === 'release_beleg')?.input).toMatchObject({ bankTxnId: 'bt_7' }));
    expect(await screen.findByText('Gelöst. Die Bankzeile wartet wieder auf einen Beleg.')).toBeInTheDocument();
    // Approving stays the person's own next click: nothing else was sent.
    expect(calls.map((c) => c.action).filter((a) => a !== 'list_bank_inbox')).toEqual(['release_beleg']);
  });
});

describe('A41.3 r4 C1: the redacted hold (receipt_held) for a seat without the receipt read right', () => {
  const MARKER = { entityKind: 'receipt_held', entityId: null, reservedBy: null };

  it('the card says it in words, with no line, no link and no Lösen', () => {
    render(
      <MemoryRouter>
        <I18nProvider initialLocale="de-CH">
          <ReceiptHolderNotice holders={parseReceiptHolders([MARKER])} />
        </I18nProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText('Dieser Beleg ist einer Bankzeile zugeordnet.')).toBeInTheDocument();
    expect(screen.queryByText(/bereits gebucht/)).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Lösen' })).toBeNull();
    expect(hasHeldMarker([MARKER])).toBe(true);
  });

  it('the refusal opens the dialog with the marker in words, and offers neither a line, a link, Lösen nor Nochmals', async () => {
    const sent: unknown[] = [];
    const calls: string[] = [];
    const transport: Transport = async (action) => {
      calls.push(action);
      return { status: 404, body: { ok: false, error: 'unknown_action' } };
    };
    render(
      <MemoryRouter>
        <TillClientProvider client={new TillClient(transport)}>
          <I18nProvider initialLocale="de-CH">
            <WorkspaceProvider initialId="ws_test">
              <Harness
                refusal={{ ok: false, error: 'receipt_assigned', holders: [MARKER] }}
                retry={async (c) => {
                  sent.push(c);
                  return null;
                }}
              />
            </WorkspaceProvider>
          </I18nProvider>
        </TillClientProvider>
      </MemoryRouter>,
    );
    const dialog = await screen.findByRole('alertdialog', { name: 'Beleg einer Bankzeile zugeordnet' });
    expect(within(dialog).getByText('Beleg ist einer Bankzeile zugeordnet')).toBeInTheDocument();
    expect(within(dialog).getByText('Wer die Belege sehen darf, kann ihn auf der Bankzeile lösen.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('link')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Lösen' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Nochmals' })).toBeNull();
    // No line is read and nothing is released or sent again.
    expect(calls).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(sent).toEqual([]);
  });
});

describe('A41.3: the card tells a booked receipt from an assigned one', () => {
  it('a booking holder says "bereits gebucht", an assignment holder says "zugeordnet", each once', () => {
    render(
      <MemoryRouter>
        <I18nProvider initialLocale="de-CH">
          <ReceiptHolderNotice holders={parseReceiptHolders([{ entityKind: 'journal_entry', entityId: 'je_1' }, { entityKind: 'receipt_held', entityId: null, reservedBy: null }])} />
        </I18nProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText('Dieser Beleg ist bereits gebucht (Buchung).')).toBeInTheDocument();
    expect(screen.getByText('Dieser Beleg ist einer Bankzeile zugeordnet.')).toBeInTheDocument();
  });
});
