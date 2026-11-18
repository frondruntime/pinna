/**
 * The graph shapes of js-reactivity-benchmark: kairo's eight, cellx, and
 * molBench, each on Pinna, on MobX, the library Pinna replaces, and on Legend
 * State. They go through `graph-model.ts`'s `Library`, so each pays the same
 * wrapper calls.
 * A step is a hundred writes, each its own update as a socket handler makes
 * it, or one batch for cellx and two for molBench, so the clock reads are a
 * small share of it.
 */
import { type Library, libraries } from "../graph-model.ts";
import { type Built, expectEqual, type Scenario } from "./harness.ts";

type Subject = "pinna" | "mobx" | "legend";

interface Shape {
  readonly name: string;
  readonly steps: number;
  readonly build: (library: Library) => Built;
  /** The subjects it runs on, where not all of them. */
  readonly subjects?: ReadonlyArray<Subject>;
}

const writes = 100;

/** A counter that a watch bumps on each change it sees. */
const counter = () => {
  let count = 0;
  return {
    bump: (): undefined => {
      count++;
    },
    get count(): number {
      return count;
    },
  };
};

const stopAll = (stops: ReadonlyArray<() => void>) => (): void => {
  for (const stop of stops) {
    stop();
  }
};

/** kairo: a chain of 50 computed values with a watch at the end. */
const deep: Shape = {
  name: "kairo deep: chain of 50",
  steps: 2000,
  build: (library) => {
    const head = library.source(0);
    let current = (): number => head.get();
    for (let index = 0; index < 50; index++) {
      const previous = current;
      current = library.computed(() => previous() + 1);
    }
    const runs = counter();
    const stop = library.watch(current, runs.bump);
    let value = 0;
    return {
      step: () => {
        for (let index = 0; index < writes; index++) {
          library.batch(() => head.set(++value));
        }
      },
      check: () => expectEqual(runs.count, 2000 * writes, "deep runs"),
      dispose: stop,
    };
  },
};

/** kairo: one source read by 50 two-step branches, each watched. */
const broad: Shape = {
  name: "kairo broad: 50 watched branches",
  steps: 500,
  build: (library) => {
    const head = library.source(0);
    const runs = counter();
    const stops: Array<() => void> = [];
    for (let index = 0; index < 50; index++) {
      const first = library.computed(() => head.get() + index);
      const second = library.computed(() => first() + 1);
      stops.push(library.watch(second, runs.bump));
    }
    let value = 0;
    return {
      step: () => {
        for (let index = 0; index < writes; index++) {
          library.batch(() => head.set(++value));
        }
      },
      check: () => expectEqual(runs.count, 500 * writes * 50, "broad runs"),
      dispose: stopAll(stops),
    };
  },
};

/** kairo: one source into five computed values into a sum. */
const diamond: Shape = {
  name: "kairo diamond: width 5",
  steps: 2000,
  build: (library) => {
    const head = library.source(0);
    const branches = Array.from({ length: 5 }, () => library.computed(() => head.get() + 1));
    const sum = library.computed(() => branches.reduce((total, branch) => total + branch(), 0));
    const runs = counter();
    const stop = library.watch(sum, runs.bump);
    let value = 0;
    return {
      step: () => {
        for (let index = 0; index < writes; index++) {
          library.batch(() => head.set(++value));
        }
      },
      check: () => expectEqual(runs.count, 2000 * writes, "diamond runs"),
      dispose: stop,
    };
  },
};

/** kairo: a chain whose end is a sum of every link, so each link feeds two places. */
const triangle: Shape = {
  name: "kairo triangle: width 10",
  steps: 2000,
  build: (library) => {
    const head = library.source(0);
    const links: Array<() => number> = [];
    let current = (): number => head.get();
    for (let index = 0; index < 10; index++) {
      const previous = current;
      current = library.computed(() => previous() + 1);
      links.push(current);
    }
    const sum = library.computed(() => links.reduce((total, link) => total + link(), 0));
    const runs = counter();
    const stop = library.watch(sum, runs.bump);
    let value = 0;
    return {
      step: () => {
        for (let index = 0; index < writes; index++) {
          library.batch(() => head.set(++value));
        }
      },
      check: () => expectEqual(runs.count, 2000 * writes, "triangle runs"),
      dispose: stop,
    };
  },
};

