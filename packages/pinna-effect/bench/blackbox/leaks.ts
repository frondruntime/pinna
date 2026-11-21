/**
 * Leak scenarios: work that should leave nothing behind, repeated until a
 * slow leak shows as live growth. Each also reports its time per step.
 */

import { Schema } from "effect";
import {
  type Box,
  computed,
  computedFunction,
  createRealm,
  decode,
  observe,
  onObserved,
  schemaBox,
  untracked,
  update,
  watch,
} from "../../src/index.ts";
import { type Built, expectEqual, type Scenario, seeded } from "./harness.ts";
import { type Market, Markets, marketsWire, tick } from "./market.ts";

const ignore = (): undefined => undefined;

/** The harness floor: a step that does nothing, so what it costs is the harness's. */
const nothing: Scenario = {
  name: "floor: an empty step",
  story: "what the harness itself costs per step",
  steps: 20_000,
  build: (): Built => ({ step: ignore, check: ignore }),
};

/**
 * A long session: one write per update, a hundred updates a step, on a
 * screen of 50 watched markets. Two hundred thousand updates in all.
 */
const longSession: Scenario = {
  name: "long session: 200k single-write updates",
  story: "a screen left open for hours, one write per update",
  steps: 2000,
  build: (): Built => {
    const random = seeded(11);
    const realm = createRealm();
    const state = decode(realm, Markets)(marketsWire(50, random));
    const all = untracked(realm, (read) => read(state.$items.rows));
    let renders = 0;
    const stops = all.map((market) =>
      watch(
        realm,
        (read) => read(market.$priceText),
        () => {
          renders++;
        },
      ),
    );
    return {
      step: () => {
        for (let index = 0; index < 100; index++) {
          const market = all[Math.floor(random() * all.length)] as Market;
          update(realm, (read, write) => {
            write(market.$price, read(market.$price) * (0.999 + random() * 0.002));
            return undefined;
          });
        }
      },
      check: () => {
        if (renders === 0) {
          throw new Error("blackbox: nothing rendered");
        }
      },
      dispose: () => {
        for (const stop of stops) {
          stop();
        }
      },
    };
  },
};

/**
 * What goes wrong in a session: a write the schema rejects, an update that
 * throws and is undone, a watch effect that throws, and a computed value
 * that throws while a watch reads it. Each error is caught or reported.
 */
const errorChurn: Scenario = {
  name: "errors: rejected writes, undone updates, throwing effects",
  story: "bad data and failing handlers, caught, for a whole session",
  steps: 3000,
  build: (): Built => {
    const random = seeded(12);
    let reported = 0;
    const realm = createRealm({
      onError: () => {
        reported++;
      },
    });
    const state = decode(realm, Markets)(marketsWire(20, random));
    const all = untracked(realm, (read) => read(state.$items.rows));
    const market = all[0] as Market;
    const fragile = computed(realm, (read) => {
      const price = read(market.$price);
      if (price < 0) {
        throw new Error("negative price");
      }
      return price;
    });
    let caughtInSelect = 0;
    const stops = [
      watch(
        realm,
        (read) => read(market.$volume),
        () => {
          throw new Error("effect failed");
        },
      ),
      watch(
        realm,
        (read) => {
          try {
            return read(fragile);
          } catch {
            caughtInSelect++;
            return -1;
          }
        },
        ignore,
      ),
    ];
    let caught = 0;
    return {
      step: () => {
        try {
          update(realm, (_read, write) => {
            write(market.$price as Box<unknown>, "not a number");
            return undefined;
          });
        } catch {
          caught++;
        }
        try {
          update(realm, (read, write) => {
            tick(read, write, market, random);
            throw new Error("handler failed");
          });
        } catch {
          caught++;
        }
        update(realm, (read, write) => {
          write(market.$volume, read(market.$volume) + 1);
          write(market.$price, -read(market.$price));
          return undefined;
        });
      },
      check: () => {
        expectEqual(caught, 2 * errorChurn.steps, "caught errors");
        expectEqual(reported, errorChurn.steps, "reported effect errors");
        expectEqual(caughtInSelect > 0, true, "a select caught the computed error");
      },
      dispose: () => {
        for (const stop of stops) {
          stop();
        }
      },
    };
  },
};

/**
 * A realm per screen or per test: made, filled, watched, and dropped. The
 * realm and everything in it must go.
 */
