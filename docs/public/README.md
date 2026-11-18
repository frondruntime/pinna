# Public documentation

The pages `apps/site` publishes under `/docs`, one per file, at
`docs/public/<section>/<name>.md`. `bun run --cwd apps/site sync` copies them
into the site.

Every code example is a region of a sample under `apps/playground/src/docs/`,
named on a line of its own as `<!-- region <file>#<name> -->`, so
`bun run typecheck` compiles what the pages print. A region uses only names
declared in a region printed before it on the same page, in the file's
imports, or on a page the prose names, such as the `TodoList` that
`guides/testing.md` takes from `effect/collections.md`. A page whose samples
share declarations prints a `setup` region first. A sample uses one realm
made in module code, except a test, which makes its own.

A reference page has the sections Example, Rules, Answers, and See also, in
that order. Between Answers and See also it may add sections of its own,
each on one topic, such as `Transitions` on `react/hooks.md` or `Plain or
schema boxes` on `start/index.md`, and then a `With Effect` section, last,
for what `@frondruntime/pinna-effect` changes on that page. A page that
explains why, such as `start/principles.md`, argues one claim per section
instead and names what each decision costs. The sidebar order is
`apps/site/src/config/nav.json`.

The rest of `docs/` is how Pinna is built, not how to use it.
