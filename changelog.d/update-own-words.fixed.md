- When the install's host holds its lock for the whole wait, `bun start.js --go-back` names the install's own `connectome update back` as the host's way back. Before, it named `/update back`, which only the host's own terminal takes.
- When no release newer than the running one is installed, `/update restart` and `connectome update restart` each name their own way to install one first. Before, each named the Web UI's Update.
- The host logs an `[update]` notice when a newer release is offered. When the host couldn't read the installed releases, the notice now ends by saying so, and why. In that case, it also says that the release offered may be installed already. Before, it only said to install it and then restart.
- When the launcher refuses a switch or a Go back, its report names each way that an install offers to ask again:
  - Restart or Go back in the Web UI;
  - `/update restart` or `/update back` in the host's terminal;
  - the install's own `connectome update restart` or `connectome update back` in a shell;
  - for a Go back, the whole `bun <root>/start.js --go-back` command, with `--keep-data` where it kept the newer data.

  Before, it named only `/update restart`, `/update back` and a bare `--go-back`.
- The answers to the Web UI's own Update controls name the page's own controls, such as Update, Restart and Go back. Before, they named the host terminal's `/update` commands.
