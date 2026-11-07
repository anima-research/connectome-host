- **Operators of the TTS relay (`modules.ttsRelay`) whose agent speaks on a
  server other than the one `editServerId` names (`discord` when it's
  unset):** the relay now voices only messages published on that server.
  A host whose Discord server's key isn't `discord`, with `editServerId`
  unset, voices nothing until `modules.ttsRelay.editServerId` is set to
  that key, which its interruption trims already needed. A host whose
  agent speaks only on a server that isn't Discord voices nothing until
  `editServerId` names that server. A host whose agent speaks on more than
  one server voices only the one `editServerId` names, and no setting
  voices more than one. At the first message published on each server it
  doesn't voice, the host logs a line naming that server and the server
  the relay voices. Unchanged: a host whose agent speaks only on the
  server `editServerId` names, or only on a Discord server whose key is
  `discord` with `editServerId` unset, needs no change to its recipe.
- **Operators whose `modules.ttsRelay.editServerId` is empty or isn't a
  string:** the host now refuses the recipe at load, naming the field.
  Set it to the key of the server the relay voices, or leave it out for
  `discord`.
