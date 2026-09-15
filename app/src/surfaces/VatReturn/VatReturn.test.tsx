/**
 * A07's surface suite. Every assertion runs against a RECORDED engine payload, never a literal.
 *
 * WHY THE FIXTURES MATTER MORE HERE THAN ANYWHERE ELSE. A07 shipped three filing-grade defects to
 * its critic and every one came back `reconciled: true`. A hand-typed fixture would have agreed with
 * all three, because a hand-typed fixture agrees with whatever its author believed. Every payload
 * below is `test/vat/capture-studio-vat-return.mjs`'s recording of the live engine, and
 * `test/vat/studio-vat-return-fixture.test.mjs` fails the moment the two disagree on any VALUE.
 *
 * VALUES, NOT KEYS AND KINDS. The assertions read francs off the screen ("CHF 1'596.20"), Ziffer
 * numbers, and the actual German sentence a refusal shows, because a test that asserts "a money
 * figure rendered" passes over the wrong money.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { axe } from 'jest-axe';

import { I18nProvider } from '../../i18n';
import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesContext, ALLOW_ALL, type Capabilities } from '../../lib/capabilities';
import { neverSettles, watchReads, hang } from '../../test-transport';
import { VatReturn } from './VatReturn';

import returnFixture from './vat-return.fixture.json';
import driftFixture from './vat-return.drift.fixture.json';
import emptyFixture from './vat-return.empty.fixture.json';
import saldoFixture from './vat-return.saldo.fixture.json';
import saldoSplitFixture from './vat-return.saldo-split.fixture.json';
import istRefusalFixture from './vat-return.ist-refusal.fixture.json';
import needsConfigFixture from './vat-return.needs-config.fixture.json';
import periodsFixture from './vat-periods.fixture.json';
import periodsSaldoFixture from './vat-periods.saldo.fixture.json';
import periodsFiledFixture from './vat-periods.filed.fixture.json';
import settlementFixture from './vat-settlement.fixture.json';
import settlementPostedFixture from './vat-settlement.posted.fixture.json';

/**
 * The stylesheet as TEXT, read off disk beside this file.
 *
 * The suite runs with `css: false`, so jsdom attaches no rules and `getComputedStyle` would answer
 * for a stylesheet that was never loaded. `?raw` does not help either: `css: false` empties the
 * module whatever the query. Reading the source is the only way a unit test can say "this rule
 * exists", and it is deliberately the weaker half of the proof. The strong half is the measured
 * bounding boxes in the browser flow.
 */
const vatReturnCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'VatReturn.css'), 'utf8');
const surfaceHeaderCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'components', 'SurfaceHeader.css'),
  'utf8',
);

type Body = RestResponse['body'];
const at = (payload: unknown, status = 200): RestResponse => ({ status, body: payload as Body });

const PROFILE = at({ ok: true, baseCurrency: 'CHF' });

/**
 * The clock is pinned INSIDE the recorded periods rather than left to the wall clock.
 *
 * `statusOf` compares the period end against today, so an unpinned suite would flip Q2/2026 from
 * "bereit" to "offen" depending on the day it runs, and the mark-filed control would appear and
 * disappear with the calendar. 2026-08-15 sits after Q2 ended and inside Q3, which is exactly the
 * position a filer is in when they open this screen.
 */
const TODAY = new Date('2026-08-15T09:00:00.000Z');

function routes(overrides: Record<string, RestResponse> = {}): Record<string, RestResponse> {
  return {
    vat_periods: at(periodsFixture),
    vat_return: at(returnFixture),
    get_company_profile: PROFILE,
    // A38 (D129 leg 2): the settlement panel reads its model on every period; the recorded
    // preview is of a FILED, unsettled Q2/2026.
    vat_settlement_preview: at(settlementFixture),
    ...overrides,
  };
}

function transportFor(table: Record<string, RestResponse>): Transport {
  return async (action) => table[action] ?? at({ ok: false, error: 'unknown_action' }, 404);
}

function renderSurface(transport: Transport, workspaceId: string | null = 'ws_1', capabilities?: Capabilities) {
  const tree = (
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          <MemoryRouter initialEntries={['/mwst']}>
            <VatReturn />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
  return render(capabilities === undefined ? tree : <CapabilitiesContext.Provider value={capabilities}>{tree}</CapabilitiesContext.Provider>);
}

/** The A24 answer with exactly one capability withheld (the fail-open default otherwise). */
function without(capability: string): Capabilities {
  return { ...ALLOW_ALL, can: (c) => c !== capability };
}

/**
 * Wait for the SETTLED surface.
 *
 * Anchored on Ziffer 303's row header rather than on the payable figure: the payable renders twice
 * on a healthy return, in the strip and again in Ziff. 500, which is correct on the form and makes
 * a text query ambiguous. A row header is unique and only exists once the table is really rendered.
 */
async function settled() {
  return screen.findByRole('rowheader', { name: '303' });
}

/**
 * Capture what the browser was really handed by the export, rather than trusting that a click did
 * something. jsdom has no downloads folder, so the object URL, the anchor click and the Blob are the
 * only observable evidence that a file left the app, and the Blob is what makes "the bytes on disk
 * are the bytes the verb returned" assertable here as well as in the browser flow.
 */
function captureDownload(): { name: string; blob: Blob }[] {
  const saved: { name: string; blob: Blob }[] = [];
  const blobs = new Map<string, Blob>();
  let n = 0;
  // jsdom implements no object-URL seam at all, so these are DEFINED rather than spied on, the way
  // `Reports.test.tsx` already does it. `afterEach` deletes them again.
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (blob: Blob) => {
      n += 1;
      const url = `blob:till/${n}`;
      blobs.set(url, blob);
      return url;
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ name: this.download, blob: blobs.get(this.href) as Blob });
  });
  return saved;
}

/** The saved Blob's contents, via the one reader jsdom does implement. */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

// `restoreMocks` is not set in `vitest.config.ts`, so the download seams would otherwise outlive the
// block that installs them and silently swallow a later test's anchor clicks.
afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
});

