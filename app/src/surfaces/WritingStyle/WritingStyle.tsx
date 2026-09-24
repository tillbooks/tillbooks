/**
 * E05, Schreibstil (`/writing-style`): the voice profile and the local drafting engine's model
 * picker, one panel each.
 *
 * WHY IT IS A ROUTE OF ITS OWN: the spec asked for a panel on "Einstellungen"; there is no such
 * surface (D89, the settings-shaped screen is Setup and is A00's), so it lands as a rail item in
 * the workspace-governance cluster, the G00/G01 precedent (see nav.ts).
 *
 * THE HONESTY LINES, stated where they render: TILL reads sent mail ON THIS MAC and stores what
 * it LEARNED, never a copy (the corpus note); with no local runtime installed the panel says so
 * AND says no cloud model will be used instead (US-E05.4: the degraded path is the important
 * one); new models arrive via `npm update`, never an online check (the updates note); a model
 * over this machine's RAM renders DISABLED with the have/need figures IN PLACE, never hidden
 * (US-E05.5). Runtime state is the shared Status, glyph plus word, never colour alone (WCAG 2.2 AA).
 *
 * THE PERMISSION GATES HERE ARE A CONVENIENCE AND NOT THE ENFORCEMENT (the standing Studio rule):
 * `whoami` is the one source, it fails open, and the engine is the real gate. The learn/rebuild
 * action and the picker's confirm render only with `voice.write`; without it the picker renders
 * READ-ONLY rather than disappearing, so a read-only user still sees what is selected (spec §6).
 */
import { useCallback, useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatDate } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { Status } from '../../components/Status';
import { Select } from '../../components/Select';
import './WritingStyle.css';

/** A fresh key per write, so a retry after a transport failure is a retry and not a second write. */
const newKey = () => crypto.randomUUID();

interface StyleCard {
  greeting: string | null;
  signOff: string | null;
  formality: string;
  meanSentenceWords: number;
  medianReplyLines: number;
  languageMix: { de: number; en: number };
}

interface Profile {
  id: string;
  accountId: string;
  styleCard: StyleCard;
  exemplarCount: number;
  modelRef: string;
  builtAt: string;
}

interface RuntimeState {
  registered: boolean;
  runtimeId?: string;
  modelRef?: string;
  device?: string;
  reason?: string;
  selection: { modelRef: string; source: string } | null;
}

interface CatalogRow {
  modelRef: string;
  displayName: string;
  minRamGb: number;
  downloadBytes: number;
  licence: { spdx: string; commercialUse: boolean };
  qualityDe: string;
  qualityEn: string;
  qualityMeasured: boolean;
  fits: boolean;
  recommended: boolean;
}

interface Catalog {
  models: CatalogRow[];
  recommendedModelRef: string | null;
  machineRamGb: number;
  selection: { modelRef: string; source: string } | null;
}

interface MailAccount {
  id: string;
  address: string;
}

interface PickableFile {
  id: string;
  name: string;
  mime: string;
}

function parseProfiles(body: unknown): Profile[] {
  const profiles = (body as { profiles?: unknown })?.profiles;
  if (!Array.isArray(profiles)) return [];
  return profiles
    .filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object')
    .filter((p) => typeof p.id === 'string' && p.styleCard !== null && typeof p.styleCard === 'object')
    .map((p) => ({
      id: p.id as string,
      accountId: typeof p.accountId === 'string' ? p.accountId : '',
      styleCard: p.styleCard as unknown as StyleCard,
      exemplarCount: typeof p.exemplarCount === 'number' ? p.exemplarCount : 0,
      modelRef: typeof p.modelRef === 'string' ? p.modelRef : '',
      builtAt: typeof p.builtAt === 'string' ? p.builtAt : '',
    }));
}

function parseAccounts(body: unknown): MailAccount[] {
  const accounts = (body as { accounts?: unknown })?.accounts;
  if (!Array.isArray(accounts)) return [];
  return accounts
    .filter((a): a is Record<string, unknown> => a !== null && typeof a === 'object')
    .filter((a) => typeof a.id === 'string' && typeof a.address === 'string')
    .map((a) => ({ id: a.id as string, address: a.address as string }));
}

