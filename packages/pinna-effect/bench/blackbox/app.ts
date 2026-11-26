/**
 * App scenarios: what a trading screen does to its state over a session.
 * A watch stands for a mounted component: its select is what the component
 * reads, its effect a render.
 */

import { Schema } from "effect";
import { Collection, Computed, Model, type Read, Realm, Source } from "../../src/index.ts";
import { type Built, expectEqual, type Scenario, seeded } from "./harness.ts";
import {
  Balance,
  Balances,
  type Candle,
  CandleRow,
  candleAt,
  candlesWire,
  Market,
  Markets,
  marketsWire,
  Portfolio,
  Position,
  RowSeries,
  Series,
  tick,
} from "./market.ts";

const ignore = (): undefined => undefined;

/** Errors with no caller fail the run: a scenario that expects them collects them itself. */
const strictRealm = (): Realm =>
  Realm.make({
    onError: (error) => {
      throw error;
    },
  });

/** A `Markets` of `count` markets, decoded from the wire. */
const marketsOf = (realm: Realm, count: number, random: () => number): Markets =>
  Model.decode(realm, Markets)(marketsWire(count, random));

/** The ten markets that moved most, by the size of their change: the picker's "top movers". */
const topMoversOf = (
  markets: ReadonlyArray<Market>,
  read: (market: Market) => number,
): Array<string> =>
  markets
    .map((market) => ({ id: market.id, change: Math.abs(read(market)) }))
    .sort((left, right) => right.change - left.change || (left.id < right.id ? -1 : 1))
    .slice(0, 10)
    .map((entry) => entry.id);

const positionsWire = (
  count: number,
  markets: number,
  random: () => number,
): Array<{ id: string; market: string; amount: number; entry: number }> => {
  const positions = [];
  for (let index = 0; index < count; index++) {
    positions.push({
      id: `P${index}`,
      market: `M${Math.floor(random() * markets)}`,
      amount: 1 + Math.floor(random() * 100),
      entry: 1 + random() * 1000,
    });
  }
  return positions;
};

/** What a position screen shows: each position's profit, valued at the market's price. */
const valuationOf = (realm: Realm, markets: Markets, portfolio: Portfolio) =>
  Computed.make(realm, (read) => {
    let total = 0;
    const lines: Array<string> = [];
    for (const position of read(portfolio.$positions.rows)) {
      const market = read(markets.$items.row(position.market));
      if (market === undefined) {
        continue;
      }
      const profit = (read(market.$price) - position.entry) * read(position.$amount);
      total += profit;
      lines.push(`${position.id} ${profit.toFixed(2)} ${read(market.$priceText)}`);
    }
    return { total, lines };
  });

/** The valuation counted again without a computed value, to check the one the screen shows. */
const recountValuation = (read: Read, markets: Markets, portfolio: Portfolio): number => {
  let total = 0;
  for (const position of read(portfolio.$positions.rows)) {
    const market = read(markets.$items.row(position.market));
    if (market !== undefined) {
      total += (read(market.$price) - position.entry) * read(position.$amount);
    }
  }
  return total;
};

/** A component showing one market row: its price, change, and spread. */
const mountRow = (realm: Realm, market: Market, rendered: () => undefined): (() => void) =>
  Realm.watch(
    realm,
    (read) => `${read(market.$priceText)} ${read(market.$changeText)} ${read(market.$spread)}`,
    rendered,
  );

/**
 * Rates arrive as one socket message a second: a batch of pairs, four
 * fields each, written in one update. A top-movers list sorts every market,
 * a positions screen values each position at its market's price, and the
 * visible rows render.
 */
