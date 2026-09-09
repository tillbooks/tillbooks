/**
 * K-13: the first-hour SETUP CARD on the Übersicht.
 *
 * THE DEFECT THIS EXISTS FOR. A freshly minted workspace lands on the Übersicht showing an all-zero
 * tile wall and an attention strip that tells a 90-second-old ledger "nothing is waiting for you",
 * with no next step anywhere on the page. The engine answers an empty workspace honestly (`ok:true`
 * with zero-state tiles, see `src/core/dashboards/dashboards.ts`), so the zeros are correct: what was
 * missing was a way FORWARD. This card is that way: while the books are empty it names the concrete
 * setup steps and links straight to the surface that does each one.
 *
 * WHEN IT SHOWS. Only while the workspace has no real data yet. "Real data" is read from the same
 * `dashboard_overview` payload the wall already loaded, so this composes nothing new and needs no
 * engine verb: a workspace has data as soon as ANY rendered tile carries a non-zero figure (a
 * posted balance, an open receivable, a logged minute). Every tile at zero (or degraded/absent) is
 * the fresh state. Once a real figure appears the card is gone for good on its own, so an
 * established workspace never sees it even if it was never dismissed.
 *
 * DISMISSAL IS A PER-VIEWER CONVENIENCE, not shared state. A hidden setup hint is one operator's
 * preference, so it lives in `localStorage`, keyed per workspace AND per user (the closest the app
 * has to a per-user preference until a real user-preference verb exists, mirroring
 * `app/nav-prefs.ts`). Storage can throw (Safari private mode, a hardened profile) or be empty, and
 * a Studio that cannot remember a dismissal must still render correctly, so every read/write is
 * wrapped and a failure reads as "not dismissed", never an exception.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { useWorkspaceId } from '../../app/workspace';
import { useCapabilities } from '../../lib/capabilities';
import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useT } from '../../i18n';
import type { DashboardTileView } from './Uebersicht';
import './SetupCard.css';

/**
 * F-09 (J1.1 ideal step 3): which of the first-hour steps the profile already answers. The card
 * reads `get_company_profile` once (one read, the verb the Setup surface itself drives) and marks the
 * profile step done when the legal form and the invoicing IBAN are stored, the MWST step done when a
 * method is stored. A step marked done keeps its link (the person may still want to look) and loses
 * its claim on the person's next click. A failed read marks nothing: unknown is not done.
 */
export interface SetupDone {
  profile: boolean;
  vat: boolean;
}

export function setupDoneFrom(profile: { legalForm?: string | null; creditorIban?: string | null; vatMethod?: string | null } | null): SetupDone {
  if (profile === null) return { profile: false, vat: false };
  return {
    profile: typeof profile.legalForm === 'string' && typeof profile.creditorIban === 'string' && profile.creditorIban.length > 0,
    vat: typeof profile.vatMethod === 'string',
  };
}

/** The `localStorage` key prefix for a dismissed setup card. One entry per workspace-and-user scope,
 *  a sibling of the `till-nav-*` preference entries. */
export const SETUP_CARD_DISMISSED_KEY_PREFIX = 'till-setup-card-dismissed:';

/** The scope a dismissal is filed under: the workspace AND the user, so one operator hiding the card
 *  never hides it for a colleague on the same books. A null id (no workspace selected, or a laptop
 *  user with no login) falls back to a stable segment rather than colliding with a real id. */
function scopeKey(workspaceId: string | null, userId: string | null): string {
  return `${SETUP_CARD_DISMISSED_KEY_PREFIX}${workspaceId ?? 'global'}:${userId ?? 'local'}`;
}

/** Read whether this viewer dismissed the card on these books. Any storage failure reads as "not
 *  dismissed", so a hardened profile shows the card rather than crashing. */
export function readSetupCardDismissed(workspaceId: string | null, userId: string | null): boolean {
  try {
    return window.localStorage.getItem(scopeKey(workspaceId, userId)) === '1';
  } catch {
    return false;
  }
}

/** Persist this viewer's dismissal. Never throws: a Studio that cannot remember the choice simply
 *  shows the card again next load, which is a far smaller failure than an exception on the landing page. */
export function writeSetupCardDismissed(workspaceId: string | null, userId: string | null): void {
  try {
    window.localStorage.setItem(scopeKey(workspaceId, userId), '1');
  } catch {
    // A landing page that cannot persist a dismissal still renders and still navigates.
  }
}

/**
 * Does the workspace already carry real data? True as soon as any rendered (`ok`) tile shows a
 * non-zero figure, in either the money form (`valueRappen`) or the ratio form (`valueBp`). A
 * degraded tile (`ok:false`, an unconfigured module) and a zero-valued tile both read as "still
 * empty", which is exactly the fresh state the card is for.
 */
