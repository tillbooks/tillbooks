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
  work on one ledger. Set TILL_DB_PATH=:memory: for a throwaway run. On start,
  mcp prints on stderr the ledger it opened and the Studio where a human approves
  what the agent drafts (Agent > Vorschläge), or that none runs and till up starts it.

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
    const { ensureDbChoice, adoptedUnavailableRefusal } = await import(new URL('../dist/api/db-path.js', import.meta.url));
    // Always a resolved path, never an implicit in-memory database: an agent that posts into a
    // ledger nobody else can see is worse than one that refuses to start.
    let store;
    let dbPath;
    let choice;
    try {
      choice = ensureDbChoice();
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    // D166 point 8 (critic F1, L-b): the person adopted a book that is not there, or that the read-only
    // probe refuses now (a swapped foreign file, a lost or read-only permission). Never open another
    // one in its place, and never open this one writable (not even a WAL header): one plain sentence,
    // the same answer `till up` gives, and the Studio says what to do.
    const { adoptedChoiceUnavailable } = await import(new URL('../dist/api/book-adopt.js', import.meta.url));
    const unavailable = adoptedChoiceUnavailable(choice);
    if (unavailable !== null) {
      console.error(adoptedUnavailableRefusal('till mcp', unavailable));
      process.exit(1);
    }
    try {
      dbPath = choice.path;
      ({ store } = await startMcpServer({ dbPath }));
    } catch (e) {
      // A refused open (a book written by a newer TILL, `schema_newer_than_runtime`) is a sentence for
      // the human on stderr and a non-zero exit, the way `up` and `serve` fail below, never a stack
      // trace. stdout stays clean: it is the MCP channel.
      if (choice.source === 'adopted') console.error(adoptedUnavailableRefusal('till mcp', { path: choice.path, reason: 'unopenable' }));
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    // P0.5c: on STDERR only (stdout is the MCP channel): which ledger this agent opened, and the
    // Studio where a human approves what it drafts, or how to start one. A banner that cannot be
    // computed is never a reason to stop serving.
    try {
      const { mcpStartLines } = await import(new URL('../dist/api/approval-pointer.js', import.meta.url));
      for (const line of mcpStartLines({ dbPath })) console.error(line);
    } catch {
      // Serving matters more than the banner.
    }
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
    const { ensureDbChoice } = await import(new URL('../dist/api/db-path.js', import.meta.url));
    const host = process.env.TILL_HOST ?? '127.0.0.1';
    const noOpen = process.argv.includes('--no-open') || process.env.TILL_NO_OPEN === '1';
    let result;
    let closingUp = false;
    // A restart asked for before `startUp` has returned is queued and run as soon as it has (critic L3).
    let restartQueued = false;
    // D166 point 8: the Studio adopted an existing book (`POST /studio/adopt-book`, after the answer is
    // out) and this process must come back on it, without a terminal. The book path is re-resolved on
    // the next start (`resolveDbPath` reads the adopted book), so a restart is all it takes:
    //   - under TILL.app (`TILL_SUPERVISED=app`, set by the app for its child), close and exit 75: the
    //     app sees its server go and starts it again, then reloads its window signed in;
    //   - otherwise (a terminal, a launcher), close (which frees the lock and the port), then start a
    //     DETACHED successor with the same node, flags, arguments and environment plus TILL_NO_OPEN=1
    //     (the tab that asked reloads itself), and exit 0. Being detached, the successor outlives the
    //     terminal's job: stop it with the TILL icon's Quit or a plain kill, as any background server.
    const restartUp = () => {
      if (result === undefined) {
        restartQueued = true;
        return;
      }
      if (closingUp || !result.started) return;
      closingUp = true;
      const supervised = process.env.TILL_SUPERVISED === 'app';
      result
        .close()
        .catch(() => {})
        .then(async () => {
          if (supervised) process.exit(75);
          const { spawn } = await import('node:child_process');
          try {
            const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
              detached: true,
              stdio: 'inherit',
              env: { ...process.env, TILL_NO_OPEN: '1' },
            });
            child.unref();
          } catch (e) {
            console.error(`till up: could not restart by itself (${e instanceof Error ? e.message : String(e)}). Start TILL again to open the adopted book.`);
            process.exit(1);
          }
          console.error('till up: restarting to open the adopted book.');
          process.exit(0);
        });
    };
    try {
      const port = resolvePortEnv(process.env.TILL_PORT);
      // D166: the Studio link (a one-time ticket) goes to a terminal only, never into a log file.
      // D166 point 8 (critic F1/F2): an adopted book that is missing, or that fails to open, starts the
      // Studio on its "not reachable" page (an in-memory book that writes nowhere), never on another book.
      const choice = ensureDbChoice();
      result = await startUp({
        dbPath: choice.path,
        port,
        host,
        open: !noOpen,
        announceStudioLink: process.stderr.isTTY === true,
        onRestartRequested: restartUp,
        ...(choice.source === 'adopted'
          ? {
              adoptedBook:
                choice.adoptedUnavailable !== undefined
                  ? { path: choice.adoptedUnavailable.path, unavailable: 'missing' }
                  : { path: choice.path },
            }
          : {}),
      });
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    if (restartQueued) restartUp();
    if (!result.started) {
      // A live instance already owns the machine: point at it, open the browser there, and exit 0.
      // Starting a second scheduler on one database is the exact double-fire the lock prevents.
      // The holder URL carries a one-time ticket derived from the key file (D166): print it to a
      // terminal only, and open it through `openStudioLink`, which keeps it off the command line on macOS.
      const { redactStudioLink } = await import(new URL('../dist/api/up.js', import.meta.url));
      const shown = process.stderr.isTTY === true ? result.holder.url : redactStudioLink(result.holder.url);
      console.error(`till up: already running at ${shown} (pid ${result.holder.pid}). Opening it.`);
      if (!noOpen) {
        const { openStudioLink } = await import(new URL('../dist/api/up.js', import.meta.url));
        openStudioLink(result.holder.url);
      }
      process.exit(0);
    }
    // The Studio opens through the #k= link (D162), which TILL.app and a terminal banner hand over (D166).
    console.error(`till up: engine at ${result.url}${result.studioServed ? '' : ' (Studio not built)'}`);
    console.error(`till up: MCP over HTTP at ${result.url}/mcp, REST at ${result.url}/api`);
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
    const { ensureDbChoice, adoptedUnavailableRefusal } = await import(new URL('../dist/api/db-path.js', import.meta.url));
    const host = process.env.TILL_HOST ?? '127.0.0.1';
    // Both bind policies live in serve.js so an embedder gets them too, and both refuse before the
    // store is opened: `ensureDbChoice` runs inside the try, AFTER the port is parsed, so a refused
    // run does not even create ~/.till. Here the CLI only has to fail like a CLI: the message, no
    // stack trace, a non-zero exit, and nothing served. An adopted book that is not there is refused
    // the way `till mcp` refuses it (D166 point 8): never another book in its place.
    let handle;
    try {
      const port = resolvePortEnv(process.env.TILL_PORT);
      const choice = ensureDbChoice();
      const { adoptedChoiceUnavailable } = await import(new URL('../dist/api/book-adopt.js', import.meta.url));
      const unavailable = adoptedChoiceUnavailable(choice);
      if (unavailable !== null) throw new Error(adoptedUnavailableRefusal('till serve', unavailable));
      handle = await startHttpServer({ dbPath: choice.path, port, host });
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
