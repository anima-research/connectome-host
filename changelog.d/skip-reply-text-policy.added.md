- **`agent.sameRoundSkipReplyTextPolicy`** is passed to Agent Framework's
  policy of the same name. Its values are `"private"`, the default, and
  `"ask"`. Any other value is refused.
  - Under `"ask"`, plain text beside a `skip_reply` becomes a draft. With
    native tools, the framework may refuse the turn's first such
    `skip_reply` once. It refuses only if the text would otherwise have been
    posted or bounced. The refusal names the drafts and asks where they
    should go.
  - With the XML formatter, nothing is refused, and all of the turn's unsent
    text is held when the turn ends.
  - Nothing is held while `proseRouting` is `"disabled"`.
  - The agent can see and change its own value through `agent_settings`.
    Agent Framework's range now starts at 0.35.1, the first release with
    both features.
