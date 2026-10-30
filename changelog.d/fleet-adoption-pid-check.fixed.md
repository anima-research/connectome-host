- A host that restarts and finds a child's socket answered by a process
  that reports a pid other than the recorded child's no longer passes on
  anything that process sends, to the Web UI's fleet views among others:
  it checks the pid in the first line on the connection before it takes
  anything from it, as it does when it connects again to a running child.
  A connection that closes before that first line now fails the adoption
  at once.
