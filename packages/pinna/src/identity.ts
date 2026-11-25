/**
 * Identity under Effect's Equal and Hash: the protocol keys, spelled out so
 * this package imports nothing from Effect, and a hash per object. Its own
 * module, with no import, so every class that defines the keys can be
 * evaluated whatever order its module loads in.
 */
/**
 * The keys of Effect's `Equal` and `Hash` protocols, spelled out so this
 * package imports nothing from Effect. An observable defines both, so
 * `Equal.equals` compares it by identity and never walks its fields; a test
 * in pinna-effect checks that Effect still uses these keys.
 */
export const equalKey = "~effect/Equal";
export const hashKey = "~effect/Hash";

/**
 * The key an Effect schema carries, spelled out for the same reason, so a
 * bare box can refuse a schema left over from a call meant for the Effect
 * entry's box.
 */
export const schemaKey = "~effect/Schema/Schema";

const identityHashes = new WeakMap<object, number>();

/** A random hash per object, kept for its life: what Effect's `Hash.random` gives. */
export const identityHash = (self: object): number => {
  let hash = identityHashes.get(self);
  if (hash === undefined) {
    hash = (Math.random() * 0x100000000) | 0;
    identityHashes.set(self, hash);
  }
  return hash;
};
