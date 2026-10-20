- **More from agent-framework 0.22.3 and 0.22.4 that operators and residents
  may notice:**
  - A resident whose context holds a `redacted_thinking` block that
    agent-framework stamped with its token estimate is no longer refused at
    every request until that turn leaves its context (0.22.4). The framework
    stamps a thinking block it stores when the reply's output tokens exceed
    what its visible blocks account for, and the stamp went out with a
    `redacted_thinking` block, which the Messages API refuses.
  - Tool definitions change. The workspace `read` tool's `offset` and
    `limit`, and `grep`'s `contextBefore` and `contextAfter`, take integers,
    the channel and history tools' descriptions are reworded, and a resident
    with MCPL channels configured gains a `drafts` tool (`list`, `read`,
    `resend`, `dismiss`) where its tool rules allow it. So a resident shown
    any of these tools misses the prompt cache once, on its first request
    after the upgrade.
  - Plain speech that routing holds back is kept as a draft its resident
    can read and resend, where only its count was kept.
  - A tool's refusal reaches the model as an error result, such as
    `tune_out`'s, `channel_open`'s on a tuned-out channel and the
    subconscious's refusals, where the model read it as the tool's answer.
  - `skip_reply`'s `wake_in_seconds` takes a number of seconds from 1, as a
    number or as text such as `"90"`, and waits at most 3600. A value it
    can't read that way is refused without ending the turn, and so is any
    value while the recipe sets `modules.wake` to `false`, since nothing can
    then set the timer. Left out or `null`, the call ends the turn without a
    wake.
  - A switch that agent-framework takes as `true`, `false` or `null` (unset)
    stops the boot with the framework's words, naming the switch, when it's
    written as anything else, such as `"false"`. The host's recipe check
    already refuses most such switches. The ones it passes on unchecked are
    an agent's `refusalHandling.autoRewind` and an MCPL server's `reconnect`,
    in `mcpl-servers.json` or a recipe's servers, which 0.22.2 read by their
    truth, so that `"false"` turned them on; and `allowHostCommands` on a
    server only a recipe defines, which 0.22.2 took as granting only when it
    was `true` (`mcpl-servers.json` doesn't carry it). Write `true` or
    `false` without quotes.
  - A stored state that the framework can't read stops the boot, naming it
    and what to do, where it was taken as empty and the next write replaced
    it: the host mode, the queue of deferred context writes, usage totals,
    an agent's persisted runtime settings, tool-result guards, MCPL
    coalescing state and checkpoint trees, and an MCPL feature set's state.
    As before, a record of provider waits that can't be read doesn't stop
    the boot: no provider call is made until it can be read or an operator
    releases the waits.
  - Quiesce writes the queue of deferred context writes first, and is refused
    when the queue can't reach disk. The Web UI shows the refusal in the
    framework's words, which name quiescing with `abandon: true` as a way
    out; the Web UI doesn't offer that.
  - Escape and the Web UI's interrupt also stop a turn at the boundary after
    a round's tools, where the turn went on, and a stop is no longer recorded
    as an inference failure.
  - A file the workspace writes keeps its permission bits.
