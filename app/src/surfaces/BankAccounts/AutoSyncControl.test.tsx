/**
 * D142: the daily automatic fetch on the EBICS channel card. What it sends (`set_bank_sync_schedule`
 * with the mode and the Swiss time, one fresh key per save), what it says (next run, last automatic
 * run, the `pay` right), and that a refusal is worded, never swallowed. Canned transport, synthetic.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { AutoSyncControl, type AutoSyncDto } from './AutoSyncControl';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

const DAILY: AutoSyncDto = {
  mode: 'daily',
  atTime: '07:00',
  explicit: false,
  nextAt: '2026-09-29T05:00:00.000Z',
  lastAuto: { finishedAt: '2026-09-28T05:02:30.000Z', ok: true, code: 'downloaded', retryable: false },
};

function renderControl(transport: Transport, props: Partial<Parameters<typeof AutoSyncControl>[0]> = {}) {
  const onSaved = vi.fn();
  render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider initialLocale="de-CH">
        <AutoSyncControl workspaceId="ws_test" connectionId="ebc_1" autoSync={DAILY} canPay onSaved={onSaved} {...props} />
      </I18nProvider>
    </TillClientProvider>,
  );
  return { onSaved };
}

/** At rest the control is one summary line; the editor opens behind "Ändern". */
async function openEditor() {
  await userEvent.click(screen.getByRole('button', { name: 'Ändern' }));
}

describe('the daily automatic fetch control', () => {
  it('at rest shows one summary line with the next run, and no editor', () => {
    // A next run in the future (the engine's `nextAt` is the next scheduled time, or now when due).
    renderControl(async () => ok(), { autoSync: { ...DAILY, nextAt: '2030-09-29T05:00:00.000Z' } });
    expect(screen.getByText('Automatisch täglich um 07:00 · nächster Abruf 29.09.2030 07:00')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Ändern' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('a run that is due now says so, never a bare time that contradicts the set one', () => {
    renderControl(async () => ok(), { autoSync: { ...DAILY, nextAt: new Date().toISOString() } });
    expect(screen.getByText('Automatisch täglich um 07:00 · heute noch offen, folgt gleich')).toBeInTheDocument();
  });

  it('switched off, the summary says it is off', () => {
    renderControl(async () => ok(), { autoSync: { ...DAILY, mode: 'off', nextAt: null } });
    expect(screen.getByText('Automatischer Abruf ist aus')).toBeInTheDocument();
  });

  it('the editor shows the setting and the last automatic run in Swiss time', async () => {
    renderControl(async () => ok());
    await openEditor();
    expect(screen.getByRole('checkbox', { name: 'Täglich automatisch abrufen' })).toBeChecked();
    expect(screen.getByLabelText('Um')).toHaveValue('07:00');
    expect(screen.getByText('Letzter automatischer Abruf: 28.09.2026 07:02')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled();
  });

  it('switching it off sends mode off with the time, a fresh key, and reloads the card', async () => {
    const seen: Record<string, unknown>[] = [];
    const { onSaved } = renderControl(async (action, input) => {
      if (action === 'set_bank_sync_schedule') seen.push(input);
      return ok({ connectionId: 'ebc_1', syncRuleId: null, autoSync: { mode: 'off', atTime: '07:00', explicit: true } });
    });
    await openEditor();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Täglich automatisch abrufen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(seen[0]).toMatchObject({ workspaceId: 'ws_test', connectionId: 'ebc_1', mode: 'off', atTime: '07:00' });
    expect(String(seen[0]?.idempotencyKey)).toMatch(/^d141-schedule-ebc_1-/);
    // A save closes the editor again.
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('a new time is saved with the daily mode', async () => {
    const seen: Record<string, unknown>[] = [];
    renderControl(async (action, input) => {
      if (action === 'set_bank_sync_schedule') seen.push(input);
      return ok({ connectionId: 'ebc_1', syncRuleId: null, autoSync: { mode: 'daily', atTime: '06:30', explicit: true } });
    });
    await openEditor();
    fireEvent.change(screen.getByLabelText('Um'), { target: { value: '06:30' } });
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ mode: 'daily', atTime: '06:30' });
  });

  it('without the pay right there is nothing to change, and the reason is said in words', () => {
    renderControl(async () => ok(), { canPay: false });
    expect(screen.queryByRole('button', { name: 'Ändern' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText(/nur, wer Zahlungen ausführen darf/)).toBeInTheDocument();
  });

  it('a refused save is worded, never swallowed', async () => {
    renderControl(async () => ({ status: 422, body: { ok: false, error: 'channel_retired', connectionId: 'ebc_1' } }));
    await openEditor();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Täglich automatisch abrufen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('critic R3-2: a last run with nobody to run as names a setter only when the schedule has one', () => {
    const noActor = { finishedAt: '2026-09-28T05:02:30.000Z', ok: false, code: 'auto_sync_no_actor', retryable: false };
    const { unmount } = render(
      <TillClientProvider client={new TillClient(async () => ok())}>
        <I18nProvider initialLocale="de-CH">
          <AutoSyncControl workspaceId="ws_test" connectionId="ebc_1" autoSync={{ ...DAILY, lastAuto: noActor, setterKnown: false }} canPay onSaved={() => {}} />
        </I18nProvider>
      </TillClientProvider>,
    );
    expect(screen.getByText(/Niemand hat ihn eingestellt, darum ruft TILL als Inhaber ab/)).toBeInTheDocument();
    expect(screen.queryByText(/die den Abruf eingestellt hat/)).toBeNull();
    unmount();
    renderControl(async () => ok(), { autoSync: { ...DAILY, lastAuto: noActor, setterKnown: true } });
    expect(screen.getByText(/Weder die Person, die den Abruf eingestellt hat, noch der Inhaber/)).toBeInTheDocument();
  });

  it('critic LB-1: a schedule an agent set says it runs as the owner, never names the agent as the person who set it', () => {
    const noActor = { finishedAt: '2026-09-28T05:02:30.000Z', ok: false, code: 'auto_sync_no_actor', retryable: false };
    renderControl(async () => ok(), { autoSync: { ...DAILY, lastAuto: noActor, setterKnown: false, scheduleSetter: 'agent' } });
    expect(screen.getByText(/Ein Agent hat ihn eingestellt, und was ein Agent einstellt, ruft TILL als Inhaber ab\. Der Inhaber darf keine Kontoauszüge abrufen\./)).toBeInTheDocument();
    expect(screen.queryByText(/Weder die Person|Niemand hat ihn eingestellt/)).toBeNull();
  });
});
