/**
 * A41.5 (D184 point 7, the owner-approved "Bankzeilen freigeben" artifact v3): the low-cognitive-load list.
 *
 *   - the "Sicherheit" column says the ENGINE's certainty in dots and a word or two; a pending agent
 *     Vorschlag reads its A41.2 evidence;
 *   - the row's ✓ (Freigeben) books directly (`bank.row_approve = direct`, the default), with the line's one
 *     matching captured receipt attached; under `review` it opens the review view and books nothing;
 *   - the rule-offer banner says the rule miner's pending draft in one sentence and saves it with one click,
 *     and asks the ask-first autopilot threshold before anything is offered.
 *
 * SYNTHETIC DATA ONLY: every name, IBAN, file and figure here is invented.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { CAP, CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { PrefsProvider, PrefsStore } from '../../lib/prefs';
import { recordedOk } from '../../lib/test-support';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';
import Bank from './index';
import { confidenceOf, dotsOf } from './Confidence';
import { parseMinedOffers } from './RuleOffer';
import type { BankInboxLine, VorschlagEvidence } from './model';

type Handler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | Handler>;
const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function account(number: string): string {
  const row = listAccountsFixture.accounts.find((a) => a.number === number);
  if (row === undefined) throw new Error(`the recorded chart has no account ${number}`);
  return row.id;
}
const BANK_LEDGER = account('1020');
const ACCOUNT = { id: 'ba_1', name: 'Seeufer Geschäftskonto', iban: 'CH5604835012345678009', currency: 'CHF', ledgerAccountId: BANK_LEDGER, archived: false };

const accountsTarget = (number: string, amountMinor: number) => ({ kind: 'accounts', legs: [{ accountId: account(number), amountMinor, taxCode: '' }] });

function line(id: string, over: Record<string, unknown> = {}) {
  return {
    attention: 'needs',
    receiptCount: 0,
    needsReceipt: false,
    bankTxnId: id,
    bankAccountId: 'ba_1',
    statementId: 'st_1',
    state: 'open',
    bookingDate: '2026-10-14',
    valueDate: '2026-10-15',
    amountMinor: -1_250,
    currency: 'CHF',
    creditDebit: 'DBIT',
    reversal: false,
    counterparty: { name: `Probe ${id}`, iban: null },
    remittance: { text: `Text ${id}`, referenceKind: 'NON', referenceValue: null, endToEndId: null },
    entryRef: null,
    creditId: null,
    decision: null,
    proposal: { target: null, certainty: 'open', reasonCode: 'no_proposal', reasonParams: {}, vatCode: null },
    standardId: null,
    ruleIds: [],
    followUp: null,
    vorschlagActionId: null,
    belegCandidates: [],
    ...over,
  };
}

/** A sure line: the counterparty's Buchungsregel books it to 6900. */
const RULED = line('bt_rule', {
  attention: 'sure',
  bulkBookable: true,
  counterparty: { name: 'Wolkenhaus Hosting AG', iban: null },
  proposal: { target: accountsTarget('6900', 1_250), certainty: 'sure', reasonCode: 'standard', reasonParams: { standardId: 'bs_1', accountId: account('6900') }, vatCode: null },
  standardId: 'bs_1',
  belegCandidates: [
    {
      groupKey: 'g1',
      files: [{ fileId: 'file_inv', captureId: 'cap_1', filename: 'wolkenhaus-oktober.pdf', vendorName: 'Wolkenhaus Hosting AG', invoiceDate: '2026-10-12', amountMinor: 1_250, currency: 'CHF', vatAmountMinor: null }],
      amountMinor: 1_250,
      currency: 'CHF',
      vendorName: 'Wolkenhaus Hosting AG',
      date: '2026-10-12',
      match: { amount: 'exact', days: 2, counterparty: 'name' },
      vat: null,
    },
  ],
});
/** A learned line: six equal earlier bookings. */
const LEARNED = line('bt_learned', {
  attention: 'learned',
  counterparty: { name: 'Papeterie Bergli', iban: null },
  proposal: { target: accountsTarget('6500', 1_250), certainty: 'learned', reasonCode: 'history', reasonParams: { accountId: account('6500'), taxCode: '', lastDate: '2026-09-14', count: 6 }, vatCode: null },
});
/** A line TILL has nothing for. */
const OPEN = line('bt_open', { counterparty: { name: 'Unbekannt Muster', iban: null } });

