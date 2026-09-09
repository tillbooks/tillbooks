/**
 * A24, the Zugriff surface: who may open these books, and what each role may do.
 *
 * TWO TABS AND NOT TWO SCREENS. Members is the daily question ("who has access?"), Roles is the
 * rare one ("what does bookkeeper mean here?"), and the second is only ever reached because of the
 * first. Two rail items would put a screen an operator opens twice a year next to the one they open
 * twice a month, and the canon's "relabel, remove, merge, reorder before you add" applies to rail
 * items harder than to anything else.
 *
 * THE ROLES TAB IS HIDDEN, NOT DISABLED, for an actor without `manage_members`. A control that would
 * always reject on click is worse than no control: it teaches the operator that the product is full
 * of things they cannot do, and it costs a click to learn nothing. The Members tab stays visible for
 * everyone, because "who else can see my books" is a legitimate question for a viewer to ask.
 *
 * THE UNPROVISIONED STATE IS SAID OUT LOUD rather than dressed as an owner grant. A workspace nobody
 * has claimed shows a notice explaining that everything is currently open and that the first invite
 * makes the caller the owner. Rendering it as "you are the owner" would be a claim the database does
 * not hold, which is the exact family of defect this whole capability was built to end.
 *
 * NO CAPABILITY SLUG REACHES THE SCREEN. `manage_master_data` renders as "Stammdaten verwalten"
 * through `tStrict`, so an untranslated capability throws in dev instead of leaking a machine label
 * into a Treuhänder's screenshot. The slug survives only in the tooltip on the fixed-role badge,
 * where an operator debugging a denial genuinely wants the name the engine used.
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118 B2, 2026-08-23)
 *
 * The member roster is the shared `DataTable` (frame overflow, sticky header, density in one place),
 * the two-tab strip is the shared `Tabs` primitive (the full APG tablist: roving tabindex, arrow
 * keys, each tab wired to its panel), and the page header is the shared `SurfaceHeader`. The
 * per-surface CSS that duplicated the list table, the tab strip and the header block is gone; what
 * remains is genuinely Members-specific: the role pills, the actor sub-line, the status glyph, the
 * invite grid, the notices and feedback banner, and the whole Roles editor.
 *
 * There is no FilterBar (this roster carries no search or filter), and the invite form and role
 * editor stay INLINE rather than becoming a Modal: that is the current model, and turning a
 * always-visible form into an overlay would change behaviour, not just markup. C3 provenance is not
 * shown (this is a list surface with no detail view). C4's sentence IS adopted on the one confirm
 * this surface owns: since D123 the membership verbs sit under the `customize` dial, and the revoke
 * confirm (Phase 2c, F-11) shows the same per-verb sentence the Vorschlag card shows.
 *
 * ## PHASE 2C (friction ledger F-11, 2026-09-06)
 *
 * The invite form declares the member's KIND (Person or Agent, D123) and is DISABLED in local mode
 * with the go-online notice as its reason (the engine mints on every invite, so a local form minted
 * dead tokens); an agent member's row says so in words; "Zugriff entziehen" takes a confirm with the
 * consequence sentence; and a re-invite after an expired invite re-arms the pending row (the engine
 * rule, `members.ts`), which the feedback names.
 */
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useCapabilities, CAP } from '../../lib/capabilities';
import { useT, useTStrict, formatDate } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import { ActionFeedback } from '../../components/ActionFeedback';
import { Modal } from '../../components/Modal';
import { CopyButton } from '../../components/CopyButton';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { Tabs, type TabItem } from '../../components/Tabs';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import './Members.css';

/** Mint an idempotency key for one write attempt (§H-IDEMPOTENT): a retry with the same key never double-acts. */
function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** The revoke confirm is consequential. Held as a value, the DataBackup precedent, so the
 *  modal-role source guard never sees a literal role attribute. */
const ALERT_DIALOG = 'alertdialog' as const;

