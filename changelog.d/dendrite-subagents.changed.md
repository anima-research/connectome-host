- Subagents are Dendrite agents. A fork is registered as a task-fork of its
  parent (spawner, result route, copy inheritance, the launch on its record),
  with #213's materialisation unchanged: the parent's compiled context
  becomes the fork's own, the parent's tool round in flight is reproduced
  with this call's result in it, so the fork sees the call that made it and
  never meets a dangling `tool_use`; a call the parent had stored before the
  launch is answered after the copy, its siblings with the framework's "no
  result yet" note, and a launch with no call gets the pair the fallback
  always made. (Deriving the fork's context through `deriveAgent` is the
  next step, not this one.) A spawn is a registered worker. Both records
  name who spawned the subagent and where its result goes, and carry the
  launch (`metadata`). A result returns by that route: to the awaiting call
  for a sync run, otherwise as attributed mail under the subagent's own
  name, and once the caller has ended, a sync run's as well as an async
  one's is held as mail for that caller until it is adopted, never lost.
  Before, an async result was a line in the primary's context whatever
  became of the caller. A failure now follows the same path,
  except one whose route is the live primary, which is still told to it as a
  line in its context. A launch whose caller ended before it registered, as
  one waiting for a slot or a retry can, registers under the caller's
  nearest live ancestor, or the primary, and its result goes there, saying
  whose run it was; a fork registered so carries no copy inheritance on its
  record, since its copy came from the caller.
  The launch refusal and the concurrency, retry, cancel and time-limit rules
  are unchanged; what a stream is told at its start is the recipe's
  `modules.subagents.orientation` (`full`, the default, or `none`).
- Five tools over the registry: `subagent--list` (the launches within the
  caller's reach, running, ended or orphaned, with spawner, task and route,
  and how many of a run's results and messages are held for a recipient that
  can't take them), `subagent--stop` (a run cancelled children-first, task
  work it spawned orphaned and offered for adoption, its stopped result
  saying who stopped it and why), `subagent--message` (a message in a
  running subagent's context under the sender's name, waking it),
  `subagent--adopt` (an orphan's new parent, its result following; an orphan
  that has since ended isn't restarted, and adopting it delivers what it
  holds for a recipient that has gone), and `subagent--resume` (a subagent a
  restart cut off, a time limit stopped or that failed, continued from the
  context it left, under the same name, its result delivered as a message;
  one that was stopped, that completed or that ended any other way is
  refused, with what to do instead). The agent tree shows the edges from
  `dendrite:agent-created`.
- The tools keep the module's own rules. They reach the caller's subtree —
  the subagents it started, and theirs — as `peek` does (postmortem
  2026-05-28 P3 #8); `modules.subagents.lifecycleReach: 'all'` widens them
  to every subagent the host knows, though not who adopts. A resume is
  refused when the launch's tools exceed the caller's own rule, since a
  resume runs the launch's tools and a caller cannot hand out more than it
  has. An orphan is adopted only by an agent it was offered to — an ancestor
  of its former parent, or the primary — or one in whose tree it hung, so
  held results never move to a stranger; `adopt` takes the framework name
  the offer gives as well as the display name. A resume says where the
  result will go when the record's route is to someone else who is still
  running: a resume keeps a route whose recipient is still running, and
  without one the result goes to the agent that resumed it.
