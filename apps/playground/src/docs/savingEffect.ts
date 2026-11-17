// The site's docs print the regions of this file (docs/public/guides/saving.md), so
// `bun run typecheck` compiles what the page shows.
import { Effect, Option, Schema } from "effect";

// #region restore
// A field the schema refuses decodes to no field at all, so it keeps its
// default and the other fields still restore.
const SavedSettings = Schema.fromJsonString(
  Schema.Struct({
    theme: Schema.optionalKey(
      Schema.Literals(["light", "dark"]).pipe(Schema.catchDecoding(() => Effect.succeedNone)),
    ),
    sidebarOpen: Schema.optionalKey(
      Schema.Boolean.pipe(Schema.catchDecoding(() => Effect.succeedNone)),
    ),
  }),
);

// Text that does not parse decodes to no fields, so the workspace keeps its defaults.
const readSaved = (text: string): typeof SavedSettings.Type =>
  Schema.decodeUnknownOption(SavedSettings)(text).pipe(Option.getOrElse(() => ({})));

// #endregion

export { readSaved };
