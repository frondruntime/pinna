import { describe, test } from "bun:test";
import { checked as libraries } from "../../src/libraries/index.ts";
import { cases } from "./cases.ts";
import { gaps } from "./gaps.ts";

for (const library of libraries) {
  describe(library.name, () => {
    for (const conformanceCase of cases) {
      const name = `${conformanceCase.group}: ${conformanceCase.name}`;
      const run = () => conformanceCase.run(library.make());
      if (gaps[library.name]?.[conformanceCase.name] === undefined) {
        test(name, run);
      } else {
        test.failing(name, run);
      }
    }
  });
}
