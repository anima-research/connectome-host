- WebUI rollback and suppression make Discord awareness marks the operator's
  choice. With an agent-framework that takes one (feature `marks`), the
  dialog previews what the change removes and offers no marks (the default),
  marks on the messages that addressed the agent, or marks on all of them,
  with counts per channel. A chosen scope is bound to exactly the previewed
  messages. The result shows the framework's marker receipt. The branch
  panel lists the framework's awareness journal (feature `awareness`) with
  cancel, retract (after confirmation) and release. An older framework marks
  every removed Discord message itself and can't be told not to, so against
  one the server refuses a live rollback or suppression unless the operator
  explicitly accepts those marks (`legacyMarks: true`, a checkbox in the
  dialog). An omitted choice never stands for them, and a scope or refs the
  framework can't honor is refused. This follows an incident in which one
  rollback queued 918 reactions, mostly on other people's messages.
