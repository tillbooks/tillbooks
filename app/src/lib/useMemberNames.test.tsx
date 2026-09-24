/**
 * R4-D1: the shared actor-id -> member-name resolver.
 *
 * The suite pins the two properties the three operations surfaces depend on: a known id resolves to
 * the member's name with the raw id kept as a tooltip, and everything else (an unknown id, or a
 * roster read the caller may not make) FALLS OPEN to the raw id rather than blanking the cell. The
 * fail-open case is the load-bearing one: it is what keeps a viewer without `read_members`, or a
 * transient read failure, from turning an operations list into a column of empty cells.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { TillClientProvider } from './client-context';
import { TillClient, type RestResponse, type Transport } from './client';
import { WorkspaceProvider } from '../app/workspace';
import { useMemberNames, ActorLabel } from './useMemberNames';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string): RestResponse => ({ status: 422, body: { ok: false, error } });

function transport(canned: Record<string, RestResponse>): Transport {
  return async (action) => canned[action] ?? { status: 404, body: { ok: false, error: 'unknown_action' } };
}

const MEMBERS = [
  // A named person bound to the `studio` seat: resolvable by BOTH its user id and its actor id.
  { memberId: 'm1', userId: 'user_1', actorId: 'studio', displayName: 'Anna Muster', email: null },
  // No display name, so the email is the fallback label.
  { memberId: 'm2', userId: 'user_2', actorId: null, displayName: null, email: 'bruno@example.ch' },
];

/** A probe that renders each id through the hook, so the suite reads the resolved DOM. */
function Probe({ ids }: { ids: (string | null)[] }) {
  const names = useMemberNames();
  return (
    <ul>
      {ids.map((id, i) => {
        const actor = names.resolve(id);
        return (
          <li key={i} data-testid={`row-${i}`} data-resolved={String(actor.resolved)}>
            <ActorLabel actor={actor} tooltip={`Kennung: ${actor.id}`} />
          </li>
        );
      })}
    </ul>
  );
}

function renderProbe(canned: Record<string, RestResponse>, ids: (string | null)[]) {
  return render(
    <TillClientProvider client={new TillClient(transport(canned))}>
      <WorkspaceProvider initialId="ws_test">
        <Probe ids={ids} />
      </WorkspaceProvider>
    </TillClientProvider>,
  );
}

describe('useMemberNames', () => {
  it('resolves a user id to the member name and keeps the raw id as a tooltip', async () => {
    renderProbe({ list_members: ok({ members: MEMBERS }) }, ['user_1']);
    const name = await screen.findByText('Anna Muster');
    // The name is a <span> carrying the raw id as its accessible tooltip.
    expect(name.tagName).toBe('SPAN');
    expect(name).toHaveAttribute('title', 'Kennung: user_1');
  });

  it('resolves a seated actor id (studio) through the member bound to it', async () => {
    renderProbe({ list_members: ok({ members: MEMBERS }) }, ['studio']);
    const name = await screen.findByText('Anna Muster');
    expect(name).toHaveAttribute('title', 'Kennung: studio');
  });

  it('falls back to the email when the member has no display name', async () => {
    renderProbe({ list_members: ok({ members: MEMBERS }) }, ['user_2']);
    expect(await screen.findByText('bruno@example.ch')).toHaveAttribute('title', 'Kennung: user_2');
  });

  it('falls open to the raw id for an unknown id, with no tooltip', async () => {
    renderProbe({ list_members: ok({ members: MEMBERS }) }, ['user_1', 'user_9']);
    await screen.findByText('Anna Muster');
    const unknown = screen.getByText('user_9');
    // Unresolved ids render as bare text (no span, no tooltip): the id is already visible.
    expect(unknown.tagName).toBe('LI');
    expect(screen.getByTestId('row-1')).toHaveAttribute('data-resolved', 'false');
  });

  it('falls open to raw ids when the roster read is unpermitted', async () => {
    renderProbe({ list_members: reject('permission_denied') }, ['user_1']);
    // Give the effect a tick: the id stays raw because the read was refused.
    await waitFor(() => expect(screen.getByTestId('row-0')).toHaveAttribute('data-resolved', 'false'));
    expect(screen.getByText('user_1').tagName).toBe('LI');
  });

  it('resolves an empty label for a null id', async () => {
    renderProbe({ list_members: ok({ members: MEMBERS }) }, [null]);
    await waitFor(() => expect(screen.getByTestId('row-0')).toHaveAttribute('data-resolved', 'false'));
    expect(screen.getByTestId('row-0')).toBeEmptyDOMElement();
  });
});
