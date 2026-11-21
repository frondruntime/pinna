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
- **Text:** `--ink-bright` for small titles and lit values, `--display`
  for headings set large, `--ink`, `--prose` for the docs' running text,
  `--lede` for the landing's, `--muted` for labels, notes, and captions,
  and `--dim` for what recedes: heading anchors, the benchmark table's
  figures, skipped runs, and the hero graph's idle tips.
- **Lines:** `--line`, `--line-bright`, and `--edge` for the hero graph.
- **Accents:** `--accent` (the lit color), `--cyan`, `--amber`, `--red`,
  `--green`. The `-rgb` triplets (`--accent-rgb` and the rest)
  exist for tints that take an alpha.
- **Layout:** `--shell-max` 1320px, `--shell-gutter` 24px (20px under
  64rem, 16px under 40rem), `--header-h` 4rem, and `--grid`, the
  background grid's 64px pitch. The docs count space in `--u`, 0.25rem.

A frame, a line, or a fill in the lit color takes one of eight alphas:

| Token | Alpha | Use |
| --- | --- | --- |
| `--lit-hairline` | 0.28 | Underlines of prose and supporting links, the text selection |
| `--lit-line-soft` | 0.6 | A beam frame that marks a state, the sidebar's current page and the add() panel |
| `--lit-line` | 0.7 | A beam frame that invites a click; the mark's frame; the square that caps the docs' pagination rule |
| `--lit-line-hover` | 0.9 | That frame under the pointer |
| `--lit-fill` | 0.06 | A beam frame's fill |
| `--lit-fill-hover` | 0.12 | That fill under the pointer |
| `--lit-panel-line` | 0.3 | The frame of a docs code panel |
| `--lit-trace` | 0.45 | A landing section's trace where it leaves its pad |

These tints are still literals, each at one or two places:

| Where | Value | Note |
| --- | --- | --- |
| The lit word | A white core at 0.3, then its own color at 40% and 12%; its edge's line at 80% and shadow at 35% | Light, not a frame; in `currentColor`, so a green word glows green |
| The header's current-page dot | Lit glow at 0.42 | Light, not a frame |
| The hero's primary action | Lit fill 0.08, 0.14 on hover | Beside the frames' 0.06 and 0.12; open |
| The landing's showcase code panels | 30% of the panel's own color | The `--lit-panel-line` recipe on `--code-accent` |
| Docs callouts | Cyan, red, or lit at 0.26 | Near `--lit-hairline`'s 0.28; open |
| The docs' Avoid panel | Red at 0.38 | |
| The benchmark disclaimer | Red at 0.45 and 0.25 | |
| The hero graph's caption rule | Lit at 25% | |
| The suite grid's passing cell | Lit at 55% on `--bg` | |
| The suite grid's current case | `--accent` ring; other squares at 0.45 opacity | |
| The benchmark table's best figure and its swatch | Lit at 18% on `--panel` | |
| The mark's ground | `--bg-dim` at 0.88 | |
| The add() panel's fill | `--bg` at 70% | Dark, to read over the graph |
| The landing's info cards | `--panel` 44% on `--bg` | Beside `--panel-subtle`'s 50%; open |
| Benchmark failure text | Red mixed with amber, red with `#ff0033`, and `#ff5c77` | |
| The graticule's plus marks | White at 0.04 | Inside a data URI, which cannot read a token |
| The vignette | Black at 0.38 | |
| The grid lit under the pointer | Lit lines at 0.035 | |
| The Effect code panel's corner dots | `--green` at half strength, full under the pointer | |
| The corner dots of the benchmark disclaimer and a docs "Avoid" panel | `--red` at half strength, full under the pointer | |

Three surfaces are mixed from the others: `--code-surface`, the code bars'
fill; `--panel-subtle`, a quiet inset; and `--shade`, the black at 0.5
behind the phone drawer and under the hero's dock.

Controls, the drawer, and the graph move in five durations. A control
answers hover and focus in `--duration-control` (0.12s) and decays in
`--duration-decay` (0.6s) once the pointer or focus leaves, the phone
drawer slides in `--duration-drawer` (0.2s), and the hero graph eases a
state change in `--duration-graph` (0.3s) and enters in `--duration-enter`
(0.4s). The graph's flash and step timings live in
`src/lib/frondScene.ts`, beside the code that runs them. A control's
transition names `--duration-beam`, which holds the decay at rest and the
control's speed under `:hover` or `:focus-visible`, so one transition
lights fast and fades slowly.

