# Social profile kit

Everything to paste into the three profiles, field by field. The accounts already exist under the
handle `tillbooks` (W23) and all three were confirmed live on 30.07.2026.

**Every claim here matches the website.** That is the point of the file: a visitor who finds a profile
before finding the site must meet the same product. The three retired false claims are absent, the
market claim is the narrow one, and no price for TILL appears anywhere.

`test/web/social-copy.test.mjs` parses this file and fails if any field exceeds its platform limit, so
nothing here can be silently truncated at paste time. The counts in the tables are measured, not
estimated.

## Which asset goes where

The assets were regenerated on 30.07.2026 because they still carried the pre-D58 tagline while the
site hero carried the new one, which meant a profile and the site made two different claims about what
TILL is.

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

Reachable at `https://x.com/settings/profile`. The owner is signed in as `@21Funkyy` alongside
`@tillbooks` and X's onboarding modal intercepts sidebar clicks, so go to the settings URL directly or
use a private window.

| Field | Value | Count |
|---|---|---|
| Name | `TILL` | 4 / 50 |
| Bio | `Open-source ERP for Swiss businesses. The MCP server is the interface, not an AI button. Your books stay in one SQLite file on your machine. Pre-alpha.` | 151 / 160 |
| Location | `Switzerland` | 11 / 30 |
| Website | `https://tillbooks.ch` | |

The profile already carries `MCP-first open source ERP` as its bio. The line above is longer and says
what that means, which is the job of a bio somebody reads once.

### First post, to pin

> TILL is an open-source ERP for Swiss businesses, and its interface is an MCP server rather than an
> AI feature bolted onto a GUI. Your books live in one SQLite file on your own machine.
>
> Pre-alpha: it cannot keep real books yet. Building in the open.
>
> https://tillbooks.ch

---

## LinkedIn, `https://www.linkedin.com/company/tillbooks`

Company id `138174402`. Admin at `https://www.linkedin.com/company/138174402/admin/dashboard/`.
Website and industry are already set.

| Field | Value | Count |
|---|---|---|
| Tagline | `Open-source ERP for Swiss businesses. Agent first, MCP native, local first.` | 75 / 120 |
| Website | `https://tillbooks.ch` | |
| Industry | `Software Development` | |
| Company size | `1 employee` (already set) | |
| Headquarters | `Männedorf, Zurich, Switzerland` | |

### About

Paste as one block. 1'070 of LinkedIn's 2'000 characters.

> TILL (Trusted Independent Ledger Library) is an open-source ERP for Swiss businesses, and you own
> the file it keeps your books in. It is a single SQLite file on your own machine, which you can copy,
> back up and read with standard tools without asking anyone for permission.
>
> It is built agent first. The interface is an MCP server rather than an AI feature added to a GUI, so
> an AI agent can post entries, draft invoices and prepare the MWST return through the same interface
> a human uses. The Studio is the GUI over the same ledger, for the moments somebody has to decide.
>
> Swiss from the ground up: QR-Rechnung with the structured-address standard, MWST at 8.1, 3.8 and
> 2.6 percent and the Abrechnung, Kontenrahmen KMU, and ISO 20022 camt and pain.
>
> MIT licensed, and the core stays free. A Swiss-hosted cloud tier is planned later as the paid layer,
> for teams that do not want to run banking and backups themselves.
>
> Pre-alpha as of July 2026: the ledger cannot keep real books yet, and the source opens when it can.
> We are building in the open.
>
> https://tillbooks.ch

### About, German

Use this one if the audience is Swiss. 1'176 of 2'000 characters.

> TILL (Trusted Independent Ledger Library) ist ein quelloffenes ERP für Schweizer Unternehmen, und
> die Datei mit deinen Büchern gehört dir. Es ist eine einzige SQLite-Datei auf deinem Rechner, die du
> kopieren, sichern und mit Standardwerkzeugen lesen kannst, ohne jemanden um Erlaubnis zu fragen.
>
> Gebaut ist es Agent first. Die Schnittstelle ist ein MCP-Server und keine KI-Funktion in einer
> Oberfläche, damit ein KI-Agent buchen, Rechnungen schreiben und die MWST-Abrechnung vorbereiten kann,
> über dieselbe Schnittstelle, die auch ein Mensch benutzt. Das Studio ist die Oberfläche auf dasselbe
> Hauptbuch, für die Momente, in denen jemand entscheiden muss.
>
> Von Anfang an schweizerisch: QR-Rechnung mit strukturierter Adresse, MWST zu 8,1, 3,8 und 2,6 Prozent
> samt Abrechnung, Kontenrahmen KMU sowie ISO 20022 camt und pain.
>
> MIT-lizenziert, und der Kern bleibt kostenlos. Geplant ist später eine in der Schweiz gehostete
> Cloud-Variante als bezahlte Ebene, für Teams, die Banking und Backups nicht selbst machen wollen.
>
> Stand Juli 2026 Pre-Alpha: das Hauptbuch kann noch keine echten Bücher führen, und der Quellcode
> wird öffentlich, sobald es das kann.
>
> https://tillbooks.ch

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

661 of YouTube's 1'000 characters.

> TILL (Trusted Independent Ledger Library) is an open-source ERP for Swiss businesses. Your books
> live in a single SQLite file on your own machine, which you can copy, back up and read without
> asking anyone's permission.
>
> It is built agent first. The interface is an MCP server rather than an AI feature bolted onto a GUI,
> so an agent and a human share one ledger.
>
> Swiss from the ground up: QR-Rechnung with structured addresses, MWST at 8.1, 3.8 and 2.6 percent
> and the Abrechnung, Kontenrahmen KMU, ISO 20022 camt and pain.
>
> MIT licensed. Pre-alpha as of July 2026: the ledger cannot keep real books yet, and we are building
> in the open.
>
> https://tillbooks.ch

---

## What must not go in any profile

These are the claims the specs retired after checking them against the code. Each was plausible and
each is false, so they get named rather than merely omitted.

| Do not write | Why | Write instead |
|---|---|---|
| Any count of TILL's own verbs or tools | The number in the code and the design target are different things and only one is a fact | The composition argument, and QuickBooks' 144 as a fact about QuickBooks |
| "TILL opens no socket" | `till serve` binds one on localhost by design, for the Studio and the MCP face | "TILL makes no outbound connection" |
| "No German-speaking vendor has shipped an official MCP server" | The vendors that have include SAP SE | "No Swiss or German-speaking SME accounting vendor has shipped an official MCP server", dated |
| Any price for TILL | No paid tier exists | bexio's published prices as a dated fact about bexio, if a comparison is needed |
| "Free forever" about any future tier | A lifetime pricing promise about a tier that does not exist | "The core is MIT and free" |
| Append-only described as legally required | It is better practice and the basis for OR Art. 958 Abs. 1, not a statutory mandate | "Append-only, with corrections as reversing entries" |
| A link to a public repository | It does not exist yet (D9) | "The source opens when the ledger is real" |

Also: no em dashes, sentence case only, and never `effortless`, `seamless`, `supercharge`, `unlock` or
`revolutionize`. German uses `du`, real umlauts, and never `ß`.
