# Social profile kit

Everything to paste into the three profiles, field by field. The accounts already exist under the
handle `tillbooks` (W23) and all three were confirmed live on 30.07.2026.

**Every claim here matches the website.** That is the point of the file: a visitor who finds a profile
before finding the site must meet the same product.

**Updated 30.09.2026 for the public beta, on 10.10.2026 for the D156 positioning** (the agent-first
ERP), **and on 18.11.2026 for the LinkedIn and X launch** (19.11. to 04.12.2026, the calendar is
[docs/distribution/linkedin-launch-2026-11.md](../../docs/distribution/linkedin-launch-2026-11.md)).
Paste the X and LinkedIn fields below before the first launch post on 19.11.2026; the package is on
npm (`tillbooks@beta`). The retired false claims are absent, no market claim is made, and no price for
TILL appears anywhere.

**After D8 (02.12.2026).** The EBICS lines live in their own "after D8" variants under X and LinkedIn.
Paste them only on the day the EBICS connection module is public under MIT and the D8 post goes out;
until then the variants above them stay.

`test/web/social-copy.test.mjs` parses this file and fails if any field exceeds its platform limit, so
nothing here can be silently truncated at paste time. The counts in the tables are measured, not
estimated.

## Which asset goes where

The assets were regenerated on 30.07.2026 because they still carried the pre-D58 tagline while the
site hero carried the new one, which meant a profile and the site made two different claims about what
TILL is. They were regenerated again on 10.10.2026 with the D156 line, "The agent-first ERP for Swiss
SMEs.", for the same reason.

| Platform | Field | File | Size |
|---|---|---|---|
| All three | Avatar / logo | `brand/social/avatar.png` | 400x400, displayed as a circle |
| X | Header | `brand/social/x-header.png` | 1500x500 |
| LinkedIn | Banner | `brand/social/linkedin-banner.png` | 1128x191 |
| YouTube | Channel art | `brand/social/youtube-art.png` | 2560x1440 |

Three grounds exist for each banner in `brand/social/variants/` (light, warm, dark), plus three avatar
treatments. `brand/social/` holds the promoted picks. **LinkedIn is the one worth reconsidering**: its
page chrome is white, so the dark walnut banner reads heavy there, and `variants/linkedin-light.png`
sits better. Swap it by copying the variant up. Every ground is contrast-checked, so any pick is safe.

---

## X, `https://x.com/tillbooks`

Reachable at `https://x.com/settings/profile`. The owner's personal account is also signed in
alongside `@tillbooks`, and X's onboarding modal intercepts sidebar clicks, so go to the settings URL
directly or use a private window.

| Field | Value | Count |
|---|---|---|
| Name | `TILL` | 4 / 50 |
| Bio | `Free, open-source accounting and ERP for Swiss SMEs. Your agent does the work, you approve. Every function an MCP tool, your books one local file. Public beta.` | 159 / 160 |
| Location | `Switzerland` | 11 / 30 |
| Website | `https://tillbooks.ch` | |

The profile already carries `MCP-first open source ERP` as its bio. The line above is longer and says
what that means, which is the job of a bio somebody reads once.

### Launch post, to pin (from 19.11.2026)

X Premium is not assumed, so this is a thread of two posts of at most 280 characters each (a link
counts 23). Pin the first.

> TILL is free, open-source (MIT) accounting and ERP for Swiss SMEs. Every function is an MCP tool,
> so your agent does the work and the Studio shows you what it did. Your books are one SQLite file on
> your own machine. Public beta.
>
> https://tillbooks.ch/en/start/

> By default, your agent waits for your OK before it books anything, moves your money, grants access
> or deletes your data for good.
>
> Source, issues and stars: https://github.com/tillbooks/tillbooks

### After D8 (02.12.2026): the bio variant

Paste only on D8, when the EBICS connection module is public under MIT.

| Field | Value | Count |
|---|---|---|
| Bio, after D8 | `Free, open-source accounting and ERP for Swiss SMEs. Your agent works, you approve. Every function an MCP tool, bank statements over EBICS. Public beta.` | 152 / 160 |

---

## LinkedIn, `https://www.linkedin.com/company/tillbooks`

Company id `138174402`. Admin at `https://www.linkedin.com/company/138174402/admin/dashboard/`.
Website and industry are already set.

| Field | Value | Count |
|---|---|---|
| Tagline | `Free, open-source accounting and ERP for Swiss SMEs. Your agent does the work, you approve. MIT, local first.` | 109 / 120 |
| Website | `https://tillbooks.ch` | |
| Industry | `Software Development` | |
| Company size | `1 employee` (already set) | |
| Headquarters | `Männedorf, Zurich, Switzerland` | |

### About

Paste as one block. 1'476 of LinkedIn's 2'000 characters.

