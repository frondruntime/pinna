# Building the first desk slice

Pinna supplies the subscription lifetime needed by a price tile
(`packages/pinna-effect/src/programs.ts:134`). The cost is
finding the right example and understanding which scope and services own it.
This record separates repository observations from implementation decisions.

## Friction recorded during implementation

### 1. The live-data guide solves a different subscription lifetime

**Needed:** a price subscription that exists only while a component shows it.
**Observed:** `docs/public/guides/live-data.md:102` explicitly keeps its Effect
socket open for the fiber's lifetime, rather than for observation. The plain
version describes observation at `docs/public/guides/live-data.md:25`.
`apps/playground/src/docs/programs.ts:55` demonstrates the missing composition:
`fromStream` under a computed value. `README.md:223` also lists that behavior.
**Decision:** use `fromStream` rather than copying the larger live-data program
or writing a separate `onObserved` hook. **Inference:** a cross-reference from
the Effect socket example to that observation pattern would shorten discovery.

### 2. An Effect context has to survive creation and later React observation

**Needed:** the same clock and realm for HTTP initialization and a stream React
starts later. **Observed:** `docs/dx.md:334` names `RealmService`; the source at
`packages/pinna-effect/src/programs.ts:153` captures the caller's context and
`packages/pinna-effect/src/programs.ts:177` runs the stream with it. The source
at `packages/pinna-effect/src/programs.ts:185` also waits for shutdown when the
creation scope closes. That source read resolved how a React subscription can
start after the Effect that constructs its value returns.
**Decision:** create the client inside the application's long-lived scope; in
tests, provide TestClock before client creation. **Inference:** a complete React
example that constructs and closes this scope would remove that source read.

### 3. The stream adapter cannot accept ordinary transport failures directly

**Needed:** feed `Stream<string, TransportError>` through JSON decoding.
**Observed:** `packages/pinna-effect/src/programs.ts:147` accepts a stream whose
error type is `never`; `packages/pinna-effect/src/programs.ts:139` explains that
defects are logged and the last value stays. The live-data example instead
logs and drops errors at `apps/playground/src/docs/liveDataEffect.ts:119`.
**Decision:** convert a transport or schema failure to a visible error value
before `fromStream`. No reconnect is added. **Inference:** failure-as-state is
an application decision; the adapter's type forces that decision early.

### 4. Price messages change more often than displayed values

**Needed:** retain every timestamp and previous price for the oracle, while
suppressing a render when everything shown is equal. **Observed:**
`docs/dx.md:137` says computed values compare with `Object.is` unless `equals`
is supplied; `packages/pinna/AGENTS.md:88` prescribes a small component under
`memo`. Returning a fresh display object with default equality would defeat
the required suppression.
**Decision:** a named computed display compares bid, ask, spread, movement,
and error; the full stream value retains current and previous wire messages.
React local state holds the notional input. A repeated price after an up tick
still changes the marker to unchanged, so that message must render once.

### 5. The stream examples use wall-clock settling in tests

**Needed:** assert every one of at least 1,000 settled ticks without sleeping
in real time. **Observed:** `packages/pinna-effect/test/effect.test.ts:50`
defines settling as a five-millisecond sleep, and its fromStream tests use
it at `packages/pinna-effect/test/effect.test.ts:460`. The application rules
at `packages/pinna/AGENTS.md:78` recommend `testRealm`, `untracked`, and `held`,
but do not supply a test-clock recipe for an observation-started stream.
**Decision:** use Effect's TestClock layer for the entire scoped scenario,
advance one interval at a time, and assert the independent log fold after
each advance. Keep the test realm and observation hold disposable.
**Inference:** real sleeps copied into the oracle test would hide races and
make a 1,000-tick check needlessly slow.

## Pinna API choices

| API | Use and reason over the alternative |
| --- | --- |
| `createRealm` | One named application realm; no global realm. |
| `Model` | Plain model ownership for trusted decoded data; no writable schema fields are needed. |
| `RealmService` | Supplies that realm to the Effect adapter without importing a singleton. |
| `fromStream` | Holds decoded prices and owns observation-driven start/stop; avoids a manual `onObserved`/fiber bridge. |
| `computed` with `equals` | Caches the exact displayed fields; avoids a fresh object from `useSelect` on every timestamp. |
| `useValue` | Reads the one known computed value; no provider or layout-effect selector is needed. |
| `untracked` | Reads retained state on subscription restart and snapshots in tests; never keeps a `read` closure. |
| `observeScoped` | Keeps the headless oracle's display observed until the test scope closes; no manual release is needed. |
| `testRealm`, `held`, `observe` | Realm leak checks and a disposable observation hold for the malformed-message test. |
| `Computed`, `Realm` | Describe the read-only price capability and explicit model owner in the client types. |

The application calls are in `apps/desk/src/main.tsx:15`,
`apps/desk/src/client/desk.ts:23`, `apps/desk/src/client/desk.ts:65`, and
`apps/desk/src/client/spot-tile.tsx:15`. The oracle's observation is held at
`apps/desk/test/market.test.ts:29`; additional test ownership is in
`apps/desk/test/react.test.tsx:1`.

`SchemaModel`, `BoxField`, `schemaBox`, and collections are unnecessary in this
slice: reference data is immutable, one pair has no keyed list, and only the
validated stream writes prices. This follows the decode-once guidance at
`docs/public/guides/live-data.md:107`, rather than weakening schema checks.

## Boundaries and reproducibility

The composition root (`apps/desk/src/main.tsx:16`) joins two independent implementations through a transport
that accepts only strings. It is the only production file allowed to import
both the exchange and client (`apps/desk/test/boundary.test.ts:8`). The exchange
uses plain state and a single seeded generator, with Effect for its clock,
scope, and broadcasts (`apps/desk/src/exchange/index.ts:32`). A market
tick continues while no view is subscribed; no price message crosses the
transport without a subscriber (`apps/desk/test/react.test.tsx:145`). Identical seeds, intervals, clock origins,
and subscription schedules reproduce the entire log. The test clock fixes
the origin and schedule, including request and subscription control messages
(`apps/desk/test/market.test.ts:49`).

## Errors encountered

The first typecheck failed on two Effect 4 signatures, before the oracle or
React checks ran. Passing `decodePrice` directly to `Stream.mapEffect` produced
`Type 'number' has no properties in common with type 'ParseOptions'`: the
stream supplies an index where the decoder accepts parse options. A unary
wrapper fixes it. Returning `[next, next]` from `Stream.mapAccum` produced
`Type 'PriceState' is missing the following properties from type 'readonly
unknown[]': length, concat, join, slice`: the second tuple member is an array
of emitted values. Returning `[next, [next]]` fixes it. The accompanying
`Computed<unknown> is not assignable to Computed<PriceState>` was a downstream
inference error. These are Effect API frictions, not failures of Pinna's
validation or observation model.

A later typecheck rejected Bun assertions that compared the client's literal
pair types with the independent oracle's broader strings and nullable pair.
Reversing the assertion operands preserved independent oracle types without a
cast (`apps/desk/test/market.test.ts:27`). It also reported the unused
disposable hold; the hold now has an underscore prefix, as the repository's
`packages/pinna/AGENTS.md:81` example does. Biome required an image role for the
labeled direction arrow (`apps/desk/src/client/spot-tile.tsx:30`). No Pinna
runtime error was encountered in the completed test scenarios.

## Assumptions and restart behavior

**Assumption:** movement compares the current bid/ask midpoint with the
previous message's midpoint; the first message and equal midpoints show an
unchanged arrow. EUR/USD has one pip per 0.0001 and five price decimals, so
spread is displayed to one decimal pip (`apps/desk/src/client/desk.ts:31`).
The notional input remains an uninterpreted React string; there is no domain
write or execution request (`apps/desk/src/client/spot-tile.tsx:50`).

**Observed:** `packages/pinna-effect/src/programs.ts:134` says the stream
restarts from its beginning but the observable retains its last element.
`packages/pinna-effect/test/effect.test.ts:509` tests that retention. A stream
scan starting from an empty state would erase the previous price on remount.
**Decision:** initialize `Stream.mapAccum` from an `untracked` read of the
retained value when observation restarts (`apps/desk/src/client/desk.ts:74`).
The read is delayed until observation, after `fromStream` has returned;
the lifecycle test checks that the first resumed tick has the retained current
price as its previous price. This required reading the adapter's source, not
adding a second writable box.

## Verification

All commands ran from the worktree root. Initial typecheck and Biome failures
are recorded above; their final runs passed. No check failed because of the
sandbox. Installation was not repeated in this continuation.

| Command | Final result |
| --- | --- |
| `bun run --cwd apps/desk typecheck` | Exit 0. |
| `bun run --cwd apps/desk test` | Exit 0; 10 tests passed, 0 failed, 3,438 assertions. |
| `bunx biome check apps/desk` | Exit 0; 16 files checked, no fixes needed. |
| `bun run --cwd apps/desk build` | Exit 0; Vite production bundle built. |
| `bunx biome check --write apps/desk` | Exit 0; formatting and import organization applied only under the desk. |
| `git diff --check` | Exit 0. |

The oracle compares full state and displayed state after every settled tick
(`apps/desk/test/market.test.ts:32`), for a 1,000-tick run
(`apps/desk/test/market.test.ts:63`). Render assertions total one initial
render plus five displayed changes across seven messages; four typed input
changes and an explicit parent render add zero price renders
(`apps/desk/test/react.test.tsx:96`). Lifecycle assertions include two mounted
tiles, last-unmount shutdown, no transport traffic while hidden, and a
StrictMode remount (`apps/desk/test/react.test.tsx:139`).

The repository and examples supplied enough API to complete this slice. Keep
boundary decoding, observable lifetime, and displayed equality separate: each
has a different owner and a different assertion in these tests.

# Building the second desk slice

The second slice keeps Pinna's observation-owned price stream and adds a
checked execution state, model-owned input, and a keyed trade collection
(`apps/desk/src/client/desk.ts:33`, `apps/desk/src/client/trades.ts:14`).
The first slice's account above is historical: its React-local notional has
been replaced. Observations below describe repository evidence; decisions
and inferences describe how this application uses it.

## The five largest frictions

### 1. A checked state does not require a serialized model

**Needed:** asynchronous writes must reject any execution state outside the
five permitted values. **Observed:** `packages/pinna/AGENTS.md:29` distinguishes
unchecked `box` from checked `schemaBox`; its model guidance then introduces
`SchemaModel` and `BoxField` at `packages/pinna/AGENTS.md:44`. The standalone
example in `README.md:42` and the explicit statement at `README.md:58` resolve
whether validation requires adopting the whole model format. I also read
`packages/pinna-effect/src/box.ts:17`: it installs both the schema check and
schema equality on the ordinary box implementation.

**Decision:** keep `Desk extends Model` and use a named `schemaBox` of a
literal schema for `$execution` (`apps/desk/src/client/desk.ts:35`). A type
union over plain `box` would only protect typed callers. A `SchemaModel`
with a `BoxField` would work, but adds a wire model that this local workflow
does not need. **Observed:** the deliberately invalid write throws
`the box rejects this value` and leaves idle intact
(`apps/desk/test/execution.test.ts:160`). **Inference:** the documentation's
model categories are useful defaults, but the standalone example is needed
to discover this smaller composition confidently.

### 2. Editable input and an executable decimal are different values

**Needed:** React and headless execution must share the notional, including
invalid intermediate edits. **Observed:** the first slice records its choice
of React-local input in this file's first API discussion. The application
rules require external input to go through a schema
(`packages/pinna/AGENTS.md:29`), while derivations belong on the model
(`packages/pinna/AGENTS.md:35`). Neither that rule nor the model example at
`docs/dx.md:70` explains how an editable empty string coexists with a positive
amount constraint.

**Decision:** `$notional` is a `schemaBox(Schema.String)`; `PositiveDecimal`
checks eligibility through `$canExecute`, and the workflow checks that value
again before sending (`apps/desk/src/client/desk.ts:34`,
`apps/desk/src/client/desk.ts:55`, `apps/desk/src/client/wire.ts:35`). This moves
the first slice's input into the model without turning temporary invalid edits
into thrown input events. A `BoxField(PositiveDecimal)` would reject clearing
the input. A parsed JavaScript number would lose decimal precision. React
local state would leave the headless workflow without an owner for input.
The headless test sends an amount smaller than ordinary floating-point input
handling should be trusted to preserve (`apps/desk/test/execution.test.ts:132`).

**Assumption:** the desk accepts digits with an optional fractional part that
has digits on both sides of the decimal point. Leading zeros are allowed;
signs, exponent notation, whitespace, `.5`, and `1.` are rejected. Positivity
is checked without converting to `Number`
(`apps/desk/src/client/wire.ts:35`). **Inference:** an explicit editable-input
example would make this boundary easier to discover than a numeric field
example alone.

### 3. Keyed rows need both validation and equality after decoding

**Needed:** isolate row renders, reject malformed rows individually, and merge
snapshot/topic overlap without duplicates. **Observed:** `docs/dx.md:140`
distinguishes `.keys`, `.rows`, and `.row(key)`; `docs/dx.md:151` says plain
collections check nothing and compare rows with `Object.is`. The collection
example supplies explicit equality at
`apps/playground/src/docs/collections.tsx:18`. I read
`packages/pinna/src/collection.ts:259` to confirm an upsert preserves an existing
key's position and `packages/pinna/src/collection.ts:399` to confirm an equal
row keeps its existing identity. I read `packages/pinna/src/collection.ts:222`
to confirm an update lookup through `read.row` does not allocate a row cell.

**Decision:** decode each unknown row, then `write.upsert` a plain immutable
trade into a `collection` with schema-derived equality
(`apps/desk/src/client/trades.ts:15`, `apps/desk/src/client/trades.ts:47`,
`apps/desk/src/client/wire.ts:63`). Decode the snapshot envelope as unknown
items so one invalid trade cannot discard valid neighbors
(`apps/desk/src/client/wire.ts:59`). Every optimistic row takes the same check.
A `CollectionField(Trade)` would require a `SchemaModel` owner and still need
per-message error recovery; a box of an array would notify the whole list;
`reconcileSchema` is unnecessary because individual trade objects are replaced
as whole checked records, rather than merged into models.

The list derives newest-first keys and compares their contents, while memoized
rows subscribe to `.row(id)` (`apps/desk/src/client/trades.ts:20`,
`apps/desk/src/client/blotter.tsx:15`). `.rows` is used only to compute the small
list's sorted key order; its status-driven recomputations do not render the
list when the order stays equal. New keys retain insertion precedence when
timestamps tie (`apps/desk/test/trades.test.ts:160`). **Inference:** decoding
and keyed storage are separate responsibilities; choosing `collection` alone
does not satisfy either boundary checking or duplicate-object suppression.

### 4. A collection feed is not the scalar feed in the guide

**Needed:** open the trade topic only while the blotter is observed, subscribe
before requesting a snapshot, and prevent an old snapshot from overwriting a
new topic update. **Observed:** `docs/dx.md:334` documents `fromStream` as a
read-only stream value. Its implementation writes each emitted value into one
box (`packages/pinna-effect/src/programs.ts:164`), captures services at creation
(`packages/pinna-effect/src/programs.ts:153`), and interrupts its fiber when
observation ends (`packages/pinna-effect/src/programs.ts:176`). Those source
reads establish the lifetime, but do not supply a keyed snapshot-plus-topic
reducer.

**Decision:** keep that adapter as a private revision signal. Its callback
owns a scoped topic reader, applies checked messages to the collection, then
loads and merges the snapshot (`apps/desk/src/client/trades.ts:84`). The list's
computed value reads the signal to own the feed. Start the reader immediately
before snapshot loading, preserve newer `updatedAt` values, and never regress
a terminal row to pending (`apps/desk/src/client/trades.ts:52`,
`apps/desk/src/client/trades.ts:95`). A delayed stale-snapshot test verifies
that ordering (`apps/desk/test/trades.test.ts:59`). A permanently forked topic
would outlive the view; manual `onObserved` would duplicate the adapter's
context and shutdown code; a `fromStream` array would lose per-key storage.

**Error encountered:** the delayed reference from `$feed` to `book` produced
`'$feed' implicitly has type 'any' because it does not have a type annotation
and is referenced directly or indirectly in its own initializer`, followed by
the equivalent error for `book`. Annotating `$feed: Computed<number>` breaks
the inference cycle (`apps/desk/src/client/trades.ts:84`). **Inference:** a
keyed feed example, rather than another scalar stream example, would remove
most of this plumbing discovery.