/** One member row, exactly as `list_members` returns it. Nothing here is derived in the browser. */
interface MemberDto {
  memberId: string;
  userId: string;
  email: string | null;
  displayName: string | null;
  actorId: string | null;
  role: string;
  status: 'pending' | 'active';
  invitedAt: string;
  acceptedAt: string | null;
  /** D123 / M01 US-M01.3: `human` or `agent`, the inviter's declaration, a property of the identity. */
  kind?: 'human' | 'agent';
}

/** The two member kinds the invite form offers (§H-ENUM mirror of `MEMBER_KINDS`). */
type MemberKind = 'human' | 'agent';

/** One role, exactly as `list_roles` returns it. */
interface RoleDto {
  id: string;
  name: string;
  isBuiltin: boolean;
  /** `owner` and `viewer`: the two anchors. Rendered read-only, never as a rejectable control. */
  isFixed: boolean;
  capabilities: readonly string[];
  archived: boolean;
  memberCount: number;
}

interface RegistryEntry {
  id: string;
  group: 'reading' | 'money' | 'compliance' | 'governance';
}

type Tab = 'members' | 'roles';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; error: Err }
  | { kind: 'ok'; members: readonly MemberDto[]; roles: readonly RoleDto[]; registry: readonly RegistryEntry[] };

interface Feedback {
  tone: 'success' | 'error';
  text: string;
  /** The invite token, on a successful invite only: TILL prepares, the operator delivers. */
  token?: string;
}

/**
 * Reading first (D50), because it is the first question an operator answers about a role: a role
 * that can see nothing can do nothing useful with any write below it. Money next, because it is what
 * most people opened this screen to decide. The order mirrors `CAPABILITIES` in the engine, and a
 * group the engine sends that is missing here would silently drop its whole block of checkboxes,
 * which is what `test/style/studio-mirrors-engine-enums.test.mjs` derives rather than trusts.
 */
const GROUP_ORDER: readonly RegistryEntry['group'][] = ['reading', 'money', 'compliance', 'governance'];

