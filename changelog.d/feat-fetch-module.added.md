- **`modules.fetch`: a fetch tool, off by default.** `fetch--fetch` reads a web
  page as text, with HTML turned into markdown, either whole or through a small
  model that answers a `prompt`, and every result says which part was read.
  With `local: true` it reads workspace files too, with the workspace's own
  `read`, so it shows what `workspace--read` shows and reaches nothing the
  mounts don't allow. It reaches only public addresses unless
  `allowPrivateNetwork` is set, checked by the address connected to on every
  redirect, and untrusted HTML is converted in a separate process with time and
  memory limits. A recipe on a provider other
  than `anthropic` or `mock` sets `modules.fetch.model`.
  Recipes that don't set `modules.fetch` are unchanged. New dependency: `turndown`.
