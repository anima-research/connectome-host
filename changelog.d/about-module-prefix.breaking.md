- **Recipe authors:** every host now has a module named `about`, so a host
  whose recipe gives an MCPL server the `toolPrefix` `about` stops at its
  start. agent-framework refuses a module and a server's `toolPrefix` that
  meet, with `Module "about" collides with MCPL server "<id>"'s toolPrefix
  "about"`. To migrate, give that server another `toolPrefix`. Unchanged: a
  server with no `toolPrefix` gets `mcpl--<id>`, which is never `about`,
  and no shipped recipe sets `about`.
