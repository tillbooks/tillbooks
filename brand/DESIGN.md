# TILL design law

This is not a mood board. It is the law the Studio builds to. When a design question comes up, the
answer is here, and if it is not here, the answer gets added here before it gets built.

The product is used by people who did not want to be doing accounting. Respect that: calm, quiet,
legible, fast to scan, impossible to mistrust.

## The one-line brief

A till is a cash drawer: plain, sturdy, unremarkable, and completely trusted. Build that.

## The direction: Brass

TILL sits deliberately in the Stripe / Linear / Vercel band of operator tools: conventional over
original, dense but legible, colour held in reserve. We are not trying to win a dribbble contest.
The product earns trust the way a good ledger does, by being the same every time you open it.

The Brass system, in one paragraph: the ground is warm paper in **light mode, which is the
default**, and walnut in dark. Dark is a **first-class parity theme**, built and judged alongside
light, never an afterthought. There is **one accent**, brass, and it is spent only on attention
(focus, the selected item, the single primary action on a surface), never on decoration. Money has
its own semantics, status has its own colours, and neither borrows the accent.

**Brass replaced Pine on 29.07.2026 (D53), and the reason is a measurement rather than a taste.**
Pine's accent and its success colour measured **8.5 &Delta;E apart in dark**, below the ~10 where
the eye stops resolving two colours, so the sentence this document used to carry, that success
"never reads as the accent", was false in the theme where it mattered. The cause is structural:
status is green, amber and red, so an accent must clear all three, and only achromatic ink and blue
can. Blue is the Ink palette D5 already retired. Brass is the one colour that is neither a status
nor an arbitrary pick: it is the metal of the drawer the product is named after.

**Warning is orange, not amber, and that is a consequence.** Brass occupies amber. Do not tidy warn
back toward yellow without re-measuring, because it will collide with the accent.

**Every pair is measured, not asserted.** Both themes clear 18 contrast gates and all 6
accent-and-status separation pairs at 25 &Delta;E or better. The numbers live next to the values in
[tokens/tokens.css](tokens/tokens.css). Re-run them before changing any colour.

The values live in [tokens/tokens.css](tokens/tokens.css), **the source of truth and the only file
the Studio imports.**

> **There is no JSON export of the tokens, and re-creating one needs a consumer first.**
> `tokens/tokens.json` existed until 2026-07-29 and was deleted: it still carried the retired
> **Ink** system (`#f6f7f9` grounds, `#35618e` accent) where the CSS is **Pine** (`#f6f5f2`,
> `#2f6153`, per D5), it was described here as "the same values for the asset pipeline", and there
> was no asset pipeline. Nothing imported it. An unconsumed file that contradicts the source of
> truth is worse than no file, because an agent that reads it gets a palette this product retired.
> If a real consumer appears, generate the JSON from the CSS in a build step rather than hand-keeping
> a second copy.

Never hardcode a
hex in a component.

## The forbidden list

The previous iteration of this product hit three of the most common AI-generation tells at once:
near-black ground by default, a neon accent, and a border around everything. That is not a style, it
is the statistical median of every generated interface, the safe average a model reaches for when
nobody has decided anything. TILL has decided. These are banned by name so no future author,
human or model, drifts back:

- **Neon-on-dark.** No cyan or violet glow, no glowing card borders, no accent-glow backgrounds.
- **Dark mode as the default reflex.** Dark exists and is first-class, but light is the ground.
- **A 1px gray border around every card.** A box around everything is separation by laziness.
  Separation comes from a background step (`--t-bg` to `--t-bg-elev`) and from spacing. A hairline
  (`--t-border`) appears only where a boundary genuinely helps: a table rule, an input edge.
- **Purple-to-blue gradient washes and gradient text.** No gradient exists to look modern.
- **Glassmorphism.** Backdrop blur, translucent frosted fills, frosted overlays: already banned,
  stays banned. A cash drawer is not frosted.
- **Three rounded cards in a row as a hero layout.**
- **Emoji as section markers or status.** Status is a glyph, not a face.
- **Multi-coloured headlines, and the accent on part of a title.** A heading is one ink, full stop.
  Colouring one word of a headline, or underlining part of it with the accent, is the statistical
  median of AI landing pages (owner-banned by name, 30.07.2026). The accent budget never includes
  type decoration, and a headline that needs a highlighted word is a headline that has not decided
  what it says.
- **Everything centered.** This is a data tool. Text left-aligns, money right-aligns.
- **The accent bar or rail on the side of a card or nav item.** The left-line active-nav indicator
  is explicitly retired. Active nav is a tinted pill (see Navigation).
- **No em dashes**, anywhere, ever. Colon, comma, or parentheses. CI enforces it.

Also still banned from the old law, still true: no stock illustration, no isometric people pointing
at charts, no exclamation marks in product copy, no hero copy saying "effortless", "seamless",
"supercharge", "unlock", or "revolutionize", and never more than one accent colour on a screen.

## Colour

### The Brass palette

Every colour on screen is one of these tokens, defined per theme in `tokens.css`:

| Token | Role |
|---|---|
| `--t-bg` | The page. Warm paper in light (`#f7f4ee`), walnut in dark (`#221e19`, L* 11.5, deliberately not near-black). |
| `--t-bg-soft` | Header strip inside a panel, hover fills. |
| `--t-bg-elev` | The elevated panel (`#fffdf8` light, `#29241e` dark). |
| `--t-bg-code` | Code and raw-value surfaces. |
| `--t-border` | The hairline. Used sparingly, never on every card. |
| `--t-border-strong` | Emphasis or hover boundary. |
| `--t-text` | One solid walnut ink for copy (`#1f1b16` light, `#efe8dc` dark). |
| `--t-text-dim` / `--t-text-faint` | Two dimmer support steps. Faint never carries meaning: it is for placeholders, disabled controls and decorative glyphs only (K-36), because it measures 3.15 to 3.6:1, under the 4.5:1 text floor. A label, a status word, a table head or an icon button's glyph is dim or ink. |
| `--t-accent` | Brass (`#7a5a16` light, `#e0b444` dark). The one attention signal. |
| `--t-accent-dim` | Hover, pressed, stronger. |
| `--t-accent-soft` | The tinted fill: active nav pill, selection. |
| `--t-on-accent` | Text or icon on an accent-filled surface. Dark's accent is light, so its on-accent goes dark. |
| `--t-success` / `--t-warn` / `--t-danger` | Status. Separate from the accent, never the only carrier of meaning. |
| `--t-on-danger` | Text or icon on a danger-FILLED surface (a destructive button). Its own token, never a borrow of `--t-on-accent`: the on-colour is tuned to the danger fill, so the two stay decoupled if either fill moves. |

