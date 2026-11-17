import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  BoxField,
  CollectionField,
  createRealm,
  decode,
  onRowChange,
  type Realm,
  type RowChange,
  reconcileSchema,
  SchemaModel,
  untracked,
  update,
} from "../src/index.ts";

class Row extends SchemaModel<Row>("Row")({
  id: Schema.String,
  price: Schema.Number,
}) {}

class Rows extends SchemaModel<Rows>("Rows")({
  $items: CollectionField(Row, { keyOf: (row) => row.id }),
}) {}

class Ticker extends SchemaModel<Ticker>("Ticker")({
  id: Schema.String,
  $price: BoxField(Schema.Number),
}) {}

class Tickers extends SchemaModel<Tickers>("Tickers")({
  $items: CollectionField(Ticker, { keyOf: (ticker) => ticker.id }),
}) {}

const Quote = Schema.Struct({ id: Schema.String, price: Schema.Number });

class Quotes extends SchemaModel<Quotes>("Quotes")({
  $items: CollectionField(Quote, { keyOf: (quote) => quote.id }),
}) {}

class Board extends SchemaModel<Board>("Board")({
  name: Schema.String,
  $items: CollectionField(Quote, { keyOf: (quote) => quote.id }),
}) {}

class Desk extends SchemaModel<Desk>("Desk")({
  $boards: CollectionField(Board, { keyOf: (board) => board.name }),
}) {}

class Panel extends SchemaModel<Panel>("Panel")({
  name: Schema.String,
  $title: BoxField(Schema.String),
  $items: CollectionField(Quote, { keyOf: (quote) => quote.id }),
}) {}

class Panels extends SchemaModel<Panels>("Panels")({
  $panels: CollectionField(Panel, { keyOf: (panel) => panel.name }),
}) {}

const json = (...rows: ReadonlyArray<readonly [string, number]>) => ({
  items: rows.map(([id, price]) => ({ id, price })),
});

const row = (realm: Realm, id: string, price: number): Row => Row.make({ id, price, realm });

/** Each change a listener saw, as `key: before -> after` prices. */
const changesOf = <Value extends { readonly price: number }>(
  changes: ReadonlyArray<RowChange<string, Value>>,
) =>
  changes.map(
    (change) => `${change.key}: ${change.before?.price ?? "-"} -> ${change.after?.price ?? "-"}`,
  );

