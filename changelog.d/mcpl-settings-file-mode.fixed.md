- `mcpl-servers.json` and `mcpl-servers.agent.json`, when a save creates
  them (a `/mcp` command or the Web UI's MCPL editor, or an agent's deploy
  or unload), are now created readable and writable by their owner alone,
  as a saved recipe is, since an entry can hold a token or another
  credential. Before, they took the umask's default, commonly readable by
  every user. A file that's already there keeps its mode: to make one
  private, `chmod 600` it.
