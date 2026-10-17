- **More from agent-framework 0.22.2 that operators may notice:**
  - On a workspace mount of more than 5000 files (links and other entries
    that aren't directories count too), the first syncs and catch-up scans
    after the upgrade catch up on what 0.22.1's walks, which stopped at
    5000, never reached, up to the mount's walk cap in each pass. Each pass pushes one event for each kind of change it
    finds, and where the mount's `wakeOnChange` admits that kind, each
    event is a message to the agent.
  - A coalesced MCPL message with inline images is admitted like any other
    message, where 0.22.1 refused one whose content passed 1 MiB with its
    images.
  - Going back to an earlier connectome-host release, on agent-framework
    0.22.1 (this one requires 0.22.2): if agent-framework logged an
    `[agent-settings]` line saying a setting stays set but unapplied, reset
    it first with the `agent_settings` tool's reset, since 0.22.1 refuses
    to start with it.
