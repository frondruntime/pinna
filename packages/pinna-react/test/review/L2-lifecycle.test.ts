import { expect, test } from "bun:test";
import { act, createElement as element, Suspense, startTransition } from "react";
import { createRoot } from "react-dom/client";
import { Atom, Box, Computed, Realm, Source } from "../../../pinna/src/index.ts";
import { useValue } from "../../src/index.ts";

test("an abandoned transition does not reset a mounted fromPromise value or reload it", async () => {
  const realm = Realm.make();
  const replacement = Box.make(realm, "replacement");
  const requests: AbortSignal[] = [];
  const first = Promise.withResolvers<string>();
  const pending = new Promise<never>(() => {});
  const loaded = Computed.fromPromise(
    realm,
    (signal) => {
      requests.push(signal);
      return requests.length === 1 ? first.promise : pending;
    },
    "loading",
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  const speculative: string[] = [];

  function Reader({ source, label }: { source: Computed<string>; label: string }) {
    const value = useValue(source);
    if (source === replacement) speculative.push(value);
    return element("p", null, `${label}=${value}`);
  }

  function Wait({ wait }: { wait: boolean }) {
    if (wait) throw pending;
    return null;
  }

  const app = (source: Computed<string>, label: string, wait: boolean) =>
    element(
      Suspense,
      { fallback: "suspended" },
      element(Reader, { source, label }),
      element(Wait, { wait }),
    );

  try {
    act(() => root.render(app(loaded, "initial", false)));
    await act(async () => {
      first.resolve("loaded");
    });
    expect(container.textContent).toBe("initial=loaded");
    act(() => startTransition(() => root.render(app(replacement, "abandoned", true))));
    expect(speculative).toContain("replacement");
    expect(container.textContent).toBe("initial=loaded");
    act(() => root.render(app(loaded, "urgent", false)));
    expect({
      text: container.textContent,
      requests: requests.length,
      aborted: requests[0]?.aborted,
    }).toEqual({
      text: "urgent=loaded",
      requests: 1,
      aborted: false,
    });
  } finally {
    act(() => root.unmount());
  }
});

test("unmounting before a queued hook notification releases its subscription", () => {
  const realm = Realm.make();
  const box = Box.make(realm, 0);
  const root = createRoot(document.createElement("div"));
  const changes: number[] = [];
  const lifecycle: string[] = [];
  let mounted = false;

  Source.onObserved(box, () => {
    lifecycle.push("start");
    return () => {
      lifecycle.push("stop");
    };
  });

  const stop = Realm.watch(
    realm,
    (read) => read(box),
    () => {
      root.unmount();
      mounted = false;
    },
  );

  function Reader() {
    const value = useValue(box);
    changes.push(value);
    return element("p", null, value);
  }

  try {
    act(() => root.render(element(Reader)));
    mounted = true;
    expect(Source.inspect(box).observers).toBe(2);
    act(() => Realm.update(realm, (_read, write) => write(box, 1)));
    expect(changes).toEqual([0]);
    expect(Source.inspect(box).observers).toBe(1);
  } finally {
    if (mounted) act(() => root.unmount());
    stop();
  }
  expect(Source.inspect(box).observers).toBe(0);
  expect(lifecycle).toEqual(["start", "stop"]);
});

test("React receives a stable initial snapshot from a computed projection over an atom", () => {
  const realm = Realm.make();
  const atom = Atom.make(realm);
  const price = 12;
  const quote = Computed.make(realm, (read) => {
    read(atom);
    return { price };
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  const errors: string[] = [];
  const previous = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(String(args[0]));
  };

  function Reader() {
    return element("p", null, useValue(quote).price);
  }

  try {
    act(() => root.render(element(Reader)));
    expect(container.textContent).toBe("12");
    expect(errors).toEqual([]);
  } finally {
    console.error = previous;
    act(() => root.unmount());
  }
});
