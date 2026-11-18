/**
 * D196 point 2, ONE-CLICK IGNORE: the panel's "Ignorieren" ignores in one click, with no reason list. The
 * reason is the workspace's `bank.ignore_default_reason` (D172) unless the caller named one; a note is
 * optional, behind the comment icon.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { I18nProvider } from '../../i18n';
import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type Transport } from '../../lib/client';
import { WorkspaceProvider } from '../../app/workspace';
import { IgnoreForm } from './IgnoreForm';
import { ignoreReasonOf } from './useIgnoreDefaultReason';
import type { BankInboxLine } from './model';
import type { Lookups } from './lookups';

const line = { bankTxnId: 'bt_1', amountMinor: 5000 } as unknown as BankInboxLine;
const lookups = { chartByNumber: new Map() } as unknown as Lookups;

function renderForm(defaultReason: string | null, onIgnore: (reason: string, note: string) => void, initialReason?: 'duplicate') {
  const transport: Transport = async (action) => {
    if (action === 'settings_get') {
      return defaultReason === null
        ? { status: 403, body: { ok: false, error: 'permission_denied' } }
        : { status: 200, body: { ok: true, setting: { key: 'bank.ignore_default_reason', value: defaultReason } } };
    }
    return { status: 200, body: { ok: true } };
  };
  render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <IgnoreForm line={line} lookups={lookups} busy={false} canPost initialReason={initialReason} onIgnore={onIgnore} onBookInstead={() => undefined} onCancel={() => undefined} />
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('D196 one-click ignore', () => {
  it('has no reason list, and one click ignores with the workspace default reason and no note', async () => {
    const onIgnore = vi.fn();
    renderForm('booked_elsewhere', onIgnore);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryByRole('textbox')).toBeNull();
    // Critic L4: the one click waits for the workspace default, then sends it.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ignorieren' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Ignorieren' }));
    expect(onIgnore).toHaveBeenCalledWith('booked_elsewhere', '');
  });

  it('the note is optional, behind the comment icon', async () => {
    const onIgnore = vi.fn();
    renderForm('other', onIgnore);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ignorieren' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Notiz hinzufügen' }));
    await userEvent.type(screen.getByRole('textbox'), '  Rückzahlung Kaution  ');
    await userEvent.click(screen.getByRole('button', { name: 'Ignorieren' }));
    expect(onIgnore).toHaveBeenCalledWith('other', 'Rückzahlung Kaution');
  });

  it('an unreadable setting falls back to other once the read failed', async () => {
    const onIgnore = vi.fn();
    renderForm(null, onIgnore);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ignorieren' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Ignorieren' }));
    expect(onIgnore).toHaveBeenCalledWith('other', '');
  });

  it('a reason the caller named wins; an unreadable setting falls back to other', async () => {
    const named = vi.fn();
    renderForm('other', named, 'duplicate');
    await userEvent.click(screen.getByRole('button', { name: 'Ignorieren' }));
    expect(named).toHaveBeenCalledWith('duplicate', '');
    expect(ignoreReasonOf(undefined)).toBe('other');
    expect(ignoreReasonOf({ setting: { value: 'nonsense' } })).toBe('other');
    expect(ignoreReasonOf({ setting: { value: 'clearing_account' } })).toBe('clearing_account');
  });
});
