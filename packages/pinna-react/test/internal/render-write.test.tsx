/**
 * Characterization, not contract: what a write from inside a render does
 * today. Whether Pinna should refuse such a write is open question 4 in the
 * test catalog, so these tests sit outside the contract bucket until it is
 * decided; a rewrite that refuses the write changes them, not the contract.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Box, Realm, Source } from "@frondruntime/pinna";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RealmProvider, useSelect } from "../../src/index.ts";

let root: Root | undefined;
let container: HTMLElement | undefined;

const mount = (element: ReactNode): HTMLElement => {
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

const set = (realm: Realm, box: Box<number>, value: number): void => {
  act(() => {
    Realm.update(realm, (_read, write) => {
      write(box, value);
    });
  });
};

/**
 * A write from inside a render is not refused today: it lands, and every
 * mounted reader settles on the written value. React itself warns when the
 * write reaches another mounted component ("Cannot update a component while
 * rendering a different component"); whether Pinna should refuse such a
 * write is an open question in the test catalog, so these tests sit outside
 * the contract bucket.
 */
describe("a write during a render", () => {
  test("to a box no component reads lands, and the render finishes", () => {
    const realm = Realm.make();
    const $count = Box.make(realm, 0);
    const $log = Box.make(realm, 0);
    function Show(): ReactNode {
      const count = useSelect((read) => read($count));
      if (count === 1) {
        Realm.update(realm, (_read, write) => {
          write($log, count);
        });
      }
      return <p>{count}</p>;
    }
    const view = mount(
      <RealmProvider realm={realm}>
        <Show />
      </RealmProvider>,
    );

    set(realm, $count, 1);

    expect(view.textContent).toBe("1");
    expect(Realm.untracked(realm, (read) => read($log))).toBe(1);
  });

  test("to a box another mounted component reads settles both on the written values", () => {
    const realm = Realm.make();
    const $count = Box.make(realm, 0);
    const $other = Box.make(realm, 0);
    function Show(): ReactNode {
      const count = useSelect((read) => read($count));
      if (count === 1) {
        Realm.update(realm, (_read, write) => {
          write($other, 5);
        });
      }
      return <p>{count}</p>;
    }
    function Other(): ReactNode {
      return <i>{useSelect((read) => read($other))}</i>;
    }
    const view = mount(
      <RealmProvider realm={realm}>
        <Show />
        <Other />
      </RealmProvider>,
    );
    const original = console.error;
    console.error = () => {};
    try {
      set(realm, $count, 1);
    } finally {
      console.error = original;
    }

    expect(view.textContent).toBe("15");
    act(() => root?.unmount());
    root = undefined;
    expect([$count, $other].map((box) => Source.inspect(box).observers)).toEqual([0, 0]);
  });
});