const ratesBatch = (markets: number, batch: number, steps: number): Scenario => ({
  name: `rates: ${markets} markets, ${batch} per batch`,
  story: "1 Hz rate batches into a picker, a positions screen, and 50 visible rows",
  steps,
  build: (): Built => {
    const random = seeded(1);
    const realm = strictRealm();
    const state = marketsOf(realm, markets, random);
    const portfolio = Model.decode(
      realm,
      Portfolio,
    )({ positions: positionsWire(100, markets, random) });
    const rows = state.$items.rows;
    const topMovers = Computed.make(realm, (read) =>
      topMoversOf(read(rows), (market) => read(market.$change)),
    );
    const valuation = valuationOf(realm, state, portfolio);
    let renders = 0;
    const rendered = (): undefined => {
      renders++;
    };
    const stops = [
      Realm.watch(realm, (read) => read(topMovers), rendered),
      Realm.watch(realm, (read) => read(valuation), rendered),
      ...Realm.untracked(realm, (read) => read(rows))
        .slice(0, 50)
        .map((market) => mountRow(realm, market, rendered)),
    ];
    const all = Realm.untracked(realm, (read) => read(rows));
    return {
      step: () => {
        Realm.update(realm, (read, write) => {
          for (let index = 0; index < batch; index++) {
            tick(read, write, all[Math.floor(random() * all.length)] as Market, random);
          }
          return undefined;
        });
      },
      check: () => {
        Realm.untracked(realm, (read) => {
          expectEqual(
            read(topMovers).join(),
            topMoversOf(all, (market) => read(market.$change)).join(),
            "top movers",
          );
          expectEqual(
            Math.round(read(valuation).total),
            Math.round(recountValuation(read, state, portfolio)),
            "valuation",
          );
        });
        if (renders === 0) {
          throw new Error("blackbox: nothing rendered");
        }
      },
      dispose: () => {
        for (const stop of stops) {
          stop();
        }
      },
    };
  },
});

/**
 * A chart's candle series in one box, as a chart screen holds it. Most
 * messages update the last candle; one in ten opens a new one and trims the
 * oldest past `cap`. The chart reads the last candle and the visible range.
 */
const candlesInBox = (cap: number, write: "set" | "modify", steps: number): Scenario => ({
  name: `candles in a box: ${cap}, ${write}`,
  story: "a live chart series of plain candles in one box",
  steps,
  build: (): Built => {
    const random = seeded(2);
    const realm = strictRealm();
    const series = Model.decode(realm, Series)({ market: "M0", candles: candlesWire(cap, random) });
    const last = Computed.make(realm, (read) => {
      const candles = read(series.$candles);
      return candles[candles.length - 1] as Candle;
    });
    const range = Computed.make(realm, (read) => {
      let low = Number.POSITIVE_INFINITY;
      let high = Number.NEGATIVE_INFINITY;
      for (const candle of read(series.$candles)) {
        low = Math.min(low, candle.low);
        high = Math.max(high, candle.high);
      }
      return { low, high };
    });
    let renders = 0;
    const stops = [
      Realm.watch(
        realm,
        (read) => read(last).close,
        () => {
          renders++;
        },
      ),
      Realm.watch(
        realm,
        (read) => read(range),
        () => {
          renders++;
        },
      ),
    ];
    let time = cap * 900;
    return {
      step: (index) => {
        const opens = index % 10 === 9;
        Realm.update(realm, (read, put) => {
          const candles = read(series.$candles);
          const previous = candles[candles.length - 1] as Candle;
          const close = previous.close * (0.999 + random() * 0.002);
          if (write === "set") {
            const next = opens
              ? candles.slice(candles.length >= cap ? 1 : 0)
              : candles.slice(0, -1);
            if (opens) {
              time += 900;
              next.push(candleAt(time, previous.close, random));
            } else {
              next.push({
                ...previous,
                close,
                high: Math.max(previous.high, close),
                low: Math.min(previous.low, close),
              });
            }
            put(series.$candles, next);
          } else {
            put.modify(series.$candles, (draft) => {
              if (opens) {
                if (draft.length >= cap) {
                  draft.shift();
                }
                time += 900;
                draft.push(candleAt(time, previous.close, random));
              } else {
                const candle = draft[draft.length - 1];
                if (candle === undefined) {
                  return undefined;
                }
                candle.close = close;
                candle.high = Math.max(candle.high, close);
                candle.low = Math.min(candle.low, close);
              }
              return undefined;
            });
          }
          return undefined;
        });
      },
      check: () => {
        Realm.untracked(realm, (read) => {
          const candles = read(series.$candles);
          expectEqual(candles.length, cap, "series length");
          expectEqual(read(last), candles[cap - 1], "last candle");
        });
        if (renders === 0) {
          throw new Error("blackbox: nothing rendered");
        }
      },
      dispose: () => {
        for (const stop of stops) {
          stop();
        }
      },
    };
  },
});

