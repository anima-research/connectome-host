- Add experimental, opt-in host-selected reaction drivers for main-final refusals.
  Enabling them requires an agent-framework release containing the main-refusal
  bridge; the currently locked dependency does not support the option. The Zulip
  driver remains pending its upstream connector contract and currently targets a
  fork-only contract (strict or compat IDs), not a supported upstream release.
  During a session switch, a connector that fails its first connection is left
  unarmed, without falling back to built-in marking. Omit the option to retain
  built-in Discord refusal reactions (#665).