/** Text-shaped files only: the picker offers what the corpus can actually distil. */
function parseFiles(body: unknown): PickableFile[] {
  const files = (body as { files?: unknown })?.files;
  if (!Array.isArray(files)) return [];
  return files
    .filter((f): f is Record<string, unknown> => f !== null && typeof f === 'object')
    .filter((f) => typeof f.id === 'string' && typeof f.mime === 'string' && /^text\/|^application\/(json|xml|rtf)$/.test(f.mime))
    .map((f) => ({
      id: f.id as string,
      name: typeof f.title === 'string' && f.title.length > 0 ? f.title : typeof f.filename === 'string' ? f.filename : (f.id as string),
      mime: f.mime as string,
    }));
}

/** `2.4 GB` from bytes: a size a person compares, not a byte count. */
function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(Math.round((bytes / 1024 ** 3) * 10) / 10).toLocaleString('de-CH')} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

export function WritingStyle() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [stale, setStale] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [accountId, setAccountId] = useState('');
  const [files, setFiles] = useState<PickableFile[]>([]);
  const [pickedFileIds, setPickedFileIds] = useState<string[]>([]);
  const [pickedModel, setPickedModel] = useState('');
  const [ggufPath, setGgufPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);
  const [building, setBuilding] = useState(false);

  const canWrite = can(CAP.voiceWrite);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const [status, listed, mailAccounts, catalogRead, fileList] = await Promise.all([
      client.call('runtime_status', { workspaceId }),
      client.call('voice_profiles_list', { workspaceId }),
      client.call('mail_accounts_list', { workspaceId }),
      client.call('runtime_catalog', { workspaceId }),
      client.call('files_search', { workspaceId }),
    ]);
    if (isErr(listed.body)) {
      if (listed.body.error === 'permission_denied' || listed.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseProfiles(listed.body);
    setProfiles(parsed);
    if (!isErr(status.body)) setRuntime(status.body as unknown as RuntimeState);
    if (!isErr(mailAccounts.body)) {
      const list = parseAccounts(mailAccounts.body);
      setAccounts(list);
      setAccountId((current) => (current !== '' ? current : (list[0]?.id ?? '')));
    }
    // `needs_local_runtime` is a STATE here, not a failure: the status line already says it.
    if (!isErr(catalogRead.body)) {
      const parsedCatalog = catalogRead.body as unknown as Catalog;
      setCatalog(parsedCatalog);
      setPickedModel((current) =>
        current !== ''
          ? current
          : (parsedCatalog.selection?.modelRef ?? parsedCatalog.recommendedModelRef ?? ''),
      );
    } else {
      setCatalog(null);
    }
    if (!isErr(fileList.body)) setFiles(parseFiles(fileList.body));

    // Staleness rides the newest profile's own read.
    const newest = parsed[0];
    if (newest !== undefined) {
      const got = await client.call('voice_profile_get', { workspaceId, profileId: newest.id });
      if (!isErr(got.body)) setStale((got.body as unknown as { stale?: boolean }).stale === true);
    } else {
      setStale(false);
    }
    setLoading(false);
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const build = useCallback(async () => {
    if (workspaceId === null || accountId === '') return;
    setWriteError(null);
    setBuilding(true);
    const response = await client.call('voice_build', {
      workspaceId,
      accountId,
      ...(pickedFileIds.length === 0 ? {} : { documentIds: pickedFileIds }),
      idempotencyKey: newKey(),
    });
    setBuilding(false);
    if (isErr(response.body)) {
      setWriteError(response.body);
      return;
    }
    await load();
  }, [client, workspaceId, accountId, pickedFileIds, load]);

  const select = useCallback(
    async (input: Record<string, unknown>) => {
      if (workspaceId === null) return;
      setWriteError(null);
      const response = await client.call('runtime_select', { workspaceId, ...input, idempotencyKey: newKey() });
      if (isErr(response.body)) {
        setWriteError(response.body);
        return;
      }
      await load();
    },
    [client, workspaceId, load],
  );

  const errorMessage = (error: Err): string => {
    if (error.error === 'corpus_too_small') {
      return t('voice.error.corpus_too_small', { have: String(error.have ?? 0), need: String(error.need ?? 20) });
    }
    if (error.error === 'insufficient_ram') {
      return t('runtime.error.insufficient_ram', { need: String(error.needGb ?? '?'), have: String(error.haveGb ?? '?') });
    }
    const known = ['needs_local_runtime', 'needs_model_selection', 'unknown_model_ref'];
    if (known.includes(error.error)) return t(`runtime.error.${error.error}`);
    if (error.error === 'unknown_document') return t('voice.error.unknown_document');
    if (error.error === 'permission_denied') return t('voice.error.permissionDenied.write');
    return t('errors.fallback');
  };

  if (workspaceId === null) return <NoWorkspaceState />;
  if (denied) return <PermissionDenied body={t('voice.error.permissionDenied.read')} />;

  const registered = runtime?.registered === true;
  const newest = profiles[0];

  /** K-22: the runtime state as the shared Status, never a filled or hollow dot dingbat. */
  const statusLine = (
    <p className="voice-runtime-line">
      <Status
        kind={registered ? 'success' : 'inactive'}
        label={registered ? t('runtime.status.ready') : t('runtime.status.absent')}
        className="voice-runtime-state"
      />
      {registered && runtime?.modelRef !== undefined && (
        <span>
          {t('runtime.status.model')}: {runtime.modelRef}
          {runtime.device !== undefined ? ` (${runtime.device})` : ''}
        </span>
      )}
      {!registered && runtime?.reason !== undefined && <span>{t('runtime.status.reason', { reason: runtime.reason })}</span>}
    </p>
  );

  const styleCardView = (profile: Profile) => (
    <dl className="voice-card" aria-label={t('voice.panel.title')}>
      {profile.styleCard.greeting !== null && (
        <div className="voice-card-row">
          <dt>{t('voice.field.greeting')}</dt>
          <dd>{profile.styleCard.greeting}</dd>
        </div>
      )}
      {profile.styleCard.signOff !== null && (
        <div className="voice-card-row">
          <dt>{t('voice.field.signOff')}</dt>
          <dd>{profile.styleCard.signOff}</dd>
        </div>
      )}
      <div className="voice-card-row">
        <dt>{t('voice.field.formality')}</dt>
        <dd>{profile.styleCard.formality}</dd>
      </div>
      <div className="voice-card-row">
        <dt>{t('voice.field.meanSentenceWords')}</dt>
        <dd>{t('voice.field.meanSentenceWordsValue', { n: String(profile.styleCard.meanSentenceWords) })}</dd>
      </div>
      <div className="voice-card-row">
        <dt>{t('voice.field.languageMix')}</dt>
        <dd>
          {t('voice.field.languageMixValue', {
            de: String(profile.styleCard.languageMix.de),
            en: String(profile.styleCard.languageMix.en),
          })}
        </dd>
      </div>
      <div className="voice-card-row">
        <dt>{t('voice.field.exemplars')}</dt>
        <dd>{profile.exemplarCount}</dd>
      </div>
      <div className="voice-card-row">
        <dt>{t('voice.field.built_at')}</dt>
        <dd>{formatDate(profile.builtAt.slice(0, 10))}</dd>
      </div>
      <div className="voice-card-row">
        <dt>{t('voice.field.model')}</dt>
        <dd>{profile.modelRef}</dd>
      </div>
    </dl>
  );

  const buildControls = canWrite && registered && (
    <div className="voice-build">
      {accounts.length === 0 ? (
        <p className="voice-note">{t('voice.account.missing')}</p>
      ) : (
        <>
          {accounts.length > 1 && (
            <div className="voice-field">
              <span>{t('voice.account.label')}</span>
              <Select
                value={accountId}
                onChange={(val) => setAccountId(val)}
                options={accounts.map((account) => ({ value: account.id, label: account.address }))}
                ariaLabel={t('voice.account.label')}
              />
            </div>
          )}
          {files.length > 0 && (
            <details className="voice-documents">
              <summary>{t('voice.documents.title')}</summary>
              <p className="voice-note">{t('voice.documents.note')}</p>
              <ul className="voice-documents-list">
                {files.map((file) => (
                  <li key={file.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={pickedFileIds.includes(file.id)}
                        onChange={(e) =>
                          setPickedFileIds((current) =>
                            e.target.checked ? [...current, file.id] : current.filter((id) => id !== file.id),
                          )
                        }
                      />{' '}
                      {file.name}
                    </label>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <button type="button" className="btn btn--primary" disabled={building} onClick={() => void build()}>
            {newest === undefined ? t('voice.action.build') : t('voice.action.rebuild')}
          </button>
        </>
      )}
    </div>
  );

  const modelSection = registered && catalog !== null && (
    <section className="voice-models" aria-labelledby="voice-models-title">
      <h2 id="voice-models-title">{t('runtime.picker.title')}</h2>
      {catalog.selection !== null && (
        <p className="voice-note">{t('runtime.picker.selected', { model: catalog.selection.modelRef })}</p>
      )}
      <ul className="voice-model-list">
        {catalog.models.map((model) => (
          <li key={model.modelRef} className={`voice-model${model.fits ? '' : ' voice-model--disabled'}`}>
            <label>
              <input
                type="radio"
                name="voice-model"
                value={model.modelRef}
                checked={pickedModel === model.modelRef}
                disabled={!model.fits || !canWrite}
                aria-label={
                  model.fits
                    ? model.displayName
                    : `${model.displayName}: ${t('runtime.error.insufficient_ram', { need: String(model.minRamGb), have: String(catalog.machineRamGb) })}`
                }
                onChange={() => setPickedModel(model.modelRef)}
              />
              <span className="voice-model-name">
                {model.displayName}
                {model.recommended && <span className="voice-model-recommended"> {t('runtime.picker.recommended')}</span>}
              </span>
            </label>
            <p className="voice-model-facts">
              <span>{t('runtime.picker.german')}: {model.qualityMeasured ? model.qualityDe : `${model.qualityDe} (${t('runtime.picker.unmeasured')})`}</span>
              <span>{t('runtime.picker.ram', { gb: String(model.minRamGb) })}</span>
              <span>{t('runtime.picker.download', { size: formatSize(model.downloadBytes) })}</span>
              <span>{t('runtime.picker.licence')}: {model.licence.spdx}</span>
            </p>
            {!model.fits && (
              <p className="voice-model-refusal">
                {t('runtime.error.insufficient_ram', { need: String(model.minRamGb), have: String(catalog.machineRamGb) })}
              </p>
            )}
          </li>
        ))}
      </ul>
      <p className="voice-note">{t('runtime.download.once')}</p>
      <p className="voice-note">{t('runtime.picker.updates')}</p>
      {canWrite && (
        <button
          type="button"
          className="btn btn--secondary"
          disabled={pickedModel === ''}
          onClick={() => void select({ modelRef: pickedModel, source: 'catalog' })}
        >
          {t('runtime.picker.confirm')}
        </button>
      )}
      {canWrite && (
        <details className="voice-advanced">
          <summary>{t('runtime.picker.advanced')}</summary>
          <p className="voice-note">{t('runtime.picker.byo_note')}</p>
          <label className="voice-field">
            <span>{t('runtime.picker.byo')}</span>
            <input className="field" type="text" value={ggufPath} onChange={(e) => setGgufPath(e.target.value)} placeholder="/pfad/zu/modell.gguf" />
          </label>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={ggufPath.trim() === ''}
            onClick={() => void select({ source: 'byo', ggufPath: ggufPath.trim() })}
          >
            {t('runtime.picker.byo_confirm')}
          </button>
        </details>
      )}
    </section>
  );

  return (
    <section className="voice" aria-labelledby="voice-title">
      <SurfaceHeader
        title={t('voice.panel.title')}
        titleId="voice-title"
        help={<SurfaceHelp surface="WritingStyle" />}
      />

      {statusLine}
      {!registered && !loading && <p className="voice-no-cloud">{t('runtime.error.needs_local_runtime')}</p>}
      <p className="voice-corpus-note">{t('voice.corpus.note')}</p>

      {writeError !== null && <ErrorBanner message={errorMessage(writeError)} />}
      {failed && <ErrorBanner context="read" message={t('voice.error.transport')} onRetry={() => void load()} />}

      {loading ? (
        // Skeleton carries its own role="status" wrapper; a second one would double the landmark.
        <Skeleton rows={4} labelKey="voice.loading" />
      ) : failed ? null : (
        <>
          {newest === undefined ? (
            <div className="voice-empty">
              {/* K-33: the style is learned from sent mail, so with no mail store connected the one
                  action is the way to connect it, on Korrespondenz. */}
              <EmptyState
                title={t('voice.empty')}
                hint={t('voice.emptyHint')}
                action={accounts.length === 0 ? { label: t('voice.emptyAction'), to: '/correspondence' } : undefined}
              />
              {accounts.length > 0 && buildControls}
            </div>
          ) : (
            <div className="voice-profile">
              {stale && (
                <p className="voice-stale">
                  <Status kind="warn" label={t('voice.stale')} />
                </p>
              )}
              {styleCardView(newest)}
              {buildControls}
            </div>
          )}
          {modelSection}
        </>
      )}
    </section>
  );
}
export default WritingStyle;
