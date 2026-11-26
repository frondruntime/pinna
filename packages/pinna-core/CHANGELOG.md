# Changelog

## [0.2.0](https://github.com/frondruntime/pinna/compare/pinna-core-v0.1.0...pinna-core-v0.2.0) (2026-11-26)


### ⚠ BREAKING CHANGES

* the flat exports of 0.1 (`box`, `computed`, `update`, `schemaBox`, `watchScoped`, and the rest) are replaced by members of their type's module, and errors match by `_tag` or `code`, not by class or message.

### Features

* Pinna 0.2.0, every call on its type's module, and a rewritten core ([#8](https://github.com/frondruntime/pinna/issues/8)) ([3d88919](https://github.com/frondruntime/pinna/commit/3d8891932905534a85e18f5990f1a74ad4be93f3))

## [0.1.0](https://github.com/frondruntime/pinna/compare/pinna-core-v0.0.1...pinna-core-v0.1.0) (2026-11-21)


### Bug Fixes

* **core:** accumulate hook failures across settlement ([ce4cdf5](https://github.com/frondruntime/pinna/commit/ce4cdf56d29dd25bf036767c151048eebc6e0d43))
* **core:** begin a hook added twice only once ([3d727f4](https://github.com/frondruntime/pinna/commit/3d727f42afa952a9f90e64d031224352c0fda442))
* **core:** bound reentrant cached refreshes ([d7f690f](https://github.com/frondruntime/pinna/commit/d7f690fad6fd1dcbed264fb78a3a2bd968eb446b))
* **core:** index wide nested dependency reads ([6bfb31f](https://github.com/frondruntime/pinna/commit/6bfb31f5f913b45222018b71ea93073985f5d9ae))
* **core:** index wide nested reads in reruns that add no edge ([d671062](https://github.com/frondruntime/pinna/commit/d6710628920dda180a3983ccf99f4e39f0f5eca7))
* **core:** keep cached values across depth suspensions ([b864411](https://github.com/frondruntime/pinna/commit/b864411e1326af8a665cd279acbe23f2c82a39be))
* **core:** make every stale read wait once a compute caught a wait ([6251bb9](https://github.com/frondruntime/pinna/commit/6251bb93f2dde858082dfdf7d09850509f7f0d64))
* **core:** refresh walk results after intervening writes ([f31735a](https://github.com/frondruntime/pinna/commit/f31735a20c3f979215389f30646f40d55ea0652b))
* **core:** stamp a computed's kept error with the clock its run began at ([0a5c0fc](https://github.com/frondruntime/pinna/commit/0a5c0fcd5066048cf8d570d0915f3e00ac9dd109))
* **core:** stamp an error a cycle leaves mid-walk with the clock the walk began at ([5a97bf3](https://github.com/frondruntime/pinna/commit/5a97bf39a24f2446010e7c3a1c9eaf9bcada551d))
* **pinna:** let an unobserved collection rows forget the rows it returned ([76583d6](https://github.com/frondruntime/pinna/commit/76583d697055d1bc93e166306be76817e1840ed6))
* **pinna:** let an unobserved row(key) forget the row a write replaced ([a605a16](https://github.com/frondruntime/pinna/commit/a605a167d01c735a662bdb44e3a38dbd00b8889f))
* **pinna:** preserve update guards through untracked ([e6fb5e4](https://github.com/frondruntime/pinna/commit/e6fb5e4de1e33cb522bf8f3468befdf735227250))
