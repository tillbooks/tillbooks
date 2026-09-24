/**
 * A33, the EBICS channel panel (spec §6/§8 component test): it renders the channel states, gates the
 * write controls behind `pay`, and drives connect / sync / disconnect through the client. THE LAW and
 * the money-path invariants live in the engine suite; here we prove the surface reaches the verbs and
 * shows the honest states (never colour alone: a glyph + label pair for every state).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { installMemoryStorage } from '../../lib/test-support';
import { CapabilitiesContext, CAP, type Capabilities } from '../../lib/capabilities';
import { EbicsChannelPanel } from './EbicsChannelPanel';
import type { BankAccount } from './model';

const ACCOUNTS: BankAccount[] = [
  { id: 'ba_1', name: 'Kontokorrent', iban: 'CH93 0076 2011 6238 5295 7' } as BankAccount,
];

/** A36's two status facets, the honest defaults every fixture below overrides only what it needs. */
const READY_KEYSTORE = { kind: 'file', state: 'ready', persistent: true };
const OFF_SCHEDULE = {
  ruleId: null as string | null,
  enabled: false,
  cadence: null as string | null,
  lastFiredAt: null as string | null,
  driverSeen: false,
  inactive: false,
};

const ACTIVE_CHANNEL = {
  connectionId: 'ebconn_1',
  host: { hostId: 'HOST', partnerId: 'PARTNER', userId: 'USER' },
  state: 'active',
  accounts: [{ bankAccountId: 'ba_1', iban: 'CH9300762011623852957' }],
  lastSyncAt: '2026-07-20T00:00:00.000Z',
  pendingIniLetter: null,
  pendingRelease: [],
  inDoubt: [],
  rejected: [],
  unmatchedFiles: [],
  recentOrders: [{ id: 'o1', orderRef: 'r1', orderType: 'BTD', status: 'ok', bankReason: null, occurredAt: '2026-07-20T00:00:00.000Z' }],
  keystore: READY_KEYSTORE,
  schedule: OFF_SCHEDULE,
};

const UBS_ENTRY = {
  bic: 'UBSWCHZH80A',
  names: ['UBS', 'UBS Switzerland AG'],
  hostUrl: null,
  hostId: null,
  ebicsNote: 'UBS offers EBICS 3.0 to business customers. An EBICS contract is required.',
  segments: ['business'],
  iniLetterAddress: 'Post the signed INI letter to the address named on your EBICS contract.',
  quirks: { dateRangeSupported: null, btfNotes: 'camt.053/054 statements, pain.001 upload over BTF.', protocolVersions: ['3.0'] },
  feeNote: { text: 'Confirm with your relationship manager.', verified: false, asOf: '2026-08-18' },
};

function ok(body: Record<string, unknown>): RestResponse {
  return { status: 200, body: { ok: true, ...body } };
}

function caps(held: readonly string[]): Capabilities {
  return {
    whoami: { actor: 'studio', provisioned: true, isMember: true, memberId: 'm1', userId: 'u1', role: 'viewer', capabilities: [...held] },
    can: (capability) => held.includes(capability),
    refresh: () => undefined,
  };
}

function renderPanel(transport: Transport, held: readonly string[] = [CAP.pay]) {
  return render(
    <MemoryRouter>
      <I18nProvider initialLocale="en">
        <WorkspaceProvider initialId="ws_test">
          <TillClientProvider client={new TillClient(transport)}>
            <CapabilitiesContext.Provider value={caps(held)}>
              <EbicsChannelPanel accounts={ACCOUNTS} />
            </CapabilitiesContext.Provider>
          </TillClientProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  installMemoryStorage();
});

