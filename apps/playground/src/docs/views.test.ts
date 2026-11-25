/// <reference types="bun" />
// Backs the claims docs/public/state/views.md makes about the samples in `views.ts`.
import { expect, test } from "bun:test";
import { Realm, View } from "@frondruntime/pinna";
import {
  $aliceOrders,
  $aliceTotal,
  $byAmount,
  $customer,
  $largestFirst,
  $orders,
  $shown,
  $visible,
  realm,
  stopViews,
} from "./views.ts";

const read = <Value>(select: Parameters<typeof Realm.untracked<Value>>[1]) =>
  Realm.untracked(realm, select);

test("the views follow the orders, their boxes, and dispose", () => {
  Realm.update(realm, (_read, write) => {
    write.replaceAll(
      $orders,
      Array.from({ length: 100 }, (_, index) => ({
        id: `o${index}`,
        customer: index % 2 === 0 ? "alice" : "bob",
        cents: index * 100,
      })),
    );
  });
  expect(read((get) => get($visible))).toEqual(
    Array.from({ length: 20 }, (_, index) => `o${99 - 40 - index}`),
  );
  expect(read((get) => get($shown))).toBe("100 of 100 orders");
  Realm.update(realm, (_read, write) => {
    write($customer, "alice");
    write($largestFirst, false);
  });
  expect(read((get) => get($shown))).toBe("50 of 100 orders");
  expect(read((get) => get($byAmount.range(0, 2)))).toEqual(["o0", "o2"]);
  expect(read((get) => get($aliceOrders)).length).toBe(50);
  expect(read((get) => get($aliceTotal))).toEqual({
    count: 50,
    total: Array.from({ length: 50 }, (_, index) => index * 200).reduce((a, b) => a + b, 0),
  });
  stopViews();
  expect(View.status($byAmount)).toBe("disposed");
});
