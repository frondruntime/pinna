import { expect, test } from "bun:test";
import { Box, Realm, Source } from "../../src/index.ts";

test("a retired hook release leaves a later registration alone", () => {
  const realm = Realm.make();
  const source = Box.make(realm, 0);
  const releaseObserver = Source.observe(source);
  let listening = false;
  const start = () => {
    listening = true;
    return () => {
      listening = false;
    };
  };
  const releaseFirst = Source.onObserved(source, start);
  releaseFirst();
  const releaseSecond = Source.onObserved(source, start);
  expect(listening).toBe(true);
  releaseFirst();
  const stillListening = listening;
  releaseSecond();
  releaseObserver();
  Realm.dispose(realm);
  expect(stillListening).toBe(true);
});

for (const scheduled of [false, true]) {
  test(`a watch stopped by its comparator skips the effect (scheduled ${scheduled})`, () => {
    const realm = Realm.make();
    const source = Box.make(realm, 0);
    const seen: number[] = [];
    let stop = (): void => {};
    stop = Realm.watch(
      realm,
      (read) => read(source),
      (value) => {
        seen.push(value);
      },
      {
        equals: (previous, next) => {
          stop();
          return previous === next;
        },
        ...(scheduled
          ? {
              scheduler: (run: () => void) => {
                run();
              },
            }
          : {}),
      },
    );
    Realm.update(realm, (_, write) => {
      write(source, 1);
    });
    Realm.dispose(realm);
    expect(seen).toEqual([]);
  });
}