describe('EbicsChannelPanel', () => {
  it('EMPTY: with no channel, names the file path as the standing floor and offers connect', async () => {
    const transport: Transport = async (action) => (action === 'bank_channel_status' ? ok({ channels: [] }) : { status: 404, body: { ok: false, error: 'x' } });
    renderPanel(transport);
    await waitFor(() => expect(screen.getByText(/file-based statement import/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /connect a channel/i })).toBeInTheDocument();
  });

  it('ERROR: a failed status read shows the error banner with a retry, NOT the empty "connect one" copy', async () => {
    let attempts = 0;
    const transport: Transport = async (action) => {
      if (action === 'bank_channel_status') {
        attempts += 1;
        // Fail the first read, recover on the retry so the banner is proven not to be a dead end.
        return attempts === 1
          ? { status: 500, body: { ok: false, error: 'channel_unreachable' } }
          : ok({ channels: [ACTIVE_CHANNEL] });
      }
      return { status: 404, body: { ok: false, error: 'x' } };
    };
    renderPanel(transport);
    // The failure renders the shared error banner, never the genuinely-empty channel copy.
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByText(/No EBICS channel yet/i)).not.toBeInTheDocument();
    // The retry refetches and recovers the real channel: an error is not a dead end.
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument());
  });

  it('LABELS: the route-account selects and the managed bank reference expose their visible label as the accessible name (no machine token)', async () => {
    const transport: Transport = async (action) => {
      if (action === 'bank_channel_status') return ok({ channels: [] });
      if (action === 'bank_channel_directory') return ok({ banks: [] });
      return { status: 404, body: { ok: false, error: 'x' } };
    };
    renderPanel(transport);
    await waitFor(() => expect(screen.getByText(/file-based statement import/i)).toBeInTheDocument());
    // The EBICS connect form's account select is reachable by its visible label, not "bankAccountId".
    await userEvent.click(screen.getByRole('button', { name: /connect a channel/i }));
    expect(screen.getByLabelText('Account to route')).toBeInTheDocument();
    expect(screen.queryByLabelText('bankAccountId')).not.toBeInTheDocument();
    // The managed (bLink) form's bank-reference input answers to its VISIBLE label, and its account
    // select to the shared visible label, never the raw "bankRef" / "managed-bankAccountId" tokens.
    await userEvent.click(screen.getByRole('button', { name: /connect via bLink/i }));
    expect(screen.getByLabelText('Your bank (bLink reference)')).toBeInTheDocument();
    expect(screen.queryByLabelText('bankRef')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('managed-bankAccountId')).not.toBeInTheDocument();
    expect(screen.getAllByLabelText('Account to route').length).toBe(2);
  });

  it('ACTIVE: renders the active state and Sync now drives bank_sync', async () => {
    const calls: string[] = [];
    const transport: Transport = async (action) => {
      calls.push(action);
      if (action === 'bank_channel_status') return ok({ channels: [ACTIVE_CHANNEL] });
      if (action === 'bank_sync') return ok({ connectionId: 'ebconn_1', files: [] });
      return { status: 404, body: { ok: false, error: 'x' } };
    };
    renderPanel(transport);
    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /sync now/i }));
    await waitFor(() => expect(calls).toContain('bank_sync'));
  });

  it('DISCONNECT: a single Block click ARMS a confirm and does NOT tear down; confirming drives bank_channel_disconnect', async () => {
    const calls: string[] = [];
    let disconnectInput: Record<string, unknown> | null = null;
    const transport: Transport = async (action, input) => {
      calls.push(action);
      if (action === 'bank_channel_status') return ok({ channels: [ACTIVE_CHANNEL] });
      if (action === 'bank_channel_disconnect') {
        disconnectInput = input;
        return ok({ connectionId: 'ebconn_1' });
      }
      return { status: 404, body: { ok: false, error: 'x' } };
    };
    renderPanel(transport);
    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument());

    // First click only ARMS the confirm: the teardown verb must NOT have fired yet.
    await userEvent.click(screen.getByRole('button', { name: /block \(SPR\)/i }));
    expect(calls).not.toContain('bank_channel_disconnect');
    expect(screen.getByText(/really block this connection/i)).toBeInTheDocument();

    // Confirming drives the verb once, with the armed mode and the untouched confirm:true wire arg.
    await userEvent.click(screen.getByRole('button', { name: /^confirm$/i }));
    await waitFor(() => expect(calls).toContain('bank_channel_disconnect'));
    expect(disconnectInput).toMatchObject({ mode: 'block', confirm: true });
  });

  it('DISCONNECT: Cancel disarms the confirm without tearing down', async () => {
    const calls: string[] = [];
    const transport: Transport = async (action) => {
      calls.push(action);
      if (action === 'bank_channel_status') return ok({ channels: [ACTIVE_CHANNEL] });
      if (action === 'bank_channel_disconnect') return ok({ connectionId: 'ebconn_1' });
      return { status: 404, body: { ok: false, error: 'x' } };
    };
    renderPanel(transport);
    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /retire/i }));
    expect(screen.getByText(/really retire this connection/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByText(/really retire this connection/i)).not.toBeInTheDocument();
    expect(calls).not.toContain('bank_channel_disconnect');
    // The arm buttons are back, no teardown ran.
    expect(screen.getByRole('button', { name: /retire/i })).toBeInTheDocument();
  });

  it('A36-U2: the last-sync and order log render humanised, not raw ISO instants or raw order/status codes', async () => {
    const transport: Transport = async (action) =>
      action === 'bank_channel_status' ? ok({ channels: [ACTIVE_CHANNEL] }) : { status: 404, body: { ok: false, error: 'x' } };
    renderPanel(transport);
    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument());
    // Last sync is a formatted date, never the raw ISO instant, with the instant kept as the tooltip.
    const lastSync = screen.getByText(/Last sync:/);
    expect(lastSync).toHaveTextContent('Last sync: 20.07.2026');
    expect(lastSync.textContent).not.toContain('2026-07-20T00:00:00.000Z');
    expect(lastSync).toHaveAttribute('title', '2026-07-20T00:00:00.000Z');
    // The order log humanises the BTF order type and the status enum, keeps the raw trail as title.
    await userEvent.click(screen.getByText(/order log/i));
    const order = screen.getByTitle('BTD · ok · 2026-07-20T00:00:00.000Z');
    expect(order).toHaveTextContent('Download · Succeeded · 20.07.2026');
    expect(order.textContent).not.toMatch(/BTD|\bok\b|2026-07-20T/);
  });

  it('PERMISSION: without pay, the write controls are replaced by a locked note (never shown then rejected)', async () => {
    const transport: Transport = async (action) => (action === 'bank_channel_status' ? ok({ channels: [ACTIVE_CHANNEL] }) : { status: 404, body: { ok: false, error: 'x' } });
    renderPanel(transport, []);
    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /sync now/i })).not.toBeInTheDocument();
    // A36 adds a second, per-control instance of the same honest reason (the schedule toggle's own
    // padlock note), so this is now `getAllByText`: the write wall AND the toggle both name it.
    expect(screen.getAllByText(/needs the payment capability/i).length).toBeGreaterThan(0);
  });
});

