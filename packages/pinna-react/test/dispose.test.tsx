import { afterEach, describe, expect, test } from "bun:test";
import { Box, type PinnaUsageError, Realm, Source } from "@frondruntime/pinna";
import { act, Component, type ReactNode, StrictMode, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RealmProvider, useSelect, useValue } from "../src/index.ts";

/**
 * `Realm.dispose` ends the `Source.onObserved` hooks a mounted hook kept started, and
 * the component keeps showing the last value until it unmounts, which does
 * not run a cleanup again. A hook mounting into a disposed realm throws.
 */

let root: Root | undefined;
let container: HTMLElement | undefined;

const mount = (element: ReactNode): HTMLElement => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
});

class Boundary extends Component<
  { readonly children: ReactNode; readonly caught: Array<unknown> },
  { readonly failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(error: unknown): void {
    this.props.caught.push(error);
  }
  override render(): ReactNode {
    return this.state.failed ? "failed" : this.props.children;
  }
}

const socket = (realm: Realm) => {
  const $price = Box.make(realm, 1, { name: "price" });
  const counts = { starts: 0, cleanups: 0 };
  Source.onObserved($price, () => {
    counts.starts++;
    return () => {
      counts.cleanups++;
    };
  });
  return { $price, counts };
};

describe("disposeRealm under React", () => {
  test("ends the hooks a mounted useValue and useSelect kept started, and the screen keeps the last value", () => {
    const realm = Realm.make();
    const { $price, counts } = socket(realm);
    const Price = () => <span>{useValue($price)}</span>;
    const Doubled = () => <span>{useSelect((read) => read($price) * 2)}</span>;
    const screen = mount(
      <RealmProvider realm={realm}>
        <Price />
        <Doubled />
      </RealmProvider>,
    );
    act(() =>
      Realm.update(realm, (_read, write) => {
        write($price, 2);
      }),
    );
    expect(screen.textContent).toBe("24");
    expect(counts).toEqual({ starts: 1, cleanups: 0 });
    act(() => Realm.dispose(realm));
    expect(counts).toEqual({ starts: 1, cleanups: 1 });
    expect(screen.textContent).toBe("24");
    act(() => root?.unmount());
    root = undefined;
    expect(counts.cleanups).toBe(1);
  });

  test("a mounted useSelect that reads a new source after disposal starts no hook", () => {
    const realm = Realm.make();
    const { $price, counts } = socket(realm);
    let show: (next: boolean) => void = () => undefined;
    const Price = () => {
      const [shown, setShown] = useState(false);
      show = setShown;
      return <span>{useSelect((read) => (shown ? read($price) : 0))}</span>;
    };
    const screen = mount(
      <RealmProvider realm={realm}>
        <Price />
      </RealmProvider>,
    );
    act(() => Realm.dispose(realm));
    act(() => show(true));
    expect(screen.textContent).toBe("1");
    expect(counts.starts).toBe(0);
  });

  test("a hook mounting into a disposed realm throws pinna/realm-disposed", () => {
    const realm = Realm.make({ name: "closed" });
    const { $price } = socket(realm);
    Realm.dispose(realm);
    const caught: Array<unknown> = [];
    const Price = () => <span>{useValue($price)}</span>;
    const screen = mount(
      <Boundary caught={caught}>
        <Price />
      </Boundary>,
    );
    expect(screen.textContent).toBe("failed");
    expect((caught[0] as PinnaUsageError).code).toBe("pinna/realm-disposed");
  });

  test("a realm made and disposed in one effect survives StrictMode", () => {
    const made: Array<Realm> = [];
    const Screen = () => {
      const [realm, setRealm] = useState<Realm | null>(null);
      useEffect(() => {
        const next = Realm.make();
        made.push(next);
        setRealm(next);
        return () => Realm.dispose(next);
      }, []);
      return realm === null ? null : <Counter realm={realm} />;
    };
    const Counter = ({ realm }: { readonly realm: Realm }) => {
      const [$count] = useState(() => Box.make(realm, 7));
      return <span>{useValue($count)}</span>;
    };
    const screen = mount(
      <StrictMode>
        <Screen />
      </StrictMode>,
    );
    expect(screen.textContent).toBe("7");
    expect(made).toHaveLength(2);
  });
});
