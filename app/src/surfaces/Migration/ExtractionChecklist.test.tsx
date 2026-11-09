/**
 * The G19 extraction checklist. The claims worth the most:
 *
 *   THE EMPTY STATE OFFERS TO CREATE THE EXPORT LIST, never a blank screen: a plan with no manifest
 *   yet must reach "Exportliste anlegen", or the first mile of a migration has no entry point.
 *
 *   A GATED RUNG (3/4) RENDERS THE GATE NOTE, never a working companion control: the browser
 *   companion is proposed and gated, so the item reads "vorgesehen, noch nicht verfügbar".
 *
 *   THE DELETION CLOCK IS TEXT PLUS DAYS, and spends colour only when it is the problem.
 *
 * Copy is asserted through the catalogue (`messages.de-CH.json`), never as a literal typed here.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { ExtractionChecklist } from './ExtractionChecklist';
import de from './messages.de-CH.json';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function fakeTransport(canned: Record<string, RestResponse>): Transport {
  return async (action) => canned[action] ?? { status: 404, body: { ok: false, error: 'unknown_action' } };
}

const GUIDE = {
  sourceSystem: 'bexio',
  label: 'bexio',
  items: [
    { id: 'contacts', what: 'Kontakte', sourceArea: 'Kontakte -> Export', formats: ['CSV'], rung: 1, rungGated: false, quirks: [], statutory: false },
    { id: 'belege', what: 'Belege', sourceArea: 'Pro Dokument', formats: ['PDF'], rung: 3, rungGated: true, quirks: [], statutory: true },
  ],
  letterTemplate: {
    'de-CH': { subject: 'Herausgabe', body: ['Sehr geehrte Damen und Herren'], limitsParagraph: 'Art. 28 revDSG deckt Personendaten ab.' },
  },
};

function tree(canned: Record<string, RestResponse>, canManageImport = true) {
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider>
        <ExtractionChecklist workspaceId="ws_1" planId="migplan_1" sourceSystem="bexio" canManageImport={canManageImport} />
      </I18nProvider>
    </TillClientProvider>
  );
}

describe('ExtractionChecklist', () => {
  it('offers to create the export list when no manifest exists yet', async () => {
    render(
      tree({
        migration_get_extraction_guide: ok({ guide: GUIDE, fellBack: false }),
        migration_get_manifest: ok({ manifest: null, items: [], completeness: null, deadline: null }),
      }),
    );
    expect(await screen.findByText(de.migration.extraction.create)).toBeTruthy();
    expect(screen.getByText(de.migration.extraction.empty)).toBeTruthy();
  });

  it('renders items with the deletion clock, and shows the gate note on a gated rung', async () => {
    render(
      tree({
        migration_get_extraction_guide: ok({ guide: GUIDE, fellBack: false }),
        migration_get_manifest: ok({
          manifest: { manifestId: 'm1', planId: 'migplan_1', sourceSystem: 'bexio', sourceAccessUntil: '2024-07-15' },
          items: [
            { itemId: 'contacts', status: 'exported', fileIds: ['f1'], rowCount: 42 },
            { itemId: 'belege', status: 'blocked', fileIds: [] },
          ],
          completeness: { denominator: 2, open: 0, blocked: 1, complete: false },
          deadline: { sourceAccessUntil: '2024-07-15', daysRemaining: 10 },
        }),
      }),
    );
    expect(await screen.findByText('Kontakte')).toBeTruthy();
    // The gated rung renders the gate note, not a working companion control.
    expect(screen.getByText(de.migration.extraction.rungGated)).toBeTruthy();
    // The deletion clock renders as text with the days remaining.
    expect(screen.getByText(de.migration.extraction.deadline.replace('{source}', 'bexio').replace('{n}', '10'))).toBeTruthy();
  });

  it('shows a complete manifest as one neutral line', async () => {
    render(
      tree({
        migration_get_extraction_guide: ok({ guide: GUIDE, fellBack: false }),
        migration_get_manifest: ok({
          manifest: { manifestId: 'm1', planId: 'migplan_1', sourceSystem: 'bexio', sourceAccessUntil: null },
          items: [
            { itemId: 'contacts', status: 'exported', fileIds: ['f1'] },
            { itemId: 'belege', status: 'not_used', fileIds: [] },
          ],
          completeness: { denominator: 1, open: 0, blocked: 0, complete: true },
          deadline: null,
        }),
      }),
    );
    expect(await screen.findByText(de.migration.extraction.complete)).toBeTruthy();
  });
});