const SUMMARY = {
  bankAccountId: 'ba_1',
  name: 'Seeufer Geschäftskonto',
  iban: 'CH5604835012345678009',
  currency: 'CHF',
  ledgerAccountId: BANK_LEDGER,
  judgeable: false,
  reason: 'no_statement',
  statementId: 'st_1',
  statementDate: '2026-10-14',
  bankBalanceMinor: null,
  ledgerBalanceMinor: null,
  openCount: 0,
  openSumMinor: 0,
  differenceMinor: null,
};

function canned(lines: unknown[], extra: Canned = {}): Canned {
  return {
    list_bank_accounts: ok({ bankAccounts: [ACCOUNT] }),
    list_bank_inbox: (input) => {
      const status = input.status as string;
      const mine = lines.filter((l) => (l as { state: string }).state === status || status === 'all');
      return ok({ lines: input.limit === 1 ? mine.slice(0, 1) : mine, nextCursor: null, total: mine.length, summary: [SUMMARY], bulkLearnedMin: null });
    },
    list_accounts: { status: 200, body: recordedOk(listAccountsFixture) },
    vat_codes: ok({ taxCodes: [] }),
    list_open_items: ok({ items: [] }),
    list_vendor_bills: ok({ bills: [] }),
    list_drafted_actions: ok({ actions: [] }),
    get_agent_dial: ok({ levels: { post: 'ask', pay: 'ask' } }),
    list_bank_standards: ok({ standards: [] }),
    compose_entry: ok({ mode: 'expand', composed: false, stamped: false, lines: [], captions: [], verdict: { ok: true } }),
    book_bank_line: ok({ state: 'booked', entryId: 'je_1', warnings: [] }),
    files_list_linked: ok({ files: [] }),
    ...extra,
  };
}

function recording(c: Canned) {
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const transport: Transport = async (action, input) => {
    calls.push({ action, input });
    const entry = c[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
  return { transport, calls };
}

const EVERY_RIGHT = [CAP.readSales, CAP.post, CAP.pay, CAP.manageFiles, CAP.readMasterData, CAP.readFileContent, 'manage_agent_dial', 'read_books', 'read_vat'];
function caps(held: readonly string[]): Capabilities {
  return {
    whoami: { actor: 'studio', provisioned: true, isMember: true, memberId: 'm1', userId: 'u1', role: 'member', capabilities: [...held] },
    can: (capability) => held.includes(capability),
    refresh: () => undefined,
  } as Capabilities;
}

function renderBank(transport: Transport) {
  return render(
    <CapabilitiesContext.Provider value={caps(EVERY_RIGHT)}>
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider initialLocale="de-CH">
          <WorkspaceProvider initialId="ws_test">
            <PrefsProvider store={new PrefsStore(null, null, { useCache: false })}>
              <MemoryRouter initialEntries={['/bank']}>
                <Bank />
              </MemoryRouter>
            </PrefsProvider>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>
    </CapabilitiesContext.Provider>,
  );
}

async function rowReady(id: string): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector(`tr.bank-row[data-line="${id}"]`)).not.toBeNull());
  return document.querySelector(`tr.bank-row[data-line="${id}"]`) as HTMLElement;
}
const confOf = (row: HTMLElement) => row.querySelector('.bank-conf') as HTMLElement;

