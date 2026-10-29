- **Installers and packagers:** connectome-host now declares
  `@animalabs/agent-framework` `^0.31.0` (was `^0.30.0`),
  `@animalabs/context-manager` `^0.25.0` (was `^0.24.0`) and
  `@animalabs/chronicle` `^0.6.0` (was `^0.5.0`), which supersede the ranges
  the Dendrite floor entry names; `@animalabs/membrane` stays `^0.8.0`. They
  are the releases that carry agent-framework #291's presentation index and
  the exports this release imports (`asOwnRow`, `storeOwnRow`,
  `residentContextOptions`, `subconsciousContextOptions`,
  `getPrimaryAgentName`), context-manager's window release with its batched
  window write, and the chronicle with the identity-stamped batched append
  (`appendManyToStateJsonWithIdentity`) that context-manager writes a window
  with. Neither of the last two floors can be lower. context-manager 0.23.0
  and 0.24.0 were both published without the window APIs (`windowStatusOf`,
  `presentRows`, `retractRows`, `getPresentedMessages`), and chronicle 0.5.0
  without the batched append; agent-framework refuses to start on either,
  naming the range to install. The four ranges are the ones agent-framework
  and context-manager declare, so an install takes one copy of each: two
  membrane copies make TypeScript refuse the host's `Membrane` where
  agent-framework or context-manager takes one, and two chronicle copies hand
  context-manager a store handle from a chronicle it doesn't load. Under the
  old ranges an install from the registry took releases without those
  exports, and the host failed to load. Until those releases are published
  an install of this one doesn't resolve, and `bun.lock` and
  `package-lock.json`, which still name the old releases, are regenerated
  once they are (then `scripts/lockfiles-agree.mjs` checks them).
  **Migration:** none for a host that installs connectome-host whole. A
  deployment that pins any of the four itself takes the ranges above. The
  first window written down with rows, or a presentation of more than one
  row, moves the store's `MANIFEST` to version 2, which chronicle 0.5.0 and
  earlier refuse (see the 291-presentation entry's going-back note).
