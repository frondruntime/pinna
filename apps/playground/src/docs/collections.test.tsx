/// <reference types="bun" />
// Backs the claims docs/public/state/collections.md makes about the samples in
// `collections.tsx`. It renders, so this file runs under a DOM.
import { afterEach, expect, test } from "bun:test";
import { act, Profiler, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { $orders, addOrder, isSelected, SelectableRow, select } from "./collections.tsx";

let root: Root | undefined;
let container: HTMLElement | undefined;

const mount = (element: ReactNode) => {
  container = document.createElement("div");
  document.body.append(container);
  const created = createRoot(container);
  root = created;
  act(() => created.render(element));
};

const unmount = () => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
};

afterEach(unmount);

const ids = ["s1", "s2", "s3", "s4"];
for (const id of ids) addOrder({ id, total: 10 });

const renders = new Map<string, number>();

const List = () => (
  <ul>
    {ids.map((id) => (
      <Profiler
        key={id}
        id={id}
        onRender={() => {
          renders.set(id, (renders.get(id) ?? 0) + 1);
        }}
      >
        <SelectableRow id={id} />
      </Profiler>
    ))}
  </ul>
);

test("a new selection rerenders the row that lost it and the row that gained it", () => {
  act(() => select("s1"));
  mount(<List />);
  renders.clear();
  act(() => select("s3"));
  expect([...renders.keys()].sort()).toEqual(["s1", "s3"]);
  expect(container?.querySelector('[aria-pressed="true"]')?.textContent).toBe("s3: 10");
});

test("a selection flag is shared while a row reads it, and dropped once none does", () => {
  mount(<List />);
  const shown = isSelected("s2");
  expect(isSelected("s2")).toBe(shown);
  unmount();
  expect(isSelected("s2")).not.toBe(shown);
});

test("a row's own computed value outlives the rows that read it, while the key is held", () => {
  mount(<List />);
  const row = $orders.row("s2");
  unmount();
  expect($orders.row("s2")).toBe(row);
});
