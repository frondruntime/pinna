import {
  box,
  type Computed,
  computed,
  Model,
  type Realm,
  untracked,
  update,
  watch,
} from "@frondruntime/pinna";
import { RealmService, schemaBox, whileObserved } from "@frondruntime/pinna-effect";
import { Clock, Effect, type Fiber, Option, type Scope, Stream } from "effect";
import type { Transport } from "../transport.ts";
import { Account } from "./account.ts";
import { Layouts } from "./layouts.ts";
import { compareDecimal } from "./order-data.ts";
import { makeOrders, type Orders } from "./orders.ts";
import { Positions } from "./positions.ts";
import { makeTradeBook, type TradeBook } from "./trades.ts";
import {
  type Direction,
  decodePairs,
  decodePrice,
  decodeTradeMessage,
  ExecutionState,
  isPositiveDecimal,
  type Pair,
  type PairSymbol,
  type Price,
} from "./wire.ts";
import { defaultNotional, type WorkspaceStore } from "./workspace-data.ts";

export interface PriceState {
  readonly current: Price | null;
  readonly previous: Price | null;
  readonly error: string | null;
}

export interface PriceDisplay {
  readonly bid: string;
  readonly ask: string;
  readonly spreadPips: string;
  readonly movement: "up" | "down" | "unchanged";
  readonly error: string | null;
}

const units = (decimal: string) => BigInt(decimal.replace(".", ""));

export class Desk extends Model {
  readonly $notional = box(this.realm, defaultNotional, {
    name: "Desk.notional",
  });
  readonly $execution = schemaBox(this.realm, ExecutionState, "idle", { name: "Desk.execution" });
  readonly $confirmation = box<Direction | null>(this.realm, null);
  readonly $canExecute = computed(
    this.realm,
    (read) =>
      isPositiveDecimal(read(this.$notional)) &&
      read(this.$execution) !== "pending" &&
      read(this.$prices).current !== null,
  );
  private active: { readonly id: string } | undefined;
  private running: Fiber.Fiber<void> | undefined;

  setNotional(value: string) {
    update(this.realm, (_read, write) => {
      write(this.$notional, value);
      write(this.$confirmation, null);
    });
  }

