/**
 * I03 Landkosten money-path UI invariants, authored by a NON-author reviewer (D118 critic gate:
 * "the money-path INVARIANT tests are authored or reviewed by a NON-author"). This surface shipped
 * with ZERO component tests, so these are the first, and they are deliberately narrow: they assert
 * only the properties that keep a landed-cost write honest, not the surface's cosmetics.
 *
 * The invariants under test:
 *   1. VERBATIM figures. A voucher total and a per-target allocated/base/unit-impact figure render
 *      the exact Rappen the read verb returned, formatted for display only, never recomputed. The
 *      allocation arithmetic is the engine's; the Studio may only divide by 100 to show it.
 *   2. NO WRITE WITHOUT THE EXPLICIT CONFIRM. The capitalise (allocate_confirm) and reverse writes
 *      fire ONLY from the alertdialog's own confirm control. A bare click on the drawer's action
 *      button opens the dialog and writes nothing; a Cancel and an Escape write nothing.
 *   3. THE A24 PRE-DISABLE GATE. Without `procurement.landed_cost` the create control is disabled and
 *      the drawer offers no confirm/reverse control at all, so the surface never shows-then-rejects.
 *
 * House idiom (mirrors ThreeWayMatch.test.tsx): a fake transport answers canned verbs, a real
 * CapabilitiesProvider mounts over a `whoami`, and every copy assertion goes through the de-CH
 * catalogue rather than a literal typed here. A recording transport counts the money-path writes so
 * an accidental early write is a failing assertion, not a silent pass.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import LandedCosts from './index';
import de from './messages.de-CH.json';
// The shipped Kontenrahmen recording, pinned to the live list_accounts by
// test/accounts/studio-list-accounts-fixture.test.mjs. Any Studio suite that answers list_accounts
// must serve this recording, never a hand-typed literal (the surface's create-form account picker
// filters against the real chart).
import accountsFixture from '../Accounts/list-accounts.fixture.json';

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

/** A transport that records every write action it was asked to run, so an early or missing write bites. */
interface RecordingTransport extends Transport {
  calls: string[];
  countOf: (action: string) => number;
}
function recordingTransport(canned: Canned): RecordingTransport {
  const calls: string[] = [];
  const fn = (async (action: string, input: Record<string, unknown>) => {
    calls.push(action);
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input ?? {}) : entry;
  }) as RecordingTransport;
  fn.calls = calls;
  fn.countOf = (action: string) => calls.filter((c) => c === action).length;
  return fn;
}

const whoamiWith = (capabilities: string[]): RestResponse =>
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities });

// A single draft voucher. Every money figure here is a distinct, unambiguous Rappen value so a
// recomputation would land on a DIFFERENT display string than the one asserted.
const TOTAL_MINOR = 123456; // -> "1'234.56"
const BASE_MINOR = 500000; //  -> "5'000.00"
const ALLOC_MINOR = 45678; //  -> "456.78"
const UNIT_MINOR = 1200; //    -> "12.00"

const VOUCHER = {
  id: 'lcv_1',
  number: 'LC-0001',
  status: 'draft',
  totalCostMinor: TOTAL_MINOR,
  allocationMethod: 'by_value',
  effectiveDate: '2026-03-01',
  journalEntryId: null,
  reverseJournalEntryId: null,
  lines: [{ id: 'lcl_1', componentType: 'freight', amountBaseMinor: TOTAL_MINOR, description: null }],
  targets: [
    { id: 'lct_1', goodsReceiptLineId: 'grl_1', itemId: 'ITEM-1', baseQty: 10, baseValueMinor: BASE_MINOR, allocatedMinor: ALLOC_MINOR, unitImpactMinor: UNIT_MINOR, movementId: null },
  ],
};

const PREVIEW_LINE = {
  targetId: 'lct_1',
  itemId: 'ITEM-1',
  baseValueMinor: BASE_MINOR,
  share: 1,
  allocatedMinor: ALLOC_MINOR,
  unitImpactMinor: UNIT_MINOR,
};

const CAPS = ['read_master_data', 'procurement.landed_cost'];

// The human name the client-side lookup resolves ITEM-1 to. Distinct from the raw id so a test can
// tell "showed the name" from "showed the id".
const ITEM_NAME = 'Frachtgut Alpha';

