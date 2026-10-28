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

Nine sizes (seven from D137, two added by D154), each with the one line height it travels with, as
theme-independent tokens in `tokens.css` (like density). Before this the law named no size, so
every surface chose one: 35 values, 129 of them fractional pixels, and the most common size was not
the body size.

| Step | Size / line | Tokens | For |
|---|---|---|---|
| xs | 11 / 16 | `--t-font-xs`, `--t-lh-xs` | Badge numbers only |
| sm | 12 / 16 | `--t-font-sm`, `--t-lh-sm` | Captions, table heads, section labels, kbd |
| md | 13 / 18 | `--t-font-md`, `--t-lh-md` | Secondary lines, small buttons, dense Kompakt tables |
| body | 14 / 20 | `--t-font-body`, `--t-lh-body` | Running interface text |
| lg | 16 / 24 | `--t-font-lg`, `--t-lh-lg` | Section and dialog titles |
| xl | 20 / 28 | `--t-font-xl`, `--t-lh-xl` | Surface titles |
| 2xl | 24 / 32 | `--t-font-2xl`, `--t-lh-2xl` | The one headline figure (the Übersicht total, a closing sum) |
| 3xl | 28 / 34 | `--t-font-3xl`, `--t-lh-3xl` | A surface title at its largest (Ruhig 3, D154) |
| display | 32 / 40 | `--t-font-display`, `--t-lh-display` | A surface's one key figure, weight 600 (Ruhig 3, D154) |

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
- Icons come in 16, 20 and 24px with one stroke width (1.75), all from `app/src/components/icons`;
  12 and 14 retire as surfaces migrate (see "Icon vocabulary").
- Radii stay on the existing scale: `--t-radius-sm` 6, `--t-radius-md` 10, `--t-radius-lg` 14, and
  `--t-radius-full` for pills.

## Layout and surfaces

- **8-pt grid.** Every gap, pad, and size is a multiple of 8 (4 is allowed for optical nudges
  only). The scale is `--t-space-1` through `--t-space-8` in `tokens.css`.
- One fixed rail and one scrolling `<main>`. No right dock: D167 (14.10.2026) retired the A35 agent
  dock that D102 had allowed, because it hid the page on a laptop and doubled decisions the page
  already showed. Agent Vorschläge are decided in Pendenzen, live sessions have their page under
  Agent. A panel that wants a column of its own belongs on a route. The rail never scrolls.
- **The /bank detail area docks right or bottom, inside its own route (D178).** Its position is a
  per-person setting: automatic (the default: decided when the page opens, bottom at 8 or fewer open
  lines, right above that, never re-decided while you work), right, or bottom. Drag the area by its
  header to the other edge to dock it there, drag the divider to resize it; both are remembered per
  person, and the dock buttons in its header plus arrow keys on the divider are the keyboard path.
  X and Escape close it. On /bank the page itself never scrolls: the list and the detail area each own
  their scroll, and the toolbar and the table head stay put. A split inside one route is not a dock
  beside every page, so D167 holds.
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
  (leaf 14px; the group label is a per-person setting since D178, default 14px/600 in `--t-text`
  starting at the icon column, alternatives 14px/500 with a group icon or the K-23 12px/500 label in
  `--t-text-dim`), never by a second row height. A
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
  the agent all speak this one taxonomy. It is the default and the reset target: since D178 each
  person may reorder groups and items, move items between groups and hide them in their own view
  ("Menü anpassen", pointer drag AND keyboard move buttons), and "Zurücksetzen" restores it.
  Documentation and the agent keep naming pages by the canonical path.
