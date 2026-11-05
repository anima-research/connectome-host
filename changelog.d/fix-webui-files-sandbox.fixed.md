- **Web UI:** `/files/<mount>/<path>` serves a workspace file with
  `X-Content-Type-Options: nosniff` and a sandboxing
  `Content-Security-Policy` (`sandbox allow-same-origin`, without
  `allow-scripts`). An HTML or SVG file an agent wrote no longer runs script
  when the operator opens it, where before its script ran on the Web UI's
  origin and could reach `/ws` with the operator's authority. Such a page
  still shows its text and inline styles, stylesheets from the Web UI's
  `/files/`, and images, fonts, audio and video from its `/files/` or
  `data:` URLs. Its scripts, forms, frames that load a page, a link in it
  that opens a new window, and a download it starts no longer work, and it
  loads nothing from another host, nor from a Web UI route other than
  `/files/` and the static app shell; a plain link in it still navigates the
  tab. A download from a file's own `/files/` URL isn't affected.
