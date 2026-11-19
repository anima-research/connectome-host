- **With agent-framework 0.35.0, three things an agent did without being
  asked now need a recipe key, and one notice changes its tag.** Nothing in
  a recipe has to change for it to load.
  - **An explicit send no longer holds back the agent's plain text.** Until
    now a `send_message`, `channel_publish`, `reply_message`, `send_dm`,
    `say`, `whisper` or `drafts` resend held, as drafts, the plain text the
    agent wrote in the same round and in the turn's later rounds, where
    that text would have landed where the send may have posted. Now that
    text is posted. **Who needs to act:** a host whose agent writes a note
    beside its sends ("sent", a summary of the message). **Migration:** set
    `agent.sendSilencing: true`, or let the agent set `send_silencing`
    through `agent_settings`.
  - **A turn no longer waits for the agent's compression call in flight.**
    It starts beside it, so its request can be larger by what that call's
    summary would have folded. **Who needs to act:** a host with an agent
    whose provider refuses a large call for how fast its input tokens per
    minute grow (Claude 3 Opus), or whose budget leaves its model's window
    no room for a chunk not yet summarized. **Migration:** set
    `agent.primaryWaitsForAuxiliary: true`.
  - **A turn whose context doesn't fit its budget while compression is
    pending waits for it** and tries again, where it ended with a failure.
    The wait has no time limit and is not kept across a restart. The agent
    is told once it has waited, in a `[budget-hold]` note.
  - **The note that marks turns set aside after a refusal opens
    `[turns-set-aside]`**, where it opened `[refusal-rewind]`. A host or
    tool that finds the note by its tag needs the new one.
