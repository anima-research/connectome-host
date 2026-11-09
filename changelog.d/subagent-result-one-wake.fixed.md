- An async subagent's result or failure that reaches its parent by its
  message route no longer asks for a second wake. agent-framework's delivery
  already wakes the parent, and the host's own wake, which named no message,
  started a turn of its own after a turn that had already read the result,
  such as at a tool boundary, or when another event was queued ahead of it:
  one more model call, whose request brought nothing new. A failure whose
  recipient is the live primary now takes its message route too, where it
  was a line in the primary's context with that wake of the host's own. A
  run that failed before its agent was created has no route, and is still
  told to its launcher as a line in its context, with a wake.
  `recipes/clerk.json`'s system prompt now says a fork's result or failure
  arrives as a message from the fork that wakes the resident, and one that
  couldn't be created, or whose message can't be delivered, as an
  `inference-request` scope event.