- **The Favoriten lane sits ABOVE the canonical tree** (D118 A3; since D178 the personal menu order
  is the rail's second personal surface). It renders only when non-empty, and it and the menu each
  fold under their own header. A favourite row sits flush with the tree's leaves: no column is
  reserved for the drag grip, which takes the icon's place on hover. By default (D178, each a
  per-person setting) a favourite shows its page's icon and a filled star at its right edge, and when
  a pinned page is open only the favourite row lights; the alternatives are a star in place of the
  icon or the icon alone, and lighting the menu row only, or both with the menu row in accent ink and
  no fill. Pins are per user per workspace; a pin is a pointer to
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
  free text to `agent_ask` and opens the answer on the Agent page (`/agent?session=`, D167). The ask row appears only with a query,
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
  consequence sentence from the engine's catalogue (`src/core/agent/consequences.ts`, D156): the
  verb's own entry, else its family's, in EN and de-CH. The Studio reads the generated projection,
  MCP reads the same entry (English in the tool description, both languages in `_meta`), and
  `test/agent/consequence-parity.test.mjs` holds them byte-identical, so a human confirming a write,
  an approver clearing an agent's draft of it, and the agent itself read the same sentence. A verb
  with no engine sentence gets none invented in the Studio.
  **Where the sentence sits (D152, owner, 01.10.2026):** beside a money commit on a working surface
  (Buchen in the composer, Buchen on a bank line), the sentence is the tooltip of an (i) button next
  to the commit, and the commit carries `aria-describedby` to it, so a screen reader hears it on the
  button and a pointer finds it on hover or focus. It is the same string, never shortened or
  reworded; only its resting visibility changed. A confirm dialog still renders it in full.

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
  surface (`role="tablist"`, the accent-soft pill with accent ink on the selected tab; D154 makes the
  selected tab the neutral raise, see "Surface hierarchy", and the surfaces take it in the E-step).
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
  faster than a check mark.) **Amended by D154:** the labelled "Abbrechen" leaves the footer. The X
  and Escape close the drawer, and the footer carries only the one primary action and its (i); see
  "Surface hierarchy". Drawers take this as their cluster migrates in the E-step.
- **Minimalism is the default.** Relabel, remove, merge, and reorder before adding anything. A new
  screen carries a high bar.
- **Forgiveness.** Destructive actions take a deliberate act: a confirm or an undo. Delete sits
  behind an overflow, never as a top-level button beside save.
- **Danger fills use `--t-on-danger` for their text and icon**, never a borrowed `--t-on-accent`.
  The two are equal by coincidence in one theme and declared separately on purpose.

## Cognitive load (D152, 01.10.2026)

The owner's words for the bank band (D143) became the rule for every working surface: "reduce to
max", "the number is enough". These six rules are what that means in practice. They were measured on
the Neue Buchung composer and the Bankzeilen queue before they were written down, and a surface that
breaks one needs a reason a reviewer would accept, not a preference.

1. **Infer before asking.** What TILL already knows, TILL fills in, as a visible and editable value:
   the account's default MWST code, the balancing amount on the last line, the VAT leg of a taxed
   line. An empty control that the system could have filled is load handed to the user.
2. **A control appears only where it can apply.** Kostenstelle only on an account that allows one
   (`costCenterAllowed`), MWST only where a tax code is possible (an Erfolgskonto or an asset account
   12xx or 14xx to 17xx (Vorräte and Anlagevermögen), never a VAT or bank account), a filter only when
   it would change the list (a facet whose count is 0 or equals the total is hidden). Nothing hidden
   ever carries a value.
