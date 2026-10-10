- WebUI rollback and suppression make Discord awareness marks the operator's
  choice. With an agent-framework that takes one (feature `marks`), the
  dialog previews what the change removes and offers no marks (the default),
  marks on the messages that addressed the agent, or marks on all of them,
  with counts per channel. A chosen scope is bound to exactly the previewed
  messages. The result shows the framework's marker receipt. The branch
  panel lists the framework's awareness journal (feature `awareness`) with
  cancel, retract (after confirmation) and release. An agent-framework
  without the choice marks every removed Discord message itself and moves
  those marks with branch switches, so against one the web UI refuses live
  rollback and suppression (`code: 'unsupported'`) and the dialog says the
  framework needs upgrading; previously it ran them and the framework marked
  everything. This follows an incident in which one rollback queued 918
  reactions, mostly on other people's messages. Every live surgery is now
  preview-bound: it runs only against the store and branch its preview
  described, which the framework checks under its own reservation, and the
  host refuses a confirmation after a session rebind or branch change. A
  journal action reaches only the framework whose journal it was chosen
  from, and "quiesce, then retry" pauses only the session and store its
  surgery was previewed on. The host records its own refusals in the
  operator log as the framework records its own. A scope over 20,000
  messages isn't offered (never truncated), a preview lost to a reconnect
  is asked for again, and a surgery whose result is lost to a disconnect
  says its outcome is unknown instead of waiting forever. This needs an
  agent-framework release carrying both the marks contract
  (anima-research/agent-framework#250) and its store-identity check (the
  R2 operator-change work); until the host depends on one, live rollback and
  suppression are refused.
