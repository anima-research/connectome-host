- **Authors of a Web UI client other than the page this host serves:** the
  Web UI protocol is now v3, and eight client messages change. `rollback` and
  `suppress` require `sessionId`. `pin-add`, `pin-remove`, `settings-update`,
  `settings-reset` and `settings-cancel-transition` require it unless their
  `scope` names a fleet child, and with such a scope carry none.
  `cancel-subagent` requires it unless it has a `childName`, and with one
  carries none. A client that leaves it out where it's required, or includes
  one on a change whose `scope` or `childName` names a fleet child, is
  answered "unknown message shape". To migrate, send the session of the data
  the operator chose the change from: the welcome's `session.id` for its
  messages and for the subagents its tree shows, or the `sessionId` that a
  `history-page`, this process's `pins-list` and `settings-state`, and the
  `/debug/context` answer now carry. Unchanged: every other message, a fleet
  child's pin, settings and subagent-cancel messages, which carry no session,
  and the page this host serves, which speaks v3. A page from before this
  release shows its protocol mismatch banner.
