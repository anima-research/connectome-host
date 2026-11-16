- Add experimental, opt-in host-selected reaction drivers for main-final refusals.
  Enabling them requires an agent-framework release containing the main-refusal
  bridge; the currently locked dependency does not support the option. The Zulip
  driver remains pending its upstream connector contract and currently targets a
  fork-only contract, not a supported upstream release. Omit the option to retain
  built-in Discord refusal reactions (#665).
