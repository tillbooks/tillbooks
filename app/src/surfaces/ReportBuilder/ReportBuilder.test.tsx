/**
 * The Berichte surface (F01): the human face over the report builder.
 *
 * The suite drives the states the spec's §6 names: the loading skeleton (waiting for the read to have
 * STARTED, `watchReads`, not a vacuous assertion), the empty state with its create CTA, a populated
 * list with the Ausführen action, the create CTA HIDDEN without `reports.write`, and the builder drawer
 * with its column checklist including the "Zusätzliche Felder" group for cf: custom fields. Copy is
 * asserted through the catalogue, never as a literal typed here.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { neverSettles, watchReads } from '../../test-transport';
import ReportBuilder from './index';
import de from './messages.de-CH.json';
import en from './messages.en.json';

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input ?? {}) : entry;
  };
}

const SOURCES = ok({
  sources: [
    {
      id: 'contacts',
      titleI18n: { 'de-CH': 'Kontakte', en: 'Contacts' },
      entityKind: 'contact',
      accountingRecord: false,
      module: 'C00',
      available: true,
      columns: [
        { key: 'name', labelI18n: { 'de-CH': 'Name', en: 'Name' }, type: 'text', custom: false },
        { key: 'email', labelI18n: { 'de-CH': 'E-Mail', en: 'Email' }, type: 'text', custom: false },
        { key: 'cf:segment', labelI18n: { 'de-CH': 'Segment', en: 'Segment' }, type: 'select', custom: true },
      ],
    },
  ],
});

const ONE_REPORT = ok({
  reports: [
    { id: 'r1', name: 'Kontaktliste', source: 'contacts', filters: [], columns: ['name'], format: 'csv', schedule: null, recipients: [], deliveryActive: false, lastRunAt: null },
  ],
});

const EMPTY = { reports_list: ok({ reports: [] }), reports_sources: SOURCES };

function tree(canned: Canned, caps?: Partial<Capabilities>, locale?: 'de-CH' | 'en') {
  const value: Capabilities = { whoami: null, can: () => true, refresh: () => undefined, ...caps };
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider initialLocale={locale}>
        <WorkspaceProvider initialId="ws_test">
          <CapabilitiesContext.Provider value={value}>
            <MemoryRouter>
              <ReportBuilder />
            </MemoryRouter>
          </CapabilitiesContext.Provider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

describe('ReportBuilder (Berichte)', () => {
  it('LOADING: shows the skeleton while the list read is in flight', async () => {
    const transport = watchReads(neverSettles);
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <ReportBuilder />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await transport.started('reports_list');
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('EMPTY: a workspace with no reports says "Noch keine Berichte." and offers the create CTA', async () => {
    render(tree(EMPTY));
    expect(await screen.findByText(de.reportBuilder.empty)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: de.reportBuilder.action.create }).length).toBeGreaterThan(0);
  });

  it('POPULATED: renders the saved report and its Ausführen action', async () => {
    render(tree({ reports_list: ONE_REPORT, reports_sources: SOURCES }));
    expect(await screen.findByText('Kontaktliste')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: de.reportBuilder.action.run })).toBeInTheDocument();
  });

  it('PERMISSION: the create CTA is HIDDEN without reports.write', async () => {
    render(tree(EMPTY, { can: (c) => c !== 'reports.write' }));
    expect(await screen.findByText(de.reportBuilder.empty)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: de.reportBuilder.action.create })).not.toBeInTheDocument();
  });

  it('BUILDER: opening the builder lists base columns and the "Zusätzliche Felder" cf group', async () => {
    render(tree(EMPTY));
    await screen.findByText(de.reportBuilder.empty);
    // Both the header and the empty-state CTA are labelled "Bericht erstellen"; the header opens the drawer.
    await userEvent.click(screen.getAllByRole('button', { name: de.reportBuilder.action.create })[0]);
    expect(screen.getByText(de.reportBuilder.field.additional)).toBeInTheDocument();
    expect(screen.getByLabelText('Segment')).toBeInTheDocument();
    // Speichern is disabled until a name and at least one column are chosen.
    expect(screen.getByRole('button', { name: de.reportBuilder.action.save })).toBeDisabled();
  });

  // K-55: under the EN locale, a server i18n object must show its `en` value, not de-CH.
  it('LOCALE: an EN-locale user sees the English server source label, not the German one', async () => {
    render(tree({ reports_list: ONE_REPORT, reports_sources: SOURCES }, undefined, 'en'));
    await screen.findByText('Kontaktliste');
    // The source cell renders the source title: EN locale must pick titleI18n.en ("Contacts").
    expect(screen.getByText('Contacts')).toBeInTheDocument();
    expect(screen.queryByText('Kontakte')).not.toBeInTheDocument();
  });

  // K-56: opening the schedule editor for an already-weekly report must reflect weekly, and saving
  // untouched must not silently rewrite it to the monthly default.
  it('SCHEDULE: a weekly report opens the editor on weekly and saving untouched preserves it', async () => {
    const WEEKLY = ok({
      reports: [
        {
          id: 'r1',
          name: 'Kontaktliste',
          source: 'contacts',
          filters: [],
          columns: ['name'],
          format: 'csv',
          schedule: 'freq=weekly;at=08:00;weekday=3',
          recipients: ['ops@example.ch'],
          deliveryActive: true,
          lastRunAt: null,
        },
      ],
    });
    let scheduled: Record<string, unknown> | null = null;
    render(
      tree({
        reports_list: WEEKLY,
        reports_sources: SOURCES,
        reports_schedule: (input) => {
          scheduled = input;
          return ok();
        },
      }),
    );
    await screen.findByText('Kontaktliste');
    await userEvent.click(screen.getByRole('button', { name: de.reportBuilder.action.schedule }));
    const freqSelect = screen.getByLabelText(de.reportBuilder.field.frequency) as HTMLSelectElement;
    expect(freqSelect.value).toBe('weekly');
    // The weekday the stored string carried (3) is prefilled, not reset.
    const weekdayInput = screen.getByLabelText(de.reportBuilder.field.weekday) as HTMLInputElement;
    expect(weekdayInput.value).toBe('3');
    await userEvent.click(screen.getByRole('button', { name: de.reportBuilder.action.save }));
    expect(scheduled).not.toBeNull();
    expect((scheduled as unknown as { schedule: { freq: string; weekday: number } }).schedule.freq).toBe('weekly');
    expect((scheduled as unknown as { schedule: { freq: string; weekday: number } }).schedule.weekday).toBe(3);
  });

  // K-57: a failed duplicate must surface the error, mirroring run/delete, not be swallowed.
  it('DUPLICATE: a rejected reports_duplicate shows the error banner', async () => {
    render(
      tree({
        reports_list: ONE_REPORT,
        reports_sources: SOURCES,
        reports_duplicate: { status: 422, body: { ok: false, error: 'permission_denied' } },
      }),
    );
    await screen.findByText('Kontaktliste');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: de.reportBuilder.action.duplicate }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  // K-59: the builder title reflects create vs edit.
  it('BUILDER TITLE: create shows the new-report title, edit shows the edit title', async () => {
    render(tree({ reports_list: ONE_REPORT, reports_sources: SOURCES }));
    await screen.findByText('Kontaktliste');
    // Edit an existing report: the dialog is titled "Bericht bearbeiten".
    await userEvent.click(screen.getByRole('button', { name: de.reportBuilder.action.edit }));
    expect(screen.getByRole('heading', { name: de.reportBuilder.builder.editTitle })).toBeInTheDocument();
    expect(en.reportBuilder.builder.editTitle).toBe('Edit report');
    await userEvent.click(screen.getAllByRole('button', { name: de.reportBuilder.action.cancel })[0]);
    // Create a new report: the dialog is titled "Bericht erstellen".
    await userEvent.click(screen.getAllByRole('button', { name: de.reportBuilder.action.create })[0]);
    expect(screen.getByRole('heading', { name: de.reportBuilder.builder.title })).toBeInTheDocument();
  });
});
