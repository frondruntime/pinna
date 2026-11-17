/// <reference types="bun" />
// Backs the claims docs/public/react/hooks.md makes about the samples in
// `react.tsx`. It renders, so this file runs under a DOM.
import { afterEach, expect, test } from "bun:test";
import { computed, observe, untracked, update } from "@frondruntime/pinna";
import { held } from "@frondruntime/pinna/testing";
import { act, Profiler, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { $quote, $quoteCard, $saving, names, Panel, QuoteCard, realm } from "./react.tsx";

let root: Root | undefined;
let container: HTMLElement | undefined;

const mount = (element: ReactNode) => {
  container = document.createElement("div");
  document.body.append(container);
  const created = createRoot(container);
  root = created;
  act(() => created.render(element));
  return container;
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
});

test("a change of status rerenders the status line, not the list beside it", () => {
  // NameList is the one caller of `names.map`, so its calls count its renders.
  let listRenders = 0;
  const map = names.map;
  Object.defineProperty(names, "map", {
    configurable: true,
    value: function (this: ReadonlyArray<string>, ...parameters: Parameters<typeof map>) {
      listRenders += 1;
      return map.apply(this, parameters);
    },
  });
  try {
    const shown = mount(<Panel />);
    expect(listRenders).toBe(1);
    act(() => update(realm, (_read, write) => write($saving, true)));
    expect(shown.textContent).toContain("Saving…");
    expect(listRenders).toBe(1);
  } finally {
    Reflect.deleteProperty(names, "map");
  }
});

test("a display projection with equals keeps its object when only an unshown field changes", () => {
  let renders = 0;
  const shown = mount(
    <Profiler
      id="card"
      onRender={() => {
        renders += 1;
      }}
    >
      <QuoteCard />
    </Profiler>,
  );
  expect(renders).toBe(1);
  const before = untracked(realm, (read) => read($quoteCard));
  act(() =>
    update(realm, (_read, write) =>
      write.modify($quote, (quote) => {
        quote.receivedAt += 1;
      }),
    ),
  );
  expect(untracked(realm, (read) => read($quoteCard))).toBe(before);
  expect(renders).toBe(1);
  act(() =>
    update(realm, (_read, write) =>
      write.modify($quote, (quote) => {
        quote.price = 11;
      }),
    ),
  );
  expect(shown.textContent).toBe("ACME 11.00");
  expect(renders).toBe(2);
});

test("without equals, the same projection would be a new object on every tick", () => {
  const plain = computed(realm, (read) => {
    const quote = read($quote);
    return { symbol: quote.symbol, price: quote.price.toFixed(2) };
  });
  using _ = held(observe(plain));
  const before = untracked(realm, (read) => read(plain));
  update(realm, (_read, write) =>
    write.modify($quote, (quote) => {
      quote.receivedAt += 1;
    }),
  );
  expect(untracked(realm, (read) => read(plain))).not.toBe(before);
});
