/**
 * Re-record `app/src/surfaces/Accounts/list-accounts.fixture.json` from the live engine.
 *
 *   npm run build && node test/accounts/capture-studio-list-accounts.mjs
 *
 * The fixture is a RECORDING, never a hand-written literal. That distinction is the whole point: the
 * three Studio suites that render it (Journal, Items, Accounts) used to carry hand-typed rows, and
 * every account name in them was wrong (`Kasse` for `Kassenbestand`, `Bank` for `Bankkonto`,
 * `Dienstleistungsertrag` for `Erlöse aus eigener Produktion`). A fixture nobody can hand-edit
 * cannot drift that way, and `studio-list-accounts-fixture.test.mjs` fails the moment this file and
 * the engine disagree.
 */

import { writeFileSync } from 'node:fs';

import { liveListAccounts } from './studio-list-accounts-world.mjs';

const TARGET = new URL('../../app/src/surfaces/Accounts/list-accounts.fixture.json', import.meta.url);

const live = liveListAccounts();
writeFileSync(TARGET, `${JSON.stringify(live, null, 2)}\n`, 'utf8');
process.stdout.write(`captured ${live.accounts.length} accounts into ${TARGET.pathname}\n`);
