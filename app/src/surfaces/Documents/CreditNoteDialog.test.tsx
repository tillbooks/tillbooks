/**
 * A13 §6: the CreditNoteDialog and the constrained editing law around it.
 *
 * The dialog is the ONE writer of a credit-note selection; the derived draft is read-only in the
 * editor (§4b.1). These tests pin the client half of that law: the arms call `create_credit_note`
 * with the engine's input shape, every arm caps at the remainder after issued credits, and the
 * over_credit refusal renders BOTH its shapes (the round-3 H3 repair).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CreditNoteDialog } from './CreditNoteDialog';
import { IssueDialog } from './IssueDialog';
import type { DocumentDto, DocumentLine } from './model';

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

const INVOICE: DocumentDto = {
  id: 'doc_inv',
  type: 'invoice',
  number: 'R-2026-0001',
  status: 'issued',
  contactId: 'ct_1',
  currency: 'CHF',
  sourceDocumentId: null,
  targetDocumentId: null,
  postedEntryId: 'entry_1',
  subtotalMinor: 150000,
  taxMinor: 9400,
  totalMinor: 159400,
  issueDate: '2026-07-16',
  dueDate: null,
  sentToEmail: null,
  creditedDocumentId: null,
  notes: null,
  createdAt: '2026-07-16T00:00:00.000Z',
};

const LINES: DocumentLine[] = [
  { id: 'l1', description: 'Beratung', quantityMilli: 1000, unitPriceMinor: 100000, lineTotalMinor: 100000, taxCode: 'UST81' },
  { id: 'l2', description: 'Material', quantityMilli: 2000, unitPriceMinor: 25000, lineTotalMinor: 50000, taxCode: 'UST26' },
];

function renderDialog(
  canned: Canned,
  alreadyCreditedNetMinor = 0,
  onClose = () => {},
  priorCreditNoteIds: readonly string[] = [],
) {
  const client = new TillClient(fakeTransport(canned));
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter>
            <CreditNoteDialog
              invoice={INVOICE}
              lines={LINES}
              alreadyCreditedNetMinor={alreadyCreditedNetMinor}
              priorCreditNoteIds={priorCreditNoteIds}
              onClose={onClose}
            />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('CreditNoteDialog (A13 §6)', () => {
  it('full arm sends mode full, and no lines or amount', async () => {
    const createSpy = vi.fn<CannedHandler>(() =>
      ok({ document: { id: 'doc_cn', type: 'credit_note', status: 'draft' } }),
    );
    renderDialog({ create_credit_note: createSpy });
    // Full is preselected when nothing was credited before.
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf erstellen' }));
    expect(createSpy).toHaveBeenCalledTimes(1);
    const input = createSpy.mock.calls[0]![0];
    expect(input.fromInvoiceId).toBe('doc_inv');
    expect(input.mode).toBe('full');
    expect(input.lines).toBeUndefined();
    expect(input.amountMinor).toBeUndefined();
    expect(typeof input.idempotencyKey).toBe('string');
  });

  it('positions arm sends the selected positions, quantity only when reduced', async () => {
    const createSpy = vi.fn<CannedHandler>(() =>
      ok({ document: { id: 'doc_cn', type: 'credit_note', status: 'draft' } }),
    );
    renderDialog({ create_credit_note: createSpy });
    await userEvent.click(screen.getByRole('radio', { name: 'Einzelne Positionen' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Material' }));
    const qty = screen.getByRole('textbox', { name: 'Menge für Material' });
    await userEvent.clear(qty);
    await userEvent.type(qty, '1');
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf erstellen' }));
    const input = createSpy.mock.calls[0]![0];
    expect(input.mode).toBe('partial');
    expect(input.lines).toEqual([{ position: 2, quantityMilli: 1000 }]);
  });

  it('the amount arm renders the ENGINE gross beside the typed net (D78)', async () => {
    // The fake engine: per-line VAT the way `vat_preview` answers it. The TEST computes the tax
    // because the test IS the engine here; the dialog itself only sums what came back.
    const vatSpy = vi.fn<CannedHandler>((input) => {
      const net = input.amountMinor as number;
      const rate = input.taxCode === 'UST81' ? 810 : 260;
      const tax = Math.round((net * rate) / 10000);
      return ok({ netMinor: net, taxMinor: tax, grossMinor: net + tax });
    });
    renderDialog({ vat_preview: vatSpy });
    await userEvent.click(screen.getByRole('radio', { name: 'Ein Betrag (netto)' }));
    // Nothing typed, nothing promised.
    expect(screen.queryByText(/Ergibt brutto/)).toBeNull();

    await userEvent.type(screen.getByRole('textbox', { name: 'Betrag in CHF (netto)' }), '600');
    // CHF 600.00 net, apportioned by the engine's own largest-remainder split over the line nets
    // (100000/50000 -> 40000/20000), each share previewed on its own code: 40000 at 8.1% carries
    // 3240, 20000 at 2.6% carries 520, so the ENGINE's gross is CHF 637.60.
    expect(await screen.findByText('Ergibt brutto (inkl. MWST): CHF 637.60')).toBeInTheDocument();

    // The derivation was the engine's, per line and per code, net stated as net.
    const asked = vatSpy.mock.calls
      .map(([input]) => input)
      .filter((input) => input.amountMinor === 40000 || input.amountMinor === 20000);
    expect(asked.some((i) => i.amountMinor === 40000 && i.taxCode === 'UST81')).toBe(true);
    expect(asked.some((i) => i.amountMinor === 20000 && i.taxCode === 'UST26')).toBe(true);
    expect(asked.every((i) => i.amountIsGross === false)).toBe(true);
    expect(asked.every((i) => i.supplyDate === '2026-07-16')).toBe(true);
  });

  it('the gross readout stays SILENT while its weights are unresolved (priors without lines)', async () => {
    // Priors exist but their ids (and so their per-position lines) were not provided: weighting
    // over the original nets would preview shares the engine will not derive, so nothing renders.
    const vatSpy = vi.fn<CannedHandler>(() => ok({ netMinor: 0, taxMinor: 0, grossMinor: 0 }));
    renderDialog({ vat_preview: vatSpy }, 90000);
    await userEvent.click(screen.getByRole('radio', { name: 'Ein Betrag (netto)' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Betrag in CHF (netto)' }), '100');
    // Give any wrongly-armed effect its microtask before measuring the silence.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(/Ergibt brutto/)).toBeNull();
    expect(vatSpy).not.toHaveBeenCalled();
  });

  it('the amount arm caps at the REMAINDER after issued credits, and shows it (F6)', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_cn' } }));
    // CHF 900.00 net already credited: the remainder is CHF 600.00 net.
    renderDialog({ create_credit_note: createSpy }, 90000);
    expect(screen.getByText('Noch gutschreibbar (netto): CHF 600.00')).toBeInTheDocument();
    // With priors, the full arm is not offered at all.
    expect(screen.queryByRole('radio', { name: 'Die ganze Rechnung' })).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'Ein Betrag (netto)' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Betrag in CHF (netto)' }), '700');
    expect(screen.getByRole('alert')).toHaveTextContent('höchstens CHF 600.00');
    expect(screen.getByRole('button', { name: 'Entwurf erstellen' })).toBeDisabled();
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe('IssueDialog renders both over_credit shapes (H3)', () => {
  const base = {
    posts: true,
    totalMinor: 10000,
    currency: 'CHF',
    busy: false,
    onConfirm: () => {},
    onCancel: () => {},
  };

  function renderIssue(error: Record<string, unknown>) {
    return render(
      <I18nProvider>
        <MemoryRouter>
          <IssueDialog {...base} error={error as never} />
        </MemoryRouter>
      </I18nProvider>,
    );
  }

  it('the invoice-level refusal names the remaining creditable amount', () => {
    renderIssue({ ok: false, error: 'over_credit', remainingCreditableMinor: 60000, currency: 'CHF' });
    expect(screen.getByRole('alert')).toHaveTextContent('höchstens CHF 600.00');
  });

  it('the line refusal names the LINE remainder and the invoice remainder, never CHF 0.00', () => {
    renderIssue({
      ok: false,
      error: 'over_credit',
      reason: 'line_over_credit',
      position: 1,
      remainingLineNetMinor: 50000,
      remainingCreditableMinor: 156650,
      currency: 'CHF',
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Position 1');
    expect(alert).toHaveTextContent('CHF 500.00');
    expect(alert).toHaveTextContent("CHF 1'566.50");
    expect(alert).not.toHaveTextContent('CHF 0.00');
  });
});

describe('CreditNoteDialog: accessibility', () => {
  it('has no axe violations in either arm', async () => {
    // Both arms, because they render different controls: the positions arm mounts a checkbox and a
    // quantity input per line (each of which has to carry its own accessible name in a grid with no
    // visible label), and the amount arm mounts a single labelled field.
    const { container } = renderDialog({});
    await userEvent.click(screen.getByLabelText('Einzelne Positionen'));
    expect(await axe(container)).toHaveNoViolations();
    await userEvent.click(screen.getByLabelText('Ein Betrag (netto)'));
    expect(await axe(container)).toHaveNoViolations();
  });
});
