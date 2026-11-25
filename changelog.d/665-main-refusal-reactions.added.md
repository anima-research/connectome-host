- Add experimental, opt-in host-selected reaction drivers for main-final refusals.
  Enabling them requires an agent-framework release containing the main-refusal
  bridge; the currently locked dependency does not support the option. The Zulip
  driver remains pending its upstream connector contract and currently targets a
  fork-only contract (strict or compat IDs), not a supported upstream release.
  Opting in turns off the framework's built-in refusal reactions for all
  servers, including unselected ones. Replacing a selected connector
  (including with `mcpl_restart`) stops its markers until the host restarts.
  A refusal-marker ops alert is raised once per server and stays until host
  restart, even if a later marker succeeds.
  While enabled, session switches (including `/session new`) are refused
  without changing the current session. To change sessions, start the host
  without the option, use `/session switch` or `/session new`, then re-enable
  the option and restart the host.
  Omit the option to retain built-in Discord refusal reactions and normal session
  switching (#665).