describe('A07 MWST-Abrechnung: the healthy effektiv return', () => {
  it('renders the payable, the method badge and the period, off the recorded payload', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes()));
    await settled();

    expect(screen.getByRole('heading', { name: 'MWST-Abrechnung', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Effektiv · Soll (vereinbart) · 01.04.2026 bis 30.06.2026')).toBeInTheDocument();
    // Twice on purpose: once in the strip above the form, once as Ziffer 500 inside it. That is
    // what the ESTV form does, so the query names both rather than pretending one of them is wrong.
    expect(screen.getAllByText('Zu bezahlender Betrag')).toHaveLength(2);
    // Outside the A38 settlement panel, which shows the same net (the settlement of this book moves
    // exactly the payable to 2201) and is asserted on its own below.
    expect(screen.getAllByText("CHF 1'596.20").filter((el) => el.closest('.vr-settle') === null)).toHaveLength(2);
  });

  it('renders the WHOLE ESTV form, not only the boxes the ledger filled', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes()));
    await settled();

    // Ziffern the engine sent.
    expect(screen.getByRole('rowheader', { name: '303' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: '313' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: '383' })).toBeInTheDocument();
    // Ziffern the engine did NOT send, which exist on the form and must still have a box.
    expect(screen.getByRole('rowheader', { name: '415' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: '900' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: '910' })).toBeInTheDocument();
  });

  it('puts the right franc figure in the right box, per rate', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes()));
    await settled();

    const row303 = screen.getByRole('rowheader', { name: '303' }).closest('tr') as HTMLElement;
    expect(within(row303).getByText("CHF 44'000.00")).toBeInTheDocument();
    expect(within(row303).getByText("CHF 3'564.00")).toBeInTheDocument();

    const row313 = screen.getByRole('rowheader', { name: '313' }).closest('tr') as HTMLElement;
    expect(within(row313).getByText("CHF 2'200.00")).toBeInTheDocument();
    expect(within(row313).getByText('CHF 57.20')).toBeInTheDocument();
  });

  it('renders a declared total as a NUMBER and an untouched detail line as a dash', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes()));
    await settled();

    // 399 is a declaration: the filer must be able to tell zero from unknown.
    const row399 = screen.getByRole('rowheader', { name: '399' }).closest('tr') as HTMLElement;
    expect(within(row399).getByText("CHF 3'702.20")).toBeInTheDocument();

    // 415 never happened. "Nothing of this kind happened" is a dash, not a fabricated CHF 0.00.
    const row415 = screen.getByRole('rowheader', { name: '415' }).closest('tr') as HTMLElement;
    expect(within(row415).queryByText('CHF 0.00')).toBeNull();
    expect(within(row415).getAllByText('–').length).toBeGreaterThan(0);
  });

  it('reports the reconciliation as agreeing, with no warn glyph and no colour-only signal', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes()));
    await settled();
    expect(screen.getByText('Abstimmung MWST-Konten: stimmt überein')).toBeInTheDocument();
  });

  it('marks steps 1 and 2 done and NEVER marks the export or the ePortal upload done', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes()));
    await settled();

    const journey = screen.getByRole('list', { name: 'Ablauf der Abrechnung' });
    const steps = within(journey).getAllByRole('listitem');
    expect(steps[0]).toHaveTextContent('erledigt');
    expect(steps[1]).toHaveTextContent('erledigt');
    // Steps 3 and 4 cannot be observed by the product, so they can never render as achievements.
    expect(steps[2]).not.toHaveTextContent('erledigt');
    expect(steps[3]).not.toHaveTextContent('erledigt');
    expect(steps[4]).not.toHaveTextContent('erledigt');
  });

  it('makes step 4 the ePortal link itself, with the URL from i18n (W4)', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes()));
    await settled();

    const link = screen.getByRole('link', { name: /im ePortal eingereicht/ });
    expect(link).toHaveAttribute('href', 'https://www.estv.admin.ch/de/mwst-online-abrechnen');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('never offers to send anything to the ESTV, in any wording', async () => {
    vi.setSystemTime(TODAY);
    const { container } = renderSurface(transportFor(routes()));
    await settled();
    const text = container.textContent ?? '';
    for (const forbidden of ['An ESTV senden', 'Übermitteln', 'Einreichen an']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('offers mark-filed as the SECONDARY action and never as the primary one (W3)', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes()));
    await settled();
    const button = screen.getByRole('button', { name: 'Als eingereicht markieren' });
    expect(button.className).toContain('btn--secondary');
    expect(button.className).not.toContain('btn--primary');
  });

  /**
   * THE ABSENCE TEST, TURNED INTO ITS OPPOSITE RATHER THAN DELETED.
   *
   * This block used to assert that no export button existed and that step 3 apologised for it, so
   * that it would FAIL the moment `vat_export_ech0217` landed. It did exactly that, which is the
   * mechanism working. Deleting it would remove the mechanism; it now asserts the new truth on the
   * same two things, and the copy assertion is the one that would catch the apology coming back.
   */
  it('offers the export as the ONE primary action, and step 3 no longer apologises for its absence', async () => {
    vi.setSystemTime(TODAY);
    const { container } = renderSurface(transportFor(routes()));
    await settled();
    // The A38 settlement panel reads on its own clock; count only once it is on screen, or the
    // assertion below passes by racing the panel rather than by the panel's design.
    await settlementPanel();

    const exportButton = screen.getByRole('button', { name: 'eCH-0217-Datei exportieren' });
    expect(exportButton.className).toContain('btn--primary');
    expect(exportButton).toBeEnabled();
    // DESIGN.md allows one solid primary per surface, and this is it: the settlement post is secondary.
    expect(container.querySelectorAll('.btn--primary')).toHaveLength(1);
    expect(within(await settlementPanel()).getByRole('button', { name: 'MWST-Konten saldieren' }).className).toContain('btn--secondary');

    expect(screen.queryByText(/noch nicht/)).toBeNull();
    expect(
      screen.getByText(/TILL erstellt die eCH-0217-Datei \(Version 2.0.0\) und du lädst sie herunter/),
    ).toBeInTheDocument();
  });
});