> TILL (Trusted Independent Ledger Library) is the agent-first ERP for Swiss SMEs: sales,
> purchasing, payments, stock, projects, books and MWST. It is open source, and you own the file it
> keeps your books in: a single SQLite file on your own machine, which you can copy, back up and read
> with standard tools without asking anyone for permission.
>
> Every function is exposed as an MCP tool, so an AI agent can post entries, draft invoices and
> prepare the MWST return through the same interface a human uses. The Studio is the GUI over the
> same ledger and shows you what the agent did. By default, your agent waits for your OK before it
> books anything, moves your money, grants access or deletes your data for good. Payroll stays with your payroll provider, payments are released in your
> eBanking, and the MWST return is filed in the ESTV ePortal.
>
> Swiss from the ground up: QR-Rechnung with the structured-address standard, MWST at 8.1, 3.8 and
> 2.6 percent and the Abrechnung, Kontenrahmen KMU, and ISO 20022 camt and pain.
>
> MIT licensed and free, with no limit on users, companies or bookings. Try it in two commands,
> npm install -g tillbooks@beta and then till up (Node.js 22 or newer, macOS or Linux). Not there yet:
> Windows, French and Italian.
>
> Public beta since September 2026. Nomadik GmbH keeps its own books in TILL. The source is public on
> GitHub under MIT, and we build in the open: a star or an issue helps.
>
> https://tillbooks.ch
> https://github.com/tillbooks/tillbooks

### About, German

Use this one if the audience is Swiss. 1'591 of 2'000 characters.

> TILL (Trusted Independent Ledger Library) ist das ERP für Schweizer KMU, das zuerst für KI-Agenten
> gebaut ist: Verkauf, Einkauf, Zahlungen, Lager, Projekte, Buchhaltung und MWST. Es ist quelloffen,
> und die Datei mit deinen Büchern gehört dir: eine einzige SQLite-Datei auf deinem Rechner, die du
> kopieren, sichern und mit Standardwerkzeugen lesen kannst, ohne jemanden um Erlaubnis zu fragen.
>
> Jede Funktion ist ein MCP-Tool. Ein KI-Agent bucht, schreibt Rechnungen und bereitet die
> MWST-Abrechnung vor, über dieselbe Schnittstelle, die auch ein Mensch benutzt. Im Studio siehst du
> auf demselben Hauptbuch, was der Agent getan hat. Standardmässig wartet dein Agent auf dein OK,
> bevor er etwas bucht, Geld bewegt, Zugriff gewährt oder deine Daten endgültig löscht. Die Löhne rechnet dein Lohnanbieter ab, Zahlungen gibst du im E-Banking
> frei, und die MWST-Abrechnung reichst du im ePortal der ESTV ein.
>
> Von Anfang an schweizerisch: QR-Rechnung mit strukturierter Adresse, MWST zu 8,1, 3,8 und 2,6 Prozent
> samt Abrechnung, Kontenrahmen KMU sowie ISO 20022 camt und pain.
>
> MIT-lizenziert und kostenlos, ohne Grenze bei Benutzern, Firmen oder Buchungen. Ausprobieren mit
> zwei Befehlen, npm install -g tillbooks@beta und dann till up (Node.js 22 oder neuer, macOS oder
> Linux). Noch nicht dabei: Windows, Französisch und Italienisch.
>
> Seit September 2026 öffentliche Beta. Die Nomadik GmbH führt ihre eigenen Bücher in TILL. Der
> Quellcode ist unter MIT auf GitHub öffentlich, und wir bauen offen weiter: Ein Stern oder ein Issue
> hilft.
>
> https://tillbooks.ch
> https://github.com/tillbooks/tillbooks

### After D8 (02.12.2026): the Swiss paragraph, both languages

Paste only on D8, when the EBICS connection module is public under MIT. It replaces the "Swiss from
the ground up" paragraph of the About above (and its German twin); everything else stays.

> Swiss from the ground up: QR-Rechnung with the structured-address standard, MWST at 8.1, 3.8 and
> 2.6 percent and the Abrechnung, Kontenrahmen KMU, ISO 20022 camt and pain, and an open-source
> EBICS 3.0 client that fetches your camt.053 statements over your own EBICS contract with your bank.
> It only downloads: TILL never sends a payment.

> Von Anfang an schweizerisch: QR-Rechnung mit strukturierter Adresse, MWST zu 8,1, 3,8 und 2,6 Prozent
> samt Abrechnung, Kontenrahmen KMU, ISO 20022 camt und pain sowie ein quelloffener EBICS-3.0-Client,
> der deine camt.053-Auszüge über deinen eigenen EBICS-Vertrag mit deiner Bank abholt. Er holt nur ab:
> TILL sendet nie eine Zahlung.

