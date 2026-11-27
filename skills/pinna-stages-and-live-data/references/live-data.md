# Live data: Example, Rules

<!-- Generated in the Pinna repository (github.com/frondruntime/pinna) by scripts/skills/build.ts; a change goes there, not in this file. -->
From docs/public/guides/live-data.md, its sections "Example", "Rules", "See also".

Sections: Example, Rules, See also.

## Example

A quote feed keeps one row per symbol, written from a WebSocket. The server
sends a snapshot of every quote when the socket opens, then one change per
message. The parser checks each message by hand, builds new objects with
the fields a quote has, and returns `undefined` for anything else.

```ts
interface Quote {
  readonly symbol: string;
  readonly bid: number;
  readonly ask: number;
}

type QuoteMessage =
  | { readonly type: "snapshot"; readonly quotes: ReadonlyArray<Quote> }
  | { readonly type: "upsert"; readonly quote: Quote }
  | { readonly type: "delete"; readonly symbol: string };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const isPrice = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

// A new object with a quote's fields alone, or undefined.
const toQuote = (value: unknown): Quote | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const { symbol, bid, ask } = value;
  return typeof symbol === "string" && isPrice(bid) && isPrice(ask)
    ? { symbol, bid, ask }
    : undefined;
};

// The message in `data`, or undefined. A snapshot that repeats a symbol is
// no message: `write.replaceAll` would throw on it.
const parseMessage = (data: unknown): QuoteMessage | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(String(data));
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const { type, quotes, quote, symbol } = value;
  if (type === "snapshot" && Array.isArray(quotes)) {
    const parsed: Array<Quote> = [];
    const seen = new Set<string>();
    for (const item of quotes) {
      const next = toQuote(item);
      if (next === undefined || seen.has(next.symbol)) {
        return undefined;
      }
      seen.add(next.symbol);
      parsed.push(next);
    }
    return { type, quotes: parsed };
  }
  if (type === "upsert") {
    const next = toQuote(quote);
    return next === undefined ? undefined : { type, quote: next };
  }
  if (type === "delete" && typeof symbol === "string") {
    return { type, symbol };
  }
  return undefined;
};
```

The socket is open while something observes the feed. A private atom stands
for the socket, and `$status`, `$symbols`, and each `quote(symbol)` read it,
so the first observer of any of them runs `connect`, and the last one
leaving runs its cleanup, which closes the socket and cancels a pending
reconnect. A hook on `keys` would miss a reader of one row: `row(key)` never
reads `keys`.

```ts
import { Atom, Box, Collection, Computed, Model, Realm, Source } from "@frondruntime/pinna";

type Status = "connecting" | "open" | "closed";

const quotesUrl = "wss://example.com/quotes";

class QuoteFeed extends Model.Class {
  // Stands for the socket: observing any public field below opens it.
  private readonly $socket = Atom.make(this.realm);
  private readonly $state = Box.make<Status>(this.realm, "closed");
  private readonly $rows = Collection.make(this.realm, {
    keyOf: (quote: Quote) => quote.symbol,
    // A snapshot builds new objects; a quote with the same prices is kept.
    equals: (previous, next) => previous.bid === next.bid && previous.ask === next.ask,
  });

  readonly $status = Computed.make(this.realm, (read) => {
    read(this.$socket);
    return read(this.$state);
  });

  readonly $symbols = Computed.make(this.realm, (read) => {
    read(this.$socket);
    return read(this.$rows.keys);
  });

  readonly quote = Computed.fn(this.realm, (read, symbol: string) => {
    read(this.$socket);
    return read.row(this.$rows, symbol);
  });

  constructor(realm: Realm) {
    super(realm);
    Source.onObserved(this.$socket, () => this.connect());
  }

  // Opens the socket, and reopens it after each drop: 0.5 s after the
  // first, doubling up to 30 s, back to 0.5 s once a message arrives.
  // Returns what closes it. The state lives in this call, so a socket from
  // an earlier observation never schedules a reconnect.
  private connect(): () => void {
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const open = () => {
      this.setStatus("connecting");
      const next = new WebSocket(quotesUrl);
      next.onopen = () => {
        this.setStatus("open");
      };
      next.onmessage = (event: MessageEvent) => {
        attempt = 0;
        this.receive(event.data);
      };
      next.onclose = () => {
        this.setStatus("closed");
        timer = setTimeout(open, Math.min(30_000, 500 * 2 ** attempt));
        attempt++;
      };
      socket = next;
    };
    open();
    return () => {
      clearTimeout(timer);
      if (socket !== undefined) {
        socket.onclose = null;
        socket.close();
      }
    };
  }

  private setStatus(status: Status): void {
    Realm.update(this.realm, (_read, write) => write(this.$state, status));
  }

  private receive(data: unknown): void {
    const message = parseMessage(data);
    if (message === undefined) {
      // The host's error sink, which a realm made without onError uses too.
      reportError(new TypeError("quotes: dropped a message that is not one"));
      return;
    }
    // One update per message: a reader sees all of it or none of it.
    Realm.update(this.realm, (_read, write) => {
      switch (message.type) {
        case "snapshot":
          // A quote equal to the one held keeps its row and notifies nobody.
          return write.replaceAll(this.$rows, message.quotes);
        case "upsert":
          return write.upsert(this.$rows, message.quote, { at: "end" });
        case "delete":
          return write.remove(this.$rows, message.symbol);
      }
    });
  }
}
```

