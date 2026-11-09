- **`agent.strategy.identityReminderSilent` is retired.** context-manager
  #129 leaves the option out. A reminder the summarizer should follow
  without quoting it ends with its own sentence asking for that, such as
  #129's example: "Apply this guidance silently. Do not quote, restate, or
  recite it in the memory. Begin with the substantive record." Where a
  recipe set the key to true, its author ends each nonblank reminder it
  sets, `identityReminder` and `witnessedIdentityReminder`, with such a
  sentence instead. A blank reminder stays as it is, since a blank
  `witnessedIdentityReminder` counts as unset and wholly inherited targets
  then take `identityReminder`. The host no longer passes the key to the
  built-in strategies, and a recipe for one of them that still sets it
  loads with a warning naming what replaced it. An extension strategy still
  gets the whole strategy config, the key included. No released
  context-manager reads the key, so a recipe on a released version loses
  nothing.
