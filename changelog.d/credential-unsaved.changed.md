- A refreshed or pasted Anthropic credential that the host can't write
  back to its file no longer prints `[anthropic-credentials] credential
  rotated in memory but not written to …` on stderr: the
  `credential-unsaved` ops alert says it instead. An `/auth` action's
  outcome no longer ends with `; WARNING: …` about it, so the Web UI's
  Health section, whose last action showed that warning, no longer shows
  it; `/auth status` and each `/auth` action's answer print it while it
  stands.
