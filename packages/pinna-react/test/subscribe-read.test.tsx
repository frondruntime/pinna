/**
 * A value over an atom nothing observes can change with no write, so the
 * realm clock does not move. The read that subscribes the hook is the one
 * that sees it, and the hook keeps that value: a change between the render
 * and the subscription shows.
 */
import { expect, test } from "bun:test";
import { Atom, Box, Computed, type Read, Realm, Source } from "@frondruntime/pinna";
import { act, Component, createElement as element, type ReactNode, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { RealmProvider, useSelect, useValue, useValues } from "../src/index.ts";

for (const form of ["useValue", "useValues"] as const) {
  test(`${form}: an atom-backed value that changes between render and subscribe shows`, () => {
    const realm = Realm.make();
    const atom = Atom.make(realm);
    let external = 1;
    const value = Computed.make(realm, (read) => {
      read(atom);
      return external;
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    const readHook = {
      useValue: () => useValue(value),
      useValues: () => useValues([value])[0],
    }[form];
    function Reader() {
      const shown = readHook();
      return element("p", null, shown);
    }
    function Changer() {
      useLayoutEffect(() => {
        external = 2;
      }, []);
      return null;
    }
    try {
      act(() => root.render([element(Reader, { key: "r" }), element(Changer, { key: "c" })]));
      expect(container.textContent).toBe("2");
    } finally {
      act(() => root.unmount());
    }
  });
}

test("useSelect: an atom-backed value that changes between render and subscribe shows", () => {
  const realm = Realm.make();
  const atom = Atom.make(realm);
  let external = 1;
  const value = Computed.make(realm, (read) => {
    read(atom);
    return external;
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  function Reader() {
    return element(
      "p",
      null,
      useSelect((read) => read(value)),
    );
  }
  function Changer() {
    useLayoutEffect(() => {
      external = 2;
    }, []);
    return null;
  }
  try {
    act(() =>
      root.render(
        element(
          RealmProvider,
          { realm },
          element(Reader, { key: "r" }),
          element(Changer, { key: "c" }),
        ),
      ),
    );
    expect(container.textContent).toBe("2");
  } finally {
    act(() => root.unmount());
  }
});

test("useSelect: a select over an atom nothing observes yet returns one snapshot per render", () => {
  // Before the subscription, the atom is never current: a capture that
  // called it changed on every getSnapshot would run the select again, and
  // a select that returns a new object each run would never settle.
  const realm = Realm.make();
  const atom = Atom.make(realm);
  let runs = 0;
  const container = document.createElement("div");
  const root = createRoot(container);
  function Reader() {
    const shown = useSelect((read) => {
      read(atom);
      runs++;
      return { label: "fresh" };
    });
    return element("p", null, shown.label);
  }
  try {
    act(() => root.render(element(RealmProvider, { realm }, element(Reader))));
    expect(container.textContent).toBe("fresh");
    expect(runs).toBeLessThan(5);
  } finally {
    act(() => root.unmount());
  }
});

class Boundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? "failed" : this.props.children;
  }
}

const quiet = <Result,>(run: () => Result): Result => {
  const original = console.error;
  console.error = () => {};
  try {
    return run();
  } finally {
    console.error = original;
  }
};

// A read over the atom that fails once the outside state turns: the failure
// shows in the subscribing read alone, at the render's clock.
for (const form of ["useValue", "useValues", "useSelect"] as const) {
  test(`${form}: an atom-backed value that starts throwing between render and subscribe reaches the boundary`, () => {
    const realm = Realm.make();
    const atom = Atom.make(realm);
    let broken = false;
    const value = Computed.make(realm, (read) => {
      read(atom);
      if (broken) {
        throw new Error("outside");
      }
      return 1;
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    const readHook = {
      useValue: () => useValue(value),
      useValues: () => useValues([value])[0],
      useSelect: () => useSelect((read) => read(value)),
    }[form];
    function Reader() {
      return element("p", null, readHook());
    }
    function Changer() {
      useLayoutEffect(() => {
        broken = true;
      }, []);
      return null;
    }
    try {
      quiet(() =>
        act(() =>
          root.render(
            element(
              RealmProvider,
              { realm },
              element(
                Boundary,
                null,
                element(Reader, { key: "r" }),
                element(Changer, { key: "c" }),
              ),
            ),
          ),
        ),
      );
      expect(container.textContent).toBe("failed");
    } finally {
      act(() => root.unmount());
    }
  });
}

for (const first of ["box", "none"] as const) {
  test(`useSelect: a new select over a warm atom-backed value that changes before its commit shows, after a select of ${first}`, () => {
    // The reaction is active and follows the new render's capture of a value
    // over an atom nothing observes: the follow must check the atom.
    const realm = Realm.make();
    const atom = Atom.make(realm);
    const box = Box.make(realm, 0);
    let external = 1;
    const value = Computed.make(realm, (read) => {
      read(atom);
      return external;
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    const selects = {
      box: (read: Read) => read(box),
      none: () => 0,
      atom: (read: Read) => read(value),
    };
    function Reader({ which }: { readonly which: "box" | "none" | "atom" }) {
      return element("p", null, useSelect(selects[which]));
    }
    function Changer({ which }: { readonly which: "box" | "none" | "atom" }) {
      useLayoutEffect(() => {
        if (which === "atom") {
          external = 2;
        }
      }, [which]);
      return null;
    }
    const tree = (which: "box" | "none" | "atom") =>
      element(
        RealmProvider,
        { realm },
        element(Changer, { key: "c", which }),
        element(Reader, { key: "r", which }),
      );
    try {
      act(() => root.render(tree(first)));
      expect(container.textContent).toBe("0");
      // Warm: the value ran once, as a read elsewhere leaves it.
      expect(Source.peek(value)).toBe(1);
      act(() => root.render(tree("atom")));
      expect(container.textContent).toBe("2");
    } finally {
      act(() => root.unmount());
    }
  });
}
