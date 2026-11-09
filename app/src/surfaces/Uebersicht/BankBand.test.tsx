/**
 * D142 + D143, the Übersicht's Bankeingang band in its minimal form (mockup v3): every state it can be
 * in, each as a dot colour on the bank's mark PLUS the words in the mark's accessible name and its card
 * (never colour alone), the card's keyboard reach, and the doors the band opens (asserted on the ROUTER,
 * not on a spy). The transport is canned per action, so every assertion is about what the band sends and
 * renders; the counts' equality with `/bank` is the engine's (`test/dashboards/bank-inbox-tile.test.mjs`).
 * All figures synthetic.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { neverSettles, watchReads } from '../../test-transport';
import { BankBand, whenText } from './BankBand';
import { ATTENTION_CHANGED_EVENT } from '../Attention/attentionSummary';

type Handler = (input: Record<string, unknown>) => RestResponse;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const refuse = (error: string, extra: Record<string, unknown> = {}): RestResponse => ({ status: 422, body: { ok: false, error, ...extra } });

// 28.09.2026, 09:30 in Zurich (summer time): "heute" is the 28th.
const NOW = new Date('2026-09-28T07:30:00.000Z');

const LAST_AUTO = { startedAt: '2026-09-28T05:02:00.000Z', finishedAt: '2026-09-28T05:02:30.000Z', ok: true, code: 'downloaded', retryable: false, attempt: 1, detail: { newMembers: 1 } };
const AUTO = { mode: 'daily', atTime: '07:00', nextAt: '2026-09-29T05:00:00.000Z', lastAuto: LAST_AUTO };
const NO_ACTIVATION = { checking: false, lastCheckAt: null, nextCheckAt: null, bankReady: false, lastOutcome: null };

const CHANNEL = {
  connectionId: 'ebc_1',
  state: 'active',
  lastSyncAt: '2026-09-28T05:02:10.000Z',
  syncInProgress: false,
  keystoreState: 'ready',
  keystorePersistent: true,
  pendingStatements: 0,
  numberJumps: [] as unknown[],
  autoSync: AUTO as Record<string, unknown>,
  bankName: 'ZKB',
  activation: NO_ACTIVATION as Record<string, unknown>,
};

function channel(over: Record<string, unknown> = {}) {
  return { ...CHANNEL, ...over };
}

function tile(over: Record<string, unknown> = {}) {
  return {
    tile: 'bank_inbox',
    ok: true,
    glyph: '⇄',
    currency: 'CHF',
    open: 12,
    needs: 3,
    sure: 7,
    learned: 2,
    noReceipt: 4,
    accounts: [
      { bankAccountId: 'ba_chf', name: 'Seeblick Geschäftskonto', currency: 'CHF', open: 9, needs: 2, sure: 6, noReceipt: 3, inMinor: 250_000, outMinor: 48_590 },
      { bankAccountId: 'ba_eur', name: 'Seeblick EUR', currency: 'EUR', open: 3, needs: 1, sure: 1, noReceipt: 1, inMinor: 0, outMinor: 12_000 },
    ],
    lastSyncAt: '2026-09-28T05:02:10.000Z',
    syncInProgress: false,
    channels: [CHANNEL],
    autoAvailable: true,
    ...over,
  };
}

/** A connection waiting for ZKB, checked daily (D143). */
const WAITING = channel({
  state: 'pending_bank_activation',
  lastSyncAt: null,
  autoSync: { mode: 'daily', atTime: '07:00', nextAt: null, lastAuto: null },
  activation: { checking: true, lastCheckAt: '2026-09-28T05:00:20.000Z', nextCheckAt: '2026-09-29T05:00:00.000Z', bankReady: false, lastOutcome: 'not_activated' },
});

/** ZKB answered HPB: the keys wait for the person's comparison. */
const READY = channel({
  state: 'pending_bank_activation',
  lastSyncAt: null,
  autoSync: { mode: 'daily', atTime: '07:00', nextAt: null, lastAuto: null },
  activation: { checking: false, lastCheckAt: '2026-09-28T05:00:20.000Z', nextCheckAt: null, bankReady: true, lastOutcome: 'bank_ready' },
});

