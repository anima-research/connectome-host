- Channel attention modes route open, debounce source, and close to the
  channel's MCPL owner, not always Discord. Optional `serverId` disambiguates
  shared ids; saved owners bind both modes until mentions cleanup completes.
  Invalid debounced ownership is refused before changes; disconnected closes
  remain durable. Configured owners awaiting connection or registration retain
  their binding and request a close retry; saved bindings take precedence over
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
  Re-adding GC restores any previously persisted pin; call mentions with GC
  present to unpin if needed. See `docs/ATTENTION-AND-GATING.md`.
