- **Operators who run the host from a clone:** `bun install` no longer
  builds the Web UI, as the README used to say it did. After updating a
  clone, run `bun run build:web` in it, and again after each later update.
  Until then its Web UI serves the bundle it already had, or, with none,
  answers 503 and names that command. Installs from npm are unchanged:
  the package carries the Web UI built.
