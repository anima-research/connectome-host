- While a session switch is under way, `/undo`, `/redo`, `/checkout`,
  `/branchto`, `/newtopic`, `/nudge`, `/puppet`, `/session rename`,
  `/session delete`, `/fleet stop` and `/fleet restart`, and `/checkpoint`,
  `/restore` and `/budget` given a name or a value, are refused, saying
  nothing changed and to try again once the switch has finished. So are the
  fleet view's stop and restart keys, the Web UI's rollback, suppress, fleet
  stop and restart, host quiesce and resume, and pin and settings changes
  (one for a fleet child is passed on, and the child refuses it only while
  its own session is switching), and a headless host's pin and settings
  changes and its answer to a release switch's quiesce. Once the switch has
  stopped the old session's framework, the Web UI answers "host not ready"
  until the next one is installed, as before.
  Before, they ran against whichever framework the host held at that moment:
  the one the switch was stopping, or the next one before its start had
  finished. A `/session delete` could remove the session being switched to,
  or the one being left once the switch had made the next one active.
  The forms of `/checkpoint`, `/restore` and `/budget` that only list or show
  answer as they do without a switch.
- `/session new` and `/session switch` start no switch while any of those
  commands, given earlier, or those actions on this host is still running,
  saying which, as they already started none while another switch was under
  way.
