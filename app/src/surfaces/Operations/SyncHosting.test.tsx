/**
 * M02 Sync & hosting panel component tests (spec §8, design brief §9). The assertions a green
 * screenshot cannot make, and the ones a claims critic reads first:
 *   - the dial renders ON and OFF from get_sync_contract, with the honest AVAILABILITY posture (ON
 *     says the stream is available to authorised readers, never that anything is connected);
 *   - a non-owner sees the switch DISABLED with a padlock and the reason, never enabled-then-rejected;
 *   - the consumer readout is the honest ◌ "no consumer readout" line (the core owns no cursor), never
 *     a green "in sync" it cannot prove;
 *   - the publishing-OFF state carries NO enable-nudge (no dark pattern toward turning egress on);
 *   - the exit box anchors to Data & Backup's existing heading (#data-title), fronting G04 in place;
 *   - loading, error and permission-denied render their own states.
 *
 * Default locale is de-CH (the I18nProvider default), so the copy asserted is the German half.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import { SyncHosting } from './SyncHosting';
import shell from '../../i18n/de-CH.json';

// The panel's copy lives in the shell locale (i18n/de-CH.json). Assert against it directly.
const S = shell.sync;

type CannedHandler = (input: Record<string, unknown>) => RestResponse | Promise<RestResponse>;
type Canned = Record<string, RestResponse | CannedHandler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, status = 422): RestResponse => ({ status, body: { ok: false, error } });

function fakeTransport(canned: Canned): { transport: Transport; calls: [string, Record<string, unknown>][] } {
  const calls: [string, Record<string, unknown>][] = [];
  const transport: Transport = async (action, input) => {
    calls.push([action, input ?? {}]);
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input ?? {}) : entry;
  };
  return { transport, calls };
}

const whoami = (caps: string[]): RestResponse =>
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities: caps });

/** A published contract: publishing on, an epoch minted, a non-zero head. */
const contractOn = (): RestResponse =>
  ok({
    versions: ['till-sync/1'],
    contractVersion: 'till-sync/1',
    publishing: true,
    epoch: 'ep_2026_abc',
    headSeq: 42,
    soleWriter: true,
    oneFilePerTenant: true,
  });

/** The default: publishing off, no epoch, head 0 (the empty state). */
const contractOff = (): RestResponse =>
  ok({
    versions: ['till-sync/1'],
    contractVersion: 'till-sync/1',
    publishing: false,
    epoch: null,
    headSeq: 0,
    soleWriter: true,
    oneFilePerTenant: true,
  });

/** M03: the Hosting journey block reads these on every mount; canned here so each existing test
 *  stays about the dial. A test about the journey overrides them. */
const journeyDefaults = (): Canned => ({
  get_move_state: ok({ move: null }),
  get_workspace: ok({
    workspace: { workspaceId: 'ws_1', name: 'Echt GmbH', legalForm: 'gmbh', baseCurrency: 'CHF', fiscalYearStart: '01-01', archived: false, createdAt: '2026-01-01' },
  }),
});