describe('A41.5: the Sicherheit column reads the engine', () => {
  it('a rule line is three dots and "Regel", a learned one two dots and "6× so", an empty one "Offen"', async () => {
    renderBank(recording(canned([RULED, LEARNED, OPEN])).transport);
    const ruled = confOf(await rowReady('bt_rule'));
    expect(ruled).toHaveAttribute('data-confidence', 'sure');
    expect(ruled.querySelectorAll('.bank-conf__dot--on')).toHaveLength(3);
    expect(within(ruled).getByText('Regel')).toBeInTheDocument();
    // Glyph plus words: the certainty word is there for a screen reader too.
    expect(ruled).toHaveTextContent('Sicher: Regel');
    const learned = confOf(await rowReady('bt_learned'));
    expect(learned.querySelectorAll('.bank-conf__dot--on')).toHaveLength(2);
    expect(within(learned).getByText('6× so')).toBeInTheDocument();
    const open = confOf(await rowReady('bt_open'));
    expect(open.querySelectorAll('.bank-conf__dot--on')).toHaveLength(0);
    expect(within(open).getByText('Offen')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Sicherheit' })).toBeInTheDocument();
  });

  it('a Vorschlag awaiting approval reads its A41.2 evidence, never the agent\'s word; a person\'s change reads "Von dir"', () => {
    const evidence = (over: Partial<VorschlagEvidence>): VorschlagEvidence =>
      ({ certainty: 'sure', agrees: true, reasons: [], engine: { certainty: 'sure', reasonCode: 'standard', reasonParams: {}, target: null }, belege: [], vat: null, ...over }) as VorschlagEvidence;
    const agreeing = { ...LEARNED, vorschlagActionId: 'act_1', vorschlagEvidence: evidence({}) } as unknown as BankInboxLine;
    expect(confidenceOf(agreeing, undefined, undefined)).toEqual({ level: 'sure', short: 'agentAgrees', count: null });
    const differing = { ...RULED, vorschlagActionId: 'act_2', vorschlagEvidence: evidence({ certainty: 'check', agrees: false }) } as unknown as BankInboxLine;
    expect(confidenceOf(differing, undefined, undefined).level).toBe('check');
    expect(confidenceOf(differing, undefined, undefined).short).toBe('agentDiffers');
    // A Vorschlag the engine has no evidence for: its `attention` is `needs`, so look first.
    const bare = { ...RULED, vorschlagActionId: 'act_3', vorschlagEvidence: null } as unknown as BankInboxLine;
    expect(confidenceOf(bare, undefined, undefined)).toEqual({ level: 'check', short: 'agent', count: null });
    const edited = confidenceOf(RULED as unknown as BankInboxLine, { target: accountsTarget('6500', 1_250) as never, source: 'edited' }, undefined);
    expect(edited.level).toBe('edited');
    expect(dotsOf('edited')).toBe(0);
  });
});

describe('A41.5: the row\'s ✓ (Freigeben)', () => {
  it('direct (the default): one click books the line with its one matching receipt attached', async () => {
    const { transport, calls } = recording(canned([RULED, OPEN]));
    renderBank(transport);
    const row = await rowReady('bt_rule');
    const approve = within(row).getByRole('button', { name: 'Buchen' });
    expect(approve).toHaveAttribute('data-icon', 'approve');
    expect(approve).toHaveAttribute('data-approve-mode', 'direct');
    await userEvent.click(approve);
    await waitFor(() => expect(calls.some((c) => c.action === 'book_bank_line')).toBe(true));
    const sent = calls.find((c) => c.action === 'book_bank_line')?.input as Record<string, unknown>;
    expect(sent.bankTxnId).toBe('bt_rule');
    expect(sent.attach).toEqual([{ fileId: 'file_inv' }]);
    expect(sent.target).toMatchObject({ kind: 'accounts', legs: [{ accountId: account('6900') }] });
    // An open line has nothing to approve: its ✓ waits, saying why.
    const openApprove = within(await rowReady('bt_open')).getByRole('button', { name: 'Buchen' });
    expect(openApprove).toHaveAttribute('aria-disabled', 'true');
  });

  it('a line that already has its receipt books without attaching another', async () => {
    const { transport, calls } = recording(canned([{ ...RULED, receiptCount: 1 }]));
    renderBank(transport);
    await userEvent.click(within(await rowReady('bt_rule')).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'book_bank_line')).toBe(true));
    expect(calls.find((c) => c.action === 'book_bank_line')?.input.attach).toBeUndefined();
  });

  it('review (bank.row_approve): the ✓ opens the line\'s review view and books nothing', async () => {
    const { transport, calls } = recording(canned([RULED], { settings_get: (input) => ok({ setting: { key: input.key, value: input.key === 'bank.row_approve' ? 'review' : null } }) }));
    renderBank(transport);
    const row = await rowReady('bt_rule');
    await waitFor(() => expect(within(row).getByRole('button', { name: 'Buchen' })).toHaveAttribute('data-approve-mode', 'review'));
    await userEvent.click(within(row).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(document.querySelector('[data-area-for="bt_rule"]')).not.toBeNull());
    expect(calls.some((c) => c.action === 'book_bank_line')).toBe(false);
  });
});

