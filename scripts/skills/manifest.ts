/**
 * The one hand-written source of `skills/`: for each skill its name, its
 * trigger description, the slices of the hub (`packages/pinna/AGENTS.md`)
 * it prints, the `docs/public` pages it carries, its neighbors, and the
 * prompts that must and must not load it. `build.ts` writes every file of
 * `skills/` from this list; a sentence a skill needs goes into the hub or a
 * page, never into this file.
 */

/** Hub text: a numbered rule, or a closing section by its heading. */
export type HubSlice =
  | {
      readonly rule: number;
      /** The bullets to print by their opening words; the rule's lead always prints. */
      readonly parts?: ReadonlyArray<string>;
      readonly omit?: ReadonlyArray<string>;
    }
  | {
      readonly section: string;
      /** The blocks to print by their opening words. */
      readonly parts?: ReadonlyArray<string>;
      readonly omit?: ReadonlyArray<string>;
    };

export interface Reference {
  /** The file's name under `references/`. */
  readonly file: string;
  /** The page, relative to `docs/public`. */
  readonly page: string;
  /** The `## ` sections to carry; the whole page when left out. */
  readonly sections?: ReadonlyArray<string>;
  /** When to open a part of a page; a whole page uses its own `description`. */
  readonly when?: string;
}

export interface Skill {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** One sentence: what the skill is for. */
  readonly claim: string;
  readonly hub: ReadonlyArray<HubSlice>;
  readonly references: ReadonlyArray<Reference>;
  readonly neighbors: ReadonlyArray<{ readonly skill: string; readonly when: string }>;
  /** The most lines the body of `SKILL.md` may have. */
  readonly budget: number;
  readonly prompts: {
    readonly loads: ReadonlyArray<string>;
    readonly skips: ReadonlyArray<{ readonly prompt: string; readonly expected: string }>;
  };
}

