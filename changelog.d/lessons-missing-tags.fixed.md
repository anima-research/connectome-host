- A lesson created without `tags` (or with `null`) no longer breaks
  `lessons_query`/`lessons_list`, retrieval, and the web UI Lessons panel.
  Tags are normalized to a string array on create and update, and lessons
  already stored without them are healed when the module starts.