Bloom is one token: `--bloom-frame` (an outer 14px halo at 0.16 and an
inner 10px at 0.06) on the primary action of the landing and the Effect
page under the pointer or focus. A panel's corner dots are `--corner-size`
(3px); a panel sets `--corner` to its frame's hue and `--corner-inset` to
where its frame lies.

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
  uppercase, tracked 0.04em, and 44px tall. The secondary action
  (`.btn-secondary`) is a muted link with the beam underline, beside the
  primary one on the landing, the Effect page, and the 404 page.
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
  for links, the mark's tip, and level-three headings; this site keeps it
  for the tip and the headings, and links take the lit underline
  (Ornament, below). In the hero graph
  it is also the color of a write: the parts a write changed flash cyan,
  then fade to the lit color if the todo is done or to gray if it is not.
  Cyan never stays on the graph at rest, so it does not compete with the
  lit color as a second one, with one exception: the stem's tip turns cyan
  once every todo is done, as the brand mark's tip is, and stays cyan until
  a todo is undone or added. It is one square, and it marks the one state
  the whole frond is in.
- **Large headings are a step under white, and running text a step over
  `--muted`.** The hero, the landing's section and card headings, and a
  page's title take `--display` (#d4e3dc, 14.7:1 on `--bg`), at weight 700
  (600 for a docs page's title), with the hero and the 404 page's title
  tracked to -0.02em. The landing's paragraphs take `--lede` (#a7b4b5,
  9.1:1) at 0.95rem and a 1.65 line height. frond-look has neither token:
  its titles are `--ink-bright` (18.5:1) and its landing paragraphs
  `--muted` (6.4:1). A designer's review read that pair as glare over text
  too dim to read at length; the headings' contrast over the text's drops
  from 2.9× to 1.6×. The section headings lost their 12% white halo, which
  frond-look's LOOK-04 forbids on a heading, and the hero's headline its
  `--bg` halo; only its lit word keeps the beam glow (Vector display). A
  phosphor gradient on its lines was tried and dropped, and so was weight
  600.

### Motion

- **Only a failure moves forever.** The hero headline has no blinking
  cursor; the lit word and its glow stay, and they hold still: no warm-up
  on load and no pulse; only the pointer brightens its edge (Vector
  display). The one endless motion is the
  glitch on a benchmark cell in the table's last tier, more than 1,000×
  the best figure or a stack overflow, and on its legend swatch, because
  that cell marks a failure and must not read as a figure to compare. Under reduced motion it holds still. frond-look
  keeps the cursor as the one endless motion.
- **A control fades like phosphor.** It lights in 0.12s under the pointer
  or focus and fades in 0.6s once left, as a vector display's beam leaves
  an afterglow. frond-look answers both ways in the same 0.12s.
- **Focus looks like hover.** Every link and button outside the hero graph
  and the brand mark lights the same way under keyboard focus as under the
  pointer, the primary action's switch-on included, and keeps the 2px lit
  focus ring outside it, because a keyboard user
  must see where focus is whether or not the control changes.
- **A link's underline brightens in place.** Under the pointer or focus
  the `--lit-hairline` underline turns to the full lit color with the
  text, in 0.08s (`--duration-link`), and fades back in 0.3s
  (`--duration-link-decay`) once left. That is faster than a control both
  ways, because a page carries dozens of links and the pointer crosses
  them on the way elsewhere: at 0.12s in and 0.6s out the light trailed
  the pointer. It does not sweep: a line drawn across the text was too
  slow and too loud. A background layer draws it, its color a registered
  property so it can fade.
- **The primary action switches on.** When the pointer or focus arrives
  on the hero's primary button or the 404 page's primary action, the whole
  action brightens by 15%, dips once to 94%, and settles in 360 ms, eased
  rather than stepped, as a tube's beam does as it warms. A stepped
  160 ms flicker at 1.7× read as a glitch, which on this site means a
  failure. It plays on every arrival and never at
  rest, and not at all under reduced motion. A press flashes the fill to
  0.24 and thickens the line inward by a pixel, at once, with no fade in.
