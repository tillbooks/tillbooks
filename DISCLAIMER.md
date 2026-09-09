# Disclaimer and responsible use

TILL is accounting software. Read this before you point it at real books.

## TILL is pre-alpha. Do not keep real books in it yet

The capability specs are written and the ledger core is in progress. Nothing here is finished, and
the file format is not stable. If you run TILL against your real accounts today, expect to lose the
data and redo the work. Use it to explore, not to file.

## TILL is not tax advice, and not an accountant

TILL implements Swiss rules as we understand them: the QR-bill, MWST at 8.1%, 3.8% and 2.6%, the
MWST-Abrechnung, Kontenrahmen KMU, ISO 20022. Implementing a rule is not the same as advising you on
it. The software does not know your situation, and it is not a Treuhänder.

**You remain responsible for your own books and your own filings.** If you are unsure whether
something is deductible, which MWST rate applies, whether you should be on the effective method or
the Saldosteuersatz, or what your obligations are, ask a qualified Swiss accountant or the ESTV. Do
not ask the software, and do not ask the agent driving it.

## The agent drafts. You are still the one who signs

TILL is built so an AI agent can keep the books through the MCP interface. That is the point of the
project. It does not make the agent responsible for the result. An agent can post an entry, and an
agent can be wrong, in ways that look completely plausible in a table. The Studio exists so a human
can see what was done and catch it.

Read what it did before you submit anything to anyone.

## Corrections are reversing entries, on purpose

Posted entries are append-only and immutable. TILL will not let you quietly edit history, because
real accounting does not let you either, and an audit expects to see the correction rather than a
clean-looking lie. If you want software that lets you paper over a mistake, TILL is the wrong tool.

## No warranty

TILL is provided under the MIT licence, without warranty of any kind. See [LICENSE](LICENSE). The
authors and Nomadik GmbH are not liable for any claim, damages, or other liability arising from the
software or its use, including any tax, penalty, or interest that follows from a filing you made.

## Independence

TILL is an independent clean-room project. It is not affiliated with, endorsed by, or derived from
bexio AG or any other vendor. Any compatibility is built from public documentation and from
observing our own accounts, never from anyone else's source code.
