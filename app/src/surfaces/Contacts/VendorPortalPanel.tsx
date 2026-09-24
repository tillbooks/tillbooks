/**
 * F03, the vendor portal panel (US-F03.1/2/4 + the US-F03.3 advice READ), the operator's
 * grant-management section on a SUPPLIER contact's Portal tab, beside F02's customer panel.
 *
 * It LISTS the supplier's vendor grants (glyph+label status, never colour-only, WCAG 2.2 AA), CREATES
 * a scoped, expiring grant (showing the one-time link exactly once), REVOKES one, and shows the
 * "Sichtbar für Lieferant" preview: exactly the open POs (D02, status sent|received) and remittance
 * advices (A14/A17) the token exposes, read WORKSPACE-scoped by contact (never through the token), so
 * the operator sees precisely what the supplier sees. The hosted portal page is cloud-tier (OP4): the
 * OSS-core surface is the link artifact plus the "Hosting: Cloud-Stufe" notice.
 *
 * A24: create and revoke render only with `portal.manage` (the padlock pattern, never
 * shown-then-rejected). Without it the panel is READ-ONLY: the lists still read (they ride
 * `read_master_data`, the contact-detail domain). Creating a remittance advice is done from the
 * Payments surface (it needs a payment), not here: this panel READS the advices.
 */
import { useCallback, useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useT, formatMoney, formatDate } from '../../i18n';
import { useCan, CAP } from '../../lib/capabilities';
import { ErrorBanner, Skeleton } from '../../components/states';
import { Status, type StatusKind } from '../../components/Status';
import type { Err } from '../../lib/client';
import { idemKey, type Contact } from './model';

type GrantStatus = 'draft' | 'active' | 'revoked' | 'expired';

interface VendorGrant {
  id: string;
  status: GrantStatus;
  expiresAt: string;
}

interface PoPreview {
  id: string;
  number: string;
  status: string;
  currency: string;
  totalRappen: number;
  expectedOn: string | null;
}

interface AdvicePreview {
  id: string;
  paymentDate: string;
  currency: string;
  totalRappen: number;
}

/** ● Aktiv · ◐ Entwurf · ⊘ Widerrufen · ▼ Abgelaufen (spec §6: glyph + label, never colour-only). */
/** A grant's state as the one `Status` word (K-22): live, not yet live, or out of play. */
const STATUS_KIND: Record<GrantStatus, StatusKind> = {
  active: 'success',
  draft: 'neutral',
  revoked: 'inactive',
  expired: 'inactive',
};

