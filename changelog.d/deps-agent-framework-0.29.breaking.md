- **Operators and residents, from agent-framework 0.29.0 (see its notes):**
  `@animalabs/agent-framework` is now ^0.29.0 (was ^0.28.0); `package-lock.json`
  and `bun.lock` move that package and nothing else. What changes for agents:
  - A turn the heartbeat opens (a tick or a reminder, with no channel) keeps
    its plain words as drafts instead of posting them to the channel that last
    had a message; a `[routing]` line says so up front. To reach someone from
    a heartbeat turn, send explicitly (a send tool or a `>>` destination).
  - Rarely used host tools move out of the tool list into the built-in
    `settings` toolset (`toolsets--open`, `toolsets--act`, `toolsets--look`,
    `toolsets--close`); the `utils` tool is gone. MCPL servers can be shown in
    full, as a tab, or as a closed tab (`presentation`, and
    `toolsets--close {server, disconnect}`).
  - MCPL RFC-014 tool hints are on by default for every server; `toolHints:
    false` opts one out.
