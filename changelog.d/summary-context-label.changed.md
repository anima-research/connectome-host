- An agent whose recipe uses the host's autobiographical or frontdesk
  strategy and sets no `summaryContextLabel` now reads "A summary follows,
  standing in for earlier conversation, tool calls and results included.
  The exact text it replaces isn't shown." in the `Context Manager` turn
  before each summary of folded conversation, where
  context-manager's default asked "What do you remember from earlier?".
  That's under adaptive resolution, the default. With adaptive resolution
  off, a recipe with `positionedRecallPairs: false` reads it once, before
  its combined summaries, and one that keeps positioned pairs shows
  `recallHeaderTemplate` there instead, as before. A recipe's own label is
  kept.
- The new label takes about 33 more tokens of the context budget each time
  it shows, by context-manager's estimate (45 against 12): once for each
  summary under adaptive resolution, and once for each combined block when
  adaptive resolution is off and `positionedRecallPairs` is false.
  context-manager also prices each positioned pair with the label where it
  shows `recallHeaderTemplate`, so those pairs take the same 33 more tokens
  of budget, though what the agent reads there doesn't change. Where prompt
  caching is on, an agent's first request after the update that shows the
  label can't reuse its cache from the first label on.
