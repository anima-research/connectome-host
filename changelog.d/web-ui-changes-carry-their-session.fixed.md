- The Web UI's rollback, suppress, pin and settings changes and its subagent
  cancel on this host are made only in the session they were chosen in. Each
  change carries the session whose messages, pins or settings the operator
  chose it from, as the host stamped it on that data, and a cancel carries
  the session shown when it was chosen. The host refuses one chosen in a
  session other than the one whose framework is open, naming both sessions
  and saying nothing changed. Before, a rollback or suppress confirmed in a
  dialog opened before a session switch, or chosen in a Context view still
  showing the old session, an armed quiesce-and-retry that fired after a
  switch, or a pin removal clicked as the switch's welcome arrived, acted on
  whichever of the open session's messages or pins had the same ids, since
  ids count from the start in each session's store. A subagent cancel sent
  after a switch had put the next session's framework in place, and before
  that session's welcome reached the page, or after a switch whose next
  framework failed to start, stopped the next session's subagent of the same
  name, if it had one. A fleet child's pins, settings and subagents aren't
  covered: the page knows no child's session, so those messages carry none
  and aren't checked.
- The welcome names the session whose framework is open. Before, a welcome
  sent while a switch was making the next session's framework named that next
  session beside the old session's messages.
- When a new session's welcome reaches the page, the page now drops an open
  rollback or suppress dialog, its pending retry and result, the selected
  messages, a pending history page and the branch list, closes the open
  panel, asks again for the MCP tab if it's the one open, and reloads the
  Context view. With this process's panels selected, it also drops their pin
  and settings state and forms, and asks again for the settings or pins tab
  if it's the one open. A selected fleet child's panels are kept while the
  welcome still lists that child, and otherwise the page goes back to this
  process's panels. Until that welcome arrives the page shows the session
  before it, and a branch checked out from its list after the switch has
  finished, like any command then, runs in the session now open. It keeps a
  history page, and this process's pins list, settings state and Context
  view, only when the session stamped on it is the one it shows.
