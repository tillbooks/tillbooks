/**
 * The critic's probes on the D152 pass (critic FAIL on claude/cl-mwst, findings F1 to F3), kept as
 * regression tests and asserting the FIXED behaviour. Each one failed against `12085d9f`:
 *
 *  F1  a session export, its refusal and its cross-check followed a WORKSPACE switch, so a workspace
 *      that never exported showed step 4 and the filing button in its header;
 *  F2  a failed re-export left the journey on step 4 beside its own refusal;
 *  F3  a slow checklist answer for the period being left landed on the period now on screen.
 *
 * Beside them, the rest of the surface's state is checked across a switch: the period, the open
 * disclosures, the export refusal.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { I18nProvider } from '../../i18n';
import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { WorkspaceProvider, useWorkspace } from '../../app/workspace';
import { VatReturn } from './VatReturn';

import returnFixture from './vat-return.fixture.json';
import periodsFixture from './vat-periods.fixture.json';
import settlementFixture from './vat-settlement.fixture.json';

type Body = RestResponse['body'];
const at = (payload: unknown, status = 200): RestResponse => ({ status, body: payload as Body });
const TODAY = new Date('2026-08-15T09:00:00.000Z');
const XML = '<?xml version="1.0" encoding="UTF-8"?>\n<eCH-0217:VATDeclaration/>\n';
const exportOk = at({
  ok: true,
  schema: { standard: 'eCH-0217', version: '2.0.0' },
  filename: 'eCH-0217_CHE116281277_2026-04-01_2026-06-30.xml',
  contentType: 'application/xml',
  xml: XML,
  byteLength: XML.length,
  transmits: false,
  taxCrossCheck: { recomputedTaxMinor: 370220, engineTaxMinor: 370220, differenceMinor: 0 },
});
const base: Record<string, RestResponse> = {
  vat_periods: at(periodsFixture),
  vat_return: at(returnFixture),
  get_company_profile: at({ ok: true, baseCurrency: 'CHF' }),
  vat_settlement_preview: at(settlementFixture),
};

let switchTo: (id: string) => void = () => {};
function Switcher() {
  const { setWorkspaceId } = useWorkspace();
  switchTo = setWorkspaceId;
  return null;
}

function mount(transport: Transport) {
  return render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_1">
          <MemoryRouter initialEntries={['/mwst']}>
            <Switcher />
            <VatReturn />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

function captureDownload() {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:x' });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
}

/** What the journey line SHOWS: its words without the (i)'s card, which itself mentions "Schritt 4". */
const line = () => {
  const el = document.querySelector('.vr-steps-line');
  if (el === null) return '';
  const copy = el.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[role="tooltip"]').forEach((tip) => tip.remove());
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
};

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
});

