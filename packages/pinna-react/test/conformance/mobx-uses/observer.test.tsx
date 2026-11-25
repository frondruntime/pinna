import { afterEach, describe, expect, test } from "bun:test";
import { Box, Realm } from "@frondruntime/pinna-effect";
import { Schema } from "effect";
import { observable, Reaction, runInAction } from "mobx";
import { act, type ReactNode, useEffect, useReducer, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RealmProvider, useSelect } from "../../../src/index.ts";

/**
 * An application's `observer` use: a component that rerenders when what its
 * render read changes. `mobx-react-lite` is not a dependency here, so the MobX
 * side is the core of `observer` written out: a `Reaction` that tracks the
 * render and forces the next one. Pinna has no wrapper; the component
 * reads through `useValue`.
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

/** The core of `observer`: tracks each render and rerenders on its change. */
const observer = <Props,>(render: (props: Props) => ReactNode) =>
  function Observed(props: Props): ReactNode {
    const [, rerender] = useReducer((count: number) => count + 1, 0);
    const reaction = useRef<Reaction | null>(null);
    if (reaction.current === null) {
      reaction.current = new Reaction("observer", rerender);
    }
    useEffect(() => () => reaction.current?.dispose(), []);
    let output: ReactNode = null;
    reaction.current.track(() => {
      output = render(props);
    });
    return output;
  };

// One render per batch that changes what it read, none for a write it did
// not read, and the text follows the state.
const trace = { texts: ["EUR/USD 1.1", "EUR/GBP 0.9", "EUR/GBP 0.9"], renders: [1, 2, 2] };

describe("observer", () => {
  test("MobX: a Reaction tracks the render", () => {
    const quote = observable({ pair: "EUR/USD", rate: 1.1, volume: 0 });
    let renders = 0;
    const Quote = observer(() => {
      renders++;
      return (
        <p>
          {quote.pair} {quote.rate}
        </p>
      );
    });
    const view = mount(<Quote />);
    const texts = [view.textContent];
    const counts = [renders];
    act(() => {
      runInAction(() => {
        quote.pair = "EUR/GBP";
        quote.rate = 0.9;
      });
    });
    texts.push(view.textContent);
    counts.push(renders);
    act(() => {
      runInAction(() => {
        quote.volume = 5;
      });
    });
    texts.push(view.textContent);
    counts.push(renders);
    expect({ texts, renders: counts }).toEqual(trace);
  });

  test("Pinna: useValue in the realm RealmProvider gives", () => {
    const realm = Realm.make();
    const $pair = Box.schema(realm, Schema.String, "EUR/USD");
    const $rate = Box.schema(realm, Schema.Number, 1.1);
    const $volume = Box.schema(realm, Schema.Number, 0);
    let renders = 0;
    const Quote = () => {
      renders++;
      const text = useSelect((read) => `${read($pair)} ${read($rate)}`);
      return <p>{text}</p>;
    };
    const view = mount(
      <RealmProvider realm={realm}>
        <Quote />
      </RealmProvider>,
    );
    const texts = [view.textContent];
    const counts = [renders];
    act(() => {
      Realm.update(realm, (_read, write) => {
        write($pair, "EUR/GBP");
        write($rate, 0.9);
      });
    });
    texts.push(view.textContent);
    counts.push(renders);
    act(() => {
      Realm.update(realm, (_read, write) => {
        write($volume, 5);
      });
    });
    texts.push(view.textContent);
    counts.push(renders);
    expect({ texts, renders: counts }).toEqual(trace);
  });
});
