- The fleet tools' errors now say what didn't happen and what the agent can
  call next. A refusal says what didn't happen, such as "Nothing was
  launched" or "Nothing was sent", says what a missing or mistyped argument
  was given, and names tools as the agent calls them (`fleet--status`, not
  "fleet status"). A `dataDir` or `subscription` of the wrong type is refused
  the same way, where one threw and a string `subscription` was split into
  its characters. A name no child has is answered with the names of the
  host's children, and a call naming no fleet tool with the fleet tools'
  names. A child that isn't running is described by how it stopped, and one
  the host has no connection to by its state. A failed launch says whether
  the child has exited or may still be running, and what to do next. A
  `dataDir` the host can't create is refused with its path and error code,
  where the file system's own message reached the agent. `fleet--relay` from
  a child with no finished reply says whether its subscription leaves out
  `inference:speech`, which `fleet--restart` keeps, and otherwise what would
  bring a reply. An adoption after a restart that met a process with another
  pid says that another process serves the child's data directory, where it
  blamed a stale socket. The texts a child's record keeps are reworded the
  same way: `exitReason`, which `fleet--status` shows, as do the TUI for a
  child that has stopped and the `/fleet` console once a child's exit has
  been seen, and `autoRestartStopped`, which `fleet--status` shows. A throw
  that no handler words, such as a spawn's own error, still reaches the
  agent as its message.