describe('EbicsChannelPanel: A36 bank picker', () => {
  it('HIT: querying the directory lists a bank; selecting it shows the note and the unverified-fee badge', async () => {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    const transport: Transport = async (action, input) => {
      calls.push({ action, input: input as Record<string, unknown> });
      if (action === 'bank_channel_status') return ok({ channels: [] });
      if (action === 'bank_channel_directory') return ok({ banks: [UBS_ENTRY] });
      return { status: 404, body: { ok: false, error: 'x' } };
    };
    renderPanel(transport);
    await waitFor(() => expect(screen.getByText(/file-based statement import/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /connect a channel/i }));
    const input = await screen.findByLabelText('Bank');
    await userEvent.type(input, 'UBS');
    const option = await screen.findByRole('option', { name: /UBS/ });
    await userEvent.click(option);
    expect(screen.getByText(UBS_ENTRY.ebicsNote)).toBeInTheDocument();
    expect(screen.getByText(/Unverified fee/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.some((c) => c.action === 'bank_channel_directory' && c.input['query'] === 'UBS')).toBe(true),
    );
  });

  it('EMPTY: a no-hit query names the empty state, and the manual host fields stay reachable (never a dead end)', async () => {
    const transport: Transport = async (action) => {
      if (action === 'bank_channel_status') return ok({ channels: [] });
      if (action === 'bank_channel_directory') return ok({ banks: [] });
      return { status: 404, body: { ok: false, error: 'x' } };
    };
    renderPanel(transport);
    await waitFor(() => expect(screen.getByText(/file-based statement import/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /connect a channel/i }));
    const input = await screen.findByLabelText('Bank');
    await userEvent.type(input, 'Nonexistent Bank');
    expect(await screen.findByText(/Bank not found/i)).toBeInTheDocument();
    // A36-U4: the host fields now carry a visible <label for>, not just a placeholder / aria-label.
    expect(screen.getByLabelText('Host URL')).toBeInTheDocument();
    expect(screen.getByLabelText('Host ID')).toBeInTheDocument();
    expect(screen.getByLabelText('Partner ID')).toBeInTheDocument();
    expect(screen.getByLabelText('User ID')).toBeInTheDocument();
  });
});

