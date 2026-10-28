- A recipe that uses the host's autobiographical or frontdesk strategy and
  sets neither `agent.name` nor `summaryParticipant` now has its agent's
  summaries voiced by the name the agent runs under (an imported session's
  name, or `agent`), as the agent's own turns. Before,
  they took context-manager's default participant, `Claude`, so the agent
  read its own recollections in a user turn as "Claude: …". The compiled
  context of such an agent changes from its first summary on, so where
  prompt caching is on, its first request after the update that shows a
  summary can't reuse its cache from there. A conversation's agents keep
  the voice they had.
- Under the frontdesk strategy, such an agent's compression now tells the
  agent's own messages apart when it lists the questions a summary is asked
  to keep verbatim. A question or mention followed by one of the agent's
  messages within the next eight is no longer listed, and neither is a
  question the agent asked. Before, every question and mention was listed.
- A subagent's summaries, spawned or forked, are now voiced by the name it
  runs under, as its own turns. Before, they read as "Claude: …" in a user
  turn.