describe('F1: a workspace switch', () => {
  it('a ws_1 export does not move ws_2 (never exported) to step 4 nor put the filing button in its header', async () => {
    vi.setSystemTime(TODAY);
    captureDownload();
    const exportsBy: string[] = [];
    const transport: Transport = async (action, input) => {
      if (action === 'vat_export_ech0217') {
        exportsBy.push((input as { workspaceId: string }).workspaceId);
        return exportOk;
      }
      return base[action] ?? at({ ok: false, error: 'unknown_action' }, 404);
    };
    mount(transport);
    await screen.findByRole('rowheader', { name: '303' });
    await userEvent.click(screen.getByRole('button', { name: 'eCH-0217-Datei exportieren' }));
    await screen.findByRole('button', { name: 'Als eingereicht markieren' });
    expect(line()).toMatch(/Schritt 4/);

    act(() => switchTo('ws_2'));
    await waitFor(() => expect(screen.getByRole('rowheader', { name: '303' })).toBeInTheDocument());
    // let the ws_2 reads settle
    await new Promise((r) => setTimeout(r, 50));
    expect(exportsBy).toEqual(['ws_1']);
    // ws_2 never exported anything: it must be on step 3 with the filing one level down.
    expect(line()).toMatch(/Schritt 3 von \d: exportieren/);
    expect(screen.queryByRole('button', { name: 'Als eingereicht markieren' })).toBeNull();
  });

  it('does not carry an export refusal, the chosen period or an open disclosure into the other workspace', async () => {
    vi.setSystemTime(TODAY);
    const transport: Transport = async (action) => {
      if (action === 'vat_export_ech0217') return at({ ok: false, error: 'boom' }, 500);
      return base[action] ?? at({ ok: false, error: 'unknown_action' }, 404);
    };
    mount(transport);
    await screen.findByRole('rowheader', { name: '303' });
    // In ws_1: pick Q1, open both disclosures, and let an export fail.
    await userEvent.click(screen.getByRole('button', { name: 'Zeitraum: Q2/2026' }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Q1\/2026/ }));
    await screen.findByRole('button', { name: 'Zeitraum: Q1/2026' });
    await screen.findByRole('rowheader', { name: '303' });
    await userEvent.click(screen.getByRole('button', { name: 'Alle Schritte der Abrechnung' }));
    await userEvent.click(screen.getByRole('button', { name: 'Abstimmung im Detail' }));
    await userEvent.click(screen.getByRole('button', { name: 'eCH-0217-Datei exportieren' }));
    await screen.findByText('Es wurde nichts verändert und keine Datei geschrieben.');

    act(() => switchTo('ws_2'));
    // ws_2 lands on ITS default period (the last one that ended), not on the one chosen in ws_1.
    await screen.findByRole('button', { name: 'Zeitraum: Q2/2026' });
    await screen.findByRole('rowheader', { name: '303' });
    expect(screen.queryByText('Es wurde nichts verändert und keine Datei geschrieben.')).toBeNull();
    expect(document.querySelectorAll('[aria-expanded="true"]')).toHaveLength(0);
  });
});

describe('F2: a failed re-export', () => {
  it('a later FAILED export of the same period does not leave the line on step 4 beside the refusal', async () => {
    vi.setSystemTime(TODAY);
    captureDownload();
    let n = 0;
    const transport: Transport = async (action) => {
      if (action === 'vat_export_ech0217') {
        n += 1;
        return n === 1 ? exportOk : at({ ok: false, error: 'boom' }, 500);
      }
      return base[action] ?? at({ ok: false, error: 'unknown_action' }, 404);
    };
    mount(transport);
    await screen.findByRole('rowheader', { name: '303' });
    await userEvent.click(screen.getByRole('button', { name: 'eCH-0217-Datei exportieren' }));
    await screen.findByRole('button', { name: 'Als eingereicht markieren' });
    await userEvent.click(screen.getByRole('button', { name: 'eCH-0217-Datei exportieren' }));
    await screen.findByText('Es wurde nichts verändert und keine Datei geschrieben.');
    expect(line()).not.toMatch(/Schritt 4/);
  });
});

describe('F3: a checklist answer only lands on the period it was asked for', () => {
  it('a slow Q2 checklist answer landing after the switch to Q1 does not put Q1 on step 4', async () => {
    vi.setSystemTime(TODAY);
    let first = true;
    const transport: Transport = async (action) => {
      if (action === 'checklist_list') {
        if (first) {
          first = false;
          await new Promise((r) => setTimeout(r, 1500));
        }
        return at({ ok: true, runs: [{ runId: 'r2', periodStart: '2026-04-01', status: 'open' }] });
      }
      if (action === 'checklist_get') {
        return at({ ok: true, items: [{ itemId: 'ech0217_exported', status: 'done', completedAt: '2026-07-10T10:00:00.000Z', signoff: null }] });
      }
      return base[action] ?? at({ ok: false, error: 'unknown_action' }, 404);
    };
    mount(transport);
    await screen.findByRole('rowheader', { name: '303' });
    await userEvent.click(screen.getByRole('button', { name: 'Zeitraum: Q2/2026' }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Q1\/2026/ }));
    await screen.findByRole('button', { name: 'Zeitraum: Q1/2026' });
    await new Promise((r) => setTimeout(r, 2000));
    expect(line()).toMatch(/Schritt 3/);
  });
});
