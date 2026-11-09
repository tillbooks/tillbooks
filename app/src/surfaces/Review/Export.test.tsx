/**
 * A25 Export: the three independent artifact rows, each state.
 *
 * The engine hands back base64 bytes, not a file, so the surface builds a Blob and saves it; jsdom
 * has no object-URL, so that seam is stubbed (the Reports precedent) rather than the component being
 * reshaped to suit the test. Each row is proven to call its OWN verb with its OWN format, the MWST
 * row to route `needs_vat_config` into A07 rather than fail, and an empty period to be a NOTICE that
 * still saves a header-only file.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { allowConsole } from '../../test-console';
import { Export } from './index';

type Canned = Record<string, RestResponse | ((input: Record<string, unknown>) => RestResponse)>;

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

const ok = (data: Record<string, unknown>): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (body: { error: string } & Record<string, unknown>, status = 422): RestResponse => ({
  status,
  body: { ...body, ok: false },
});

/** A valid base64 blob so `atob` in `saveArtifact` does not throw. */
const artifact = (filename: string) => ({ filename, mediaType: 'text/csv; charset=utf-8', base64: 'aGVsbG8=' });

const DEFAULT: Canned = {
  export_journal: ok({ artifact: artifact('journal.csv'), empty: false }),
  export_statements: ok({ artifacts: [artifact('bilanz.pdf'), artifact('erfolg.pdf')], empty: false }),
  export_vat: ok({ artifact: artifact('mwst.csv'), empty: false }),
};

function caps(held: readonly string[]): Capabilities {
  return {
    whoami: {
      actor: 'studio',
      provisioned: true,
      isMember: true,
      memberId: 'm1',
      userId: 'u1',
      role: 'custom',
      capabilities: [...held],
    },
    can: (capability) => held.includes(capability),
    refresh: () => undefined,
  };
}

interface RenderOptions {
  held?: readonly string[] | null;
  workspaceId?: string | null;
  /** The route to mount on (F-07: `/export?period=YYYY-MM` opens on that period). */
  route?: string;
}

function renderSurface(canned: Canned = DEFAULT, options: RenderOptions = {}) {
  const { held = null, workspaceId = 'ws_test', route = '/export' } = options;
  const client = new TillClient(fakeTransport(canned));
  const inner = (
    <MemoryRouter initialEntries={[route]}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          <TillClientProvider client={client}>
            <Export />
          </TillClientProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </MemoryRouter>
  );
  return render(
    held === null ? inner : <CapabilitiesContext.Provider value={caps(held)}>{inner}</CapabilitiesContext.Provider>,
  );
}

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:x'), configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
});

