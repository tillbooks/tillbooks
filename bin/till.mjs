#!/usr/bin/env node
/**
 * The `till` command.
 *
 * The package is `tillbooks` (the bare `till` is taken on npm), but a bin name is independent of
 * the package name, so the command itself stays short.
 *
 * The `mcp` command starts the real MCP stdio server (Phase E) from the built core.
 */

import { readFileSync } from 'node:fs';

// The single source of truth for the version is package.json; the release bump touches that, and
// `till --version` / the help header follow automatically. Works from source and from the
// published package (bin/till.mjs and package.json sit at the package root together).
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const USAGE = `till ${VERSION} - Swiss accounting your agent can actually use

  Usage: till <command> [options]

  Commands:
    up         Start everything (Studio + REST + /mcp + scheduler) and open the browser
    mcp        Start the MCP server on stdio (the agent interface)
    serve      Start the MCP server over HTTP at /mcp (the Studio transport, D23)
    version    Print the version
    help       Print this

  up is the one command a human runs: it binds 127.0.0.1:8788 (TILL_PORT and
  TILL_HOST honoured), serves the built Studio at /, mounts the REST twins at
  /api/:action beside /mcp, starts the local scheduler tick that fires due
  recurring invoices and dunning cadences, prints the URL and opens your
  browser. A second "till up" finds the first, opens the browser at it, and
  exits. Pass --no-open (or TILL_NO_OPEN=1) to keep the browser shut.

  The MCP server reads its SQLite path from TILL_DB_PATH, defaulting to
  ~/.till/till.db. The Studio resolves the SAME path, so the agent and the human
  work on one ledger. Set TILL_DB_PATH=:memory: for a throwaway run.

  serve binds 127.0.0.1:8788. TILL_PORT takes decimal digits, 1 to 65535, and
  refuses anything else instead of reinterpreting it. TILL_HOST accepts loopback
  only: 127.0.0.1 (all of 127.0.0.0/8), ::1, localhost, *.localhost.

  A non-loopback bind (0.0.0.0, ::, a LAN address) is REFUSED, because the /mcp
  host checks Host and Origin as a DNS-rebinding defence and that is not
  authentication: anything that can reach the port drives the whole action
  registry against the real ledger, post_entry and send_invoice included, with no
  password. If you are in a container or a VM and mean it, set
  TILL_EXPOSE_LEDGER_UNAUTHENTICATED=1 and put your own authentication in front.

  Docs: https://tillbooks.ch
`;

const [, , command = 'help'] = process.argv;

switch (command) {
  case 'version':
  case '--version':
  case '-v':
    console.log(VERSION);
    break;

  case 'mcp': {
    // Loaded lazily from the build output so `version`/`help` never pay for the server or its
    // native SQLite dependency. The stdio transport keeps the process alive once connected.
    const { startMcpServer } = await import(new URL('../dist/api/mcp.js', import.meta.url));
    const { ensureDbPath } = await import(new URL('../dist/api/db-path.js', import.meta.url));
    // Always a resolved path, never an implicit in-memory database: an agent that posts into a
    // ledger nobody else can see is worse than one that refuses to start.
    const { store } = await startMcpServer({ dbPath: ensureDbPath() });
    // Closing the store is what checkpoints the write-ahead log. Without this the process exits with
    // its WAL still holding the last writes, and `till.db-wal` grows every run.
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      store.close();
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    process.once('beforeExit', () => store.close());
    break;
  }

  case 'up': {
    // The one-command human entry point (M00). Assembles the built Studio + REST + /mcp + the
    // scheduler tick on one loopback process. Loaded lazily from the build output so `version`/`help`
    // never pay for the server or its native SQLite dependency.
    const { startUp } = await import(new URL('../dist/api/up.js', import.meta.url));
    const { resolvePortEnv } = await import(new URL('../dist/api/serve.js', import.meta.url));
    const { ensureDbPath } = await import(new URL('../dist/api/db-path.js', import.meta.url));
    const host = process.env.TILL_HOST ?? '127.0.0.1';
    const noOpen = process.argv.includes('--no-open') || process.env.TILL_NO_OPEN === '1';
    let result;
    try {
      const port = resolvePortEnv(process.env.TILL_PORT);
      result = await startUp({ dbPath: ensureDbPath(), port, host, open: !noOpen });
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    if (!result.started) {
      // A live instance already owns the machine: point at it, open the browser there, and exit 0.
      // Starting a second scheduler on one database is the exact double-fire the lock prevents.
      console.error(`till up: already running at ${result.holder.url} (pid ${result.holder.pid}). Opening it.`);
      if (!noOpen) {
        const { openBrowser } = await import(new URL('../dist/api/up.js', import.meta.url));
        openBrowser(result.holder.url);
      }
      process.exit(0);
    }
    console.error(`till up: Studio${result.studioServed ? '' : ' (not built)'} at ${result.url}`);
    console.error(`till up: MCP over HTTP at ${result.url}/mcp, REST at ${result.url}/api`);
    let closingUp = false;
    const shutdownUp = () => {
      if (closingUp) return;
      closingUp = true;
      result.close().finally(() => process.exit(0));
    };
    process.once('SIGINT', shutdownUp);
    process.once('SIGTERM', shutdownUp);
    break;
  }

  case 'serve': {
    // The production /mcp StreamableHTTP host (D23): the same server the Studio speaks, so an A11
    // demo runs against a real ledger with no Vite in front. Loaded lazily from the build output.
    const { startHttpServer, resolvePortEnv } = await import(new URL('../dist/api/serve.js', import.meta.url));
    const { ensureDbPath } = await import(new URL('../dist/api/db-path.js', import.meta.url));
    const host = process.env.TILL_HOST ?? '127.0.0.1';
    // Both bind policies live in serve.js so an embedder gets them too, and both refuse before the
    // store is opened: `ensureDbPath` runs inside the try, AFTER the port is parsed, so a refused
    // run does not even create ~/.till. Here the CLI only has to fail like a CLI: the message, no
    // stack trace, a non-zero exit, and nothing served.
    let handle;
    try {
      const port = resolvePortEnv(process.env.TILL_PORT);
      handle = await startHttpServer({ dbPath: ensureDbPath(), port, host });
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    console.error(`till serve: MCP over HTTP at ${handle.url}/mcp`);
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      handle.close().finally(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    break;
  }

  case 'help':
  case '--help':
  case '-h':
    console.log(USAGE);
    break;

  default:
    console.error(`till: unknown command "${command}"\n`);
    console.error(USAGE);
    process.exit(1);
}
