import { describe, it, expect, beforeEach } from 'vitest';

import {
  WORKSPACE_STORAGE_KEY,
  isWorkspaceId,
  readWorkspaceIdFromPath,
  readStoredWorkspaceId,
  storeWorkspaceId,
  resolveInitialWorkspaceId,
} from './workspace-store';
import { installMemoryStorage } from './test-support';

beforeEach(() => {
  installMemoryStorage();
});

describe('readWorkspaceIdFromPath', () => {
  it('reads the id out of /w/:workspaceId', () => {
    expect(readWorkspaceIdFromPath('/w/ws_42')).toBe('ws_42');
  });

  it('reads it out of a deeper path too, so a bookmarked surface keeps its tenant', () => {
    expect(readWorkspaceIdFromPath('/w/ws_42/journal')).toBe('ws_42');
  });

  it('is null for a bare root or any other surface path', () => {
    expect(readWorkspaceIdFromPath('/')).toBeNull();
    expect(readWorkspaceIdFromPath('/accounts')).toBeNull();
    expect(readWorkspaceIdFromPath('/w/')).toBeNull();
  });

  it('rejects a path segment that is not a workspace id, rather than passing it to the engine', () => {
    expect(readWorkspaceIdFromPath('/w/..%2Fetc')).toBeNull();
    expect(readWorkspaceIdFromPath('/w/acct_1')).toBeNull();
  });
});

describe('isWorkspaceId', () => {
  it('accepts a minted id and refuses anything else', () => {
    expect(isWorkspaceId('ws_01HX')).toBe(true);
    expect(isWorkspaceId('ws_')).toBe(false);
    expect(isWorkspaceId('nope')).toBe(false);
    expect(isWorkspaceId('')).toBe(false);
    expect(isWorkspaceId(null)).toBe(false);
  });
});

describe('localStorage round trip', () => {
  it('stores and reads back the selected workspace', () => {
    storeWorkspaceId('ws_7');
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe('ws_7');
    expect(readStoredWorkspaceId()).toBe('ws_7');
  });

  it('clearing the selection removes the key rather than storing "null"', () => {
    storeWorkspaceId('ws_7');
    storeWorkspaceId(null);
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();
    expect(readStoredWorkspaceId()).toBeNull();
  });

  it('ignores a stored value that is not a workspace id', () => {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, 'DROP TABLE workspace');
    expect(readStoredWorkspaceId()).toBeNull();
  });
});

describe('resolveInitialWorkspaceId', () => {
  it('the URL wins over the stored fallback', () => {
    storeWorkspaceId('ws_stored');
    expect(resolveInitialWorkspaceId('/w/ws_url')).toBe('ws_url');
  });

  it('a bare root falls back to the stored id', () => {
    storeWorkspaceId('ws_stored');
    expect(resolveInitialWorkspaceId('/')).toBe('ws_stored');
  });

  it('is null when neither the URL nor storage names one', () => {
    expect(resolveInitialWorkspaceId('/')).toBeNull();
  });
});
