- The Web UI's composer attaches images: pick them with `+ img`, paste them,
  or drop them on the composer. They are sent with the message and stored as
  image blocks ahead of its text, and show in the transcript like any other
  image. The browser shrinks an image that is too big for the model API
  (over 3.75 MB or 8000 px on a side) and converts formats the API doesn't
  take, such as BMP, and refuses a file that is cut short or damaged; the
  host checks every image again and refuses a message whose image the API
  would refuse, saying why, so no such image is stored.
  Up to 8 images per message. Images can't be routed to a fleet child.
  See `docs/webui-live-surgery.md`.
