/**
 * G13, the Archiv tab: the five states, the five specified safeguards (spec §6), and the hard
 * partition proven at the component level: switching to the Archiv face unmounts the live table
 * and renders ONLY `gl_archive_query` results, so a mixed list cannot exist even transiently.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { axe } from 'jest-axe';

import Journal from './index';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { TillClientProvider } from '../../lib/client-context';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';

type Handler = RestResponse | ((input: Record<string, unknown>) => RestResponse | Promise<RestResponse>);
type Handlers = Record<string, Handler>;

const PROVENANCE = { system: 'bexio', from: '2019-01-05', to: '2025-11-30' };

function archiveEntry(over: Record<string, unknown> = {}) {
  return {
    entryId: 'glarch_1',
    sourceEntryId: 'B-77',
    date: '2019-03-05',
    description: 'Bareinnahme',
    sourceRef: 'file_1',
    balanced: true,
    lines: [
      {
        sourceAccount: '10',
        sourceAccountName: 'Kasse (alt)',
        targetAccountId: 'acc_1000',
        targetNumber: '1000',
        targetName: 'Kassenbestand',
        debitMinor: 10000,
        creditMinor: 0,
        currency: 'CHF',
        description: 'Bareinnahme',
      },
      {
        sourceAccount: '9999',
        sourceAccountName: null,
        targetAccountId: null,
        targetNumber: null,
        targetName: null,
        debitMinor: 0,
        creditMinor: 10000,
        currency: 'CHF',
        description: null,
      },
    ],
    ...over,
  };
}

const QUERY_OK: RestResponse = {
  status: 200,
  body: { ok: true, entries: [archiveEntry()], page: 1, pageSize: 50, total: 1, provenance: PROVENANCE },
};

const LIVE_LIST: RestResponse = {
  status: 200,
  body: {
    ok: true,
    entries: [
      {
        id: 'je_live',
        date: '2026-03-31',
        ref: 'L-1',
        description: 'Live Buchung',
        status: 'posted',
        source: 'manual',
        reversesEntryId: null,
        total: 5000,
        currency: 'CHF',
      },
    ],
  },
};

function renderJournal(handlers: Handlers) {
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const transport: Transport = async (action, input) => {
    calls.push({ action, input });
    const h = handlers[action];
    if (h === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof h === 'function' ? h(input) : h;
  };
  const utils = render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider initialLocale="en">
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter>
            <Journal />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
  return { ...utils, calls };
}

async function openArchive(handlers: Handlers) {
  const utils = renderJournal({ list_journal: LIVE_LIST, ...handlers });
  await screen.findByText('Live Buchung');
  await userEvent.click(screen.getByRole('tab', { name: 'Archive' }));
  return utils;
}

describe('the Archiv tab: safeguards and the hard partition', () => {
  it('renders archive rows under the NON-DISMISSIBLE provenance band, and unmounts the live table', async () => {
    const { calls } = await openArchive({ gl_archive_query: QUERY_OK });

    // The band: present, text-accessible, and with NO dismiss control anywhere inside it.
    const band = await screen.findByTestId('archive-provenance');
    expect(band).toHaveTextContent('From the prior system bexio');
    expect(band).toHaveTextContent('Not part of the TILL document chain.');
    expect(within(band).queryByRole('button')).not.toBeInTheDocument();

    // The archive row renders with its distinct treatment and its flags.
    expect(screen.getByText('B-77')).toBeInTheDocument();
    expect(screen.getByText('Unmapped')).toBeInTheDocument();

    // THE HARD PARTITION: the live row is GONE from the document, not merely filtered. The two
    // worlds are different components, so no state exists in which both lists render.
    expect(screen.queryByText('Live Buchung')).not.toBeInTheDocument();
    // And the archive face never re-queried the live journal to build its list.
    const afterSwitch = calls.filter((c) => c.action === 'list_journal').length;
    expect(calls.filter((c) => c.action === 'gl_archive_query').length).toBe(1);
    expect(afterSwitch).toBe(1);

    // The composer's primary action does not exist on the archive face: the archive has no write.
    expect(screen.queryByRole('button', { name: 'New entry' })).not.toBeInTheDocument();
  });

  it('opens a plain READ-ONLY detail with the same band, never the live drawer', async () => {
    await openArchive({ gl_archive_query: QUERY_OK });
    await screen.findByText('B-77');
    await userEvent.click(screen.getByRole('button', { name: /B-77/ }));

    // The detail: source and target accounts, and a SECOND provenance band inside it.
    expect(await screen.findByText('10 Kasse (alt)')).toBeInTheDocument();
    expect(screen.getByText('1000 Kassenbestand')).toBeInTheDocument();
    expect(screen.getAllByTestId('archive-provenance').length).toBe(2);

    // No live-journal affordance: nothing to post, reverse, or edit.
    expect(screen.queryByRole('button', { name: /reverse/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /post/i })).not.toBeInTheDocument();
  });

  it('renders the empty state naming the archive and pointing at the migration plan', async () => {
    await openArchive({
      gl_archive_query: {
        status: 200,
        body: { ok: true, entries: [], page: 1, pageSize: 50, total: 0, provenance: { system: null, from: null, to: null } },
      },
    });
    expect(await screen.findByText('No archive imported')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the migration plan' })).toHaveAttribute('href', '/migration');
  });

  it('renders the A24 padlock naming read_books on a denied query', async () => {
    await openArchive({
      gl_archive_query: { status: 403, body: { ok: false, error: 'permission_denied' } },
    });
    expect(await screen.findByText(/read_books/)).toBeInTheDocument();
  });

  it('renders the error banner with a retry on a failed query', async () => {
    let failures = 0;
    await openArchive({
      gl_archive_query: () => {
        failures += 1;
        return failures === 1
          ? { status: 500, body: { ok: false, error: 'unexpected_error' } }
          : QUERY_OK;
      },
    });
    const retry = await screen.findByRole('button', { name: /try again|retry/i });
    await userEvent.click(retry);
    expect(await screen.findByText('B-77')).toBeInTheDocument();
  });

  it('keeps the purge behind the overflow on the periods view, and renders retention_active with the statute', async () => {
    // LOADING-PROOF-EXEMPT: the role=status here is the PURGE RESULT live region, not a loading affordance; the refusal it asserts can only exist after gl_archive_purge really answered.
    await openArchive({
      gl_archive_query: QUERY_OK,
      gl_archive_periods: {
        status: 200,
        body: {
          ok: true,
          periods: [{ period: '2019-03', entryCount: 1, retentionUntil: '2029-12-31', purged: false }],
          purgeRecords: [],
          provenance: PROVENANCE,
        },
      },
      gl_archive_purge: {
        status: 422,
        body: { ok: false, error: 'retention_active', until: '2029-12-31', statutoryRef: 'OR 958f' },
      },
    });
    await screen.findByText('B-77');

    // No purge control is visible beside the query.
    expect(screen.queryByRole('button', { name: 'Purge expired periods' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Archived periods' }));
    // K-38: an archived period reads as a month in words, never the raw `2019-03`.
    expect(await screen.findByText('March 2019')).toBeInTheDocument();
    expect(screen.queryByText('2019-03')).not.toBeInTheDocument();

    // The purge lives behind the overflow, with a reason field and a confirm.
    await userEvent.click(screen.getByRole('button', { name: 'Archive period actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Purge expired periods' }));
    const confirm = screen.getByRole('button', { name: 'Purge with this reason' });
    expect(confirm).toBeDisabled();

    await userEvent.type(screen.getByLabelText('From period'), '2019-01');
    await userEvent.type(screen.getByLabelText('To period'), '2019-12');
    await userEvent.type(screen.getByLabelText('Reason'), 'Löschbegehren');
    await userEvent.click(screen.getByRole('button', { name: 'Purge with this reason' }));

    // The refusal names the date AND the statutory reference, and says the refusal is on record.
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('OR 958f');
    expect(status).toHaveTextContent('the refusal is on record');
  });

  it('has no axe violations on the archive face', async () => {
    const { container } = await openArchive({ gl_archive_query: QUERY_OK });
    await screen.findByText('B-77');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the Journal face is untouched by the tab (regression)', () => {
  it('still renders the live list with its filters and composer on the default tab', async () => {
    renderJournal({ list_journal: LIVE_LIST });
    expect(await screen.findByText('Live Buchung')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New entry' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Journal' })).toHaveAttribute('aria-selected', 'true');
    // The archive read is LAZY: nothing was asked of the archive while the live face is showing.
    expect(screen.queryByTestId('archive-provenance')).not.toBeInTheDocument();
  });

  it('waits for a workspace before showing either face', async () => {
    render(
      <TillClientProvider client={new TillClient(async () => ({ status: 200, body: { ok: true, entries: [] } }))}>
        <I18nProvider initialLocale="en">
          <WorkspaceProvider initialId={null}>
            <MemoryRouter>
              <Journal />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await waitFor(() => expect(screen.getByText(/journal belongs to a workspace/i)).toBeInTheDocument());
    expect(screen.queryByRole('tab', { name: 'Archive' })).not.toBeInTheDocument();
  });
});