/** The same chart with each candle a row of boxes in a keyed collection. */
const candlesInCollection = (cap: number, steps: number): Scenario => ({
  name: `candles in a collection: ${cap}`,
  story: "a live chart series as a collection of candle rows",
  steps,
  build: (): Built => {
    const random = seeded(2);
    const realm = strictRealm();
    const series = Model.decode(
      realm,
      RowSeries,
    )({ market: "M0", candles: candlesWire(cap, random) });
    const keys = series.$candles.keys;
    const last = Computed.make(realm, (read) => {
      const order = read(keys);
      return read(series.$candles.row(order[order.length - 1] as number));
    });
    const range = Computed.make(realm, (read) => {
      let low = Number.POSITIVE_INFINITY;
      let high = Number.NEGATIVE_INFINITY;
      for (const candle of read(series.$candles.rows)) {
        low = Math.min(low, read(candle.$low));
        high = Math.max(high, read(candle.$high));
      }
      return { low, high };
    });
    let renders = 0;
    const stops = [
      Realm.watch(
        realm,
        (read) => {
          const candle = read(last);
          return candle === undefined ? undefined : read(candle.$close);
        },
        () => {
          renders++;
        },
      ),
      Realm.watch(
        realm,
        (read) => read(range),
        () => {
          renders++;
        },
      ),
    ];
    let time = cap * 900;
    const decodeCandle = Model.decode(realm, CandleRow);
    return {
      step: (index) => {
        const opens = index % 10 === 9;
        Realm.update(realm, (read, write) => {
          const order = read(keys);
          const previous = read(
            series.$candles.row(order[order.length - 1] as number),
          ) as CandleRow;
          if (opens) {
            if (order.length >= cap) {
              write.remove(series.$candles, order[0] as number);
            }
            time += 900;
            write.upsert(
              series.$candles,
              decodeCandle(candleAt(time, read(previous.$close), random)),
              {
                at: "end",
              },
            );
          } else {
            const close = read(previous.$close) * (0.999 + random() * 0.002);
            write(previous.$close, close);
            write(previous.$high, Math.max(read(previous.$high), close));
            write(previous.$low, Math.min(read(previous.$low), close));
          }
          return undefined;
        });
      },
      check: () => {
        expectEqual(Realm.untracked(realm, (read) => read(keys)).length, cap, "series length");
        if (renders === 0) {
          throw new Error("blackbox: nothing rendered");
        }
      },
      dispose: () => {
        for (const stop of stops) {
          stop();
        }
      },
    };
  },
});

/**
 * A positions stream: each message opens, changes, or closes one position,
 * and the positions screen values them all at live prices.
 */
const positionsStream = (positions: number, steps: number): Scenario => ({
  name: `positions stream: ${positions} positions`,
  story: "position updates one message at a time, valued at live prices",
  steps,
  build: (): Built => {
    const random = seeded(3);
    const realm = strictRealm();
    const state = marketsOf(realm, 300, random);
    const portfolio = Model.decode(
      realm,
      Portfolio,
    )({
      positions: positionsWire(positions, 300, random),
    });
    const valuation = valuationOf(realm, state, portfolio);
    const decodePosition = Model.decode(realm, Position);
    let renders = 0;
    const stops = [
      Realm.watch(
        realm,
        (read) => read(valuation),
        () => {
          renders++;
        },
      ),
    ];
    let next = positions;
    return {
      step: () => {
        Realm.update(realm, (read, write) => {
          const rows = read(portfolio.$positions.rows);
          const roll = random();
          if (roll < 0.15 || rows.length < positions / 2) {
            write.upsert(
              portfolio.$positions,
              decodePosition({
                id: `P${next++}`,
                market: `M${Math.floor(random() * 300)}`,
                amount: 1 + Math.floor(random() * 100),
                entry: 1 + random() * 1000,
              }),
            );
          } else if (roll < 0.3) {
            write.remove(
              portfolio.$positions,
              (rows[Math.floor(random() * rows.length)] as Position).id,
            );
          } else {
            const position = rows[Math.floor(random() * rows.length)] as Position;
            write(position.$amount, read(position.$amount) + 1);
          }
          return undefined;
        });
      },
      check: () => {
        Realm.untracked(realm, (read) => {
          expectEqual(
            Math.round(read(valuation).total),
            Math.round(recountValuation(read, state, portfolio)),
            "valuation",
          );
        });
        if (renders === 0) {
          throw new Error("blackbox: nothing rendered");
        }
      },
      dispose: () => {
        for (const stop of stops) {
          stop();
        }
      },
    };
  },
});

