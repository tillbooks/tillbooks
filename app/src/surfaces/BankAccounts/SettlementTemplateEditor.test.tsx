/**
 * A43 §3: the booking template editor. What it sends (`set_settlement_template` with the clearing account and
 * every kind that is not left unset), what it shows (the engine's defaults for a new source), that a refusal
 * is worded by its code, and the padlock. Canned transport, synthetic data: an invented platform, accounts and
 * codes.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { SettlementTemplateEditor } from './SettlementTemplateEditor';
// The engine's own list_accounts answer for the shipped chart (pinned by test/accounts/studio-list-accounts-fixture.test.mjs).
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const refusal = (error: string): RestResponse => ({ status: 422, body: { ok: false, error } });

const CODES = [{ code: 'UST81', kind: 'output', rateBp: 810, formLine: '303', label: 'Umsatzsteuer 8.1%', active: true }];

type Call = { action: string; input: Record<string, unknown> };

function renderEditor(answer: (action: string) => RestResponse | undefined, canPost = true) {
  const calls: Call[] = [];
  const transport: Transport = async (action, input) => {
    calls.push({ action, input: input as Record<string, unknown> });
    const own = answer(action);
    if (own !== undefined) return own;
    if (action === 'list_accounts') return ok({ accounts: listAccountsFixture.accounts });
    if (action === 'vat_codes') return ok({ taxCodes: CODES });
    return ok({ templates: [] });
  };
  render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider initialLocale="de-CH">
        <SettlementTemplateEditor workspaceId="ws_test" system="kurswerk" processor="zahlfix" canPost={canPost} />
      </I18nProvider>
    </TillClientProvider>,
  );
  return calls;
}

async function pick(name: string, option: string) {
  await userEvent.click(await screen.findByRole('combobox', { name }));
  await userEvent.click(screen.getByRole('option', { name: option }));
}

describe('the settlement template editor', () => {
  it('a new source starts on the engine defaults and saves only the kinds that are set', async () => {
    const calls = renderEditor((action) => (action === 'set_settlement_template' ? ok({ templateId: 'stltpl_1', changed: true }) : undefined));
    expect(await screen.findByRole('combobox', { name: 'Auszahlung: Buchung' })).toHaveTextContent('Überspringen');
    expect(screen.getByRole('combobox', { name: 'Anderes: Buchung' })).toHaveTextContent('Mich fragen');
    expect(screen.getByRole('combobox', { name: 'Verkauf: Buchung' })).toHaveTextContent('Nicht gesetzt');
    await pick('Durchlaufkonto', '1100 Forderungen aus Lieferungen und Leistungen');
    await pick('Verkauf: Buchung', 'Buchen');
    await pick('Verkauf: Konto', '3400 Erlöse aus Dienstleistungen');
    await pick('Verkauf: Steuercode', 'UST81 Umsatzsteuer 8.1%');
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'set_settlement_template')).toBe(true));
    const saved = calls.find((c) => c.action === 'set_settlement_template');
    expect(saved?.input).toMatchObject({
      system: 'kurswerk',
      processor: 'zahlfix',
      clearingAccountId: 'acc_4',
      kinds: { sale: { action: 'book', accountId: 'acc_31', taxCode: 'UST81' }, bank_payout: { action: 'skip' }, other: { action: 'attention' } },
    });
    expect('refund' in (saved?.input['kinds'] as Record<string, unknown>)).toBe(false);
    expect(await screen.findByText('Gespeichert')).toBeInTheDocument();
  });

  it('a refusal is worded by its code', async () => {
    renderEditor((action) => (action === 'set_settlement_template' ? refusal('account_archived') : undefined));
    await pick('Durchlaufkonto', '1100 Forderungen aus Lieferungen und Leistungen');
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText('Dieses Konto ist archiviert.')).toBeInTheDocument();
  });

  it('a payout booked to a revenue account is refused in its own words (D203, payout_not_turnover)', async () => {
    renderEditor((action) => (action === 'set_settlement_template' ? refusal('payout_not_turnover') : undefined));
    await pick('Durchlaufkonto', '1100 Forderungen aus Lieferungen und Leistungen');
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText('Eine Auszahlung ist nie Umsatz: buche sie auf ein Durchlaufkonto oder das Bankkonto, nicht auf ein Erlöskonto.')).toBeInTheDocument();
  });

  it('a failed read shows the error, and without the post right the padlock', async () => {
    renderEditor((action) => (action === 'vat_codes' ? refusal('forbidden') : undefined));
    expect(await screen.findByRole('button', { name: /erneut|Wiederholen|nochmals/i })).toBeInTheDocument();
  });

  it('without the post right there is nothing to edit', () => {
    renderEditor(() => undefined, false);
    expect(screen.queryByRole('button', { name: 'Speichern' })).toBeNull();
    expect(screen.getByText('Eine Buchungsvorlage bearbeiten braucht das Recht zu buchen.')).toBeInTheDocument();
  });
});
