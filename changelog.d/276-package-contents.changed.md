- **Anyone who ran the tests, or rebuilt the web UI, from the installed
  package:** the npm package now carries `src`, `recipes`, `scripts`,
  `docs`, `tsconfig.json`, the built web UI and the root docs, and no
  longer the test suite, the web UI's sources, `bun.lock`,
  `CONTRIBUTING.md` or the repository's CI and changelog files. Run the
  tests, or rebuild the web UI, from a checkout. Running the host from
  the npm package, its web UI included, is unchanged.
