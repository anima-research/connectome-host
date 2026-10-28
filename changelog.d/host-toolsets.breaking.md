- **Agents, and operators whose agents use them:** the MCPL administration tools (`mcpl-admin--mcpl_list`,
  `--mcpl_deploy`, `--mcpl_restart`, `--mcpl_unload`) and the observer grant
  tools (`observers--get`, `--grant`, `--revoke`) live in agent-framework's
  built-in `settings` toolset (0.29.0), out of the tool list: open it with
  `toolsets--open {"toolset": "settings"}` and call one with `toolsets--act`.
  The framework's `utils` tool is gone, and every message, description and doc
  of this host that named it now names the settings toolset: a call of a
  module's tool it lacks lists the module's tools in the settings toolset and
  how to reach them, identity's invitation note, and subagent `tools` lists
  (a subagent that should use a settings-toolset tool lists `toolsets--open`,
  `toolsets--act` and the tool's own name).
