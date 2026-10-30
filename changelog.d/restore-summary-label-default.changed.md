- An agent whose recipe sets no `summaryContextLabel` reads context-manager's
  default, "What do you remember from earlier?", before each summary of folded
  conversation again, as before 0.16.0. 0.16.0's host default label ("A summary
  follows, standing in for earlier conversation…") is withdrawn: the words a
  resident reads before its own memories are decided with the residents, per
  recipe (`summaryContextLabel`), not changed fleet-wide by a host default.
  0.16.0's other change in that release, summaries voiced by the agent's own
  name for an unnamed agent and for subagents, stays. Where prompt caching is
  on, an agent that ran 0.16.0 or 0.17.0 with no label of its own can't reuse
  its cache from the first label on, once.
