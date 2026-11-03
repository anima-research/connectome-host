- The TTS relay (`modules.ttsRelay`) sends voice clients only what the
  agent's prose published: each message, once its publish is confirmed, as
  one text block on the channel it was published to, its `blockIndex` the
  publish's index in its stream. It used to stream everything the model
  wrote as it wrote it, tagged with the turn's channel, so voice clients
  spoke text the agent kept back, such as an explicit-mode agent's
  unprefixed text, and a `>>` reply's prefix. The relay no longer receives
  the model's thinking, tool calls or tool results either. A spoken reply
  now starts when its message is posted, not while it is being written.
- A failed model call that the framework tries again, or holds for a
  provider's wait, no longer ends the voice client's activation, so it no
  longer cancels the audio of what the turn had already published. A turn
  the framework gives up on still ends it as an error.