describe('EbicsChannelPanel: A36 keystore card', () => {
  it('MEMORY: shows the kind and the not-persistent notice (a heads-up, never a refusal)', async () => {
    const channel = { ...ACTIVE_CHANNEL, keystore: { kind: 'memory', state: 'ready', persistent: false } };
    const transport: Transport = async (action) =>
      action === 'bank_channel_status' ? ok({ channels: [channel] }) : { status: 404, body: { ok: false, error: 'x' } };
    renderPanel(transport);
    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument());
    expect(screen.getByText(/memory only/i)).toBeInTheDocument();
    expect(screen.getByText(/does not survive a restart/i)).toBeInTheDocument();
  });

  it('FILE: shows the kind and never renders the not-persistent notice', async () => {
    const transport: Transport = async (action) =>
      action === 'bank_channel_status' ? ok({ channels: [ACTIVE_CHANNEL] }) : { status: 404, body: { ok: false, error: 'x' } };
    renderPanel(transport);
    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument());
    expect(screen.getByText(/passphrase-encrypted/i)).toBeInTheDocument();
    expect(screen.queryByText(/does not survive a restart/i)).not.toBeInTheDocument();
  });

  it('LOCKED: the unlock control opens a labelled, focus-trapped dialog; Escape closes it and returns focus to the opener', async () => {
    const channel = { ...ACTIVE_CHANNEL, keystore: { kind: 'file', state: 'locked', persistent: true } };
    const transport: Transport = async (action) =>
      action === 'bank_channel_status' ? ok({ channels: [channel] }) : { status: 404, body: { ok: false, error: 'x' } };
    renderPanel(transport);
    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument());
    expect(screen.getByText(/passphrase was not entered this session/i)).toBeInTheDocument();
    const unlockButton = screen.getByRole('button', { name: 'Unlock' });
    await userEvent.click(unlockButton);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Unlock');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(unlockButton).toHaveFocus();
  });

  it('LOCKED: Tab from the last control in the dialog wraps to the first (focus trap)', async () => {
    const channel = { ...ACTIVE_CHANNEL, keystore: { kind: 'file', state: 'locked', persistent: true } };
    const transport: Transport = async (action) =>
      action === 'bank_channel_status' ? ok({ channels: [channel] }) : { status: 404, body: { ok: false, error: 'x' } };
    renderPanel(transport);
    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    const dialog = await screen.findByRole('dialog');
    // With no passphrase typed yet, the submit control stays disabled (excluded from the tab order),
    // so the trap's two ends are the passphrase field and Cancel.
    const field = within(dialog).getByLabelText('Unlock');
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    cancel.focus();
    await userEvent.tab();
    expect(field).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(cancel).toHaveFocus();
  });

  it('UNAVAILABLE: names the two recoveries, neither of which touches the bank contract', async () => {
    const channel = { ...ACTIVE_CHANNEL, keystore: { kind: 'file', state: 'unavailable', persistent: true } };
    const transport: Transport = async (action) =>
      action === 'bank_channel_status' ? ok({ channels: [channel] }) : { status: 404, body: { ok: false, error: 'x' } };
    renderPanel(transport);
    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/re-initialise the connection/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/bank contract is unaffected/i);
  });
});

describe('EbicsChannelPanel: A36 Automatischer Abruf (the cadence toggle)', () => {
  it('OFF -> ON: states the scheduled egress up front, creates the G01 rule, then links it', async () => {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    let channel = { ...ACTIVE_CHANNEL };
    const transport: Transport = async (action, input) => {
      calls.push({ action, input: input as Record<string, unknown> });
      if (action === 'bank_channel_status') return ok({ channels: [channel] });
      if (action === 'create_automation_rule') return ok({ rule: { id: 'arule_1' } });
      if (action === 'set_bank_sync_schedule') {
        channel = {
          ...channel,
          schedule: { ruleId: 'arule_1', enabled: true, cadence: 'schedule.daily', lastFiredAt: null, driverSeen: true, inactive: false },
        };
        return ok({ connectionId: channel.connectionId, syncRuleId: 'arule_1' });
      }
      return { status: 404, body: { ok: false, error: 'x' } };
    };
    renderPanel(transport, [CAP.pay, CAP.manageAutomations]);
    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument());
    expect(screen.getByText(/scheduled network egress/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: /automatic fetch/i }));
    await waitFor(() =>
      expect(calls.some((c) => c.action === 'create_automation_rule' && c.input['trigger'] && (c.input['trigger'] as { event: string }).event === 'schedule.daily')).toBe(
        true,
      ),
    );
    await waitFor(() =>
      expect(calls.some((c) => c.action === 'set_bank_sync_schedule' && c.input['ruleId'] === 'arule_1')).toBe(true),
    );
  });

  it('INACTIVE: an enabled schedule with no driver names the M00 scheduler daemon and Sync now', async () => {
    const channel = {
      ...ACTIVE_CHANNEL,
      schedule: { ruleId: 'arule_2', enabled: true, cadence: 'schedule.daily', lastFiredAt: null, driverSeen: false, inactive: true },
    };
    const transport: Transport = async (action) =>
      action === 'bank_channel_status' ? ok({ channels: [channel] }) : { status: 404, body: { ok: false, error: 'x' } };
    renderPanel(transport, [CAP.pay, CAP.manageAutomations]);
    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument());
    expect(screen.getByText(/M00/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /automatic fetch/i })).toBeChecked();
  });

  it('PERMISSION: without manage_automations, the toggle is pre-disabled and announces why via aria-describedby', async () => {
    const transport: Transport = async (action) =>
      action === 'bank_channel_status' ? ok({ channels: [ACTIVE_CHANNEL] }) : { status: 404, body: { ok: false, error: 'x' } };
    renderPanel(transport, [CAP.pay]);
    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument());
    const toggle = screen.getByRole('checkbox', { name: /automatic fetch/i });
    expect(toggle).toBeDisabled();
    const describedBy = toggle.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy as string)).toHaveTextContent(/payment capability/i);
  });
});

