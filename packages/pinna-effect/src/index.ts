/**
 * Pinna on Effect Schema. Every name of `@frondruntime/pinna` is re-exported
 * as it is, so `Box.make`, `Collection.make`, and `Model` check nothing here either.
 * The names this package adds say they use a schema: `Box.schema`,
 * `Collection.schema`, `Model.Schema` with its `Model.boxField` and
 * `Model.collectionField`, and `Collection.reconcile`, whose `equals` defaults to the
 * schema's. `Model.decode` reads wire data into a realm, and `Model.restore`
 * reads it into a held instance; a `Model.context` field
 * holds a service the caller provides, as any Effect service is. The Effect
 * programs live for the caller's scope: `Program.watchScoped` and `Source.observeScoped`
 * next to the plain `Realm.watch` and `Source.observe`, `Program.changes`, `Program.updates`, `Program.fromStream`, and
 * `Program.whileObserved`; `Stage.scoped` holds a section's writes in a stage until it
 * succeeds, and fails with pinna's own `StageConflictError` on a conflict;
 * `View.orderedScoped`, `View.groupedScoped`, and `View.totalsScoped` make a
 * view that the scope disposes.
 */
export type {
  AutorunOptions,
  BoxChange,
  CollectionChange,
  CollectionOptions,
  Draft,
  Equals,
  GroupedView,
  GroupedViewOptions,
  GroupTotal,
  Inspection,
  ModelData,
  OrderedView,
  OrderedViewOptions,
  PinnaErrorByTag,
  PinnaErrorTag,
  PinnaUsageCode,
  Read,
  RealmOptions,
  RealmStatus,
  ReconcileOptions,
  RestoreData,
  RowChange,
  RowListener,
  Scheduler,
  Snapshot,
  StageInspection,
  StageOptions,
  StageStatus,
  TotalArithmetic,
  TotalsView,
  TotalsViewOptions,
  UpdateListener,
  UpdateOptions,
  UpdateRecipe,
  UpdateRecord,
  UpsertOptions,
  ValueOptions,
  ViewStatus,
  WatchOptions,
  Write,
} from "@frondruntime/pinna";
export {
  Atom,
  type AtomModule,
  Computed,
  type ComputedModule,
  isPinnaError,
  PinnaError,
  PinnaUsageError,
  StageClosedError,
  StageConflictError,
  ValueRejectedError,
} from "@frondruntime/pinna";
export { DecodeError, RealmService } from "./decode.ts";
export { Box, type BoxModule } from "./modules/box.ts";
export { Collection, type CollectionModule } from "./modules/collection.ts";
export { Model, type ModelModule } from "./modules/model.ts";
export { Program, type ProgramModule } from "./modules/program.ts";
export { Realm, type RealmModule } from "./modules/realm.ts";
export { Source, type SourceModule } from "./modules/source.ts";
export { Stage, type StageModule } from "./modules/stage.ts";
export { View, type ViewModule } from "./modules/view.ts";
export type { ScopedStageOptions } from "./stage.ts";
