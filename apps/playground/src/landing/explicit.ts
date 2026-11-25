// The site's landing page prints the regions of this file (apps/site/src/pages/index.astro), so
// `bun run typecheck` compiles what the page shows: one region per rule, its correct use first,
// then the mistakes it stops, a comment naming each. A `// ^^^ error TS…` line marks what
// `bun run typecheck` reports for the line above once its `@ts-expect-error` is removed; a
// `// ^^^ Error: pinna: …` line marks what the line above throws when it runs. The page
// underlines each span and labels it under the line.
import { Computed, type Read, Realm } from "@frondruntime/pinna";
import { Box } from "@frondruntime/pinna-effect";
import { Schema } from "effect";

const realm = Realm.make({ name: "app" });
const notify = (): void => {};
const save = async (): Promise<void> => {};

function reads() {
  // #region read
  const $price = Box.make(realm, 12);
  const $quantity = Box.make(realm, 3);

  // A computed value reads through read, and recomputes when either box changes.
  const $total = Computed.make(realm, (read) => read($price) * read($quantity)); // 36

  // A box used as its value
  // @ts-expect-error the landing page prints this error: a box is not a number
  const $broken = Computed.make(realm, () => $price * $quantity);
  //                                    ^^^^^^ error TS2362: The left-hand side of an arithmetic operation must be of type 'any', 'number', 'bigint' or an enum type.
  // @ts-expect-error the landing page prints this error: a computed value is not its value
  if ($total > 30) {
    //^^^^^^^^^^^ error TS2365: Operator '>' cannot be applied to types 'Computed<number>' and 'number'.
    notify();
  }
  // #endregion
  return $broken;
}

function writes() {
  // #region write
  const $count = Box.make(realm, 0);
  const $age = Box.schema(realm, Schema.Int, 30);

  // Only update hands out write; watchers see its writes together.
  Realm.update(realm, (read, write) => {
    write($count, read($count) + 1);
    write($age, 31);
  });

  // A value of the wrong type, and one its schema rejects
  Realm.update(realm, (_read, write) => {
    // @ts-expect-error the landing page prints this error: a schema box takes only its schema's type
    write($age, "thirty");
    //          ^^^^^^^^ error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
  });
  Realm.update(realm, (_read, write) => {
    write($age, 30.5);
    //          ^^^^ Error: pinna: the box rejects this value: Expected an integer
  });

  // An await inside an update
  // @ts-expect-error the landing page prints this error: an update recipe is synchronous
  Realm.update(realm, async (_read, write) => {
    //          ^^^^^^^^^^^^^^^^^^^^^^^^^ error TS2345: Argument of type '(_read: Read, write: Write) => Promise<void>' is not assignable to parameter of type '(read: Read, write: Write) => undefined'.
    //          ^^^^^ Error: pinna: Realm.update recipes are synchronous; await outside, then Realm.update
    await save();
    write($count, 2);
  });

  // An update that throws is undone
  try {
    Realm.update(realm, (_read, write) => {
      write($count, 5);
      throw new Error("stop");
    });
  } catch {}
  Realm.untracked(realm, (read) => read($count)); // 1: the write is undone
  // #endregion
}

// biome-ignore format: the mark under update sits left of where the formatter would indent a comment
function places() {
  // #region realm
  // Each test or request creates its own realm, and a box answers only to the one that made it.
  const app = Realm.make({ name: "app" });
  const quotes = Realm.make({ name: "quotes" });
  const $count = Box.make(app, 0);
  const $price = Box.make(quotes, 0);

  // An observable of another realm
  Realm.update(app, (_read, write) => {
    write($price, 1);
    //    ^^^^^^ Error: pinna: write($observable) is handed an observable of another realm (realm "quotes", not "app"). A realm's read and write take only what that realm made
  });

  // A read kept past its update
  let kept: Read | undefined;
  Realm.update(app, (read) => {
    kept = read;
  });
  setTimeout(() => kept?.($count));
  //               ^^^^^^^^^^^^^^ Error: pinna: read($observable) runs outside a place. In a component, use useValue($observable) or useSelect; in a handler, Realm.untracked; elsewhere, read inside Computed.make, Computed.fn, Realm.watch, Realm.autorun, or Realm.update of its own realm

  // An update inside a computed value
  const $double = Computed.make(app, (read) => {
    Realm.update(app, (_read, write) => {
  //^^^^^^ Error: pinna: Realm.update cannot run in a computed value; write from an event, a watch's effect, or an autorun
      write($count, 1);
    });
    return read($count) * 2;
  });
  Realm.untracked(app, (read) => read($double));
  // #endregion
}

export { places, reads, writes };
