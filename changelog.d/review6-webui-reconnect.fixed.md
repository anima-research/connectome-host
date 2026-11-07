- A Web UI page that reconnects reads its open context panels (makeup and
  coverage, the compiled context, the pins) once at the new connection's
  welcome. It read none, so the makeup, the compiled context and the pins
  of a window another client moved while the page was away, by an undo
  say, stayed stale there until the panel was reopened or refreshed; the
  coverage figure caught up at the panel's next five-second poll.
