- **Dependencies:** `@opentui/core` moves to `^0.2.16` (from `^0.1.82`). From
  0.2.1 it depends on `diff` 9.0.0 and no longer on `jimp`, so installing the
  host no longer brings the versions of `diff`, `file-type` and `zod` 3 that
  published advisories cover. The Web UI is built with `dompurify` 3.4.17 and
  `solid-js` 1.9.18, whose `seroval` is 1.6.12, and the repository's lockfiles
  take `undici` 6.29.1, each within its existing range.
