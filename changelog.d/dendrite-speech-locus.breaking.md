- **Operators whose residents rely on where their words land when nothing
  names a channel:** with the agent-framework release that carries
  agent-framework#546, `speech.locus` defaults to `'delivery'`, and a
  `channel_publish` with no `channelId` goes where the calling turn's plain
  prose would. This host passes `speech` to the framework only when a recipe
  sets it, so every recipe without it takes the new default.
  - **Plain prose** (under prose routing by locus, `"locus"` or `"hybrid"`;
    `"explicit"` and `"disabled"` don't publish prose to a locus): it lands
    in the channel of the delivery that woke the turn, a conversation fork's
    home channel, or a channel the agent opened during the turn. A turn with
    none of these falls back only to an open all-except tune-out's excepted
    channel, and otherwise keeps its prose private (a heartbeat's turn, a
    `noChannel` turn and an ephemeral agent's take no fallback); a
    `[routing]` notice tells the agent so when it was last told its speech
    lands in a channel.
    An addressed message from another channel moves nothing, and a
    `[routing]` notice names who wrote from where. Before, a turn no channel
    message woke fell back to the channel of the most recent inbound
    message, unless it was a conversation fork's, a heartbeat's, a
    `noChannel` turn or an ephemeral agent's, and an addressed message from
    another channel arriving during a turn, or between its streams, moved
    the rest of its prose there.
  - **`channel_publish` with no `channelId`:** from a turn, it goes to the
    turn's locus, else a conversation fork's home channel, else the channel
    of the message that woke the turn, else the fallback above. Made outside
    any turn, as by a script left running after its turn, it goes to a
    conversation fork's home channel, else that fallback. A heartbeat's
    turn, a `noChannel` turn and an ephemeral agent take no fallback, and the
    call is refused when none of these names a channel. Before, it went to
    the channel of the most recent inbound message, whichever turn called
    it, or none, except a conversation fork's own call, which went to its
    home channel, as now; it was refused when there was no such message or
    the caller was an ephemeral agent.
  - **Migration:** `"speech": { "locus": "latest-inbound" }` in a recipe
    brings back the moves on an addressed message, mid-turn or between
    streams, and makes the most recent delivered inbound message's channel
    the fallback again, after an open all-except tune-out's excepted
    channel, for prose and for a publish. No setting sends a publish there
    ahead of the turn's own channel, or from a turn that takes no fallback:
    a publish meant for a particular channel names its `channelId`.
  - **Unchanged:** a `channel_publish` that names its `channelId` goes to that
    channel.