### 5. Observation cancellation and order cancellation have different owners

**Needed:** stop client request work on unmount, preserve accepted server work
for late fills, and prevent an old reset timer from changing a newer execution.
**Observed:** `watchScoped` interrupts its running effect when the selected
value changes (`packages/pinna-effect/src/programs.ts:35`); `fromStream`
interrupts on last-observer release
(`packages/pinna-effect/src/programs.ts:179`). Neither is an execution-command
API. The adapter's captured-context runner at
`packages/pinna-effect/src/programs.ts:177` provided the pattern for retaining
the application's TestClock when a later React event starts work.

**Decision:** use an explicit `execute` Effect callable without React, plus
a captured-context event runner and synchronous cancellation that invalidates
the active request before interruption
(`apps/desk/src/client/desk.ts:52`, `apps/desk/src/client/desk.ts:138`,
`apps/desk/src/client/desk.ts:200`). Guard asynchronous writes and the reset
timer by request identity; `useEffect` cleanup invokes cancellation
(`apps/desk/src/client/desk.ts:71`, `apps/desk/src/client/spot-tile.tsx:56`).
A watch of `$execution` would react to the workflow's own state writes; a
separate intent box plus `watchScoped` would add state without simplifying
ownership. `changes` supplies a value stream, not request ownership.

The exchange forks accepted processing into its own scope; interrupting the
client's join cannot cancel that processing
(`apps/desk/src/exchange/index.ts:117`). A timed-out client drops its pending
row, and a subsequent topic fill restores one checked row under the same ID
(`apps/desk/test/execution.test.ts:113`). **Inference:** Pinna owns observable
lifetimes, while command lifetimes still need explicit Effect/application
ownership. They should not be inferred from a pending status field.

**Error encountered:** the first scenario helper returned its Promise from a
function containing `using realm = testRealm()`. The realm disposed before
the asynchronous scope closed and threw
`The test realm is not at rest: watch still running; watch still running.`
The source confirms disposal stops the watches before throwing
(`packages/pinna/src/testing/index.ts:104`). Make the helper asynchronous
and `return await` the scoped run so disposal follows completion
(`apps/desk/test/execution.test.ts:16`). This was an application lifetime bug;
the leak check exposed it before it could silently affect another test.

## Pinna APIs selected for this slice

| API | Choice and alternative |
| --- | --- |
| `Model` | Keep explicit application ownership and methods. `SchemaModel` is unnecessary without a serialized observable class (`apps/desk/src/client/desk.ts:33`, `apps/desk/src/client/trades.ts:14`). |
| `schemaBox` | Check the five execution states at every write; keep input checked as text. Plain `box` would not enforce the state schema; `BoxField` would require a different owner (`apps/desk/src/client/desk.ts:34`). |
| `computed` with `equals` | Derive eligibility, displayed prices, and sorted keys; compare displayed data and key contents. A fresh `useSelect` result would need its own equality and a provider (`apps/desk/src/client/desk.ts:36`, `apps/desk/src/client/trades.ts:20`). |
| `collection` with `equals` | Store one checked immutable trade per ID and retain equal rows. Array boxes would invalidate readers together (`apps/desk/src/client/trades.ts:15`). |
| `update`, `write.upsert`, `write.remove` | Bound box writes, merges, and withdrawals. Whole-list replacement would complicate overlap with live messages (`apps/desk/src/client/trades.ts:51`, `apps/desk/src/client/trades.ts:74`). |
| `read.row` | Inspect a held trade during a write without allocating a tracked row cell. React instead reads `.row(id)` to subscribe to one row (`apps/desk/src/client/trades.ts:52`, `apps/desk/src/client/blotter.tsx:15`). |
| `untracked` | Snapshot workflow inputs and test state inside a valid read place. No captured `read` escapes its place (`apps/desk/src/client/desk.ts:55`). |
| `fromStream`, `RealmService` | Retain the price adapter and give the trade reader observation ownership in the same realm and Effect context. Avoid a second manual fiber bridge (`apps/desk/src/client/desk.ts:199`, `apps/desk/src/client/trades.ts:84`). |
| `useValue`, `useValues` | Subscribe rows and controls to known observables. `useSelect` adds no useful derivation here; `memo` isolates parent renders (`apps/desk/src/client/blotter.tsx:15`, `apps/desk/src/client/spot-tile.tsx:50`). |
| `observeScoped` | Hold prices and trades in headless tests without React or manual release (`apps/desk/test/execution.test.ts:36`). |
| `testRealm`, `record` | Detect leaked watches and record every state/row change across unmount. Comparing only the final value could miss a write followed by rollback (`apps/desk/test/react.test.tsx:400`). |

The existing `createRealm`, `observe`, and `held` uses remain from the first
slice (`apps/desk/src/main.tsx:16`, `apps/desk/test/react.test.tsx:214`).
`Computed` and `Realm` describe the read-only feed and its explicit owner
(`apps/desk/src/client/trades.ts:39`). No Pinna internal API is imported by
the application (`apps/desk/src/client/trades.ts:1`).

## Protocol decisions and verification evidence

**Decisions:** local IDs are `local-N` for this one desk instance and survive
optimistic/response/topic reconciliation. Other desks use exchange IDs.
The exchange treats acceptance as durable within its scope; client timeout
cancels waiting, rather than reversing a trade
(`apps/desk/src/client/desk.ts:62`, `apps/desk/src/exchange/index.ts:117`).
Local rejected trades are withdrawn even when echoed on the topic or returned
in a later snapshot; other desks' rejections remain visible. Withdrawn pending
IDs cannot reappear from a stale snapshot, but their terminal fills can
(`apps/desk/src/client/trades.ts:59`). This resolves the requirement to withdraw
local rejection rows while still broadcasting rejected exchange trades.

The exchange options document other-desk frequency as probability per market
tick. Defaults are 0.08 per tick, 100–700 milliseconds normal latency, 0.12
rejection probability, 0.08 long-delay probability, and 4,000 milliseconds
long delay (`apps/desk/src/exchange/index.ts:53`). All new randomness comes
from the exchange's seeded generator, with execution decisions drawn at order
placement (`apps/desk/src/exchange/index.ts:102`). Decimal values stay strings;
ISO timestamps use the Effect clock (`apps/desk/src/exchange/index.ts:93`).

The independent oracle imports only the neutral log type and folds requests,
snapshots, and whole-trade messages. An explicit clock argument advances
timeout/reset deadlines without requiring a new wire message
(`apps/desk/test/oracle.ts:1`, `apps/desk/test/oracle.ts:41`). Its generated run
uses a separate seeded generator to choose client execution moments, observes
all five execution states, and compares state after every tick and execution
start across 1,000 ticks (`apps/desk/test/execution.test.ts:182`).

Malformed snapshot rows, malformed topic rows, bad JSON, and malformed or
unrelated execution answers are counted through a captured logger and dropped
(`apps/desk/test/trades.test.ts:12`, `apps/desk/test/trades.test.ts:93`). Exact
React counts are first row 1 then 2 on its own status change, second row 1
then 2 on its own status change, and no row renders across three price ticks;
the price renders once initially and once per changed tick, with none for
trade adds or changes (`apps/desk/test/react.test.tsx:224`). Unmount checks
request interruption, both topics closing, and no later writes from immediately
after unmount through eight seconds of simulated time
(`apps/desk/test/react.test.tsx:376`).

Additional check errors were TypeScript assertion overloads rejecting broad
fixture strings against client literal types, followed by readonly-array
incompatibility after reversing the assertion. Compare a mutable copy of the
actual rows against the independently typed fixture
(`apps/desk/test/trades.test.ts:35`). The scenario helper's error type also
needed to admit transport failures once its assertion requested `/trades`
(`apps/desk/test/execution.test.ts:16`). Biome required normal formatting,
import ordering, and removal of a non-null assertion; the oracle snapshot now
throws explicitly if a listed key has no held trade
(`apps/desk/test/execution.test.ts:210`).

**Documentation constraint:** `AGENTS.md:73` names `documentation-voice`, but
that skill was absent from the supplied skill catalog and the searched local
skill roots. This findings continuation follows the existing file's explicit
observation/decision/inference format. Pinna knowledge came only from the
repository; Context7 was used for Effect 4.1.0's fork/scope API, not Pinna.

## Second-slice check results

Final checks ran from the worktree root, after the implementation and findings
were complete. Earlier failures and their fixes are recorded above.

| Command | Final result |
| --- | --- |
| `bun run --cwd apps/desk typecheck` | Exit 0. |
| `bun run --cwd apps/desk test` | Exit 0; 25 tests passed, 0 failed, 4,577 assertions. |
| `bunx biome check apps/desk` | Exit 0; 21 files checked, no fixes applied. |
| `bunx biome check --write apps/desk` | Exit 0; formatting and import organization applied only under the desk. |
| `git diff --check` | Exit 0. |

No production build or browser session was run for this slice. React behavior
was exercised in the installed DOM test environment, with Effect's TestClock
for asynchronous work (`apps/desk/test/setup.ts:1`,
`apps/desk/test/react.test.tsx:376`). No requested implementation remains open.

Keep command cancellation separate from exchange acceptance: a timed-out
request can still produce a trade, so identity must survive both delivery paths.

# Building the third desk slice: the blotter at scale

The blotter now keeps its view state in `TradeBook`, maintains an ordered
index as messages arrive, and renders a fixed-height window. The trade
collection still owns checked rows and per-key subscriptions
(`apps/desk/src/client/trades.ts:43`, `apps/desk/src/client/blotter.tsx:26`).
The remaining linear cost for a new trade is Pinna's collection order copy,
not a full-list derivation (`packages/pinna/src/collection.ts:280`).

## Friction recorded during implementation

### 1. A keyed collection isolates renders but does not make new keys constant work

**Needed:** cheap ingestion at 100,000 held trades. **Observed:** the authoring
guide describes per-key tracking and the full `.rows` read, without a cost
model (`docs/dx.md:140`). The playground's whole-list sum is appropriate for
its example, but reads every row (`apps/playground/src/docs/collections.tsx:68`).
Reading package source established the distinction: existing keys update a
map entry and optional cell (`packages/pinna/src/collection.ts:266`), a new key
copies the order (`packages/pinna/src/collection.ts:280`), and removal scans
and copies it (`packages/pinna/src/collection.ts:303`). The previous slice's
whole-list sort hid that distinction behind larger application work.

**Decision:** retain `collection` for keyed subscriptions, but never read
`.rows` in the production blotter. Keep ordered trade references in an
application index and take only the required ranks
(`apps/desk/src/client/trades.ts:68`, `apps/desk/src/client/trade-index.ts:149`).
**Inference:** constant-work insertion is unavailable through the documented
collection write API. A custom map behind atoms could avoid the order copy,
but would replace Pinna's keyed storage and require application-owned
notification and cleanup. That alternative also conflicts with the prescribed
collection pattern for lists (`packages/pinna/AGENTS.md:53`). I did not add an
internal API, shard collections, or weaken boundary validation.

### 2. Cached derivation is not an incremental sorted and filtered query

**Needed:** change a row without sorting all held trades, and scroll without
materializing all matching IDs. **Observed:** `computed` caches and compares
results (`docs/dx.md:137`); the documented collection reads expose keys, rows,
and individual keys (`README.md:183`). Those sources give no indexed sort,
filter, or rank operation. An equal array suppresses notifications but cannot
recover the cost of producing it.

**Decision:** use persistent AVL trees for the complete order and the matching
order. Each changed trade replaces only its search paths. Their roots live in
plain boxes written atomically with the collection
(`apps/desk/src/client/trades.ts:178`). Filtering scans the complete order and
builds an already ordered matching tree; it does not sort again
(`apps/desk/src/client/trade-index.ts:176`). With an empty filter the roots
share the same tree. A custom mutable tree plus `atom` was considered:
`docs/dx.md:294` describes outside state, but it would also require application
rollback for that state. Persistent roots use Pinna's existing box rollback
instead (`docs/dx.md:129`). No source read beyond the public box/update
contract was required for the trees.

**Observed during measurement:** the first implementation sorted on each
filter edit. At 100,000 trades its median filter edit was 133.998 ms; retaining
the full order removed that unnecessary sort. This was application work,
not a Pinna error. **Inference:** an example distinguishing notification
suppression from computation suppression would prevent a plausible small-list
pattern from becoming the large-list implementation.

### 3. A stream observation is neither snapshot completion nor a bulk write

**Needed:** retain the subscription lifetime from earlier slices while loading
100,000 independently checked rows. **Observed:** `fromStream` owns one scalar
value (`packages/pinna-effect/src/programs.ts:158`), starts work through a
captured Effect context (`packages/pinna-effect/src/programs.ts:177`), and
interrupts it when observation ends (`packages/pinna-effect/src/programs.ts:179`).
These source reads were necessary to confirm that a stream emitting no
revision messages could still own the keyed feed. The collection supports
`replaceAll` (`docs/public/state/collections.md:83`), and its source constructs
one next map and order for that operation
(`packages/pinna/src/collection.ts:313`).

**Decision:** `$window` and the compatibility `$keys` read the private feed
only for ownership. The stream no longer emits a revision per trade. Decode
each snapshot row independently, merge against the current book after decoding,
then publish one collection replacement and the index roots in one update
(`apps/desk/src/client/trades.ts:213`). This preserves malformed-neighbor
isolation and snapshot/topic precedence without quadratic repeated key copies.
A `fromStream` array would lose per-key subscriptions; repeated upserts in
one update still copy the order on every insertion.

**Error encountered:** the first large-load tests asserted after
`TestClock.adjust(0)` and failed with `Expected: 10000; Received: 0`, and the
same failure for 100,000. A clock adjustment did not establish completion of
the long decoding program. Add `$loaded` and await its first true value with
`changes`, while holding `$window` observed
(`apps/desk/src/client/trades.ts:242`, `apps/desk/test/scale.test.ts:43`). This
is explicit readiness, not a real-time sleep. The old small-load tests remain
valid. **Inference:** a bulk keyed-feed example with a readiness signal would
remove both the lifetime and settling guesswork.

### 4. Row selection needs a bounded selector lifetime as well as stable identity

**Needed:** select trades across filters and sorts, render only affected
visible rows, and retain no per-ID selector registry forever. **Observed:**
`computedFunction` entries are shared while observed and dropped afterward
(`README.md:169`, `README.md:247`); the brief authoring-guide description does
not show row selection (`docs/dx.md:301`). A collection's tracked row cells
are retained while their keys are held, even after a view stops reading them
(`docs/public/state/collections.md:64`). An untracked `read.row` allocates
none (`packages/pinna/AGENTS.md:73`). Reading the collection's `row` and
`forget` implementations confirmed both lifetimes
(`packages/pinna/src/collection.ts:226`, `packages/pinna/src/collection.ts:468`).

**Decision:** keep selected, validated held IDs in one immutable array box;
use `computedFunction` for each mounted row's boolean membership and
`computed` for exact decimal totals over selected trades
(`apps/desk/src/client/trades.ts:89`). No permanent map of booleans or
computed values is necessary. A selection collection would add another
ordered store; passing the whole selected array as a row prop would render
every visible row when it changed. `useSelect` could compute membership,
but would add the provider and selector lifetime described at
`packages/pinna/AGENTS.md:68`. **Inference:** the documented lifetime is enough
once found; an explicit selection example would make the intended use clear.

### 5. Withdrawal bookkeeping was an application protocol problem

**Needed:** prevent stale pending echoes from restoring withdrawn orders
without keeping an unbounded set of withdrawn IDs. **Observed:** collection
removal releases its present-key cell and row registry
(`packages/pinna/src/collection.ts:468`). It cannot release an application's
separate tombstone set. The earlier-slice protocol already distinguishes
local execution from incoming topic messages
(`apps/desk/src/client/desk.ts:77`, `apps/desk/src/client/trades.ts:275`).

**Decision:** only optimistic execution may introduce a local pending row.
A wire pending message can update an existing local row, but cannot introduce
one. Local rejection removes the row and selection; a terminal late fill can
still introduce the done trade (`apps/desk/src/client/trades.ts:159`). Remove
the withdrawn-ID set entirely. A time-to-live tombstone cache would require
an expiry policy and could fail after delayed snapshots; a high-water mark
would assume ID ordering. Neither is needed for this single-client protocol.
**Assumption:** `local` denotes this application's execution origin; recovering
another client instance's in-flight pending orders is outside this slice.
**Inference:** Pinna's cleanup behaved as documented; the permanent set was
not a library retention defect.

