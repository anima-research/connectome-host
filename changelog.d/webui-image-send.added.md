- The Web UI's composer attaches images: pick them with `+ img`, paste them,
  or drop them on the composer. They are sent with the message and stored as
  image blocks ahead of its text, and show in the transcript like any other
  image. The browser shrinks an image that is too big for the model API
  (over 3.75 MB or 8000 px on a side) and converts formats the API doesn't
  take, such as BMP, and refuses a file that is cut short, or a PNG that
  fails its checksum; the host checks every image again and refuses a
  message whose image the API would refuse, saying why, so no such image is
  stored. An animation sent as it is is marked "first frame", since the
  model sees only that. A message the host refuses, or that the connection
  doesn't take, isn't lost: it stays in the composer, or in the transcript
  marked not sent with the host's reason, and one a reconnect can't confirm
  is marked so until its echo comes. Such a row stays through a change of
  session or branch too, naming the one it was sent in; only `/clear`
  drops it.
  Up to 8 images per message, and no more than the recipe keeps live (6 by
  default); a recipe that can keep more than 20 live holds them to 2000 px
  on a side, under the stricter limit the model APIs apply to requests that
  carry that many. Images can't be routed to a fleet child.
  A message whose text and images together are over the 16 MiB one
  message can carry stays in the composer with a note, rather than being
  lost when the host closes the connection.
  See `docs/webui-live-surgery.md`.
