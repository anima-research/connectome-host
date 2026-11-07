- A headless host sends `inference:prose` (`agentName, content`) with the
  words of the primary's rounds that ended with tool calls, written when
  agent-framework routes them as speech and asks the host where they went
  (`Module.onSpeechRouted`, on a host that gives agent-framework an MCP or
  MCPL server), and only to the client that sent the turn while it is the
  connected client and subscribes. Words the framework keeps back, such as a
  round's that `skip_reply` or a private `think` keeps, are never sent. It
  is never a reply: `fleet--relay` and a parent's latest reply still read
  `inference:speech` alone.