## Pinna APIs selected for this slice

| API | Choice and alternative |
| --- | --- |
| `Model`, `Realm` | Retain `TradeBook` ownership across component mounts; no serialized observable class is needed (`apps/desk/src/client/trades.ts:43`). |
| `schemaBox` | Check sort, text filter, finite nonnegative scroll position, and viewport height. React local state would fail headless access and remount persistence; `SchemaModel`/`BoxField` would add an unused wire model (`apps/desk/src/client/trades.ts:48`). |
| `box` | Hold trusted index roots, counts, readiness, and selection normalized to held IDs. These are application-produced values, not unchecked wire trades (`apps/desk/src/client/trades.ts:52`, `apps/desk/src/client/trades.ts:135`). |
| `computed` with `equals` | Derive the window and compare only start, matching count, and the small ID array. A full sorted array or a fresh `useSelect` result would do more work or notify unnecessarily (`apps/desk/src/client/trades.ts:68`). |
| `computedFunction` | Share row membership selectors only while the row is mounted; avoids a growing manual selector map (`apps/desk/src/client/trades.ts:89`). |
| `collection`, `.row`, `read.row` | Retain checked immutable trades by ID, with schema equality for duplicates and row subscriptions only where needed. A box of trades would couple all row readers; `CollectionField` would require a schema model owner (`apps/desk/src/client/trades.ts:44`, `apps/desk/src/client/blotter.tsx:26`). |
| `update`, `write.upsert`, `write.remove`, `write.replaceAll` | Publish trades, indexes, counts, and selection changes atomically; replace the collection once for a snapshot (`apps/desk/src/client/trades.ts:178`, `apps/desk/src/client/trades.ts:225`). |
| `fromStream`, `RealmService` | Preserve observation-owned subscription work and the application's clock/context without a manual `onObserved` fiber bridge (`apps/desk/src/client/trades.ts:268`). |
| `useValue`, `useValues` | Subscribe the window, headers, controls, and memoized rows to their own observables; no shared provider or render-time derivation is needed (`apps/desk/src/client/blotter.tsx:26`, `apps/desk/src/client/blotter.tsx:55`, `apps/desk/src/client/blotter.tsx:123`). |
| `untracked`, `testRealm`, `observeScoped`, `changes` | Read settled headless state, detect leaked observers, hold the feed without React, and await snapshot readiness; no layout or wall-clock sleep is needed (`apps/desk/test/scale.test.ts:14`, `apps/desk/test/scale.test.ts:43`). |

`computed` also derives matching count and selection totals. Selection totals
read only selected trade keys, rather than scanning the full book
(`apps/desk/src/client/trades.ts:92`). The unchanged price tile retains its
previous observation and equality choices.

## Behavior, costs, and evidence

**Decisions:** primary sort direction applies only to the chosen column.
Ties use newest creation time and then descending trade ID, in either sort
direction. Notional and rate compare exact positive decimal strings; selection
sums align decimal scales and use integers
(`apps/desk/src/client/trade-index.ts:30`, `apps/desk/src/client/trade-index.ts:43`,
`apps/desk/src/client/trade-index.ts:53`). Filtering uses the seven rendered
column values, including the displayed UTC time, without adding hidden ID or
update-time matches (`apps/desk/src/client/trade-index.ts:12`).

Rows are 36 pixels high with three extra rows on either side. A window clamps
the requested scroll position to the matching extent, includes a partially
visible final row, and renders no trade rows for a zero-height viewport
(`apps/desk/src/client/trades.ts:68`). Layout effects synchronize the real
scroll element and an optional `ResizeObserver` reports a nonzero browser
height; happy-dom can use model state directly
(`apps/desk/src/client/blotter.tsx:123`).

For `n` held trades, `m` matching trades, `k` window rows, and `s` selected trades:

| Operation | Work and remaining limit |
| --- | --- |
| Held-trade change | Index paths `O(log n + log m)`, or one shared tree without a filter; a window read is `O(log m + k)`. Collection replacement under a held key does not scan `n`. A selected trade also recomputes its `O(s)` selection summary, including status-only changes. |
| New trade or withdrawal | The same index work plus Pinna's unavoidable `O(n)` key-order copy; withdrawal can also copy `s` selection IDs. The public collection API has no unordered write. |
| Snapshot | Independent validation, one merge/replacement, and `O(n log n)` initial ordering; no repeated insertion copies. |
| Sort | `O(n log n)` ordering and `O(n)` rebuilding. The complete order is retained so later filters do not sort it again. |
| Filter keystroke | `O(n)` scanning of shown text plus `O(m)` matching-tree construction. Arbitrary case-insensitive substring matching still requires inspecting each trade. |
| One-row scroll | `O(log m + k)` for the rank window; retained row components keep their keys. |
| Selection | Summary `O(s)`; visible membership checks `O(k * s)` after a selection edit. Selection is bounded by held IDs. |

Decimal and text lengths add their own comparison costs. A caller explicitly
observing the compatibility `$keys` asks for all matching IDs and adds `O(m)`
work per order change; neither the UI nor `measure` does that
(`apps/desk/src/client/trades.ts:59`, `apps/desk/scripts/measure.ts:53`).

The exchange seeds the default 1,000 trades across four hours and four desks,
with pending, done, and rejected statuses. `historyTradeCount` controls the
size; `otherDeskTradesPerSecond` overrides the legacy probability and carries
fractional placements between ticks, accepting rates through 1,000 per second
(`apps/desk/src/exchange/index.ts:7`, `apps/desk/src/exchange/index.ts:103`,
`apps/desk/src/exchange/index.ts:171`). Other desks publish a second pending
revision before the terminal result (`apps/desk/src/exchange/index.ts:140`).
Earlier execution fixtures explicitly request zero history to preserve their
focused assertions (`apps/desk/test/execution.test.ts:25`).

The independent oracle imports only the transport log type. It folds all
messages, materializes matching trades, sorts them, slices the window, and
sums selection with separate decimal arithmetic
(`apps/desk/test/oracle.ts:1`, `apps/desk/test/oracle.ts:158`). The 10,000-trade
scenario compares after the initial load and before and after each of 40
seeded view changes, with other desks placing 300 trades per simulated second
(`apps/desk/test/scale.test.ts:28`). A separate test covers every column and
both directions, precision beyond Number, hidden selection, and withdrawal
(`apps/desk/test/scale.test.ts:120`).

Exact React checks start with eight window rows from 100 held trades. A changed
visible row renders once, a changed off-window row zero times, and a one-row
scroll renders only the entering row. An all-matching filter edit renders zero
rows; a restrictive edit renders the eight newly entering rows; the sort
change renders its eight newly entering rows. None renders the price tile,
and a price tick renders neither blotter nor rows. Selection by ordinary,
Command, and Control clicks and all five view settings survive remount
(`apps/desk/test/react.test.tsx:439`).

The retention test runs 100 executions across 510 simulated seconds, observes
fills, rejections, and timeouts, checks selection, both index trees, and the
collection's held/cell/row maps, then withdraws every remaining row. It also
replays stale local pending messages through both ingestion paths
(`apps/desk/test/scale.test.ts:181`, `apps/desk/test/scale.test.ts:208`). These
checks inspect private tables only in tests; production imports no Pinna
internals. **Limit:** this is a retained-key audit, not a garbage-collector heap
proof. The exchange's durable history and the transport's intentional message
log are separate from client bookkeeping (`apps/desk/src/transport.ts:27`).

## Errors and verification notes

No new Pinna runtime failure occurred. The first typecheck passed. The first
full test run exposed the oracle's old arrival-order tie assumption; it now
uses the required total order (`apps/desk/test/oracle.ts:135`). Large-snapshot
readiness failures are recorded above. An initial 90-step scale oracle timed
out with `this test timed out after 10000ms`; repeated timestamp parsing while
sorting made the plain oracle unnecessarily expensive. Compare canonical ISO
timestamps as text and keep 40 seeded changes, with all column/direction
combinations tested separately. The full script now stays well below ten
seconds (`apps/desk/test/scale.test.ts:61`).

Biome initially rejected `aria-label` on a paragraph and hidden/presentation
roles on spacer rows. Use a labeled `output` for the summary and ordinary
spacer rows instead (`apps/desk/src/client/blotter.tsx:75`,
`apps/desk/src/client/blotter.tsx:159`). Its formatter also normalized imports
and wrapping. Context7 was used only for Effect 4.1.0 scope, forking, and test
clock details. All Pinna API decisions came from this repository.
`documentation-voice` is still absent from the available skill catalog and
local skill roots; this continuation follows this file's existing
observation/decision/inference register.

## Third-slice measurement

Measured on an Apple M1 Pro, arm64, Darwin 24.6.0, Bun 1.4.4
(JavaScriptCore, concurrent JIT disabled). The script prints machine/runtime
information (`apps/desk/scripts/measure.ts:149`). The following is a single
local run; these numbers gate nothing.

Snapshot timing starts when the window is observed and ends at `$loaded`;
it includes the in-memory HTTP snapshot serialization, envelope parsing,
per-row checking, merge, and indexing, and excludes generating exchange
history and constructing the desk (`apps/desk/scripts/measure.ts:52`). Incoming
samples traverse the production string transport and topic reader, including
JSON parsing and schema checking. They finish after the keyed state signal
and observed view state have settled (`apps/desk/scripts/measure.ts:91`).
There are 20 warm-up insert/update pairs and 250 measured pairs. Sort uses
four representative transitions, filtering types `desk-2` one character at a
time, and scrolling uses 250 one-row changes. The Effect clock is frozen;
wall time comes from `performance.now`. No React rendering is included.

| Milliseconds | 10,000 history trades | 100,000 history trades |
| --- | ---: | ---: |
| Snapshot load | 90.667 | 409.487 |
| New incoming trade, median / 95th percentile | 0.047 / 0.549 | 0.760 / 1.536 |
| Held-trade update, median / 95th percentile | 0.028 / 0.589 | 0.027 / 0.520 |
| Change sort, median / 95th percentile | 13.559 / 39.041 | 195.438 / 369.387 |
| Filter keystroke, median / 95th percentile | 5.275 / 7.816 | 62.694 / 63.601 |
| Scroll one row, median / 95th percentile | 0.001 / 0.002 | 0.001 / 0.002 |

| Filter text | 10,000 history trades, ms | 100,000 history trades, ms |
| --- | ---: | ---: |
| `d` | 5.831 | 48.568 |
| `de` | 7.816 | 63.601 |
| `des` | 3.238 | 62.338 |
| `desk` | 5.275 | 62.694 |
| `desk-` | 4.071 | 62.548 |
| `desk-2` | 3.824 | 63.343 |

**Inference:** flat held-trade update and scrolling medians are consistent
with the bounded view and logarithmic index paths; new-trade growth is
consistent with the source's collection order copy. These two sizes do not
prove asymptotic behavior. Sort and filtering still block synchronously;
100,000-trade measurements make that visible instead of hiding the work
behind render suppression.

## Third-slice check results

| Command, from the worktree root | Final result |
| --- | --- |
| `bun run --cwd apps/desk typecheck` | Exit 0. Includes the measurement script. |
| `bun run --cwd apps/desk test` | Exit 0; 30 passed, 0 failed, 7,844 assertions; 4.31 seconds. |
| `bun run --cwd apps/desk measure` | Exit 0; both sizes completed; numbers above. |
| `bunx biome check apps/desk` | Exit 0; 24 files checked. |
| `bunx biome check --write apps/desk` | Exit 0 on the final formatting pass; earlier accessibility errors fixed. |

Keep list identity, row subscriptions, and the cost of producing the list
separate: suppressing a render does not remove ingestion or query work.

# Building the fourth desk slice: five pairs and positions

The desk now holds one price stream and one execution model per listed pair,
with a workspace controlling which tiles and panels are visible
(`apps/desk/src/client/desk.ts:209`, `apps/desk/src/client/desk.ts:263`).
The exchange has five independent seeded walks and staggered tick intervals
(`apps/desk/src/exchange/index.ts:108`, `apps/desk/src/exchange/index.ts:180`).
The existing keyed trade collection and persistent blotter index stay in place;
position aggregates are written in the same transaction as a trade revision
(`apps/desk/src/client/trades.ts:194`). No package API or dependency was added.

## Arithmetic and the definition of average

**Decision:** let a buy have sign +1 and a sell sign -1. For all held done
trades of a pair, retain count, signed quantity Q = sum(sign × notional), and
signed cost C = sum(sign × notional × rate). Net position is Q. Average rate
is C / Q when Q is nonzero, and absent when Q is zero. This is the rate at
which the entire held book breaks even, including the profit or loss of
offsetting trades. It can lie outside the traded rates and does not represent
FIFO inventory accounting. A flat pair still has a row if it holds done
trades, and can still have profit or loss. The implementation is
`apps/desk/src/client/position-book.ts:32` and
`apps/desk/src/client/positions.ts:62`; the independent oracle uses the same
definition at `apps/desk/test/oracle.ts:388`.

**Observed:** the row computes mark M = (bid + ask) / 2 and quote-currency
profit or loss Q × M - C (`apps/desk/src/client/positions.ts:24`,
`apps/desk/src/client/positions.ts:48`). This is algebraically the requested
sum over trades. Pending and rejected contributions are skipped; a revision
subtracts the previous done contribution and adds the next one inside the
trade transaction (`apps/desk/src/client/position-book.ts:32`). Snapshot
replacement rebuilds the aggregates from the merged held book
(`apps/desk/src/client/trades.ts:238`). Withdrawal removes its contribution
(`apps/desk/src/client/trades.ts:265`). No per-trade position graph is retained.

**Decision:** use reduced BigInt fractions for exact decimal input, products,
midpoints, division, and averages (`apps/desk/src/client/decimal.ts:1`).
Division by USD/JPY can repeat forever; keeping a fraction avoids choosing an
early decimal precision. GBP profit or loss multiplies by GBP/USD's mid; JPY
profit or loss divides by USD/JPY's mid. Each result becomes signed integer
cents, half to even, before addition into the total
(`apps/desk/src/client/positions.ts:50`, `apps/desk/src/client/positions.ts:83`).
Unknown marks or converters yield an absent dollar amount and an incomplete
total. The UI rounds only for presentation, including one extra mark digit
to preserve half-point mids (`apps/desk/src/client/workspace.tsx:26`).

The playground's positions example uses Effect BigDecimal, but its display
converts through Number (`apps/playground/src/positions-view.tsx:20`). I did
not copy that presentation helper. Fractions preserve exact JPY division
until the required half-even cent boundary; no arithmetic dependency or
Pinna extension is needed.

## The five most expensive frictions

### 1. Finding an incremental aggregate pattern without a second write phase

**Needed:** constant work per trade for positions, including status changes,
with no watcher seeing the new trade and the old position. **Observed:** the
guide's collection example derives a list result by reading all rows
(`docs/dx.md:85`), while its transaction rules say nested updates join and
watchers see the end state once (`docs/dx.md:129`). The public export list
provides `Read` and `Write` capabilities (`packages/pinna/src/index.ts:3`),
and the actual update closes its batch only after the recipe finishes
(`packages/pinna/src/observable.ts:1094`). I found no incremental aggregation
recipe in those examples or the API table (`README.md:163`).
**Decision:** pass the current read and write to `PositionBook.change` from
each existing trade mutation, rather than watching `$trades.rows` and writing
positions later. **Inference:** this application-maintained index is easy to
express once the mutation boundary is known; the documentation makes the
all-rows computed example easier to find than the incremental pattern.

### 2. A conversion price has several reasons to stay subscribed

**Needed:** GBP/USD must remain subscribed for EUR/GBP even after its own tile
closes. Hiding the panel must remove that reason. **Observed:** computed values
observe their dependencies only while observed (`README.md:245`), and hooks
lost and regained within one update do not restart (`docs/dx.md:286`). I read
the stream adapter to verify captured services, retained values, and fiber
interruption (`packages/pinna-effect/src/programs.ts:134`,
`packages/pinna-effect/src/programs.ts:153`,
`packages/pinna-effect/src/programs.ts:176`).
**Decision:** one `fromStream` per pair, with each row reading its own price
and its converter. Unmount the panel; make the headless workspace view use
the same conditional reads (`apps/desk/src/client/desk.ts:214`). A separate
topic reference counter or `onObserved` bridge would duplicate Pinna's graph.
**Inference:** the conversion diamond is handled by ordinary dependency
tracking; the extra work was proving the lifetime of the Effect stream,
not implementing a subscription manager.

