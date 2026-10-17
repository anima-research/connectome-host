- The `notices` module now tells a person who writes to the agent from a
  channel it hasn't opened, such as a mention in a closed channel or a first
  DM, that it can't respond during an outage. Those messages reach the host
  as push events, and the module answered only `channels/incoming`, so such
  a writer was told only when a turn their message started failed (#286).
  A push counts when it's addressed to the agent and tagged
  `chat:from-human`: a bot's mention, or a server's summary of missed
  messages, gets no line. `reply.in`, which matches every channel unless the
  operator narrows it, decides which channels are answered, as for incoming
  traffic. On a Zulip stream the agent hasn't opened, the host can't name
  the topic the person wrote in, so the line lands in whichever topic
  zulip_mcp gives a publish with no routing hints: on its `main` now, the
  topic named `mcpl`.
  The `activity` module takes typing's routing hints, such as a Zulip topic,
  from those messages too, as it takes them from `channels/incoming`.