function tree(canned: Canned, calls?: { current?: [string, Record<string, unknown>][] }) {
  const made = fakeTransport({ ...journeyDefaults(), ...canned });
  if (calls) calls.current = made.calls;
  return (
    <TillClientProvider client={new TillClient(made.transport)}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_1">
          <CapabilitiesProvider>
            <MemoryRouter>
              <SyncHosting />
            </MemoryRouter>
          </CapabilitiesProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

describe('SyncHosting (M02 Sync & hosting panel)', () => {
  it('DIAL OFF: renders the off dial and the honest off posture, with no machine values', async () => {
    render(tree({ get_sync_contract: contractOff() }));
    expect(await screen.findByText(S.state.off.body)).toBeInTheDocument();
    const dial = screen.getByRole('switch');
    expect(dial).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(S.dial.off)).toBeInTheDocument();
    // No stream to describe: the machine values and the consumer block are absent when off.
    expect(screen.queryByText(S.contract.version)).not.toBeInTheDocument();
    expect(screen.queryByText(S.consumer.title)).not.toBeInTheDocument();
  });

  it('DIAL ON: renders the on dial, the AVAILABILITY posture, and the machine values', async () => {
    render(tree({ get_sync_contract: contractOn() }));
    // The sentence the claims critic reads first: availability, never connectivity.
    expect(await screen.findByText(S.state.on.body)).toBeInTheDocument();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(S.contract.version)).toBeInTheDocument();
    expect(screen.getByText('till-sync/1')).toBeInTheDocument();
    expect(screen.getByText(S.stream.head)).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('ep_2026_abc')).toBeInTheDocument();
  });

  it('ON POSTURE never claims connectivity: no "connected" word, only "available"', async () => {
    render(tree({ get_sync_contract: contractOn() }));
    const posture = await screen.findByText(S.state.on.body);
    // The de-CH copy states "steht ... bereit" (available) and "verbindet sich ... mit nichts".
    expect(posture.textContent ?? '').toContain('bereit');
    expect(posture.textContent ?? '').toContain('mit nichts');
  });

  it('CONSUMER READOUT: the honest ◌ no-readout line shows when publishing, never a green in-sync', async () => {
    // LOADING-PROOF-EXEMPT: the role=status here is the consumer-readout RESULT live region, not a loading affordance; the honest no-readout line it asserts can only exist after get_sync_contract really answered.
    render(tree({ get_sync_contract: contractOn() }));
    expect(await screen.findByText(S.consumer.none)).toBeInTheDocument();
    // The status line carries the meaning in text under role=status, glyph aria-hidden.
    const line = screen.getByRole('status', { name: S.consumer.none });
    expect(line).toBeInTheDocument();
  });

  it('NON-OWNER: a member without manage_sync sees the switch disabled and padlocked, not hidden', async () => {
    render(tree({ get_sync_contract: contractOff(), whoami: whoami(['egress.read']) }));
    const dial = await screen.findByRole('switch');
    await waitFor(() => expect(dial).toBeDisabled());
    expect(dial).toHaveAttribute('aria-disabled', 'true');
    // The reason is programmatically associated and visible, never shown-then-rejected.
    expect(screen.getByText(S.dial.denied)).toBeInTheDocument();
    expect(dial).toHaveAttribute('aria-describedby');
  });

  it('OWNER: flipping the off dial calls sync_publish_enable with an m02- idempotency key', async () => {
    const calls: { current?: [string, Record<string, unknown>][] } = {};
    render(
      tree({ get_sync_contract: contractOff(), sync_publish_enable: ok({ publishing: true }) }, calls),
    );
    await screen.findByText(S.state.off.body);
    await userEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect((calls.current ?? []).some(([a]) => a === 'sync_publish_enable')).toBe(true));
    const enable = (calls.current ?? []).find(([a]) => a === 'sync_publish_enable');
    expect(String((enable?.[1] as { idempotencyKey?: string }).idempotencyKey)).toMatch(/^m02-/);
  });

  it('NO DARK PATTERN: the off state carries no enable-nudge and spends no accent on the dial', async () => {
    const { container } = render(tree({ get_sync_contract: contractOff() }));
    await screen.findByText(S.state.off.body);
    const text = (container.textContent ?? '').toLowerCase();
    // No "unlock / freischalten / turn on to ..." nudge copy anywhere in the off render.
    for (const nudge of ['freischalt', 'unlock', 'jetzt einschalten', 'aktiviere']) {
      expect(text).not.toContain(nudge);
    }
    // The dial is a real switch, not a primary "Turn on" call to action.
    expect(screen.getByRole('switch')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: S.dial.on })).not.toBeInTheDocument();
  });

  it('EXIT BOX: fronts G04 with a plain anchor to Data & Backup (#data-title)', async () => {
    render(tree({ get_sync_contract: contractOff() }));
    const link = await screen.findByRole('link', { name: S.exit.link });
    expect(link).toHaveAttribute('href', '#data-title');
    expect(screen.getByText(S.exit.title)).toBeInTheDocument();
  });

  it('TIER NOTE: the managed-tier local-only truth is standing copy, present when off too', async () => {
    render(tree({ get_sync_contract: contractOff() }));
    expect(await screen.findByText(S.tier.note)).toBeInTheDocument();
  });

  it('EPOCH HINT: the epoch row carries a HelpHint explainer trigger', async () => {
    render(tree({ get_sync_contract: contractOn() }));
    await screen.findByText(S.epoch.label);
    expect(screen.getByRole('button', { name: S.epoch.help_label })).toBeInTheDocument();
  });

  it('LOADING: renders the skeleton, never a spinner, before the read resolves', async () => {
    // A handler that never resolves keeps the panel in loading (and no state update escapes act).
    // The counter proves the read really went in flight, so the skeleton is not vacuous.
    let started = 0;
    render(
      tree({
        get_sync_contract: () => {
          started += 1;
          return new Promise<RestResponse>(() => undefined);
        },
      }),
    );
    expect(started).toBe(1);
    // M03: the Hosting journey block mounts its own skeleton beside the dial's, so at least one
    // busy status region is asserted rather than exactly one.
    expect(screen.getAllByRole('status', { busy: true }).length).toBeGreaterThan(0);
    // Let the journey block's canned reads settle (its skeleton yields to the ladder); the dial's
    // own never-resolving read keeps exactly the sync skeleton on screen.
    await waitFor(() => expect(screen.getAllByRole('status', { busy: true }).length).toBe(1));
  });

  it('ERROR: a failed read shows the error banner with retry, and the exit box still renders', async () => {
    render(tree({ get_sync_contract: reject('unexpected_error', 500) }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    // The exit box and tier note are static truths: they render even on a failed read.
    expect(screen.getByText(S.exit.title)).toBeInTheDocument();
    expect(screen.getByText(S.tier.note)).toBeInTheDocument();
    // Never a switch whose state is unknown.
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('PERMISSION-DENIED: a refused read renders the padlock panel, not a crash', async () => {
    render(tree({ get_sync_contract: reject('permission_denied', 403) }));
    expect(await screen.findByText(S.denied.body)).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('A11Y: no axe violations with the dial off', async () => {
    const { container } = render(tree({ get_sync_contract: contractOff() }));
    await screen.findByText(S.state.off.body);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('A11Y: no axe violations with the dial on', async () => {
    const { container } = render(tree({ get_sync_contract: contractOn() }));
    await screen.findByText(S.state.on.body);
    expect(await axe(container)).toHaveNoViolations();
  });
});
