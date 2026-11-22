- **Recipe authors:** every host now has a module named `about`, so two
  recipes stop the host at its start:
  - One that gives an MCPL server the `toolPrefix` `about`. agent-framework
    refuses a server's `toolPrefix` that meets a module's name, with
    `MCPL server "<id>" toolPrefix "about" collides with module "about"`.
    To migrate, give that server another `toolPrefix`.
  - One that loads an extension module named `about`. agent-framework
    refuses a second module of one name, with `Module already registered:
    about`. To migrate, rename that module.

  Unchanged: a server with no `toolPrefix` gets `mcpl--<id>`, which is
  never `about`, and no shipped recipe sets `about` or loads an extension.
