- Stop the new framework when setup fails during a session switch, so its MCP
  children and modules don't keep running. If stopping also fails, log that
  failure without hiding the original setup error (#714).
