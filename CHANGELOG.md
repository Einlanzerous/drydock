# Changelog

## [1.7.0](https://github.com/Einlanzerous/drydock/compare/v1.6.0...v1.7.0) (2026-08-22)


### Features

* **daemon:** /healthz reports internal state, plus /readyz (DRY-48) ([c2e3ba5](https://github.com/Einlanzerous/drydock/commit/c2e3ba5614b8dbd37d34027245bc6c429edba1bf))
* **daemon:** /healthz reports internal state, plus /readyz (DRY-48) ([db2557a](https://github.com/Einlanzerous/drydock/commit/db2557a7a4081690905d669e27d240e7b631b26b))


### Bug Fixes

* **daemon:** `idle` counts the whole registry, not just running PTYs (DRY-48) ([c67e28a](https://github.com/Einlanzerous/drydock/commit/c67e28a901ead3042db4a603a5f4552b61007a59))
* **daemon:** a 404 only exempts the tracker on a call that carried a key (DRY-48) ([23da037](https://github.com/Einlanzerous/drydock/commit/23da0376c9ff9b24d8f3ae3aced9ac669b9b3a53))
* **daemon:** restore faults.record, and publish the measured table (DRY-48) ([ae5a889](https://github.com/Einlanzerous/drydock/commit/ae5a88975d290000aeb5a12366b0a35ca0076547))


### Documentation

* point the repo's inbound references at docs/decisions/ (DRY-95) ([76971ab](https://github.com/Einlanzerous/drydock/commit/76971ab26b34c55c1da3dea018fe84810c08378d))
* split CLAUDE.md into per-ticket decision docs (DRY-95) ([9fba0ef](https://github.com/Einlanzerous/drydock/commit/9fba0efcf8e4ef0b020c864cc3b3610f9698955b))
* split CLAUDE.md into per-ticket decision docs (DRY-95) ([6347024](https://github.com/Einlanzerous/drydock/commit/6347024197e8da8f89f0ade91a7d312d3b354d62))

## [1.6.0](https://github.com/Einlanzerous/drydock/compare/v1.5.0...v1.6.0) (2026-08-21)


### Features

* **ci:** publish OCI revision and source labels on the shell image (DRY-91) ([106a222](https://github.com/Einlanzerous/drydock/commit/106a22265ce18a6b3d448aff8e437fb6a725cbf8))
* **ci:** publish OCI revision and source labels on the shell image (DRY-91) ([54f4523](https://github.com/Einlanzerous/drydock/commit/54f452305f9a72ed890b81a8ca9b59e3c977cbec))
* **shell:** rework the desk chrome (DRY-82) ([5ce0905](https://github.com/Einlanzerous/drydock/commit/5ce0905f9f93a6454ad724f1f1035764f9feb169))
* **shell:** rework the desk chrome (DRY-82) ([275f184](https://github.com/Einlanzerous/drydock/commit/275f18440ef6e3f2b15d61b7933afb35c9f3abf6))


### Bug Fixes

* **deploy:** check the probe's body, not just its status (DRY-81) ([11c0f5e](https://github.com/Einlanzerous/drydock/commit/11c0f5eee7d57d1307c4877b4d627474e927f9a3))
* **deploy:** find the .env the way env.ts finds it (DRY-81) ([67446bd](https://github.com/Einlanzerous/drydock/commit/67446bd3717cd4be6baadf8886a7ae5a253453f2))
* **deploy:** give the restarted daemon 60s, and print the code it gave (DRY-81) ([268440a](https://github.com/Einlanzerous/drydock/commit/268440a7a676637ad6c76c3fae42632ed5591522))
* **deploy:** let a 401 count as a healthy daemon (DRY-81) ([580db3c](https://github.com/Einlanzerous/drydock/commit/580db3c8e09642f99beaeee0df751373b73028f0))
* **deploy:** let a 401 count as a healthy daemon (DRY-81) ([708c367](https://github.com/Einlanzerous/drydock/commit/708c36728e2696492f4e0fa746dd3ea32a1b68b7))
* **deploy:** match the .env key the way env.ts does (DRY-81) ([c481f26](https://github.com/Einlanzerous/drydock/commit/c481f26f3f7baffd2f74110bf1285787f881f349))
* **deploy:** read the .env like env.ts, and split the failure line (DRY-81) ([9d956e8](https://github.com/Einlanzerous/drydock/commit/9d956e8b492e8b01a5d165a20e86aca84d6d5090))
* **deploy:** take the first DRYDOCK_PORT, and send 5xx to the journal (DRY-81) ([76ef2b7](https://github.com/Einlanzerous/drydock/commit/76ef2b7ac4c31f00da46aec0a81fa597eef5d7c1))
* **shell:** close five review findings on the sidebar search (DRY-82) ([506342e](https://github.com/Einlanzerous/drydock/commit/506342e8b16dd7e5795645f6619cfb22b5d138f5))
* **shell:** close three more review findings on the palette and sidebar (DRY-82) ([ab6006b](https://github.com/Einlanzerous/drydock/commit/ab6006b08b845490bce3ceaafe3ba6ebf3d10490))
* **shell:** give the centred header real slack, and latch it (DRY-82) ([1c438b4](https://github.com/Einlanzerous/drydock/commit/1c438b48578f8f6c306f2325ed3b1cde2dbbd54d))
* **shell:** keep generic words out of the palette's terms (DRY-82) ([f494b1c](https://github.com/Einlanzerous/drydock/commit/f494b1c430780a9aa9519e64e0cb164e852528e0))
* **shell:** match a filter value by its stored spelling too (DRY-82) ([e1674b9](https://github.com/Einlanzerous/drydock/commit/e1674b916d28bf9886333975ef21f9d42ae7b49c))
* **shell:** stop the header painting its controls over the switcher (DRY-82) ([6a12a15](https://github.com/Einlanzerous/drydock/commit/6a12a15a919286fa5dcb2ce12142107df84fdd28))


### Documentation

* **ci:** correct the revision rationale's worked example (DRY-91) ([41be8c7](https://github.com/Einlanzerous/drydock/commit/41be8c7e91a1c5916d687594cfb5fed52c77aaa6))

## [1.5.0](https://github.com/Einlanzerous/drydock/compare/v1.4.0...v1.5.0) (2026-08-21)


### Features

* **daemon:** reap worktrees whose work is finished (DRY-90) ([2f95dc6](https://github.com/Einlanzerous/drydock/commit/2f95dc6368956a7d730b9dbcdf8ddc3c0d9bed88))
* **daemon:** reap worktrees whose work is finished (DRY-90) ([01b2075](https://github.com/Einlanzerous/drydock/commit/01b207519ed970bff181a0a6c93a3762819a9579))


### Bug Fixes

* **daemon:** close five review findings on the worktree reaper (DRY-90) ([4cff530](https://github.com/Einlanzerous/drydock/commit/4cff5304f40ae7aef073e183efbdaa505099b844))
* **daemon:** correct the harness count and say what the floor covers (DRY-88) ([84cad17](https://github.com/Einlanzerous/drydock/commit/84cad17bb50cb07a68d606f93bd2247fb03ceb77))
* **daemon:** let the daemon type a supervised spawn's prompt (DRY-88) ([7458065](https://github.com/Einlanzerous/drydock/commit/745806544b6cfeac6fd6637c45b083c89520a5fb))
* **daemon:** let the daemon type a supervised spawn's prompt (DRY-88) ([f84f8aa](https://github.com/Einlanzerous/drydock/commit/f84f8aaf3af69cdc93471a9966491f3033d2fe3e))
* **deploy:** close the review findings on the deploy renderer (DRY-87) ([4ca4a36](https://github.com/Einlanzerous/drydock/commit/4ca4a36dc65ff0cba9f2c31dae7afda60c6fdf53))
* **deploy:** keep live agents alive across a prod restart (DRY-87) ([42af4ab](https://github.com/Einlanzerous/drydock/commit/42af4ab87f7b1bedc2d718a84fb19a1ecd727092))
* **deploy:** keep live agents alive across a prod restart (DRY-87) ([ccce78d](https://github.com/Einlanzerous/drydock/commit/ccce78d96c2c229c98ae605bdf8b80525e5a4fc9))

## [1.4.0](https://github.com/Einlanzerous/drydock/compare/v1.3.0...v1.4.0) (2026-08-20)


### Features

* **daemon:** forward body.env to a spawn, with a guard (DRY-66) ([a5db98e](https://github.com/Einlanzerous/drydock/commit/a5db98ec41545e2b08a6f292812d2d9bcc4611dd))
* **daemon:** forward body.env to a spawn, with a guard (DRY-66) ([3d5b8b3](https://github.com/Einlanzerous/drydock/commit/3d5b8b35af8ebaf18b132af7e32849bf7af8738e))


### Bug Fixes

* **daemon:** address review on the spawn replay (DRY-79) ([10502e9](https://github.com/Einlanzerous/drydock/commit/10502e94a3289206901f71b45b6f81d8febe1d7e))
* **daemon:** close four deny-set gaps review found in the spawn env (DRY-66) ([7071a5b](https://github.com/Einlanzerous/drydock/commit/7071a5bbfc8c36c97ccac504e75b79eb44f5967e))
* **daemon:** take the supervisor's replay on the spawn path too (DRY-79) ([105db22](https://github.com/Einlanzerous/drydock/commit/105db22d0d861d217ddaa24ee3584b9305055e7b))
* **daemon:** take the supervisor's replay on the spawn path too (DRY-79) ([3bfcc5f](https://github.com/Einlanzerous/drydock/commit/3bfcc5f1fa84efe9a80adbe705d17ce592416b12))

## [1.3.0](https://github.com/Einlanzerous/drydock/compare/v1.2.0...v1.3.0) (2026-08-13)


### Features

* **daemon:** put session exits on the event stream (DRY-64) ([7a3957c](https://github.com/Einlanzerous/drydock/commit/7a3957c902fc37e38a1917536d0c318ee7ed8985))
* **daemon:** put session exits on the event stream (DRY-64) ([9806efe](https://github.com/Einlanzerous/drydock/commit/9806efe5ddbf43633ce3de799cc1a04f47653118))


### Bug Fixes

* **daemon:** carry endReason on session-exit, and correct what it promises (DRY-64) ([d7ee3c4](https://github.com/Einlanzerous/drydock/commit/d7ee3c4042852403303c64d1b78fa016b80db978))
* **scripts:** address review of the TypeScript conversion (DRY-80) ([186ea82](https://github.com/Einlanzerous/drydock/commit/186ea826b42700092e90bb9b118b01c65f9aec98))
* **scripts:** fold in main, and make the gate report both halves (DRY-80) ([0a6dec2](https://github.com/Einlanzerous/drydock/commit/0a6dec24f9fa3dbdca5a1c26d37866dd0a0d944f))
* **shell:** address review on the clipboard chords (DRY-71) ([a7d214a](https://github.com/Einlanzerous/drydock/commit/a7d214a568833a67f4c1234990a88aed204701d3))
* **shell:** copy from a terminal pane with Ctrl+Shift+C (DRY-71) ([f5c22aa](https://github.com/Einlanzerous/drydock/commit/f5c22aa3da563dac4b0b0558104af86771b182cb))
* **shell:** copy from a terminal pane with Ctrl+Shift+C (DRY-71) ([584bcd4](https://github.com/Einlanzerous/drydock/commit/584bcd480437051e2eddbe1d7c72c29af0ef70e1))
* **shell:** draw the real mark in the tab, not just the hull (DRY-86) ([17ec3fe](https://github.com/Einlanzerous/drydock/commit/17ec3feb59a5dbd1cf4734aaadebca034809555b))
* **shell:** put the favicon's plate back and drop its media query (DRY-86) ([7e91b8c](https://github.com/Einlanzerous/drydock/commit/7e91b8c1728c027a8ed3e0b63b88aefa78d1d867))
* **shell:** redraw the favicon at the size it is used (DRY-86) ([f0d8760](https://github.com/Einlanzerous/drydock/commit/f0d87604d3ea2bccd216a940669155cc8b45b4a1))
* **shell:** redraw the favicon at the size it is used (DRY-86) ([12518de](https://github.com/Einlanzerous/drydock/commit/12518de771a568899f886c1cc4b17a7ca504fbca))
* **shell:** stop the backlog control dimming on a poll nobody asked for (DRY-85) ([9df7e35](https://github.com/Einlanzerous/drydock/commit/9df7e3598dd249c00027c004cedc0d0c01bf6112))
* **shell:** stop the backlog control dimming on a poll nobody asked for (DRY-85) ([4693e1e](https://github.com/Einlanzerous/drydock/commit/4693e1ee2a54ee12250e60cbbfc5b848ea4e9dea))


### Documentation

* **scripts:** move the harness docs onto the .mts invocations (DRY-80) ([501f704](https://github.com/Einlanzerous/drydock/commit/501f7047421f23464daffab693fa18b94426b0fd))
* **shell:** record that the inspect-element accelerator is preventable (DRY-71) ([fbae626](https://github.com/Einlanzerous/drydock/commit/fbae626b2b63626aa53eae7eb9059ef9599944f8))


### Refactoring

* **scripts:** convert the remaining .mjs harnesses to TypeScript (DRY-80) ([d9b1857](https://github.com/Einlanzerous/drydock/commit/d9b185758000aa99c09ac1cd5e9d6a8cab004ecc))
* **scripts:** convert the remaining .mjs harnesses to TypeScript, and typecheck them (DRY-80) ([31b042b](https://github.com/Einlanzerous/drydock/commit/31b042ba362ae789eb14c6378981dc136aba956c))

## [1.2.0](https://github.com/Einlanzerous/drydock/compare/v1.1.0...v1.2.0) (2026-08-12)


### Features

* **shell:** expand an epic to its children, not to what the pull included (DRY-83) ([8b79ceb](https://github.com/Einlanzerous/drydock/commit/8b79cebeef39e19df705c929b17adf8fb39a0ed0))
* **shell:** expand an epic to its children, not to what the pull included (DRY-83) ([849fe44](https://github.com/Einlanzerous/drydock/commit/849fe44072296e646124a0abff2157723909a5c1))


### Bug Fixes

* **shell:** route on-demand epic children through the grouping (DRY-83) ([f6ad1a2](https://github.com/Einlanzerous/drydock/commit/f6ad1a2aed155c9b5060f61d71e9473eda66d6d8))

## [1.1.0](https://github.com/Einlanzerous/drydock/compare/v1.0.0...v1.1.0) (2026-08-04)


### Features

* **daemon:** a door on the daemon, and accounts behind it (DRY-27) ([f5cdd42](https://github.com/Einlanzerous/drydock/commit/f5cdd42916e216b877bf0176dd18f982f2dbd8fd))
* **daemon:** a door on the daemon, and accounts behind it (DRY-27) ([f1c847f](https://github.com/Einlanzerous/drydock/commit/f1c847f0e9412f644a25e1c50331268a8d1dee38))
* **daemon:** brief spawned agents from the comment thread and epic (DRY-53) ([fb60612](https://github.com/Einlanzerous/drydock/commit/fb606121d76caa0f58f7b6d59fd810c081e0d053))
* **shell:** clear finished sessions from the desk (DRY-60) ([5cec804](https://github.com/Einlanzerous/drydock/commit/5cec804fcb6d85bf7e68b2c5d1510aa30da38804))
* **shell:** clear finished sessions from the desk (DRY-60) ([8fcd61a](https://github.com/Einlanzerous/drydock/commit/8fcd61adcae1d8a2609e93252a83a751a3e7aa72))


### Bug Fixes

* **daemon:** add the IDE marker, tolerate malformed session env (DRY-59 review) ([ade231d](https://github.com/Einlanzerous/drydock/commit/ade231d783166b00435c62c8e07e9d8c81213cba))
* **daemon:** cache and coalesce the sidebar's tracker pull (DRY-72) ([e9fae36](https://github.com/Einlanzerous/drydock/commit/e9fae361c5150782d83122d2e639da7799d044b0))
* **daemon:** cache and coalesce the sidebar's tracker pull (DRY-72) ([d411d43](https://github.com/Einlanzerous/drydock/commit/d411d43edb5465d9c9c2e09e76b9652648d4aaa1))
* **daemon:** close the review findings on the tracker cache (DRY-72) ([bf324e6](https://github.com/Einlanzerous/drydock/commit/bf324e6a0a2528b27242ae7d07e245ccd6498791))
* **daemon:** close the review's holes in the new auth surface (DRY-27) ([eabde0e](https://github.com/Einlanzerous/drydock/commit/eabde0ed113757556a590c823391ae2f8de3fab2))
* **daemon:** harden the ticket brief against its own inputs (DRY-53) ([383ed25](https://github.com/Einlanzerous/drydock/commit/383ed254657405eaa88368f6b6a694613c56071f))
* **daemon:** stop spawned agents inheriting the daemon's claude session markers (DRY-59) ([5e8ae01](https://github.com/Einlanzerous/drydock/commit/5e8ae01197f4ed60c31a4a028c9a501ecc2edd0e))
* **daemon:** stop spawned agents inheriting the daemon's claude session markers (DRY-59) ([d77a445](https://github.com/Einlanzerous/drydock/commit/d77a4450ae198d2829cddc865bcbd9ed01661d17))
* **shell:** budget the ticket pull and stop the outage copy guessing (DRY-55 review) ([55c3393](https://github.com/Einlanzerous/drydock/commit/55c3393e3e62a634a835b14665e00a39f1068f03))
* **shell:** close the review findings on the gate's action row (DRY-78) ([01403c5](https://github.com/Einlanzerous/drydock/commit/01403c5753370529797e3c9f697352adb7156645))
* **shell:** correct the epic row's expand predicate and toggle (DRY-75) ([7167766](https://github.com/Einlanzerous/drydock/commit/7167766bcbdf7e9409ffa5fe3c50f59923c932d7))
* **shell:** don't offer to resume a conversation that was never written (DRY-62) ([1aa1155](https://github.com/Einlanzerous/drydock/commit/1aa11551c652615e007017abc6c739489181c59f))
* **shell:** don't offer to resume a conversation that was never written (DRY-62) ([4a51788](https://github.com/Einlanzerous/drydock/commit/4a51788085dc6193b866e194d6efb1d0bf5f8f4b))
* **shell:** expand an epic on row click, launch from its own icon (DRY-75) ([8a068fd](https://github.com/Einlanzerous/drydock/commit/8a068fdb044894b686b2b34e824be784783da55b))
* **shell:** expand an epic on row click, launch from its own icon (DRY-75) ([149ac83](https://github.com/Einlanzerous/drydock/commit/149ac83159aee98c4579cf18b679e5ec3b7a0a18))
* **shell:** give the countdown the card's second row, not more width (DRY-60) ([8245bc5](https://github.com/Einlanzerous/drydock/commit/8245bc503d7708f144e66e4099f4ce64a7000496))
* **shell:** handle what the panel's new scroll container brings with it (DRY-74) ([358f450](https://github.com/Einlanzerous/drydock/commit/358f450a7588b3fd4cfe4f7850f3fad782c0052e))
* **shell:** keep the permission gate's answers inside its panel (DRY-78) ([f28394b](https://github.com/Einlanzerous/drydock/commit/f28394bcb534cc3c429b38e802c36237d6174321))
* **shell:** keep the permission gate's answers inside its panel (DRY-78) ([3c2c684](https://github.com/Einlanzerous/drydock/commit/3c2c6846001dffad6406d04a49201050af83ef35))
* **shell:** let the rail's chooser be dismissed, and stop the deny flow offering approval (DRY-73) ([6ae3512](https://github.com/Einlanzerous/drydock/commit/6ae3512bc7bb05fef65864cde1df3228cda0cb8e))
* **shell:** let the rail's chooser be dismissed, and stop the deny flow offering approval (DRY-73) ([6eaa54e](https://github.com/Einlanzerous/drydock/commit/6eaa54e84142af8b25d3951be22bafe8d7723e55))
* **shell:** make the sweep's countdown survive a crowded desk (DRY-60) ([3078abd](https://github.com/Einlanzerous/drydock/commit/3078abd5b036604e29149a9392575f2e7bba9344))
* **shell:** say when the tracker is unreachable instead of "No tickets match." (DRY-55) ([c760181](https://github.com/Einlanzerous/drydock/commit/c76018166cf2a96af2ff718da12c8e5393d10681))
* **shell:** say when the tracker is unreachable instead of "No tickets match." (DRY-55) ([3d9e36b](https://github.com/Einlanzerous/drydock/commit/3d9e36b7dd703d82b5ef38d7d1a4da2ebdd55b1b))
* **shell:** stop the spawn panel's action row overflowing (DRY-74) ([7e00dd7](https://github.com/Einlanzerous/drydock/commit/7e00dd7d14d9e08a059427d0524d198f33e587b7))
* **shell:** stop the spawn panel's action row overflowing (DRY-74) ([24c0efb](https://github.com/Einlanzerous/drydock/commit/24c0efbe2e0340030284c8b41f493ff5c7ea1159))


### Documentation

* note that the compile gate is required on main (DRY-52) ([9ad53fc](https://github.com/Einlanzerous/drydock/commit/9ad53fc095b54a8ab64edf7f2bb642e8ff7b9e12))

## 1.0.0 (2026-07-28)


### ⚠ BREAKING CHANGES

* **daemon:** DRYDOCK_EXIT_ON_UNCAUGHT now defaults to on, so an uncaught exception exits the daemon instead of leaving it wedged and serving. Live sessions survive either way — that is the point of this change — and prod's systemd unit restarts and reattaches to them. Set DRYDOCK_EXIT_ON_UNCAUGHT=0 to keep the previous behaviour.

### Features

* autonomous agent mode — a run that surfaces itself only when it needs you (DRY-49) ([d259d3b](https://github.com/Einlanzerous/drydock/commit/d259d3be20431b7cda893afef1f9f8f736765ad5))
* **daemon:** autonomous runs — a session that ends honestly (DRY-49) ([ef3b778](https://github.com/Einlanzerous/drydock/commit/ef3b778538d82c7477ca5901f9ad31829923bf97))
* **daemon:** daemon-owned workspace state, file or Postgres (DRY-28) ([1fceb54](https://github.com/Einlanzerous/drydock/commit/1fceb54803bebfacc8b8304ef4f9661eb6216408))
* **daemon:** let a session outlive the daemon that spawned it (DRY-57) ([4a6953b](https://github.com/Einlanzerous/drydock/commit/4a6953b0f98ce0d92164f2a213cc296fc94ec016))
* **daemon:** let a session outlive the daemon that spawned it (DRY-57) ([06a6a92](https://github.com/Einlanzerous/drydock/commit/06a6a9229d6ae941efdb69596c662c5f194a2f5b))
* **daemon:** pull epics past the backlog cut and roll up real child counts (DRY-13) ([24c477d](https://github.com/Einlanzerous/drydock/commit/24c477dd901ce5028cc4ae66035e431dbf18049d))
* **daemon:** record what ran, so a dead session leaves a trace (DRY-56) ([f4a34f8](https://github.com/Einlanzerous/drydock/commit/f4a34f8504438b69f83175a8dfe56c2262d69bdf))
* **daemon:** tell a down store from a cooling one (DRY-58) ([229473d](https://github.com/Einlanzerous/drydock/commit/229473dab7962aa1aa933fe6f0a0950de402bac4))
* give permission gates a lifetime beyond the terminal pane (DRY-50) ([ef6bafa](https://github.com/Einlanzerous/drydock/commit/ef6bafa4c3bc9d439c47bb57e07449f7370a6d71))
* make an autonomous run's permission posture host policy (DRY-49) ([084d626](https://github.com/Einlanzerous/drydock/commit/084d6269c94324e6b80f538a47c8d5e4454a5b62))
* resumable session tombstones, and the tier line they draw (DRY-56) ([757a649](https://github.com/Einlanzerous/drydock/commit/757a6492657c7b3032faff93186be4d477c7d5b9))
* **shell:** a window whose PTY is gone becomes something you can resume (DRY-56) ([50c0867](https://github.com/Einlanzerous/drydock/commit/50c08675496b82d22a72a3ce176358bcadc2eef6))
* **shell:** markdown doc viewer + workspace as the single ticket spawn (DRY-35, DRY-36) ([610e5df](https://github.com/Einlanzerous/drydock/commit/610e5df42914d013582d029abc77f0dc1e7d1d60))
* **shell:** markdown doc viewer + workspace as the single ticket spawn (DRY-35, DRY-36) ([7c1c5a0](https://github.com/Einlanzerous/drydock/commit/7c1c5a0f568cb7e75884e504a2ec8e521cd16fc4))
* **shell:** one rail owning the bottom edge (DRY-49) ([3719561](https://github.com/Einlanzerous/drydock/commit/3719561cc2851196d90dbb7097fdcb890137ec90))
* **shell:** roll epics and their children up in the sidebar (DRY-13) ([6aaf639](https://github.com/Einlanzerous/drydock/commit/6aaf639e347c0f04f83550f5e821918a80ee4297))
* **shell:** roll epics and their children up in the sidebar (DRY-13) ([e860552](https://github.com/Einlanzerous/drydock/commit/e8605522548c9bdfbd03c6587dca0564eb2d6a90))
* **shell:** say it once when the desk stops roaming (DRY-58) ([c7bb0f7](https://github.com/Einlanzerous/drydock/commit/c7bb0f7d38342b24412e8fe9e3661adb57120963))


### Bug Fixes

* a store outage that ends by itself, and says so while it lasts (DRY-58) ([3f1e228](https://github.com/Einlanzerous/drydock/commit/3f1e228bf6aec8d8a3f38956a3f57245e3d0c92c))
* close the gap that made an autonomous run hang silently (DRY-49) ([72cd635](https://github.com/Einlanzerous/drydock/commit/72cd63594c02589d34538b80bf796a2f322245e8))
* close the review's findings on session history (DRY-56) ([8a09591](https://github.com/Einlanzerous/drydock/commit/8a095918dd2d3ffaae330fcdeda5cfc9330f69fb))
* correct gate tray stacking, in-pane deny, and stream resync (DRY-50) ([48f22e8](https://github.com/Einlanzerous/drydock/commit/48f22e89d0f9ffc1c1f58e2d99babece679f4036))
* **daemon:** a cooldown 503 should say what went wrong (DRY-58) ([f5b8691](https://github.com/Einlanzerous/drydock/commit/f5b8691d15cd258a3c75f6a15fffee65f67d21de))
* **daemon:** a migration edited after it applied is an error (DRY-58) ([89888ea](https://github.com/Einlanzerous/drydock/commit/89888ea162c265f574078f90ce9364a8c9cb64c1))
* **daemon:** a run you stop on purpose is not a failure (DRY-49) ([442a18e](https://github.com/Einlanzerous/drydock/commit/442a18e22aaef69c744c5c1ebb60ee8c760ca2ae))
* **daemon:** abort a slow query server-side, not just client-side (DRY-58) ([19d62b5](https://github.com/Einlanzerous/drydock/commit/19d62b5cd12e26e98c3fd18f5c495f767d712cff))
* **daemon:** answer refused upgrades, retry a broken log sink (DRY-45) ([950272e](https://github.com/Einlanzerous/drydock/commit/950272e73043abc433ab6194e1faef280a44a87e))
* **daemon:** bound a query, not just the connect (DRY-58) ([ef5d3ee](https://github.com/Einlanzerous/drydock/commit/ef5d3ee67473eb961ab98965583f9f865eeee4ab))
* **daemon:** close the gaps review found in session durability (DRY-57) ([9f3afd5](https://github.com/Einlanzerous/drydock/commit/9f3afd5f7e3880c3fc421cffa6b56dc65906775a))
* **daemon:** contain client socket errors, log session lifecycle (DRY-45) ([3eb732b](https://github.com/Einlanzerous/drydock/commit/3eb732b20e7717c1e9ec3e3c8a6a154b05c87988))
* **daemon:** contain client socket errors, log session lifecycle (DRY-45) ([1913929](https://github.com/Einlanzerous/drydock/commit/19139298cb0599b4aef7c62cbf02991b2c2de321))
* **daemon:** don't let the request ceiling cap a migration (DRY-58) ([21bf49b](https://github.com/Einlanzerous/drydock/commit/21bf49bdf45510469cfc87ffbcc8c5c570f8dd55))
* **daemon:** harden the crash handlers themselves (DRY-45) ([6715444](https://github.com/Einlanzerous/drydock/commit/67154447320e1d3f49effcb504a3a9342840d15d))
* **daemon:** only downgrade the epic clause when the query contained it (DRY-13) ([894bba9](https://github.com/Einlanzerous/drydock/commit/894bba9e332f3478cb5b5e4a08647f38ad620e6a))
* **deploy:** put StartLimitIntervalSec where systemd reads it (DRY-57) ([0dc3b17](https://github.com/Einlanzerous/drydock/commit/0dc3b17b4c3dc3a4703e4e83b7d873adce7abc52))
* give permission gates a lifetime beyond the terminal pane (DRY-50) ([9040345](https://github.com/Einlanzerous/drydock/commit/90403459a8100c98fc37fcf30c23d144ffd32577))
* harden the gate surface against dead streams and bad input (DRY-50) ([3f2b8ae](https://github.com/Einlanzerous/drydock/commit/3f2b8ae25c4384dc9c6ac6f0de7956e8fd5b6971))
* **shell:** a daemon's error body is not data (DRY-51) ([1898b5b](https://github.com/Einlanzerous/drydock/commit/1898b5bd93088d8d83e6644128e4ecffffc10452))
* **shell:** a daemon's error body is not data (DRY-51) ([0d74ef1](https://github.com/Einlanzerous/drydock/commit/0d74ef1818c5db7e97cb99c5cfbc36f6a6afce5b))
* **shell:** a store outage that ends without a reload (DRY-58) ([c46446a](https://github.com/Einlanzerous/drydock/commit/c46446ab8119ba695b699baebb78726c1e646218))
* **shell:** a write budget that outlasts the daemon's own deadline (DRY-58) ([68873d0](https://github.com/Einlanzerous/drydock/commit/68873d03debc648c27ef65a1e7800bf48b6a6a2b))
* **shell:** banner a dead PTY's pane so /exit reads as exited, not stalled (DRY-41) ([c16776e](https://github.com/Einlanzerous/drydock/commit/c16776e9b0094ae34c7805d375d84054bb2b0035))
* **shell:** banner a dead PTY's pane so /exit reads as exited, not stalled (DRY-41) ([e52be0d](https://github.com/Einlanzerous/drydock/commit/e52be0db34cc1514da66dfd8770b56365ab2ddc3))
* **shell:** claim Ctrl+K in the capture phase; harden the chord (DRY-43) ([cec7510](https://github.com/Einlanzerous/drydock/commit/cec7510d0c092d0da17ee220db9b29bec4ea85bb))
* **shell:** dedupe windows per session id; heal persisted dups (DRY-42) ([39f3667](https://github.com/Einlanzerous/drydock/commit/39f3667064362774f42969b75a4c990820ec2906))
* **shell:** dedupe windows per session id; heal persisted dups (DRY-42) ([64c737c](https://github.com/Einlanzerous/drydock/commit/64c737c1e73309adeed5aaa951a3bc17996324ee))
* **shell:** drop duplicate New Session header button; pin blank-shell row in the palette (DRY-39) ([734116c](https://github.com/Einlanzerous/drydock/commit/734116c01e0221a61b60c4fd365a6df843424b1b))
* **shell:** drop duplicate New Session header button; pin blank-shell row in the palette (DRY-39) ([a301fd1](https://github.com/Einlanzerous/drydock/commit/a301fd1906871710bdd4a5fd9a6b9fbccf1d3be3))
* **shell:** focus a freshly spawned terminal; blur spawn buttons (DRY-40) ([f7a70e7](https://github.com/Einlanzerous/drydock/commit/f7a70e79aea9acc789f0455ed91709a9ae569702))
* **shell:** focus a freshly spawned terminal; blur spawn buttons (DRY-40) ([2db7e00](https://github.com/Einlanzerous/drydock/commit/2db7e00ac024146f713a055f8f9a59cc2345193d))
* **shell:** give a workspace write a deadline (DRY-58) ([ad0246d](https://github.com/Einlanzerous/drydock/commit/ad0246dd43fbd89ca5bfdd5cc4988e72ab466ffe))
* **shell:** give the errors this PR raises somewhere to land (DRY-51) ([a686190](https://github.com/Einlanzerous/drydock/commit/a686190ce6269649753a6c8a7d6b0ad4ed3550e3))
* **shell:** keep a notice to one line (DRY-58) ([3f12e2e](https://github.com/Einlanzerous/drydock/commit/3f12e2e61cf62270822798c53f132b7b724d722a))
* **shell:** let Ctrl+K reach the palette from inside a terminal (DRY-43) ([345c293](https://github.com/Einlanzerous/drydock/commit/345c293e77f5c392df82866d664381fc52ccc477))
* **shell:** let Ctrl+K reach the palette from inside a terminal (DRY-43) ([ec0f0c3](https://github.com/Einlanzerous/drydock/commit/ec0f0c354deb4f927f2aefc3b162014162b6f381))
* **shell:** one writer while recovery is in flight (DRY-58) ([1fc18c7](https://github.com/Einlanzerous/drydock/commit/1fc18c7d94fd0bb4d4c54e5ca1963ad6befb5c5c))
* **shell:** recover in a background tab too (DRY-58) ([a9a52e8](https://github.com/Einlanzerous/drydock/commit/a9a52e840708fbd0a1a68557ac87eefba3b8f6ec))
* **shell:** recovery must not swallow a desk queued behind its own push (DRY-58) ([f549c35](https://github.com/Einlanzerous/drydock/commit/f549c35883b158cd25de37e6a18bf10f2f35ff2e))
* **shell:** un-binary tracker.ts and make the epic queries fail soft (DRY-13) ([b194e7c](https://github.com/Einlanzerous/drydock/commit/b194e7c3e45ad86d8c7c4a74016ece24f77a6182))


### Documentation

* **claude:** capture the Playwright UI-verification recipe as a project verify skill (DRY-40) ([77b9b75](https://github.com/Einlanzerous/drydock/commit/77b9b7539a42fb1a8b4a269a8791eddd4be92a65))
* **claude:** project verify skill — Playwright UI-verification recipe (DRY-40) ([b9bae4f](https://github.com/Einlanzerous/drydock/commit/b9bae4f3558d9ba61abd4c2bd771f24e80d00207))
* **claude:** verify skill — config.js clobbers __DRYDOCK__; VITE_DAEMON_URL is the working override (DRY-40) ([ad7a3a4](https://github.com/Einlanzerous/drydock/commit/ad7a3a415157e420e0dc488e692ee892e08c1a9a))
* don't tie the tier docs to another PR's merge order (DRY-58) ([b939672](https://github.com/Einlanzerous/drydock/commit/b9396723242e4eb28137363587321e5a4498cf6c))
* name the right PTY owner now DRY-57 has landed (DRY-58) ([687ee45](https://github.com/Einlanzerous/drydock/commit/687ee457bb656743106ec4ce5c2b8db024124612))
* refresh README with logo + screenshot, drop demo-repo ([95c71cb](https://github.com/Einlanzerous/drydock/commit/95c71cb487ab6c4742f443abe1b6f97844a694a1))
* stop tracking HANDOFF.md in the repo ([6d2c789](https://github.com/Einlanzerous/drydock/commit/6d2c7890feea994ec0b637514eb82c094c4665ee))
* the dev daemon no longer kills sessions on edit (DRY-57) ([1e93f8d](https://github.com/Einlanzerous/drydock/commit/1e93f8d063d64da94f10ce9eb05e85cb4317234f))
* two tiers, and what a database actually buys (DRY-58) ([95d3bcf](https://github.com/Einlanzerous/drydock/commit/95d3bcfb96f7438153c7fcfab093d4c0f08cb0aa))