### Token discipline

- **Only defined `--t-*` tokens reach a component.** No hardcoded hex, ever: the phantom-variable
  audit found 15 surfaces painting a retired palette through `var(--accent, #0f766e)` fallbacks,
  which is exactly the failure this rule exists to prevent. The translucent values declared in
  `tokens.css` (the scrim `--t-scrim`, the soft tints and the shadows) are the one allowlisted
  exception, and the guard test enforces the rest: a surface paints a scrim with `var(--t-scrim)`,
  never its own `rgba()`.
- **Every new token is defined in BOTH themes** in the same commit. A token that exists in one theme
  is an un-themed element waiting to ship.
- Density and spacing are tokens too (`--t-control-h`, `--t-row-h`, `--t-row-head-h`,
  `--t-row-pad-y`, `--t-cell-pad-x`, `--t-font-table`, `--t-space-*`): a component that restates
  their values in pixels has opted out of the density toggle and the grid at once.

### Accent discipline

The accent is a budget, not a paint. It marks exactly three things: **focus** (the soft ring: an
accent border plus a faint halo), **the selected item** (nav pill, selected row), and **the single
primary action** on a surface. If two
things both want the accent, one of them does not deserve it. An accent used as decoration stops
working as a signal, which is the only job it has.

**One exemption, on purpose** (K-11, D137): the selected segment of a `Segmented` control is a
neutral raise (`--t-bg-elev` and a `--t-border` hairline on a `--t-bg-soft` track), never the
accent. A period switch or a list/board toggle beside the nav pill, a selected row and the one
primary would otherwise make four accents on one screen.

### Money

Money never uses the accent. It has its own two semantics:

- **Debit / positive / incoming**: plain `--t-text`. Money coming in is normal, not celebratory.
- **Credit / negative / outgoing**: `--t-danger`, but only in the sign or a glyph, never a filled
  red row. A ledger page full of red boxes reads as an emergency; a minus sign reads as a fact.
- **Open payables are shown positive** (K-39, D137). Kreditoren shows what is owed as a positive
  amount, as the Übersicht tile and the payment run already do: a Treuhänderin reads there what she
  owes, and a minus there reads as a credit with the supplier. The minus is reserved for credit
  notes and reversals. This is display only; no engine value, sign or posting changes.

### Status

`--t-success`, `--t-warn`, `--t-danger` are status, not brand. Status is never carried by colour
alone: always icon plus text, so a colour-blind operator and a grayscale printout read the same.

**Separation from the accent is a measured gate, not an intention.** Every status colour sits at
least **25 &Delta;E** from the accent and from every other status colour, in both themes. This rule
exists because the sentence it replaces ("success is a lighter leaf green so it never reads as the
accent") was an intention, and the values behind it measured 8.5 &Delta;E in dark. An intention
cannot fail a build; a number can.

### Light default, dark parity

Light is the default ground. Dark is not a filter over light: every dark value is chosen, including
the inverted on-accent relationship. **Parity is a gate**: every surface is judged in both themes
before it ships, and an un-themed element is a defect, not a polish item.

## The brand mark

**A wordmark plus a drawer glyph** (W13, chosen 29.07.2026, D53). The glyph is the till itself: a
drawer face, its split, and the pull, drawn as three straight elements on the 8-pt grid with no
curves to lose at 16px. It is stroked in the accent, so the identity spends one thin stroke of the
budget rather than a filled block.

- **The wordmark is `TILL`, in caps.** TILL is an acronym (Trusted Independent Ledger Library), so
  caps is the name and not emphasis. This is the one deliberate exception to the sentence-case rule
  below, and it does not license Title Case anywhere else.
- Inter 700, letter-spacing `-0.04em`, set solid beside the glyph.
- **The same object at every size.** The glyph in the header is the glyph in the favicon is the
  glyph in the social avatar. A wordmark that degrades to a bare letter in a browser tab was the
  reason the wordmark-only direction lost.
- The mark never uses a second colour, a gradient, or a container tile.


## Type

**Inter, self-hosted.** One typeface. No second display face, no exceptions.

- Weights 400, 500, 600, 700. **700 is the ceiling.** Nothing heavier.
- No all-caps and no Title Case. Sentence case everywhere. All-caps hurts German compounds
  (`Vorsteuerabzug`, `Mehrwertsteuerabrechnung`) badly, and Swiss German is full of them.
- Tabular numerals (`font-variant-numeric: tabular-nums`) for **every** money figure, account
  number, and date column. Money that shifts as it updates is money you do not trust.
- **A money figure never wraps** (K-18, D137): `white-space: nowrap` and a minimum width belong to
  the money cell (`.t-money`, `td[data-money]`), so "CHF" and its amount stay on one line and a text
  column beside it gives up the width instead.
- Line length caps at ~72 characters for prose.

### The scale (UI polish round 2, K-37, D137)

Seven sizes, each with the one line height it travels with, as theme-independent tokens in
`tokens.css` (like density). Before this the law named no size, so every surface chose one: 35
values, 129 of them fractional pixels, and the most common size was not the body size.

| Step | Size / line | Tokens | For |
|---|---|---|---|
| xs | 11 / 16 | `--t-font-xs`, `--t-lh-xs` | Badge numbers only |
| sm | 12 / 16 | `--t-font-sm`, `--t-lh-sm` | Captions, table heads, section labels, kbd |
| md | 13 / 18 | `--t-font-md`, `--t-lh-md` | Secondary lines, small buttons, dense Kompakt tables |
| body | 14 / 20 | `--t-font-body`, `--t-lh-body` | Running interface text |
| lg | 16 / 24 | `--t-font-lg`, `--t-lh-lg` | Section and dialog titles |
| xl | 20 / 28 | `--t-font-xl`, `--t-lh-xl` | Surface titles |
| 2xl | 24 / 32 | `--t-font-2xl`, `--t-lh-2xl` | The one headline figure (the Übersicht total, a closing sum) |

- **A surface reaches for a step; it never types a size.** The shared core (`tokens.css`,
  `global.css`, `motion.css`) carries no literal size and the rest of the Studio ratchets down:
  `test/style/type-scale.test.mjs` holds both, and the agent that migrates a surface lowers its
  ceiling in the same commit.
- **A size travels with its line height.** The body's own line is written as the unitless ratio of
  its pair (20 / 14): a length line height inherits as a length, and a 24px figure that states only
  its size would otherwise sit in a 20px line. The one line off the scale is help prose at its
  440px measure, which keeps the 1.55 reading leading Part A gave it.
- **Secondary text is dimmer or smaller, never bold and dim** (K-23). Section labels and table
  heads are 12px/500 in `--t-text-dim`; a ghost button's label is 13px/500 in `--t-text` (its missing
  edge already makes it the quiet one); 600 belongs to titles and the leading cell of a row, in the
  ink. Bold and dim together is the inverted hierarchy the round-2 audit measured on every table
  head and ghost row action.
