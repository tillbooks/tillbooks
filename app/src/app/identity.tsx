/**
 * M01, the signed-in-identity chrome and the served-access resolver pages.
 *
 * TILL is never an identity provider (spec M01 §1): a reverse proxy authenticates the caller and the
 * engine consumes ONE fact, the attested subject, mapping it onto A24's membership model. This module
 * is the Studio's face of that seam. It renders NOTHING of its own identity: every string it shows is
 * read VERBATIM from `whoami`, the one permission source (see `../lib/capabilities`). A laptop user
 * has no login, so in local mode this whole module is silent, which is the honest state and not a gap.
 *
 * Three pieces, all driven by the single `whoami` read the `CapabilitiesProvider` already performs:
 *  1. `IdentityChip`   the G15 shell-chrome chip: subject + role, served mode only. Focusable, and it
 *                      opens the details `whoami` returns (subject, role, identity source).
 *  2. `NotAMemberPage` the full-page "signed in as X, not a member here" state (US-M01.1 empty).
 *  3. `SignInRequiredPage` the 401-shape "sign-in required by your deployment" page (US-M01.1 error).
 * `IdentityGate` wires (2) and (3) in front of the routed surface, so a served stranger meets a proper
 * page with a heading rather than an empty ledger or a crash.
 *
 * NOTHING here fabricates identity. `identitySource` defaults to `local_client` (a laptop) when a test
 * double or an older payload omits it, which is the safe default: absent proof of a proxy, no login is
 * shown. The chip is chrome, so it fails inside its own slot boundary in the shell and never gates the
 * rail's first paint.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';

import './identity.css';
import { useT } from '../i18n';
import { useCapabilities, type Whoami } from '../lib/capabilities';
import { useClient } from '../lib/client-context';
import { isErr } from '../lib/client';
import { useWorkspace } from './workspace';
import { InboxGlyph, LockGlyph } from '../components/states/glyphs';
import { ThemeToggle } from '../components/ThemeToggle';
import { CapabilitiesProvider } from '../lib/CapabilitiesProvider';

/** True when the session's identity was attested by a reverse proxy (served mode), false on a laptop. */
function isServed(whoami: Whoami): boolean {
  return (whoami.identitySource ?? 'local_client') === 'served_subject';
}

/** The five built-in roles carry a word; a custom role has only its id, which then stays visible. */
const BUILTIN_ROLE_LABEL: Record<string, string> = {
  owner: 'identity.role.owner',
  viewer: 'identity.role.viewer',
  bookkeeper: 'identity.role.bookkeeper',
  treuhaender: 'identity.role.treuhaender',
  agent: 'identity.role.agent',
};

/**
 * The role in words for the chip (DESIGN.md: no raw enum value reaches the screen). A custom role
 * defined on the Rollen tab has no global label, so its id renders as-is: an operator's own name for
 * it, not a machine key. The raw id survives in the details disclosure beside the word.
 */
function roleLabel(t: (key: string) => string, role: string): string {
  const key = BUILTIN_ROLE_LABEL[role];
  return key === undefined ? role : t(key);
}

/**
 * A single-line glyph icon for the identity chip: a neutral person mark in `currentColor`, so it
 * inherits the chip's ink and never spends the accent. Decorative; the accessible name carries the
 * meaning (glyph plus text, never colour alone, WCAG 2.2 AA and the design law).
 */