function baseCanned(caps: string[] = CAPS): Canned {
  return {
    whoami: whoamiWith(caps),
    // The allocation table humanizes the raw itemId through this client-side lookup (no name on the wire).
    list_items: ok({ items: [{ id: 'ITEM-1', name: ITEM_NAME }] }),
    landed_cost_list: ok({
      items: [
        {
          id: VOUCHER.id,
          number: VOUCHER.number,
          status: VOUCHER.status,
          totalCostMinor: VOUCHER.totalCostMinor,
          allocationMethod: VOUCHER.allocationMethod,
          effectiveDate: VOUCHER.effectiveDate,
          journalEntryId: VOUCHER.journalEntryId,
        },
      ],
    }),
    list_accounts: ok(accountsFixture),
    goods_receipt_list: ok({ items: [] }),
    landed_cost_get: ok({ voucher: VOUCHER }),
    landed_cost_allocate_preview: ok({ lines: [PREVIEW_LINE] }),
    // If these ever fire, the recording transport has already logged them; the body just lets refresh settle.
    landed_cost_allocate_confirm: ok({ voucher: { ...VOUCHER, status: 'allocated', journalEntryId: 'je_1' } }),
    landed_cost_reverse: ok({ voucher: { ...VOUCHER, status: 'reversed' } }),
  };
}

function renderSurface(transport: Transport) {
  return render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <CapabilitiesProvider>
            <MemoryRouter>
              <LandedCosts />
            </MemoryRouter>
          </CapabilitiesProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

/** Open the drawer for the one voucher row and wait for its allocation preview to load. */
async function openDrawer(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('row', { name: VOUCHER.number }));
  // The preview allocated figure proves the drawer + its read landed.
  await screen.findByText('456.78');
}

