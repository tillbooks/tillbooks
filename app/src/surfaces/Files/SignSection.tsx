/**
 * E01, the "Signatur" section of the file drawer: request, track and complete signatures on the
 * open file. One component, hosted by `FileDrawer` (spec §6: no new route, a sign request is
 * meaningless without its file, and the drawer is where the operator already is).
 *
 * EVERY STATUS IS GLYPH PLUS TEXT and never colour alone: the shared `Status` word (K-22, D137), an
 * icon-set glyph beside the translated label, the text carrying the meaning. Entwurf is neutral,
 * Gesendet and Angesehen are under way, Signiert is done, Abgelehnt refused and Abgelaufen out of play.
 *
 * THE PERMISSION SPLIT IS RENDERED, NOT INVENTED (US-E01.2): without `sign.write` the request CTA
 * and every row action are hidden (never shown-then-rejected); without `sign.send` the Senden
 * button renders DISABLED with the Berechtigung-fehlt hint, deliberately visible, because a
 * Treuhänder who prepares requests must see that sending exists and what it requires. The engine's
 * ALL-OF gate is the one that decides.
 *
 * THE `needs_provider` REFUSAL IS AN AFFORDANCE, NOT AN ERROR (P9/OP4): the OSS core ships no
 * provider, so the honest rendering is "connect a provider (cloud) or complete manually", next to
 * the manual **Signiert markieren** upload that keeps the whole lifecycle usable offline.
 *
 * The QES/SES hint under the level picker states the OR Art. 14 boundary plainly: QES equals a
 * handwritten signature and is needed only where the law mandates written form; SES does not
 * satisfy statutory written-form requirements. E01 never claims form equivalence for SES.
 */
import { useState } from 'react';
import type { SVGProps } from 'react';

import { useT, formatDate } from '../../i18n';
import { ErrorBanner } from '../../components/states';
import { FileDrop } from '../../components/FileDrop';
import { Select } from '../../components/Select';
import { Status, type StatusKind } from '../../components/Status';
import type { Err } from '../../lib/client';

type GlyphProps = SVGProps<SVGSVGElement> & { size?: number };

function frame({ size = 14, ...rest }: GlyphProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
    ...rest,
  };
}