/**
 * A balances subscription delivers the whole list each time; one balance
 * differs. `naive` decodes and replaces every row; `reconciled` keeps the
 * rows whose contents did not change first. Either way `write.replaceAll`
 * merges each refetched `Balance` into the held instance (ruling 51), so the
 * two modes differ in cost, not in what reruns.
 */
const balancesSnapshot = (mode: "naive" | "reconciled", steps: number): Scenario => ({
  name: `balances snapshot: ${mode}`,
  story: "a full balances snapshot per message, one balance changed",
  steps,
  build: (): Built => {
    const random = seeded(4);
    const realm = strictRealm();
    const wire = Array.from({ length: 30 }, (_, index) => ({
      token: `T${index}`,
      amount: Math.round(random() * 1000),
    }));
    const balances = Model.decode(realm, Balances)({ items: wire });
    const decodeList = Model.decode(realm, Schema.Array(Balance));
    const rows = balances.$items.rows;
    const total = Computed.make(realm, (read) =>
      read(rows).reduce((sum, row) => sum + read(row.$amount), 0),
    );
    let rowRenders = 0;
    const stops = [
      Realm.watch(
        realm,
        (read) => read(total),
        () => {},
      ),
      ...wire.map((entry) =>
        Realm.watch(
          realm,
          (read) => {
            const row = read(balances.$items.row(entry.token));
            return row === undefined ? undefined : read(row.$amount);
          },
          () => {
            rowRenders++;
          },
        ),
      ),
      ...wire.map((entry) =>
        Realm.watch(
          realm,
          (read) => read(balances.$items.row(entry.token)),
          () => {
            rowRenders++;
          },
        ),
      ),
    ];
    return {
      step: (index) => {
        const changed = wire[index % wire.length] as { token: string; amount: number };
        changed.amount += 1;
        const next = decodeList(wire);
        Realm.update(realm, (read, write) => {
          if (mode === "naive") {
            write.replaceAll(balances.$items, next);
          } else {
            write.replaceAll(
              balances.$items,
              Collection.reconcile(read(rows), next, {
                keyOf: (balance) => balance.token,
                equals: (left, right) => read(left.$amount) === read(right.$amount),
              }),
            );
          }
          return undefined;
        });
      },
      check: () => {
        expectEqual(
          Realm.untracked(realm, (read) => read(total)),
          wire.reduce((sum, entry) => sum + entry.amount, 0),
          "balances total",
        );
        // Ruling 51: a refetched `Model.Schema` row merges into the held
        // instance, so no row's instance changes and only the changed row's
        // amount rerenders, once per snapshot, naive or reconciled.
        const perStep = rowRenders / steps;
        expectEqual(perStep, 1, "row renders per snapshot");
      },
      dispose: () => {
        for (const stop of stops) {
          stop();
        }
      },
    };
  },
});

/**
 * Switching the selected market: the old screen unmounts, the new one
 * mounts. The screen reads a memoized stats value and the row, starts a
 * price feed through `Source.onObserved` on the market's price, and keeps a chart
 * series made for that market. A few ticks land between switches.
 */
