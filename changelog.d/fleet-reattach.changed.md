- A fleet parent connects again to a running child that closed its
  connection without saying it was exiting, as a child does when another
  client connects to it, and when the parent has stopped reading long
  enough for the child to close a client that stops reading. Before, the
  child stayed ready with no connection: `fleet--send`, `fleet--command`
  and `fleet--relay` to it refused, saying it might be exiting, with
  `fleet--restart`, which stops the child, as the way on, and
  `fleet--await` waited out its timeout. A connect that fails is logged,
  and each `fleet--send`, `fleet--command`, `fleet--relay` and
  `fleet--await`, and each of the release switch's requests, that finds
  no connection tries once more. A connection that closes again within
  30 s of a connect is left closed, since another client may hold it: for
  30 s those four tools make no connect of their own and answer at once
  (`fleet--relay` once any connect under way to its other child has
  ended), saying so and from when they try again, while the release
  switch's requests still try, and a call made during such a connect
  waits for it when its answer depends on it. `fleet--await` answers at
  once for a child it can't reach, and the tool descriptions of
  `fleet--relay` and `fleet--await` say what they now do. A client
  attached to a fleet child by hand loses its connection when the parent
  connects again.
