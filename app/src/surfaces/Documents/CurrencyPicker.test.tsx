/**
 * The currency picker (M11-M13), driven through the REAL invoice editor rather than the component in
 * isolation, so the tests prove the composition: the picker's state reaches the issue gate, and the
 * readiness checklist and the control agree about the payment part.
 *
 * Every canned response is an arm of `exchange-rate.fixture.json`, which
 * `test/sales/currency-picker-fixture.test.mjs` pins to the live engine, keys and kinds. Nothing
 * here is a shape anyone believed the engine returns.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { hang, watchReads } from '../../test-transport';
import DocumentsSurface from './index';
import profileFixture from '../Setup/company-profile.fixture.json';
import rateFixture from './exchange-rate.fixture.json';

type Canned = Record<string, RestResponse | ((input: Record<string, unknown>) => RestResponse)>;

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
/** An engine answer passed through verbatim: the fixture arms already carry their own `ok` flag. */
const verbatim = (body: Record<string, unknown>, status = 200): RestResponse => ({
  status,
  body: body as RestResponse['body'],
});

const TAX_CODES = [
  { code: 'UST81', kind: 'output', rateBp: 810, formLine: '303', label: 'Normalsatz 8.1%', active: true },
];

const CONTACT = {
  id: 'ct_1',
  name: 'Muster AG',
  email: 'kunde@example.ch',
  paymentTermsDays: 30,
  address: { street: 'Musterweg', houseNo: '7', zip: '3000', city: 'Bern', country: 'CH' },
};

/** A plain (non-QR) IBAN: valid, mod-97 clean, QR-IID outside 30000-31999, so it yields SCOR. */
const PLAIN_IBAN = 'CH9300762011623852957';

function renderEditor(canned: Canned, initial = '/documents/new?type=invoice') {
  const client = new TillClient(fakeTransport(canned));
  return render(
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
    </TillClientProvider>,
  );
}

const base = (extra: Canned = {}): Canned => ({
  list_contacts: ok({ contacts: [CONTACT] }),
  vat_codes: ok({ taxCodes: TAX_CODES }),
  get_company_profile: ok({ profile: profileFixture.profile }),
  list_exchange_rates: verbatim(rateFixture.list),
  get_exchange_rate: verbatim(rateFixture.base),
  vat_preview: ok({
    kind: 'output',
    netMinor: 15000,
    taxMinor: 1215,
    grossMinor: 16215,
    rateBp: 810,
    deductible: false,
    formLine: '303',
    trace: { taxCode: 'UST81', taxBaseMinor: 15000, taxAmountMinor: 1215 },
  }),
  ...extra,
});

async function pickEur() {
  await userEvent.selectOptions(await screen.findByLabelText('Währung'), 'EUR');
}

