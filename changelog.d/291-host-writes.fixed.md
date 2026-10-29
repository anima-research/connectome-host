- What the host writes into an agent's context is stamped for that agent and
  shown to it as agent-framework #291 shows any row: at once while the agent
  has no turn alive, and otherwise at a point of its turn that can carry it,
  never between rounds a request didn't carry. Each was stored straight into
  the agent's context, unstamped, which with each agent's window would reach
  every resident sharing the slot, and only at their next turn.
  - A host notice's marker (`modules.notices`) is written for its agent
    through the module's context, and so is the Web UI's opt-in notice that an
    operator changed the agent's context settings, through the settings
    module.
  - `/newtopic`'s `[Topic Transition]` row is the agent's own row: in its
    window, where its head window starts, and in no other resident's. It is
    stored only while the agent has no turn alive. A turn that started
    while a bare `/newtopic` wrote its summary used to get the row in its
    window between rounds its requests were sent without, and so did a turn
    whose continuation or retry was on its way when `/newtopic <text>` was
    given (the agent reads idle then, a budget restart's continuation
    queued or a provider hold's retry waiting); now the row follows the
    turn, and `/newtopic <text>` says it waits. If the agent is still busy
    ten minutes later, or the branch moved meanwhile, nothing is stored; a
    bare `/newtopic`'s answer gives the summary to pass as
    `/newtopic <text>`. A waiting `/newtopic` also stores nothing once the
    session or the branch is switched or the host stops, and a later
    `/newtopic` for the same agent replaces it, so one turn's end stores
    one transition.
  - A subagent's result or failure told straight to the agent that started
    it, when the run has no route of its own, is written for that agent, and
    tts-relay's note that a voiced reply was interrupted is written for the
    agent that spoke: the author of the published message it matched, else
    the agent voicing in its channel. Each was written for no agent, so every
    resident sharing the slot was shown it. An interruption whose speaker
    can't be named (no published message matched it, and no one registered
    agent was voicing in its channel) writes no note, and the log says why. One whose launcher, or the attempt that
    launched it, has ended (its line says `, which has ended` or `: launched
    by an attempt that has ended`) was written for no agent too. It is now
    written for the nearest agent above the launcher that agent-framework
    lists, such as the resident whose subagent launched it, or the current
    attempt of a run above it, else for the primary. It wakes nobody, as
    before.
  - A subagent's first rows (its orientation and task, a fork's copy of its
    parent's context, and the fork call and result a fork without one is
    given) are the subagent's own rows.
- `modules.retrieval` chooses lessons from the conversation of the agent whose
  request they go into, where it read the primary's for every agent.
- The store audit (`--audit-stores`, and a host on trial) opens the resident's
  namespace and, under the persistent reader, the subconscious's with the
  options agent-framework opens them with (`residentContextOptions`,
  `subconsciousContextOptions`), the recipe's `subconscious.name` included. Its resident view kept the other residents'
  stored context injections, and the subconscious had no view, so a store
  could be audited over messages a start's compiles leave out.
