/**
 * A render reads its sources apart, and the commit makes them the ones the
 * component follows: the public twin of pinna-core's "a reaction's pending
 * run" tests (`trackPending` and `adopt`), which only the React hooks use.
 * A change between a render and its commit, and a render React discards,
 * are covered in `react.test.tsx`; a pending run that throws has no render
 * form and stays in pinna-core.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Box, Realm, Source } from "@frondruntime/pinna";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RealmProvider, useSelect } from "../src/index.ts";

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

/** Logs each start and stop of `box`'s observed hook as `start name` or `stop name`. */
const logObserved = (box: Box<number>, name: string, log: Array<string>): void => {
  Source.onObserved(box, () => {
    log.push(`start ${name}`);
    return () => {
      log.push(`stop ${name}`);
    };
  });
};

describe("a render and its commit", () => {
  test("a commit follows what the render read and lets go of the rest", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 1);
    const $b = Box.make(realm, 10);
    const log: Array<string> = [];
    logObserved($a, "a", log);
    logObserved($b, "b", log);
    let renders = 0;
    function Show({ useB }: { readonly useB: boolean }): ReactNode {
      renders++;
      return <p>{useSelect((read) => (useB ? read($b) : read($a)))}</p>;
    }
    const app = (useB: boolean): ReactNode => (
      <RealmProvider realm={realm}>
        <Show useB={useB} />
      </RealmProvider>
    );
    const view = mount(app(false));
    expect(log).toEqual(["start a"]);

    act(() => root?.render(app(true)));
    expect(log).toEqual(["start a", "start b", "stop a"]);
    expect(view.textContent).toBe("10");
    renders = 0;

    set(realm, $a, 2);
    expect(renders).toBe(0);
    set(realm, $b, 11);
    expect(view.textContent).toBe("11");

    act(() => root?.unmount());
    root = undefined;
    expect(log).toEqual(["start a", "start b", "stop a", "stop b"]);
  });

  test("renders that read the same sources keep the subscription in place", () => {
    const realm = Realm.make();
    const $a = Box.make(realm, 1);
    const log: Array<string> = [];
    logObserved($a, "a", log);
    let renders = 0;
    function Show({ label }: { readonly label: string }): ReactNode {
      renders++;
      return (
        <p>
          {label}
          {useSelect((read) => read($a))}
        </p>
      );
    }
    const app = (label: string): ReactNode => (
      <RealmProvider realm={realm}>
        <Show label={label} />
      </RealmProvider>
    );
    const view = mount(app("v0:"));
    for (const label of ["v1:", "v2:", "v3:"]) {
      act(() => root?.render(app(label)));
    }
    expect(log).toEqual(["start a"]);
    renders = 0;

    set(realm, $a, 2);

    expect(renders).toBe(1);
    expect(view.textContent).toBe("v3:2");
    expect(Source.inspect($a).observers).toBe(1);
  });
});