  /** React only starts/stops this program; its state and clock live outside React. */
  execute(direction: Direction, seenRate?: string, confirmed = false) {
    const desk = this;
    return Effect.suspend(() => {
      const input = untracked(desk.realm, (read) => ({
        allowed: read(desk.$canExecute),
        notional: read(desk.$notional),
        price: read(desk.$prices).current,
        threshold: read(desk.account.settings.$confirmationThreshold),
      }));
      if (!input.allowed || input.price === null) return Effect.void;
      if (!confirmed && compareDecimal(input.notional, input.threshold) > 0) {
        update(desk.realm, (_read, write) => write(desk.$confirmation, direction));
        return Effect.void;
      }
      desk.cancelExecution();
      const token = { id: desk.nextOrderId() };
      desk.active = token;
      const request = {
        id: token.id,
        symbol: desk.pair.symbol,
        direction,
        notional: input.notional,
        rate: seenRate ?? (direction === "buy" ? input.price.ask : input.price.bid),
      };
      const current = () => desk.active === token;
      const setState = (state: ExecutionState) => {
        if (current()) update(desk.realm, (_read, write) => write(desk.$execution, state));
      };
      return Effect.gen(function* () {
        const time = new Date(yield* Clock.currentTimeMillis).toISOString();
        yield* desk.trades.accept(
          {
            ...request,
            desk: "local",
            status: "pending",
            createdAt: time,
            updatedAt: time,
          },
          true,
        );
        setState("pending");
        const answer = yield* desk.transport.request("/execute", JSON.stringify(request)).pipe(
          Effect.flatMap((raw) => decodeTradeMessage(raw)),
          Effect.tapError((error) =>
            Effect.logWarning("desk: execution response failed validation or transport", error),
          ),
          Effect.option,
          Effect.timeoutOption(2000),
        );
        if (!current()) return;
        if (Option.isNone(answer)) {
          desk.trades.withdraw(token.id);
          setState("timed out");
        } else if (Option.isNone(answer.value)) {
          desk.trades.withdraw(token.id);
          setState("rejected");
        } else {
          const trade = answer.value.value;
          // A valid but unrelated response is still an invalid execution answer.
          if (
            trade.id !== token.id ||
            trade.symbol !== request.symbol ||
            trade.direction !== direction ||
            trade.notional !== input.notional ||
            trade.rate !== request.rate ||
            trade.desk !== "local" ||
            trade.status === "pending"
          ) {
            yield* Effect.logWarning("desk: dropped mismatched execution response");
            desk.trades.withdraw(token.id);
            setState("rejected");
          } else {
            yield* desk.trades.accept(trade);
            setState(trade.status);
          }
        }
        yield* Effect.sleep(3000);
        setState("idle");
        if (current()) desk.active = undefined;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (current()) {
              if (untracked(desk.realm, (read) => read(desk.$execution)) === "pending")
                desk.trades.withdraw(token.id);
              setState("idle");
              desk.active = undefined;
            }
          }),
        ),
      );
    });
  }

  startExecution(direction: Direction, seenRate: string) {
    this.running = this.runExecution(this.execute(direction, seenRate));
  }
  confirmExecution() {
    const direction = untracked(this.realm, (read) => read(this.$confirmation));
    if (direction) this.running = this.runExecution(this.execute(direction, undefined, true));
  }
  dismissConfirmation() {
    update(this.realm, (_read, write) => write(this.$confirmation, null));
  }

  cancelExecution() {
    this.dismissConfirmation();
    const active = this.active;
    this.active = undefined;
    this.running?.interruptUnsafe();
    this.running = undefined;
    if (active !== undefined) {
      if (untracked(this.realm, (read) => read(this.$execution)) === "pending")
        this.trades.withdraw(active.id);
      update(this.realm, (_read, write) => write(this.$execution, "idle"));
    }
  }
  readonly $display = computed<PriceDisplay>(
    this.realm,
    (read) => {
      const { current, previous, error } = read(this.$prices);
      if (current === null) {
        return { bid: "—", ask: "—", spreadPips: "—", movement: "unchanged", error };
      }
      const spread = units(current.ask) - units(current.bid);
      const movement =
        previous === null
          ? 0n
          : units(current.bid) + units(current.ask) - units(previous.bid) - units(previous.ask);
      return {
        bid: current.bid,
        ask: current.ask,
        spreadPips: `${spread / 10n}.${spread % 10n}`,
        movement: movement > 0n ? "up" : movement < 0n ? "down" : "unchanged",
        error,
      };
    },
    {
      name: "Desk.display",
      equals: (previous, next) =>
        previous.bid === next.bid &&
        previous.ask === next.ask &&
        previous.spreadPips === next.spreadPips &&
        previous.movement === next.movement &&
        previous.error === next.error,
    },
  );

  constructor(
    realm: Realm,
    readonly pair: Pair,
    readonly $prices: Computed<PriceState>,
    readonly trades: TradeBook,
    private readonly transport: Transport,
    private readonly runExecution: (program: Effect.Effect<void>) => Fiber.Fiber<void>,
    private readonly nextOrderId: () => string,
    readonly account: Account,
  ) {
    super(realm);
  }
}