export function workspaceHasData(tiles: readonly DashboardTileView[]): boolean {
  return tiles.some(
    (tile) =>
      tile.ok &&
      ((typeof tile.valueRappen === 'number' && tile.valueRappen !== 0) ||
        (typeof tile.valueBp === 'number' && tile.valueBp !== 0)),
  );
}

/** One setup step: the surface it links to and the message key for its label. The order is the
 *  natural setup sequence: identify the company, then its tax basis, then the accounts those postings
 *  land in, then the master data (contacts, items) a first document needs, then that first document. */
const SETUP_STEPS: readonly { to: string; labelKey: string; done?: keyof SetupDone }[] = [
  { to: '/setup', labelKey: 'dashboard.setup.step.profile', done: 'profile' },
  { to: '/vat', labelKey: 'dashboard.setup.step.vat', done: 'vat' },
  { to: '/accounts', labelKey: 'dashboard.setup.step.accounts' },
  { to: '/contacts', labelKey: 'dashboard.setup.step.contacts' },
  { to: '/items', labelKey: 'dashboard.setup.step.items' },
  { to: '/documents', labelKey: 'dashboard.setup.step.invoice' },
];

/**
 * The setup card. Renders nothing once the workspace has data or this viewer dismissed it, so the
 * caller can mount it unconditionally on a loaded overview and let the card decide.
 */
export function SetupCard({ tiles }: { tiles: readonly DashboardTileView[] }) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { whoami } = useCapabilities();
  const userId = whoami?.userId ?? null;

  const [dismissed, setDismissed] = useState<boolean>(() => readSetupCardDismissed(workspaceId, userId));
  const [done, setDone] = useState<SetupDone>({ profile: false, vat: false });

  // Re-read the remembered dismissal when the scope (workspace or user) changes, so switching books
  // does not carry one workspace's dismissal onto another's fresh setup card. Also clear `done`
  // SYNCHRONOUSLY: the async profile read below (no key={workspaceId} remount) only re-populates
  // `done` once it resolves, so without this reset mandate A's "erledigt" paints over mandate B for
  // the window before B's read returns. The async effect then fills in B's real state.
  useEffect(() => {
    setDismissed(readSetupCardDismissed(workspaceId, userId));
    setDone({ profile: false, vat: false });
  }, [workspaceId, userId]);

  // F-09: one profile read decides which first-hour steps are already answered.
  useEffect(() => {
    if (workspaceId === null || workspaceId === '') return;
    let live = true;
    void client.call('get_company_profile', { workspaceId }).then((resp) => {
      if (!live) return;
      if (isErr(resp.body)) return;
      const { profile } = resp.body as { profile?: { legalForm?: string | null; creditorIban?: string | null; vatMethod?: string | null } };
      const next = setupDoneFrom(profile ?? null);
      // Set unconditionally: the card is not remounted on a workspace change (no key={workspaceId}),
      // so its `done` survives a mandate switch. The old guard skipped the write on an all-false
      // profile, which left the previous mandate's done in place and showed "erledigt" over an
      // unconfigured step on the fresh books. Writing every time costs at most one extra render on a
      // bare profile, a price worth paying to never carry a stale done across the switch.
      setDone(next);
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId]);

  if (dismissed) return null;
  if (workspaceHasData(tiles)) return null;

  const dismiss = () => {
    writeSetupCardDismissed(workspaceId, userId);
    setDismissed(true);
  };

  return (
    <section className="setup-card" aria-labelledby="setup-card-title">
      <div className="setup-card-head">
        <h2 id="setup-card-title" className="setup-card-title">
          {t('dashboard.setup.title')}
        </h2>
        <button type="button" className="setup-card-dismiss" onClick={dismiss}>
          {t('dashboard.setup.dismiss')}
        </button>
      </div>
      <p className="setup-card-lead">{t('dashboard.setup.lead')}</p>
      <ol className="setup-card-steps">
        {SETUP_STEPS.map((step) => {
          const isDone = step.done !== undefined && done[step.done];
          return (
            <li key={step.to} data-done={isDone ? 'true' : undefined}>
              <Link to={step.to} className="setup-card-step" aria-describedby={isDone ? `setup-card-done-${step.done}` : undefined}>
                <span className="setup-card-step-label">{t(step.labelKey)}</span>
                {isDone ? (
                  // Done is said in words and a glyph, never colour alone; the link stays a link.
                  <span id={`setup-card-done-${step.done}`} className="setup-card-step-done">
                    {t('dashboard.setup.done')}
                  </span>
                ) : (
                  <span className="setup-card-step-go" aria-hidden="true">
                    ›
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export default SetupCard;