const marketSwitch = (steps: number): Scenario => ({
  name: "market switching",
  story: "select a market, mount its screen and chart, tick, switch away",
  steps,
  build: (): Built => {
    const random = seeded(5);
    const realm = strictRealm();
    const state = marketsOf(realm, 300, random);
    const all = Realm.untracked(realm, (read) => read(state.$items.rows));
    const feeds = new Set<string>();
    const hooks = all.map((market) =>
      Source.onObserved(market.$price, () => {
        feeds.add(market.id);
        return () => {
          feeds.delete(market.id);
        };
      }),
    );
    const statsOf = Computed.fn(realm, (read, id: string) => {
      const market = read(state.$items.row(id));
      return market === undefined
        ? undefined
        : { spread: read(market.$spread), change: read(market.$changeText) };
    });
    let screen: Array<() => void> = [];
    let selected = all[0] as Market;
    let renders = 0;
    const rendered = (): undefined => {
      renders++;
    };
    const unmount = (): void => {
      for (const stop of screen) {
        stop();
      }
      screen = [];
    };
    const decodeSeries = Model.decode(realm, Series);
    return {
      step: () => {
        unmount();
        selected = all[Math.floor(random() * all.length)] as Market;
        const market = selected;
        const series = decodeSeries({ market: market.id, candles: candlesWire(100, random) });
        const chart: Computed<number> = Computed.make(realm, (read) => {
          const candles = read(series.$candles);
          return (candles[candles.length - 1] as Candle).close + read(market.$price);
        });
        screen = [
          Realm.watch(realm, (read) => read(statsOf(market.id)), rendered),
          mountRow(realm, market, rendered),
          Realm.watch(realm, (read) => read(chart), rendered),
          Realm.autorun(realm, (read) => {
            read(market.$price);
            return () => {};
          }),
        ];
        for (let index = 0; index < 5; index++) {
          Realm.update(realm, (read, write) => {
            tick(read, write, market, random);
            return undefined;
          });
        }
      },
      check: () => {
        expectEqual(feeds.size, 1, "price feeds open");
        expectEqual(feeds.has(selected.id), true, "the selected market's feed is open");
        if (renders === 0) {
          throw new Error("blackbox: nothing rendered");
        }
      },
      dispose: () => {
        unmount();
        expectEqual(feeds.size, 0, "price feeds open after unmount");
        for (const remove of hooks) {
          remove();
        }
      },
    };
  },
});

/**
 * Scrolling a list of markets: rows leave the window and new ones mount.
 * Every market's four rate fields carry a `Source.onObserved` hook, as a rates
 * store that subscribes only the pairs on screen has, and ticks keep coming.
 */
const scrollRows = (markets: number, window: number, steps: number): Scenario => ({
  name: `scroll: ${markets} markets, ${window} visible`,
  story: "scroll a list: rows unmount and mount, per-field demand hooks follow",
  steps,
  build: (): Built => {
    const random = seeded(6);
    const realm = strictRealm();
    const state = marketsOf(realm, markets, random);
    const all = Realm.untracked(realm, (read) => read(state.$items.rows));
    let observedFields = 0;
    const hooks = all.flatMap((market) =>
      [market.$price, market.$bid, market.$ask, market.$open].map((field) =>
        Source.onObserved(field, () => {
          observedFields++;
          return () => {
            observedFields--;
          };
        }),
      ),
    );
    const mounted = new Map<number, () => void>();
    let top = 0;
    const mount = (index: number): void => {
      mounted.set(index, mountRow(realm, all[index % markets] as Market, ignore));
    };
    for (let index = 0; index < window; index++) {
      mount(index);
    }
    return {
      step: () => {
        for (let index = top; index < top + 5; index++) {
          mounted.get(index)?.();
          mounted.delete(index);
          mount(index + window);
        }
        top += 5;
        Realm.update(realm, (read, write) => {
          for (let index = 0; index < 20; index++) {
            tick(
              read,
              write,
              all[(top + Math.floor(random() * window)) % markets] as Market,
              random,
            );
          }
          return undefined;
        });
      },
      check: () => {
        // A row reads price, open (through change), bid and ask (through spread).
        const visible = new Set<number>();
        for (const index of mounted.keys()) {
          visible.add(index % markets);
        }
        expectEqual(observedFields, visible.size * 4, "observed rate fields");
      },
      dispose: () => {
        for (const stop of mounted.values()) {
          stop();
        }
        expectEqual(observedFields, 0, "observed rate fields after unmount");
        for (const remove of hooks) {
          remove();
        }
      },
    };
  },
});

/**
 * Pulling to refresh: the markets come back from the server with one in
 * twenty prices moved. `replace` decodes and replaces the rows; `Collection.reconcile`
 * keeps unchanged rows first; `patch` writes the new prices into the rows
 * already held.
 */
