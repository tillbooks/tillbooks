/**
 * G21, the Offene-Posten step. The claims worth the most:
 *
 *   THE FIVE STATES render (loading / empty / error-refusal / success / denied), and the control
 *   delta renders in the three G11 states, with not_asserted ORANGE-worded ("Noch nicht geprüft"),
 *   never green. A refused row names its reason inline (never a stack). The Importieren action is
 *   gated on a green-or-acknowledged tie-out.
 *
 * Copy is asserted through the de-CH catalogue, never a literal typed here.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { OpenItems } from './OpenItems';
import de from './messages.de-CH.json';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const t = de.migration.openItems;

function fakeTransport(
  handler: (action: string, input: Record<string, unknown>) => RestResponse,
  calls: Array<{ action: string; input: Record<string, unknown> }>,
): Transport {
  return async (action, input) => {
    calls.push({ action, input: input as Record<string, unknown> });
    return handler(action, input as Record<string, unknown>);
  };
}

function tree(handler: (a: string, i: Record<string, unknown>) => RestResponse, calls: Array<{ action: string; input: Record<string, unknown> }>, props: Record<string, unknown> = {}) {
  return (
    <TillClientProvider client={new TillClient(fakeTransport(handler, calls))}>
      <I18nProvider>
        <OpenItems workspaceId="ws_1" planId="migplan_1" {...props} />
      </I18nProvider>
    </TillClientProvider>
  );
}

const AR_ROW = { contactId: 'ct_1', number: 'SRC-1', issueDate: '2026-06-15', currency: 'CHF', lines: [{ netMinor: 100000, taxMinor: 8100, taxCode: 'UST81' }] };

const greenControl = { kind: 'ar_control', controlAccountMinor: 108100, migratedOpenMinor: 108100, differenceMinor: 0, status: 'passed' };
const redControl = { kind: 'ar_control', controlAccountMinor: 108100, migratedOpenMinor: 108099, differenceMinor: -1, status: 'failed' };

describe('OpenItems Offene-Posten step', () => {
  it('renders the EMPTY state when no rows are loaded', () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(tree(() => ok(), calls));
    // Both panels render the empty copy; no preview call fires for an empty side.
    expect(screen.getAllByText(t.empty).length).toBe(2);
    expect(calls.find((c) => c.action === 'preview_open_items')).toBeUndefined();
  });

  it('renders a GREEN control and imports on the green tie-out', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(
      tree(
        (action) =>
          action === 'preview_open_items'
            ? ok({ control: greenControl, refusals: [], validCount: 1 })
            : ok({ importedCount: 1, control: greenControl }),
        calls,
        { arRows: [AR_ROW] },
      ),
    );
    expect(await screen.findByText(t.asserted)).toBeTruthy();
    // The Importieren button is enabled on a passing control.
    const button = screen.getAllByRole('button', { name: t.import })[0];
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    await waitFor(() => {
      expect(calls.find((c) => c.action === 'import_open_items')).toBeTruthy();
    });
    expect(await screen.findByText(t.importedCount.replace('{count}', '1'))).toBeTruthy();
  });

  it('renders a RED control and gates import behind acknowledgement', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(tree(() => ok({ control: redControl, refusals: [], validCount: 1 }), calls, { arRows: [AR_ROW] }));
    // The difference renders (not green): the failed control shows the Rappen figure.
    expect(await screen.findByText(new RegExp(t.difference.replace('{amount}', '')))).toBeTruthy();
    const button = screen.getAllByRole('button', { name: t.import })[0];
    expect(button.hasAttribute('disabled')).toBe(true);
    // Acknowledge the open difference; the action unlocks.
    fireEvent.click(screen.getByLabelText(t.acknowledge));
    expect(button.hasAttribute('disabled')).toBe(false);
  });

  it('renders a refused row NAMING its reason inline, and blocks import', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    const refusals = [{ rowIndex: 0, number: 'SRC-1', reason: 'contact_unmapped' }];
    render(
      tree(
        () => ok({ control: { ...redControl, status: 'not_asserted', differenceMinor: 0, migratedOpenMinor: 0, controlAccountMinor: 0 }, refusals, validCount: 0 }),
        calls,
        { arRows: [AR_ROW] },
      ),
    );
    expect(await screen.findByText(`SRC-1: ${t.contactUnmapped}`)).toBeTruthy();
    // not_asserted renders its orange-worded label, never green.
    expect(screen.getByText(t.notAsserted)).toBeTruthy();
    const button = screen.getAllByRole('button', { name: t.import })[0];
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('f9: the not_asserted state is not a dead end: it names why import is blocked and offers a real re-check', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    const notAsserted = { kind: 'ar_control', controlAccountMinor: 0, migratedOpenMinor: 108100, differenceMinor: 0, status: 'not_asserted' };
    render(tree(() => ok({ control: notAsserted, refusals: [], validCount: 1 }), calls, { arRows: [AR_ROW] }));
    // The block is named (not a bare disabled button), and a working re-check control is offered.
    expect(await screen.findByText(t.notAssertedHint)).toBeTruthy();
    const recheck = screen.getAllByRole('button', { name: t.recheck })[0];
    // Clicking it re-runs the preview (a genuine in-surface action), so the panel is no dead end.
    const before = calls.filter((c) => c.action === 'preview_open_items').length;
    fireEvent.click(recheck);
    await waitFor(() => {
      expect(calls.filter((c) => c.action === 'preview_open_items').length).toBeGreaterThan(before);
    });
    // Import stays disabled while the tie-out is unasserted (the gate is unchanged).
    expect(screen.getAllByRole('button', { name: t.import })[0].hasAttribute('disabled')).toBe(true);
  });

  it('renders the DENIED padlock when the write is forbidden', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(
      tree((action) => (action === 'preview_open_items' ? ({ status: 403, body: { ok: false, error: 'forbidden' } }) : ok()), calls, { arRows: [AR_ROW] }),
    );
    expect(await screen.findByText(t.denied)).toBeTruthy();
  });
});
