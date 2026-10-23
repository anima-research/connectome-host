- **Operators:** connectome-host now requires `@animalabs/agent-framework`
  ^0.26.1 (was ^0.26.0) and `@animalabs/context-manager` ^0.20.1 (was
  ^0.20.0), and both lockfiles hold them. What operators and agents meet, in
  brief; each package's notes give it in full:
  - **A reference in a module's content reaches a script without its URI.**
    In a module's result that reaches a script, an RFC-005 reference in its
    content blocks arrives without its URI, a `disposition: "never"` one
    included, as an MCPL peer's already did, since what a script prints comes
    back to the model. A result's `structuredContent` still reaches a script
    whole, as before.
  - **No repeated admissions.** A coalesced MCPL message whose receipt the
    host couldn't write, or couldn't make durable, is no longer admitted
    again each time its server retries it. On `channels/incoming`, such a
    failure now fails the whole request with a -32000 error, where it
    answered that message `accepted: false`, and the messages after it in
    the request aren't admitted until they're sent again.
  - **A turn waiting for its continuation is alive.** While a budget
    restart's or a tool-result guard's continuation waits to start, which a
    provider's stated wait can make long, the Web UI's host-mode quiesce
    waits for it, and the host's stop ends the turn as `shutdown` with the
    continuation dropped.
  - **Load repairs are reported.** context-manager 0.20.1 is the first
    release that reports a load's repair of an agent's summaries, which the
    `memory-load-repair` alert needs before it can send anything (its own
    entry says when it does).
  - **Compression.** A compression request no longer recalls summaries that
    start after the history it summarizes; a summary that straddles that
    history still brings its later part. After `/newtopic`, a compression or
    merge request for history from before it gets the head that history
    followed, not the new topic's opening (a source-only request carries no
    head, as before).
