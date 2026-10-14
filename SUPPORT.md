# Support

Thanks for trying TILL. Here is where to get help, and what to expect.

## First, the honest bit

TILL is in public beta, built by Nomadik GmbH, a small Swiss company. During the beta, help is free
and best effort. There is no support contract, no SLA, no guaranteed response time and no phone
line. We read every mail and every issue.

## Paid help with setup and with moving from bexio

If you would rather not set TILL up alone, Nomadik GmbH does it with you, for a fee. That covers
setting up your company, and moving your books from bexio, including the parallel run that checks
TILL's figures against bexio's before you switch. Write to **hello@tillbooks.ch** and tell us what
you need.

<!-- TODO(website): link the pricing page here once tillbooks.ch publishes it (launch plan W4).
     Prices stay on the website only. -->

## Documentation

Start with the README and the docs in [site-docs/](site-docs).

## Questions, bugs, and ideas

**From inside TILL** is the shortest path. **Send feedback** is the speech-bubble icon at the bottom
of the sidebar, and an error on screen offers **Report this error** next to it. TILL writes the
report to `~/.till/feedback/`, shows you exactly what it says, and opens your mail app addressed to
**hello@tillbooks.ch**. It cannot send anything itself, so nothing leaves your machine until you
press send. If you would rather read the file first, the path is on screen.

Error details are only attached if you switched that on under **Settings → Operations → Diagnostics
& feedback**. It is off until you turn it on, that panel lists exactly what would be recorded, and you
can read or delete the lot at any time. TILL records error codes, which action failed and the line
numbers in our own code. It never records amounts, names, account numbers, or anything you typed.

Agents can do all of this too, over MCP: `prepare_feedback` writes the report and hands back a
mailto link. An agent can switch error recording on with `set_diagnostics`, and it should only do that
when you ask it to. You see the setting in that panel and can turn it off there at any time.

**In public**, open an issue at
[github.com/tillbooks/tillbooks/issues](https://github.com/tillbooks/tillbooks/issues). Leave out
anything from your books: amounts, names, IBANs and account numbers do not belong in a public issue.

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
