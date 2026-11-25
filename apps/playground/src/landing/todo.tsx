// The site's landing page prints the regions of this file (apps/site/src/pages/index.astro), so
// `bun run typecheck` compiles what the page shows. The hero draws the same todos as a frond
// (apps/site/src/components/FrondGraph.astro): keep their titles and the toggled one in step.
// It uses the package without Effect, as the graph does; the Effect section prints models on
// Effect Schema (`effect.ts`).
// #region todo
import { Box, Computed, Model, Realm } from "@frondruntime/pinna";
import { useValue } from "@frondruntime/pinna-react";
import { memo } from "react";
import { ListItem } from "./ui.tsx"; // the app's own list item: an <li> with a button

class Todo extends Model.Class {
  readonly $done = Box.make(this.realm, false); // a box: the square on each branch
  // A computed value: the diamond. It reads $done, so a line runs from the box to it.
  readonly $label = Computed.make(this.realm, (read) =>
    read(this.$done) ? `✓ ${this.title}` : this.title,
  );

  constructor(
    realm: Realm,
    readonly id: string,
    readonly title: string,
  ) {
    super(realm);
  }

  toggle(): void {
    Realm.update(this.realm, (read, write) => write(this.$done, !read(this.$done)));
  }
}

// The row reads $label, so it re-renders only when its own label changes.
const Row = memo(function Row({ todo }: { readonly todo: Todo }) {
  return <ListItem onPress={() => todo.toggle()}>{useValue(todo.$label)}</ListItem>;
});

const realm = Realm.make(); // the stem: the six todos of the graph live in it
const site = new Todo(realm, "2", "Ship the site");
site.toggle(); // the lit branch: its $label recomputes once, and one <Row> of six re-renders
// #endregion

const conformance = new Todo(realm, "4", "Run conformance");
const node = new Todo(realm, "6", "Bench on Node");
conformance.toggle();
node.toggle();
const todos = [
  new Todo(realm, "1", "Write the docs"),
  site,
  new Todo(realm, "3", "Measure Hermes"),
  conformance,
  new Todo(realm, "5", "Check the tarballs"),
  node,
];

export { Row, Todo, todos };
