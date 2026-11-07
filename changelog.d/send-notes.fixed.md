- `connectome send` printed only the reply after the agent's last tool
  call, though it says it prints what the agent says until the turn's work
  ends: notes the agent wrote between tool calls never reached the person,
  and on a host with an MCP or MCPL server the agent was told they had no
  channel to go to. On such a host it now prints each note the framework
  routes as speech in the turn its line opens, as it comes, and holds each
  turn's reply until that turn's notes are in, printing it when the next
  turn starts or when the wait ends. A host with no MCP or MCPL server
  routes no notes, so there only replies print, as before. A turn that
  fails or is stopped, or under explicit prose routing one a tool ends,
  doesn't wait for its deliveries: a note of it
  still on its way can then print after its reply, or, once the wait has
  ended, not at all, and then the agent gets the framework's notice for it.
  A note never counts as a reply: a wait in which a turn gave up and no
  reply came, only notes, still says the turn ended without a reply and
  exits 1. A turn that printed a note and whose last round was empty exits
  0 and says nothing more: the line saying the turn ended without saying
  anything here is for a turn that printed nothing. The agent's receipt,
  when the turn writes one, names the terminal for a note it printed.