/** ⊘ permission missing: the barred circle, beside its text hint. */
function BarredGlyph(props: GlyphProps) {
  return (
    <svg {...frame(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.6 5.6l12.8 12.8" />
    </svg>
  );
}

/** A sign request's state as the one `Status` word (K-22). */
const STATUS_KIND: Record<string, StatusKind> = {
  draft: 'neutral',
  sent: 'pending',
  viewed: 'pending',
  signed: 'success',
  declined: 'danger',
  expired: 'inactive',
};

/** One sign request as `sign_requests_list` projects it, plus the envelope's signer identity. */
export interface SignRequestItem {
  id: string;
  status: string;
  signatureLevel: string;
  signerName: string | null;
  signerEmail: string;
  message: string | null;
  expiresAt: string | null;
  declinedReason: string | null;
  expiredReason: string | null;
  signedFileId: string | null;
}

export interface SignContact {
  id: string;
  name: string;
  email: string | null;
}

export interface SignSectionProps {
  /** null while the list read is in flight. */
  requests: SignRequestItem[] | null;
  /** The signer picker's options (C00 contacts; those without an email render disabled). */
  contacts: SignContact[];
  canWrite: boolean;
  canSend: boolean;
  busy: boolean;
  /** The engine's own refusal for whatever was last attempted here, or null. */
  error: Err | null;
  onCreate(input: { signerContactId: string; signatureLevel: string; message?: string; expiresAt?: string }): void;
  onSend(signRequestId: string): void;
  onMarkSigned(signRequestId: string, picked: File): void;
  onDecline(signRequestId: string): void;
  onWithdraw(signRequestId: string): void;
  onDeleteDraft(signRequestId: string): void;
}

export function SignSection({
  requests,
  contacts,
  canWrite,
  canSend,
  busy,
  error,
  onCreate,
  onSend,
  onMarkSigned,
  onDecline,
  onWithdraw,
  onDeleteDraft,
}: SignSectionProps) {
  const t = useT();
  const [formOpen, setFormOpen] = useState(false);
  const [signerId, setSignerId] = useState('');
  const [level, setLevel] = useState('ses');
  const [message, setMessage] = useState('');
  const [expiresAt, setExpiresAt] = useState('');

  const errorMessage =
    error === null
      ? null
      : error.error === 'needs_provider'
        ? t('sign.error.needs_provider')
        : error.error === 'request_already_open'
          ? t('sign.error.request_already_open')
          : error.error === 'expiry_in_past'
            ? t('sign.error.expiry_in_past')
            : error.error === 'document_hash_mismatch'
              ? t('sign.error.document_hash_mismatch')
              : error.error === 'signer_email_missing'
                ? t('sign.error.signer_email_missing')
                : error.error === 'not_head_version'
                  ? t('files.error.not_head_version')
                  : error.error === 'invalid_transition'
                    ? t('sign.error.invalid_transition')
                    : error.error === 'permission_denied'
                      ? t('files.error.permissionDenied.write')
                      : t('errors.fallback');

  return (
    <section className="files-section" aria-labelledby="files-sign-heading">
      <h3 id="files-sign-heading" className="files-section-title">
        {t('sign.section.title')}
      </h3>

      {/* The `needs_provider` degradation renders as the connect affordance plus the manual
          fallback hint, never as a raw error (spec §6 states). Everything else is the engine's own
          refusal, rendered where it was attempted. */}
      {errorMessage !== null && <ErrorBanner message={errorMessage} />}

      {requests === null ? (
        <p className="files-muted" role="status" aria-busy="true">
          {t('sign.loading')}
        </p>
      ) : requests.length === 0 && !formOpen ? (
        <p className="files-muted">{t('sign.empty')}</p>
      ) : (
        <ul className="files-versions sign-list">
          {requests.map((request) => {
            return (
              <li key={request.id} className="files-version sign-row">
                <Status kind={STATUS_KIND[request.status] ?? 'neutral'} label={t(`sign.status.${request.status}`)} />
                <span className="sign-signer">{request.signerName ?? request.signerEmail}</span>
                <span className="files-muted">{t(`sign.levelShort.${request.signatureLevel}`)}</span>
                {request.expiresAt !== null && request.status !== 'signed' && (
                  <span className="files-num">{formatDate(request.expiresAt)}</span>
                )}
                {request.status === 'declined' && request.declinedReason !== null && (
                  <span className="files-muted">{request.declinedReason}</span>
                )}
                {request.status === 'expired' && request.expiredReason === 'withdrawn' && (
                  <span className="files-muted">{t('sign.status.withdrawnHint')}</span>
                )}
                {canWrite && (request.status === 'draft' || request.status === 'sent' || request.status === 'viewed') && (
                  <span className="sign-row-actions">
                    {request.status === 'draft' &&
                      (canSend ? (
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          disabled={busy}
                          onClick={() => onSend(request.id)}
                        >
                          {t('sign.action.send')}
                        </button>
                      ) : (
                        /* DISABLED, not hidden: the split exists so a preparer can see what sending
                           requires. Glyph AND text on the hint. */
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          disabled
                          title={t('sign.hint.sendDenied')}
                        >
                          <BarredGlyph size={12} /> {t('sign.action.send')}
                        </button>
                      ))}
                    <FileDrop
                      variant="button"
                      label={t('sign.action.mark_signed')}
                      onFiles={(picked) => {
                        const first = picked[0];
                        if (first !== undefined) onMarkSigned(request.id, first);
                      }}
                    />
                    {request.status === 'draft' ? (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={busy}
                        onClick={() => onDeleteDraft(request.id)}
                      >
                        {t('sign.action.delete_draft')}
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={busy}
                          onClick={() => onWithdraw(request.id)}
                        >
                          {t('sign.action.withdraw')}
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={busy}
                          onClick={() => onDecline(request.id)}
                        >
                          {t('sign.action.mark_declined')}
                        </button>
                      </>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Hidden entirely without sign.write (permission-denied face, US-E01.1). */}
      {canWrite && !formOpen && (
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => setFormOpen(true)}>
          {t('sign.action.request')}
        </button>
      )}

      {canWrite && formOpen && (
        <form
          className="files-field sign-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (signerId === '') return;
            onCreate({
              signerContactId: signerId,
              signatureLevel: level,
              ...(message.trim() === '' ? {} : { message: message.trim() }),
              ...(expiresAt === '' ? {} : { expiresAt }),
            });
            setFormOpen(false);
            setSignerId('');
            setMessage('');
            setExpiresAt('');
          }}
        >
          <label className="files-label" htmlFor="sign-signer">
            {t('sign.form.signer')}
          </label>
          {/* A contact without an email is offered DISABLED with the reason in the label: the engine
             would refuse it (`signer_email_missing`), and hiding it would make the picker look like
             the register lost a contact. */}
          <Select
            id="sign-signer"
            className="field"
            value={signerId}
            onChange={(val) => setSignerId(val)}
            options={[
              { value: '', label: t('sign.form.signerPlaceholder') },
              ...contacts.map((contact) => ({
                value: contact.id,
                label:
                  contact.email === null || contact.email === ''
                    ? `${contact.name} (${t('sign.form.noEmail')})`
                    : contact.name,
                disabled: contact.email === null || contact.email === '',
              })),
            ]}
            ariaLabel={t('sign.form.signer')}
          />

          <label className="files-label" htmlFor="sign-level">
            {t('sign.form.level')}
          </label>
          <Select
            id="sign-level"
            className="field"
            value={level}
            onChange={(val) => setLevel(val)}
            options={[
              { value: 'ses', label: t('sign.level.ses') },
              { value: 'qes', label: t('sign.level.qes') },
            ]}
            ariaLabel={t('sign.form.level')}
          />
          {/* The statutory boundary, stated per selected level (spec §3): never colour, never a
              tooltip-only fact. */}
          <p className="files-muted sign-level-hint">{level === 'qes' ? t('sign.hint.qes') : t('sign.hint.ses')}</p>

          <label className="files-label" htmlFor="sign-message">
            {t('sign.form.message')}
          </label>
          <input
            id="sign-message"
            type="text"
            className="field"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />

          <label className="files-label" htmlFor="sign-expires">
            {t('sign.form.expires')}
          </label>
          <input
            id="sign-expires"
            type="date"
            className="field"
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
          />

          <div className="sign-form-actions">
            <button type="submit" className="btn btn--secondary btn--sm" disabled={signerId === '' || busy}>
              {t('sign.form.submit')}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setFormOpen(false)}>
              {t('files.action.cancel')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
