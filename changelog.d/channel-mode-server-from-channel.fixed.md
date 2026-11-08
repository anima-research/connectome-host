- Channel attention modes now route open, debounce rule source, and close to the
  channel's own MCPL server instead of always using Discord. Registry ownership
  takes precedence over a known-server id prefix; `modules.channelMode.serverId`
  remains a fallback for unregistered bare ids (no `:`) or its own namespace,
  defaulting to `discord` as before. Unknown namespaces never use a different
  fallback server. Debounced mode refuses unknown, disconnected, or ambiguous
  ownership before changes.
  The tool's optional `serverId` selects a known server or registry owner when
  ids are ambiguous. Mentions mode prefers the persisted last debounced owner,
  unless explicitly overridden, so server removal cannot retarget cleanup. It
  still removes the rule and pin when ownership is unknown or ambiguous,
  reporting the skipped close; for a known disconnected owner it sends the close
  so the framework records it for re-registration, preserving its retry guidance.
  Reapply the mode on affected non-Discord
  channels: previously saved wrong-source rules are replaced or removed on the
  next call, not migrated at startup.
  Remove hand-written workaround debounce rules when reapplying the mode.