const realmChurn: Scenario = {
  name: "realm churn: make, fill, watch, drop",
  story: "a realm made and dropped per screen, 50 markets each",
  steps: 2000,
  build: (): Built => {
    const random = seeded(13);
    const wire = marketsWire(50, random);
    let renders = 0;
    return {
      step: () => {
        const realm = createRealm();
        const state = decode(realm, Markets)(wire);
        const all = untracked(realm, (read) => read(state.$items.rows));
        const stops = all.slice(0, 10).map((market) =>
          watch(
            realm,
            (read) => read(market.$changeText),
            () => {
              renders++;
            },
          ),
        );
        const removeHook = onObserved((all[0] as Market).$price, () => ignore);
        update(realm, (read, write) => {
          for (const market of all.slice(0, 10)) {
            tick(read, write, market, random);
          }
          return undefined;
        });
        for (const stop of stops) {
          stop();
        }
        removeHook();
      },
      check: () => {
        if (renders === 0) {
          throw new Error("blackbox: nothing rendered");
        }
      },
    };
  },
};

/**
 * `computedFunction` with what an app passes it: an id string, a fresh object, and a
 * call that is only read untracked and never observed. And `row` for keys that are
 * not in the collection, as a deep link to a delisted market does.
 */
const memoChurn = (
  kind:
    | "string, observed"
    | "object, observed"
    | "object, read untracked"
    | "missing row, read untracked"
    | "missing row, observed",
): Scenario => ({
  name: `memo churn: ${kind}`,
  story: "memoized lookups with arguments that keep changing",
  steps: 5000,
  build: (): Built => {
    const random = seeded(14);
    const realm = createRealm();
    const state = decode(realm, Markets)(marketsWire(100, random));
    const byId = computedFunction(realm, (read, id: string) => {
      const market = read(state.$items.row(id));
      return market === undefined ? undefined : read(market.$priceText);
    });
    const byObject = computedFunction(realm, (read, query: { readonly id: string }) => {
      const market = read(state.$items.row(query.id));
      return market === undefined ? undefined : read(market.$priceText);
    });
    let seen = 0;
    return {
      step: (index) => {
        const id = `M${index % 100}`;
        switch (kind) {
          case "string, observed": {
            const release = observe(byId(`${id}`));
            seen += untracked(realm, (read) => read(byId(id))) === undefined ? 0 : 1;
            release();
            break;
          }
          case "object, observed": {
            const computed = byObject({ id });
            const release = observe(computed);
            seen += untracked(realm, (read) => read(computed)) === undefined ? 0 : 1;
            release();
            break;
          }
          case "object, read untracked":
            seen += untracked(realm, (read) => read(byObject({ id }))) === undefined ? 0 : 1;
            break;
          case "missing row, read untracked":
            seen +=
              untracked(realm, (read) => read(state.$items.row(`gone-${index}`))) === undefined
                ? 1
                : 0;
            break;
          case "missing row, observed": {
            const row = state.$items.row(`gone-${index}`);
            const release = observe(row);
            seen += untracked(realm, (read) => read(row)) === undefined ? 1 : 0;
            release();
            break;
          }
        }
      },
      check: () => {
        expectEqual(seen, 5000, "lookups answered");
      },
    };
  },
});

/** A form: a box per field, made per screen, written per keystroke, checked by its schema. */
const formChurn: Scenario = {
  name: "form churn: a box per field per screen",
  story: "an order form opened, typed into, and closed",
  steps: 3000,
  build: (): Built => {
    const realm = createRealm();
    const Amount = Schema.Number.check(Schema.isGreaterThan(0));
    let submitted = 0;
    return {
      step: () => {
        const $amount = schemaBox(realm, Amount, 1);
        const $note = schemaBox(realm, Schema.String, "");
        const $valid = computed(realm, (read) => read($amount) > 0 && read($note).length < 100);
        const stop = watch(realm, (read) => read($valid), ignore);
        for (let key = 0; key < 10; key++) {
          update(realm, (read, write) => {
            write($amount, read($amount) + 1);
            write($note, `${read($note)}x`);
            return undefined;
          });
        }
        if (untracked(realm, (read) => read($valid))) {
          submitted++;
        }
        stop();
      },
      check: () => {
        expectEqual(submitted, 3000, "forms submitted");
      },
    };
  },
};

export const leakScenarios: ReadonlyArray<Scenario> = [
  nothing,
  longSession,
  errorChurn,
  realmChurn,
  memoChurn("string, observed"),
  memoChurn("object, observed"),
  memoChurn("object, read untracked"),
  memoChurn("missing row, read untracked"),
  memoChurn("missing row, observed"),
  formChurn,
];
