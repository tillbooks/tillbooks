/**
 * The G09 go-live readiness card. The claims worth the most:
 *
 *   AN OPEN ITEM NAMES WHO MUST MOVE IT (du / ein Agent / das System): a stuck migration is really
 *   asking whose turn it is, so the card must render the owner the engine derived, not a bare state.
 *
 *   READY IS NEVER PLAIN OVER A WAIVER: a plan clear of blockers but carrying N recorded exceptions
 *   reads "bereit, mit N Ausnahmen", so a human judgment stays visible before go-live.
 *
 * Copy is asserted through the catalogue (`messages.de-CH.json`), never as a literal typed here.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { ReadinessCard } from './ReadinessCard';
import de from './messages.de-CH.json';
import en from './messages.en.json';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function fakeTransport(canned: Record<string, RestResponse>): Transport {
  return async (action) => canned[action] ?? { status: 404, body: { ok: false, error: 'unknown_action' } };
}

function tree(canned: Record<string, RestResponse>, locale?: 'de-CH' | 'en') {
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider initialLocale={locale}>
        <ReadinessCard workspaceId="ws_1" planId="migplan_1" />
      </I18nProvider>
    </TillClientProvider>
  );
}

describe('ReadinessCard', () => {
  it('names an open blocking item and who must move it', async () => {
    render(
      tree({
        migration_readiness: ok({
          ready: false,
          readyWithWaivers: false,
          blocking: [{ item: 'backup_required', owner: 'du', reason: 'Vor der ersten Übernahme braucht es eine Sicherung' }],
          warnings: [],
          waivers: [],
          backupOnRecord: false,
        }),
      }),
    );
    expect(await screen.findByText(de.migration.readiness.item.backupRequired)).toBeTruthy();
    expect(screen.getByText(de.migration.readiness.owner.prefix.replace('{owner}', de.migration.actor.you))).toBeTruthy();
  });

  it('reads the singular headline when exactly one blocker stands (K-22)', async () => {
    render(
      tree({
        migration_readiness: ok({
          ready: false,
          readyWithWaivers: false,
          blocking: [{ item: 'backup_required', owner: 'du', reason: 'Vor der ersten Übernahme braucht es eine Sicherung' }],
          warnings: [],
          waivers: [],
          backupOnRecord: false,
        }),
      }),
    );
    // One blocker never reads "1 offene Punkte": the singular key carries the case, exactly as the
    // waiver headline one line above already does.
    expect(await screen.findByText(de.migration.readiness.blockedOne)).toBeTruthy();
  });

  it('renders a row whose engine reason IS the label only once (K-19: scope_empty)', async () => {
    render(
      tree({
        migration_readiness: ok({
          ready: false,
          readyWithWaivers: false,
          // The engine reason and the de-CH label are the identical sentence; the row must not read it twice.
          blocking: [{ item: 'scope_empty', owner: 'du', reason: de.migration.readiness.item.scopeEmpty }],
          warnings: [],
          waivers: [],
          backupOnRecord: false,
        }),
      }),
    );
    expect(await screen.findByText(de.migration.readiness.item.scopeEmpty)).toBeTruthy();
    expect(screen.getAllByText(de.migration.readiness.item.scopeEmpty)).toHaveLength(1);
  });

  it('localises the engine reason at the surface in the EN locale, never the raw German prose (K-25)', async () => {
    render(
      tree(
        {
          migration_readiness: ok({
            ready: false,
            readyWithWaivers: false,
            // A non-terminal step: the engine reason is hard-coded German ("Schritt ist mapped").
            blocking: [{ item: 'contacts', step: 'migstep_1', state: 'mapped', owner: 'ein Agent', reason: 'Schritt ist mapped' }],
            warnings: [],
            waivers: [],
            backupOnRecord: false,
          }),
        },
        'en',
      ),
    );
    // The reason renders through the EN reason-code map (state parametrised), never the raw prose.
    const expected = en.migration.readiness.reason.stepOpen.replace('{state}', en.migration.step.state.mapped);
    expect(await screen.findByText(expected)).toBeTruthy();
    expect(screen.queryByText('Schritt ist mapped')).toBeNull();
  });

  it('falls back to the raw engine prose for a reason not in the surface map (K-25)', async () => {
    render(
      tree({
        migration_readiness: ok({
          ready: false,
          readyWithWaivers: false,
          // A brand-new reason the surface map does not know yet must still be shown, never blanked.
          blocking: [{ item: 'documents', owner: 'du', reason: 'Ein ganz neuer Grund' }],
          warnings: [],
          waivers: [],
          backupOnRecord: false,
        }),
      }),
    );
    expect(await screen.findByText('Ein ganz neuer Grund')).toBeTruthy();
  });

  it('reads ready-with-exceptions when a waiver stands', async () => {
    render(
      tree({
        migration_readiness: ok({
          ready: true,
          readyWithWaivers: true,
          blocking: [],
          warnings: [],
          waivers: [{ step: 'migstep_1', control: 'ar_control', scope: 'workspace', reason: 'begründet', owner: 'du' }],
          backupOnRecord: true,
        }),
      }),
    );
    expect(await screen.findByText(de.migration.readiness.readyWithOneWaiver)).toBeTruthy();
  });
});
