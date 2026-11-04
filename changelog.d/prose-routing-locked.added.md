- Recipes accept `agent.proseRouting: "locked"` and `agent.proseLock`
  (agent-framework's locked prose routing: plain text goes to one destination
  the agent chose, and only its `prose_locus` tool moves it). `proseLock` is
  refused unless `proseRouting` is `"locked"`. A locked resident's subagents
  run `"disabled"`: a subagent has no lock of its own,
  so it publishes no plain text, and its result still reaches its parent. Needs the
  agent-framework release that adds the mode.
