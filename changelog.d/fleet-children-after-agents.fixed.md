- A fleet's autoStart children launch once the parent's framework has started
  its agents, as the fleet module's description says, instead of while the
  framework is still being built. A child is a host with residents of its own,
  so none of them acts before the parent's agents run, and when building the
  parent's framework fails, no child is launched at all. Children still
  running from an earlier parent are adopted at the same point as before. A
  parent's first turn can now find an autoStart child still starting, or not
  yet listed while its recipe loads. The Web UI's welcome as the host starts
  or switches session waits up to a second for the autoStart children's
  launches to load their recipes, so it gives those recipes as before. A
  child whose recipe takes longer, as one fetched from a URL that stalls can,
  is listed by name, and its recipe comes with the first welcome begun after
  it has loaded, as a reconnect or a session switch brings.
