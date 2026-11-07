- Residents: on a host with an MCP or MCPL server, a reply a host surface
  showed the person who sent the turn is no longer reported undeliverable.
  Each surface's text now records
  which surface sent it, and for headless and the Web UI which connection.
  When the agent-framework release with `Module.onSpeechRouted` asks where a
  turn's plain speech went, each surface whose text opened the turn answers
  for what reached it: `connectome send` and other headless clients
  subscribed to `inference:speech` for the primary's final reply written to
  them ("the terminal that sent this turn (`connectome send`)", or "… now
  connected …, not the one that sent this turn"); the client that sent the
  turn for a round's words written to it as `inference:prose`; readline and
  batch mode ("the terminal this host runs in", or "this host's standard
  output"); the TUI for its root agent ("the TUI"); and a Web UI page while
  it is open, for the agent its pages show ("the Web UI page that sent this
  turn", or "a Web UI page open now, not the one that sent this turn"). A
  turn with no channel that writes a receipt then gets a `[delivered]`
  receipt naming the surface instead of a `[send-undeliverable]` notice (a
  turn that is stopped writes none), and a turn whose speech went to a
  channel names the surface beside the channel; one whose channel post
  failed names it in its receipt, and the failed post keeps its own notice.
  Where no surface that opened the turn showed its speech, as for a turn no
  surface opened, a turn with no channel still gets the notice, which says
  another surface may have shown it.
- Residents: a text from a fleet parent no longer carries the
  "[host note: this message arrived over IPC …]" paragraph, which said a
  plain-prose reply would not reach the sender: a parent subscribed to
  `inference:speech` gets the primary's final reply while it is the host's
  connected client. On a host with no channel server, an agent answering a
  client not subscribed to it is no longer told that its reply won't reach
  that client.
- Operators: `connectome-doctor` reads the routing lines the
  agent-framework release with `Module.onSpeechRouted` adds. For a turn with
  no channel whose speech a host surface showed, its routeSpeech stage says
  where it was shown, and for a reply its agent's replacement kept from being
  routed, it says so, where it showed the line's last 60 characters.
