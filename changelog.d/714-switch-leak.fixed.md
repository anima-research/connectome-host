- Stop the new framework with a five-second shutdown budget when post-create
  setup fails during a session switch or at boot, including when committing the
  release at boot fails. If the stop fails or times out, log it and close the
  store if still open, without hiding the original error (#714).
