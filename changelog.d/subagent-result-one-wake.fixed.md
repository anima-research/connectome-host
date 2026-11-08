- An async subagent's result that reaches its parent by its message route no
  longer asks for a second wake. agent-framework's delivery already wakes the
  parent, and the host's own wake, which named no message, started a turn of
  its own after a turn that had already read the result, such as at a tool
  boundary, or when another event was queued ahead of it: one more model
  call, whose request brought nothing new. `recipes/clerk.json`'s system
  prompt now says a returned fork's result arrives as a message that wakes
  the resident, and a failed fork as an `inference-request` scope event.
