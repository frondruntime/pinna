# Pinna design brief

The Pinna site follows the Frond family's look, `frond-look`, a house
style kept with Frond and not published, and departs from it where this
file says. Where the two disagree, this file wins for Pinna. Each departure
below gives Pinna's own value, so this file and the stylesheets describe
the site without `frond-look`.

Pinna leads. The Frond site takes these changes later, and the parts
both sites share move into reusable components then.
Until that happens, `frond-look` still describes the old values, and a
review of the Pinna site checks it against this file first.

The stylesheets in `apps/site/src/styles` hold the values. This file
records what was decided and why.

## The system

### Where a rule goes

`design-system.css` holds the tokens, the reset, the shared components,
the header, and the footer, and every page loads it. `landing.css`,
`docs.css`, and `page.css` (the 404 page) hold each page's own rules.

The order of the stylesheets differs between pages: `design-system.css`
loads before the landing's and the 404 page's stylesheet, and after
`docs.css`. So a shared rule cannot count on loading first. Every shared
base, the focus ring included, is written inside `:where()`, which gives
it no specificity, and a page rule refines it whichever loads first. A
shared rule that needs to win is a sign the value belongs to a token
instead.

### Tokens

A new color, tint, mixed surface, or duration is written as a token
before its second use, so a later change touches one line. Every color,
frame alpha, and duration the shared components use is a token; the tints
that are still literals are listed after the alpha table.

- **Surfaces:** `--bg`, `--bg-dim`, `--panel`.
- **Text:** `--ink-bright` for titles, `--ink`, `--prose` for running
  text, `--muted`, and `--dim` for what recedes: heading anchors, the
  benchmark table's figures, skipped runs, and the hero graph's idle tips.
- **Lines:** `--line`, `--line-bright`, and `--edge` for the hero graph.
- **Accents:** `--accent` (the lit color), `--cyan`, `--amber`, `--pink`,
  `--red`, `--green`. The `-rgb` triplets (`--accent-rgb` and the rest)
  exist for tints that take an alpha.
- **Layout:** `--shell-max` 1320px, `--shell-gutter` 24px (20px under
  64rem, 16px under 40rem), `--header-h` 4rem, and `--grid`, the
  background grid's 64px pitch. The docs count space in `--u`, 0.25rem.

A frame, a line, or a fill in the lit color takes one of seven alphas:

| Token | Alpha | Use |
| --- | --- | --- |
| `--lit-hairline` | 0.28 | Underlines of quiet links, the text selection |
| `--lit-line-soft` | 0.6 | A beam frame that marks a state, the sidebar's current page and the add() panel; the 404 page's plain action under the pointer |
| `--lit-line` | 0.7 | A beam frame that invites a click; the mark's frame; the square that caps the docs' pagination rule |
| `--lit-line-hover` | 0.9 | That frame under the pointer |
| `--lit-fill` | 0.06 | A beam frame's fill |
| `--lit-fill-hover` | 0.12 | That fill under the pointer |
| `--lit-panel-line` | 0.3 | The frame of a docs code panel |

These tints are still literals, each at one or two places:

| Where | Value | Note |
| --- | --- | --- |
| The hero's title, the header's current-page dot | Lit glows at 0.8, 0.2, 0.08, and 0.42 | Light, not a frame |
| The hero's primary action | Lit fill 0.08, 0.14 on hover | Beside the frames' 0.06 and 0.12; open |
| The landing's showcase code panels | 30% of the panel's own color | The `--lit-panel-line` recipe on `--code-accent` |
| Docs callouts | Cyan, red, or lit at 0.26 | Near `--lit-hairline`'s 0.28; open |
| The docs' Avoid panel | Red at 0.38 | |
| The benchmark disclaimer | Red at 0.45 and 0.25 | |
| The 404 status badge | Red at 60% and 8% | |
| The hero graph's caption rule | Lit at 25% | |
| The suite grid's passing cell | Lit at 55% on `--bg` | |
| The benchmark table's best figure and its swatch | Lit at 18% on `--panel` | |
| The 404 page's plain action | `--panel` at 0.7 | |
| The mark's ground | `--bg-dim` at 0.88 | |
| The add() panel's fill | `--bg` at 70% | Dark, to read over the graph |
| The landing's info cards | `--panel` 44% on `--bg` | Beside `--panel-subtle`'s 50%; open |
| Benchmark failure text | Red mixed with amber, red with `#ff0033`, and `#ff5c77` | |
| Landing link underlines | `currentColor` at 40% | Follows the link's color |

Three surfaces are mixed from the others: `--code-surface`, the code bars'
fill; `--panel-subtle`, a quiet inset; and `--shade`, the black at 0.5
behind the phone drawer and under the hero's dock.

Motion has four durations. A control answers hover and focus in
`--duration-control` (0.12s), the phone drawer slides in
`--duration-drawer` (0.2s), and the hero graph eases a state change in
`--duration-graph` (0.3s) and enters in `--duration-enter` (0.4s). The
graph's flash and step timings live in `src/lib/frondScene.ts`, beside the
code that runs them.

