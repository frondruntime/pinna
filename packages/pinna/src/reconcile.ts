/**
 * `reconcile` keeps row identity across a refetch: an item whose key and
 * value are unchanged is the previous instance, so a box of the result
 * notifies nobody and a row's component does not rerender.
 */

export interface ReconcileOptions<Item, Key> {
  /** The item's identity across fetches; a key repeated in `next` throws. */
  readonly keyOf: (item: Item) => Key;
  /**
   * Whether an item with the same key as a previous one, and not the same
   * instance, is unchanged. Required: a refetch builds new objects, so
   * identity alone would keep nothing.
   */
  readonly equals: (previous: Item, next: Item) => boolean;
}

/**
 * `next` in its own order, with the previous instance wherever an item's key
 * is unchanged and `equals` holds. Returns `previous` itself when nothing
 * changed. Throws when `next` repeats a key.
 */
export const reconcile = <Item, Key>(
  previous: ReadonlyArray<Item>,
  next: ReadonlyArray<Item>,
  options: ReconcileOptions<Item, Key>,
): ReadonlyArray<Item> => {
  const { keyOf, equals } = options;
  const byKey = new Map<Key, Item>();
  for (const item of previous) {
    byKey.set(keyOf(item), item);
  }
  const seen = new Set<Key>();
  const result: Array<Item> = [];
  let unchanged = previous.length === next.length;
  for (let index = 0; index < next.length; index++) {
    const item = next[index] as Item;
    const key = keyOf(item);
    if (seen.has(key)) {
      throw new Error(`pinna: reconcile: the key ${String(key)} appears twice`);
    }
    seen.add(key);
    const kept = byKey.get(key) as Item;
    const chosen = byKey.has(key) && (kept === item || equals(kept, item)) ? kept : item;
    if (chosen !== previous[index]) {
      unchanged = false;
    }
    result.push(chosen);
  }
  return unchanged ? previous : result;
};
