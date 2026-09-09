/**
 * The Versand surface: G05 §10's human face over the Textbausteine editor and the Protokoll.
 *
 * The house discipline: every claim about a GATE mounts a real `CapabilitiesProvider` over a
 * transport that answers `whoami`, the loading assertion waits for the read to have STARTED, and
 * copy is asserted through the catalogue, never as a literal typed here.
 *
 * The §10-specific claims worth singling out: both tabs render; the send-line lede renders in
 * place; the built-in-default note names itself when no slot is saved; saving drives the REAL verb
 * WITHOUT an idempotencyKey (the naturally-idempotent shape is part of the contract); an
 * `unknown_variable` refusal renders its named message with the valid set; the variable chips
 * insert by keyboard (they are buttons); the Protokoll renders outcome as glyph + label with a
 * document link per row; and without `manage_dispatch_texts` Speichern is PRE-disabled with the
 * reason beside it while both tabs stay readable.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import { neverSettles, watchReads } from '../../test-transport';
import Dispatch from './index';
import de from './messages.de-CH.json';

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, extra: Record<string, unknown> = {}, status = 422): RestResponse => ({
  status,
  body: { ok: false, error, ...extra },
});

function fakeTransport(canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>): Transport {
  return async (action, input) => {
    asked?.push({ action, input: input ?? {} });
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input ?? {}) : entry;
  };
}

// --- The engine's own payload shapes -----------------------------------------------------------

const ROW = (over: Record<string, unknown> = {}) => ({
  dispatchId: 'dsp_1',
  documentKind: 'invoice',
  documentId: 'doc_1',
  dunningRunId: null,
  contactId: 'c_1',
  recipientEmail: 'kunde@example.ch',
  channel: 'smtp',
  locale: 'de-CH',
  subjectResolved: 'Rechnung R-2026-0001',
  bodyResolved: '',
  dispatchTextDefaulted: true,
  outcome: 'sent',
  degradeReason: null,
  actor: 'studio',
  sentAt: '2026-07-16T00:00:00.000Z',
  ...over,
});

const TEXT = (over: Record<string, unknown> = {}) => ({
  dispatchTextId: 'dsptxt_1',
  documentKind: 'invoice',
  locale: 'de-CH',
  subject: 'Eigener Betreff {{invoice_number}}',
  body: 'Eigener Text {{contact_name}}',
  updatedAt: '2026-07-16T00:00:00.000Z',
  updatedBy: 'studio',
  ...over,
});

const whoamiWith = (capabilities: string[]): RestResponse =>
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities });

const baseCanned = (): Canned => ({
  whoami: whoamiWith(['read_master_data', 'manage_dispatch_texts']),
  list_dispatches: ok({ dispatches: [ROW()], texts: [TEXT()] }),
  dispatch_preview: ok({
    messages: [
      {
        recipient: null,
        contactId: null,
        locale: 'de-CH',
        subject: 'Eigener Betreff R-2026-0001',
        body: 'Eigener Text Muster AG',
        attachments: [],
        flags: [],
        defaulted: false,
      },
    ],
    sample: true,
  }),
});

function tree(canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>) {
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_1">
          <CapabilitiesProvider>
            <MemoryRouter>
              <Dispatch />
            </MemoryRouter>
          </CapabilitiesProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

describe('Dispatch', () => {
  it('LOADING: shows the skeleton while the log read is really in flight', async () => {
    const transport = watchReads(neverSettles);
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_1">
            <MemoryRouter>
              <Dispatch />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await transport.started('list_dispatches');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('ERROR: a failed list renders the retryable banner, not a crash', async () => {
    render(tree({ ...baseCanned(), list_dispatches: reject('unexpected_error', {}, 500) }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('PERMISSION-DENIED (read): a refused list renders the padlock copy', async () => {
    render(
      tree({
        ...baseCanned(),
        whoami: whoamiWith([]),
        list_dispatches: reject('permission_denied', {}, 403),
      }),
    );
    expect(await screen.findByText(de.dispatch.permissionDenied.read)).toBeInTheDocument();
  });

  it('PERMISSION-DENIED (write): Speichern is PRE-disabled with the reason beside it, the editor stays readable', async () => {
    render(tree({ ...baseCanned(), whoami: whoamiWith(['read_master_data']) }));
    expect(await screen.findByLabelText(de.dispatch.texts.subject)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: de.dispatch.texts.save })).toBeDisabled(),
    );
    expect(screen.getByText(de.dispatch.needsPermission)).toBeInTheDocument();
  });

  it('SUCCESS (Textbausteine): lede, tabs and the saved slot prefill render; the preview resolves', async () => {
    render(tree(baseCanned()));
    // The prefill lands in the post-load effect, one tick after the field first renders: wait for
    // the VALUE, not merely the element (a race only visible under gate contention).
    const subject = await screen.findByLabelText(de.dispatch.texts.subject);
    await waitFor(() => expect(subject).toHaveValue('Eigener Betreff {{invoice_number}}'));
    expect(screen.getByText(de.dispatch.lede)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: de.dispatch.tab.texts })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: de.dispatch.kind.invoice })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('Eigener Betreff R-2026-0001')).toBeInTheDocument();
    expect(screen.getByText(de.dispatch.texts.previewSaved)).toBeInTheDocument();
  });

  it('DEFAULT IN USE: an unsaved slot names the built-in fallback honestly', async () => {
    render(tree({ ...baseCanned(), list_dispatches: ok({ dispatches: [], texts: [] }) }));
    expect(await screen.findByText(de.dispatch.texts.defaultInUse)).toBeInTheDocument();
  });

  it('SAVE: drives dispatch_text_upsert with the typed slot and NO idempotencyKey; a chip inserts its variable', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned: Canned = {
      ...baseCanned(),
      list_dispatches: ok({ dispatches: [], texts: [] }),
      dispatch_text_upsert: ok({ dispatchText: TEXT() }),
    };
    const user = userEvent.setup();
    render(tree(canned, asked));
    await user.type(await screen.findByLabelText(de.dispatch.texts.subject), 'Neuer Betreff');
    await user.type(screen.getByLabelText(de.dispatch.texts.body), 'Guten Tag');
    // The palette chip is a BUTTON (keyboard-insertable, never drag-only, §10.6 accessibility).
    await user.click(screen.getByRole('button', { name: '{{contact_name}}' }));
    await user.click(screen.getByRole('button', { name: de.dispatch.texts.save }));
    await waitFor(() => {
      const call = asked.find((x) => x.action === 'dispatch_text_upsert');
      expect(call).toBeDefined();
      expect(call?.input.documentKind).toBe('invoice');
      expect(call?.input.locale).toBe('de-CH');
      expect(call?.input.subject).toBe('Neuer Betreff');
      expect(String(call?.input.body)).toContain('{{contact_name}}');
      expect('idempotencyKey' in (call?.input ?? {})).toBe(false);
    });
    expect(await screen.findByText(de.dispatch.texts.saved)).toBeInTheDocument();
  });

  it('WRITE ERROR: unknown_variable renders its named message with the valid set, not the fallback', async () => {
    const canned: Canned = {
      ...baseCanned(),
      list_dispatches: ok({ dispatches: [], texts: [] }),
      dispatch_text_upsert: reject('unknown_variable', { variable: 'tippfehler', valid: ['contact_name'] }),
    };
    const user = userEvent.setup();
    render(tree(canned));
    await user.type(await screen.findByLabelText(de.dispatch.texts.subject), 'B');
    await user.type(screen.getByLabelText(de.dispatch.texts.body), 'T');
    await user.click(screen.getByRole('button', { name: de.dispatch.texts.save }));
    // Scoped to the ALERT: the variable palette's chips carry the same names.
    const alert = within(await screen.findByRole('alert'));
    expect(alert.getByText(/tippfehler/)).toBeInTheDocument();
    expect(alert.getByText(/contact_name/)).toBeInTheDocument();
  });

  it('PROTOKOLL: rows render outcome as glyph + label with a document link; empty state names the first action', async () => {
    const user = userEvent.setup();
    render(
      tree({
        ...baseCanned(),
        list_dispatches: ok({
          dispatches: [
            ROW(),
            ROW({ dispatchId: 'dsp_2', outcome: 'degraded', degradeReason: 'needs_email_config', recipientEmail: null }),
          ],
          texts: [],
        }),
      }),
    );
    await user.click(await screen.findByRole('tab', { name: de.dispatch.tab.log }));
    // Scoped to the TABLE: the filter select's options carry the same outcome labels.
    const table = within(await screen.findByRole('table'));
    expect(table.getByText(de.dispatch.log.outcome.sent)).toBeInTheDocument();
    expect(table.getByText(de.dispatch.log.outcome.degraded)).toBeInTheDocument();
    // The degrade reason renders its HUMANISED label, never the raw engine code (f3).
    expect(table.getByText(new RegExp(de.dispatch.log.degradeReason.needs_email_config))).toBeInTheDocument();
    expect(table.queryByText(/needs_email_config/)).not.toBeInTheDocument();
    expect(table.getAllByRole('link', { name: de.dispatch.log.open })).toHaveLength(2);
    expect(table.getByText('kunde@example.ch')).toBeInTheDocument();

    // The outcome filter narrows the table client-side: no failed rows exist, so the table gives
    // way to the named empty state. (The select's own option labels remain, so the assertion is on
    // the TABLE's absence, not on label text.)
    await user.selectOptions(screen.getByLabelText(de.dispatch.log.filterLabel), 'failed');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText(de.dispatch.log.empty)).toBeInTheDocument();
  });

  it('DEGRADE REASON (f3): a known code renders its humanised label, an unknown code degrades gracefully to a humanised form, never the raw token', async () => {
    const user = userEvent.setup();
    render(
      tree({
        ...baseCanned(),
        list_dispatches: ok({
          dispatches: [
            ROW({ dispatchId: 'dsp_known', outcome: 'degraded', degradeReason: 'needs_customer_email', recipientEmail: null }),
            // A future/unknown code the catalogue does not carry: it must still humanise, not leak.
            ROW({ dispatchId: 'dsp_unknown', outcome: 'failed', degradeReason: 'quota_exhausted', recipientEmail: null }),
            // A prefixed code (`render_failed:<detail>`): resolves on its head, the detail never bleeds.
            ROW({ dispatchId: 'dsp_prefixed', outcome: 'failed', degradeReason: 'render_failed:boom', recipientEmail: null }),
          ],
          texts: [],
        }),
      }),
    );
    await user.click(await screen.findByRole('tab', { name: de.dispatch.tab.log }));
    const table = within(await screen.findByRole('table'));
    // Known code: the catalogue label, not the code.
    expect(table.getByText(new RegExp(de.dispatch.log.degradeReason.needs_customer_email))).toBeInTheDocument();
    expect(table.queryByText(/needs_customer_email/)).not.toBeInTheDocument();
    // Unknown code: humanised ("Quota exhausted"), never the raw `quota_exhausted`.
    expect(table.getByText(/Quota exhausted/)).toBeInTheDocument();
    expect(table.queryByText(/quota_exhausted/)).not.toBeInTheDocument();
    // Prefixed code: the head resolves through the catalogue, the `:boom` detail never renders.
    expect(table.getByText(new RegExp(de.dispatch.log.degradeReason.render_failed))).toBeInTheDocument();
    expect(table.queryByText(/boom/)).not.toBeInTheDocument();
  });
});
