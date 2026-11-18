/**
 * D196 point 2, ONE-CLICK IGNORE: the reason a line is ignored with when the person picks none, the
 * workspace's `bank.ignore_default_reason` (D172, default `other`). Read once per workspace; `other` while
 * unread or unreadable. Self-contained (it shares no state with the bank surface), so any control that
 * ignores a line in one click (the panel's form, the row's Mehr menu) can call it.
 */
import { useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useOptionalWorkspaceId } from '../../app/workspace';
import { BANK_LINE_IGNORE_REASONS, type IgnoreReason } from './model';

export const IGNORE_DEFAULT_REASON_SETTING = 'bank.ignore_default_reason';

/** The stored value when it is a closed reason, else `other`. */
export function ignoreReasonOf(body: unknown): IgnoreReason {
  const setting = body !== null && typeof body === 'object' ? (body as { setting?: unknown }).setting : undefined;
  const value = setting !== null && typeof setting === 'object' ? (setting as { value?: unknown }).value : undefined;
  return typeof value === 'string' && (BANK_LINE_IGNORE_REASONS as readonly string[]).includes(value) ? (value as IgnoreReason) : 'other';
}

export function useIgnoreDefaultReason(): IgnoreReason {
  return useIgnoreDefaultReasonState().reason;
}

/**
 * The default with whether it has been read (critic D196 L4): `ready` is false until `settings_get`
 * answered (or failed, then `other`), so a control can hold its one click until the default is known
 * instead of sending `other` over a configured default.
 */
export function useIgnoreDefaultReasonState(): { reason: IgnoreReason; ready: boolean } {
  const client = useClient();
  const workspaceId = useOptionalWorkspaceId();
  // Critic D196 round 2 L2: the answer is kept WITH the workspace it was read for, so a workspace that arrives
  // or changes after mount is not ready until its own default is read.
  const [state, setState] = useState<{ workspaceId: string | null; reason: IgnoreReason }>({ workspaceId: null, reason: 'other' });
  useEffect(() => {
    if (workspaceId === null) return undefined;
    let live = true;
    void client.call('settings_get', { workspaceId, key: IGNORE_DEFAULT_REASON_SETTING }).then(
      ({ body }) => {
        if (live) setState({ workspaceId, reason: isErr(body) ? 'other' : ignoreReasonOf(body) });
      },
      () => {
        if (live) setState({ workspaceId, reason: 'other' });
      },
    );
    return () => {
      live = false;
    };
  }, [client, workspaceId]);
  if (workspaceId === null) return { reason: 'other', ready: true };
  return state.workspaceId === workspaceId ? { reason: state.reason, ready: true } : { reason: 'other', ready: false };
}
