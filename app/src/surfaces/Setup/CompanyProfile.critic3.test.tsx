/**
 * CRITIC PROBES, round 3 on claude/cl-setup 6b7a68ca. Not for landing.
 * Header truth and payload shape when a cleared UID or MWST-Nr meets other identity edits.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { recordedOk } from '../../lib/test-support';
import { CompanyProfile } from './CompanyProfile';
import workspacesFixture from './workspaces.fixture.json';

const STORED = {
  workspaceId: 'ws_test', name: 'Mara Design GmbH', legalForm: 'gmbh', baseCurrency: 'CHF', fiscalYearStart: '01-01',
  vatMethod: 'effektiv', vatAccounting: 'soll', creditorName: null, creditorAddress: null, creditorIban: null,
  uid: 'CHE-123.456.789', mwstNo: 'CHE-123.456.789 MWST', createdAt: '2026-10-01T10:00:00.000Z', ledgerLocked: false,
};

/** The real `updateCompanyProfile` rules: an omitted key keeps the stored value, a bad shape refuses the whole verb. */
function engine() {
  const writes: { verb: string; input: Record<string, unknown> }[] = [];
  const state: Record<string, unknown> = { ...STORED };
  const transport: Transport = async (action, input) => {
    const i = input as Record<string, unknown>;
    if (action === 'list_workspaces') return { status: 200, body: recordedOk(workspacesFixture) };
    if (action === 'get_company_profile') return { status: 200, body: recordedOk({ ok: true, profile: { ...state } }) };
    if (action === 'get_ebill_config') return { status: 200, body: recordedOk({ ok: true, config: null }) };
    if (action === 'whoami') return { status: 404, body: { ok: false, error: 'unknown_action' } };
    writes.push({ verb: action, input: i });
    if (action === 'update_company_profile') {
      if (i.uid !== undefined && !/^CHE-\d{3}\.\d{3}\.\d{3}$/.test(String(i.uid))) return { status: 422, body: { ok: false, error: 'invalid_uid' } } as RestResponse;
      if (i.mwstNo !== undefined && !/^CHE-\d{3}\.\d{3}\.\d{3} MWST$/.test(String(i.mwstNo))) return { status: 422, body: { ok: false, error: 'invalid_mwst_no' } } as RestResponse;
      for (const k of ['name', 'legalForm', 'uid', 'mwstNo']) if (i[k] !== undefined) state[k] = i[k];
    }
    return { status: 200, body: { ok: true } } as RestResponse;
  };
  return { client: new TillClient(transport), writes, state };
}

function mount(client: TillClient) {
  render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter initialEntries={['/setup']}>
            <CompanyProfile />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}
const header = () => document.querySelector('.surface-header-actions') as HTMLElement;
const save = () => screen.getByRole('button', { name: 'Speichern' });
async function openMore(): Promise<HTMLElement> {
  const p = (await screen.findByRole('region', { name: 'Firmenangaben' })) as HTMLElement;
  await userEvent.click(within(p).getByRole('button', { name: 'Weitere Angaben' }));
  return p;
}
async function settled() {
  const panel = (await screen.findByRole('region', { name: 'Arbeitsbereiche' })) as HTMLElement;
  await within(panel).findAllByRole('listitem');
}

describe('critic round 3: a cleared UID beside other identity edits', () => {
  it('UID cleared, MWST-Nr changed to a valid value: the payload carries mwstNo and no uid key; the stored UID survives', async () => {
    const e = engine();
    mount(e.client);
    const p = await openMore();
    await userEvent.clear(within(p).getByLabelText('UID'));
    const m = within(p).getByLabelText('MWST-Nummer');
    await userEvent.clear(m);
    await userEvent.paste('CHE-987.654.321 MWST');
    await userEvent.click(save());
    expect(await within(header()).findByText('Nicht gespeichert: UID')).toBeInTheDocument();
    expect(e.writes).toEqual([
      { verb: 'update_company_profile', input: { workspaceId: 'ws_test', name: 'Mara Design GmbH', legalForm: 'gmbh', mwstNo: 'CHE-987.654.321 MWST' } },
    ]);
    expect(e.state.uid).toBe('CHE-123.456.789');
    expect(e.state.mwstNo).toBe('CHE-987.654.321 MWST');
    // The MWST-Nr landed and is clean; the UID alone stays dirty, and a retry writes nothing.
    await userEvent.click(save());
    expect(await within(header()).findByText('Nicht gespeichert: UID')).toBeInTheDocument();
    expect(e.writes).toHaveLength(1);
    await settled();
  });

  it('UID cleared and the identity verb refused (a malformed MWST-Nr): the header names BOTH, nothing lands', async () => {
    const e = engine();
    mount(e.client);
    const p = await openMore();
    await userEvent.clear(within(p).getByLabelText('UID'));
    const m = within(p).getByLabelText('MWST-Nummer');
    await userEvent.clear(m);
    await userEvent.paste('CHE-1 MWST');
    await userEvent.click(save());
    expect(await within(header()).findByText('Nicht gespeichert: UID, Firmenangaben')).toBeInTheDocument();
    expect(e.writes.map((w) => w.verb)).toEqual(['update_company_profile']);
    expect(e.writes[0]?.input).not.toHaveProperty('uid');
    expect(e.state.uid).toBe('CHE-123.456.789');
    expect(e.state.mwstNo).toBe('CHE-123.456.789 MWST');
    expect(within(p).getByLabelText('UID')).toHaveAccessibleDescription(/Die UID lässt sich hier nicht entfernen/);
    expect(within(p).getByLabelText('MWST-Nummer')).toHaveAttribute('aria-invalid', 'true');
    await settled();
  });

  it('both cleared plus a rename: the rename lands without either key, the header names UID and MWST-Nummer only', async () => {
    const e = engine();
    mount(e.client);
    const p = await openMore();
    await userEvent.clear(within(p).getByLabelText('UID'));
    await userEvent.clear(within(p).getByLabelText('MWST-Nummer'));
    const n = within(p).getByLabelText('Firmenname');
    await userEvent.clear(n);
    await userEvent.paste('Mara Studio GmbH');
    await userEvent.click(save());
    expect(await within(header()).findByText('Nicht gespeichert: UID, MWST-Nummer')).toBeInTheDocument();
    expect(e.writes).toEqual([{ verb: 'update_company_profile', input: { workspaceId: 'ws_test', name: 'Mara Studio GmbH', legalForm: 'gmbh' } }]);
    expect(e.state).toEqual(expect.objectContaining({ name: 'Mara Studio GmbH', uid: 'CHE-123.456.789', mwstNo: 'CHE-123.456.789 MWST' }));
    // Both cleared fields stay dirty after the rename landed: the retry names both again and writes nothing.
    await userEvent.click(save());
    expect(await within(header()).findByText('Nicht gespeichert: UID, MWST-Nummer')).toBeInTheDocument();
    expect(e.writes).toHaveLength(1);
    await settled();
  });
});