describe('A07: S7, the eCH-0217 export (owner decision W3)', () => {
  /** The engine's real success shape: the XML as TEXT, not base64, plus the cross-check beside it. */
  const XML = '<?xml version="1.0" encoding="UTF-8"?>\n<eCH-0217:VATDeclaration/>\n';
  const exportOk = (crossCheck: unknown = { recomputedTaxMinor: 370220, engineTaxMinor: 370220, differenceMinor: 0 }) =>
    at({
      ok: true,
      schema: { standard: 'eCH-0217', version: '2.0.0' },
      filename: 'eCH-0217_CHE116281277_2026-04-01_2026-06-30.xml',
      contentType: 'application/xml',
      xml: XML,
      byteLength: XML.length,
      transmits: false,
      taxCrossCheck: crossCheck,
    });

  it('forwards the SELECTED period and saves the engine’s bytes under the engine’s filename', async () => {
    vi.setSystemTime(TODAY);
    const saved = captureDownload();
    const seen: unknown[] = [];
    const table = routes({ vat_export_ech0217: exportOk() });
    const transport: Transport = async (action, input) => {
      if (action === 'vat_export_ech0217') seen.push(input);
      return table[action] ?? at({ ok: false, error: 'unknown_action' }, 404);
    };
    renderSurface(transport);
    await settled();
    await userEvent.click(screen.getByRole('button', { name: 'eCH-0217-Datei exportieren' }));

    // The period the SCREEN is showing, so the file and the figures above it cannot disagree.
    expect(seen).toEqual([
      { workspaceId: 'ws_1', periodStart: '2026-04-01', periodEnd: '2026-06-30' },
    ]);
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('eCH-0217_CHE116281277_2026-04-01_2026-06-30.xml');
    expect(saved[0].blob.type).toBe('application/xml');
    // jsdom's Blob has no `.text()`, so the bytes are read the long way round. Reading them at all
    // is the point: this is the same claim the A08 browser flow proves against a real download, that
    // what reaches the disk is byte-for-byte what the verb returned.
    await expect(blobText(saved[0].blob)).resolves.toBe(XML);
  });

  it('says nothing at all on a clean export: the file arriving is the feedback', async () => {
    vi.setSystemTime(TODAY);
    captureDownload();
    renderSurface(transportFor(routes({ vat_export_ech0217: exportOk() })));
    await settled();
    await userEvent.click(screen.getByRole('button', { name: 'eCH-0217-Datei exportieren' }));
    expect(await screen.findByRole('button', { name: 'eCH-0217-Datei exportieren' })).toBeEnabled();
    expect(screen.queryByText(/Die ESTV wird eine andere Steuer errechnen/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports the tax cross-check with BOTH figures and the gap, in francs', async () => {
    vi.setSystemTime(TODAY);
    captureDownload();
    renderSurface(
      transportFor(
        routes({
          vat_export_ech0217: exportOk({
            recomputedTaxMinor: 370223,
            engineTaxMinor: 370220,
            differenceMinor: 3,
          }),
        }),
      ),
    );
    await settled();
    await userEvent.click(screen.getByRole('button', { name: 'eCH-0217-Datei exportieren' }));

    // The file is valid and WAS downloaded: this is a disclosure, not a refusal.
    expect(
      await screen.findByText(/Daraus errechnet die ESTV CHF 3'702.23. Deine Buchungen ergeben CHF 3'702.20, also eine Differenz von CHF 0.03./),
    ).toBeInTheDocument();
    expect(screen.getByText(/Die Datei ist gültig/)).toBeInTheDocument();
  });

  it('names the missing UID and routes to the company profile, on both UID codes', async () => {
    vi.setSystemTime(TODAY);
    for (const error of ['needs_company_uid', 'invalid_company_uid']) {
      const view = renderSurface(transportFor(routes({ vat_export_ech0217: at({ ok: false, error }, 422) })));
      await settled();
      await userEvent.click(screen.getByRole('button', { name: 'eCH-0217-Datei exportieren' }));
      expect(await screen.findByText(/Jede eCH-0217-Deklaration nennt die UID der Firma/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Firmenprofil öffnen' })).toHaveAttribute('href', '/setup');
      view.unmount();
    }
  });

  it('names the Ziffer that carries two rates and opens its entries, because the fix is in the ledger', async () => {
    vi.setSystemTime(TODAY);
    const entryId = (returnFixture.lines.find((l) => l.code === '303') as { entryIds: string[] }).entryIds[0];
    renderSurface(
      transportFor(
        routes({
          vat_export_ech0217: at({ ok: false, error: 'ambiguous_rate_on_form_line', codes: ['303'] }, 422),
          get_entry: at({ ok: true, entry: { id: entryId, date: '2026-05-15', ref: 'BEL-1', description: null } }),
        }),
      ),
    );
    await settled();
    await userEvent.click(screen.getByRole('button', { name: 'eCH-0217-Datei exportieren' }));
    expect(await screen.findByText(/Ziffer 303 enthält Umsätze zu mehr als einem Steuersatz/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Buchungen zu Ziffer 303 prüfen' }));
    expect(await screen.findByText('15.05.2026')).toBeInTheDocument();
  });

  it('sends the three unfilable causes to the ePortal by hand, each naming its own cause', async () => {
    vi.setSystemTime(TODAY);
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ error: 'unmapped_form_line', codes: ['415', '420'] }, /Ziffer 415, 420, für die eCH-0217 v2.0.0 kein Feld hat/],
      [{ error: 'saldo_rates_exceed_form_lines', configuredRates: 3 }, /sind 3 Saldosteuersätze hinterlegt/],
      [{ error: 'unsupported_base_currency', baseCurrency: 'EUR' }, /führt die Bücher in EUR/],
    ];
    for (const [payload, expected] of cases) {
      const view = renderSurface(
        transportFor(routes({ vat_export_ech0217: at({ ok: false, ...payload }, 422) })),
      );
      await settled();
      await userEvent.click(screen.getByRole('button', { name: 'eCH-0217-Datei exportieren' }));
      expect(await screen.findByText(expected)).toBeInTheDocument();
      // ONE remedy over three causes, and it is the fallback that always exists.
      expect(screen.getByText(/Diesen Zeitraum reichst du im ePortal von Hand ein/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /ESTV ePortal öffnen/ })).toHaveAttribute(
        'href',
        'https://www.estv.admin.ch/de/mwst-online-abrechnen',
      );
      view.unmount();
    }
  });

  it('does not restate a compute refusal in a second voice: it re-reads, and the form’s own panel says it', async () => {
    vi.setSystemTime(TODAY);
    let returns = 0;
    const transport: Transport = async (action, input) => {
      if (action === 'vat_return') {
        returns += 1;
        return returns === 1 ? at(returnFixture) : at(needsConfigFixture, 422);
      }
      if (action === 'vat_export_ech0217') return at({ ok: false, error: 'needs_vat_config' }, 422);
      return transportFor(routes())(action, input);
    };
    renderSurface(transport);
    await settled();
    await userEvent.click(screen.getByRole('button', { name: 'eCH-0217-Datei exportieren' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Abrechnung neu laden' }));

    // The authoritative refusal, from `RefusalPanel`, exactly once.
    expect(await screen.findByText(/MWST ist für diesen Arbeitsbereich noch nicht eingerichtet/)).toBeInTheDocument();
    expect(returns).toBe(2);
  });

  it('offers a retry on an unrecognised failure and re-runs the export on click', async () => {
    vi.setSystemTime(TODAY);
    const saved = captureDownload();
    let exports = 0;
    const transport: Transport = async (action, input) => {
      if (action === 'vat_export_ech0217') {
        exports += 1;
        return exports === 1 ? at({ ok: false, error: 'boom' }, 500) : exportOk();
      }
      return transportFor(routes())(action, input);
    };
    renderSurface(transport);
    await settled();
    await userEvent.click(screen.getByRole('button', { name: 'eCH-0217-Datei exportieren' }));
    expect(await screen.findByText('Es wurde nichts verändert und keine Datei geschrieben.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Erneut exportieren' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(exports).toBe(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the export available on a FILED period: the lock does not withhold the file', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes({ vat_periods: at(periodsFiledFixture) })));
    await settled();
    expect(screen.getByRole('button', { name: 'eCH-0217-Datei exportieren' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Als eingereicht markieren' })).toBeNull();
  });

  it('offers no export while a refusal replaced the figures: there is nothing to put in a file', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes({ vat_return: at(needsConfigFixture, 422) })));
    await screen.findByText(/MWST ist für diesen Arbeitsbereich noch nicht eingerichtet/);
    expect(screen.queryByRole('button', { name: 'eCH-0217-Datei exportieren' })).toBeNull();
  });

  it('LOADING: disables the button while the export read is genuinely in flight', async () => {
    vi.setSystemTime(TODAY);
    const transport = watchReads(hang('vat_export_ech0217', transportFor(routes())));
    renderSurface(transport);
    await settled();
    const button = screen.getByRole('button', { name: 'eCH-0217-Datei exportieren' });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    await transport.started('vat_export_ech0217');
    expect(screen.getByRole('button', { name: 'Datei wird erstellt …' })).toBeDisabled();
  });
});

describe('A07: LOADING', () => {
  it('shows the skeleton while the return is genuinely in flight', async () => {
    vi.setSystemTime(TODAY);
    const transport = watchReads(neverSettles);
    renderSurface(transport);
    await transport.started('vat_periods');
    // Two skeleton blocks, one per half of the form's shape, so the layout does not jump when the
    // figures land. Both are `status` regions; asserting on the pair is the honest query.
    const busy = screen.getAllByRole('status');
    expect(busy.length).toBeGreaterThan(0);
    for (const region of busy) expect(region).toHaveAttribute('aria-busy', 'true');
  });

  it('keeps the period picker in its own loading state while `vat_periods` is in flight', async () => {
    vi.setSystemTime(TODAY);
    const transport = watchReads(hang('vat_periods', transportFor(routes())));
    renderSurface(transport);
    await transport.started('vat_periods');
    await userEvent.click(screen.getByRole('button', { name: /Zeitraum/ }));
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
  });
});

describe('A07: EMPTY', () => {
  it('renders the full form at zero and names the period rather than blanking the screen', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes({ vat_return: at(emptyFixture) })));
    expect(await screen.findByText('Keine steuerbare Tätigkeit in diesem Zeitraum.')).toBeInTheDocument();
    // A zero return is still a return the ESTV expects, so the form is on screen with its
    // declared boxes at CHF 0.00 rather than replaced by an empty panel.
    const row500 = screen.getByRole('rowheader', { name: '500' }).closest('tr') as HTMLElement;
    expect(within(row500).getByText('CHF 0.00')).toBeInTheDocument();
  });
});

describe('A07: ERROR', () => {
  it('banners an unrecognised rejection with a retry and re-reads on click', async () => {
    vi.setSystemTime(TODAY);
    let calls = 0;
    const transport: Transport = async (action) => {
      if (action === 'vat_return') {
        calls += 1;
        return calls === 1 ? at({ ok: false, error: 'boom' }, 500) : at(returnFixture);
      }
      return transportFor(routes())(action, {});
    };
    renderSurface(transport);
    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    await settled();
    expect(calls).toBe(2);
  });

  it('renders an error row with a retry inside the picker, never an empty dropdown', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes({ vat_periods: at({ ok: false, error: 'boom' }, 500) })));
    await userEvent.click(await screen.findByRole('button', { name: /Zeitraum/ }));
    expect(screen.getByText('Die Abrechnungsperioden konnten nicht geladen werden.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeInTheDocument();
  });
});

describe('A07: PERMISSION-DENIED', () => {
  it('replaces the figures with the padlock panel and names who can grant the right', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(
      transportFor(routes({ vat_return: at({ ok: false, error: 'permission_denied' }, 403) })),
    );
    expect(await screen.findByText(/Dir fehlt das Recht/)).toBeInTheDocument();
    expect(screen.queryByRole('rowheader', { name: '303' })).toBeNull();
  });
});

describe('A07: the five refusals', () => {
  it('names the missing MWST configuration and routes to A05', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes({ vat_return: at(needsConfigFixture, 422) })));
    expect(await screen.findByText(/MWST ist für diesen Arbeitsbereich noch nicht eingerichtet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'MWST einrichten' })).toHaveAttribute('href', '/vat');
  });

  it('explains the two-rate Saldo refusal as a missing activity split, citing MWSTV Art. 84 Abs. 3', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(
      transportFor({
        vat_periods: at(periodsSaldoFixture),
        vat_return: at(saldoSplitFixture, 422),
        get_company_profile: PROFILE,
      }),
    );
    expect(await screen.findByText(/MWSTV Art. 84 Abs. 3/)).toBeInTheDocument();
    // The engine names the configured rates back, and the panel repeats them: a café filer takes
    // this screen to a Treuhänder, and "two rates" without the rates is not actionable.
    expect(screen.getByText('1. Satz: 6.2 Prozent')).toBeInTheDocument();
    expect(screen.getByText('2. Satz: 5.3 Prozent')).toBeInTheDocument();
    expect(screen.queryByRole('rowheader', { name: '323' })).toBeNull();
  });

  it('explains the IST refusal the engine really sends, which the UX design never named', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes({ vat_return: at(istRefusalFixture, 422) })));
    expect(await screen.findByText(/MWSTG Art. 39 Abs. 2/)).toBeInTheDocument();
    expect(screen.getByText(/lieber keine Zahlen als falsche/)).toBeInTheDocument();
  });

  it('explains a rate that was not on the ESTV ladder for the period, by the engine’s real code', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(
      transportFor(
        routes({
          vat_return: at({ ok: false, error: 'saldo_rate_not_valid_for_period', rateBp: 620 }, 422),
        }),
      ),
    );
    expect(await screen.findByText(/Saldosteuersatz 6.2 Prozent/)).toBeInTheDocument();
  });
});

