- **Installers and packagers:** connectome-host now declares
  `@animalabs/agent-framework` `^0.28.0` (was `^0.27.0`),
  `@animalabs/context-manager` `^0.23.0` (was `^0.22.1`) and
  `@animalabs/chronicle` `^0.5.0` (was `^0.4.0`): the releases that carry
  agent-framework #291's presentation index and the exports this release
  imports (`asOwnRow`, `storeOwnRow`, `residentContextOptions`,
  `subconsciousContextOptions`, `getPrimaryAgentName`), context-manager's
  window release with its batched window write, and the chronicle with the
  identity-stamped batched append, the same ranges agent-framework and
  context-manager declare, so an install takes one copy of each. Under the
  old ranges an install from the registry took releases without those
  exports, and the host failed to load. Until those releases are published
  an install of this one doesn't resolve, and `bun.lock` and
  `package-lock.json`, which still name the old releases, are regenerated
  once they are (then `scripts/lockfiles-agree.mjs` checks them).
  **Migration:** none for a host that installs connectome-host whole. A
  deployment that pins any of the three itself takes the ranges above. A
  store chronicle 0.5 writes a batch to moves to `MANIFEST` version 2, which
  older chronicle builds refuse (see the 291-presentation entry's going-back
  note).
