- A headless host now ends a turn its framework ran while it started, before
  its socket listened, in a `lifecycle:idle`, even one whose start came after
  the boot's held traces had filled their 1,000: `ready` says `idle: true`
  once the quiet after it has lasted 500 ms, or the idle follows `ready`.
  Before, no idle came until a `text` arrived, so a fleet parent's
  `fleet--await` on a child it had sent no text waited out its timeout, and
  `--exit-when-idle` didn't exit.
- `/newtopic` that fails while the host is stopping says the host is
  stopping, before what the reset said, rather than giving only the reset's
  error, such as one naming a branch generation and asking for a
  reinitialize.