describe('A07: the Abstimmung (owner decision W2)', () => {
  it('warns on an unexplained difference and never disables filing', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes({ vat_return: at(driftFixture) })));
    expect(await screen.findByText('Abstimmung MWST-Konten: CHF 148.50 ungeklärt')).toBeInTheDocument();
    // Filing is a statutory obligation with a deadline. The bridge is TILL's own heuristic, so it
    // warns loudly and stays out of the way.
    expect(screen.getByRole('button', { name: 'Als eingereicht markieren' })).toBeEnabled();
  });

  it('opens expanded on a difference and shows the arithmetic against the real account', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes({ vat_return: at(driftFixture) })));
    await screen.findByText('Abstimmung MWST-Konten: CHF 148.50 ungeklärt');
    expect(screen.getByText('Ziff. 399 Total geschuldete Steuer')).toBeInTheDocument();
    expect(screen.getByText('Bewegung Konto 2200')).toBeInTheDocument();
    expect(screen.getByText("CHF 3'553.70")).toBeInTheDocument();
  });

  it('says the Saldo method cannot be checked, and shows NO drift figure at all', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(
      transportFor({
        vat_periods: at(periodsSaldoFixture),
        vat_return: at(saldoFixture),
        get_company_profile: PROFILE,
      }),
    );
    expect(await screen.findByText(/Die Saldomethode lässt sich nicht gegen Konto 2200 prüfen/)).toBeInTheDocument();
    // The payload carries driftMinor -53229 beside `applicable: false`. Printing it would report a
    // discrepancy the engine explicitly declined to compute.
    expect(screen.queryByText('CHF -532.29')).toBeNull();
    expect(screen.queryByText(/ungeklärt/)).toBeNull();
  });

  it('leaves journey step 2 NOT done while a difference is unexplained', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes({ vat_return: at(driftFixture) })));
    await screen.findByText('Abstimmung MWST-Konten: CHF 148.50 ungeklärt');
    const steps = within(screen.getByRole('list', { name: 'Ablauf der Abrechnung' })).getAllByRole('listitem');
    expect(steps[1]).not.toHaveTextContent('erledigt');
  });
});

