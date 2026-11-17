import type { FrameworkName } from "./frameworks.ts";

/**
 * What each library gets on reactive-framework-test-suite 0.2.0, the exact
 * version pinned. A case not listed passes. A listed case must still fail or
 * skip, so a gap that closes fails the suite until it is removed here.
 */
export interface Miss {
  readonly status: "fail" | "skip";
  readonly reason: string;
}

const noCleanup: Miss = {
  status: "skip",
  reason: "no effect cleanup: MobX's autorun ignores its return value",
};

/** The cases that need an effect cleanup, which MobX's autorun does not take. */
const cleanupCases = [
  38, 39, 40, 51, 89, 90, 110, 111, 120, 178, 222, 229, 230, 231, 233, 236, 237, 238, 243,
] as const;

const cleanup: Readonly<Record<number, Miss>> = Object.fromEntries(
  cleanupCases.map((id) => [id, noCleanup]),
);

/** MobX's own result, which Pinna passes. */
const mobxResult = (reason: string): Miss => ({ status: "fail", reason: `MobX: ${reason}` });

export const cases: Readonly<Record<FrameworkName, Readonly<Record<number, Miss>>>> = {
  pinna: {
    154: {
      status: "fail",
      reason:
        "expects a throwing batch to keep its writes; Pinna's update is atomic and rolls them back, the side #69 accepts",
    },
  },
  // Every case passes: an unlisted case passes.
  "alien-signals": {},
  mobx: {
    ...cleanup,
    7: mobxResult("an unchanged computed value still reaches its reader"),
    12: mobxResult("an inactive dependency still triggers"),
    13: mobxResult("an old branch's dependency still triggers"),
    18: mobxResult("a computed value read outside a reaction recomputes"),
    25: mobxResult("a computed value with no dependencies recomputes"),
    27: mobxResult("an unchanged computed value still re-evaluates its reader"),
    28: mobxResult("a same-value write still propagates"),
    34: mobxResult("pruning does not stop at the first unchanged node"),
    70: mobxResult("an autorun created in a transaction waits for its end"),
    76: mobxResult("an untracked read in a computed value is tracked"),
    95: mobxResult("a stale computed value is not evaluated before its dependents"),
    123: mobxResult("a write and its revert in one transaction rerun an autorun"),
    220: mobxResult("a computed value returning the same object still propagates"),
    235: mobxResult("a transaction inside an autorun body does not coalesce its writes"),
  },
};

/**
 * Probes report which of several valid designs a library takes. Each
 * library's answer is recorded; a change is a design change and fails the
 * suite. A probe that fails or skips is a `Miss`.
 */
export const probes: Readonly<Record<FrameworkName, Readonly<Record<number, string | Miss>>>> = {
  pinna: {
    15: "no subscription",
    17: "lazy",
    29: "Object.is",
    30: "skips",
    // The run that wrote reads a value the write changed, so it runs again.
    49: "runs twice per write",
    // An autorun that keeps changing what it read stops at the round limit,
    // and the error goes to onError, which the suite's realm drops.
    62: "no throw",
    86: "caches error",
    88: "unsubscribes",
    106: "continues",
    107: "caches error",
    // An update that writes a value and then writes the old one back leaves
    // the box at its old version, so nothing that read it recomputes.
    132: "skipped",
    146: "single recompute",
    147: "skipped",
    167: "Object.is",
    172: "throws",
    173: "post-write",
    174: "post-write",
    175: "batched",
    176: "returns void",
    187: "not evaluated",
    188: "skipped",
    193: "skipped",
    209: "no cascade",
    210: "accumulates",
    216: "creation order",
    // An autorun made inside another is not its child: stopping the outer
    // one leaves the inner ones running.
    241: "no cascade",
    244: "no cascade",
    246: "children survive",
    248: "skipped",
  },
  "alien-signals": {
    15: "no subscription",
    17: "lazy",
    29: "===",
    30: "skips",
    49: "runs once per write",
    62: "no throw",
    86: "returns stale",
    88: "keeps subscribed",
    106: "halts flush",
    107: "returns stale",
    132: "skipped",
    146: "single recompute",
    147: "skipped",
    167: "===",
    172: "re-evaluates",
    173: "post-write",
    174: "post-write",
    175: "unbatched",
    176: "returns void",
    187: "not evaluated",
    188: "skipped",
    193: "skipped",
    209: "cascades",
    210: "replaced",
    216: "creation order",
    241: "deepest first",
    244: "LIFO",
    246: "children survive",
    248: "skipped",
  },
  mobx: {
    15: "no subscription",
    17: "lazy",
    29: "===",
    30: "propagates",
    49: "runs twice per write",
    62: "no throw",
    86: "re-evaluates",
    88: "keeps subscribed",
    106: "continues",
    107: "re-evaluates",
    132: "recomputed",
    146: "single recompute",
    147: "recomputed",
    167: "===",
    172: "re-evaluates",
    173: "post-write",
    174: "post-write",
    175: "batched",
    176: "returns value",
    187: "not evaluated",
    188: "skipped",
    193: "skipped",
    209: "no cascade",
    210: "accumulates",
    216: "creation order",
    241: noCleanup,
    244: noCleanup,
    246: "children survive",
    248: "skipped",
  },
};