/** kairo: 100 sources into one object, split back into 100 watched values. */
const mux: Shape = {
  name: "kairo mux: 100 into one, split out",
  steps: 500,
  build: (library) => {
    const heads = Array.from({ length: 100 }, () => library.source(0));
    const muxed = library.computed(() => heads.map((head) => head.get()));
    const runs = counter();
    const stops = heads.map((_, index) => {
      const split = library.computed(() => (muxed()[index] as number) + 1);
      return library.watch(
        library.computed(() => split() + 1),
        runs.bump,
      );
    });
    let value = 0;
    return {
      step: () => {
        for (let index = 0; index < writes; index++) {
          const head = heads[index % heads.length] as { set: (value: number) => void };
          library.batch(() => head.set(++value));
        }
      },
      check: () => expectEqual(runs.count, 500 * writes, "mux runs"),
      dispose: stopAll(stops),
    };
  },
};

/** kairo: a computed value that reads its one source 30 times. */
const repeated: Shape = {
  name: "kairo repeated observers: 30 reads",
  steps: 2000,
  build: (library) => {
    const head = library.source(0);
    const sum = library.computed(() => {
      let total = 0;
      for (let index = 0; index < 30; index++) {
        total += head.get();
      }
      return total;
    });
    const runs = counter();
    const stop = library.watch(sum, runs.bump);
    let value = 0;
    return {
      step: () => {
        for (let index = 0; index < writes; index++) {
          library.batch(() => head.set(++value));
        }
      },
      check: () => expectEqual(runs.count, 2000 * writes, "repeated runs"),
      dispose: stop,
    };
  },
};

/** kairo: a computed value whose sources flip with the source's parity. */
const unstable: Shape = {
  name: "kairo unstable: sources flip each write",
  steps: 2000,
  build: (library) => {
    const head = library.source(0);
    const double = library.computed(() => head.get() * 2);
    const inverse = library.computed(() => -head.get());
    const current = library.computed(() => {
      let result = 0;
      for (let index = 0; index < 20; index++) {
        result += head.get() % 2 ? double() : inverse();
      }
      return result;
    });
    const runs = counter();
    const stop = library.watch(current, runs.bump);
    let value = 0;
    return {
      step: () => {
        for (let index = 0; index < writes; index++) {
          library.batch(() => head.set(++value));
        }
      },
      check: () => expectEqual(runs.count, 2000 * writes, "unstable runs"),
      dispose: stop,
    };
  },
};

/** kairo: a value that stops changing early, so nothing past it should run. */
const avoidable: Shape = {
  name: "kairo avoidable: change stops at the second link",
  steps: 2000,
  build: (library) => {
    const head = library.source(0);
    let busy = 0;
    const first = library.computed(() => head.get());
    const second = library.computed(() => {
      first();
      return 0;
    });
    const third = library.computed(() => {
      busy++;
      return second() + 1;
    });
    const fourth = library.computed(() => third() + 2);
    const fifth = library.computed(() => fourth() + 3);
    const runs = counter();
    const stop = library.watch(fifth, runs.bump);
    // Legend computes `third` twice on the watch's first read, the others
    // once; what the shape checks is that no write recomputes it.
    const built = busy;
    let value = 0;
    return {
      step: () => {
        for (let index = 0; index < writes; index++) {
          library.batch(() => head.set(++value));
        }
      },
      check: () => {
        expectEqual(runs.count, 0, "avoidable runs");
        expectEqual(busy - built, 0, "avoidable recomputes after build");
      },
      dispose: stop,
    };
  },
};