- **A copy lights the code panel's seam.** When a docs copy button reports
  "Copied", a short lit segment runs once along the line under the
  panel's header bar, left to right in 0.44s (`--duration-sweep`). A failed copy turns the
  button red and runs nothing. Under reduced motion only the button's
  text changes.
- **The section marker slides.** The table of contents' lit square moves
  from one section to the next in 0.3s (`--duration-graph`), so the eye
  follows it down the list instead of finding it again. The first section
  marked shows the square where it lands. Under reduced motion it jumps.
- **A table row lifts under the pointer.** A landing benchmark row takes a
  5% lit fill over `--panel`, and a docs table row a 4% one, lighting in
  0.12s and fading in 0.6s like a control, so one row reads across twelve
  columns. A best cell keeps its own fill.
- **A suite case reads across the libraries.** Hovering or tapping a
  square in the conformance grid rings that case in all three rows with a
  1px `--accent` outline 1px out, inside the 3px gap, and dims every other
  square to 0.45 in 0.12s; leaving the card fades both back in 0.6s, like
  a control. The dim is on the three rows' containers and the ring is one
  marker per row, a copy of the case's square moved by transform: a dim
  on each square started 483 opacity transitions as the pointer entered
  the card, 16 to 19 ms of style work on an M1 Pro against 2 ms now,
  and a case under the pointer costs 1.2 ms.
