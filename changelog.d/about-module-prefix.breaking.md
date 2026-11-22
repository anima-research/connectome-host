- **Recipe authors:** every host now has a module named `about`, so a host
  whose recipe gives an MCPL server the `toolPrefix` `about` stops at its
  start. agent-framework refuses a server's `toolPrefix` that meets a
  module's name, with `MCPL server "<id>" toolPrefix "about" collides with
  module "about"`. To migrate, give that server another `toolPrefix`.
  Unchanged: a server with no `toolPrefix` gets `mcpl--<id>`, which is
  never `about`, and no shipped recipe sets `about`.
