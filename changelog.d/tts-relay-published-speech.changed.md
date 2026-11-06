- The TTS relay (`modules.ttsRelay`) sends voice clients only what the
  agent's prose published: each message, once its publish is confirmed, as
  one text block on the channel it was published to, when that channel is
  on the server `editServerId` names (`discord` when it's unset). It used
  to stream everything the model wrote as it wrote it, tagged with the
  turn's channel, so voice clients were sent text the agent kept back as
  text to speak, such as an explicit-mode agent's unprefixed text, and a
  `>>` reply's envelope. The relay no longer receives the model's
  thinking, tool calls or tool results either. A spoken reply now starts
  when its message is posted, not while it is being written. A message's
  block can now arrive after its turn's `activation_end`, or on a channel
  where no activation was opened.
- A failed model call that the framework tries again, or holds for a
  provider's wait, no longer ends the voice client's activation, so it no
  longer cancels the audio of what the turn had already published. A turn
  the framework gives up on still ends it as an error.
- When the TTS relay module stops with an activation still open, such as
  a turn held after a failed model call, it now sends that activation's
  `activation_end`, as an abort, before it disconnects, if it's connected
  to the relay. The relay keeps no activation state, so Melodeus went on
  showing the agent as thinking after the host had gone. On an abort,
  Melodeus cancels the speech it is still fetching for the host, so the
  end of a message the turn published may go unvoiced. The message is
  still in its channel as text.
