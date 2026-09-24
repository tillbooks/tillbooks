/**
 * R4-D1: resolve a raw actor id to a member's name.
 *
 * Three operations surfaces (Time, Requisitions, InventoryMovements) each render a bare actor id in
 * a cell, `user_1` where the reader wants "Anna Muster". Unlike GoodsReceipt or ThreeWayMatch, which
 * receive a resolved `supplierName` straight from the engine, these fields (`userId`, `requesterId`,
 * `createdBy`) hold the id the engine stored (a minted `user_N`, or a seated actor like `studio` /
 * `agent`) and no roster was ever loaded to turn it into a person. This hook is that one shared
 * roster read, so the mapping is written and tested once rather than three times.
 *
 * FAIL-OPEN ON THE DISPLAY. The roster read is `list_members` (capability `read_members`). It is a
 * courtesy lookup and never a gate: a member without `read_members`, or a transient read failure,
 * falls back to the RAW id rather than blanking the cell or hiding the row. The engine stays the
 * real gate on who may see the roster; this only decides whether a name or an id is on screen.
 *
 * THE RAW ID STAYS DISCOVERABLE. `resolve` returns the original `id` alongside the resolved `label`,
 * and `ActorLabel` keeps the id as a hover / aria tooltip whenever a name was found, so an operator
 * asking "who is user_1?" never loses the id the engine actually recorded.
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react';

import { useClient } from './client-context';
import { isErr } from './client';
import { useWorkspaceId } from '../app/workspace';

/** One member row, the subset of `list_members` this resolver reads. Mirrors `MemberDto` in Members. */
interface MemberRow {
  readonly userId: string | null;
  readonly actorId: string | null;
  readonly displayName: string | null;
  readonly email: string | null;
}

/** The outcome of resolving one id: the id always, the display name when known, and which it is. */
export interface ResolvedActor {
  /** The raw actor / user id, exactly as the engine stored it. Always present. */
  readonly id: string;
  /** The member's name when the roster knew this id, otherwise the raw id itself. */
  readonly label: string;
  /** True only when a member name was found, so the raw id is worth keeping as a tooltip. */
  readonly resolved: boolean;
}

/** A resolver over a loaded (or empty, when unpermitted / still loading) members roster. */
export interface MemberNames {
  /** Resolve one actor / user id to a name, falling back to the raw id when unknown. */
  resolve: (id: string | null | undefined) => ResolvedActor;
}

const EMPTY = new Map<string, string>();

/** The display name for a row: the typed name, else the email, else nothing (raw id will show). */
function rowName(row: MemberRow): string {
  if (row.displayName !== null && row.displayName !== '') return row.displayName;
  if (row.email !== null && row.email !== '') return row.email;
  return '';
}

/**
 * Load the workspace members once and hand back a resolver from actor / user id to member name.
 *
 * The map keys on BOTH `userId` and `actorId`, because the three consuming surfaces store different
 * ones: a time entry keeps the acting user's id, while a requisition or an inventory movement can
 * keep a seated actor id (`studio`, `agent`). A row whose id matches neither resolves to the raw id.
 */
export function useMemberNames(): MemberNames {
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const [names, setNames] = useState<ReadonlyMap<string, string>>(EMPTY);

  useEffect(() => {
    let live = true;
    if (workspaceId === null) {
      setNames(EMPTY);
      return;
    }
    void (async () => {
      const response = await client.call('list_members', { workspaceId });
      if (!live) return;
      // Fail open: a viewer without `read_members` (or any read error) keeps the raw ids.
      if (isErr(response.body)) {
        setNames(EMPTY);
        return;
      }
      const rows = (response.body as unknown as { members?: readonly MemberRow[] }).members ?? [];
      const next = new Map<string, string>();
      for (const row of rows) {
        const name = rowName(row);
        if (name === '') continue;
        if (row.userId !== null && row.userId !== '') next.set(row.userId, name);
        if (row.actorId !== null && row.actorId !== '') next.set(row.actorId, name);
      }
      setNames(next);
    })();
    return () => {
      live = false;
    };
  }, [client, workspaceId]);

  return useMemo<MemberNames>(
    () => ({
      resolve: (id) => {
        if (id === null || id === undefined || id === '') return { id: '', label: '', resolved: false };
        const name = names.get(id);
        return name === undefined ? { id, label: id, resolved: false } : { id, label: name, resolved: true };
      },
    }),
    [names],
  );
}

/**
 * Render a resolved actor: the member name with the raw id kept as a tooltip, or, when no name was
 * found, the raw id on its own (no tooltip, because it would only repeat the visible text).
 *
 * `tooltip` is the surface's own translated "id" label (each surface owns the string in its message
 * files); it falls back to the bare id so the id is never lost even if a caller omits it.
 */
export function ActorLabel({ actor, tooltip }: { actor: ResolvedActor; tooltip?: string }): ReactElement {
  if (!actor.resolved) return <>{actor.label}</>;
  return (
    <span className="actor-name" title={tooltip ?? actor.id}>
      {actor.label}
    </span>
  );
}