export class Workspace extends Model implements Disposable {
  readonly $openSymbols;
  readonly $panelShown = box(this.realm, true);
  readonly positions: Positions;
  readonly layouts: Layouts;
  private readonly stopClosing: () => void;
  /** A coherent headless view with exactly the same conditional dependencies as the UI. */
  readonly $view = computed(this.realm, (read) => ({
    tiles: read(this.$openSymbols).map((symbol) => ({
      symbol,
      price: read(this.tile(symbol).$prices).current,
    })),
    positions: read(this.$panelShown)
      ? read(this.positions.$symbols).map((symbol) => read(this.positions.row(symbol).$value))
      : [],
    total: read(this.$panelShown) ? read(this.positions.$total) : null,
  }));
  constructor(
    realm: Realm,
    readonly tiles: readonly Desk[],
    readonly trades: TradeBook,
    readonly orders: Orders,
    store?: WorkspaceStore,
  ) {
    super(realm);
    this.$openSymbols = box<readonly PairSymbol[]>(
      realm,
      tiles.map((tile) => tile.pair.symbol),
    );
    this.positions = new Positions(realm, tiles, trades);
    this.layouts = new Layouts(this, store);
    // Cancellation cannot roll back. Wait for a successful outer update before interrupting.
    this.stopClosing = watch(
      realm,
      (read) => read(this.$openSymbols),
      (open, previous) => {
        for (const symbol of previous)
          if (!open.includes(symbol)) this.tile(symbol).cancelExecution();
      },
    );
  }
  tile(symbol: PairSymbol) {
    const tile = this.tiles.find((tile) => tile.pair.symbol === symbol);
    if (!tile) throw new Error(`pair is not listed: ${symbol}`);
    return tile;
  }
  closeTile(symbol: PairSymbol) {
    this.tile(symbol);
    update(this.realm, (read, write) =>
      write(
        this.$openSymbols,
        read(this.$openSymbols).filter((open) => open !== symbol),
      ),
    );
  }
  openTile(symbol: PairSymbol) {
    this.tile(symbol);
    update(this.realm, (read, write) => {
      if (!read(this.$openSymbols).includes(symbol))
        write(this.$openSymbols, [...read(this.$openSymbols), symbol]);
    });
  }
  showPositions(shown: boolean) {
    update(this.realm, (_read, write) => write(this.$panelShown, shown));
  }
  [Symbol.dispose]() {
    this.stopClosing();
    this.layouts[Symbol.dispose]();
  }
}

/** Create this in the application's scope, with its clock and realm provided. */
export const makeDesk = (transport: Transport, store?: WorkspaceStore) =>
  Effect.gen(function* () {
    const realm = yield* RealmService;
    const context = yield* Effect.context<Scope.Scope>();
    const pairs = yield* transport.request("/pairs", "").pipe(Effect.flatMap(decodePairs));
    const trades = yield* makeTradeBook(transport);
    const account = new Account(realm, transport);
    let sequence = 0;
    const tiles: Desk[] = [];
    for (const pair of pairs) {
      const initial: PriceState = { current: null, previous: null, error: null };
      // History belongs to the desk; it never supplies an executable quote.
      const $lastPrice = box<Price | null>(realm, null, { name: "Desk.lastPrice" });
      const $prices = box<PriceState>(realm, initial, { name: "Desk.prices" });
      yield* whileObserved(
        $prices,
        transport.subscribe(`prices/${pair.symbol}`).pipe(
          Stream.mapEffect((raw) =>
            decodePrice(raw).pipe(
              Effect.flatMap((price) =>
                price.symbol === pair.symbol
                  ? Effect.succeed(price)
                  : Effect.fail("price does not match topic"),
              ),
            ),
          ),
          Stream.runForEach((current) =>
            Effect.sync(() =>
              update(realm, (read, write) => {
                write($prices, { current, previous: read($lastPrice), error: null });
                write($lastPrice, current);
              }),
            ),
          ),
          Effect.catch((error) =>
            Effect.sync(() =>
              update(realm, (read, write) =>
                write($prices, { ...read($prices), error: String(error) }),
              ),
            ),
          ),
          // The run ends only when the last observer leaves, or on a defect;
          // either way the tile must not keep a quote nobody streams.
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => update(realm, (_read, write) => write($prices, initial))),
          ),
        ),
      );
      const desk = new Desk(
        realm,
        pair,
        $prices,
        trades,
        transport,
        Effect.runForkWith(context),
        () => `local-${++sequence}`,
        account,
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => desk.cancelExecution()));
      tiles.push(desk);
    }
    const orders = yield* makeOrders(
      transport,
      trades,
      () =>
        new Date(Effect.runSyncWith(context)(Clock.currentTimeMillis)).toISOString().slice(0, 10),
      (program) =>
        Effect.runForkWith(context)(
          program.pipe(Effect.forkScoped({ startImmediately: true }), Effect.asVoid),
        ),
      account,
    );
    const workspace = new Workspace(realm, tiles, trades, orders, store);
    yield* Effect.addFinalizer(() => Effect.sync(() => workspace[Symbol.dispose]()));
    return workspace;
  });
