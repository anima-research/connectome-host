- **Operators:** 0.14.0's step to agent-framework 0.27.0, context-manager
  0.22.1 and membrane 0.7.2 changed more than its notes said.
  - **A recipe's `agent.retry` no longer applies to an agent's turns.**
    agent-framework now retries a turn itself, on membrane's default
    schedules: a 529 up to 7 tries over five to ten minutes, each wait between
    half and all of a step that doubles from 10 s to 5 minutes; a rate limit
    up to 5 tries; and any other retryable failure, such as a 5xx or a dropped
    connection, up to 3 tries, 1 s then 2 s apart. Under 0.13 releases,
    agent-framework retried a failed turn up to three times, 1, 2 and 4 s
    apart, and each try went through the host's own retries, up to three
    sends with a 529 retried as any other failure. Those counts and waits hold
    when the provider states no wait. A longer wait the provider states is
    waited instead: a resident is held for all of it before any retry counts,
    and a subagent's run waits up to ten minutes of it and ends on a longer
    one. Under 0.13 releases, agent-framework's own retries waited a stated
    wait in place of their 1, 2 and 4 s. `agent.retry` now applies only
    to the host's own provider calls: compression and merging, retrieval,
    session naming and the TUI's status line. The recipe documentation now
    says so.
  - **A live-image limit of 0 no longer turns the limit off.** For agents on
    the autobiographical strategy (the default) or frontdesk, a recipe's
    `agent.strategy.maxLiveImages` of 0 now keeps up to 500 live images, and a
    `maxLiveImageBytes` of 0 up to 24 MiB. These are context-manager's image
    ceilings, and a value above one is held to it. This host doesn't pass the
    ceilings, so a recipe can't raise them. The strategy warns at start about
    a value above a ceiling, and says once which ceiling it held a 0 to when
    that first leaves an image as a placeholder. A recipe that sets neither
    keeps the defaults, 6 images and 20 MiB, as before. The recipe
    documentation and the agents' memory guide now say so.
  - **A pin or document mark on a long message now covers the whole
    message.** Under adaptive resolution, which this host turns on for agents
    on the autobiographical strategy (the default) or frontdesk unless a
    recipe sets `adaptiveResolution: false`, a pin or mark the Pins panel made
    on a single message the store keeps in parts covered only its first part;
    it now covers every part. So the first compile after upgrading rewrites
    the request once, from that message on, or from earlier where older history
    folds further to make room for it. Where the whole message doesn't fit,
    the compile refuses as over budget, as for any pin the budget can't hold;
    where the plan's middle is what's over, the refusal names the mark and the
    tokens it keeps raw. Compression requests after the message carry it
    whole, so they cost more. A mark made as a long message arrived can leave
    parts no chunk holds, which compression requests carry without counting
    them against
    `compressionContextBudgetTokens`. Where those come to more than that
    budget, a summarizer with a smaller window would refuse those requests,
    and compression would stop making progress for that store unless
    `compressionSourceOnly` or `compressionSourceOnlyFallback` is set.
    Unpinning lets later requests leave them out, though a chunk already
    quarantined for them can stay quarantined.
  - **A pin at a level no summary supplies yet no longer stops every
    compile.** Under the kv-unified folding strategy, which adaptive
    resolution uses unless a recipe sets `foldingStrategy`, a pin or mark the
    Pins panel made at a level made every compile refuse as infeasible under
    0.13 releases while no summary over the pinned messages supplied that
    level. Such a pin now holds its messages at the deepest level a summary
    does supply, or raw, until the pinned level exists, and the log says
    `autobio: kv-unified holds pin …`. While it's held, the pin can take more
    of the budget than it asked for, and the compile can refuse as over
    budget.
  - **A channel an agent put in mentions mode before upgrading reads as one it
    closed itself.** agent-framework before 0.27.0 recorded the channel-mode
    module's close as the agent's own. So a resident's words there carry a
    note, unless it has turned `closed_channel_note` off, that it closed the
    channel and that `channel_open` opens it, which would undo only part of
    mentions mode. Calling `channel-mode--set_channel_mode` with
    `mode: "mentions"` for that channel again records the close as the
    module's, and the note stops.
  - **An MCPL server's `inference/request` is refused,** with a log line once
    per server naming `inferenceRouting`, which this host doesn't set and a
    recipe can't. 0.13 releases sent such a request to the provider under the
    model name `default`. So what 0.14.0's notes say of an MCPL server's
    inference, its `'updates'` thinking display, its cache write and its
    traces naming the model, doesn't happen on this host, and a refused
    request's trace names no model.
  - **Two membrane fixes reach this host.** Cache keepalive, on by default for
    the anthropic provider, now counts a cache's last use from when a request
    was sent rather than from its first answer, so a slow first answer no
    longer moves a refresh toward where it writes the cache instead of
    reading it. And membrane now strips `temperature`, `top_p` and `top_k`
    for Claude Opus 5 and Opus 5.5, which refuse them: lesson retrieval sends
    `temperature: 0`, so with `modules.retrieval.model` set to either model,
    its calls failed under 0.13 releases and now go through.
  - **One-time costs at upgrading.** agent-framework 0.27.0 changes the
    `channel_close` and `agent_settings` tool definitions, so each agent given
    either tool has its whole cached prompt written again at its first call.
    For an agent given `agent_settings`, that is the same write as the one
    0.14.0's notes give for `reasoning_display`'s description. With
    `modules.history.semantic`, each branch's summaries are embedded again
    under a new key, one embedding per summary; until a branch's summaries
    have been sent again, a search on it can miss one. Going back to a 0.13
    release with `/update back` leaves those summaries out of its searches
    until the index is rebuilt. The index lives in the embedding service, and
    neither `/update back`'s data restore nor any command of this host
    rebuilds it.
