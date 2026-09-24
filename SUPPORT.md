# Support

Thanks for trying TILL. Here is where to get help, and what to expect.

## First, the honest bit

TILL is pre-alpha and maintained part time. There is no support contract, no SLA, and no guaranteed
response time. If you need software you can call someone about today, TILL is not that yet.

## Documentation

Start with the README and the docs in [site-docs/](site-docs).

## Questions, bugs, and ideas

**From inside TILL** is the shortest path: **Send feedback** sits at the bottom of the sidebar, and an
error on screen offers **Report this error** next to it. TILL writes the report to
`~/.till/feedback/`, shows you exactly what it says, and opens your mail app addressed to
**hello@tillbooks.ch**. It cannot send anything itself, so nothing leaves your machine until you
press send. If you would rather read the file first, the path is on screen.

Error details are only attached if you switched that on under **Setup → Diagnostics & feedback**. It
is off until you turn it on, that panel lists exactly what would be recorded, and you can read or
delete the lot at any time. TILL records error codes, which action failed and the line numbers in
our own code. It never records amounts, names, account numbers, or anything you typed.

Agents can do all of this too, over MCP: `prepare_feedback` writes the report and hands back a
mailto link. An agent cannot turn error recording on for you.

**A public issue tracker is not open yet.** TILL is licensed MIT and the source opens when the
ledger can keep real books; until then there is no public repository to file against, so the mail
route above is the only one. If you want a report to be public and searchable, say so in the mail
and it will be carried over when the tracker opens.

- **Bug**: tell us what you did, what you expected, and what happened. Steps to reproduce are worth
  more than a description of the symptom.
- **Feature request**: tell us the problem, not the solution you have in mind. The problem survives
  longer.
- **Question**: ask. If the docs did not answer it, that is a documentation bug and we want to know.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md), or mail
**security@tillbooks.ch**.

## Anything else

**hello@tillbooks.ch**.

## What we cannot help with

We cannot tell you how to do your accounting. Whether a cost is deductible, which MWST rate applies
to what you sell, or whether you should file with the effective method or the Saldosteuersatz are
questions for a qualified Swiss accountant or the ESTV. See [DISCLAIMER.md](DISCLAIMER.md).
