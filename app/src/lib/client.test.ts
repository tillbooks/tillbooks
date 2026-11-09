import { describe, it, expect } from 'vitest';

import { TillClient, isErr, type RestResponse, type Transport } from './client';

describe('TillClient', () => {
  it('passes the action and input to the transport and returns its RestResponse', async () => {
    const seen: Array<{ action: string; input: Record<string, unknown> }> = [];
    const fake: Transport = async (action, input) => {
      seen.push({ action, input });
      return { status: 200, body: { ok: true, accounts: [] } } satisfies RestResponse;
    };
    const client = new TillClient(fake);

    const resp = await client.call('list_accounts', { workspaceId: 'ws_1' });

    expect(seen).toEqual([{ action: 'list_accounts', input: { workspaceId: 'ws_1' } }]);
    expect(resp.status).toBe(200);
    expect(resp.body).toEqual({ ok: true, accounts: [] });
  });

  it('defaults input to an empty object', async () => {
    let capturedInput: Record<string, unknown> | undefined;
    const fake: Transport = async (_action, input) => {
      capturedInput = input;
      return { status: 200, body: { ok: true } };
    };

    await new TillClient(fake).call('list_workspaces');

    expect(capturedInput).toEqual({});
  });

  it('surfaces a domain rejection as a 422 with an Err body the caller can narrow', async () => {
    const fake: Transport = async () => ({
      status: 422,
      body: { ok: false, error: 'workspace_not_found', workspaceId: 'ws_x' },
    });

    const { status, body } = await new TillClient(fake).call('list_accounts', { workspaceId: 'ws_x' });

    expect(status).toBe(422);
    expect(isErr(body)).toBe(true);
    if (isErr(body)) expect(body.error).toBe('workspace_not_found');
  });
});
