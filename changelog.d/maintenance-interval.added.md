- Recipes accept a top-level `maintenanceIntervalMs`: how often
  agent-framework runs its context maintenance pass, in milliseconds, as a
  whole number from 0 to 2147483647; any other value stops the load, naming
  the key. Left out, the framework's 5000 ms stands, as before. 0 turns the
  pass off, for short runs such as test fixtures; the README's Recipes
  section says what waits without it.
