/**
 * The Vorlagen surface: G05's human face over the template lifecycle and the Vorschau pane.
 *
 * The suite follows the house discipline: every claim about a GATE mounts a real
 * `CapabilitiesProvider` over a transport that answers `whoami`, the loading assertion waits for
 * the read to have STARTED, and copy is asserted through the catalogue, never as a literal typed
 * here.
 *
 * The G05-specific claims worth singling out: the statutory lede (what a template can NEVER
 * change) renders in place; the five states render (loading/empty/error/success/
 * permission-denied); without `manage_document_templates` the write controls are PRE-disabled
 * with the requires-admin note beside them while the list stays readable; the sample preview
 * names itself as a Muster; and saving drives the real verb with the typed fields.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import { neverSettles, watchReads } from '../../test-transport';
import DocumentTemplates from './index';
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

const TEMPLATE = (over: Record<string, unknown> = {}) => ({
  templateId: 'doctpl_1',
  documentKind: 'invoice',
  name: 'Briefpapier Standard',
  lineItemColumns: ['discount'],
  footerI18n: { 'de-CH': 'Vielen Dank.' },
  languageMode: 'fixed',
  fixedLocale: 'de-CH',
  isDefault: true,
  archived: false,
  logoFileId: null,
  createdAt: '2026-07-16T00:00:00.000Z',
  updatedAt: '2026-07-16T00:00:00.000Z',
  ...over,
});

const whoamiWith = (capabilities: string[]): RestResponse =>
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities });

const baseCanned = (): Canned => ({
  whoami: whoamiWith(['read_master_data', 'manage_document_templates']),
  list_document_templates: ok({ templates: [TEMPLATE()] }),
  preview_document_template: ok({
    pdf: { base64: Buffer.from('%PDF-1.4 probe').toString('base64'), byteLength: 14 },
    sample: true,
    sourceDocumentId: null,
    templateId: 'doctpl_1',
    locale: 'de-CH',
  }),
});

function tree(canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>) {
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_1">
          <CapabilitiesProvider>
            <MemoryRouter>
              <DocumentTemplates />
            </MemoryRouter>
          </CapabilitiesProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

describe('DocumentTemplates', () => {
  it('LOADING: shows the skeleton while the template read is really in flight', async () => {
    const transport = watchReads(neverSettles);
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_1">
            <MemoryRouter>
              <DocumentTemplates />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await transport.started('list_document_templates');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('EMPTY: names the state and the CTA, and states the built-in fallback honestly', async () => {
    render(tree({ ...baseCanned(), list_document_templates: ok({ templates: [] }) }));
    expect(await screen.findByText(de.docTemplate.empty)).toBeInTheDocument();
    expect(screen.getByText(de.docTemplate.emptyHint)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: de.docTemplate.new })).toBeEnabled();
  });

  it('ERROR: a failed list renders the retryable banner, not a crash', async () => {
    render(tree({ ...baseCanned(), list_document_templates: reject('unexpected_error', {}, 500) }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('PERMISSION-DENIED (read): a refused list renders the padlock copy', async () => {
    render(
      tree({
        ...baseCanned(),
        whoami: whoamiWith([]),
        list_document_templates: reject('permission_denied', {}, 403),
      }),
    );
    expect(await screen.findByText(de.docTemplate.permissionDenied.read)).toBeInTheDocument();
  });

  it('PERMISSION-DENIED (write): without the capability the controls are PRE-disabled with the reason beside them, list stays readable', async () => {
    render(tree({ ...baseCanned(), whoami: whoamiWith(['read_master_data']) }));
    expect(await screen.findByText('Briefpapier Standard')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: de.docTemplate.new })).toBeDisabled());
    expect(screen.getByText(de.docTemplate.needsPermission)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: de.docTemplate.archive })).toBeDisabled();
  });

  it('SUCCESS: the statutory lede, the kind tabs and the default badge render; selecting shows the Muster preview', async () => {
    const user = userEvent.setup();
    render(tree(baseCanned()));
    expect(await screen.findByText('Briefpapier Standard')).toBeInTheDocument();
    expect(screen.getByText(de.docTemplate.lede)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: de.docTemplate.kind.invoice })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(de.docTemplate.default)).toBeInTheDocument();

    // The name is now a clickable DataTable row (aria-label = the template name), not a button.
    await user.click(screen.getByRole('row', { name: 'Briefpapier Standard' }));
    expect(await screen.findByText(de.docTemplate.samplePreview)).toBeInTheDocument();
    expect(screen.getByLabelText(de.docTemplate.previewAria)).toBeInTheDocument();
    // The editor prefills from the row: the footer text for de-CH is on screen.
    expect(screen.getByLabelText('Fusszeile (de-CH)')).toHaveValue('Vielen Dank.');
  });

  it('SAVE: creating a template drives create_document_template with the typed fields, then reloads', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned: Canned = {
      ...baseCanned(),
      list_document_templates: ok({ templates: [] }),
      create_document_template: ok({ template: TEMPLATE({ templateId: 'doctpl_neu', isDefault: false }) }),
    };
    const user = userEvent.setup();
    render(tree(canned, asked));
    await user.click(await screen.findByRole('button', { name: de.docTemplate.new }));
    await user.type(screen.getByLabelText(de.docTemplate.name), 'Neue Vorlage');
    await user.type(screen.getByLabelText('Fusszeile (de-CH)'), 'Danke!');
    await user.click(screen.getByRole('button', { name: de.docTemplate.save }));

    await waitFor(() => {
      const create = asked.find((call) => call.action === 'create_document_template');
      expect(create).toBeDefined();
      expect(create?.input.documentKind).toBe('invoice');
      expect(create?.input.name).toBe('Neue Vorlage');
      expect((create?.input.footerI18n as Record<string, string>)['de-CH']).toBe('Danke!');
      expect(typeof create?.input.idempotencyKey).toBe('string');
    });
  });

  it('SET DEFAULT: a non-default row offers Als Standard festlegen and drives the verb', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned: Canned = {
      ...baseCanned(),
      list_document_templates: ok({
        templates: [TEMPLATE(), TEMPLATE({ templateId: 'doctpl_2', name: 'Zweite', isDefault: false })],
      }),
      set_default_document_template: ok({ template: TEMPLATE({ templateId: 'doctpl_2', isDefault: true }) }),
    };
    const user = userEvent.setup();
    render(tree(canned, asked));
    await user.click(await screen.findByRole('button', { name: de.docTemplate.setDefault }));
    await waitFor(() => {
      const call = asked.find((x) => x.action === 'set_default_document_template');
      expect(call).toBeDefined();
      expect(call?.input.templateId).toBe('doctpl_2');
      expect(call?.input.documentKind).toBe('invoice');
    });
  });

  it('WRITE ERROR: needs_valid_logo_file renders its named message, not the fallback', async () => {
    const canned: Canned = {
      ...baseCanned(),
      list_document_templates: ok({ templates: [] }),
      create_document_template: reject('needs_valid_logo_file'),
    };
    const user = userEvent.setup();
    render(tree(canned));
    await user.click(await screen.findByRole('button', { name: de.docTemplate.new }));
    await user.type(screen.getByLabelText(de.docTemplate.name), 'Mit kaputtem Logo');
    await user.click(screen.getByRole('button', { name: de.docTemplate.save }));
    expect(await screen.findByText(de.docTemplate.needsValidLogoFile)).toBeInTheDocument();
  });
});
