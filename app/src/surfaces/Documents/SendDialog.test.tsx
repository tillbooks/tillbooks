/**
 * S7, the send dialog: all five states, driven from the real DocumentDetail's Senden action so the
 * routing (an invoice opens S7, a quote does not) is under test with the dialog.
 *
 * The rejection codes asserted here are the codes the ENGINE emits, pinned by
 * `test/sales/invoice-gui-fixture.test.mjs`: needs_confirmation, needs_email_config,
 * needs_customer_email. None of them is invented on this side.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import DocumentsSurface from './index';
import artifacts from './invoice-artifacts.fixture.json';
import sendFixture from './send-invoice.fixture.json';

/**
 * A canned handler exactly as the transport calls it: the request input in, a RestResponse out.
 *
 * Spies are declared `vi.fn<CannedHandler>(...)` rather than bare `vi.fn(...)`, so that
 * `spy.mock.calls[0][0]` is the request the surface actually sent. Inferred from a zero-argument
 * implementation the calls tuple is empty, and every assertion about what the surface asked for is
 * a compile error the moment anyone type-checks this file.
 */
type CannedHandler = (input: Record<string, unknown>) => RestResponse;

type Canned = Record<string, RestResponse | CannedHandler>;

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, extra: Record<string, unknown> = {}, status = 422): RestResponse => ({
  status,
  body: { ok: false, error, ...extra },
});

const VAT_PREVIEW = ok({
  ok: true,
  kind: 'output',
  netMinor: 150000,
  taxMinor: 12150,
  grossMinor: 162150,
  rateBp: 810,
  deductible: false,
  formLine: '303',
  trace: { taxCode: 'UST81', taxBaseMinor: 150000, taxAmountMinor: 12150 },
});

function getDocument(document: Record<string, unknown> = artifacts.document) {
  return (input: Record<string, unknown>): RestResponse => {
    const include = (input.include as string[] | undefined) ?? [];
    const body: Record<string, unknown> = { document, lines: artifacts.lines, history: artifacts.history };
    if (include.includes('qr')) body.qr = artifacts.qr;
    if (include.includes('pdf')) body.pdf = artifacts.pdf;
    return ok(body);
  };
}

/**
 * A `get_document` that follows the engine: the ISSUED invoice before a send, the SENT one (with
 * `sentToEmail` filled in) once `send_invoice` has succeeded.
 *
 * The dialog's confirmation is no longer an echo of the click, it is a re-read of the document, so a
 * static handler here would assert nothing about what a user actually sees after the reload. That
 * was the old shape of this test and it is exactly the mistake the fixture guards exist to stop: it
 * proved the client could repeat its own input back to itself.
 */
function documentBecomingSent() {
  let sent = false;
  const read = (input: Record<string, unknown>): RestResponse =>
    getDocument(sent ? sendFixture.document : artifacts.document)(input);
  return { read, markSent: () => { sent = true; } };
}

const withEmail = ok({ contact: { id: 'ct_1', name: 'Muster AG', email: 'kunde@example.ch' } });
const withoutEmail = ok({ contact: { id: 'ct_1', name: 'Muster AG', email: null } });

