# Live data: With Effect

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->
From docs/public/guides/live-data.md, its section "With Effect".

## With Effect

The same feed as an Effect program. `Schema.fromJsonString` parses and
checks a message in one step, and fails with a `SchemaError` for anything
that does not fit.

```ts
import { Schema } from "effect";

const Quote = Schema.Struct({
  symbol: Schema.String,
  bid: Schema.Finite,
  ask: Schema.Finite,
});
type Quote = typeof Quote.Type;

const QuoteMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), quotes: Schema.Array(Quote) }),
  Schema.Struct({ type: Schema.Literal("upsert"), quote: Quote }),
  Schema.Struct({ type: Schema.Literal("delete"), symbol: Schema.String }),
]);
type QuoteMessage = typeof QuoteMessage.Type;

// Parses the JSON and checks it in one step; fails with a SchemaError.
const decodeMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(QuoteMessage));
```

The watchlist is a `Model.boxField`, checked on every write: people type it, and
it is saved with the board. The quotes are a plain collection and the status
a plain box, written only from messages the decode checked, so nothing checks
them twice ([Plain or schema boxes](https://pinna.frondruntime.dev/docs/start#plain-or-schema-boxes)).
Loosening a field's schema to make the feed fast would leave every other
writer of that field unchecked; the hot rows go in a plain collection
instead.

```ts
import { Box, Collection, Model, Realm } from "@frondruntime/pinna-effect";
import { Schema } from "effect";

type Status = "connecting" | "open" | "closed";

class QuoteBoard extends Model.Schema<QuoteBoard>("QuoteBoard")({
  // Typed by people and saved with the board: every write is checked.
  $watchlist: Model.boxField(Schema.Array(Schema.String)),
}) {
  // Written by the feed alone, from messages the decode checked: checked nowhere else.
  readonly $quotes = Collection.make(this.realm, {
    keyOf: (quote: Quote) => quote.symbol,
    equals: Schema.toEquivalence(Quote),
  });
  readonly $status = Box.make<Status>(this.realm, "closed");

  setStatus(status: Status): void {
    Realm.update(this.realm, (_read, write) => write(this.$status, status));
  }

  add(symbol: string): void {
    Realm.update(this.realm, (read, write) =>
      write(this.$watchlist, [...read(this.$watchlist), symbol]),
    );
  }

  // One update per message: a reader sees all of it or none of it.
  receive(message: QuoteMessage): void {
    Realm.update(this.realm, (_read, write) => {
      switch (message.type) {
        case "snapshot":
          return write.replaceAll(this.$quotes, message.quotes);
        case "upsert":
          return write.upsert(this.$quotes, message.quote, { at: "end" });
        case "delete":
          return write.remove(this.$quotes, message.symbol);
      }
    });
  }
}
```

`Stream.callback` turns the socket's callbacks into a stream. The socket
opens in `Effect.acquireRelease`, so closing the stream's scope closes it,
and a drop fails the stream with `SocketClosed`.

```ts
import { Cause, Data, Effect, Queue, Stream } from "effect";

class SocketClosed extends Data.TaggedError("SocketClosed")<{ readonly code: number }> {}

// Each message the socket receives. The stream fails with SocketClosed when
// the socket closes, and closing the stream's scope closes the socket.
const socket = (url: string, onOpen: () => void): Stream.Stream<string, SocketClosed> =>
  Stream.callback<string, SocketClosed>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const next = new WebSocket(url);
        next.onopen = onOpen;
        next.onmessage = (event: MessageEvent) => {
          Queue.offerUnsafe(queue, String(event.data));
        };
        next.onclose = (event: CloseEvent) => {
          Queue.failCauseUnsafe(queue, Cause.fail(new SocketClosed({ code: event.code })));
        };
        return next;
      }),
      (next) =>
        Effect.sync(() => {
          next.onclose = null;
          next.close();
        }),
    ),
  );
```

`Program.changes` streams the watchlist, and `Stream.switchMap` closes the socket
of the previous list and opens one for the new list. `Stream.retry` reopens
the socket after a drop, and its schedule resets once a message passes
through. Each message is decoded, then written in one update; a message
that fails either step is logged and dropped.

```ts
import { Program } from "@frondruntime/pinna-effect";
import { Effect, Schedule, Stream } from "effect";

const quotesUrl = "wss://example.com/quotes";

// 0.5 s after a drop, doubling up to 30 s; a message that arrives resets it.
const reconnect = Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("30 seconds")]);

// Follows the board's watchlist: a new list closes the socket and opens one for it.
const follow = Effect.fn("follow")(function* (board: QuoteBoard) {
  yield* Program.changes(board.$watchlist).pipe(
    Stream.switchMap((symbols) => {
      const url = `${quotesUrl}?symbols=${symbols.map(encodeURIComponent).join(",")}`;
      return socket(url, () => board.setStatus("open")).pipe(
        Stream.onStart(Effect.sync(() => board.setStatus("connecting"))),
        Stream.tapError(() => Effect.sync(() => board.setStatus("closed"))),
        Stream.retry(reconnect),
      );
    }),
    Stream.runForEach((data) =>
      decodeMessage(data).pipe(
        // A write that throws, such as a snapshot that repeats a symbol, is undone.
        Effect.flatMap((message) => Effect.try(() => board.receive(message))),
        Effect.catch((error) => Effect.logWarning("quotes: dropped a message", error)),
      ),
    ),
  );
});
```

A layer provides the realm. The fiber owns the feed: the socket is open
while the fiber runs, whether or not anything observes the board, and
interrupting the fiber closes it. A value that should run only while a
screen shows it is owned by observation instead, through `Program.fromStream`
([Programs](programs.md#lifetimes)).

```ts
import { Model, Realm, RealmService } from "@frondruntime/pinna-effect";
import { Effect, Fiber, Layer } from "effect";

const realm = Realm.make();
const RealmLive = Layer.succeed(RealmService, realm);

// Throws a DecodeError, holding the SchemaError, when the saved board does not fit.
const board = Model.decode(realm, QuoteBoard)({ watchlist: ["ACME", "GLOBEX"] });

// The socket is open while the fiber runs.
const fiber = Effect.runFork(follow(board).pipe(Effect.provide(RealmLive)));

// Interrupting the fiber closes the socket.
const close = () => Effect.runFork(Fiber.interrupt(fiber));
```

- Wrap the write in `Effect.try`. A throw inside `Effect.sync` is a defect,
  and a defect in `Stream.runForEach` ends the program, socket and all.
  `Effect.try` makes it an error the program logs; the update has already
  undone the write.
- Write each status in the stage that knows it: `Stream.onStart` for
  `"connecting"`, the socket's `onopen` for `"open"`, and `Stream.tapError`,
  before `Stream.retry`, for `"closed"`. Without `Stream.tapError`, the
  status stays `"open"` through every reconnect wait.