function IdentityGlyph() {
  return (
    <svg
      className="rail-identity-glyph"
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

/**
 * The G15 shell-chrome identity chip.
 *
 * Renders in SERVED mode only: a local user has no login and must never be shown a fake one (spec §6),
 * so `local_client` and a null/absent subject both yield NO DOM. In served mode it shows the attested
 * subject plus the member's role, both verbatim from `whoami`. It is a real button (keyboard focusable,
 * shows the token focus ring) whose accessible name is "Signed in as {subject}"; activating it opens a
 * small disclosure with the details `whoami` returns. Esc and an outside click close it and return
 * focus to the chip.
 *
 * `iconOnly` is the collapsed-rail form: the glyph shows and the label rides only on the accessible
 * name, matching the trust indicator's icon form.
 */
export function IdentityChip({ iconOnly = false }: { iconOnly?: boolean }) {
  const t = useT();
  const { whoami } = useCapabilities();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();

  // Close on an outside pointer press or Esc, returning focus to the chip on Esc (spec §6: the
  // disclosure is keyboard operable). Registered only while open, so it costs nothing at rest.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Silent unless a reverse proxy vouches for a concrete subject (US-M01.1 boundary + the local case).
  if (whoami === null || !isServed(whoami)) return null;
  const subject = whoami.subject;
  if (subject === null || subject === undefined || subject === '') return null;

  const accessibleName = t('identity.signed_in_as', { subject });
  const role = whoami.role;

  return (
    <div className="rail-identity" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={iconOnly ? 'rail-identity-btn rail-identity-btn--icon' : 'rail-identity-btn'}
        aria-label={accessibleName}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <IdentityGlyph />
        {!iconOnly && (
          <span className="rail-identity-text">
            <span className="rail-identity-subject">{subject}</span>
            {role !== null && role !== '' && <span className="rail-identity-role">{roleLabel(t, role)}</span>}
          </span>
        )}
      </button>
      {open && (
        <div id={panelId} role="dialog" aria-label={t('identity.details.title')} className="rail-identity-details">
          <dl className="rail-identity-dl">
            <dt>{t('identity.details.subject')}</dt>
            <dd>{subject}</dd>
            {role !== null && role !== '' && (
              <>
                <dt>{t('identity.details.role')}</dt>
                <dd>
                  {roleLabel(t, role)}
                  {roleLabel(t, role) !== role && <code className="rail-identity-raw"> {role}</code>}
                </dd>
              </>
            )}
            <dt>{t('identity.details.source')}</dt>
            <dd>{t('identity.details.source_served')}</dd>
          </dl>
        </div>
      )}
    </div>
  );
}

/**
 * M03 invite (N4b): pull the token out of whatever the collaborator pasted.
 *
 * The field accepts either the bare token or the full invite link the owner copied off the Members
 * surface. A full link carries the token as its `invite` query parameter, so extraction is
 * CLIENT-SIDE and mechanical: if the value parses as a URL, its `invite` parameter is the token;
 * otherwise the trimmed value IS the token. Nothing here validates the token: the engine's
 * `accept_invite` is the arbiter, and a wrong guess renders as its inline refusal.
 */
export function extractInviteToken(raw: string): string {
  const value = raw.trim();
  if (value === '') return '';
  try {
    const url = new URL(value);
    const fromParam = url.searchParams.get('invite');
    if (fromParam !== null && fromParam.trim() !== '') return fromParam.trim();
  } catch {
    // Not a URL: the pasted value is the token itself.
  }
  return value;
}

/**
 * M03 invite (N4b): the deep-link prefill, captured ONCE at app bootstrap.
 *
 * A link like `/?invite=<token>` PREFILLS the redemption field and moves focus to the action, and
 * that is ALL it does: redemption stays a deliberate press of Einlösen, never an auto-redeem, so a
 * forwarded link is not a capability URL (spec M03 §4 V6; served mode's subject match is the second
 * rail).
 *
 * WHY A BOOTSTRAP STASH AND NOT A LOCATION READ AT MOUNT: the router's index route redirects `/` to
 * the first rail surface with a string `to` and `replace`, which drops the query string and erases
 * the history entry BEFORE `whoami` has answered and the not-a-member page has mounted. A page that
 * read `window.location` at mount would therefore always see the token already gone. So `main.tsx`
 * calls `captureInviteDeepLink()` before the router renders: the token is stashed in module state
 * and the parameter is stripped from the URL immediately (`history.replaceState`), which is also
 * the token hygiene the seam wants: a bearer-shaped token must not linger in the browser's history
 * or be re-sent in a referrer. The stash lives only in this tab's JS memory and dies with it.
 */
let stashedInviteToken = '';

export function captureInviteDeepLink(): void {
  try {
    const url = new URL(window.location.href);
    const token = url.searchParams.get('invite')?.trim() ?? '';
    // Always assign, so a capture over a token-less URL clears any previous stash (test isolation
    // and reload honesty: the stash never outlives the entry that carried it).
    stashedInviteToken = token;
    if (token === '') return;
    url.searchParams.delete('invite');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  } catch {
    // No usable location (a bare test environment): nothing to capture.
  }
}

/**
 * US-M01.1 empty: the caller authenticated at the proxy but matches no member row. A proper page with
 * a heading (never a toast, spec §6), naming the subject and pointing at the one way in: an invite
 * from an owner.
 *
 * M03 invite (N4b) extends the page with the invite redemption itself (spec M03 §2 S4.3 / §4 V6):
 * the identity fact stays first and keeps M01's copy, then the redemption control. The collaborator
 * pastes the token or the full link, presses Einlösen, and the page calls the EXISTING
 * `accept_invite` verb: on success the granted workspace is selected and `whoami` re-read, so the
 * page flips into the workspace shell without a restart (the IdentityGate re-evaluates the same
 * context this page rendered from). Every refusal renders INLINE with the field value retained
 * (S7.6: `invite_expired` with the ask-the-owner sentence; `invite_subject_mismatch` naming that the
 * invite was issued to a different address, with THIS page's subject verbatim; anything else as
 * "Dieser Code ist ungültig").
 */
export function NotAMemberPage({ subject }: { subject: string }) {
  const t = useT();
  const client = useClient();
  const caps = useCapabilities();
  const { setWorkspaceId } = useWorkspace();
  const fieldId = useId();
  const errorId = useId();
  const [value, setValue] = useState(() => stashedInviteToken);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actionRef = useRef<HTMLButtonElement | null>(null);
  // Focus the ACTION when a deep link prefilled the field (spec: prefill and focus, never redeem).
  // Runs once on mount; a page the collaborator typed into keeps the browser's natural focus.
  const prefilled = useRef(value !== '');
  useEffect(() => {
    if (prefilled.current) actionRef.current?.focus();
  }, []);

  async function redeem(event: FormEvent): Promise<void> {
    event.preventDefault();
    const token = extractInviteToken(value);
    if (token === '' || busy) return;
    setBusy(true);
    setError(null);
    const response = await client.call('accept_invite', { token });
    setBusy(false);
    if (isErr(response.body)) {
      const code = response.body.error;
      if (code === 'invite_expired') setError(t('identity.redeem.error.invite_expired'));
      else if (code === 'invite_subject_mismatch') setError(t('identity.redeem.error.invite_subject_mismatch', { subject }));
      else setError(t('identity.redeem.error.invalid'));
      return; // The field value is RETAINED on every refusal: nothing typed is destroyed.
    }
    // Success: enter the granted workspace and re-read `whoami`. The IdentityGate above re-renders
    // off the refreshed answer (isMember flips), so the shell appears with no restart (S4.3).
    // The workspaceId is GUARDED, not cast-and-trusted: a malformed ok body must not push a
    // non-string into the workspace store; the refresh alone still flips the gate for the
    // already-selected workspace.
    //
    // THE SESSION RESET IS LOAD-BEARING (S4.3). The served MCP face pins the resolved identity at
    // session OPEN (src/api/mcp-http.ts, M01's documented contract), so the post-accept `whoami`
    // on the OLD session still answers stranger and the page never flips. Dropping the session
    // here makes the refresh re-handshake, and the NEW session resolves the fresh membership.
    client.resetSession();
    stashedInviteToken = '';
    const grantedWorkspaceId = (response.body as unknown as { workspaceId?: unknown }).workspaceId;
    if (typeof grantedWorkspaceId === 'string' && grantedWorkspaceId !== '') setWorkspaceId(grantedWorkspaceId);
    caps.refresh();
  }

  return (
    <div className="state-panel panel" role="note">
      <InboxGlyph className="state-glyph" size={24} />
      <h1 className="state-title">{t('identity.not_a_member.title')}</h1>
      <p className="state-body">{t('identity.not_a_member.body', { subject })}</p>
      <form className="identity-redeem" onSubmit={(e) => void redeem(e)}>
        <p className="identity-redeem-lead">{t('identity.redeem.lead')}</p>
        <label className="identity-redeem-label" htmlFor={fieldId}>
          {t('identity.redeem.label')}
        </label>
        <div className="identity-redeem-row">
          <input
            id={fieldId}
            className="field"
            value={value}
            aria-describedby={error !== null ? errorId : undefined}
            aria-invalid={error !== null || undefined}
            onChange={(e) => setValue(e.target.value)}
          />
          <button
            ref={actionRef}
            type="submit"
            className="btn btn--accent"
            disabled={busy || extractInviteToken(value) === ''}
          >
            {t('identity.redeem.action')}
          </button>
        </div>
        {error !== null && (
          <p id={errorId} className="identity-redeem-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}

/**
 * US-M01.1 error: served mode but the request carried no attested subject. In practice the reverse
 * proxy answers this with its own 401 before the request reaches TILL, but the Studio handles the
 * 401-shape with a page rather than a crash, so a misconfigured proxy degrades to an explanation.
 */
export function SignInRequiredPage({ onRetry }: { onRetry?: () => void } = {}) {
  const t = useT();
  // F-11 / J8.4 (M03 S7.4's finding against M01): the ONE action out. The visitor signs in at the
  // proxy in another tab, then retries here; a retry is a full reload, because the proxy sets the
  // subject on the next request and the Studio's session must re-handshake to see it.
  const retry = onRetry ?? (() => window.location.reload());
  return (
    <div className="state-panel panel" role="note">
      <LockGlyph className="state-glyph" size={24} />
      <h1 className="state-title">{t('identity.error.title')}</h1>
      <p className="state-body">{t('identity.error.missing_subject')}</p>
      <p className="state-body">{t('identity.error.retry_hint')}</p>
      <button type="button" className="btn btn--accent" onClick={retry}>
        {t('identity.error.retry')}
      </button>
    </div>
  );
}

/**
 * F-11 / J6.4: the served-login pages are FULL pages, never a panel inside the workspace chrome.
 *
 * Measured in Phase 1: the not-a-member page rendered inside the whole rail tree, the palette
 * trigger and a workspace switcher reading the raw id, so every rail row was a door that would
 * refuse (DESIGN.md permission-denied: "the action that would fail is hidden, never shown and then
 * rejected"). This frame carries the app title, the theme toggle and the page, and nothing that
 * assumes a membership. The redemption control on the not-a-member page stays, because it is the
 * one act a stranger can perform.
 */
export function IdentityPageFrame({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <div className="identity-page">
      <header className="identity-page-head">
        <p className="identity-page-title">{t('app.title')}</p>
        <ThemeToggle />
      </header>
      <main id="main-content" className="identity-page-main">
        {children}
      </main>
    </div>
  );
}

/**
 * The shell-level served gate: decides, from ONE `whoami` read of its own provider, whether the
 * workspace frame renders at all. A served subject with no membership, or a served request with no
 * subject, meets its full page instead of the rail; every other case (local mode, a resolved member,
 * a pending or failed read, no workspace selected yet) renders the frame unchanged. The in-frame
 * `IdentityGate` stays as the second line for the beat between a refresh and a re-render.
 */
export function ServedShellGate({ children }: { children: ReactNode }) {
  return (
    <CapabilitiesProvider>
      <ServedShellDecision>{children}</ServedShellDecision>
    </CapabilitiesProvider>
  );
}

function ServedShellDecision({ children }: { children: ReactNode }) {
  const { whoami } = useCapabilities();
  if (whoami !== null && isServed(whoami)) {
    const subject = whoami.subject;
    if (subject === null || subject === undefined || subject === '') {
      return (
        <IdentityPageFrame>
          <SignInRequiredPage />
        </IdentityPageFrame>
      );
    }
    if (!whoami.isMember) {
      return (
        <IdentityPageFrame>
          <NotAMemberPage subject={subject} />
        </IdentityPageFrame>
      );
    }
  }
  return <>{children}</>;
}

/**
 * The resolver gate in front of the routed surface. It consumes the single `whoami` the
 * `CapabilitiesProvider` already read (never a second call, per the one-source rule) and decides:
 *
 *  - served mode, attested subject, NOT a member  -> the not-a-member page (US-M01.1 empty);
 *  - served mode reporting NO subject             -> the sign-in-required page (the 401-shape);
 *  - everything else                              -> the surface, unchanged.
 *
 * `whoami === null` (loading, a transient read failure, or no workspace selected yet) renders the
 * surface: this is chrome over A24's fail-open convenience gate, and blanking a working ledger over a
 * pending or failed read would be the more expensive mistake (see `../lib/capabilities`). Local mode
 * (`local_client`) always renders the surface: a header nobody vouches for grants nothing.
 */
export function IdentityGate({ children }: { children: ReactNode }) {
  const { whoami } = useCapabilities();
  if (whoami !== null && isServed(whoami)) {
    const subject = whoami.subject;
    if (subject === null || subject === undefined || subject === '') return <SignInRequiredPage />;
    if (!whoami.isMember) return <NotAMemberPage subject={subject} />;
  }
  return <>{children}</>;
}
