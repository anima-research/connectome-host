- Headless and readline recipes can select `agent.execution: "native-cli"` to use
  logged-in Claude Code or Codex for authorization and provider inference. The
  selected CLI manages its context, while permitted Framework tools and stored
  conversation history remain available. Native completion and owned subprocess
  shutdown are recorded separately from Framework inference events.
