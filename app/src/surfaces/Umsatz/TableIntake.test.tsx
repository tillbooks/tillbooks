/**
 * A43 §2 and §3, the table door on `/umsatz`: a CSV goes name, mapping, template (only when none exists),
 * then the review of the document the engine generated, booked with that same document. A mismatch with the
 * saved mapping starts over from the engine's guess. Canned transport, synthetic data: an invented till
 * export, platform and amounts.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { CapabilitiesContext, ALLOW_ALL } from '../../lib/capabilities';
import { WorkspaceProvider } from '../../app/workspace';
import { UmsatzPage, EdgeDays, base64Of } from './Umsatz';
import type { FromTable } from './TableIntake';
// The engine's own list_accounts answer for the shipped chart (pinned by test/accounts/studio-list-accounts-fixture.test.mjs).
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const refusal = (error: string, extra: Record<string, unknown> = {}): RestResponse => ({ status: 422, body: { ok: false, error, ...extra } });

const CSV = 'Datum;Beleg;Betrag\n01.09.2026;K-1;12,50\n02.09.2026;K-2;7,80\n';
const MAPPING = { columns: { day: 'Datum', id: 'Beleg', amount: 'Betrag' }, kindMap: {}, kindDefault: { positive: 'sale', negative: 'refund' }, vat: { mode: 'from_template' }, dateFormat: 'dd.mm.yyyy', decimalSeparator: ',', feeSign: 'deducted', amountSign: 'as_stated' };
const DOC = { schema: 'till-settlement/v1', source: { system: 'laden', processor: 'kasse' }, events: [{ id: 'K-1', kind: 'sale', day: '2026-09-01', currency: 'CHF', amount: '12.50', net: '11.56', vat: { amount: '0.94' } }] };

const fromTable = (extra: Partial<FromTable> = {}): RestResponse =>
  ok({
    system: 'laden',
    processor: 'kasse',
    headers: ['Datum', 'Beleg', 'Betrag'],
    rows: [
      { row: 2, cells: { Datum: '01.09.2026', Beleg: 'K-1', Betrag: '12,50' }, parsed: { id: 'K-1', day: '2026-09-01', kind: 'sale', amountMinor: 1250 } },
      { row: 3, cells: { Datum: '02.09.2026', Beleg: 'K-2', Betrag: '7,80' }, parsed: { code: 'unreadable_day' } },
    ],
    typeCells: [],
    rowCount: 2,
    mappingSource: 'guessed',
    mapping: MAPPING,
    profile: { id: 'generic', label: 'Generic table', docsUrl: null, note: 'check on your own export' },
    templateSaved: true,
    sameAsBooked: [],
    sameIdOtherFigures: [],
    savedMapping: false,
    savedHeadersDiffer: null,
    idRecipeDiffers: false,
    bookedEvents: 0,
    settlement: DOC,
    refusedRows: [],
    totals: { rows: 2, events: 2, amountMinor: 2030 },
    warnings: [],
    ...extra,
  });

const REVIEW = {
  mode: 'file',
  system: 'laden',
  processor: 'kasse',
  period: { from: '2026-07-01', to: '2026-09-30', unit: 'quarter' },
  reviewSha256: 'b'.repeat(64),
  rows: [],
  toBook: 1,
  totals: { turnoverNetMinor: 1156, outputVat: { amountMinor: 94, formLines: ['303'] }, inputVat: { amountMinor: 0, formLines: [] }, ignored: { events: 0, vatMinor: 0 }, test: { events: 0, vatMinor: 0 }, notBooked: { events: 0, vatMinor: 0 } },
  checks: { payouts: { state: 'unknown', payouts: [] }, vat: { state: 'ok', statedMinor: 94, bookedMinor: 94, differing: [] } },
  warnings: [],
};

type Route = RestResponse | ((input: Record<string, unknown>, n: number) => RestResponse);

function renderPage(routes: Record<string, Route>) {
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const transport: Transport = async (action, input) => {
    calls.push({ action, input });
    const route = routes[action];
    if (route === undefined) return refusal('settlement_source_missing');
    return typeof route === 'function' ? route(input, calls.filter((c) => c.action === action).length) : route;
  };
  render(
    <MemoryRouter>
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider initialLocale="de-CH">
          <WorkspaceProvider initialId="ws_test">
            <CapabilitiesContext.Provider value={ALLOW_ALL}>
              <UmsatzPage workspaceId="ws_test" />
            </CapabilitiesContext.Provider>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>
    </MemoryRouter>,
  );
  return calls;
}

async function loadCsv(text = CSV, name = 'kasse.csv') {
  await userEvent.upload(screen.getByTestId('umsatz-file-input'), new File([text], name, { type: 'text/csv' }));
}

async function nameSource() {
  await userEvent.type(await screen.findByLabelText('System'), 'laden');
  await userEvent.type(screen.getByLabelText('Zahlungsanbieter'), 'kasse');
  await userEvent.click(screen.getByRole('button', { name: 'Weiter' }));
}

describe('the table door on /umsatz', () => {
  it('a CSV goes name, mapping, then the review of the generated document; Buchen books that same document', async () => {
    const calls = renderPage({
      get_settlement_table_mapping: ok({ mappings: [] }),
      settlement_from_table: fromTable(),
      set_settlement_table_mapping: ok({ mappingId: 'stltmap_1', changed: true }),
      settlement_review: (input) => (input['content'] !== undefined ? ok(REVIEW) : refusal('settlement_source_missing')),
      import_settlement: ok({ booked: 1 }),
    });
    await loadCsv();
    await nameSource();
    expect(await screen.findByRole('region', { name: 'Spalten zuordnen' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Aus den Spaltennamen erraten' })).toBeInTheDocument();
    expect(screen.getByText('2 Ereignisse aus 2 Zeilen')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'settlement_review' && c.input['content'] !== undefined)).toBe(true));
    const table = calls.find((c) => c.action === 'settlement_from_table');
    expect(table?.input).toMatchObject({ system: 'laden', processor: 'kasse', contentBase64: base64Of(new TextEncoder().encode(CSV)) });
    expect(calls.find((c) => c.action === 'set_settlement_table_mapping')?.input).toMatchObject({ system: 'laden', processor: 'kasse', mapping: MAPPING, headers: ['Datum', 'Beleg', 'Betrag'] });
    const reviewed = calls.find((c) => c.action === 'settlement_review' && c.input['content'] !== undefined);
    expect(JSON.parse(String(reviewed?.input['content']))).toEqual(DOC);
    await userEvent.click(await screen.findByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'import_settlement')).toBe(true));
    expect(calls.find((c) => c.action === 'import_settlement')?.input).toMatchObject({ settlement: DOC, expectReviewSha256: 'b'.repeat(64) });
  });

  it('without a template the template editor comes before the review', async () => {
    renderPage({
      get_settlement_table_mapping: ok({ mappings: [] }),
      settlement_from_table: fromTable({ templateSaved: false, mappingSource: 'saved' }),
      get_settlement_template: ok({ templates: [] }),
      list_accounts: ok({ accounts: listAccountsFixture.accounts }),
      vat_codes: ok({ taxCodes: [] }),
    });
    await loadCsv();
    await nameSource();
    await userEvent.click(await screen.findByRole('button', { name: 'Weiter' }));
    expect(await screen.findByRole('form', { name: 'Buchungsvorlage von laden / kasse' })).toBeInTheDocument();
  });

  it('a file whose headers differ from the saved mapping starts over from the engine guess, and says why', async () => {
    const calls = renderPage({
      get_settlement_table_mapping: ok({ mappings: [{ system: 'laden', processor: 'kasse', profile: {} }] }),
      settlement_from_table: (input) => (input['mapping'] === undefined ? refusal('table_mapping_mismatch', { guessedMapping: MAPPING, headers: ['Datum', 'Beleg', 'Betrag'] }) : fromTable({ mappingSource: 'given' })),
    });
    await loadCsv();
    // The only saved source is picked in the shared Select; no free-text field to mistype.
    expect(await screen.findByRole('combobox', { name: 'Quelle' })).toHaveTextContent('laden · kasse');
    expect(screen.queryByLabelText('System')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(await screen.findByText(/weichen von der gespeicherten Zuordnung/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Deine Zuordnung' })).toBeInTheDocument();
    expect(calls.filter((c) => c.action === 'settlement_from_table').map((c) => c.input['mapping'] !== undefined)).toEqual([false, true]);
  });

  it('replacing a saved mapping waits for a confirm that names the double-booking risk, then sends confirmIdChange', async () => {
    const calls = renderPage({
      get_settlement_table_mapping: ok({ mappings: [{ system: 'laden', processor: 'kasse', profile: {} }] }),
      settlement_from_table: (input) =>
        input['mapping'] === undefined
          ? refusal('table_mapping_mismatch', { guessedMapping: MAPPING, headers: ['Datum', 'Beleg', 'Betrag'] })
          : fromTable({ mappingSource: 'given', savedMapping: true, bookedEvents: 3, savedHeadersDiffer: { missing: ['Kasse'], added: ['Beleg'] } }),
      set_settlement_table_mapping: ok({ mappingId: 'stltmap_1', changed: true }),
    });
    await loadCsv();
    await userEvent.click(await screen.findByRole('button', { name: 'Weiter' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Weiter' }));
    const confirm = await screen.findByRole('group', { name: 'Gespeicherte Zuordnung ersetzen' });
    expect(confirm).toHaveTextContent('3 Ereignisse gebucht');
    expect(calls.some((c) => c.action === 'set_settlement_table_mapping')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Ersetzen' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'set_settlement_table_mapping')).toBe(true));
    expect(calls.find((c) => c.action === 'set_settlement_table_mapping')?.input).toMatchObject({ system: 'laden', processor: 'kasse', confirmIdChange: true });
  });

  it('several saved sources are offered in the Select, with a new source as its own choice', async () => {
    renderPage({
      get_settlement_table_mapping: ok({ mappings: [{ system: 'laden', processor: 'kasse', profile: {} }] }),
      get_settlement_template: ok({ templates: [{ system: 'markt', processor: 'stand' }] }),
    });
    await loadCsv();
    await userEvent.click(await screen.findByRole('combobox', { name: 'Quelle' }));
    expect(screen.getByRole('option', { name: 'laden · kasse' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'markt · stand' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: 'Neue Quelle' }));
    expect(screen.getByLabelText('System')).toHaveValue('');
  });

  it('the preview shows each row as read, refused rows are counted, and the reading choices are controls', async () => {
    renderPage({
      get_settlement_table_mapping: ok({ mappings: [] }),
      settlement_from_table: fromTable({ refusedRows: [{ row: 3, code: 'unreadable_day' }] }),
    });
    await loadCsv();
    await nameSource();
    expect(await screen.findByRole('img', { name: '1 Zeilen abgelehnt' })).toBeInTheDocument();
    expect(screen.getByText(/01\.09\.2026 · Verkauf/)).toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: 'Die ersten Zeilen der Tabelle' })).getByText('Zeile 3: unreadable_day')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Vorzeichen des Betrags' })).toHaveTextContent('Wie in der Tabelle');
    expect(screen.getByRole('combobox', { name: 'Art bei Geldeingang' })).toHaveTextContent('Verkauf');
    expect(screen.getByRole('combobox', { name: 'MWST auf Gebühren' })).toHaveTextContent('Keine');
  });

  it('without the right to post there is the padlock and no file to load', () => {
    render(
      <MemoryRouter>
        <TillClientProvider client={new TillClient(async () => refusal('permission_denied'))}>
          <I18nProvider initialLocale="de-CH">
            <WorkspaceProvider initialId="ws_test">
              <CapabilitiesContext.Provider value={{ ...ALLOW_ALL, can: () => false }}>
                <UmsatzPage workspaceId="ws_test" />
              </CapabilitiesContext.Provider>
            </WorkspaceProvider>
          </I18nProvider>
        </TillClientProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('umsatz-file-input')).toBeNull();
    expect(screen.getByText('Abrechnungsereignisse prüfen braucht das Recht zu buchen.', { exact: false })).toBeInTheDocument();
  });

  it('a legacy workbook is refused in words', async () => {
    renderPage({ get_settlement_table_mapping: ok({ mappings: [] }), settlement_from_table: refusal('xls_unsupported') });
    await loadCsv('ÐÏ\u0011à binary', 'alt.xls');
    await nameSource();
    expect(await screen.findByText('Das ist eine alte oder verschlüsselte Arbeitsmappe. Speichere sie als xlsx oder CSV.')).toBeInTheDocument();
  });

  it('rows whose id is already booked are shown on the mapping step and marked in the review: the same, and the same id with other figures', async () => {
    const row = (eventId: string, status: string) => ({
      eventId,
      kind: 'sale',
      day: '2026-09-01',
      outsidePeriod: false,
      amountMinor: 1250,
      netMinor: 1156,
      vatMinor: 94,
      counterparty: { email: null, name: null, masked: false, document: null, chargeId: null },
      test: false,
      included: true,
      inclusion: { state: 'included', source: 'default', reason: null, actor: null, at: null },
      status,
      reason: null,
      code: status === 'refused' ? 'event_amended' : null,
      sentence: status === 'refused' ? 'this event id was booked before with other figures' : null,
      entryId: status === 'booked' ? 'je_1' : null,
      vatPostedMinor: 94,
      toggleable: status !== 'booked',
      includeVia: 'inclusion',
      derivation: null,
    });
    renderPage({
      get_settlement_table_mapping: ok({ mappings: [] }),
      settlement_from_table: fromTable({
        mappingSource: 'saved',
        sameAsBooked: [{ eventId: 'K-1', row: 2 }],
        sameIdOtherFigures: [{ eventId: 'K-2', row: 3 }],
        warnings: ['1 events are the same as events already booked for this source (rows 2): they book nothing again'],
      }),
      settlement_review: (input) => (input['content'] !== undefined ? ok({ ...REVIEW, rows: [row('K-1', 'booked'), row('K-2', 'refused'), row('K-3', 'to_book')] }) : refusal('settlement_source_missing')),
    });
    await loadCsv();
    await nameSource();
    expect(await screen.findByRole('img', { name: '1 gleich wie schon gebuchte Ereignisse' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '1 mit der ID eines gebuchten Ereignisses, aber anderen Zahlen' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Jede Zeile dieser Datei hat ihre eigene ID (geprüft wird nur diese Datei)' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Die ID enthält einen Betrag/ })).toBeNull();
    expect(screen.getByRole('list', { name: 'Was der Tabellenimport bemerkt hat' })).toHaveTextContent('they book nothing again');
    await userEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(await screen.findByText(/Gleich wie ein schon gebuchtes Ereignis/)).toBeInTheDocument();
    expect(screen.getByText('Gleiche ID, andere Zahlen')).toBeInTheDocument();
  });

  it('a table without an id: the mapping step asks for the id columns, and a live check says whether the composed id is unique', async () => {
    const calls = renderPage({
      get_settlement_table_mapping: ok({ mappings: [] }),
      settlement_from_table: (input) => {
        const id = (input['mapping'] as { columns?: { id?: unknown } } | undefined)?.columns?.id;
        if (id === undefined) {
          return refusal('id_column_missing', {
            headers: ['Datum', 'Beleg', 'Betrag'],
            rows: [{ row: 2, cells: { Datum: '01.09.2026', Beleg: 'K-1', Betrag: '12,50' } }],
            rowCount: 1,
            guessedMapping: { ...MAPPING, columns: { day: 'Datum', amount: 'Betrag' } },
            candidates: ['Datum'],
          });
        }
        const mapping = input['mapping'] as FromTable['mapping'];
        return id === 'Datum' ? fromTable({ mapping, refusedRows: [{ row: 2, code: 'id_not_unique' }, { row: 3, code: 'id_not_unique' }] }) : fromTable({ mapping });
      },
    });
    await loadCsv();
    await nameSource();
    expect(await screen.findByRole('img', { name: 'Noch keine ID: Wähle die Spalten, die jede Zeile unterscheiden (Datum)' })).toBeInTheDocument();
    expect(screen.getByText('K-1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('combobox', { name: 'ID-Teil 1' }));
    await userEvent.click(screen.getByRole('option', { name: 'Datum' }));
    expect(await screen.findByRole('img', { name: '2 Zeilen dieser Datei teilen eine ID (geprüft wird nur diese Datei)' })).toBeInTheDocument();
    // A second part composes the id.
    await userEvent.click(screen.getByRole('combobox', { name: 'ID-Teil 2' }));
    await userEvent.click(screen.getByRole('option', { name: 'Beleg' }));
    // A third part that is the amount: the hint that equal sales in other files read as already booked.
    await userEvent.click(await screen.findByRole('combobox', { name: 'ID-Teil 3' }));
    await userEvent.click(screen.getByRole('option', { name: 'Betrag' }));
    expect(await screen.findByRole('img', { name: 'Die ID enthält einen Betrag: Ein gleicher Verkauf in einer anderen Datei gilt als schon gebucht' })).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => JSON.stringify((c.input['mapping'] as { columns?: unknown } | undefined)?.columns ?? null).includes('"id":["Datum","Beleg"]'))).toBe(true));
  });

  it('a mapping that makes ids otherwise than the booked events waits for a confirm, then every read carries confirmIdChange', async () => {
    const calls = renderPage({
      get_settlement_table_mapping: ok({ mappings: [] }),
      settlement_from_table: (input) => (input['confirmIdChange'] === true ? fromTable() : refusal('event_id_derivation_changed', { bookedEvents: 4, headers: ['Datum', 'Beleg', 'Betrag'], changed: ['id_recipe'], mapping: MAPPING })),
    });
    await loadCsv();
    await nameSource();
    const confirm = await screen.findByRole('group', { name: 'Andere IDs als bei den gebuchten Ereignissen' });
    expect(confirm).toHaveTextContent('4 Ereignisse');
    await userEvent.click(screen.getByRole('button', { name: 'So lesen' }));
    expect(await screen.findByText('2 Ereignisse aus 2 Zeilen')).toBeInTheDocument();
    expect(calls.filter((c) => c.action === 'settlement_from_table').at(-1)?.input['confirmIdChange']).toBe(true);
  });

  it('a JSON file still goes straight to the review', async () => {
    const calls = renderPage({ settlement_review: (input) => (input['content'] !== undefined ? ok(REVIEW) : refusal('settlement_source_missing')) });
    await loadCsv(JSON.stringify(DOC), 'laden.json');
    await waitFor(() => expect(calls.some((c) => c.action === 'settlement_review' && c.input['content'] !== undefined)).toBe(true));
    expect(calls.some((c) => c.action === 'settlement_from_table')).toBe(false);
  });
});

// D206, the whole-day mode: the "lists whole days" choice on the mapping step, the days the engine left out in the
// review, and the first or last day the import holds back until the person says it is complete.
describe('the table door, whole days (D206)', () => {
  const NOID = { ...MAPPING, columns: { day: 'Datum', amount: 'Betrag' } };
  const DAY_DOC = { schema: 'till-settlement/v1', source: { system: 'laden', processor: 'kasse' }, events: [{ id: 'day:2026-09-03#1', kind: 'sale', day: '2026-09-03', currency: 'CHF', amount: '5.00', net: '4.63', vat: { amount: '0.37' } }] };
  const DAYS = [
    { day: '2026-09-01', status: 'in_books', edge: null, rows: [2], file: { events: 1, amountMinor: 1250 }, books: { events: 1, amountMinor: 1250 } },
    { day: '2026-09-02', status: 'differs', edge: null, rows: [3], file: { events: 1, amountMinor: 780 }, books: { events: 2, amountMinor: 1560 } },
    { day: '2026-09-03', status: 'edge_unconfirmed', edge: 'both', rows: [4], file: { events: 1, amountMinor: 500 }, books: null },
  ];
  const reviewRow = {
    rowKey: 'id:day:2026-09-03#1',
    eventId: 'day:2026-09-03#1',
    kind: 'sale',
    day: '2026-09-03',
    outsidePeriod: false,
    amountMinor: 500,
    netMinor: 463,
    vatMinor: 37,
    counterparty: { email: null, name: null, masked: false, document: null, chargeId: null },
    test: false,
    included: true,
    inclusion: { state: 'included', source: 'default', reason: null, actor: null, at: null },
    vatPostedMinor: 0,
    toggleable: true,
    includeVia: 'inclusion',
    derivation: null,
    entryId: null,
    reason: null,
  };
  const reviewOf = (input: Record<string, unknown>): RestResponse => {
    const confirmed = Array.isArray(input['confirmEdgeDays']) && (input['confirmEdgeDays'] as string[]).includes('2026-09-03');
    return ok({
      ...REVIEW,
      toBook: confirmed ? 1 : 0,
      rows: [{ ...reviewRow, status: confirmed ? 'to_book' : 'refused', code: confirmed ? null : 'edge_day_unconfirmed', sentence: confirmed ? null : 'engine words' }],
    });
  };

  it('an id-less table may be read by whole days; the review lists the days left out, and the edge waits for the person', async () => {
    let saved = false;
    const calls = renderPage({
      get_settlement_table_mapping: ok({ mappings: [] }),
      settlement_from_table: (input) => {
        const m = input['mapping'] as Record<string, unknown> | undefined;
        if (!(m === undefined && saved) && (m === undefined || m['wholeDays'] !== true)) return refusal('id_column_missing', { dayModeAvailable: true, headers: ['Datum', 'Betrag'], rows: [], rowCount: 3, guessedMapping: NOID, candidates: ['Datum'] });
        return fromTable({ headers: ['Datum', 'Betrag'], mapping: { ...NOID, wholeDays: true } as FromTable['mapping'], mappingSource: 'given', dayMode: true, days: DAYS as FromTable['days'], settlement: DAY_DOC });
      },
      set_settlement_table_mapping: () => {
        saved = true;
        return ok({ mappingId: 'stltmap_1', changed: true });
      },
      settlement_review: (input) => (input['content'] !== undefined ? reviewOf(input) : refusal('settlement_source_missing')),
      import_settlement: ok({ booked: 1 }),
    });
    await loadCsv('Datum;Betrag\n01.09.2026;12,50\n02.09.2026;7,80\n03.09.2026;5,00\n');
    await nameSource();
    // The choice sits on the id row, its words on hover.
    await userEvent.click(await screen.findByRole('combobox', { name: 'Ohne ID' }));
    await userEvent.click(screen.getByRole('option', { name: 'Listet ganze Tage' }));
    expect(screen.getByRole('img', { name: /nur, wenn der Export immer jede Zeile/ })).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.action === 'settlement_from_table' && (c.input['mapping'] as Record<string, unknown> | undefined)?.['wholeDays'] === true)).toBe(true));
    await userEvent.click(await screen.findByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'set_settlement_table_mapping')).toBe(true));
    expect((calls.find((c) => c.action === 'set_settlement_table_mapping')?.input['mapping'] as Record<string, unknown>)['wholeDays']).toBe(true);
    // The review: one line per day left out, both sides where it differs.
    const days = await screen.findByRole('list', { name: 'Tage der Tabelle' });
    expect(within(days).getByText(/01\.09\.2026 schon im Buch/)).toBeInTheDocument();
    expect(within(days).getByText(/02\.09\.2026 weicht ab: gebucht CHF\s?15\.60, Datei CHF\s?7\.80/)).toBeInTheDocument();
    // The edge day: refused until the person says it is complete; then the review and Buchen carry the answer.
    const edge = screen.getByRole('list', { name: 'Erster und letzter Tag' });
    expect(within(edge).getByText(/03\.09\.2026 ist vielleicht abgeschnitten/)).toBeInTheDocument();
    expect(screen.getByText('erster oder letzter Tag der Datei, wartet auf deine Antwort')).toBeInTheDocument();
    await userEvent.click(within(edge).getByRole('button', { name: '03.09.2026 ist vollständig' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'settlement_review' && Array.isArray(c.input['confirmEdgeDays']))).toBe(true));
    // Critic r1 L3: the confirmed day stays visible, with its undo, until Buchen.
    const confirmed = await screen.findByText(/03\.09\.2026 vollständig, deine Antwort/);
    expect(within(edge).queryByText(/^03\.09\.2026 ist vielleicht abgeschnitten/)).toBeNull();
    expect(within(confirmed.closest('li') as HTMLElement).getByRole('button', { name: 'Rückgängig: 03.09.2026 ist vielleicht abgeschnitten' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'import_settlement')).toBe(true));
    expect(calls.find((c) => c.action === 'import_settlement')?.input).toMatchObject({ confirmEdgeDays: ['2026-09-03'] });
    expect(JSON.stringify(calls.find((c) => c.action === 'import_settlement')?.input['settlement'])).not.toMatch(/complete/);
  });

  it('a payout id with whole days, or a day the engine cannot read, is worded on the mapping step', async () => {
    renderPage({
      get_settlement_table_mapping: ok({ mappings: [] }),
      settlement_from_table: refusal('unreadable_day', { mapping: { ...NOID, wholeDays: true }, headers: ['Datum', 'Betrag'], rows: [], rowCount: 1 }),
    });
    await loadCsv('Datum;Betrag\n31.09.2026;12,50\n');
    await nameSource();
    expect(await screen.findByText(/Ein Tag in dieser Tabelle lässt sich nicht lesen/)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Datumsformat' })).toBeInTheDocument();
  });

  it('a day next to a held day names the amount it shares with it (critic r2 M-A)', () => {
    const near = [{ day: '2026-09-02', status: 'edge_unconfirmed' as const, edge: 'first' as const, rows: [2, 3], file: { events: 2, amountMinor: 1280 }, books: null, nearHeld: { day: '2026-09-01', amountsMinor: [780] } }];
    render(
      <I18nProvider initialLocale="de-CH">
        <EdgeDays days={['2026-09-02', '2026-09-03']} confirmed={[]} near={near} onConfirm={() => {}} onUndo={() => {}} />
      </I18nProvider>,
    );
    expect(screen.getByText(/^02\.09\.2026: CHF 7\.80 ist auch am 01\.09\.2026 gebucht, vielleicht dieselbe Zeile$/)).toBeInTheDocument();
    expect(screen.getByText(/^03\.09\.2026 ist vielleicht abgeschnitten$/)).toBeInTheDocument();
  });
});
