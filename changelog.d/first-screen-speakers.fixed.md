- The TUI's session history and the Web UI's conversation call a message
  "you" only when it came in as the host's own input: typed in the TUI or
  the Web UI, a piped line, or a fleet parent's message to its child. The
  host's own messages read as the host's, by kind: agent-framework's clock
  and notices, and the host's notes of a session's start time, a restart
  it asked for, a subagent's return or failure and a voice reply cut off,
  which now carry `hostNote` in their metadata. A channel message reads as
  its author's in its channel, and a push as the author it names or else
  as its server's. Anything else, such as an imported history, reads as
  `user`. Before, every one of them read "You:" in the TUI and "you" in
  the Web UI. The host's notes stored before this release carry no
  `hostNote`, so they read as `user`, and so do typed messages stored
  before agent-framework 0.22.3 marked where input came from. The Web
  UI's message entries carry who each `user` entry is as `speaker`. The
  model's requests are unchanged.
- A turn the framework retries shows a repeated failure once: the TUI
  updates the line's count in place (`Error (×3): …`), and batch mode
  prints nothing more until the failure's words change. When the turn
  gives up, a line says how many attempts it made and what to check: for a
  network failure or a timeout, the network, any proxy and the provider's
  base URL setting (its host when it's set, or that it isn't); for an
  authentication failure, the credential the host used.