Custom properties cannot drive a media query, so the breakpoints are a
list kept in the tokens' comment: 24rem, 40rem (phones), 700px, 48rem
(tablets, and the docs drawer), 900px, 64rem, 1100px, and 78rem.

The syntax theme, the Mermaid renderer, and the browser's theme color run
at build time and cannot read a custom property, so
`apps/site/src/lib/palette.ts` repeats the colors they use. A token's
color changes in both files. The syntax theme's own colors, for tags,
property names, and punctuation, live in the theme alone.

### Components

- **Code bar** (`.code-bar`). The header bar over a code panel: the label
  on the left, controls on the right, in 0.7rem uppercase tracked 0.1em,
  `--muted` on `--code-surface`, framed by `--code-border` with no bottom
  line. The landing pads it `8px 16px` (`8px 12px` on phones) and colors
  a showcase panel's label in that panel's color; the docs' `.code-header`
  pads it `8px 16px` too and spaces the label from the copy button.
- **Code body.** 0.72rem at a line height of 1.66, square, and it scrolls
  sideways rather than wrapping. Each page sets its own inset and surface.
- **Action** (`.action`). A link that acts as a button: 0.82rem, bold,
  uppercase, tracked 0.04em. The hero's actions are 44px tall and the 404
  page's are 40px.
- **Beam frame.** A recipe, not a class, because each frame sits on a
  different element with its own layout: a 1px line in `--lit-line`,
  `background: var(--beam-corners)` for the lit corners, and
  `background-color: var(--lit-fill)`, brightening to `--lit-line-hover`
  and `--lit-fill-hover`. A frame that marks a state takes
  `--lit-line-soft`. The sidebar's current page draws its line as an inset
  shadow, so the link's text does not shift; the add() panel keeps a dark
  fill, to stay readable over the graph. The hero's primary action, the 404
  page's primary action, the add() panel, the sidebar's current page, and
  the docs pagination under the pointer use it.
- **Focus ring.** Every link and button shows the same 2px ring in the lit
  color, 3px out, square. The hero graph's own controls draw their focus
  inside the graph.

## Departures from frond-look

### Shape

- **Radius is 0 everywhere.** Controls, panels, the brand mark, focus
  outlines, and the hero's dock are square. frond-look gives 2px, 3px for
  the dock, and 999px for pills and dots.
- **Dots are square.** The current page's dot in the navigation is a 6px
  square with the same glow.

### Color

- **Cyan also marks a value that just changed.** frond-look keeps cyan
  for links, the mark's tip, and level-three headings. In the hero graph
  it is also the color of a write: the parts a write changed flash cyan,
  then fade to the lit color if the todo is done or to gray if it is not.
  Cyan never stays on the graph at rest, so it does not compete with the
  lit color as a second one, with one exception: the stem's tip turns cyan
  once every todo is done, as the brand mark's tip is, and stays cyan until
  a todo is undone or added. It is one square, and it marks the one state
  the whole frond is in.

### Motion

- **Nothing moves forever.** The hero headline has no blinking cursor. The
  lit word and its glow stay. frond-look keeps the cursor as the one
  endless motion.
- **A write flashes the hero graph, a step at a time.** The changed parts
  flash in the order the change reaches them: the box that was written,
  the computed value it invalidates, then the row that renders it, 100 ms
  from the write to the render. Each flash fades in 700 ms. Under reduced
  motion the graph changes color at once, with no flash.

### Ornament

- **No `→` after links or actions.** Secondary actions, section links to
  the docs, and the docs' "Next" link carry their text alone. A section
  link to the docs is underlined with a hairline in the lit color at 0.28
  alpha, which turns to the full lit color on hover. Arrows that belong to
  the content, such as the edges in the hero graph's caption, stay.
- **No rules beside labels.** Code panel labels, the docs sidebar's group
  labels, and the table of contents label stand alone, with no hairline
  running from them.
- **No separator glyphs.** The footer, the docs pagination, and the 404
  page space their items with a gap, not with dots or bars.
- **The landing page ends on its last section.** There is no closing
  call-to-action band, no uppercase lead line above the explicit section,
  and no numbers on its points.

### Space

Every padding and gap is a multiple of 4px. The landing stylesheet writes
pixels; the docs stylesheet writes `calc(var(--u) * n)` with
`--u: 0.25rem`. Both land on the same grid.

| Element | Value | frond-look |
| --- | --- | --- |
| Panel inset (code panels and their header bars, cards, tables, legend, disclaimer, docs code blocks) | 16px | mixed |
| Panel inset on phones, landing code panels | 12px | |
| Landing section padding | `112px 0`; `80px 0` on phones | `104px 0 112px` |
| Hero bottom padding | 112px | |
| Code panel header bar | `8px 16px` | |
| Benchmark table cells | `8px`, line height 24px, 40px rows | |

