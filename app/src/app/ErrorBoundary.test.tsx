/**
 * G08 §8, the component gate for the crash boundary.
 *
 * The two assertions that matter are the ones a screenshot cannot make: that the report path works
 * with the transport dead, asserted on the PAYLOAD rather than on the presence of a button, and
 * that `error.message` never reaches that payload. The second one uses a deliberate offender, in
 * the spirit of the engine's leak test: the thrown message carries a counterparty name and an
 * amount, and none of it may survive.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

import { I18nProvider } from '../i18n';
import { ThemeProvider, type Theme } from './theme';
import { WorkspaceProvider } from './workspace';
import { TillClientProvider } from '../lib/client-context';
import { TillClient, type Transport } from '../lib/client';
import { FeedbackProvider } from '../components/FeedbackProvider';
import { allowConsole } from '../test-console';
import { ErrorBoundary, diagnosticFor } from './ErrorBoundary';

/**
 * React and jsdom both shout about every caught render error, and in a suite whose whole subject is
 * caught render errors that shout is expected rather than tolerated. The patterns are narrow on
 * purpose: anything the components themselves log (a missing translation, an act(...) escape) is
 * still a failure.
 */
function allowReactBoundaryNoise() {
  allowConsole(/An error occurred in the <Boom> component|The above error occurred/);
  allowConsole(/Uncaught \[/);
}

const clipboard: string[] = [];

beforeEach(() => {
  clipboard.length = 0;
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      writeText: async (text: string) => {
        clipboard.push(text);
      },
    },
    configurable: true,
    writable: true,
  });
});

function Boom({ throwValue }: { throwValue: unknown }): never {
  throw throwValue;
}

