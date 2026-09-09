/**
 * G08 §8, the component gate for the feedback dialog.
 *
 * The default locale is de-CH, so every assertion below is already made against the German copy,
 * which runs about 30% longer than the English. That is the point of not pinning `initialLocale`:
 * the layout and the a11y tree are gated at the longer strings by default rather than by a test
 * somebody remembers to add.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

import { I18nProvider } from '../i18n';
import { ThemeProvider, type Theme } from '../app/theme';
import { WorkspaceProvider } from '../app/workspace';
import { TillClientProvider } from '../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../lib/client';
import { FeedbackProvider, useFeedback, type FeedbackRequest } from './FeedbackProvider';
import type { DiagnosticEntry } from '../../../src/core/support/redact.js';

const OPENER = 'Rückmeldung öffnen';

/** Everything that can be focused, which is what a focus trap and Hick's law both count. */
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

const CRASH_ENTRY: DiagnosticEntry = {
  at: '2026-07-25T09:00:00.000Z',
  kind: 'unhandled_exception',
  name: 'TypeError',
  code: undefined,
  action: undefined,
  surface: '/documents/:id',
  detailKeys: [],
  frames: ['renderRow (assets/index.js:12:9)', '<external>'],
};

function ok(body: Record<string, unknown>): RestResponse {
  return { status: 200, body: { ok: true, ...body } };
}

function rejected(error: string, extra: Record<string, unknown> = {}): RestResponse {
  return { status: 422, body: { ok: false, error, ...extra } };
}

const PREPARED = ok({
  feedbackId: 'fb_abc',
  path: '/Users/test/.till/feedback/fb_abc.md',
  report: '# TILL feedback: Betreff\n\n## Error details\n\nCode: unexpected_error\n',
  mailto: 'mailto:hello@tillbooks.ch?subject=%5Bbug%5D%20Betreff&body=Was%20passiert%20ist',
  mailtoBody: 'Was passiert ist',
  truncated: false,
  diagnosticsIncluded: false,
  state: 'prepared',
});

function makeClient(routes: Record<string, RestResponse>): TillClient {
  const transport: Transport = async (action) =>
    routes[action] ?? { status: 404, body: { ok: false, error: 'unknown_action' } };
  return new TillClient(transport);
}

function Opener({ request }: { request: FeedbackRequest }) {
  const feedback = useFeedback();
  return (
    <button type="button" onClick={() => feedback?.open(request)}>
      {OPENER}
    </button>
  );
}

interface HarnessOptions {
  request?: FeedbackRequest;
  routes?: Record<string, RestResponse>;
  theme?: Theme;
  /** The default is effectively "never", so a suite that is not about the preview never races it. */
  previewDebounceMs?: number;
  openMailto?: (uri: string) => void;
}

function renderDialogHost({
  request = {},
  routes = { prepare_feedback: PREPARED },
  theme = 'light',
  previewDebounceMs = 1_000_000,
  openMailto = () => {},
}: HarnessOptions = {}) {
  return render(
    <ThemeProvider initialTheme={theme}>
      <TillClientProvider client={makeClient(routes)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <FeedbackProvider previewDebounceMs={previewDebounceMs} openMailto={openMailto}>
              <Opener request={request} />
            </FeedbackProvider>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>
    </ThemeProvider>,
  );
}

async function openDialog(options: HarnessOptions = {}) {
  const result = renderDialogHost(options);
  await userEvent.click(screen.getByRole('button', { name: OPENER }));
  return { ...result, dialog: screen.getByRole('dialog') };
}

/** Fill both required fields so the primary action is genuinely available. */
async function fillForm(subject = 'Betreff', message = 'Was passiert ist') {
  await userEvent.clear(screen.getByLabelText('Betreff'));
  await userEvent.type(screen.getByLabelText('Betreff'), subject);
  await userEvent.type(screen.getByLabelText('Was ist passiert, und was hast du erwartet?'), message);
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

describe('FeedbackDialog, the modal contract', () => {
  it('is a labelled modal dialog, which ConfirmDialog is not', async () => {
    const { dialog } = await openDialog();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Rückmeldung senden');
  });

  it('closes on Escape and returns focus to the control that opened it', async () => {
    await openDialog();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: OPENER })).toHaveFocus();
  });

  it('closes on a click outside and returns focus to the opener', async () => {
    const { dialog } = await openDialog();
    // The overlay is the click target; the panel itself stops propagation.
    await userEvent.click(dialog.parentElement as HTMLElement);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: OPENER })).toHaveFocus();
  });

  it('traps Tab inside the dialog: the last control wraps round to the first', async () => {
    const { dialog } = await openDialog();
    await fillForm();
    const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;

    last.focus();
    await userEvent.tab();
    expect(first).toHaveFocus();

    await userEvent.tab({ shift: true });
    expect(last).toHaveFocus();
  });
});