### 3. Granularity depends on where the aggregate lives

**Needed:** an EUR/USD trade must not rerender four unrelated position rows.
**Observed:** the application rules warn that replacing a box containing
models reruns every reader and prescribe per-key subscriptions for lists
(`packages/pinna/AGENTS.md:55`); computed equality defaults to identity
(`docs/dx.md:137`). The React implementation tracks exactly the supplied
observables and deactivates on unsubscribe
(`packages/pinna-react/src/index.ts:208`,
`packages/pinna-react/src/index.ts:268`).
**Decision:** keep five stable ledger models, each with one aggregate box,
and five stable row models with computed values. Derive the active symbols
with element-wise equality (`apps/desk/src/client/trades.ts:46`), so the
panel list does not rerender when only an existing row's quantities change.
The variable trade book still uses a collection; the fixed pair list needs
no keyed insertion/removal machinery. The total reads cached row values.
**Inference:** neither a single aggregate-map box nor a collection row per
trade is a cheap position index. The important boundary is per pair.

### 4. Model field initialization guarantees the realm, not constructor inputs

**Observed:** `README.md:184` promises that field initializers can read
`this.realm`; it does not promise that subclass parameter properties have
been assigned. I initially used the constructor's tile inside a computed
value's eager `name` option and received `TS2729: Property 'tile' is used
before its initialization`. The model base establishes only the realm
(`packages/pinna/src/observable.ts:139`).
**Decision:** use the fixed diagnostic name `Position.value` and read the
tile inside the lazy compute (`apps/desk/src/client/positions.ts:28`,
`apps/desk/src/client/positions.ts:68`). **Inference:** this is a TypeScript
initialization constraint, not a Pinna tracking failure. The same model field
syntax can look safe in the closure and fail in its adjacent eager options.

### 5. Simulated time advancing is not a large snapshot completion signal

**Observed:** `changes` promises the current value then changes
(`docs/dx.md:330`); it does not promise that a separate stream or an arbitrary
number of decoding effects have settled. An initial test using only
`TestClock.adjust(0)` saw the snapshot response in the wire log while the
client still had zero positions. The trade book already exposes `$loaded`
and writes it in the snapshot transaction (`apps/desk/src/client/trades.ts:256`).
**Decision:** await `changes($loaded)` before the first large-book assertion
(`apps/desk/test/positions.test.ts:81`); advance the test clock for subsequent
market work. Record synchronous `watch` deliveries with their log prefix
and workspace visibility, rather than recording through a sliding stream
(`apps/desk/test/positions.test.ts:59`). `changes` intentionally coalesces a
slow consumer (`packages/pinna-effect/src/programs.ts:87`).
**Inference:** a clock barrier and an application completion signal answer
different questions. No Pinna runtime errors occurred during this slice.

Other implementation diagnostics were ordinary type/lint failures, not
missing Pinna behavior: `TS2375` rejected optional render callbacks passed as
explicit `undefined` (the accepting props now allow it at
`apps/desk/src/client/workspace.tsx:14`); `noShadowRestrictedNames` rejected
the initial schema name `Symbol` (now `PairSymbol` at
`apps/desk/src/client/wire.ts:4`); the total's paragraph needed a supported
ARIA role (`apps/desk/src/client/workspace.tsx:45`). A render fixture's update
timestamp preceded its creation timestamp and correctly logged
`SchemaError: Expected <filter>`; the corrected test uses later timestamps
(`apps/desk/test/react.test.tsx:148`). The old invalid-pair fixture used GBP/USD,
which is now valid; it now uses USD/CAD (`apps/desk/test/trades.test.ts:18`).

## Pinna API choices in this slice

| API | Choice and alternative |
| --- | --- |
| `Model`, `box` | Stable per-pair ledger and workspace state after wire validation; avoids a single broad map box. No schema is weakened. |
| `schemaBox` | Retain validation of each tile's notional text and execution state, and blotter controls; no conversion to unchecked state. |
| `computed`, `equals` | Derive marks, profit or loss, dollars, the total, active symbols, and the conditional headless view; avoids manually synchronizing derived boxes with watch effects. Active-symbol equality suppresses list renders; row and total identity preserves one delivery per affected tick. |
| `fromStream` | One shared read-only price source per listed pair; avoids manual hooks, reference counts, and duplicate streams for the tile and position. The trade-feed adapter remains shared by blotter and positions. |
| `RealmService` | Use the same creation realm and Effect services for every pair; avoids a global singleton and separate realms that cannot share reads. |
| `update`, `Read`, `Write` | Apply position deltas inside the existing trade mutation, including replacement and withdrawal; avoids a later aggregate write and an inconsistent intermediate state. |
| `collection`, `read.row`, `write.upsert/remove/replaceAll` | Retain keyed held trades and granular blotter rows; no all-trade observable array. Position deltas inspect only the old and new trade. |
| `untracked` | Retained stream state, execution input, test snapshots, and benchmark settlement without acquiring price subscriptions; avoids holding subscriptions just to inspect them. |
| `useValue`, `useValues` | Bind small memoized row, total, and tile components to known observables; avoids `useSelect` layout effects and one broad workspace subscription in React. |
| `observeScoped`, `changes` | Own headless observations and await explicit load/arrival milestones in tests and measurements; avoids arbitrary real-time sleeps. |
| `watch`, `testRealm` | Record every synchronous subscriber receipt and assert teardown; avoids `changes` dropping intermediate receipts. Earlier `record` and `held` tests remain; the new recorder needs log-prefix metadata as well as the value. |

The earlier tile model is instantiated once per pair. A workspace now owns
the shared order-ID sequence, the trade book, tile visibility, and panel
visibility (`apps/desk/src/client/desk.ts:209`,
`apps/desk/src/client/desk.ts:269`). Callers now explicitly select their pair;
there is no first-pair compatibility property on the workspace. Input and
execution state remain separate for each tile. The prior selection, sort,
filter, and window state stay on the original trade book
(`apps/desk/src/client/trades.ts:60`).

## Guarantees the application relies on

| Guarantee | Repository statement and use |
| --- | --- |
| Atomic updates, including rollback; observers see the end state once | `README.md:173`, `docs/dx.md:129`. Trade collection, position deltas, and blotter index change together. Source confirmation: `packages/pinna/src/observable.ts:1104`. |
| Glitch-free derived reads; watchers run after settlement | `docs/dx.md:36`, `docs/design.md:58`. Tile prices, position marks, conversion dependencies, and the total form ordinary computed dependencies in one realm. No effect writes derived results. |
| Dynamic dependency removal and transitive observation | `README.md:245`, `README.md:257`. A hidden panel or closed tile stops reading prices; a conversion row independently retains its converter. |
| One first-observer start and last-observer cleanup; no churn within one update | `README.md:179`, `docs/dx.md:286`. Multiple tiles/rows share the same pair source without duplicate topic subscriptions. |
| Stream retains its last value, restarts with observation, and closes with its creation scope | `README.md:223`; detailed statement and implementation at `packages/pinna-effect/src/programs.ts:134`. The first resumed tick also receives the retained previous price through the application's map accumulation. |
| Equality suppresses notifications and per-key reads isolate rows | `docs/dx.md:137`, `docs/dx.md:147`. Active-symbol equality protects the list; collection row subscriptions protect the blotter. |
| React uses external-store snapshots and releases observations on unsubscribe | `packages/pinna/AGENTS.md:84`; source confirmation at `packages/pinna-react/src/index.ts:268` and `packages/pinna-react/src/index.ts:313`. Rows and totals render from the same settled graph. |
| Untracked inspection does not hold observation | `README.md:178`, `README.md:259`. Tests and measurements can inspect closed tiles without reopening their topics. |

These guarantees are stated in the repository; no unstated Pinna guarantee
was needed. Exact decimal arithmetic, status merging, and the choice to
unmount hidden panels are application responsibilities.

## Coverage and remaining costs

**Observed:** `apps/desk/test/positions.test.ts:15` loads 10,000 trades across
five pairs, advances a seeded clock with 120 other-desk trades/second, executes
several tiles concurrently, and opens/closes tiles and hides/shows the panel.
Twelve independent synchronous subscribers record every delivery, including
the coherent whole view; each delivered value is compared with a plain fold
of its log prefix (`apps/desk/test/positions.test.ts:133`). The oracle shares
no client arithmetic or Pinna code and rebuilds aggregates by scanning done
trades with independently scaled integers (`apps/desk/test/oracle.ts:279`).
Separate cases cover all five execution pairs, precise fractional notionals,
flat books, terminal corrections, half-even positive and negative ties, and
rounding each pair before summing (`apps/desk/test/positions.test.ts:271`,
`apps/desk/test/positions.test.ts:334`).
The topic-log test checks conversion-only observation, absent conversion
prices, last-reader release, reopening, and removal of the final done trade
(`apps/desk/test/positions.test.ts:177`). React tests assert exact tile, row,
total, and blotter counts for every pair's tick and visible done-trade updates,
plus no commits for an empty workspace under real simulated market ticks
(`apps/desk/test/react.test.tsx:52`, `apps/desk/test/react.test.tsx:211`).

**Cost:** position maintenance visits at most the previous and next trade and
five fixed ledgers; it never scans held trades
(`apps/desk/src/client/position-book.ts:32`). A tick recomputes only rows that
read that pair's source; the total then sums at most five cached rows
(`apps/desk/src/client/positions.ts:83`). That last sum is linear in the fixed
number of position rows, not strictly in affected rows. Snapshot rebuilding
is linear in held trades (`apps/desk/src/client/position-book.ts:50`). BigInt
work grows with decimal digit count, independently of the number of trades.

The existing blotter path still has logarithmic index edits and linear
collection key-array copying for newly inserted or removed IDs
(`apps/desk/src/client/trade-index.ts:119`,
`packages/pinna/src/collection.ts:280`, `packages/pinna/src/collection.ts:303`).
Sort, filtering, and selected-trade summaries retain the prior slice's costs.
**Inference:** position deltas avoid that collection cost by using a fixed
ledger. I found no unordered public collection write in `README.md:183`;
removing the variable trade book's ordered-key copy would require a different
trade storage design, not a cheaper call to the documented collection API.
Pinna did not obstruct constant-count position updates. It does not make the
separate blotter ingestion path constant time.

## Fourth-slice measurements

Machine: Apple M1 Pro, arm64, Darwin 24.6.0. Runtime: Bun 1.4.4,
JavaScriptCore, concurrent JIT disabled. Each metric has 250 samples after
20 warmups (`apps/desk/scripts/measure.ts:90`). Prices for all pairs and the
positions panel are observed, the market clock is frozen, and serialized
messages pass through the production transport. Timings include delivery,
decoding, application writes, and settled position and total reads, without
React rendering (`apps/desk/scripts/measure.ts:37`,
`apps/desk/scripts/measure.ts:77`).

The done-trade number is the real pending-to-done arrival path, including the
blotter; it is not an isolated arithmetic microbenchmark. The tick is GBP/USD,
which affects GBP/USD's position and EUR/GBP's conversion, plus the total
(`apps/desk/scripts/measure.ts:110`, `apps/desk/scripts/measure.ts:128`).

| Operation, milliseconds: median / 95th percentile | 10,000 history trades | 100,000 history trades |
| --- | ---: | ---: |
| One done trade through positions and blotter until settled | 0.040 / 0.745 | 0.040 / 0.498 |
| One GBP/USD tick through positions until settled | 0.028 / 0.302 | 0.027 / 0.072 |

These measurements gate nothing. Two sizes and small wall-clock durations do
not establish asymptotic behavior; the source explains the bounded position
work and the remaining collection and index work.

## Fourth-slice check results

| Command, from the worktree root | Final result |
| --- | --- |
| `bun run --cwd apps/desk typecheck` | Exit 0. Includes source, tests, and measurement. |
| `bun run --cwd apps/desk test` | Exit 0; 36 passed, 0 failed, 8,871 assertions; 5.84 seconds. |
| `bun run --cwd apps/desk measure` | Exit 0; both sizes completed; fourth-slice numbers above. |
| `bunx biome check apps/desk` | Exit 0; 29 files checked; no fixes applied. |
| `bunx biome check --write apps/desk` | Exit 0 on the final formatting pass; earlier naming and accessibility errors fixed. |
| `git diff --check` | Exit 0. |

Keep aggregate writes inside the transaction that changes their inputs;
derive marks and totals instead of repairing them in a later effect.

# Building the fifth desk slice: live quotes and collection-owned derivations

The desk now distinguishes a live quote from the last price it remembers.
The stream owns the live quote; a private history box supplies only movement
comparison after a restart (`apps/desk/src/client/desk.ts:272`). Two
`onRowChange` listeners maintain positions and the blotter inside every
collection write (`apps/desk/src/client/position-book.ts:35`,
`apps/desk/src/client/trades.ts:123`). This section supersedes earlier claims
in this file that an unobserved stream retains its price, and that trade
writers must maintain aggregates themselves.

## How the library changes were found

**Observed:** after reading the root rules, this file, and the current
application rules, I ran `git log` and `git diff 3914997 -- README.md docs
packages`. The history identifies `54d4f5f` as the stream reset change and
`2137543` as held-row replay for the new listener. The diff exposed both
public contracts: reset in `README.md:224`, and row listeners in
`README.md:184`. The current authoring guide states the same rules at
`docs/dx.md:342` and `docs/dx.md:154`; application guidance now prescribes
listeners for incremental indexes at `packages/pinna/AGENTS.md:57`.

I confirmed the details in package source and tests, rather than treating
the old findings as current documentation. Stream reset is synchronous and
precedes fiber interruption (`packages/pinna-effect/src/programs.ts:195`);
the restart test checks the initial value before the next element
(`packages/pinna-effect/test/effect.test.ts:522`). Listener rollback includes
errors caught by the writer (`packages/pinna/src/collection.ts:299`,
`packages/pinna/test/row-change.test.ts:383`). No external Pinna documentation
or undocumented internal API was used.

## The five largest frictions

### 1. A historical retention guarantee had become a freshness guarantee

**Observed:** the initial required test run exited 1: 33 passed and the three
named tests failed, with 7,916 assertions. The positions comparison expected
GBP/USD's earlier quote, mark, and dollar figures but received null; the
panel test reported `Expected: true; Received: false`; the React lifecycle
test expected its retained state but received null current and previous.
The new documentation explicitly resets the stream after its last observer
leaves (`README.md:224`). Source confirms the value is restored to the
original initial object, without consulting element equality
(`packages/pinna-effect/src/programs.ts:195`).

**Inference, confirmed by the regression tests:** these were old lifecycle
expectations, not lost trade data. Restoring the old stream value would make
a closed pair's historical price executable again. **Decision:** keep null
as the stream's initial current price. The existing display and execution
guard already handle null (`apps/desk/src/client/desk.ts:48`,
`apps/desk/src/client/desk.ts:160`); positions already propagate missing marks
and conversions (`apps/desk/src/client/positions.ts:58`). No weaker schema
check or permanent observation hold is needed.

### 2. The movement marker needed memory that the stream no longer owns

**Observed:** the old delayed scan seed read the stream itself; with the new
reset rule that read cannot recover the prior run. The library promises
only the latest element of the current observation run
(`packages/pinna-effect/src/programs.ts:134`). The two-observer test also
shows that releasing one observer leaves the live value intact until the
last release (`packages/pinna-effect/test/effect.test.ts:543`).

**Decision:** store the last checked price in a private plain `box`, seed
the scan from it with `untracked`, and update it only after price decoding
and topic validation (`apps/desk/src/client/desk.ts:274`,
`apps/desk/src/client/desk.ts:286`). The scan emits nothing on restart, so
history cannot fill the live current price. A schema box would check an
already decoded value again; a mutable variable would forgo ordinary box
ownership. Dropping movement history was permitted but would discard useful
existing behavior. A second observer would prevent the required topic stop.

**Observed:** a separate UI regression closes an already priced EUR/USD tile
through its Close button, advances ten simulated seconds, reopens it through
Open, checks blank bid/ask and both disabled actions, and then supplies a
new price. Only that price enables trading and shows the upward marker
(`apps/desk/test/react.test.tsx:420`). The shared-source/StrictMode test also
checks headless execution refuses both directions while waiting
(`apps/desk/test/react.test.tsx:394`).

### 3. A wire-log prefix alone does not describe synchronous loss of demand

**Observed:** stream reset occurs before interruption runs transport cleanup
(`packages/pinna-effect/src/programs.ts:195`), while the unsubscribe entry
is appended by the transport's Effect finalizer
(`apps/desk/src/transport.ts:61`). A synchronous subscriber can therefore
receive a visibility change at a prefix that still contains the old price
and does not yet contain the unsubscribe. The earlier oracle only remembered
price messages; that model would call a stopped quote live.

**Decision:** the independent oracle removes a price on its topic's
unsubscribe and evaluates demand from the recorded open symbols, panel
visibility, done trades, and required converters
(`apps/desk/test/oracle.ts:320`, `apps/desk/test/oracle.ts:339`). It reads no
client prices, ledgers, arithmetic, or subscription internals. Cache receipts
by prefix *and* visibility, because visibility can change without a wire
message (`apps/desk/test/positions.test.ts:143`). Every receipt still gets
an equality assertion, with the original greater-than-500-receipts and
12-channel checks intact (`apps/desk/test/positions.test.ts:162`).

**Inference:** observation ownership is an input to the domain oracle, just
as workspace visibility already was; removing null receipts or delaying
their assertions would conceal a real consistency failure.

### 4. Incremental listeners are synchronous state maintenance with a lifetime

**Observed:** the public guide now directly answers the derived-state
question (`docs/dx.md:154`). Source documents that listeners see replaced
rows, not writes inside a row's boxes; it also says registration replays
held rows and every registration repeats that replay
(`packages/pinna/src/collection.ts:708`,
`packages/pinna/src/collection.ts:713`). The application rules warn that
`testRealm` now reports listeners left running
(`packages/pinna/AGENTS.md:84`). These details required checking source to
separate registration lifetime from observation lifetime.

**Decision:** install each listener once with its owner, not when a view
mounts. `PositionBook` owns its aggregate listener and `TradeBook` owns the
index listener and disposes both (`apps/desk/src/client/position-book.ts:33`,
`apps/desk/src/client/trades.ts:147`). The factory ties book disposal to the
application Effect scope (`apps/desk/src/client/trades.ts:297`). No watch or
autorun repairs derived boxes after a transaction. The immutable checked
trade records are whole-row replacements, so the documented limitation on
box writes inside rows does not affect this application.

### 5. Bulk replacement is reported as deltas, not as a rebuild instruction

**Observed:** `replaceAll` writes all rows before its first listener report;
reading the collection during a report can see rows ahead of their reports
(`packages/pinna/src/collection.ts:714`). There is no batch/rebuild event in
the public listener contract (`README.md:184`). The collection's `.rows`
implementation reads its held map without allocating one cell per key
(`packages/pinna/src/collection.ts:265`). I read that source before using it
for the snapshot merge, replacing the old dependency on the sorted index.

**Decision:** apply only `before` and `after` deltas inside listeners and
keep all aggregate values and persistent tree roots in boxes. The snapshot
still performs one `write.replaceAll`; it no longer rebuilds position
totals or indexes itself (`apps/desk/src/client/trades.ts:249`). A bulk
listener rebuild would repeatedly scan held trades, and a mutable tree
would need its own rollback. Initial index population now makes persistent
AVL insertions instead of sorting and building once; both have
`O(n log n)` ordering work, with different allocation constants. Per held-row
changes remain bounded to the previous/next position contributions and
logarithmic tree paths (`apps/desk/src/client/position-book.ts:47`,
`apps/desk/src/client/trades.ts:123`). New/removal key-order copying remains
linear in held trades (`packages/pinna/src/collection.ts:329`).

## Changed expectations, in domain terms

| Test | Changed expectation and reason |
| --- | --- |
| 10,000-trade log-prefix scenario | The independent fold now treats a price as absent after its last demand ends, until a new message arrives in a later subscription. GBP/USD's mark and EUR/GBP's dollar conversion must be missing during that gap; totals include only available dollars and report incomplete. Both complete-book comparisons and every subscriber receipt still compare against the independent fold (`apps/desk/test/positions.test.ts:92`, `apps/desk/test/positions.test.ts:139`). |
| Price-topic ownership | Showing positions no longer immediately makes the total complete: EUR/GBP lost its live mark while hidden. Assert its null mark and incomplete total, send a fresh EUR/GBP quote, then retain the complete-total assertion. GBP/USD stayed observed by its tile, so its live conversion remains usable (`apps/desk/test/positions.test.ts:232`). |
| Last tile unmount/remount | The unobserved price state is now empty instead of equal to the old current/previous pair. Remount must show placeholders and disable execution before the next tick. Preserve the first-new-tick comparison to the old price as movement history, independently of the live quote (`apps/desk/test/react.test.tsx:369`, `apps/desk/test/react.test.tsx:399`). |

No render-count expectation or receipt-count threshold was weakened. The
new direct-write test exercises `upsert`, `remove`, and `replaceAll` without
calling any ingestion method, including a symbol/side/quantity/rate correction,
active filtering, selection removal, equality no-ops, and empty replacement
(`apps/desk/test/derived-state.test.ts:10`). One transaction produces one
coherent recorded receipt. A second test checks outer rollback and caught
listener failures for all three write operations; the rejecting listener
runs after both application listeners have written
(`apps/desk/test/derived-state.test.ts:101`).

## Hand-wiring removed

Locations here refer to **baseline `3914997`**, not current line numbers.
The three position-maintenance calls were
`apps/desk/src/client/trades.ts:194` (`positions.change` in `accept`),
`apps/desk/src/client/trades.ts:246` (`positions.replace` in the snapshot),
and `apps/desk/src/client/trades.ts:265` (`positions.change` in `withdraw`).
The corresponding per-writer index/count/selection blocks began at baseline
`apps/desk/src/client/trades.ts:195`, `apps/desk/src/client/trades.ts:248`,
and `apps/desk/src/client/trades.ts:267`; all were removed. The obsolete
`PositionBook.replace` helper at baseline
`apps/desk/src/client/position-book.ts:50` was deleted too.

The writers now only validate/merge and mutate the collection, with snapshot
readiness still written in the snapshot transaction
(`apps/desk/src/client/trades.ts:215`, `apps/desk/src/client/trades.ts:237`,
`apps/desk/src/client/trades.ts:263`). The existing tree algorithms in
`apps/desk/src/client/trade-index.ts:119` did not need changes; their roots
are now maintained by the collection listener. Sort/filter control changes
still rebuild their views through the existing model methods
(`apps/desk/src/client/trades.ts:152`).

## Pinna API choices in this slice

| API | Use, alternative considered, and reason |
| --- | --- |
| `onRowChange` | New: own indexes, held count, selection removal, and position deltas at the collection. Replaces per-writer calls; a `watch`/`autorun` would write after settlement and a full `.rows` reduction would scan history (`docs/dx.md:154`). |
| `box`, `update` | Keep checked historical prices, immutable aggregate values, and persistent tree roots. A schema box duplicates decoding for history; mutable caches require separate rollback (`apps/desk/src/client/desk.ts:274`, `apps/desk/src/client/position-book.ts:20`). |
| `Model`, `Realm`, `Collection`, `Read`, `Write`, `Computed` | Retain explicit owner and observable capability types; pass the listener's current read/write to the aggregate helper. `SchemaModel`/`CollectionField` add a wire model the desk does not need (`apps/desk/src/client/position-book.ts:33`, `apps/desk/src/client/trades.ts:45`). |
| `collection`, `write.upsert/remove/replaceAll`, `read.row` | Retain granular held trades and one bulk snapshot replacement. Snapshot-only `.rows` supplies the authoritative held records; a repeated-upsert snapshot would copy key order repeatedly (`apps/desk/src/client/trades.ts:56`, `apps/desk/src/client/trades.ts:250`). |
| `fromStream`, `RealmService`, `untracked` | Retain observation-owned live topics and the shared realm; read history without holding a topic open. A manually reference-counted stream or a permanent observation hold duplicates or defeats the supplied lifetime (`apps/desk/src/client/desk.ts:275`, `apps/desk/src/client/desk.ts:287`). |
| `computed`, `computedFunction`, `schemaBox` | Retain cached marks, conversions, windows, selection membership, and checked controls. These are derived reads or external inputs, not row-delta accumulators; no replacement with handwritten effects (`apps/desk/src/client/positions.ts:29`, `apps/desk/src/client/trades.ts:61`, `apps/desk/src/client/trades.ts:102`). |
| `testRealm`, `record`, `held` | New tests own books and listeners, record synchronous receipts, and verify no receipt from failed writes. Final-state assertions alone would miss intermediate publication (`apps/desk/test/derived-state.test.ts:39`, `apps/desk/test/derived-state.test.ts:124`). |
| `observeScoped`, `changes`, `watch` | Retain explicit headless lifetime, snapshot readiness, and every synchronous receipt with prefix metadata. A coalescing `changes` stream remains inappropriate for the receipt oracle (`apps/desk/test/positions.test.ts:59`, `apps/desk/test/positions.test.ts:79`). |

The unchanged UI continues using `useValue`/`useValues` and small memoized
components; no new selector or provider is needed
(`apps/desk/src/client/spot-tile.tsx:12`, `apps/desk/src/client/spot-tile.tsx:58`).

## Errors encountered and documentation limits

Besides the reproduced three runtime expectation failures, two typechecks
failed with `TS2769: No overload matches this call`, both in new assertions.
One compared a `string[]` with optional current-price fields; an explicit
missing-quote guard narrows the value (`apps/desk/test/react.test.tsx:402`).
The other compared a literal pair union with a fixture widened to `string`;
the fixture now uses `as const` (`apps/desk/test/react.test.tsx:427`). These
were test typing errors, not missing Pinna behavior. Biome formatting passes
organized imports and formatted the changed files. No new Pinna runtime
error occurred after the migration; deliberate rollback tests throw
`failed trade batch` and `refused trade write`
(`apps/desk/test/derived-state.test.ts:129`,
`apps/desk/test/derived-state.test.ts:137`).

**Observation:** `documentation-voice`, named in `AGENTS.md:73`, is still
absent from the supplied skill catalog and searches of the local skill roots.
This continuation follows the earlier findings' observation/decision/inference
register. No new dependency, install, library edit, commit, or remote action
was needed. **Assumption:** trade records remain immutable whole-row values,
as checked by `apps/desk/src/client/wire.ts:69`; adding observable fields
inside those rows would require reconsidering row-listener coverage.

## Fifth-slice measurements

Same reported machine/runtime and unchanged measurement script: Apple M1 Pro,
arm64, Darwin 24.6.0, Bun 1.4.4, JavaScriptCore with concurrent JIT disabled.
The 250-sample settled paths and 20 warmups are still those described in the
fourth slice (`apps/desk/scripts/measure.ts:90`). Figures below are actual
output of this slice's `measure` run; they are observations, not proof of a
speed improvement. Fourth-slice reference figures are above at
`apps/desk/FINDINGS.md:1017`.

| Operation, milliseconds: median / 95th percentile | Fourth: 10,000 | Fifth: 10,000 | Fourth: 100,000 | Fifth: 100,000 |
| --- | ---: | ---: | ---: | ---: |
| One done trade through positions and blotter until settled | 0.040 / 0.745 | 0.038 / 0.747 | 0.040 / 0.498 | 0.035 / 0.381 |
| One GBP/USD tick through positions until settled | 0.028 / 0.302 | 0.031 / 0.337 | 0.027 / 0.072 | 0.027 / 0.055 |

Other script output is retained here for reproducibility. The fourth slice
did not record these metrics; the older third-slice comparison is above at
`apps/desk/FINDINGS.md:728`.

| Operation, milliseconds | 10,000 history trades | 100,000 history trades |
| --- | ---: | ---: |
| Snapshot load | 164.217 | 652.932 |
| New incoming trade, median / 95th percentile | 0.042 / 0.484 | 0.792 / 1.191 |
| Held-trade update, median / 95th percentile | 0.038 / 0.747 | 0.035 / 0.381 |
| Change sort, median / 95th percentile | 16.536 / 33.901 | 163.430 / 331.865 |
| Filter keystroke, median / 95th percentile | 4.026 / 7.360 | 55.911 / 61.853 |
| Scroll one row, median / 95th percentile | 0.001 / 0.007 | 0.001 / 0.001 |

Filter `d`, `de`, `des`, `desk`, `desk-`, `desk-2` measured respectively
6.175, 4.026, 7.360, 3.767, 3.483, 3.210 ms at 10,000, and 45.648,
55.911, 56.421, 53.952, 61.853, 54.238 ms at 100,000. Snapshot load includes
validation and transport; the difference from older slices does not isolate
listener overhead. The source, rather than these timings, establishes the
bounded position deltas and remaining key-order copy.

## Fifth-slice check results

| Command, from the worktree root | Result |
| --- | --- |
| `bun run --cwd apps/desk typecheck` | Final exit 0; the two earlier TS2769 failures and fixes are recorded above. |
| `bun run --cwd apps/desk test` | Exit 0; 39 passed, 0 failed, 8,908 assertions across eight files. Initial run: exit 1, three expected migration failures. |
| `bun run --cwd apps/desk measure` | Exit 0; both history sizes completed; all output recorded above. |
| `bunx biome check apps/desk` | Exit 0; 30 files checked, no fixes applied. |
| `bunx biome check --write apps/desk` | Exit 0; scoped formatting passes changed six files, then one file. |
| `git diff --check` | Exit 0. |

No requested implementation remains unfinished. Remaining collection insertion,
selection, sort, and filter costs are the existing limits described above;
there is no new reconnect, persistence, pair, or market-data feature.

Keep historical memory separate from live authority, and attach incremental
derived state to the input collection's transaction.

# Building the sixth desk slice: saved workspaces and named layouts

The desk now restores a checked projection of its workspace before installing
its persistence observer. Layout switches write into the existing tile and
trade-book models; they never construct replacement price streams
(`apps/desk/src/client/layouts.ts:80`, `apps/desk/src/client/layouts.ts:131`).
This section records repository observations, application decisions, and
inferences separately. Earlier slices' guarantees and tests remain intact.

## The five largest frictions

### 1. Checked decoding is not partial recovery

**Needed:** keep a valid tile and filter beside a negative notional, unknown
pair, and invalid sort column, including inside individual named layouts.
**Observed:** the application rules require schemas for outside input
(`packages/pinna/AGENTS.md:29`). `decode` is a whole-input operation that throws
`SchemaError` on failure (`README.md:191`); its implementation runs one decoder
and throws its failure, with no recovery report
(`packages/pinna-effect/src/decode.ts:33`,
`packages/pinna-effect/src/decode.ts:47`). `schemaBox` checks every write and
rolls back a rejected update (`packages/pinna-effect/src/box.ts:6`). Neither
contract defines which neighboring fields to retain or which default to use.

**Decision:** recover containers, fields, and rows separately, using the same
`PositiveDecimal`, `SortSchema`, and finite nonnegative `Position` schemas the
desk already uses. Each rejection records a data path and a reason; dynamic
pair membership is checked against the actual `/pairs` result, in addition to
the symbol schema (`apps/desk/src/client/workspace-data.ts:46`,
`apps/desk/src/client/workspace-data.ts:87`). Decode each recovered named row
with Pinna's public `decode` before storing it
(`apps/desk/src/client/layouts.ts:92`, `apps/desk/src/client/layouts.ts:164`).
An all-or-nothing `SchemaModel` decode would lose good neighbors. Catching a
failed live write would recover too late to produce a complete preview.
**Inference:** defaulting and migration are application policy; a checked
box alone cannot supply it. I read the decoder and box source to establish
that boundary, rather than guessing at a Pinna partial-decode API.

### 2. Whole-structure reconciliation depends on the model representation

**Needed:** apply saved tile order and notionals without replacing held tile
instances, quotes, subscriptions, or execution ownership.
**Observed:** `reconcile` retains equal keyed items; `reconcileSchema` can merge
boxes on held `SchemaModel` instances (`README.md:181`, `README.md:182`). The
guide introduces them for arrays (`docs/dx.md:164`). Reading the implementation
confirmed that schema reconciliation plans model merges, defers their writes
until duplicate-key checking finishes, then writes per realm
(`packages/pinna-effect/src/reconcile.ts:36`,
`packages/pinna-effect/src/reconcile.ts:55`,
`packages/pinna-effect/src/reconcile.ts:77`).

**Decision:** keep the existing `Model` instances and apply a plain workspace
projection through their checked methods in one outer `update`
(`apps/desk/src/client/layouts.ts:131`). Compare order, sort, and filter before
writing or rebuilding; equal schema-box writes suppress their notifications.
The snapshot contains configuration, while each held tile also owns transport,
execution, and stream capabilities (`apps/desk/src/client/desk.ts:201`). It
is not a refetched array of replacement models. `reconcile` would only return
an array; `reconcileSchema` would require changing that representation and
would not express the ordinary close behavior. **Inference:** neither API is
a general patch operation over arbitrary live models. Explicit application
is smaller here and makes the projection's limits visible.

### 3. Atomic state writes do not roll back an interrupted execution

**Needed:** a switch must publish one complete workspace and close an execution
exactly as the trader's Close button does, including when an enclosing write
fails. **Observed:** nested updates join the outermost update, and observers
receive its end state once (`packages/pinna/src/observable.ts:1085`). The old
`cancelExecution` also clears a plain token and interrupts a fiber, which is
outside that state journal (`apps/desk/src/client/desk.ts:155`). The current
stream source explicitly treats lifecycle state as separate from the rollback
journal (`packages/pinna-effect/src/programs.ts:156`).

**Decision:** make tile closure a state change, then use one workspace-owned
`watch` to cancel executions for successfully closed pairs
(`apps/desk/src/client/desk.ts:244`). Both manual closes and switches use that
path. Stop this watch with the workspace's Effect scope
(`apps/desk/src/client/desk.ts:278`, `apps/desk/src/client/desk.ts:339`). No
derived workspace field is repaired by that effect: the whole configuration
and active layout are already written atomically. Cancellation is the external
consequence of the successful update. **Inference:** calling cancellation
inside the application recipe could leave a rolled-back pending order with
no running execution. The new test deliberately throws after switching,
checks the pending execution and trade remain untouched, then successfully
switches and proves interruption and no late client writes
(`apps/desk/test/workspace.test.tsx:444`).

### 4. Persistence needs a projection and an explicit scheduling boundary

**Needed:** one save for a burst, no overwrite while restoring, no subscriptions
started just to serialize, and no saves for market traffic or selection.
**Observed:** `watch` is synchronous and its callback returns `undefined`
(`packages/pinna/src/observable.ts:1147`). `fromStream` runs while observed and
resets on last release (`packages/pinna-effect/src/programs.ts:134`). Reading
the whole live view to save it would therefore acquire market demand as well
as persisting the wrong fields. The repository's `record` helper explicitly
excludes the initial value (`packages/pinna/src/testing/index.ts:39`).

**Decision:** a `computed` snapshot reads only open symbols, those tiles'
notionals, panel visibility, and three blotter controls. Another computed
serializes that projection, named layouts, and the active identifier
(`apps/desk/src/client/layouts.ts:62`, `apps/desk/src/client/layouts.ts:115`).
Attach `watch` only after restoration, schedule one microtask per synchronous
burst, and flush the latest projection on scope disposal. Equality skips
net-zero bursts (`apps/desk/src/client/layouts.ts:97`,
`apps/desk/src/client/layouts.ts:233`). A plain browser adapter and an in-memory
test store implement the desk-owned two-method interface
(`apps/desk/src/client/workspace-data.ts:293`,
`apps/desk/test/workspace.test.tsx:28`). A React effect would miss headless
changes and depend on mounting; `watchScoped` or `changes` would add an Effect
consumer and its interruption/coalescing semantics without solving storage
batching. **Inference:** Pinna owns publication; the desk owns storage timing.

### 5. Fine-grained reads need stable component boundaries too

**Needed:** typing changes one tile and the modified mark, with no layout-list
or layout-row render; a membership switch must leave unchanged shared tiles
alone. **Observed:** collection keys and per-key rows have separate reads
(`apps/playground/src/docs/collections.tsx:82`,
`apps/playground/src/docs/collections.tsx:95`). The application rules prescribe
small memoized components and `computedFunction` supplies observed argument
entries (`packages/pinna/AGENTS.md:95`, `README.md:169`). The previous workspace
created an inline Close callback inside its changing tile list; a new callback
would defeat a child's shallow prop comparison.

**Decision:** read layout keys in `LayoutList`, one immutable row in each
`LayoutRow`, and one primitive status from `$status(id)` in a separate
`LayoutStatus`. Keep tile callbacks inside a memoized wrapper with stable
workspace and symbol props (`apps/desk/src/client/layouts-panel.tsx:20`,
`apps/desk/src/client/layouts-panel.tsx:38`,
`apps/desk/src/client/layouts-panel.tsx:106`,
`apps/desk/src/client/workspace.tsx:88`). The status depends on the live
snapshot only for the active layout. A broad `.rows` read in the list or a
fresh object from a selector would expand its render scope. **Observed:** the
render test gets exactly one changed EUR/USD tile, two changed active marks,
zero list renders, and zero layout-row renders on a switch. The first
notional edit gets one tile and one mark; a second edit while already modified
does not render the unchanged mark (`apps/desk/test/workspace.test.tsx:516`).

## Pinna APIs selected and alternatives

| API | Use, alternative considered, and reason |
| --- | --- |
| `Model`, `Realm` | Keep the existing workspace/tile owners and add `Layouts`; `SchemaModel` would combine durable configuration with live capabilities that are deliberately excluded (`apps/desk/src/client/layouts.ts:37`). |
| `schemaBox` | Retain every existing input check and add a checked nullable active identifier. Plain boxes would weaken the control boundary (`apps/desk/src/client/layouts.ts:39`, `apps/desk/src/client/trades.ts:61`). |
| `decode` | Final schema decoding of recovered immutable layout rows; whole-document decoding was rejected because it cannot retain invalid fields' valid neighbors (`apps/desk/src/client/layouts.ts:92`). |
| `box` | Hold recovery reports, storage errors, and an already checked paste preview. These are application-produced results; they do not need observable schema models (`apps/desk/src/client/layouts.ts:40`). |
| `collection`, `.keys`, `.row`, `read.row`, `write.upsert/remove/replaceAll` | Store named layouts by stable identifier, restore once, and update one row on rename. A box of all layouts would couple readers; names as keys would change identity on rename (`apps/desk/src/client/layouts.ts:38`, `apps/desk/src/client/layouts.ts:189`). |
| `computed`, custom `equals` | Derive the small configuration snapshot, modified state, and serialized envelope. A live-view snapshot would observe prices; an identity-only comparison would publish equal projections (`apps/desk/src/client/layouts.ts:25`, `apps/desk/src/client/layouts.ts:46`). |
| `computedFunction` | Per-layout primitive status, retained only while observed; avoids a permanent selector map and prevents inactive marks from reading notionals (`apps/desk/src/client/layouts.ts:59`). |
| `update`, `Read` | Apply all configuration fields and active identity together, reusing nested checked methods. Separate calls would expose partial layouts (`apps/desk/src/client/layouts.ts:181`). |
| `watch` | Persist a settled projection and interrupt work only after a successful close. `autorun` would run immediately during setup; neither is used to repair derived state (`apps/desk/src/client/layouts.ts:98`, `apps/desk/src/client/desk.ts:245`). |
| `untracked` | Read the latest queued save and copy text without retaining demand. Capturing `read` or serializing a whole live model is unnecessary (`apps/desk/src/client/layouts.ts:204`, `apps/desk/src/client/layouts.ts:236`). |
| `useValue`, retained `useValues` | Subscribe each small UI boundary to known observables. `useSelect` would add providers and selector effects without a needed view derivation (`apps/desk/src/client/layouts-panel.tsx:30`, `apps/desk/src/client/spot-tile.tsx:58`). |
| `fromStream`, `RealmService` | Retain existing observation-owned prices and the creation realm; no new price adapter, permanent observation, or reference counter (`apps/desk/src/client/desk.ts:284`). |
| `testRealm`, `record`, `held`, `watch` | Check listener teardown and every synchronous receipt, including failed writes. `changes` could coalesce receipts and hide an intermediate state (`apps/desk/test/workspace.test.tsx:364`). |

No application import uses a Pinna internal API. For checking outside data I
read `decode`, `schemaBox`, `SchemaModel`/`BoxField`, and their documented
contracts; for whole-structure application I read both reconciliation APIs
and `update`'s implementation. The choices above use those public contracts
without changing library source (`README.md:167`, `README.md:181`,
`README.md:191`, `packages/pinna/src/observable.ts:1085`).

## Saved format, migration, and sharing decisions

**Decisions:** version 2 stores a workspace, an ordered array of named layouts,
and an active layout identifier. The browser key is `pinna.desk.workspace`.
Trades, prices, selection, and viewport height are outside that projection
(`apps/desk/src/client/workspace-data.ts:22`,
`apps/desk/src/client/workspace-data.ts:297`,
`apps/desk/src/client/layouts.ts:115`). A valid empty tile array stays empty;
an invalid tile array uses all currently listed pairs. An invalid tile row,
unknown pair, or repeated pair is dropped; invalid fields of a valid tile
use defaults (`apps/desk/src/client/workspace-data.ts:73`).

**Assumptions:** version 1 means either its bare string array or an envelope
with `version: 1` and `openTiles` (also accepting `tiles`). Slash pair names
migrate to the current symbols. There was no existing storage implementation
to dictate a different envelope. Names are trimmed, nonempty, and unique
case-sensitively; the first valid duplicate wins during recovery. Layouts
whose identity or name cannot be retained are dropped with their row path.
Unknown versions recover recognized fields through the same checks, with a
version warning (`apps/desk/src/client/workspace-data.ts:186`,
`apps/desk/src/client/workspace-data.ts:229`,
`apps/desk/src/client/workspace-data.ts:238`).

**Decision:** editable notional strings retain the earlier slice's temporary
invalid-input behavior. Durable layouts require a positive decimal: saving a
layout while editing an invalid amount uses its default in that layout and
reports the dropped amount; the unchanged live edit then correctly marks that
layout modified. Autosave captures the current edit, and a later restoration
checks it before application (`apps/desk/src/client/desk.ts:47`,
`apps/desk/src/client/layouts.ts:163`,
`apps/desk/src/client/workspace-data.ts:98`). This preserves editing while
refusing negative imported values; it does not weaken an input schema.

**Decision:** sharing exports `version` and `workspace` only. Preview uses the
same per-field recovery, displays both recovered settings and all dropped
paths, and neither changes live state nor saves. Confirm applies in one update
and clears the active named identity; Cancel removes only the preview. The
trader can explicitly name the imported workspace afterward
(`apps/desk/src/client/layouts.ts:204`,
`apps/desk/src/client/layouts.ts:211`,
`apps/desk/src/client/layouts-panel.tsx:160`). The Copy button writes the
clipboard and also exposes selectable text for manual copying
(`apps/desk/src/client/layouts-panel.tsx:82`). Storage failures are visible
without preventing desk startup or further editing
(`apps/desk/src/client/layouts.ts:81`, `apps/desk/src/client/layouts.ts:228`).

## Errors encountered and verification evidence

**Observed:** the first typecheck of the new recovery code failed with
`TS4111: Property 'tiles' comes from an index signature, so it must be accessed
with ['tiles']`, with analogous errors for other fields. A typed set of
permitted object keys now gives those records their actual fields, keeping
unknown values checked rather than casting them to domain data
(`apps/desk/src/client/workspace-data.ts:57`). The temporary bracket-key fix
then produced Biome's `useLiteralKeys` informational diagnostics; explicit
record shapes resolved that conflict. A later typecheck reported
`Type 'void' is not assignable to type 'undefined'` for a separately declared
watch callback. Give the receipt callback Pinna's explicit `undefined` return
type (`apps/desk/test/workspace.test.tsx:397`). Optional preview expectations
also produced `TS2769: No overload matches this call`; guard the actual
preview before comparing it (`apps/desk/test/workspace.test.tsx:622`).

The first new-test run had 49 passing tests and one failure:
`Expected length: 2; Received length: 1`. I had counted an initial value in
`record`; its source says only changes are recorded. The corrected test
requires exactly one receipt for confirmation
(`packages/pinna/src/testing/index.ts:39`,
`apps/desk/test/workspace.test.tsx:650`). No Pinna runtime error occurred.
The deliberate rollback failures are `refused workspace` and `refused layout`
(`apps/desk/test/workspace.test.tsx:289`,
`apps/desk/test/workspace.test.tsx:483`).

| Requirement | Test and evidence |
| --- | --- |
| Save and restore without a startup write; one burst, one save; market data and selection excluded | `apps/desk/test/workspace.test.tsx:244`: verifies no save after full restore, five field changes produce one complete save, failed updates produce none, and prices/trades/selection/viewport edits produce none. |
| Recover corrupt JSON and version 1 | `apps/desk/test/workspace.test.tsx:70`, `apps/desk/test/workspace.test.tsx:91`: actual desk startup and exact default/migration/report assertions, with no restore write. |
| Recover untrusted fields and layout rows | `apps/desk/test/workspace.test.tsx:123`: exact ordered path/reason list, a schema-known delisted pair, valid neighboring amounts/filter/scroll/direction, duplicate names and identifiers, and cleared unknown active identity. `apps/desk/test/workspace.test.tsx:717` checks structural corruption and a valid empty workspace. |
| Named operations, uniqueness, active identity, and modified state survive reload | `apps/desk/test/workspace.test.tsx:323`; real Save/Rename/Copy/Delete controls additionally run at `apps/desk/test/workspace.test.tsx:750`. |
| In-place switching and coherent receipts | `apps/desk/test/workspace.test.tsx:364`: shared tile and quote identity, zero shared-pair subscription traffic, exactly one close and one open topic, one aggregate receipt, seven direct watcher channels seeing complete old/new snapshots, and an idempotent repeated switch. |
| Closing an execution and rollback | `apps/desk/test/workspace.test.tsx:444`: a failed enclosing update does not cancel; a successful switch cancels, withdraws, unsubscribes, and produces no later client writes over eight simulated seconds. |
| Exact render scope | `apps/desk/test/workspace.test.tsx:516`: changed tile and active marks only; no list/row renders, including while typing. |
| Preview, Cancel, Confirm, and export round trip | `apps/desk/test/workspace.test.tsx:592`: visible dropped paths before confirmation, zero saves on preview/cancel, one receipt/save on confirmation, and unchanged named layouts. |
| Storage failures, teardown flush, and browser interface | `apps/desk/test/workspace.test.tsx:670`, `apps/desk/test/workspace.test.tsx:703`. |

The prior 39 tests were not edited. In particular the log-prefix oracle,
subscription checks, exact React counts, 100,000-trade path, and collection
rollback tests still run (`apps/desk/test/positions.test.ts:15`,
`apps/desk/test/react.test.tsx:52`, `apps/desk/test/scale.test.ts:260`,
`apps/desk/test/derived-state.test.ts:101`). No browser session or production
build was run; the UI was tested in the existing DOM environment
(`apps/desk/test/setup.ts:1`). The `documentation-voice` skill remains absent
from the supplied catalog and searched local skill roots, as recorded by the
prior slice (`apps/desk/FINDINGS.md:1258`); this continuation uses the same
observation/decision/inference register.

## Sixth-slice measurements beside the fifth slice

**Observed:** the unchanged measurement command reported Apple M1 Pro, arm64,
Darwin 24.6.0, Bun 1.4.4, JavaScriptCore with concurrent JIT disabled. The
settled trade and tick paths have 250 samples after 20 warmups
(`apps/desk/scripts/measure.ts:90`). Fifth-slice references are recorded at
`apps/desk/FINDINGS.md:1276` and `apps/desk/FINDINGS.md:1285`.

| Operation, milliseconds: median / 95th percentile unless noted | Fifth: 10,000 | Sixth: 10,000 | Fifth: 100,000 | Sixth: 100,000 |
| --- | ---: | ---: | ---: | ---: |
| Snapshot load, single measurement | 164.217 | 177.034 | 652.932 | 712.416 |
| New incoming trade | 0.042 / 0.484 | 0.048 / 0.648 | 0.792 / 1.191 | 0.824 / 1.429 |
| Held-trade update / done trade through positions and blotter | 0.038 / 0.747 | 0.039 / 0.728 | 0.035 / 0.381 | 0.045 / 0.384 |
| GBP/USD tick through positions | 0.031 / 0.337 | 0.030 / 0.344 | 0.027 / 0.055 | 0.025 / 0.046 |
| Change sort | 16.536 / 33.901 | 15.964 / 35.537 | 163.430 / 331.865 | 205.751 / 365.444 |
| Filter keystroke | 4.026 / 7.360 | 5.277 / 7.177 | 55.911 / 61.853 | 62.039 / 68.383 |
| Scroll one row | 0.001 / 0.007 | 0.001 / 0.008 | 0.001 / 0.001 | 0.001 / 0.002 |

Raw sixth-slice filter edits `d`, `de`, `des`, `desk`, `desk-`, `desk-2`:
7.177, 4.186, 6.848, 5.277, 4.506, 3.568 ms at 10,000; 48.498, 68.383,
61.641, 62.039, 62.869, 59.068 ms at 100,000. Sort has four samples, filter
six, and scroll 250 (`apps/desk/scripts/measure.ts:155`,
`apps/desk/scripts/measure.ts:168`, `apps/desk/scripts/measure.ts:181`).

**Inference:** these single-run wall-clock differences do not isolate a speed
change. The unchanged script supplies no storage adapter, so these figures
do not measure local-storage latency. Source establishes that persistence
reads no held-trade collection or prices; new controls add no per-trade work
(`apps/desk/src/client/layouts.ts:62`, `apps/desk/src/client/layouts.ts:115`).
The existing insertion key-order copy, sorting, filtering, and selection
limits remain; no timing threshold was weakened.

## Sixth-slice check results

| Command, from the worktree root | Result |
| --- | --- |
| `bun run --cwd apps/desk typecheck` | Final exit 0. Earlier TS4111, callback-return, and preview-assertion failures are recorded above. |
| `bun run --cwd apps/desk test` | Final exit 0; 52 passed, 0 failed, 9,074 assertions across nine files. The original 39 tests remain unchanged. |
| `bun run --cwd apps/desk measure` | Exit 0; both history sizes completed; all figures recorded above. |
| `bunx biome check apps/desk` | Exit 0; 34 files checked, no fixes applied. |
| `bunx biome check --write apps/desk` | Exit 0; formatting and import organization applied only under the desk. |
| `git diff --check` | Exit 0. |

No requested implementation remains unfinished. Changes stay under
`apps/desk`; no dependencies, install, library edit, commit, branch change,
or remote action were needed. Persist a checked configuration projection;
keep live capability identity and irreversible effects with their owners.

# Building the seventh desk slice: checked orders and account settings

Accepted ticket fields, working orders, acknowledgments, fills, and account
settings now have schemas attached to their writable Pinna state. Raw form
text, prices, computed rules, and workflow bookkeeping remain plain
(`apps/desk/src/client/form-field.ts:6`,
`apps/desk/src/client/order-data.ts:64`,
`apps/desk/src/client/account.ts:19`,
`apps/desk/src/client/trades.ts:50`). This section distinguishes observations
from application decisions and inferences; earlier descriptions of a plain
trade collection or a schema-checked tile input no longer describe those two
fields.

## The five largest frictions

### 1. A checked field cannot also be lossless input text

**Observed:** the application rules distinguish plain `box` and checked
`schemaBox` (`packages/pinna/AGENTS.md:29`). The introductory checked counter
uses a single accepted value (`README.md:42`); the model example writes its
checked field directly (`README.md:81`). Neither example supplies form text,
field errors, or a last accepted value. The implementation of `schemaBox`
installs the schema check and schema equivalence, with no form policy
(`packages/pinna-effect/src/box.ts:17`).

**Decision:** `FormField` owns a plain `$text`, checked `$accepted`, checked
`$serverError`, and computed `$error`. `set` always writes the exact text and
advances `$accepted` only when its declared schema accepts the normalized
value (`apps/desk/src/client/form-field.ts:6`,
`apps/desk/src/client/form-field.ts:28`). Only a display name is trimmed;
notionals, prices, and notes retain their representation. Clearing a checked
positive amount directly was not an input strategy: the intentional direct
write tests produce `the box rejects this value`, retain the old accepted
value, and deliver no accepted-value receipt
(`apps/desk/test/orders.test.tsx:127`). No Pinna form abstraction was assumed.

**Inference:** a two-value form example would remove more discovery work than
another single-value schema example. Making the accepted schema accept empty
or negative strings would violate this slice's invariant. Keeping only React
state would prevent headless validation. Neither workaround was used.

### 2. Relations belong in the checked value, while live eligibility is derived

**Observed:** `BoxField` checks its own schema on every write
(`packages/pinna-effect/src/class.ts:107`), and nested updates publish only the
outer result (`docs/dx.md:129`). A field check is not a documented transaction
validator over arbitrary sibling boxes. I read the `BoxField` implementation
and its merge function to confirm that distinction
(`packages/pinna-effect/src/class.ts:112`,
`packages/pinna-effect/src/class.ts:122`).

**Decision:** put the order's related terms, filled amount, status, and revision
in one `BoxField(OrderValue)`. Its schema enforces pair precision, calendar
shape, cumulative fill bounds, and the relationship between status and amount
(`apps/desk/src/client/order-data.ts:35`). Separate checked ticket fields keep
field-level rendering. A plain computed value combines those fields with the
plain live quote for the ten-percent rule and the immediate-fill mark
(`apps/desk/src/client/ticket.ts:55`). A moving price does not make a previously
accepted order intrinsically invalid. Expiry is checked against the Effect
clock when accepting input, in the rule, and again before sending
(`apps/desk/src/client/order-data.ts:26`,
`apps/desk/src/client/orders.ts:238`).

**Inference:** attaching a live-price predicate to every historical order write
would confuse eligibility to send with validity of a working order. Separate
sibling fields with sibling-dependent checks were considered, not implemented;
there was no need to bypass checked state. Fractional exchange fills can have
more than two places: user-entered order notionals have two, while fill sums
use the existing exact decimal adder
(`apps/desk/src/client/order-data.ts:5`,
`apps/desk/test/orders.test.tsx:1075`).

### 3. Model identity and collection notifications have different boundaries

**Observed:** the public contract says schema-model rows can merge their boxes
into the held instance (`README.md:182`). `CollectionField` supplies that merge
function to its keyed collection (`packages/pinna-effect/src/class.ts:202`).
The application rules explicitly say `onRowChange` does not hear a box written
inside a held row (`packages/pinna/AGENTS.md:60`). I read the collection-field
implementation and the reconciliation implementation rather than assuming a
plain collection's `upsert` preserved a changed object
(`packages/pinna-effect/src/class.ts:194`,
`packages/pinna-effect/src/reconcile.ts:55`).

**Decision:** store `WorkingOrder` instances in `CollectionField`; decode a
fresh wire model, then upsert it in the message's update. Its plain `id` stays
fixed and its `$value` merges into the held model
(`apps/desk/src/client/orders.ts:123`,
`apps/desk/src/client/orders.ts:213`). The working row reads that held
`$value`, while the list reads keys. Per-ID pending flags use
`computedFunction`, so an unrelated pending request does not change another
row's displayed pending state (`apps/desk/src/client/orders.ts:52`,
`apps/desk/src/client/orders-panel.tsx:189`).

The trade book instead holds immutable whole-trade rows in a checked
`CollectionField(Trade)`. Its existing collection listeners still see
replacements and maintain the blotter and positions inside the same update
(`apps/desk/src/client/trades.ts:50`,
`apps/desk/src/client/trades.ts:134`). This conversion is necessary because
limit fills now write that collection directly. A plain collection plus
boundary decoding would still allow another writer to insert an invalid row.
Identity assertions and a deliberately failing fill listener prove both
in-place order merging and rollback of the order, trade, and aggregates
(`apps/desk/test/orders.test.tsx:379`,
`apps/desk/test/orders.test.tsx:1075`).

**Inference:** choosing mutable model rows for the existing incremental trade
book would require replacing its listener pattern. The documented immutable
trade and mutable order representations fit their different consumers.

### 4. Decode/encode is whole-model policy, not partial recovery

**Observed:** `decode` throws a schema error for an invalid input
(`packages/pinna-effect/src/decode.ts:33`). `SchemaModel`'s wire transformation
reads declared fields, removes `$` from field keys, and excludes the realm
(`packages/pinna-effect/src/class.ts:321`). The playground shows decoding and
checked field declarations, including a context-injected field
(`apps/playground/src/docs/models.ts:27`,
`apps/playground/src/docs/models.ts:60`). It does not choose defaults for an
invalid account field while preserving valid neighboring fields.

**Decision:** validate each startup field against the same field schemas used
by `AccountSettings`. Record its path and a field-specific reason, use its
default if invalid, then `decode` the recovered model. Reconcile that model
into the held settings in one update (`apps/desk/src/client/account.ts:44`).
Save responses are strict: decode all returned settings before applying any.
Save requests encode an `AccountSettings` model with `Schema.encodeSync`,
which emits exactly the three declared wire keys
(`apps/desk/src/client/account.ts:155`). The test deliberately supplies extra
server keys and a wire `realm`, checks default recovery, checks the exact save
body, checks server field errors beside the unchanged typed fields, and
checks that direct model decoding refuses the wire realm
(`apps/desk/test/orders.test.tsx:794`).

**Inference:** partial recovery and error wording are application policy;
Pinna's checked state supplies the invariant after that policy runs. No
serialization replacement or unchecked settings cache was needed.

### 5. Synchronous rollback does not span an exchange request

**Observed:** `update` journals a synchronous recipe and rolls back a thrown
recipe (`README.md:173`, `docs/dx.md:129`). Its implementation closes the batch
when the recipe returns (`packages/pinna/src/observable.ts:1085`). It is not an
asynchronous transaction or a three-way form merge. `changes` can skip
intermediate values for a slow reader (`README.md:222`), so it cannot prove
that no partial amendment was delivered.

**Decision:** publish both optimistic amendment terms and pending state in one
update. Retain a plain rollback projection of checked authoritative state.
Each intervening valid exchange message advances that authoritative base.
On refusal, restore both terms together while retaining intervening fills
and revisions (`apps/desk/src/client/orders.ts:253`,
`apps/desk/src/client/orders.ts:347`). The edit compares its prior base with
each incoming field, retains untouched typed text, and exposes conflicting
values until the trader chooses (`apps/desk/src/client/ticket.ts:162`).
Terminal messages close the edit in their message transaction
(`apps/desk/src/client/orders.ts:205`).

A response can arrive after its topic acceptance and even after an IOC fill
and cancellation. Comparing only current revision numbers was insufficient:
a newer revision need not acknowledge the submitted terms. Keep the last
accepted/amended acknowledgment per order in another checked
`CollectionField`, and compare the complete acknowledged order before
suppressing a duplicate response (`apps/desk/src/client/order-data.ts:69`,
`apps/desk/src/client/orders.ts:327`). Event-started command fibers join the
application scope (`apps/desk/src/client/desk.ts:367`).

**Inference:** optimistic compensation and conflict choice remain domain
workflows. Pinna supplies their atomic publication and rollback, not a network
transaction. Four independent watcher deliveries see either both old terms
or both optimistic terms; a concurrent fill survives refusal
(`apps/desk/test/orders.test.tsx:476`,
`apps/desk/test/orders.test.tsx:1171`).

## State inventory: every added or touched state owner

Checked means the writable state itself checks every write. A computed value
is plain even when all its dependencies are checked. Rollback projections,
conflict choices, and diagnostics are computed bookkeeping, not alternative
authoritative copies of input.

| State | Holds | Kind and Pinna API | Why |
| --- | --- | --- | --- |
| Every ticket and settings field `$text` | Exact typed string, including invalid text | Plain `box` in `FormField` | Editing must never throw or rewrite text (`apps/desk/src/client/form-field.ts:6`). |
| Every field `$accepted` | Side, two-place notional, pair-precision limit, time in force, future date, note, trimmed name, per-pair default, threshold | Checked `schemaBox` | A direct invalid write must fail independently of the form method (`apps/desk/src/client/form-field.ts:26`). |
| Every field `$serverError` | Exchange field error or null | Checked `schemaBox` | Server text is accepted outside data (`apps/desk/src/client/form-field.ts:9`). |
| Every field `$error` | Client validation error or server error | Plain `computed` | Derives a display result from text and checked error (`apps/desk/src/client/form-field.ts:10`). |
| `WorkingOrder.$value` | All accepted terms, symbol, filled amount, status, revision | Checked `BoxField(OrderValue)` in `SchemaModel` | Related invariants are checked together (`apps/desk/src/client/order-data.ts:64`). |
| `OrderBook.$orders` | Keyed, stable working-order models, including terminal rows | Checked `CollectionField(WorkingOrder)` | Validate inserted models and merge held models in place (`apps/desk/src/client/order-data.ts:69`). |
| `OrderBook.$acknowledgments` | Last acceptance/amendment wire value per order | Checked `CollectionField(OrderWire)` | Recognize validated response/topic overlap without accepting unrelated newer state (`apps/desk/src/client/order-data.ts:71`). |
| Ticket `$base` | Last checked exchange value used for edit comparison | Checked `schemaBox(NullOr(OrderValue))` | Every new base is an accepted exchange value (`apps/desk/src/client/ticket.ts:126`). |
| Ticket `$value`, `$fieldValid`, `$rules`, `$canSend`, `$needsConfirmation`, `$reason` | Payload projection, errors, live rules, eligibility, threshold comparison, displayed reason | Plain `computed` | Derived state; reads checked and plain dependencies without another validation layer (`apps/desk/src/client/ticket.ts:32`). |
| Ticket `$pending`, `$confirmation`, `$conflicts`, `$localReason` | Request lifetime, confirmation prompt, derived conflict choices, local diagnostics | Plain `box` | Workflow and comparison results, not accepted input (`apps/desk/src/client/ticket.ts:28`). |
| Ticket `$exchangeReason` | Accepted exchange refusal text | Checked `schemaBox` | Keep outside text checked independently of generated messages (`apps/desk/src/client/ticket.ts:30`). |
| Orders `$pending` | Immutable rollback projections indexed by order | Plain `box` | Derived snapshots advance with authoritative messages and roll back with updates (`apps/desk/src/client/orders.ts:51`). |
| Orders `$isPending`, `$keys`, `$feed` | Per-row pending view, keys, observation ownership | Plain `computedFunction`, `computed`, `fromStream` | Own keyed render scope and feed lifetime (`apps/desk/src/client/orders.ts:52`, `apps/desk/src/client/orders.ts:387`). |
| Orders `$ticket`, `$notice`, `$loaded`, `$rejections` | Active local model, generated notice, readiness, rejected-message count/path/reason | Plain `box` | Application state and validation results (`apps/desk/src/client/orders.ts:44`). |
| Account settings | Display name, five defaults, confirmation threshold | Checked `SchemaModel` with three `BoxField`s | One declared schema controls writes, decoding, and encoding (`apps/desk/src/client/account.ts:19`). |
| Account `$form`, `$dropped` | Local form reference and recovery diagnostics | Plain `box` | Generated UI state (`apps/desk/src/client/account.ts:42`). |
| Settings form `$pending`, `$message`, `$valid` | Save lifetime, generated result, aggregate field validity | Plain `box`, `computed` | No accepted domain value lives here (`apps/desk/src/client/account.ts:109`). |
| Tile `$notional` | Legacy market amount text, also saved by layouts | Plain `box`, replacing its old `schemaBox(String)` | This slice touches its confirmation path; raw text belongs in plain state (`apps/desk/src/client/desk.ts:50`). |
| Tile `$confirmation` | Requested market side awaiting confirmation | Plain `box` | Local intent; confirmation re-reads the live quote (`apps/desk/src/client/desk.ts:54`, `apps/desk/src/client/desk.ts:170`). |
| Tile `$execution` | Existing market command status | Existing checked `schemaBox`, retained | Existing status invariant remains (`apps/desk/src/client/desk.ts:53`). |
| Trade book `$trades` | Existing trades and new limit fills | Checked `CollectionField(Trade)`, replacing plain collection | New fills use this write path; every writer now faces the same trade schema (`apps/desk/src/client/trades.ts:50`). |
| Trade index roots, held count, selection, position ledgers | Derived ordering, count, selection bookkeeping, exact aggregates | Existing plain `box` and collection listeners, retained | Limit fills change the same derived state atomically (`apps/desk/src/client/trades.ts:134`, `apps/desk/src/client/position-book.ts:35`). |
| Prices, movement history, position marks and totals | High-frequency quotes and computed prices/profit/loss | Existing plain `box`, `fromStream`, `computed`, retained | New tickets share the existing topic; no new checked price store (`apps/desk/src/client/desk.ts:321`, `apps/desk/src/client/positions.ts:24`). |
| Simulator orders, account settings, random state, listeners | Exchange-owned in-memory data and scheduled messages | Ordinary exchange data; no Pinna | Preserve the client/exchange boundary (`apps/desk/src/exchange/orders.ts:101`, `apps/desk/test/boundary.test.ts:77`). |

Previously saved workspace fields and schemas otherwise retain their earlier
representation. Tickets, conflicts, settings forms, and pending requests are
not added to the workspace projection (`apps/desk/src/client/layouts.ts:115`).

## Where checked and plain state meet

1. A field's plain text is checked before a write to `$accepted`; its computed
   error reads both text and checked server errors. A failed direct accepted
   write leaves both the accepted value and subscriber history unchanged
   (`apps/desk/src/client/form-field.ts:28`,
   `apps/desk/test/orders.test.tsx:127`).
2. Ticket rules read checked field values and the plain live quote. Exact
   decimal arithmetic calculates distance from mid and the side-specific
   immediate-fill mark. Fields subscribe only to their own text/error; the
   marks and send control subscribe to rules. A price tick changes rule
   renders and produces zero field renders
   (`apps/desk/src/client/ticket.ts:55`,
   `apps/desk/src/client/orders-panel.tsx:9`,
   `apps/desk/test/orders.test.tsx:216`).
3. Plain edits and conflict choices compare with checked exchange bases.
   Choosing the exchange value goes through the field's checked acceptance
   again. The working row retains its checked model while the form retains
   unrelated raw text (`apps/desk/src/client/ticket.ts:162`,
   `apps/desk/test/orders.test.tsx:379`).
4. An amendment's derived rollback projection feeds checked `$value` writes.
   Pending state changes in the same update; invalid acknowledgments cannot
   keep an optimistic value. Intervening checked fills remain authoritative
   (`apps/desk/src/client/orders.ts:253`,
   `apps/desk/test/orders.test.tsx:1122`,
   `apps/desk/test/orders.test.tsx:1171`).
5. Checked fills update the plain blotter indexes and position ledgers through
   existing collection listeners. Those ledgers then join plain live marks
   and conversion prices. A rejecting listener rolls all of that back,
   including the checked order change
   (`apps/desk/src/client/orders.ts:216`,
   `apps/desk/test/orders.test.tsx:1075`).
6. A new ticket reads the checked account default once, so later settings do
   not overwrite its edit. Checked thresholds join checked limit notionals
   and plain market text at send time. Both limit and market confirmation
   recheck their current input; market confirmation uses the current quote
   (`apps/desk/src/client/ticket.ts:110`,
   `apps/desk/src/client/desk.ts:73`,
   `apps/desk/test/orders.test.tsx:1220`,
   `apps/desk/test/orders.test.tsx:1274`).
7. Settings recovery diagnostics and save status are plain generated results
   alongside checked account fields. Encoding an isolated candidate model
   avoids serializing any of those local fields
   (`apps/desk/src/client/account.ts:44`,
   `apps/desk/src/client/account.ts:160`).

## Pinna API choices and alternatives

| API used or considered | Result, alternative, and reason |
| --- | --- |
| `Model`, `box` | Own forms, workflow, rollback projections, and raw input. `SchemaModel` for those owners would introduce a wire format for local machinery (`apps/desk/src/client/form-field.ts:6`). |
| `schemaBox` | Check individual accepted form values, exchange errors, and edit bases. `BoxField` is used where a real wire model exists; plain boxes would permit invalid direct writes (`apps/desk/src/client/ticket.ts:126`). Default schema equality is retained; no `{ equals: Object.is }` override or weakened predicate is used. |
| `SchemaModel`, `BoxField` | Working orders and account settings decode and encode with checked state. A plain `Schema.Class` would not supply writable observable fields (`apps/desk/src/client/order-data.ts:64`, `apps/desk/src/client/account.ts:19`). Group related order fields in one box rather than pretending each independent field can validate the whole row. |
| `CollectionField`, `write.upsert`, `read.row` | Enforce checked keyed rows, merge order identity, and inspect without creating row cells in handlers. Plain `collection` would not check direct writers; a box of models would invalidate all rows (`apps/desk/src/client/orders.ts:125`). |
| `decode`, `SchemaModel.make` | Decode recovered wire settings and incoming order models; make local checked stores and isolated save candidates. Raw `new` adds no needed behavior. `disableChecks`, `extend`, `mapFields`, `makeOption`, and `makeEffect` are unused; the documented sealed methods do not supply recovery or drafts (`docs/dx.md:124`). |
| `reconcileSchema` | Apply account refetches into the held settings in the surrounding update. Order rows use `CollectionField`'s built-in merge, so an extra reconcile pass is unnecessary. Plain `reconcile` would keep only equal rows, without updating checked fields (`apps/desk/src/client/account.ts:86`). |
| `computed`, `computedFunction` | Derive rules, validity, keys, pending membership, and threshold comparisons. `watch`/`autorun` would maintain duplicate derived state after writes; `useSelect` would add a provider/layout effect without improving scope (`apps/desk/src/client/ticket.ts:55`, `apps/desk/src/client/orders.ts:52`). |
| `update`, `untracked` | Publish complete messages and amendment compensation; capture command input with a fresh read capability. No read or write closure crosses its place (`apps/desk/src/client/orders.ts:229`). |
| `onRowChange` | Retain existing trade indexes and position deltas after converting their source collection. It is deliberately not used to observe a working order's inner box (`apps/desk/src/client/trades.ts:134`). |
| `fromStream`, `RealmService` | Subscribe before snapshot and share observation-owned order and price feeds in one realm. A permanent price hold or another topic reference counter would violate the existing demand rule (`apps/desk/src/client/orders.ts:387`). |
| `useValue`, `useValues` | Read known observables in small memoized components. Order rows read their held box, fields their own text/error, and rule marks their own computed value (`apps/desk/src/client/orders-panel.tsx:9`). |
| `observeScoped`, `testRealm`, `record`, `watch`, `held` | Hold headless feeds, detect leaked listeners, and record every synchronous receipt. A coalescing `changes` stream cannot prove atomic delivery (`apps/desk/test/orders.test.tsx:476`, `apps/desk/test/orders.test.tsx:553`). |
| `FromContext` — considered, unused | Services are explicit application constructor capabilities, not fields of the account or order wire models. The documented omission from wire is useful but unnecessary here (`README.md:192`, `apps/playground/src/docs/models.ts:60`). |
| `watchScoped`, `changes` — considered, unused in new command handling | Latest-wins cancellation or sliding delivery does not express accepting/rejecting this particular order request. Existing application Effect scopes own those commands (`README.md:220`, `apps/desk/src/client/desk.ts:367`). |

No checked-state API used here required a substitute storage mechanism.
Manual field recovery, transition checks, error paths, three-way comparisons,
and asynchronous compensation implement domain policy around checked Pinna
state; they do not turn its checks off. Source reads were limited to the
repository, including `box.ts`, `class.ts`, `decode.ts`, `reconcile.ts`, and
`observable.ts`; no external Pinna documentation or Pinna internal import was
used in the application.

## Protocol decisions, errors, and coverage

**Decisions:** exchange dates use UTC, matching the simulated Effect clock.
`day`, `date`, and `immediate` are wire time-in-force values. Local limit IDs
use a separate `limit-local-N` sequence. Every message carries a whole order
value with a monotone revision; fill messages also carry the complete trade.
A malformed message changes no order, trade, index, or position; only the
rejection diagnostic changes (`apps/desk/src/client/orders.ts:112`). An
identical no-fill duplicate is a no-op. The simulator uses a separate seeded
generator for this slice, leaving the previous market-execution generator
alone (`apps/desk/src/exchange/orders.ts:63`). The runnable app seeds five
working orders; the simulator's default initial list is empty so preexisting
market-only callers retain their history (`apps/desk/src/main.tsx:21`,
`apps/desk/src/exchange/orders.ts:113`).

**Observed errors:** the first typecheck reported `TS2739` for a settings
record made with `Object.fromEntries`, and `TS2729: Property 'transport' is
used before its initialization` for an eager model field initializer.
The settings candidate now checks the assembled fixed-pair record, and the
account is created explicitly and passed to both market and limit owners
(`apps/desk/src/client/account.ts:164`,
`apps/desk/src/client/desk.ts:313`). A later `TS2367` rejected comparing a
generic schema object with the display-name schema; the diagnostic policy
now selects by the declared field path (`apps/desk/src/client/account.ts:57`).
Oracle expectations also hit the previously documented readonly-array
`TS2769`; reversing actual/expected preserves the independently typed oracle
(`apps/desk/test/orders.test.tsx:662`). These are application typing errors,
not observed schema failures.

The initial focused tests read pending state before their scheduled fork
started: `Expected: true; Received: false`, and `Expected length: 1; Received
length: 0`. Use the existing Effect pattern
`forkScoped({ startImmediately: true })`
(`apps/desk/test/orders.test.tsx:325`,
`apps/desk/test/orders.test.tsx:525`). Early DOM runs also reported updates
outside `act`; all mounted-view mutations now run inside it
(`apps/desk/test/orders.test.tsx:120`). Biome required an explicit label/control
association and a semantic fieldset for the rule group
(`apps/desk/src/client/orders-panel.tsx:23`,
`apps/desk/src/client/orders-panel.tsx:73`).

The first long oracle retained a full growing fill-ID array in every receipt
and was stopped with exit 130 after making no timely progress. Its replacement
keeps bounded order/count/position receipt summaries, checks every such
receipt against an independently folded accepted prefix, checks every
rejection's exact path/reason and unchanged neighboring state, and separately
checks the full final fill-ID sequence. This is a test-retention fix; it does
not remove a receipt or reject an inconvenient prefix
(`apps/desk/test/order-oracle.ts:1`,
`apps/desk/test/orders.test.tsx:553`). The run uses 1,500 seeded ticks,
requires more than 2,000 accepted states and 500 rejected messages, and checks
both order and fill subscriber channels.

Two initial legacy failures exposed new startup behavior: seeded limit fills
changed a market-only history assertion, and `/settings` added one request.
The simulator now opts into initial working orders explicitly. The old render
test still checks the exact request sequence; it now expects `/pairs` and
`/settings` rather than only one request
(`apps/desk/test/react.test.tsx:332`). No render-count, receipt-count, scale,
rollback, workspace, or subscription assertion was weakened.

| Requirement | Headless evidence |
| --- | --- |
| All ticket fields preserve invalid text, display errors, and refuse direct invalid writes | `apps/desk/test/orders.test.tsx:127`; includes both pair precisions and amounts beyond Number precision. |
| Price rules, absent quote, exact field render scope, and last-reader price cleanup | `apps/desk/test/orders.test.tsx:216`; both sides' immediate-fill marks, ten-percent changes, zero field renders per tick. |
| Confirmation, pending state, exchange refusal, exact request body, successful acceptance | `apps/desk/test/orders.test.tsx:301`. |
| Thousands of good messages mixed with every seeded malformed category; every receipt is a valid log prefix | `apps/desk/test/orders.test.tsx:553`, independent fold at `apps/desk/test/order-oracle.ts:1`. |
| No mutation on bad messages; precise paths; next good revision succeeds; invalid direct collection writes fail | `apps/desk/test/orders.test.tsx:700`. |
| Retain unrelated edits; expose both conflict values; support both choices; keep row identity; close on all terminal statuses | `apps/desk/test/orders.test.tsx:379`. |
| Atomic optimistic amendment and full refusal compensation | `apps/desk/test/orders.test.tsx:476`. |
| Fractional fills and failures after the order write roll back trades, indexes, and positions too | `apps/desk/test/orders.test.tsx:1075`. |
| Malformed amendment response rolls back with a field path; concurrent fills survive refusal | `apps/desk/test/orders.test.tsx:1122`, `apps/desk/test/orders.test.tsx:1171`. |
| Settings partial recovery, dropped paths/reasons, checked direct writes, per-field refusal, exact encoding, returned settings authority | `apps/desk/test/orders.test.tsx:794`. |
| Real simulator fills and rounds an amendment in place; IOC cancels remainder; UTC expiry | `apps/desk/test/orders.test.tsx:944`, `apps/desk/test/orders.test.tsx:1032`. |
| Threshold also gates market orders; confirmation reads a fresh quote; every open tile has a ticket action | `apps/desk/test/orders.test.tsx:1220`, `apps/desk/test/orders.test.tsx:1274`. |
| Application-scope cancellation prevents later request writes | `apps/desk/test/orders.test.tsx:1320`. |

No browser session or production build was run. React runs in the existing
DOM environment (`apps/desk/test/setup.ts:1`). The root's
`documentation-voice` skill remains absent from the supplied catalog and
searched local skill roots, as in the sixth-slice account; this continuation
retains the existing observation/decision/inference register.

## Seventh-slice measurements beside the sixth slice

Same reported machine/runtime: Apple M1 Pro, arm64, Darwin 24.6.0, Bun 1.4.4,
JavaScriptCore with concurrent JIT disabled. The unchanged script measures
250 settled samples after 20 warmups; sort has four samples, filtering six,
and scroll 250 (`apps/desk/scripts/measure.ts:90`). Sixth-slice references are
above in this file's sixth-slice measurement table.

| Operation, milliseconds: median / 95th percentile unless noted | Sixth: 10,000 | Seventh: 10,000 | Sixth: 100,000 | Seventh: 100,000 |
| --- | ---: | ---: | ---: | ---: |
| Snapshot load, single measurement | 177.034 | 177.457 | 712.416 | 719.611 |
| New incoming trade | 0.048 / 0.648 | 0.044 / 0.435 | 0.824 / 1.429 | 0.810 / 1.428 |
| Held-trade update / done trade through positions and blotter | 0.039 / 0.728 | 0.038 / 0.606 | 0.045 / 0.384 | 0.033 / 0.217 |
| GBP/USD tick through positions | 0.030 / 0.344 | 0.028 / 0.275 | 0.025 / 0.046 | 0.024 / 0.039 |
| Change sort | 15.964 / 35.537 | 12.599 / 33.756 | 205.751 / 365.444 | 141.461 / 321.539 |
| Filter keystroke | 5.277 / 7.177 | 4.749 / 5.922 | 62.039 / 68.383 | 52.841 / 59.796 |
| Scroll one row | 0.001 / 0.008 | 0.001 / 0.003 | 0.001 / 0.002 | 0.001 / 0.001 |

Raw seventh-slice filter edits `d`, `de`, `des`, `desk`, `desk-`, `desk-2`:
4.749, 5.922, 4.944, 3.460, 3.243, 3.757 ms at 10,000;
41.861, 52.789, 52.841, 59.796, 55.357, 52.311 ms at 100,000.
An earlier run in this session measured snapshot load at 276.352 / 724.156 ms;
these are single wall-clock observations, not isolated speed claims.

**Inference:** existing held-trade work stays independent of held-history
size, while new-key insertion still has the collection's ordered-key copy.
Checked rows do not remove that existing cost. These measurements do not
measure form rendering or claim a schema-overhead speedup. The separate
seeded-message and render tests establish those correctness properties.

## Seventh-slice check results

| Command, from the worktree root | Result |
| --- | --- |
| `bun run --cwd apps/desk typecheck` | Final exit 0. Earlier typing failures and fixes are recorded above. |
| `bun run --cwd apps/desk test` | Final exit 0; 68 passed, 0 failed, 35,912 assertions across ten files. |
| `bun run --cwd apps/desk measure` | Exit 0; both history sizes completed; full numbers above. |
| `bunx biome check apps/desk` | Exit 0; 44 files checked, no fixes applied. |
| `bunx biome check --write apps/desk` | Scoped formatting, import organization, and label fixes; final exit 0. |

No requested feature remains unfinished. Changes are confined to `apps/desk`;
no dependencies were added, no install ran, no library files changed, and no
commit, branch switch, or remote action occurred. Keep raw editing, accepted
values, live eligibility, and asynchronous command compensation as distinct
state responsibilities.
