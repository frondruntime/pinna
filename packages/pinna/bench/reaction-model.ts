/**
 * What `useValue` asks of a reaction on each render, without React: the
 * hook of 20f0bde ran the render's read with `track`, which relinks while
 * active; the hook since runs it with `trackPending` and links what it read
 * with `adopt` once React keeps the render. Each scenario renders every one
 * of a set of active reactions, each reading the same cells every time, the
 * way a row rerenders on a tick. `hermes-reaction.ts` runs it on Bun and on
 * Hermes.
 */
import { type CellNode, Graph, Reaction, readCell, writeCell } from "@frondruntime/pinna-core";
import type { Host, Measured } from "./graph-model.ts";

/** One render of `reaction`, reading with `read`, the way a hook does it. */
type Render = (reaction: Reaction, read: () => number) => number;

export const subjects = {
  track: (reaction, read) => reaction.track(read),
  "trackPending + adopt": (reaction, read) => {
    const value = reaction.trackPending(read);
    reaction.adopt();
    return value;
  },
} as const satisfies Record<string, Render>;

export type SubjectName = keyof typeof subjects;

const runs = 9;

const middle = (values: Array<number>): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] as number;
};

/** `reactions` active reactions, each reading its own `cells` cells. */
const scenario = (
  host: Host,
  render: Render,
  reactions: number,
  cells: number,
  passes: number,
): Measured => {
  const times: Array<number> = [];
  const bytes: Array<number> = [];
  for (let run = 0; run < runs; run++) {
    const graph = new Graph();
    let notified = 0;
    const rows = Array.from({ length: reactions }, () => {
      const read: Array<CellNode<number>> = Array.from({ length: cells }, () => graph.cell(1));
      const reaction = new Reaction(graph, () => {
        notified++;
      });
      const sum = (): number => {
        let total = 0;
        for (const cell of read) {
          total += readCell(cell);
        }
        return total;
      };
      render(reaction, sum);
      reaction.adopt();
      reaction.activate();
      return { reaction, sum, read };
    });
    host.collect();
    const allocatedBefore = host.allocated?.() ?? 0;
    const start = host.now();
    let total = 0;
    for (let pass = 0; pass < passes; pass++) {
      for (const row of rows) {
        total += render(row.reaction, row.sum);
      }
    }
    times.push(host.now() - start);
    bytes.push((host.allocated?.() ?? 0) - allocatedBefore);
    if (total !== reactions * cells * passes) {
      throw new Error(`bench: the renders read ${total}`);
    }
    // Every reaction still follows what it read.
    for (const row of rows) {
      const last = row.read[cells - 1];
      if (last !== undefined) {
        writeCell(last, 2);
      }
    }
    if (notified !== reactions) {
      throw new Error(`bench: ${notified} of ${reactions} reactions saw a write`);
    }
  }
  return {
    minimum: Math.min(...times),
    median: middle(times),
    ...(host.allocated === undefined ? {} : { bytes: middle(bytes) }),
  };
};

export const measure = (name: SubjectName, host: Host): Record<string, Measured> => {
  const render = subjects[name];
  return {
    "1000 reactions reading 1 cell, render ×100": scenario(host, render, 1000, 1, 100),
    "1000 reactions reading 10 cells, render ×100": scenario(host, render, 1000, 10, 100),
    "10000 reactions reading 1 cell, render ×10": scenario(host, render, 10_000, 1, 10),
  };
};