3. **One action, one place.** No action appears twice on a surface (a bank line's Buchen steps out of
   its row while the Details panel beside the table shows that line's Buchen). **Amended by D177:** a
   commit that cannot act yet stays in its place, DISABLED and saying why: Buchen on every open bank
   line, `aria-disabled` so it stays focusable, its reason in a few words on its tooltip ("Konto
   wählen", "Rest wäre 0.00", "Konto fehlt"). A disabled Buchen reads plainly as not available: the
   faint ink, no fill, a dashed hairline and the not-allowed cursor, never the look of an enabled
   secondary. A row whose button comes and goes made the column jump and hid what was missing.
4. **Words on demand.** Explanations, equations and "next step" sentences live behind an (i) as a
   hover and focus card. The working surface carries values and a one-line state. A derived figure
   is said in one line ("davon MWST 8.07 auf 1170 · netto 99.63"), not repeated as a table of what
   the fields above already show.
5. **A list never opens itself.** Selecting is the user's act; nothing is pre-selected on load
   (a deep link is the user's act too, carried as `?focus=<id>` and dropped from the URL once the
   user selects something else). A resting selection adds at most one line of context under
   its row. An editor the user opens on purpose may be as tall as it needs. Nothing is pre-ticked
   either: a box that commits money (a payment run, a bulk approval) is ticked by the user, and a
   suggestion is said as a line ("Vorschlag: 1 Zahlung fällig · auswählen"), never as a ticked box.
6. **Chrome never cuts content.** The sticky surface header is flush with the scroll edge, so
   nothing scrolls visibly above it, and its bottom hairline appears only once content passes under
   it.

**Three rules learnt from the critics (D153, 04.10.2026).** The D152 follow-up pass took the rules to
thirteen more surfaces; independent critics found the same three defects on several branches, so they
are rules now, not review comments:

- **One glyph per line.** A one-line state carries exactly one status glyph (check, warn or error)
  with its words; a second fact on the same line is said in words, never with a second glyph
  ("✓ Keine Differenz ⚠" reads as a contradiction). The glyph's accessible name is its own fact.
- **A workspace switch resets the surface.** A surface does not remount on a switch, so anything it
  holds (a selection, a draft, a dialog, a refusal, a "done in this session" flag) is reset when the
  workspace changes, and an answer that started under the old workspace or was overtaken by a newer
  read is dropped. A session flag is keyed by workspace and object, never by object alone.
- **One idempotency key per act.** A key minted per object (`approve:<ws>:<entry>`) replays the stored
  answer after the state has moved back (approve, flag, approve again), so the user is told "done"
  while nothing happened. The Studio mints a key when the user acts and reuses it only to retry that
  same act.

**The measured budgets** (1280x800, Komfortabel; re-measure when a surface changes):

| Surface | Before D152 | Budget |
|---|---|---|
| Neue Buchung, a simple expense with MWST | 18 inputs, 3 lines, Vorsteuer typed by hand | 7 inputs or fewer, 1 Buchungssatz, VAT leg derived |
| Bankzeilen, open lines fully visible | 1 | 10 or more |
| Bankzeilen, words above the first line | 81 | 20 or fewer |
| Bankzeilen, height of the selected line | 358px | 80px or less at rest |
| Any surface, content visible above the sticky header | a 24px strip (64px on mobile) | none |

## Ruhig 3 (D154, 07.10.2026)

The owner asked for the whole Studio to be "minimalistic, Apple-style, intuitive and clear, with as
little text as possible, icons with a hover label where necessary, low cognitive load". The Ruhig 3
artifact tried three directions on Bank, Journal, Kreditoren and MWST, and the owner chose C (a
closed icon vocabulary plus one surface layer) with an opaque header. On those four surfaces C cut
the visible words from 435 to 181 and the boxed elements from 31 to 1. The three sections below are
the law it sets. The system (`app/src/components/icons`, `IconButton`, the guard
`test/style/icon-vocabulary-guard.test.mjs`) exists now; the surfaces adopt it cluster by cluster
(the E-step), and the guard's baselines only go down.

### Icon vocabulary

Twenty-two glyphs may stand alone on a button, and no others: D154's twelve, the five D177 added for
the bank line (16.10.2026) and the five D180 added for arranging the Übersicht in place (24.10.2026). Each means one thing everywhere, and its name is the button's accessible
name and the first line of its tooltip.

| Glyph | Name | Means | Where |
|---|---|---|---|
| pencil | Bearbeiten | Change this value or draft in place | Drafts and master records. Never a posted entry: its correction is Stornieren, under Mehr |
| paperclip | Anhängen | Attach a Beleg (PDF, photo) | Once attached, the slot shows Öffnen |
| speech bubble | Kommentieren | Add a note to the object | Detail headers; on dense rows it sits under Mehr |
| flag | Markieren | Mark for follow-up or for the payment run | Rows. The marked state has its own accessible name ("markiert"), never colour alone |
| two squares | Kopieren | Duplicate as a new draft | Always yields a draft, never a posted state |
| arrow into tray | Herunterladen | Get a file: CSV, PDF, eCH-0217, a statement | Headers. The tooltip names the file |
| arrow out of a box | Öffnen | Go to the linked object or an outside place | An outside place says so ("neues Fenster") |
| magnifier | Suchen | Search within this surface | Headers. Cmd+K stays the global search |
| three falling lines | Filter | Facets of this list | Headers. An active filter shows its count; "Filter zurücksetzen" stays a word |
| three dots | Mehr | Rare actions and every destructive one | Always. Stornieren, Ignorieren and Löschen live only here |
| cross | Schliessen | Close a drawer or dialog | Top right. Escape is its twin |
| i in a circle | Info | Words on demand: an explanation, a consequence sentence | Beside a commit, the commit carries `aria-describedby` to it |
| a line forking in two | Aufteilen | Split one amount over several accounts | Bank line details (D177) |
| two chain links | Abgleichen | Tie a line to an entry already on the books | Bank line details (D177) |
| outline star | Als Regel speichern | Save how this line books as a Buchungsregel | Bank line details (D177). It books nothing |
| small cross | Ignorieren | Take a bank line out of the inbox without booking it | The bank row's right edge (D177 point 5): the one destructive glyph, because the status line undoes it in one click |
| minus in a ring | Position entfernen | Take a position out of a draft (a split's position) | Draft rows (D177). Never a posted record: its correction is Stornieren. A minus, never a cross: on the bank line × means Ignorieren only (D177 final judge) |
| two sliders | Anpassen | Open the arrangement of this surface for editing, in place | The surface header (D180). Pressed again, as Fertig, it closes the mode; Escape is its twin |
| check | Fertig | Close an arrangement, or confirm a short name entry | Anpassen's pressed state, and the confirm of a one-field name entry such as naming a view (D180). Never a money commit or a posted record |
| eye struck through | Ausblenden | Take an item off the page; it keeps its place | An item in edit mode (D180). The item stays in its slot as a faded ghost until Fertig |
| open eye | Einblenden | Put a hidden item back where it was | A ghost in edit mode (D180) |
| arrows between two edges | Grösse ändern | Make an item wider or narrower, or choose its size | An item in edit mode (D180): a card toggles half and full width; the bank item opens Kachel, Karte oben, Schmale Leiste |

- **The one control is `IconButton`.** It takes a vocabulary key, a required `context` ("Beleg zu
  dieser Buchung"), and nothing else that changes its meaning. The name is its `aria-label`; the
  context is the tooltip's second line and its `aria-describedby`, so a screen reader hears "Anhängen,
  Beleg zu dieser Buchung" and never the name twice. The tooltip opens on a mouse or pen hover (and
  stays while the pointer moves onto it), on keyboard focus and on a 450ms long press on touch, and
  Escape dismisses it wherever focus is. The tap that ends a long press does not act; a keyboard or
  screen-reader click always does. A touch tap opens no bubble, and only a hover-opened bubble takes
  the pointer, so a leftover bubble never catches the next tap.
- **Everything else is an icon plus a word.** A glyph outside the twenty-two never stands alone; status
  and disclosure glyphs sit beside words or inside a primitive that names itself.
- **Money commits always keep their word:** Buchen, Ausstellen, Zahlung buchen, Periode sperren, and
  the one main action of a surface (Neue Buchung, Rechnung erfassen). An irreversible act is never a
  glyph alone, which is why the vocabulary has no "Neu" and no "Löschen". Its one check mark (D180) is
  Fertig: it closes an arrangement whose every change already saved itself, or confirms a one-field
  name entry (naming a view), and it never stands in for Buchen, Ausstellen or any posted record. Where
  it confirms a name entry, `IconButton`'s `name` override says what it does ("Ansicht speichern"), so a
  screen reader never hears a bare "Fertig" for a save; the glyph and its one meaning stay the vocabulary's.
- **Every glyph comes from `app/src/components/icons`:** one grid (24 viewBox, stroke 1.75, round caps,
  `currentColor`), sizes 16, 20 and 24. `test/style/icon-vocabulary-guard.test.mjs` refuses, in the
  JSX it parses (`.tsx` under `app/src`), a new `<svg>` elsewhere, a new `glyphs.tsx`, a new native
  `<button>` whose only content is a glyph (an `<svg>`, a `*Glyph` or an `*Icon` component), and a
  money commit (`data-money-commit`) without words. It does not see `createElement`, a glyph held in
  a variable, an icon-only `role="button"` element or link: those stay review items until the E-step.

### Text budget

Busyness comes from text buttons, labels and boxed controls more than from prose, so those are what
the budget counts: visible words, text buttons, icon buttons and boxes (three or more bordered sides,
or a shadow), at rest and with the main object open, at 1280x800. The C counts are the budget for the
four measured surfaces, and every other surface is held to "no more than today" until its cluster
migrates:

| Surface, at rest | Today: words / text btn / icon btn / boxes | Budget (C) |
|---|---|---|
| Bank | 96 / 20 / 20 / 19 | 61 / 11 / 5 / 0 |
| Journal | 72 / 5 / 1 / 6 | 52 / 3 / 2 / 0 |
| Kreditoren | 127 / 3 / 7 / 3 | 38 / 1 / 4 / 0 |
| MWST | 140 / 3 / 6 / 3 | 30 / 10 / 6 / 1 |

- **Words go to the Info glyph, not away.** A sentence that explains is an (i) card (D152 rule 4);
  a word that names an act stays when the act moves money or is rare enough that nobody would learn
  its glyph (tabs, segments, "Konto wählen").
- **The budget is measured, not argued.** The rendered audit (`docs/planning/handoff-2026-10-07/
  tools/audit2.cjs`) counts all 75 surfaces before and after each cluster; the F-step publishes the
  numbers and turns them into a per-surface-type ratchet. Until then the icon guard is the automated
  half.

### Surface hierarchy

- **One surface layer.** Group by whitespace and alignment, not by cards and borders. A border is
  there for a role (a table's row rule, an input's edge, an overlay's boundary), never to make a box.
- **An opaque sticky header** with the hairline that appears on scroll (D152 rule 6). No translucency
  and no blur: glass stays on the forbidden list.
- **One display step for the key figure.** The surface's one headline figure takes `--t-font-display`
  (32/40, weight 600), and a surface title may go up to `--t-font-3xl` (28/34). Nothing else uses them.
- **A selected tab is neutral:** the `--t-bg-soft` raise in ink, like a selected `Segmented`. Brass
  marks only focus, the selected row and the money commit.
- **Drawers close by X and Escape.** No labelled "Abbrechen"; the footer holds the one primary action
  and its (i). Rare drawer actions (Als Entwurf sichern, Aufteilen, Referenz) move under Mehr.
- **Row actions appear on hover or focus-within**, always on the selected row, and always on touch
  (`@media (hover: none)`), so a touch user never meets a hidden control.

**Grounding.** Apple's Human Interface Guidelines ask that each toolbar item's purpose be clear from a
simple symbol, a short verb label or both, and show a brief help tag when the pointer rests on a
button ([Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars),
[Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)). Material 3 sizes an
icon button's target at 48dp and pairs it with a tooltip for accessibility
([IconButton](https://developer.android.com/reference/kotlin/androidx/compose/material3/IconButton.composable)).
GitHub's Primer makes the icon button's label both the tooltip and the accessible name, with a
separate description for context, which is the `name` plus `context` split above
([IconButton](https://primer.style/components/icon-button)). WCAG 2.2 SC 1.4.13 requires content shown
on hover or focus to be dismissible, hoverable and persistent
([Understanding 1.4.13](https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus)). And
since few icons are universal, the vocabulary is closed and small, learnt through one meaning each,
and every act that moves money or cannot be undone keeps its word.

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

### Motion levels (D178, 21.10.2026)

Motion is a per-person setting with four levels, stamped on the root like density, and the OS
"reduce motion" beats every one of them:

| Level | What it adds |
|---|---|
| **Calm** | The vocabulary below and nothing else: 120-200 ms, three moments, the hover beat, the loop. |
| **Standard** | One entrance per surface: chart marks grow in 400 ms with a 30 ms stagger. Figures are final from the first frame. |
| **Lively** (the default, owner pick) | Chart marks grow in 700 ms with a 60 ms stagger, the Übersicht's headline figures count up over 700 ms, interactive tiles lift 2 px on hover. |
| **Off** | No motion at all, the same as the OS setting. |

Lively keeps two limits that no level lifts: a count-up runs only on the Übersicht's headline figures,
never in a table, an input, a bank amount or anything you act on, and the layout holds still while
anything moves (the space is reserved, only a fill, a mark or a figure changes). The budget sentence
below governs Calm and every moment the levels do not name.

The levels are tokens like the vocabulary: `--t-motion-grow` (700 ms, Lively's marks and count-up),
`--t-motion-grow-standard` (400 ms), `--t-motion-grow-stagger` (60 ms, Lively's per-mark step;
Standard uses `--t-motion-stagger`) and `--t-lift` (2 px). The person's level is the preference
`appearance.motion`, stamped as `data-motion` on the root by `app/src/lib/motion.ts`;
`app/src/styles/motion.css` maps it to what a chart and a tile read, and `off` repeats the kill
switch. The chart palette is two tokens, `--t-chart-in` and `--t-chart-out`, one per theme.

### The vocabulary: three moments, one ease pair (D122 D-I, 05.09.2026)

Motion is spent on exactly three moments, plus one hover beat (K-41) and one loading loop (D155), and
each one is a set of tokens in `tokens.css`, never a number typed into a surface. A surface says `var(--t-motion-reveal)`; it never says `200ms`. The
`test/style/motion-tokens.test.mjs` guard holds the set, the values and the kill switch, and
ratchets the raw duration literals left in the Studio down to zero.

| Moment | What moves | Tokens |
|---|---|---|
| **Navigate** (a change of surface) | The new surface enters in 200 ms from 8 px on the travel side (`--t-ease-out`): a fade over the whole 200 ms, the travel settling in the first 80 ms (`--t-motion-nav-out`, the beat the old surface's exit would have taken). The rail pill changes in 120 ms regardless. Same-surface moves (a list to its detail, a route closing a drawer) do not navigate. **The old surface does not leave**: D-I asked for an 80 ms exit, it was built on the View Transitions API and measured (05.09.2026), and a raw click 150 ms after landing was lost four of four while the transition ran, with `pointer-events: none` on `::view-transition` as documented; the act after a navigation cost 325 ms against 172 with the transition nulled. That is the pointer being fought, so the exit was withdrawn. | `--t-motion-nav-out` 80 ms, `--t-motion-nav-in` 200 ms, `--t-motion-pill` 120 ms, `--t-travel` 8 px |
| **Commit** (post, pay, issue, lock, apply) | The pressed control scales to 0.98 in 80 ms. The new or updated row lands in 180 ms from 8 px above, a check draws in 180 ms beside the words, and an `--t-accent-soft` tint on the row decays over 720 ms. Never a toast that says "Success", never colour alone: the `ActionFeedback` primitive carries the words. | `--t-motion-press` 80 ms, `--t-press-scale` 0.98, `--t-motion-commit` 180 ms, `--t-motion-tint` 720 ms |
| **Reveal** (a dock, a drawer, a disclosure) | The panel slides from the edge it lives on in 200 ms; its items follow with a 30 ms per-item stagger over at most three items. A disclosure's body fades under its chevron in 200 ms. | `--t-motion-reveal` 200 ms, `--t-motion-stagger` 30 ms |
| **Hover** (a pointer over a control; UI polish round 2, K-41) | The one beat under the pointer: a shared primitive's background, ink and edge colour ease in 120 ms (`.btn`, `.field`, `.select-trigger`, `.help-trigger`, the rail tree rows, table row hover). Nothing else moves on hover. | `--t-motion-hover` 120 ms |
| **Loop** (a loading or pending state; owner, 09.10.2026, D155) | A skeleton pulses, or a pending indicator breathes, on one 1400 ms cycle. It is the single allowed exception to the 120-200 ms budget, used only for a skeleton or a pending indicator, never for decoration. Reduced motion stops it. | `--t-motion-loop` 1400 ms |

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

## Website (D181)

tillbooks.ch is the Studio's family, not a second brand (owner, 28.10.2026: visual direction A,
"Brass, refined"). It uses the same Brass tokens, the same one typeface and the same accent budget,
and it adds no colour. What it adds lives in `web/src/styles/site.css` as `--t-site-*` tokens, because
a page read from a couch is not a ledger read at a desk:

- **A bigger scale with a display step.** The home H1 is `--t-site-font-display`: 58px on desktop,
  36px on a phone, weight 700, tracking -0.035em. An inner page's H1 is `--t-site-font-title` (48 to
  32), a band title `--t-site-font-h2` (40 to 26), a lede 20 to 17, body 16 on a 1.6 line. 700 stays
  the ceiling; sentence case everywhere; eyebrows and section labels are dim ink, never brass.
- **One rhythm.** A band is 96px top and bottom on desktop and 64px at mobile width
  (`--t-site-band-y`); two bands on the same ground share one gap instead of stacking two.
- **Soft depth, one shadow.** An elevated panel or a product shot lifts by the background step plus
  `--t-site-shadow-panel`, one soft shadow defined for both themes. This is the website's one
  exception to "no shadow" on panels; it is still never a stack, never a glow, and never a border
  around every card.
- **Pill buttons.** Primary (brass, at most one per band), quiet (neutral with a control edge) and
  link (ink with an arrow). 44px tall, 36px only in the desktop bar.
- **The accent budget is the Studio's**: the single primary action, focus and the selected item.
  "Get TILL" is one primary style on every page; on /start it carries `aria-current` and keeps its
  style. The GitHub control is ink, never brass.
- **Focus is a 2px brass outline** on the website, offset 2px. The Studio's "Sehr subtil" halo is
  tuned for bordered controls in dense tables; on borderless marketing links it would vanish.
- **Motion is transform only** (owner: "subtle movement only"). A Reveal nudges an element that
  starts below the fold by `--t-travel` (8px) and settles it in `--t-motion-reveal`. Content is
  never at `opacity: 0` waiting for an observer, the hero never moves, and reduced motion or a
  missing script leaves the page exactly as authored. `test/web/site-foundation.test.mjs` holds it.
- **The header** is wordmark, Product menu, Compare, Resources menu, GitHub, the language switch and
  Get TILL: seven controls, at the S11 cap. The menus are disclosure buttons that also work on hover
  and degrade without script. Below 900px the nav collapses into a full-sitemap panel over a scrim,
  rows 44px, and the language switch and Get TILL stay in the bar.
- **The footer** is five grouped columns (Product, Compare, Resources, Community, Company) from the
  same map as the mobile menu (`web/src/data/sitemap.mjs`), links at least 32px tall (44px on a
  phone). Community carries GitHub Discussions for questions, an issue for bugs and the mailto as
  an equal path.
- **Shared components** live in `web/src/components/ui/`: Section, PageHero, Button, CtaPair,
  GitHubButton, Badge (icon plus text, never colour alone) and Reveal. A page reaches for them
  rather than restyling a band, a hero or a button of its own.

## Dependencies

The Studio is zero-UI-dependency by default, and every exception is named here (D118 D1/D2). A
dependency is adopted ON ITS TRIGGER, never in advance, and "we might need it" is not a trigger:

| Dependency | Trigger |
|---|---|
| Base UI (per component) | Only when hand-rolling that one primitive would cost 500+ lines (an anchored combobox is the likely first case). Radix, Ark and Headless UI are off the table. |
| dnd-kit | The Favoriten reorder, since D178 the personal menu order, and since D180 the Übersicht's key figures and cards, ALWAYS paired with a non-drag move (WCAG 2.5.7: Alt+Arrow on the focused item and the item's Mehr menu). Drag without that alternative is a defect, not a phase one. One wrapper, `app/src/components/SortableList.tsx`, serves all of them. |
| TanStack Virtual | Only when a list measurably janks (~2'000 rendered rows). Measured, not feared. |
| react-resizable-panels | The first genuine multi-panel surface, if one ever ships. Explicitly NOT the rail splitter, which stays hand-rolled. |
| TanStack Table | Deferred. Revisit only if user-configurable columns/grouping become a product requirement. |

Charts are hand-rolled SVG on one shared primitive (extracted from the creditor-payments liquidity
chart, D178), never a chart library; the /bank detail area's dock drag and divider are hand-rolled
like the rail splitter. The rail splitter stays hand-rolled: it shipped as ~160 lines against the WAI-ARIA window splitter
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
- **Consequence sentences (D156).** At most two sentences: what happens, in the words an owner uses
  ("books", "issues", "sends"), then what you can still do afterwards, naming the correction or
  saying plainly there is no way back. Never "irreversible" or "immutable" where a governed way back
  exists, never a way back that does not exist. A correction is a new entry and both stay traceable
  (de-CH: "Korrekturbuchung", the original stays visible); never "the law forbids".
