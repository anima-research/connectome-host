- Channel attention modes now route open, debounce rule source, and close to the
  channel's own MCPL server instead of always using Discord. Registry ownership
  takes precedence over a connected-server id prefix; an explicit
  `modules.channelMode.serverId` remains a fallback for legacy ids. Unknown,
  disconnected, or ambiguous ownership is refused before any changes.