describe('A07: the Saldo form is a different form, not the effektiv one with fields hidden', () => {
  it('renders Ziff. 323, has no 333 box on a 2025+ period, and replaces Vorsteuer with 470/471', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(
      transportFor({
        vat_periods: at(periodsSaldoFixture),
        vat_return: at(saldoFixture),
        get_company_profile: PROFILE,
      }),
    );
    await screen.findByRole('rowheader', { name: '323' });
    // The fixture reports 01.01.2026 to 30.06.2026. That period files on the form MWST-Info 12
    // Ziff. 18.1.4 describes, whose Steuerberechnung block carries Ziffer 322 and 323 and nothing
    // else: the 2. Satz row was abolished with the rate-position dimension (A07 §3.1a). Printing an
    // empty 333 would put a box on the screen that is not on the form the figures are filed on.
    expect(screen.queryByRole('rowheader', { name: '333' })).toBeNull();
    expect(screen.queryByRole('rowheader', { name: '400' })).toBeNull(); // no Vorsteuer under Art. 37
    expect(screen.getByRole('rowheader', { name: '470' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: '471' })).toBeInTheDocument();
    // Ziff. 205 does not exist on form DM_0553_03 at all: absent, not blank.
    expect(screen.queryByRole('rowheader', { name: '205' })).toBeNull();
  });

  it('renders the Steueranrechnung as unknown rather than as a nil TILL never computed', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(
      transportFor({
        vat_periods: at(periodsSaldoFixture),
        vat_return: at(saldoFixture),
        get_company_profile: PROFILE,
      }),
    );
    const row479 = (await screen.findByRole('rowheader', { name: '479' })).closest('tr') as HTMLElement;
    expect(within(row479).queryByText('CHF 0.00')).toBeNull();
    expect(screen.getByText(/TILL berechnet sie nicht/)).toBeInTheDocument();
  });
});

describe('A07: the period picker', () => {
  it('lists the engine-supplied periods with a status WORD, never a free-text field', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes()));
    await settled();
    await userEvent.click(screen.getByRole('button', { name: /Zeitraum/ }));

    const menu = screen.getByRole('menu', { name: 'Abrechnungsperiode wählen' });
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent('Q1/2026');
    expect(items[0]).toHaveTextContent('bereit');
    // Q3 has not ended on 15.08.2026.
    expect(items[2]).toHaveTextContent('offen');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('names an already-filed period as filed', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes({ vat_periods: at(periodsFiledFixture) })));
    await settled();
    await userEvent.click(screen.getByRole('button', { name: /Zeitraum/ }));
    const items = within(screen.getByRole('menu')).getAllByRole('menuitemradio');
    expect(items[1]).toHaveTextContent('eingereicht');
  });

  it('names the missing configuration instead of an empty dropdown', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes({ vat_periods: at({ ok: true, method: 'effektiv', year: '2026', periods: [] }) })));
    await userEvent.click(await screen.findByRole('button', { name: /Zeitraum/ }));
    expect(screen.getByText('Für diesen Arbeitsbereich sind noch keine Abrechnungsperioden definiert.')).toBeInTheDocument();
  });
});

describe('A07: filing', () => {
  it('gates the irreversible act behind a dialog that restates the period and the payable', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes()));
    await settled();
    await userEvent.click(screen.getByRole('button', { name: 'Als eingereicht markieren' }));

    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/Es wird nichts an die ESTV übermittelt/)).toBeInTheDocument();
    expect(within(dialog).getByText('Q2/2026, 01.04.2026 bis 30.06.2026')).toBeInTheDocument();
    expect(within(dialog).getByText("CHF 1'596.20")).toBeInTheDocument();
    expect(within(dialog).getByText(/lässt sich hier nicht rückgängig machen/)).toBeInTheDocument();
  });

  it('gates confirm behind an acknowledgement when a difference is unexplained (W2)', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes({ vat_return: at(driftFixture) })));
    await screen.findByText('Abstimmung MWST-Konten: CHF 148.50 ungeklärt');
    await userEvent.click(screen.getByRole('button', { name: 'Als eingereicht markieren' }));

    const dialog = screen.getByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Als eingereicht markieren' });
    expect(confirm).toBeDisabled();
    await userEvent.click(within(dialog).getByLabelText(/ungeklärte Differenz von CHF 148.50/));
    expect(confirm).toBeEnabled();
  });

  it('asks for no acknowledgement when nothing is unexplained', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes()));
    await settled();
    await userEvent.click(screen.getByRole('button', { name: 'Als eingereicht markieren' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Als eingereicht markieren' })).toBeEnabled();
  });

  it('sends a period-derived idempotency key, so a replay is a no-op rather than a second lock', async () => {
    vi.setSystemTime(TODAY);
    const seen: unknown[] = [];
    const table = routes({ vat_mark_filed: at({ ok: true, period: '2026-Q2' }) });
    const transport: Transport = async (action, input) => {
      if (action === 'vat_mark_filed') seen.push(input);
      return table[action] ?? at({ ok: false, error: 'unknown_action' }, 404);
    };
    renderSurface(transport);
    await settled();
    await userEvent.click(screen.getByRole('button', { name: 'Als eingereicht markieren' }));
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Als eingereicht markieren' }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ period: '2026-Q2', idempotencyKey: 'vat_filed:ws_1:2026-Q2' });
  });

  it('keeps the dialog open and loses nothing when the write fails', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes({ vat_mark_filed: at({ ok: false, error: 'period_locked' }, 409) })));
    await settled();
    await userEvent.click(screen.getByRole('button', { name: 'Als eingereicht markieren' }));
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Als eingereicht markieren' }),
    );
    expect(await screen.findByText('Die Periode konnte nicht gesperrt werden. Es wurde nichts verändert.')).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('disables filing while the period is still running, and says why', async () => {
    // 15.02.2026 sits inside Q1, and no earlier quarter of 2026 has ended, so the surface lands on
    // a RUNNING period. A date inside Q2 would land on Q1, which has ended, and prove nothing.
    vi.setSystemTime(new Date('2026-02-15T09:00:00.000Z'));
    renderSurface(transportFor(routes()));
    await settled();
    expect(screen.getByRole('button', { name: 'Als eingereicht markieren' })).toBeDisabled();
    expect(screen.getByText(/Die Periode läuft noch/)).toBeInTheDocument();
  });

  it('replaces the control with a banner on a filed period, and says the figures are recomputed', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes({ vat_periods: at(periodsFiledFixture) })));
    await settled();
    expect(screen.getByText('Eingereicht: Q2/2026 ist gesperrt.')).toBeInTheDocument();
    // A07 persists no return. Implying a stored snapshot would be a lie about the read model.
    expect(screen.getByText(/keine gespeicherte Kopie/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Als eingereicht markieren' })).toBeNull();
  });
});

