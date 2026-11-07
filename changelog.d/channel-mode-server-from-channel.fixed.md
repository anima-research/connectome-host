- Channel attention modes now route open, debounce rule source, and close to the
  channel's own MCPL server instead of always using Discord. Registry ownership
  takes precedence over a known-server id prefix; `modules.channelMode.serverId`
  remains a fallback for unregistered bare ids (no `:`) or its own namespace,
  defaulting to `discord` as before. Unknown namespaces never use a different
  fallback server. Debounced mode refuses unknown, disconnected, or ambiguous
  ownership before changes.
  Mentions mode still removes the rule and pin when the owner is unavailable,
  reporting any skipped or failed close. Reapply the mode on affected non-Discord
  channels: previously saved wrong-source rules are replaced or removed on the
  next call, not migrated at startup.
