/**
 * O00 (D199): What's new after an update, in the Studio.
 *
 * ONE TOAST, bottom right, and only when this install has notes it has not seen ("Aktualisiert auf"): a short
 * title, the What's new button and the close glyph (DESIGN.md cognitive load, rule 7).
 *
 * The notes dialog lists versions newest first: a quiet version and date line, then per item the art tile
 * (the item's glyph on a soft brass tile, the kind as a badge and as screen-reader text), a title and one
 * sentence; an item with a Studio route ends in Öffnen. The version line in the rail menu opens the same
 * list with the recent versions.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useI18n } from '../i18n';
import { useClient } from '../lib/client-context';
import { useWorkspaceId } from '../app/workspace';
import { IconButton } from './IconButton';
import { Modal } from './Modal';
import { RELEASE_GLYPHS, RELEASE_KIND_GLYPHS, type ReleaseIconName, type ReleaseKind } from './icons/releases';
import './WhatsNew.css';

export interface NoteItemView {
  kind: ReleaseKind;
  icon: ReleaseIconName;
  title: string | { en: string; 'de-CH': string };
  body: string | { en: string; 'de-CH': string };
  go?: string | null;
}

export interface NoteEntryView {
  version: string;
  date?: string | null;
  items: NoteItemView[];
}

export interface WhatsNewState {
  version: string;
  seen: string;
  unseen: NoteEntryView[];
  recent: NoteEntryView[];
  toast: boolean;
  releasesUrl: string;
}

/** Reads `whats_new` for the open workspace and marks the notes seen. */
export function useReleases(): { notes: WhatsNewState | null; markSeen: () => void } {
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { locale } = useI18n();
  const [notes, setNotes] = useState<WhatsNewState | null>(null);

  useEffect(() => {
    if (workspaceId === null) return;
    let live = true;
    void client.call('whats_new', { workspaceId, locale }).then(
      (r) => { if (live && r.body.ok) setNotes(r.body as unknown as WhatsNewState); },
      () => undefined,
    );
    return () => { live = false; };
  }, [client, workspaceId, locale]);

  const markSeen = useCallback(() => {
    setNotes((n) => (n === null ? n : { ...n, unseen: [] }));
    if (workspaceId !== null) void client.call('whats_new_mark_seen', { workspaceId }).catch(() => undefined);
  }, [client, workspaceId]);

  return { notes, markSeen };
}

function textOf(text: NoteItemView['title'], locale: string): string {
  return typeof text === 'string' ? text : locale.startsWith('de') ? text['de-CH'] : text.en;
}

function formatDate(date: string | null | undefined, locale: string): string {
  if (date === null || date === undefined) return '';
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(locale.startsWith('de') ? 'de-CH' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}

/** The list of versions, newest first. `onGo` runs an item's "Show me". */
export function NotesList({ entries, releasesUrl, onGo }: { entries: NoteEntryView[]; releasesUrl?: string | undefined; onGo?: ((route: string) => void) | undefined }) {
  const { t, locale } = useI18n();
  if (entries.length === 0) return <p className="whatsnew-empty">{t('releases.notes.empty')}</p>;
  return (
    <div className="whatsnew-list" data-testid="whats-new-list">
      {entries.map((entry) => (
        <section key={entry.version} className="whatsnew-version" aria-label={entry.version === 'unreleased' ? t('releases.notes.unreleased') : entry.version}>
          <h3 className="whatsnew-version-line">
            <span className="whatsnew-version-name">{entry.version === 'unreleased' ? t('releases.notes.unreleased') : entry.version}</span>
            <span className="whatsnew-version-date">{formatDate(entry.date, locale)}</span>
          </h3>
          <ul className="whatsnew-items">
            {entry.items.map((item, i) => {
              const Art = RELEASE_GLYPHS[item.icon] ?? RELEASE_GLYPHS.sparkle;
              const Kind = RELEASE_KIND_GLYPHS[item.kind] ?? RELEASE_KIND_GLYPHS.new;
              const title = textOf(item.title, locale);
              return (
                <li key={`${entry.version}-${i}`} className="whatsnew-item">
                  <span className="whatsnew-art" aria-hidden="true">
                    <Art size={24} />
                    <span className="whatsnew-kind"><Kind size={16} /></span>
                  </span>
                  <span className="whatsnew-text">
                    <span className="whatsnew-title">
                      <span className="visually-hidden">{t(`releases.kind.${item.kind}`)}: </span>
                      {title}
                    </span>
                    <span className="whatsnew-body">{textOf(item.body, locale)}</span>
                  </span>
                  {typeof item.go === 'string' && onGo !== undefined ? (
                    <IconButton icon="open" name={t('releases.notes.show')} context={title} small onClick={() => onGo(item.go as string)} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {releasesUrl !== undefined ? (
        <p className="whatsnew-all">
          <a href={releasesUrl} target="_blank" rel="noopener noreferrer">{t('releases.notes.all')}</a>
        </p>
      ) : null}
    </div>
  );
}

/** The shell's one What's new toast (mounted once in `Shell.tsx`). */
export function ReleaseToast() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { notes, markSeen } = useReleases();
  const [open, setOpen] = useState(false);

  const go = (route: string) => {
    setOpen(false);
    markSeen();
    navigate(route);
  };

  if (notes === null) return null;
  return (
    <>
      {notes.toast && notes.unseen.length > 0 && !open ? (
        <div className="whatsnew-toast" role="status" data-kind="updated">
          <span className="whatsnew-toast-title">{t('releases.toast.updated', { version: notes.version })}</span>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => setOpen(true)}>{t('releases.notes.title')}</button>
          <IconButton icon="close" context={t('releases.toast.dismiss')} small onClick={markSeen} />
        </div>
      ) : null}
      {open ? (
        <Modal open onClose={() => { setOpen(false); markSeen(); }} title={t('releases.notes.title')} closeLabel={t('releases.close')}>
          <NotesList entries={notes.unseen} releasesUrl={notes.releasesUrl} onGo={go} />
        </Modal>
      ) : null}
    </>
  );
}

/** The rail menu's version line opens this: the recent release notes. */
export function VersionDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { notes } = useReleases();
  return (
    <Modal open onClose={onClose} title={t('releases.version', { version: notes?.version ?? '' })} closeLabel={t('releases.close')}>
      <NotesList entries={notes?.recent ?? []} releasesUrl={notes?.releasesUrl} onGo={(route) => { onClose(); navigate(route); }} />
    </Modal>
  );
}