describe('FeedbackDialog, the five states', () => {
  it('DEFAULT: opens with the requested kind and a prefilled subject, so nothing is retyped', async () => {
    await openDialog({ request: { kind: 'bug', subject: 'Buchung fehlgeschlagen' } });
    expect(screen.getByRole('radio', { name: 'Etwas funktioniert nicht' })).toBeChecked();
    expect(screen.getByLabelText('Betreff')).toHaveValue('Buchung fehlgeschlagen');
  });

  it('EMPTY: the primary action is disabled AND states its reason inline, never as a tooltip (D15)', async () => {
    const { dialog } = await openDialog();
    const primary = within(dialog).getByRole('button', { name: 'Im Mail-Programm öffnen' });
    expect(primary).toBeDisabled();
    // The reason is on the page, next to the field it is about.
    expect(within(dialog).getByText('Bitte beschreibe, was passiert ist.')).toBeInTheDocument();
    expect(within(dialog).getByText('Bitte gib einen kurzen Betreff an.')).toBeInTheDocument();
    // And it is not hidden behind a hover, which a keyboard user cannot perform.
    expect(primary).not.toHaveAttribute('title');
    const message = screen.getByLabelText('Was ist passiert, und was hast du erwartet?');
    expect(message).toHaveAccessibleDescription('Bitte beschreibe, was passiert ist.');
  });

  it('ERROR: a rejected submit keeps every character the person typed', async () => {
    await openDialog({ routes: { prepare_feedback: rejected('invalid_input', { field: 'message' }) } });
    await fillForm('Betreff', 'Der Beleg liess sich nicht buchen.');
    await userEvent.click(screen.getByRole('button', { name: 'Im Mail-Programm öffnen' }));

    expect(await screen.findByText('Eine Eingabe war ungültig. Bitte prüfe die Felder und versuche es erneut.')).toBeInTheDocument();
    // Still in the form, and the words are still there. This is the assertion the spec asks for.
    expect(screen.getByLabelText('Betreff')).toHaveValue('Betreff');
    expect(screen.getByLabelText('Was ist passiert, und was hast du erwartet?')).toHaveValue(
      'Der Beleg liess sich nicht buchen.',
    );
  });

  it('PERMISSION-DENIED: the checkbox goes disabled with its reason, and the report can still be written', async () => {
    await openDialog({
      request: { diagnostic: CRASH_ENTRY },
      routes: { prepare_feedback: rejected('permission_denied', { capability: 'diagnostics.read' }) },
    });
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Im Mail-Programm öffnen' }));

    const box = await screen.findByRole('checkbox');
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
    expect(
      screen.getByText(
        'Du hast keine Berechtigung, aufgezeichnete Fehler zu lesen, daher können keine mitgesendet werden. Den Bericht kannst du trotzdem verfassen.',
      ),
    ).toBeInTheDocument();
    // The wall is on the data, never on the reporting: the primary action stays available.
    expect(screen.getByRole('button', { name: 'Im Mail-Programm öffnen' })).toBeEnabled();
  });

  it('PERMISSION-DENIED: capture off gets its own reason, not the missing-right one', async () => {
    await openDialog({
      request: { diagnostic: CRASH_ENTRY },
      routes: { prepare_feedback: rejected('diagnostics_not_enabled') },
    });
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Im Mail-Programm öffnen' }));
    expect(await screen.findByText('Fehler ab jetzt aufzeichnen')).toBeInTheDocument();
  });

  it('SUCCESS: renders Copy report and the artifact path unconditionally, and hands over the mailto', async () => {
    const openMailto = vi.fn();
    await openDialog({ openMailto });
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Im Mail-Programm öffnen' }));

    expect(await screen.findByText('Bericht gespeichert')).toBeInTheDocument();
    // Unconditional, because a browser cannot observe whether a mailto handler exists.
    expect(screen.getByRole('button', { name: 'Bericht kopieren' })).toBeInTheDocument();
    expect(screen.getByText('/Users/test/.till/feedback/fb_abc.md')).toBeInTheDocument();
    expect(
      screen.getByText(/Wenn sich nichts geöffnet hat, ist auf diesem Computer kein Mail-Programm/),
    ).toBeInTheDocument();
    expect(openMailto).toHaveBeenCalledWith(PREPARED.body.mailto);
    // No confetti and no "Erfolg!" toast: the state says what happened, in order.
    expect(screen.queryByText(/Erfolg/)).toBeNull();
  });

  it('SUCCESS: copying is an explicit press that names the consequence, never automatic', async () => {
    // LOADING-PROOF-EXEMPT: the role="status" awaited here is the "Bericht kopiert" confirmation,
    // not a skeleton, and the press it confirms is a clipboard write that asks the engine for
    // nothing. The assertion that follows is over the clipboard payload, so it cannot be vacuous.
    await openDialog();
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Im Mail-Programm öffnen' }));
    await screen.findByText('Bericht gespeichert');

    // Nothing reached the clipboard as a side effect of the primary action.
    expect(clipboard).toEqual([]);
    expect(
      screen.getByText(
        'Beim Kopieren liegt der Bericht in der Zwischenablage, die manche Systeme mit deinen anderen Geräten abgleichen.',
      ),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Bericht kopieren' }));
    await screen.findByRole('status');
    expect(clipboard).toEqual([PREPARED.body.report]);
  });

  it('BOUNDARY: a truncated mailto says so rather than losing text silently', async () => {
    await openDialog({
      routes: {
        prepare_feedback: ok({ ...(PREPARED.body as Record<string, unknown>), truncated: true }),
      },
    });
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Im Mail-Programm öffnen' }));
    expect(await screen.findByText(/Dein Text ist länger, als ein E-Mail-Link fassen kann/)).toBeInTheDocument();
  });
});

describe('FeedbackDialog, the crash path with the engine dead', () => {
  /**
   * The row the design turns on. The transport is not merely failing, it is not consulted at all,
   * and the assertions are on the PAYLOAD rather than on the presence of buttons: a report that
   * renders a Copy button over an empty string is not a report.
   */
  it('composes a working mailto and clipboard payload with no verb called', async () => {
    // LOADING-PROOF-EXEMPT: the role="status" awaited here is the "Bericht kopiert" confirmation,
    // not a skeleton. This is the localOnly crash path, and the block asserts the transport was
    // never called at all, so by construction there is no request that could be in flight.
    const openMailto = vi.fn();
    const transport = vi.fn<Transport>(async () => ({
      status: 0,
      body: { ok: false, error: 'transport_error' },
    }));
    render(
      <ThemeProvider initialTheme="light">
        <TillClientProvider client={new TillClient(transport)}>
          <I18nProvider>
            <WorkspaceProvider initialId="ws_test">
              <FeedbackProvider previewDebounceMs={0} openMailto={openMailto}>
                <Opener request={{ kind: 'bug', localOnly: true, diagnostic: CRASH_ENTRY }} />
              </FeedbackProvider>
            </WorkspaceProvider>
          </I18nProvider>
        </TillClientProvider>
      </ThemeProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: OPENER }));
    await fillForm('Absturz', 'Der Bildschirm ist stehen geblieben.');
    await userEvent.click(screen.getByRole('button', { name: 'Im Mail-Programm öffnen' }));

    expect(
      await screen.findByText(/TILL konnte den eigenen Hintergrunddienst nicht erreichen, daher wurde dieser Bericht/),
    ).toBeInTheDocument();

    // A working mailto: the scheme, the fixed recipient, the subject and the person's own words.
    const uri = openMailto.mock.calls[0]?.[0] as string;
    expect(uri.startsWith('mailto:hello@tillbooks.ch?subject=')).toBe(true);
    expect(decodeURIComponent(uri)).toContain('[bug] Absturz');
    expect(decodeURIComponent(uri)).toContain('Der Bildschirm ist stehen geblieben.');

    // A working clipboard payload, carrying the redacted crash detail and none of the message.
    await userEvent.click(screen.getByRole('button', { name: 'Bericht kopieren' }));
    await screen.findByRole('status');
    const report = clipboard[0] as string;
    expect(report).toContain('Der Bildschirm ist stehen geblieben.');
    expect(report).toContain('TypeError');
    expect(report).toContain('renderRow (assets/index.js:12:9)');
    expect(report).toContain('/documents/:id');

    // And the engine was never asked, because the engine is what may be broken.
    expect(transport).not.toHaveBeenCalled();
    // Nothing was saved, so there is no path and no Copy file path to offer.
    expect(screen.queryByRole('button', { name: 'Dateipfad kopieren' })).toBeNull();
  });
});

