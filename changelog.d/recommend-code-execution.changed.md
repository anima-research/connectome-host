- **The onboarding guide recommends code execution for every resident.** Its
  recipe skeleton includes `"codeExecution": { "enabled": true }`, with a section
  on what agent-framework's `code_execution` does (JavaScript that calls the
  agent's own tools in a QuickJS isolate; calls and intermediate results stay out
  of the context), its defaults, the cost of turning it on for a running resident
  (one full cache write), and the security note's caveat (no operating-system
  sandbox; containment is the engine's). The built-in default recipe still leaves
  it off. `index.ts` now passes the setting to `AgentFramework.create` through
  `codeExecutionOption(recipe)` in `framework-agent-config.ts`, with tests that
  the tool is offered when it is on and not when it is off or absent.
