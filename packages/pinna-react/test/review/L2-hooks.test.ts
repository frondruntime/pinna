import { expect, test } from "bun:test";
import {
  act,
  createElement as element,
  Fragment,
  StrictMode,
  Suspense,
  startTransition,
  useLayoutEffect,
} from "react";
import { createRoot } from "react-dom/client";
import { Box, Realm, Source } from "../../../pinna/src/index.ts";
import { RealmProvider, useSelect, useValue, useValues } from "../../src/index.ts";

test("useValues preserves the tuple identity when equal values move to a new source", () => {
  const realm = Realm.make();
  const first = Box.make(realm, 1);
  const second = Box.make(realm, 1);
  const root = createRoot(document.createElement("div"));
  const results: ReadonlyArray<number>[] = [];

  function Reader({ box }: { box: Box<number> }) {
    const values = useValues([box]);
    useLayoutEffect(() => {
      results.push(values);
    });
    return null;
  }

  try {
    act(() => root.render(element(Reader, { box: first })));
    act(() => root.render(element(Reader, { box: second })));
    expect([Source.inspect(first).observers, Source.inspect(second).observers]).toEqual([0, 1]);
    expect(results[0]).toEqual([1]);
    expect(results.at(-1)).toBe(results[0]);
  } finally {
    act(() => root.unmount());
  }
});

for (const form of ["useValue", "useValues", "useSelect"] as const) {
  test(`${form} keeps observing the same committed source across an abandoned transition`, () => {
    const firstRealm = Realm.make();
    const secondRealm = Realm.make();
    const first = Box.make(firstRealm, 1);
    const second = Box.make(secondRealm, 2);
    const events: string[] = [];
    Source.onObserved(first, () => {
      events.push("start");
      return () => {
        events.push("stop");
      };
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    const pending = new Promise<never>(() => {});
    const speculative: number[] = [];
    const readHook = {
      useValue: (box: Box<number>) => useValue(box),
      useValues: (box: Box<number>) => useValues([box])[0],
      useSelect: (box: Box<number>) => useSelect((read) => read(box)),
    }[form];

    function Reader({ box, label }: { box: Box<number>; label: string }) {
      const value = readHook(box);
      if (box === second) speculative.push(value);
      return element("p", null, `${label}=${value}`);
    }

    function Wait({ wait }: { wait: boolean }) {
      if (wait) throw pending;
      return null;
    }

    const app = (realm: Realm, box: Box<number>, label: string, wait: boolean) =>
      element(
        RealmProvider,
        { realm },
        element(
          Suspense,
          { fallback: "loading" },
          element(Reader, { box, label }),
          element(Wait, { wait }),
        ),
      );

    try {
      act(() => root.render(app(firstRealm, first, "initial", false)));
      act(() => startTransition(() => root.render(app(secondRealm, second, "abandoned", true))));
      expect(speculative).toContain(2);
      expect(events).toEqual(["start"]);
      expect(container.textContent).toBe("initial=1");
      act(() => root.render(app(firstRealm, first, "urgent", false)));
      expect(container.textContent).toBe("urgent=1");
      expect(events).toEqual(["start"]);
    } finally {
      act(() => root.unmount());
    }
  });
}

test("a StrictMode realm swap keeps exactly one live selector subscription", () => {
  const firstRealm = Realm.make();
  const secondRealm = Realm.make();
  const first = Box.make(firstRealm, 1);
  const second = Box.make(secondRealm, 2);
  const container = document.createElement("div");
  const root = createRoot(container);

  function Reader({ box }: { box: Box<number> }) {
    return element(
      "p",
      null,
      useSelect((read) => read(box)),
    );
  }

  const app = (realm: Realm, box: Box<number>) =>
    element(StrictMode, null, element(RealmProvider, { realm }, element(Reader, { box })));

  try {
    act(() => root.render(app(firstRealm, first)));
    expect([Source.inspect(first).observers, Source.inspect(second).observers]).toEqual([1, 0]);
    act(() => root.render(app(secondRealm, second)));
    expect([Source.inspect(first).observers, Source.inspect(second).observers]).toEqual([0, 1]);
    act(() => Realm.update(secondRealm, (_read, write) => write(second, 3)));
    expect(container.textContent).toBe("3");
  } finally {
    act(() => root.unmount());
  }
  expect([Source.inspect(first).observers, Source.inspect(second).observers]).toEqual([0, 0]);
});

test("a concurrent render never commits two readings of one source at different values", async () => {
  const realm = Realm.make();
  const first = Box.make(realm, 1);
  const second = Box.make(realm, 10);
  const container = document.createElement("div");
  const root = createRoot(container);
  const yielded = Promise.withResolvers<void>();
  const committed = Promise.withResolvers<void>();
  const layout: string[] = [];
  let firstPass = true;
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

  function Selector({ next }: { next: boolean }) {
    const value = useSelect((read) => read(next ? second : first));
    if (next && firstPass) {
      firstPass = false;
      const until = performance.now() + 30;
      while (performance.now() < until) {}
      yielded.resolve();
    }
    return element("p", { id: "selector" }, value);
  }

  function SameSource() {
    const value = useValue(second);
    useLayoutEffect(() => {
      layout.push(`${container.querySelector("#selector")?.textContent}/${value}`);
      committed.resolve();
    }, [value]);
    return element("p", null, value);
  }

  const app = (next: boolean) =>
    element(
      RealmProvider,
      { realm },
      element(Fragment, null, element(Selector, { next }), next ? element(SameSource) : null),
    );

  try {
    act(() => root.render(app(false)));
    expect(container.textContent).toBe("1");
    environment.IS_REACT_ACT_ENVIRONMENT = false;
    startTransition(() => root.render(app(true)));
    await yielded.promise;
    expect(container.textContent).toBe("1");
    Realm.update(realm, (_read, write) => write(second, 11));
    await committed.promise;
    expect(layout[0]).toBe("11/11");
  } finally {
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    act(() => root.unmount());
  }
});
