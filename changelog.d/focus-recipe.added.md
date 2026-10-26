- Recipe `focus` block (`enabled`, `defaultDurationSeconds`,
  `maxDurationSeconds`, `defaultBacklogCap`, `maxBacklogCap`, `autoReply`,
  `autoReplyTemplate`) passes through to agent-framework's focus mode: the
  resident narrows attention to one channel for a bounded time; other
  channel and DM traffic is held and the newest `backlogCap` messages per
  held channel are delivered at unfocus (the rest stay reachable through the
  history tools). Numeric fields must be non-negative integers,
  `maxDurationSeconds` within 60..604800, defaults no larger than their
  maxima, and `focus.enabled` is refused alongside `conversations`.
