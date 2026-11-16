- **`agent.sameRoundSkipReplyTextPolicy`: `"private"`, the behaviour when
  it's omitted, or `"ask"`,** passed to Agent Framework's policy of the same
  name. Under `"ask"`, ordinary text that only a `skip_reply` in its round
  keeps back is held as a draft. Where some of it would have been posted or
  bounced without the `skip_reply`, the turn's first such `skip_reply` is
  refused once with a result that names the drafts and asks where they
  should go. Any other value is refused. `"ask"` is refused where the recipe runs the
  XML formatter, `formatter: "anthropic-xml"` with a provider other than
  `openai-responses` or `openai-codex`, since on that path the framework
  neither refuses nor holds.
