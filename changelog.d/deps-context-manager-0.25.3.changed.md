- **connectome-host takes context-manager 0.25.3 or later in the 0.25
  line** (it took 0.25.0). With it, every host gets what 0.25.2 and 0.25.3
  changed: no live image is stripped by default (`maxLiveImages`,
  `imageStripDepthTokens` and `maxLiveImageBytes` default to 0, so an image
  stays until its message is folded or leaves the window; set them to keep
  the old limits); the head and recent windows keep their edges where the
  chunks were cut when token estimates are recalibrated; and kv-unified can
  price what a change of layout costs, which a recipe sets with the keys
  above.