A few values stay off the grid on purpose: the 3px gap inside conformance
suite cells, the margin of an inline compiler error's note, the 2px side
padding of header links, the dock's offsets from the graph, the docs
sidebar links' 6px vertical padding, the drawer's close button pulled
10px into its edge so its glyph lines up with the links, and the
screen-reader utility's 1px.

### Components

- **Docs code panels have the landing panels' header bar.** The bar holds
  the language name on the left, or the "Avoid" or "Recommended" label
  when the example has one, and the copy button on the right. The label is
  `--muted` in docs, where every block carries one; the landing's panel
  labels are in the lit color, where each panel is a showcase. An "Avoid"
  panel's bar and frame are red.
- **The benchmark legend has no fill.** It is outlined like the
  disclaimer above it, so the two read as one kind of frame.
- **The hero graph is drawn as a vector display.** Edges are thin lines,
  and the pads are wireframes: a cube for a box and a row, an octahedron
  for a computed value. Pads are hollow, and nothing on the graph glows
  at rest; frond-look fills a lit pad and gives it a glow. Only a flash
  glows. The page background is the plain grid alone, with no color wash
  and no spotlight that follows the pointer. The docs keep their look.
- **The hero graph has the brand mark's shape.** It is a frond: the stem
  is the realm, its root pad the `$todos` box, and each todo is a leaf
  that alternates sides up the stem, as a fern's do, carrying its `$done`
  box, its `$label` computed value, and its `<Row>`. Each todo leaf is a
  little shorter than the one below, so the frond narrows to its tip. Past
  the last todo, three shorter leaves end in the realm's totals, `$count`,
  `$left`, and `$allDone`, each a computed value with its value printed
  beside it; they are real computed values, so a write flashes them too.
  No leaf ends bare.
- **The 3D graph keeps its leaves flat to the screen.** The frond turns in
  3D, but each leaf's points are projected and drawn facing the viewer, so
  pads, names, and rows keep their shape and size at any angle instead of
  skewing with the turn. Without WebGL2 the same frond is drawn flat in
  SVG.
- **The brand mark is drawn as beams too.** A leaflet of thin lime lines,
  a stem with two pairs of leaves, stands in a 1px frame whose corners are
  lit squares; the tip is the cyan square it always was, and the only part
  that glows. frond-look's mark sets filled pads along a stem whose trace
  runs from lime to cyan. The favicon is the same drawing.
- **The primary action and the add() panel are beam frames.** The hero's
  primary button, the 404 page's primary action, and the hero's add()
  panel take the mark's frame: a 1px line in the lit color at 0.7 alpha
  (0.6 on the panel), with 3px lit squares at its corners. Hover brightens
  the line to 0.9 and the fill. None of them glows, at rest, on hover, or
  on focus; frond-look gives the button a glow on hover and the dock one at
  rest. The panel keeps its dark shadow, and the input and the Add button
  inside it keep their plain frames. The corners are the `--beam-corners`
  token.
- **The docs mark the current page with beams, not bars.** The sidebar's
  current page is a beam frame, a 1px lit line at 0.6 alpha with the lit
  corners over a 0.06 fill, and a link under the pointer takes a plain
  hairline frame. The table of contents marks the section in view with a
  4px lit square beside its first line, like the header's current page.
  frond-look marks both with a 2px bar on the left.
- **The docs sidebar has no panel.** On wide screens it sits on the page's
  grid with a hairline on its right, as the table of contents has one on
  its left, so the current page's beam frame is the one box in it. The
  phone drawer keeps the `--panel` fill, so it covers the page behind it.
  frond-look fills the sidebar with `--panel` and frames it on every side.
- **A docs divider starts at a pad.** Each level-two heading's hairline
  starts at a hollow 7px square in the lit color at 0.7 alpha, centered on
  the line, like a trace leaving a pad in the hero graph. The hairline
  above the pagination ends the page on the same pad.
- **Docs pagination links become beam frames on hover.** Under the pointer
  a previous or next link takes the sidebar's current-page frame: a 1px lit
  line at 0.7 alpha, the lit corners, a 0.06 fill, and its text in the lit
  color. At rest it keeps its plain frame.
- **The graph recedes further under the headline.** Above 900px its mask
  holds 0.22 to 0.3 alpha across the headline's width (to 42%), then rises
  to 0.85 at 60%; frond-look's mask runs straight from 0.3 to 0.85. The
  headline also takes the lede's `--bg` halo. Together they keep the
  graph's names on the left as background while its stem and lit nodes stay
  bright.

## Kept as they are

- `--dim` colors two kinds of text, and both are meant to be quiet: the
  "—" in a benchmark cell that was not measured, and the heading anchor
  that appears on hover in the docs. frond-look lists `--dim` text as a
  known miss; on this site the remaining uses are these two.
- The WARNING box in the docs keeps its red outline and label.
