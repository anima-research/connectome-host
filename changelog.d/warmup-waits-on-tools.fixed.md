- `scripts/warmup-session.ts` no longer prints "Converged." over work it
  didn't do. It declares no tool definitions, so a chunk whose compression
  request holds a tool call or result, and any chunk or merge on a Fable- or
  Mythos-family compression model, waits for them: it printed "Converged."
  with such work uncompressed, and its progress line counted it done. It now
  says "Not converged:", names the waiting work as context-manager describes
  it, says why and that the host compresses it once it declares the agent's
  tool definitions, and exits 1, which the evacuator, when it runs the
  warmup, passes on as its own exit. Its progress line counts that work as
  waiting, not done.
