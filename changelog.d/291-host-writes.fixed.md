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
    still has no turn alive and nothing moved meanwhile (the branch, the
    strategy, the session, the host's stop). Otherwise it stores nothing,
    and its answer gives the summary, when one was written, to pass as
    `/newtopic <text>`.
  - tts-relay's note that a voiced reply was interrupted is written for the
    agent that spoke: the author of the published message the heard words
    start, else the agent voicing in its channel. It was written for no
    agent, so every resident sharing the slot was shown it. An interruption
    whose speaker can't be named (no published message matched it, and no
    one registered agent was voicing in its channel) writes no note, and the
    log says why. Heard words that start no published message in the channel
    edit nothing: the relay used to edit the channel's latest published
    message to them, and tell that message's author.
  - A subagent's result or failure told straight to the agent that started
    it, when the run has no route of its own through agent-framework, and
    its launcher, or the attempt that launched it, has ended (its line says
    `, which has ended` or `: launched by an attempt that has ended`), was
    written for no agent. It is now written for the nearest agent above the
    launcher that agent-framework lists, such as the resident whose subagent
    launched it, or the current attempt of a run above it, else for the
    primary. It wakes nobody, as before. One whose launcher is listed was
    already written for it, and a run with a route of its own (a subagent
    agent-framework registered) still has its result held as mail for an
    ended launcher, which agent-framework delivers on adoption.
  - A subagent's first rows (its orientation and task, a fork's copy of its
    parent's context, and the fork call and result a fork without one is
    given) are the subagent's own rows.
