/**
 * A33 + A36, the EBICS channel panel (spec A36 §5 component test): it renders the channel states, gates
 * the write controls behind `pay`, drives connect / fetch / the two-step bank-key review / disconnect
 * through the client, shows per account the newest statement and every waiting statement in words, and
 * words every refusal through the one path. The money-path invariants live in the engine suites; here we
 * prove the surface reaches the verbs and shows the honest states (a glyph + label pair for every state).
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

/** The keystore facet, the honest default every fixture below overrides only where it needs to. */
const READY_KEYSTORE = { kind: 'file', state: 'ready', persistent: true };

/** An active EBICS channel as `bank_channel_status` returns it since A36 (download only). */
const ACTIVE_CHANNEL = {
  connectionId: 'ebconn_1',
  channelKind: 'ebics',
  host: { hostId: 'HOST', partnerId: 'PARTNER', userId: 'USER' },
  protocolVersion: 'H005',
  state: 'active',
  activatedAt: '2026-07-19T00:00:00.000Z',
  ceremony: { ini: 'confirmed', hia: 'confirmed', refusal: null as string | null },
  accounts: [
    {
      bankAccountId: 'ba_1',
      iban: 'CH9300762011623852957',
      newestStatement: { number: 214, year: 2026, fromDate: '2026-07-19', toDate: '2026-07-19', openingBalanceMinor: 964235, closingBalanceMinor: 976082, currency: 'CHF' },
    },
  ],
  lastSyncAt: '2026-07-20T00:00:00.000Z',
  pendingIniLetter: null,
  iniLetterDocumentId: 'file_1',
  pendingStatements: [] as Record<string, unknown>[],
  recentOrders: [{ id: 'o1', orderRef: 'r1', orderType: 'BTD', status: 'ok', bankReason: null, occurredAt: '2026-07-20T00:00:00.000Z' }],
  keystore: READY_KEYSTORE,
};

/** The bank's hashes as the engine returns them from HPB, and the lines ZKB's sheet prints. */
const BANK_HASHES = {
  electronicSignature: '',
  authentication: 'a'.repeat(64),
  encryption: 'b'.repeat(64),
  certificateHashes: { authentication: 'c'.repeat(64), encryption: 'd'.repeat(64) },
  keyHashes: { authentication: 'e'.repeat(64), encryption: 'f'.repeat(64) },
};
const lines = (ch: string) => Array.from({ length: 4 }, () => Array.from({ length: 8 }, () => ch.toUpperCase().repeat(2)).join(' '));
const BANK_KEY_LINES = {
  authentication: { certificate: lines('c'), key: lines('e'), spki: lines('a') },
  encryption: { certificate: lines('d'), key: lines('f'), spki: lines('b') },
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
    await waitFor(() => expect(screen.getByText(/importing statements by hand/i)).toBeInTheDocument());
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
    await waitFor(() => expect(screen.getByText(/importing statements by hand/i)).toBeInTheDocument());
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

  it('ACTIVE: renders the active state, the newest statement, the eBanking note; Fetch statements drives bank_sync with a fresh key', async () => {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    const transport: Transport = async (action, input) => {
      calls.push({ action, input: input as Record<string, unknown> });
      if (action === 'bank_channel_status') return ok({ channels: [ACTIVE_CHANNEL] });
      if (action === 'bank_sync') return ok({ connectionId: 'ebconn_1', download: { outcome: 'downloaded' }, statements: [{ outcome: 'imported', final: true }, { outcome: 'gap_refused', final: false }] });
      return { status: 404, body: { ok: false, error: 'x' } };
    };
    renderPanel(transport);
    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument());
    expect(screen.getByText(/Newest statement in the books: no\. 214\/2026 of 19\.07\.2026, closing balance/)).toBeInTheDocument();
    expect(screen.getByText(/All data not yet retrieved/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /fetch statements/i }));
    await waitFor(() => expect(calls.some((c) => c.action === 'bank_sync')).toBe(true));
    const sync = calls.find((c) => c.action === 'bank_sync');
    expect(sync?.input).toMatchObject({ connectionId: 'ebconn_1' });
    expect(String(sync?.input.idempotencyKey)).toMatch(/^a36-sync-ebconn_1-\d+$/);
    expect(sync?.input.dateRange).toBeUndefined();
    await waitFor(() => expect(screen.getByText(/1 statements imported, 1 waiting/)).toBeInTheDocument());
  });

  it('A36C-1: a number jump is said in the fetch feedback AND on the account line from the status, naming the skipped numbers', async () => {
    const jump = { after: { number: 214, year: 2026 }, statement: { number: 216, year: 2026 }, skipped: [{ year: 2026, from: 215, to: 215 }] };
    let synced = false;
    const transport: Transport = async (action) => {
      if (action === 'bank_channel_status') {
        const account = { ...ACTIVE_CHANNEL.accounts[0], lastNumberJump: synced ? jump : null };
        return ok({ channels: [{ ...ACTIVE_CHANNEL, accounts: [account] }] });
      }
      if (action === 'bank_sync') {
        synced = true;
        return ok({ connectionId: 'ebconn_1', download: { outcome: 'downloaded' }, statements: [{ outcome: 'imported', final: true, notice: 'statement_number_jump', jump }] });
      }
      return { status: 404, body: { ok: false, error: 'x' } };
    };
    renderPanel(transport);
    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument());
    expect(screen.queryByText(/Missing numbers/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /fetch statements/i }));
    // Once in the fetch feedback, once on the account line the status keeps after the feedback is gone.
    await waitFor(() => expect(screen.getAllByText(/Statement 216 came after statement 214\. Missing numbers: 215\/2026\./).length).toBe(2));
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
    await userEvent.click(screen.getByRole('button', { name: /^block$/i }));
    expect(calls).not.toContain('bank_channel_disconnect');
    expect(screen.getByText(/really block this channel\? TILL then fetches nothing more\. To block it at ZKB: by phone/i)).toBeInTheDocument();

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
    // Last fetched is a formatted date, never the raw ISO instant, with the instant kept as the tooltip.
    const lastSync = screen.getByText(/Last fetched:/);
    expect(lastSync).toHaveTextContent('Last fetched: 20.07.2026');
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
    expect(screen.queryByRole('button', { name: /fetch statements/i })).not.toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByText(/importing statements by hand/i)).toBeInTheDocument());
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
    await waitFor(() => expect(screen.getByText(/importing statements by hand/i)).toBeInTheDocument());
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

