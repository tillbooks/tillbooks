/**
 * A19, Bankkonten: the app-level suite the surface shipped without.
 *
 * ANCHORED ON THE RECORDINGS, NOT ON PROSE. Every IBAN, name, currency, chart number and figure
 * below is read off the fixtures in this directory, and `test/banking/studio-bank-accounts-fixture.
 * test.mjs` pins those to the live engine VALUE for value, asserts the key set exactly, and asserts
 * the ABSENCE of the fields a surface might be tempted to invent. Nothing here is hand-typed: the
 * frozen-editor test derives its row from the recorded register rather than writing a fourth
 * account, and the missing-9100 test filters the recorded chart rather than inventing a shorter one.
 *
 * THE PERMISSION SHAPE IS ASSERTED AS AN ABSENCE. `list_bank_accounts` carries no permission field,
 * and three phantom ones (`canPost`, `canManage`, `canUnlock`) were once read off payloads that have
 * never carried them, each tested `x !== false`, so absent meant permanently true. The tests below
 * therefore prove the row affordances come from `openingEntryId` and `archived` and from nothing
 * else, and that a denied READ is the padlock while a denied WRITE is a sentence where it happened.
 *
 * NO CurrencyPicker IS MOUNTED HERE, so there is no unpinned `list_exchange_rates` to hang: the
 * editor's Währung control is a plain `select` over a local list, and the only FX read on this
 * surface is `get_exchange_rate` (singular), which the foreign-currency tests pin explicitly.
 *
 * AXE RUNS ON A SETTLED SURFACE. The browser harness's `waitForPaintToSettle`
 * (`.claude/ui-tests/lib/audit-tools.cjs`) drives `document.getAnimations()` through Playwright and
 * cannot run in jsdom. `settled()` below is the equivalent claim: real content present AND no
 * `aria-busy` region anywhere. Auditing the first frame audits the skeleton.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter, useNavigate } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { installMemoryStorage } from '../../lib/test-support';
import { hang, neverSettles, watchReads } from '../../test-transport';
import BankAccounts from './index';

import activeFixture from './list-bank-accounts.fixture.json';
import archivedFixture from './list-bank-accounts.archived.fixture.json';
import qrOnlyFixture from './list-bank-accounts.qr-only.fixture.json';
import oneFixture from './get-bank-account.fixture.json';
import chartFixture from './list-accounts-with-9100.fixture.json';
import previewFixture from './preview-bank-opening-balance.fixture.json';

/** A canned handler exactly as the transport calls it: the request input in, a RestResponse out. */
type CannedHandler = (input: Record<string, unknown>) => RestResponse;

type Canned = Record<string, RestResponse | CannedHandler>;

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

const ok = (data: Record<string, unknown> = {}): RestResponse => ({
  status: 200,
  body: { ok: true, ...data },
});

const reject = (error: string, status = 422, extra: Record<string, unknown> = {}): RestResponse => ({
  status,
  body: { ok: false, error, ...extra },
});

/** The workspace keeps its books in francs, so the EUR account is the foreign one. */
const PROFILE = ok({ profile: { baseCurrency: 'CHF' } });

/**
 * The engine's opening-balance preview, in its default shape: it ECHOES the amount as the base
 * figure. Every assertion that cares about the arithmetic overrides this with a handler whose answer
 * is deliberately not the amount, because a component that multiplied in the browser would agree
 * with an echoing fake forever.
 */
const previewEcho: CannedHandler = (input) => {
  const amountMinor = input.amountMinor as number;
  return ok({
    bankAccountId: input.bankAccountId,
    currency: 'EUR',
    amountMinor,
    baseCurrency: 'CHF',
    baseAmountMinor: amountMinor,
    posts: amountMinor !== 0,
  });
};

const HAPPY: Canned = {
  list_bank_accounts: ok(activeFixture),
  get_bank_account: ok(oneFixture),
  list_accounts: ok(chartFixture),
  get_company_profile: PROFILE,
  preview_bank_opening_balance: previewEcho,
  // The surface mounts EbicsChannelPanel, whose own bank_channel_status read must resolve to a
  // genuine empty (not an error): a failed read now renders that panel's error banner + retry, which
  // is a DISTINCT state from empty and would otherwise collide with this surface's own retry control.
  bank_channel_status: ok({ channels: [] }),
};

interface RenderOptions {
  workspaceId?: string | null;
  route?: string;
  transport?: Transport;
}

