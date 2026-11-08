- The Web UI's composer attaches images: pick them with `+ img`, paste them,
  or drop them on the composer. They are sent with the message and stored as
  image blocks ahead of its text, and show in the transcript like any other
  image, and in the TUI's history replay as a line such as
  `You: [2 images]`. The browser shrinks an image over 3.75 MB or 3,000 px
  on a side, converts formats the API doesn't take, such as BMP, and
  refuses a file that is cut short, or a PNG that fails its checksum; the
  host checks every image again and refuses, saying why, a message with an
  image in a format the API doesn't take, over 3.75 MB or 3,000 px on a
  side, or cut short or a damaged PNG, so no such image is stored. The
  browser redraws an animation as one still frame, marked
  "still frame", since Claude's docs say only the first frame is used; a
  host on `openai-responses` or `openai-codex`, where OpenAI's docs list
  only non-animated GIF, refuses an animated image from any client. A
  message the host refuses, or that the connection
  doesn't take, isn't lost: it stays in the composer, or in the transcript
  marked not sent with the host's reason, and one a reconnect can't confirm
  is marked so until its echo comes. Such a row stays through a change of
  session or branch too, naming the session or branch it was sent in while
  another is shown; only `/clear`, or a reload, drops it.
  Up to 8 images per message, and, under the host's own strategies
  (`autobiographical`, `frontdesk`), no more images or base64 than the
  recipe keeps live (6 images by default). Every image is held to 3,000 px
  on a side, which keeps it under Claude's stricter limit for a request
  carrying more than 20 images and under OpenAI's limit of 30,000 patches an
  image, whichever provider the recipe names later. Images can't be routed to a
  fleet child. A host whose recipe uses `passthrough`, which keeps every
  image in every request, takes no composer images. A message that would
  come near `imageStripDepthTokens` as soon as it is stored, where its
  images could reach the model only as a placeholder, is refused, asking for
  fewer images or less text with them and the rest once the agent has
  answered, and where a single image would, the refusal says the depth
  leaves too little room for an image, which whoever runs the host can
  raise.
  A message whose text and images together are over the 16 MiB one
  message can carry stays in the composer with a note, rather than being
  lost when the host closes the connection.
  The host now refuses, as an unknown message shape, a `user-message` frame
  whose `corrId` isn't a string, or whose `images` isn't an array of
  `{ mediaType, data }` strings; it took such a frame's text before. The
  refusal names the frame's `corrId` when that is a string.
  See `docs/webui-live-surgery.md`.