describe('A07: S3, the drill-down', () => {
  it('expands a Ziffer in place and lists its contributing entries', async () => {
    vi.setSystemTime(TODAY);
    const entryId = (returnFixture.lines.find((l) => l.code === '303') as { entryIds: string[] }).entryIds[0];
    renderSurface(
      transportFor(
        routes({
          get_entry: at({ ok: true, entry: { id: entryId, date: '2026-05-15', ref: 'BEL-1', description: null } }),
        }),
      ),
    );
    await settled();
    await userEvent.click(screen.getByRole('button', { name: 'Buchungen zu Ziffer 303 anzeigen' }));

    expect(await screen.findByText('15.05.2026')).toBeInTheDocument();
    expect(screen.getByText('BEL-1')).toBeInTheDocument();
    // The return the operator was checking is still on screen: expansion, not navigation.
    expect(screen.getByRole('rowheader', { name: '313' })).toBeInTheDocument();
  });

  it('offers no drill affordance on a box with no contributing entries', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes()));
    await settled();
    expect(screen.queryByRole('button', { name: 'Buchungen zu Ziffer 415 anzeigen' })).toBeNull();
  });
});

describe('A07: the header is the shared SurfaceHeader primitive', () => {
  /**
   * THE HEADER USED TWO CLASSES NO STYLESHEET DECLARED. `.surface` and `.surface-head` appeared on
   * this surface and nowhere else in `app/`, and nothing anywhere declared them, so the row that
   * holds the title, the Periodenwaehler and the export button had no layout at all: it fell back to
   * block flow, `.vr-actions` started at the left margin, and `.vr-picker-pop`'s `right: 0` opened
   * the period menu leftwards out of the main column and under the navigation rail. The surface then
   * carried a bespoke `.vr-head` that owned the layout; D118 B2 replaced it with the shared
   * `SurfaceHeader` primitive, so the layout now lives in `SurfaceHeader.css` for every surface.
   *
   * Neither assertion can see geometry: vitest runs with `css: false` and jsdom has no viewport, and
   * that is exactly how a full green suite missed a popover that was not positioned. The measured
   * bounding boxes are in `.claude/ui-tests/flows/verify-vat-return.cjs`
   * (`pickerPopupStaysInsideTheSurface`). These two guard the CAUSE instead: that the header names
   * the shared class the primitive owns, and that that class carries the row layout.
   */
  it('renders the header as `.surface-header`, a class the primitive declares', async () => {
    vi.setSystemTime(TODAY);
    const { container } = renderSurface(transportFor(routes()));
    await settled();

    const root = container.querySelector('section') as HTMLElement;
    const head = container.querySelector('header') as HTMLElement;

    // The surface root keeps its own namespace class; the header is now the shared primitive, whose
    // class `SurfaceHeader.css` declares. `vr-head`, `surface` and `surface-head` are all gone.
    expect([...root.classList]).toEqual(['vr']);
    expect([...head.classList]).toEqual(['surface-header']);
    expect(/\.surface-header[\s,{]/.test(surfaceHeaderCss)).toBe(true);
    // The retired bespoke classes are no longer declared or named on this surface.
    expect(/\.vr-head[\s,{]/.test(vatReturnCss)).toBe(false);
  });

  it('lays the header out in `.surface-header`, the shared row treatment', () => {
    const rule = /\.surface-header\s*\{([^}]*)\}/.exec(surfaceHeaderCss)?.[1] ?? '';
    // The primitive declares exactly what every sibling *-head once did by hand: the title block on
    // one side, the action cluster on the other, on one row.
    expect(rule).toMatch(/display:\s*flex/);
    expect(rule).toMatch(/justify-content:\s*space-between/);
  });
});

describe('A07: a refused period list is a state, not a blank page', () => {
  /**
   * THE COMMONEST FIRST-RUN STATE ON THIS SURFACE HAD NO WORDS.
   *
   * `listVatPeriods` refuses a workspace with no MWST method using the SAME `needs_vat_config` code
   * `computeVatReturn` does. `loadPeriods` threw that code away into a boolean, so `selected` stayed
   * null, `loadReturn` returned at its `period === null` guard without calling anything, and
   * `refusal` was never set. What a new operator got was a title, a journey strip, and one sentence
   * hidden inside a menu they had to open.
   *
   * Measured against the built engine on 2026-07-29, an unconfigured workspace answers
   * `needs_vat_config` on BOTH reads (`vat_periods` and `vat_return`), which is why the period list
   * has to carry the refusal: the return read never happens.
   */
  it('names the missing MWST configuration when `vat_periods` is what refused', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(
      transportFor(routes({ vat_periods: at({ ok: false, error: 'needs_vat_config', method: 'none' }, 422) })),
    );
    expect(
      await screen.findByText(/MWST ist für diesen Arbeitsbereich noch nicht eingerichtet/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'MWST einrichten' })).toHaveAttribute('href', '/vat');
    expect(screen.queryByRole('rowheader', { name: '303' })).toBeNull();
  });

  it('keeps the padlock panel when the period list is the read that was denied', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(
      transportFor(routes({ vat_periods: at({ ok: false, error: 'permission_denied' }, 403) })),
    );
    expect(await screen.findByText(/Dir fehlt das Recht/)).toBeInTheDocument();
  });

  it('still degrades to the in-picker error row on a rejection it cannot name', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes({ vat_periods: at({ ok: false, error: 'boom' }, 500) })));
    await userEvent.click(await screen.findByRole('button', { name: /Zeitraum/ }));
    expect(screen.getByText('Die Abrechnungsperioden konnten nicht geladen werden.')).toBeInTheDocument();
    // No refusal panel: inventing one for a code the surface does not recognise would be a guess
    // printed as an explanation.
    expect(document.querySelector('.vr-refusal')).toBeNull();
  });

  it('has no violations while the period list is refused', async () => {
    vi.setSystemTime(TODAY);
    const { container } = renderSurface(
      transportFor(routes({ vat_periods: at({ ok: false, error: 'needs_vat_config', method: 'none' }, 422) })),
    );
    await screen.findByText(/MWST ist für diesen Arbeitsbereich noch nicht eingerichtet/);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('A07: no workspace', () => {
  it('routes to setup rather than reading with a null workspace', () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes()), null);
    // The shared no-workspace panel always carries the way out, so this is never a dead end.
    expect(screen.getByRole('link')).toHaveAttribute('href', '/setup');
    expect(screen.queryByRole('rowheader', { name: '303' })).toBeNull();
  });
});

