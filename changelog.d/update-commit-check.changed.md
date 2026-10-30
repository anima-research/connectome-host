- A release on trial now waits, before its commit, only for the MCPL servers
  it's configured with that the release before it had connected when it
  stopped for the switch or Go back, closed tabs aside. A server that was
  already down then, such as Discord with a token that no longer works, no
  longer holds every update back: the new release commits without it, and if
  it's still down its log names it and says why it didn't wait. A server the
  new release is configured with but can't connect, where the old one had it
  connected, still sends the next start back to the old release. The old
  release records its servers in the request it writes as it stops, so these
  still wait for every server, as before: the first update onto this release,
  asked by a release that doesn't record its servers; a Go back to a release
  from before this one, whose own check ignores the record; a Go back asked
  from a shell with `start.js --go-back`, which has no running host to ask;
  and a request whose record can't be read. The refusal then says that no
  readable record named the servers.