- **The suite's legend and its readout share one slot.** At rest the
  slot under the rows holds the legend (pass, differs from the suite,
  skip) and "Hover or tap a square for its case."; a case replaces it
  with the case (`#id` and title), each library's result in the legend's
  colors, and the reason recorded for a miss, from the suite's
  `expected.ts`. Leaving the card brings the legend back; a tap has no
  leave, so a tapped case stays until a tap outside the card. The case
  replaces the native `title` tooltip, which appeared only after the
  browser's delay and spoke for one library's square. A resting case
  (#154, the one Pinna differs on) was dropped: it repeated the note
  under the grid and read as a case the pointer had left behind. A hidden
  copy of the case with the most text (#154, by 37 characters) shares the
  slot's grid cell, so the card keeps its height at every width. A glow on the
  hovered square was dropped: it marks no live state or failure
  (frond-look LOOK-04), and it lit one library where the question is how
  all three answer.
- **A section's trace draws as it scrolls in.** Where `animation-timeline:
  view()` runs and motion is not reduced, the trace leaving a landing
  section's pad grows from the pad as the section enters, tied to the
  scroll and not to a clock; elsewhere it is drawn at once. The rule has
  no `@supports` guard, because Biome stops checking selector order after
  an `@supports` block, and a browser without scroll timelines runs the
  animation in 0s.
- **A write flashes the hero graph, a step at a time.** The changed parts
  flash in the order the change reaches them: the box that was written,
  the computed value it invalidates, then the row that renders it, 100 ms
  from the write to the computed value and 200 ms to the render. Each
  flash fades in 700 ms. Under reduced motion the graph changes color at
  once, with no flash.
- **A press on a part that holds no todo explains it and changes
  nothing.** The totals, `$todos`, the stem (the realm), and the tip are
  not controls: the pointer stays an arrow over them, and their name
  brightens to `--ink-bright`. A press brightens the part 70% of the way
  to `--ink-bright` and grows a root, tip, or total pad 35%, settling in
  450 ms, and the caption says what the part reads and what changes it,
  such as "`$count` is computed from `$todos`: `add()` and `remove()`
  change it; a toggle does not." The pop is white and not cyan, because
  cyan means a value changed and nothing was written. Visitors press the
  totals and the stem, and before this a press there did nothing. Under
  reduced motion only the caption changes; the flat drawing explains the
  same parts without the pop.

### Ornament

- **No `→` after links or actions.** Secondary actions, section links to
  the docs, and the docs' "Next" link carry their text alone. Arrows that
  belong to the content, such as the edges in the hero graph's caption,
  stay.
- **Prose and supporting links are underlined in the lit color.** The
  underline is `--lit-hairline` (0.28), whatever the link's text color,
  and turns to the full lit color with the text on hover ("A link's
  underline brightens in place", under Motion). A link laid out as a flex
  box, such as the hero's secondary action, carries it along its bottom
  edge. An underline that followed the text's color read gray under muted
  text and green under a section link, so two links side by side looked
  like two kinds. Docs prose links take the same underline over `--ink`
  text, a step brighter than the prose's `--prose`. frond-look colors docs
  prose links cyan; on this site cyan means a value that just changed
  (Color, above), and a cyan link was a third kind of link.
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
- **Pinna's benchmark columns are marked, never crowned.** Its three
  columns sit on a 3% lit wash and its name in the header is lit, so the
  eye finds the library the page is about. The wash is far under a best
  cell's 18% fill, so it never reads as a win.
- **The hero graph is drawn as a vector display.** Edges are thin lines,
  and the pads are wireframes: a cube for a box and a row, an octahedron
  for a computed value. Pads are hollow, and nothing on the graph glows
  at rest; frond-look fills a lit pad and gives it a glow. Only a flash
  glows. The page background has no color wash; its graticule, its
  vignette, and the grid it lights under the pointer are under "Vector
  display".
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
  the line to 0.9 and the fill. None of them glows at rest; the hero's
  primary button blooms on hover and focus (see "Vector display"), and the
  404 page's primary action and the panel never glow. frond-look gives the
  button a glow on hover and the dock one at rest. The panel keeps its dark shadow, and the input and the Add button
  inside it keep their plain frames. The corners are the `--beam-corners`
  token.
- **The docs mark the current page with beams, not bars.** The sidebar's
  current page is a beam frame, a 1px lit line at 0.6 alpha with the lit
  corners over a 0.06 fill, and a link under the pointer takes a plain
  hairline frame. The table of contents marks the section in view with a
  4px lit square beside its first line, like the header's current page,
  that slides from section to section (Motion). frond-look marks both with
  a 2px bar on the left.
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
  to 0.85 at 60%; frond-look's mask runs straight from 0.3 to 0.85, so the
  graph's names on the left read as background while its stem and lit
  nodes stay bright. Only the lede takes a `--bg` halo.

### Vector display

The site reads as a vector display, a tube that draws lines with a beam,
and the frond as a plant grown on it. Each mark below copies a part of
such a display or of a garden bed, and carries no data of its own, so
each is faint and none sits inside running text. frond-look has none of
them: its background is a flat grid, and its rule LOOK-04 lets glow mark
only a live state, a failure, or identity.

- **The background is a graticule.** A plus 3px a side, 2px of arm on
  each side of the center, marks every crossing of the 64px grid, in white
  at 0.04, and a vignette darkens the
  window's edges to black at 0.38, as a tube's falls off.
- **The grid lights under the pointer, faintly.** Over the graticule, the
  64px grid's lines turn lit at 0.035 within a 220px circle of the
  pointer, and nothing else changes. The light sits on the pointer with
  no trail; it comes up in 0.4s when a fine pointer enters the page and
  fades in 0.6s when it leaves, and a touch screen draws none. Every move
  is a transform, so the compositor draws it and nothing is painted again
  while the pointer moves: a lens of fixed size and fixed mask moves to
  the pointer while its grid moves back by as much. A trail that eased
  the light toward the pointer, a mask whose center moved and repainted
  the window on every move, lit plus marks, and a lit fill on the cell
  under the pointer and its neighbors were rendered and dropped as too
  loud for a background. It is `.site-background-pointer` in
  `design-system.css`, fed by `SiteBackground.astro`.
- **Panels end in dots, as a beam frame does.** Code panels, the docs'
  code frames, the landing's info cards, and the benchmark legend and
  disclaimer carry a 3px square on each corner of their frame, the same
  square a beam frame's corners carry, so every frame on the site ends the
  same way. The dots are the panel's hue at half strength: lit, green on
  the Effect panel, red on the disclaimer and on a docs "Avoid" panel.
  Under the pointer they come up to full in 0.12s and fade back in 0.6s,
  as a control does; nothing else on the panel changes. The benchmark
  table's scroll box carries none, because a dot inside a scrolling box
  would scroll and clip with it.
- **A code bar's label starts at a pad**, a hollow 5px square in the
  label's color.
- **A landing section starts at a pad and a trace.** A hollow 5px square
  sits on the section's top edge, the size of a code bar's pad, and a 1px
  trace leaves it in the lit color at 0.45, fading out within 480px or 60%
  of the shell. The section's id stands at the top right in `--dim`, as
  "api" after a 9px `--hash-small`, and is a link to the section, lit
  under the pointer; its label names the heading, as the docs' heading
  anchors do.
- **A link to a section is a # drawn as the graph.** `--hash`, in
  `design-system.css`, draws two 1px edges each way at 0.6 crossing at
  four filled 3px nodes, 13px a side beside a docs heading, drawn to whole
  pixels. `--hash-small` draws it 9px a side with 2px nodes beside a
  landing section's id; a 2px node centered on a 1px edge sits on half
  pixels, which are whole device pixels on a screen of two or more. An
  11px mark with 3px nodes read too heavy beside the 0.68rem id. Neither
  is scaled. The glyph carries no underline: it
  marks the link alone, and a line under a 13px drawing read as part of
  it.
- **The lit word stands on an edge.** One word of a headline is lit
  (`.lit-word`, in `design-system.css`): "hard" in the hero, "Effect" on
  the Effect page in green, and "read" on the 404 page. Its glow is a
  beam's, a white core 1px wide at 0.3, a 3px halo in the word's color at
  40%, and a 16px bloom at 12%, so it reads as a lit stroke and not a soft
  blur. Under it runs an edge of the hero graph: a 1px line in the word's
  color at 80% between two filled square nodes, max(3px, 0.035em) a side,
  0.1em under the baseline and 0.08em past each end of the word, with a
  2px shadow at 35%. The edge rests at 0.7 and comes up to full under the
  pointer in 0.12s, fading back in 0.6s, as a panel's corner dots do;
  nothing else moves. The hero's headline passes clicks through to the
  graph behind it, and the lit word takes the pointer so its edge can
  light. Every color is `currentColor`, and the lit color sits in
  `:where()`, so the Effect word keeps its green whichever stylesheet
  loads first. A misconverged beam, an outlined word, a frame, a reticle,
  a traced branch, and a line drawn on load were rendered and dropped for
  this still edge.
- **The hero's primary action blooms under the pointer and focus.** The
  beam frame keeps its line and fill and adds `--bloom-frame`, as
  frond-look's button glows on hover; the 404 page's primary action does
  not.
- **A docs list grows leaves.** An unordered list's bullet is a 6px
  filled leaflet in the lit line color, which reads as a dot at reading
  distance, drawn as a masked `::before`, because a
  `::marker` takes no mask. The disc stays, transparent, because Safari
  drops a list's role when its `list-style` is `none`. Ordered lists keep
  their numbers.
- **The page ends on the ground.** The footer's rule is a lit hairline at
  0.28 with small trees standing on it, up to 16px tall, each a copy of
  the brand mark: a lime stem with a filled 3px node at its tip and pairs
  of 1px beams that leave the stem at one point, one to each side, rising
  5px for every 8px out as the hero graph's branches do and shortening
  toward the tip. About one beam in three ends in a filled node; the rest
  end bare, because a node on every end read as a circuit, not a plant.
  Each tree is drawn at one of three strengths, its beams at 0.22, 0.32,
  or 0.45 and its nodes at 0.4, 0.52, or 0.65, so the row stays below the
  page's text and has depth without gray: gray traces and hollow pads,
  copied from the hero graph, read as dead plants. About one tip in eight
  and one node in ten is cyan at 0.7 and glows, as the mark's tip does;
  this departs from LOOK-04, since the glow marks no state, and it is kept
  because it ties the garden to the mark beside it. No two trees touch:
  `bun run --cwd apps/site sprouts` draws them from a seeded generator
  (`apps/site/scripts/sprouts.ts`) as one 1499px tile, wider than a
  1440px window, and fails when two trees, glow included, stand closer
  than 4px, across the tile's seam too. A data URI cannot read a token, so
  the run copies `--accent` and `--cyan` into the tile; run it again after
  changing one.

## Kept as they are

- `--dim` colors two kinds of text, and both are meant to be quiet: the
  "—" in a benchmark cell that was not measured, and the heading anchor
  that appears on hover in the docs. frond-look lists `--dim` text as a
  known miss; on this site the remaining uses are these two and the
  landing's section anchors.
- The WARNING box in the docs keeps its red outline and label.
