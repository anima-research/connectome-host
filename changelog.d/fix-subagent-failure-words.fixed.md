- The subagent tools check each input against the type their schemas
  declare before anything starts, and a refusal names every wrong or
  missing input with what to give. Absent or `null` means not given, which
  a required input can't be, apart from `return`'s `result`, whose absence
  still means the subagent's last words; and a whole input that isn't an
  object is refused as such. Before, a spawn without `systemPrompt`
  answered that it was running and then failed on a TypeError, one without
  `task` failed on one too, one without `name` ran as `undefined`, a
  `systemPrompt` of `42` ran with no system prompt, `sync` or `hud`'s
  `enabled` given as `"false"` read as true, an async run's `timeoutMs` of
  `null` ended it at once and one of `"300"` set no limit, `tools` given
  as text failed on a TypeError, `maxConcurrent` `null` set the limit to 1
  and `{}` held every spawn, `return` with a `result` that's an object
  reached the parent as `[object Object]`, a spawn given `"go"` as its
  whole input was spawned as `undefined`, and `return` given `"done"`
  dropped it. With no input at all, `peek`, `concurrency` and `return` now
  answer as with no inputs given, where they failed on a TypeError. Some
  calls that did what was meant by coercion are refused too:
  `maxConcurrent` given as text, such as `"3"`; `sync` given as `0`; and a
  `tools` list holding something other than names, which ran. Ranges,
  empty text and inputs a schema doesn't declare are taken as before.
- A spawn's or fork's failure, in the call's answer and in the async
  notice, says whether anything ran, what ended it and what to do: a run
  that didn't start ran nothing; one that stopped returned no result, what
  it did stays done, and calling again starts its task over. One stopped
  by a cancel or a reclaim before its run began says nothing ran. A prompt
  over the module's limit says what to shorten, or for a fork, which
  carries the whole conversation, to spawn instead. No concurrency slot in
  time says how many run against what limit, and to wait or raise the
  limit, or, while a rate limit holds the limit down, that it rises as
  subagents finish without error, and to wait. The async time limit says
  how to give a run longer.
- A reclaimed subagent's result opens `[Stopped: it showed no activity for
  over 120 s, so the host reclaimed its slot]`, where it read
  `[Terminated: zombie]`. A peek that finds no subagent by that name says
  it may have finished or not have started yet. A tool the module doesn't
  have is answered with the ones it has.
