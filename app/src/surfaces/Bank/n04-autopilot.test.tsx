/**
 * N04 (D183): the rule card's autopilot (chip, switch "Künftig automatisch") and a Vorlage's "Wiederholen"
 * section with "Nächste Ausführung". SYNTHETIC DATA ONLY: invented ids, names and amounts.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { RuleAutopilotChip, RuleAutopilotSwitch, type AutobookCandidate } from './RuleAutopilot';
import { VorlageScheduleSection } from './VorlageSchedule';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
type Call = { action: string; input: Record<string, unknown> };

function wrap(transport: Transport, ui: ReactNode) {
  return render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider initialLocale="de-CH">{ui}</I18nProvider>
    </TillClientProvider>,
  );
}

const base: AutobookCandidate = {
  standardId: 'bstd_telco',
  label: null,
  counterparty: 'Fernmeldewerk Beispiel AG',
  eligible: true,
  ineligibleReason: null,
  cleanUses: 10,
  humanCleanUses: 10,
  ceilingPreview: { amountMinor: 13485, currency: 'CHF' },
  grant: null,
  offerActionId: null,
  grantable: true,
};
const grant = (state: 'active' | 'suspended', suspendedReason: string | null = null) =>
  ({ grantId: 'agrant_1', standardId: 'bstd_telco', state, grantedBy: 'user_1', grantedAt: '2026-11-01T08:00:00.000Z', ceilingMinor: 13485, currency: 'CHF', cleanUsesAtGrant: 10, suspendedAt: null, suspendedReason, revokedAt: null }) as AutobookCandidate['grant'];

describe('N04: the rule card autopilot', () => {
  it('the chip says Automatisch, or Pausiert with the reason; none without a grant', () => {
    const { rerender, container } = wrap(async () => ok(), <RuleAutopilotChip candidate={{ ...base, grant: grant('active') }} />);
    expect(screen.getByText('Automatisch')).toBeTruthy();
    rerender(
      <TillClientProvider client={new TillClient(async () => ok())}>
        <I18nProvider initialLocale="de-CH">
          <RuleAutopilotChip candidate={{ ...base, grant: grant('suspended', 'reopened') }} />
        </I18nProvider>
      </TillClientProvider>,
    );
    expect(screen.getByText('Pausiert: eine Buchung wurde rückgängig gemacht')).toBeTruthy();
    rerender(
      <TillClientProvider client={new TillClient(async () => ok())}>
        <I18nProvider initialLocale="de-CH">
          <RuleAutopilotChip candidate={base} />
        </I18nProvider>
      </TillClientProvider>,
    );
    expect(container.querySelector('.bank-rules__auto')).toBeNull();
  });

  it('the switch grants an earned rule, showing the ceiling it fixes', async () => {
    const calls: Call[] = [];
    let changed = 0;
    wrap(async (action, input) => (calls.push({ action, input }), ok()), <RuleAutopilotSwitch workspaceId="ws_test" candidate={base} offerAfter={10} onChanged={() => (changed += 1)} />);
    expect(screen.getByText(/Bis CHF\s?134\.85 pro Zeile, nur in CHF/)).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Künftig automatisch' }));
    await waitFor(() => expect(changed).toBe(1));
    expect(calls[0]).toMatchObject({ action: 'grant_rule_autobook', input: { workspaceId: 'ws_test', standardId: 'bstd_telco' } });
  });

  it('the switch is off and disabled with the reason when the rule cannot earn it or has not yet', () => {
    wrap(async () => ok(), <RuleAutopilotSwitch workspaceId="ws_test" candidate={{ ...base, eligible: false, ineligibleReason: 'name_key', grantable: false }} offerAfter={10} onChanged={() => undefined} />);
    const sw = screen.getByRole('switch', { name: 'Künftig automatisch' }) as HTMLInputElement;
    expect(sw.disabled).toBe(true);
    expect(screen.getByText('Die Regel erkennt die Gegenpartei nur am Namen; sie braucht eine IBAN')).toBeTruthy();
  });

  it('an active switch revokes', async () => {
    const calls: Call[] = [];
    wrap(async (action, input) => (calls.push({ action, input }), ok()), <RuleAutopilotSwitch workspaceId="ws_test" candidate={{ ...base, grant: grant('active'), grantable: false }} offerAfter={10} onChanged={() => undefined} />);
    const sw = screen.getByRole('switch', { name: 'Künftig automatisch' }) as HTMLInputElement;
    expect(sw.checked).toBe(true);
    fireEvent.click(sw);
    await waitFor(() => expect(calls.some((c) => c.action === 'revoke_rule_autobook')).toBe(true));
  });
});

describe('N04: Wiederholen on a Vorlage', () => {
  const schedule = {
    scheduleId: 'vsched_1',
    seriesId: 'bstd_miete',
    liveVersionId: 'bstd_miete',
    label: 'Miete',
    every: 'month',
    anchorDay: 1,
    start: '2026-11-01',
    end: null,
    mode: 'post',
    effectiveMode: 'propose',
    asks: { 0: 250000 },
    setBy: 'user_1',
    setAt: '2026-11-01T08:00:00.000Z',
    status: 'active',
    endReason: null,
    nextRun: '2026-12-01',
    runs: [],
  };

  it('shows the next run, says an edit dropped Direkt buchen to proposing, and saves the asked amount by leg index', async () => {
    const calls: Call[] = [];
    wrap(
      async (action, input) => {
        calls.push({ action, input });
        if (action === 'vorlage_schedules') return ok({ schedules: [schedule] });
        return ok();
      },
      <VorlageScheduleSection workspaceId="ws_test" vorlageId="bstd_miete" asks={[{ index: 0, label: 'Miete' }]} canEdit today="2026-11-03" />,
    );
    expect(await screen.findByText(/Nächste Ausführung: 01\.12\.2026/)).toBeTruthy();
    expect(screen.getByText(/schlägt vor, bis du sie neu setzt/)).toBeTruthy();
    expect((screen.getByLabelText('Miete') as HTMLInputElement).value).toBe('2500.00');
    fireEvent.change(screen.getByLabelText('Miete'), { target: { value: "2'600.00" } });
    fireEvent.click(screen.getByRole('button', { name: 'Wiederholen' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'set_vorlage_schedule')).toBe(true));
    expect(calls.find((c) => c.action === 'set_vorlage_schedule')?.input).toMatchObject({ vorlageId: 'bstd_miete', every: 'month', anchorDay: 1, start: '2026-11-01', mode: 'post', asks: { 0: 260000 } });
    fireEvent.click(screen.getByRole('button', { name: 'Nicht mehr wiederholen' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'clear_vorlage_schedule' && c.input.scheduleId === 'vsched_1')).toBe(true));
  });

  it('without a schedule it says so and proposes by default', async () => {
    const calls: Call[] = [];
    wrap(
      async (action, input) => {
        calls.push({ action, input });
        if (action === 'vorlage_schedules') return ok({ schedules: [] });
        return ok();
      },
      <VorlageScheduleSection workspaceId="ws_test" vorlageId="bstd_miete" asks={[]} canEdit today="2026-11-03" />,
    );
    expect(await screen.findByText('Wird nicht wiederholt')).toBeTruthy();
    expect((screen.getByRole('radio', { name: 'Vorschlagen' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Wiederholen' }));
    await waitFor(() => expect(calls.find((c) => c.action === 'set_vorlage_schedule')?.input).toMatchObject({ mode: 'propose', start: '2026-11-03', asks: {} }));
  });
});
