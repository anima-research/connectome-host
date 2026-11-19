- A host quiesced for a release switch refuses what would change its session. A fleet child is quiesced in this way while its parent's switch runs. The host refuses:
  - the pin and settings changes passed on to it, as the parent's Web UI passes one on for a child;
  - its own Web UI's pin, settings, rollback and suppress;
  - a command that changes the session, from its terminal, its Web UI, its socket or a fleet parent.

  Before, it refused them only during a session switch. So a change started on such a host after the release switch's last check could be cut off by the switch's stop. The refusal says that nothing changed, and to try again once that quiesce has ended. It also says that `/update restart resume` ends a quiesce that a switch which has ended left behind. Resume, and what only reads, aren't refused.
