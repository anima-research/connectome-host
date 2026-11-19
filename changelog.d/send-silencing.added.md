- **`agent.sendSilencing`** (default false) passes agent-framework's setting
  of the same name: true makes an explicit send (`send_message`,
  `channel_publish`, a `drafts` resend and the like) silence the plain speech
  its round and later rounds aim where the send may have posted, holding it
  as drafts. An agent-framework with the setting no longer silences unless it
  is on, so a recipe for a resident who writes a note beside each send sets
  it to true to keep those notes unposted. The resident can change it for
  itself with `agent_settings` (`send_silencing`). An agent-framework that
  predates the setting always silences.
