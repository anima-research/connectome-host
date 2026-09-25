- Recipe `proseOutbox: { enabled, maxAgeMs?, maxEntriesPerAgent?, maxEntries?, tools? }`
  turns on agent-framework's prose outbox: plain speech that couldn't be
  delivered (connector down, timed out) is kept and retried in order —
  and so are calls to the send tools listed in `tools` (e.g.
  `["send_message"]`), which answer "queued" instead of an error —
  without double posts, and the resident gets non-waking notices. Validated
  and passed through; the host refuses to start if a recipe enables it and
  the installed agent-framework doesn't support it (an older framework
  would silently ignore the key).
