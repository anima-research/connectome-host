- A headless host closes a socket client that stops reading. Before, it kept
  every event it couldn't write to that client in memory for as long as the
  client stayed connected, without bound: a fleet parent whose process was
  stopped, or any other client stopped with Ctrl-Z, grew the host's memory
  by every event the host emitted meanwhile, and a second client connecting
  didn't free it. Now, once a client's socket refuses a write, it has five
  minutes to empty the host's queue for it; a client whose queue the host
  still holds then is closed, and the host's log says how much was left
  unsent. A client that keeps up is never closed; one that reads but can't
  keep up with the host's events is. A fleet parent closed this way finds
  its child ready with no connection to it, as it does when another client
  takes the child's socket. When `connectome send`'s connection closes after
  the host said it was ready, it names this among the reasons a connection
  closes, as when the command was suspended.
