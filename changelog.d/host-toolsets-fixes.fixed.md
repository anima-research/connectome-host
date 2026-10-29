- **Agents:** a text that sends an agent to a tool in the built-in `settings`
  toolset says how to reach it from that agent's seat:
  `toolsets--open {"toolset": "settings"}`, then
  `toolsets--act {"tool": ..., "args": {...}}`, or, for an agent whose tool
  list lacks `toolsets--open` or `toolsets--act`, a call by the tool's own
  name, since agent-framework presents the toolset only to an agent that may
  call both. That covers an unknown tool's answer, identity's notes, the
  settings and subscription-gc answers, a channel's auto-close notice,
  `lifecycle--restart`'s pointer to `mcpl-admin--mcpl_restart`, the subagent
  `tools` description, the shipped clerk recipe's prompt and the agent-facing
  docs.
- **Agents:** `mcpl-admin--mcpl_deploy` describes `presentation` as
  agent-framework 0.29 applies it: a tab's tools start out of the tool list,
  `toolsets--open {"server": id}` lists them for `toolsets--act`, and
  `toolsets--open {"server": id, "full": true}` puts them back in the list; a
  closed tab also starts out disconnected; an agent that may not call both
  `toolsets--open` and `toolsets--act` isn't shown tabs. Its answer for a
  server saved as a tab or closed tab says so, and `mcpl-admin--mcpl_list`
  says its `presentation=` is the configured one, not necessarily how the
  server is shown to the agent now.
- **Agents:** a spawn's or fork's prompt-size check no longer counts the tools
  its first request leaves out, such as module utilities and, for a stream
  that may call both `toolsets--open` and `toolsets--act`, the built-in
  toolset's tools, so it no longer refuses a launch for their size (#511).
- **Agents whose requests carry a changed text:** the descriptions of
  `lifecycle--restart` and `subagent--spawn`'s `tools` parameter change, and so
  do `mcpl-admin--mcpl_deploy`'s, which is in the tool list of an agent that
  may not call both `toolsets--open` and `toolsets--act`, and the shipped clerk
  recipe's prompt. Where prompt caching is on, such an agent's first request
  after the update writes its cache in full.
- **Operators:** the Web UI's MCPL panel shows a closed tab as one, grey and
  labelled, rather than as a server that failed to connect.
