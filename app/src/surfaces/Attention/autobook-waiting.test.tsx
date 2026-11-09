/**
 * A41.3 re-cut v2: the lines an autopilot rule waits on for their receipt ("wartet auf Beleg"), under the
 * newest digest card and on the rule's card. SYNTHETIC DATA ONLY: invented names, ids and figures.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { I18nProvider } from '../../i18n';
import { TillClient, type Transport } from '../../lib/client';
import { AutobookDigestLines, parseWaiting } from './AutobookDigestLines';
import { RuleWaitingChip, readWaitingByRule } from '../Bank/RuleAutopilot';

const WAITING = {
  bankTxnId: 'bt_w1',
  grantId: 'g_1',
  standardId: 'bs_1',
  ruleLabel: 'Hosting',
  counterparty: 'Wolkenhaus Hosting AG',
  amountMinor: -1_250,
  currency: 'CHF',
  lineDate: '2026-10-14',
  reason: 'no_beleg',
};

describe('A41.3: wartet auf Beleg', () => {
  it('the digest card lists the waiting lines with the engine\'s reason and a way to the line', () => {
    render(
      <MemoryRouter>
        <I18nProvider initialLocale="de-CH">
          <AutobookDigestLines digest={{ day: '2026-10-14', lines: [] }} busy={false} onAct={() => undefined} waiting={parseWaiting({ waitingForBeleg: [WAITING, { bad: true }] })} />
        </I18nProvider>
      </MemoryRouter>,
    );
    const list = screen.getByRole('list', { name: 'Wartet auf Beleg (1)' });
    expect(list).toHaveTextContent('Wolkenhaus Hosting AG, Regel Hosting');
    expect(list).toHaveTextContent('Wartet auf Beleg: kein Beleg zugeordnet');
    expect(within(list).getByRole('link', { name: 'Bankzeile öffnen' })).toHaveAttribute('href', '/bank?line=bt_w1');
  });

  // Critic A41.3 follow-ups r1 F2: a person-assigned line whose receipt evidences another booking waits
  // `beleg_in_use` on every tick; the engine now lists it, and the card says why in both locales.
  it('a line waiting beleg_in_use is listed with its own reason, in de-CH and en', () => {
    for (const [locale, text] of [
      ['de-CH', 'Wartet auf Beleg: der Beleg belegt schon eine andere Buchung, buche die Zeile selbst'],
      ['en', 'the receipt already evidences another booking, so book the line yourself'],
    ] as const) {
      const { unmount } = render(
        <MemoryRouter>
          <I18nProvider initialLocale={locale}>
            <AutobookDigestLines digest={{ day: '2026-10-14', lines: [] }} busy={false} onAct={() => undefined} waiting={parseWaiting({ waitingForBeleg: [{ ...WAITING, reason: 'beleg_in_use' }] })} />
          </I18nProvider>
        </MemoryRouter>,
      );
      expect(screen.getByRole('list', { name: /\(1\)/ })).toHaveTextContent(text);
      unmount();
    }
  });

  it('no waiting lines, or an engine without the field: no list', () => {
    expect(parseWaiting({})).toEqual([]);
    render(
      <MemoryRouter>
        <I18nProvider initialLocale="de-CH">
          <AutobookDigestLines digest={{ day: '2026-10-14', lines: [] }} busy={false} onAct={() => undefined} />
        </I18nProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByRole('list', { name: /Wartet auf Beleg/ })).toBeNull();
  });

  it('the rule card counts its waiting lines; a refused read is none', async () => {
    const transport: Transport = async () => ({ status: 200, body: { ok: true, waitingForBeleg: [WAITING, { ...WAITING, bankTxnId: 'bt_w2' }, { ...WAITING, standardId: 'bs_2' }] } });
    const counts = await readWaitingByRule(new TillClient(transport), 'ws_1');
    expect(counts.get('bs_1')).toBe(2);
    expect(counts.get('bs_2')).toBe(1);
    const refused = await readWaitingByRule(new TillClient(async () => ({ status: 403, body: { ok: false, error: 'permission_denied' } })), 'ws_1');
    expect(refused.size).toBe(0);
    render(
      <I18nProvider initialLocale="de-CH">
        <RuleWaitingChip count={2} />
        <RuleWaitingChip count={0} />
      </I18nProvider>,
    );
    expect(screen.getByText('2 Zeilen warten auf Beleg')).toBeInTheDocument();
  });
});
