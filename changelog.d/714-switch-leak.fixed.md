- Try to stop the new framework when setup fails at boot or during a session
  switch. Wait up to five seconds for cleanup, logging any failure or timeout
  without hiding the original setup error (#714).