A watch, an autorun, `Source.observe`, or a mounted `useValue(feed.$symbols)` opens
the socket.

```ts
import { Realm } from "@frondruntime/pinna";

const realm = Realm.make();
const feed = new QuoteFeed(realm);

// The first observer opens the socket; stopping the last one closes it.
const stop = Realm.watch(
  realm,
  (read) => read(feed.$status),
  (status) => {
    console.log(`quotes: ${status}`);
  },
);
```

A request is the same shape without a socket. An `AbortController` cancels
the request a newer one replaces, and `Collection.reconcile` keeps each unchanged row's
instance, so a refetch that changed nothing notifies nobody. The parser
reuses `isRecord` and `isPrice` from the first sample and throws on a body
that does not fit, and the status ends in `"failed"`.

```ts
import { Box, Collection, Model, Realm } from "@frondruntime/pinna";

interface Position {
  readonly id: string;
  readonly symbol: string;
  readonly quantity: number;
}

type Load =
  | { readonly state: "loading" }
  | { readonly state: "loaded" }
  | { readonly state: "failed"; readonly error: unknown };

const positionsUrl = "https://example.com/positions";

const toPosition = (value: unknown): Position => {
  if (isRecord(value)) {
    const { id, symbol, quantity } = value;
    if (typeof id === "string" && typeof symbol === "string" && isPrice(quantity)) {
      return { id, symbol, quantity };
    }
  }
  throw new TypeError("positions: a row is not a position");
};

class Positions extends Model.Class {
  readonly $rows = Box.make<ReadonlyArray<Position>>(this.realm, []);
  readonly $load = Box.make<Load>(this.realm, { state: "loading" });
  private controller: AbortController | undefined;

  // Loads the account's positions. A newer call aborts this one, and an
  // aborted call writes nothing, so the last call wins. The rows stay on
  // screen while the next ones load.
  async refresh(account: string): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    Realm.update(this.realm, (_read, write) => write(this.$load, { state: "loading" }));
    try {
      const response = await fetch(`${positionsUrl}/${encodeURIComponent(account)}`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`positions: the server answered ${response.status}`);
      }
      const body: unknown = await response.json();
      if (!Array.isArray(body)) {
        throw new TypeError("positions: the body is not a list");
      }
      const next = body.map(toPosition);
      if (controller.signal.aborted) {
        return;
      }
      Realm.update(this.realm, (read, write) => {
        // Unchanged positions keep their instance; nothing changed keeps the array.
        write(
          this.$rows,
          Collection.reconcile(read(this.$rows), next, {
            keyOf: (position) => position.id,
            equals: (previous, current) =>
              previous.symbol === current.symbol && previous.quantity === current.quantity,
          }),
        );
        write(this.$load, { state: "loaded" });
      });
    } catch (error) {
      // An aborted fetch rejects too; the newer call owns the status.
      if (controller.signal.aborted) {
        return;
      }
      Realm.update(this.realm, (_read, write) => write(this.$load, { state: "failed", error }));
    }
  }
}
```

## Rules

- Write each message in one update. A reader then sees a snapshot whole or
  not at all; a write per row would show every row in between.
- Write a snapshot through `write.replaceAll` on a collection with `equals`.
  An unchanged row keeps its instance, so a reconnect that sends the same
  quotes reruns no reader. `write.replaceAll` throws on a repeated key and
  writes nothing, so reject one at the boundary.
- Await a request, then write its result in an update of its own: an update
  is synchronous ([Updates](https://pinna.frondruntime.dev/docs/state/updates.md)).
- Check that a request was not aborted before writing its result or its
  failure. An aborted `fetch` rejects, and without the check the older
  request's failure overwrites the newer one's `"loading"`.
- The hook writes `"connecting"`, in an update. The cleanup writes nothing,
  so rows and status stay as last written while nothing observes the feed,
  and the next snapshot replaces the rows.
- Keep a connection's state inside the call that opens it, and detach the
  socket's `onclose` before closing it, so a socket from an earlier
  observation schedules no reconnect.
- A message the parser drops goes to the host's `reportError`, where a realm
  made without `onError` also reports. A realm made with `onError` does not
  see it.

`Source.onObserved` and atoms are on [Lifecycles](lifecycles.md), the
writes to a collection on [Collections](https://pinna.frondruntime.dev/docs/state/collections.md), and
`Collection.reconcile` on [Updates](https://pinna.frondruntime.dev/docs/state/updates.md).

## See also

- [Lifecycles](lifecycles.md): `Source.onObserved`, atoms, and `Source.observe`.
- [Collections](https://pinna.frondruntime.dev/docs/state/collections.md): `keys`, `row(key)`, and `equals`.
- [Updates](https://pinna.frondruntime.dev/docs/state/updates.md): what an update undoes when it throws.
- [Programs](https://pinna.frondruntime.dev/docs/effect/programs.md): `Program.changes`, `Program.watchScoped`, `Program.fromStream`, and who owns a feed.
- [Classes](https://pinna.frondruntime.dev/docs/effect/classes.md): `Model.Schema`, `Model.boxField`, and `Model.decode`.
- [Hooks](https://pinna.frondruntime.dev/docs/react/hooks.md): `useValue` and a list that rerenders one row.
