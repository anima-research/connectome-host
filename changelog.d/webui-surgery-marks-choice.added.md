- WebUI rollback and suppression make Discord awareness marks the operator's
  choice. With an agent-framework that takes one (feature `marks`), the
  dialog previews what the change removes and offers no marks (the default),
  marks on the messages that addressed the agent, or marks on all of them,
  with counts per channel. A chosen scope is bound to exactly the previewed
  messages. The result shows the framework's marker receipt. The branch
  panel lists the framework's awareness journal (feature `awareness`) with
  cancel, retract (after confirmation) and release. Against an older
  framework, which marks every removed Discord message itself, the dialog
  says so and the server refuses a marks choice instead of passing on a field
  the framework would ignore. This follows an incident in which one rollback
  queued 918 reactions, mostly on other people's messages.
