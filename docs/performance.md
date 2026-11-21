# Pinna performance: direction and findings

`design.md` "Benchmarks" holds the reference table; this file holds where
performance work goes next and why. "Where 1.0 stands" is the state on
2026-11-13; "Measurements, in order" is the dated log behind it, and its
entries after that date, through "The graph tables after the fairness fixes, rough tier"
(2026-11-18), are newer than the summary.

## Direction (owner, 2026-11-04)

1. **Effect moves out of the core.** Not deleted: the schema checks, `Equal`
   and `Hash`, and decode move behind their own import path. Done
   2026-11-14: they are `@frondruntime/pinna-effect` (ruling 44 in
   `api.md`). The reason is the shape of the code, not
   speed: the spike below shows Effect costs almost nothing on the bare path.
   In a real application Effect is still present, at another boundary
   (network, storage, services); the core is what runs on every read and
   write.
2. **Aim at alien-signals**, the fastest library of this family, for the graph
   alone. MobX stays the line to beat, since Pinna replaces it.
3. **Hermes first.** Hermes matters more than Bun: it is what ships, it scales
   to real applications, and code that allocates little and keeps stable
   shapes is fast on JavaScriptCore too. A win measured only in Bun counts as
   a hint until Hermes confirms it.

## Budget for 1.0 (owner, 2026-11-05)

Beating alien-signals is not a goal on its own. Pinna 1.0 pays for its design
and guarantees with speed, within a budget measured on Hermes:

- the public layer, a realm and its boxes, within **2×** alien-signals;
- the graph core within **1.6×**;
- less memory than alien-signals where it can be had, counted as bytes
  allocated, garbage included, and faster than MobX everywhere.

A change that costs nothing in the API, the guarantees, or the code's shape
goes in. A structural rewrite, or anything exotic or questionable, waits for
the next version. Make and dispose, 3.1× in the public layer and 2.6× in the
core, is the price of the design for now. Adding rows one update at a time,
6 to 8× slower than MobX, is the list copy (plan item 5), a design question
of its own.

## Where 1.0 stands (2026-11-13)

`bench:hermes-graph` on `main` on 2026-11-13, ms minimum of 18 runs over two
runs of the bench (KB allocated by one run). The baseline for what comes
next; the black-box scenarios, the store against MobX, and the hooks are in
"Baseline after the second round (2026-11-13)".

| | Pinna | alien-signals | MobX | Pinna ÷ alien | Pinna ÷ MobX |
| --- | --- | --- | --- | --- | --- |
| deep chain | 69.2 (44) | 42.4 (7,845) | 222 (31,353) | 1.63× | 0.31× |
| fan-out | 149 (61) | 99.0 (7,845) | 561 (88,380) | 1.51× | 0.27× |
| diamond | 95.7 (28) | 58.6 (7,852) | 250 (32,979) | 1.63× | 0.38× |
| conditional reads | 374 (11,021) | 256 (42,089) | 1306 (178,300) | 1.46× | 0.29× |
| make and dispose | 26.5 (11,810) | 13.3 (10,714) | 85.6 (32,054) | 2.00× | 0.31× |
| write 1000 sources in one update | 124 (3,325) | 80.7 (17,983) | 341 (64,935) | 1.54× | 0.36× |
| bursty fan-out | 154 (371) | 505 (8,850) | 565 (88,380) | 0.30× | 0.27× |
| increment ×100k | 249 (25,004) | 147 (36,722) | 662 (128,911) | 1.69× | 0.38× |
| one write among 10k watched rows | 2.89 (409) | 1.90 (449) | 7.40 (1,372) | 1.52× | 0.39× |

