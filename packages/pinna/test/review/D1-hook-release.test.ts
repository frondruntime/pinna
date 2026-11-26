import { expect, test } from "bun:test";
import { Box, Realm, Source } from "../../src/index.ts";

test("releasing a removed hook twice preserves the new subscription", () => {
  const realm = Realm.make();
  const value = Box.make(realm, 0);
  const hold = Source.observe(value);
  const listeners = new Set<(next: number) => void>();
  const start = () => {
    const receive = (next: number) =>
      Realm.update(realm, (_read, write) => {
        write(value, next);
      });
    listeners.add(receive);
    return () => {
      listeners.delete(receive);
    };
  };
  const removeFirst = Source.onObserved(value, start);
  removeFirst();
  const removeSecond = Source.onObserved(value, start);
  try {
    for (const receive of listeners) receive(1);
    expect(Source.peek(value)).toBe(1);
    removeFirst();
    for (const receive of listeners) receive(2);
    expect(Source.peek(value)).toBe(2);
  } finally {
    removeSecond();
    hold();
    Realm.dispose(realm);
  }
});
