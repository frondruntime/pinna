import { describe, expect, test } from "bun:test";
import { Box, Computed, type Read, Realm, Source } from "../src/index.ts";
import { expectRealmAtRest } from "./rest.ts";

/**
 * Wide reads through the public API: a value that reads hundreds of sources,
 * some more than once, keeps exactly the sources its last run read. The
 * public twin of `packages/pinna-core/test/reads.test.ts`. How many steps the
 * graph takes per read, its linear-cost budget, has no public probe and is
 * checked there.
 */

describe("wide nested reads", () => {
  test("a first read of computed-then-source pairs keeps one dependency per pair member", () => {
    const realm = Realm.make();
    const width = 512;
    const rows = Array.from({ length: width }, (_, index) => {
      const source = Box.make(realm, index, { name: `source ${index}` });
      return {
        source,
        derived: Computed.make(realm, (read) => 2 * read(source), { name: `double ${index}` }),
      };
    });
    const aggregate = Computed.make(realm, (read) => {
      let total = 0;
      for (const { source, derived } of rows) total += read(derived) + read(source);
      return total;
    });
    expect(Realm.untracked(realm, (read) => read(aggregate))).toBe((3 * width * (width - 1)) / 2);
    const dependencies = Source.inspect(aggregate).dependencies;
    expect(dependencies.length).toBe(2 * width);
    expect(dependencies.slice(0, 4)).toEqual(["double 0", "source 0", "double 1", "source 1"]);
    expectRealmAtRest(realm);
  });

  for (const kind of ["computed", "autorun"] as const) {
    for (const ending of ["stable", "drop", "throw"] as const) {
      test(`a ${kind} that reads each source twice keeps its sources after a ${ending} run`, () => {
        const reports: Array<unknown> = [];
        const realm = Realm.make({ onError: (error) => reports.push(error) });
        const width = 512;
        const rows = Array.from({ length: width }, (_, index) => {
          const source = Box.make(realm, index);
          return { source, derived: Computed.make(realm, (read) => 2 * read(source)) };
        });
        const count = Box.make(realm, width);
        const failing = Box.make(realm, false);
        const compute = (read: Read): number => {
          const length = read(count);
          const failure = read(failing);
          let total = 0;
          for (let index = 0; index < length; index++) {
            const row = rows[index] as (typeof rows)[number];
            total += read(row.source) + read(row.derived) + read(row.source);
          }
          if (failure) throw new Error("wide run failed");
          return total;
        };
        const aggregate = Computed.make(realm, compute);
        const stop = Realm.autorun(realm, (read) => {
          if (kind === "computed") read(aggregate);
          else compute(read);
          return undefined;
        });
        const length = ending === "drop" ? width / 2 : width;
        Realm.update(realm, (read, write) => {
          write(count, length);
          write(failing, ending === "throw");
          for (const row of rows) write(row.source, read(row.source) + 1);
        });

        expect(reports.map((error) => (error as Error).message)).toEqual(
          ending === "throw" ? ["wide run failed"] : [],
        );
        Realm.update(realm, (_read, write) => {
          write(failing, false);
        });
        if (kind === "computed") {
          expect(Realm.untracked(realm, (read) => read(aggregate))).toBe(2 * length * (length + 1));
        }
        for (let index = 0; index < width; index++) {
          const row = rows[index] as (typeof rows)[number];
          // Each kept source is observed by the reader and by its own double.
          expect(Source.inspect(row.source).observers).toBe(index < length ? 2 : 0);
        }
        stop();
        expectRealmAtRest(realm);
      });
    }
  }
});