function renderBoundary(
  throwValue: unknown,
  { theme = 'light' as Theme, openMailto = () => {}, transport }: {
    theme?: Theme;
    openMailto?: (uri: string) => void;
    transport?: Transport;
  } = {},
) {
  const dead: Transport = transport ?? (async () => ({ status: 0, body: { ok: false, error: 'transport_error' } }));
  return render(
    <ThemeProvider initialTheme={theme}>
      <TillClientProvider client={new TillClient(dead)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <FeedbackProvider previewDebounceMs={1_000_000} openMailto={openMailto}>
              <ErrorBoundary surface="/documents/:id">
                <Boom throwValue={throwValue} />
              </ErrorBoundary>
            </FeedbackProvider>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>
    </ThemeProvider>,
  );
}

describe('ErrorBoundary', () => {
  it('renders a recoverable panel instead of blanking the document', () => {
    allowReactBoundaryNoise();
    renderBoundary(new Error('boom'));
    expect(screen.getByRole('heading', { name: 'Dieser Bildschirm funktioniert nicht mehr' })).toBeInTheDocument();
    expect(screen.getByText('Neu laden ist unbedenklich. TILL speichert nur, wenn du eine Aktion bestätigst.')).toBeInTheDocument();
    // Two ways out, so the worst failure in the product is still a recoverable one.
    expect(screen.getByRole('button', { name: 'Neu laden' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Diesen Fehler melden' })).toBeInTheDocument();
  });

  it('renders its children untouched when nothing throws', () => {
    render(
      <I18nProvider>
        <ErrorBoundary>
          <p>alles gut</p>
        </ErrorBoundary>
      </I18nProvider>,
    );
    expect(screen.getByText('alles gut')).toBeInTheDocument();
  });

  it('produces a working mailto and clipboard payload with the transport dead', async () => {
    // LOADING-PROOF-EXEMPT: the only role="status" on this path is the "Bericht kopiert"
    // confirmation, which carries no aria-busy and is not a skeleton. The crash path never
    // consults the engine at all, which this block asserts, so there is no request to prove.
    allowReactBoundaryNoise();
    const openMailto = vi.fn();
    const transport = vi.fn<Transport>(async () => ({
      status: 0,
      body: { ok: false, error: 'transport_error' },
    }));
    renderBoundary(new TypeError('cannot read x of undefined'), { openMailto, transport });

    await userEvent.click(screen.getByRole('button', { name: 'Diesen Fehler melden' }));
    await userEvent.type(
      screen.getByLabelText('Was ist passiert, und was hast du erwartet?'),
      'Der Bildschirm ist weiss geworden.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Im Mail-Programm öffnen' }));

    // Asserted on the payload, not on the presence of a button.
    const uri = openMailto.mock.calls[0]?.[0] as string;
    expect(uri.startsWith('mailto:hello@tillbooks.ch?subject=')).toBe(true);
    expect(decodeURIComponent(uri)).toContain('Der Bildschirm ist weiss geworden.');

    await userEvent.click(await screen.findByRole('button', { name: 'Bericht kopieren' }));
    await screen.findByRole('status');
    const report = clipboard[0] as string;
    expect(report).toContain('Der Bildschirm ist weiss geworden.');
    expect(report).toContain('TypeError');

    // And it never asked the engine, which is the whole point of the path.
    expect(transport).not.toHaveBeenCalled();
    expect(screen.getByText(/TILL konnte den eigenen Hintergrunddienst nicht erreichen/)).toBeInTheDocument();
  });

  it.each(['light', 'dark'] as const)('has no axe violations in the %s theme', async (theme) => {
    allowReactBoundaryNoise();
    const { container } = renderBoundary(new Error('boom'), { theme });
    expect(await axe(container, { rules: { region: { enabled: false } } })).toHaveNoViolations();
  });
});

describe('ErrorBoundary redaction (§4)', () => {
  /**
   * The deliberate offender. `guarded()` attaches `message: e.message` to every `unexpected_error`,
   * and an exception raised inside a posting path can carry an amount, a counterparty name and an
   * IBAN in that one string. None of it may reach the report.
   */
  const LEAKY = new Error('Beratung Müller AG 1234.55 CH9300762011623852957');

  it('drops error.message entirely and keeps only the name', () => {
    const entry = diagnosticFor(LEAKY, '/documents/:id', '2026-07-25T09:00:00.000Z');
    const serialised = JSON.stringify(entry);
    expect(entry.name).toBe('Error');
    expect(serialised).not.toContain('Müller');
    expect(serialised).not.toContain('Beratung');
    expect(serialised).not.toContain('1234.55');
    expect(serialised).not.toContain('CH9300762011623852957');
  });

  it('keeps no absolute path, so the OS username can never travel', () => {
    const entry = diagnosticFor(LEAKY, '/documents/:id', '2026-07-25T09:00:00.000Z');
    // Every frame in a jsdom stack is outside the page origin, so all of them collapse.
    for (const frame of entry.frames) expect(frame).toBe('<external>');
    expect(JSON.stringify(entry)).not.toContain('/Users/');
  });

  it('records <non-error> for a thrown string rather than undefined', () => {
    const entry = diagnosticFor('just a string', undefined, '2026-07-25T09:00:00.000Z');
    expect(entry.name).toBe('<non-error>');
  });

  it('records <non-error> for a thrown plain object too', () => {
    const entry = diagnosticFor({ kunde: 'Müller AG' }, undefined, '2026-07-25T09:00:00.000Z');
    expect(entry.name).toBe('<non-error>');
    expect(JSON.stringify(entry)).not.toContain('Müller');
  });

  it('passes the route PATTERN through, never a concrete id', () => {
    const entry = diagnosticFor(LEAKY, '/documents/doc_8f3a91bc22', '2026-07-25T09:00:00.000Z');
    expect(entry.surface).toBe('/documents/:id');
  });

  it('never reaches the screen with the thrown message on it', async () => {
    allowReactBoundaryNoise();
    renderBoundary(LEAKY);
    await userEvent.click(screen.getByRole('button', { name: 'Diesen Fehler melden' }));
    expect(document.body.textContent ?? '').not.toContain('Müller');
    expect(document.body.textContent ?? '').not.toContain('1234.55');
  });
});
