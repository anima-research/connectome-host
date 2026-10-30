- Every MCPL server entry now reconnects by default: recipe entries,
  `mcpl-servers.json` entries a recipe names, and the agent's overlay, at
  startup and through `mcpl_deploy`. Before, only an overlay entry with a
  `url` did, so a stdio server that failed at startup, or whose process
  exited later, stayed gone until the host restarted or an agent's
  `mcpl_restart` started it again, and a failed start raised no ops alert
  unless the server spoke a protocol version the host can't or its launch
  couldn't be confirmed to have exited. Now its command is started again,
  waiting about 5 seconds at first and doubling to about 5 minutes between
  tries by default, for as long as the host runs unless one of those two
  stops it for good; from the fifth failed retry, each one raises an
  `mcpl-down` ops alert and writes a line to `logs/failures.log`, and an ops
  webhook, if one is set, posts at most once every 15 minutes per server.
  The default was URL-only on the reasoning that reconnecting didn't start a
  stdio server's process again; agent-framework does, and has since at
  least 0.21.0 (#229). An entry that should stay down when its server fails
  says `reconnect: false`. A close the host makes itself, at batch mode's
  end, a shutdown or an unload, isn't undone.
