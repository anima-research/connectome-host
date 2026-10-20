- Requires `@animalabs/agent-framework` ^0.22.4, which carries 0.22.3's
  changes and one fix of its own. What changes in the host with it:
  - After an interruption, the TTS relay's note to the agent says the posted
    message "could not be trimmed" when the server refuses the edit, where it
    said the message was trimmed to match: 0.22.3 gives a module's `callTool`
    an MCPL server's error result as a failure.
  - The Web UI's agent tree, and a fleet child's agents in the TUI's tree,
    show a turn the framework gave up on (`inference:exhausted`) as failed,
    where they showed it as cancelled: from 0.22.3 a stop or a shutdown ends a
    turn with `inference:aborted` alone, and `inference:exhausted` means the
    turn failed. A turn already stopped stays stopped until its next start,
    so a fleet child the host adopts while the child still runs 0.22.2 shows
    an interrupt's stop as before: 0.22.2's interrupt sends
    `inference:aborted` and then `inference:exhausted`. Until such a child
    restarts on 0.22.3 or later, a subagent it stops shows as failed, since
    0.22.2 ends that stop with `inference:exhausted` alone.
  - An agent overlay entry's `reconnect` written as the text `"false"`, in
    any case and with any spaces around it, is read as false, where its truth
    turned retrying on. Any other value that isn't `true` or `false` is still
    read by its truth, and the startup warnings name each. 0.22.3 refuses any
    value but `true`, `false` or `null`, so the overlay hands it `true` or
    `false`.
