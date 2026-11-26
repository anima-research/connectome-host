- Subscription cleanup (`modules.subscriptionGc`) is on by default, and it
  watches one server: `discord`, unless `serverId` names another (#634). A host
  can lack that server, as a Portal host does when the recipe leaves `serverId`
  out. On such a host, cleanup now writes an `[agent-settings]` line at the
  first ambient message with text from each other server. The line says that
  cleanup closes nothing there. `agent_settings` answers with
  `channel_idle_server`, and with a `channel_idle_warning` where the host has
  any MCPL server. The old
  `set_channel_idle_limit` and `pin_channel_idle_limit` add a sentence to their
  message. `list_channel_idle_limits` reports `active` and `serverId`. Before,
  cleanup said nothing.
- At start, the host writes an `[agent-settings]` line when
  `modules.subscriptionGc.serverId` or `modules.ttsRelay.editServerId` names a
  server that the host lacks.
- On a host that has `discord` and another chat server, cleanup still watches
  only `discord` when `serverId` is left out. The first ambient message with
  text from each other server now gets a line that says so. When `serverId`
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
  no longer reports a failed pin step. Before, each call answered that pinning
  the channel failed (`Module not found: subscription-gc`), though the open or
  close had worked. Channel mode now skips the pin where the host has no
  cleanup module.
