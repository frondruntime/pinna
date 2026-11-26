import { expect, test } from "bun:test";
import { distTagOf } from "./publish.ts";

test("a prerelease is published under next, a release under latest", () => {
  expect(distTagOf("0.2.0-rc.1")).toBe("next");
  expect(distTagOf("0.2.0")).toBe("latest");
  expect(distTagOf("0.2.0+build-1")).toBe("latest");
  expect(distTagOf("0.2.0-rc.1+build-1")).toBe("next");
});
