- A Web UI page signed in as an observer stopped reading `/healthz` when its
  first read, sent before its session cookie was set, was refused: its alert
  strip stopped updating, and Health showed the refusal until its Refresh.
  The page now reads again once the observer is signed in, and a refused
  read stops the page's reads only when no later read has passed.