describe('EbicsChannelPanel: A36 the feed and the bank-key review', () => {
  it('WAITING: each waiting statement says why it waits and what to do, in words (never a code)', async () => {
    const channel = {
      ...ACTIVE_CHANNEL,
      pendingStatements: [
        { documentId: 'f1', payloadSha256: 's1', since: '2026-07-20T00:00:00.000Z', code: 'gap_refused', bankAccountId: 'ba_1', statement: { number: 216, year: 2026, fromDate: '2026-07-21', toDate: '2026-07-21', iban: 'CH9300762011623852957' }, details: { against: { number: 214, year: 2026 } } },
        { documentId: 'f2', payloadSha256: 's2', since: '2026-07-20T00:00:00.000Z', code: 'unmatched_account', bankAccountId: null, statement: { number: 1, year: 2026, fromDate: '2026-07-21', toDate: '2026-07-21', iban: 'CH5604835012345678009' } },
        { documentId: 'f3', payloadSha256: 's3', since: '2026-07-20T00:00:00.000Z', code: 'gap_refused', bankAccountId: 'ba_1', readyToImport: true, statement: { number: 215, year: 2026, fromDate: '2026-07-20', toDate: '2026-07-20', iban: 'CH9300762011623852957' } },
      ],
    };
    const transport: Transport = async (action) => (action === 'bank_channel_status' ? ok({ channels: [channel] }) : { status: 404, body: { ok: false, error: 'x' } });
    renderPanel(transport);
    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument());
    expect(screen.getByText('Waiting statements')).toBeInTheDocument();
    expect(screen.getByText('Statement 216 does not follow statement 214. Import the missing day-end statement from e-banking, then fetch again.')).toBeInTheDocument();
    expect(screen.getByText(/Statement for IBAN CH5604835012345678009, which belongs to no routed account/)).toBeInTheDocument();
    expect(screen.getByText('Statement 215 fits now: the next fetch imports it.')).toBeInTheDocument();
    expect(screen.queryByText(/gap_refused|unmatched_account/)).not.toBeInTheDocument();
  });

  it('KEY REVIEW: fetch shows the hashes 8 pairs per line; confirm waits for the checkbox and pins exactly the reviewed set', async () => {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    let channel: Record<string, unknown> = { ...ACTIVE_CHANNEL, state: 'pending_bank_activation', accounts: [{ bankAccountId: 'ba_1', iban: 'CH9300762011623852957', newestStatement: null }] };
    const transport: Transport = async (action, input) => {
      const i = input as Record<string, unknown>;
      calls.push({ action, input: i });
      if (action === 'bank_channel_status') return ok({ channels: [channel] });
      if (action === 'bank_channel_connect' && i.confirmBankKeys !== true) {
        return ok({ connectionId: 'ebconn_1', state: 'pending_bank_activation', bankKeyHashes: BANK_HASHES, bankKeyLines: BANK_KEY_LINES, awaitingConfirmation: true });
      }
      if (action === 'bank_channel_connect') {
        channel = { ...channel, state: 'active' };
        return ok({ connectionId: 'ebconn_1', state: 'active' });
      }
      return { status: 404, body: { ok: false, error: 'x' } };
    };
    renderPanel(transport);
    await waitFor(() => expect(screen.getByText('Waiting on the bank')).toBeInTheDocument());
    expect(screen.getByText(/Sign the INI letter/)).toBeInTheDocument();
    expect(screen.getByText(/No day-end statement in the books yet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /fetch and compare the bank keys/i }));
    const review = await screen.findByRole('region', { name: /compare and confirm the bank keys/i });
    expect(within(review).getByText(/H005 mit Zertifikat/)).toBeInTheDocument();
    const certBlock = within(review).getByLabelText('Authentication (X002), Certificate, SHA-256');
    expect(certBlock.textContent?.split('\n')).toEqual(lines('c'));
    expect(certBlock.textContent?.split('\n')[0]?.split(' ')).toHaveLength(8);
    const confirm = within(review).getByRole('button', { name: 'Confirm the bank keys' });
    expect(confirm).toBeDisabled();
    await userEvent.click(within(review).getByRole('checkbox'));
    await userEvent.click(confirm);
    await waitFor(() => expect(calls.some((c) => c.action === 'bank_channel_connect' && c.input.confirmBankKeys === true)).toBe(true));
    const pinned = calls.find((c) => c.action === 'bank_channel_connect' && c.input.confirmBankKeys === true);
    expect(pinned?.input.expectedBankKeyHashes).toEqual(BANK_HASHES);
    await waitFor(() => expect(screen.getByText('Bank keys confirmed')).toBeInTheDocument());
  });

  it('KEY REVIEW: a set that changed since the review is a hard stop that pins nothing', async () => {
    const channel = { ...ACTIVE_CHANNEL, state: 'bank_keys_changed' };
    const transport: Transport = async (action, input) => {
      const i = input as Record<string, unknown>;
      if (action === 'bank_channel_status') return ok({ channels: [channel] });
      if (action === 'bank_channel_connect' && i.confirmBankKeys !== true) return ok({ connectionId: 'ebconn_1', state: 'bank_keys_changed', bankKeyHashes: BANK_HASHES, bankKeyLines: BANK_KEY_LINES });
      if (action === 'bank_channel_connect') return { status: 422, body: { ok: false, error: 'bank_keys_mismatch', reason: 'changed_since_review' } };
      return { status: 404, body: { ok: false, error: 'x' } };
    };
    renderPanel(transport);
    await waitFor(() => expect(screen.getByText(/ZKB's keys have changed/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /fetch and compare the bank keys/i }));
    const review = await screen.findByRole('region', { name: /compare and confirm the bank keys/i });
    await userEvent.click(within(review).getByRole('checkbox'));
    await userEvent.click(within(review).getByRole('button', { name: 'Confirm the bank keys' }));
    await waitFor(() => expect(screen.getByText(/ZKB now sends other keys than the ones you checked/)).toBeInTheDocument());
  });

  it('INIT REFUSED: 091002 on both legs is said plainly (only ZKB can tell the cases apart); Send again resends', async () => {
    const calls: string[] = [];
    const channel = { ...ACTIVE_CHANNEL, state: 'ini_sent', ceremony: { ini: '091002', hia: '091002', refusal: 'init_refused' } };
    const transport: Transport = async (action) => {
      calls.push(action);
      if (action === 'bank_channel_status') return ok({ channels: [channel] });
      if (action === 'bank_channel_connect') return { status: 422, body: { ok: false, error: 'init_refused', code: '091002' } };
      return { status: 404, body: { ok: false, error: 'x' } };
    };
    renderPanel(transport);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/ZKB refused INI and HIA with 091002/));
    expect(screen.getByRole('alert')).toHaveTextContent(/partner ID or user ID is wrong/);
    await userEvent.click(screen.getByRole('button', { name: /send again/i }));
    await waitFor(() => expect(calls).toContain('bank_channel_connect'));
  });

  it('REFUSAL: a download refusal is worded through the one path, naming the class and the raw code', async () => {
    const transport: Transport = async (action) => {
      if (action === 'bank_channel_status') return ok({ channels: [ACTIVE_CHANNEL] });
      if (action === 'bank_sync') return { status: 422, body: { ok: false, error: 'download_refused', kind: 'busy', code: '091119' } };
      return { status: 404, body: { ok: false, error: 'x' } };
    };
    renderPanel(transport);
    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /fetch statements/i }));
    await waitFor(() => expect(screen.getByText('ZKB is busy right now (code 091119). Fetch the statements again later.')).toBeInTheDocument());
  });

  it('BLOCKED: the block is local (TILL sends nothing; ZKB by phone), and the reviewed confirm is the way back', async () => {
    const channel = { ...ACTIVE_CHANNEL, state: 'blocked' };
    const transport: Transport = async (action) => (action === 'bank_channel_status' ? ok({ channels: [channel] }) : { status: 404, body: { ok: false, error: 'x' } });
    renderPanel(transport);
    await waitFor(() => expect(screen.getByText('Blocked')).toBeInTheDocument());
    expect(screen.getByText(/TILL sends nothing more\. To block it at ZKB: by phone\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^block$/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fetch and compare the bank keys/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /fetch statements/i })).not.toBeInTheDocument();
  });
});

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
    await userEvent.click(screen.getByRole('button', { name: /fetch statements/i }));
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

