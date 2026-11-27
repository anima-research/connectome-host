- Subscription cleanup (`modules.subscriptionGc`) is on by default, and it
  watches one server: `discord`, unless `serverId` names another (#634). A host
  can lack that server, as a Portal host does when the recipe leaves `serverId`
  out. On such a host, cleanup now writes an `[agent-settings]` line for each
  other server. The line comes at that server's first ambient event with text,
  such as a message or a reaction. The line says that cleanup closes nothing
  there. `agent_settings` answers now carry `channel_idle_server`. Where the
  host has at least one MCPL server, they also carry a `channel_idle_warning`.
  The old `set_channel_idle_limit` and `pin_channel_idle_limit` add a sentence
  to their message. `list_channel_idle_limits` reports `active` and `serverId`.
  Before, cleanup said nothing.
- The host now checks two settings at start: `modules.subscriptionGc.serverId`
  and `modules.ttsRelay.editServerId`. If either names a missing server, the
  start writes an `[agent-settings]` line.
- Take a host that has `discord` and another chat server, with `serverId` left
  out. Cleanup still watches only `discord` there. A line now says so, once
  for each other server. When `serverId`
  names `discord`, cleanup works as before, and that line doesn't come.
- Cleanup no longer counts a message tagged `chat:addressed` toward a channel's
  idle limit. Such a message is a mention, a reply or a DM. The change matters
  for a server that sets neither `isMention` nor `isDM`, such as GitHub's
  server.
- agent-framework can answer a close with `already closed`. Cleanup then no
  longer adds an `Auto-closed` notice to the resident's context, and it sends no
  `subscription-gc-close` ops record. When cleanup closes a channel, the notice
  and the ops record name the server.
- With `modules.subscriptionGc: false` and the wake gate on, `set_channel_mode`
  no longer reports a failed pin step. Before, each call reported a failed pin
  step (`Module not found: subscription-gc`) after the channel had already
  opened or closed. Channel mode now skips the pin in one case: the host has no
  cleanup module, and the recipe leaves `channelMode.gcModuleName` out. A
  recipe can name a `gcModuleName`. Channel mode then always calls that module,
  so a wrong name still makes each pin step fail.
