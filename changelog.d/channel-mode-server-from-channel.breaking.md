- **Recipe authors and operators:** `channel-mode--set_channel_mode` takes
  each call's MCPL server from the prefix of its channel id (the text before
  the first `:`), not from `modules.channelMode.serverId`. The open, the
  debounce rule's `source` and the close all use that server, so
  `zulip:backend` now opens, gates and closes on `zulip` rather than on
  `discord` (#613). The prefix must name an MCPL server the host knows,
  connected or not. An id with no prefix, or with an unknown one, is refused
  before any step, and the message shows the expected `<serverId>:<channel>`
  form. So is an id containing `*`, which the gate would read as a wildcard
  matching other servers or channels. Nothing else chooses the server: not
  the channel registry, not the config, and not a default. A second call for
  a channel id while the first is still running is refused before any step.
  See `docs/ATTENTION-AND-GATING.md`.
  - **Discord-only hosts:** calls with `discord:<guildId>:<channelId>` ids
    run the same steps as before, including while Discord is disconnected.
    One difference: a second call for an id while the first is still running
    is now refused, where both used to run. Calls with an unprefixed id, such
    as a raw channel snowflake, are now refused. Before, a debounced call
    tried the open on `discord`, set a rule for the raw id and pinned it. That
    rule could match push events, whose `channelId` can be the raw id, but
    not the channel's messages, which carry `discord:<guildId>:<channelId>`.
    Migration: pass the channel's registered id, as `channel_list` shows it.
    An agent removes a rule such a call left with `wake_remove_rule`
    `{ "name": "channel-mode:debounced:<id>" }`. Its pin can't be removed
    with an agent tool or `/puppet`: host code removes it with
    `framework.executeToolCall`, naming
    `subscription-gc--pin_channel_idle_limit` with input
    `{ "channelId": "<id>", "pinned": false }`.
  - **Recipe authors:** `modules.channelMode.serverId` is ignored, and a
    startup line says so. If it named a server whose id differs from its
    channels' prefix (say `discord-bot` serving `discord:…` ids), those calls
    now go to the server the prefix names. With no `discord` server they are
    refused as unknown. With one, they run there: for a channel only
    `discord-bot` registers, the open fails, but the rule and pin steps
    still run. Migration: give the MCPL server the id its channel ids
    carry, then drop `serverId` from `modules.channelMode`. If
    `modules.subscriptionGc.serverId` named the old id, change it to the new
    one too: subscription GC watches only that server, so otherwise it stops
    counting and auto-closing the renamed server's channels.
  - **Known limit:** a channel id's prefix must equal its MCPL server id;
    nothing checks it against the server that registered the channel, and
    there is no `serverId` parameter or other override. A server whose id
    differs from its channels' prefix (such as `discord-bot` above), or whose
    id contains `:` (for `chat:west` registering `chat:west:room`, the prefix
    is `chat`), can't be used with channel mode until its id matches.
  - **Operators:** a rule an earlier release set for a prefixed id with
    `source: "discord"` stays until that channel's mode is set again. The next
    debounced call replaces it, and the next mentions call removes it.
    Reapply the mode on affected channels, and remove any hand-written rules
    that worked around this.
- **Operators:** the `set_channel_mode` tool description and schema change on
  upgrade. Each resident whose requests carry the tool (not hidden by its tool
  allowlist) and use prompt caching rewrites its prompt cache in full on its
  first such request, even if it never invokes the tool. A resident with
  `promptCaching: false`, or on a model without prompt caching, has no cache
  to rewrite.
