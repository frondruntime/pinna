/** pinna's `Source` module, with `Source.observeScoped`. */
import { Source as PlainSource, type SourceModule as PlainSourceModule } from "@frondruntime/pinna";
import { observeScoped } from "../programs.ts";

export interface SourceModule extends PlainSourceModule {
  /** Keeps the observable observed for the length of the caller's scope. */
  readonly observeScoped: typeof observeScoped;
}

export const Source: SourceModule = { ...PlainSource, observeScoped };
