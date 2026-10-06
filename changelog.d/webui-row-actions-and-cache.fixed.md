- WebUI: the rollback / suppress row actions now sit inside the message row
  (top-right, labelled) instead of hanging off its left edge, where the
  scroll pane's overflow clipping made them nearly invisible; the Context
  document's "roll back to here" is faintly visible before hover. The static
  server now sends `Cache-Control: no-cache` for `index.html` and
  `immutable` for hashed `assets/`, so a stale tab can no longer pin an old
  index/bundle pair across a bundle swap.
