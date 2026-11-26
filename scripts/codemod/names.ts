/**
 * The mapping the API rename follows, from each flat export to its module
 * member (ruling 62 of `docs/api.md`). The codemod reads this table and nothing
 * else, so a name is settled when it is here. `module` is the module object
 * the member lives on; `package` is the package whose export the old name
 * is, which a reference must resolve to before it is rewritten.
 */

export type Package = "@frondruntime/pinna" | "@frondruntime/pinna-effect";

/** A value export that becomes a member of a module object. */
export interface MemberRename {
  readonly kind: "member";
  readonly from: string;
  readonly module: string;
  readonly member: string;
  /** The packages that export `from`; pinna-effect re-exports pinna's names. */
  readonly packages: ReadonlyArray<Package>;
}

/** A type export that is renamed in place, staying top-level. */
export interface TypeRename {
  readonly kind: "type";
  readonly from: string;
  readonly to: string;
  readonly packages: ReadonlyArray<Package>;
}

/**
 * A module renamed in place, with its module type (`ProgramsModule` becomes
 * `ProgramModule`), for code already on the modules.
 */
export interface ModuleRename {
  readonly kind: "module";
  readonly from: string;
  readonly to: string;
  readonly packages: ReadonlyArray<Package>;
}

export type Rename = MemberRename | TypeRename | ModuleRename;

const both: ReadonlyArray<Package> = ["@frondruntime/pinna", "@frondruntime/pinna-effect"];
const effect: ReadonlyArray<Package> = ["@frondruntime/pinna-effect"];

const member = (
  from: string,
  module: string,
  name: string,
  packages: ReadonlyArray<Package> = both,
): MemberRename => ({ kind: "member", from, module, member: name, packages });

export const renames: ReadonlyArray<Rename> = [
  // Realm
  member("createRealm", "Realm", "make"),
  member("update", "Realm", "update"),
  member("untracked", "Realm", "untracked"),
  member("watch", "Realm", "watch"),
  member("autorun", "Realm", "autorun"),
  member("isTracking", "Realm", "isTracking"),
  member("disposeRealm", "Realm", "dispose"),
  member("realmStatus", "Realm", "status"),
  member("createRealmScoped", "Realm", "scoped", effect),
  // Values
  member("box", "Box", "make"),
  member("schemaBox", "Box", "schema", effect),
  member("atom", "Atom", "make"),
  member("computed", "Computed", "make"),
  // `fn` for the reserved word `function` (rule 5), as MobX's `computedFn`.
  member("computedFunction", "Computed", "fn"),
  // Collections
  member("collection", "Collection", "make"),
  member("schemaCollection", "Collection", "schema", effect),
  member("onRowChange", "Collection", "onRowChange"),
  // pinna-effect's `Collection.reconcile` is `reconcileSchema`, which hands a call
  // with `equals` to pinna's `reconcile` unchanged; pinna's requires `equals`, so a
  // call to either lands on the same behavior.
  member("reconcile", "Collection", "reconcile"),
  member("reconcileSchema", "Collection", "reconcile", effect),
  // Stages
  member("openStage", "Stage", "make"),
  member("stageUpdate", "Stage", "update"),
  member("stageRead", "Stage", "read"),
  member("realmRead", "Stage", "realmRead"),
  member("applyStage", "Stage", "apply"),
  member("dropStage", "Stage", "drop"),
  member("stageStatus", "Stage", "status"),
  member("inspectStage", "Stage", "inspect"),
  member("withStage", "Stage", "scoped", effect),
  // Models
  member("Model", "Model", "Class"),
  member("SchemaModel", "Model", "Schema", effect),
  member("BoxField", "Model", "boxField", effect),
  member("CollectionField", "Model", "collectionField", effect),
  member("FromContext", "Model", "context", effect),
  member("decode", "Model", "decode", effect),
  // Any observable
  member("observe", "Source", "observe"),
  member("onObserved", "Source", "onObserved"),
  member("inspect", "Source", "inspect"),
  member("observeScoped", "Source", "observeScoped", effect),
  // Effect programs: `Program`, named for what it holds, as Effect names its modules.
  member("changes", "Program", "changes", effect),
  // On `Program`, not `Realm`: on `Realm` it added 21 KB to every bundle (B2).
  member("watchScoped", "Program", "watchScoped", effect),
  member("fromStream", "Program", "fromStream", effect),
  member("whileObserved", "Program", "whileObserved", effect),
  { kind: "module", from: "Programs", to: "Program", packages: effect },
  // Types that stay top-level, with a prefix
  { kind: "type", from: "Options", to: "ValueOptions", packages: both },
  { kind: "type", from: "Recipe", to: "UpdateRecipe", packages: both },
];
