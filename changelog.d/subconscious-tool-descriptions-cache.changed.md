- Residents whose recipe enables a `subconscious`: agent-framework 0.33.0
  changes the description of `tune_out`, which their requests carry, and
  of the reader's four tools (`cancel_tuneout`, `deliver_summary`,
  `note_disposition` and `speak_in_channel`), which every agent's requests
  carry with reader forks (`reader: "forks"`), and only a persistent
  subconscious's own requests carry otherwise. So where prompt caching is
  on, the first request after the update of each agent whose requests
  carry one of them writes its prompt cache in full, once: with a
  persistent subconscious, each resident's and the subconscious's.
- Residents whose recipe turns on `modules.history`: agent-framework
  0.33.0 changes the descriptions of `history--extract`,
  `history--search`, `history--overview` and, where it's configured,
  `history--semantic_search` (each says what it now marks and leaves out
  for the calling agent, and `history--extract`'s also how it shows a
  send and a result flagged as an error), so where prompt caching is on,
  such a resident's first request after the update writes its prompt
  cache in full, once.
- An agent whose `agent.allowedTools` list names `wake_add_rule` but not
  both `toolsets--open` and `toolsets--act`, with the wake gate on: the
  tool is in its tool list rather than the settings toolset, and
  agent-framework 0.33.0 changes its definition, so where prompt caching
  is on, its first request after the update writes its prompt cache in
  full, once. With both of those tools, the gate's tools stay in the
  settings toolset, out of the tool list.