describe('Export: gate and the three rows', () => {
  it('permission-denied by capability shows the padlock, not the rows', async () => {
    renderSurface(DEFAULT, { held: [] });
    expect(await screen.findByText(/Treuhänder-Rolle/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Herunterladen/ })).not.toBeInTheDocument();
  });

  it('offers the three exports in one bar, and the MWST honesty line stays on the page', async () => {
    // D187 (Berichte A): one bar picks what to export; the chosen one is described beneath.
    renderSurface();
    const what = screen.getByRole('radiogroup', { name: 'Was' });
    for (const name of ['Journal', 'Abschlüsse', 'MWST-Zahlen']) expect(within(what).getByRole('radio', { name })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Journal' })).toBeInTheDocument();
    await userEvent.setup().click(within(what).getByRole('radio', { name: 'MWST-Zahlen' }));
    expect(screen.getByRole('heading', { name: 'MWST-Zahlen' })).toBeInTheDocument();
    // The MWST working-paper honesty line is visible beside the export, not behind an (i).
    expect(screen.getByText(/nicht die Upload-Datei für die ESTV/)).toBeVisible();
  });

  it('the journal row downloads a CSV via export_journal', async () => {
    allowConsole(/Not implemented: navigation/);
    let called: Record<string, unknown> | null = null;
    renderSurface({ ...DEFAULT, export_journal: (input) => ((called = input), ok({ artifact: artifact('journal.csv'), empty: false })) });
    const user = userEvent.setup();
    const row = screen.getByRole('region', { name: 'Export' });
    await user.click(within(row).getByRole('button', { name: /Herunterladen/ }));
    await waitFor(() => expect(called).not.toBeNull());
    expect((called as unknown as { format: string }).format).toBe('csv');
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it('the statements row downloads the chosen format and saves BOTH artifacts', async () => {
    allowConsole(/Not implemented: navigation/);
    let called: Record<string, unknown> | null = null;
    renderSurface({
      ...DEFAULT,
      export_statements: (input) => ((called = input), ok({ artifacts: [artifact('bilanz.csv'), artifact('erfolg.csv')], empty: false })),
    });
    const user = userEvent.setup();
    const row = screen.getByRole('region', { name: 'Export' });
    await user.click(within(row).getByRole('radio', { name: 'Abschlüsse' }));
    // Switch the format toggle from PDF to CSV.
    await user.click(within(row).getByRole('radio', { name: 'CSV' }));
    await user.click(within(row).getByRole('button', { name: /Herunterladen/ }));
    await waitFor(() => expect(called).not.toBeNull());
    expect((called as unknown as { format: string }).format).toBe('csv');
    // One save per statement in the pair.
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
  });
});

describe('Export: the honest error and empty paths', () => {
  it('MWST needs_vat_config is a CTA into A07, not a failure', async () => {
    renderSurface({ ...DEFAULT, export_vat: reject({ error: 'needs_vat_config' }) });
    const user = userEvent.setup();
    const row = screen.getByRole('region', { name: 'Export' });
    await user.click(within(row).getByRole('radio', { name: 'MWST-Zahlen' }));
    await user.click(within(row).getByRole('button', { name: /Herunterladen/ }));
    expect(await screen.findByRole('link', { name: 'MWST einrichten' })).toBeInTheDocument();
  });

  it('an empty period is a notice, not a failure, and still saves the header-only file', async () => {
    allowConsole(/Not implemented: navigation/);
    renderSurface({ ...DEFAULT, export_journal: ok({ artifact: artifact('journal.csv'), empty: true }) });
    const user = userEvent.setup();
    const row = screen.getByRole('region', { name: 'Export' });
    await user.click(within(row).getByRole('button', { name: /Herunterladen/ }));
    expect(await within(row).findByText(/keine Bewegungen/)).toBeInTheDocument();
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it('a failed export renders inline with a retry, never a toast', async () => {
    renderSurface({ ...DEFAULT, export_journal: reject({ error: 'io_error' }, 500) });
    const user = userEvent.setup();
    const row = screen.getByRole('region', { name: 'Export' });
    await user.click(within(row).getByRole('button', { name: /Herunterladen/ }));
    expect(await within(row).findByRole('alert')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Nochmals versuchen' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderSurface();
    expect(await axe(container)).toHaveNoViolations();
  });
});

/** F-07 (J4.3) and D190: the lock confirmation's link carries the period, and it prefills Von and Bis. */
describe('Export: the period carried over from the lock (F-07, D190)', () => {
  it('/export?period=2026-07 opens on July as Von/Bis, with Monat chosen', async () => {
    renderSurface(DEFAULT, { route: '/export?period=2026-07' });
    expect(((await screen.findByLabelText('Von')) as HTMLInputElement).value).toBe('2026-07-01');
    expect((screen.getByLabelText('Bis') as HTMLInputElement).value).toBe('2026-07-31');
    const quick = screen.getByRole('radiogroup', { name: 'Zeitraum' });
    expect(within(quick).getByRole('radio', { name: 'Monat' })).toHaveAttribute('aria-checked', 'true');
  });

  it('/export?period=2025 opens on the year', async () => {
    renderSurface(DEFAULT, { route: '/export?period=2025' });
    expect(((await screen.findByLabelText('Von')) as HTMLInputElement).value).toBe('2025-01-01');
    expect((screen.getByLabelText('Bis') as HTMLInputElement).value).toBe('2025-12-31');
    const quick = screen.getByRole('radiogroup', { name: 'Zeitraum' });
    expect(within(quick).getByRole('radio', { name: 'Jahr' })).toHaveAttribute('aria-checked', 'true');
  });

  it('the linked month is what the journal export sends, as from and to, never a period', async () => {
    allowConsole(/Not implemented: navigation/);
    let called: Record<string, unknown> | null = null;
    renderSurface(
      { ...DEFAULT, export_journal: (input) => ((called = input), ok({ artifact: artifact('journal.csv'), empty: false })) },
      { route: '/export?period=2026-07' },
    );
    await userEvent.setup().click(screen.getByRole('button', { name: /Herunterladen/ }));
    await waitFor(() => expect(called).not.toBeNull());
    expect(called).toMatchObject({ from: '2026-07-01', to: '2026-07-31', format: 'csv' });
    expect(called).not.toHaveProperty('period');
    expect(called).not.toHaveProperty('account');
    expect(called).not.toHaveProperty('source');
  });
});

describe('Export: the range, the quick picks and the journal filters (D190)', () => {
  it('Quartal and Jahr fill Von and Bis around Von; a typed range is no pick', async () => {
    const user = userEvent.setup();
    renderSurface(DEFAULT, { route: '/export?period=2026-08' });
    const quick = screen.getByRole('radiogroup', { name: 'Zeitraum' });
    await user.click(within(quick).getByRole('radio', { name: 'Quartal' }));
    expect((screen.getByLabelText('Von') as HTMLInputElement).value).toBe('2026-07-01');
    expect((screen.getByLabelText('Bis') as HTMLInputElement).value).toBe('2026-09-30');
    await user.click(within(quick).getByRole('radio', { name: 'Jahr' }));
    expect((screen.getByLabelText('Von') as HTMLInputElement).value).toBe('2026-01-01');
    expect((screen.getByLabelText('Bis') as HTMLInputElement).value).toBe('2026-12-31');
    fireEvent.change(screen.getByLabelText('Bis'), { target: { value: '2026-03-15' } });
    for (const radio of within(quick).getAllByRole('radio')) expect(radio).toHaveAttribute('aria-checked', 'false');
  });

  it('the account field and the Quelle chip ride along to export_journal', async () => {
    allowConsole(/Not implemented: navigation/);
    const user = userEvent.setup();
    let called: Record<string, unknown> | null = null;
    renderSurface(
      { ...DEFAULT, export_journal: (input) => ((called = input), ok({ artifact: artifact('journal-auszug.csv'), empty: false })) },
      { route: '/export?period=2026-03' },
    );
    await user.type(screen.getByRole('searchbox', { name: 'Konto' }), ' 1020 ');
    await user.click(screen.getByRole('button', { name: 'Filter hinzufügen' }));
    await user.click(screen.getByRole('menuitem', { name: 'Quelle: Import' }));
    // The chosen source is a removable chip, so the page always says how the file is filtered.
    expect(screen.getByRole('button', { name: 'Quelle ändern' })).toHaveTextContent('Import');
    await user.click(screen.getByRole('button', { name: /Herunterladen/ }));
    await waitFor(() => expect(called).not.toBeNull());
    expect(called).toMatchObject({ from: '2026-03-01', to: '2026-03-31', account: '1020', source: 'import' });
  });

  it('the statements send the range and no filter, and a mid-month range says what it may miss', async () => {
    allowConsole(/Not implemented: navigation/);
    const user = userEvent.setup();
    let called: Record<string, unknown> | null = null;
    renderSurface(
      {
        ...DEFAULT,
        export_statements: (input) => (
          (called = input),
          ok({ artifacts: [artifact('bilanz.pdf'), artifact('erfolg.pdf')], notice: 'range_not_whole_months' })
        ),
      },
      { route: '/export?period=2026-03' },
    );
    await user.click(screen.getByRole('radio', { name: 'Abschlüsse' }));
    // The filters belong to the journal alone: a filtered Bilanz is not a Bilanz.
    expect(screen.queryByRole('searchbox', { name: 'Konto' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Bis'), { target: { value: '2026-03-15' } });
    await user.click(screen.getByRole('button', { name: /Herunterladen/ }));
    await waitFor(() => expect(called).not.toBeNull());
    expect(called).toMatchObject({ from: '2026-03-01', to: '2026-03-15', format: 'pdf' });
    expect(called).not.toHaveProperty('account');
    expect(await screen.findByText(/mitten im Monat/)).toBeInTheDocument();
  });

  it('MWST shows its own period picker, not the range, and sends a filing label', async () => {
    const user = userEvent.setup();
    let called: Record<string, unknown> | null = null;
    allowConsole(/Not implemented: navigation/);
    renderSurface(
      { ...DEFAULT, export_vat: (input) => ((called = input), ok({ artifact: artifact('mwst.csv'), empty: false })) },
      { route: '/export?period=2026-08' },
    );
    await user.click(screen.getByRole('radio', { name: 'MWST-Zahlen' }));
    expect(screen.queryByLabelText('Von')).toBeNull();
    const kinds = screen.getByRole('radiogroup', { name: 'MWST-Periode' });
    // The linked month opens as a month; Quartal turns it into that month's quarter label.
    expect(within(kinds).getByRole('radio', { name: 'Monat' })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(kinds).getByRole('radio', { name: 'Quartal' }));
    expect(within(screen.getByRole('radiogroup', { name: 'Welches Quartal' })).getByRole('radio', { name: 'Q3' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.click(screen.getByRole('button', { name: /Herunterladen/ }));
    await waitFor(() => expect(called).not.toBeNull());
    expect(called).toMatchObject({ period: '2026-Q3', format: 'csv' });
    expect(called).not.toHaveProperty('from');
  });

  it('the named refusals read as what to fix: the range, an unknown account', async () => {
    const user = userEvent.setup();
    renderSurface({ ...DEFAULT, export_journal: reject({ error: 'range_inverted', from: '2026-04-01', to: '2026-03-31' }) });
    await user.click(screen.getByRole('button', { name: /Herunterladen/ }));
    expect(await screen.findByText(/Prüfe Von und Bis/)).toBeInTheDocument();
  });

  it('an unknown account names the account, and an empty extract is its own notice', async () => {
    allowConsole(/Not implemented: navigation/);
    const user = userEvent.setup();
    let answer: RestResponse = reject({ error: 'unknown_account', account: '9999' });
    renderSurface({ ...DEFAULT, export_journal: () => answer });
    await user.type(screen.getByRole('searchbox', { name: 'Konto' }), '9999');
    await user.click(screen.getByRole('button', { name: /Herunterladen/ }));
    expect(await screen.findByText('Das Konto 9999 gibt es in diesem Workspace nicht.')).toBeInTheDocument();
    answer = ok({ artifact: artifact('journal-auszug.csv'), empty: true, notice: 'empty_extract' });
    await user.click(screen.getByRole('button', { name: /Herunterladen/ }));
    expect(await screen.findByText(/Keine Buchung passt zu diesen Filtern/)).toBeInTheDocument();
  });

  it('has no axe violations on the journal with a filter set, nor on MWST', async () => {
    const user = userEvent.setup();
    const { container } = renderSurface();
    await user.click(screen.getByRole('button', { name: 'Filter hinzufügen' }));
    await user.click(screen.getByRole('menuitem', { name: 'Quelle: Rechnung' }));
    expect(await axe(container)).toHaveNoViolations();
    await user.click(screen.getByRole('radio', { name: 'MWST-Zahlen' }));
    expect(await axe(container)).toHaveNoViolations();
  });
});
