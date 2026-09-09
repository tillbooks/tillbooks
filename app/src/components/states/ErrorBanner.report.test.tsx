/**
 * G08 §6 and §8, the "Report this error" predicate on `ErrorBanner`.
 *
 * The predicate reads `DEFECT_SHAPED_CODES` from `src/core/support/redact.ts`, the same constant the
 * engine's journal filter reads, so the two faces cannot drift on what counts as a defect. These
 * assertions exist to keep that true: a code added to the engine's list and not reaching the banner
 * would otherwise be silent.
 *
 * The banner's 19 existing call sites are covered by `states.test.tsx`, which renders it with NO
 * feedback provider. That file is deliberately untouched: it is the regression proof that reading
 * the context instead of taking an `onReport` prop cost those call sites nothing.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type Transport } from '../../lib/client';
import { allowConsole } from '../../test-console';
import { FeedbackProvider } from '../FeedbackProvider';
import { ErrorBanner } from './ErrorBanner';
import { DEFECT_SHAPED_CODES } from '../../../../src/core/support/redact.js';

const idleTransport: Transport = async () => ({ status: 200, body: { ok: true } });

function withProviders(children: ReactNode) {
  return (
    <TillClientProvider client={new TillClient(idleTransport)}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <FeedbackProvider previewDebounceMs={1_000_000} openMailto={vi.fn()}>
            {children}
          </FeedbackProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

function renderBanner(code: string) {
  return render(withProviders(<ErrorBanner error={{ ok: false, error: code }} />));
}

describe('ErrorBanner, the Report this error offer', () => {
  it.each([...DEFECT_SHAPED_CODES])('offers the report for the defect-shaped code %s', (code) => {
    renderBanner(code);
    expect(screen.getByRole('button', { name: 'Diesen Fehler melden' })).toBeInTheDocument();
  });

  it('offers it for an unmapped code, which today has no way out at all', () => {
    allowConsole(/missing translation for "errors\.some_brand_new_code"/);
    renderBanner('some_brand_new_code');
    expect(screen.getByRole('button', { name: 'Diesen Fehler melden' })).toBeInTheDocument();
  });

  it.each(['invalid_input', 'permission_denied', 'workspace_not_found', 'forbidden'])(
    'does NOT offer it for %s, which is the system working correctly',
    (code) => {
      renderBanner(code);
      expect(screen.queryByRole('button', { name: 'Diesen Fehler melden' })).toBeNull();
    },
  );

  it('renders nothing extra when no feedback provider is mounted, so the 19 call sites are untouched', () => {
    render(
      <I18nProvider>
        <ErrorBanner error={{ ok: false, error: 'unexpected_error' }} />
      </I18nProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Diesen Fehler melden' })).toBeNull();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('opens the dialog on kind=bug and carries the failing code, never free text', async () => {
    render(
      withProviders(
        <ErrorBanner
          error={{ ok: false, error: 'unexpected_error', message: 'Beratung Müller AG 1234.55' }}
        />,
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Diesen Fehler melden' }));
    const dialog = await screen.findByRole('dialog');
    expect(screen.getByRole('radio', { name: 'Etwas funktioniert nicht' })).toBeChecked();
    // The `Err` carried a message with a counterparty name in it; none of it reaches the dialog.
    expect(dialog.textContent ?? '').not.toContain('Müller');
    expect(dialog.textContent ?? '').not.toContain('1234.55');
  });

  it('stays a quiet link and never spends the accent', () => {
    renderBanner('unexpected_error');
    const report = screen.getByRole('button', { name: 'Diesen Fehler melden' });
    expect(report).toHaveClass('error-report');
    expect(report).not.toHaveClass('btn--primary', 'btn--accent');
  });
});
