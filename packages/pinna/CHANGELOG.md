# Changelog

## [0.1.0](https://github.com/frondruntime/pinna/compare/pinna-v0.0.1...pinna-v0.1.0) (2026-11-21)


### Features

* **pinna:** add stages, writes that land whole or not at all ([f49aeba](https://github.com/frondruntime/pinna/commit/f49aeba7ca94585db6ca41f6e5915d309c436390))
* **pinna:** complete stages: reads and writes of everything, guarded recipes, child stages, conflicts ([83f51d9](https://github.com/frondruntime/pinna/commit/83f51d99487868f44976a382090aab60c0ad5429))
* **pinna:** name collections, and report what a stage wrote and read by name ([66ded55](https://github.com/frondruntime/pinna/commit/66ded553a6c8754d75f17962c187568815fc1d7e))
* **site:** remeasure the graph tables after the bench fairness fixes ([2a94ba3](https://github.com/frondruntime/pinna/commit/2a94ba3128b9b24b4836d55b2b5262f55d63d429))


### Bug Fixes

* **core:** accumulate hook failures across settlement ([ce4cdf5](https://github.com/frondruntime/pinna/commit/ce4cdf56d29dd25bf036767c151048eebc6e0d43))
* **core:** refresh walk results after intervening writes ([f31735a](https://github.com/frondruntime/pinna/commit/f31735a20c3f979215389f30646f40d55ea0652b))
* **core:** stamp a computed's kept error with the clock its run began at ([0a5c0fc](https://github.com/frondruntime/pinna/commit/0a5c0fcd5066048cf8d570d0915f3e00ac9dd109))
* **core:** stamp an error a cycle leaves mid-walk with the clock the walk began at ([5a97bf3](https://github.com/frondruntime/pinna/commit/5a97bf39a24f2446010e7c3a1c9eaf9bcada551d))
* **effect:** replace models from another realm in collections ([b3169d3](https://github.com/frondruntime/pinna/commit/b3169d32a448da7cd13b8befefbe2b1bef7ad5ce))
* **pinna-effect:** read both sides of a staged merge through the stage, and undo a caught merge failure ([53b6983](https://github.com/frondruntime/pinna/commit/53b6983a91c796276b6d68e03cb164b1b35b0b82))
* **pinna:** clean up leaked autoruns in test realms ([617d5d5](https://github.com/frondruntime/pinna/commit/617d5d5f27e7125fc0373833b7c1de5fd4c5553e))
* **pinna:** draft a box's value as a tree and throw on a written draft at two keys ([efc19a0](https://github.com/frondruntime/pinna/commit/efc19a0934715f069fc310ccf5380cf9dbd50dee))
* **pinna:** draft an object assigned at two keys once ([d931ddb](https://github.com/frondruntime/pinna/commit/d931ddba796a4c1c4dbec49656ba934076fa5dc5))
* **pinna:** draft assigned children and cache read children ([ff6bd59](https://github.com/frondruntime/pinna/commit/ff6bd59cf2ca3f9d25d26728c417f165efbc069c))
* **pinna:** finalize a draft at a symbol key of an assigned object ([44327ce](https://github.com/frondruntime/pinna/commit/44327cea15542a0753674af8ccd6e652375c0751))
* **pinna:** finalize drafts nested in assigned containers ([ab6f8ed](https://github.com/frondruntime/pinna/commit/ab6f8ed244251b5db058cc294e85170a8db5cd80))
* **pinna:** finalize drafts without mutating supplied containers ([d67a9c7](https://github.com/frondruntime/pinna/commit/d67a9c73a10696fcc75c12e08890a00e2d94faf1))
* **pinna:** follow a supplied container's copy from a back-reference that triggers it ([d6c9b00](https://github.com/frondruntime/pinna/commit/d6c9b00bc61f8429d32806183234a133253b6a2a))
* **pinna:** follow a supplied container's copy from a draft that finalized to it ([5dcc55d](https://github.com/frondruntime/pinna/commit/5dcc55dace89eca7a61c191b60d4f6d31ad13845))
* **pinna:** follow main's update refusal and undefined rows through stages ([d7e6fe3](https://github.com/frondruntime/pinna/commit/d7e6fe330ab1e218e34eb45cff5e39c82a25767f))
* **pinna:** give a draft's descriptors the child draft a read gives ([5054db6](https://github.com/frondruntime/pinna/commit/5054db6e703236f2cc998d199c61da9df31d1efb))
* **pinna:** give the cached child draft in a draft's property descriptor ([2c4f475](https://github.com/frondruntime/pinna/commit/2c4f475a6dd75b12bea8f5a051a7f5e4b7853649))
* **pinna:** hold stages to update semantics for caught throws, copied rows, equality, and guards ([432791c](https://github.com/frondruntime/pinna/commit/432791c66f91ad33f7a699848bb97c8723f6d2f4))
* **pinna:** keep a child stage's older read versions, and stage a replaceAll without a throwaway copy ([a4fd4ac](https://github.com/frondruntime/pinna/commit/a4fd4acd14739bd5ec41137cf5be27aa05038954))
* **pinna:** keep first reads, recipe lifetimes, and write-back identity through replay ([eceac14](https://github.com/frondruntime/pinna/commit/eceac14ca17d791336b890883e978929bd8de718))
* **pinna:** let an unobserved collection rows forget the rows it returned ([76583d6](https://github.com/frondruntime/pinna/commit/76583d697055d1bc93e166306be76817e1840ed6))
* **pinna:** let an unobserved row(key) forget the row a write replaced ([a605a16](https://github.com/frondruntime/pinna/commit/a605a167d01c735a662bdb44e3a38dbd00b8889f))
* **pinna:** let go of a leaving key's row and of rows a rollback discarded ([34bd89e](https://github.com/frondruntime/pinna/commit/34bd89ee27a42e31ede8040ee3dd987933f1498e))
* **pinna:** list what a stage read once per box or collection, not once per name ([4fc14bd](https://github.com/frondruntime/pinna/commit/4fc14bd4b8f52748aeb5ed0530de7a85bc8e052b))
* **pinna:** name a repeated key that has no string form ([9587188](https://github.com/frondruntime/pinna/commit/95871889056c6d3078edaa1b98082e84f0b0e4c7))
* **pinna:** prepare a root landing through its own read-only session ([4cf67b6](https://github.com/frondruntime/pinna/commit/4cf67b6a5ac1da71cbf4ae3573f0173bcb801545))
* **pinna:** preserve signed-zero and NaN identity ([fdb7f13](https://github.com/frondruntime/pinna/commit/fdb7f13a631f6c778c7859d5b48d73321cc1731b))
* **pinna:** preserve update guards through untracked ([e6fb5e4](https://github.com/frondruntime/pinna/commit/e6fb5e4de1e33cb522bf8f3468befdf735227250))
* **pinna:** reject undefined collection rows ([97aba23](https://github.com/frondruntime/pinna/commit/97aba23002630142cca585578829a1909f0a4c9b))
* **pinna:** remove listeners when registration settling fails ([575a306](https://github.com/frondruntime/pinna/commit/575a306839589920921e551be9a6cc69d58c903d))
* **pinna:** replay a stage under the recipe guard and land its final values in one update ([997f80f](https://github.com/frondruntime/pinna/commit/997f80f6b7013e5be18034891d8e451ddd10777a))
* **pinna:** throw on a written draft that a wrapper at two keys carries ([4dcfd0b](https://github.com/frondruntime/pinna/commit/4dcfd0bf685fe785a51a64e95842d128f44a48c3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @frondruntime/pinna-core bumped from 0.0.1 to 0.1.0
  * devDependencies
    * @frondruntime/pinna-core bumped to 0.1.0