const refetch = (mode: "replace" | "reconcile" | "patch", steps: number): Scenario => ({
  name: `refetch 300 markets: ${mode}`,
  story: "a REST refetch of the market list, 5% of prices moved",
  steps,
  build: (): Built => {
    const random = seeded(7);
    const realm = strictRealm();
    const wire = marketsWire(300, random);
    const state = Model.decode(realm, Markets)(wire);
    const decodeList = Model.decode(realm, Schema.Array(Market));
    const rows = state.$items.rows;
    const topMovers = Computed.make(realm, (read) =>
      topMoversOf(read(rows), (market) => read(market.$change)),
    );
    let rowRenders = 0;
    const stops = [
      Realm.watch(realm, (read) => read(topMovers), ignore),
      ...wire.items.slice(0, 50).map((entry) =>
        Realm.watch(
          realm,
          (read) => {
            const market = read(state.$items.row(entry.id));
            return market === undefined
              ? ""
              : `${read(market.$priceText)} ${read(market.$changeText)}`;
          },
          () => {
            rowRenders++;
          },
        ),
      ),
    ];
    return {
      step: () => {
        for (const entry of wire.items) {
          if (random() < 0.05) {
            (entry as { price: number }).price *= 1.001;
          }
        }
        if (mode === "patch") {
          Realm.update(realm, (read, write) => {
            for (const entry of wire.items) {
              const row = read(state.$items.row(entry.id));
              if (row !== undefined) {
                write(row.$price, entry.price);
              }
            }
            return undefined;
          });
          return;
        }
        const next = decodeList(wire.items);
        Realm.update(realm, (read, write) => {
          write.replaceAll(
            state.$items,
            mode === "replace"
              ? next
              : Collection.reconcile(read(rows), next, {
                  keyOf: (market) => market.id,
                  equals: (left, right) => read(left.$price) === read(right.$price),
                }),
          );
          return undefined;
        });
      },
      check: () => {
        Realm.untracked(realm, (read) => {
          for (const entry of wire.items) {
            const row = read(state.$items.row(entry.id));
            expectEqual(
              row === undefined ? undefined : read(row.$price),
              entry.price,
              `${entry.id} price`,
            );
          }
        });
        if (rowRenders === 0) {
          throw new Error("blackbox: no row rendered");
        }
      },
      dispose: () => {
        for (const stop of stops) {
          stop();
        }
      },
    };
  },
});

/**
 * Infinite scroll: each step appends a page of 50 markets. `upsert` adds
 * them one at a time inside one update; `replaceAll` writes the grown list
 * once. Grows by design, so its live bytes are not a leak.
 */
const pagination = (mode: "upsert" | "replaceAll", pages: number): Scenario => ({
  name: `pagination by 50: ${mode}`,
  story: "append pages of 50 rows to a list that keeps growing",
  steps: pages,
  build: (): Built => {
    const random = seeded(8);
    const realm = strictRealm();
    const state = Model.decode(realm, Markets)({ items: [] });
    const decodeList = Model.decode(realm, Schema.Array(Market));
    const count = Computed.make(realm, (read) => read(state.$items.keys).length);
    const stops = [Realm.watch(realm, (read) => read(count), ignore)];
    return {
      step: (index) => {
        const page = decodeList(
          marketsWire(50, random).items.map((entry, offset) => ({
            ...entry,
            id: `M${index * 50 + offset}`,
          })),
        );
        Realm.update(realm, (read, write) => {
          if (mode === "upsert") {
            for (const market of page) {
              write.upsert(state.$items, market, { at: "end" });
            }
          } else {
            write.replaceAll(state.$items, [...read(state.$items.rows), ...page]);
          }
          return undefined;
        });
      },
      check: () => {
        expectEqual(
          Realm.untracked(realm, (read) => read(count)),
          pages * 50,
          "rows",
        );
      },
      dispose: () => {
        for (const stop of stops) {
          stop();
        }
      },
    };
  },
});

export const appScenarios: ReadonlyArray<Scenario> = [
  ratesBatch(300, 100, 2000),
  ratesBatch(600, 200, 1000),
  candlesInBox(500, "set", 3000),
  candlesInBox(5000, "set", 1000),
  candlesInBox(500, "modify", 3000),
  candlesInBox(5000, "modify", 500),
  candlesInCollection(500, 3000),
  candlesInCollection(5000, 3000),
  positionsStream(100, 3000),
  positionsStream(400, 3000),
  balancesSnapshot("naive", 2000),
  balancesSnapshot("reconciled", 2000),
  marketSwitch(2000),
  scrollRows(1000, 30, 2000),
  refetch("replace", 300),
  refetch("reconcile", 300),
  refetch("patch", 300),
  pagination("upsert", 200),
  pagination("replaceAll", 200),
];