export const skills: ReadonlyArray<Skill> = [
  {
    name: "pinna-state",
    title: "Pinna state, collections, and watches",
    description:
      "Use when declaring, writing, or reacting to Pinna state (@frondruntime/pinna, not Pinia): a realm, Box.make, Computed.make, a Model, Realm.update, rows by key, views, Realm.watch, Realm.autorun. For components use pinna-react-components; for Effect use pinna-with-effect.",
    claim:
      "Declares the state an application starts from, writes it, keeps rows by key and the lists over them, and runs code when it changes.",
    hub: [
      { rule: 1 },
      { rule: 2 },
      { rule: 3 },
      { rule: 4 },
      { rule: 5 },
      {
        rule: 6,
        parts: [
          "Without Effect, it extends",
          "A method writes with",
          "A collection changes its key order",
          "A list of models is a",
          "A list sorted or filtered",
          "Any other value kept a row at a time",
          "A list written whole on each refetch",
        ],
      },
      { rule: 10 },
      { section: "In a component", parts: ["In a handler or an update, look a row up"] },
    ],
    references: [
      { file: "start.md", page: "start/index.md" },
      { file: "boxes.md", page: "state/boxes.md" },
      {
        file: "updates.md",
        page: "state/updates.md",
        sections: ["Example", "Rules", "Answers"],
        when: "Read when writing state. One update, drafts of arrays and objects, rollback on a throw.",
      },
      { file: "collections.md", page: "state/collections.md" },
      { file: "views.md", page: "state/views.md" },
      { file: "row-indexes.md", page: "guides/row-indexes.md" },
      { file: "reacting.md", page: "state/reacting.md" },
      {
        file: "effects-after-the-update.md",
        page: "state/updates.md",
        sections: ["Effects after the update"],
        when: "Read when an update must send a request, log, or touch the DOM: the effect goes in a watch after the update.",
      },
      { file: "principles.md", page: "start/principles.md" },
    ],
    neighbors: [
      { skill: "pinna-react-components", when: "a component that shows or changes the state" },
      {
        skill: "pinna-with-effect",
        when: "a value checked by Effect Schema, decoded from the wire, or run by an Effect program",
      },
      {
        skill: "pinna-stages-and-live-data",
        when: "writes that wait for asynchronous work, show optimistically, or come from a request or a socket",
      },
      {
        skill: "pinna-saving-and-history",
        when: "saving and restoring state, undo, redo, or a log of every write",
      },
    ],
    budget: 220,
    prompts: {
      loads: [
        "Add a `discount` field to the cart model and a total that includes it",
        "Set up Pinna in this app and make a counter",
        "This box holds an array; append an item",
        "Write the selected user and the selected tab together so nothing sees one without the other",
        "Cache the full name derived from first and last name on the profile model",
        "Keep 10,000 quotes by symbol and update one at a time",
        "Show the top 50 rows by volume, filtered by sector",
        "Count and total the orders per account",
        "Log to analytics whenever the selected tab changes",
        "Redraw the chart at most once a frame when prices change",
      ],
      skips: [
        {
          prompt: "Validate the price from the API before storing it",
          expected: "pinna-with-effect",
        },
        { prompt: "Add a Pinia store for the user", expected: "none" },
        { prompt: "Undo the last change to the drawing", expected: "pinna-saving-and-history" },
        { prompt: "Port this MobX store to Pinna", expected: "pinna-from-mobx" },
        {
          prompt: "Render each row without rerendering the list",
          expected: "pinna-react-components",
        },
        {
          prompt: "Open the socket only while the ticker is on screen",
          expected: "pinna-stages-and-live-data",
        },
      ],
    },
  },
  {
    name: "pinna-react-components",
    title: "Pinna in React components",
    description:
      "Use when a React component shows or changes Pinna state: useValue, useValues, useSelect, useRealm, RealmProvider, reads in event handlers, rerendering less. For the model behind the component use pinna-state; for component tests use pinna-testing-and-errors.",
    claim:
      "Shows state in React and changes it from handlers, through `@frondruntime/pinna-react`.",
    hub: [
      { rule: 9 },
      { section: "In a component", omit: ["In a handler or an update, look a row up"] },
      { section: "No lint rule for reads in render" },
    ],
    references: [{ file: "hooks.md", page: "react/hooks.md" }],
    neighbors: [
      {
        skill: "pinna-state",
        when: "the model behind the component; a value several components need is a `Computed.make` on it, and a row by key is `read.row`",
      },
      { skill: "pinna-testing-and-errors", when: "tests of the models a component reads" },
      { skill: "pinna-from-mobx", when: "a component wrapped in MobX's `observer`" },
      { skill: "pinna-stages-and-live-data", when: "data a screen fetches when it opens" },
    ],
    budget: 130,
    prompts: {
      loads: [
        "Show the cart total in the header component",
        "This list rerenders on every keystroke; fix it",
        "Read the current filter inside the click handler",
        "Make the realm for this screen and dispose it when the screen unmounts",
        "Use the realm from context in a nested component",
      ],
      skips: [
        {
          prompt: "Write a test for the cart component's model",
          expected: "pinna-testing-and-errors",
        },
        { prompt: "Convert this `observer` component", expected: "pinna-from-mobx" },
        { prompt: "Add a computed total to the cart", expected: "pinna-state" },
        {
          prompt: "Fetch the user when the profile screen opens",
          expected: "pinna-stages-and-live-data",
        },
        { prompt: "Style the header with CSS modules", expected: "none" },
      ],
    },
  },
  {
    name: "pinna-with-effect",
    title: "Pinna with Effect",
    description:
      "Use when Pinna meets Effect: state checked by Effect Schema or decoded from the wire (Box.schema, Model.Schema, Model.decode), or Effect programs on state (Program.*, Source.observeScoped, Realm.scoped, Stage.scoped). For plain state with no schema use pinna-state.",
    claim:
      "Declares state that a schema checks, decodes wire data into it, and runs Effect programs over state for the length of a scope, through `@frondruntime/pinna-effect`.",
    hub: [
      { rule: 4 },
      {
        rule: 6,
        parts: ["With Effect, it is a", "With Effect, a class with no", "A method writes with"],
      },
      { rule: 7, parts: ["A write meant to show before the work succeeds"] },
      { rule: 8, parts: ["A request's answer is"] },
      { rule: 9 },
      { rule: 12, parts: ["In Effect,"] },
    ],
    references: [
      { file: "boxes.md", page: "effect/boxes.md" },
      { file: "classes.md", page: "effect/classes.md" },
      { file: "collections.md", page: "effect/collections.md" },
      { file: "equality.md", page: "effect/equality.md" },
      {
        file: "programs.md",
        page: "effect/programs.md",
        sections: [
          "",
          "Example",
          "Rules",
          "Answers",
          "Lifetimes",
          "Failures as values",
          "See also",
        ],
        when: "Read when an Effect program watches, streams, or feeds Pinna state: the `Scoped` forms, lifetimes, and failures as values.",
      },
      {
        file: "programs-stages.md",
        page: "effect/programs.md",
        sections: ["Stages"],
        when: "Read when an Effect section holds its writes in a stage: `Stage.scoped`, a visible section, `{ guess }`, conflicts.",
      },
      {
        file: "live-data-with-effect.md",
        page: "guides/live-data.md",
        sections: ["With Effect"],
        when: "Read when a socket or a request is an Effect or a `Stream`: `Program.whileObserved`, `Program.fromStream`, `Program.fromEffect`.",
      },
    ],
    neighbors: [
      { skill: "pinna-state", when: "a plain box or model that checks nothing" },
      {
        skill: "pinna-stages-and-live-data",
        when: "the plain `Stage.make`, `Source.onObserved`, and `Computed.fromPromise` the `Scoped` forms stand for; load it with this one",
      },
      { skill: "pinna-saving-and-history", when: "`Model.restore` and restoring a saved shape" },
      {
        skill: "pinna-testing-and-errors",
        when: "tests of an Effect program, and a `ValueRejectedError` or `DecodeError` to trace",
      },
    ],
    budget: 190,
    prompts: {
      loads: [
        "Decode the `/todos` response into models",
        "Make the price box reject negative numbers",
        "Two decodes of the same order are not equal; why",
        "Run an Effect each time the selected account changes",
        "Feed this `Stream` of ticks into state while a screen reads it",
        "Tie the realm's lifetime to the layer's scope",
      ],
      skips: [
        { prompt: "Restore the saved models on load", expected: "pinna-saving-and-history" },
        { prompt: "Make a plain counter box", expected: "pinna-state" },
        { prompt: "Write an Effect HTTP client with retries", expected: "none" },
        { prompt: "Open the socket with plain callbacks", expected: "pinna-stages-and-live-data" },
        { prompt: "Build an Effect CLI that reads a file", expected: "none" },
      ],
    },
  },
  {
    name: "pinna-stages-and-live-data",
    title: "Pinna stages and state from outside",
    description:
      "Use when Pinna state comes from outside or waits on it: a request, socket, or query library (Computed.fromPromise, Source.onObserved, Realm.dispose), or writes held until async work succeeds or shown optimistically (Stage.make, Stage.apply, visible stages). For Effect streams use pinna-with-effect.",
    claim:
      "Brings state in from outside while something observes it, ends it with its realm, and holds the writes of asynchronous work until it succeeds or shows them at once.",
    hub: [{ rule: 7 }, { rule: 8 }, { rule: 9 }],
    references: [
      {
        file: "stages.md",
        page: "state/updates.md",
        sections: ["Stages"],
        when: "Read when writes of asynchronous work must not show early: making, updating, applying, and dropping a stage, child stages, conflicts.",
      },
      {
        file: "visible-stages.md",
        page: "state/updates.md",
        sections: ["Visible stages"],
        when: "Read when a write must show before the work succeeds: the two optimistic flows, pending markers, a guess that stops showing.",
      },
      { file: "lifecycles.md", page: "state/lifecycles.md" },
      {
        file: "live-data.md",
        page: "guides/live-data.md",
        sections: ["Example", "Rules", "See also"],
        when: "Read when a socket, a subscription, or a query library feeds state: starting on the first observer, stopping after the last.",
      },
      { file: "async-state.md", page: "guides/async-state.md" },
    ],
    neighbors: [
      {
        skill: "pinna-state",
        when: "a synchronous write, one `Realm.update`, or code that runs after a change",
      },
      {
        skill: "pinna-with-effect",
        when: "a feed that is an Effect or a `Stream`, and `Stage.scoped`",
      },
      { skill: "pinna-saving-and-history", when: "undo of writes that already landed" },
      { skill: "pinna-react-components", when: "making and disposing the realm in a component" },
    ],
    budget: 190,
    prompts: {
      loads: [
        "Show the renamed title at once and roll back if the save fails",
        "A wizard writes three boxes over two requests; none may show until the last succeeds",
        "Handle `StageConflictError` on apply",
        "Fetch the user when the profile screen opens and cancel when it closes",
        "Reconnect the WebSocket after a drop",
        "Copy a TanStack Query result into state",
        "Dispose the realm on logout",
      ],
      skips: [
        { prompt: "Undo the last edit", expected: "pinna-saving-and-history" },
        { prompt: "Write two boxes in one update", expected: "pinna-state" },
        { prompt: "Retry the failed request three times", expected: "none" },
        { prompt: "Run the feed as an Effect `Stream`", expected: "pinna-with-effect" },
        { prompt: "Build a server cache for the API", expected: "none" },
      ],
    },
  },
  {
    name: "pinna-saving-and-history",
    title: "Pinna snapshots, restore, and update records",
    description:
      "Use when Pinna state leaves as plain data or as records of writes: saving across a reload, hydrating, read.snapshot, write.restore, Model.restore, or undo, redo, replay, an update log, Realm.onUpdate, write.revert. For one value's side effect use pinna-state.",
    claim:
      "Takes declared state out as plain data and writes it back whole, and reads every landed update as a record for undo, redo, replay, and logs.",
    hub: [{ rule: 11 }, { rule: 12 }],
    references: [
      { file: "snapshots.md", page: "state/snapshots.md" },
      { file: "saving.md", page: "guides/saving.md" },
      { file: "changes.md", page: "state/changes.md" },
    ],
    neighbors: [
      {
        skill: "pinna-state",
        when: "the watch that runs a save, or code that runs when one value changes",
      },
      { skill: "pinna-with-effect", when: "decoding wire data into models, and `Program.updates`" },
      { skill: "pinna-stages-and-live-data", when: "rolling back a write that has not landed" },
    ],
    budget: 170,
    prompts: {
      loads: [
        "Keep the open tabs and the theme across a reload",
        "Hydrate state from the server-rendered JSON",
        "`pinna/restore-shape` on load; fix the restore",
        "Add undo and redo to the canvas",
        "Log every state change with the action's name",
        "Replay a recorded session into a fresh realm",
      ],
      skips: [
        { prompt: "Decode rows from the API", expected: "pinna-with-effect" },
        { prompt: "Refetch the list every minute", expected: "pinna-stages-and-live-data" },
        { prompt: "Set up IndexedDB with a migration", expected: "none" },
        { prompt: "Run code when one box changes", expected: "pinna-state" },
        { prompt: "Roll back an optimistic write", expected: "pinna-stages-and-live-data" },
      ],
    },
  },
  {
    name: "pinna-testing-and-errors",
    title: "Testing Pinna code and tracing its errors",
    description:
      "Use when testing code on Pinna or when Pinna throws: testRealm, record, held, retainedKeys from @frondruntime/pinna/testing, a PinnaError, a pinna/ code, ValueRejectedError, DecodeError, a message starting 'pinna: ', onError, Source.inspect. For new features use pinna-state.",
    claim:
      "Tests code on Pinna with a realm per test that reports what it left running, and traces a Pinna error from its message or code to its cause and fix.",
    hub: [{ section: "In a test" }, { section: "When it throws" }],
    references: [
      { file: "testing.md", page: "guides/testing.md" },
      {
        file: "testing-programs.md",
        page: "effect/programs.md",
        sections: ["Testing"],
        when: "Read when testing an Effect program on Pinna: the test realm in a scope, and what it reports left running.",
      },
      { file: "messages.md", page: "reference/errors.md" },
      { file: "errors.md", page: "guides/errors.md" },
    ],
    neighbors: [
      {
        skill: "pinna-state",
        when: "the reads and writes a test makes, and the fix for a read or write kept past its place",
      },
      { skill: "pinna-stages-and-live-data", when: "the fix for a stage message" },
      {
        skill: "pinna-saving-and-history",
        when: "the fix for a snapshot, restore, or record message",
      },
      { skill: "pinna-with-effect", when: "the program under test" },
    ],
    budget: 190,
    prompts: {
      loads: [
        "Write tests for the cart model",
        "The test passes alone and fails in the suite; state leaks",
        "Assert that a removed row is let go",
        '`pinna: read("count") runs outside a place`; what is wrong',
        "Catch a rejected value and show the field error",
        "What does `pinna/foreign-realm` mean",
      ],
      skips: [
        { prompt: "Add a `clear` method to the cart", expected: "pinna-state" },
        { prompt: "Test a plain React component with no state", expected: "none" },
        { prompt: "Set up Playwright for the checkout flow", expected: "none" },
        { prompt: "A React error boundary for the page", expected: "none" },
        {
          prompt: "Handle a conflict when the stage applies",
          expected: "pinna-stages-and-live-data",
        },
      ],
    },
  },
  {
    name: "pinna-from-mobx",
    title: "Moving from MobX to Pinna",
    description:
      "Use when moving code from MobX to Pinna, or when MobX habits appear in Pinna code: observer, makeAutoObservable, action, computed getters, reaction, flow. Gives the Pinna call for each MobX one. For new code with no MobX in it use pinna-state.",
    claim:
      "Gives the Pinna call for each MobX one, and names the MobX habits that do not carry over.",
    hub: [{ section: "MobX habits that do not carry over" }],
    references: [{ file: "mobx.md", page: "start/mobx.md" }],
    neighbors: [
      {
        skill: "pinna-state",
        when: "new code with no MobX in it, and `Realm.watch` and `Realm.autorun` in detail",
      },
      { skill: "pinna-react-components", when: "the hooks that replace `observer`" },
    ],
    budget: 90,
    prompts: {
      loads: [
        "Port this MobX store to Pinna",
        "What replaces `runInAction`",
        "This code assigns `store.x = 1`; why does it not type-check",
        "Replace `makeAutoObservable` in this class",
        "What is the Pinna form of a MobX `reaction`",
      ],
      skips: [
        { prompt: "Add a field to the Pinna cart model", expected: "pinna-state" },
        { prompt: "Port this Redux slice", expected: "pinna-state" },
        {
          prompt: "Replace `mobx-react` `observer` in a file with no Pinna import",
          expected: "none",
        },
        { prompt: "Upgrade MobX from 5 to 6", expected: "none" },
        { prompt: "Fix a rerender loop in a Pinna component", expected: "pinna-react-components" },
      ],
    },
  },
];
