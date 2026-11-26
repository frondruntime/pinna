# Changelog

## [0.2.0](https://github.com/frondruntime/pinna/compare/pinna-effect-v0.1.0...pinna-effect-v0.2.0) (2026-11-26)


### ⚠ BREAKING CHANGES

* the flat exports of 0.1 (`box`, `computed`, `update`, `schemaBox`, `watchScoped`, and the rest) are replaced by members of their type's module, and errors match by `_tag` or `code`, not by class or message.

### Features

* Pinna 0.2.0, every call on its type's module, and a rewritten core ([#8](https://github.com/frondruntime/pinna/issues/8)) ([3d88919](https://github.com/frondruntime/pinna/commit/3d8891932905534a85e18f5990f1a74ad4be93f3))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @frondruntime/pinna bumped to 0.2.0
    * @frondruntime/pinna-core bumped to 0.2.0
  * peerDependencies
    * @frondruntime/pinna bumped from 0.1.0 to 0.2.0

## [0.1.0](https://github.com/frondruntime/pinna/compare/pinna-effect-v0.0.1...pinna-effect-v0.1.0) (2026-11-21)


### ⚠ BREAKING CHANGES

* **pinna-effect:** watchScoped(select, effect) is watchScoped(realm, select, effect), and fromStream(stream, initial) is fromStream(realm, stream, initial); neither requires RealmService.

### Features

* **pinna-effect:** add withStage and StageConflict, and take the realm first in watchScoped and fromStream ([334b9c6](https://github.com/frondruntime/pinna/commit/334b9c6eadf2c8318067fbb84033246ac7b6b84c))
* **pinna-effect:** take the realm of changes from the observable, and re-export stages ([f34c631](https://github.com/frondruntime/pinna/commit/f34c6315d8e2793601797a7f28d54969af75c067))
* **pinna:** complete stages: reads and writes of everything, guarded recipes, child stages, conflicts ([83f51d9](https://github.com/frondruntime/pinna/commit/83f51d99487868f44976a382090aab60c0ad5429))
* **pinna:** name collections, and report what a stage wrote and read by name ([66ded55](https://github.com/frondruntime/pinna/commit/66ded553a6c8754d75f17962c187568815fc1d7e))


### Bug Fixes

* **effect:** await every released whileObserved run ([c04a7a1](https://github.com/frondruntime/pinna/commit/c04a7a1f00af6723aeb2e59bf88b8321ee1079b7))
* **effect:** build one decode schema per SchemaModel subclass ([dd63846](https://github.com/frondruntime/pinna/commit/dd63846daaff1bdfd4701410b64496f02d4fa70d))
* **effect:** catch synchronous throws from watch effects ([f56ccd2](https://github.com/frondruntime/pinna/commit/f56ccd2858e3cf101270d9ba73475572893d7a5b))
* **effect:** keep the element index in array rejection paths ([83b25e0](https://github.com/frondruntime/pinna/commit/83b25e0b27637d72ff66e01be2f9b8bc64b48001))
* **effect:** recheck array elements whose identity changed under Object.is ([38b9975](https://github.com/frondruntime/pinna/commit/38b997580e603cfb61de0eb118f8cfa72f4a1b07))
* **effect:** replace models from another realm in collections ([b3169d3](https://github.com/frondruntime/pinna/commit/b3169d32a448da7cd13b8befefbe2b1bef7ad5ce))
* **effect:** replace models that cannot merge across realms ([6aca81a](https://github.com/frondruntime/pinna/commit/6aca81ae82ff1a15adc2308e204846b621e6d149))
* **pinna-effect:** fail a CollectionField decode on an undefined row ([5fc0979](https://github.com/frondruntime/pinna/commit/5fc0979dfbe2dcfd2ff4282f89f83bc90bac58eb))
* **pinna-effect:** leave StageConflict out of a child withStage's error type ([3e49c80](https://github.com/frondruntime/pinna/commit/3e49c805c22cda1268262cbb35d15723d87754b6))
* **pinna-effect:** read both sides of a staged merge through the stage, and undo a caught merge failure ([53b6983](https://github.com/frondruntime/pinna/commit/53b6983a91c796276b6d68e03cb164b1b35b0b82))
* **pinna-effect:** refuse a conflicts option for a child withStage at the type level ([723595f](https://github.com/frondruntime/pinna/commit/723595febfce66b129325a935d7e485b90ab3707))
* **pinna:** follow main's update refusal and undefined rows through stages ([d7e6fe3](https://github.com/frondruntime/pinna/commit/d7e6fe330ab1e218e34eb45cff5e39c82a25767f))
* **pinna:** name a repeated key that has no string form ([9587188](https://github.com/frondruntime/pinna/commit/95871889056c6d3078edaa1b98082e84f0b0e4c7))
* **pinna:** prepare a root landing through its own read-only session ([4cf67b6](https://github.com/frondruntime/pinna/commit/4cf67b6a5ac1da71cbf4ae3573f0173bcb801545))
* **pinna:** reject undefined collection rows ([97aba23](https://github.com/frondruntime/pinna/commit/97aba23002630142cca585578829a1909f0a4c9b))
* **pinna:** replay a stage under the recipe guard and land its final values in one update ([997f80f](https://github.com/frondruntime/pinna/commit/997f80f6b7013e5be18034891d8e451ddd10777a))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @frondruntime/pinna bumped to 0.1.0
    * @frondruntime/pinna-core bumped to 0.1.0
  * peerDependencies
    * @frondruntime/pinna bumped from 0.0.1 to 0.1.0
