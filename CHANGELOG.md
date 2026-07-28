# Changelog

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
