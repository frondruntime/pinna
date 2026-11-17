/**
 * The harness: asks the collector for a job, runs every scenario of one
 * variant on one list size, and posts the measures back. The collector
 * relaunches the app for every job, so no job sees another's heap.
 */
import { type ComponentType, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { alienVariant } from "../alien/variant.tsx";
import { legendVariant } from "../legend/variant.tsx";
import { mobxVariant } from "../mobx/variant.tsx";
import { pinnaVariant } from "../pinna/variant.tsx";
import { settled } from "./probe.ts";
import { heap, type Job, type Mount, runScenarios } from "./scenarios.ts";
import type { Variant } from "./store.ts";

const collector = "http://localhost:8799";

const variants: ReadonlyArray<Variant> = [pinnaVariant, mobxVariant, alienVariant, legendVariant];

interface Mounted {
  readonly key: number;
  readonly Screen: ComponentType;
}

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${collector}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export function App() {
  const [mounted, setMounted] = useState<Mounted | undefined>(undefined);
  const [status, setStatus] = useState("waiting for a job");

  useEffect(() => {
    let key = 0;
    const mount: Mount = async (variant) => {
      setMounted(undefined);
      await settled();
      const { store, Screen } = variant.make();
      key++;
      setMounted({ key, Screen });
      await settled();
      return store;
    };

    const run = async (): Promise<void> => {
      const job = (await (await fetch(`${collector}/job`)).json()) as Job | null;
      if (job === null) {
        setStatus("no job");
        return;
      }
      const variant = variants.find((candidate) => candidate.name === job.variant);
      if (variant === undefined) {
        throw new Error(`no variant ${job.variant}`);
      }
      setStatus(`${job.variant} ${job.size}`);
      const { measures, memory } = await runScenarios(
        variant,
        job.size,
        job.scenarios,
        mount,
        async () => {
          await post("/memory", { ...job, phase: "loaded", heap: heap() });
        },
      );
      setMounted(undefined);
      await post("/result", { ...job, measures, memory, heap: heap() });
      setStatus("done");
    };

    run().catch((error: unknown) => {
      setStatus(String(error));
      void post("/error", { message: String(error), stack: (error as Error).stack });
    });
  }, []);

  return (
    <View style={{ flex: 1, paddingTop: 60, backgroundColor: "#fff" }}>
      {mounted === undefined ? (
        <Text style={{ padding: 16 }}>{status}</Text>
      ) : (
        <mounted.Screen key={mounted.key} />
      )}
    </View>
  );
}