describe('CurrencyPicker, the five states', () => {
  it('LOADING: the control is disabled while the editor resolves its own reads', async () => {
    const transport = watchReads(hang('list_contacts', async () => ok()));
    const client = new TillClient(transport);
    render(
      <TillClientProvider client={client}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter initialEntries={['/documents/new?type=invoice']}>
              <Routes>
                <Route path="/documents/*" element={<DocumentsSurface />} />
              </Routes>
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    // The editor paints its skeleton on the first commit, so the assertions below would hold just
    // as well over an editor that never read a contact. Waiting for the read makes them a claim
    // about a load in progress rather than about a first render.
    await transport.started('list_contacts');
    // The skeleton stands in for the whole editor while it loads, so the control is not on screen at
    // all yet: a control you can operate before its options have arrived is worse than none.
    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(screen.queryByLabelText('Währung')).not.toBeInTheDocument();
  });

  it('EMPTY: with no recorded rates the picker still offers the base currency and EUR', async () => {
    renderEditor(base({ list_exchange_rates: ok({ rates: [] }) }));
    const select = (await screen.findByLabelText('Währung')) as HTMLSelectElement;
    const values = [...select.options].map((o) => o.value);
    expect(values).toEqual(['CHF', 'EUR', '__other__']);
    // The base currency is labelled as such, so the common case is recognisable rather than a bare code.
    expect(within(select).getByText('CHF (Buchwährung)')).toBeInTheDocument();
  });

  it('LOADED: the recorded pairs become options, so a workspace bills what it has rates for', async () => {
    renderEditor(
      base({
        list_exchange_rates: ok({
          rates: [
            { ...rateFixture.list.rates[0], baseCurrency: 'USD', id: 'fxrate_2' },
            rateFixture.list.rates[0],
          ],
        }),
      }),
    );
    // The recorded pairs arrive on their own read, so the option list grows a tick after the control
    // itself exists. Waiting for the grown list is the point of the test.
    await waitFor(() => {
      const select = screen.getByLabelText('Währung') as HTMLSelectElement;
      expect([...select.options].map((o) => o.value)).toEqual(['CHF', 'EUR', 'USD', '__other__']);
    });
  });

  it('BASE: a CHF invoice shows NO rate, because a rate of 1 is not FX', async () => {
    renderEditor(base());
    expect(await screen.findByText(/CHF ist deine Buchwährung/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Umrechnung')).not.toBeInTheDocument();
    expect(screen.queryByText(/1 CHF = /)).not.toBeInTheDocument();
  });

  it('LOADED: EUR shows the engine rate verbatim, its validity date, its basis and its origin', async () => {
    renderEditor(base({ get_exchange_rate: verbatim(rateFixture.resolved) }));
    await pickEur();

    const panel = await screen.findByLabelText('Umrechnung');
    // The rate string is the engine's own, rendered without reformatting.
    expect(within(panel).getByText('1 EUR = 0.9412 CHF')).toBeInTheDocument();
    expect(within(panel).getByText('15.07.2026')).toBeInTheDocument();
    expect(within(panel).getByText('Tageskurs (Verkauf von Devisen)')).toBeInTheDocument();
    expect(within(panel).getByText('Von Hand erfasst')).toBeInTheDocument();
    // What will happen, said before it happens. No converted amount is claimed.
    expect(within(panel).getByText(/verbucht TILL diese Rechnung zu diesem Kurs in CHF/)).toBeInTheDocument();
  });

  it('ERROR (M12): needs_fx_rate names the pair and the date, and blocks Ausstellen with the reason inline', async () => {
    renderEditor(base({ get_exchange_rate: verbatim(rateFixture.needsRateEmpty, 422) }));
    await userEvent.selectOptions(await screen.findByLabelText('Kunde'), 'ct_1');
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    await pickEur();

    const panel = await screen.findByLabelText('Umrechnung');
    // The panel carries the SPECIFIC fact (rates exist, none covers this date) and the cure.
    expect(within(panel).getByText(/keiner deckt dieses Datum ab/)).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Kurs erfassen' })).toHaveAttribute('href', '/setup');

    // D15/C3: the control is pre-disabled with the reason beside it, never shown then rejected.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ausstellen' })).toBeDisabled());
    expect(screen.getByText('Für EUR fehlt ein Kurs auf den 16.07.2026.')).toBeInTheDocument();

    /*
     * A11-G14: and it says it ONCE. The panel used to open with "Für EUR liegt kein zulässiger Kurs
     * auf den 16.07.2026 vor. Ohne Kurs kannst du die Rechnung nicht ausstellen.", which is the same
     * currency, the same date and the same consequence the disabled button already carries three
     * inches away. Repetition reads as two separate problems.
     */
    expect(within(panel).queryByText(/liegt kein zulässiger Kurs/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/kannst du die Rechnung nicht ausstellen/)).not.toBeInTheDocument();
  });

  it('ERROR (M12): a QUOTE without a rate is not blocked, and the copy does not claim it is', async () => {
    // Issuing a quote posts nothing, so no rate is needed to issue one. Saying "you cannot issue
    // this" would send its operator hunting for a rate they do not need yet, and the rate genuinely
    // does matter for the invoice the quote becomes, so the panel says that instead.
    renderEditor(base({ get_exchange_rate: verbatim(rateFixture.needsRateEmpty, 422) }), '/documents/new?type=quote');
    await userEvent.selectOptions(await screen.findByLabelText('Kunde'), 'ct_1');
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    await pickEur();

    const panel = await screen.findByLabelText('Umrechnung');
    expect(within(panel).getByText(/Diesen Beleg kannst du trotzdem ausstellen, er verbucht nichts/)).toBeInTheDocument();
    expect(within(panel).queryByText(/kannst du die Rechnung nicht ausstellen/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ausstellen' })).toBeEnabled());

    // And no payment part is promised either: only an invoice ever gets one (`buildQrBill` refuses
    // every other type), so a quote carries no QR consequence at all.
    expect(screen.queryByText(/Zahlteil/)).not.toBeInTheDocument();
  });

  it('ERROR (M12): a rate that is merely too old says so, and names the newest one on file', async () => {
    renderEditor(base({ get_exchange_rate: verbatim(rateFixture.needsRateStale, 422) }));
    await pickEur();
    const panel = await screen.findByLabelText('Umrechnung');
    expect(within(panel).getByText(/Der neuste Kurs ist vom 15.07.2026 und damit älter als 7 Tage/)).toBeInTheDocument();
  });

  it('ERROR: a locked Steuerperiode names the elected basis and when it can change', async () => {
    renderEditor(
      base({
        get_exchange_rate: verbatim(rateFixture.methodNotElected, 422),
        get_fx_method: verbatim(rateFixture.fxMethodLocked),
      }),
    );
    await userEvent.selectOptions(await screen.findByLabelText('Kunde'), 'ct_1');
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    await pickEur();

    const panel = await screen.findByLabelText('Umrechnung');
    // The engine's refusal carries no currency; the panel supplies the pair it asked about.
    expect(
      within(panel).getByText(/Der Kurs für EUR liegt auf der Basis Tageskurs \(Verkauf von Devisen\)/),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/gilt bei dir aber Monatsmittelkurs/)).toBeInTheDocument();
    // `get_fx_method` is what turns the rule into something actionable: a date it stops binding.
    expect(within(panel).getByText(/Wechseln kannst du erst ab 2027/)).toBeInTheDocument();
    expect(within(panel).getByText(/Erfasse den Kurs auf der Basis Monatsmittelkurs/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ausstellen' })).toBeDisabled());
  });

  it('ERROR: an unreadable rate degrades to a retry, never to a silent rate', async () => {
    renderEditor(base({ get_exchange_rate: { status: 0, body: { ok: false, error: 'transport_error' } } }));
    await pickEur();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Der Kurs konnte nicht geladen werden.');
    expect(within(alert).getByRole('button', { name: 'Erneut versuchen' })).toBeInTheDocument();
  });

  it('DENIED: a refused rate read says so, and never falls back to a rate of 1', async () => {
    renderEditor(base({ get_exchange_rate: { status: 403, body: { ok: false, error: 'permission_denied' } } }));
    await pickEur();
    expect(await screen.findByText('Dir fehlt die Berechtigung, Kurse zu lesen.')).toBeInTheDocument();
    expect(screen.queryByText(/1 EUR = /)).not.toBeInTheDocument();
  });

  it('DENIED: a write-denied editor renders the currency as text, with no control to operate', async () => {
    renderEditor({ ...base(), create_document: { status: 403, body: { ok: false, error: 'permission_denied' } } });
    await userEvent.selectOptions(await screen.findByLabelText('Kunde'), 'ct_1');
    await userEvent.type(screen.getByLabelText('Bezeichnung 1'), 'Beratung');
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));

    await waitFor(() => expect(screen.getByLabelText('Währung').tagName).toBe('SPAN'));
    expect(screen.getByLabelText('Währung')).toHaveTextContent('CHF');
  });
});

describe('CurrencyPicker, the payment-part consequence (M13/ST3)', () => {
  it('a QR-IBAN in CHF promises a QRR reference', async () => {
    renderEditor(base());
    expect(await screen.findByText(/mit einer QR-Referenz/)).toBeInTheDocument();
  });

  it('a plain IBAN promises SCOR, in CHF and in EUR alike', async () => {
    renderEditor(
      base({
        get_company_profile: ok({ profile: { ...profileFixture.profile, creditorIban: PLAIN_IBAN } }),
        get_exchange_rate: verbatim(rateFixture.resolved),
      }),
    );
    expect(await screen.findByText(/mit einer SCOR-Referenz/)).toBeInTheDocument();
    await pickEur();
    expect(await screen.findByText(/mit einer SCOR-Referenz/)).toBeInTheDocument();
  });

  it('no IBAN at all states there is no payment part in ANY currency, and links to Setup', async () => {
    renderEditor(base({ get_company_profile: ok({ profile: { ...profileFixture.profile, creditorIban: null } }) }));
    const note = await screen.findByText(/in keiner Währung einen Zahlteil/);
    expect(note).toBeInTheDocument();
  });

  it('a currency outside CHF/EUR warns at the control and does NOT block issuing', async () => {
    renderEditor(base({ get_exchange_rate: verbatim(rateFixture.resolved) }));
    await userEvent.selectOptions(await screen.findByLabelText('Kunde'), 'ct_1');
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    await userEvent.selectOptions(screen.getByLabelText('Währung'), '__other__');
    await userEvent.type(screen.getByLabelText('Währungscode'), 'USD');

    expect(await screen.findByText(/Den QR-Zahlteil gibt es nur in CHF und EUR/)).toBeInTheDocument();
    // The invoice is not blocked: it issues, posts and renders, it simply gets no payment part.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ausstellen' })).toBeEnabled());
  });

  it('a half-typed currency code never reaches the engine as a currency', async () => {
    const asked: string[] = [];
    renderEditor(
      base({
        get_exchange_rate: (input) => {
          asked.push(String(input.currency));
          return verbatim(rateFixture.resolved);
        },
      }),
    );
    await userEvent.selectOptions(await screen.findByLabelText('Währung'), '__other__');
    await userEvent.type(screen.getByLabelText('Währungscode'), 'US');
    await waitFor(() => expect(screen.getByLabelText('Währungscode')).toHaveValue('US'));
    expect(asked).toEqual([]);

    await userEvent.type(screen.getByLabelText('Währungscode'), 'D');
    await waitFor(() => expect(asked).toEqual(['USD']));
  });

  it('a EUR invoice on a QR-IBAN after the SIX cutover warns, names the remedy, and labels the inference', async () => {
    // The bill is judged by its own issue date, so moving the date past 14.11.2026 is what fires it.
    renderEditor(base({ get_exchange_rate: verbatim(rateFixture.resolved) }));
    await userEvent.clear(await screen.findByLabelText('Datum'));
    await userEvent.type(screen.getByLabelText('Datum'), '2026-11-20');
    await pickEur();

    expect(await screen.findByText(/Ab dem 14.11.2026 trägt eine QR-IBAN nur noch CHF/)).toBeInTheDocument();
    // The remedy is named AND labelled as the inference it is: SIX states no guidance for a creditor
    // who holds only a QR-IBAN, and borrowing the authority of a citation TILL does not have would be
    // the dishonest part of an otherwise sound conclusion.
    expect(screen.getByText(/Das ist unsere Schlussfolgerung/)).toBeInTheDocument();
    expect(screen.getByText(/Die Fassung 2.3 gilt noch bis November 2027/)).toBeInTheDocument();
    // And it still does not block the invoice.
    await userEvent.selectOptions(screen.getByLabelText('Kunde'), 'ct_1');
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ausstellen' })).toBeEnabled());
  });
});

describe('CurrencyPicker reaches the engine', () => {
  it('sends the chosen currency on create, and asks for the rate on the INVOICE date', async () => {
    const asked: Record<string, unknown>[] = [];
    let created: Record<string, unknown> | null = null;
    renderEditor(
      base({
        get_exchange_rate: (input) => {
          asked.push(input);
          return verbatim(rateFixture.resolved);
        },
        create_document: (input) => {
          created = input;
          return ok({ document: { id: 'doc_new', type: 'invoice', status: 'draft' } });
        },
      }),
    );
    await userEvent.clear(await screen.findByLabelText('Datum'));
    await userEvent.type(screen.getByLabelText('Datum'), '2026-07-16');
    await pickEur();
    await waitFor(() => expect(asked.at(-1)).toMatchObject({ currency: 'EUR', date: '2026-07-16' }));

    await userEvent.selectOptions(screen.getByLabelText('Kunde'), 'ct_1');
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(created).not.toBeNull());
    expect(created).toMatchObject({ currency: 'EUR' });
  });

  it('a saved EUR draft reopens in EUR, with the rate resolved for it', async () => {
    renderEditor(
      base({
        get_document: ok({
          document: {
            id: 'doc_1',
            type: 'invoice',
            number: null,
            status: 'draft',
            contactId: 'ct_1',
            currency: 'EUR',
            sourceDocumentId: null,
            targetDocumentId: null,
            postedEntryId: null,
            subtotalMinor: 150000,
            taxMinor: 0,
            totalMinor: 150000,
            issueDate: null,
            dueDate: null,
            sentToEmail: null,
            notes: null,
            createdAt: '2026-07-16T00:00:00.000Z',
          },
          lines: [{ description: 'Beratung', quantityMilli: 10000, unitPriceMinor: 15000, taxCode: 'UST81' }],
          history: [],
        }),
        get_exchange_rate: verbatim(rateFixture.resolved),
      }),
      '/documents/doc_1',
    );
    await waitFor(() => expect(screen.getByLabelText('Währung')).toHaveValue('EUR'));
    expect(await screen.findByText('1 EUR = 0.9412 CHF')).toBeInTheDocument();
  });
});