- **No CSS case transforms.** The catalogue writes the case the words are read in; a
  `text-transform: uppercase` over "Aktiven" is the all-caps German compound this section bans.
- `--t-text-faint` is an edge tone (a placeholder, a disabled control, a decorative glyph), never
  text a person has to read.
- Icons come in 16, 20 and 24px with one stroke width (1.75); 12 and 14 retire as surfaces migrate.
- Radii stay on the existing scale: `--t-radius-sm` 6, `--t-radius-md` 10, `--t-radius-lg` 14, and
  `--t-radius-full` for pills.

## Layout and surfaces

- **8-pt grid.** Every gap, pad, and size is a multiple of 8 (4 is allowed for optical nudges
  only). The scale is `--t-space-1` through `--t-space-8` in `tokens.css`.
- One fixed rail, one scrolling `<main>`, and at most one right dock, collapsed by default, which is
  a viewport onto work in progress and never a place where work is done. A dock that acquires its
  own tables, filters or settings has become a screen and belongs on a route. (The dock sentence is
  the A35 exception, ratified verbatim by D102 on 17.08.2026; its own limit is what keeps it from
  becoming a precedent for a fourth column.) The rail never scrolls.
- Density is a feature. This is a data tool, not a landing page. Rows are compact and scannable.
- **One global density toggle, Komfortabel or Kompakt** (D118 B3), never per-table density menus.
  It sits in the rail footer beside the theme toggle, persists per user, and works by stamping
  `data-density` on the document root, where the token stylesheet keys the compact values
  (`--t-control-h`, `--t-row-h`, `--t-row-pad-y`, `--t-cell-pad-x`, `--t-font-table`).
  Komfortabel is the ground and equals the default look; Kompakt tightens control height, row
  height, table type and money-row rhythm, and lands EXACTLY on the D116 32px dense-band floor,
  never below it. Surfaces opt in by using the shared control and money-cell primitives, so the one
  toggle costs nothing per surface.
- **Scrollbars are native, thin and tokenised** (D118 B1). `scrollbar-width: thin` and a token
  `scrollbar-color` (`--t-border-strong` thumb on the `--t-bg` track) are declared ONCE on the root
  and inherit everywhere, correct in both themes; the scrolling main reserves its gutter with
  `scrollbar-gutter: stable` so content never shoves sideways when the bar appears. No
  `::-webkit-scrollbar` pseudo-bars, no scrollbar library. Wide content (a table, a code block)
  scrolls inside its own overflow frame; the body never scrolls sideways.
- Tables right-align money, left-align text, and never centre anything.
- **A table row is a number, not its tallest cell** (UI polish round 2, K-20 and K-23, D137). A
  text row is 36px in Komfortabel and 32px in Kompakt (`--t-row-h`), the head row 32px in both
  (`--t-row-head-h`), a cell's inline padding 16px or 8px (`--t-cell-pad-x`) over the block padding
  `--t-row-pad-y`. A cell never holds a control taller than its row: row actions are small buttons or
  one overflow. The head is 12px/500 in `--t-text-dim`, sentence case, and right-aligned over a money
  column like the figures under it; 600 is kept for the leading cell of a row, in `--t-text`.
  Measured before this: nineteen first-row heights between 37.5 and 108.5px, because the row
  followed its tallest control, and Kompakt reached half the tables.
- **One panel treatment**, deliberately dull: `--t-bg-elev` on the `--t-bg` page, `--t-radius-md`
  corners. Depth comes from the background step and spacing. No shadow stacks, no blur, no
  translucency, and no default border: the hairline is earned, not issued.
- Elevation is a **two-step scale**, not a continuum: the page is `--t-bg`, a panel on it is
  `--t-bg-elev`, a header strip inside a panel is `--t-bg-soft`. If a design needs a third step,
  the layout is doing too much, not the palette too little.
