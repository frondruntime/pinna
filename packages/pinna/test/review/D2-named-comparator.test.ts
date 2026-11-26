import { expect, test } from "bun:test";
import { Box, Computed, Realm, Source } from "../../src/index.ts";

// Edge (ruling 67), recorded in principles.md. Misuse inside a computed value's `equals` still throws
// loudly; only the label is generic ("a derived value"). The comparator runs with no active node, and
// naming the computed value would need a store on each recompute that has an `equals`, which is not
// worth a weaker label on a loud error.
test("misuse in a named computed comparator names a derived value, not the computed value", () => {
  const realm = Realm.make();
  const count = Box.make(realm, 0);
  const named = Computed.make(realm, (read) => read(count), {
    name: "total",
    equals: (previous, next) => {
      Source.observe(count);
      return previous === next;
    },
  });
  expect(Source.peek(named)).toBe(0);
  Realm.update(realm, (_, write) => {
    write(count, 1);
  });
  expect(() => Source.peek(named)).toThrow(
    "pinna: a derived value cannot observe or release while it computes",
  );
});
