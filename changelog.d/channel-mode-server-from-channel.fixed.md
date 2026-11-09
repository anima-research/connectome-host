- Channel attention modes route open, debounce source, and close to the channel's
  MCPL owner, not always Discord. Optional `serverId` disambiguates shared ids;
  saved owners bind both modes until mentions cleanup completes. Invalid
  debounced ownership is refused before changes; disconnected closes remain
  durable. Owner records follow branch switches and free after rule/close
  cleanup even without subscription GC. Reapply affected modes to replace or
  remove old wrong-source rules, and remove hand-written workaround rules.
  Mentions can release deregistered or removed owners after rule removal and
  unpin, without a replacement or confirmed close; unconfirmed old-owner closes
  are reported, not claimed as closed. Without subscription GC, unpin is a
  successful no-op and does not strand orphan records; results distinguish it
  from an actual unpin. Re-adding GC restores any previously persisted pin;
  call mentions with GC present to unpin if needed. See
  `docs/ATTENTION-AND-GATING.md`.
