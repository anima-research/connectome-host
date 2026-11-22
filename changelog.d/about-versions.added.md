- **`about--versions` gives an agent the versions that its host runs.**
  Every host has it, as a utility of the built-in `settings` toolset, so
  no request's tool list carries it: `toolsets--open {"toolset":
  "settings"}`, then `toolsets--act {"tool": "about--versions", "args": {}}`. Its answer
  has the host's line and the Connectome packages' line, as `/bug` prints
  them, from what the host started with: `connectome-host 0.27.1`, with
  the commit and whether it's modified for a host that runs from a git
  checkout, and `agent-framework … · membrane … · context-manager … ·
  chronicle …`. Then one line for each MCPL server that the host has
  loaded, by its id, with the server's own name and version as its last
  handshake gave them. A server that isn't connected now shows what its
  connection's last handshake gave, with `(not connected now)`, or says
  that its name and version aren't known.
- **`mcpl-admin--mcpl_list` gives each server's own name and version** in
  its line, as `server=<name> <version>`, or `server=unknown` where the
  host doesn't know them.
