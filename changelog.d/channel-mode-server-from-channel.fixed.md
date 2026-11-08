- Channel attention modes now route open, debounce rule source, and close to the
  channel's own MCPL server instead of always using Discord. Registry ownership
  takes precedence over a known-server id prefix; `modules.channelMode.serverId`
  remains a fallback for unregistered bare ids (no `:`) or its own namespace,
  defaulting to `discord` as before. Unknown namespaces never use a different
  fallback server. Debounced mode refuses unknown, disconnected, or ambiguous
  ownership before changes.
  The tool's optional `serverId` selects a known server or registry owner when
  ids are ambiguous. Mentions mode prefers the persisted live debounced owner,
  unless explicitly overridden. Owners are saved only after open and rule install
  succeed, and deleted after completed cleanup (including durably recorded
  closes). Without a saved owner, mentions uses the same per-channel resolution
  as debounced mode, including pre-upgrade and directly opened channels. A removed
  saved owner is never retargeted to a replacement. Rule/pin cleanup is always
  attempted; only unknown or ambiguous ownership skips the close. Known
  disconnected owners still receive the close for
  durable re-registration, preserving the framework's retry guidance. New
  debounced ids are refused before effects at 1024 live owners (including
  in-flight opens); complete tracked mentions cleanup to free a slot, restoring
  a removed server/registration first if needed. Existing owners are not evicted.
  Reapply the mode on affected non-Discord
  channels: previously saved wrong-source rules are replaced or removed on the
  next call, not migrated at startup.
  Remove hand-written workaround debounce rules when reapplying the mode.
