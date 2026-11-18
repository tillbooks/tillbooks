/**
 * D204, THE REASON ROUTE: whether the Studio offers a reason field at all. The workspace setting
 * `audit.ask_reason` (D172) is `never` (the default: no field anywhere) or `optional` (an optional note
 * that never disables a button). No value makes a reason mandatory, and the engine never refuses for a
 * missing one (A03 §11). Read once per workspace; `never` while unread or unreadable, so a surface
 * that has not heard back shows the calm default rather than a field it may not need.
 */
import { useEffect, useState } from 'react';

import { useOptionalClient } from './client-context';
import { isErr } from './client';
import { useOptionalWorkspaceId } from '../app/workspace';

export const ASK_REASON_SETTING = 'audit.ask_reason';

export type AskReason = 'never' | 'optional';

/** The stored value when it is `optional`, else `never`. */
export function askReasonOf(body: unknown): AskReason {
  const setting = body !== null && typeof body === 'object' ? (body as { setting?: unknown }).setting : undefined;
  const value = setting !== null && typeof setting === 'object' ? (setting as { value?: unknown }).value : undefined;
  return value === 'optional' ? 'optional' : 'never';
}

/** True when the workspace asks for an optional reason (`audit.ask_reason = optional`). */
export function useAskReason(): boolean {
  // Optional: a page outside the shell (the drop page) has no client and never offers the field.
  const client = useOptionalClient();
  const workspaceId = useOptionalWorkspaceId();
  const [state, setState] = useState<{ workspaceId: string | null; ask: AskReason }>({ workspaceId: null, ask: 'never' });
  useEffect(() => {
    if (workspaceId === null || client === null) return undefined;
    let live = true;
    void client.call('settings_get', { workspaceId, key: ASK_REASON_SETTING }).then(
      ({ body }) => {
        if (live) setState({ workspaceId, ask: isErr(body) ? 'never' : askReasonOf(body) });
      },
      () => {
        if (live) setState({ workspaceId, ask: 'never' });
      },
    );
    return () => {
      live = false;
    };
  }, [client, workspaceId]);
  return state.workspaceId === workspaceId && state.ask === 'optional';
}

/** A reason as the engine takes it: trimmed, and absent when blank (D204). */
export function optionalReason(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
