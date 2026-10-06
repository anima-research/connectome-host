- Depend on released `@animalabs/agent-framework` 0.19.0. MCPL servers that
  announce a new channel from inside a tool call no longer deadlock against
  the host (agent-framework #160): in zulip-mcp, a stream the bot joined after
  startup stayed `Unknown channel` until a restart. Also brings the private
  `journal` tool beside `think` and `skip_reply`.
