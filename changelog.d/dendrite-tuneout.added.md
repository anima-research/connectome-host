- Tune-out mk2 recipe surface (agent-framework#546): `subconscious.reader: 'forks'`
  runs the tune-out reader as a succession of forks of the resident (`model`
  and `voice` required; the host supplies the per-fork strategy factory the
  way it does for `conversations`); top-level `speech.locus` (`delivery` |
  `latest-inbound`) chooses where plain prose lands when nothing names a
  destination; top-level `tuneOut.enabled` offers `tune_out` / `focus` without
  a reader (a silent hold). The recipe fields are typed from the framework's
  own config and need the agent-framework release that carries #546; the
  dependency range rises with it.
- The framework's speech rule changes with that release: plain prose with
  nothing naming a destination lands by `delivery` (the waking delivery's
  channel, a fork's home channel, or a channel opened this turn; with none,
  the prose stays private and a `[routing]` notice says so). A recipe that
  leaves `speech.locus` unset gets the new rule; `"speech": { "locus":
  "latest-inbound" }` keeps the previous one.
- What a forked or spawned stream is told at its start is a recipe policy,
  `modules.subagents.orientation` (`full`, the default, or `none`). The host
  carries no consent gate on reader forks: the framework attaches no
  consent model to a derivation and offers `dendrite.beforeDerive` and
  `dendrite.derivationNotice` to a deployment that wants one, and a consent
  module is to come as a package of its own (tel0s, Antra and Ra,
  2026-10-19). What the host guarantees instead: a reader fork can post
  nowhere unless `subconscious.allowChannelSpeech` is on.
