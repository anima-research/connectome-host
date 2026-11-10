- The host's own small model calls, the session name (synesthete) and the
  TUI's fleet-view activity summaries, go to a model the recipe's provider
  serves: Claude Haiku on the `anthropic` route, as before, and the
  resident's own model elsewhere, or `sessionNaming.model` where a recipe
  names one (#649). Before, every provider was sent `claude-haiku-4-5-20251001`:
  Codex and OpenRouter refused it and the callers swallowed the error, so a
  session on such a host was never named and each try left an error row in
  llm-calls. A naming call that fails is now said once per process in the
  journal.
