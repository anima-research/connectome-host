- **Operators:** `modules.mcplAdmin.surface` and `modules.webui.observersSurface`
  are no longer read (they chose between the tool list and `utils`); they're
  still accepted, with a `[deprecated]` startup line, so older recipes load.
- A subagent's orientation lists the tools its stream is shown as
  agent-framework presents them (`AgentFramework.presentedTools`, from
  0.29.0): tools in the built-in toolset and servers shown as tabs aren't
  among them, as they aren't in its first request, so the orientation and the
  first request agree.
- Texts that point an agent at `agent_settings` outside the settings toolset
  (a channel's auto-close notice, and the answers to an unknown reasoning or
  idle-limit tool) give its route: `toolsets--open {"toolset": "settings"}`,
  then `toolsets--act`.
- `mcpl-admin--mcpl_list` shows a closed tab as `CLOSED TAB` (disconnected
  until it's opened, or `mcpl_restart` connects it), and each server's
  configured `presentation` (the agent's own overlay entry where it defines
  the server, else the operator's definition, else `full`).
