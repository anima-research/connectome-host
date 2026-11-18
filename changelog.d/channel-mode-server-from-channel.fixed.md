- Channel attention modes route open, debounce source, and close to the
  channel's MCPL owner, not always Discord. Optional `serverId` disambiguates
  shared ids; saved owners bind both modes until mentions cleanup completes.
  Invalid debounced ownership is refused before changes; disconnected closes
  remain durable. Configured owners missing a channel registration retain
  their binding and request a close retry; registered disconnected owners
  record a durable close and can release their binding. Saved bindings take
  precedence over
  registry replacement hints in both modes, unless explicitly abandoned by
  naming the saved owner. Owner records follow branch switches and free after
  rule/close cleanup even without subscription GC. Branch moves can forget
  bindings but leave the host-wide rule and open channel in place. Reapply
  affected modes to replace or remove old wrong-source rules, and remove
  hand-written workaround rules. Mentions naming a saved owner can release a
  missing-channel binding after rule removal and unpin, without a replacement
  or confirmed close; unconfirmed old-owner closes are reported, not claimed
  as closed. Without subscription GC, pin and unpin are successful no-ops and
  do not strand orphan records; results distinguish them from an actual unpin.
  Re-adding GC restores any previously persisted pin; ask the host operator
  to unpin with GC directly if ownership may have changed, rather than calling
  mentions on a replacement. See `docs/ATTENTION-AND-GATING.md`.
- **Operators:** The default-enabled `set_channel_mode` tool description and
  schema change on upgrade. Each wake-enabled resident's first request rewrites
  its prompt cache in full, even if residents never invoke the tool.
- **Recipe authors:** `modules.channelMode.serverId` is now only a legacy
  fallback for unregistered bare ids or its own namespace, not a server override
  for every call. Registry owners take precedence; use tool-call `serverId`
  for explicit ownership (after cleaning up any saved owner).
- Debounced setup now refuses disconnected or unregistered saved owners,
  in-progress new bindings, and new ids at the 1,024-owner cap. Reconnect and
  wait for registration, wait for setup to finish, or complete mentions cleanup
  for a tracked id to free capacity, respectively.