// A37: the managed (bLink) rail on the SAME panel (spec §6). The card is kind-labelled, shows consent
// state, and reaches the five verbs by channelKind; the honest OP4 card renders on the tier-off notice.
const MANAGED_ACTIVE = {
  connectionId: 'mconn_1',
  channelKind: 'managed_blink',
  provider: 'blink',
  bankRef: 'blink:UBS-CH',
  scopes: ['ais', 'pss'],
  bankConsentExpiresAt: '2027-01-01',
  state: 'active',
  accounts: [{ bankAccountId: 'ba_1', iban: 'CH9300762011623852957' }],
  lastSyncAt: '2026-07-20T00:00:00.000Z',
  pendingRelease: [],
  inDoubt: [],
  rejected: [],
  unmatchedFiles: [],
  recentOrders: [{ id: 'o1', orderRef: 'r1', kind: 'statements', status: 'ok', bankReason: null, occurredAt: '2026-07-20T00:00:00.000Z' }],
};

describe('EbicsChannelPanel: A37 managed (bLink) rail', () => {
  it('renders a managed channel kind-labelled and drives bank_sync', async () => {
    const calls: string[] = [];
    const transport: Transport = async (action) => {
      calls.push(action);
      if (action === 'bank_channel_status') return ok({ channels: [MANAGED_ACTIVE] });
      if (action === 'bank_sync') return ok({ connectionId: 'mconn_1', files: [] });
      return { status: 404, body: { ok: false, error: 'x' } };
    };
    renderPanel(transport);
    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument());
    // The rail label ("bLink") appears as text, never colour alone (the kind chip on the state row).
    expect(screen.getAllByText(/bLink/).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: /sync now/i }));
    await waitFor(() => expect(calls).toContain('bank_sync'));
  });

  it('a consent_pending managed channel shows the waiting-for-bank state and a resume action', async () => {
    const channel = { ...MANAGED_ACTIVE, state: 'consent_pending', lastSyncAt: null };
    const transport: Transport = async (action) =>
      action === 'bank_channel_status' ? ok({ channels: [channel] }) : { status: 404, body: { ok: false, error: 'x' } };
    renderPanel(transport);
    await waitFor(() => expect(screen.getAllByText(/Waiting for your bank/i).length).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: /resume consent/i })).toBeInTheDocument();
  });

  it('a consent_revoked managed channel names the bank as where consent lives and offers reconnect', async () => {
    const channel = { ...MANAGED_ACTIVE, state: 'consent_revoked' };
    const transport: Transport = async (action) =>
      action === 'bank_channel_status' ? ok({ channels: [channel] }) : { status: 404, body: { ok: false, error: 'x' } };
    renderPanel(transport);
    await waitFor(() => expect(screen.getByText(/revoked at your bank/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /reconnect/i })).toBeInTheDocument();
  });

  it('the managed connect button reaches bank_channel_connect with channelKind managed_blink; tier-off shows the OP4 card', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    const transport: Transport = async (action, input) => {
      calls.push({ action, input: input as Record<string, unknown> });
      if (action === 'bank_channel_status') return ok({ channels: [] });
      if (action === 'bank_channel_connect') return { status: 200, body: { ok: false, error: 'cloud_tier' } };
      return { status: 404, body: { ok: false, error: 'x' } };
    };
    renderPanel(transport);
    await waitFor(() => expect(screen.getByRole('button', { name: /connect via bLink/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /connect via bLink/i }));
    await userEvent.type(screen.getByLabelText('Your bank (bLink reference)'), 'blink:UBS-CH');
    await userEvent.click(screen.getByRole('button', { name: /connect via bLink/i }));
    await waitFor(() => {
      const connect = calls.find((c) => c.action === 'bank_channel_connect');
      expect(connect?.input.channelKind).toBe('managed_blink');
    });
    // The tier-off cloud_tier code renders the honest OP4 explainer, never a stack trace.
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/optional tier your owner enables/i));
  });
});
