- Installed from npm with npm 12 or bun, the host has its web UI: the
  package now carries it built, in `dist/web`, where it used to rely on a
  `postinstall` to build it, which npm 12 and bun don't run for a
  dependency (#276). The `postinstall` stays for checkouts, where `web/` is
  and it builds the web UI. In an install from npm it does nothing, and npm
  12 and bun may report it as blocked; nothing is lost. The host's warning
  and 503 page for a missing web UI now say to rebuild it in a checkout and
  to reinstall an installed package.