---

## YouTube, `https://www.youtube.com/@tillbooks`

Channel `UCrl73rey084gWCAbLduDmBw`. Edit at `https://studio.youtube.com` under Customisation.

| Field | Value | Count |
|---|---|---|
| Name | `TILL` | 4 / 100 |
| Handle | `@tillbooks` | 10 / 30 |
| Links | `tillbooks.ch` -> `https://tillbooks.ch` | |
| Contact | `hello@tillbooks.ch` | |

### Description

819 of YouTube's 1'000 characters.

> TILL (Trusted Independent Ledger Library) is the agent-first ERP for Swiss SMEs: sales,
> purchasing, payments, stock, projects, books and MWST. Your books live in a single SQLite file on
> your own machine, which you can copy, back up and read without asking anyone's permission.
>
> Every function is exposed as an MCP tool, so your agent runs it and the Studio shows you what it
> did. By default, your agent waits for your OK before it books anything, moves your money, grants
> access or deletes your data for good.
>
> Swiss from the ground up: QR-Rechnung with structured addresses, MWST at 8.1, 3.8 and 2.6 percent
> and the Abrechnung, Kontenrahmen KMU, ISO 20022 camt and pain.
>
> MIT licensed and free. Public beta since September 2026: Nomadik GmbH keeps its own books in TILL,
> and we build in the open.
>
> https://tillbooks.ch

---

## What must not go in any profile

These are the claims the specs retired after checking them against the code. Each was plausible and
each is false, so they get named rather than merely omitted.

| Do not write | Why | Write instead |
|---|---|---|
| Any count of TILL's own verbs or tools | The number in the code and the design target are different things and only one is a fact | The composition argument, and QuickBooks' 145 as a fact about QuickBooks (their README, read 28.10.2026) |
| "TILL opens no socket", and since beta.6 "TILL makes no outbound connection" | `till serve` binds one on localhost by design, for the Studio and the MCP face; a settlement feed you set up fetches over HTTPS (`settlement.pull_mode`) | "TILL connects out only to what you set up, such as a settlement feed (and from D8 your bank). No telemetry, no call home." |
| "No German-speaking vendor has shipped an official MCP server", and the narrower "No Swiss or German-speaking SME accounting vendor has shipped an official MCP server" | The vendors that have include SAP SE, and since D181 (28.10.2026) the Swiss Infinity advertises native MCP: both universal negatives are false | A dated fact about a named vendor, from its own publication, or the architecture argument with no market claim at all |
| Any price for TILL | No paid tier exists | bexio's published prices as a dated fact about bexio, if a comparison is needed |
| "Free forever" about any future tier | A lifetime pricing promise about a tier that does not exist | "The core is MIT and free" |
| Append-only described as legally required | It is better practice and the basis for OR Art. 958 Abs. 1, not a statutory mandate | "Append-only, with corrections as reversing entries" |
| "Nothing happens without your OK", "everything waits for your OK", "alles wartet auf dein OK" | Drafts and contact edits run without asking, and reads never ask | "By default, your agent waits for your OK before it books anything, moves your money, grants access or deletes your data for good" |
| "Anything that can't be undone waits for your OK", "Nothing irreversible happens without your OK", "was sich nicht rückgängig machen lässt, wartet auf dein OK", "alles Unwiderrufliche wartet auf dein OK" | Not our claim (D160): the boundary is what a write touches, not whether it can be undone. A task, a note or a draft runs without asking even when it leaves a trace | The consequence claim above, which names what the dial gates by default |
| "Waits for your OK before it touches your books", "changes who has access", "bevor er deine Buchhaltung anrührt", "Zugriffe ändert" | Drafts, chart-of-accounts and VAT-code edits touch the books and run free; revoking a portal link or disabling a plugin changes access and runs free | The claim above, which names acts: books anything, moves your money, grants access, deletes your data for good |
| "Waits for your OK before it sends your data out", "bevor er deine Daten verschickt" | An agent may edit a contact's email without asking, and your own automatic sends then go to that address | The claim above, which names booking, moving money, granting access and deleting for good |
| "Connects to your bank", "automatic bank sync", "open-source EBICS" (until D8, 02.12.2026) | The module that connects the EBICS client to a bank is not published yet, so the public release cannot reach a bank. From D8 the "after D8" variants apply, and even then "connects to your bank" stays too broad: it downloads statements over your own EBICS contract and sends nothing | "The EBICS client is built and tested with ZKB's test platform"; from D8, "an open-source EBICS 3.0 client that fetches your camt.053 statements over your own EBICS contract" |

Also: no em dashes, sentence case only, and never `effortless`, `seamless`, `supercharge`, `unlock` or
`revolutionize`. German uses `du`, real umlauts, and never `ß`.