describe('A36 §4.7 (D150): the durable statement gap on the channel card', () => {
  it('names the gap and its explanation instead of the jump notice, and "Close the gap" opens the repair', async () => {
    const gap = {
      gapId: 'bst_1:bst_4',
      bankAccountId: 'ba_1',
      source: 'book',
      after: { statementRowId: 'bst_1', documentId: null, number: 211, year: 2026, fromDate: '2026-07-14', toDate: '2026-07-14' },
      before: { statementRowId: 'bst_4', documentId: null, number: 214, year: 2026, fromDate: '2026-07-19', toDate: '2026-07-19' },
      missing: [{ year: 2026, from: 212, to: 213 }],
      oldYearTailUnknown: false,
      missingDates: { from: '2026-07-15', to: '2026-07-18' },
      chains: false,
      differenceMinor: 50000,
      currency: 'CHF',
      refused: [],
      confirmable: false,
    };
    const jump = { after: { number: 211, year: 2026 }, statement: { number: 214, year: 2026 }, skipped: [{ year: 2026, from: 212, to: 213 }] };
    const channel = { ...ACTIVE_CHANNEL, accounts: [{ ...ACTIVE_CHANNEL.accounts[0], lastNumberJump: jump, statementGaps: [gap] }] };
    const transport: Transport = async (action) => (action === 'bank_channel_status' ? ok({ channels: [channel] }) : { status: 404, body: { ok: false, error: 'x' } });
    const repairs: [string, string][] = [];
    render(
      <MemoryRouter>
        <I18nProvider initialLocale="en">
          <WorkspaceProvider initialId="ws_test">
            <TillClientProvider client={new TillClient(transport)}>
              <CapabilitiesContext.Provider value={caps([CAP.pay])}>
                <EbicsChannelPanel accounts={ACCOUNTS} onRepairGap={(a, g) => repairs.push([a, g])} />
              </CapabilitiesContext.Provider>
            </TillClientProvider>
          </WorkspaceProvider>
        </I18nProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Statements 212–213 are missing (15.07.2026 to 18.07.2026)')).toBeInTheDocument();
    expect(screen.getByText(/The missing statements hold CHF 500\.00 that is not in the books yet\./)).toBeInTheDocument();
    // The durable gap replaces the transient jump notice.
    expect(screen.queryByText(/came after statement/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Close the gap' }));
    expect(repairs).toEqual([['ba_1', 'bst_1:bst_4']]);
  });
});