- **One overlay tier** (UI polish round 2, K-28, D137). An overlay (popover, menu, listbox,
  palette, dialog, drawer) is not a third elevation step: it is `--t-bg-elev`, one hairline
  (`--t-border`), one shadow (`--t-shadow-overlay`), a radius by role (tooltip `--t-radius-sm`,
  popover and menu `--t-radius-md`, dialog and drawer `--t-radius-lg`), and behind a modal one
  scrim, `--t-scrim`. The stacking order is tokens too, and a `z-index` is one of them, `auto` or
  `0`: `--t-z-raised` 1 < `--t-z-sticky` 2 < `--t-z-popover` 30 < `--t-z-menu` 40 < `--t-z-rail`
  60 < `--t-z-overlay` 1000 < `--t-z-palette` 1100 < `--t-z-listbox` 3000. The palette and the
  feedback dialog sit above a drawer, because Cmd+K and "Diesen Fehler melden" must work from
  inside one (the palette used to open under the drawer's scrim and take keystrokes invisibly); the
  Select listbox tops the stack because it opens from inside any of them.

## Navigation and information architecture

- **Active nav is a tinted pill.** The selected item gets a soft accent-tint fill
  (`--t-accent-soft`), accent text and icon, and `aria-current`. Hover is a neutral background step
  (`--t-bg-soft`), never an underline. The left accent bar is retired; do not bring it back.
- **One rail rhythm** (owner decision, UI polish round 2 A4, 23.09.2026; pitch set by D138,
  24.09.2026). Every row in the rail, a leaf at any level, a group heading, a nested parent, the
  Favoriten header and a Favoriten row, is the same 28px band with a 2px gap, a 30px pitch, and the
  same inline inset, in both densities; the search field and the workspace switcher span the same
  column the rows' pills span. The 28px band is the rail's stated exception to the D116 32px dense
  floor and to the 8-pt grid (see Tap targets); A4 first set it at 32px (a 34px pitch), and the owner
  found that too loose (D138, option B of the rail density picker). Hierarchy is carried by type
  (leaf 14px, group label 12px/500 in `--t-text-dim` since K-23), never by a second row height. A
  control inside a row (the 24px pin star, a count badge) never grows the row: the band is the row's
  natural height (a 20px line, 3px padding, a transparent 1px border) held by its `min-height`, and
  the star takes a negative block margin to stay out of the height calculation while keeping its
  24px hit area. The "tighter lane" of round 1 survives as spacing, not as a second rhythm: no
  divider, no margin, and the Favoriten header to its first row and the lane to the tree are each
  ONE row step (the 2px gap), no extra whitespace. Hover stays the soft fill, never an underline.
  Measured before A4: leaves 40px, group rows 32, parents 34, the Favoriten header a 37px paragraph
  with 14px UA margins, four rhythms in one column.
- **The rail chrome has a budget** (UI polish round 2, K-01, D137). The head is one row, the
  wordmark and the workspace switcher side by side, with the search field under it; the tagline
  lives on the website, not in the rail. The footer is one row: the environment as a single pill
  (its egress state a word inside it, never a bare dot) followed by the icon buttons, with
  "Umgebungen verwalten" as the first row of the environment menu. The budget is measured, not
  asserted: at 1440x900 with one group open, the tree does not scroll, and since D138 (the 30px
  pitch) neither does it at 1280x800 with no favourites pinned. Measured before it, head and
  footer took 320 of 900px and an open group made the tree scroll on every laptop; a two-row footer
  still scrolled by about 33px. An element that would break the budget moves into a menu.
- **The rail is a real tree, and the tree is why the rail never scrolls** (D118 A1). Headed groups
  AND nested parents collapse; everything collapsible DEFAULTS TO COLLAPSED, so a fresh workspace
  shows roughly fifteen rows that fit without a scrollbar. A group header or parent carries no route
  of its OWN, so it adds no anchor to the rail and the count of anchors stays equal to the count of
  destinations. Its chevron toggles expand/collapse, and (D135, owner request) clicking the header
  itself navigates to the node's first child leaf, its natural landing, and expands it: a header is a
  shortcut into its group, not a dead label, and no separate "section landing" surface is added.
  Opening one top-level group collapses its sibling groups (an accordion); nested parents keep their
  own independent expand state.
- **The tree is a WAI-ARIA treeview, not a styled list.** `role="tree"`, `role="treeitem"` with
  `aria-expanded` on collapsibles and `aria-current="page"` on the active leaf, `role="group"` child
  lists linked by `aria-owns`, ROVING TABINDEX (one Tab stop), and the full APG keyboard model:
  Up/Down over visible rows, Right expands or steps in, Left collapses or steps out, Home/End,
  Enter/Space activates or toggles. Verified with jest-axe in both themes.
- **Deep links auto-expand; deliberate toggles persist** (D118 A1). A collapsed group never hides
  the active route: the ancestors of the active leaf auto-expand. What is stored per user (and per
  workspace) is the user's explicit toggle OVERRIDES, not the whole expanded set, so visiting a
  group does not pin it open and the default-collapsed rhythm survives. Storage failure is silent:
  a rail that cannot remember its open groups still navigates.
- **The taxonomy is authored once, in one shared vocabulary** (D118 A2): Lager, Anlagen and
  Einstellungen are nested parents, Berichte is a group of report doors, and the daily queues
  (Übersicht, Aufgaben, Inbox, ...) stay top-level and always visible. Documentation, support and
  the agent all speak this one taxonomy; no user can reorder it.
- **The Favoriten lane sits ABOVE the canonical tree and is the only personal surface of the rail**
  (D118 A3). It renders only when non-empty. Pins are per user per workspace; a pin is a pointer to
  a catalog surface, and the canonical tree below stays fixed. Reorder is pointer drag AND
  keyboard move-up/move-down buttons, and the buttons are MANDATORY (WCAG 2.5.7 requires a
  single-pointer, non-dragging alternative to every drag); the drag grip is pointer-only and hidden
  from assistive tech so there is exactly one keyboard reorder path. A per-user alias exists on
  favourites ONLY, and the canonical name always survives as the row's tooltip and as the tree's
  label: one shared vocabulary below, one personal lane on top.
- **The rail is resizable by a hand-rolled splitter, never a resize library** (D118 A4, bound by
  the dependency law below). It is the WAI-ARIA window splitter: a focusable `role="separator"`
  reporting the width via `aria-value*` and `aria-controls`, resizable by pointer and by keyboard
  (arrow steps, Home/End to the bounds, Enter to collapse/restore). The range is 200-400px,
  double-click resets to 240px, and dragging well below the minimum snaps to a 56px icon rail.
  Collapsing keeps the stored width so expanding restores it; width and collapsed state persist per
  user per workspace. A keyboard arrow can never collapse the rail by accident: collapse is the
  deliberate Enter action.
- **The icon rail's flyouts are disclosures, never dialogs.** A flyout is a positioned `div` with
  `role="group"` and an accessible name, opened by hover or focus, closed by Escape with focus
  returned to its trigger; the active surface carries `aria-current`, never colour alone.
- **Navigate without closing.** Moving between peer surfaces never requires a modal round-trip.
  If reaching a sibling means dismissing something first, the structure is wrong.

## Agent-native surfaces

TILL's thesis is that humans and agents drive the identical verbs. The chrome states that thesis
rather than contradicting it (D118 C1-C4):

- **One omnibox** (D118 C1). The Cmd/Ctrl+K palette is the single overlay for going somewhere,
  finding something and doing something, and it carries a "Frag den Agenten" tail row that routes
  free text to `agent_ask` and opens the answer in the dock. The ask row appears only with a query,
  is scored zero so it is never the auto-selected default over a real command, and a failed ask
  stays IN the palette so the operator sees why nothing happened. One input, two lanes; never a
  second agent input beside the palette.
- **Palette actions are a drift-tested projection of the verb registry, never a hand list**
  (D118 C2). The palette runs the same `ActionDef[]` the MCP `tools/list` and the REST route table
  resolve, generated into JSON and held equal to the live registry by a drift test: structural
  human/agent parity, not parity by review. Ranking is the hand-rolled cmdk-tier scorer (exact >
  prefix > word-boundary prefix > substring > subsequence), diacritics folded so "ubersicht" finds
  "Übersicht"; the library itself is not taken (see the dependency law).
- **Provenance is a quiet line on detail views, and nowhere else** (D118 C3). Who acted (a member
  seat, or the agent named IN WORDS, never signalled by colour alone), by what act, when, and a
  link into the A35 trace rendered only when a trace exists. Neutral ink, a calm glyph, never a
  coloured badge; list rows stay unmarked, because a glyph column on every row is a wall of noise
  no one reads.
- **Approval is tiered, and the sentence is shared** (D118 C4). The risk ladder is
  read < draft < post < statutory filing. A read never confirms; a draft waits asynchronously in
  the Vorschläge queue; the top two tiers ALWAYS take a synchronous human confirmation before the
  write leaves the surface. That rule is a floor, never a ceiling, and blanket confirmation on
  everything is banned because it trains blind clicking. Every governed confirm renders the ONE
  consequence sentence resolved from the engine's dial map, the identical string the Vorschlag
  card shows, so a human confirming a write and an approver clearing an agent's draft of the same
  write read the same sentence. A verb with no engine sentence gets none invented in the Studio.

## Interaction

- **No dead ends.** Every state offers a next action: an error offers retry, an empty filter
  result offers clear-filter, an empty list offers create, a result row opens. An error with no
  way out, or a figure you cannot open, is a defect.
- **Real tooltips.** `aria-describedby`, reachable by focus and by hover, dismissible, and never
  the `title` attribute. Icon-only controls carry an `aria-label`.
- **Progressive disclosure and help.** Every key field has an in-place explainer. A contextual
  help article (help drawer or panel) is reachable from each surface. When a humanized label
  replaces a machine key, the raw key survives as the tooltip.
- **Humanize machine labels.** No raw snake_case or enum value ever reaches the screen. And plain
  language only: no coined internal jargon. A label a user needs the team to explain has failed.
- **Primary action where the eye expects.** One obvious primary action per surface, in the
  surface header's action slot at its natural width, never a bar across the page; secondary and
  overflow actions sit to its left.
- **One button ladder** (UI polish round 2, K-08, D137). Primary (`.btn--primary`, solid, at most
  one per surface), secondary (`.btn--secondary`, an edge, the default), ghost (`.btn--ghost`,
  text), and danger (`.btn--danger`) only inside an overflow or a confirm. The tinted `.btn--accent`
  has exactly one role: the commit of a money write (Buchen, Zahlen, Ausstellen), always followed by
  the C4 confirmation; never a header action and never an export.
- **"One of N" has three primitives, and only three** (K-11, D137). Sixteen class families with
  thirteen heights did the same job before this. `Tabs` switches the views of one record or one
  surface (`role="tablist"`, the accent-soft pill with accent ink on the selected tab).
  `Segmented` switches between two to five sibling values (a period, month or year, list or
  board: `role="radiogroup"`, 32px, equal segments, arrow keys), and its selected segment is the
  neutral raise named under Accent discipline, never the accent; six options or more is a Select.
  `FilterChips` toggles several facets at once (`aria-pressed`, `--t-radius-full`; a selected chip is
  the accent-soft pill with accent ink, because a chosen facet is a selected item). A list of reports
  down the side is vertical `Tabs` or a list row, not a fourth family.
- **A drawer closes the way a macOS sheet does** (K-32, D137). In a drawer, "Abbrechen" and the one
  primary action sit labelled at the bottom right in a fixed footer that stays in view while the
  body scrolls, and the close X sits top right. Glyph-only save and cancel at the top right belong
  to inline editors that have no footer. (The law used to say glyph-only top right for every
  drawer; every drawer in the Studio already did the footer, and a Treuhänder reads "Speichern"
  faster than a check mark.)
- **Minimalism is the default.** Relabel, remove, merge, and reorder before adding anything. A new
  screen carries a high bar.
- **Forgiveness.** Destructive actions take a deliberate act: a confirm or an undo. Delete sits
  behind an overflow, never as a top-level button beside save.
- **Danger fills use `--t-on-danger` for their text and icon**, never a borrowed `--t-on-accent`.
  The two are equal by coincidence in one theme and declared separately on purpose.

## Motion

Motion is a courtesy, not a personality (D118 D3):

- **CSS transitions and the native View Transitions API only. No motion library.** Framer
  Motion/Motion is not taken; a spring physics engine for a chevron is the definition of a
  dependency that costs more than it moves.
- **The budget is 120-200ms.** A reveal, a chevron rotation, a rail width snap all live inside it.
  Anything longer is a wait, not a courtesy.
- **`prefers-reduced-motion` is a kill switch, not a suggestion.** The global rule zeroes
  durations AND delays (an animation behind a 3s delay is still a 3s wait for the end state).
  A pointer-tracking drag is not motion in this sense and is never suppressed: it follows the
  finger.
- **A transition never fights the pointer.** The rail's width transition is suppressed during the
  splitter drag; any animated dimension a pointer drives directly does the same.

### The vocabulary: three moments, one ease pair (D122 D-I, 05.09.2026)

Motion is spent on exactly three moments, plus one hover beat (K-41), and each one is a set of
tokens in `tokens.css`, never a number typed into a surface. A surface says `var(--t-motion-reveal)`; it never says `200ms`. The
`test/style/motion-tokens.test.mjs` guard holds the set, the values and the kill switch, and
ratchets the raw duration literals left in the Studio down to zero.

| Moment | What moves | Tokens |
|---|---|---|
| **Navigate** (a change of surface) | The new surface enters in 200 ms from 8 px on the travel side (`--t-ease-out`): a fade over the whole 200 ms, the travel settling in the first 80 ms (`--t-motion-nav-out`, the beat the old surface's exit would have taken). The rail pill changes in 120 ms regardless. Same-surface moves (a list to its detail, a route closing a drawer) do not navigate. **The old surface does not leave**: D-I asked for an 80 ms exit, it was built on the View Transitions API and measured (05.09.2026), and a raw click 150 ms after landing was lost four of four while the transition ran, with `pointer-events: none` on `::view-transition` as documented; the act after a navigation cost 325 ms against 172 with the transition nulled. That is the pointer being fought, so the exit was withdrawn. | `--t-motion-nav-out` 80 ms, `--t-motion-nav-in` 200 ms, `--t-motion-pill` 120 ms, `--t-travel` 8 px |
| **Commit** (post, pay, issue, lock, apply) | The pressed control scales to 0.98 in 80 ms. The new or updated row lands in 180 ms from 8 px above, a check draws in 180 ms beside the words, and an `--t-accent-soft` tint on the row decays over 720 ms. Never a toast that says "Success", never colour alone: the `ActionFeedback` primitive carries the words. | `--t-motion-press` 80 ms, `--t-press-scale` 0.98, `--t-motion-commit` 180 ms, `--t-motion-tint` 720 ms |
| **Reveal** (a dock, a drawer, a disclosure) | The panel slides from the edge it lives on in 200 ms; its items follow with a 30 ms per-item stagger over at most three items. A disclosure's body fades under its chevron in 200 ms. | `--t-motion-reveal` 200 ms, `--t-motion-stagger` 30 ms |
| **Hover** (a pointer over a control; UI polish round 2, K-41) | The one beat under the pointer: a shared primitive's background, ink and edge colour ease in 120 ms (`.btn`, `.field`, `.select-trigger`, `.help-trigger`, the rail tree rows, table row hover). Nothing else moves on hover. | `--t-motion-hover` 120 ms |

- **The hover beat is colour only.** It animates `background-color`, `color` and `border-color`,
  never `transition: all`; the only properties that move anywhere are `transform`, `opacity` and
  colours. Keyboard repeats (arrows in the tree and the palette, Escape) never animate, which is
  why the rail tree rows transition fill and ink but not the border their focus cue lives on.
  Before it the button glided and the select beside it snapped: two feels on one screen.
- **One ease pair, and everything else inherits.** Entrances ease out (`--t-ease-out`,
  `cubic-bezier(0.2, 0, 0, 1)`); exits ease in (`--t-ease-in`, `cubic-bezier(0.4, 0, 1, 1)`). There
  is no third curve, no spring, and no per-surface easing.
- A stagger of at most 30 ms per item over at most three items is a delay inside the budget, not a
  fourth duration.
- The two exits (80 ms) sit deliberately under the 120 to 200 ms budget: a departure is felt, never
  watched. The 720 ms tint is not a duration anyone waits on: the row is live from its first frame,
  and the decay only tells the eye which row just changed.
- Reduced motion zeroes every one of these, including the stagger delay; `motion.ts` stamps
  nothing under the setting (no direction, no entrance, no tint).
- The primitives live in `app/src/lib/motion.ts` (`navigate`, `commitAck`, `useCommitAck`) and
  `app/src/styles/motion.css` (the `motion-reveal--*` classes, the `[data-just-committed]` hook,
  the `motion-nav-enter` entrance). The Navigate moment is wired once, at the router. The View
  Transitions API stays permitted (D3) and stays unused: on the harness Chromium it holds the
  pointer for its whole life (about 250 ms with a single 80 ms exit declared, because the user
  agent's group animations run regardless) and drops a click issued meanwhile. Re-measure before
  reaching for it again; do not re-add it on the strength of the documentation.

## Dependencies

The Studio is zero-UI-dependency by default, and every exception is named here (D118 D1/D2). A
dependency is adopted ON ITS TRIGGER, never in advance, and "we might need it" is not a trigger:

| Dependency | Trigger |
|---|---|
| Base UI (per component) | Only when hand-rolling that one primitive would cost 500+ lines (an anchored combobox is the likely first case). Radix, Ark and Headless UI are off the table. |
| dnd-kit | The Favoriten reorder, and ALWAYS paired with keyboard move buttons (WCAG 2.5.7). Drag without the buttons is a defect, not a phase one. |
| TanStack Virtual | Only when a list measurably janks (~2'000 rendered rows). Measured, not feared. |
| react-resizable-panels | The first genuine multi-panel surface, if one ever ships. Explicitly NOT the rail splitter, which stays hand-rolled. |
| TanStack Table | Deferred. Revisit only if user-configurable columns/grouping become a product requirement. |

The rail splitter stays hand-rolled: it shipped as ~160 lines against the WAI-ARIA window splitter
pattern, which is the proof the zero-dep default holds for interactions of that size. No motion
library (see Motion), no scrollbar library (see Layout), no command-palette library (the cmdk
ranking IDEA is vendored as ~30 lines, the dependency is not).

## The five states

Every surface handles all five, and "we'll add it later" is not one of them:

| State | Rule |
|---|---|
| **loading** | Skeleton matching the real layout. Never a spinner in a panel that knows its shape. Nothing appears before 200ms (a local read usually lands first), and once shown an indicator stays at least 300ms, so it never flickers (K-34, D137). The skeleton has the measure of what it stands for: a table draws its head strip and its rows at the row height they will take, a tile grid draws its tiles, and nothing grows when the data lands. A "wird geladen" sentence is for screen readers only. The rail, tabs, headers, buttons, inputs, menus and dialogs never skeleton. |
| **empty** | Says what this is and invites the first action. Never just "No data". The formula (K-33, D137): the title names what is missing, short, with a full stop ("Noch keine Zahlungen."); one sentence under 14 words says when something will appear; the one action mirrors the title ("Zahlung erfassen", never "Loslegen"), with at most one secondary beside it; the glyph is 32px at most; the block is left-aligned and replaces the table rather than sitting inside it. A FILTERED empty state says what the filter hides and offers "Filter zurücksetzen", never a create. |
| **error** | Says what happened and what to do, and offers a way out (retry, at minimum). Never a stack trace, never "Something went wrong". |
| **success** | The data. No confetti, no toast that says "Success!". Every figure and row offers a next action: open, drill in, act. |
| **permission-denied** | A padlock panel that says the right is missing, not a blank screen and not a lie. The action that would fail is hidden or disabled, never shown and then rejected. |

## Accessibility

**WCAG 2.2 AA is a gate, not an aspiration.**

- Contrast: 4.5:1 for body text, 3:1 for large text and UI boundaries. The Ink text-on-paper pairs
  are chosen to clear this in both themes.
- Colour is never the only carrier of meaning. A red number also has a sign or a glyph; a status
  colour always travels with icon and text.
- **Links.** Standalone (action) links, a lone call to action or a list of destinations, are NOT
  underlined at rest: they are distinguished by their accent colour and their position, and the
  underline appears on hover as the affordance cue (the owner's "Ohne Unterstrich, Hover-Cue"
  pick). WCAG 1.4.1 (use of colour) governs a link sitting INSIDE a block of running text, where
  colour alone cannot mark it apart from the surrounding prose; such an inline-prose link keeps an
  at-rest underline, scoped to a real prose container (there is none in the Studio today).
  - **The global anchor rules are zero-specificity and colour only** (UI polish round 2, A1/A2,
    23.09.2026). `:where(a)` and `:where(a:hover)` set the accent and its hover step and nothing
    else, so every component class on an `<a>` wins by construction. They used to be a bare `a` and
    `a:hover` with an underline, and the `a:hover` at (0,1,1) outranked `.btn--primary { color }` on
    every router `<Link>` styled as a button: the primary door read brass on brass, measured 1.00:1
    in both themes.
  - **Underline on hover is an explicit opt-in for text links, never something an element
    inherits.** A text link (a sentence link, a link inside running text, a document number in a
    table cell, a list of destinations) carries `link-inline`, or sits in one of the four prose
    scopes (`.help-body`, `.state-body`, `.consequence-line-text`, `.diag-prose`), written entirely
    inside `:where()`. A surface link class may spell the same opt-in locally (`.help-link`,
    `.pay-link`, `.documents-back`).
  - **Chrome never underlines, in any state.** Nav rows, buttons, tabs, list and card rows, chips,
    tiles, palette items and tree toggles: their hover affordance is the soft `--t-bg-soft` fill (the
    macOS sidebar), and every `.btn` variant states its own colour and `text-decoration: none` at
    rest, on hover, active and focus-visible. `test/style/anchor-state-specificity.test.mjs` holds
    all three facts.
- Every interactive element is keyboard-reachable with a **visible, never-removed focus indicator**:
  the owner's "Sehr subtil" treatment, where the control's border shifts to the accent
  (`--t-focus-border`) and a faint 2px accent-soft halo sits just outside it (`--t-focus-ring`), per
  `tokens.css`. No detached outline. The border going from grey to brass is the primary cue, so the
  indicator stays clearly visible in both themes (WCAG 2.4.7). A control that carries its own resting
  shadow (a raised button, an interactive tile) layers the halo outside that shadow rather than
  replacing it.
  - **Every focusable control has a border, transparent where it shows none, so the border cue
    exists** (UI polish round 2, K-10, D137). The token focus selector is
    `:is(a, button, input, select, textarea, [tabindex]):focus-visible`, specificity (0,2,0), so a
    control's resting single-class border never outranks it. (Its `:where()` predecessor was (0,1,0),
    not 0: the grey border of every select, search field and tab stayed put under focus, and on the
    22 borderless controls, the rail rows among them, only the halo arrived at 1.15:1.) The 1px comes
    out of the padding, so no box moves; a tile that drops its hairline sets `border-color:
    transparent`, never `border: none`.
  - **The measured cue, and what it does and does not claim.** On a bordered control the swap from
    the grey boundary to brass measures 1.74:1 in light and 2.51:1 in dark; on a borderless one the
    brass edge measures 5.79:1 against the page in light and 8.50:1 in dark. That meets AA through
    1.4.11; it does not meet AAA 2.4.13 (3:1 between the focused and unfocused states), and AAA is not
    claimed. This is the accepted pick: a solid 2px ring would reverse "Sehr subtil".
    `test/style/focus-border-cue.test.mjs` holds the selector and the borders.
- `prefers-reduced-motion` is honoured everywhere. Motion is a courtesy, not a personality.
- **Every drag has a single-pointer, non-dragging alternative** (WCAG 2.5.7): visible buttons, not
  a second keyboard grabber. The drag handle itself stays pointer-only and hidden from assistive
  tech, so there is exactly one keyboard path and it is the buttons.
- Light/dark parity is part of this gate: an element unreadable in one theme fails.
- **Tap targets follow the two-tier rule** (D116, 2026-08-21; supersedes the earlier flat 44px). The
  WCAG 2.2 AA floor (2.5.8 Target Size Minimum) is 24px and is never crossed. Above it:
  - **Standalone and primary controls, and every control on a mobile-width layout, are at least
    44px** (WCAG 2.5.5). This was being missed by default: a bare `<input type="checkbox">` measures
    16px and a radio 13px, so **every native checkbox and radio in the Studio failed it** until the
    G08 gate measured them (2026-07-25, D46). Style the control or wrap it; do not replace it with a
    div, because the real control is what carries the label, the focus ring and the keyboard
    behaviour.
  - **Controls embedded in a dense data row or a toolbar may sit in a denser band, minimum ~32px**,
    comfortably above the 24px AA floor. A desktop-first ledger packs many rows; forcing 44px into a
    dense table costs real density for no compliance gain. The `/ux-architect` gate judges a control
    against its tier (a layout-context call a CSS lint cannot make reliably); it is not a piecemeal
    per-surface exception.
  - **The shared small controls sit on the floor, never under it** (K-14, D137). A small button
    (`.btn--sm`) is 32px in BOTH densities; Kompakt does not shrink it, because Kompakt's control
    height already is the floor. A table checkbox sits in a 32x32 `.check-cell` label with the
    native 16px box centred (the control itself stays native). The help trigger is a 32px circle
    with its 16px glyph, and in the surface header an invisible 44px hit area around it.
  - **The rail is the one stated exception to the dense band** (D138, 24.09.2026). Its rows sit on a
    28px band with a 2px gap (a 30px pitch), under the ~32px dense band and still above the 24px AA
    floor; a control inside a rail row (the pin star, a Favoriten row control) keeps a 24px hit
    target. The exception is the rail's alone: it is a column of navigation rows read at a glance,
    and at 32px the tree with one group open scrolled at 1280x800. It is not a precedent for a table
    row, a toolbar or any other control.
  - **The rail's 28px band never reaches a touch layout.** Below 767px the rail is the overlay
    drawer and every row in it (leaves, group and parent rows, the Favoriten header and rows) grows to
    44px; the 2px gap and the type are unchanged, so the drawer is the same column at a touch pitch.
- **An error a person can see must be one they can report.** `ErrorBanner` carries the "Report this
  error" affordance (G08); a second error component that renders a failure without it is a dead end
  by construction. Either it offers the affordance or it gives way to `ErrorBanner`. Found the same
  way: `SaveStatus` on the Setup surface renders the most-used write's failures and offered nothing.
- `jest-axe` runs on changed components. A violation fails the build.

## i18n

de-CH and en are both first-class from day one. fr-CH and it-CH follow.

- **No hardcoded strings.** A tripwire test fails the build on any literal in a component.
- **Locale completeness** is a test: a key present in one locale and missing in another fails.
- de-CH uses **real umlauts** (ä, ö, ü) and **never `ß`**. Swiss German does not have the
  character at all. It is always `ss`.
- German runs ~30% longer than English. Design the layout for German and English will fit. The
  other way round produces a broken German UI, every time.
- **One address register across the whole product, and it is `du`** (D54, 29.07.2026, reversing
  D49 the same day). Two registers on one screen reads as two products, and it happened: the G08
  strings arrived in `Sie` while the shell said `du`, inches apart (D46). The argument for `du` is
  what TILL is rather than who reads it: an **open-source ERP** wants the same register it would use
  in an issue thread or a release note, and `Sie` buys formality at the price of distance.
- **`Sie` as the polite address never appears in de-CH. `sie` as the third-person pronoun is
  untouched.** German capitalises the pronoun at the start of a sentence, so `Das ist eine QR-IBAN.
  Sie kann nur Zahlungen empfangen.` is correct and must survive. A find-and-replace on the word
  `Sie` corrupts it. Only address constructions convert.
- **A locale test pins the register**, banning the unambiguous address forms (`Bitte ... Sie`,
  `haben/können/sind Sie`, the polite possessive `Ihr`) rather than the bare word. D48 and D49 both
  asked for this test and neither shipped it, which is exactly why the register could flip twice
  with nothing going red. It lives at `test/style/address-register.test.mjs`.
- **The domain is German, the technology is English** (D56). Established IT terms stay in English
  because translating a term of art makes it read as a translation: `local first`, not
  `lokal zuerst`; `open source`, `MCP-Server`, `Repository`, `Commit`. This does **not** license
  anglicising the accounting vocabulary, which is the opposite case. A Treuhänder judges you on
  `Rechnung`, `MWST`, `Beleg`, `Buchung` and `Kontenrahmen KMU`, and an English word in that slot
  reads as someone who has not done Swiss books.
- Money is formatted `CHF 1'234.55`. The Swiss thousands separator is an apostrophe.
- Dates are `TT.MM.JJJJ` in de-CH.

## Copy voice

- **Sentence case.** Never Title Case, never ALL-CAPS.
- Plain, humanized, active voice. The software is calm and does not perform enthusiasm.
- Errors say what happened and what to do. Empty states invite a first action.
- No coined jargon: the words on screen are the words a Treuhänder or a shop owner already uses.
- All outward and in-app copy runs through the humanizer for its language (`/humanizer-en`,
  `/humanizer-de`), and de-CH copy keeps its real umlauts.