describe('FeedbackDialog, the preview', () => {
  it('shows exactly what would travel, rendered by the engine rather than guessed at', async () => {
    const preview = ok({
      report: '# TILL feedback: Betreff\n\n## Error details\n\n### 1. 2026-07-25, verb_error\n- Code: unexpected_error\n',
      mailto: 'mailto:hello@tillbooks.ch?subject=x&body=y',
      mailtoBody: 'y',
      truncated: false,
      diagnosticsIncluded: true,
    });
    await openDialog({
      request: { diagnostic: CRASH_ENTRY },
      routes: { preview_feedback: preview, prepare_feedback: PREPARED },
      previewDebounceMs: 0,
    });
    await fillForm();
    expect(await screen.findByText(/### 1\. 2026-07-25, verb_error/)).toBeInTheDocument();
  });

  it('says there is nothing to include when the box is not ticked', async () => {
    await openDialog();
    expect(screen.getByText('Nichts zum Mitsenden.')).toBeInTheDocument();
  });
});

describe('FeedbackDialog, the design gates', () => {
  /**
   * Hick's law, G08 §6: at most seven decision points at the dialog's one decision point. Cancel is
   * excluded because an escape hatch is not a choice between alternatives, it is the way out of the
   * choice. Counting it the spec's way (three kinds + subject + message + checkbox + primary) gives
   * exactly the seven the spec claims, which is also why a fourth `kind` would have to displace
   * something rather than simply be added.
   */
  it('keeps the decision points at or under seven', async () => {
    const { dialog } = await openDialog();
    await fillForm();
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    const cancel = within(dialog).getByRole('button', { name: 'Abbrechen' });
    const decisions = focusable.filter((node) => node !== cancel);
    expect(decisions).toHaveLength(7);
  });

  it('spends the accent on exactly one control, the primary action', async () => {
    const { dialog } = await openDialog();
    await fillForm();
    const accented = dialog.querySelectorAll('.btn--primary, .btn--accent');
    expect(accented).toHaveLength(1);
    expect(accented[0]).toHaveAccessibleName('Im Mail-Programm öffnen');
  });

  it('names the recipient, the retention period and the way to ask for erasure, at the point of sending', async () => {
    await openDialog();
    expect(
      screen.getByText(
        'Der Bericht geht an hello@tillbooks.ch. Wir löschen ihn innerhalb von 12 Monaten, und du kannst uns bitten, ihn früher zu löschen.',
      ),
    ).toBeInTheDocument();
  });

  it.each(['light', 'dark'] as const)('has no axe violations in the %s theme, at de-CH lengths', async (theme) => {
    const { container } = await openDialog({ theme, request: { diagnostic: CRASH_ENTRY } });
    await fillForm();
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });

  it.each(['light', 'dark'] as const)('has no axe violations in its success state, %s theme', async (theme) => {
    const { container } = await openDialog({ theme });
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: 'Im Mail-Programm öffnen' }));
    await screen.findByText('Bericht gespeichert');
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});
