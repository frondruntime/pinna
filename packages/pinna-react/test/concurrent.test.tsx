/**
 * The hooks under React's concurrent features. They read through
 * `useSyncExternalStore`, so a write renders as a blocking update, even
 * inside `startTransition`. `useDeferredValue` over a hook's result is how a
 * component lowers the priority of a slow render that follows a write.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { box, createRealm, onObserved, update } from "@frondruntime/pinna";
import {
  Activity,
  act,
  type ReactNode,
  Suspense,
  startTransition,
  use,
  useDeferredValue,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { useValue } from "../src/index.ts";

let root: Root | undefined;
let container: HTMLElement | undefined;

const mount = async (element: ReactNode): Promise<HTMLElement> => {
  container = document.createElement("div");
  document.body.append(container);
  const created = createRoot(container);
  root = created;
  await act(async () => created.render(element));
  return container;
};

/** The text of the paragraphs on screen; React hides suspended content with `display: none`. */
const shown = (view: HTMLElement): string =>
  [...view.querySelectorAll("p")]
    .filter((paragraph) => paragraph.style.display !== "none")
    .map((paragraph) => paragraph.textContent)
    .join(" ");

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
});

describe("useDeferredValue", () => {
  test("a write renders the urgent value first and the deferred one after", async () => {
    const realm = createRealm();
    const $query = box(realm, "");
    const log: Array<string> = [];
    function Search(): ReactNode {
      const query = useValue($query);
      const deferred = useDeferredValue(query);
      log.push(`${query}/${deferred}`);
      return null;
    }
    await mount(<Search />);
    log.length = 0;
    await act(async () => update(realm, (_read, write) => write($query, "a")));
    expect(log).toEqual(["a/", "a/a"]);
  });

  test("a write inside startTransition still renders at once", async () => {
    const realm = createRealm();
    const $query = box(realm, "");
    const log: Array<string> = [];
    function Search(): ReactNode {
      const query = useValue($query);
      const deferred = useDeferredValue(query);
      log.push(`${query}/${deferred}`);
      return null;
    }
    await mount(<Search />);
    log.length = 0;
    await act(async () =>
      startTransition(() => update(realm, (_read, write) => write($query, "a"))),
    );
    expect(log).toEqual(["a/", "a/a"]);
  });
});

describe("Suspense", () => {
  /** A user per id, loaded once; `resolve` finishes the load of `id`. */
  const users = () => {
    const loads = new Map<number, { promise: Promise<string>; resolve: () => void }>();
    const load = (id: number) => {
      let entry = loads.get(id);
      if (entry === undefined) {
        let resolve = () => {};
        const promise = new Promise<string>((done) => {
          resolve = () => done(`user ${id}`);
        });
        entry = { promise, resolve };
        loads.set(id, entry);
      }
      return entry;
    };
    return {
      read: (id: number): Promise<string> => load(id).promise,
      resolve: (id: number): void => load(id).resolve(),
    };
  };

  function User({
    load,
    id,
  }: {
    readonly load: (id: number) => Promise<string>;
    readonly id: number;
  }) {
    return <p>{use(load(id))}</p>;
  }

  test("a write that suspends shows the fallback in place of the shown content", async () => {
    const realm = createRealm();
    const $id = box(realm, 1);
    const loads = users();
    loads.resolve(1);
    function Profile(): ReactNode {
      return <User load={loads.read} id={useValue($id)} />;
    }
    const view = await mount(
      <Suspense fallback={<p>loading</p>}>
        <Profile />
      </Suspense>,
    );
    expect(shown(view)).toBe("user 1");
    await act(async () => update(realm, (_read, write) => write($id, 2)));
    expect(shown(view)).toBe("loading");
    await act(async () => loads.resolve(2));
    expect(shown(view)).toBe("user 2");
  });

  test("a deferred id keeps the shown content until the next one loads", async () => {
    const realm = createRealm();
    const $id = box(realm, 1);
    const loads = users();
    loads.resolve(1);
    function Profile(): ReactNode {
      const id = useDeferredValue(useValue($id));
      return <User load={loads.read} id={id} />;
    }
    const view = await mount(
      <Suspense fallback={<p>loading</p>}>
        <Profile />
      </Suspense>,
    );
    await act(async () => update(realm, (_read, write) => write($id, 2)));
    expect(shown(view)).toBe("user 1");
    await act(async () => loads.resolve(2));
    expect(shown(view)).toBe("user 2");
  });
});

describe("Activity", () => {
  test("hiding unsubscribes, and showing again renders what was written meanwhile", async () => {
    const realm = createRealm();
    const $count = box(realm, 0);
    const events: Array<string> = [];
    onObserved($count, () => {
      events.push("start");
      return () => events.push("stop");
    });
    const renders: Array<number> = [];
    function Count(): ReactNode {
      const count = useValue($count);
      renders.push(count);
      return <p>{count}</p>;
    }
    const view = await mount(
      <Activity mode="visible">
        <Count />
      </Activity>,
    );
    expect(events).toEqual(["start"]);
    await act(async () =>
      root?.render(
        <Activity mode="hidden">
          <Count />
        </Activity>,
      ),
    );
    expect(events).toEqual(["start", "stop"]);
    renders.length = 0;
    await act(async () => update(realm, (_read, write) => write($count, 1)));
    expect(renders).toEqual([]);
    await act(async () =>
      root?.render(
        <Activity mode="visible">
          <Count />
        </Activity>,
      ),
    );
    expect(events).toEqual(["start", "stop", "start"]);
    expect(view.textContent).toBe("1");
  });
});
