// The site's docs print the regions of this file (docs/public/guides/live-data.md), so
// `bun run typecheck` compiles what the page shows. The same feed on Effect is
// `liveDataEffect.ts`.
import {
  atom,
  box,
  collection,
  computed,
  computedFunction,
  createRealm,
  Model,
  onObserved,
  type Realm,
  reconcile,
  update,
  watch,
} from "@frondruntime/pinna";

// #region message
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
// #endregion

// #region feed
type Status = "connecting" | "open" | "closed";

const quotesUrl = "wss://example.com/quotes";

class QuoteFeed extends Model {
  // Stands for the socket: observing any public field below opens it.
  private readonly $socket = atom(this.realm);
  private readonly $state = box<Status>(this.realm, "closed");
  private readonly $rows = collection(this.realm, {
    keyOf: (quote: Quote) => quote.symbol,
    // A snapshot builds new objects; a quote with the same prices is kept.
    equals: (previous, next) => previous.bid === next.bid && previous.ask === next.ask,
  });

  readonly $status = computed(this.realm, (read) => {
    read(this.$socket);
    return read(this.$state);
  });

  readonly $symbols = computed(this.realm, (read) => {
    read(this.$socket);
    return read(this.$rows.keys);
  });

  readonly quote = computedFunction(this.realm, (read, symbol: string) => {
    read(this.$socket);
    return read.row(this.$rows, symbol);
  });

  constructor(realm: Realm) {
    super(realm);
    onObserved(this.$socket, () => this.connect());
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
    update(this.realm, (_read, write) => write(this.$state, status));
  }

  private receive(data: unknown): void {
    const message = parseMessage(data);
    if (message === undefined) {
      // The host's error sink, which a realm made without onError uses too.
      reportError(new TypeError("quotes: dropped a message that is not one"));
      return;
    }
    // One update per message: a reader sees all of it or none of it.
    update(this.realm, (_read, write) => {
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
// #endregion

// #region observe
const realm = createRealm();
const feed = new QuoteFeed(realm);

// The first observer opens the socket; stopping the last one closes it.
const stop = watch(
  realm,
  (read) => read(feed.$status),
  (status) => {
    console.log(`quotes: ${status}`);
  },
);
// #endregion

// #region fetch
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

class Positions extends Model {
  readonly $rows = box<ReadonlyArray<Position>>(this.realm, []);
  readonly $load = box<Load>(this.realm, { state: "loading" });
  private controller: AbortController | undefined;

  // Loads the account's positions. A newer call aborts this one, and an
  // aborted call writes nothing, so the last call wins. The rows stay on
  // screen while the next ones load.
  async refresh(account: string): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    update(this.realm, (_read, write) => write(this.$load, { state: "loading" }));
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
      update(this.realm, (read, write) => {
        // Unchanged positions keep their instance; nothing changed keeps the array.
        write(
          this.$rows,
          reconcile(read(this.$rows), next, {
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
      update(this.realm, (_read, write) => write(this.$load, { state: "failed", error }));
    }
  }
}

// #endregion

export { feed, Positions, stop };
