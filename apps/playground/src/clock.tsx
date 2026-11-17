import type { Computed, Realm } from "@frondruntime/pinna-effect";
import { atom, computed, onObserved, update } from "@frondruntime/pinna-effect";
import { useValue } from "@frondruntime/pinna-react";
import { useState } from "react";
import { Renders, useRenders } from "./renders.tsx";

/**
 * A clock built on Pinna's public API: the current time, in milliseconds
 * since the epoch, ticking every `interval` milliseconds while something
 * observes it. Pinna has no clock of its own; this is one way to make one.
 *
 * - The atom stands for time. `onObserved` starts the timer with the first
 *   observer and stops it with the last.
 * - An unobserved atom counts as changed on every read, so a read with the
 *   timer stopped still returns the current time.
 */
const makeClock = (realm: Realm, interval: number): Computed<number> => {
  const $tick = atom(realm);
  onObserved($tick, () => {
    const timer = setInterval(() => {
      update(realm, (_read, write) => {
        write.changed($tick);
      });
    }, interval);
    return () => {
      clearInterval(timer);
    };
  });
  return computed(realm, (read) => {
    read($tick);
    return Date.now();
  });
};

const Time = ({ $now }: { readonly $now: Computed<number> }) => {
  const renders = useRenders();
  const now = useValue($now);
  return (
    <p>
      {new Date(now).toLocaleTimeString()} <Renders count={renders} />
    </p>
  );
};

export const ClockExample = ({ realm }: { readonly realm: Realm }) => {
  const [$now] = useState(() => makeClock(realm, 1000));
  const [shown, setShown] = useState(true);
  return (
    <section>
      <h2>Clock · atom and onObserved</h2>
      <p className="muted">The timer runs only while the time is shown.</p>
      <button type="button" aria-pressed={shown} onClick={() => setShown(!shown)}>
        {shown ? "hide" : "show"}
      </button>
      {shown && <Time $now={$now} />}
    </section>
  );
};