describe('A41.5: the review view shows the Beleg', () => {
  it('a line without a receipt shows its one matching captured receipt, read through files_get_content', async () => {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:review/1' });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
    const { transport, calls } = recording(canned([RULED], { files_get_content: ok({ contentBase64: btoa('%PDF-1.4'), mime: 'application/pdf', filename: 'wolkenhaus-oktober.pdf' }) }));
    renderBank(transport);
    const row = await rowReady('bt_rule');
    await userEvent.click(within(row).getAllByRole('cell')[2] as HTMLElement);
    const area = await waitFor(() => document.querySelector('[data-area-for="bt_rule"]') as HTMLElement);
    const preview = await within(area).findByRole('region', { name: 'Passender Beleg' });
    expect(await within(preview).findByTitle('Beleg wolkenhaus-oktober.pdf')).toHaveAttribute('src', 'blob:review/1');
    expect(calls.find((c) => c.action === 'files_get_content')?.input).toEqual({ workspaceId: 'ws_test', fileId: 'file_inv' });
  });
});

describe('A41.5: the rule-offer banner', () => {
  const mined = {
    actionId: 'act_mined',
    status: 'pending',
    actor: 'system',
    actionTool: 'set_bank_standard',
    dialCapability: null,
    createdAt: '2026-10-14T08:00:00Z',
    payload: { bankTxnId: 'bt_learned', legs: [], minedFacts: { counterparty: 'Papeterie Bergli', repeats: 6, since: '2026-04-01', hits: 6, identical: 6, evidence: [] } },
  };

  it('says the miner\'s draft in one sentence; "Regel speichern" approves it, "Nicht jetzt" hides it', async () => {
    const { transport, calls } = recording(canned([LEARNED], { list_drafted_actions: ok({ actions: [mined] }), approve_drafted_action: ok({ status: 'approved' }) }));
    renderBank(transport);
    const banner = await screen.findByRole('region', { name: 'Regelvorschlag' });
    expect(banner).toHaveTextContent('Papeterie Bergli: die letzten 6 Mal gleich gebucht.');
    await userEvent.click(within(banner).getByRole('button', { name: 'Regel speichern' }));
    await waitFor(() => expect(calls.find((c) => c.action === 'approve_drafted_action')?.input.actionId).toBe('act_mined'));
  });

  it('"Nicht jetzt" writes nothing; another seat\'s draft or a malformed one is no offer', async () => {
    const { transport, calls } = recording(canned([LEARNED], { list_drafted_actions: ok({ actions: [mined] }) }));
    renderBank(transport);
    const banner = await screen.findByRole('region', { name: 'Regelvorschlag' });
    await userEvent.click(within(banner).getByRole('button', { name: 'Nicht jetzt' }));
    expect(screen.queryByRole('region', { name: 'Regelvorschlag' })).toBeNull();
    expect(calls.some((c) => c.action === 'approve_drafted_action' || c.action === 'reject_drafted_action')).toBe(false);
    expect(parseMinedOffers({ actions: [{ ...mined, actor: 'till-cli' }, { ...mined, actionId: 'act_x', payload: {} }] })).toEqual([]);
  });

  it('asks the ask-first autopilot threshold before anything is offered', async () => {
    const candidates = {
      setting: 'offer',
      offerAfter: 5,
      offerAfterAnswered: false,
      headroomPercent: 20,
      rules: [{ standardId: 'bs_1', label: 'Hosting', counterparty: 'Wolkenhaus Hosting AG', eligible: true, ineligibleReason: null, cleanUses: 5, humanCleanUses: 5, ceilingPreview: { amountMinor: 1_500, currency: 'CHF' }, grant: null, offerActionId: null, grantable: false, asksThreshold: true }],
    };
    const { transport } = recording(canned([RULED], { autobook_candidates: ok(candidates) }));
    renderBank(transport);
    const banner = await screen.findByRole('region', { name: 'Regelvorschlag' });
    expect(banner).toHaveTextContent('Regel Hosting bucht immer gleich.');
    expect(within(banner).getByRole('radio', { name: '5' })).toBeChecked();
    expect(within(banner).queryByRole('button', { name: 'Automatisch buchen' })).toBeNull();
  });
});
