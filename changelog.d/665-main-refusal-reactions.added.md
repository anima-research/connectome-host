- Add experimental, opt-in host-selected reaction drivers for main-final refusals.
  Enabling them requires an agent-framework release containing the main-refusal
  bridge; the currently locked dependency does not support the option. The Zulip
  driver remains pending its upstream connector contract and currently targets a
  fork-only contract (strict or compat IDs), not a supported upstream release.
  Host ownership replaces built-in refusal reactions framework-wide. If a
  selected server starts closed or unconnected, the host alerts and leaves
  built-in reactions enabled. On detecting a stale connection (for example,
  after `mcpl_restart`), the host releases ownership and alerts; built-in
  reactions resume for subsequent refusals. Restart to re-enable host-selected
  reactions. Other refusal-marker failures alert once per server per run.
  Failed reaction ADDs report a short error category without exposing raw
  error text.
  While enabled, session switches (including `/session new`) are refused
  without changing the current session. To change sessions, start the host
  with the path of a recipe that omits the option (a bare start reloads the
  saved snapshot), use `/session switch` or `/session new`, then re-enable the
  option and start the host again with the edited recipe's path.
  Omit the option to retain built-in Discord refusal reactions and normal session
  switching (#665).
