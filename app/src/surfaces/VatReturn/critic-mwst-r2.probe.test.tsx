/**
 * CRITIC PROBES, round 2 (claude/cl-mwst at 30ee5fc1). Never lands on develop.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { I18nProvider } from '../../i18n';
import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { WorkspaceProvider, useWorkspace } from '../../app/workspace';
import { VatReturn } from './VatReturn';

import returnFixture from './vat-return.fixture.json';
import periodsFixture from './vat-periods.fixture.json';
import periodsFiledFixture from './vat-periods.filed.fixture.json';
import settlementFixture from './vat-settlement.fixture.json';

type Body = RestResponse['body'];
const at = (payload: unknown, status = 200): RestResponse => ({ status, body: payload as Body });
const TODAY = new Date('2026-08-15T09:00:00.000Z');
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
const line = () => {
  const el = document.querySelector('.vr-steps-line');
  if (el === null) return '';
  const copy = el.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[role="tooltip"]').forEach((tip) => tip.remove());
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
};
async function openFiling() {
  const direct = screen.queryByRole('button', { name: 'Als eingereicht markieren' });
  if (direct !== null) return userEvent.click(direct);
  await userEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen zur Abrechnung' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Als eingereicht markieren' }));
}
afterEach(() => vi.restoreAllMocks());

describe('R2: an in-flight vat_mark_filed across a workspace switch', () => {
  for (const outcome of ['ok', 'fail'] as const) {
    it(`(${outcome}) the write goes to ws_1 only, nothing of ws_1 reaches ws_2, and ws_1 re-reads the lock on return`, async () => {
      vi.setSystemTime(TODAY);
      let release: (r: RestResponse) => void = () => {};
      const writes: unknown[] = [];
      let ws1Filed = false;
      const transport: Transport = async (action, input) => {
        const ws = (input as { workspaceId?: string }).workspaceId;
        if (action === 'vat_mark_filed') {
          writes.push(input);
          return new Promise<RestResponse>((r) => {
            release = (resp) => {
              if (outcome === 'ok') ws1Filed = true;
              r(resp);
            };
          });
        }
        if (action === 'vat_periods' && ws === 'ws_1' && ws1Filed) return at(periodsFiledFixture);
        return base[action] ?? at({ ok: false, error: 'unknown_action' }, 404);
      };
      const errors = vi.spyOn(console, 'error');
      mount(transport);
      await screen.findByRole('rowheader', { name: '303' });
      await openFiling();
      await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Als eingereicht markieren' }));
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ workspaceId: 'ws_1', idempotencyKey: 'vat_filed:ws_1:2026-Q2' });

      act(() => switchTo('ws_2'));
      await screen.findByRole('rowheader', { name: '303' });
      await act(async () => {
        release(outcome === 'ok' ? at({ ok: true, period: '2026-Q2' }) : at({ ok: false, error: 'period_locked' }, 409));
        await new Promise((r) => setTimeout(r, 50));
      });
      // ws_2: no dialog, no filed banner, no error from ws_1's write.
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(screen.queryByText(/Eingereicht: Q2\/2026 ist gesperrt/)).toBeNull();
      expect(screen.queryByText(/konnte nicht gesperrt/)).toBeNull();
      expect(line()).toMatch(/Schritt 3/);
      expect(errors).not.toHaveBeenCalled();

      // Back to ws_1: the engine's truth is read again.
      act(() => switchTo('ws_1'));
      await screen.findByRole('rowheader', { name: '303' });
      if (outcome === 'ok') await screen.findByText(/Eingereicht: Q2\/2026 ist gesperrt/);
      else {
        await new Promise((r) => setTimeout(r, 50));
        expect(screen.queryByText(/Eingereicht: Q2\/2026 ist gesperrt/)).toBeNull();
      }
      expect(writes).toHaveLength(1);
    });
  }
});

describe('R2: F3 window after a WORKSPACE switch', () => {
  it('ws_1 Q2 run with export evidence never shows under ws_2 Q2 before the ws_2 checklist read has answered', async () => {
    vi.setSystemTime(TODAY);
    let releaseWs2: () => void = () => {};
    const transport: Transport = async (action, input) => {
      const ws = (input as { workspaceId?: string }).workspaceId;
      if (action === 'checklist_list') {
        if (ws === 'ws_2') await new Promise<void>((r) => (releaseWs2 = r));
        return ws === 'ws_1'
          ? at({ ok: true, runs: [{ runId: 'r1', periodStart: '2026-04-01', status: 'open' }] })
          : at({ ok: true, runs: [] });
      }
      if (action === 'checklist_get') {
        return at({ ok: true, items: [{ itemId: 'ech0217_exported', status: 'done', completedAt: '2026-07-10T10:00:00.000Z', signoff: null }] });
      }
      return base[action] ?? at({ ok: false, error: 'unknown_action' }, 404);
    };
    mount(transport);
    await screen.findByRole('rowheader', { name: '303' });
    await waitFor(() => expect(line()).toMatch(/Schritt 4/));
    act(() => switchTo('ws_2'));
    // Synchronously after the switch commit, and through the whole pending window.
    expect(line()).not.toMatch(/Schritt 4/);
    expect(screen.queryByRole('button', { name: 'Als eingereicht markieren' })).toBeNull();
    await screen.findByRole('rowheader', { name: '303' });
    await new Promise((r) => setTimeout(r, 100));
    expect(line()).toMatch(/Schritt 3/);
    expect(screen.queryByRole('button', { name: 'Als eingereicht markieren' })).toBeNull();
    await act(async () => {
      releaseWs2();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(line()).toMatch(/Schritt 3/);
  });

  it('the same period keeps its exportiert-am through completeExport (no blank)', async () => {
    vi.setSystemTime(TODAY);
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:x' });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const XML = '<x/>';
    let lists = 0;
    const transport: Transport = async (action) => {
      if (action === 'vat_export_ech0217')
        return at({ ok: true, schema: { standard: 'eCH-0217', version: '2.0.0' }, filename: 'f.xml', contentType: 'application/xml', xml: XML, byteLength: XML.length, transmits: false, taxCrossCheck: { recomputedTaxMinor: 1, engineTaxMinor: 1, differenceMinor: 0 } });
      if (action === 'checklist_list') {
        lists += 1;
        return at({ ok: true, runs: [{ runId: 'r1', periodStart: '2026-04-01', status: 'open' }] });
      }
      if (action === 'checklist_get') return at({ ok: true, items: [{ itemId: 'ech0217_exported', status: 'done', completedAt: '2026-07-10T10:00:00.000Z', signoff: null }] });
      if (action === 'checklist_item_complete') return at({ ok: true });
      return base[action] ?? at({ ok: false, error: 'unknown_action' }, 404);
    };
    mount(transport);
    await screen.findByRole('rowheader', { name: '303' });
    await waitFor(() => expect(line()).toMatch(/Schritt 4/));
    await userEvent.click(screen.getByRole('button', { name: 'eCH-0217-Datei exportieren' }));
    await waitFor(() => expect(lists).toBeGreaterThanOrEqual(2));
    expect(line()).toMatch(/Schritt 4/);
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
  });
});

import emptyFixture from './vat-return.empty.fixture.json';

const pickQ1 = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Zeitraum: Q2/2026' }));
  await userEvent.click(screen.getByRole('menuitemradio', { name: /Q1\/2026/ }));
  await screen.findByRole('button', { name: 'Zeitraum: Q1/2026' });
};

describe('R2: the request tokens the author added but no test pins', () => {
  it('N6: a slow Q2 vat_return landing after the switch to Q1 never puts Q2 figures under Q1', async () => {
    vi.setSystemTime(TODAY);
    let releaseQ2: () => void = () => {};
    let returns = 0;
    const transport: Transport = async (action, input) => {
      if (action === 'vat_return') {
        returns += 1;
        const start = (input as { periodStart: string }).periodStart;
        if (start === '2026-04-01' && returns === 1) return at(returnFixture);
        if (start === '2026-04-01') {
          await new Promise<void>((r) => (releaseQ2 = r));
          return at(returnFixture);
        }
        return at(emptyFixture);
      }
      return base[action] ?? at({ ok: false, error: 'unknown_action' }, 404);
    };
    mount(transport);
    await screen.findByRole('rowheader', { name: '303' });
    // Second Q2 read (slow): go to Q1, back to Q2 (slow read starts), then Q1 again (fast).
    await pickQ1();
    await waitFor(() => expect(screen.getAllByText(/CHF 0\.00/).length).toBeGreaterThan(0));
    await userEvent.click(screen.getByRole('button', { name: 'Zeitraum: Q1/2026' }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Q2\/2026/ }));
    await screen.findByRole('button', { name: 'Zeitraum: Q2/2026' });
    await pickQ1();
    await waitFor(() => expect(screen.getAllByText(/CHF 0\.00/).length).toBeGreaterThan(0));
    await act(async () => {
      releaseQ2();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByRole('button', { name: 'Zeitraum: Q1/2026' })).toBeInTheDocument();
    const payable = [...document.querySelectorAll('.vr-payable')].map((e) => e.textContent ?? '').join(' ');
    expect(payable).toMatch(/CHF 0\.00/);
    expect(payable).not.toMatch(/1'596\.20/);
  });

  it('N4: the render right after a period switch shows no run of the period just left', async () => {
    vi.setSystemTime(TODAY);
    let slow = false;
    const transport: Transport = async (action) => {
      if (action === 'checklist_list') {
        if (slow) await new Promise((r) => setTimeout(r, 1500));
        return at({ ok: true, runs: [{ runId: 'r2', periodStart: '2026-04-01', status: 'open' }] });
      }
      if (action === 'checklist_get') return at({ ok: true, items: [{ itemId: 'ech0217_exported', status: 'done', completedAt: '2026-07-10T10:00:00.000Z', signoff: null }] });
      return base[action] ?? at({ ok: false, error: 'unknown_action' }, 404);
    };
    mount(transport);
    await screen.findByRole('rowheader', { name: '303' });
    await waitFor(() => expect(line()).toMatch(/Schritt 4/));
    slow = true;
    await pickQ1();
    expect(line()).not.toMatch(/Schritt 4/);
    expect(screen.queryByRole('button', { name: 'Als eingereicht markieren' })).toBeNull();
  });

  it('N8: a failed filing does not greet the dialog when it is opened again', async () => {
    vi.setSystemTime(TODAY);
    const transport: Transport = async (action) => {
      if (action === 'vat_mark_filed') return at({ ok: false, error: 'period_locked' }, 409);
      return base[action] ?? at({ ok: false, error: 'unknown_action' }, 404);
    };
    mount(transport);
    await screen.findByRole('rowheader', { name: '303' });
    await openFiling();
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Als eingereicht markieren' }));
    await screen.findByText('Die Periode konnte nicht gesperrt werden. Es wurde nichts verändert.');
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Abbrechen' }));
    await openFiling();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.queryByText('Die Periode konnte nicht gesperrt werden. Es wurde nichts verändert.')).toBeNull();
  });
});
