- **Operators:** a server's `presentation` in recipes and `mcpl-servers.json`
  (`"full"`, the default, `"tab"` or `"closed-tab"`), passed through to
  agent-framework's host toolsets (0.29.0): how agents are shown the server at
  first. `"tab"` keeps it connected with none of its tools in the tool list
  until an agent opens it (`toolsets--open {"server": "<id>"}`); `"closed-tab"`
  leaves it disconnected until an agent opens it. Each agent can switch later,
  and its choice is kept over this default. A recipe naming a
  `mcpl-servers.json` server may override it. Any other value stops the load,
  naming the key; in the agent's own overlay it's left out, named in a startup
  line. An earlier agent-framework ignores it.
- **Agents:** `mcpl-admin--mcpl_deploy` takes `presentation` (`"full"`,
  `"tab"` or `"closed-tab"`), saved to the agent overlay and applied to the
  server it connects; another value refuses the deploy, naming the values.