- **Within the 2× budget** everywhere, make and dispose on the line: 1.99×
  and 2.00× in the two runs, 2.00× on their minimum ("Fewer calls on a
  write, a read, and a watch's make and dispose"). Since 2026-11-16 it is
  1.94× ("A first run links its own edges").
- **Since 2026-11-09:** bursty fan-out 468 to 154 ms, a third of
  alien-signals' time ("A source written again in one update marks once");
  every other scenario 0.95 to 1.02× of then, within noise. Allocation is
  unchanged.
- **Allocates less than alien-signals** in eight of the nine scenarios,
  all but make and dispose: 11,810 KB against 10,714, down from 12,122 with
  two fields off every derived, watch, and reaction node ("Two fields fewer
  on a node").
- **Faster than MobX** in every graph scenario, and in every `bench:hermes`
  row but adding rows one update at a time (6 to 8× slower, plan item 5).
- **In a React Native app** (`apps/rn-bench`, full mode, 2026-11-16),
  with every store kept to the same three reactive fields a row and built
  with babel-preset-expo's defaults: Pinna's store loads 10,000 rows in
  51 ms against alien-signals' 27, MobX 7.1.7's 238, and Legend State's 166,
  and ticks in 28 ms against 25, 42, and 232. The load allocates 8.5 MB
  against 15.4, 115.9, and 29.1; the rows keep 43.5 MB against 42.3, 51.9,
  and 45.9, so Pinna makes less garbage than alien-signals but does not keep
  less. MobX inserts 100 rows about 5 times faster than Pinna, 2.7 against
  14 ms. MobX 7.1.7 loads about 80 ms and 60 MB slower than 6.15.3 did,
  which is Babel's class helper, not MobX ("MobX 7.1.7 in every bench").
  The figures of 2026-11-14, MobX at 2,545 ms and Legend State at 5,769 on
  load, measured stores that made every field reactive, and are withdrawn
  ("Four stores tuned to one reactive shape").
- **Next version:** appending without copying (plan item 5). Edges are
  reused in place since 2026-11-07 ("Edges reused in place").
- **React, on Bun with happy-dom:** `useValue` is 1.0 to 1.4× a hand-written
  MobX `observer` and 1.1 to 1.5× a plain `useSyncExternalStore` store, with
  the same renders. `useSelect` keeps the layout effect per render.
- **React hooks on Hermes, without React** (`bench:hermes-hooks`): against
  the hook before ruling 39, on ticks, `useValue($box)` is 0.60 to 0.67× per
  render with half the garbage, `useValue($computed)` 0.75 to 0.78× with the
  box's garbage, and `useValues` 0.57 to 0.65×. A snapshot read that finds
  nothing changed allocates nothing.
- **Against Legend State** (2026-11-11), the observable store React Native
  teams pick today: Pinna is 5.6 to 18× faster on Hermes in every graph
  scenario and every js-reactivity-benchmark shape, and Legend allocates 13
  to 23,000 times more ("Legend State as a third library").

## Measurements, in order

### The first data benchmark (the explicit-observables spike)

The spike that introduced `$` boxes measured 10,000 todos, each with a
`$done` box and a `$label` computed value (`bench:data`, one run, without
freezing):

| | MobX | Pinna |
| --- | --- | --- |
| build 10k | 13.53 ms | 12.13 ms |
| decode 10k | 11.25 ms | 9.34 ms |
| memory 10k decoded | 16.6 MB, 28 obj/row | 15.0 MB, 35 obj/row |
| memory 10k observed | 52.0 MB, 58 obj/row | 35.0 MB, 72 obj/row |
| observe 10k rows | 15.43 ms | 6.85 ms |
| toggle 1 row ×1000, observed | 650.84 ms | 724.99 ms |
| toggleAll 10k, observed | 10.55 ms | 11.56 ms |
| add ×1000, observed | 1.65 ms | 304.05 ms |
| add ×1000, unobserved | 1.42 ms | 301.87 ms |
| add 1000 in one update, observed | 1.28 ms | 1.66 ms |

With freezing, adding ×1000 took 3,317 ms and toggling ×1000 took 1,449 ms:
in JavaScriptCore, `Object.freeze` on a 10,000-element array takes about
3 ms and a frozen array is slower to walk. Values are not frozen since; the
`readonly` types are the guard. Adding one item to a 10,000-item box cost
about 0.3 ms then, the whole new array checked against its schema.

### Against MobX (`bench:data`, loaded machine, run that passed every ceiling)

| | MobX | Pinna, bare | Pinna, schema |
| --- | --- | --- | --- |
| toggle 1 row ×1000, observed | 1070 ms | 2.9× faster | 3.5× faster |
| toggleAll 10k, observed | 26.3 ms | 4.4× faster | 4.1× faster |
| observe 10k rows | 24.2 ms | 3.5× faster | 2.4× faster |
| decode 10k | 11.5 ms | 2.8× faster | 2.0× slower |
| build 10k | 16.2 ms | about even | about even |
| rename 1 keyed row ×1000, 10k readers | 3.03 ms | even | even |
| add 1000 in one update, observed | 2.91 ms | 3× faster | 1.8× faster |
| add ×1000, one update each, observed | 1.90 ms | 14× slower | 28× slower |
| memory, 10k observed | 52 MB, 58 obj/row | 22 MB, 43 obj/row | 22 MB, 43 obj/row |
| memory, 10k decoded | 16.6 MB, 28 obj/row | 14.1 MB, 29 obj/row | 5.6 MB, 8 obj/row |

### Graph alone (the spike's graph bench, minimum of 15 runs, ms)

| | Pinna | Pinna, no check or journal | alien-signals | MobX |
| --- | --- | --- | --- | --- |
| deep chain 1000, write ×100 | 6.3 | 6.2 | 2.9 | 16.0 |
| fan-out 1000 watched, write ×100 | 8.1 | 8.1 | 6.3 | 29.3 |
| diamond 1000 into a sum, write ×100 | 5.6 | 5.8 | 4.9 | 15.7 |
| conditional reads 1000, flip ×100 | 45.6 | 45.8 | 15.6 | 67.2 |
| make and dispose 1000 watched computeds ×10 | 3.9 | 3.9 | 1.1 | 12.2 |
| write 1000 sources in one update ×100 | 16.4 | 8.1 | 4.4 | 18.8 |

Pinna beats MobX in every scenario. Against alien-signals it is within 1.2×
on fan-out and diamond, and 2.2× to 3.7× behind on the rest.

### Graph alone on Hermes (`bench:hermes-graph`, 2026-11-05)

Hermes V1 260318099.0.5, code lowered by React Native 0.88.1's preset.
Minimum of 9 runs in ms, and KB allocated by one run, garbage included.

| | Pinna | alien-signals | MobX | Pinna ÷ alien | Pinna ÷ MobX |
| --- | --- | --- | --- | --- | --- |
| deep chain 1000, write ×100 | 92 | 42 | 214 | 2.18× | 0.43× |
| fan-out 1000 watched, write ×100 | 187 | 98 | 546 | 1.91× | 0.34× |
| diamond 1000 into a sum, write ×100 | 136 | 58 | 245 | 2.35× | 0.55× |
| conditional reads 1000, flip ×100 | 544 | 245 | 1264 | 2.22× | 0.43× |
| make and dispose 1000 watched computeds ×10 | 44 | 12.5 | 82 | 3.53× | 0.54× |
| write 1000 sources in one update ×100 | 185 | 78 | 323 | 2.37× | 0.57× |
| bursty fan-out: 1000 watched, 100 writes per update ×100 | 2362 | 484 | 542 | 4.88× | 4.36× |
| increment ×100k, each value checked | 352 | 144 | 642 | 2.44× | 0.55× |
| one write among 10k watched rows ×1000 | 4.3 | 1.7 | 7.0 | 2.57× | 0.62× |

| KB allocated by one run | Pinna | alien-signals | MobX |
| --- | --- | --- | --- |
| deep chain | 3,253 | 7,845 | 31,353 |
| fan-out | 28,297 | 7,845 | 88,380 |
| diamond | 14,288 | 7,852 | 32,979 |
| conditional reads | 116,458 | 42,089 | 178,300 |
| make and dispose | 21,975 | 10,714 | 32,054 |
| write 1000 sources in one update | 72,244 | 17,983 | 64,935 |
| bursty fan-out | 805,602 | 8,850 | 88,380 |
| increment ×100k | 126,567 | 36,722 | 128,911 |
| one write among 10k watched rows | 1,426 | 449 | 1,372 |

What Hermes shows that Bun hid:

1. **Pinna is about 2 to 2.5× alien-signals everywhere on Hermes**, not only
   on the scenarios that lagged on Bun. Fan-out and diamond, within 1.3× on
   Bun, are 1.9× and 2.4× on Hermes: Bun's JIT was absorbing per-dependent
   overhead.
2. **Bursty fan-out is the one scenario Pinna loses to MobX**, 4.4× on
   Hermes (2.5× on Bun), and it allocates 805 MB per run: about 80 bytes for
   every write times every dependent. Each write inside an update seems to
   do per-dependent work that allocates, where alien-signals allocates
   almost nothing. It is the first thing to find; not yet diagnosed.
3. **Allocation tracks time.** Where Pinna allocates 3 to 4× alien-signals
   (fan-out, conditional reads, increment, one write among 10k), it runs
   2 to 2.5× slower. On a deep chain Pinna allocates less than alien-signals
   and is still 2.2× slower, so that gap is calls, not garbage.

### Observers in linked nodes (2026-11-05)

Bursty fan-out's 80 bytes were Hermes's `for...of` over a `Set`: it
allocates an iterator result for every element, where `forEach` and an
indexed loop allocate nothing (`HermesInternal.getInstrumentedStats()` on a
bare loop). Each source now keeps its observers in a doubly linked list of
link nodes in link order; the observer holds its link, so unlinking is
constant time, and marking walks `next` with a while loop. The tracker holds
the link in a third slot beside each source and version.

| Hermes, ms (KB per run) | Before | After |
| --- | --- | --- |
| deep chain | 92 (3,253) | 94 (4,035) |
| fan-out | 187 (28,297) | 184 (22,039) |
| diamond | 136 (14,288) | 133 (8,849) |
| conditional reads | 544 (116,458) | 503 (78,164) |
| make and dispose | 44 (21,975) | 43 (19,315) |
| write 1000 sources in one update | 185 (72,244) | 180 (73,025) |
| bursty fan-out | 2362 (805,602) | 1625 (25,133) |
| increment ×100k | 352 (126,567) | 350 (128,130) |
| one write among 10k watched rows | 4.3 (1,426) | 4.2 (1,442) |

- **Bursty fan-out no longer allocates, and is still 3.4× alien-signals and
  3× MobX.** What is left is calls: every write in the update marks the
  derived value again, which marks all 1000 watchers again, because a mark
  is skipped only when the graph version has not moved, and every write
  moves it. alien-signals stops at a subscriber already pending. That is
  the next step.
- **On Bun it got slower in two scenarios**, old and new run back to back:
  bursty fan-out 69.5 to 91.5 ms and one write among 10k 1.42 to 1.55 ms.
  Bun's `Set` iteration does not allocate, so walking link objects is the
  price without the win. Not diagnosed further; Hermes is the target.
- **Memory with 10k rows observed** (`bench:hermes`) went from 27.9 to
  28.9 MB: a link object per observed edge. Toggle and rename moved within
  the noise of back-to-back runs.

### A computed value marks its observers once (2026-11-05)

A computed value marked after its last check has marked its observers
already, and a write skips it, as alien-signals stops at a pending
subscriber. The skip holds only while each observer it marked is still due.
A watcher's update can stop at the first change or throw, a flush drops
watchers at its round limit, and a reaction can link to what an earlier run
read: each moves `Graph.markFloor` to the current version, and a mark at or
below the floor is walked again. Inside one update no watcher runs, so the
writes there mark once; across flushes it is the old behavior. Four tests
pin those four holes (each fails with the skip and no floor), and a fifth
counts the marks.

A review found a fifth hole: a watcher due in a round and not yet run
counted as due, so an earlier watcher's write in the round skipped it, and
it ran once in that round instead of again in the next, against "a
watcher's writes run in the next round" (`design.md`). The floor now moves
at the start of every round as well; a test pins the order.

Step 1 and this step back to back, ms minimum:

| | Hermes before | Hermes after | Bun before | Bun after |
| --- | --- | --- | --- | --- |
| bursty fan-out | 1675 | 560 | 92.0 | 79.8 |
| one write among 10k watched rows | 4.28 | 4.36 | 1.69 | 1.25 |
| write 1000 sources in one update | 186 | 192 | 17.3 | 17.6 |
| conditional reads | 520 | 529 | 23.2 | 24.9 |

- **Bursty fan-out on Hermes is 1.12× alien-signals and 0.97× MobX**, from
  3.4× and 2.9×. On Bun it is 1.30× alien-signals and still 2.8× MobX, and
  above the 69.5 ms it took before step 1.
- The other scenarios moved by 4% or less in either direction, about what
  separates two runs of the same code; allocation is unchanged.

### A rerun that reads what it read allocates nothing (2026-11-05)

A probe on Hermes (`HermesInternal.getInstrumentedStats()`, bytes per
computed value or watcher per write) found where reruns allocated:

| Case | Before | After |
| --- | --- | --- |
| write a value a computed reads | 289 | 0.7 |
| watcher rerun | 185 | 0.4 |
| computed values into one watcher | 90 | 0.4 |
| write nothing observes | 243 | 3 |
| flip which value a computed reads | 513 | 224 |
| empty `realm.update` | 473 | 233 |

What it was, and what replaced it:

- `tracker.length = 0` drops the array's storage on Hermes, so every run
  reallocated its scratch tracker. The scratch now keeps its slots and the
  graph keeps its length; what a run read is cleared slot by slot once it
  is taken, so a long run holds nothing after a short one.
- A function that holds a closure gets the closure's scope on entry, before
  any early return: about 80 bytes per call. `drain` returns before the
  function that makes the closures, and a watcher calls its effect inline
  instead of through `untracked`.
- The pending watchers are a fixed array with a length; a round swaps it
  with a spare instead of making a new one.

Tests pin the two new ways to hold memory (a long run followed by a short
one, a watch stopped while another is due) and the order of watchers left
due after one is stopped; each fails on a mutant of its change.

Step 2 and this step back to back on Hermes, ms minimum (KB per run):

| | Before | After | alien-signals |
| --- | --- | --- | --- |
| deep chain | 92.8 (4,035) | 96.8 (102) | 41.2 (7,845) |
| fan-out | 182 (22,039) | 183 (135) | 94.4 (7,845) |
| diamond | 131 (8,849) | 134 (166) | 56.5 (7,852) |
| conditional reads | 512 (78,164) | 498 (22,104) | 242 (42,089) |
| make and dispose | 43.9 (19,316) | 40.8 (13,378) | 12.5 (10,714) |
| write 1000 sources in one update | 187 (73,025) | 177 (47,222) | 77.7 (17,983) |
| bursty fan-out | 546 (25,133) | 536 (2,455) | 483 (8,850) |
| increment ×100k | 351 (128,130) | 347 (97,661) | 141 (36,722) |
| one write among 10k watched rows | 4.47 (1,442) | 4.21 (1,137) | 1.67 (449) |

- **Allocation fell by a quarter to 99%, and time moved 6% or less.** On the
  Hermes interpreter the gap to alien-signals is calls, not garbage. Pinna
  now allocates less than alien-signals in five of the nine scenarios.
  Collection pauses in an app are not in these numbers.
- **The changed rerun keeps its 224 bytes**: the copy of what it read
  (about 144) and a link for the new source (about 80, which alien-signals
  allocates too). Writing the copy into the old tracker means splitting
  `relink` and a reentrant scratch for the dropped links; with time flat
  after a 72% cut on conditional reads, it is not worth it.
- **Hermes data** (`bench:hermes`, three runs each, loaded machine): toggle,
  toggleAll, rename, and adds moved within the noise; one toggle run of
  10.4 s did not repeat. Memory with 10k rows observed went from 28.9 to
  29.2 MB; not diagnosed.
- **Bun**, back to back: conditional reads 23.1 to 21.5 ms, the rest within
  noise; bursty fan-out 74.4 to 83.0 ms, about where step 2 measured it
  (79.8).

### A write allocates almost nothing (2026-11-05)

The same probe, bytes per operation on Hermes:

| Case | Before | After |
| --- | --- | --- |
| empty `realm.update` | 115 | 3 |
| update writing one `Unknown` box | 541 | 35 |
| update writing one `Number` box | 685 | 116 |
| one `Number` box written twice in an update | 1,213 | 228 |
| 1000 `Unknown` boxes in one update, per write | 482 | 32 |
| 1000 `Number` boxes in one update, per write | 626 | 112 |
| the journal's record, per box | 242 | 0.3 |
| `Number` equality | 147 | 3 |

What it was, and what replaced it:

- **`batch` took a closure**, so every `realm.update` paid a scope. The
  graph has `beginBatch` and `endBatch`, and `update` calls them directly;
  `batch` is written with them.
- **The check ran inside `untracked`**, another closure per write. It now
  saves and restores the tracker inline.
- **A schema that accepts every value still built a check.** `Unknown` and
  `Any` without refinements share one function that returns nothing; a
  refined one is checked as before. Nothing is traded: there was nothing to
  check.
- **The journal was two maps and an object per step.** It is now two flat
  arrays the realm keeps across updates: one of steps (box, value, version)
  and one of values from before the outermost update, which a box finds by
  an index in a field. The end of the outermost update and a rollback clear
  the slots they used, so an update holds no old value after it ends.
- **Effect's `Equal.equals` reads `arguments`**, about 144 bytes per call.
  For a primitive schema whose equivalence is Effect's own, the box compares
  with `===`, and NaN with `Number.isNaN`, which is what `Equal.equals` does
  on primitives. A schema with its own equivalence keeps it.

Tests first, each caught by a mutant of its change: a check adds nothing to
what a run reads; a nested update that fails puts back only what it wrote,
and the next update rolls back from where it began; an update that wrote
many boxes, and a rolled-back nested one, keep none of the old values; an
`Unknown` box accepts every value while a refined one still rejects; a
`Number` box counts 0 and -0, and NaN and NaN, as the same value, as
`Equal.equals` does; a primitive schema with its own equivalence keeps it.

Step 3 and this step back to back on Hermes, ms minimum (KB per run):

| | Before | After | alien-signals |
| --- | --- | --- | --- |
| deep chain | 98.7 (102) | 97.2 (52) | 42.9 (7,845) |
| fan-out | 184 (135) | 185 (84) | 97.1 (7,845) |
| diamond | 137 (166) | 139 (116) | 58.5 (7,852) |
| conditional reads | 519 (22,104) | 519 (22,005) | 250 (42,089) |
| make and dispose | 42.4 (13,378) | 42.1 (13,378) | 13.0 (10,714) |
| write 1000 sources in one update | 187 (47,222) | 145 (3,412) | 79.1 (17,983) |
| bursty fan-out | 569 (2,455) | 550 (394) | 500 (8,850) |
| increment ×100k | 362 (97,661) | 315 (48,442) | 146 (36,722) |
| one write among 10k watched rows | 4.60 (1,137) | 3.74 (644) | 1.90 (449) |

- **Writes are 13 to 22% faster on Hermes and allocate 1.8 to 14× less.**
  Pinna now allocates less than alien-signals in seven of the nine
  scenarios; the two left are make and dispose, and increment.
- **Bun**, back to back: write 1000 sources 18.2 to 6.6 ms (alien-signals
  4.4), increment 34.8 to 14.2 ms (8.4), one write among 10k rows 1.78 to
  1.02 ms (1.46, so Pinna is ahead); the rest within noise.
- **Hermes data** (`bench:hermes`, two runs each, bare Pinna): build and
  decode of 10k rows 38 to 19 ms, memory decoded 18.3 to 8.1 MB, memory
  observed 29.2 to 19.0 MB, toggle 1 row ×1000 4.5 to 3.6 s, toggleAll 46 to
  39 ms. All of it is the shared check: before, every `Unknown` box built its
  own. The Effect Schema subject did not move, and neither did adds.
- **What a write still costs**: the `Number` check, 84 bytes, is
  `Schema.is` (idea 1). `box.modify` with a recipe costs about 1.5 KB per
  call, in the draft machinery, not the write. The realm's journal arrays
  keep their storage after a large update, as the graph's tracker does.

### A flush makes no closure, and a recompute makes fewer calls (2026-11-05)

A Hermes profile of a deep chain put the time in the recompute's calls
(`recompute`, `settle`, `refresh`, `record`, `track`, `current`, `same`,
`passesOn`) and in the flush, not in marking or checking. `hermesc -O` inlines
a small free function but not a method, so each method call is paid as
written. What changed, none of it in the API:

- **The settle of a flush built two closures on every call**, a reporter and
  a hook pass. They are methods now, `reportSettling` and `settleHooks`,
  returning the reporter's error to keep instead of writing a captured
  variable; the first error is still the one thrown.
- **The default equality is checked in place.** `same` guards `equals`
  against reads; `Object.is` reads nothing, so it is called directly.
- **`current()` is written out** at its two callers, `get` and `refresh`.
- **`passesOn` is called only for a run that threw.**
- **`settle` compares and copies in one pass.** On a mismatch, the slots
  already passed take their sources back before the copy. The versions it
  wrote into the old tracker are never read: every caller replaces its
  sources with the new tracker.

Left out: inlining `track` into the recompute, a small gain that needed
private fields made public; skipping `relink`'s passes for a first link,
which would link twice a source `forward` lists twice.

Guards: each change was mutated and the suite run. Five mutants passed it,
none of them in the old tests either, and each now has a test that fails
under it: a write throws the reporter's first error when two watchers throw,
and when two hooks begun in one pass throw; it throws the reporter's error on
the round-limit report; a hook error an activation settles goes to the host
when the reporter throws; hooks that keep beginning once the watchers reach
their limit stop at the hook limit. The guards pass on the old code too.
Removing the pass count of the main hook loop makes the suite hang rather
than fail. Dropping `computing` from `get`'s check is equivalent today (a
computing value was never checked at the current version) and stays as the
guard.

Before and after, back to back on Hermes, ms minimum (KB per run):

| | Before | After | alien-signals | After ÷ alien | After ÷ MobX |
| --- | --- | --- | --- | --- | --- |
| deep chain | 95.7 (52) | 77.7 (28) | 41.7 (7,845) | 1.86× | 0.35× |
| fan-out | 181 (84) | 160 (60) | 94.3 (7,845) | 1.70× | 0.29× |
| diamond | 134 (116) | 118 (92) | 58.7 (7,852) | 2.00× | 0.47× |
| conditional reads | 508 (22,005) | 470 (21,959) | 249 (42,089) | 1.89× | 0.37× |
| make and dispose | 41.6 (13,378) | 40.4 (13,378) | 13.1 (10,714) | 3.08× | 0.47× |
| write 1000 sources in one update | 143 (3,412) | 140 (3,389) | 79.2 (17,983) | 1.77× | 0.41× |
| bursty fan-out | 538 (394) | 512 (371) | 499 (8,850) | 1.03× | 0.91× |
| increment ×100k | 309 (48,442) | 289 (25,004) | 142 (36,722) | 2.04× | 0.44× |
| one write among 10k watched rows | 3.38 (644) | 3.19 (410) | 1.70 (449) | 1.87× | 0.46× |

- **The public layer is 11 to 19% faster on chains, fan-out and diamonds,
  7% on conditional reads and increment.** It is within the 2× budget
  everywhere but make and dispose (3.1×); increment is on the line.
- **Allocation:** Pinna allocates less than alien-signals in eight of the
  nine scenarios; increment went from 48 to 25 MB per run, since a flush no
  longer allocates. Make and dispose is the one left.
- **The core alone**, after (a scratch probe, not a package script): deep
  chain 66.6 ms, fan-out 139, diamond 100, conditional reads 411, make and
  dispose 35.2, increment 201; 1.4 to 1.7× alien-signals, so within the 1.6×
  budget but for diamond (1.7×) and make and dispose (2.6×).
- **`bench:hermes`**, back to back: within noise but toggleAll (37.2 to
  32.0 ms) and adding 1000 in one update (5.07 to 4.49 ms). Pinna, bare,
  beats MobX in every row but adding rows one update at a time (6 to 8×
  slower, the list copy).

### The React hooks, and what the discarded-render fix costs (2026-11-05)

`pinna-react`'s `bench`: a list of rows, each showing one price through
`useValue`, a hand-written MobX `observer` core (as the conformance test
writes it), or a plain `useSyncExternalStore` store per row. Bun 1.4.2,
React 19.3.1's production build, happy-dom; each operation in `flushSync`, and
each one checks the rows it rendered and the text it left. ms minimum of 7
runs. "Before" is the previous hook (`track` on every render) on today's
core, whose `track` is unchanged; "after" is the fixed hook (`trackPending`, then
`adopt` in a layout effect). The before column is a separate run; the MobX
and plain columns of that run were within 0.6 ms of these.

| | Pinna before | Pinna after | MobX observer | plain store | after ÷ before | after ÷ MobX |
| --- | --- | --- | --- | --- | --- | --- |
| mount 1000 rows | 2.87 | 3.43 | 2.64 | 2.35 | 1.20× | 1.30× |
| 1000 rows: one row ticks ×100 | 9.17 | 9.51 | 6.22 | 7.81 | 1.04× | 1.53× |
| 1000 rows: every row ticks ×10 | 8.43 | 9.91 | 5.65 | 5.58 | 1.18× | 1.75× |
| 1000 rows: add a row ×20 | 3.22 | 3.48 | 2.52 | 2.72 | 1.08× | 1.38× |
| 1000 rows: remove a row ×20 | 4.32 | 4.33 | 3.46 | 3.28 | 1.00× | 1.25× |
| mount 10000 rows | 19.4 | 24.1 | 17.1 | 16.0 | 1.24× | 1.41× |
| 10000 rows: one row ticks ×100 | 91.6 | 94.5 | 52.8 | 67.7 | 1.03× | 1.79× |
| 10000 rows: every row ticks ×10 | 131 | 157 | 85.0 | 79.2 | 1.21× | 1.85× |
| 10000 rows: add a row ×20 | 30.5 | 30.2 | 21.2 | 21.1 | 0.99× | 1.43× |
| 10000 rows: remove a row ×20 | 47.4 | 42.5 | 30.5 | 30.1 | 0.90× | 1.40× |

Render counts match across all four: one row per tick, every row per
tick-all, the list and one row per add, the list alone per remove.

`bench:hermes-reaction`: what the hook asks of a reaction per render,
without React, on active reactions that read the same cells each time. ms
minimum of 9 runs (KB allocated by one run).

| | `track` | `trackPending` + `adopt` | ratio |
| --- | --- | --- | --- |
| Bun: 1000 reactions × 1 cell, ×100 | 2.89 | 4.40 | 1.52× |
| Bun: 1000 reactions × 10 cells, ×100 | 9.86 | 20.6 | 2.09× |
| Bun: 10000 reactions × 1 cell, ×10 | 2.92 | 4.35 | 1.49× |
| Hermes: 1000 reactions × 1 cell, ×100 | 55.7 (3) | 107 (120) | 1.91× |
| Hermes: 1000 reactions × 10 cells, ×100 | 206 (3) | 433 (331) | 2.11× |
| Hermes: 10000 reactions × 1 cell, ×10 | 55.8 (3) | 107 (1,175) | 1.92× |

- **The fix costs 20 to 24% where every row renders** (mount, every row
  ticks) and nothing measurable where one row does: there React's walk past
  the other rows costs more than the hook.
- **On Bun most of that is the layout effect**, not the graph: `adopt` adds
  about 0.015 µs per render in the microbench, the React bench about 0.27 µs.
- **On Hermes the graph part doubles**: about 0.5 µs more per render, and it
  allocates where `track` allocates nothing, since `adopt` relinks even when
  the render read what the kept one did (`pending` is never `sources`).
  10,000 rows ticking cost about 5 ms more per tick on Hermes from this alone.
  The same 100,000 renders allocate 120 KB over 1,000 reactions and 1,175 KB
  over 10,000; why is not known yet.
- **`useValue($x)` reads the realm context it does not need.** A plain store
  whose rows also call `useContext` goes from 67.7 to 88.1 ms on one row
  ticking ×100 among 10,000 (a scratch probe), close to Pinna's 94.5: on
  every update React checks the context of each row it walks past. That is
  most of Pinna's gap to the plain store on single ticks, before and after the
  fix.
- **Not measured:** React on Hermes (React DOM does not run on bare Hermes),
  and `ValueStore` itself there; the microbench drives `Reaction` directly.

### `useValue` subscribes to what it reads; `useTracked` keeps the function (2026-11-05)

Ruling 39 in `api.md`. `useValue($x)` and `useValues([...])` know their
observables before the render, so the render reads them with `peek()` and
`useSyncExternalStore` returns the value. The reaction tracks them in
`subscribe`, which React runs only for a render it keeps. No layout effect,
no realm context, no reaction work in the render. The function form moves to
`useTracked`, which keeps the `trackPending` and `adopt` hook unchanged.
This is how tldraw's `useValue` and Zustand subscribe; the track-in-render
hooks (MobX `useObserver`, Legend-State, Preact signals) skip the discarded
render's cost and carry the staleness the discarded-render fix removed.

The same `pinna-react` bench, which reads through `useValue`. ms, the lower
minimum of two runs of 7 each; "before" is the hook before this change, "after" the slice. The
MobX and plain columns are the lowest of all four runs.

| | Pinna before | Pinna after | MobX observer | plain store | after ÷ before | after ÷ MobX | after ÷ plain |
| --- | --- | --- | --- | --- | --- | --- | --- |
| mount 1000 rows | 3.08 | 2.94 | 2.74 | 2.51 | 0.95× | 1.07× | 1.17× |
| 1000 rows: one row ticks ×100 | 9.00 | 8.21 | 6.21 | 7.62 | 0.91× | 1.32× | 1.08× |
| 1000 rows: every row ticks ×10 | 10.4 | 7.64 | 5.79 | 5.51 | 0.74× | 1.32× | 1.39× |
| 1000 rows: add a row ×20 | 3.11 | 2.95 | 2.51 | 2.55 | 0.95× | 1.18× | 1.16× |
| 1000 rows: remove a row ×20 | 4.38 | 4.16 | 3.36 | 3.26 | 0.95× | 1.24× | 1.28× |
| mount 10000 rows | 25.4 | 18.9 | 18.2 | 16.1 | 0.74× | 1.04× | 1.18× |
| 10000 rows: one row ticks ×100 | 95.9 | 73.1 | 52.6 | 69.1 | 0.76× | 1.39× | 1.06× |
| 10000 rows: every row ticks ×10 | 163 | 122 | 89.1 | 82.6 | 0.75× | 1.36× | 1.47× |
| 10000 rows: add a row ×20 | 31.1 | 24.2 | 21.4 | 21.8 | 0.78× | 1.13× | 1.11× |
| 10000 rows: remove a row ×20 | 47.0 | 41.0 | 31.4 | 31.3 | 0.87× | 1.31× | 1.31× |

- **A quarter off where every row renders**, and below the hook before the
  discarded-render fix (19.4 and 131 ms at 10,000 rows): the fix's cost and
  the context read are both gone from `useValue`.
- **One tick among 10,000 rows is within noise of the plain store.** The
  plain store's own minimum ranged 69 to 77 ms over the four runs.
- **Still 1.0 to 1.4× MobX `observer`.** What is left is the reaction per row
  and the version check in the graph, not the hook.
- **`useTracked` costs what `useValue` cost before**: the code is unchanged,
  and the previous entry's numbers stand for it. Not rerun.
- **Not measured here:** the new hooks on Hermes, and allocation per render;
  the next entry measures both.

### The hooks on Hermes, and what a render allocates (2026-11-05)

`bench:hermes-hooks`: what each hook asks of Pinna, without React, on Bun
and on Hermes (`bench/hooks-model.ts`). Each row has two boxes and their
sum, and its hook shows `$a`. The model drives the stores of
`pinna-react/src/index.ts` the way React 19's production
`useSyncExternalStore` does. A mount reads the snapshot in the render,
subscribes, and reads it once more, as the passive effect does. A change
reads it in the listener, as `handleStoreChange` does, and again in the
render that follows. A tick writes `$a` of the ticking rows in one
`realm.update`, with its schema check, and renders the rows the listeners
marked. The model checks each tick's marked-row count and rendered total.
"Before" is the store before this change, which every form used, given a new read
function each render as an inline arrow is; it is `useTracked`'s store
today. ms minimum of 9 runs, Hermes V1 260318099.0.5.

| Hermes | `useValue($box)` before | after | `useValue($computed)` before | after | `useValues([$a, $b])` before | after |
| --- | --- | --- | --- | --- | --- | --- |
| mount and unmount 1000 rows | 2.05 | 2.13 | 4.47 | 5.13 | 2.98 | 3.43 |
| mount and unmount 10000 rows | 27.8 | 26.9 | 53.9 | 60.8 | 39.3 | 44.3 |
| 1000 rows: every row ticks ×100 | 316 | 197 | 433 | 341 | 442 | 298 |
| 10000 rows: every row ticks ×10 | 359 | 230 | 489 | 389 | 549 | 380 |
| 10000 rows: one row ticks ×1000 | 3.77 | 2.52 | 5.04 | 3.98 | 4.92 | 3.48 |

KB (1,024 bytes) allocated by one run, median, Hermes:

| Hermes | `useValue($box)` before | after | `useValue($computed)` before | after | `useValues([$a, $b])` before | after |
| --- | --- | --- | --- | --- | --- | --- |
| mount and unmount 1000 rows | 1,310 | 1,193 | 1,608 | 1,709 | 1,818 | 1,904 |
| mount and unmount 10000 rows | 13,052 | 11,880 | 16,022 | 17,038 | 18,130 | 18,990 |
| 1000 rows: every row ticks ×100 | 23,859 | 12,804 | 23,859 | 34,679 | 94,195 | 72,179 |
| 10000 rows: every row ticks ×10 | 28,443 | 16,334 | 28,443 | 38,209 | 98,991 | 75,709 |
| 10000 rows: one row ticks ×1000 | 324 | 214 | 325 | 434 | 1,028 | 809 |

Bun 1.4.2, same run, ms minimum:

| Bun | `useValue($box)` before | after | `useValue($computed)` before | after | `useValues([$a, $b])` before | after |
| --- | --- | --- | --- | --- | --- | --- |
| mount and unmount 10000 rows | 2.21 | 2.30 | 3.63 | 4.04 | 3.52 | 3.79 |
| 1000 rows: every row ticks ×100 | 19.7 | 13.4 | 25.4 | 24.8 | 30.5 | 23.0 |
| 10000 rows: every row ticks ×10 | 42.3 | 24.6 | 53.0 | 49.4 | 48.6 | 38.6 |

- **A render costs Hermes a third less for `useValue($box)`**: 0.62 to
  0.67× the old hook on ticks, about 1.2 µs less per render, and half the
  garbage (244 to 131 bytes per row tick, the write included). Mount is the
  same.
- **`useValues` is 0.67 to 0.71× on ticks** and allocates 21 to 23% less.
- **`useValue($computed)` is 0.79 to 0.80× on ticks but allocates 1.34 to
  1.45×**
  (244 to 355 bytes per row tick). The old hook allocated the same for a
  computed value as for a box, so the recompute allocates nothing. The new
  hook allocates 224 bytes more per row tick for a computed value than for a
  box: two snapshot reads per change, each a Computed `peek`, which is
  `realm.untracked(() => this.derived.get())`, a closure per call. About
  110 bytes per `peek`, inferred from the difference, not probed.
- **`useValues` allocates the most**: 739 bytes per row tick. Each snapshot
  read maps a new array, with its callbacks, before it compares; the second
  read of a change throws its array away.
- **Mount is 13 to 15% slower on Hermes for a computed value and
  `useValues`**, with 5 to 6% more garbage. Mount reads the snapshot twice,
  and for these two forms each read is a `peek` with its closure or a new
  array.
- **Bun hid the computed value's cost**: 0.93 to 0.98× on Bun, 0.8× on
  Hermes, and Bun does not count allocation.
- **Not measured:** React itself on Hermes. React's development build reads
  the snapshot more often, so allocation per snapshot read counts for more
  there.

### A snapshot read that finds nothing changed allocates nothing (2026-11-05)

This closes the two open decisions from the last entry, at the owner's word.

- **A Computed `peek` makes no closure.** The core's derived node has a
  `peek`, as a cell has: it clears the tracker, reads, and puts it back, with
  `untracked` written out. The realm's `peekDerived` keeps the untracked
  depth that `realm.untracked` kept, so a hook or cleanup that runs inside a
  `peek` may read as before.
- **`useValues` reads every value and compares as it goes.** A new array
  starts at the first value that differs (`Object.is`), so a read where
  nothing changed allocates nothing. Its tracking read and `follows` are
  indexed loops: no `for…of` iterator, no `every` callback. `follows` runs on
  every render, and the model does not measure it, since its render passes
  the same array.

`bench:hermes-hooks` on main and on this change, run back to back,
the model's after subject updated to match. `useValue($box)` did not change,
so it is the control: its times moved by 3% or less. ms minimum of 9 runs,
Hermes V1 260318099.0.5:

| Hermes | `useValue($box)` main | this | `useValue($computed)` main | this | `useValues([$a, $b])` main | this |
| --- | --- | --- | --- | --- | --- | --- |
| mount and unmount 1000 rows | 2.21 | 2.17 | 5.12 | 5.02 | 3.49 | 3.32 |
| mount and unmount 10000 rows | 28.1 | 28.1 | 64.7 | 60.4 | 45.9 | 43.3 |
| 1000 rows: every row ticks ×100 | 208 | 204 | 366 | 336 | 336 | 275 |
| 10000 rows: every row ticks ×10 | 246 | 253 | 424 | 394 | 415 | 380 |
| 10000 rows: one row ticks ×1000 | 2.71 | 2.56 | 3.97 | 3.96 | 3.61 | 3.31 |

KB (1,024 bytes) allocated by one run, median, Hermes. The same in both runs
for the box:

| Hermes | `useValue($box)` | `useValue($computed)` main | this | `useValues([$a, $b])` main | this |
| --- | --- | --- | --- | --- | --- |
| mount and unmount 1000 rows | 1,193 | 1,709 | 1,491 | 1,904 | 1,521 |
| mount and unmount 10000 rows | 11,880 | 17,038 | 14,850 | 18,990 | 15,162 |
| 1000 rows: every row ticks ×100 | 12,804 | 34,679 | 12,804 | 72,179 | 26,086 |
| 10000 rows: every row ticks ×10 | 16,334 | 38,209 | 16,334 | 75,709 | 29,615 |
| 10000 rows: one row ticks ×1000 | 214 | 434 | 215 | 809 | 348 |

- **`useValue($computed)` allocates what `useValue($box)` does on ticks**:
  131 bytes per row tick, down from 355, and 0.92 to 0.93× the time. Against
  the hook before ruling 39 it is now 0.75 to 0.78× the time and 0.54 to 0.57×
  the garbage on ticks, where it was 1.34 to 1.45× the garbage.
- **`useValues` allocates 64% less on ticks**: 267 bytes per row tick, down
  from 739, at 0.82 to 0.92× the time. What is left over the box, 136 bytes,
  is the one new array a change needs. Against the hook before ruling 39 it
  is 0.57 to 0.65× the time.
- **Mount garbage falls under the old hook's** for both: 13% less than main
  for a computed value, 20% less for `useValues`. Mount time is 0.93 to 0.98×
  main. A computed value still mounts about 8% slower than the old hook did,
  in this run; `useValues` mounts in about the same time.
- **The one-row tick did not move for a computed value** (3.97 to 3.96 ms):
  a thousand single writes, where the write and the flush cost more than the
  two reads.
- **Bun shows nothing either way**: the box control moved by up to 14%
  between the runs, more than any change here, and Bun does not count
  allocation.

### Edges reused in place (2026-11-07)

The graph is rewritten (`docs/design.md`, "The graph"): one edge
per source and observer, kept in two linked lists, reused in place when a
run reads what the last one read; one object shape per kind of node; a
check walks down to the first changed source without recursion. Its tests
match main's behavior, including on four points the first draft missed:

- a source read again after a nested run read it is not linked twice;
- a failed watch or reaction keeps its old sources and adds what it read;
- a pending render that fails leaves the last one in place;
- a computed value between a cycle's origin and the read that closed it
  keeps no edge back to the origin.

The first point is on the read path. Checked there, it cost 4 to 7% on
fan-out, diamond, and conditional reads; the check that remains is one
comparison, and the rest runs in a method `hermesc` does not inline.

`bench:hermes-graph` on main and on this change, alternating,
two runs of each. ms minimum of 18 runs, Hermes V1 260318099.0.5:

| Hermes | main | this | this ÷ main | KB main | KB this |
| --- | --- | --- | --- | --- | --- |
| deep chain 1000, write ×100 | 78.3 | 76.9 | 0.98× | 28 | 44 |
| fan-out 1000 watched, write ×100 | 161 | 172 | 1.07× | 60 | 61 |
| diamond 1000 into a sum, write ×100 | 120 | 112 | 0.94× | 92 | 28 |
| conditional reads 1000, flip ×100 | 483 | 423 | 0.88× | 21,959 | 11,020 |
| make and dispose 1000 watched computeds ×10 | 41.0 | 29.6 | 0.72× | 13,378 | 12,903 |
| write 1000 sources in one update ×100 | 142 | 155 | 1.09× | 3,389 | 3,389 |
| bursty fan-out: 1000 watched, 100 writes per update ×100 | 521 | 484 | 0.93× | 371 | 370 |
| increment ×100k, each value checked | 289 | 295 | 1.02× | 25,004 | 25,003 |
| one write among 10k watched rows ×1000 | 3.33 | 3.25 | 0.98× | 410 | 410 |

- **Conditional reads allocate half** and run 12% faster: a rerun that
  reads what it read makes no edge.
- **Make and dispose is 28% faster**, 2.4× alien-signals where it was 3.2×.
- **Fan-out and a write of 1000 sources are 7 to 9% slower.** Both mark many
  observers from one write or many writes; the cost is in marking, not in
  reads. Not yet diagnosed.
- **Memory is in the same range**: a deep chain allocates 16 KB more per
  run, a diamond 64 KB less. Bytes held per node, measured with a heap
  pass, are within 10% of main and lower for chains and diamonds.

### A watch over cells only, checked without the walk: rejected (2026-11-07)

Tried on main on 2026-11-07: before entering the walk, a watch or reaction whose
sources are all cells compares their versions in place and returns the first
that changed, with the walk's stamps when none did. A root that reads anything
else, or a derived root, takes the walk as before. The core's tests passed.

The graph core alone (`Graph` cells, no realm), the match for alien-signals,
on the scenarios of `bench/graph-model.ts` driven by a scratch harness. ms
minimum over 7 alternating runs, Hermes V1 260318099.0.5:

| Hermes, core | main | fast path | fast path ÷ main |
| --- | --- | --- | --- |
| deep chain 1000, write ×100 | 69.4 | 70.6 | 1.02× |
| fan-out 1000 watched, write ×100 | 153.5 | 158.2 | 1.03× |
| diamond 1000 into a sum, write ×100 | 96.3 | 97.6 | 1.01× |
| conditional reads 1000, flip ×100 | 374.7 | 386.8 | 1.03× |
| make and dispose 1000 watched computeds ×10 | 26.2 | 26.5 | 1.01× |
| write 1000 sources in one update ×100 | 90.7 | 82.8 | 0.91× |
| bursty fan-out: 1000 watched, 100 writes per update ×100 | 453.5 | 473.4 | 1.04× |
| increment ×100k, each value checked | 203.2 | 209.3 | 1.03× |
| one write among 10k watched rows ×1000 | 2.3 | 2.4 | 1.04× |

An earlier run of 5 rounds gave the same signs: write 1000 sources 0.91×,
the rest 1.01 to 1.04×. Allocation was the same in every row.

- **It diagnoses the write of 1000 sources** ("Edges reused in place"): most
  of what that scenario lost is entering the walk once per watch. On
  that section's main the same scenario is 77.3 ms.
- **It costs every watch that reads a computed value**, which scans its first
  edge and then walks anyway; fan-out goes from 1.59× to 1.68× alien-signals,
  over the core's 1.6× budget. A write of 1000 sources is already 1.16×.
- **Rejected:** the budget takes a change that costs nothing, and this one
  costs the common shape to speed up a rare one. Knowing a watch reads only
  cells when it links them, not on each check, would avoid the scan; that
  changes linking, and waits for the next version.

### A React Native app against MobX (2026-11-07)

`apps/rn-bench` is a Release React Native app (Expo 55, React Native 0.83,
Hermes) with a LegendList of instruments and a details screen, built three
ways over the same wire JSON: MobX with serializr, Pinna read through
`useSelect`, and Pinna read through cells. A row carries 17 `Big` values,
14 dates, 12 points, 8 boxes and 8 computed values. Every write starts from
wire text; `JSON.parse` is timed apart, so "store" is decode plus the write,
and "settle" runs until three frames pass with no render. `bun run ios`
builds it, and `bun run bench` drives it on the booted simulator, one app
launch per job.

One round, 10,000 rows, iPhone 16 Pro simulator, before the changes below.
ms, store / settle:

| Scenario | MobX | Pinna, `useSelect` | Pinna, cells |
| --- | --- | --- | --- |
| load | 8,124 / 8,317 | 6,473 / 6,650 | 6,684 / 6,867 |
| merge a refetch | 7,994 / 8,200 | 8,204 / 8,367 | 8,277 / 8,417 |
| deep merge | 8,770 / 8,907 | 8,737 / 8,854 | 9,034 / 9,141 |
| replace all | 10,460 / 10,683 | 7,855 / 8,050 | 8,294 / 8,483 |
| insert 100 | 113 / 183 | 148 / 200 | 137 / 183 |
| remove 100 | 17 / 44 | 61 / 76 | 59 / 78 |
| 60 ticks of 50 updates | 161 / 1,083 | 251 / 1,017 | 253 / 1,017 |
| details open | 0.1 / 83 | 0.1 / 33 | 0.1 / 33 |

After load, MobX holds 581 MB resident and 397 MB of Hermes heap; Pinna 327
and 99.

- **Decode is most of load and merge** on both sides. Pinna wins load and
  replace by 20 to 25% and ties merge; it loses ticks and removals in the
  store, though it settles ticks 6% sooner.
- **Pinna holds a quarter of MobX's heap** and 56% of its resident memory.

A full device run, five rounds of two sizes, takes about 45 minutes, so the
changes since were measured on the store code alone, on the Hermes command
line
(`packages/pinna/bench/hermes-toolchain.ts`, Hermes V1 260318099.0.5,
10,000 rows, ms; one run each, "—" where none ran):

| Hermes, store only | before | step 1 | step 2 | step 3 |
| --- | --- | --- | --- | --- |
| `realm.decode`, µs per row | — | 221 | 202 | 162 |
| load | — | 2,284 | 2,067 | 1,630 |
| merge a refetch, whole | — | 2,781 | 2,621 | 2,087 |
| merge, writing decoded rows | 1,052 | 385 | — | 394 |
| remove 100, one at a time | 67 | 15 | — | — |
| 60 ticks, no observers (MobX 41 to 45) | 70 | 46 | 49 | 53 |

- **Step 1**: schema equality is built once per schema and compares dates
  by time; a collection returns the same row for a key and edits its order
  with native array calls; a box a decode built does not check its value
  again.
- **Step 2**: a `SchemaModel` decode parses and checks each field once;
  `Schema.encodeKeys` ran every check twice.
- **Step 3**: a class builds its boxes after one realm lookup per row,
  not one effectful transformation per box, about 5 µs each.
- **What is left is Effect's decode.** The same class with no boxes takes
  155 µs per row, a plain `Struct` of the same fields 141, and a
  hand-written decode to plain objects 71. A synchronous decode
  (`design.md`, "Leads") is the next step there.
- **The tick moved between runs** with no change to it, 46 to 53 ms against
  MobX's 41 to 45; it is within noise of where step 1 left it.

The device again, one round, 10,000 rows, with the store code of
step 3. ms, store / settle; "—" where the store has no such operation:

| Scenario | MobX | Pinna, `useSelect` | Pinna, cells |
| --- | --- | --- | --- |
| load | 8,192 / 8,400 | 4,630 / 4,800 | 4,722 / 4,916 |
| merge a refetch | 8,227 / 8,417 | 5,498 / 5,667 | 5,694 / 5,866 |
| deep merge | 8,682 / 8,817 | 5,693 / 5,804 | 5,930 / 6,041 |
| reconcile per row | — | 6,203 / 6,367 | 6,691 / 6,899 |
| deep reconcile per row | — | 6,815 / 6,950 | 7,117 / 7,267 |
| replace all | 11,359 / 11,700 | 5,781 / 5,967 | 6,601 / 6,866 |
| insert 100 | 114 / 200 | 109 / 166 | 133 / 216 |
| remove 100 | 20 / 53 | 60 / 75 | 57 / 75 |
| 60 ticks of 50 updates | 153 / 1,066 | 216 / 1,016 | 221 / 1,017 |
| details open | 0.1 / 83 | 0.1 / 33 | 0.1 / 34 |

After load, MobX holds 568 MB resident and 397 MB of Hermes heap; Pinna,
`useSelect`, 334 and 98; Pinna, cells, 271 and 100.

- **The command line's gains held on the device.** Against the round before the changes, Pinna's
  load is 28% faster and merge 33%. It now beats MobX by 43% on load, 33% on
  merge, 34% on deep merge, and 49% on replace, and ties insert.
- **Removals did not move**: 60 ms against MobX's 20. The 67 to 15 above
  was `remove each`; the app's `remove` filters the rows into `replaceAll`.
  Both cost the same on the command line with no observers, with the
  keys', and with 20 rows' (16 to 24 ms); the simulator runs about
  2.8× the command line, as load does.
- **The tick is still slower in the store**, 216 ms against 153, but its
  longest frame is 17 ms against MobX's 60, and it settles 5% sooner.
- One round is one sample: the bulk gains are far outside the noise seen
  between runs, the insert and tick rows are not.

### Writing the value a box holds returns at once (2026-11-09)

`replaceAll` writes every kept row back to its cell. Each write ran the
row's schema check and journaled the box, though the row was the one the
cell held, checked when it landed. A write of the value a box holds now
returns before the check: it changes nothing, so it notifies nobody and has
nothing to undo. `replaceAll` also builds its key set once, not twice.

Hermes command line, the app's store, 10,000 rows, ms, one run each:

| Store operation | Before | After |
| --- | --- | --- |
| remove 100 (`replaceAll` of 9,900 kept rows) | 21 | 9.5 |
| `replaceAll` of the same 10,000 rows | 18 | 8.7 |
| remove 100, one at a time | 15 | 15 |

- **Insert** writes its kept rows the same way, so it gains too.
- **Remove each** copies the 10,000 keys once per removal, 100 copies;
  that is plan item 5's copy, not the write.

One device round with this change against the step 3 run above, iPhone 16 Pro
simulator, 10,000 rows, store ms, settle ms in parentheses:

| Scenario | MobX | Pinna select, before | after | Pinna cells, before | after |
| --- | ---: | ---: | ---: | ---: | ---: |
| remove | 19.5 (48.9) | 60.4 (75.1) | 22.9 (37.5) | 56.7 (74.7) | 32.3 (47.7) |
| insert | 110.5 (183.7) | 108.9 (165.8) | 78.5 (149.6) | 133.3 (216.1) | 69.9 (133.1) |
| remove each | — | 61.2 (75.7) | 61.1 (72.0) | 63.2 (81.6) | 64.9 (76.7) |
| replace | 10,418.7 (10,651.9) | 5,780.6 (5,966.6) | 5,229.3 (5,417.8) | 6,600.9 (6,865.9) | 5,107.9 (5,301.4) |

- **Removal** went from 3× MobX's store time to 1.2× with selectors, and
  now settles sooner than MobX: 37.5 ms against 48.9.
- **Insert** now beats MobX by 29% with selectors and 37% with cells.
- **Remove each** did not move, as the command line said.
- One round of each is a single sample; load, which this change does not
  touch, moved 7% between the runs, so a gap under about 10% is noise.

### Fewer calls on a write, a read, and a watch's make and dispose (2026-11-09)

`hermesc -O` inlines only a function with one caller; every helper with two
is a real call, about 40 to 60 ns each in the interpreter. The bytecode
showed which calls make and dispose and increment paid, and these went:

- **A box write inside an update**: a four-slot journal entry,
  a first-write path, and one `try` per update.
- **The core**: `watch` and `disposeWatch` ask `checkObserving`
  only inside a run, and check for due work before calling the settle;
  `subscribe` and `unsubscribe` handle the source without the stack;
  `reconcile` takes whether the node is observed from its caller; a walk's
  entry and exit are written out where they happen.
- **The public layer**: a read inside a run checks `canRead`
  without a call; `realm.watch` without options and an unnamed computed
  value skip the name check, and the second shares one options object.

`bench:hermes-graph`, two runs of 9, ms minimum of each (pinna ÷
alien-signals):

| | Before (2026-11-07) | Run 1 | Run 2 |
| --- | --- | --- | --- |
| make and dispose | 29.6 (2.36×) | 25.9 (1.96×) | 26.2 (2.02×) |
| increment ×100k | 295 (2.07×) | 256 (1.75×) | 254 (1.75×) |
| write 1000 sources in one update | 155 (1.98×) | 125 (1.57×) | 126 (1.59×) |
| diamond | 112 (1.97×) | 98.8 (1.68×) | 99.3 (1.71×) |

- **Every scenario is now within the 2× budget**, make and dispose on the
  line. The core alone, by the probe, is about 1.9× alien-signals on make
  and dispose, over its 1.6×.
- **What make and dispose still pays**, per 10,000 watches in the probe's
  core: allocating the node and its closure costs about what alien-signals'
  whole effect does; linking a watch to a computed value about 6.4 ms, as a
  pass after the run; the first compute about 4.3 ms; dispose about 3.4 ms
  against alien-signals' 1. A smaller node for a watch, or linking during
  the run, is a structural change and waits for the next version. Since
  2026-11-16 a first run links its edges at its end, with no pass after it,
  and a smaller watch node was measured and dropped ("A first run links its
  own edges").
- **Tried and dropped:** inlining `unlinkAll` into `disposeWatch`, and a
  bound dispose function; neither moved.

### Black-box scenarios on Hermes (2026-11-11)

`bench:hermes-blackbox <destroot>` runs app-shaped scenarios through the
public API only, each in its own Hermes process, compiled as a release
build compiles them; `bench:blackbox` runs the same on Bun. The scenarios are
a trading app's state: markets with
live prices, positions, balances, chart series in a box and as a
collection, refetch, pagination, scrolling, market switching, forms, memo
lookups, a realm per screen, and errors. The js-reactivity-benchmark graph
shapes run on Pinna, on MobX, and on Legend State ("Legend State as a
third library"). A scenario reports each step's median, p99,
and the median of each quarter; bytes allocated per step; bytes live after a
full collection at five checkpoints, the growth per 1,000 steps after the
first quarter, and what stays live after dispose. Every scenario checks its
result at the end.

**No leak.** Live bytes stay flat after warm-up in every scenario, and
nothing outlives dispose beyond the harness's own 15 to 30 KB:

- a collection's remove and upsert, with readers or without: 0 B per churn;
- chart candles as a collection: warm-up to 479 KB by about 6,000 steps,
  then flat;
- market switching: flat at 547 KB over 12,000 steps;
- positions at a fixed count: flat over 30,000 steps;
- a realm made and dropped per screen, memo lookups with fresh arguments,
  missing rows, forms, rejected writes, undone updates, and throwing effects:
  flat.

**What looked like a leak was Effect parking a microtask.** A refetch of 300
markets seemed to keep 1.1 KB per refetch, 2.28 MB at the end. A decode of
300 class rows runs past Effect's op budget (`MaxOpsBeforeYield`, 2,048), so
the fiber yields: `runSyncExit` flushes the work at once, but the microtask
it queued stays on the queue, holding about 1.1 KB, until the queue drains.
In an app the queue drains after every message, so nothing accumulates; the
harness now lets microtasks run between steps, outside the clock, as an
event loop does. A decode of 30 rows, or of a plain Effect struct, stays
under the budget and queues nothing. Running with
`Scheduler.PreventSchedulerYield` set through `Effect.runSyncExitWith`
queues nothing (752 B to 0 per run of a 3,000-op program); the same reference
given through `provideContext` changes nothing, because the fiber reads it
once, when it starts.

**Trimming the front of a large array box rechecks every element.** A chart
series as a box of 5,000 candles, one write per candle, on Hermes:

| Write | Per write |
| --- | --: |
| `set`, append | 0.16 ms |
| `set`, drop the first and append, `Array(Candle)` | 11.0 ms |
| `set`, drop the first and append, `Unknown` | 0.06 ms |
| `modify`, append | 0.17 ms |
| `modify`, `shift` and push, `Array(Candle)` | 22.2 ms |
| `modify`, `shift` and push, `Unknown` | 11.7 ms |
| `Schema.is` over 5,000 candles, for reference | 10.7 ms |

The check skips an element only when it is the same object at the same
index as before, so a shift by one checks all 5,000 again. In a `modify`
the draft's `shift` adds 5,000 proxy writes on top. Appending is cheap
either way. A collection keyed by time, or an append-only box, avoids it
today.

**An add or remove in a collection copies its order.** Per call, on Hermes:

| Rows | Add | Replace | Remove |
| --- | --: | --: | --: |
| 1,000 | 15 µs | 1.8 µs | 17 µs |
| 10,000 | 123 µs | 2.1 µs | 131 µs |
| 50,000 | 812 µs | 2.2 µs | 918 µs |

Linear, as plan item 5 says; at a few hundred rows it does not show.

**Pages added by `upsert` copy the order once per row.** Appending pages of
50 rows, 200 pages, on Hermes: a page costs 2.0 ms at the start and 6.4 ms
at 10,000 rows with `upsert` row by row or with one `replaceAll`, but
`upsert` allocates 6.5 MB a page against `replaceAll`'s 0.98 MB, because
each of the 50 calls copies the order again inside the same update.

**A refetch decodes everything it is given.** Refetching 300 markets on
Hermes: replacing the collection 8.9 ms a refetch and 2.9 MB allocated,
reconciling 6.8 ms and 2.7 MB, patching only the changed fields 0.6 ms and
52 KB. The decode is most of the cost, about 9 KB per row; collections
during the 300 refetches took 208 ms when replacing and 102 ms when
reconciling.

**A view over every row is linear, and faster than MobX.** A range over
5,000 rows with two sources each: a membership change recomputes in 3.2 ms
against MobX's 7.4, a change to the last row in 2.2 ms against 7.4, and
each row holds about 1,500 bytes against MobX's 1,560. The p99 of the
candle collection is this cost.

**First computes and reentrant cached refreshes have bounded stack depth.** A chain of
computed values no one has read, read first from the top, used to fail
with `RangeError: Maximum call stack size exceeded` between 1,100 and
1,200 links on the Hermes command line and near 980 on Node 26, since
each compute reads the next through user code. Past 256 nested stale
reads the read now waits and the value it stopped at refreshes from a
shallow stack (`docs/design.md`, "The graph"): a million links compute
on Node. A chain within the limit computes each value once; a chain of
1,000 runs 1,768 computes, and longer chains approach twice their length.
A chain read as it is built, and a later write refreshed by an ordinary
freshness walk, needs no recursion or wait. A cached compute that reads a
changed shared source before the next level reenters through user code,
so it uses the same bound. Suspended cached values retain their value and
version for equality cutoff, but must finish their compute on retry:
the interrupted run already updated read versions. With unchanged results,
the 600-level shared-source case starts 1,112 computes and the 2,000-level
case starts 3,792, while running no watch selectors or effects again.
A compute reading separate deep branches can restart for each branch;
the bound of fewer than twice the length describes a single chain.

**The graph shapes: Pinna is 2.0 to 3.3 times faster than MobX on Hermes,
and allocates 3 to 1,600 times less.** A step is 100 writes, each its own
update, except cellx (one batch of four) and molBench (two batches):

| Shape | Pinna ms | MobX ms | MobX ÷ Pinna | Pinna B/step | MobX B/step |
| --- | --: | --: | --: | --: | --: |
| kairo deep, chain of 50 | 3.66 | 11.02 | 3.0× | 22,833 | 1,697,234 |
| kairo broad, 50 watched branches | 11.51 | 38.27 | 3.3× | 22,837 | 6,190,841 |
| kairo diamond, width 5 | 0.73 | 1.89 | 2.6× | 30,832 | 305,234 |
| kairo triangle, width 10 | 1.19 | 3.21 | 2.7× | 30,832 | 479,634 |
| kairo mux, 100 into one | 17.13 | 40.89 | 2.4× | 123,657 | 3,645,241 |
| kairo repeated observers, 30 reads | 0.50 | 1.15 | 2.3× | 22,832 | 129,234 |
| kairo unstable | 0.82 | 1.99 | 2.4× | 34,032 | 193,234 |
| kairo avoidable | 0.38 | 0.78 | 2.0× | 22,832 | 118,034 |
| cellx, 1,000 layers | 3.39 | 9.75 | 2.9× | 803 | 1,283,433 |
| molBench | 0.022 | 0.054 | 2.5× | 2,544 | 8,109 |

The medians of each quarter of every run stay level, so no step grows
slower as a session goes on; the two that rise are pagination, where the
list grows by design, and a positions stream whose count drifts. MobX's
allocation shows as collections: 829 in the deep chain against Pinna's 8.

### A shifted array box checks only the new elements (2026-11-11)

The array check now finds how far a write moved the array against the value
before it, from the first element of each, and skips every element identical
to the one that many places away. Dropping the oldest candle to append one
checks one candle; adding to the front works the same way. A splice in the
middle still checks everything after it. `realm.decode` now runs with
`Scheduler.PreventSchedulerYield` through `Effect.runSyncExitWith`.

`bench:hermes-blackbox`, the candle and refetch scenarios, before and after,
same machine and session. A candle step opens a new candle, dropping the
oldest, once in ten, so the p99 is the trimming write:

| Scenario | p99 before | p99 after | B/step before | B/step after |
| --- | --: | --: | --: | --: |
| candles in a box: 500, set | 1.244 ms | 0.131 ms | 27,570 | 13,198 |
| candles in a box: 5000, set | 15.359 ms | 1.027 ms | 265,171 | 121,200 |
| candles in a box: 500, modify | 2.646 ms | 1.382 ms | 59,530 | 45,159 |
| candles in a box: 5000, modify | 24.709 ms | 13.742 ms | 574,307 | 431,573 |

Garbage collections in the 5,000 `set` run fell from 67 (7.3 ms) to 28
(1.6 ms). The `modify` p99 halves rather than matching `set`: what is left is
the draft's own `shift`, about 5,000 proxy writes, which the check no longer
adds to. A `set` with a new array, or a collection keyed by time, avoids it.

The decode change saves about 5 KB a refetch of 300 markets (2,853,284 to
2,848,351 bytes replacing, 2,692,931 to 2,687,955 reconciling). The medians
moved by less than the run-to-run spread (9.62 to 9.51 ms replacing, 7.78 to
7.50 ms reconciling); the decode itself is still most of a refetch.

### A draft's shift, unshift, and splice draft nothing they move (2026-11-11)

The native `shift`, `unshift`, and `splice` on a draft array read every
element after the change through the proxy, and each read made a draft: a
`shift` of 5,000 candles made 5,000 drafts. A draft array now runs these
three on its copy and moves the keys the recipe touched with the elements;
an element at an untouched key is drafted when it is read, wherever it sits.
A removed element comes back as a read would give it. `sort`, `reverse`,
`fill`, `copyWithin`, and iterating still draft every element they read.
This supersedes the advice, in the two entries above, to use `set` or a
collection keyed by time to avoid the draft's `shift`.

One write per step to a box of 5,000 `Candle`s (`Schema.Array(Candle)`) on
Hermes, median of 200:

| Write | Before | After | KB/write before | KB/write after |
| --- | --: | --: | --: | --: |
| `modify`: `shift`, then `push` | 13.2 ms | 0.27 ms | 3,930 | 43.6 |
| `modify`: `splice(0, 1)`, then `push` | 13.85 ms | 0.19 ms | 3,900 | 43.9 |
| `modify`: `pop`, then `unshift` | 12.8 ms | 0.28 ms | — | 44.6 |
| `set`: drop the first and append | 0.23 ms | 0.24 ms | 172 | 172 |

`bench:hermes-blackbox`, the candle scenarios, main and this change run back
to back twice in one session:

| Scenario | p99 before | p99 after | B/step before | B/step after | GCs before | GCs after |
| --- | --: | --: | --: | --: | --: | --: |
| candles in a box: 500, modify | 2.602 / 1.472 ms | 0.195 / 0.221 ms | 45,159 | 7,265 | 38 | 4 |
| candles in a box: 5000, modify | 14.223 / 14.341 ms | 7.820 / 8.741 ms | 431,573 | 43,282 | 88 | 4 |

The 500-candle `modify` p99 now matches `set` (0.155 to 0.177 ms in the same
runs). The 5,000-candle `modify` p99 stays above `set`'s (1.25 to 1.85 ms in
the same runs), unexplained: a probe of the same steps with the same
watchers put the trimming write at a median 0.65 ms against 0.52 ms for
`set`, and the closing write at 0.99 ms against 0.94 ms. Its maximums,
`set` included, ranged up to 68 ms that session, so the tail of 500 steps is
read here as noise until a quieter run shows otherwise.

### Legend State as a third library (2026-11-11)

`bench:graph`, `bench:hermes-graph`, `bench:blackbox`, and
`bench:hermes-blackbox` now run Legend State (`@legendapp/state`
3.0.0-beta.48, the 3.x line its docs teach) through the same `Library`
wrapper as the others: a source is `observable(value)`, a computed value
`observable(fn)`, a watch `observe`, and an update `batch`. `computed` and
`observablePrimitive` measure the same as `observable(fn)` on Bun.

`bench:hermes-graph`, minimum ms of 9 runs (KB allocated by one run). Pinna, alien-signals, and MobX are within 7% of
"Where 1.0 stands", but for one write among 10k rows, where Pinna and
alien-signals read about 20% slower:

| | Pinna | alien-signals | MobX | Legend | Legend ÷ Pinna | Legend ÷ MobX |
| --- | --: | --: | --: | --: | --: | --: |
| deep chain | 72.8 (44) | 44.4 (7,845) | 229 (31,353) | stack overflow | — | — |
| fan-out | 157 (61) | 101 (7,845) | 564 (88,380) | 1,670 (642,827) | 10.6× | 3.0× |
| diamond | 99.5 (28) | 60.0 (7,852) | 249 (32,979) | 1,521 (652,398) | 15.3× | 6.1× |
| conditional reads | 391 (11,021) | 260 (42,089) | 1,304 (178,300) | 3,787 (1,462,489) | 9.7× | 2.9× |
| make and dispose | 26.3 (12,122) | 13.5 (10,714) | 85.8 (32,054) | 300 (156,055) | 11.4× | 3.5× |
| write 1000 sources in one update | 127 (3,325) | 82.2 (17,983) | 335 (64,935) | 708 (389,153) | 5.6× | 2.1× |
| bursty fan-out | 470 (371) | 510 (8,850) | 559 (88,380) | 4,555 (1,753,875) | 9.7× | 8.1× |
| increment ×100k | 256 (25,004) | 146 (36,722) | 661 (128,911) | 2,123 (1,145,928) | 8.3× | 3.2× |
| one write among 10k watched rows | 3.65 (409) | 2.14 (449) | 7.14 (1,372) | 25.9 (11,988) | 7.1× | 3.6× |

`bench:graph` on Bun 1.4.2, minimum ms of 9 runs:

| | Pinna | alien-signals | MobX | Legend |
| --- | --: | --: | --: | --: |
| deep chain | 3.90 | 2.88 | 16.4 | 256 |
| fan-out | 7.84 | 6.64 | 29.7 | 262 |
| diamond | 5.52 | 5.03 | 15.7 | 216 |
| conditional reads | 19.0 | 15.9 | 68.3 | 611 |
| make and dispose | 2.17 | 1.08 | 11.9 | 45.7 |
| write 1000 sources in one update | 6.48 | 4.48 | 18.5 | 105 |
| bursty fan-out | 61.5 | 64.0 | 29.5 | 735 |
| increment ×100k | 12.8 | 8.36 | 44.1 | 343 |
| one write among 10k watched rows | 1.01 | 0.89 | 1.86 | 5.73 |

The js-reactivity-benchmark shapes on Hermes, median ms per step:

| Shape | Pinna | MobX | Legend | Legend ÷ Pinna | Legend B/step | Legend GCs (ms) |
| --- | --: | --: | --: | --: | --: | --: |
| kairo deep, chain of 50 | 3.81 | 11.47 | 68.51 | 18.0× | 34,251,107 | 19,757 (9,121) |
| kairo broad, 50 watched branches | 11.82 | 39.51 | 135.64 | 11.5× | 61,284,442 | 7,947 (3,807) |
| kairo diamond, width 5 | 0.75 | 1.96 | 9.34 | 12.4× | 4,479,641 | 2,314 (970) |
| kairo triangle, width 10 | 1.22 | 3.34 | 19.14 | 15.7× | 9,146,262 | 4,802 (1,440) |
| kairo mux, 100 into one | 17.71 | 42.54 | 120.84 | 6.8× | 45,215,326 | 5,731 (2,011) |
| kairo repeated observers, 30 reads | 0.51 | 1.20 | 3.79 | 7.4× | 1,959,462 | 989 (277) |
| kairo unstable | 0.85 | 2.11 | 8.81 | 10.4× | 3,484,265 | 1,759 (631) |
| kairo avoidable | 0.41 | 0.85 | 2.95 | 7.3× | 1,436,884 | 742 (422) |
| cellx, 1,000 layers | 3.64 | 11.67 | — | — | — | — |
| molBench | 0.022 | 0.056 | 0.235 | 10.7× | 88,151 | 112 (42) |

On Bun the shapes keep the order: Legend is 17 to 58 times Pinna's median,
cellx at 1,000 layers included (12.2 ms against 0.26).

- **Legend's chain-depth limit on Hermes is lower than Pinna's.** A chain of
  computed values fits 750 links on the Hermes command line and overflows by
  757; Pinna's was between 1,100 and 1,200 and is now unlimited. So the
  graph's deep chain of 1,000 reports a stack overflow for Legend, and cellx
  at 1,000 layers runs on Hermes without it.
- **An overflow breaks Legend's tracking for the rest of the process.**
  Legend keeps what it is tracking in module state, and the overflow leaves
  it set: a diamond measured after it in the same process saw 0. The graph
  benches now run the scenarios after an overflow in a fresh process.
- **Legend's batch starts a timer.** `beginBatch` calls
  `setTimeout(…, 0)` and `endBatch` clears it, on every update. The Hermes
  command line has no `setTimeout`, so Legend's processes get a stand-in
  that keeps a map and never fires; a React Native app pays a native call
  here that these numbers leave out.
- **Legend computes the avoidable shape's third link twice when the watch
  first reads it**, the others once, and no write recomputes it on any of
  the three. The shape now checks that no write recomputes it.

Every other bench, re-run on `main` the same day, is level with the entries
above, but for `bench:data`, which failed its schema ceilings
(`schemaCeilings` in `bench/data-model.ts`). The schema path is where it was
(decode about 23 ms); the bare path got faster, decode from 4.1 ms to 1.2 to
1.95 ms. Over seven runs the schema path took 3.3 to 7.5 times bare to build
10k (ceiling 3), 7.2 to 12.4 times to decode (ceiling 8), and 2.5 to 3.8
times on toggleAll (ceiling 3). The owner re-based those three ceilings:
decode to 20 and toggleAll to 6, about twice their median ratio, and build
to 10, above the 7.3 it reaches in about half the runs.

### Two fields fewer on a node (2026-11-11)

A node kept eight booleans. Two pairs were one fact each, and each pair
became one field:

- `initialized` and `thrown` became `status`: no run kept, a value, or an
  error. Of the pair's four combinations three occurred; thrown without
  initialized never did, and now cannot be written. The equals check after
  a compute is one comparison.
- A watch's `disposed` and a reaction's `active` became `linked`: the
  node's edges are in its sources' observer lists. `observed()` is one
  branch.

`bench:hermes-graph`, minimum ms of 9 runs, main before each change against
the change: every scenario within noise, alien-signals' column moving as
much between the two runs. Make and dispose allocates 12,122 KB, then
11,966, then 11,810: 8 B per field on 20,000 nodes. A core derived node
measured 288 B before and 280 B after the first change. Alien-signals
allocates 10,714 KB there, so Pinna still allocates about 10% more.

Not built: packing the five booleans left into one number and making the
computed value the node, without its 80 B handle, would bring a make and
dispose pair to about 1,056 B against alien-signals' 1,080, about 2% under.
The second is a structural change, and the bit operations' cost on Hermes
is not measured.

### A schema's check is built once (2026-11-12)

`realm.box(schema, value)` built the schema's check (`SchemaAST.toType` and
the whole-value check) and its equivalence on every call, so every box held
its own. Both are now kept per schema in a `WeakMap`.

| | before | after |
| --- | ---: | ---: |
| Hermes, retained per observed row, 4 boxes | 7,265 B | 2,073 B |
| Hermes, retained per observed row, 6 boxes | 10,017 B | 2,681 B |
| Hermes, create 10k rows | 214 ms | 128 ms |
| `bench:data`, Effect Schema, memory 10k observed | 23.3 MB, 42 obj/row | 15.1 MB, 21 obj/row |
| `bench:data`, Effect Schema, build 10k | 14.0 ms | 8.5 ms |
| `bench:data`, Effect Schema, observe 10k rows | 4.04 ms | 2.29 ms |

A class row now costs about what a decoded one does (2,090 B).

### A source written again in one update marks once (2026-11-12)

A cell written 100 times in one update walked its whole observer tree 100
times, though after the first walk every watch it reached was already due.
The graph keeps the last source marked, `Graph.lastMarked`, and clears it
wherever `markFloor` moves: every link and every settle step. A mark of that
same source with neither in between returns at once. Only a settle step
clears a schedule and only a link adds a path, so nothing the first mark
reached can need it again; a computed value's mark only prunes later marks,
so leaving it older costs a later walk, never an observer. One slot misses
writes that alternate between two sources (A, B, A, B), which a stamp per
source would catch, at a field on every cell.

`bench:hermes-graph`, minimum ms of 9 runs, the graph before against the change:

| | before | after | after ÷ alien-signals | after ÷ MobX |
| --- | ---: | ---: | ---: | ---: |
| bursty fan-out | 475 | 163 | 0.32× | 0.28× |

Every other scenario within noise, allocation unchanged. Two encodings were
dropped on the way: keeping the floor and the walk beside the source cost
write-1000 7% (45 ns a write), the floor alone 4%; one field cleared at each
floor move is within noise. A differential fuzz of 3000 programs of 300 steps
matched the graph without the skip exactly, with 411,220 marks skipped; the
new test fails when a link does not clear the field.

Marking is 7 to 10% of an update elsewhere: Pinna marks in 0.70 to 0.90× of
alien-signals' time, and the whole gap to it is in the flush, 1.28 to 1.73×.

### The flush's bookkeeping is not the gap (2026-11-12)

A spike on where the flush's 1.3 to 1.7× of alien-signals goes, on the graph
core alone (the scenarios of `bench/graph-model.ts` plus write 1000 and
bursty fan-out, through a scratch harness). The gate, set before timing: a
change that keeps tracking, error handling and equality, and removes at
least 10% of the flush on both fan-out and a deep chain, with no scenario
over 2% slower.

**The work, counted per update (flush only), is the same units as
alien-signals 3.2.1:** a refresh per `checkDirty`, a recompute per update, a
record per link, a `finishRun` per `purgeDeps`, a watch run per effect run.
Three extras, all Pinna's:

- equality is a call, `node.equals`; alien-signals compares with `!==`;
- more edge checks: 3 per watch in fan-out against 1, 2 per level in a deep
  chain against 1. One is the walk checking again, on the way back up, the
  edge it descended through; in fan-out the other is each computed value's
  check of the head, which alien-signals skips because the head's update
  marks every reader dirty (`shallowPropagate`). Each is a field compare, no
  call;
- in a diamond each branch the sum reads takes its own walk
  (`refreshForRead`, then `refresh`): 999 walks per update, where
  alien-signals tests a flag.

The user work alone, with no graph (each watch's read and callback in a bare
loop), is 2 to 8 ms of the 68 to 151 ms totals.

Flush phase on Hermes V1 260318099.0.5, ms minimum of 8 interleaved rounds of
3 runs, ÷ the current graph. Every candidate passes the core's 86 tests and
the package's 1,277:

| | fan-out | write 1000 | bursty | diamond | deep chain |
| --- | --- | --- | --- | --- | --- |
| current graph, ms | 135 | 65.6 | 135 | 80.1 | 63.2 |
| one `try` around settle's loop | 0.99 | 1.00 | 0.99 | 1.00 | 1.01 |
| recompute's `finally` as a block | 0.99 | 1.00 | 0.99 | 1.00 | 0.98 |
| `Object.is` compared in place | 1.02 | 1.02 | 1.02 | 1.02 | 1.02 |
| `record`'s fast path in each `get` | 0.98 | 0.98 | 0.97 | 0.96 | 0.98 |
| `finishRun`'s common case in place | 0.94 | 0.96 | 0.93 | 0.95 | 0.95 |
| all five | 0.92 | 0.95 | 0.92 | 0.91 | 0.92 |
| the last two (second run) | 0.93 | 0.93 | 0.91 | 0.92 | 0.92 |
| no `try` in the flush (a bound) | 0.98 | 0.99 | 0.99 | 0.99 | 1.00 |
| the graph of 2026-11-07 | 0.92 | 0.81 | 0.93 | 1.13 | 0.98 |
| alien-signals | 0.59 | 0.79 | 0.59 | 0.61 | 0.58 |

- **No candidate passes.** Error handling costs 0 to 2% (dropping every
  `try` in the flush, which fails 102 tests); comparing `Object.is` in
  place is 2% slower than calling it. Inlining `record`'s fast path and
  `finishRun`'s common case is the one gain, 7 to 9% of the flush and 5 to
  8% of the total with nothing slower, and it misses the gate. That pair was
  picked after the first run.
- **The graph of 2026-11-07 flushes a write of 1000 sources 19% faster** and
  fan-out 8%, a diamond 13% slower. Its writes are slower, so in totals it
  is 0.90×, 0.97× and 1.11×: a trade. Not bisected.
- **What is left is structure, not bookkeeping:** the same calls each cost
  more, and the diamond walks per read. A dirty mark for every reader of a
  source found changed would replace the per-read walk and the fan-out's
  extra edge check; it changes how the flush finds work, and waits for the
  next version.

**Landed anyway: `record` and `finishRun`'s common case inline.** The 10%
gate was a guess, and the pair costs no semantics, memory or test. Through
the public layer (the black-box scenarios on Hermes, 5 interleaved rounds
against HEAD), only `record`'s hit inline made two scenarios slower:
repeated observers 1.07× and unstable sources 1.05×. A repeated read, or one
that missed the next edge, did the inline check and then all of `record`
again. Inlining the whole of `record` fixed both:

| black box, total ÷ HEAD, minimum | deep 50 | broad 50 | diamond 5 | triangle 10 | mux 100 | repeated 30 | unstable | avoidable | cellx 1000 | molBench |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `record`'s hit inline | 0.92 | 0.92 | 0.95 | 0.94 | 0.96 | 1.07 | 1.04 | 0.97 | 0.94 | 0.98 |
| the whole of `record` inline | 0.94 | 0.93 | 0.95 | 0.94 | 0.97 | 0.99 | 0.97 | 0.97 | 0.94 | 0.95 |

On the graph core alone, as landed, the flush is 0.91, 0.95, 0.91, 0.95
and 0.93 of the current graph (same columns as above), the total 0.92 to
0.97. It matches HEAD's graph over a 5,000-seed differential fuzz. Each of
15 mutants of the landed copies fails a test. In the first version,
dropping `readBy = run` in `DerivedNode.get` failed none, the fuzz
included, until a test of a derived value read twice in one run was added. The copies are the cost: `record` now lives in three
places and `finishRun`'s case in three.


### Baseline after the second round (2026-11-13)

`main` on 2026-11-13, the Hermes host in the
`hermes-ios-260318099.0.5-release` `destroot`, every bench run twice back to back; load average 6 to 24 over
the 35 minutes. Minimum of the two runs' minimums unless named. The graph
alone is in "Where 1.0 stands".

`bench:hermes`, the store against MobX, ms:

| | MobX | Pinna, bare | Pinna, Effect Schema | bare ÷ MobX | schema ÷ bare |
| --- | ---: | ---: | ---: | ---: | ---: |
| build 10k | 159 | 13.8 | 63.2 | 0.09× | 4.6× |
| decode 10k | 157 | 12.2 | 135 | 0.08× | 11× |
| memory 10k decoded | 22.4 MB | 8.2 MB | 8.2 MB | 0.37× | 1.00× |
| memory 10k observed | 41.0 MB | 18.9 MB | 18.8 MB | 0.46× | 0.99× |
| observe 10k rows | 148 | 34.4 | 33.7 | 0.23× | 0.98× |
| toggle 1 row ×1000, observed | 11,966 | 2,062 | 2,100 | 0.17× | 1.02× |
| toggleAll 10k, observed | 152 | 32.3 | 32.3 | 0.21× | 1.00× |
| rename 1 keyed row ×1000, 10k readers | 6.62 | 4.46 | 11.2 | 0.67× | 2.5× |
| add ×1000, observed | 22.8 | 144 | 404 | 6.3× | 2.8× |
| add ×1000, unobserved | 17.3 | 139 | 390 | 8.0× | 2.8× |
| add 1000 in one update, observed | 16.1 | 5.48 | 8.60 | 0.34× | 1.6× |

Adding rows one update at a time is still the one row slower than MobX
(plan item 5); in one update Pinna is a third of MobX's time.

`bench:hermes-hooks`, the hooks without React, ms (KB allocated by one run):

| | `useValue($box)` | `useValue($computed)` | `useValues([$a, $b])` |
| --- | ---: | ---: | ---: |
| mount and unmount 1000 rows | 1.79 (1,373) | 3.50 (1,592) | 2.60 (1,709) |
| mount and unmount 10000 rows | 23.5 (13,677) | 42.9 (15,865) | 34.4 (17,037) |
| 1000 rows: every row ticks ×100 | 203 (12,740) | 302 (12,740) | 259 (26,022) |
| 10000 rows: every row ticks ×10 | 232 (15,823) | 332 (15,823) | 291 (29,103) |
| 10000 rows: one row ticks ×1000 | 2.56 (215) | 3.49 (215) | 3.05 (348) |

`bench:hermes-reaction`, ms (KB allocated by one run):

| | `track` | `trackPending` + `adopt` |
| --- | ---: | ---: |
| 1000 reactions reading 1 cell, render ×100 | 42.6 (3) | 110 (11,206) |
| 1000 reactions reading 10 cells, render ×100 | 126 (3) | 409 (109,644) |
| 10000 reactions reading 1 cell, render ×10 | 43.2 (3) | 115 (13,597) |

`bench:hermes-blackbox`, the graph shapes, the lower of the two runs'
median ms per step (bytes allocated per step):

| | Pinna | MobX | Legend State | Pinna ÷ MobX |
| --- | ---: | ---: | ---: | ---: |
| kairo deep: chain of 50 | 3.69 (22,833) | 11.8 (1,697,234) | 69.7 | 0.31× |
| kairo broad: 50 watched branches | 11.6 (22,837) | 40.8 (6,190,841) | 130 | 0.28× |
| kairo diamond: width 5 | 0.731 (30,832) | 2.00 (305,234) | 8.99 | 0.36× |
| kairo triangle: width 10 | 1.20 (30,832) | 3.46 (479,634) | 19.3 | 0.35× |
| kairo mux: 100 into one, split out | 17.7 (123,657) | 42.8 (3,645,241) | 119 | 0.41× |
| kairo repeated observers: 30 reads | 0.514 (22,832) | 1.24 (129,234) | 3.92 | 0.42× |
| kairo unstable: sources flip each write | 0.858 (34,032) | 2.15 (193,234) | 8.52 | 0.40× |
| kairo avoidable: change stops at the second link | 0.394 (22,832) | 0.828 (118,034) | 2.77 | 0.48× |
| cellx: 1000 layers | 3.59 (803) | 11.2 (1,283,433) | | 0.32× |
| molBench | 0.022 (2,544) | 0.057 (8,109) | 0.234 | 0.39× |

The app-shaped scenarios, median ms per step: a 200k-update session 0.327,
a realm made and dropped per screen 1.20, rates for 300 markets 1.09 and
600 markets 1.94, positions 0.164 (100) and 0.587 (400), market switching
0.434, scroll 0.241, refetch of 300 markets 9.38 replaced, 7.34 reconciled,
0.644 patched. Live bytes stay flat after warm-up and nothing outlives
dispose beyond the harness's own 2 to 19 KB, as on 2026-11-11 ("Black-box
scenarios on Hermes"); pagination grows by the rows it adds, and a
collection of candles is still warming up at 3,000 steps.

`bench:data` on Bun ran once, at load 24: Pinna bare is 0.12 to 0.45× of
MobX everywhere but adding rows one update at a time (1.9× observed, 3.7×
unobserved), with 6.8 MB and 8 objects a row decoded against MobX's
16.6 MB and 28.

### Reading and writing through the verbs costs nothing on the device (2026-11-13)

`apps/rn-bench` on a trial branch, where every
compute, select, and update reads through `read` and writes through
`write` (ruling 43 in `api.md`), against `main` of the same day.
Release builds on the iPhone 17 Pro simulator (iOS 26.3), so not
comparable with the iPhone 16 Pro tables above; three rounds of 10,000
rows each, run one after the other. Median store ms, branch / main, and
the change:

| Scenario | MobX | Pinna, `useSelect` | Pinna, cells |
| --- | --- | --- | --- |
| load | 8,950 / 8,221, +9% | 4,296 / 4,561, −6% | 4,485 / 4,658, −4% |
| merge a refetch | 8,604 / 8,209, +5% | 5,099 / 5,425, −6% | 5,239 / 5,368, −2% |
| deep merge | 9,213 / 8,615, +7% | 5,263 / 5,466, −4% | 5,373 / 5,417, −1% |
| reconcile per row | — | 5,884 / 6,082, −3% | 5,945 / 6,010, −1% |
| deep reconcile per row | — | 6,344 / 6,639, −4% | 6,618 / 6,731, −2% |
| replace all | 10,952 / 11,279, −3% | 5,234 / 5,712, −8% | 5,436 / 5,680, −4% |
| insert 100 | 122 / 112 | 68 / 80 | 69 / 87 |
| insert 100, one at a time | — | 108 / 116 | 109 / 115 |
| remove 100, one at a time | — | 60 / 66, −10% | 58 / 66, −12% |
| 60 ticks of 50 updates | 137 / 136 | 213 / 213 | 213 / 263, −19% |
| longest tick frame | 55.6 / 56.2 | 16.7 / 17.0 | 17.6 / 19.6 |

Settle times follow the store times. After load, the Hermes heap is the
same on both: MobX 397 MB, Pinna 99.6 (`useSelect`) and 99.9 (cells).

- **The verbs cost nothing.** No Pinna row is slower on the branch. The
  MobX code is the same on both, and its bulk rows moved by up to 9%, so
  that is the noise here; the 1 to 8% gains in Pinna's bulk rows are
  inside it, though they came in the run where MobX was the slower.
- **The cells tick is 19% faster** on the branch while MobX's tick did not
  move, which is outside the noise; it is not profiled, so what the branch
  changed to cause it is not known.
- Remove 100 in one write (15 to 28 ms) and details open are too small to
  compare at three rounds.

### Removing the methods: the verbs are the only path (2026-11-13)

Boxes lost `get`, `peek`, `set`, and `modify`; computed values `get` and
`peek`; atoms `observe` and `changed`; collections their writers. Reading
and writing go only through `read` and `write`, and `peek` moved to
`@frondruntime/pinna/testing`, since removed: tests read through
`realm.untracked`, and `peek` stays in `/internal` for pinna-react and the
Effect entry. `bench:hermes-graph`, Hermes for iOS
0.5, minimum ms of 9 runs, and KB allocated by one run: the methods
(`pinna`), the verbs beside them (`pinna-read`), both on the build before
this, and the build without the methods.

| Scenario | methods | verbs beside them | verbs only | KB: methods / verbs only |
| --- | --- | --- | --- | --- |
| deep chain 1000, write ×100 | 68.60 | 67.64 | 66.58 | 44 / 41 |
| fan-out 1000 watched, write ×100 | 147.56 | 145.36 | 142.73 | 61 / 57 |
| diamond 1000 into a sum, write ×100 | 95.25 | 93.34 | 91.15 | 28 / 25 |
| conditional reads 1000, flip ×100 | 369.13 | 366.64 | 359.58 | 11,021 / 11,015 |
| make and dispose 1000 watched computeds ×10 | 26.11 | 26.13 | 25.74 | 11,810 / 11,810 |
| write 1000 sources in one update ×100 | 120.26 | 113.95 | 112.04 | 3,325 / 121 |
| bursty fan-out, 100 writes per update ×100 | 150.65 | 149.18 | 145.90 | 371 / 58 |
| increment ×100k, each value checked | 246.02 | 242.18 | 239.42 | 25,004 / 21,879 |
| one write among 10k watched rows ×1000 | 3.07 | 2.77 | 2.57 | 409 / 300 |

- **Every scenario is 1 to 7% faster than the verbs beside the methods,
  and 1 to 16% faster than the methods.** A box, a computed value, and an
  atom have no prototype methods left, and a write allocates no bound
  closure: that is where the 3 MB of `write 1000` went.
- **`read` is at its floor.** Checking the place through the node's graph
  (`source.graph.active`) instead of the realm (`realm.core.active`) saves
  a load and measured inside the noise (deep chain 67.08, conditional
  357.03, increment 238.06); it was not kept.
- Bun, `bench:graph`, does not separate the three: every scenario moved
  by 6% or less either way (deep chain 3.42, 3.76, 3.61 ms; write 1000
  6.01, 5.70, 5.75), inside its run-to-run noise.

### The verbs alone on the device (2026-11-13)

`apps/rn-bench` on the build without the methods, one round of
10,000 rows on the same iPhone 17 Pro simulator as the table two sections
up. Store ms, then the change from that table's branch and main
medians:

| Scenario | MobX | Pinna, `useSelect` | Pinna, cells |
| --- | --- | --- | --- |
| load | 7,801, −13% / −5% | 4,126, −4% / −10% | 4,346, −3% / −7% |
| merge a refetch | 7,919, −8% / −4% | 4,827, −5% / −11% | 5,010, −4% / −7% |
| deep merge | 7,810, −15% / −9% | 4,876, −7% / −11% | 5,205, −3% / −4% |
| reconcile per row | — | 5,462, −7% / −10% | 5,755, −3% / −4% |
| deep reconcile per row | — | 6,271, −1% / −6% | 6,171, −7% / −8% |
| replace all | 9,762, −11% / −13% | 4,887, −7% / −14% | 5,019, −8% / −12% |
| 60 ticks of 50 updates | 159 | 187 | 198 |

After load, the Hermes heap is MobX 397.4 MB, Pinna 95.5 (`useSelect`) and
95.9 (cells).

- **No regression, and no gain this run can show.** MobX's code did not
  change and its bulk rows came in 4 to 15% faster than before, the same
  range as Pinna's: the simulator ran faster today. One round cannot
  separate a few percent from that.
- **Pinna's heap after load is 4% smaller** (99.6 and 99.9 MB before) while
  MobX's did not move, in line with the allocations the graph bench lost
  with the methods.

### Nodes as plain objects (2026-11-14)

A node was an object literal with `__proto__` set to its class's prototype,
and its methods lived there. Now a node is a plain literal with no
prototype, and the methods became functions that take a node of one kind
(`readCell`, `readDerived`, `writeCell`). Two ways to pick the read were
tried: one `readSource` that branches on `kind`, and a `read` method on
each of the realm's box, computed value, and atom classes that calls its
kind's function. The second is kept.

pinna-bench's publish tier, Node 26.13.1 and Hermes from the command line,
five launches per cell, three builds alternating over two rounds. Each
figure is the median of a build's ten launch medians, in ms; the machine's
load average ran 3 to 7:

| Scenario | Node: before | branch on kind | method per class | Hermes: before | branch on kind | method per class |
| --- | --- | --- | --- | --- | --- | --- |
| deep chain | 5.07 | 5.25 | 5.13 | 69.2 | 69.2 | 70.8 |
| fan-out | 10.2 | 10.4 | 10.0 | 155 | 158 | 154 |
| diamond | 7.37 | 7.08 | 7.06 | 103 | 105 | 101 |
| conditional reads | 28.1 | 29.6 | 28.5 | 385 | 393 | 387 |
| make and dispose | 14.5 | 2.55 | 2.53 | 28.0 | 27.8 | 27.2 |
| write 1,000 sources | 7.65 | 7.70 | 7.70 | 116 | 116 | 116 |
| bursty fan-out | 10.7 | 10.9 | 10.5 | 161 | 164 | 159 |
| increment ×100k | 16.9 | 17.0 | 16.7 | 256 | 257 | 255 |
| one write among 10k | 0.618 | 0.600 | 0.583 | 3.03 | 3.05 | 3.16 |

- **Make and dispose on Node is 5.7 times faster.** V8 builds a literal
  that sets `__proto__` through a runtime call instead of its inline
  allocation; a plain literal takes the fast path. The bytes allocated did
  not change on either runtime.
- **Branching on `kind` cost Hermes 1 to 2% on every read-heavy
  scenario.** A method on each class puts the choice back where the
  prototype had it, and those scenarios return to within 1% of before.
- **Every other difference is inside the range of the launches.** Deep
  chain and one write among 10k read higher on Hermes for the kept build,
  by 2 and 4%, with ranges that overlap the build before.

### Four stores in a React Native app (2026-11-14)

`apps/rn-bench` now builds the same screen over five stores: Pinna, MobX,
alien-signals, and Legend State over plain values, and Pinna on Effect
Schema over the wire JSON. The harness converts wire JSON to plain values
(`Big` decimals and dates) and times that apart, so "store" is the
library's write alone; for Pinna on Effect Schema it includes the decode.
MobX lost serializr: its classes take plain values in their constructors.
Every store merges by one rule, keeping a row whose other fields match and
writing each of its three tick fields only when it changed, and every
component formats in its read. `apps/rn-bench/test/conformance.test.ts` checks that the
stores hold the same ids after each write and rerender the same rows, with
one exception: Legend State rerenders 30 rows on a replace, not 500,
because its `set` compares the new value with the old field by field. The
Pinna cells variant is gone.

`bun run bench` takes `--mode`: rough, the default, runs one round of the
load, merge, replace, and ticks; full runs three rounds of every scenario.
These are rough figures: one round, 10,000 rows, a Release build on the
iPhone 17 Pro simulator (iOS 26.3). ms, store / settle; settle runs from
`JSON.parse`, so a plain store's settle includes the parse (79 to 121 ms)
and the conversion (707 to 789 ms):

| Scenario | Pinna | alien-signals | Legend State | MobX | Pinna on Effect Schema |
| --- | --- | --- | --- | --- | --- |
| load | 69 / 933 | 28 / 900 | 5,769 / 6,650 | 2,545 / 3,450 | 3,756 / 3,917 |
| merge a refetch | 262 / 1,117 | 226 / 1,083 | 3,187 / 4,083 | 871 / 1,783 | 4,113 / 4,266 |
| replace all | 70 / 983 | 36 / 917 | 4,053 / 5,000 | 2,558 / 3,483 | 4,305 / 4,467 |
| 60 ticks of 50 updates | 139 / 1,016 | 123 / 1,017 | 1,642 / 2,100 | 43 / 1,016 | 198 / 1,016 |
| longest tick frame | 17.1 | 17.4 | 100.9 | 18.8 | 23.3 |
| Hermes allocated after load, MB | 67.9 | 65.0 | 454.2 | 265.3 | 69.8 |
| resident after load, MB | 415.8 | 407.8 | 809.7 | 617.7 | 416.8 |

The figures do not compare with the tables above: those stores decoded
in their write, and MobX decoded through serializr.

- **Over plain values, the conversion is most of a write.** Pinna and
  alien-signals spend 28 to 262 ms in the store and settle within 8% of
  each other on every bulk write.
- **MobX's load and replace build 15 observable objects a row**: an
  `Instrument`, its `Network` and `Limits`, and 12 `Point`s, each through
  `makeObservable`. That is not profiled; the store does nothing else on
  load but set the list and its id index.
- **MobX is the fastest on ticks in the store**, 43 ms against Pinna's 139
  and alien-signals' 123. All three settle in 1,016 ms, the 60 frames the
  ticks take.
- **Legend State is the slowest at every write.** A first run took 160 s
  for the ticks: the store read `state$.rows.peek()` once per tick, and
  that peek walks every row, 6 ms at 10,000 rows on Bun and more once a
  batch has written. Peeking each moved row on its own took the ticks to
  1.6 s. Its store alone, on Bun with no React, ticks in 2 ms; what the
  rest of the 1.6 s is on the device is not profiled.
- **Effect's decode costs 3.7 to 4.3 s** of a bulk write and 2 MB of heap
  over plain Pinna. Its ticks take 198 ms, since the store also builds the
  `Big` decimals and dates the plain stores get converted.
- **Pinna holds a quarter of MobX's heap** and about a seventh of
  Legend State's; alien-signals holds 4% less than Pinna.

The four stores do not observe the same things, so these figures compare
store designs as much as libraries. This was read from the code on
2026-11-14 and is not measured:

- **Pinna and alien-signals make three fields of a row reactive**, the
  price, the 24-hour change, and the update time, and hold the rest as
  plain values.
- **MobX makes all 13 fields observable**, with `observable.ref` on each
  `Big`, date, and array, and builds a `Network`, a `Limits`, and 12
  `Point`s a row.
- **Legend State holds whole rows in one deep observable**, with no
  `ObservableHint.opaque`. Legend treats a `Big` as an object and walks its
  fields; a row has 17 of them and 12 history points.
- **Legend State's `set` of a record checks each previous key against the
  array of new keys**, 10,000 by 10,000 string comparisons on a replace.
- **Legend State's variant reads through `useSelector`**, not through the
  library's own `For` and fine-grained components.
- **Settle includes the parse and the conversion**, 786 to 910 ms, so two
  stores that settle alike may differ in the store alone.

The stores are to be rewritten as each library's documentation writes
them, and measured again in full mode, before these figures are relied on.

### One instance of each library per bench process (2026-11-15)

A bench worker made a new Pinna realm for every sample. alien-signals,
MobX, and Legend State keep their state in the module, so one instance of
each already served a whole process. A worker now makes the library's
instance once per cell and builds every sample's graph in it, warm-up
included, as an application keeps one realm. A conformance case still gets
an instance of its own.

pinna-bench's rough tier on Node 26.13.1, Pinna alone, four launches of
each build in turn. Each figure is the median of a build's four launch
medians:

| Scenario | ms: a realm per sample | one realm | bytes: a realm per sample | one realm |
| --- | --- | --- | --- | --- |
| deep chain | 5.01 | 4.77 | 39,096 | 10,488 |
| fan-out | 10.1 | 8.91 | 10,792 | 10,488 |
| make and dispose | 3.01 | 2.51 | 11,496,836 | 11,360,156 |
| write 1,000 sources | 8.04 | 7.10 | 732,916 | 10,488 |
| increment ×100k | 15.1 | 15.2 | 10,262,276 | 9,789,684 |

- **Write 1,000 sources allocated 70 times its present figure.** 10,488
  bytes is what alien-signals reads for the same scenario, and the lowest
  figure any Node cell reads.
- **Four of the five scenarios run 5 to 17% faster.** Increment did not
  move.
- **What a new realm costs V8 in a sample was not traced to one cause.**
  It is a question for the bench correctness run, with how bytes are
  counted.

### Dirty marks, a box's cell without an options object, and a fuzz (2026-11-15)

A spike rewrote the core from scratch. Three pieces of it are merged, and
the rest stays on its branch:

- **A differential fuzz.** `bun run fuzz` in `packages/pinna` runs
  programs a seed generates (boxes, atoms, collections, computed values,
  watches, updates) against this checkout and against the checkout
  `PINNA_REFERENCE` names, and compares the two traces entry by entry:
  each value read, each error thrown, and each compute that ran. It
  shrinks a mismatch to the smallest program that still differs.
  `PINNA_FUZZ_IGNORE_RUNS=1` compares what a program observed and leaves
  out which computes ran.
- **A box's cell without an options object.** `Graph.cellComparing` takes
  the comparison as an argument, where a box passed `{ equals }` to
  `cell`.
- **Dirty marks.** A write marks each derived value that reads the written
  cell or atom directly, in the `linked` field a derived value never
  used. A marked value with one source recomputes with no walk below it,
  and a walk that finishes a source resumes its parent by that source's
  version instead of visiting the edge again. The clear of the mark on a
  kept error was dropped: no path reaches it with a mark that is read.

pinna-bench's rough tier, Node 26.13.1 and Hermes from the command line,
Pinna alone, three launches of each build in turn. Each figure is the
median of a build's three launch medians, in ms:

| Scenario | Node: before | after | Hermes: before | after |
| --- | --- | --- | --- | --- |
| deep chain | 5.04 | 4.68 | 71.3 | 74.2 |
| fan-out | 8.95 | 8.55 | 165 | 143 |
| diamond | 6.56 | 5.91 | 117 | 95.5 |
| conditional reads | 27.3 | 27.7 | 414 | 413 |
| make and dispose | 2.69 | 2.80 | 29.0 | 28.3 |
| write 1,000 sources | 7.05 | 7.22 | 114 | 115 |
| bursty fan-out | 9.50 | 9.10 | 166 | 148 |
| increment ×100k | 15.3 | 17.3 | 259 | 232 |
| one write among 10k | 0.602 | 0.579 | 3.55 | 2.96 |

- **Fan-out, diamond, bursty fan-out, and increment run 10 to 18% faster
  on Hermes**, and one write among 10k 17%. On Node the first three and
  deep chain run 4 to 10% faster.
- **Deep chain on Hermes is 3 to 4% slower.** Over 20 more launches of
  each build it read 71.8 before and 74.7 after, and 72.4 for a build
  that differs from before by one unused method. A chain's values have
  one source each, so each recompute pays for the mark and skips no walk.
- **Increment on Node reads in three bands in every build**: 10.4 to
  11.5, about 15, and 17.1 to 18.2 ms a launch. Over the same 20 launches
  the medians are 15.3 before and 15.0 after; the 17.3 above is three
  launches that fell in the top band. Which band a launch lands in is a
  question for the bench correctness run.
- **The bytes allocated did not change** in any scenario on either
  runtime.
- **The fuzz found no mismatch**, computes included, over 900,000 seeds
  against the build before with the fix of the next section applied.

### A reader of a never-current value stays never current (2026-11-15)

The fuzz found a defect older than the spike. A derived value that reads
an atom nothing observes is never current: nothing can tell it that the
atom changed, so it recomputes on every read. So is a value whose run met
a cycle. A reader of such a value has to be never current too. The walk
that checks a reader kept that in a local variable and reset it each time
it descended into a later source, so a reader with a never-current source
before another source it had to walk into ended current, and served its
cached value until the next write. The reader now keeps what its earlier
edges showed across the walk below.

Six launches of each build in turn, the build with dirty marks against the
same build with the fix, medians of launch medians in ms:

| Scenario | Node: before | after | Hermes: before | after |
| --- | --- | --- | --- | --- |
| deep chain | 4.48 | 4.55 | 73.5 | 76.3 |
| fan-out | 8.51 | 8.42 | 142 | 143 |
| diamond | 5.91 | 5.98 | 94.7 | 95.1 |
| conditional reads | 26.8 | 27.3 | 412 | 421 |
| make and dispose | 2.63 | 2.62 | 28.1 | 28.1 |
| write 1,000 sources | 7.06 | 7.07 | 114 | 116 |
| bursty fan-out | 8.88 | 8.85 | 148 | 148 |
| increment ×100k | 16.1 | 16.2 | 232 | 232 |
| one write among 10k | 0.596 | 0.589 | 2.96 | 2.89 |

- **Deep chain on Hermes costs 3.7% more**, 5 to 6% with the dirty
  marks' share, and conditional reads 2%: the walk writes one field more
  at each descent and reads it at each return. The owner accepted the
  cost for a correct read.
- **Every other scenario is within 2.5%**, and the bytes did not change.
- **A program with a real dependency cycle may now throw `CycleError` from
  a different read.** Against the build before the fix, 213 of 600,000
  fuzz programs differ at all: 211 start with a compute the fixed build
  runs and the other does not, and 2 with a cycle caught at a different
  value. In 13 of them a read returns a different result, each with a
  cycle, some where the fixed build throws and the other returns a value
  and some the other way around. No program without a cycle reads a
  different value.
- **The fuzz's reference is now the build with the fix.** Against it this
  build shows no mismatch, computes included, over 100,000 seeds.

### What the site prints (2026-11-15)

The landing page's Node and Hermes columns come from one run of
pinna-bench's rough tier on 2026-11-15: every library, one launch per cell,
343 seconds, load average 2.2 to 3.7. Pinna against alien-signals:

| Scenario | Node ms: Pinna | alien-signals | Hermes ms: Pinna | alien-signals | Node KB: Pinna | alien-signals | Hermes KB: Pinna | alien-signals |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| deep chain | 4.52 | 3.86 | 78.1 | 47.8 | 10 | 3,934 | 14 | 7,856 |
| fan-out | 8.40 | 6.26 | 143 | 96.8 | 10 | 14 | 14 | 7,845 |
| diamond | 5.97 | 4.78 | 97.8 | 59.6 | 10 | 27 | 14 | 7,863 |
| conditional reads | 26.9 | 16.6 | 428 | 261 | 8,089 | 8,377 | 10,959 | 42,089 |
| make and dispose | 2.57 | 1.02 | 28.3 | 14.1 | 11,206 | 8,015 | 13,059 | 12,511 |
| write 1,000 sources | 7.05 | 3.73 | 117 | 77.9 | 10 | 10 | 14 | 17,983 |
| bursty fan-out | 8.84 | 88.8 | 151 | 500 | 464 | 9,710 | 14 | 19,788 |
| increment ×100k | 14.9 | 8.03 | 234 | 158 | 10,098 | 22,983 | 10,941 | 47,659 |
| one write among 10k | 0.61 | 0.41 | 3.08 | 1.87 | 178 | 217 | 191 | 448 |

- **Every Node memory row is within 2 times alien-signals**, the target
  set for this work. The largest is make and dispose, 1.40 times.
- **Time is 1.2 to 2.5 times alien-signals on Node and 1.5 to 2.0 times
  on Hermes**, bursty fan-out aside, where Pinna runs in a tenth and a
  third of the time.
- **The Hermes launches of deep chain and conditional reads ran slow for
  every library**: alien-signals read 12% and 6% above its run on the
  build before. One launch per cell does not separate that from a change.
- **Bursty fan-out on Node allocates 97 to 493 KB from launch to launch
  of one build.** The site prints the 464 KB this run read.
- **The Bun column was not measured again.** It dates from 2026-11-14 and
  from the build before these changes.

### Four stores tuned to one reactive shape (2026-11-15)

Pinna is 1.2 to 1.6 times faster than MobX on load, replace, and ticks in
`apps/rn-bench`, ties it on merge, and is 4 to 6 times slower on insert and
remove. alien-signals is faster than Pinna on every write. Since 2026-11-14
the stores keep one reactive shape: the price, the 24-hour change, and the
update time of a row are reactive, every other field is a plain value, and
a refetch that changes one of those makes a new row. Each store reaches
that shape through its own library's tools, and its header cites the page
it follows:

- **Pinna** (`src/pinna/store.ts`): a `Model` per row with three plain
  boxes, each with an `equals` for its `Big` or date, in a `collection`;
  `useValue` and `useValues` read them. Plain boxes check nothing; a
  schema box is not measured here.
- **MobX 6.15.3** (`src/mobx/model.ts`): `observable.ref` on the three
  fields, the list as `observable.array` with `deep: false`, every write an
  `action`, and an `observer` component per field.
- **Legend State 3.0.0-beta.48** (`src/legend/store.ts`): rows by id in a
  record, the rest of a row and each `Big` marked `ObservableHint.opaque`,
  the row and the record `ObservableHint.plain`, a `set` per key inside one
  `batch`, and a `Memo` per field.
- **alien-signals 3.2.1** (`src/alien/store.ts`): a `signal` per field and a
  signal per row a component asks for. Its README documents no React
  binding, so `useTracked` in `src/alien/variant.tsx` is written for this
  app.

Every variant renders the same `RowList`, the same row and details views,
and a component per reactive field, which formats in its render.
`test/conformance.test.ts` checks that after each write every store holds
the same ids in the same order and shows the same texts as a reference over
plain arrays. The Pinna on Effect Schema variant is gone: no application
decodes in its store.

`bun run bench --mode full --sizes 1000,10000`: three rounds of every
scenario, a Release build on the iPhone 17 Pro simulator (iOS 26.3). The
median, store ms at 10,000 rows:

| Scenario | Pinna | alien-signals | Legend State | MobX |
| --- | --- | --- | --- | --- |
| load | 105.5 | 26.8 | 265.6 | 158.3 |
| merge a refetch | 259.6 | 223.7 | 308.5 | 273.4 |
| deep merge | 257.7 | 229.6 | 283.4 | 284.7 |
| replace all | 100.5 | 28.9 | 271.7 | 160.7 |
| insert 100 rows | 18.1 | 9.6 | 29.7 | 3.1 |
| remove 100 rows | 25.4 | 18.4 | 28.9 | 5.9 |
| 60 ticks of 50 updates | 39.0 | 25.0 | 236.4 | 45.2 |

At 1,000 rows the load is 10.2, 3.5, 26.3, and 16.5 ms, and the ticks 39.4,
25.7, 227.4, and 42.6. Rounds differ by about 3%.

- **What Pinna's load costs, split on Bun 1.4.4**: 4.0 ms for the whole
  load against alien-signals' 2.0; of it, 1.3 ms makes the 10,000
  `Instrument`s and their 30,000 boxes, where 30,000 alien-signals
  `signal`s take 0.4, and 1.8 ms is the `replaceAll`, which makes a cell
  and records an undo for every key. alien-signals makes a row's signal
  only for the 21 rows on screen. The `equals` option costs 6% of making a
  box. On Hermes, which has no JIT, Pinna's load is 4 times
  alien-signals', against 2 on Bun.
- **Insert and remove rewrite Pinna's whole list.** The store follows
  `write.replaceAll`, which walks all 10,000 keys; MobX splices its array.
  One `upsert` or `remove` a row in one update, Pinna alone, takes 57.5 and
  61.5 ms.
- **The merge is mostly the comparison all four share**, `sameRest` on
  every row, so it shows the libraries as near equal by construction.
- **A store figure is the synchronous write.** Pinna's `useValue` and
  alien-signals' `useTracked` rerun their reads inside it; MobX's `observer`
  and Legend State's `Memo` rerun in the render that follows, which no
  column times.
- **Legend State's ticks take 228 ms at 1,000 rows and 236 at 10,000**,
  about 25 µs a field `set` whatever the size. That is not profiled.

What does not compare:

- **Settle.** It runs from `JSON.parse` to the first quiet frame, so it
  holds the parse, 80 to 111 ms, and the conversion, 684 to 717 ms, and is
  counted in 16.7 ms frames. At 10,000 rows its differences are the store's;
  at 1,000 rows the variation of the parse is larger than any store gap.
  The ticks settle in the 60 frames they take, 1,016.7 ms, in every
  variant, and no variant's longest tick frame passed 21.3 ms.
- **Renders.** The variants split their components differently: a MobX row
  marks 4 times, the others 5.
- **Memory.** Hermes reports 63.6 to 79.7 MB allocated after the load, with
  no collection forced, so the figure holds garbage.
- **A device.** The simulator runs Hermes on an Apple Silicon Mac.

### Pinna's rows without a subclass (2026-11-15)

Pinna's load in `apps/rn-bench` fell from 105.5 to 51.1 ms at 10,000 rows,
and its allocation from 34.5 to 8.5 MB, less than alien-signals' 15.4. Most
of that came from one change to the store: its rows and its market are plain
objects now, not `Model` subclasses, as the alien-signals and Legend State
stores already were. MobX's store keeps its classes, which extend nothing.

The cost was Babel's, not Pinna's. babel-preset-expo lowers classes for
Hermes and, by default, takes its helpers from `@babel/runtime`. In 7.29.13,
`helpers/callSuper.js` holds `getPrototypeOf` and `isNativeReflectConstruct`
from `require`. Each helper remembers its answer by rewriting its own
`module.exports` and its local name, which `callSuper` does not see, so
every subclass construction runs `Object.getPrototypeOf.bind()` twice and
`Reflect.construct(Boolean, [], function () {})` once. On Hermes from the
command line, that is 1,411 bytes per construction against 290 for
`Reflect.construct` alone. The helpers Babel inlines into each file
(`enableBabelRuntime: false`) remember their answers, and pinna-bench lowers
with those, so no graph scenario pays this; no graph scenario makes a
subclass either.

Two rough runs on one commit, one round at 10,000 rows, one with
`Instrument extends Model` and one without, isolated it. The other three
stores allocated the same bytes in both:

| Pinna's load | `extends Model` | Plain object | alien-signals |
| --- | ---: | ---: | ---: |
| store ms | 84.6 | 56.6 | 27.0 |
| MB allocated | 34.5 | 9.2 | 15.4 |
| collections | 9 | 3 | 4 |

That is about 2.6 KB and 2.8 µs per row in the app, against 1.1 KB from the
command line. Why the app pays more, and why the plain-object store
allocates 9.2 MB in the app against 12.9 MB from the command line, is not
explained. Every `SchemaModel` and `Model` an application constructs under
these defaults pays the same, which this run does not measure. The figures
of 17.8 MB per load and 184 bytes and about 3 ms for `extends Model`, found
earlier this day, came from inlined helpers, which the app does not use, and
are withdrawn.

Since the previous run the store also hoists its `equals` options, Pinna
makes a collection's cell on its first read, and Legend State
loads in one `rows$.set`.

`bun run bench --mode full --sizes 1000,10000`, three rounds, the median,
store ms at 10,000 rows:

| Scenario | Pinna | alien-signals | Legend State | MobX |
| --- | ---: | ---: | ---: | ---: |
| load | 51.1 | 26.8 | 153.4 | 160.9 |
| merge a refetch | 248.9 | 224.5 | 321.6 | 275.1 |
| deep merge | 250.7 | 230.5 | 302.9 | 276.1 |
| replace all | 55.6 | 29.1 | 284.5 | 163.2 |
| insert 100 rows | 15.2 | 16.7 | 25.9 | 2.3 |
| remove 100 rows | 14.0 | 17.7 | 41.2 | 11.0 |
| 60 ticks of 50 updates | 41.6 | 24.2 | 234.8 | 42.3 |

Insert and remove vary up to 2 times between rounds, 9.1 to 18.0 ms for
Pinna's insert, so they rank nothing. Load and replace vary by under 2%.

Hermes's counters, read across the store's write alone, at 10,000 rows:

| Scenario | Pinna | alien-signals | Legend State | MobX |
| --- | ---: | ---: | ---: | ---: |
| load, MB allocated | 8.5 | 15.4 | 29.1 | 55.2 |
| load, collections | 3 | 4 | 8 | 14 |
| ticks, MB allocated | 3.0 | 0.9 | 31.5 | 2.6 |
| kept after collection, MB | 43.5 | 42.3 | 45.9 | 57.2 |

"Kept" is allocated bytes after two forced full collections with the rows
loaded, minus the same with the store empty, read on a fresh screen after
the timed scenarios. All four hold the same converted values for every row,
so the stores differ by 1 to 15 MB.

- **Collections cost the stores little.** The collector reports 0 to 14 ms
  per write, in whole milliseconds; whether that counts its work off the JS
  thread is not checked.
- **Ticks drop almost no frames.** In every round, at most one tick frame
  in sixty came later than 25 ms, in any variant, and the median of the
  longest frame was at most 27.0 ms, Legend State's at 1,000 rows.
- **The gap to alien-signals is not allocation.** Pinna now allocates less
  on the load and still takes 1.9 times as long, 51.1 against 26.8 ms.
  Both make 30,000 reactive values: an alien-signals `signal` is one object
  and a bound function, a Pinna box a cell and a graph node.

### `read.row`: a lookup without a cell (2026-11-15)

Pinna's 60 ticks in `apps/rn-bench` fell from 41.6 to 29.2 ms at 10,000
rows, and their allocation from 3.0 to 0.9 MB, the same as alien-signals'.
The tick looked each row up with `read($rows.row(tick.id))` inside its
update. A collection makes a key's row computed and cell on the first read
of `row(key)` and keeps both until the key is removed, so each tick left
behind a computed value and a cell for every key it touched first. The tick
now reads through `read.row($rows, tick.id)`, which where nothing tracks
reads the row the collection holds and makes neither.

On Hermes 0.14.1 from the command line, 3,000 lookups over 2,159 keys, the
keys of the app's 60 ticks:

| Lookup | MB allocated |
| --- | ---: |
| `$rows.row(key)` alone | 1.01 |
| `read($rows.row(key))` | 1.84 |

The tick's store from the command line, 60 ticks of 50 updates:

| Store | MB allocated |
| --- | ---: |
| Pinna, `read($rows.row(id))` | 2.91 |
| Pinna, `read.row($rows, id)` | 0.81 |
| alien-signals | 0.81 |

`read` gains one property, made once per realm. pinna-bench's rough tier
on Hermes, Pinna alone, two interleaved runs each, ms:

| Scenario | Before | After |
| --- | --- | --- |
| make and dispose | 27.8, 28.0 | 28.4, 28.1 |
| increment | 227.7, 228.2 | 229.2, 229.7 |
| fan-out | 139.2, 140.7 | 140.9, 140.5 |
| conditional reads | 410.9, 409.1 | 411.9, 410.8 |
| diamond | 90.7, 90.8 | 92.2, 92.4 |

Every scenario allocates the same bytes and is 0.3 to 1.7% slower on the
mean of its two runs, the diamond most; fan-out and conditional reads
overlap between before and after. What costs the time is not found. Make
and dispose, 1.3% slower here, stood at 2.0 times alien-signals before the
change (28.3 against 14.1 ms, "What the site prints"), so it may now be
past the 2× budget; no run since measures it against alien-signals.

`bun run bench --mode full --variants pinna --sizes 10000`, a release build
on the iPhone 17 Pro simulator, three rounds, store ms and MB allocated:

| Scenario | Before, rounds | After, rounds |
| --- | --- | --- |
| load | 51.1, 51.5, 51.1 | 55.6, 53.5, 51.2 |
| merge a refetch | 248.7, 248.9, 252.1 | 269.5, 251.7, 262.0 |
| replace all | 55.5, 55.6, 55.8 | 55.0, 55.6, 56.0 |
| 60 ticks | 41.3, 43.3, 41.6 | 31.1, 28.5, 29.2 |
| 60 ticks, MB | 3.0, 3.0, 3.0 | 0.9, 0.9, 0.9 |

The load and the merge allocate the same bytes in both runs, 8.5 and 25.6
MB a round, and neither reads through `read.row`; their spread between
launches is wider after than before. "Kept for the rows" is 43.5 MB in
both. The site prints every store's figures from one later run of the four
stores, the same day, after `read.row`: the median of three rounds, 10,000
rows, Pinna at 52.0 ms on load, 256.6 on the merge, and 28.9 on the ticks.

### A first run links its own edges; a watch node of its own costs more than it saves (2026-11-16)

Make and dispose had sat on the 2× budget since 2026-11-09. Four calls
that `hermesc -O` does not inline went from its path: a first run of a
derived value or a watch now links its new edges at the end of the run
itself, with no `finishRun` and no `reconcile`; `subscribe` and
`unsubscribe` link and unlink the edge they are given without `append` and
`detach`; `watch` and `disposeWatch` call `checkObserving` only inside a
run.

`bench:hermes-graph`, ms minimum of 9 runs (pinna ÷ alien-signals):

| | Before, run 1 | Before, run 2 | After, run 1 | After, run 2 |
| --- | --- | --- | --- | --- |
| make and dispose | 27.3 (2.11×) | 27.1 (2.14×) | 24.7 (1.94×) | 25.0 (1.83×) |
| fan-out | 140 (1.49×) | 138 (1.47×) | 140 (1.46×) | 138 (1.36×) |
| conditional reads | 415 (1.68×) | 418 (1.73×) | 405 (1.67×) | 409 (1.45×) |
| increment ×100k | 228 (1.63×) | 232 (1.66×) | 228 (1.59×) | 234 (1.58×) |

- **Make and dispose is 9% faster, 1.94× alien-signals**, under the 2×
  budget. Every other scenario holds its time within 2%.
- **The second run after is noisy for alien-signals**: its medians ran 17 to
  31% over its minimums, against 1 to 3% in the other runs, so its ratios
  there read low. Pinna's own times match the first run.
- **A watch node of its own, 15 fields against 28, was tried and dropped.**
  It took make and dispose to 1.90× and 1.91× in two runs, and cost fan-out,
  conditional reads, and increment 4 to 6% each: every site that reads both
  a watch and a derived value now sees two shapes. One shape for every
  observer stays (`docs/design.md`).
- **Also tried and dropped, each within noise:** writing `append` and
  `detach` out in the loops that link and unlink a source's own edges, and a
  `read` that calls `readDerived` or `readCell` itself rather than through
  the wrapper's method.
- **What is left is the node.** On the probe, per 10,000: a derived node
  alone costs 3.4 ms against alien-signals' 1.8, and a watch on a box 10.3
  against 7.3. A literal costs about 8 ns per field on Hermes (28 fields 211
  ns, 15 fields 103, 7 fields 60), and alien-signals' nodes have about 7.
  Closing the gap to 1.6× is a node layout with fewer fields per kind, and
  that layout has to be measured against the cost of a second shape that
  the watch node met.
- **The site's make and dispose row is remeasured** with
  pinna-bench's rough tier, every library, on Node and Hermes: Pinna 24.6 ms
  on Hermes against alien-signals' 13.4 (1.84×), and 2.38 against 0.948 on
  Node; two runs agree within 2% on Hermes. Its Hermes memory is unchanged to
  the kilobyte, so that row stays. Every other row stays from 2026-11-15: a
  full rerun at a load average of 5 to 26 put Pinna's Hermes bursty fan-out
  at 266 ms against 151, which is the machine, not the code. Bun's
  `bench:graph` shows no change (median 2.32 ms against 2.23), so Bun stays
  from 2026-11-14.
- **Decided: 1.0 ships at 1.94×.** The node layout is weighed after 1.0,
  against how often a real app makes and disposes watches when it mounts and
  unmounts.

### MobX 7.1.7 in every bench, and what Babel's class helper costs it (2026-11-16)

Every bench now runs MobX 7.1.7, the latest stable release, where the
speed benches had run 6.15.3, the version the applications Pinna replaces
ship. Legend State stays on 3.0.0-beta.48, labeled as a beta on the site.
The site's graph tables and app table are all remeasured on this date.

- **The graph tables:** pinna-bench's rough tier on Node 26.13.1 and
  hermes-ios 0.5, at a load average of 8 to 10, and
  `bench:graph` on Bun 1.4.4, median of 9 runs. The Bun column, last
  measured 2026-11-14, is remeasured with the rest.
- **The app, `apps/rn-bench`**, full mode, 10,000 rows, median of three
  rounds; ms unless the row names another unit:

| | Pinna | alien-signals | Legend State | MobX 7.1.7 | MobX 6.15.3 (2026-11-15) |
| --- | --- | --- | --- | --- | --- |
| load | 51.4 | 27.2 | 165.5 | 237.9 | 161 |
| merge | 252.4 | 228.5 | 332.3 | 285.1 | 275 |
| replace | 55.9 | 29.8 | 292.3 | 249.4 | 163 |
| insert 100 | 14.1 | 12.9 | 30.6 | 2.7 | 1.9 |
| remove 100 | 15.1 | 20.2 | 42.6 | 11.4 | 7.0 |
| 60 ticks | 28.3 | 24.8 | 232.2 | 41.8 | 41 |
| allocated by the load, MB | 8.5 | 15.4 | 29.1 | 115.9 | 55.2 |
| collections during the load | 3 | 4 | 8 | 30 | 14 |
| kept for the rows, MB | 43.5 | 42.3 | 45.9 | 51.9 | 57.2 |

- **MobX 7.1.7's load and replace cost is Babel's, not MobX's.** MobX
  7.1.7's `dist/mobx.esm.js`, the entry React Native resolves, declares
  native classes, and `class ObservableValue extends Atom` (line 1192)
  makes one instance per observable field. babel-preset-expo lowers the
  subclass through `@babel/runtime`'s `_callSuper`, which costs about
  2.6 KB and 2.8 µs a construction in this app ("Pinna's rows without a
  subclass"). Three fields a row over 10,000 rows is 30,000 constructions,
  which predicts about 78 MB and 84 ms; the load measured 61 MB and 77 ms
  over 6.15.3. MobX 6.15.3 shipped an ES5 build with no class declarations.
- **Without Babel, 7.1.7 is the cheaper MobX.** The same load bundled with
  `bun build` and run by `hermes -O` from the command line: 7.1.7 146 ms and
  85.2 MB, 6.15.3 156 ms and 99.0 MB. On Bun, 5.6 ms and 10.28 MB kept
  against 6.3 ms and 11.04 MB.
- **Decided: the app keeps babel-preset-expo's defaults for every store.**
  A setting that drops the helper, such as `enableBabelRuntime: false`,
  would be tuned for MobX alone. No store's own rows extend a class; Pinna's
  hold plain objects, MobX's `Instrument` extends nothing. The cost MobX
  pays is inside its own build, and the site names it next to the table.
- **Insert and remove vary up to 3× between rounds** (MobX's remove 4.9 to
  14.7 ms); load, replace, and ticks within 13%. Parse and conversion from
  wire JSON, timed apart, took 760 to 845 ms of each bulk write.

### Each node's most-read fields in Hermes' five inline slots: within noise (2026-11-16)

Hermes keeps an object's first five named properties inline, and the rest
in a separate property storage. On a probe, a read past the fifth property
cost about 12% more, and a write about 6%. A count of field accesses
across the nine scenarios of `packages/pinna-bench` found that a source's
`value`, `version`, `readBy`, `graph`, and `kind` take about 80% of its
accesses; an observer's most read are `cursor`, `kind`, `status`,
`volatile`, and `checkedAt`. The spike put those five first in each
literal, on a trial branch.

`packages/pinna-bench` on Hermes, publish tier, Pinna alone, five
alternating pairs, median of each pair's ratio (reordered ÷ before):

| Scenario | Ratio |
| --- | --- |
| deep chain | 1.004 |
| fan-out | 0.990 |
| diamond | 0.993 |
| conditional reads | 0.999 |
| make and dispose | 1.025 |
| write sources | 1.002 |
| bursty fan-out | 0.987 |
| increment | 0.988 |
| one write among many | 0.997 |

- **No scenario moves past noise**: the geometric mean of the ratios is
  0.998. Make and dispose is slower in four of five pairs, by 2.5%.
- **A single pair misleads.** The first pair alone read 2 to 8% faster.
- **Dropped.** The inline slots are not where the graph's time goes; the
  order of a literal's keys stays the order that reads best.

### A box, a computed value, and an atom as the node itself (2026-11-16)

A box, a computed value, or an atom was a handle object around a
pinna-core node. The spike makes each the node: one object per
observable. A node carries what the handle did: the read of its kind,
Effect's identity keys, and, on a cell, the host's check and what an update
recorded of it. The label and `onObserved` hooks move to a part made on
the first of either. On a trial branch, not rebased over the first-run
linking above. `bun run check` passes, and 100,000 fuzz seeds match
the `main` it branched from.

Bytes allocated per item on Hermes:

| Item | Before | One object |
| --- | --- | --- |
| box | 304.3 | 232.3 |
| computed value, unread | 360.4 | 296.4 |
| computed value, read once | 472.6 | 408.6 |
| watch over one box | 512.6 | 528.5 |

`packages/pinna-bench` on Hermes, publish tier, Pinna alone, three
alternating pairs, median of each pair's ratio (one object ÷ before):

| Scenario | Ratio |
| --- | --- |
| deep chain | 0.973 |
| fan-out | 0.971 |
| diamond | 0.954 |
| conditional reads | 0.966 |
| make and dispose | 1.032 |
| write sources | 0.987 |
| bursty fan-out | 0.989 |
| increment | 0.969 |
| one write among many | 1.003 |

The React Native app (`apps/rn-bench`, full mode, 10,000 rows, iPhone 17
Pro simulator), four runs of each build, alternated by installing each
built app, median of twelve rounds:

| Scenario | Store ms before | Store ms one object | Store ms net of collections, before → one object |
| --- | --- | --- | --- |
| load | 57.0 | 47.1 | 51.5 → 44.1 |
| merge | 268.9 | 262.9 | 265.9 → 259.9 |
| replace | 61.0 | 50.3 | 53.8 → 46.3 |
| insert | 11.2 | 8.2 | 9.2 → 8.2 |
| insert each | 53.1 | 52.7 | 52.1 → 51.7 |
| remove | 9.2 | 13.7 | 9.2 → 11.3 |
| remove each | 48.7 | 49.4 | 47.7 → 48.4 |
| tick | 29.5 | 34.7 | 29.5 → 30.7 |

- **Making rows is faster.** Net of collections, load and replace take 14%
  less, and insert 11% less. Load and replace are faster in every one of
  the twelve rounds; insert overlaps.
- **The graph is 1 to 5% faster on Hermes, and make and dispose 3%
  slower**. Over the first-run linking, not measured: 3% on 1.94×
  alien-signals would be 2.0×, the budget's edge. A watch grew 16 bytes:
  the slots a node now carries for the handle it replaces. The runs
  before the change saw a load average of 4.7 to 6.0 against 3.5 to 4.7, so
  the gains may read a point or two high.
- **Tick and remove are slower, most of it collections that moved.** The
  one-object app collects twice in every tick and once in every remove,
  where the app before never did; it collects 19 ms a round in all, against
  23. Net of collections, tick still costs 4% more, and remove 23% more
  (9.2 ms to 11.3).
- **Memory kept is 2% less**: Hermes retained 42.6 MB after collection,
  against 43.5.
- **Load allocates 2.2 MB more, 11.1 MB against 8.9, and the cause is not
  found.** The figure is Hermes' total allocated bytes across the
  scenario, which a collection does not lower. The bytes bench does not
  describe the app's load: before the change, load allocated about 890
  bytes a row, less than the 912 that three boxes take in that bench.
- **Decided: parked until after 1.0.** 1.0 ships at 1.94× on make and
  dispose. The node layout is weighed after 1.0 (above), starting from these
  figures.

### The graph tables at the publish tier (2026-11-18)

The site's graph tables are remeasured at pinna-bench's publish tier, which
replaces the rough tier's one launch per cell with five: 2,385 seconds with
every package clean. Before the run, Safari, the ChatGPT app,
Monosnap, and the iOS simulator were closed; the load average was 2.6 at
the start and 4.5 at the end, against 8 to 10 for the rough run of
2026-11-16. The app table is unchanged, from 2026-11-16.

- **Runtimes:** Node 26.13.1, the Active LTS and the latest release;
  Hermes 260318099.0.5, the Hermes V1 build React Native 0.88.1 ships and
  the one already measured (0.88.0 shipped 260318099.0.4; `latest-v1` on
  npm is 260318099.0.8, which no stable React Native ships yet); Bun
  1.4.4, `bench:graph`, median of 9 runs.
- **Libraries:** alien-signals 3.2.1, MobX 7.1.7, Legend State
  3.0.0-beta.48, the latest of each that the benches already ran.

Pinna's median divided by alien-signals':

| Scenario | Node | Hermes | Bun |
| --- | --- | --- | --- |
| deep chain | 1.18 | 1.74 | 1.28 |
| fan-out | 1.37 | 1.44 | 1.37 |
| diamond | 1.22 | 1.57 | 1.40 |
| conditional reads | 1.62 | 1.66 | 1.28 |
| make and dispose | 2.48 | 1.85 | 1.35 |
| write 1,000 sources | 1.91 | 1.46 | 1.42 |
| bursty fan-out | 0.10 | 0.29 | 0.15 |
| increment ×100k | 1.74 | 1.47 | 1.36 |
| one write among 10k | 1.36 | 1.49 | 1.33 |

- **alien-signals' increment on Node is bimodal, and the site takes its
  fast mode.** In the full run its launch medians were 7.80 and 7.91 ms
  against 10.65 to 10.86 ms in the other three, a median of 10.6 ms. Two
  reruns of that cell alone for Pinna and alien-signals, at a load average
  of 1.8 to 2.6, put 8 of 10 launches at 7.81 to 8.33 ms and 2 at 9.92 and
  10.57 ms, so the slow mode is not the load. Over all 15 launches the
  median is 7.91 ms; Pinna's is 13.58 ms, with 3 of its 15 launches at
  15.1 to 15.5 ms. The site's Node increment figures, speed and memory,
  are the first rerun's: Pinna 13.7 ms, alien-signals 7.87 ms. Why a
  launch lands in one mode or the other is not investigated.
- **The five launches' medians agree within 5% on Hermes for every cell
  of Pinna and alien-signals.** On Node, 16 of those 18 cells agree within
  9%; the rest are Pinna's conditional reads (11%) and increment (15%).
- **Against the previous figures, Pinna and alien-signals moved within
  6% in most cells, and down more often than up**, as the lower load
  predicts. The exceptions: one write among 10k, down 11 to 14% for both
  on Hermes and for alien-signals on Node; Pinna's increment on Node, down
  10%; its conditional reads on Node, up 8%. Legend State moved the most,
  2 to 18% down.
- **Bursty fan-out on Node allocates 261 KB for Pinna**, inside the 97 to
  493 KB range one build read from launch to launch on 2026-11-15.
- **Raw results:** `packages/pinna-bench/results/` is ignored by git; the
  site's figures are in `apps/site/src/lib/benchResults.ts`.

### The graph tables after the fairness fixes, rough tier (2026-11-18)

The site's graph tables are replaced by a rough run made after the
fairness fixes, which give every library's watchers the same counting
effect and the Bun bench production builds. Pinna's lead over MobX holds and
its gap to alien-signals widens; MobX itself moved within 8% on Node and
Hermes, so the earlier tables did not understate it there.

- **Run:** pinna-bench's rough tier, one launch a cell, on Node 26.13.1 and
  Hermes 260318099.0.5, 321 seconds with every package clean, load average 3.0 to 3.7; then `bench:graph` on Bun 1.4.4, median
  of 9 runs. Before it, the headless Android emulator was stopped. A
  publish-tier run replaces these figures.
- **Libraries:** unchanged: alien-signals 3.2.1, MobX 7.1.7, Legend State
  3.0.0-beta.48.

Pinna's median divided by alien-signals':

| Scenario | Node | Hermes | Bun |
| --- | --- | --- | --- |
| deep chain | 1.26 | 1.82 | 1.45 |
| fan-out | 1.75 | 1.35 | 1.42 |
| diamond | 1.28 | 1.61 | 1.26 |
| conditional reads | 1.56 | 1.57 | 1.23 |
| make and dispose | 2.38 | 1.86 | 1.87 |
| write 1,000 sources | 1.50 | 1.32 | 1.28 |
| bursty fan-out | 0.10 | 0.29 | 0.15 |
| increment ×100k | 1.53 | 1.51 | 1.33 |
| one write among 10k | 1.34 | 1.41 | 1.31 |

- **MobX moved within 8% on Node and Hermes**: from −6% (one write among
  10k on Node) to +8% (the same on Hermes). On Bun, now on its production
  build and with the counting effect, its deep chain rose 15% and its
  diamond 10%; the rest moved within 5%.
- **Pinna's Node figures rose where its watcher had done less**: fan-out
  8.36 to 10.6 ms, write 1,000 sources 7.06 to 8.52, increment 13.7 to 15.0.
  alien-signals' write 1,000 sources rose 3.70 to 5.70 ms, so that ratio
  fell from 1.91 to 1.50.
- **alien-signals' increment on Node took 9.81 ms in this launch**, between
  the fast (7.8 ms) and slow (10.6 ms) modes of the publish run; one launch
  does not say which mode a cell takes.
- **The two alien-signals memory cells the old adapter inflated came
  down**: increment on Node 23,298 to 13,910 KB, bursty fan-out on Node
  9,690 to 165 KB; on Hermes 47,659 to 36,722 KB and 19,788 to 8,850 KB.
- **Pinna's fan-out on Node allocated 273 KB a run in this launch**,
  against 10 KB before. The counting effect does not cause it: the same
  scenario with a no-op effect measured 0.28 MiB, against 0.20 MiB with the
  counting effect. Within one launch the 15 counted runs ranged from 39 to
  577 KB, so a rough launch's median swings across that range; Hermes
  holds 14 KB. The cause is not yet found.

### Cold boxes, and what each box layout would save (2026-11-21)

**Neither box layout saves more than 3% of the store's retained heap on
the React Native trace, and the one-object layout saves more than lazy
nodes once ticks have run.** A third finding outweighs both: a collection
read whole, unobserved, keeps the rows it returned alive until the next
whole read, so after a refetch and a `replaceAll` the store holds 1,500
boxes of the previous generation. Lazy nodes are not spiked; the
one-object layout stays parked until after 1.0, for its load time.

The census replays `apps/rn-bench/src/pinna/store.ts` on `528b573`
(`perf/0.1.0`): 500 rows, a 10-row headless viewport and the details
panel, 60 frames of 50 ticks, a scroll over every row, a compatible merge,
a seeded refetch, a full replacement, and disposal. An instrumented copy
of the graph counts each box's first tracked read, first observer, and
first changed write; a scan of node fields after every frame and scroll
step found 0 differences in 127 comparisons, and all 1,405 callbacks match
an uninstrumented Hermes replay. Bytes are Hermes allocations, median of 5
processes at 200,000 items: a box is 304 bytes, 176 of them the node and
128 the handle, matching the 304.3 recorded before. Shares divide by the
store's Hermes retained heap at that stage, after load minus empty.

| Stage | Live boxes | Cold, a changed write promotes | Heap | Lazy nodes, one more handle field | Lazy nodes, writes do not promote | One object |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Load | 1,503 | 1,501 | 4.47 MB | 264 KB (5.9%) | 144 KB (3.2%) | 108 KB (2.4%) |
| After ticks | 1,528 | 9 | 4.55 MB | 1.6 KB (0.03%) | 129 KB (2.8%) | 110 KB (2.4%) |
| After full scroll | 2,003 | 0 | 5.01 MB | 0 | −160 KB | 144 KB (2.9%) |
| After full replacement | 3,498 | 1,467 | 9.47 MB | 258 KB (2.7%) | −22 KB | 252 KB (2.7%) |

- **Ticks make almost every field box hot.** 3,000 row ticks over 60
  frames wrote a changed value to 1,491 of the 1,500 field boxes, 1,416 of
  them never read with tracking or observed. With promotion on a changed
  write, 9 boxes stay cold.
- **A lazy handle costs more than its slot.** On Hermes a `BoxCell`-shaped
  object costs 128 bytes with 8 or 9 fields and 208 with 10: the first
  added field is free and the second costs 80 bytes. Lazy nodes that do not
  promote on a write hold the value and its version on the handle, two
  fields, and lose to one object from the full scroll on. Break-even is
  40.9% of live boxes cold for lazy nodes with one added field and 86.4%
  with two.
- **The ceilings are arithmetic, not measured savings.** Each charges the
  measured node and handle bytes; a working lazy layout's extra graph work
  and metadata are not measured. One object's 72 bytes a box come from the
  parked spike ("A box, a computed value, and an atom as the node itself").
- **`collection.rows` holds the previous generation.** The store's `merge`
  reads `read($rows.rows)` before `write.replaceAll`, so the collection's
  `rows` computed value caches the array it returned. Unobserved, it keeps
  that array until something reads it again, and the rows in it keep their
  boxes and data. After the seeded refetch 90 old field boxes stay
  reachable, after the full replacement 1,500. On Node with `--expose-gc`, 500 rows
  read through `rows` once and then replaced stay alive in 3 of 3 runs; a
  second read after the replacement, or no read at all, frees all 500.
  A key's `row(key)`, read under a key the replacement keeps, held the old
  row the same way: 500 of 500. Fixed for 0.1.0 (`docs/api.md`, ruling
  55): a write that changes the rows empties an unobserved `rows` and the
  unobserved `row(key)` of each key it changed. Both probes keep 0 of 500.
  On the trace, 1,998 boxes stay reachable after the seeded refetch and
  after the full replacement, against 2,088 and 3,498, and the Hermes
  retained heap is 5,008,232 and 5,027,168 bytes, against 5,279,256 and
  9,465,280. The ceilings above were measured before the fix and count the
  retained generation.

The harness, its raw data, and the full report are on the local branch
`experiment/2026-11-21-cold-box-census` (`085e962`), at
`experiments/cold-box-census/README.md`. Bun 1.4.4, Hermes
260318099.0.5 with `hermesc -O`, Node 26.13.1 with `--expose-gc` for the
cross-check (3.816 MB loaded, as before), Apple M1 Pro.

## Spike findings

The spike ran on a branch that was never merged and was deleted on
2026-11-07. Its two benches went with it; `bench/graph.ts`
and the Hermes benches cover the graph since. Its variants that dropped the
check or the journal patched instances, not the source.

1. **The add gap is the list being copied, not the update.** An empty
   update, a box write, and making a row match or beat MobX. An add costs
   about 1.5 ms per 1000 on an empty list and 11 to 14 ms on a 10k list:
   `box.modify` drafts a copy of the whole array on every push (the `slice()`
   in the draft code of `observable.ts`), and `collection.upsert` builds
   `[key, ...order]` each time. The schema subject also scans the 10k
   elements by identity on each write. MobX's `push` copies nothing.
2. **Effect on the bare path is one call.** `Schema.is(Schema.Unknown)` runs
   on every write, about 30 ns. Everything else Effect touches in
   `observable.ts` and `collection.ts` is an `Equal` or `Hash` symbol method
   that Pinna itself never calls, or the class and decode layer.
3. **Per-write bookkeeping is real in large updates.** Writing 1000 boxes in
   one update: the check costs about 30 ns per write and the journal's maps
   (`recorded`, `before`, the journal array) about 50 ns. Dropping both halves
   the time (16.4 to 8.1 ms; alien-signals 4.4 ms).
4. **The rest of the gap to alien-signals is in `packages/pinna-core/src/graph.ts`.** Deep
   chains, conditional reads, and creating and disposing do not move without
   the check or the journal.
5. **On large lists the journal adds about a third on top of the copy.** The
   likely cause is the journal keeping the copied array alive longer; not
   verified.

## Plan, in order

1. **A Hermes bench that needs no React Native app.** Done 2026-11-05:
   `bench:hermes-graph` and `bench:hermes` take a `hermes-ios` `destroot`
   (`design.md`, "On Hermes"); numbers above. What bursty fan-out allocated
   was `for...of` over the observer `Set`; observers are in linked nodes
   since 2026-11-05.
2. **Move Effect behind its own import path.** The move is done: since
   2026-11-14 the Effect layer is its own package,
   `@frondruntime/pinna-effect` (ruling 44 in `api.md`). The rest of this
   item is the plan as written, not checked against the code. Equality
   and hashing become options the core takes (`Object.is` by default); the class layer passes
   Effect's `Equal` and `Hash` in, so domain objects keep structural
   equality. Errors are plain in the core and become a `Cause` in the Effect
   bridge.
3. **Per-write bookkeeping.** Done 2026-11-05: `Unknown` and `Any` share one
   check that accepts everything, and the journal is flat arrays with an
   index on the box ("A write allocates almost nothing").
4. **Close the graph gaps to alien-signals**, judged on Hermes numbers. The
   cheap part is done 2026-11-05 ("A flush makes no closure"), and edge
   reuse with one object shape per kind 2026-11-07 ("Edges reused in
   place"). What is left:
   - cheaper creation and disposal of graph entries (2.0×, on the line);
   - propagation down long chains.
5. **Appending without copying.** A design question, not a quick fix. Box
   values are immutable snapshots, so a cheap append needs something like a
   chunked or persistent order for collections, or a size readers can watch
   without reading the array. It is the only way to close the add gap (14×
   on Bun, 6 to 8× on Hermes). A collection copies only its keys on an add,
   not the rows, but still the whole list of them. Waits for the next
   version (owner, 2026-11-05).

## Ideas, ranked for Hermes

Hermes interprets bytecode compiled ahead of time: `hermesc -O` inlines a
small free function but no method, every other call, closure, getter, and
temporary object is paid as written, and garbage becomes collection pauses
on the JS thread.

1. **Compile the schema checks.** A straight-line validator per schema, with
   Effect called only on failure so the message stays the same; differential
   fuzzing proves both accept the same inputs. Generated at build time, since
   Hermes bytecode does not take `new Function`. Belongs to
   `pinna-effect`, the class layer.
2. **Per-update and per-write allocation:** done 2026-11-05 for `update` and
   a write. Left: `write.modify` (then `box.modify`) with a recipe, about
   1.5 KB per call in the draft as measured on 2026-11-05.
3. **Fewer objects per row:** done 2026-11-12 the cheap way, by building a
   schema's check once ("A schema's check is built once"): 21 objects per
   observed row, from 42. A row node with a field mask on each edge was
   spiked and measured 1.76× fewer bytes per observed row, short of its 3×
   gate; the watch alone is 624 B of it.
4. **A graph core that does not allocate:** done 2026-11-07, linked-list
   dependency edges reused in place on a rerun ("Edges reused in place").
5. **Incremental collections:** `filter`, `count`, `groupBy` updated from
   deltas instead of rescanned. Algorithmic, so it wins on every engine.
6. **Typed arrays and packed integer flags:** measured 2026-11-12 and
   rejected. A struct of `Int32Array`s marks 1.15× slower, relinks 1.87×,
   and makes edges 2.6× slower than today's objects, for a third of the
   memory per edge; plain arrays of integers beat `Int32Array` everywhere.

Hermes-specific rules for the core's hot paths (reads, writes, tracking, the
drain): no closure per operation, no accessors, no `for…of`, spread, or
destructuring, fewer and flatter calls. A lint rule or grit plugin limited to
`packages/pinna-core` could enforce it.

Other ideas:

- **Dates as numbers:** epoch milliseconds in boxes, `Date` and `Intl`
  formatting only at the view.
- **Count allocations, not just time:** objects allocated per update and per
  row as gated numbers. Load does not move them.
- **Further out:** Static Hermes (typed JavaScript compiled to native; check
  its status first), decoding off the JS thread with a separate runtime from
  react-native-worklets, lazy decode (changes when errors surface; needs a
  ruling). A WASM core is unlikely to pay, since every read would cross the
  boundary.

## Measuring

- **Machine load.** The machine these ran on is shared and often loaded (load
  average 5 to 28). Report the minimum as well as the median; the minimum
  survives load.
- **Allocation counts in Bun do not work.** `heapStats()` from `bun:jsc` and
  `process.memoryUsage()` change only at a collection, so they cannot count
  garbage. **Hermes does:** `HermesInternal.getInstrumentedStats()` has
  `js_totalAllocatedBytes`, which counts every allocation as it happens,
  and `js_numGCs` and `js_gcTime`. `bench:hermes-graph` reports bytes per
  run; they are what a gated allocation number would be built on.
- **Graph scenarios.** For alien-signals and the rest of the family, the
  shared yardstick is js-reactivity-benchmark (kairo, cellx, molBench,
  dynamic graphs).
- **Fair comparisons.** Compare the graph alone with alien-signals, and the
  class layer with serializr plus MobX, not with bare MobX.

### rere-benchmark (read 2026-11-04)

[rere-benchmark](https://github.com/NullVoxPopuli/rere-benchmark) ("The
Reactive Rendering Benchmark", NullVoxPopuli) times rendering through UI
frameworks in Chrome, from a state change to the DOM settling. It is a source
of scenarios and method, not a yardstick for Pinna:

- Browser and DOM only (puppeteer); Hermes is what Pinna is judged on.
- A "react + pinna" entry would mostly measure React reconciling; the graph
  gaps above would barely show.
- Its entries are frameworks only: no MobX, alien-signals, or standalone
  signal libraries to compare against.
- Built with pnpm (a separate checkout only, never this repository) and
  licensed GPL-3.0: borrow ideas, not code. Early, by its own README.

Worth borrowing for the Hermes bench (plan item 1):

- **Bursty fan-out:** 1000 consumers of one source, 100 updates per burst
  (a live exchange rate).
- **Incrementing render effect:** 100k increments, the result checked after
  each one, which shows whether per-update overhead stays flat.
- **One update on 10k items** and **many updates to one item.**
- **Method:** seeded randomness, p50/p75/p90 over repeated runs, a throttle
  option, and detecting done from the output rather than with a timeout.

Maybe later, in a separate checkout: "react + pinna" against "react + mobx"
entries, as a web check that the graph wins survive React. Not a target.
Not yet read: its companion `ember-reactivity-bench` ("Reactivity without
effects"), which may be closer to the graph-only question.

## Open decisions

- Decided 2026-11-14: the Effect layer is a separate package (ruling 44 in
  `api.md`), and a box without a schema compares with `Object.is` by
  default, while a schema box compares by its schema.
- Whether collection key hashing is pluggable in the core or lives in the
  class layer.
- How a list grows without a copy (plan item 5).
- Whether `adopt` keeps the links when a render read what the kept one did,
  as `track` does, rather than relinking (the React hooks entry: on Hermes it
  doubles the graph work per render and allocates). A change in the core.
  Only `useSelect` pays it now.
