- `scripts/warmup-session.ts` no longer prints "Converged." over work it
  didn't do. It declares no tool definitions, so the first chunk whose
  compression request carries a tool call or result waits for them, with
  each later chunk whose request carries that one too, and on a Fable-
  or Mythos-family compression model every chunk and merge waits: it printed
  "Converged." with such work uncompressed, and its progress line counted it
  done. It now says "Not converged:", names the waiting work as
  context-manager describes it, says why and when the host compresses it,
  and exits 1, which the evacuator, when it runs the
  warmup, passes on as its own exit. Its progress line counts that work as
  waiting, not done.
