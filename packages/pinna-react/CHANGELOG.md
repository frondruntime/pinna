# Changelog

## [0.2.0](https://github.com/frondruntime/pinna/compare/pinna-react-v0.1.0...pinna-react-v0.2.0) (2026-11-26)


### ⚠ BREAKING CHANGES

* the flat exports of 0.1 (`box`, `computed`, `update`, `schemaBox`, `watchScoped`, and the rest) are replaced by members of their type's module, and errors match by `_tag` or `code`, not by class or message.

### Features

* Pinna 0.2.0, every call on its type's module, and a rewritten core ([#8](https://github.com/frondruntime/pinna/issues/8)) ([3d88919](https://github.com/frondruntime/pinna/commit/3d8891932905534a85e18f5990f1a74ad4be93f3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @frondruntime/pinna-core bumped from 0.1.0 to 0.2.0
  * devDependencies
    * @frondruntime/pinna bumped to 0.2.0
    * @frondruntime/pinna-core bumped to 0.2.0
    * @frondruntime/pinna-effect bumped to 0.2.0
  * peerDependencies
    * @frondruntime/pinna bumped from 0.1.0 to 0.2.0

## [0.1.0](https://github.com/frondruntime/pinna/compare/pinna-react-v0.0.1...pinna-react-v0.1.0) (2026-11-21)


### ⚠ BREAKING CHANGES

* **pinna-effect:** watchScoped(select, effect) is watchScoped(realm, select, effect), and fromStream(stream, initial) is fromStream(realm, stream, initial); neither requires RealmService.

### Features

* **pinna-effect:** add withStage and StageConflict, and take the realm first in watchScoped and fromStream ([334b9c6](https://github.com/frondruntime/pinna/commit/334b9c6eadf2c8318067fbb84033246ac7b6b84c))


### Bug Fixes

* **react:** own the useValues source list ([3160530](https://github.com/frondruntime/pinna/commit/31605309148f1bddeab723b105294241efd5cc45))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @frondruntime/pinna-core bumped from 0.0.1 to 0.1.0
  * devDependencies
    * @frondruntime/pinna bumped to 0.1.0
    * @frondruntime/pinna-core bumped to 0.1.0
    * @frondruntime/pinna-effect bumped to 0.1.0
  * peerDependencies
    * @frondruntime/pinna bumped from 0.0.1 to 0.1.0
