import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider, useWorkspace } from '../../app/workspace';
import { CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import DocumentsSurface from './index';
import getFixture from './get-document.fixture.json';
import issueFixture from './issue-invoice.fixture.json';

/**
 * A canned handler exactly as the transport calls it: the request input in, a RestResponse out.
 *
 * Spies are declared `vi.fn<CannedHandler>(...)` rather than bare `vi.fn(...)`, so that
 * `spy.mock.calls[0][0]` is the request the surface actually sent. Inferred from a zero-argument
 * implementation the calls tuple is empty, and every assertion about what the surface asked for is
 * a compile error the moment anyone type-checks this file.
 */
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
const reject = (error: string, status = 422): RestResponse => ({ status, body: { ok: false, error } });

/**
 * The MWST code is the shared Select since K-30 (a combobox trigger over a portaled listbox): open
 * it and click the option that carries the code ('' is "Keine MWST").
 */
async function pickTaxCode(trigger: HTMLElement, code: string) {
  await userEvent.click(trigger);
  const option = screen.getAllByRole('option').find((o) => o.getAttribute('data-value') === code);
  if (option === undefined) throw new Error(`the tax code list offers no ${code}`);
  await userEvent.click(option);
}

const TAX_CODES = [{ code: 'UST81', kind: 'output', rateBp: 810, formLine: '303', label: 'Normalsatz 8.1%', active: true }];
const CONTACTS = [{ id: 'ct_1', name: 'Muster AG' }];

function renderNew(canned: Canned, initial = '/documents/new', held: readonly string[] | null = null) {
  const client = new TillClient(fakeTransport(canned));
  const tree = (
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter initialEntries={[initial]}>
            <Routes>
              <Route path="/documents/*" element={<DocumentsSurface />} />
            </Routes>
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
  if (held === null) return render(tree);
  const caps: Capabilities = {
    whoami: { actor: 'u1', provisioned: true, isMember: true, memberId: 'm1', userId: 'u1', role: 'viewer', capabilities: [...held] },
    can: (capability) => held.includes(capability),
    refresh: () => undefined,
  };
  return render(<CapabilitiesContext.Provider value={caps}>{tree}</CapabilitiesContext.Provider>);
}

const base = (): Canned => ({
  list_contacts: ok({ contacts: CONTACTS }),
  vat_codes: ok({ taxCodes: TAX_CODES }),
  vat_preview: ok({ ok: true, kind: 'output', netMinor: 15000, taxMinor: 1215, grossMinor: 16215, rateBp: 810, deductible: false, formLine: '303', trace: { taxCode: 'UST81', taxBaseMinor: 15000, taxAmountMinor: 1215 } }),
});

describe('DocumentEditor, D152 rule 3: no Ausstellen beside the control that unlocks it', () => {
  it('at rest there is no Ausstellen and no sentence about it; the customer brings the button, enabled', async () => {
    renderNew(base());
    await screen.findByLabelText('Kunde');
    expect(screen.queryByRole('button', { name: 'Ausstellen' })).not.toBeInTheDocument();
    expect(screen.queryByText('Wähle zuerst einen Kunden.')).not.toBeInTheDocument();
    // Nothing on the page is a disabled button waiting for the customer.
    expect(screen.queryAllByRole('button').filter((b) => (b as HTMLButtonElement).disabled)).toEqual([]);

    await userEvent.click(screen.getByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    expect(screen.getByRole('button', { name: 'Ausstellen' })).toBeEnabled();
    // Clearing the customer takes the button away again.
    await userEvent.click(screen.getByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Kunde wählen' }));
    expect(screen.queryByRole('button', { name: 'Ausstellen' })).not.toBeInTheDocument();
  });

  it('a press the engine would refuse names the gap in ONE line at the moment of the act, and saves nothing', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_new', type: 'invoice', status: 'draft' } }));
    renderNew({ ...base(), create_document: createSpy });
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    const issue = screen.getByRole('button', { name: 'Ausstellen' });
    // Before the press, no reason is on screen.
    expect(screen.queryByText('Füge zuerst eine Position hinzu.')).not.toBeInTheDocument();

    // No positions: the engine answers needs_lines.
    await userEvent.click(issue);
    const reason = await screen.findByRole('alert');
    expect(reason).toHaveTextContent('Füge zuerst eine Position hinzu.');
    expect(issue).toHaveAccessibleDescription('Füge zuerst eine Position hinzu.');
    expect(createSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    // A position with a text but no amount: the engine answers invalid_line (a zero line cannot
    // post), so the press names the position instead.
    await userEvent.type(screen.getByLabelText('Bezeichnung 1'), 'Beratung');
    await userEvent.click(issue);
    expect(await screen.findByText('Position 1 hat noch keinen Betrag.')).toBeInTheDocument();
    expect(createSpy).not.toHaveBeenCalled();

    // The amount clears the gap: the line goes, and the next press saves and opens the confirm.
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    expect(screen.queryByText('Position 1 hat noch keinen Betrag.')).not.toBeInTheDocument();
    await userEvent.click(issue);
    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    expect(await screen.findByRole('alertdialog', { name: 'Rechnung ausstellen' })).toBeInTheDocument();
  });

  it('a quote with a priceless position is not refused for it: only an invoice posts', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_q', type: 'quote', status: 'draft' } }));
    renderNew({ ...base(), create_document: createSpy }, '/documents/new?type=quote');
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await userEvent.type(screen.getByLabelText('Bezeichnung 1'), 'Option A');
    await userEvent.click(screen.getByRole('button', { name: 'Ausstellen' }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    expect(screen.queryByText(/hat noch keinen Betrag/)).not.toBeInTheDocument();
  });
});

describe('DocumentEditor, D152 rule 2 and the MWST summary', () => {
  /** A transport whose vat_preview answers only when the test releases it. */
  function heldPreview(canned: Canned) {
    const waiting: (() => void)[] = [];
    const transport: Transport = async (action, input) => {
      if (action === 'vat_preview') {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      const entry = canned[action];
      if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
      return typeof entry === 'function' ? entry(input) : entry;
    };
    return { transport, release: () => waiting.splice(0).forEach((resolve) => resolve()) };
  }

  function renderWith(transport: Transport) {
    return render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter initialEntries={['/documents/new']}>
              <Routes>
                <Route path="/documents/*" element={<DocumentsSurface />} />
              </Routes>
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
  }

  it('at rest there is no MWST summary and no QR readiness: no customer, no amount', async () => {
    renderNew({ ...base(), list_documents: ok({ documents: [] }) });
    // The line already carries the workspace default code (UST81), exactly the audited screen.
    await waitFor(() => expect(screen.getByLabelText('MWST 1')).toHaveTextContent(/· UST81$/));
    expect(screen.queryByTestId('vat-summary-empty')).not.toBeInTheDocument();
    expect(screen.queryByText('Keine MWST auf diesem Beleg')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('MWST-Übersicht')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('QR-Bereitschaft')).not.toBeInTheDocument();
    // An amount without a customer is still not enough.
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    expect(screen.queryByLabelText('MWST-Übersicht')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('QR-Bereitschaft')).not.toBeInTheDocument();
  });

  it('never says "Keine MWST" about a line that carries a code while its preview has not answered', async () => {
    const { transport, release } = heldPreview({ ...base(), list_documents: ok({ documents: [] }) });
    renderWith(transport);
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await waitFor(() => expect(screen.getByLabelText('MWST 1')).toHaveTextContent(/· UST81$/));
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    // Customer and amount are there, the preview is in flight: neither a summary nor a false empty.
    expect(screen.queryByText('Keine MWST auf diesem Beleg')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('MWST-Übersicht')).not.toBeInTheDocument();

    release();
    // The figure is the engine's answer (vat_preview, the computeLineTax the posting runs).
    const summary = await screen.findByLabelText('MWST-Übersicht');
    expect(within(summary).getAllByText('CHF 12.15').length).toBeGreaterThan(0);
    expect(screen.queryByText('Keine MWST auf diesem Beleg')).not.toBeInTheDocument();
  });

  it('an amount changed while its new preview is out hides the summary and the Total: no stale tax (critic F5)', async () => {
    let hold = false;
    const held: (() => void)[] = [];
    const transport: Transport = async (action, input) => {
      if (action === 'vat_preview') {
        if (hold) await new Promise<void>((resolve) => held.push(resolve));
        const net = Number(input.amountMinor);
        const tax = Math.round((net * 810) / 10000);
        return ok({ kind: 'output', netMinor: net, taxMinor: tax, grossMinor: net + tax, rateBp: 810, deductible: false, formLine: '303', trace: { taxCode: 'UST81', taxBaseMinor: net, taxAmountMinor: tax } });
      }
      const entry = ({ ...base(), list_documents: ok({ documents: [] }) } as Canned)[action];
      if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
      return typeof entry === 'function' ? entry(input) : entry;
    };
    renderWith(transport);
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await waitFor(() => expect(screen.getByLabelText('MWST 1')).toHaveTextContent(/· UST81$/));
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    const summary = await screen.findByLabelText('MWST-Übersicht');
    await waitFor(() => expect(within(summary).getAllByText('CHF 12.15').length).toBeGreaterThan(0));
    const totals = document.querySelector('.documents-editor-totals') as HTMLElement;
    expect(within(totals).getByText('CHF 162.15')).toBeInTheDocument();

    hold = true;
    // 150 -> 1500 in one keystroke, never through an empty field (which would drop every answer).
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '0');
    // The answer on file is for CHF 150: it is not this line's answer any more.
    expect(screen.queryByLabelText('MWST-Übersicht')).not.toBeInTheDocument();
    expect(within(totals).queryByText('CHF 162.15')).not.toBeInTheDocument();
    expect(within(totals).getByText('wird berechnet')).toBeInTheDocument();

    held.splice(0).forEach((resolve) => resolve());
    await waitFor(() => expect(within(totals).getByText("CHF 1'621.50")).toBeInTheDocument());
    expect(within(screen.getByLabelText('MWST-Übersicht')).getAllByText('CHF 121.50').length).toBeGreaterThan(0);
  });

  it('a refused preview is not "Keine MWST" either: the summary stays away and the line says why', async () => {
    renderNew({ ...base(), list_documents: ok({ documents: [] }), vat_preview: reject('rate_era_unknown') });
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await waitFor(() => expect(screen.getByLabelText('MWST 1')).toHaveTextContent(/· UST81$/));
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText('Keine MWST auf diesem Beleg')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('MWST-Übersicht')).not.toBeInTheDocument();
  });

  it('"Keine MWST" chosen by hand, with a customer and an amount, is said honestly', async () => {
    renderNew({ ...base(), list_documents: ok({ documents: [] }) });
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await waitFor(() => expect(screen.getByLabelText('MWST 1')).toHaveTextContent(/· UST81$/));
    await pickTaxCode(screen.getByLabelText('MWST 1'), '');
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    expect(await screen.findByText('Keine MWST auf diesem Beleg')).toBeInTheDocument();
  });
});

describe('DocumentEditor, a workspace switch (wave B-2 lesson)', () => {
  function Switcher({ onReady }: { onReady: (switchTo: (id: string) => void) => void }) {
    const { setWorkspaceId } = useWorkspace();
    onReady(setWorkspaceId);
    return null;
  }

  function renderSwitchable(transport: Transport, initial = '/documents/new') {
    let switchTo: (id: string) => void = () => undefined;
    let path = '';
    function Where() {
      path = useLocation().pathname;
      return null;
    }
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_a">
            <Switcher onReady={(fn) => (switchTo = fn)} />
            <MemoryRouter initialEntries={[initial]}>
              <Where />
              <Routes>
                <Route path="/documents/*" element={<DocumentsSurface />} />
              </Routes>
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    return { switchTo: (id: string) => act(() => switchTo(id)), path: () => path };
  }

  it('drops the customer, the lines and the typed due date of the old workspace, and reads the new one', async () => {
    const asked: string[] = [];
    const contactsFor: Record<string, unknown[]> = {
      ws_a: [{ id: 'ct_a', name: 'Alpha AG', paymentTermsDays: 30 }],
      ws_b: [{ id: 'ct_b', name: 'Beta GmbH', paymentTermsDays: 10 }],
    };
    const transport: Transport = async (action, input) => {
      if (action === 'list_contacts') {
        asked.push(String(input.workspaceId));
        return ok({ contacts: contactsFor[String(input.workspaceId)] ?? [] });
      }
      const entry = base()[action];
      if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
      return typeof entry === 'function' ? entry(input) : entry;
    };
    const ws = renderSwitchable(transport);
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Alpha AG' }));
    await userEvent.type(screen.getByLabelText('Bezeichnung 1'), 'Beratung');
    await userEvent.type(screen.getByLabelText('Zahlbar bis'), '2026-12-24');
    expect(screen.getByLabelText('Zahlbar bis')).toHaveValue('2026-12-24');

    ws.switchTo('ws_b');
    await waitFor(() => expect(asked).toEqual(['ws_a', 'ws_b']));
    await waitFor(() => expect(screen.getByLabelText('Kunde')).toHaveTextContent('Kunde wählen'));
    expect(screen.getByLabelText('Bezeichnung 1')).toHaveValue('');
    expect(screen.getByLabelText('Zahlbar bis')).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Ausstellen' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Kunde'));
    expect(screen.queryByRole('option', { name: 'Alpha AG' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Beta GmbH' })).toBeInTheDocument();
  });

  it('an issue answered after a switch lands in the workspace it was pressed in and navigates nowhere', async () => {
    let releaseIssue: () => void = () => undefined;
    const issueCalls: Record<string, unknown>[] = [];
    const canned: Canned = {
      ...base(),
      create_document: ok({ document: { id: 'doc_a', type: 'invoice', status: 'draft' } }),
    };
    const transport: Transport = async (action, input) => {
      if (action === 'issue_invoice') {
        issueCalls.push(input);
        await new Promise<void>((resolve) => (releaseIssue = resolve));
        return ok({ ...issueFixture });
      }
      const entry = canned[action];
      if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
      return typeof entry === 'function' ? entry(input) : entry;
    };
    const ws = renderSwitchable(transport);
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    await userEvent.click(screen.getByRole('button', { name: 'Ausstellen' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Rechnung ausstellen' });
    await userEvent.click(within(dialog).getByRole('button', { name: /^Ausstellen/ }));
    await waitFor(() => expect(issueCalls).toHaveLength(1));
    expect(issueCalls[0]).toMatchObject({ workspaceId: 'ws_a', invoiceId: 'doc_a' });

    ws.switchTo('ws_b');
    await act(async () => releaseIssue());
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The editor of ws_b is fresh, and nobody was sent to ws_a's document inside ws_b's books.
    expect(ws.path()).toBe('/documents/new');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Kunde')).toHaveTextContent('Kunde wählen');
  });
});

describe('DocumentEditor, one act and one default (friction ledger F-03, J3.5)', () => {
  const TWO_CODES = [
    ...TAX_CODES,
    { code: 'UST26', kind: 'output', rateBp: 260, formLine: '312', label: 'Reduzierter Satz 2.6%', active: true },
    { code: 'VST81', kind: 'input', rateBp: 810, formLine: '400', label: 'Vorsteuer 8.1%', active: true },
  ];

  it('defaults a position to the workspace Normalsatz, never "Keine MWST", when the customer has no history', async () => {
    renderNew({ ...base(), vat_codes: ok({ taxCodes: TWO_CODES }), list_documents: ok({ documents: [] }) });
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    // The highest active OUTPUT rate (the Normalsatz), not the input code and not the reduced rate.
    await waitFor(() => expect(screen.getByLabelText('MWST 1')).toHaveTextContent(/· UST81$/));
    // A position added later inherits the same default.
    await userEvent.click(screen.getByRole('button', { name: 'Position hinzufügen' }));
    expect(screen.getByLabelText('MWST 2')).toHaveTextContent(/· UST81$/);
  });

  it('defaults a position to the code on the customer\'s newest issued invoice, and leaves a hand-picked code alone', async () => {
    renderNew({
      ...base(),
      vat_codes: ok({ taxCodes: TWO_CODES }),
      list_documents: ok({
        documents: [
          { id: 'doc_prev', type: 'invoice', status: 'issued', contactId: 'ct_1' },
          { id: 'doc_older', type: 'invoice', status: 'settled', contactId: 'ct_1' },
        ],
      }),
      get_document: (input) =>
        input.documentId === 'doc_prev'
          ? ok({ document: { id: 'doc_prev', type: 'invoice', status: 'issued' }, lines: [{ description: 'Kaffee', quantityMilli: 1000, unitPriceMinor: 1000, taxCode: 'UST26' }], history: [] })
          : reject('not_found', 404),
    });
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await waitFor(() => expect(screen.getByLabelText('MWST 1')).toHaveTextContent(/· UST26$/));
    // The person overrides: a later re-default (the customer is re-picked) must not touch it.
    await pickTaxCode(screen.getByLabelText('MWST 1'), 'UST81');
    await userEvent.click(screen.getByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Kunde wählen' }));
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await waitFor(() => expect(screen.getByLabelText('MWST 1')).toHaveTextContent(/· UST81$/));
  });

  // Critic F1 (2026-09-05), the two ways the default silently re-coded a decided line. Revert the
  // `taxDefaulted`-only condition (or the loaded lines' `taxDefaulted: false`) and each one fails.
  it('a hand-picked "Keine MWST" survives a customer switch that changes the default VALUE (critic F1a)', async () => {
    renderNew({
      ...base(),
      vat_codes: ok({ taxCodes: TWO_CODES }),
      list_contacts: ok({ contacts: [...CONTACTS, { id: 'ct_2', name: 'Neu AG' }] }),
      // Customer A has UST26 history, customer B none (the workspace default UST81 applies to B).
      list_documents: (input) =>
        input.contactId === 'ct_1'
          ? ok({ documents: [{ id: 'doc_prev', type: 'invoice', status: 'issued', contactId: 'ct_1' }] })
          : ok({ documents: [] }),
      get_document: ok({ document: { id: 'doc_prev', type: 'invoice', status: 'issued' }, lines: [{ description: 'Kaffee', quantityMilli: 1000, unitPriceMinor: 1000, taxCode: 'UST26' }], history: [] }),
    });
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await waitFor(() => expect(screen.getByLabelText('MWST 1')).toHaveTextContent(/· UST26$/));
    // The person removes the VAT leg on purpose.
    await pickTaxCode(screen.getByLabelText('MWST 1'), '');
    expect(screen.getByLabelText('MWST 1')).toHaveTextContent('Keine MWST');
    // Switching to a customer whose default is UST81 must not put the leg back.
    await userEvent.click(screen.getByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Neu AG' }));
    // A fresh position proves the default really moved to UST81 while line 1 kept its decision.
    await userEvent.click(screen.getByRole('button', { name: 'Position hinzufügen' }));
    await waitFor(() => expect(screen.getByLabelText('MWST 2')).toHaveTextContent(/· UST81$/));
    expect(screen.getByLabelText('MWST 1')).toHaveTextContent('Keine MWST');
  });

  it('a saved draft whose line carries taxCode null reopens as "Keine MWST", never re-coded (critic F1b)', async () => {
    renderNew(
      {
        ...base(),
        vat_codes: ok({ taxCodes: TWO_CODES }),
        list_documents: ok({ documents: [] }),
        get_document: ok({
          document: { id: 'doc_1', type: 'invoice', status: 'draft', contactId: 'ct_1', currency: 'CHF', notes: '', dueDate: null, totalMinor: 15000, sourceDocumentId: null },
          lines: [{ description: 'Export', quantityMilli: 1000, unitPriceMinor: 15000, taxCode: null }],
          history: [],
        }),
      },
      '/documents/doc_1',
    );
    expect(await screen.findByLabelText('Bezeichnung 1')).toHaveValue('Export');
    // Give the default effect every chance to run (the customer is set, the codes are loaded) and
    // assert the line still reads none.
    await userEvent.click(screen.getByRole('button', { name: 'Position hinzufügen' }));
    await waitFor(() => expect(screen.getByLabelText('MWST 2')).toHaveTextContent(/· UST81$/));
    expect(screen.getByLabelText('MWST 1')).toHaveTextContent('Keine MWST');
  });

  it('"Ausstellen und senden": ONE confirm issues, then sends to the address on file without asking for it', async () => {
    const issueSpy = vi.fn<CannedHandler>(() => ok({ ...issueFixture }));
    const sendSpy = vi.fn<CannedHandler>(() => ok({ documentId: 'doc_new', sentToEmail: 'buchhaltung@muster.example', transmitted: true }));
    renderNew({
      ...base(),
      list_contacts: ok({ contacts: [{ id: 'ct_1', name: 'Muster AG', email: 'buchhaltung@muster.example' }] }),
      create_document: ok({ document: { id: 'doc_new', type: 'invoice', status: 'draft', totalMinor: 15000 } }),
      issue_invoice: issueSpy,
      send_invoice: sendSpy,
      get_document: ok({ document: { ...getFixture.document, status: 'sent', sentToEmail: 'buchhaltung@muster.example' }, lines: getFixture.lines, history: getFixture.history }),
      get_contact: ok({ contact: { id: 'ct_1', name: 'Muster AG', email: 'buchhaltung@muster.example' } }),
    });
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await userEvent.type(screen.getByLabelText('Bezeichnung 1'), 'Beratung');
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    const issue = screen.getByRole('button', { name: 'Ausstellen' });
    await waitFor(() => expect(issue).toBeEnabled());
    await userEvent.click(issue);
    const dialog = await screen.findByRole('alertdialog', { name: 'Rechnung ausstellen' });
    // The send line is offered, default on, naming the address; the confirm names both acts.
    const sendLine = within(dialog).getByRole('checkbox', { name: 'Anschliessend per E-Mail an buchhaltung@muster.example senden' });
    expect(sendLine).toBeChecked();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ausstellen und senden' }));
    await waitFor(() => expect(sendSpy).toHaveBeenCalledOnce());
    expect(issueSpy).toHaveBeenCalledOnce();
    // No typed address: the engine resolves the contact's own; the press is the confirmation.
    expect(sendSpy.mock.calls[0][0]).toMatchObject({ invoiceId: 'doc_new', confirmed: true });
    expect(sendSpy.mock.calls[0][0]).not.toHaveProperty('email');
    // The detail acknowledges both halves in one sentence.
    expect(await screen.findByText(/ist ausgestellt und an buchhaltung@muster.example versendet/)).toBeInTheDocument();
  });

  // Critic F6 (M4): without the `busy` guard on the confirm every Documents test still passed. A
  // double press on "Ausstellen und senden" must issue ONCE and send ONCE; each verb mints its own
  // key per call, so a second confirm would be a second numbered invoice. Drop `disabled={busy}` from
  // the confirm and this fails.
  it('a double press on "Ausstellen und senden" issues once and sends once', async () => {
    const issueSpy = vi.fn<CannedHandler>(() => ok({ ...issueFixture }));
    const sendSpy = vi.fn<CannedHandler>(() => ok({ documentId: 'doc_new', sentToEmail: 'buchhaltung@muster.example', transmitted: true }));
    const canned: Canned = {
      ...base(),
      list_contacts: ok({ contacts: [{ id: 'ct_1', name: 'Muster AG', email: 'buchhaltung@muster.example' }] }),
      create_document: ok({ document: { id: 'doc_new', type: 'invoice', status: 'draft', totalMinor: 15000 } }),
      issue_invoice: issueSpy,
      send_invoice: sendSpy,
      get_document: ok({ document: { ...getFixture.document, status: 'sent', sentToEmail: 'buchhaltung@muster.example' }, lines: getFixture.lines, history: getFixture.history }),
      get_contact: ok({ contact: { id: 'ct_1', name: 'Muster AG', email: 'buchhaltung@muster.example' } }),
    };
    // A slow wire: the issue call is still in flight when the second click lands.
    const slow: Transport = async (action, input) => {
      if (action === 'issue_invoice') await new Promise((r) => setTimeout(r, 60));
      return fakeTransport(canned)(action, input);
    };
    const client = new TillClient(slow);
    render(
      <TillClientProvider client={client}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter initialEntries={['/documents/new']}>
              <Routes>
                <Route path="/documents/*" element={<DocumentsSurface />} />
              </Routes>
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await userEvent.type(screen.getByLabelText('Bezeichnung 1'), 'Beratung');
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    const issue = screen.getByRole('button', { name: 'Ausstellen' });
    await waitFor(() => expect(issue).toBeEnabled());
    await userEvent.click(issue);
    const dialog = await screen.findByRole('alertdialog', { name: 'Rechnung ausstellen' });
    await userEvent.dblClick(within(dialog).getByRole('button', { name: 'Ausstellen und senden' }));
    await waitFor(() => expect(sendSpy).toHaveBeenCalledOnce());
    // The detail lands (every in-flight update drained), then the counts are final.
    await waitFor(() => expect(screen.getByText(/ist ausgestellt und an buchhaltung@muster.example versendet/)).toBeInTheDocument());
    expect(issueSpy).toHaveBeenCalledOnce();
    expect(sendSpy).toHaveBeenCalledOnce();
  });

  it('a refused send leaves the invoice issued and names the reason with its ways out (no dead end)', async () => {
    const sendSpy = vi.fn<CannedHandler>(() => reject('needs_email_config'));
    renderNew({
      ...base(),
      list_contacts: ok({ contacts: [{ id: 'ct_1', name: 'Muster AG', email: 'buchhaltung@muster.example' }] }),
      create_document: ok({ document: { id: 'doc_new', type: 'invoice', status: 'draft', totalMinor: 15000 } }),
      issue_invoice: ok({ ...issueFixture }),
      send_invoice: sendSpy,
      get_document: ok({ document: getFixture.document, lines: getFixture.lines, history: getFixture.history }),
      get_contact: ok({ contact: { id: 'ct_1', name: 'Muster AG', email: 'buchhaltung@muster.example' } }),
    });
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await userEvent.type(screen.getByLabelText('Bezeichnung 1'), 'Beratung');
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    const issue = screen.getByRole('button', { name: 'Ausstellen' });
    await waitFor(() => expect(issue).toBeEnabled());
    await userEvent.click(issue);
    const dialog = await screen.findByRole('alertdialog', { name: 'Rechnung ausstellen' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ausstellen und senden' }));
    await waitFor(() => expect(sendSpy).toHaveBeenCalledOnce());
    expect(await screen.findByText(/ist ausgestellt, aber noch nicht an buchhaltung@muster.example versendet/)).toBeInTheDocument();
    expect(screen.getByText(/kein E-Mail-Versand eingerichtet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'PDF herunterladen' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'E-Mail-Versand einrichten' })).toBeInTheDocument();
  });

  it('without an address on file the dialog offers no send line and the confirm stays "Ausstellen"', async () => {
    renderNew({
      ...base(),
      create_document: ok({ document: { id: 'doc_new', type: 'invoice', status: 'draft', totalMinor: 15000 } }),
    });
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await userEvent.type(screen.getByLabelText('Bezeichnung 1'), 'Beratung');
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    const issue = screen.getByRole('button', { name: 'Ausstellen' });
    await waitFor(() => expect(issue).toBeEnabled());
    await userEvent.click(issue);
    const dialog = await screen.findByRole('alertdialog', { name: 'Rechnung ausstellen' });
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Ausstellen' })).toBeInTheDocument();
  });
});

describe('DocumentEditor, the customer typed inline (friction ledger F-03, J1.1 step 5)', () => {
  it('with no contact at all, the customer is created here, with the customer role, and the draft survives', async () => {
    const createSpy = vi.fn<CannedHandler>((input) => ok({ contact: { id: 'ct_new', name: input.name, partyRole: 'customer', email: null } }));
    renderNew({ ...base(), list_contacts: ok({ contacts: [] }), create_contact: createSpy });
    // The draft is started BEFORE the customer exists: the line must still be there afterwards.
    await userEvent.type(await screen.findByLabelText('Bezeichnung 1'), 'Beratung September');
    expect(screen.queryByRole('link', { name: 'Zu den Kontakten' })).toBeNull();
    await userEvent.type(screen.getByLabelText('Name des Kunden'), 'Mara Design GmbH');
    await userEvent.click(screen.getByRole('button', { name: 'Kunde anlegen' }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    expect(createSpy.mock.calls[0][0]).toMatchObject({ partyRole: 'customer', name: 'Mara Design GmbH' });
    // Created AND selected, said in words; the draft's line is untouched.
    expect(await screen.findByText('Mara Design GmbH ist als Kunde angelegt und ausgewählt.')).toBeInTheDocument();
    expect(screen.getByLabelText('Kunde')).toHaveTextContent('Mara Design GmbH');
    expect(screen.getByLabelText('Bezeichnung 1')).toHaveValue('Beratung September');
  });

  // Critic F7: the key was minted per call, so a retry after a lost response made a second contact
  // with the same name (the engine deduplicates nothing by name). Put `idemKey('contact-create')`
  // back and the two keys differ.
  it('"Kunde anlegen" retried after a lost response carries the SAME key, so the engine replays instead of duplicating', async () => {
    let attempts = 0;
    const createSpy = vi.fn<CannedHandler>((input) => {
      attempts += 1;
      if (attempts === 1) return { status: 0, body: { ok: false, error: 'transport_error' } };
      return ok({ contact: { id: 'ct_new', name: input.name, partyRole: 'customer', email: null } });
    });
    renderNew({ ...base(), list_contacts: ok({ contacts: [] }), create_contact: createSpy });
    await userEvent.type(await screen.findByLabelText('Name des Kunden'), 'Bergblick AG');
    await userEvent.click(screen.getByRole('button', { name: 'Kunde anlegen' }));
    expect(await screen.findByText(/Der Kunde konnte nicht angelegt werden/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Kunde anlegen' }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(2));
    const [first, second] = createSpy.mock.calls;
    expect(typeof first?.[0].idempotencyKey).toBe('string');
    expect(second?.[0].idempotencyKey).toBe(first?.[0].idempotencyKey);
    expect(await screen.findByText('Bergblick AG ist als Kunde angelegt und ausgewählt.')).toBeInTheDocument();
  });

  it('once a create has answered, creating the same name again is a NEW act with a new key, never a replay', async () => {
    let n = 0;
    const createSpy = vi.fn<CannedHandler>((input) => {
      n += 1;
      return ok({ contact: { id: `ct_new${n}`, name: input.name, partyRole: 'customer', email: null } });
    });
    renderNew({ ...base(), create_contact: createSpy });
    await screen.findByLabelText('Kunde');
    await userEvent.click(screen.getByRole('button', { name: 'Neuer Kunde' }));
    await userEvent.type(screen.getByLabelText('Name des Kunden'), 'Bergblick AG{Enter}');
    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole('button', { name: 'Neuer Kunde' }));
    await userEvent.type(screen.getByLabelText('Name des Kunden'), 'Bergblick AG{Enter}');
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(2));
    const [first, second] = createSpy.mock.calls;
    expect(second?.[0].idempotencyKey).not.toBe(first?.[0].idempotencyKey);
  });

  it('with contacts on file, "Neuer Kunde" reveals the same inline form beside the picker', async () => {
    const createSpy = vi.fn<CannedHandler>((input) => ok({ contact: { id: 'ct_2', name: input.name, partyRole: 'customer', email: null } }));
    renderNew({ ...base(), create_contact: createSpy });
    await screen.findByLabelText('Kunde');
    await userEvent.click(screen.getByRole('button', { name: 'Neuer Kunde' }));
    await userEvent.type(screen.getByLabelText('Name des Kunden'), 'Neukunde AG{Enter}');
    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByLabelText('Kunde')).toHaveTextContent('Neukunde AG'));
  });

  it('without manage_master_data the inline create is absent and the honest link remains', async () => {
    renderNew({ ...base(), list_contacts: ok({ contacts: [] }) }, '/documents/new', ['issue']);
    expect(await screen.findByRole('link', { name: 'Zu den Kontakten' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Name des Kunden')).toBeNull();
  });
});

describe('DocumentEditor, issue flow (S2 -> S4)', () => {
  it('persists the draft, opens the confirm dialog, and issues an INVOICE through issue_invoice', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_new', type: 'invoice', status: 'draft', totalMinor: 15000 } }));
    const issueSpy = vi.fn<CannedHandler>(() => ok({ ...issueFixture }));
    const transitionSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_new', status: 'issued' } }));
    renderNew({
      ...base(),
      create_document: createSpy,
      issue_invoice: issueSpy,
      transition_document: transitionSpy,
      get_document: ok({ document: getFixture.document, lines: getFixture.lines, history: getFixture.history }),
      get_contact: ok({ contact: { id: 'ct_1', name: 'Muster AG' } }),
    });

    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await userEvent.type(screen.getByLabelText('Bezeichnung 1'), 'Beratung');
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');

    const issue = screen.getByRole('button', { name: 'Ausstellen' });
    await waitFor(() => expect(issue).toBeEnabled());
    // Issuing an invoice posts, so it is the tinted money commit (K-08, D137).
    expect(issue).toHaveClass('btn--accent');
    await userEvent.click(issue);

    // The draft is persisted, then S4 states what will happen; nothing posts until confirmed.
    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    const dialog = await screen.findByRole('alertdialog', { name: 'Rechnung ausstellen' });
    expect(issueSpy).not.toHaveBeenCalled();
    // The confirm carries the same tint as the button that opened it: the invoice issue posts, so
    // the money accent, attributed to the posting verbs (K-08, the C2 money critic, F5).
    const confirmInvoice = within(dialog).getByRole('button', { name: 'Ausstellen' });
    expect(confirmInvoice).toHaveClass('btn--accent');
    expect(confirmInvoice).toHaveAttribute('data-money-commit', 'issue_invoice issue_credit_note');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Ausstellen' }));
    // An invoice posts, so it goes through A11's issue_invoice (the verb that composes guard +
    // gap-free number + QR reference + the balanced entry), never A10's generic transition.
    await waitFor(() => expect(issueSpy).toHaveBeenCalledOnce());
    expect(issueSpy.mock.calls[0][0]).toMatchObject({ invoiceId: 'doc_new' });
    expect(transitionSpy).not.toHaveBeenCalled();
  });

  it('issues a QUOTE through A10 transition_document: issuing one posts nothing', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_q', type: 'quote', status: 'draft' } }));
    const issueSpy = vi.fn<CannedHandler>(() => ok({ ...issueFixture }));
    const transitionSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_q', status: 'issued' } }));
    renderNew(
      { ...base(), create_document: createSpy, issue_invoice: issueSpy, transition_document: transitionSpy },
      '/documents/new?type=quote',
    );

    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ausstellen' })).toBeEnabled());
    // Issuing a quote books nothing: the editor's one primary, never the money accent (K-08, C2 F2).
    expect(screen.getByRole('button', { name: 'Ausstellen' })).toHaveClass('btn--primary');
    expect(screen.getByRole('button', { name: 'Ausstellen' })).not.toHaveClass('btn--accent');
    await userEvent.click(screen.getByRole('button', { name: 'Ausstellen' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Beleg ausstellen' });
    // The quote dialog states only the number line: no posting, no VAT, no irrelevant content.
    expect(within(dialog).getByText('Die Offerte wird ausgestellt und erhält eine Nummer.')).toBeInTheDocument();
    // Issuing a quote posts nothing, so the confirm is the dialog's primary, never the money accent,
    // the same tint as the editor's "Ausstellen" that opened it (the C2 money critic, F5).
    const confirmQuote = within(dialog).getByRole('button', { name: 'Ausstellen' });
    expect(confirmQuote).toHaveClass('btn--primary');
    expect(confirmQuote).not.toHaveClass('btn--accent');
    expect(confirmQuote).not.toHaveAttribute('data-money-commit');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ausstellen' }));
    await waitFor(() => expect(transitionSpy).toHaveBeenCalledOnce());
    expect(issueSpy).not.toHaveBeenCalled();
  });

  it('saves a draft via create_document', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_new' } }));
    renderNew({ ...base(), create_document: createSpy });
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await userEvent.type(screen.getByLabelText('Bezeichnung 1'), 'Beratung');
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    expect(createSpy.mock.calls[0][0]).toMatchObject({ type: 'invoice', contactId: 'ct_1' });
  });
});

describe('DocumentEditor, creating the draft is one act with one key (wave B-2 lesson)', () => {
  /**
   * An engine-faithful create: `rememberIdempotent` replays the stored result for a known key and
   * ignores the input, and a refusal is stored like any result. `lose` drops the first answer on the
   * wire AFTER the draft was created, which is the case a fresh key per call turned into two drafts.
   */
  function memoCreate(opts: { lose?: number; refuseFirst?: boolean } = {}) {
    const stored = new Map<string, RestResponse>();
    const drafts: Record<string, unknown>[] = [];
    let calls = 0;
    const spy = vi.fn<CannedHandler>((input) => {
      calls += 1;
      const key = String(input.idempotencyKey);
      let result = stored.get(key);
      if (result === undefined) {
        if (opts.refuseFirst === true && calls === 1) {
          result = reject('invalid_input');
        } else {
          drafts.push(input);
          result = ok({ document: { id: `doc_${drafts.length}`, type: 'invoice', status: 'draft' } });
        }
        stored.set(key, result);
      }
      if (opts.lose !== undefined && calls <= opts.lose) return { status: 0, body: { ok: false, error: 'transport_error' } };
      return result;
    });
    return { spy, drafts };
  }

  async function fillAndSave() {
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await userEvent.type(screen.getByLabelText('Bezeichnung 1'), 'Beratung');
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
  }

  it('a save retried after a lost answer carries the SAME key, and the engine holds ONE draft', async () => {
    const create = memoCreate({ lose: 1 });
    const updateSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_1', type: 'invoice', status: 'draft' } }));
    renderNew({ ...base(), create_document: create.spy, update_document: updateSpy });
    await fillAndSave();
    await waitFor(() => expect(create.spy).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(create.spy).toHaveBeenCalledTimes(2));
    const [first, second] = create.spy.mock.calls;
    expect(typeof first?.[0].idempotencyKey).toBe('string');
    expect(second?.[0].idempotencyKey).toBe(first?.[0].idempotencyKey);
    expect(create.drafts).toHaveLength(1);
    // Same content both times, so no follow-up write was needed.
    expect(updateSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText('Nicht gespeichert')).not.toBeInTheDocument());

    // The draft exists now: the next save is an update of it, never a second create.
    await userEvent.type(screen.getByLabelText('Bezeichnung 1'), ' Oktober');
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(updateSpy).toHaveBeenCalledOnce());
    expect(updateSpy.mock.calls[0][0]).toMatchObject({ documentId: 'doc_1' });
    expect(create.spy).toHaveBeenCalledTimes(2);
    expect(create.drafts).toHaveLength(1);
  });

  it('a draft edited between the lost save and its retry is written as it now stands, still ONE draft', async () => {
    const create = memoCreate({ lose: 1 });
    const updateSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_1', type: 'invoice', status: 'draft' } }));
    renderNew({ ...base(), create_document: create.spy, update_document: updateSpy });
    await fillAndSave();
    await waitFor(() => expect(create.spy).toHaveBeenCalledTimes(1));
    await userEvent.type(screen.getByLabelText('Bezeichnung 1'), ' Oktober');
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));

    await waitFor(() => expect(updateSpy).toHaveBeenCalledOnce());
    // The retry replayed the FIRST attempt's draft (the old text), so the screen's text follows it.
    expect(create.spy.mock.calls[1]?.[0].idempotencyKey).toBe(create.spy.mock.calls[0]?.[0].idempotencyKey);
    expect(create.drafts).toHaveLength(1);
    const patch = (updateSpy.mock.calls[0][0] as { documentId: string; patch: { lines: { description: string }[] } });
    expect(patch.documentId).toBe('doc_1');
    expect(patch.patch.lines[0]?.description).toBe('Beratung Oktober');
  });

  it('a refused create ends the act: the next save is a new act with a new key, never the stored refusal', async () => {
    const create = memoCreate({ refuseFirst: true });
    renderNew({ ...base(), create_document: create.spy });
    await fillAndSave();
    await waitFor(() => expect(create.spy).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(create.spy).toHaveBeenCalledTimes(2));
    const [first, second] = create.spy.mock.calls;
    expect(second?.[0].idempotencyKey).not.toBe(first?.[0].idempotencyKey);
    expect(create.drafts).toHaveLength(1);
  });
});

describe('DocumentEditor, error state', () => {
  it('surfaces a transport failure on save without destroying entered input (M38)', async () => {
    renderNew({ ...base(), create_document: reject('store_busy') });
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    const desc = screen.getByLabelText('Bezeichnung 1');
    await userEvent.type(desc, 'Beratung');
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    // The typed value survives the failed save.
    expect(desc).toHaveValue('Beratung');
  });

  // A10-G4: a permission_denied on a write must name the missing capability inline (D15/C3),
  // not render the raw label "Ausstellen" (the old i18n-key bug).
  it('names the missing capability on a permission-denied write, never the bare "Ausstellen" (A10-G4)', async () => {
    renderNew({ ...base(), create_document: reject('permission_denied', 403) });
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await userEvent.type(screen.getByLabelText('Bezeichnung 1'), 'Beratung');
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Dir fehlt die Berechtigung, Belege zu erstellen oder zu bearbeiten.');
    expect(alert).not.toHaveTextContent(/^Ausstellen$/);
  });
});

describe('DocumentEditor, delete a draft (A10-G3)', () => {
  const draftDoc = {
    document: { id: 'doc_1', type: 'quote', status: 'draft', contactId: 'ct_1', currency: 'CHF', notes: null, totalMinor: 15000, sourceDocumentId: null },
    lines: [{ description: 'Beratung', quantityMilli: 1000, unitPriceMinor: 15000, taxCode: 'UST81' }],
    history: [],
  };

  // A10-G3: the editor overflow "Löschen" must go through the same ConfirmDialog the list uses,
  // never delete on a single click. The transition fires only AFTER the explicit confirm.
  it('routes overflow Löschen through a confirm dialog before cancelling', async () => {
    const transitionSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_1', status: 'cancelled' } }));
    renderNew(
      { ...base(), get_document: ok(draftDoc), transition_document: transitionSpy },
      '/documents/doc_1',
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Aktionen für Entwurf' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Löschen' }));

    // The confirm appears and NOTHING is cancelled yet.
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Diesen Entwurf löschen?')).toBeInTheDocument();
    expect(transitionSpy).not.toHaveBeenCalled();

    // Confirming fires the cancel transition.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Löschen' }));
    await waitFor(() => expect(transitionSpy).toHaveBeenCalledOnce());
    expect(transitionSpy.mock.calls[0][0]).toMatchObject({ documentId: 'doc_1', to: 'cancelled' });
  });

  it('cancels the delete: the confirm dialog closes and nothing is cancelled', async () => {
    const transitionSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_1', status: 'cancelled' } }));
    renderNew(
      { ...base(), get_document: ok(draftDoc), transition_document: transitionSpy },
      '/documents/doc_1',
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Aktionen für Entwurf' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Löschen' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(transitionSpy).not.toHaveBeenCalled();
  });
});

/**
 * The A10 findings this GUI folds in. Each one was measured on the running surface by the
 * /ux-architect gate and logged for A11 because A11 extends exactly these files.
 */
describe('DocumentEditor, folded A10 findings', () => {
  const savedDraft = {
    document: {
      id: 'doc_1',
      type: 'invoice',
      status: 'draft',
      contactId: 'ct_1',
      currency: 'CHF',
      notes: 'alte Notiz',
      dueDate: null,
      totalMinor: 15000,
      sourceDocumentId: null,
    },
    lines: [{ description: 'Beratung', quantityMilli: 1000, unitPriceMinor: 15000, taxCode: 'UST81' }],
    history: [],
  };

  // A10-D1/G2: issuing a draft reached AT its own url used to leave the stale editor on screen,
  // because the route's status probe keyed on `id` alone and `id` never changed. The swap to the
  // immutable detail must happen without the operator navigating anywhere.
  it('swaps the stale editor for the immutable detail after an in-place issue (A10-D1/G2)', async () => {
    let issued = false;
    const issueSpy = vi.fn<CannedHandler>(() => {
      issued = true;
      return ok({ ...issueFixture });
    });
    renderNew(
      {
        ...base(),
        get_document: () =>
          issued
            ? ok({
                document: { ...savedDraft.document, status: 'issued', number: 'R-2026-0001', postedEntryId: 'entry_1' },
                lines: savedDraft.lines,
                history: [{ fromStatus: 'draft', toStatus: 'issued', actor: 'user_1', at: '2026-07-16T00:00:00.000Z' }],
              })
            : ok(savedDraft),
        get_contact: ok({ contact: { id: 'ct_1', name: 'Muster AG' } }),
        update_document: ok({ document: savedDraft.document }),
        issue_invoice: issueSpy,
      },
      '/documents/doc_1',
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Ausstellen' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Rechnung ausstellen' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ausstellen' }));
    await waitFor(() => expect(issueSpy).toHaveBeenCalledOnce());

    // The immutable detail is on screen, and the draft's editable controls are gone: no stale form
    // over an already-posted document.
    expect(await screen.findByRole('heading', { name: /R-2026-0001/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Entwurf speichern' })).not.toBeInTheDocument();
  });

  // A10-G9: editing a saved draft and leaving used to drop the edit silently.
  it('guards an unsaved edit on the way out, and keeps it when you stay (A10-G9)', async () => {
    renderNew(
      { ...base(), get_document: ok(savedDraft), update_document: ok({ document: savedDraft.document }) },
      '/documents/doc_1',
    );

    const notes = await screen.findByLabelText('Notiz');
    expect(screen.queryByText('Nicht gespeichert')).not.toBeInTheDocument();
    await userEvent.type(notes, ' geändert');
    expect(screen.getByText('Nicht gespeichert')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: 'Zurück zu den Belegen' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Du hast Änderungen, die noch nicht gespeichert sind. Verwerfen?')).toBeInTheDocument();

    // Staying keeps every character: nothing is discarded behind the operator's back.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Weiter bearbeiten' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Notiz')).toHaveValue('alte Notiz geändert');
  });

  it('clears the unsaved marker once the draft is saved (A10-G9)', async () => {
    renderNew(
      { ...base(), get_document: ok(savedDraft), update_document: ok({ document: savedDraft.document }) },
      '/documents/doc_1',
    );
    await userEvent.type(await screen.findByLabelText('Notiz'), '!');
    expect(screen.getByText('Nicht gespeichert')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(screen.queryByText('Nicht gespeichert')).not.toBeInTheDocument());
  });

  // A10-G7: convert lands on a DRAFT, which mounts this editor, so the origin toast that lived only
  // on the detail never rendered. The M20 acceptance is "Aus Offerte O-2026-0001 erstellt".
  it('renders the convert-origin toast on the target draft (A10-G7)', async () => {
    const client = new TillClient(fakeTransport({ ...base(), get_document: ok(savedDraft) }));
    render(
      <TillClientProvider client={client}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter initialEntries={[{ pathname: '/documents/doc_1', state: { fromNumber: 'O-2026-0001' } }]}>
              <Routes>
                <Route path="/documents/*" element={<DocumentsSurface />} />
              </Routes>
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await screen.findByLabelText('Notiz');
    const toast = screen.getByText('Aus O-2026-0001 erstellt');
    expect(toast).toBeInTheDocument();
    // Announced, not merely drawn: an operator who did not watch the navigation still learns it.
    // The role lives on the shared ActionFeedback banner that wraps the message.
    expect(toast.closest('.action-feedback')).toHaveAttribute('role', 'status');
  });
});

describe('DocumentEditor, the constrained credit-note mode (A13 §4b.1)', () => {
  const creditDraft = {
    document: {
      id: 'doc_cn',
      type: 'credit_note',
      status: 'draft',
      contactId: 'ct_1',
      currency: 'CHF',
      notes: null,
      dueDate: null,
      totalMinor: 15000,
      sourceDocumentId: null,
      creditedDocumentId: 'doc_inv',
    },
    lines: [
      {
        description: 'Beratung',
        quantityMilli: 1000,
        unitPriceMinor: 15000,
        taxCode: 'UST81',
        creditedLinePosition: 1,
      },
    ],
    history: [],
  };

  it('renders the derived positions READ-ONLY under the derivation notice, and patches only notes/dueDate', async () => {
    const updateSpy = vi.fn<CannedHandler>(() => ok(creditDraft));
    const client = new TillClient(
      fakeTransport({ ...base(), get_document: ok(creditDraft), update_document: updateSpy }),
    );
    render(
      <TillClientProvider client={client}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter initialEntries={['/documents/doc_cn']}>
              <Routes>
                <Route path="/documents/*" element={<DocumentsSurface />} />
              </Routes>
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    // The notice and the remedy: the selection changes by re-deriving, never by editing lines here.
    await screen.findByText(/aus der Rechnung abgeleitet/);
    expect(screen.getByText(/neue Gutschrift aus der Rechnung/)).toBeInTheDocument();
    // No line inputs exist at all: the position renders as text, so no save can rewrite the
    // attribution the per-class closure rests on (the round-3 H1 lesson, made structural).
    expect(screen.queryByLabelText('Beschreibung 1')).toBeNull();
    expect(screen.queryByLabelText('Einzelpreis 1')).toBeNull();
    expect(screen.getByText('Beratung')).toBeInTheDocument();
    // No add-line control either.
    expect(screen.queryByRole('button', { name: 'Position hinzufügen' })).toBeNull();

    // Saving sends ONLY the fields the derivation does not own.
    await userEvent.type(screen.getByLabelText('Notiz'), 'Kulanz');
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    const patch = updateSpy.mock.calls[0]![0].patch as Record<string, unknown>;
    expect(patch.lines).toBeUndefined();
    expect(patch.currency).toBeUndefined();
    expect(patch.contactId).toBeUndefined();
    expect(patch.notes).toBe('Kulanz');
  });

  it('issues a credit note through issue_credit_note, the named verb (D14 parity)', async () => {
    const issueSpy = vi.fn<CannedHandler>(() =>
      ok({ document: { ...creditDraft.document, status: 'issued', number: 'G-2026-0001' } }),
    );
    const client = new TillClient(
      fakeTransport({
        ...base(),
        get_document: ok(creditDraft),
        update_document: ok(creditDraft),
        issue_credit_note: issueSpy,
      }),
    );
    render(
      <TillClientProvider client={client}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter initialEntries={['/documents/doc_cn']}>
              <Routes>
                <Route path="/documents/*" element={<DocumentsSurface />} />
              </Routes>
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await screen.findByText(/aus der Rechnung abgeleitet/);
    await userEvent.click(screen.getByRole('button', { name: 'Ausstellen' }));
    // S4 opens; confirming reaches the credit-note verb, never a bare transition. The dialog's
    // confirm carries the same word as the page action, so it is found inside the dialog.
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ausstellen' }));
    await waitFor(() => expect(issueSpy).toHaveBeenCalledTimes(1));
    expect(issueSpy.mock.calls[0]![0].creditNoteId).toBe('doc_cn');
  });

  it('states the DIRECTION of the posting on the last screen before it happens', async () => {
    // An invoice and a Gutschrift post opposite money, and this dialog said "Eine Buchung über
    // CHF x wird erstellt" for both. On the last screen before an irreversible posting, a sentence
    // that is equally true of a charge and of a refund is not a confirmation.
    const client = new TillClient(
      fakeTransport({ ...base(), get_document: ok(creditDraft), update_document: ok(creditDraft) }),
    );
    render(
      <TillClientProvider client={client}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter initialEntries={['/documents/doc_cn']}>
              <Routes>
                <Route path="/documents/*" element={<DocumentsSurface />} />
              </Routes>
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await screen.findByText(/aus der Rechnung abgeleitet/);
    await userEvent.click(screen.getByRole('button', { name: 'Ausstellen' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Gutschrift ausstellen')).toBeInTheDocument();
    expect(within(dialog).getByText(/reduziert die Forderung an den Kunden/)).toBeInTheDocument();
  });
});
