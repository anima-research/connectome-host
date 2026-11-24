- **`about--versions` gives an agent the versions that its host runs.**
  Every host has it, as a utility of the built-in `settings` toolset, so
  no agent request's tool list carries it: an agent opens the toolset with
  `toolsets--open {"toolset": "settings"}` and calls it with
  `toolsets--act {"tool": "about--versions", "args": {}}`. An agent without
  the `settings` toolset calls it by its own name, and an agent whose
  `allowedTools` leaves it out can't call it. Its answer has the host's line
  and the Connectome packages' line, as `/bug` prints them, as the host
  started with them: `connectome-host 0.27.1`, with
  the commit and whether it's modified for a host that runs from a git
  checkout, and `agent-framework … · membrane … · context-manager … ·
  chronicle …`. Then one line for each MCPL server that the host has
  loaded, by its id, with the server's own name and version as the last
  handshake of its connection gave them. A server that isn't connected now
  shows those, with `(not connected now)`, or says that its name and
  version aren't known. Agent Framework 0.35.2 is the first release whose
  server rows carry a server's own name and version.
  At the upgrade, each agent's summariser requests miss their prompt cache
  once: they carry every tool that the agent may call, utilities included,
  so they now carry this one too.
- **`mcpl-admin--mcpl_list` gives each loaded server's own name and
  version** in its line, as `server="<name> <version>"`, or
  `server=unknown` where the host doesn't know them.
