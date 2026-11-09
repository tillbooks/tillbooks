import { describe, it, expect } from 'vitest';

import { isErr } from './client';
import { mcpTransportOver, parseToolResult, statusFor, type McpToolCaller } from './mcp-transport';

/** An MCP caller that answers with whatever content block the test hands it. */
function caller(reply: (name: string, args: Record<string, unknown>) => unknown): McpToolCaller {
  return { callTool: async ({ name, arguments: args }) => reply(name, args) };
}

/** The shape our MCP server actually emits: one JSON text block carrying the verb Result. */
function block(result: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

describe('statusFor', () => {
  it('maps a verb Result onto the statuses the surfaces already branch on', () => {
    expect(statusFor({ ok: true })).toBe(200);
    expect(statusFor({ ok: false, error: 'needs_empty_ledger' })).toBe(422);
    expect(statusFor({ ok: false, error: 'unknown_action', action: 'nope' })).toBe(404);
  });
});

describe('parseToolResult', () => {
  it('unwraps the single JSON text block', () => {
    expect(parseToolResult(block({ ok: true, accounts: [] }))).toEqual({ ok: true, accounts: [] });
  });

  it('treats a missing, empty or non-JSON content block as a transport fault', () => {
    for (const junk of [undefined, {}, { content: [] }, { content: [{ type: 'text', text: 'not json' }] }]) {
      const parsed = parseToolResult(junk);
      expect(parsed.ok).toBe(false);
      if (isErr(parsed)) expect(parsed.error).toBe('transport_error');
    }
  });

  it('treats a JSON block that is not a verb Result as a transport fault', () => {
    const parsed = parseToolResult(block({ some: 'other shape' }));
    expect(isErr(parsed) && parsed.error).toBe('transport_error');
  });
});

describe('mcpTransportOver', () => {
  it('calls the tool by action name with the input as arguments', async () => {
    const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
    const transport = mcpTransportOver(async () =>
      caller((name, args) => {
        seen.push({ name, args });
        return block({ ok: true, accounts: [] });
      }),
    );

    const resp = await transport('list_accounts', { workspaceId: 'ws_1' });

    expect(seen).toEqual([{ name: 'list_accounts', args: { workspaceId: 'ws_1' } }]);
    expect(resp).toEqual({ status: 200, body: { ok: true, accounts: [] } });
  });

  it('a domain rejection still arrives as a 422 with the stable error code', async () => {
    const transport = mcpTransportOver(async () =>
      caller(() => block({ ok: false, error: 'workspace_not_found', workspaceId: 'ws_x' })),
    );

    const { status, body } = await transport('get_company_profile', { workspaceId: 'ws_x' });

    expect(status).toBe(422);
    expect(isErr(body)).toBe(true);
    if (isErr(body)) expect(body.error).toBe('workspace_not_found');
  });

  it('an unknown action is a 404, exactly as the REST twin reported it', async () => {
    const transport = mcpTransportOver(async () => caller(() => block({ ok: false, error: 'unknown_action' })));
    const { status, body } = await transport('no_such_tool', {});
    expect(status).toBe(404);
    expect(isErr(body) && body.error).toBe('unknown_action');
  });

  it('reuses one session across calls: the handshake happens once, not per call', async () => {
    let connections = 0;
    const transport = mcpTransportOver(async () => {
      connections += 1;
      return caller(() => block({ ok: true }));
    });

    await transport('vat_config', { workspaceId: 'ws_1' });
    await transport('vat_codes', { workspaceId: 'ws_1' });

    expect(connections).toBe(1);
  });

  it('a failed connection is a readable transport_error, never a thrown exception', async () => {
    const transport = mcpTransportOver(async () => {
      throw new Error('econnrefused');
    });

    const { status, body } = await transport('list_workspaces', {});

    expect(status).toBe(0);
    expect(isErr(body) && body.error).toBe('transport_error');
  });

  it('retries the handshake on the next call rather than staying dead after one failure', async () => {
    let attempt = 0;
    const transport = mcpTransportOver(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('the engine was still starting');
      return caller(() => block({ ok: true, workspaces: [] }));
    });

    expect((await transport('list_workspaces', {})).status).toBe(0);
    expect(await transport('list_workspaces', {})).toEqual({ status: 200, body: { ok: true, workspaces: [] } });
  });

  it('a mid-session call failure is a transport_error and drops the session', async () => {
    let connections = 0;
    const transport = mcpTransportOver(async () => {
      connections += 1;
      return caller(() => {
        throw new Error('session expired');
      });
    });

    const { status, body } = await transport('list_workspaces', {});
    expect(status).toBe(0);
    expect(isErr(body) && body.error).toBe('transport_error');

    await transport('list_workspaces', {});
    expect(connections).toBe(2);
  });

  it('resetSession drops the live session (and closes it) so the next call re-handshakes', async () => {
    // M01/M03 S4.3: the served face pins identity at session open, so after accept_invite the
    // client must be able to force a FRESH session; the stale one is closed best-effort.
    let connections = 0;
    let closed = 0;
    const transport = mcpTransportOver(async () => {
      connections += 1;
      return Object.assign(caller(() => block({ ok: true })), {
        close: async () => {
          closed += 1;
        },
      });
    });

    await transport('whoami', { workspaceId: 'ws_1' });
    expect(connections).toBe(1);

    transport.resetSession?.();
    await transport('whoami', { workspaceId: 'ws_1' });

    expect(connections).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 0)); // the close is fire-and-forget
    expect(closed).toBe(1);
  });
});
