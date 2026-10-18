- **Agent overlays:** an `mcpl-servers.agent.json` entry's
  `allowHostCommands` is left out at boot, as its `inheritEnv`,
  `enabledCapabilities` and `toolLifecycle` already were, so host commands
  are granted only by the operator's own config: an operator who granted
  them through the overlay sets `allowHostCommands` in a server the recipe
  defines itself, with its own command or url and an id
  `mcpl-servers.json` doesn't define, instead. The startup warnings now
  name each of the four that an overlay entry sets, with where the
  operator sets it, and for `enabledCapabilities` how the entry can narrow
  what its server advertises instead: by listing what to deny in its
  `disabledCapabilities`. They also name an overlay entry's `reconnect`
  that isn't true or false, which is read as its truth, as the framework's
  connection read it, so agent-framework's setup-failure trace now reports
  `willRetry` as the connection retries. An overlay entry that replaces an
  operator's server is also named for the operator's host commands,
  capabilities and tool lifecycle it lacks, as it was for env and the
  inherited environment.
