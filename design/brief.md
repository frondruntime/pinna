# Pinna design brief

The Pinna site follows the house style of the Frond family's sites, kept in
`frondruntime/site-kit` as `design/house-style.md`, with the tokens, the
shared components, the docs shell, and their stylesheets. Where the two
disagree, this file wins for Pinna. A change to the shared look is made in
site-kit and reaches this site as a new pin in `apps/site/package.json`.

This file records what is Pinna's own: the landing, the hero graph, the
benchmark and conformance tables, the brand mark, and the footer's garden.
Their styles are in `apps/site/src/styles/landing.css` and
`apps/site/src/styles/site.css`, and the graph's flash and step timings in
`apps/site/src/lib/frondScene.ts`.

## Motion

- **Only a failure moves forever.** The hero headline has no blinking
  cursor; the lit word and its glow stay, and they hold still: no warm-up
  on load and no pulse; only the pointer brightens its edge (Vector
  display). The one endless motion is the
  glitch on a benchmark cell in the table's last tier, more than 1,000×
  the best figure or a stack overflow, and on its legend swatch, because
  that cell marks a failure and must not read as a figure to compare. Under reduced motion it holds still. frond-look
  keeps the cursor as the one endless motion.
- **The suite grid takes no hover.** The conformance card shows the three
  rows of squares and the legend under them (pass, differs from the suite,
  skip). A readout that ringed a hovered case in every row, dimmed the
  rest, and named each library's result and reason was removed on the
  owner's call; the reasons stay in the suite's `expected.ts`.
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
  flash is a P7 phosphor's: a white strike for 60 ms, cyan that fades in
  700 ms, and a lime afterglow at half strength that settles into the
  part's own color over 1,600 ms.
  The afterglow passes a part that is not done through lime on its way
  back to gray, as a tube's persistence does. A label's text takes the same
  curve on the same steps without the strike: cyan at 70% decaying with a
  110 ms constant over lime at 35% that settles in 800 ms, mixed in oklab
  over 32 keyframes, with a text shadow of up to 5px in its own color
  (`lib/phosphor.ts`). Under reduced motion the graph
  changes color at once, with no flash.
- **A todo just added stays lime for a while.** Its row starts at 70%
  lime and settles to `--prose` over 8 s, fast at first and slow at the
  end, so the newest row reads apart from the rest. A todo drawn on load
  does not take it, and under reduced motion no row does.
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

## Ornament

- **The landing page ends on its last section.** There is no closing
  call-to-action band, no uppercase lead line above the explicit section,
  and no numbers on its points.

## Components

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
  glows. The beam dwells where it stops: a pad's stroke is lifted 20%
  toward white over its edges, and each joint where a leaf meets the stem
  is a 3px point in the leaf's color, so the drawing is brightest where it
  has structure without a glow rule. The page background has no color wash; its graticule, its
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
- **The graph recedes further under the headline.** Above 900px its mask
  holds 0.22 to 0.3 alpha across the headline's width (to 42%), then rises
  to 0.85 at 60%; frond-look's mask runs straight from 0.3 to 0.85, so the
  graph's names on the left read as background while its stem and lit
  nodes stay bright. Only the lede takes a `--bg` halo.

## Vector display

- **A landing section starts at a pad and a trace.** A hollow 5px square
  sits on the section's top edge, the size of a code bar's pad, and a 1px
  trace leaves it in the lit color at 0.45, fading out within 480px or 60%
  of the shell. The section's id stands at the top right in `--dim`, as
  "api" after a 9px `--hash-small`, and is a link to the section, lit
  under the pointer; its label names the heading, as the docs' heading
  anchors do.
- **The hero's primary action blooms under the pointer and focus.** The
  beam frame keeps its line and fill and adds `--bloom-frame`, as
  frond-look's button glows on hover; the 404 page's primary action does
  not.
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