/** cellx: layers of four cells, each reading the layer before; four writes in one batch. */
const cellx = (layers: number): Shape => ({
  name: `cellx: ${layers} layers`,
  steps: 500,
  build: (library) => {
    const start = {
      a: library.source(1),
      b: library.source(2),
      c: library.source(3),
      d: library.source(4),
    };
    let layer = {
      a: (): number => start.a.get(),
      b: (): number => start.b.get(),
      c: (): number => start.c.get(),
      d: (): number => start.d.get(),
    };
    for (let index = 0; index < layers; index++) {
      const previous = layer;
      layer = {
        a: library.computed(() => previous.b()),
        b: library.computed(() => previous.a() - previous.c()),
        c: library.computed(() => previous.b() + previous.d()),
        d: library.computed(() => previous.c()),
      };
    }
    const end = layer;
    const runs = counter();
    const stops = [end.a, end.b, end.c, end.d].map((cell) => library.watch(cell, runs.bump));
    const expected = (values: { a: number; b: number; c: number; d: number }) => {
      let { a, b, c, d } = values;
      for (let index = 0; index < layers; index++) {
        [a, b, c, d] = [b, a - c, b + d, c];
      }
      return [a, b, c, d].join();
    };
    let flip = false;
    return {
      step: () => {
        flip = !flip;
        library.batch(() => {
          start.a.set(flip ? 4 : 1);
          start.b.set(flip ? 3 : 2);
          start.c.set(flip ? 2 : 3);
          start.d.set(flip ? 1 : 4);
        });
      },
      check: () => {
        // Pinna reads only inside an update or a tracked context.
        let actual = "";
        library.batch(() => {
          actual = [end.a(), end.b(), end.c(), end.d()].join();
        });
        expectEqual(
          actual,
          expected(flip ? { a: 4, b: 3, c: 2, d: 1 } : { a: 1, b: 2, c: 3, d: 4 }),
          "cellx end layer",
        );
      },
      dispose: stopAll(stops),
    };
  },
});

/** molBench: two sources, a small derived web with an array, three watches; two batches a step. */
const molBench: Shape = {
  name: "molBench",
  steps: 5000,
  build: (library) => {
    const numbers = [0, 1, 2, 3, 4];
    const a = library.source(0);
    const b = library.source(0);
    const c = library.computed(() => (a.get() % 2) + (b.get() % 2));
    const d = library.computed(() =>
      numbers.map((index) => ({ x: index + (a.get() % 2) - (b.get() % 2) })),
    );
    const e = library.computed(() => c() + a.get() + (d()[0] as { x: number }).x + 1);
    const f = library.computed(() => (d()[2] as { x: number }).x || b.get());
    const g = library.computed(() => c() + (c() || e() % 2) + (d()[4] as { x: number }).x + f());
    const runs = counter();
    const stops = [
      library.watch(g, runs.bump),
      library.watch(f, runs.bump),
      library.watch(e, runs.bump),
    ];
    return {
      step: (index) => {
        library.batch(() => {
          b.set(1);
          a.set(1 + index * 2);
        });
        library.batch(() => {
          a.set(2 + index * 2);
          b.set(2);
        });
      },
      check: () => {
        if (runs.count === 0) {
          throw new Error("blackbox: molBench ran no watch");
        }
      },
      dispose: stopAll(stops),
    };
  },
};

const shapes: ReadonlyArray<Shape> = [
  deep,
  broad,
  diamond,
  triangle,
  mux,
  repeated,
  unstable,
  avoidable,
  // js-reactivity-benchmark also runs 2,500 and 5,000 layers. Pinna's
  // recursive recompute overflows Hermes's stack past about 1,100 nested
  // computed values (docs/performance.md), so those depths are left out.
  // Legend overflows it at 1,000 layers already, so cellx runs without it.
  { ...cellx(1000), subjects: ["pinna", "mobx"] },
  molBench,
];

const subjects: ReadonlyArray<Subject> = ["pinna", "mobx", "legend"];

export const shapeScenarios: ReadonlyArray<Scenario> = shapes.flatMap((shape) =>
  (shape.subjects ?? subjects).map(
    (subject): Scenario => ({
      name: `${shape.name} (${subject})`,
      story: "a js-reactivity-benchmark graph shape",
      steps: shape.steps,
      build: () => shape.build(libraries[subject]()),
    }),
  ),
);
