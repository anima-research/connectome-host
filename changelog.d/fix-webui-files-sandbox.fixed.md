- **Web UI:** `/files/<mount>/<path>` serves a workspace file with the same
  isolation as `/media`: `Content-Security-Policy: default-src 'none';
  style-src 'unsafe-inline'; sandbox` and `X-Content-Type-Options: nosniff`.
  An HTML or SVG file an agent wrote no longer runs script on the Web UI's
  origin, where it could reach `/ws` with the operator's authority when the
  operator opened it. Files still display and download as before.
