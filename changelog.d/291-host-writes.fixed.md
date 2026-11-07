- What the host writes into an agent's context about that agent is stamped
  for it and shown to it as agent-framework #291 shows any row: at once while
  the agent has no turn alive, and otherwise at a point of its turn that can
  carry it, never between rounds a request didn't carry. Each was stored
  straight into the agent's context, or written for no agent, which with
  each agent's window would reach every resident sharing the slot. The
  session's start time and the note after a self-restart are for every
  resident, and are still written for no agent.
  - A host notice's marker (`modules.notices`) is written for its agent
    through the module's context, and so is the Web UI's opt-in notice that an
    operator changed the agent's context settings, through the settings
    module.
  - `/newtopic`'s `[Topic Transition]` row is the agent's own row: in its
    window, where its head window starts, and in no other resident's. It is
    stored only while the agent has no turn alive. A turn that started
    while a bare `/newtopic` wrote its summary used to get the row in its
    window between rounds its requests were sent without, and so did a turn
    whose continuation or retry was on its way when `/newtopic` was given
    (the agent reads idle then, a budget restart's continuation queued or a
    provider hold's retry waiting). Now `/newtopic` is refused while a
    continuation or a retry of the agent's turn is on its way, and a bare
    `/newtopic` stores its summary only if, once it is written, the agent
    still has no turn alive, no row entered or left its window, and nothing
    moved meanwhile. A branch or strategy change while it is written leaves no
    summary: context-manager refuses one written across either, so nothing
    is stored and the answer says it couldn't be written. A turn's start,
    rows entering the agent's window (a turn that started and ended, or
    another `/newtopic`'s transition: the answer says `rows entered
    <agent>'s window`), rows leaving it (an undo or a shed: `rows left
    <agent>'s window`), both (`rows entered <agent>'s window and rows left
    it`), rows that come and go and leave the window holding what it held,
    as a turn and its undo or an undo and its redo do (`rows entered
    <agent>'s window and left it, or left it and entered it again`), a
    session switch or the host's stop meanwhile
    stores nothing either, and the answer gives the written summary back
    to run as `/newtopic <text>`: as written in the TUI, the Web UI and the
    headless mode, which send a multi-line command whole, and in the
    readline and piped modes as a one-line `/newtopic <text>`, its line
    breaks folded to spaces, since they read each line as its own input: a
    summary given back on several lines stored its first line alone there,
    and sent the rest to the agent. One given back as the TUI stops
    is printed to the terminal the TUI leaves, if it comes before the host
    exits, as any command's answer that comes then now is: the TUI dropped
    it, its scrollback gone. That answer names the stop once and says to
    store the summary after the restart. `/newtopic <text>` stores its
    text as given, but for the white space at its two ends, its line breaks
    included (a multi-line one needs the TUI, the Web UI or the headless
    mode, which send it whole), where it joined its words with single
    spaces.
  - tts-relay's note that a voiced reply was interrupted is written for the
    agent that spoke: the author of the published message the heard words
    start, else the agent voicing in its channel. It was written for no
    agent, so every resident sharing the slot was shown it. An interruption
    whose speaker can't be named (no published message matched it, and not
    exactly one agent, still registered, was voiced in its channel; or the
    heard words start messages by more than one agent, by an agent no longer
    registered, or messages there by another agent are no longer kept)
    writes no note, and, while `notifyOnInterruption` isn't `false`, the log
    says why. Heard words that start no published message in the channel
    edit nothing: the relay used to edit the channel's latest published
    message still kept, if any, to them.
  - A subagent's result or failure told straight to the agent that started
    it, when the run has no route of its own through agent-framework, and
    its launcher, or the attempt that launched it, has ended (its line says
    `, which has ended` or `: launched by an attempt that has ended`), was
    written for no agent. It is now written for the nearest agent above the
    launcher that agent-framework lists, such as the resident whose subagent
    launched it, or the current attempt of a run above it, else for the
    primary. It wakes nobody, as before. One whose launcher is listed was
    already written for it, and a run with a route of its own (a subagent
    agent-framework registered) still goes where agent-framework routes it:
    held as mail for its launcher if that launcher has since ended
    (delivered on adoption), or, for a launch that waited for a slot past
    its launcher's end, to the launcher's nearest live ancestor.
  - A subagent's first rows (its orientation and task, a fork's copy of its
    parent's context, and the fork call and result a fork without one is
    given) are the subagent's own rows.
- A subagent run that ends on a tool call, with no speech, answers with the
  newest text its window holds that isn't the user's or a stored
  injection's (and `(no text output)` when there is none): a text row an
  undo or a shed took out of
  it, or one stored and never shown to it (another agent's mail held out of
  it past the run's end), was the answer.
