- An operator's work still under way now holds a headless host's quiet: a
  command's follow-up, such as `/newtopic`'s transition summary or
  `/update check` reading the registry, whichever entry sent the command; a
  credential action, such as `/auth login` waiting for its code to be entered,
  which the Codex subscription's login gives up on after 10 min by default;
  and the actions that already held a session switch off. `lifecycle:idle`,
  `--exit-when-idle` and an armed self-restart wait for it. Before, a
  self-restart or `--exit-when-idle` could stop the host mid-`/newtopic`,
  losing the topic reset.
- A headless, readline or batch host that begins to stop while a session
  switch is under way, before the switch has installed its new framework,
  starts no framework for that switch: the switch stops a framework it has
  made rather than starting it. A headless host waits for the switch to
  settle before it stops and exits, saying so in its log if the switch
  outlasts the ~50 ms the host gives its `exiting` line, and exits 1 if
  stopping what the switch made failed; a switch already installing there
  finishes, and the stop then stops the framework it installed. `/session new` and
  `/session switch` asked for after the stop began are refused, saying the
  host is stopping, before any session is created. For a switch the stop
  left unfinished, the asker is told it didn't finish and which session the
  next start opens: in a headless or readline command's answer, in place of
  `Session switched.`, and as an error to the webui while its server is still
  up. Before, a headless or readline host could start that framework and exit
  without stopping it (#499).
