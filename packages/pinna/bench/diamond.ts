/**
 * The diamond: a → (b, c) → d, one unbatched write to `a`.
 *
 * Prints every value `d` computed after the write, for Pinna and for
 * Effect's Atom. A value that mixes the old `b` or `c` with the new one is a
 * glitch.
 */
import { Graph, readCell, readDerived, writeCell } from "@frondruntime/pinna-core";
import { Atom, AtomRegistry } from "effect/reactivity";

const pinna = (): ReadonlyArray<string> => {
  const graph = new Graph();
  const a = graph.cell(1);
  const b = graph.derived(() => readCell(a) * 2);
  const c = graph.derived(() => readCell(a) * 3);
  const seen: Array<string> = [];
  const d = graph.derived(() => {
    const value = `${readDerived(b)}+${readDerived(c)}`;
    seen.push(value);
    return value;
  });
  const stop = graph.watch(() => readDerived(d));
  seen.length = 0;
  writeCell(a, 2);
  stop();
  return seen;
};

const atom = (): ReadonlyArray<string> => {
  const registry = AtomRegistry.make();
  const a = Atom.make(1);
  const b = Atom.make((get) => get(a) * 2);
  const c = Atom.make((get) => get(a) * 3);
  const seen: Array<string> = [];
  const d = Atom.make((get) => {
    const value = `${get(b)}+${get(c)}`;
    seen.push(value);
    return value;
  });
  const stop = registry.subscribe(d, () => {}, { immediate: true });
  seen.length = 0;
  registry.set(a, 2);
  stop();
  return seen;
};

const report = (name: string, seen: ReadonlyArray<string>): void => {
  const glitches = seen.filter((value) => value !== "4+6");
  console.log(`${name}: d computed ${JSON.stringify(seen)}; glitches ${glitches.length}`);
};

report("pinna", pinna());
report("atom ", atom());
