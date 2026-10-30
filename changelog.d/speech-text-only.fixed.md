- A headless host no longer writes its agent's thinking into
  `inference:speech`. With thinking on, the frame carried the thinking
  glued to the front of the reply, so `connectome send` printed it, and
  `fleet--relay` handed it to another child. The frame now carries the
  round's text alone, and what `connectome send` prints and what
  `fleet--relay` hands on change the same way.
- A headless host now sends `inference:speech` for every inference round
  that ends without tool calls outside a silent heartbeat (below), with `""`
  for one that had no text, where it
  sent nothing for such a round. So `fleet--relay` no longer hands on a
  child's earlier reply as its latest when its latest round said nothing:
  it relays nothing and says the latest round had no text. `connectome
  send` prints nothing for such a round, where with thinking on it printed
  the thinking. A turn that ends on a tool, such as `skip_reply`, still
  sends no frame.
- A headless host no longer sends `inference:speech` for a silent
  heartbeat's turn, which agent-framework marks `silent` as a wake that
  must not surface prose. `fleet--relay` handed that text to another
  child as the child's latest reply; the child's latest reply now stays
  its last one that wasn't silent, until this host connects to it again.
