/**
 * The Schreibstil surface: E05's human face over the voice profile and the OP6 model picker.
 *
 * The suite follows the Korrespondenz discipline: every claim about a GATE mounts a real
 * `CapabilitiesProvider` over a transport that answers `whoami`, a loading assertion waits for the
 * read to have STARTED, and copy is asserted through the catalogue, never as a literal typed here.
 *
 * The E05-specific claims worth singling out: with no runtime installed the panel says so AND says
 * no cloud model will be used instead (US-E05.4: the degraded path is the important one); the
 * corpus note states index-never-copy IN PLACE; `corpus_too_small` shows the honest have/need
 * counts; the recommended model row is preselected and labelled; an over-floor row renders
 * DISABLED with the have/need sentence in place, never hidden; Erweitert is collapsed by default;
 * and the updates note states that TILL does not check online.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import { neverSettles, watchReads } from '../../test-transport';
import WritingStyle from './index';
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

const PROFILE = (over: Record<string, unknown> = {}) => ({
  id: 'voiceprf_1',
  accountId: 'mailacc_1',
  styleCard: {
    greeting: 'Guten Tag',
    signOff: 'Freundliche Grüsse',
    formality: 'Sie',
    meanSentenceWords: 11.2,
    medianReplyLines: 4,
    languageMix: { de: 96, en: 4 },
  },
  sourceSha256: 'f'.repeat(64),
  exemplarCount: 21,
  modelRef: 'stub-4b-q4',
  builtAt: '2026-07-16T00:00:00.000Z',
  ...over,
});

const CATALOG = () =>
  ok({
    models: [
      {
        modelRef: 'stub-4b-q4',
        displayName: 'Stub 4B (Q4)',
        minRamGb: 8,
        downloadBytes: 2_400_000_000,
        sha256: 'a'.repeat(64),
        upstreamUrl: 'https://example.invalid/commit/0123/x.gguf',
        licence: { spdx: 'Apache-2.0', commercialUse: true },
        qualityDe: 'Deutsch nicht gemessen.',
        qualityEn: 'Not measured.',
        qualityMeasured: false,
        contextTokens: 8192,
        fits: true,
        recommended: true,
      },
      {
        modelRef: 'stub-70b-f16',
        displayName: 'Stub 70B (F16)',
        minRamGb: 128,
        downloadBytes: 140_000_000_000,
        sha256: 'c'.repeat(64),
        upstreamUrl: 'https://example.invalid/commit/89ab/y.gguf',
        licence: { spdx: 'Apache-2.0', commercialUse: true },
        qualityDe: 'Sehr gutes Deutsch.',
        qualityEn: 'Very good English.',
        qualityMeasured: true,
        contextTokens: 32768,
        fits: false,
        recommended: false,
      },
    ],
    recommendedModelRef: 'stub-4b-q4',
    machineRamGb: 16,
    selection: null,
  });

const whoamiWith = (capabilities: string[]): RestResponse =>
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities });

const baseCanned = (): Canned => ({
  whoami: whoamiWith(['voice.read', 'voice.write']),
  runtime_status: ok({ registered: true, runtimeId: 'stub-local', modelRef: 'stub-4b-q4', device: 'metal', selection: null }),
  runtime_catalog: CATALOG(),
  voice_profiles_list: ok({ profiles: [], total: 0 }),
  voice_profile_get: ok({ profile: PROFILE(), stale: false }),
  mail_accounts_list: ok({ accounts: [{ id: 'mailacc_1', address: 'praxis@example.ch' }] }),
  files_search: ok({ files: [] }),
});

function tree(canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>) {
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_1">
          <CapabilitiesProvider>
            <MemoryRouter>
              <WritingStyle />
            </MemoryRouter>
          </CapabilitiesProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

describe('WritingStyle', () => {
  it('LOADING: shows the skeleton while the profile read is really in flight', async () => {
    const transport = watchReads(neverSettles);
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_1">
            <MemoryRouter>
              <WritingStyle />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await transport.started('voice_profiles_list');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('PERMISSION-DENIED: a refused profile list renders the padlock copy, not a crash', async () => {
    render(tree({ ...baseCanned(), whoami: whoamiWith([]), voice_profiles_list: reject('permission_denied', {}, 403) }));
    expect(await screen.findByText(de.voice.error.permissionDenied.read)).toBeInTheDocument();
  });

  it('RUNTIME ABSENT: states not-installed AND that no cloud model will be used instead (US-E05.4)', async () => {
    render(
      tree({
        ...baseCanned(),
        runtime_status: ok({ registered: false, selection: null }),
        runtime_catalog: reject('needs_local_runtime'),
      }),
    );
    expect(await screen.findByText(de.voice.empty)).toBeInTheDocument();
    expect(screen.getByText(de.runtime.status.absent)).toBeInTheDocument();
    expect(screen.getByText(de.runtime.error.needs_local_runtime)).toBeInTheDocument();
    // No runtime: the learn action is not offered, and no model list renders.
    expect(screen.queryByText(de.voice.action.build)).not.toBeInTheDocument();
    expect(screen.queryByText(de.runtime.picker.title)).not.toBeInTheDocument();
  });

  it('EMPTY: offers Schreibstil lernen with the honest index-never-copy note in place', async () => {
    render(tree(baseCanned()));
    expect(await screen.findByText(de.voice.empty)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: de.voice.action.build })).toBeInTheDocument();
    expect(screen.getByText(de.voice.corpus.note)).toBeInTheDocument();
  });

  it('ERROR: corpus_too_small shows the honest have/need counts', async () => {
    const canned = { ...baseCanned(), voice_build: reject('corpus_too_small', { have: 3, need: 20 }) };
    render(tree(canned));
    const build = await screen.findByRole('button', { name: de.voice.action.build });
    await userEvent.click(build);
    expect(await screen.findByText('TILL braucht mindestens 20 gesendete Nachrichten, um deinen Schreibstil zu lernen. Gefunden: 3.')).toBeInTheDocument();
  });

  it('SUCCESS: the style card renders readable fields, the rebuild action, and the staleness note', async () => {
    const canned = {
      ...baseCanned(),
      voice_profiles_list: ok({ profiles: [PROFILE()], total: 1 }),
      voice_profile_get: ok({ profile: PROFILE(), stale: true }),
    };
    render(tree(canned));
    expect(await screen.findByText('Guten Tag')).toBeInTheDocument();
    expect(screen.getByText('Freundliche Grüsse')).toBeInTheDocument();
    expect(screen.getByText(de.voice.field.exemplars)).toBeInTheDocument();
    expect(screen.getByText('21')).toBeInTheDocument();
    expect(screen.getByText('16.07.2026')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: de.voice.action.rebuild })).toBeInTheDocument();
    expect(screen.getByText(de.voice.stale)).toBeInTheDocument();
  });

  it('PICKER: preselects the recommended row, labels it, and disables the over-floor row with the reason IN PLACE', async () => {
    render(tree(baseCanned()));
    expect(await screen.findByText(de.runtime.picker.recommended, { exact: false })).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(radios[0]).toBeChecked();
    expect(radios[1]).toBeDisabled();
    expect(screen.getByText('Benötigt 128 GB RAM. Dein Mac hat 16 GB.')).toBeInTheDocument();
    // The honesty notes render with the list, not behind anything.
    expect(screen.getByText(de.runtime.picker.updates)).toBeInTheDocument();
    expect(screen.getByText(de.runtime.download.once)).toBeInTheDocument();
    // Erweitert is a collapsed disclosure: present, closed, its note not visible yet.
    const advanced = screen.getByText(de.runtime.picker.advanced);
    expect(advanced.closest('details')?.open).not.toBe(true);
  });

  it('PICKER: confirming calls runtime_select with the picked catalog model', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(tree(baseCanned(), asked));
    const confirm = await screen.findByRole('button', { name: de.runtime.picker.confirm });
    await userEvent.click(confirm);
    await waitFor(() => {
      const call = asked.find((entry) => entry.action === 'runtime_select');
      expect(call).toBeDefined();
      expect(call?.input.modelRef).toBe('stub-4b-q4');
      expect(call?.input.source).toBe('catalog');
      expect(typeof call?.input.idempotencyKey).toBe('string');
    });
  });

  it('READ-ONLY: without voice.write the picker renders read-only rather than disappearing', async () => {
    const canned = {
      ...baseCanned(),
      whoami: whoamiWith(['voice.read']),
      voice_profiles_list: ok({ profiles: [PROFILE()], total: 1 }),
    };
    render(tree(canned));
    expect(await screen.findByText(de.runtime.picker.title)).toBeInTheDocument();
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(screen.queryByRole('button', { name: de.runtime.picker.confirm })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: de.voice.action.rebuild })).not.toBeInTheDocument();
  });

  it('A11Y: the loaded surface has no axe violations', async () => {
    const { container } = render(
      tree({
        ...baseCanned(),
        voice_profiles_list: ok({ profiles: [PROFILE()], total: 1 }),
      }),
    );
    await screen.findByText('Guten Tag');
    expect(await axe(container)).toHaveNoViolations();
  });
});