export function Members() {
  const t = useT();
  const tStrict = useTStrict();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const caps = useCapabilities();
  const inviteEmailId = useId();
  const inviteRoleId = useId();
  const revokeBodyId = useId();

  const [tab, setTab] = useState<Tab>('members');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('bookkeeper');
  const [inviteKind, setInviteKind] = useState<MemberKind>('human');
  /** J6.5 / F-11: the member a "Zugriff entziehen" press is asking about, until the confirm answers. */
  const [revokeTarget, setRevokeTarget] = useState<MemberDto | null>(null);
  const [draftRole, setDraftRole] = useState<{ id: string | null; name: string; capabilities: string[] } | null>(null);

  const canManage = caps.can(CAP.manageMembers);

  /**
   * M03 invite (N4b), S4.2: on a LOCAL instance an invite is redeemable by nobody (no second human
   * can authenticate), so the invite form carries a go-online notice naming the precondition and
   * linking the Hosting journey. Rendered only when `whoami` has answered AND names this session a
   * local one; in served mode the notice is ABSENT (the S4.2 acceptance), and while `whoami` is
   * unanswered nothing renders rather than a guess.
   */
  const localMode = caps.whoami !== null && (caps.whoami.identitySource ?? 'local_client') === 'local_client';

  const load = useCallback(async () => {
    if (workspaceId === null) return;
    setState({ kind: 'loading' });
    const [membersResponse, rolesResponse] = await Promise.all([
      client.call('list_members', { workspaceId }),
      client.call('list_roles', { workspaceId }),
    ]);
    if (isErr(membersResponse.body)) return setState({ kind: 'error', error: membersResponse.body });
    if (isErr(rolesResponse.body)) return setState({ kind: 'error', error: rolesResponse.body });
    const membersBody = membersResponse.body as unknown as { members: readonly MemberDto[] };
    const rolesBody = rolesResponse.body as unknown as {
      roles: readonly RoleDto[];
      registry: readonly RegistryEntry[];
    };
    setState({
      kind: 'ok',
      members: membersBody.members,
      roles: rolesBody.roles,
      registry: rolesBody.registry,
    });
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Run one write, then re-read BOTH the list and `whoami`.
   *
   * The `whoami` refresh is the load-bearing half. A role change takes effect on the member's next
   * engine call, so the only thing that could be stale after a `set_role` or a `define_role` is this
   * browser's own copy of the capability answer, and an owner who just granted themselves something
   * should see it unlock without a reload.
   */
  async function run(action: string, input: Record<string, unknown>, successKey: string): Promise<void> {
    if (workspaceId === null) return;
    setBusy(true);
    const response = await client.call(action, { workspaceId, ...input });
    setBusy(false);
    if (isErr(response.body)) {
      setFeedback({ tone: 'error', text: errorText(response.body) });
      return;
    }
    const body = response.body as unknown as { token?: string; replacedExpired?: boolean };
    const token = body.token;
    // J8.8: a re-invite that re-armed an expired pending row says so, so the owner knows the old
    // code is dead and only the new one redeems.
    const key = token !== undefined && body.replacedExpired === true ? 'members.reinvited' : successKey;
    setFeedback(token === undefined ? { tone: 'success', text: t(key) } : { tone: 'success', text: t(key), token });
    caps.refresh();
    await load();
  }

  /** A rejection in the operator's words. Every code A24 can answer with has its own sentence. */
  function errorText(error: Err): string {
    const known = [
      'permission_denied',
      'last_owner',
      'already_member',
      'unknown_role',
      'unknown_capability',
      'builtin_fixed',
      'role_in_use',
      'member_not_found',
      'role_not_found',
      'invite_expired',
      'invite_not_found',
      'actor_already_bound',
      'member_kind_mismatch',
    ];
    if (!known.includes(error.error)) return t('members.error.generic');
    if (error.error === 'permission_denied') {
      const capability = typeof error.capability === 'string' ? error.capability : null;
      return capability === null
        ? t('members.error.permission_denied')
        : t('members.error.permissionNamed', { capability: tStrict(`capability.${capability}`) });
    }
    if (error.error === 'unknown_capability') {
      const capability = typeof error.capability === 'string' ? error.capability : '';
      return t('members.error.unknown_capability', { capability });
    }
    return t(`members.error.${error.error}`);
  }

  if (workspaceId === null) {
    return (
      <section className="members" aria-labelledby="members-title">
        <SurfaceHeader title={t('members.title')} titleId="members-title" help={<SurfaceHelp surface="Members" />} />
        <NoWorkspaceState body={t('members.noWorkspaceHint')} />
      </section>
    );
  }

  const assignable = state.kind === 'ok' ? state.roles.filter((r) => !r.archived) : [];

  const membersPanel = state.kind === 'ok' && (
    <MembersPanel
      members={state.members}
      roles={state.roles}
      assignable={assignable}
      canManage={canManage}
      localMode={localMode}
      busy={busy}
      inviteEmail={inviteEmail}
      inviteRole={inviteRole}
      inviteKind={inviteKind}
      inviteEmailId={inviteEmailId}
      inviteRoleId={inviteRoleId}
      onInviteEmail={setInviteEmail}
      onInviteRole={setInviteRole}
      onInviteKind={setInviteKind}
      onInvite={() =>
        void run(
          'invite_member',
          { email: inviteEmail, role: inviteRole, kind: inviteKind, idempotencyKey: newIdempotencyKey() },
          'members.invited',
        ).then(() => setInviteEmail(''))
      }
      onSetRole={(memberId, role) => void run('set_role', { memberId, role }, 'members.roleChanged')}
      onRevoke={(member) => setRevokeTarget(member)}
    />
  );

  const rolesPanel = state.kind === 'ok' && canManage && (
    <RolesTab
      roles={state.roles}
      registry={state.registry}
      busy={busy}
      draft={draftRole}
      onDraft={setDraftRole}
      onSave={(draft) =>
        void run(
          'define_role',
          {
            ...(draft.id === null ? {} : { roleId: draft.id }),
            name: draft.name,
            capabilities: draft.capabilities,
            idempotencyKey: newIdempotencyKey(),
          },
          'members.roleSaved',
        ).then(() => setDraftRole(null))
      }
      onArchive={(roleId) =>
        void run('archive_role', { roleId, idempotencyKey: newIdempotencyKey() }, 'members.roleArchived')
      }
    />
  );

  // The tab strip is the shared Tabs primitive. The Roles tab is HIDDEN rather than disabled for an
  // actor without `manage_members` (see the module note), so it is only in the array when canManage.
  const tabs: TabItem[] = [
    { id: 'members', label: t('members.tab.members'), panel: membersPanel },
    ...(canManage ? [{ id: 'roles', label: t('members.tab.roles'), panel: rolesPanel } as TabItem] : []),
  ];

  return (
    <section className="members" aria-labelledby="members-title">
      <SurfaceHeader title={t('members.title')} titleId="members-title" help={<SurfaceHelp surface="Members" />} />

      {/*
        THE ONE NOTICE THAT IS NOT AN ERROR. It says the true thing (nobody has claimed this
        workspace) rather than the convenient one (you are the owner), and it says what the next
        click will do, because inviting somebody is also the act of claiming ownership and an
        operator should not discover that afterwards.
      */}
      {caps.whoami !== null && !caps.whoami.provisioned && (
        <ActionFeedback tone="info" message={t('members.unclaimed')} />
      )}
      {caps.whoami !== null && caps.whoami.provisioned && !caps.whoami.isMember && (
        <ActionFeedback tone="info" message={t('members.notAMember')} />
      )}

      {/*
        THE COST OF D50, SAID OUT LOUD ON THE SCREEN THAT CAN FIX IT. Provisioning seats the MCP
        agent as an owner so that the first invite does not silently cut `till mcp` out of every
        write. The price is that whoever reaches the MCP socket holds everything until somebody
        narrows it, and a price nobody is told about is a price nobody pays deliberately. It shows
        only while the agent is still AT `owner`, and only to somebody who can act on it: a notice
        that outlives the condition it describes is furniture, and one an operator cannot act on is
        an accusation.
      */}
      {canManage && state.kind === 'ok' && state.members.some((m) => m.actorId === 'agent' && m.role === 'owner') && (
        <ActionFeedback tone="info" message={t('members.agentIsOwner')} />
      )}

      {feedback !== null && (
        <ActionFeedback
          tone={feedback.tone === 'error' ? 'error' : 'success'}
          message={feedback.text}
          onDismiss={() => setFeedback(null)}
          dismissLabel={t('members.dismiss')}
        >
          {/*
            THE TOKEN IS SHOWN BECAUSE NOTHING WAS SENT. There is no mail transport in the MIT
            core, so an invite that claimed to be "on its way" would be a delivery guarantee this
            product cannot make offline. The operator gets the token and delivers it themselves.
          */}
          {feedback.token !== undefined && (
            <InviteHandOver key={feedback.token} token={feedback.token} workspaceId={workspaceId} />
          )}
        </ActionFeedback>
      )}

      {/*
        J6.5 / F-11 (DESIGN.md "Forgiveness"): revoking is destructive and takes a deliberate act. The
        confirm names the person and states the consequence in the SAME sentence the Vorschlag card
        shows for `revoke_member` (D118 C4: one sentence, shared), then the danger action.
      */}
      <Modal
        open={revokeTarget !== null}
        role={ALERT_DIALOG}
        onClose={() => setRevokeTarget(null)}
        title={t('members.revokeConfirm.title')}
        closeLabel={t('members.dismiss')}
        describedById={revokeBodyId}
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setRevokeTarget(null)}>
              {t('members.revokeConfirm.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--danger"
              disabled={busy}
              onClick={() => {
                const target = revokeTarget;
                setRevokeTarget(null);
                if (target !== null) void run('revoke_member', { memberId: target.memberId }, 'members.revoked');
              }}
            >
              {t('members.revokeConfirm.confirm')}
            </button>
          </>
        }
      >
        <p id={revokeBodyId} className="members-revoke-body">
          {revokeTarget !== null && t('members.revokeConfirm.body', { name: personLabel(revokeTarget, t) })}
        </p>
        <p className="members-revoke-consequence">{t('agent.consequenceVerb.revoke_member')}</p>
      </Modal>
      {state.kind === 'loading' && <Skeleton rows={4} height={40} />}

      {state.kind === 'error' &&
        (state.error.error === 'permission_denied' ? (
          <PermissionDenied body={t('members.error.permission_denied')} />
        ) : (
          <ErrorBanner error={state.error} onRetry={() => void load()} />
        ))}

      {state.kind === 'ok' && (
        <Tabs tabs={tabs} activeId={tab} onChange={(id) => setTab(id as Tab)} label={t('members.title')} />
      )}
    </section>
  );
}

/**
 * M03 invite (N4b), S4.1: the invite hand-over. TILL has no mail transport, so nothing was sent:
 * the confirmation renders the token AND the redemption link (the deep link that prefills the
 * not-a-member page's field, and never auto-redeems) with the shared CopyButton, and the feedback
 * sentence beside it says the owner delivers it. Keyed by token by the caller, so the control's
 * copied state resets per invite.
 */
function InviteHandOver({ token, workspaceId }: { token: string; workspaceId: string }) {
  const t = useT();
  // The link carries the WORKSPACE (S4.3). A memberless subject landing on a bare `/?invite=` link
  // never gets whoami resolved (the gate only consults it once a workspace is selected), so the
  // no-workspace shell rendered instead of the redemption, offering to FORK the books. The inviter
  // knows the id, so the deep link adopts the workspace first and lands on the not-a-member page
  // with the token prefilled; the bootstrap capture strips the token on any path.
  const link = `${window.location.origin}/w/${workspaceId}/?invite=${encodeURIComponent(token)}`;
  return (
    <>
      <p className="action-feedback__detail">
        {t('members.inviteToken')}: <code className="members-token">{token}</code>
      </p>
      <p className="action-feedback__detail">
        {t('members.inviteLink')}: <code className="members-token">{link}</code>{' '}
        <CopyButton value={link} label={t('members.copyLink')} />
      </p>
    </>
  );
}

/**
 * The Personen panel: the invite form (for a manager) and the roster as the shared DataTable.
 *
 * The roster is a plain read/select table, not a click-to-open list, so it carries no `onRowClick`:
 * every action lives in a cell (the role select, the revoke button) rather than behind a row open.
 */
function MembersPanel({
  members,
  roles,
  assignable,
  canManage,
  localMode,
  busy,
  inviteEmail,
  inviteRole,
  inviteKind,
  inviteEmailId,
  inviteRoleId,
  onInviteEmail,
  onInviteRole,
  onInviteKind,
  onInvite,
  onSetRole,
  onRevoke,
}: {
  members: readonly MemberDto[];
  roles: readonly RoleDto[];
  assignable: readonly RoleDto[];
  canManage: boolean;
  localMode: boolean;
  busy: boolean;
  inviteEmail: string;
  inviteRole: string;
  inviteKind: MemberKind;
  inviteEmailId: string;
  inviteRoleId: string;
  onInviteEmail: (value: string) => void;
  onInviteRole: (value: string) => void;
  onInviteKind: (value: MemberKind) => void;
  onInvite: () => void;
  onSetRole: (memberId: string, role: string) => void;
  onRevoke: (member: MemberDto) => void;
}) {
  const t = useT();
  const tStrict = useTStrict();
  const noticeId = useId();
  const kindLegendId = useId();

  const columns: DataTableColumn<MemberDto>[] = [
    {
      key: 'person',
      header: t('members.column.person'),
      render: (member) => (
        <>
          <span className="members-person">
            {personLabel(member, t)}
            {/* D123: an agent member is named IN WORDS, never signalled by a glyph or colour alone. */}
            {member.kind === 'agent' && <span className="members-kind-chip">{t('members.rowKind.agent')}</span>}
          </span>
          {member.actorId !== null && (
            <span className="members-actor">{t('members.boundTo', { actor: member.actorId })}</span>
          )}
        </>
      ),
    },
    {
      key: 'role',
      header: t('members.column.role'),
      render: (member) =>
        canManage ? (
          <select
            className="field members-role-select"
            value={member.role}
            disabled={busy}
            aria-label={t('members.roleLabel')}
            onChange={(e) => onSetRole(member.memberId, e.target.value)}
          >
            {assignable.map((role) => (
              <option key={role.id} value={role.id}>
                {roleLabel(role, tStrict)}
              </option>
            ))}
          </select>
        ) : (
          <span className="members-pill">
            {roleLabel(roles.find((r) => r.id === member.role), tStrict, member.role)}
          </span>
        ),
    },
    {
      key: 'status',
      header: t('members.column.status'),
      // Glyph plus text, never colour alone (DESIGN.md, status).
      render: (member) => (
        <span className="members-status">
          <StatusGlyph pending={member.status === 'pending'} />
          <span>{t(`members.status.${member.status}`)}</span>
        </span>
      ),
    },
    {
      key: 'since',
      header: t('members.column.since'),
      render: (member) => (
        <span className="members-since">
          {member.acceptedAt !== null ? formatDate(member.acceptedAt) : formatDate(member.invitedAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('members.column.actions'),
      headerHidden: true,
      align: 'end',
      render: (member) =>
        canManage ? (
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={busy}
            onClick={() => onRevoke(member)}
          >
            {t('members.revoke')}
          </button>
        ) : null,
    },
  ];

  return (
    <>
      {/*
        M03 invite (N4b), S4.2: the go-online notice sits WITH the invite form, never above the
        list. It corrects the expectation (locally there is no second sign-in, so a minted token is
        redeemable by nobody) and links the Hosting journey; the form itself stays visible and
        ENABLED, because preparing rolesets is still legitimate. Absent in served mode.
      */}
      {canManage && localMode && (
        <div id={noticeId}>
          <ActionFeedback
            tone="info"
            role="note"
            className="members-goonline"
            message={
              <>
                {t('members.goOnline.notice')} <Link to="/operations">{t('members.goOnline.link')}</Link>
              </>
            }
          />
        </div>
      )}
      {canManage && (
        <form
          className="members-invite panel"
          onSubmit={(e) => {
            e.preventDefault();
            onInvite();
          }}
        >
          {/*
            M03 S4.2, corrected in Phase 2c (friction ledger F-11): the engine mints a token on every
            invite and cannot know the instance is local, so in LOCAL mode the form is DISABLED with
            the notice above as its stated reason. A form that minted a code nobody could redeem was
            an action shown and then refused; the Rollen tab stays open for preparing rolesets.
          */}
          <fieldset
            className="members-invite-fields"
            disabled={localMode}
            aria-describedby={localMode ? noticeId : undefined}
          >
            <label className="members-field" htmlFor={inviteEmailId}>
              {t('members.emailLabel')}
            </label>
            <input
              id={inviteEmailId}
              className="field"
              type="email"
              required
              value={inviteEmail}
              placeholder={t('members.emailPlaceholder')}
              onChange={(e) => onInviteEmail(e.target.value)}
            />
            <label className="members-field" htmlFor={inviteRoleId}>
              {t('members.roleLabel')}
            </label>
            <select id={inviteRoleId} className="field" value={inviteRole} onChange={(e) => onInviteRole(e.target.value)}>
              {assignable.map((role) => (
                <option key={role.id} value={role.id}>
                  {roleLabel(role, tStrict)}
                </option>
              ))}
            </select>
            {/* D123 / M03 V5: the kind, declared by the inviter (Person or Agent). One click each. */}
            <span className="members-field" id={kindLegendId}>
              {t('members.kindLabel')}
            </span>
            <div className="members-kind" role="radiogroup" aria-labelledby={kindLegendId}>
              {(['human', 'agent'] as const).map((kind) => (
                <label key={kind} className="members-kind-option">
                  <input
                    type="radio"
                    name="member-kind"
                    value={kind}
                    checked={inviteKind === kind}
                    onChange={() => onInviteKind(kind)}
                  />
                  <span>{t(`members.kind.${kind}`)}</span>
                </label>
              ))}
            </div>
            <button type="submit" className="btn btn--accent" disabled={busy || inviteEmail === ''}>
              {t('members.invite')}
            </button>
          </fieldset>
          {inviteKind === 'agent' && !localMode && <p className="members-kind-hint">{t('members.kindHint.agent')}</p>}
        </form>
      )}

      <DataTable
        columns={columns}
        rows={[...members]}
        rowKey={(member) => member.memberId}
        caption={t('members.list.aria')}
        emptyState={
          // In local mode the invite-CTA hint would contradict the go-online notice right above
          // it (no second person can sign in here), so the empty state defers to the notice with
          // neutral copy instead (M03 S4.2).
          <EmptyState title={t('members.empty')} hint={t(localMode ? 'members.emptyHintLocal' : 'members.emptyHint')} />
        }
      />
    </>
  );
}

/**
 * The Roles tab: every assignable role, its resolved bundle, and the capability checkbox editor.
 *
 * The two anchors render as a read-only "fest" badge rather than as a disabled checkbox grid, and
 * they stay in the tab order (focusable, `aria-disabled`) so a screen-reader user can confirm they
 * are fixed rather than merely encountering a greyed-out thing with no explanation.
 */
function RolesTab({
  roles,
  registry,
  busy,
  draft,
  onDraft,
  onSave,
  onArchive,
}: {
  roles: readonly RoleDto[];
  registry: readonly RegistryEntry[];
  busy: boolean;
  draft: { id: string | null; name: string; capabilities: string[] } | null;
  onDraft: (draft: { id: string | null; name: string; capabilities: string[] } | null) => void;
  onSave: (draft: { id: string | null; name: string; capabilities: string[] }) => void;
  onArchive: (roleId: string) => void;
}) {
  const t = useT();
  const tStrict = useTStrict();
  const nameId = useId();

  const grouped = useMemo(
    () => GROUP_ORDER.map((group) => ({ group, entries: registry.filter((e) => e.group === group) })),
    [registry],
  );

  return (
    <div className="members-roles">
      <div className="members-roles-head">
        <button
          type="button"
          className="btn btn--accent"
          disabled={busy}
          onClick={() => onDraft({ id: null, name: '', capabilities: [] })}
        >
          {t('members.roles.define')}
        </button>
      </div>

      <ul className="members-role-list">
        {roles
          .filter((role) => !role.archived)
          .map((role) => (
            <li key={role.id} className="members-role panel">
              <div className="members-role-head">
                <span className="members-role-name">{roleLabel(role, tStrict)}</span>
                {role.isFixed ? (
                  /* Focusable and read-only, never a control that would reject on click. The slug
                     rides in the title so an operator debugging a denial can see the engine's name. */
                  <span className="members-pill members-pill--fixed" tabIndex={0} aria-disabled="true" title={role.id}>
                    {t('members.roles.fixed')}
                  </span>
                ) : (
                  <span className="members-role-actions">
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      disabled={busy}
                      onClick={() => onDraft({ id: role.id, name: role.name, capabilities: [...role.capabilities] })}
                    >
                      {t('members.roles.edit')}
                    </button>
                    {!role.isBuiltin && (
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        disabled={busy}
                        onClick={() => onArchive(role.id)}
                      >
                        {t('members.roles.archive')}
                      </button>
                    )}
                  </span>
                )}
              </div>
              <p className="members-role-caps">
                {role.capabilities.length === 0
                  ? t('members.roles.noCapabilities')
                  : role.capabilities.map((c) => tStrict(`capability.${c}`)).join(', ')}
              </p>
              <p className="members-role-count">{t('members.roles.memberCount', { count: role.memberCount })}</p>
            </li>
          ))}
      </ul>

      {draft !== null && (
        <form
          className="members-role-editor panel"
          onSubmit={(e) => {
            e.preventDefault();
            onSave(draft);
          }}
        >
          <label className="members-field" htmlFor={nameId}>
            {t('members.roles.name')}
          </label>
          <input
            id={nameId}
            className="field"
            required
            value={draft.name}
            onChange={(e) => onDraft({ ...draft, name: e.target.value })}
          />

          {grouped.map(({ group, entries }) => (
            <fieldset key={group} className="members-cap-group">
              <legend>{t(`members.roles.group.${group}`)}</legend>
              {entries.map((entry) => (
                <label key={entry.id} className="members-cap">
                  <input
                    type="checkbox"
                    checked={draft.capabilities.includes(entry.id)}
                    onChange={(e) =>
                      onDraft({
                        ...draft,
                        capabilities: e.target.checked
                          ? [...draft.capabilities, entry.id]
                          : draft.capabilities.filter((c) => c !== entry.id),
                      })
                    }
                  />
                  <span>{tStrict(`capability.${entry.id}`)}</span>
                </label>
              ))}
            </fieldset>
          ))}

          <div className="members-role-editor-actions">
            <button type="submit" className="btn btn--accent" disabled={busy || draft.name === ''}>
              {t('members.roles.save')}
            </button>
            <button type="button" className="btn btn--secondary" onClick={() => onDraft(null)}>
              {t('members.roles.cancel')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** A pending invite has no glyph of its own in the shared set; an outline ring reads as "not yet". */
function StatusGlyph({ pending }: { pending: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <circle cx="6" cy="6" r="4.5" fill={pending ? 'none' : 'currentColor'} stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/**
 * A role's label. A BUILT-IN resolves through `tStrict` so `treuhaender` reads "Treuhänder"; a
 * CUSTOM role is a name its own operator typed, so it renders verbatim and is never sent through a
 * lookup that would either throw in dev or humanise it into something they did not write.
 */
function roleLabel(role: RoleDto | undefined, tStrict: (key: string) => string, fallback = ''): string {
  if (role === undefined) return fallback;
  return role.isBuiltin ? tStrict(`members.role.${role.id}`) : role.name;
}

/**
 * The label for a D13 session actor, which is a TRANSPORT and not a person.
 *
 * Both seated actors reach this function with a null name and a null email (see `seatOwner`), so
 * before D50 they would both have rendered as the same "this installation" string and an operator
 * could not have told the Studio's own seat from the MCP agent's. That is precisely the row D50
 * requires to be discoverable, so each one is named.
 *
 * A map rather than a `members.actor.${id}` lookup, because the actor id is a string the engine may
 * one day fill with a real subject (`treuhand:mueller`), and a template lookup would then throw in
 * dev on a value that is perfectly valid. An unknown actor falls back to the generic label.
 */
const SEATED_ACTOR_LABEL: Readonly<Record<string, string>> = {
  studio: 'members.actor.studio',
  agent: 'members.actor.agent',
};

/** A person's name, their email, or, for a local session identity, the actor the engine knows. */
function personLabel(member: MemberDto, t: (key: string, params?: Record<string, string>) => string): string {
  if (member.displayName !== null && member.displayName !== '') return member.displayName;
  if (member.email !== null && member.email !== '') return member.email;
  const actorKey = member.actorId !== null ? SEATED_ACTOR_LABEL[member.actorId] : undefined;
  return t(actorKey ?? 'members.localSession');
}

export default Members;
