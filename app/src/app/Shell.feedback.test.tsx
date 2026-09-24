/**
 * G08 §2 US-G08.2, the shell rail's feedback entry.
 *
 * A separate file from `Shell.test.tsx` on purpose: that suite renders the shell with NO feedback
 * provider and its eleven assertions are the proof that the rail is unchanged for every tree that
 * does not mount one. This file covers the tree that does.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { axe } from 'jest-axe';

import { I18nProvider } from '../i18n';
import { TillClientProvider } from '../lib/client-context';
import { TillClient, type Transport } from '../lib/client';
import { FeedbackProvider } from '../components/FeedbackProvider';
import { ThemeProvider, type Theme } from './theme';
import { DensityProvider } from './density';
import { WorkspaceProvider } from './workspace';
import { Shell } from './Shell';

const idleTransport: Transport = async () => ({ status: 200, body: { ok: true, workspaces: [] } });

/** F-02: the shell's WorkspaceResolver reads `list_workspaces` once per load; settle that one async
 *  read (an empty ledger here, so nothing is adopted) before a test asserts. */
async function renderShell(theme: Theme = 'light') {
  const rendered = render(
    <ThemeProvider initialTheme={theme}>
      <DensityProvider initialDensity="komfortabel">
      <TillClientProvider client={new TillClient(idleTransport)}>
        <I18nProvider>
          <WorkspaceProvider initialId={null}>
            <FeedbackProvider previewDebounceMs={1_000_000} openMailto={vi.fn()}>
              <MemoryRouter initialEntries={['/setup']}>
                <Routes>
                  <Route element={<Shell />}>
                    <Route path="/setup" element={<p>Einrichtung</p>} />
                  </Route>
                </Routes>
              </MemoryRouter>
            </FeedbackProvider>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>
      </DensityProvider>
    </ThemeProvider>,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return rendered;
}

describe('Shell rail footer, the feedback entry', () => {
  it('sits in the rail footer beside the theme toggle, reachable from every screen', async () => {
    await renderShell();
    const rail = screen.getByRole('navigation');
    expect(within(rail).getByRole('button', { name: 'Rückmeldung senden' })).toBeInTheDocument();
  });

  it('is a quiet icon control in the one footer row and NEVER spends the accent (K-01)', async () => {
    await renderShell();
    const entry = screen.getByRole('button', { name: 'Rückmeldung senden' });
    // An icon button with its name as the accessible label: the footer is one row since K-01.
    expect(entry).toHaveClass('rail-icon-btn');
    expect(entry.closest('.rail-footer')).not.toBeNull();
    // The accent belongs to the dialog's one primary action. An accent here would spend it on
    // every screen at once, because the rail is on every screen.
    expect(entry).not.toHaveClass('btn--primary', 'btn--accent');
  });

  it('opens the same dialog, on kind=idea, with no error context', async () => {
    await renderShell();
    await userEvent.click(screen.getByRole('button', { name: 'Rückmeldung senden' }));
    await screen.findByRole('dialog');
    expect(screen.getByRole('radio', { name: 'Eine Idee' })).toBeChecked();
    expect(screen.getByText('Nichts zum Mitsenden.')).toBeInTheDocument();
  });

  it('returns focus to the rail entry when the dialog closes', async () => {
    await renderShell();
    const entry = screen.getByRole('button', { name: 'Rückmeldung senden' });
    await userEvent.click(entry);
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    expect(entry).toHaveFocus();
  });

  it.each(['light', 'dark'] as const)('has no axe violations with the entry present, %s theme', async (theme) => {
    const { container } = await renderShell(theme);
    expect(await axe(container)).toHaveNoViolations();
  });
});
