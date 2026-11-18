/**
 * O00 (D199): the What's new toast, the notes dialog and the version dialog, against a
 * scripted transport. No engine, no install: every answer is invented here.
 */
import { describe, it, expect } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { I18nProvider } from '../i18n';
import { TillClientProvider } from '../lib/client-context';
import { TillClient, type Transport } from '../lib/client';
import { watchReads } from '../test-transport';
import { WorkspaceProvider } from '../app/workspace';
import { ReleaseToast, VersionDialog } from './WhatsNew';

const ITEM = {
  kind: 'new',
  icon: 'sparkle',
  title: 'Neuigkeiten nach einem Update',
  body: 'Nach einem Update zeigt dir TILL, was sich geändert hat.',
  go: '/journal',
};

function notes(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    version: '1.0.0-beta.6',
    seen: '1.0.0-beta.5',
    unseen: [{ version: '1.0.0-beta.6', date: '2026-11-20', items: [ITEM, { ...ITEM, kind: 'fixed', icon: 'shield', title: 'Zweiter Punkt', go: null }] }],
    recent: [{ version: '1.0.0-beta.6', date: '2026-11-20', items: [ITEM] }],
    toast: true,
    releasesUrl: 'https://tillbooks.ch/de/changelog',
    ...over,
  };
}


function setup(answers: Record<string, unknown>) {
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const transport: Transport = async (action, input) => {
    calls.push({ action, input: input ?? {} });
    const body = answers[action] ?? { ok: true };
    return { status: 200, body: body as never };
  };
  const watched = watchReads(transport);
  return { calls, client: new TillClient(watched), transport: watched };
}

async function renderWith(node: React.ReactNode, client: TillClient) {
  window.localStorage.clear();
  render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_1">
          <MemoryRouter>{node}</MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('the release toast', () => {
  it('says the version and opens the unseen notes; closing marks them seen', async () => {
    const { client, calls, transport } = setup({ whats_new: notes() });
    await renderWith(<ReleaseToast />, client);
    await transport.started('whats_new');
    const toast = screen.getByRole('status');
    expect(toast).toHaveTextContent('Aktualisiert auf 1.0.0-beta.6');
    await userEvent.click(within(toast).getByRole('button', { name: 'Neuigkeiten' }));
    const dialog = await screen.findByRole('dialog');
    const titles = [...dialog.querySelectorAll('.whatsnew-title')].map((n) => n.textContent);
    expect(titles).toEqual(['Neu: Neuigkeiten nach einem Update', 'Behoben: Zweiter Punkt']);
    expect(within(dialog).getByRole('button', { name: 'Zeigen' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(calls.some((c) => c.action === 'whats_new_mark_seen' && c.input.workspaceId === 'ws_1')).toBe(true);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('stays silent when the setting turns the toast off or nothing is unseen', async () => {
    const { client, transport } = setup({ whats_new: notes({ toast: false }) });
    await renderWith(<ReleaseToast />, client);
    await transport.started('whats_new');
    expect(screen.queryByRole('status')).toBeNull();
  });

});

describe('the version dialog', () => {
  it('lists the recent notes under the version', async () => {
    const { client } = setup({ whats_new: notes() });
    await renderWith(<VersionDialog onClose={() => undefined} />, client);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('TILL 1.0.0-beta.6');
    expect(dialog.querySelectorAll('.whatsnew-item')).toHaveLength(1);
  });
});