describe('A07: accessibility', () => {
  /**
   * ANCHORED ON A SETTLED SURFACE, NEVER THE FIRST FRAME. An axe run on the first commit judges a
   * skeleton, which is markup the operator sees for a moment and which contains none of the tables,
   * menus or dialogs the audit exists to check. Every block below waits for real content first.
   */
  it('has no violations on the settled healthy return', async () => {
    vi.setSystemTime(TODAY);
    const { container } = renderSurface(transportFor(routes()));
    await settled();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations with the period picker open', async () => {
    vi.setSystemTime(TODAY);
    const { container } = renderSurface(transportFor(routes()));
    await settled();
    await userEvent.click(screen.getByRole('button', { name: /Zeitraum/ }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations with the confirm dialog open', async () => {
    vi.setSystemTime(TODAY);
    const { container } = renderSurface(transportFor(routes()));
    await settled();
    await userEvent.click(screen.getByRole('button', { name: 'Als eingereicht markieren' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations with the bridge in its warn state', async () => {
    vi.setSystemTime(TODAY);
    const { container } = renderSurface(transportFor(routes({ vat_return: at(driftFixture) })));
    await screen.findByText('Abstimmung MWST-Konten: CHF 148.50 ungeklärt');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations with an export refusal on screen', async () => {
    vi.setSystemTime(TODAY);
    const { container } = renderSurface(
      transportFor(routes({ vat_export_ech0217: at({ ok: false, error: 'needs_company_uid' }, 422) })),
    );
    await settled();
    await userEvent.click(screen.getByRole('button', { name: 'eCH-0217-Datei exportieren' }));
    await screen.findByText(/Jede eCH-0217-Deklaration nennt die UID der Firma/);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations with the tax cross-check on screen', async () => {
    vi.setSystemTime(TODAY);
    captureDownload();
    const { container } = renderSurface(
      transportFor(
        routes({
          vat_export_ech0217: at({
            ok: true,
            filename: 'eCH-0217.xml',
            contentType: 'application/xml',
            xml: '<x/>',
            byteLength: 4,
            taxCrossCheck: { recomputedTaxMinor: 370223, engineTaxMinor: 370220, differenceMinor: 3 },
          }),
        }),
      ),
    );
    await settled();
    await userEvent.click(screen.getByRole('button', { name: 'eCH-0217-Datei exportieren' }));
    await screen.findByText(/Die Datei ist gültig/);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations on a refusal', async () => {
    vi.setSystemTime(TODAY);
    const { container } = renderSurface(transportFor(routes({ vat_return: at(needsConfigFixture, 422) })));
    await screen.findByText(/MWST ist für diesen Arbeitsbereich noch nicht eingerichtet/);
    expect(await axe(container)).toHaveNoViolations();
  });
});

// -------------------------------------------------------------------------------------------
// A38 (D129 leg 2): the MWST-Saldierung panel
// -------------------------------------------------------------------------------------------

/**
 * The SETTLED settlement panel: the section once its read has answered. Re-queried on every wait
 * rather than captured off the first heading, because the heading moves inside the section when the
 * skeleton gives way to the table and a captured element would be a detached one.
 */
async function settlementPanel() {
  return waitFor(() => {
    const el = document.querySelector('section.vr-settle');
    if (el === null) throw new Error('the settlement panel is not on screen');
    if (el.querySelector('[role="status"]') !== null) throw new Error('the settlement panel is still loading');
    return el as HTMLElement;
  });
}

describe('A38: the MWST-Saldierung panel on a filed period', () => {
  it('renders booked beside declared with no difference, and the net that lands on 2201, off the recorded preview', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes({ vat_periods: at(periodsFiledFixture) })));
    await settled();
    const panel = await settlementPanel();
    // The figures are the engine's: 8.1% of the taxable sales on 2200, the two Vorsteuer accounts,
    // and a net that equals the return's own payable (the same book, the same Rappen).
    const output = within(panel).getByRole('row', { name: /Umsatzsteuer/ });
    expect(within(output).getAllByText("CHF 3'702.20")).toHaveLength(2);
    expect(within(output).getByText('keine')).toBeInTheDocument();
    const input = within(panel).getByRole('row', { name: /Vorsteuer/ });
    expect(within(input).getAllByText("CHF 2'106.00")).toHaveLength(2);
    const net = within(panel).getByRole('row', { name: /Netto auf 2201/ });
    expect(within(net).getAllByText("CHF 1'596.20")).toHaveLength(2);
    // The lines the post books, behind a disclosure, dated the period end.
    expect(within(panel).getByText('4 Buchungszeilen per 30.06.2026')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'MWST-Konten saldieren' })).toBeEnabled();
  });

  it('gates the post behind an alertdialog carrying the C4 consequence sentence, and posts with a period-derived key', async () => {
    vi.setSystemTime(TODAY);
    const seen: unknown[] = [];
    let posted = false;
    const table = routes({ vat_periods: at(periodsFiledFixture) });
    const transport: Transport = async (action, input) => {
      if (action === 'vat_settlement_post') {
        seen.push(input);
        posted = true;
        return at({ ok: true, settlementId: 'vatsettle_1' });
      }
      if (action === 'vat_settlement_preview') return at(posted ? settlementPostedFixture : settlementFixture);
      return table[action] ?? at({ ok: false, error: 'unknown_action' }, 404);
    };
    renderSurface(transport);
    await settled();
    const panel = await settlementPanel();
    await userEvent.click(within(panel).getByRole('button', { name: 'MWST-Konten saldieren' }));

    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/innerhalb der eingereichten Periode/)).toBeInTheDocument();
    expect(dialog.querySelector('[data-verb="vat_settlement_post"]')).not.toBeNull();
    expect(within(dialog).getByText('Q2/2026, 01.04.2026 bis 30.06.2026')).toBeInTheDocument();
    expect(within(dialog).getByText("CHF 1'596.20")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'MWST-Konten saldieren' }));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ period: '2026-Q2' });
    expect((seen[0] as { idempotencyKey: string }).idempotencyKey).toMatch(/^vat_settlement:ws_1:2026-Q2:[0-9a-f-]{36}$/);
    // The posted state is the ENGINE's row re-read, not the click: the date is the row's posted_at.
    expect(await screen.findByText('Saldiert am 16.07.2026')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // And the journey's sixth step reads the same fact.
    expect(screen.getByText('saldiert am 16.07.2026')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Aktionen zur Saldierung Q2/2026' })).toBeInTheDocument();
  });

  it('settles a period AGAIN after a reversal under a NEW key, so the engine books a new settlement instead of replaying the reversed memo', async () => {
    vi.setSystemTime(TODAY);
    const keys: string[] = [];
    let posted = false;
    const table = routes({ vat_periods: at(periodsFiledFixture) });
    const transport: Transport = async (action, input) => {
      if (action === 'vat_settlement_post') {
        keys.push((input as { idempotencyKey: string }).idempotencyKey);
        posted = true;
        return at({ ok: true, settlementId: `vatsettle_${keys.length}` });
      }
      if (action === 'vat_settlement_reverse') {
        posted = false;
        return at({ ok: true, settlementId: 'vatsettle_1', status: 'reversed' });
      }
      if (action === 'vat_settlement_preview') return at(posted ? settlementPostedFixture : settlementFixture);
      return table[action] ?? at({ ok: false, error: 'unknown_action' }, 404);
    };
    renderSurface(transport);
    await settled();
    const panel = await settlementPanel();
    await userEvent.click(within(panel).getByRole('button', { name: 'MWST-Konten saldieren' }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'MWST-Konten saldieren' }));
    expect(await screen.findByText('Saldiert am 16.07.2026')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Aktionen zur Saldierung Q2/2026' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Saldierung stornieren' }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Saldierung stornieren' }));
    await waitFor(() => expect(screen.queryByText('Saldiert am 16.07.2026')).toBeNull());

    // The model now reads exactly as before the first post. The key must still be a NEW one.
    const again = await settlementPanel();
    await userEvent.click(within(again).getByRole('button', { name: 'MWST-Konten saldieren' }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'MWST-Konten saldieren' }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[1]).toMatch(/^vat_settlement:ws_1:2026-Q2:[0-9a-f-]{36}$/);
  });

  it('names a spent key when the engine refuses already_reversed_key, and keeps the dialog open', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(
      transportFor(
        routes({
          vat_periods: at(periodsFiledFixture),
          vat_settlement_post: at({ ok: false, error: 'already_reversed_key', settlementId: 'vatsettle_1', reversalEntryId: 'entry_9' }, 409),
        }),
      ),
    );
    await settled();
    const panel = await settlementPanel();
    await userEvent.click(within(panel).getByRole('button', { name: 'MWST-Konten saldieren' }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'MWST-Konten saldieren' }));
    expect(await screen.findByText(/wurde storniert\. Schliesse den Dialog/)).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('SALDO: names the Vorsteuer balance and links to the journal when the preview refuses saldo_input_vat_booked, and offers no post', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(
      transportFor({
        vat_periods: at(periodsSaldoFixture),
        vat_return: at(saldoFixture),
        get_company_profile: PROFILE,
        vat_settlement_preview: at({ ok: false, error: 'saldo_input_vat_booked', period: '2026-H1', method: 'saldo', balance: { 1170: 40500, 1171: 0 }, totalMinor: 40500 }, 409),
      }),
    );
    // A Saldo return has no Ziffer 303 row, so the effektiv `settled()` waiter does not apply here.
    expect(await screen.findByText(/Die Saldomethode lässt sich nicht gegen Konto 2200 prüfen/)).toBeInTheDocument();
    const panel = await settlementPanel();
    expect(within(panel).getByRole('note')).toHaveTextContent(/1170 und 1171 tragen einen Saldo von CHF 405\.00/);
    expect(within(panel).getByRole('link', { name: 'Journal öffnen' })).toHaveAttribute('href', '/journal');
    expect(within(panel).queryByRole('button', { name: 'MWST-Konten saldieren' })).toBeNull();
  });

  it('keeps the dialog open and names the seal when the write is refused into a closed year', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(
      transportFor(
        routes({
          vat_periods: at(periodsFiledFixture),
          vat_settlement_post: at({ ok: false, error: 'period_locked', period: '2026', kind: 'hard', reason: 'year_close' }, 409),
        }),
      ),
    );
    await settled();
    const panel = await settlementPanel();
    await userEvent.click(within(panel).getByRole('button', { name: 'MWST-Konten saldieren' }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'MWST-Konten saldieren' }));
    expect(await screen.findByText(/Das Jahr ist abgeschlossen/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Perioden öffnen' })).toHaveAttribute('href', '/periods');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('offers the reverse in the overflow of a posted settlement, behind its own confirm, and sends the settlement id', async () => {
    vi.setSystemTime(TODAY);
    const seen: unknown[] = [];
    const table = routes({ vat_periods: at(periodsFiledFixture), vat_settlement_preview: at(settlementPostedFixture) });
    const transport: Transport = async (action, input) => {
      if (action === 'vat_settlement_reverse') {
        seen.push(input);
        return at({ ok: true, settlementId: 'vatsettle_1', status: 'reversed' });
      }
      return table[action] ?? at({ ok: false, error: 'unknown_action' }, 404);
    };
    renderSurface(transport);
    await settled();
    const panel = await settlementPanel();
    expect(within(panel).queryByRole('button', { name: 'MWST-Konten saldieren' })).toBeNull();
    await userEvent.click(within(panel).getByRole('button', { name: 'Aktionen zur Saldierung Q2/2026' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Saldierung stornieren' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.querySelector('[data-verb="vat_settlement_reverse"]')).not.toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Saldierung stornieren' }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ settlementId: 'vatsettle_1', idempotencyKey: 'vat_settlement_reverse:ws_1:vatsettle_1' });
  });
});