describe('LandedCosts, verbatim money figures', () => {
  it('renders the voucher total exactly as the read verb reported it, divided by 100 only', async () => {
    renderSurface(recordingTransport(baseCanned()));
    // 123456 Rappen -> "1'234.56". A recomputed or re-rounded total would not be this string, and
    // the apostrophe is the de-CH thousands group (house style), applied on display only.
    expect(await screen.findByText("1'234.56")).toBeInTheDocument();
  });

  it('renders each allocation figure (base / allocated / unit impact) verbatim from the preview', async () => {
    const user = userEvent.setup();
    renderSurface(recordingTransport(baseCanned()));
    await openDrawer(user);
    expect(screen.getByText("5'000.00")).toBeInTheDocument(); // baseValueMinor 500000
    expect(screen.getByText('456.78')).toBeInTheDocument(); //  allocatedMinor 45678
    expect(screen.getByText('12.00')).toBeInTheDocument(); //   unitImpactMinor 1200
  });

  it('groups a >= 1000 figure with the Swiss apostrophe separator, and the value is unchanged', async () => {
    renderSurface(recordingTransport(baseCanned()));
    const total = await screen.findByText("1'234.56");
    // The house de-CH group separator is the apostrophe (never a comma, never a bare run of digits).
    expect(total.textContent).toBe("1'234.56");
    // The displayed value is identical to the read verb's Rappen: stripping the group separator and
    // the decimal mark reconstructs TOTAL_MINOR exactly, so only the formatting changed.
    const reconstructedMinor = Number((total.textContent ?? '').replace(/'/g, '').replace('.', ''));
    expect(reconstructedMinor).toBe(TOTAL_MINOR);
  });
});

describe('LandedCosts, the money-path write fires only from the alertdialog confirm', () => {
  it('opening the confirm dialog writes NOTHING; the write needs the dialog’s own confirm control', async () => {
    const user = userEvent.setup();
    const transport = recordingTransport(baseCanned());
    renderSurface(transport);
    await openDrawer(user);

    // Bare click on the drawer action: opens the alertdialog, calls no write verb.
    await user.click(screen.getByRole('button', { name: de.landedCosts.confirm }));
    const dialog = await screen.findByRole('alertdialog');
    expect(transport.countOf('landed_cost_allocate_confirm')).toBe(0);

    // Cancel closes the dialog and still writes nothing. The alertdialog carries a close affordance
    // and a footer cancel, both labelled "Abbrechen"; either dismisses without writing, so click the
    // explicit footer control (the last such button).
    const cancels = within(dialog).getAllByRole('button', { name: de.landedCosts.confirmDialog.cancel });
    await user.click(cancels[cancels.length - 1]);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(transport.countOf('landed_cost_allocate_confirm')).toBe(0);
  });

  it('Escape on the open confirm dialog dismisses it without writing', async () => {
    const user = userEvent.setup();
    const transport = recordingTransport(baseCanned());
    renderSurface(transport);
    await openDrawer(user);

    await user.click(screen.getByRole('button', { name: de.landedCosts.confirm }));
    await screen.findByRole('alertdialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(transport.countOf('landed_cost_allocate_confirm')).toBe(0);
  });

  it('the write fires exactly once, only after the alertdialog confirm is pressed', async () => {
    const user = userEvent.setup();
    const transport = recordingTransport(baseCanned());
    renderSurface(transport);
    await openDrawer(user);

    await user.click(screen.getByRole('button', { name: de.landedCosts.confirm }));
    const dialog = await screen.findByRole('alertdialog');
    // The dialog body carries the engine's total verbatim, grouped for display.
    expect(within(dialog).getByText(/1'234\.56/)).toBeInTheDocument();
    expect(transport.countOf('landed_cost_allocate_confirm')).toBe(0);

    await user.click(within(dialog).getByRole('button', { name: de.landedCosts.confirm }));
    await waitFor(() => expect(transport.countOf('landed_cost_allocate_confirm')).toBe(1));
    // The confirm went through the real verb, not a second bespoke path.
    expect(transport.countOf('landed_cost_reverse')).toBe(0);
  });
});

describe('LandedCosts, the A24 pre-disable gate', () => {
  it('disables create and offers no confirm control without procurement.landed_cost', async () => {
    const user = userEvent.setup();
    const transport = recordingTransport(baseCanned(['read_master_data'])); // capability withheld
    renderSurface(transport);
    await openDrawer(user);

    // The create action is pre-disabled (whoami has resolved without the capability).
    await waitFor(() => expect(screen.getByRole('button', { name: de.landedCosts.create })).toBeDisabled());
    // The drawer is open on a draft voucher, yet no capitalise control is offered at all.
    expect(screen.queryByRole('button', { name: de.landedCosts.confirm })).not.toBeInTheDocument();
    // And nothing on the money path was ever called.
    expect(transport.countOf('landed_cost_allocate_confirm')).toBe(0);
    expect(transport.countOf('landed_cost_reverse')).toBe(0);
  });
});

describe('LandedCosts, the allocation item is humanized (ux-f3)', () => {
  it('shows the item NAME for a resolved id, with the raw id surviving only as a real tooltip', async () => {
    const user = userEvent.setup();
    renderSurface(recordingTransport(baseCanned()));
    await openDrawer(user);

    // The cell reads the human name, not the machine id (house rule: no raw key on screen).
    const nameCell = await screen.findByText(ITEM_NAME);
    expect(nameCell).toBeInTheDocument();
    // The raw id is NOT the visible cell text; it lives in the associated tooltip, tied by
    // aria-describedby (never the title attribute), so a human can still recover the key.
    const describedBy = nameCell.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    const tip = document.getElementById(describedBy as string);
    expect(tip).not.toBeNull();
    expect(tip).toHaveAttribute('role', 'tooltip');
    expect(tip?.textContent).toContain('ITEM-1');
    // And the raw id never reaches the cell as its plain visible label.
    expect(nameCell.textContent).toBe(ITEM_NAME);
  });

  it('falls back to the raw id when the lookup does not resolve it', async () => {
    const user = userEvent.setup();
    // The items read returns nothing that matches ITEM-1, so there is no name to show.
    const canned = { ...baseCanned(), list_items: ok({ items: [] }) };
    renderSurface(recordingTransport(canned));
    await openDrawer(user);

    // With no resolved name, the cell shows the raw id itself (never a blank), and no name leaks in.
    expect(screen.getByText('ITEM-1')).toBeInTheDocument();
    expect(screen.queryByText(ITEM_NAME)).not.toBeInTheDocument();
  });
});

describe('LandedCosts, the disabled-create reason is associated, not a hover title (ux-f6)', () => {
  it('exposes the permission reason via aria-describedby to a visible note, never the title attribute', async () => {
    const transport = recordingTransport(baseCanned(['read_master_data'])); // capability withheld
    renderSurface(transport);

    const btn = await screen.findByRole('button', { name: de.landedCosts.create });
    await waitFor(() => expect(btn).toBeDisabled());
    // DESIGN.md bans the native title tooltip: the reason must not hide in a hover-only title.
    expect(btn).not.toHaveAttribute('title');
    // The reason is associated via aria-describedby and is a VISIBLE, reachable note.
    const describedBy = btn.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    const reason = document.getElementById(describedBy as string);
    expect(reason).not.toBeNull();
    expect(reason).toHaveTextContent(de.landedCosts.needsPermission);
  });

  it('adds neither the association nor the note when the write capability is present', async () => {
    const transport = recordingTransport(baseCanned()); // full caps
    renderSurface(transport);

    const btn = await screen.findByRole('button', { name: de.landedCosts.create });
    await waitFor(() => expect(btn).not.toBeDisabled());
    expect(btn).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText(de.landedCosts.needsPermission)).not.toBeInTheDocument();
  });
});
