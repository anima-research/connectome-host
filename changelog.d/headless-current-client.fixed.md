- A headless child stops treating a client as current once its socket closes,
  including a reset with no clean end, such as a parent that died with events
  still unread. A client superseded by a newer one can no longer command the
  child: what it sends afterwards is dropped and logged. Both mattered on
  runtimes with Node's socket semantics, such as Bun 1.4.2. There a reset
  socket stayed current, so telemetry kept going to it until the next client
  connected, and the disconnect was never logged. A superseded client's
  `subscribe` replaced the new client's filter, and its other commands still
  ran, though their answers were dropped. Bun 1.3.14 signals a reset socket's
  end and closes a superseded socket whole, so neither happened there.
