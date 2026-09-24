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
import { render, screen, within, waitFor } from '@testing-library/react';
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

  it('renders three independent artifact rows', () => {
    renderSurface();
    expect(screen.getByRole('heading', { name: 'Journal' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Abschlüsse' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'MWST-Zahlen' })).toBeInTheDocument();
    // The MWST working-paper honesty line is present.
    expect(screen.getByText(/nicht die Upload-Datei für die ESTV/)).toBeInTheDocument();
  });

  it('the journal row downloads a CSV via export_journal', async () => {
    allowConsole(/Not implemented: navigation/);
    let called: Record<string, unknown> | null = null;
    renderSurface({ ...DEFAULT, export_journal: (input) => ((called = input), ok({ artifact: artifact('journal.csv'), empty: false })) });
    const user = userEvent.setup();
    const row = screen.getByRole('heading', { name: 'Journal' }).closest('.ex-row') as HTMLElement;
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
    const row = screen.getByRole('heading', { name: 'Abschlüsse' }).closest('.ex-row') as HTMLElement;
    // Switch the row's own format toggle from PDF to CSV.
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
    const row = screen.getByRole('heading', { name: 'MWST-Zahlen' }).closest('.ex-row') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /Herunterladen/ }));
    expect(await screen.findByRole('link', { name: 'MWST einrichten' })).toBeInTheDocument();
  });

  it('an empty period is a notice, not a failure, and still saves the header-only file', async () => {
    allowConsole(/Not implemented: navigation/);
    renderSurface({ ...DEFAULT, export_journal: ok({ artifact: artifact('journal.csv'), empty: true }) });
    const user = userEvent.setup();
    const row = screen.getByRole('heading', { name: 'Journal' }).closest('.ex-row') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /Herunterladen/ }));
    expect(await within(row).findByText(/keine Bewegungen/)).toBeInTheDocument();
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it('a failed export renders inline with a retry, never a toast', async () => {
    renderSurface({ ...DEFAULT, export_journal: reject({ error: 'io_error' }, 500) });
    const user = userEvent.setup();
    const row = screen.getByRole('heading', { name: 'Journal' }).closest('.ex-row') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /Herunterladen/ }));
    expect(await within(row).findByRole('alert')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Nochmals versuchen' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderSurface();
    expect(await axe(container)).toHaveNoViolations();
  });
});

/** F-07 (J4.3): the lock confirmation's link carries the period, so Export opens on the month just locked. */
describe('Export: the period carried over from the lock (F-07)', () => {
  it('/export?period=2026-07 opens on July, nothing typed twice', async () => {
    renderSurface(DEFAULT, { route: '/export?period=2026-07' });
    const month = (await screen.findByLabelText('Monat')) as HTMLInputElement;
    expect(month.value).toBe('2026-07');
  });

  it('/export?period=2025 opens on the year', async () => {
    renderSurface(DEFAULT, { route: '/export?period=2025' });
    const year = (await screen.findByLabelText('Jahr')) as HTMLInputElement;
    expect(year.value).toBe('2025');
  });
});
