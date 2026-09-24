import { readFileSync } from 'node:fs';

import { defineConfig } from 'vite';

/**
 * The engine version, baked in at build time.
 *
 * G08's crash path composes its report in the browser precisely because the engine may be
 * unreachable, so it cannot ask the engine what version it is. Without this the one report written
 * when everything else is broken was the one report that could not say which build produced it.
 */
const TILL_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
import react from '@vitejs/plugin-react';

import { devApiPlugin } from './dev-api';

export default defineConfig({
  define: { __TILL_VERSION__: JSON.stringify(TILL_VERSION) },
  plugins: [react(), devApiPlugin()],
  server: {
    port: 5173,
    // The app imports the canonical design tokens from ../brand, outside the app root. Vite's dev
    // server refuses to serve files outside the project root unless the parent is allow-listed.
    fs: { allow: ['..'] },
    // The ledger now lives at TILL_DB_PATH (default `~/.till/till.db`), OUTSIDE the Vite root, so the
    // watcher no longer sees ledger writes at all. The ignore stays for the case where someone points
    // TILL_DB_PATH back inside the project: without it, every write touches `till.db-wal`, the watcher
    // fires, and the page full-reloads mid-flow.
    watch: { ignored: ['**/.dev-data/**', '**/*.db', '**/*.db-wal', '**/*.db-shm'] },
  },
});
