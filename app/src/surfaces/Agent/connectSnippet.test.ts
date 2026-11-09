/**
 * P0.5a: the MCP client config is generated from the running instance, in the docs' form, and pins
 * the agent to the Studio's own ledger and build.
 */
import { describe, it, expect } from 'vitest';

import { connectSnippet, MCP_SERVER_KEY } from './connectSnippet';

describe('connectSnippet', () => {
  it('matches the docs (tillbooks key, npx -y, mcp) and carries the open ledger path', () => {
    const s = connectSnippet({ dbPath: '/Users/beispiel/.till/firma.db', version: '1.0.0-beta.1' });
    expect(s.kind).toBe('stdio');
    if (s.kind !== 'stdio') return;
    const parsed = JSON.parse(s.json);
    expect(MCP_SERVER_KEY).toBe('tillbooks');
    expect(parsed).toEqual({
      mcpServers: {
        tillbooks: {
          command: 'npx',
          args: ['-y', 'tillbooks@1.0.0-beta.1', 'mcp'],
          env: { TILL_DB_PATH: '/Users/beispiel/.till/firma.db' },
        },
      },
    });
    expect(s.pinned).toBe('1.0.0-beta.1');
  });

  it('pins only a release-shaped version, and leaves the env out when the path is unknown', () => {
    const s = connectSnippet({ dbPath: null, version: 'unknown' });
    expect(s.kind === 'stdio' && JSON.parse(s.json)).toEqual({ mcpServers: { tillbooks: { command: 'npx', args: ['-y', 'tillbooks', 'mcp'] } } });
    const dev = connectSnippet({ dbPath: '', version: null });
    expect(dev.kind === 'stdio' && dev.dbPath).toBe(null);
  });

  it('refuses to offer a stdio block for an in-memory ledger: a second process could not open it', () => {
    expect(connectSnippet({ dbPath: ':memory:', version: '1.0.0' })).toEqual({ kind: 'memory' });
  });

  it('a path with spaces and quotes survives as valid JSON', () => {
    const s = connectSnippet({ dbPath: 'C:\\Users\\Anna "A." Muster\\till.db', version: '1.0.0' });
    expect(s.kind === 'stdio' && JSON.parse(s.json).mcpServers.tillbooks.env.TILL_DB_PATH).toBe('C:\\Users\\Anna "A." Muster\\till.db');
  });
});
