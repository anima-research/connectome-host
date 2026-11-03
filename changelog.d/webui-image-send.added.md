- The Web UI's composer attaches images: pick them with `+ img`, paste them,
  or drop them on the composer. They are sent with the message and stored as
  image blocks ahead of its text, and show in the transcript like any other
  image. The browser shrinks an image that is too big for the model API
  (over 3.75 MB or 8000 px on a side) and converts formats the API doesn't
  take, such as BMP, and refuses a file that is cut short, or a PNG that
  fails its checksum; the host checks every image again and refuses,
  saying why, a message with an image whose format, size or dimensions the
  API would refuse, or that is cut short or a damaged PNG, so no such image
  is stored. The browser redraws an animation as one still frame, marked
  "still frame", since Claude's docs say only the first frame is used; a
  host on `openai-responses` or `openai-codex`, where OpenAI's docs list
  only non-animated GIF, refuses an animated image from any client. A
  message the host refuses, or that the connection
  doesn't take, isn't lost: it stays in the composer, or in the transcript
  marked not sent with the host's reason, and one a reconnect can't confirm
  is marked so until its echo comes. Such a row stays through a change of
  session or branch too, naming the session or branch it was sent in while
  another is shown; only `/clear`, or a reload, drops it.
  Up to 8 images per message, and no more images or base64 than the recipe
  keeps live (6 images by default); a recipe that can keep more than 20
  live holds them to 2000 px on a side, under the stricter limit the model
  APIs apply to requests that carry that many. Images can't be routed to a
  fleet child. A host whose recipe uses `passthrough`, which keeps every
  image in every request, takes no composer images. A message that would
  come near `imageStripDepthTokens` as soon as it is stored, where its
  images could reach the model only as a placeholder, is refused: one with
  much text asks for the images first, in a message of their own, then the
  text once the agent has answered them, one whose images together come that
  near says how many fit and asks for the rest to be attached again after,
  as many at a time, each once the agent has answered (and, when its text
  leaves no room for even one, for the text after them, in a message of its
  own), and where a single image would, the refusal says the depth leaves
  too little room for an image, which whoever runs the host can raise.
  A message whose text and images together are over the 16 MiB one
  message can carry stays in the composer with a note, rather than being
  lost when the host closes the connection.
  The host now refuses, as an unknown message shape, a `user-message` frame
  whose `corrId` isn't a string, or whose `images` isn't an array of
  `{ mediaType, data }` strings; it took such a frame's text before. The
  refusal names the frame's `corrId` when that is a string.
  See `docs/webui-live-surgery.md`.