function renderBank(canned: Canned = HAPPY, options: RenderOptions = {}) {
  const { workspaceId = 'ws_test', route = '/bank-accounts', transport } = options;
  const client = new TillClient(transport ?? fakeTransport(canned));
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          <MemoryRouter initialEntries={[route]}>
            <BankAccounts />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

/** Real content on screen AND nothing still announcing itself busy. See the header note. */
async function settled(container: HTMLElement, anchor: string): Promise<void> {
  await screen.findByText(anchor);
  await waitFor(() => {
    expect(container.querySelectorAll('[aria-busy="true"]')).toHaveLength(0);
  });
}

// --- the recordings, addressed by value -----------------------------------------------------------

/** One recorded register row by name. Throws rather than asserting against `undefined`. */
function recorded(name: string) {
  const row = archivedFixture.bankAccounts.find((account) => account.name === name);
  if (row === undefined) throw new Error(`the recording has no bank account "${name}"`);
  return row;
}

const QR = recorded('PostFinance QR');
const EUR = recorded('Raiffeisen EUR');
const ARCHIVED = recorded('Altes Kontokorrent');

/** The recorded row that carries a posted opening entry, which is what freezes the editor. */
const FROZEN_ONE = ok({ bankAccount: QR });

/** The recorded preview answer, addressed by value like every other recording in this file. */
const PREVIEW = previewFixture;

/** The recorded chart with 9100 removed, for the prevented-at-the-control refusal. */
const CHART_WITHOUT_9100 = ok({
  accounts: chartFixture.accounts.filter((account) => account.number !== '9100'),
});

/** The recorded chart with 9100 archived, which is a DIFFERENT absence with a different recovery. */
const CHART_WITH_9100_ARCHIVED = ok({
  accounts: chartFixture.accounts.map((account) =>
    account.number === '9100' ? { ...account, archived: true } : account,
  ),
});

beforeEach(() => {
  installMemoryStorage();
});

describe('the recordings these assertions are read off', () => {
  // If a recording is re-captured against a different seed, this fails FIRST and names the drift
  // instead of every assertion below failing as an unexplained string mismatch.
  it('holds the three row shapes the register branches on', () => {
    expect(QR.isQrIban).toBe(true);
    expect(QR.openingEntryId).toBe('entry_1');
    expect(QR.openingBalanceMinor).toBe(1250000);
    expect(EUR.currency).toBe('EUR');
    expect(EUR.openingBalanceMinor).toBeNull();
    expect(ARCHIVED.archived).toBe(true);
    // The qr-only recording really is a register that cannot initiate a payment.
    expect(qrOnlyFixture.bankAccounts.every((a) => a.isQrIban)).toBe(true);
    // 9100 is in the chart recording, and it is equity, so the picker must never offer it.
    expect(chartFixture.accounts.some((a) => a.number === '9100' && a.type === 'equity')).toBe(true);
    // The preview recording really CONVERTED: a foreign preview whose base amount equalled its own
    // amount would make the "the browser does not multiply" assertion vacuous.
    expect(PREVIEW.currency).not.toBe(PREVIEW.baseCurrency);
    expect(PREVIEW.baseAmountMinor).not.toBe(PREVIEW.amountMinor);
  });
});

// --- the five states ------------------------------------------------------------------------------

describe('BankAccounts, five states', () => {
  it('LOADING: shows the skeleton while list_bank_accounts is genuinely in flight', async () => {
    const transport = watchReads(neverSettles);
    renderBank(HAPPY, { transport });
    // The proof. `loading` starts true, so the region is on screen before any effect has fired and
    // the bare assertion would hold over a surface that reads nothing at all. The shared DataTable
    // owns the loading placeholder now, so there is one `aria-busy` skeleton region rather than the
    // former hand-rolled wrapper-plus-Skeleton pair.
    await transport.started('list_bank_accounts');

    const regions = screen.getAllByRole('status');
    expect(regions).toHaveLength(1);
    for (const region of regions) expect(region).toHaveAttribute('aria-busy', 'true');
    // The completeness note is a claim about a set that is not loaded yet, so it is withheld.
    expect(screen.queryByText(/Du hast eine QR-IBAN/)).not.toBeInTheDocument();
  });

  it('NO WORKSPACE: offers the way to /setup and asks the engine for nothing', async () => {
    const listSpy = vi.fn<CannedHandler>(() => ok(activeFixture));
    renderBank({ ...HAPPY, list_bank_accounts: listSpy }, { workspaceId: null });

    expect(await screen.findByText('Kein Arbeitsbereich vorhanden')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Arbeitsbereich einrichten' })).toHaveAttribute(
      'href',
      '/setup',
    );
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('EMPTY: says what the register is for and invites the first account', async () => {
    renderBank({ ...HAPPY, list_bank_accounts: ok({ bankAccounts: [] }) });

    expect(await screen.findByText('Noch keine Bankkonten erfasst.')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Hier erfasst du jedes Konto mit seiner IBAN und dem Konto aus deinem Kontenplan, auf das es bucht.',
      ),
    ).toBeInTheDocument();
    // Two invitations to the same first step: the header primary and the empty-state action.
    expect(screen.getAllByRole('button', { name: 'Konto hinzufügen' })).toHaveLength(2);
  });

  it('ERROR: names what failed and retries the read in place', async () => {
    let calls = 0;
    renderBank({
      ...HAPPY,
      list_bank_accounts: () => {
        calls += 1;
        return calls === 1 ? reject('transport_error', 500) : ok(activeFixture);
      },
    });

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Bankkonten konnten nicht geladen werden.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    await waitFor(() => expect(calls).toBe(2));
    expect(await screen.findByText('PostFinance QR')).toBeInTheDocument();
  });

  it('DENIED: renders the padlock panel naming the missing READ right', async () => {
    renderBank({ ...HAPPY, list_bank_accounts: reject('permission_denied', 403) });

    expect(await screen.findByRole('heading', { name: 'Kein Zugriff' })).toBeInTheDocument();
    expect(screen.getByText('Dir fehlt die Berechtigung, Bankkonten zu sehen.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('POPULATED: renders the recorded rows, masked IBAN, chart number and posted balance', async () => {
    renderBank();

    const qr = (await screen.findByText('PostFinance QR')).closest('tr') as HTMLElement;
    // CH4431999123000889012 masked to its country, IID group and last group.
    expect(within(qr).getByText('CH44 3199 ...9012')).toBeInTheDocument();
    expect(within(qr).getByText('QR-IBAN, nur Eingang')).toBeInTheDocument();
    expect(within(qr).getByText('CHF')).toBeInTheDocument();
    // The chart NUMBER, never the raw `ledgerAccountId`.
    expect(within(qr).getByText('1020')).toBeInTheDocument();
    expect(within(qr).queryByText('acc_2')).not.toBeInTheDocument();
    // 1250000 Rappen and 2026-07-19, linked to the entry it posted.
    const balance = within(qr).getByRole('link');
    expect(balance).toHaveAttribute('href', '/journal');
    expect(balance.textContent).toContain("CHF 12'500.00");
    expect(balance.textContent).toContain('19.07.2026');

    const eur = screen.getByText('Raiffeisen EUR').closest('tr') as HTMLElement;
    expect(within(eur).getByText('EUR')).toBeInTheDocument();
    expect(within(eur).getByText('noch keiner')).toBeInTheDocument();
    expect(within(eur).queryByText('QR-IBAN, nur Eingang')).not.toBeInTheDocument();
  });

  it('F8: a zero opening balance carries its CURRENCY, not a bare 0.00', async () => {
    // Derived from the recorded EUR row rather than hand-typed, and EUR on purpose: a bare "0.00"
    // beside a franc account merely looks terse, while beside a euro account it has no unit at all.
    const ZERO_EUR = ok({
      bankAccounts: activeFixture.bankAccounts.map((account) =>
        account.name === 'Raiffeisen EUR'
          ? { ...account, openingBalanceMinor: 0, openingEntryId: null }
          : account,
      ),
    });
    renderBank({ ...HAPPY, list_bank_accounts: ZERO_EUR });

    const eur = (await screen.findByText('Raiffeisen EUR')).closest('tr') as HTMLElement;
    // B12's own acceptance sentence, with the figure formatted rather than hardcoded into the string.
    expect(within(eur).getByText('EUR 0.00, keine Buchung')).toBeInTheDocument();
    // And it is still not a link: no entry exists to link to.
    expect(within(eur).queryByRole('link')).not.toBeInTheDocument();
  });

  it('has no axe violations on a SETTLED register', async () => {
    const { container } = renderBank();
    await settled(container, 'PostFinance QR');
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

// --- the completeness note ------------------------------------------------------------------------

describe('the QR-IBAN completeness note (INV-6)', () => {
  it('stays silent when the register already holds a plain IBAN', async () => {
    renderBank();
    await screen.findByText('PostFinance QR');
    expect(screen.queryByText(/Du hast eine QR-IBAN/)).not.toBeInTheDocument();
  });

  it('says the register is incomplete when every live account is a QR-IBAN', async () => {
    renderBank({ ...HAPPY, list_bank_accounts: ok(qrOnlyFixture) });

    const note = await screen.findByText(
      'Du hast eine QR-IBAN, aber keine normale IBAN. Zahlungen, die du auslöst, brauchen eine normale IBAN.',
    );
    // An incompleteness, not a failure: A18 does not exist yet, so shouting would invent urgency.
    expect(note.closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // Its action is not a second "Konto hinzufügen" forty pixels from the primary.
    expect(screen.getByRole('button', { name: 'Normale IBAN erfassen' })).toBeInTheDocument();
  });

  it('stays dismissed per workspace, and dismissal writes nothing to the engine', async () => {
    const listSpy = vi.fn<CannedHandler>(() => ok(qrOnlyFixture));
    renderBank({ ...HAPPY, list_bank_accounts: listSpy });

    await screen.findByText(/Du hast eine QR-IBAN/);
    const before = listSpy.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Nicht mehr anzeigen' }));
    expect(screen.queryByText(/Du hast eine QR-IBAN/)).not.toBeInTheDocument();

    // Presentational only: no re-read, no write, and the key is scoped to this workspace.
    expect(listSpy.mock.calls).toHaveLength(before);
    // F3: what is remembered is WHICH register was dismissed, not merely that something was.
    expect(window.localStorage.getItem('till.bank.qrNoteDismissed.ws_test')).toBe('bank_1');
  });

  /**
   * F3. The comment at the top of `BankAccounts.tsx` and the design's §7.2 lifecycle clause both
   * promise "the note returns if a further QR-IBAN is registered". A single boolean per workspace
   * cannot keep that promise, and the register it describes keeps moving. Both re-reads below are
   * driven through the archived toggle, which is the surface's own re-read path.
   */
  describe('F3: the dismissal is keyed to the register it dismissed', () => {
    /** A second QR-IBAN, derived from the recorded one so no IBAN is hand-typed. */
    const SECOND_QR = {
      ...qrOnlyFixture.bankAccounts[0],
      id: 'bank_7',
      name: 'PostFinance QR EUR',
      currency: 'EUR',
    };

    it('returns when a FURTHER QR-IBAN is registered', async () => {
      let calls = 0;
      renderBank({
        ...HAPPY,
        list_bank_accounts: () => {
          calls += 1;
          return calls === 1
            ? ok(qrOnlyFixture)
            : ok({ bankAccounts: [...qrOnlyFixture.bankAccounts, SECOND_QR] });
        },
      });

      await screen.findByText(/Du hast eine QR-IBAN/);
      await userEvent.click(screen.getByRole('button', { name: 'Nicht mehr anzeigen' }));
      expect(screen.queryByText(/Du hast eine QR-IBAN/)).not.toBeInTheDocument();

      // The register grew a QR-IBAN the dismissal never covered.
      await userEvent.click(screen.getByLabelText('Archivierte anzeigen'));
      expect(await screen.findByText(/Du hast eine QR-IBAN/)).toBeInTheDocument();
    });

    it('returns when the register was completed and then broke again', async () => {
      // The sequence the note exists to prevent: dismiss, register a plain IBAN, then lose it.
      // Without this the suppression outlives the fact and nobody finds out until A18's pain.001
      // debit picker comes up empty.
      let calls = 0;
      renderBank({
        ...HAPPY,
        list_bank_accounts: () => {
          calls += 1;
          // 1: qr-only. 2: complete (the recorded register holds a plain IBAN). 3: qr-only again.
          return calls === 2 ? ok(activeFixture) : ok(qrOnlyFixture);
        },
      });

      await screen.findByText(/Du hast eine QR-IBAN/);
      await userEvent.click(screen.getByRole('button', { name: 'Nicht mehr anzeigen' }));

      await userEvent.click(screen.getByLabelText('Archivierte anzeigen'));
      await screen.findByText('Raiffeisen EUR');
      // A complete register has nothing to suppress, so the dismissal is forgotten rather than
      // banked against the next time the register breaks.
      expect(window.localStorage.getItem('till.bank.qrNoteDismissed.ws_test')).toBeNull();

      await userEvent.click(screen.getByLabelText('Archivierte anzeigen'));
      expect(await screen.findByText(/Du hast eine QR-IBAN/)).toBeInTheDocument();
    });

    it('stays dismissed when the register has not changed at all', async () => {
      // The other half: a dismissal that keeps its promise is worth nothing if it does not hold.
      renderBank({ ...HAPPY, list_bank_accounts: () => ok(qrOnlyFixture) });

      await screen.findByText(/Du hast eine QR-IBAN/);
      await userEvent.click(screen.getByRole('button', { name: 'Nicht mehr anzeigen' }));
      await userEvent.click(screen.getByLabelText('Archivierte anzeigen'));
      await waitFor(() => expect(screen.getByLabelText('Archivierte anzeigen')).toBeChecked());
      expect(screen.queryByText(/Du hast eine QR-IBAN/)).not.toBeInTheDocument();
    });
  });
});

// --- the row affordances --------------------------------------------------------------------------

describe('the row overflow, and what governs it', () => {
  it('drops Eröffnungssaldo erfassen once the opening entry exists, and offers Archivieren', async () => {
    renderBank();
    const qr = (await screen.findByText('PostFinance QR')).closest('tr') as HTMLElement;
    await userEvent.click(
      within(qr).getByRole('button', { name: 'Aktionen für PostFinance QR' }),
    );

    // B13: absent because `openingEntryId` is set, so `opening_balance_already_set` is unreachable.
    expect(
      within(qr).queryByRole('menuitem', { name: 'Eröffnungssaldo erfassen' }),
    ).not.toBeInTheDocument();
    expect(within(qr).getByRole('menuitem', { name: 'Bearbeiten' })).toBeInTheDocument();
    expect(within(qr).getByRole('menuitem', { name: 'Archivieren' })).toBeInTheDocument();
  });

  it('offers it on a row that has no opening entry yet', async () => {
    renderBank();
    const eur = (await screen.findByText('Raiffeisen EUR')).closest('tr') as HTMLElement;
    await userEvent.click(
      within(eur).getByRole('button', { name: 'Aktionen für Raiffeisen EUR' }),
    );
    expect(
      within(eur).getByRole('menuitem', { name: 'Eröffnungssaldo erfassen' }),
    ).toBeInTheDocument();
  });

  it('offers Löschen nowhere, in any state', async () => {
    const { container } = renderBank({ ...HAPPY, list_bank_accounts: ok(archivedFixture) });
    await settled(container, 'Altes Kontokorrent');
    for (const name of ['PostFinance QR', 'Raiffeisen EUR', 'Altes Kontokorrent']) {
      const row = screen.getByText(name).closest('tr') as HTMLElement;
      await userEvent.click(within(row).getByRole('button', { name: `Aktionen für ${name}` }));
      // A bank account is a durable reference for A20 and A21, unlike a never-posted chart account.
      expect(within(row).queryByRole('menuitem', { name: 'Löschen' })).not.toBeInTheDocument();
      await userEvent.keyboard('{Escape}');
    }
  });

  it('puts the archived state in a WORD as well as in the dimming', async () => {
    renderBank({ ...HAPPY, list_bank_accounts: ok(archivedFixture) }, {
      route: '/bank-accounts?archived=1',
    });
    const row = (await screen.findByText('Altes Kontokorrent')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Archiviert')).toBeInTheDocument();
    await userEvent.click(
      within(row).getByRole('button', { name: 'Aktionen für Altes Kontokorrent' }),
    );
    expect(within(row).getByRole('menuitem', { name: 'Wiederherstellen' })).toBeInTheDocument();
    expect(within(row).queryByRole('menuitem', { name: 'Archivieren' })).not.toBeInTheDocument();
  });

  it('asks for archived rows only when the toggle says so', async () => {
    const listSpy = vi.fn<CannedHandler>(() => ok(archivedFixture));
    renderBank({ ...HAPPY, list_bank_accounts: listSpy });
    await screen.findByText('PostFinance QR');
    expect(listSpy.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws_test' });
    expect(listSpy.mock.calls[0][0].includeArchived).toBeUndefined();

    await userEvent.click(screen.getByLabelText('Archivierte anzeigen'));
    await waitFor(() => expect(listSpy.mock.calls.length).toBeGreaterThan(1));
    expect(listSpy.mock.calls[listSpy.mock.calls.length - 1][0]).toMatchObject({
      includeArchived: true,
    });
  });
});

// --- archiving is reversible, so it is an undo and not a confirm ----------------------------------

describe('archiving', () => {
  it('archives with no confirm dialog and offers the restore immediately', async () => {
    const archiveSpy = vi.fn<CannedHandler>(() => ok());
    const unarchiveSpy = vi.fn<CannedHandler>(() => ok());
    renderBank({ ...HAPPY, archive_bank_account: archiveSpy, unarchive_bank_account: unarchiveSpy });

    const qr = (await screen.findByText('PostFinance QR')).closest('tr') as HTMLElement;
    await userEvent.click(within(qr).getByRole('button', { name: 'Aktionen für PostFinance QR' }));
    await userEvent.click(within(qr).getByRole('menuitem', { name: 'Archivieren' }));

    // A confirm dialog on a reversible act devalues the confirm on an irreversible one.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => expect(archiveSpy).toHaveBeenCalledOnce());
    expect(archiveSpy.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws_test',
      bankAccountId: QR.id,
    });
    expect(typeof archiveSpy.mock.calls[0][0].idempotencyKey).toBe('string');

    const undo = await screen.findByText('«PostFinance QR» ist archiviert.');
    await userEvent.click(
      within(undo.closest('[role="status"]') as HTMLElement).getByRole('button', {
        name: 'Wiederherstellen',
      }),
    );
    await waitFor(() => expect(unarchiveSpy).toHaveBeenCalledOnce());
    expect(unarchiveSpy.mock.calls[0][0]).toMatchObject({ bankAccountId: QR.id });
  });

  it('says which write right is missing, where the write was attempted', async () => {
    renderBank({ ...HAPPY, archive_bank_account: reject('permission_denied', 403) });
    const qr = (await screen.findByText('PostFinance QR')).closest('tr') as HTMLElement;
    await userEvent.click(within(qr).getByRole('button', { name: 'Aktionen für PostFinance QR' }));
    await userEvent.click(within(qr).getByRole('menuitem', { name: 'Archivieren' }));

    expect(
      await screen.findByText('Dir fehlt die Berechtigung, Bankkonten zu erfassen.'),
    ).toBeInTheDocument();
    // A denied WRITE never becomes the whole-surface padlock: the register stays readable.
    expect(screen.queryByRole('heading', { name: 'Kein Zugriff' })).not.toBeInTheDocument();
    expect(screen.getByText('Raiffeisen EUR')).toBeInTheDocument();
  });
});

// --- B-S2, the editor drawer ----------------------------------------------------------------------

describe('the BankAccountEditor drawer', () => {
  it('LOADING: proves get_bank_account went in flight before showing its skeleton', async () => {
    const transport = watchReads(async (action, input) =>
      action === 'get_bank_account' ? neverSettles(action, input) : fakeTransport(HAPPY)(action, input),
    );
    const { container } = renderBank(HAPPY, {
      transport,
      route: `/bank-accounts?account=${EUR.id}`,
    });

    await transport.started('get_bank_account');
    // The shared DetailDrawer panel carries the `.drawer` class now (the bespoke `.bank-drawer` shell
    // was retired for it); the drawer still shows a `role="status"` Skeleton body until its reads land.
    const drawer = container.querySelector('.drawer') as HTMLElement;
    expect(within(drawer).getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('opens the recorded account with its IBAN grouped for reading', async () => {
    renderBank(HAPPY, { route: `/bank-accounts?account=${EUR.id}` });
    const drawer = await screen.findByRole('dialog', { name: 'Bankkonto bearbeiten' });
    // The drawer names itself on the first commit and keeps a Skeleton body until its reads land,
    // so the FIRST query into the body is awaited. Same law across this describe block.
    expect(await within(drawer).findByLabelText('Name')).toHaveValue('Raiffeisen EUR');
    // CH9300762011623852957, grouped in fours. The clipboard elsewhere gets the unformatted value.
    expect(within(drawer).getByLabelText('IBAN')).toHaveValue('CH93 0076 2011 6238 5295 7');
    expect(within(drawer).getByLabelText('Währung')).toHaveValue('EUR');
  });

  it('offers only asset accounts in the picker, never 9100 Eröffnungsbilanz', async () => {
    renderBank(HAPPY, { route: `/bank-accounts?account=${EUR.id}` });
    const drawer = await screen.findByRole('dialog', { name: 'Bankkonto bearbeiten' });
    const picker = await within(drawer).findByLabelText('Verknüpftes Konto');
    const labels = within(picker).getAllByRole('option').map((option) => option.textContent);

    expect(labels[0]).toBe('Konto wählen');
    // The recorded chart's own asset rows, by number AND name, so a renamed seed fails here.
    expect(labels).toContain('1000 Kassenbestand');
    expect(labels).toContain('1020 Bankkonto');
    // 9100 is equity, and `resolveLedgerAccount` would refuse it, so the picker never offers it.
    expect(labels.some((label) => label?.startsWith('9100'))).toBe(false);
  });

  it('freezes IBAN, Währung and Konto once an opening entry exists, and SHOWS the reason', async () => {
    renderBank(
      { ...HAPPY, get_bank_account: FROZEN_ONE },
      { route: `/bank-accounts?account=${QR.id}` },
    );
    const drawer = await screen.findByRole('dialog', { name: 'Bankkonto bearbeiten' });

    // Shown read-only rather than hidden: an operator who came to check an IBAN and found the field
    // gone would conclude the data was lost.
    expect(await within(drawer).findByLabelText('IBAN')).toHaveAttribute('readonly');
    expect(within(drawer).getByLabelText('Währung')).toBeDisabled();
    expect(within(drawer).getByLabelText('Verknüpftes Konto')).toBeDisabled();
    expect(
      within(drawer).getByText(
        'Gesperrt, seit der Eröffnungssaldo gebucht ist. Den Namen kannst du weiterhin ändern.',
      ),
    ).toBeInTheDocument();
    // Speichern stays enabled, because the name is still editable for good.
    expect(within(drawer).getByRole('button', { name: 'Speichern' })).toBeEnabled();
  });

  it('sends only the name when the account is frozen', async () => {
    const updateSpy = vi.fn<CannedHandler>(() => ok());
    renderBank(
      { ...HAPPY, get_bank_account: FROZEN_ONE, update_bank_account: updateSpy },
      { route: `/bank-accounts?account=${QR.id}` },
    );
    const drawer = await screen.findByRole('dialog', { name: 'Bankkonto bearbeiten' });
    const name = await within(drawer).findByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'PostFinance Geschäft');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(updateSpy).toHaveBeenCalledOnce());
    const sent = updateSpy.mock.calls[0][0];
    expect(sent).toMatchObject({ bankAccountId: QR.id, name: 'PostFinance Geschäft' });
    expect(sent.iban).toBeUndefined();
    expect(sent.currency).toBeUndefined();
    expect(sent.ledgerAccountId).toBeUndefined();
  });

  it('names the clashing account on duplicate_iban rather than echoing the number', async () => {
    renderBank(
      {
        ...HAPPY,
        get_bank_account: ok(oneFixture),
        update_bank_account: reject('duplicate_iban', 422, { iban: QR.iban }),
      },
      { route: `/bank-accounts?account=${EUR.id}` },
    );
    const drawer = await screen.findByRole('dialog', { name: 'Bankkonto bearbeiten' });
    await userEvent.click(await within(drawer).findByRole('button', { name: 'Speichern' }));

    // B4: the engine returns `{ iban }`, and the drawer resolves the name from the register it holds.
    expect(
      await within(drawer).findByText('Diese IBAN ist schon als «PostFinance QR» erfasst.'),
    ).toBeInTheDocument();
    expect(within(drawer).queryByText(QR.iban)).not.toBeInTheDocument();
  });

  it('maps invalid_iban reasons to their own sentences', async () => {
    renderBank(
      {
        ...HAPPY,
        update_bank_account: reject('invalid_iban', 422, { reason: 'structure' }),
      },
      { route: `/bank-accounts?account=${EUR.id}` },
    );
    const drawer = await screen.findByRole('dialog', { name: 'Bankkonto bearbeiten' });
    await userEvent.click(await within(drawer).findByRole('button', { name: 'Speichern' }));
    expect(
      await within(drawer).findByText('Diese IBAN hat nicht die richtige Länge oder Form.'),
    ).toBeInTheDocument();
  });

  it('C14: a stale deep link says what is missing and offers the way back', async () => {
    renderBank(
      { ...HAPPY, get_bank_account: reject('bank_account_not_found', 404) },
      { route: '/bank-accounts?account=bank_gone' },
    );
    const drawer = await screen.findByRole('dialog', { name: 'Bankkonto bearbeiten' });
    expect(await within(drawer).findByText('Dieses Bankkonto gibt es nicht mehr.')).toBeInTheDocument();
    // It does NOT silently open an empty create form.
    expect(within(drawer).queryByLabelText('IBAN')).not.toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Zur Liste' })).toBeInTheDocument();
  });

  it('B7: an unseeded chart is a derived banner BEFORE any Save, not a rejection after one', async () => {
    renderBank(
      { ...HAPPY, list_accounts: ok({ accounts: [] }) },
      { route: '/bank-accounts?new=1' },
    );
    const drawer = await screen.findByRole('dialog', { name: 'Bankkonto erfassen' });
    expect(
      await within(drawer).findByText('Dein Kontenplan hat noch keine Aktivkonten. Ein Bankkonto braucht eines.'),
    ).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'Kontenplan öffnen' })).toHaveAttribute(
      'href',
      '/accounts',
    );
    // The rest of the drawer stays readable and every typed value survives.
    expect(within(drawer).getByLabelText('Name')).toBeInTheDocument();
  });

  it('hints that a typed IBAN looks like a QR-IBAN before anything is committed', async () => {
    renderBank(HAPPY, { route: '/bank-accounts?new=1' });
    const drawer = await screen.findByRole('dialog', { name: 'Bankkonto erfassen' });
    // The recorded QR-IBAN carries IID 31999, inside SIX's reserved 30000 to 31999 range.
    await userEvent.type(await within(drawer).findByLabelText('IBAN'), QR.iban);
    expect(
      await within(drawer).findByText(
        'Das ist eine QR-IBAN. Sie kann nur Zahlungen empfangen. Für Zahlungen, die du auslöst, brauchst du zusätzlich eine normale IBAN.',
      ),
    ).toBeInTheDocument();
  });

  // The SAME defect as the Eröffnungssaldo step's sixth divergence, in the drawer one step earlier.
  // The engine's `updateBankAccount` replay is already asserted on rows: a second call under one key
  // with a DIFFERENT name returns the first row and discards the second name
  // (`test/banking/bank-accounts.test.mjs`). So a key that outlives the values it was minted for is
  // a request answered with a row the operator has already corrected away.
  it('mints a NEW idempotency key once the typed values change, so a lost response cannot replay the old row', async () => {
    const sent: Array<{ name: unknown; idempotencyKey: unknown }> = [];
    const createSpy: CannedHandler = (input) => {
      sent.push({ name: input.name, idempotencyKey: input.idempotencyKey });
      return sent.length === 1
        ? reject('transport_error', 500)
        : ok({ bankAccountId: 'bank_9', isQrIban: false });
    };
    renderBank({ ...HAPPY, create_bank_account: createSpy }, { route: '/bank-accounts?new=1' });
    const drawer = await screen.findByRole('dialog', { name: 'Bankkonto erfassen' });
    const name = await within(drawer).findByLabelText('Name');
    await userEvent.type(name, 'Kantonalbank');
    await userEvent.type(within(drawer).getByLabelText('IBAN'), ARCHIVED.iban);
    await userEvent.selectOptions(
      within(drawer).getByLabelText('Verknüpftes Konto'),
      chartFixture.accounts.find((a) => a.number === '1020')?.id ?? '',
    );
    const speichern = within(drawer).getByRole('button', { name: 'Speichern' });
    await userEvent.click(speichern);
    await waitFor(() => expect(sent).toHaveLength(1));
    // The spy fires when the request goes IN FLIGHT, not when its answer has been processed:
    // `saving` is still true and Speichern still disabled until the refusal round-trips, and a
    // click on a disabled button is swallowed silently. So the wait is on the state the next click
    // actually depends on, exactly as the Eröffnungssaldo twins below wait for Buchen. Waiting on
    // the spy alone was the CI flake: under load the commit that re-enables the button can land
    // after the click, and no findBy budget closes a race whose click never fired.
    await waitFor(() => expect(speichern).toBeEnabled());

    // The row landed and the answer was lost. The drawer holds every typed value, so the operator
    // corrects the name they had mistyped and saves again.
    await userEvent.clear(name);
    await userEvent.type(name, 'Kantonalbank Zürich');
    await userEvent.click(speichern);
    await waitFor(() => expect(sent).toHaveLength(2));

    expect(sent.map((call) => call.name)).toEqual(['Kantonalbank', 'Kantonalbank Zürich']);
    expect(sent[1].idempotencyKey).not.toBe(sent[0].idempotencyKey);
  });

  it('keeps ONE idempotency key when nothing typed has changed, so a retry cannot create two rows', async () => {
    const keys: unknown[] = [];
    const createSpy: CannedHandler = (input) => {
      keys.push(input.idempotencyKey);
      return keys.length === 1
        ? reject('transport_error', 500)
        : ok({ bankAccountId: 'bank_9', isQrIban: false });
    };
    renderBank({ ...HAPPY, create_bank_account: createSpy }, { route: '/bank-accounts?new=1' });
    const drawer = await screen.findByRole('dialog', { name: 'Bankkonto erfassen' });
    await userEvent.type(await within(drawer).findByLabelText('Name'), 'Kantonalbank');
    await userEvent.type(within(drawer).getByLabelText('IBAN'), ARCHIVED.iban);
    await userEvent.selectOptions(
      within(drawer).getByLabelText('Verknüpftes Konto'),
      chartFixture.accounts.find((a) => a.number === '1020')?.id ?? '',
    );
    const save = within(drawer).getByRole('button', { name: 'Speichern' });
    await userEvent.click(save);
    await waitFor(() => expect(keys).toHaveLength(1));
    // Same in-flight-is-not-answered race as the changed-values test above: wait for the refusal
    // round-trip to re-enable Speichern before re-clicking, or the retry click is swallowed.
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    await waitFor(() => expect(keys).toHaveLength(2));

    expect(keys[1]).toBe(keys[0]);
  });

  it('INV-7: create writes the row, posts nothing, and advances to the opening step', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ bankAccountId: 'bank_9', isQrIban: false }));
    const postSpy = vi.fn<CannedHandler>(() => ok());
    renderBank(
      { ...HAPPY, create_bank_account: createSpy, set_bank_opening_balance: postSpy },
      { route: '/bank-accounts?new=1' },
    );
    const drawer = await screen.findByRole('dialog', { name: 'Bankkonto erfassen' });
    await userEvent.type(await within(drawer).findByLabelText('Name'), 'Kantonalbank');
    await userEvent.type(within(drawer).getByLabelText('IBAN'), ARCHIVED.iban);
    await userEvent.selectOptions(
      within(drawer).getByLabelText('Verknüpftes Konto'),
      chartFixture.accounts.find((a) => a.number === '1020')?.id ?? '',
    );
    await userEvent.click(within(drawer).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    expect(createSpy.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws_test',
      name: 'Kantonalbank',
      iban: ARCHIVED.iban,
      currency: 'CHF',
    });
    // Master data only. Nothing moved.
    expect(postSpy).not.toHaveBeenCalled();
    expect(await screen.findByRole('dialog', { name: 'Eröffnungssaldo' })).toBeInTheDocument();
  });

  it('F4: an unset picker is flagged ON THE FIELD, and never round-trips to the engine', async () => {
    // A19 §2 US-A19.1 verbatim: "Given no ledger account selected, When I save, Then P9 returns
    // `needs_ledger_account`; the field is flagged." The field, not a sentence below every field.
    const createSpy = vi.fn<CannedHandler>(() => ok({ bankAccountId: 'bank_9' }));
    renderBank({ ...HAPPY, create_bank_account: createSpy }, { route: '/bank-accounts?new=1' });
    const drawer = await screen.findByRole('dialog', { name: 'Bankkonto erfassen' });

    // The picker renders a skeleton until the chart read lands: wait for the control itself.
    const picker = await within(drawer).findByLabelText('Verknüpftes Konto');
    await userEvent.type(within(drawer).getByLabelText('Name'), 'Kantonalbank');
    await userEvent.type(within(drawer).getByLabelText('IBAN'), ARCHIVED.iban);
    await userEvent.click(within(drawer).getByRole('button', { name: 'Speichern' }));

    const row = picker.closest('.form-row') as HTMLElement;
    // Beside the control it is about, inside the picker's own row.
    expect(
      within(row).getByText('Wähl das Konto aus deinem Kontenplan, auf das dieses Bankkonto bucht.'),
    ).toBeInTheDocument();
    expect(picker).toHaveAttribute('aria-invalid', 'true');
    // Prevented at the control: the engine is never asked a question the drawer could answer.
    expect(createSpy).not.toHaveBeenCalled();
    // And the operator is put where the fix is.
    expect(picker).toHaveFocus();
  });

  it('F4: the flag clears as soon as an account is picked, and the save then goes', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ bankAccountId: 'bank_9' }));
    renderBank({ ...HAPPY, create_bank_account: createSpy }, { route: '/bank-accounts?new=1' });
    const drawer = await screen.findByRole('dialog', { name: 'Bankkonto erfassen' });

    const picker = await within(drawer).findByLabelText('Verknüpftes Konto');
    await userEvent.type(within(drawer).getByLabelText('Name'), 'Kantonalbank');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Speichern' }));
    expect(picker).toHaveAttribute('aria-invalid', 'true');

    await userEvent.selectOptions(
      picker,
      chartFixture.accounts.find((a) => a.number === '1020')?.id ?? '',
    );
    expect(picker).not.toHaveAttribute('aria-invalid', 'true');
    expect(
      within(drawer).queryByText(
        'Wähl das Konto aus deinem Kontenplan, auf das dieses Bankkonto bucht.',
      ),
    ).not.toBeInTheDocument();

    await userEvent.click(within(drawer).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
  });

  it('F4: leaving the picker untouched-but-visited flags it on blur, not only on Save', async () => {
    // Canon Tier 2 Forms: "Validation is inline, on blur, next to the field."
    renderBank(HAPPY, { route: '/bank-accounts?new=1' });
    const drawer = await screen.findByRole('dialog', { name: 'Bankkonto erfassen' });
    const picker = await within(drawer).findByLabelText('Verknüpftes Konto');

    picker.focus();
    await userEvent.tab();
    expect(
      within(picker.closest('.form-row') as HTMLElement).getByText(
        'Wähl das Konto aus deinem Kontenplan, auf das dieses Bankkonto bucht.',
      ),
    ).toBeInTheDocument();
  });

  it('has no axe violations on a SETTLED editor drawer', async () => {
    const { container } = renderBank(HAPPY, { route: `/bank-accounts?account=${EUR.id}` });
    await settled(container, 'Bankkonto bearbeiten');
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

// --- B-S3, the opening-balance step ---------------------------------------------------------------

describe('the Eröffnungssaldo step', () => {
  const openingRoute = `/bank-accounts?opening=${EUR.id}`;

  async function openStep(canned: Canned = HAPPY) {
    const rendered = renderBank(canned, { route: openingRoute });
    await screen.findByRole('dialog', { name: 'Eröffnungssaldo' });
    return rendered;
  }

  /**
   * Buchen, clicked only once it is genuinely clickable.
   *
   * The dialog above appears when the REGISTER read lands, but Buchen also waits on the CHART read:
   * `probing` disables it until `list_accounts` commits, and user-event swallows a click on a
   * disabled control silently. So a click straight after typing races that commit, exactly the
   * in-flight-taken-for-answered class this file was already burned by, and the failure is a
   * downstream waitFor burning its whole budget on a click that never fired. Every intentional
   * Buchen click goes through this wait for the state the click actually depends on.
   */
  async function clickBuchen() {
    const buchen = screen.getByRole('button', { name: 'Buchen' });
    await waitFor(() => expect(buchen).toBeEnabled());
    await userEvent.click(buchen);
  }

  it('states the A04 consequence BEFORE the click, not after it', async () => {
    await openStep();
    expect(
      screen.getByText(
        'Danach kannst du für dieses Konto keine Eröffnungsbilanz mehr importieren, ohne diese Buchung zuerst zu stornieren.',
      ),
    ).toBeInTheDocument();
  });

  it('posts integer Rappen and the chosen date, with an idempotency key', async () => {
    const postSpy = vi.fn<CannedHandler>(() => ok());
    await openStep({ ...HAPPY, set_bank_opening_balance: postSpy });

    await userEvent.type(screen.getByLabelText(/Eröffnungssaldo \(EUR\)/), "12'500.00");
    await clickBuchen();

    await waitFor(() => expect(postSpy).toHaveBeenCalledOnce());
    const sent = postSpy.mock.calls[0][0];
    // Integer Rappen, never a float, and the account id from the recorded row.
    expect(sent).toMatchObject({ bankAccountId: EUR.id, amountMinor: 1250000 });
    expect(sent.date).toBe(EUR.createdAt.slice(0, 10));
    expect(typeof sent.idempotencyKey).toBe('string');
  });

  it('B12: says a zero balance posts nothing, before it is posted', async () => {
    await openStep();
    await userEvent.type(screen.getByLabelText(/Eröffnungssaldo \(EUR\)/), '0');
    expect(
      screen.getByText('Bei 0.00 wird nichts gebucht. Das Konto gilt trotzdem als erfasst.'),
    ).toBeInTheDocument();
    // Waited, not sampled: enabled requires the chart probe to have committed, not only the zero.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Buchen' })).toBeEnabled());
  });

  it('refuses to enable Buchen on an amount it cannot read', async () => {
    await openStep();
    const post = screen.getByRole('button', { name: 'Buchen' });
    expect(post).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Eröffnungssaldo \(EUR\)/), 'zwölftausend');
    expect(screen.getByText("Trag einen Betrag ein, zum Beispiel 12'500.00.")).toBeInTheDocument();
    expect(post).toBeDisabled();
  });

  it('B9: a MISSING 9100 blocks Buchen at the control and offers to create it IN ONE CLICK', async () => {
    await openStep({ ...HAPPY, list_accounts: CHART_WITHOUT_9100 });
    await waitFor(() =>
      expect(
        screen.getByText(
          'In deinem Kontenplan fehlt das Konto 9100 Eröffnungsbilanz. Ohne dieses Konto lässt sich der Saldo nicht buchen.',
        ),
      ).toBeInTheDocument(),
    );
    await userEvent.type(screen.getByLabelText(/Eröffnungssaldo \(EUR\)/), '100.00');
    expect(screen.getByRole('button', { name: 'Buchen' })).toBeDisabled();
    // The recovery is a BUTTON that performs the act, not a link that sends the operator elsewhere
    // to work out what to type. The chart link survives beside it, so nobody is left with one door.
    expect(screen.getByRole('button', { name: 'Konto 9100 anlegen' })).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Kontenplan öffnen' })).toHaveAttribute('href', '/accounts');
  });

  it('B9: the number, the name AND the type are on screen BEFORE the click', async () => {
    // D43: nothing is invented behind the operator's back. What the sentence names is what is sent,
    // and the assertion below reads the same two strings off the create_account call.
    await openStep({ ...HAPPY, list_accounts: CHART_WITHOUT_9100 });
    expect(
      await screen.findByText(
        'TILL legt es als «9100 Eröffnungsbilanz», Typ Eigenkapital, in deinem Kontenplan an. Sonst ändert sich nichts.',
      ),
    ).toBeInTheDocument();
  });

  it('B9: one click creates 9100 through the ORDINARY create_account, then Buchen unblocks', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ accountId: 'acc_9100' }));
    // The chart answers "missing" until 9100 is created and "present" afterwards, which is what makes
    // the re-read load-bearing: a component that decided for itself that its write worked would pass
    // this test with the chart still saying missing.
    let created = false;
    const canned: Canned = {
      ...HAPPY,
      list_accounts: () => (created ? ok(chartFixture) : CHART_WITHOUT_9100),
      create_account: (input) => {
        created = true;
        return createSpy(input);
      },
    };
    await openStep(canned);
    await screen.findByRole('button', { name: 'Konto 9100 anlegen' });
    await userEvent.type(screen.getByLabelText(/Eröffnungssaldo \(EUR\)/), '100.00');

    await userEvent.click(screen.getByRole('button', { name: 'Konto 9100 anlegen' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    const sent = createSpy.mock.calls[0][0];
    expect(sent).toMatchObject({ number: '9100', name: 'Eröffnungsbilanz', type: 'equity' });
    // A key, so a transport failure and a retry cannot leave two 9100s in the chart.
    expect(typeof sent.idempotencyKey).toBe('string');

    // The block clears from the re-read, and the money control becomes reachable: the dead end this
    // closes was that a fresh workspace could register a bank account and never post its balance.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Buchen' })).toBeEnabled());
    expect(
      screen.queryByText(
        'In deinem Kontenplan fehlt das Konto 9100 Eröffnungsbilanz. Ohne dieses Konto lässt sich der Saldo nicht buchen.',
      ),
    ).not.toBeInTheDocument();
  });

  it('B9: an ARCHIVED 9100 is a DIFFERENT absence with a DIFFERENT verb', async () => {
    const unarchiveSpy = vi.fn<CannedHandler>(() => ok());
    const createSpy = vi.fn<CannedHandler>(() => ok({ accountId: 'acc_nope' }));
    await openStep({
      ...HAPPY,
      list_accounts: CHART_WITH_9100_ARCHIVED,
      unarchive_account: unarchiveSpy,
      create_account: createSpy,
    });
    // Collapsing the two would send an operator to create an account that already exists, where a
    // duplicate-number rejection would meet them with no hint that reactivating is the fix.
    await waitFor(() =>
      expect(
        screen.getByText(
          'Das Konto 9100 Eröffnungsbilanz ist archiviert. Aktivier es wieder, dann kannst du den Saldo buchen.',
        ),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('Das Konto bleibt, wie es ist. Es wird nur wieder aktiv.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Konto 9100 wieder aktivieren' }));

    await waitFor(() => expect(unarchiveSpy).toHaveBeenCalledOnce());
    // Addressed by ID, off the same chart read that judged it archived: `unarchive_account` takes no
    // account number, and a component that sent one would silently do nothing.
    const archived9100 = chartFixture.accounts.find((a) => a.number === '9100');
    expect(unarchiveSpy.mock.calls[0][0]).toMatchObject({ accountId: archived9100?.id });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('B9: a refused creation is NAMED, and the chart link is still there', async () => {
    await openStep({
      ...HAPPY,
      list_accounts: CHART_WITHOUT_9100,
      create_account: reject('permission_denied', 403),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Konto 9100 anlegen' }));
    expect(
      await screen.findByText(
        'Dir fehlt die Berechtigung, Konten anzulegen. Bitte jemanden mit dieser Berechtigung, 9100 Eröffnungsbilanz zu erfassen.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Kontenplan öffnen' })).toBeInTheDocument();
  });

  it('B9: a chart that moved under the drawer says RELOAD, not retry', async () => {
    await openStep({
      ...HAPPY,
      list_accounts: CHART_WITHOUT_9100,
      create_account: reject('duplicate_number', 422, { number: '9100' }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Konto 9100 anlegen' }));
    expect(await screen.findByText('Das Konto 9100 gibt es schon. Lad die Seite neu.')).toBeInTheDocument();
  });

  it('B10: period_locked keeps the step open, names the period and offers both ways out', async () => {
    await openStep({
      ...HAPPY,
      set_bank_opening_balance: reject('period_locked', 422, { period: '2026-Q1' }),
    });
    const amount = screen.getByLabelText(/Eröffnungssaldo \(EUR\)/);
    await userEvent.type(amount, '500.00');
    await clickBuchen();

    expect(
      await screen.findByText(
        'Die Periode 2026-Q1 ist gesperrt. Buch den Saldo auf ein anderes Datum oder öffne die Periode.',
      ),
    ).toBeInTheDocument();
    // A dialog that vanishes on rejection makes the operator rebuild a decision they already made.
    expect(amount).toHaveValue('500.00');
    expect(screen.getByRole('link', { name: 'Perioden öffnen' })).toHaveAttribute('href', '/periods');
  });

  it('B11: prefills the rate for a foreign account and says where it came from', async () => {
    const rateSpy = vi.fn<CannedHandler>(() =>
      ok({ rate: '0.9412', rateAsOf: '2026-07-19', rateSource: 'ESTV' }),
    );
    await openStep({ ...HAPPY, get_exchange_rate: rateSpy });

    await waitFor(() => expect(rateSpy).toHaveBeenCalled());
    expect(rateSpy.mock.calls[0][0]).toMatchObject({ currency: 'EUR', date: EUR.createdAt.slice(0, 10) });
    // The spy fires when the read goes IN FLIGHT; the prefill commits with its ANSWER. Sampling the
    // field synchronously here raced that continuation and was this test's CI flake, so the wait is
    // on the filled field: the provenance sentence and the checkbox land in the same commit.
    const rate = screen.getByLabelText('Kurs EUR zu CHF');
    await waitFor(() => expect(rate).toHaveValue('0.9412'));
    // The DATE reads the way every other date on this surface reads: `formatDate`, not raw ISO.
    expect(screen.getByText('Kurs vom 19.07.2026, Quelle ESTV.')).toBeInTheDocument();
    // "Kurs merken" is offered only once a rate is in the field.
    expect(screen.getByLabelText('Kurs merken')).toBeInTheDocument();
  });

  it('B11: leaves the field empty and asks for a rate when none is admissible', async () => {
    await openStep({ ...HAPPY, get_exchange_rate: reject('needs_fx_rate', 422) });
    await waitFor(() =>
      expect(
        screen.getByText('Für dieses Datum ist kein Kurs hinterlegt. Trag ihn hier ein.'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByLabelText('Kurs EUR zu CHF')).toHaveValue('');
    // Not offered until the operator has actually typed one.
    expect(screen.queryByLabelText('Kurs merken')).not.toBeInTheDocument();
  });

  it('B11: the needs_fx_rate rejection names the date in Swiss form, not raw ISO', async () => {
    await openStep({
      ...HAPPY,
      set_bank_opening_balance: reject('needs_fx_rate', 422, {
        currency: 'EUR',
        date: '2026-07-19',
      }),
    });
    await userEvent.type(screen.getByLabelText(/Eröffnungssaldo \(EUR\)/), '100.00');
    await clickBuchen();

    // The engine speaks ISO. Every date this Studio shows a human goes through `formatDate`.
    expect(
      await screen.findByText(
        'Für EUR auf den 19.07.2026 ist kein Kurs hinterlegt. Trag den Kurs hier ein.',
      ),
    ).toBeInTheDocument();
  });

  it('records the typed rate under its OWN key when Kurs merken is ticked', async () => {
    const recordSpy = vi.fn<CannedHandler>(() => ok());
    const postSpy = vi.fn<CannedHandler>(() => ok());
    await openStep({
      ...HAPPY,
      get_exchange_rate: reject('needs_fx_rate', 422),
      record_exchange_rate: recordSpy,
      set_bank_opening_balance: postSpy,
    });

    await userEvent.type(screen.getByLabelText(/Eröffnungssaldo \(EUR\)/), '250.00');
    await userEvent.type(screen.getByLabelText('Kurs EUR zu CHF'), '0.95');
    await userEvent.click(screen.getByLabelText('Kurs merken'));
    await clickBuchen();

    await waitFor(() => expect(postSpy).toHaveBeenCalledOnce());
    expect(recordSpy).toHaveBeenCalledOnce();
    expect(recordSpy.mock.calls[0][0]).toMatchObject({ baseCurrency: 'EUR', rate: '0.95' });
    expect(postSpy.mock.calls[0][0]).toMatchObject({ amountMinor: 25000, fxRate: '0.95' });
    // Two writes, two keys: a replayed rate must never be mistaken for a replayed posting.
    expect(recordSpy.mock.calls[0][0].idempotencyKey).not.toBe(
      postSpy.mock.calls[0][0].idempotencyKey,
    );
  });

  it('F7: a refused "Kurs merken" is reported, and does NOT block the posting', async () => {
    // `recordExchangeRate` refuses a differing rate under the same date and source
    // (`src/core/fx/rates.ts:442-452`, `rate_conflict`), because that rate may already have priced a
    // posted entry. Discarding the response let a ticked checkbox do nothing and say nothing.
    const recordSpy = vi.fn<CannedHandler>(() =>
      reject('rate_conflict', 422, { storedRate: '0.9412', asOf: '2026-07-19', source: 'manual' }),
    );
    const postSpy = vi.fn<CannedHandler>(() => ok());
    await openStep({
      ...HAPPY,
      get_exchange_rate: reject('needs_fx_rate', 422),
      record_exchange_rate: recordSpy,
      set_bank_opening_balance: postSpy,
    });

    await userEvent.type(screen.getByLabelText(/Eröffnungssaldo \(EUR\)/), '250.00');
    await userEvent.type(screen.getByLabelText('Kurs EUR zu CHF'), '0.95');
    await userEvent.click(screen.getByLabelText('Kurs merken'));
    await clickBuchen();

    // The money act is independent of the memo and is NOT held hostage to it.
    await waitFor(() => expect(postSpy).toHaveBeenCalledOnce());
    expect(recordSpy).toHaveBeenCalledOnce();

    // What happened, why, and what to do about it.
    expect(
      await screen.findByText('Der Saldo ist gebucht. Der Kurs wurde nicht gespeichert.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Für dieses Datum ist schon der Kurs 0.9412 hinterlegt, und eine gebuchte Zeile kann daran hängen. Trag eine Korrektur auf ein anderes Datum ein.',
      ),
    ).toBeInTheDocument();
    // Buchen is gone: the balance is posted, and offering it again would invite a replay.
    expect(screen.queryByRole('button', { name: 'Buchen' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fertig' })).toBeInTheDocument();
  });

  it('F7: a rate that records cleanly closes the step exactly as before', async () => {
    const postSpy = vi.fn<CannedHandler>(() => ok());
    await openStep({
      ...HAPPY,
      get_exchange_rate: reject('needs_fx_rate', 422),
      record_exchange_rate: ok(),
      set_bank_opening_balance: postSpy,
    });

    await userEvent.type(screen.getByLabelText(/Eröffnungssaldo \(EUR\)/), '250.00');
    await userEvent.type(screen.getByLabelText('Kurs EUR zu CHF'), '0.95');
    await userEvent.click(screen.getByLabelText('Kurs merken'));
    await clickBuchen();

    await waitFor(() => expect(postSpy).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Eröffnungssaldo' })).not.toBeInTheDocument(),
    );
  });


  it('F6: Escape closes the row-launched step, exactly as it closes the editor drawer', async () => {
    // One job, one component. The row-launched drawer hand-rolled the overlay and the dialog panel
    // instead of using the shell, so it silently dropped the shell's Escape handler: an operator who
    // learned the key on the create path found it dead on the "record it later from the row" path,
    // which the design calls the common real sequence.
    await openStep();
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Eröffnungssaldo' })).not.toBeInTheDocument(),
    );
    // The register behind it is untouched and still readable.
    expect(screen.getByText('Raiffeisen EUR')).toBeInTheDocument();
  });

  it('F6: and the editor drawer still closes on Escape', async () => {
    renderBank(HAPPY, { route: `/bank-accounts?account=${EUR.id}` });
    await screen.findByRole('dialog', { name: 'Bankkonto bearbeiten' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Bankkonto bearbeiten' })).not.toBeInTheDocument(),
    );
  });

  it('Später closes the step and leaves a perfectly valid account behind', async () => {
    const postSpy = vi.fn<CannedHandler>(() => ok());
    await openStep({ ...HAPPY, set_bank_opening_balance: postSpy });
    await userEvent.click(screen.getByRole('button', { name: 'Später' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Eröffnungssaldo' })).not.toBeInTheDocument(),
    );
    expect(postSpy).not.toHaveBeenCalled();
    expect(screen.getByText('Raiffeisen EUR')).toBeInTheDocument();
  });

  it('names the missing POST right when the posting is denied', async () => {
    await openStep({ ...HAPPY, set_bank_opening_balance: reject('permission_denied', 403) });
    await userEvent.type(screen.getByLabelText(/Eröffnungssaldo \(EUR\)/), '100.00');
    await clickBuchen();
    expect(
      await screen.findByText('Dir fehlt die Berechtigung, den Eröffnungssaldo zu buchen.'),
    ).toBeInTheDocument();
  });

  // --- A19 §6 / US-A19.4, the base-currency readout (owner decision D43/B2) ----------------------

  it('shows the ENGINE\'s base figure, not one the browser multiplied', async () => {
    // The answer is the RECORDING, pinned to the live engine value for value by
    // `test/banking/studio-bank-accounts-fixture.test.mjs`, which also asserts that its
    // `baseAmountMinor` is not its own `amountMinor`. So this test cannot pass against a fixture
    // that never converted anything, and a component doing the multiplication itself would render
    // whatever its own float produced rather than the engine's figure.
    const previewSpy = vi.fn<CannedHandler>(() => ok(previewFixture));
    await openStep({
      ...HAPPY,
      get_exchange_rate: ok({ rate: PREVIEW.fxRate, rateAsOf: '2026-07-19', rateSource: 'manual' }),
      preview_bank_opening_balance: previewSpy,
    });
    await userEvent.type(screen.getByLabelText(/Eröffnungssaldo \(EUR\)/), "12'345.67");

    expect(await screen.findByText("CHF 11'650.76")).toBeInTheDocument();
    // The rate the figure was priced at is echoed from the engine too, never from the input field.
    expect(screen.getByText(new RegExp(`umgerechnet zum Kurs ${PREVIEW.fxRate}`))).toBeInTheDocument();

    // The rate PREFILL is its own async read, and each landing re-asks the preview. Sampling
    // `calls.at(-1)` after "called at least once" races that: under load the last call can still be
    // the rate-less one from before the prefill committed. So the matcher itself is the wait.
    await waitFor(() => {
      expect(previewSpy.mock.calls.at(-1)?.[0]).toMatchObject({
        bankAccountId: EUR.id,
        amountMinor: PREVIEW.amountMinor,
        fxRate: PREVIEW.fxRate,
      });
    });
    const asked = previewSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    // A read: no key, because a key is a promise about a write that never happens.
    expect('idempotencyKey' in asked).toBe(false);
  });

  it('shows the readout for a FRANC account too, with no rate note', async () => {
    // The sign and the contra account are what a franc operator can still get wrong, and Buchen is
    // just as irreversible without a rate involved.
    const chf = ok({
      bankAccounts: activeFixture.bankAccounts.map((a) =>
        a.id === EUR.id ? { ...a, currency: 'CHF' } : a,
      ),
    });
    const { container } = await openStep({ ...HAPPY, list_bank_accounts: chf });
    await userEvent.type(screen.getByLabelText(/Eröffnungssaldo \(CHF\)/), "12'500.00");
    // Scoped to the readout: the register BEHIND the drawer carries a row with the same figure, and
    // a document-wide query here would pass on a step that rendered nothing at all.
    await waitFor(() =>
      expect(container.querySelector('.bank-preview-amount')?.textContent).toBe("CHF 12'500.00"),
    );
    expect(screen.queryByText(/umgerechnet zum Kurs/)).not.toBeInTheDocument();
  });

  it('carries the SIGN: an overdraft previews as a negative figure, never an absolute one', async () => {
    await openStep({
      ...HAPPY,
      preview_bank_opening_balance: (input) =>
        ok({
          bankAccountId: EUR.id,
          currency: 'EUR',
          amountMinor: input.amountMinor,
          baseCurrency: 'CHF',
          baseAmountMinor: input.amountMinor as number,
          posts: true,
        }),
    });
    await userEvent.type(screen.getByLabelText(/Eröffnungssaldo \(EUR\)/), "-4'000.00");
    expect(await screen.findByText(/-4'000\.00/)).toBeInTheDocument();
  });

  it('drops the OLD figure the moment the amount changes, rather than leaving a stale one', async () => {
    // A figure under Buchen that describes an amount the operator has already edited away is the
    // exact failure this readout exists to prevent, so the stale one goes and "wird berechnet" says
    // so.
    //
    // The FIRST preview answers and the SECOND hangs. A transport that hung both would make this
    // test vacuous: the figure would never have appeared at all, and the assertion below would pass
    // over a component that never renders a figure in the first place.
    // `type` fires one effect per keystroke, so the switch is a flag the test flips rather than a
    // call counter: everything up to and including the settled figure answers, everything after it
    // hangs.
    let stall = false;
    const inner = fakeTransport(HAPPY);
    const transport = watchReads(async (action, input) => {
      if (action !== 'preview_bank_opening_balance') return inner(action, input);
      if (stall) return neverSettles(action, input);
      return ok({
        baseCurrency: 'CHF',
        baseAmountMinor: input.amountMinor as number,
        posts: true,
      });
    });
    const { container } = renderBank(HAPPY, { route: openingRoute, transport });
    await screen.findByRole('dialog', { name: 'Eröffnungssaldo' });
    const amount = screen.getByLabelText(/Eröffnungssaldo \(EUR\)/);

    await userEvent.type(amount, '100.00');
    // The figure really is on screen before the amount changes: that is what makes it stale-able.
    await waitFor(() =>
      expect(container.querySelector('.bank-preview-amount')?.textContent).toBe('CHF 100.00'),
    );

    const answered = transport.asked.filter((a) => a === 'preview_bank_opening_balance').length;
    stall = true;
    // ONE change event to a second READABLE amount, deliberately not `clear` + `type`. Clearing the
    // field makes the amount unreadable for a beat, and the readout unmounts on its own guard: the
    // assertion below would then pass over a component that never dropped anything. Typing another
    // digit onto '100.00' has the same defect ('100.000' has three decimals). This edit keeps the
    // readout mounted throughout, so the only thing that can clear the figure is the code under test.
    fireEvent.change(amount, { target: { value: "250.00" } });
    await transport.started('preview_bank_opening_balance', answered + 1);

    await waitFor(() =>
      expect(container.querySelector('.bank-preview')?.textContent).toContain('wird berechnet'),
    );
    expect(container.querySelector('.bank-preview-amount')).toBeNull();
  });

  it('LOADING: the readout announces itself busy while the preview read is IN FLIGHT', async () => {
    // The proof the convention wants: the assertion is made only after the transport confirms the
    // surface really asked for the preview. A skeleton on screen is the default, not evidence.
    const transport = watchReads(hang('preview_bank_opening_balance', fakeTransport(HAPPY)));
    const { container } = renderBank(HAPPY, { route: openingRoute, transport });
    await screen.findByRole('dialog', { name: 'Eröffnungssaldo' });
    await userEvent.type(screen.getByLabelText(/Eröffnungssaldo \(EUR\)/), "12'500.00");

    await transport.started('preview_bank_opening_balance');
    await waitFor(() => {
      expect(container.querySelector('.bank-preview[aria-busy="true"]')).not.toBeNull();
    });
    expect(screen.getByText('wird berechnet')).toBeInTheDocument();
  });

  it('asks for NO preview at all while 9100 is missing', async () => {
    // The answer there is `needs_account`, and the block above the button already says it in the
    // operator's own words with its recovery attached. Asking anyway would state one fact twice.
    const previewSpy = vi.fn<CannedHandler>(() =>
      ok({ baseCurrency: 'CHF', baseAmountMinor: 0, posts: false }),
    );
    await openStep({
      ...HAPPY,
      list_accounts: CHART_WITHOUT_9100,
      preview_bank_opening_balance: previewSpy,
    });
    await userEvent.type(screen.getByLabelText(/Eröffnungssaldo \(EUR\)/), '100.00');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Konto 9100 anlegen' })).toBeInTheDocument(),
    );
    expect(previewSpy).not.toHaveBeenCalled();
  });

  it('a refusal the PREVIEW reports lands before the click, and Buchen stays reachable', async () => {
    // Shown early, because that is the whole point. Not disabling, because the preview informs and
    // the posting decides: being wrong should cost a stale sentence, never a locked-out operator.
    await openStep({
      ...HAPPY,
      preview_bank_opening_balance: reject('period_locked', 422, { period: '2026-Q1' }),
    });
    await userEvent.type(screen.getByLabelText(/Eröffnungssaldo \(EUR\)/), '100.00');
    expect(
      await screen.findByText(
        'Die Periode 2026-Q1 ist gesperrt. Buch den Saldo auf ein anderes Datum oder öffne die Periode.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Buchen' })).toBeEnabled();
  });

  // --- the same staleness law, applied to the REFUSALS rather than only to the figure -----------
  //
  // A stale figure under Buchen and a stale REFUSAL under Buchen are one defect wearing two hats:
  // both describe a question the operator has already edited away. The figure was fixed first and
  // the refusals were left behind, so an independent critic found the third instance of the family.
  // These four tests pin the whole family at once, on the surface rather than on a helper.

  it('drops a refused Buchen SENTENCE the moment the question changes, exactly as it drops the figure', async () => {
    await openStep({
      ...HAPPY,
      set_bank_opening_balance: reject('period_locked', 422, { period: '2026-Q1' }),
    });
    const amount = screen.getByLabelText(/Eröffnungssaldo \(EUR\)/);
    await userEvent.type(amount, '100.00');
    await clickBuchen();

    const refusal =
      'Die Periode 2026-Q1 ist gesperrt. Buch den Saldo auf ein anderes Datum oder öffne die Periode.';
    expect(await screen.findByText(refusal)).toBeInTheDocument();

    // One change event to a second readable amount, for the reason the figure test spells out.
    fireEvent.change(amount, { target: { value: '250.00' } });

    // The figure updates; a sentence describing the SUPERSEDED attempt must not outlive it.
    await waitFor(() => expect(screen.queryByText(refusal)).not.toBeInTheDocument());
  });

  it('keeps showing the PREVIEW\'s refusals after a Buchen has been refused once', async () => {
    // The mask: the preview refusal is gated on there being no post refusal, so a post refusal that
    // never cleared suppressed EVERY preview refusal for the rest of the step. On a step whose only
    // purpose is verifying before an irreversible write, that inverts the feature.
    await openStep({
      ...HAPPY,
      set_bank_opening_balance: reject('period_locked', 422, { period: '2026-Q1' }),
      preview_bank_opening_balance: (input) =>
        input.amountMinor === 25000
          ? reject('period_locked', 422, { period: '2026-Q3' })
          : previewEcho(input),
    });
    const amount = screen.getByLabelText(/Eröffnungssaldo \(EUR\)/);
    await userEvent.type(amount, '100.00');
    await clickBuchen();

    await screen.findByText(
      'Die Periode 2026-Q1 ist gesperrt. Buch den Saldo auf ein anderes Datum oder öffne die Periode.',
    );

    fireEvent.change(amount, { target: { value: '250.00' } });

    expect(
      await screen.findByText(
        'Die Periode 2026-Q3 ist gesperrt. Buch den Saldo auf ein anderes Datum oder öffne die Periode.',
      ),
    ).toBeInTheDocument();
  });

  // --- the SIXTH member of the family, and the only one that can move money -----------------------
  //
  // `idempotencyKey` describes an input just as much as the figure and the two refusals do: it names
  // ONE posting attempt of one amount on one date at one rate. Minted once in a ref and never
  // reconsidered, it outlived its question, and `SqliteStore.rememberIdempotent` keys on
  // `(workspace, verb, key)` with no fingerprint of the input, so a differing call under a recorded
  // key REPLAYS rather than conflicts. A second critic drove the two tests below on the real surface
  // and watched the step close reporting success on a replay of a figure the operator had edited away.

  it('mints a NEW idempotency key once the question changes, so a lost response cannot replay the old figure', async () => {
    // The world is the one the ref exists for: a posting that LANDED whose response was lost.
    // `fetchTransport` surfaces that as a `transport_error` Result rather than throwing, so the step
    // shows a refusal and holds every typed value, which is what lets the operator edit and re-click.
    const sent: Array<{ amountMinor: unknown; idempotencyKey: unknown }> = [];
    const postSpy: CannedHandler = (input) => {
      sent.push({ amountMinor: input.amountMinor, idempotencyKey: input.idempotencyKey });
      return sent.length === 1 ? reject('transport_error', 500) : ok();
    };
    await openStep({ ...HAPPY, set_bank_opening_balance: postSpy });

    const amount = screen.getByLabelText(/Eröffnungssaldo \(EUR\)/);
    await userEvent.type(amount, '100.00');
    await clickBuchen();
    await waitFor(() => expect(sent).toHaveLength(1));

    // The operator raises the figure. The readout follows and the stale refusal goes: both correct.
    fireEvent.change(amount, { target: { value: '250.00' } });
    await clickBuchen();
    await waitFor(() => expect(sent).toHaveLength(2));

    expect(sent.map((call) => call.amountMinor)).toEqual([10000, 25000]);
    // Two amounts under ONE key is a request for CHF 250.00 answered `ok` with the CHF 100.00 entry
    // the engine already holds, and the step then closes reporting a success nobody chose.
    expect(sent[1].idempotencyKey).not.toBe(sent[0].idempotencyKey);
  });

  it('keeps ONE idempotency key across a retry of the SAME question, so a transport failure cannot post twice', async () => {
    // The property the ref was minted for, which the fix must not trade away: an unchanged question
    // re-clicked after a lost response is still one posting.
    const keys: unknown[] = [];
    const postSpy: CannedHandler = (input) => {
      keys.push(input.idempotencyKey);
      return keys.length === 1 ? reject('transport_error', 500) : ok();
    };
    await openStep({ ...HAPPY, set_bank_opening_balance: postSpy });

    await userEvent.type(screen.getByLabelText(/Eröffnungssaldo \(EUR\)/), '100.00');
    // Both clicks go through the enabled-wait: the first races the chart probe, the second the
    // refusal round-trip. Same wrong assumption, two different in-flight reads.
    await clickBuchen();
    await waitFor(() => expect(keys).toHaveLength(1));
    await clickBuchen();
    await waitFor(() => expect(keys).toHaveLength(2));

    expect(keys[1]).toBe(keys[0]);
  });

  // --- the chart read that fails, in front of the money step ---------------------------------------
  //
  // The step is gated on a chart read it does not own. When that read failed, the surface set nothing:
  // `chart` stayed null, `probing` stayed true for ever, Buchen stayed disabled, and the block that
  // would explain anything is gated behind `!probing`. A permanently silent dead end, met on the
  // first flaky read, in front of the one step on this surface that posts money.
  //
  // The two treatments it must NOT be given are what makes this worth a test rather than a one-liner:
  // it must not read as "9100 is missing" (that offers to CREATE an account that may well exist, and
  // walks the operator into `duplicate_number`), and it must not silently unblock Buchen on a chart
  // nobody has read.

  it('says the chart read FAILED instead of probing for ever, and offers a retry', async () => {
    let attempts = 0;
    const chartSpy: CannedHandler = () => {
      attempts += 1;
      return attempts === 1 ? reject('transport_error', 500) : ok(chartFixture);
    };
    await openStep({ ...HAPPY, list_accounts: chartSpy });

    expect(await screen.findByText('Der Kontenplan konnte nicht geladen werden.')).toBeInTheDocument();
    // NOT the 9100 sentence: a chart nobody could read is not a chart with 9100 missing.
    expect(
      screen.queryByRole('button', { name: 'Konto 9100 anlegen' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Buchen' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));

    // The retry re-reads, the failure sentence goes, and the step becomes usable.
    await waitFor(() =>
      expect(screen.queryByText('Der Kontenplan konnte nicht geladen werden.')).not.toBeInTheDocument(),
    );
    await userEvent.type(screen.getByLabelText(/Eröffnungssaldo \(EUR\)/), '100.00');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Buchen' })).toBeEnabled());
  });

  it('stops saying "wird berechnet" once the preview has finished and REFUSED', async () => {
    // The pending branch rendered on `preview === null`, and a refusal sets `preview` to null. So a
    // refused preview left the region reading "wird berechnet" for ever, beside a refusal that had
    // very much arrived. `aria-busy` was correctly absent throughout, which is the contradiction.
    //
    // The read is WATCHED, exactly as the loading-state convention requires of its inverse: an
    // assertion that "wird berechnet" is gone would hold trivially over a surface that never asked
    // for a preview at all, so the request is proven to have gone in flight first.
    const transport = watchReads(
      fakeTransport({
        ...HAPPY,
        preview_bank_opening_balance: reject('period_locked', 422, { period: '2026-Q1' }),
      }),
    );
    const { container } = renderBank(HAPPY, { route: openingRoute, transport });
    await screen.findByRole('dialog', { name: 'Eröffnungssaldo' });
    await userEvent.type(screen.getByLabelText(/Eröffnungssaldo \(EUR\)/), '100.00');
    await transport.started('preview_bank_opening_balance');

    await screen.findByText(
      'Die Periode 2026-Q1 ist gesperrt. Buch den Saldo auf ein anderes Datum oder öffne die Periode.',
    );
    await waitFor(() => expect(screen.queryByText('wird berechnet')).not.toBeInTheDocument());
    // Nothing is being calculated, so the readout is absent rather than pending.
    expect(container.querySelector('.bank-preview')).toBeNull();
  });

  it('stops crediting a SOURCE for a rate once the operator has typed their own', async () => {
    // The fourth instance of the family, found by going looking for it. The provenance hint is set
    // from `get_exchange_rate` and never reconsidered, so overtyping the prefilled rate left
    // «Kurs vom 19.07.2026, Quelle ESTV.» sitting under a figure priced at the operator's own rate.
    // A wrong provenance beside a money figure is worse than no provenance at all.
    await openStep({
      ...HAPPY,
      get_exchange_rate: ok({ rate: '0.9412', rateAsOf: '2026-07-19', rateSource: 'ESTV' }),
    });
    const rate = await screen.findByLabelText('Kurs EUR zu CHF');
    await waitFor(() => expect(rate).toHaveValue('0.9412'));
    expect(screen.getByText('Kurs vom 19.07.2026, Quelle ESTV.')).toBeInTheDocument();

    fireEvent.change(rate, { target: { value: '0.95' } });

    await waitFor(() =>
      expect(screen.queryByText('Kurs vom 19.07.2026, Quelle ESTV.')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('Diesen Kurs hast du selber eingetragen.')).toBeInTheDocument();
    // And the sentence for "nothing on file at all" must not be pressed into service here: it would
    // be flatly false, because a rate IS on file for this date.
    expect(
      screen.queryByText('Für dieses Datum ist kein Kurs hinterlegt. Trag ihn hier ein.'),
    ).not.toBeInTheDocument();
  });

  it('never carries ONE account\'s typed values into another account\'s step', async () => {
    // The narrowest instance of the same family, and the only one that is structural rather than a
    // missing clear: `?opening=` going straight from one id to another keeps the component mounted,
    // so the amount, the date and the refusal belonging to account A would open account B's step
    // already filled in. Every route in the surface goes through `opening=null` first, so this is
    // not reachable by clicking today; it is reachable by editing the URL, and a money step that is
    // safe only because of the order the caller happens to use is safe by luck.
    //
    // The real router is driven, not simulated, because the claim is about what React does with the
    // component when the search param changes under it.
    function Jump({ to }: { to: string }) {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => navigate(to)}>
          zum anderen Konto
        </button>
      );
    }
    const client = new TillClient(fakeTransport(HAPPY));
    render(
      <TillClientProvider client={client}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter initialEntries={[openingRoute]}>
              <Jump to={`/bank-accounts?opening=${QR.id}`} />
              <BankAccounts />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await screen.findByRole('dialog', { name: 'Eröffnungssaldo' });
    await userEvent.type(screen.getByLabelText(/Eröffnungssaldo \(EUR\)/), "12'500.00");
    expect(screen.getByLabelText(/Eröffnungssaldo \(EUR\)/)).toHaveValue("12'500.00");

    await userEvent.click(screen.getByRole('button', { name: 'zum anderen Konto' }));

    // A different account, in ITS own currency, with nothing typed and its own creation date.
    const amount = await screen.findByLabelText(/Eröffnungssaldo \(CHF\)/);
    expect(amount).toHaveValue('');
    expect(screen.getByLabelText('Datum')).toHaveValue(QR.createdAt.slice(0, 10));
  });

  it('has no axe violations on a SETTLED opening step', async () => {
    const { container } = await openStep();
    // Anchored on the one sentence that appears exactly once: "Eröffnungssaldo" is the column
    // header, the drawer title and the journey step, so it cannot identify the settled step.
    await settled(
      container,
      'Danach kannst du für dieses Konto keine Eröffnungsbilanz mehr importieren, ohne diese Buchung zuerst zu stornieren.',
    );
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});
