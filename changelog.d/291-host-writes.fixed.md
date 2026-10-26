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
    window, where its head window starts, and in no other resident's.
  - A subagent's first rows (its orientation and task, a fork's copy of its
    parent's context, and the fork call and result a fork without one is
    given) are the subagent's own rows.
- `modules.retrieval` chooses lessons from the conversation of the agent whose
  request they go into, where it read the primary's for every agent.
- The store audit (`--audit-stores`, and a host on trial) opens the resident's
  and the subconscious's namespaces with the options agent-framework opens them
  with (`residentContextOptions`, `subconsciousContextOptions`), the recipe's
  `subconscious.name` included. Its resident view kept the other residents'
  stored context injections, and the subconscious had no view, so a store
  could be audited over messages a start's compiles leave out.