function renderDetail(canned: Canned) {
  const client = new TillClient(fakeTransport(canned));
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter initialEntries={['/documents/doc_1']}>
            <Routes>
              <Route path="/documents/*" element={<DocumentsSurface />} />
            </Routes>
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

async function openSend(canned: Canned) {
  renderDetail(canned);
  await userEvent.click(await screen.findByRole('button', { name: 'Senden' }));
  return screen.findByRole('alertdialog');
}

describe('SendDialog (S7), the five states', () => {
  it('POPULATED: prefills the customer email, names the attachment, and sends through send_invoice', async () => {
    const doc = documentBecomingSent();
    const sendSpy = vi.fn<CannedHandler>(() => {
      doc.markSent();
      return ok({ ...sendFixture });
    });
    const dialog = await openSend({
      get_document: doc.read,
      get_contact: withEmail,
      vat_preview: VAT_PREVIEW,
      send_invoice: sendSpy,
    });

    expect(within(dialog).getByLabelText('An')).toHaveValue('kunde@example.ch');
    expect(within(dialog).getByText(/Rechnung-R-2026-0001\.pdf/)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Senden' }));
    await waitFor(() => expect(sendSpy).toHaveBeenCalledOnce());
    // A11's own verb, with the human's confirmation for the P8-gated outbound step (M15). No
    // transition_document: the send composes render + attach + relay + transition itself.
    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      invoiceId: 'doc_1',
      email: 'kunde@example.ch',
      confirmed: true,
    });
    // The confirmation names the address the DOCUMENT records, so it survives the reload it just
    // triggered rather than living in a state the next page load would lose.
    expect(await screen.findByText('Versendet an kunde@example.ch')).toBeInTheDocument();
  });

  it('EMPTY: no email on file leaves the field blank, prompts, and holds Senden (M17)', async () => {
    const sendSpy = vi.fn<CannedHandler>(() => ok({ ...sendFixture }));
    const dialog = await openSend({
      get_document: getDocument(),
      get_contact: withoutEmail,
      vat_preview: VAT_PREVIEW,
      send_invoice: sendSpy,
    });

    expect(within(dialog).getByLabelText('An')).toHaveValue('');
    expect(within(dialog).getByText(/keine E-Mail hinterlegt/)).toBeInTheDocument();
    // Nothing is prefilled falsely, and an empty recipient cannot be sent.
    expect(within(dialog).getByRole('button', { name: 'Senden' })).toBeDisabled();

    await userEvent.type(within(dialog).getByLabelText('An'), 'neu@example.ch');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Senden' }));
    await waitFor(() => expect(sendSpy).toHaveBeenCalledOnce());
    expect(sendSpy.mock.calls[0][0]).toMatchObject({ email: 'neu@example.ch' });
  });

  it('ERROR: no relay names BOTH ways out and keeps the typed address (M18)', async () => {
    const dialog = await openSend({
      get_document: getDocument(),
      get_contact: withEmail,
      vat_preview: VAT_PREVIEW,
      send_invoice: reject('needs_email_config', { email: 'kunde@example.ch' }),
    });

    await userEvent.clear(within(dialog).getByLabelText('An'));
    await userEvent.type(within(dialog).getByLabelText('An'), 'anders@example.ch');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Senden' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(/Lade das PDF herunter und sende es von Hand/);
    expect(within(alert).getByRole('button', { name: 'PDF herunterladen' })).toBeInTheDocument();
    expect(within(alert).getByRole('link', { name: 'E-Mail-Versand einrichten' })).toHaveAttribute('href', '/setup');
    // A failed attempt never destroys input.
    expect(within(dialog).getByLabelText('An')).toHaveValue('anders@example.ch');
  });

  it('ERROR: the PDF way out actually opens S8, so the operator is never stuck', async () => {
    const dialog = await openSend({
      get_document: getDocument(),
      get_contact: withEmail,
      vat_preview: VAT_PREVIEW,
      send_invoice: reject('needs_email_config'),
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Senden' }));
    const alert = await within(dialog).findByRole('alert');
    await userEvent.click(within(alert).getByRole('button', { name: 'PDF herunterladen' }));

    const viewer = await screen.findByRole('dialog');
    expect(await within(viewer).findByRole('link', { name: 'Herunterladen' })).toBeInTheDocument();
  });

  /*
   * A11-G3's remainder. `sendInvoice` refuses to mail an invoice whose PDF carries no payment part
   * and hands back the cause the render already computed. The dialog used to discard it and print
   * "check the IBAN and both addresses" at everyone, including the operator whose IBAN was fine.
   */
  it('ERROR: needs_qr_bill names the engine’s OWN reason and the field that fixes it', async () => {
    const dialog = await openSend({
      get_document: getDocument(),
      get_contact: withEmail,
      vat_preview: VAT_PREVIEW,
      send_invoice: reject('needs_qr_bill', {
        transmitted: false,
        reason: 'needs_customer_address',
        detail: 'needs_customer_address: debtorStreet: missing',
      }),
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Senden' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(/fehlt der QR-Zahlteil/);
    // The engine's reason, in the operator's language, and the route that fixes it.
    expect(alert).toHaveTextContent(/Die Kundenadresse ist unvollständig/);
    expect(within(alert).getByRole('link', { name: 'Adresse vervollständigen' })).toHaveAttribute('href', '/contacts');
    // The old catch-all guess is gone: the IBAN is not the problem here and must not be named.
    expect(alert).not.toHaveTextContent(/Prüfe die IBAN/);
  });

  it('ERROR: a creditor-side QR gap routes to Setup without blaming the IBAN', async () => {
    const dialog = await openSend({
      get_document: getDocument(),
      get_contact: withEmail,
      vat_preview: VAT_PREVIEW,
      send_invoice: reject('needs_qr_bill', { reason: 'needs_creditor_address', detail: 'needs_creditor_address' }),
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Senden' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(/Deine eigene Adresse ist unvollständig/);
    expect(within(alert).getByRole('link', { name: 'Deine Adresse vervollständigen' })).toHaveAttribute('href', '/setup');
    expect(within(alert).queryByRole('link', { name: 'IBAN hinterlegen' })).not.toBeInTheDocument();
  });

  /*
   * `unknown` is the engine's honest answer when the render produced no cause. Nothing is invented,
   * and the raw diagnostic is shown rather than dropped a second time.
   */
  it('ERROR: an unnamed QR gap says so and still surfaces the engine’s raw detail', async () => {
    const dialog = await openSend({
      get_document: getDocument(),
      get_contact: withEmail,
      vat_preview: VAT_PREVIEW,
      send_invoice: reject('needs_qr_bill', { reason: 'swiss_qr_payload_too_long', detail: 'payload is 1013 characters' }),
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Senden' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(/nicht herausgefunden/);
    expect(alert).toHaveTextContent(/payload is 1013 characters/);
    expect(within(alert).queryByRole('link', { name: /vervollständigen|hinterlegen/ })).not.toBeInTheDocument();
  });

  it('ERROR: a relay failure stays open and keeps the invoice issued, never claims a send', async () => {
    const dialog = await openSend({
      get_document: getDocument(),
      get_contact: withEmail,
      vat_preview: VAT_PREVIEW,
      send_invoice: reject('email_send_failed', { reason: 'relay_refused' }),
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Senden' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/Die Rechnung bleibt ausgestellt/);
    expect(screen.queryByText(/Versendet an/)).not.toBeInTheDocument();
  });

  it('ERROR: the P8 refusal is rendered as the engine states it, not swallowed (M15)', async () => {
    const dialog = await openSend({
      get_document: getDocument(),
      get_contact: withEmail,
      vat_preview: VAT_PREVIEW,
      send_invoice: reject('needs_confirmation', { reason: 'outbound_send_requires_confirmation' }),
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Senden' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/bestätigst du diesen Schritt selbst/);
  });

  it('PERMISSION-DENIED: a denied send says so and leaves the document untouched', async () => {
    const dialog = await openSend({
      get_document: getDocument(),
      get_contact: withEmail,
      vat_preview: VAT_PREVIEW,
      send_invoice: reject('permission_denied', {}, 403),
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Senden' }));
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/Versendet an/)).not.toBeInTheDocument();
  });

  it('LOADING: the button is held while the call is in flight, so one click is one send', async () => {
    let resolveSend: (r: RestResponse) => void = () => {};
    let calls = 0;
    const doc = documentBecomingSent();
    const dialog = await openSend({
      get_document: doc.read,
      get_contact: withEmail,
      vat_preview: VAT_PREVIEW,
      send_invoice: () => {
        calls += 1;
        return new Promise<RestResponse>((resolve) => {
          resolveSend = resolve;
        }) as unknown as RestResponse;
      },
    });

    const button = within(dialog).getByRole('button', { name: 'Senden' });
    await userEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    // A second click cannot land: at-most-once is the engine's guarantee, and the GUI does not
    // hand it a second call to have to deduplicate.
    await userEvent.click(button);
    expect(calls).toBe(1);
    doc.markSent();
    resolveSend(ok({ ...sendFixture }));
    await screen.findByText('Versendet an kunde@example.ch');
  });
});

describe('SendDialog routing: only an invoice transmits', () => {
  it('marks a quote sent through A10 transition_document, with no dialog and no PDF', async () => {
    const transitionSpy = vi.fn<CannedHandler>(() => ok({ document: { ...artifacts.document, type: 'quote', status: 'sent' } }));
    const sendSpy = vi.fn<CannedHandler>(() => ok({ ...sendFixture }));
    renderDetail({
      get_document: getDocument({ ...artifacts.document, type: 'quote', number: 'O-2026-0001', status: 'issued' }),
      get_contact: withEmail,
      vat_preview: VAT_PREVIEW,
      transition_document: transitionSpy,
      send_invoice: sendSpy,
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Senden' }));
    await waitFor(() => expect(transitionSpy).toHaveBeenCalledOnce());
    expect(sendSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