function transportFor(handlers: Record<string, RestResponse | Handler>): Transport {
  return async (action, input) => {
    const h = handlers[action];
    if (h === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof h === 'function' ? h(input) : h;
  };
}

function Probe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderBand(transport: Transport, locale: 'de-CH' | 'en' = 'de-CH') {
  return render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider initialLocale={locale}>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter initialEntries={['/overview']}>
            <Routes>
              <Route path="*" element={<><BankBand /><Probe /></>} />
            </Routes>
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

const band = (t: Record<string, unknown>, locale: 'de-CH' | 'en' = 'de-CH') => renderBand(transportFor({ dashboard_tile: ok({ tile: t }) }), locale);

/** The bank's mark (a button named by the state in words) and its tone class. */
async function mark(name: string | RegExp) {
  const trigger = await screen.findByRole('button', { name });
  const wrap = trigger.closest('.bank-mark') as HTMLElement;
  return { trigger, wrap, tone: [...wrap.classList].find((c) => c.startsWith('bank-mark--'))?.slice('bank-mark--'.length) };
}

/** The card a mark controls, found by its id (a hidden card has no accessible name to query by). */
function cardOf(trigger: HTMLElement): HTMLElement {
  return document.getElementById(trigger.getAttribute('aria-controls') ?? '') as HTMLElement;
}

/** The band's VISIBLE text: without the closed card and without screen-reader-only words. */
function visibleText(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.bank-mark__card, .visually-hidden').forEach((n) => n.remove());
  return (clone.textContent ?? '').replace(/\s+/g, ' ');
}

/** Open the card by hovering the mark, and return it. */
async function card(name: string | RegExp) {
  const m = await mark(name);
  await userEvent.hover(m.trigger);
  const group = screen.getByRole('group', { name });
  expect(group).toBeVisible();
  return group;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the Bankeingang band', () => {
  it('asks the engine for the bank_inbox tile, and shows a skeleton while that read is in flight', async () => {
    const inputs: Record<string, unknown>[] = [];
    const transport = watchReads((action, input) => {
      if (action === 'dashboard_tile') inputs.push(input);
      return neverSettles(action, input);
    });
    const { container } = renderBand(transport);
    await transport.started('dashboard_tile');
    expect(inputs[0]).toMatchObject({ workspaceId: 'ws_test', tile: 'bank_inbox' });
    await waitFor(() => expect(container.querySelector('.bank-band--pending')).not.toBeNull());
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('LEFT SIDE (D150): the headline is what waits for you, in visible words; the open total is secondary; two icon facets', async () => {
    const { container } = band(tile());
    // The headline's accessible name IS its visible words ("Bank 2" read as "two fetches worked").
    const waiting = await screen.findByRole('link', { name: '3 Buchungen warten auf dich' });
    expect(waiting).toHaveAttribute('href', '/bank?facet=needs');
    expect(waiting).toHaveTextContent(/^3 Buchungen warten auf dich$/);
    const open = screen.getByRole('link', { name: '12 offene Bankbuchungen' });
    expect(open).toHaveAttribute('href', '/bank');
    expect(open).toHaveTextContent(/^12 offen$/);
    expect(screen.getByRole('heading', { name: 'Bank' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '7 sicher vorgeschlagen' })).toHaveAttribute('href', '/bank?facet=sure');
    const noReceipt = screen.getByRole('link', { name: '4 ohne Beleg' });
    expect(noReceipt).toHaveAttribute('href', '/bank?tab=booked&facet=noreceipt');
    expect(noReceipt).toHaveAttribute('title', 'Ohne Beleg');
    expect(noReceipt.querySelector('svg')).not.toBeNull();
    // The facet that would repeat the headline is gone.
    expect(screen.queryByRole('link', { name: '3 brauchen dich' })).toBeNull();
    const text = visibleText(container.querySelector('.bank-band') as HTMLElement);
    expect(text).toBe('Bank3 Buchungen warten auf dich12 offen74ZKB');
    expect(screen.queryByRole('list', { name: 'Offene Bankbuchungen pro Bankkonto' })).toBeNull();
    await userEvent.click(waiting);
    expect(screen.getByTestId('location')).toHaveTextContent('/bank?facet=needs');
    await userEvent.click(open);
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/bank$/);
  });

  it('ONE NUMBER WITH THE HUB (critic LOW 5): the headline is the waiting lines without those a Vorschlag names, which are their own door', async () => {
    band(tile({ waiting: 2, vorschlag: 1 }));
    expect(await screen.findByRole('link', { name: '2 Buchungen warten auf dich' })).toHaveAttribute('href', '/bank?facet=needs');
    expect(screen.queryByRole('link', { name: '3 Buchungen warten auf dich' })).toBeNull();
    expect(screen.getByRole('link', { name: '1 mit Vorschlag' })).toHaveAttribute('href', '/agent');
    expect(screen.getByRole('link', { name: '12 offene Bankbuchungen' })).toHaveTextContent(/^12 offen$/);
  });

  it('ONE LINE WAITING: the singular, in words and in the name', async () => {
    band(tile({ needs: 1 }));
    expect(await screen.findByRole('link', { name: '1 Buchung wartet auf dich' })).toHaveTextContent(/^1 Buchung wartet auf dich$/);
  });

  it('NOTHING WAITING (D150): "Nichts wartet auf dich · 12 offen", never a bare 0, and a facet at zero is dimmed and no door', async () => {
    const { container } = band(tile({ needs: 0, sure: 0 }));
    expect(await screen.findByText('Nichts wartet auf dich')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /warten auf dich|wartet auf dich/ })).toBeNull();
    expect(screen.getByRole('link', { name: '12 offene Bankbuchungen' })).toHaveTextContent('· 12 offen');
    expect(visibleText(container.querySelector('.bank-band') as HTMLElement)).toMatch(/^BankNichts wartet auf dich· 12 offen/);
    const zero = screen.getByTitle('Sicher vorgeschlagen');
    expect(zero).toHaveClass('is-zero');
    expect(zero.tagName).toBe('SPAN');
    expect(zero).toHaveTextContent('0 sicher vorgeschlagen');
  });

  it('en: the headline in English', async () => {
    band(tile(), 'en');
    expect(await screen.findByRole('link', { name: '3 bank lines are waiting for you' })).toHaveAttribute('href', '/bank?facet=needs');
  });

  it('ACTIVE, FETCHED AUTOMATICALLY: a success dot on "ZKB", the card names the fetch and the next run, and an icon-only Jetzt abrufen', async () => {
    band(tile());
    const m = await mark('ZKB aktiv');
    expect(m.tone).toBe('success');
    expect(m.trigger).toHaveTextContent(/^ZKB$/);
    expect(m.wrap.querySelector('.bank-mark__dot')).not.toBeNull();
    expect(cardOf(m.trigger)).not.toBeVisible();
    const c = await card('ZKB aktiv');
    expect(c).toHaveTextContent('Abgerufen heute 07:02, automatisch');
    expect(c).toHaveTextContent('Nächster automatischer Abruf: morgen 07:00');
    const press = screen.getByRole('button', { name: 'Jetzt abrufen' });
    expect(press).toHaveAttribute('title', 'Jetzt abrufen');
    expect(press).toHaveTextContent(/^$/);
    expect(press.querySelector('svg')).not.toBeNull();
    expect(press).not.toHaveClass('btn--primary');
  });

  it('THE CARD is reachable by keyboard: focus opens it, Tab reaches its action, Escape closes it', async () => {
    band(tile({ channels: [READY] }));
    await screen.findByRole('button', { name: 'ZKB: Schlüssel prüfen' });
    await userEvent.tab(); // the big count
    await userEvent.tab(); // needs
    await userEvent.tab(); // sure
    await userEvent.tab(); // no receipt
    await userEvent.tab(); // the mark
    const trigger = screen.getByRole('button', { name: 'ZKB: Schlüssel prüfen' });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const group = screen.getByRole('group', { name: 'ZKB: Schlüssel prüfen' });
    expect(group).toBeVisible();
    await userEvent.tab();
    const action = within(group).getByRole('link', { name: 'Schlüssel vergleichen' });
    expect(action).toHaveFocus();
    expect(group).toBeVisible();
    expect(action).toHaveAttribute('href', '/bank-accounts');
    await userEvent.keyboard('{Escape}');
    expect(cardOf(trigger)).not.toBeVisible();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await userEvent.tab({ shift: true });
    await userEvent.click(trigger);
    expect(screen.getByRole('group', { name: 'ZKB: Schlüssel prüfen' })).toBeVisible();
  });

  it('THE CARD survives the pointer crossing to its action (critic F4): a close delay, and a bridge over the gap', async () => {
    band(tile({ channels: [READY] }));
    const m = await mark('ZKB: Schlüssel prüfen');
    const group = cardOf(m.trigger);
    await userEvent.hover(m.trigger);
    expect(group).toBeVisible();
    // The pointer leaves the mark and reaches the card a moment later, as a hand does.
    await userEvent.unhover(m.trigger);
    expect(group).toBeVisible();
    await userEvent.hover(group);
    await new Promise((r) => setTimeout(r, 400));
    expect(group).toBeVisible();
    const action = within(group).getByRole('link', { name: 'Schlüssel vergleichen' });
    await userEvent.click(action);
    expect(screen.getByTestId('location')).toHaveTextContent('/bank-accounts');
  });

  it('THE CARD closes after the pointer truly left, and Escape closes a hover-opened card from anywhere', async () => {
    band(tile({ channels: [READY] }));
    const m = await mark('ZKB: Schlüssel prüfen');
    const group = cardOf(m.trigger);
    await userEvent.hover(m.trigger);
    await userEvent.unhover(m.trigger);
    await waitFor(() => expect(group).not.toBeVisible());
    await userEvent.hover(m.trigger);
    expect(group).toBeVisible();
    expect(m.trigger).not.toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(group).not.toBeVisible();
  });

  it('THE CARD has a hover bridge over the gap below the mark (the rule, as text: jsdom lays nothing out)', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'BankBand.css'), 'utf8');
    const bridge = /\.bank-mark__card::before\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(bridge).toMatch(/content:\s*''/);
    expect(bridge).toMatch(/top:\s*calc\(-1 \* var\(--t-space-1\)\)/);
    expect(bridge).toMatch(/height:\s*var\(--t-space-1\)/);
    expect(css).toMatch(/\.bank-mark__card\s*\{[^}]*top:\s*calc\(100% \+ var\(--t-space-1\)\)/);
  });

  it('WAITING FOR ZKB (D143): the four pips at step 2, the daily check in words, and no refresh button', async () => {
    band(tile({ channels: [WAITING] }));
    const m = await mark('ZKB: warte auf Freischaltung');
    expect(m.tone).toBe('warn');
    expect(m.wrap.querySelector('.bank-mark__dot')).toBeNull();
    const pips = [...m.wrap.querySelectorAll('.bank-mark__pips .bank-mark__pip')].map((p) => p.className.replace('bank-mark__pip ', ''));
    expect(pips).toEqual(['is-done', 'is-now', 'is-todo', 'is-todo']);
    const c = await card('ZKB: warte auf Freischaltung');
    expect(c).toHaveTextContent('TILL fragt jeden Morgen um 07:00 bei der ZKB nach, ob der Zugang freigeschaltet ist. Du musst nichts tun.');
    expect(c).toHaveTextContent('Zuletzt geprüft heute 07:00 · nächste Prüfung morgen 07:00');
    const steps = within(c).getByRole('list', { name: 'Einrichtung in vier Schritten' });
    expect(within(steps).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Brief an die ZKB geschickt, erledigt',
      'ZKB schaltet frei, jetzt',
      'Schlüssel einmal vergleichen, offen',
      'Täglicher Abruf läuft, offen',
    ]);
    expect(screen.queryByRole('button', { name: 'Jetzt abrufen' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '12 offene Bankbuchungen' })).toBeInTheDocument();
  });

  it('ZKB ACTIVATED (D143): "Schlüssel prüfen", the pips at step 3, the one action leads to the compare', async () => {
    band(tile({ channels: [READY] }));
    const m = await mark('ZKB: Schlüssel prüfen');
    expect(m.tone).toBe('warn');
    const pips = [...m.wrap.querySelectorAll('.bank-mark__pips .bank-mark__pip')].map((p) => p.className.replace('bank-mark__pip ', ''));
    expect(pips).toEqual(['is-done', 'is-done', 'is-now', 'is-todo']);
    const c = await card('ZKB: Schlüssel prüfen');
    expect(c).toHaveTextContent('Die ZKB hat freigeschaltet. Vergleiche die angezeigten Hashwerte einmal mit dem Blatt der ZKB.');
    expect(c).toHaveTextContent('Freischaltung erkannt heute 07:00');
    await userEvent.click(within(c).getByRole('link', { name: 'Schlüssel vergleichen' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/bank-accounts');
  });

  it('LIVE: the lamp follows the bank while the page stays open (a focus or an announced change re-reads quietly)', async () => {
    let current = WAITING;
    const transport = watchReads(transportFor({ dashboard_tile: () => ok({ tile: tile({ channels: [current] }) }) }));
    const { container } = renderBand(transport);
    await mark('ZKB: warte auf Freischaltung');
    // The bank switches the access on while the Übersicht is open; the person comes back to the tab.
    current = READY;
    window.dispatchEvent(new Event('focus'));
    await mark('ZKB: Schlüssel prüfen');
    expect(transport.asked.filter((a) => a === 'dashboard_tile')).toHaveLength(2);
    // A quiet refresh: the band never fell back to its skeleton on the way.
    expect(container.querySelector('.bank-band--pending')).toBeNull();
    // A change announced by the hub re-reads too.
    window.dispatchEvent(new Event(ATTENTION_CHANGED_EVENT));
    await waitFor(() => expect(transport.asked.filter((a) => a === 'dashboard_tile')).toHaveLength(3));
  });

  it('A FIGURE THAT MOVED takes the Commit tint on a quiet re-read; the first read and an unchanged figure take none (D122 D-I)', async () => {
    let needs = 3;
    const transport = watchReads(transportFor({ dashboard_tile: () => ok({ tile: tile({ needs }) }) }));
    const { container } = renderBand(transport);
    const count = await waitFor(() => {
      const el = container.querySelector('.bank-band__count');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(count.textContent).toBe('3');
    // The first read is not a change: nothing is tinted.
    expect(container.querySelectorAll('[data-just-committed]')).toHaveLength(0);
    // A line was decided elsewhere; the band re-reads quietly and the waiting figure moves.
    needs = 2;
    window.dispatchEvent(new Event(ATTENTION_CHANGED_EVENT));
    await waitFor(() => expect(container.querySelector('.bank-band__count')?.textContent).toBe('2'));
    // The stamp is set by a passive effect after the commit that drew the new figure: wait for it.
    await waitFor(() => expect(container.querySelector('.bank-band__count')).toHaveAttribute('data-just-committed'));
    // The open total did not change, so it is not tinted.
    expect(container.querySelector('.bank-band__open')).not.toHaveAttribute('data-just-committed');
    // The stamp lifts once the tint has decayed.
    await waitFor(() => expect(container.querySelector('[data-just-committed]')).toBeNull(), { timeout: 2000 });
  });

  it('each figure owns its tint: the open total moving does not cancel the waiting count\'s running tint', async () => {
    let needs = 3;
    let open = 12;
    const transport = watchReads(transportFor({ dashboard_tile: () => ok({ tile: tile({ needs, open }) }) }));
    const { container } = renderBand(transport);
    await waitFor(() => expect(container.querySelector('.bank-band__count')?.textContent).toBe('3'));
    needs = 2;
    window.dispatchEvent(new Event(ATTENTION_CHANGED_EVENT));
    await waitFor(() => expect(container.querySelector('.bank-band__count')?.textContent).toBe('2'));
    // The stamp is set by a passive effect after the commit that drew the new figure: wait for it.
    await waitFor(() => expect(container.querySelector('.bank-band__count')).toHaveAttribute('data-just-committed'));
    // Inside the tint, only the open total moves on the next quiet read.
    open = 11;
    window.dispatchEvent(new Event(ATTENTION_CHANGED_EVENT));
    await waitFor(() => expect(container.querySelector('.bank-band__open')).toHaveAttribute('data-just-committed'));
    expect(container.querySelector('.bank-band__count')).toHaveAttribute('data-just-committed');
    await waitFor(() => expect(container.querySelector('[data-just-committed]')).toBeNull(), { timeout: 2000 });
  });

  it('a changed figure tints, never lands: the band stylesheet keeps the tint and drops the travel', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'BankBand.css'), 'utf8');
    const rule = /\.bank-band__count\[data-just-committed\][^{]*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/animation:\s*motion-tint var\(--t-motion-tint\) var\(--t-ease-out\)/);
    expect(rule).not.toMatch(/motion-land/);
  });

  it('WAITING with the daily check off, or under till serve: the pips stay, the card says TILL does not ask', async () => {
    band(tile({ channels: [channel({ ...WAITING, activation: { ...WAITING.activation, checking: false, nextCheckAt: null } })] }));
    const c = await card('ZKB: warte auf Freischaltung');
    expect(c).toHaveTextContent('Die tägliche Nachfrage ist aus.');
    expect(c).not.toHaveTextContent('nächste Prüfung');
  });

  it('WAITING, but the key store is locked: a fault, the stuck step marked, and the one act that clears it', async () => {
    band(tile({ channels: [channel({ ...WAITING, keystoreState: 'locked' })] }));
    const m = await mark('ZKB: Nachfrage gestört');
    expect(m.tone).toBe('danger');
    expect(m.wrap.querySelector('.bank-mark__pip.is-fault')).not.toBeNull();
    const c = await card('ZKB: Nachfrage gestört');
    expect(c).toHaveTextContent('Die Schlüsselablage ist gesperrt, deshalb kann TILL nicht bei der ZKB nachfragen.');
    expect(c).toHaveTextContent('Starte TILL mit der Passphrase der Schlüsselablage neu.');
    expect(c).not.toHaveTextContent('Auszüge');
  });

  // Critic F2: every activation outcome, and never "Du musst nichts tun" when that is false.
  const withOutcome = (lastOutcome: string, over: Record<string, unknown> = {}) =>
    channel({ ...WAITING, activation: { ...WAITING.activation, lastOutcome, ...over } });

  it('ACTIVATION keystore_locked at the last check, unlocked since (critic F3): no stale lock on the lamp', async () => {
    band(tile({ channels: [withOutcome('keystore_locked', { nextCheckAt: '2026-09-28T07:31:00.000Z' })] }));
    const m = await mark('ZKB: warte auf Freischaltung');
    expect(m.tone).toBe('warn');
    const c = await card('ZKB: warte auf Freischaltung');
    expect(c).not.toHaveTextContent(/Schlüsselablage/);
  });

  it('ACTIVATION not_activated: the calm wait, and there truly is nothing to do', async () => {
    band(tile({ channels: [withOutcome('not_activated')] }));
    expect((await mark('ZKB: warte auf Freischaltung')).tone).toBe('warn');
    expect(await card('ZKB: warte auf Freischaltung')).toHaveTextContent('Du musst nichts tun.');
  });

  it('ACTIVATION channel_unreachable: danger, the check did not get through, and when TILL tries again', async () => {
    band(tile({ channels: [withOutcome('channel_unreachable', { nextCheckAt: '2026-09-28T06:02:30.000Z' })] }));
    const m = await mark('ZKB: Nachfrage gestört');
    expect(m.tone).toBe('danger');
    const c = await card('ZKB: Nachfrage gestört');
    expect(c).toHaveTextContent('Die letzte Nachfrage bei der ZKB kam nicht durch.');
    expect(c).toHaveTextContent('Nächster Versuch: heute 08:02');
    expect(c).not.toHaveTextContent('Du musst nichts tun');
  });

  it('ACTIVATION, a failed attempt (critic F9): "Letzter Versuch", never "Zuletzt geprüft" for a check the bank never saw', async () => {
    band(tile({ channels: [withOutcome('channel_unreachable', { lastCheckAt: null, lastAttemptAt: '2026-09-28T05:02:00.000Z', nextCheckAt: '2026-09-28T06:02:30.000Z' })] }));
    const c = await card('ZKB: Nachfrage gestört');
    expect(c).toHaveTextContent('Letzter Versuch heute 07:02');
    expect(c).not.toHaveTextContent('Zuletzt geprüft');
  });

  it('ACTIVATION worker_failed (critic R3-3): danger, and it never claims the bank was asked', async () => {
    band(tile({ channels: [withOutcome('worker_failed', { lastCheckAt: null, lastAttemptAt: '2026-09-28T05:02:00.000Z', nextCheckAt: '2026-09-28T06:02:30.000Z' })] }));
    expect((await mark('ZKB: Nachfrage gestört')).tone).toBe('danger');
    const c = await card('ZKB: Nachfrage gestört');
    expect(c).toHaveTextContent('Die Nachfrage bei der ZKB konnte nicht starten.');
    expect(c).not.toHaveTextContent('kam nicht durch');
    expect(c).toHaveTextContent('Nächster Versuch: heute 08:02');
    expect(c).not.toHaveTextContent('Du musst nichts tun');
  });

  it('ACTIVATION needs_bank_transport: danger, TILL cannot ask at all', async () => {
    band(tile({ channels: [withOutcome('needs_bank_transport', { nextCheckAt: null })] }));
    expect((await mark('ZKB: Nachfrage gestört')).tone).toBe('danger');
    const c = await card('ZKB: Nachfrage gestört');
    expect(c).toHaveTextContent('In diesem TILL ist keine Bankverbindung eingerichtet, deshalb kann TILL nicht bei der ZKB nachfragen.');
    expect(c).not.toHaveTextContent('Du musst nichts tun');
  });

  it('ACTIVATION keystore_unavailable: danger, TILL cannot ask at all', async () => {
    band(tile({ channels: [withOutcome('keystore_unavailable', { nextCheckAt: null })] }));
    const c = await card('ZKB: Nachfrage gestört');
    expect(c).toHaveTextContent('Die Schlüsselablage fehlt oder ist beschädigt, deshalb kann TILL nicht bei der ZKB nachfragen.');
    expect(c).not.toHaveTextContent('Du musst nichts tun');
  });

  it('ACTIVATION auto_sync_no_actor (critic F8, U5): danger, the reason in words, and the Members door', async () => {
    band(tile({ channels: [withOutcome('auto_sync_no_actor', { nextCheckAt: null })] }));
    const m = await mark('ZKB: Nachfrage gestört');
    expect(m.tone).toBe('danger');
    expect(m.wrap.querySelector('.bank-mark__pip.is-fault')).not.toBeNull();
    const c = await card('ZKB: Nachfrage gestört');
    expect(c).toHaveTextContent(/Weder die Person, die den Abruf eingestellt hat, noch der Inhaber darf Kontoauszüge abrufen/);
    expect(within(c).getByRole('link', { name: 'Zu den Mitgliedern' })).toHaveAttribute('href', '/members');
  });

  it('INI_SENT: the legs are not both confirmed; the one action is to resend them on /bank-accounts', async () => {
    band(tile({ channels: [channel({ ...WAITING, state: 'ini_sent', activation: { ...WAITING.activation, lastOutcome: 'not_activated' } })] }));
    const m = await mark('ZKB: INI und HIA erneut senden');
    expect(m.tone).toBe('warn');
    const pips = [...m.wrap.querySelectorAll('.bank-mark__pips .bank-mark__pip')].map((p) => p.className.replace('bank-mark__pip ', ''));
    expect(pips).toEqual(['is-now', 'is-todo', 'is-todo', 'is-todo']);
    const c = await card('ZKB: INI und HIA erneut senden');
    expect(c).toHaveTextContent('INI und HIA sind noch nicht beide von der ZKB bestätigt.');
    expect(c).not.toHaveTextContent('Du musst nichts tun');
    expect(within(c).getByRole('link', { name: 'Erneut senden' })).toHaveAttribute('href', '/bank-accounts');
  });

  it('KEYS GENERATED, legs never sent: the same one action, never a calm wait', async () => {
    band(tile({ channels: [channel({ ...WAITING, state: 'keys_generated', activation: NO_ACTIVATION })] }));
    const c = await card('ZKB: INI und HIA erneut senden');
    expect(c).toHaveTextContent('INI und HIA sind noch nicht an die ZKB gesendet.');
    expect(within(c).getByRole('link', { name: 'Erneut senden' })).toBeInTheDocument();
  });

  it('NOTHING NEW: an automatic fetch the bank had nothing for says so in the card', async () => {
    band(tile({ channels: [channel({ autoSync: { ...AUTO, lastAuto: { ...LAST_AUTO, code: 'no_data', detail: null } } })] }));
    expect(await card('ZKB aktiv')).toHaveTextContent('Nichts Neues.');
  });

  it('RUNNING: a fetch under way keeps the page usable and the button says it is running', async () => {
    // LOADING-PROOF-EXEMPT: aria-busy here is the fetch button's RUNNING state carried by the answered bank_inbox tile (syncInProgress), not a loading affordance; the hover card it asserts can only exist after dashboard_tile really answered.
    band(tile({ syncInProgress: true, channels: [channel({ syncInProgress: true })] }));
    const c = await card('ZKB: Kontoauszüge werden abgerufen');
    expect(c).toHaveTextContent('Du kannst weiterarbeiten.');
    const press = screen.getByRole('button', { name: 'Wird abgerufen' });
    expect(press).toBeDisabled();
    expect(press).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('link', { name: '3 Buchungen warten auf dich' })).toBeInTheDocument();
  });

  it('BANK UNREACHABLE: a danger dot, the reason in words and when the next automatic try runs', async () => {
    band(
      tile({
        channels: [
          channel({
            lastSyncAt: '2026-09-27T05:01:00.000Z',
            autoSync: { ...AUTO, nextAt: '2026-09-28T06:02:30.000Z', lastAuto: { ...LAST_AUTO, ok: false, code: 'channel_unreachable', retryable: true, detail: null } },
          }),
        ],
      }),
    );
    const m = await mark('ZKB: Abruf gestört');
    expect(m.tone).toBe('danger');
    const c = await card('ZKB: Abruf gestört');
    expect(c).toHaveTextContent('Die Bank war nicht erreichbar.');
    expect(c).toHaveTextContent('Nächster Versuch: heute 08:02');
    expect(screen.getByRole('button', { name: 'Jetzt abrufen' })).toBeEnabled();
  });

  it('NO SEATED ACTOR (critic F1): the automatic fetch had nobody to run as; the card says so and opens Members', async () => {
    band(tile({ channels: [channel({ lastSyncAt: '2026-09-27T05:01:00.000Z', autoSync: { ...AUTO, lastAuto: { ...LAST_AUTO, ok: false, code: 'auto_sync_no_actor', finishedAt: '2026-09-28T05:02:00.000Z', detail: null } } })] }));
    const c = await card('ZKB: Abruf gestört');
    // Critic R2-2: what was tried, the setter and the owner, never "nobody in this workspace".
    expect(c).toHaveTextContent(/Weder die Person, die den Abruf eingestellt hat, noch der Inhaber darf Kontoauszüge abrufen/);
    expect(c).not.toHaveTextContent(/niemand in diesem Arbeitsbereich/);
    expect(within(c).getByRole('link', { name: 'Zu den Mitgliedern' })).toHaveAttribute('href', '/members');
  });

  // Critic R3-2 (D142): a schedule nobody set has no setter; the sentence names only the owner.
  const noActor = (setterKnown: boolean) =>
    channel({ lastSyncAt: '2026-09-27T05:01:00.000Z', autoSync: { ...AUTO, setterKnown, lastAuto: { ...LAST_AUTO, ok: false, code: 'auto_sync_no_actor', finishedAt: '2026-09-28T05:02:00.000Z', detail: null } } });
  const NEVER_SET_DE = 'Der automatische Abruf lief nicht: Niemand hat ihn eingestellt, darum ruft TILL als Inhaber ab, und der Inhaber darf keine Kontoauszüge abrufen. Gib dem Inhaber das Recht für Zahlungen zurück oder stelle den Abruf als eine Person ein, die es hat.';
  const NEVER_SET_EN = 'The automatic fetch did not run: nobody has set it up, so TILL fetches as the owner, and the owner may not fetch statements. Give the owner back the right to make payments, or set up the fetch as someone who has it.';

  it('NO SEATED ACTOR, schedule never set (critic R3-2, de-CH): names only the owner, never a setter', async () => {
    band(tile({ channels: [noActor(false)] }));
    const c = await card('ZKB: Abruf gestört');
    expect(c).toHaveTextContent(NEVER_SET_DE);
    expect(c).not.toHaveTextContent(/die den Abruf eingestellt hat/);
    expect(within(c).getByRole('link', { name: 'Zu den Mitgliedern' })).toHaveAttribute('href', '/members');
  });

  it('NO SEATED ACTOR, schedule never set (critic R3-2, en): names only the owner, never a setter', async () => {
    band(tile({ channels: [noActor(false)] }), 'en');
    const c = await card('ZKB: fetch failed');
    expect(c).toHaveTextContent(NEVER_SET_EN);
    expect(c).not.toHaveTextContent(/the person who set it up/);
  });

  it('NO SEATED ACTOR, schedule set by a person (critic R3-2, de-CH): names the setter and the owner', async () => {
    band(tile({ channels: [noActor(true)] }));
    const de = await card('ZKB: Abruf gestört');
    expect(de).toHaveTextContent('Weder die Person, die den Abruf eingestellt hat, noch der Inhaber darf Kontoauszüge abrufen.');
    expect(de).not.toHaveTextContent(/Niemand hat ihn eingestellt/);
  });

  it('NO SEATED ACTOR, schedule set by a person (critic R3-2, en): names the setter and the owner', async () => {
    band(tile({ channels: [noActor(true)] }), 'en');
    const c = await card('ZKB: fetch failed');
    expect(c).toHaveTextContent('neither the person who set it up nor the owner may fetch statements.');
    expect(c).not.toHaveTextContent(/nobody has set it up/);
  });

  // Critic LB-1 (D143): an agent's setter is never tried, so the fetch ran as the owner alone.
  const bySetter = (scheduleSetter: 'none' | 'owner' | 'agent' | 'person') =>
    channel({ lastSyncAt: '2026-09-27T05:01:00.000Z', autoSync: { ...AUTO, setterKnown: scheduleSetter === 'person', scheduleSetter, lastAuto: { ...LAST_AUTO, ok: false, code: 'auto_sync_no_actor', finishedAt: '2026-09-28T05:02:00.000Z', detail: null } } });
  const AGENT_SET_DE = 'Der automatische Abruf lief nicht: Ein Agent hat ihn eingestellt, und was ein Agent einstellt, ruft TILL als Inhaber ab. Der Inhaber darf keine Kontoauszüge abrufen. Gib dem Inhaber das Recht für Zahlungen zurück oder stelle den Abruf als eine Person ein, die es hat.';
  const AGENT_SET_EN = 'The automatic fetch did not run: an agent set it up, and TILL runs what an agent sets up as the owner. The owner may not fetch statements. Give the owner back the right to make payments, or set up the fetch as someone who has it.';

  it('NO SEATED ACTOR, schedule set by an agent (critic LB-1, de-CH): runs as the owner, never "the person who set it"', async () => {
    band(tile({ channels: [bySetter('agent')] }));
    const c = await card('ZKB: Abruf gestört');
    expect(c).toHaveTextContent(AGENT_SET_DE);
    expect(c).not.toHaveTextContent(/Weder die Person|Niemand hat ihn eingestellt/);
    expect(within(c).getByRole('link', { name: 'Zu den Mitgliedern' })).toHaveAttribute('href', '/members');
  });

  it('NO SEATED ACTOR, schedule set by an agent (critic LB-1, en): runs as the owner, never "the person who set it"', async () => {
    band(tile({ channels: [bySetter('agent')] }), 'en');
    const c = await card('ZKB: fetch failed');
    expect(c).toHaveTextContent(AGENT_SET_EN);
    expect(c).not.toHaveTextContent(/the person who set it up|nobody has set it up/);
  });

  it('NO SEATED ACTOR, schedule set by the owner (critic LB-1): one party, the owner', async () => {
    band(tile({ channels: [bySetter('owner')] }));
    const c = await card('ZKB: Abruf gestört');
    expect(c).toHaveTextContent('Der automatische Abruf lief nicht: Der Inhaber hat ihn eingestellt, darum ruft TILL als Inhaber ab, und der Inhaber darf keine Kontoauszüge abrufen.');
    expect(c).not.toHaveTextContent(/Weder die Person|Niemand hat ihn eingestellt/);
  });

  it('NO SEATED ACTOR: the setter kind wins over setterKnown (critic LB-1)', async () => {
    band(tile({ channels: [bySetter('none')] }));
    expect(await card('ZKB: Abruf gestört')).toHaveTextContent(NEVER_SET_DE);
  });

  it('ACTIVATION auto_sync_no_actor, schedule set by an agent (critic LB-1): the check card says it runs as the owner', async () => {
    band(tile({ channels: [channel({ ...WAITING, autoSync: { ...WAITING.autoSync, setterKnown: false, scheduleSetter: 'agent' }, activation: { ...WAITING.activation, lastOutcome: 'auto_sync_no_actor', nextCheckAt: null } })] }));
    const c = await card('ZKB: Nachfrage gestört');
    expect(c).toHaveTextContent(AGENT_SET_DE);
  });

  it('ACTIVATION auto_sync_no_actor, schedule never set (critic R3-2): the check card names only the owner', async () => {
    band(tile({ channels: [channel({ ...WAITING, autoSync: { ...WAITING.autoSync, setterKnown: false }, activation: { ...WAITING.activation, lastOutcome: 'auto_sync_no_actor', nextCheckAt: null } })] }));
    const c = await card('ZKB: Nachfrage gestört');
    expect(c).toHaveTextContent(NEVER_SET_DE);
    expect(c).not.toHaveTextContent(/Weder die Person/);
  });

  it('KEYSTORE LOCKED (critic F3): says the key is locked, names the one action that clears it, promises no retry', async () => {
    band(tile({ channels: [channel({ keystoreState: 'locked' })] }));
    const c = await card('ZKB: Abruf gestört');
    expect(c).toHaveTextContent('Die Schlüsselablage ist gesperrt, deshalb ruft TILL keine Auszüge ab.');
    // Critic R2-1: true for every install (app/ ships MIT), no launcher or Keychain of one machine.
    expect(c).toHaveTextContent('Starte TILL mit der Passphrase der Schlüsselablage neu. Von selbst versucht TILL es nicht erneut.');
    expect(c.textContent ?? '').not.toMatch(/Launcher|Schlüsselbund|Nächster Versuch|Nächster automatischer Abruf/);
  });

  it('KEYSTORE LOCKED at the last automatic run, unlocked since: no stale lock message', async () => {
    band(tile({ channels: [channel({ lastSyncAt: '2026-09-27T05:01:00.000Z', autoSync: { ...AUTO, lastAuto: { ...LAST_AUTO, ok: false, code: 'keystore_locked', detail: null } } })] }));
    const c = await card('ZKB aktiv');
    expect(c).toHaveTextContent('Abgerufen gestern 07:01');
    expect(c).not.toHaveTextContent(/Schlüsselablage/);
  });

  it('CHANGED BANK KEYS: a warn dot, the reason, and the compare as the one action', async () => {
    band(tile({ channels: [channel({ state: 'bank_keys_changed' })] }));
    const m = await mark('ZKB: Bankschlüssel geändert');
    expect(m.tone).toBe('warn');
    const c = await card('ZKB: Bankschlüssel geändert');
    expect(c).toHaveTextContent('Die Bankschlüssel haben sich geändert.');
    expect(within(c).getByRole('link', { name: 'Schlüssel vergleichen' })).toHaveAttribute('href', '/bank-accounts');
    expect(screen.queryByRole('button', { name: 'Jetzt abrufen' })).not.toBeInTheDocument();
  });

  it('BLOCKED: a danger dot, said in words, with the way to the bank accounts', async () => {
    band(tile({ channels: [channel({ state: 'blocked' })] }));
    expect((await mark('ZKB: Abruf gesperrt')).tone).toBe('danger');
    const c = await card('ZKB: Abruf gesperrt');
    expect(within(c).getByRole('link', { name: 'Zu den Bankkonten' })).toHaveAttribute('href', '/bank-accounts');
  });

  it('NUMBER JUMP: a warn dot, the missing numbers in words, with a door to that account', async () => {
    const jump = { after: { number: 1, year: 2026 }, statement: { number: 3, year: 2026 }, skipped: [{ year: 2026, from: 2, to: 2 }] };
    band(tile({ channels: [channel({ numberJumps: [{ bankAccountId: 'ba_chf', jump }] })] }));
    expect((await mark('ZKB: Auszüge fehlen')).tone).toBe('warn');
    const c = await card('ZKB: Auszüge fehlen');
    expect(c).toHaveTextContent(/Nach Auszug 1 kam Auszug 3\. Fehlende Nummern: 2\/2026/);
    expect(within(c).getByRole('link', { name: 'Zu Seeblick Geschäftskonto' })).toHaveAttribute('href', '/bank?account=ba_chf');
  });

  it('NO CHANNEL: the counts alone, no mark and no button', async () => {
    const { container } = band(tile({ channels: [] }));
    await screen.findByRole('link', { name: '12 offene Bankbuchungen' });
    expect(container.querySelector('.bank-mark')).toBeNull();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('AUTOMATIC FETCH OFF: a faint dot, said in words, with the way to switch it on', async () => {
    band(tile({ channels: [channel({ autoSync: { ...AUTO, mode: 'off', nextAt: null } })] }));
    expect((await mark('ZKB: Automatik aus')).tone).toBe('off');
    const c = await card('ZKB: Automatik aus');
    expect(c).toHaveTextContent('Der automatische Abruf ist aus.');
    expect(within(c).getByRole('link', { name: 'Einstellen' })).toHaveAttribute('href', '/bank-accounts');
  });

  it('TILL SERVE: no scheduler in this process, so nothing fetches by itself; a faint dot and the card says so', async () => {
    band(tile({ autoAvailable: false }));
    expect((await mark('ZKB: kein automatischer Abruf')).tone).toBe('off');
    const c = await card('ZKB: kein automatischer Abruf');
    expect(c).toHaveTextContent('Automatisch abrufen kann TILL nur mit till up.');
    expect(c).not.toHaveTextContent(/Nächster automatischer Abruf/);
  });

  it('NOTHING OPEN: "Nichts wartet auf dich" alone, no count, and every facet is dimmed', async () => {
    band(tile({ open: 0, needs: 0, sure: 0, noReceipt: 0 }));
    expect(await screen.findByText('Nichts wartet auf dich')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /offene Bankbuchung/ })).toBeNull();
    expect(document.querySelectorAll('.bank-band__facet.is-zero')).toHaveLength(2);
  });

  it('STATEMENT GAP (D150): a warn dot, the gap with its explanation in words, and "Lücke schliessen" opens the repair', async () => {
    const gap = {
      gapId: 'bst_182:bst_187',
      bankAccountId: 'ba_chf',
      source: 'book',
      after: { statementRowId: 'bst_182', documentId: null, number: 182, year: 2026, fromDate: '2026-09-22', toDate: '2026-09-22' },
      before: { statementRowId: 'bst_187', documentId: null, number: 187, year: 2026, fromDate: '2026-09-29', toDate: '2026-09-29' },
      missing: [{ year: 2026, from: 183, to: 186 }],
      oldYearTailUnknown: false,
      missingDates: { from: '2026-09-23', to: '2026-09-28' },
      chains: true,
      differenceMinor: 0,
      currency: 'CHF',
      refused: [],
      confirmable: true,
    };
    band(tile({ channels: [channel({ statementGaps: [gap], numberJumps: [] })] }));
    expect((await mark('ZKB: Auszüge fehlen')).tone).toBe('warn');
    const c = await card('ZKB: Auszüge fehlen');
    expect(c).toHaveTextContent('Seeblick Geschäftskonto: Auszüge 183–186 fehlen (23.09.2026 bis 28.09.2026)');
    // A chained gap misses no money, so the band says only which statements (owner, 18.10.2026: less text).
    expect(c).not.toHaveTextContent('Der Saldo von Auszug 182');
    const repair = within(c).getByRole('link', { name: 'Lücke schliessen' });
    expect(repair).toHaveAttribute('href', '/bank-accounts?repair=ba_chf&gap=bst_182%3Abst_187');
  });

  it('EMPTY: no Bankkonto yet names what is missing and offers the one door', async () => {
    band(tile({ accounts: [], open: 0, needs: 0, sure: 0, noReceipt: 0, channels: [] }));
    expect(await screen.findByRole('heading', { name: 'Noch kein Bankkonto.' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Bankkonto erfassen' })).toHaveAttribute('href', '/bank-accounts');
  });

  it('ERROR: a failed read is a muted line with a retry, never a fake zero', async () => {
    renderBand(transportFor({ dashboard_tile: refuse('store_busy') }));
    expect(await screen.findByText('Der Bankeingang konnte nicht geladen werden.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeInTheDocument();
  });

  it('PERMISSION DENIED: a role that may not see the bank lines is shown nothing here', async () => {
    const seen: string[] = [];
    const { container } = renderBand(
      transportFor({
        dashboard_tile: () => {
          seen.push('tile');
          return refuse('permission_denied', { capability: 'read_sales' });
        },
      }),
    );
    await waitFor(() => expect(seen).toHaveLength(1));
    await waitFor(() => expect(container.querySelector('.bank-band')).toBeNull());
  });

  it('JETZT ABRUFEN: one bank_sync per active connection, a fresh key, then the band re-reads and announces what came', async () => {
    const syncs: Record<string, unknown>[] = [];
    let reads = 0;
    renderBand(
      transportFor({
        dashboard_tile: () => {
          reads += 1;
          return ok({ tile: tile() });
        },
        bank_sync: (input) => {
          syncs.push(input);
          return ok({ connectionId: 'ebc_1', download: { outcome: 'no_data' }, statements: [], pendingStatements: 0, lastSyncAt: NOW.toISOString() });
        },
      }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Jetzt abrufen' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Die ZKB hat keine neuen Auszüge.');
    expect(syncs).toHaveLength(1);
    expect(syncs[0]).toMatchObject({ workspaceId: 'ws_test', connectionId: 'ebc_1' });
    expect(String(syncs[0]?.idempotencyKey)).toMatch(/^a36-press-ebc_1-/);
    expect(reads).toBe(2);
  });

  it('JETZT ABRUFEN while another fetch runs: the refusal in words on the mark and announced, never a silent join', async () => {
    // LOADING-PROOF-EXEMPT: the role=status here is the fetch RESULT live region, not a loading affordance; the refusal it asserts can only exist after dashboard_tile and bank_sync really answered.
    renderBand(
      transportFor({
        dashboard_tile: ok({ tile: tile() }),
        bank_sync: refuse('sync_in_progress', { connectionId: 'ebc_1', syncStartedAt: '2026-09-28T07:25:00.000Z', freesAt: '2026-09-28T07:40:00.000Z', retryable: true }),
      }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Jetzt abrufen' }));
    // Critic F2 (D142): what is known, in Swiss time, and no promise of an answer that may never come.
    const sentence = 'Für diese Verbindung ist seit 09:25 ein Abruf als laufend markiert. Läuft keiner mehr, gibt TILL die Markierung um 09:40 frei.';
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(sentence));
    const c = await card('ZKB: Abruf gestört');
    expect(c).toHaveTextContent(sentence);
  });

  it('is accessible (axe), closed and with the card open', async () => {
    const { container } = band(tile({ channels: [READY] }));
    await screen.findByRole('link', { name: '12 offene Bankbuchungen' });
    expect(await axe(container)).toHaveNoViolations();
    await card('ZKB: Schlüssel prüfen');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('whenText', () => {
  const t = (key: string, p: Record<string, string | number> = {}) => `${key}|${Object.values(p).join('|')}`;
  it('names today, yesterday and tomorrow in Swiss time, and a date otherwise', () => {
    const now = Date.parse('2026-09-28T07:30:00.000Z');
    expect(whenText(t, '2026-09-28T05:02:00.000Z', now)).toBe('dashboard.bankBand.when.today|07:02');
    expect(whenText(t, '2026-09-27T21:59:00.000Z', now)).toBe('dashboard.bankBand.when.yesterday|23:59');
    expect(whenText(t, '2026-09-29T05:00:00.000Z', now)).toBe('dashboard.bankBand.when.tomorrow|07:00');
    expect(whenText(t, '2026-09-20T05:00:00.000Z', now)).toBe('dashboard.bankBand.when.date|20.09.2026|07:00');
  });
});
