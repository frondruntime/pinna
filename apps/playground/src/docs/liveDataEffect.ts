// The site's docs print the regions of this file (docs/public/guides/live-data.md), so
// `bun run typecheck` compiles what the page shows. The feed without Effect is
// `liveData.ts`.
import { Box, Collection, Model, Program, Realm, RealmService } from "@frondruntime/pinna-effect";
import { Cause, Data, Effect, Fiber, Layer, Queue, Schedule, Schema, Stream } from "effect";

// #region schema
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
// #endregion

// #region board
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
// #endregion

// #region socket
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
// #endregion

// #region program
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
// #endregion

// #region run
const realm = Realm.make();
const RealmLive = Layer.succeed(RealmService, realm);

// Throws a DecodeError, holding the SchemaError, when the saved board does not fit.
const board = Model.decode(realm, QuoteBoard)({ watchlist: ["ACME", "GLOBEX"] });

// The socket is open while the fiber runs.
const fiber = Effect.runFork(follow(board).pipe(Effect.provide(RealmLive)));

// Interrupting the fiber closes the socket.
const close = () => Effect.runFork(Fiber.interrupt(fiber));

// #endregion

export { close };
