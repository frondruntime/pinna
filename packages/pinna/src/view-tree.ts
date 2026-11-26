/** Persistent AVL trees. Each edit copies only the search path. */
export interface Tree<Entry> {
  readonly entry: Entry;
  readonly left: Tree<Entry> | undefined;
  readonly right: Tree<Entry> | undefined;
  readonly height: number;
  readonly size: number;
}

export type Compare<Entry> = (left: Entry, right: Entry) => number;
export const size = <Entry>(tree: Tree<Entry> | undefined): number => tree?.size ?? 0;
const height = <Entry>(tree: Tree<Entry> | undefined): number => tree?.height ?? 0;

const branch = <Entry>(entry: Entry, left?: Tree<Entry>, right?: Tree<Entry>): Tree<Entry> => ({
  entry,
  left,
  right,
  height: Math.max(height(left), height(right)) + 1,
  size: size(left) + size(right) + 1,
});

const balance = <Entry>(entry: Entry, left?: Tree<Entry>, right?: Tree<Entry>): Tree<Entry> => {
  if (height(left) > height(right) + 1) {
    const heavy = left as Tree<Entry>;
    if (height(heavy.left) >= height(heavy.right)) {
      return branch(heavy.entry, heavy.left, branch(entry, heavy.right, right));
    }
    const middle = heavy.right as Tree<Entry>;
    return branch(
      middle.entry,
      branch(heavy.entry, heavy.left, middle.left),
      branch(entry, middle.right, right),
    );
  }
  if (height(right) > height(left) + 1) {
    const heavy = right as Tree<Entry>;
    if (height(heavy.right) >= height(heavy.left)) {
      return branch(heavy.entry, branch(entry, left, heavy.left), heavy.right);
    }
    const middle = heavy.left as Tree<Entry>;
    return branch(
      middle.entry,
      branch(entry, left, middle.left),
      branch(heavy.entry, middle.right, heavy.right),
    );
  }
  return branch(entry, left, right);
};

export const insert = <Entry>(
  tree: Tree<Entry> | undefined,
  entry: Entry,
  compare: Compare<Entry>,
): Tree<Entry> => {
  if (tree === undefined) return branch(entry);
  return compare(entry, tree.entry) < 0
    ? balance(tree.entry, insert(tree.left, entry, compare), tree.right)
    : balance(tree.entry, tree.left, insert(tree.right, entry, compare));
};

export const remove = <Entry>(
  tree: Tree<Entry> | undefined,
  entry: Entry,
  compare: Compare<Entry>,
): Tree<Entry> | undefined => {
  if (tree === undefined) return undefined;
  const order = compare(entry, tree.entry);
  if (order < 0) return balance(tree.entry, remove(tree.left, entry, compare), tree.right);
  if (order > 0) return balance(tree.entry, tree.left, remove(tree.right, entry, compare));
  if (tree.left === undefined) return tree.right;
  if (tree.right === undefined) return tree.left;
  let successor = tree.right;
  while (successor.left !== undefined) successor = successor.left;
  return balance(successor.entry, tree.left, remove(tree.right, successor.entry, compare));
};

/** Linear construction from entries already in order. */
export const fromSorted = <Entry>(
  entries: ReadonlyArray<Entry>,
  start = 0,
  end = entries.length,
): Tree<Entry> | undefined => {
  if (start >= end) return undefined;
  const middle = Math.floor((start + end) / 2);
  return branch(
    entries[middle] as Entry,
    fromSorted(entries, start, middle),
    fromSorted(entries, middle + 1, end),
  );
};

/** Visits only the search paths and returned entries: O(log n + width). */
export const range = <Entry>(
  tree: Tree<Entry> | undefined,
  start: number,
  end: number,
  result: Array<Entry> = [],
): Array<Entry> => {
  if (tree === undefined || end <= 0 || start >= tree.size || start >= end) return result;
  const leftSize = size(tree.left);
  if (start < leftSize) range(tree.left, start, end, result);
  if (start <= leftSize && end > leftSize) result.push(tree.entry);
  if (end > leftSize + 1) range(tree.right, start - leftSize - 1, end - leftSize - 1, result);
  return result;
};

/** Every entry in order: O(n). */
export const entries = <Entry>(
  tree: Tree<Entry> | undefined,
  result: Array<Entry> = [],
): Array<Entry> => {
  if (tree === undefined) return result;
  entries(tree.left, result);
  result.push(tree.entry);
  entries(tree.right, result);
  return result;
};

/** Whether an entry `compare` finds equal to `entry` is in the tree: O(log n). */
export const has = <Entry>(
  tree: Tree<Entry> | undefined,
  entry: Entry,
  compare: Compare<Entry>,
): boolean => {
  let node = tree;
  while (node !== undefined) {
    const order = compare(entry, node.entry);
    if (order === 0) return true;
    node = order < 0 ? node.left : node.right;
  }
  return false;
};
