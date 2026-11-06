- `agent.speculativeChannelChunks` (boolean, off when omitted) passes
  agent-framework's `AgentConfig.speculativeChannelChunks` through: a
  `channel_publish` call's text streams to a channel declaring
  `streaming: { speculative: true }` while the model writes it. Needs an
  agent-framework that has the option; older ones ignore it.
