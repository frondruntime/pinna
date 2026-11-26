/**
 * Components compiled by the React Compiler stay current. The case that
 * renders stale with `observer` on live objects: a component that passes its
 * input to a helper, and a list that maps items whose values changed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transformAsync } from "@babel/core";
import { Realm } from "@frondruntime/pinna-effect";
import type { FunctionComponent } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Portfolio, positionsJson } from "./model.ts";

const source = `
import { RealmProvider, useSelect, useValue, useValues } from "PINNA_REACT";

const describePosition = (position) => position.label;

export function Row({ position }) {
  const value = useValue(position.$value);
  return <li>{describePosition(position)}: {value}</li>;
}

export function Summary({ portfolio }) {
  const [currency, label] = useValues([portfolio.$currency, portfolio.$totalLabel]);
  return <p>{currency}/{label}</p>;
}

export function Positions({ portfolio }) {
  const items = useSelect((read) => read(portfolio.$response).items);
  return <ul>{items.map((position) => <Row key={position.id} position={position} />)}</ul>;
}

export function App({ portfolio }) {
  return (
    <RealmProvider realm={portfolio.realm}>
      <Summary portfolio={portfolio} />
      <Positions portfolio={portfolio} />
    </RealmProvider>
  );
}
`;

let directory: string | undefined;
let compiled = "";
let App: FunctionComponent<{ readonly portfolio: Portfolio }>;
let root: Root | undefined;
let container: HTMLElement | undefined;

beforeAll(async () => {
  const result = await transformAsync(source, {
    filename: "positions.jsx",
    configFile: false,
    babelrc: false,
    plugins: [
      "@babel/plugin-syntax-jsx",
      ["babel-plugin-react-compiler", { target: "19", panicThreshold: "all_errors" }],
    ],
  });
  compiled = (result?.code ?? "").replace("PINNA_REACT", "../../src/index.ts");
  // Inside the package, so the compiled module resolves react from its node_modules.
  directory = mkdtempSync(join(import.meta.dir, ".compiled-"));
  const file = join(directory, "positions.jsx");
  writeFileSync(file, compiled);
  ({ App } = await import(file));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
});

afterAll(() => {
  if (directory !== undefined) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const mount = (portfolio: Portfolio): HTMLElement => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<App portfolio={portfolio} />));
  return container;
};

describe("React Compiler", () => {
  test("the components are compiled and read observables only inside useSelect", () => {
    expect(compiled).toContain("compiler-runtime");
    // The one read is the read function's body; a read the compiler hoisted
    // into the render would throw on mount.
    expect(compiled.match(/\bread\(\w+\.\$\w+\)/g)).toEqual(["read(portfolio.$response)"]);
    const portfolio = new Portfolio(Realm.make());
    portfolio.load(positionsJson(2));
    expect(mount(portfolio).querySelector("p")?.textContent).toBe("USD/30 USD");
  });

  test("useValues follows each change", () => {
    const portfolio = new Portfolio(Realm.make());
    portfolio.load(positionsJson(2));
    const view = mount(portfolio);
    act(() =>
      Realm.update(portfolio.realm, (_read, write) => {
        write(portfolio.$currency, "EUR");
      }),
    );
    expect(view.querySelector("p")?.textContent).toBe("EUR/30 EUR");
    act(() => portfolio.tick({ id: "p0", price: 20 }));
    expect(view.querySelector("p")?.textContent).toBe("EUR/40 EUR");
  });

  test("a row that passes its position to a helper shows each tick", () => {
    const portfolio = new Portfolio(Realm.make());
    portfolio.load(positionsJson(3));
    const view = mount(portfolio);
    act(() => portfolio.tick({ id: "p1", price: 20 }));
    expect(view.querySelectorAll("li")[1]?.textContent).toBe("2 T1: 40");
    act(() => portfolio.tick({ id: "p1", price: 30 }));
    expect(view.querySelectorAll("li")[1]?.textContent).toBe("2 T1: 60");
  });

  test("the list follows removals", () => {
    const portfolio = new Portfolio(Realm.make());
    portfolio.load(positionsJson(3));
    const view = mount(portfolio);
    act(() => portfolio.close("p0"));
    expect([...view.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "2 T1: 20",
      "3 T2: 30",
    ]);
  });
});