describe("onRowChange on a CollectionField", () => {
  // Each test clears what the listener heard of the rows held when it was added.
  test("a field of plain values reports each upsert, remove, and replaceAll", () => {
    const realm = createRealm();
    const quotes = decode(realm, Quotes)(json(["a", 1], ["b", 2]));
    const seen: Array<RowChange<string, typeof Quote.Type>> = [];
    const stop = onRowChange(quotes.$items, (change) => {
      seen.push(change);
      return undefined;
    });
    expect(changesOf(seen)).toEqual(["a: - -> 1", "b: - -> 2"]);
    seen.length = 0;

    update(realm, (_read, write) => {
      write.upsert(quotes.$items, { id: "a", price: 5 });
      write.remove(quotes.$items, "b");
    });
    update(realm, (_read, write) => {
      write.replaceAll(quotes.$items, [
        { id: "a", price: 5 },
        { id: "c", price: 3 },
      ]);
    });

    expect(changesOf(seen)).toEqual(["a: 1 -> 5", "b: 2 -> -", "c: - -> 3"]);
    stop();
  });

  test("a field of models reports a model replaced, added, or removed", () => {
    const realm = createRealm();
    const rows = decode(realm, Rows)(json(["a", 1], ["b", 2]));
    const seen: Array<RowChange<string, Row>> = [];
    const stop = onRowChange(rows.$items, (change) => {
      seen.push(change);
      return undefined;
    });
    seen.length = 0;

    update(realm, (_read, write) => {
      write.upsert(rows.$items, row(realm, "a", 10));
      write.upsert(rows.$items, row(realm, "c", 3));
    });
    update(realm, (_read, write) => {
      write.replaceAll(rows.$items, [row(realm, "a", 10), row(realm, "c", 4)]);
    });

    // The upsert put "c" first, so replaceAll reports it before "b".
    expect(changesOf(seen)).toEqual(["a: 1 -> 10", "c: - -> 3", "c: 3 -> 4", "b: 2 -> -"]);
    stop();
  });

  test("a model whose box fields alone differ merges in place and reports nothing", () => {
    const realm = createRealm();
    const tickers = decode(realm, Tickers)({ items: [{ id: "a", price: 1 }] });
    const before = untracked(realm, (read) => read(tickers.$items.row("a")));
    const seen: Array<RowChange<string, Ticker>> = [];
    const stop = onRowChange(tickers.$items, (change) => {
      seen.push(change);
      return undefined;
    });
    seen.length = 0;

    update(realm, (_read, write) => {
      write.upsert(tickers.$items, Ticker.make({ id: "a", price: 5, realm }));
    });

    const after = untracked(realm, (read) => read(tickers.$items.row("a")));
    expect(after).toBe(before as never);
    expect(after === undefined ? undefined : untracked(realm, (read) => read(after.$price))).toBe(
      5,
    );
    expect(seen).toEqual([]);
    stop();
  });

  test("a model merged into a held one reports the rows its collection field changes", () => {
    const realm = createRealm();
    const desk = decode(realm, Desk)({ boards: [{ name: "spot", ...json(["a", 1], ["b", 2]) }] });
    const board = untracked(realm, (read) => read(desk.$boards.row("spot"))) as Board;
    const seen: Array<RowChange<string, typeof Quote.Type>> = [];
    const stop = onRowChange(board.$items, (change) => {
      seen.push(change);
      return undefined;
    });
    seen.length = 0;

    update(realm, (_read, write) => {
      write.upsert(
        desk.$boards,
        decode(realm, Board)({ name: "spot", ...json(["a", 1], ["c", 3]) }),
      );
    });

    expect(changesOf(seen)).toEqual(["b: 2 -> -", "c: - -> 3"]);
    stop();
  });

  test("a nested listener that throws, caught by the writer, puts back the whole merge", () => {
    const realm = createRealm();
    const panels = decode(
      realm,
      Panels,
    )({
      panels: [{ name: "p", title: "old", items: [{ id: "a", price: 1 }] }],
    });
    const held = untracked(realm, (read) => read(panels.$panels.row("p")));
    if (held === undefined) {
      throw new Error("the panel is held");
    }
    const stop = onRowChange(held.$items, (change) => {
      if (change.before !== undefined) {
        throw new Error("refused");
      }
      return undefined;
    });

    update(realm, (_read, write) => {
      try {
        write.upsert(
          panels.$panels,
          Panel.make({ name: "p", title: "new", items: [{ id: "a", price: 2 }], realm }),
        );
      } catch {
        // The writer goes on without the panel.
      }
    });

    expect(untracked(realm, (read) => read(panels.$panels.row("p")))).toBe(held);
    expect(untracked(realm, (read) => read(held.$title))).toBe("old");
    expect(untracked(realm, (read) => read(held.$items.rows))).toEqual([{ id: "a", price: 1 }]);
    stop();
  });

  test("reconcileSchema with a nested listener that throws, caught by the writer, puts back the whole merge", () => {
    const realm = createRealm();
    const panels = decode(
      realm,
      Panels,
    )({
      panels: [{ name: "p", title: "old", items: [{ id: "a", price: 1 }] }],
    });
    const held = untracked(realm, (read) => read(panels.$panels.row("p")));
    if (held === undefined) {
      throw new Error("the panel is held");
    }
    const stop = onRowChange(held.$items, (change) => {
      if (change.before !== undefined) {
        throw new Error("refused");
      }
      return undefined;
    });
    const fresh = Panel.make({ name: "p", title: "new", items: [{ id: "a", price: 2 }], realm });

    update(realm, () => {
      try {
        reconcileSchema([held], [fresh], { keyOf: (panel: Panel) => panel.name });
      } catch {
        // The writer goes on without the panel.
      }
    });

    expect(untracked(realm, (read) => read(held.$title))).toBe("old");
    expect(untracked(realm, (read) => read(held.$items.rows))).toEqual([{ id: "a", price: 1 }]);
    stop();
  });
});
