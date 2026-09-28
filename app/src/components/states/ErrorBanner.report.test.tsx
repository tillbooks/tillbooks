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

  it('M3: a book newer than this TILL gets its update sentence and never the report offer', () => {
    renderBanner('schema_newer_than_runtime');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Diese Datenbank wurde von einem neueren TILL geschrieben. Aktualisiere TILL und versuche es erneut. Die Datei wurde nicht verändert.',
    );
    expect(screen.queryByRole('button', { name: 'Diesen Fehler melden' })).toBeNull();
  });

  it.each([
    ['store_busy', 'Der Ledger war belegt, nachdem TILL einen Teil dieser Aktion schon gespeichert hatte.'],
    ['unexpected_error', 'In TILL selbst ist etwas schiefgelaufen, nachdem ein Teil dieser Aktion schon gespeichert war.'],
    ['schema_newer_than_runtime', 'Bis dahin hatte dieses TILL einen Teil der Aktion gespeichert, den Rest nicht.'],
  ])('R2-4: %s raised after part of the action was saved never says nothing was changed', (code, sentence) => {
    // The engine sets `partial` when the call had already written before it failed (critic R2-4).
    render(withProviders(<ErrorBanner error={{ ok: false, error: code, partial: true }} />));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(sentence);
    expect(alert).not.toHaveTextContent(/nichts geändert|nicht verändert/);
  });

  // Critic R4-1: the engine's refusal for a call that was SAVED WHOLE, then the book moved on to a newer
  // TILL before the registry's check after the verb (probe r4-completed-then-moved.mjs item).
  const SAVED_THEN_MOVED = {
    ok: false as const, error: 'schema_newer_than_runtime', action: 'create_item', bookGeneration: 8, buildGeneration: 7,
    path: '/x/book.db', partial: true, completed: true,
    message: 'A newer TILL (generation 8) changed this book right after this call. This TILL knows generation 7. Update TILL before you use the book again.\nThis call was saved before that, but its answer may no longer match the book: /x/book.db',
  };

  it('R4-1: a call saved WHOLE before the book moved on says it is saved and not to repeat it, never "part of it"', () => {
    render(withProviders(<ErrorBanner error={SAVED_THEN_MOVED} />));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      'Diese Aktion ist gespeichert. Gleich danach hat ein neueres TILL die Datenbank aktualisiert, darum stimmt die Anzeige hier vielleicht nicht mehr. Aktualisiere TILL, bevor du weiterarbeitest. Wiederhole die Aktion nicht, sonst entsteht sie doppelt.',
    );
    expect(alert).not.toHaveTextContent(/den Rest nicht|nicht verändert|versuche es erneut/);
    expect(screen.queryByRole('button', { name: 'Diesen Fehler melden' })).toBeNull();
  });

  it('R4-1: a call saved WHOLE offers no "try again" button beside "do not repeat it"; the other refusals keep the offer', async () => {
    const onRetry = vi.fn();
    const { unmount } = render(withProviders(<ErrorBanner error={SAVED_THEN_MOVED} onRetry={onRetry} />));
    expect(screen.getByRole('alert')).toHaveTextContent('Wiederhole die Aktion nicht');
    expect(screen.queryByRole('button', { name: 'Erneut versuchen' })).toBeNull();
    unmount();
    for (const error of [{ ...SAVED_THEN_MOVED, completed: false }, { ...SAVED_THEN_MOVED, partial: false }]) {
      const { unmount: next } = render(withProviders(<ErrorBanner error={error} onRetry={onRetry} />));
      await userEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
      next();
    }
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('R5-1: a surface`s own `message` never overrides the shared sentence of a newer-book or after-save refusal', () => {
    const { unmount } = render(withProviders(<ErrorBanner error={SAVED_THEN_MOVED} message="Die Aktion konnte nicht abgeschlossen werden." />));
    expect(screen.getByRole('alert')).toHaveTextContent('Diese Aktion ist gespeichert.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('Die Aktion konnte nicht abgeschlossen werden.');
    unmount();
    // Any other refusal keeps the surface's own sentence.
    render(withProviders(<ErrorBanner error={{ ok: false, error: 'code_taken' }} message="Projektcode bereits vergeben." />));
    expect(screen.getByRole('alert')).toHaveTextContent('Projektcode bereits vergeben.');
  });

  it('R4-1: `completed` without `partial` (a read that finished) keeps the plain sentence, and `partial` alone keeps "part of it"', () => {
    const { unmount } = render(withProviders(<ErrorBanner error={{ ...SAVED_THEN_MOVED, partial: false }} />));
    expect(screen.getByRole('alert')).toHaveTextContent('Die Datei wurde nicht verändert.');
    unmount();
    render(withProviders(<ErrorBanner error={{ ...SAVED_THEN_MOVED, completed: false }} />));
    expect(screen.getByRole('alert')).toHaveTextContent('Bis dahin hatte dieses TILL einen Teil der Aktion gespeichert, den Rest nicht.');
  });

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
