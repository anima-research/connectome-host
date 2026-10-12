- **Recipe authors:** `agent.strategy.identityReminderSilent` is retired.
  context-manager #129 leaves the option out. A reminder the summarizer
  should follow without quoting it ends with its own sentence asking for
  that, such as "Apply this guidance silently. Do not quote, restate, or
  recite it in the memory. Begin with the substantive record." The host no
  longer passes the key, and a recipe that still sets it loads with a
  warning naming what replaced it. No released context-manager reads the
  key, so a recipe on a released version loses nothing.