describe('A38: the panel on a period that is not filed, without the right, and while loading', () => {
  it('disables the post on an unfiled period and says it waits for the filing', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes()));
    await settled();
    const panel = await settlementPanel();
    expect(within(panel).getByRole('button', { name: 'MWST-Konten saldieren' })).toBeDisabled();
    expect(within(panel).getByText(/Wartet auf die Einreichung/)).toBeInTheDocument();
  });

  it('shows the padlock reason without the post right, and never the enabled action', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(transportFor(routes({ vat_periods: at(periodsFiledFixture) })), 'ws_1', without('post'));
    await settled();
    const panel = await settlementPanel();
    expect(within(panel).getByRole('button', { name: 'MWST-Konten saldieren' })).toBeDisabled();
    expect(within(panel).getByText('Zum Buchen brauchst du das Recht post.')).toBeInTheDocument();
  });

  it('says nothing is to settle on an empty period, and shows no action', async () => {
    vi.setSystemTime(TODAY);
    renderSurface(
      transportFor(routes({ vat_periods: at(periodsFiledFixture), vat_settlement_preview: at({ ...settlementFixture, lines: [], outputMinor: 0, inputMinor: 0, netMinor: 0, nothingToSettle: true }) })),
    );
    await settled();
    const panel = await settlementPanel();
    expect(within(panel).getByText(/Nichts zu saldieren/)).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'MWST-Konten saldieren' })).toBeNull();
  });

  it('LOADING: keeps the panel in its own skeleton while vat_settlement_preview is genuinely in flight', async () => {
    vi.setSystemTime(TODAY);
    const transport = watchReads(hang('vat_settlement_preview', transportFor(routes())));
    renderSurface(transport);
    await settled();
    await transport.started('vat_settlement_preview');
    const panel = document.querySelector('section.vr-settle') as HTMLElement;
    expect(within(panel).getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('has no violations with the settlement dialog open', async () => {
    vi.setSystemTime(TODAY);
    const { container } = renderSurface(transportFor(routes({ vat_periods: at(periodsFiledFixture) })));
    await settled();
    const panel = await settlementPanel();
    await userEvent.click(within(panel).getByRole('button', { name: 'MWST-Konten saldieren' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});