export function VendorPortalPanel({ contact, workspaceId }: { contact: Contact; workspaceId: string }) {
  const t = useT();
  const client = useClient();
  const canManage = useCan(CAP.portalManage);

  const [grants, setGrants] = useState<VendorGrant[]>([]);
  const [pos, setPos] = useState<PoPreview[]>([]);
  const [advices, setAdvices] = useState<AdvicePreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Err | null>(null);

  const [expiresAt, setExpiresAt] = useState('');
  const [saving, setSaving] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);
  // The one-time link, shown exactly once after a successful create (spec §6: "wird nur einmal
  // angezeigt"). Never re-derivable, so it lives in component state and is never re-fetched.
  const [oneTimeLink, setOneTimeLink] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [gr, po, ad] = await Promise.all([
      client.call('vendor_portal_grants_list', { workspaceId, contactId: contact.id }),
      client.call('vendor_portal_pos', { workspaceId, contactId: contact.id }),
      client.call('vendor_portal_remittances', { workspaceId, contactId: contact.id }),
    ]);
    if (isErr(gr.body)) {
      setError(gr.body);
      setLoading(false);
      return;
    }
    const grantsRaw = (gr.body as unknown as { grants?: unknown }).grants;
    const posRaw = isErr(po.body) ? undefined : (po.body as unknown as { pos?: unknown }).pos;
    const advicesRaw = isErr(ad.body) ? undefined : (ad.body as unknown as { advices?: unknown }).advices;
    setGrants(Array.isArray(grantsRaw) ? (grantsRaw as VendorGrant[]) : []);
    setPos(Array.isArray(posRaw) ? (posRaw as PoPreview[]) : []);
    setAdvices(Array.isArray(advicesRaw) ? (advicesRaw as AdvicePreview[]) : []);
    setLoading(false);
  }, [client, workspaceId, contact.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createGrant() {
    if (expiresAt === '') return;
    setSaving(true);
    setWriteError(null);
    setOneTimeLink(null);
    const resp = await client.call('vendor_portal_grant', {
      workspaceId,
      contactId: contact.id,
      expiresAt,
      idempotencyKey: idemKey('vgrant'),
    });
    setSaving(false);
    if (isErr(resp.body)) {
      setWriteError(resp.body);
      return;
    }
    const link = (resp.body as { localLink?: unknown }).localLink;
    if (typeof link === 'string') setOneTimeLink(link);
    void load();
  }

  async function revoke(grantId: string) {
    setWriteError(null);
    const resp = await client.call('vendor_portal_revoke', {
      workspaceId,
      grantId,
      idempotencyKey: idemKey('vrevoke'),
    });
    if (isErr(resp.body)) {
      setWriteError(resp.body);
      return;
    }
    void load();
  }

  if (loading) return <Skeleton rows={4} />;

  return (
    <section className="ct-portal-section" aria-label={t('vendorPortal.section.title')}>
      <h3 className="ct-subsection-title">{t('vendorPortal.section.title')}</h3>
      {error !== null && <ErrorBanner error={error} context="read" />}
      {writeError !== null && <ErrorBanner error={writeError} />}

      {/* The one-time link, surfaced once (aria-label, keyboard-reachable). */}
      {oneTimeLink !== null && (
        <div className="ct-subsection">
          <div className="ct-field-row">
            <input className="field" readOnly value={oneTimeLink} aria-label={t('vendorPortal.notice.token_once')} />
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              aria-label={t('vendorPortal.link.copyLabel')}
              onClick={() => void navigator.clipboard?.writeText(oneTimeLink)}
            >
              {t('vendorPortal.link.copy')}
            </button>
          </div>
          <span className="ct-field-hint">{t('vendorPortal.notice.token_once')}</span>
        </div>
      )}

      {/* Create (US-F03.1). Hidden without portal.manage: the panel is then read-only (padlock). */}
      {canManage && (
        <div className="ct-subsection">
          <label className="ct-field-inner">
            <span className="ct-field-label">{t('vendorPortal.field.expiresAt')}</span>
            <input type="date" className="field" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </label>
          <button type="button" className="btn btn--primary btn--sm" disabled={saving || expiresAt === ''} onClick={() => void createGrant()}>
            {t('vendorPortal.action.grant')}
          </button>
          <span className="ct-field-hint">{t('vendorPortal.notice.cloud_tier')}</span>
        </div>
      )}

      {/* The grants list (US-F03.1/4). */}
      {grants.length === 0 ? (
        <p className="ct-empty-hint">{t('vendorPortal.empty.grants')}</p>
      ) : (
        <ul className="ct-portal-grants">
          {grants.map((g) => (
            <li key={g.id} className="ct-portal-grant">
              <Status kind={STATUS_KIND[g.status]} label={t(`vendorPortal.status.${g.status}`)} />
              <span className="ct-grant-expiry t-num">{formatDate(g.expiresAt)}</span>
              {canManage && g.status !== 'revoked' && g.status !== 'expired' && (
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => void revoke(g.id)}>
                  {t('vendorPortal.action.revoke')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* "Sichtbar für Lieferant" preview (US-F03.2/3): exactly what the token exposes. */}
      <div className="ct-subsection">
        <h4 className="ct-subsection-title">{t('vendorPortal.preview.title')}</h4>
        {pos.length === 0 ? (
          <p className="ct-empty-hint">{t('vendorPortal.empty.pos')}</p>
        ) : (
          <ul className="ct-portal-preview">
            {pos.map((p) => (
              <li key={p.id}>
                <span>{p.number}</span>
                <span>{t(`vendorPortal.poStatus.${p.status}`)}</span>
                <span className="t-money">{formatMoney(p.totalRappen, p.currency)}</span>
              </li>
            ))}
          </ul>
        )}
        {advices.length === 0 ? (
          <p className="ct-empty-hint">{t('vendorPortal.empty.remittances')}</p>
        ) : (
          <ul className="ct-portal-preview">
            {advices.map((a) => (
              <li key={a.id}>
                <span>{formatDate(a.paymentDate)}</span>
                <span className="t-money">{formatMoney(a.totalRappen, a.currency)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
