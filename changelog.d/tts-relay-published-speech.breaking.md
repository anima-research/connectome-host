- **Operators of the TTS relay (`modules.ttsRelay`) whose Discord server's
  key isn't `discord`:** the relay now voices only messages published on
  the server `editServerId` names (`discord` when it's unset), so such a
  host voices nothing until `modules.ttsRelay.editServerId` is set to its
  Discord server's key, which its interruption trims already needed. A
  message published on any other server isn't voiced either: at the first
  such message from each server, the host logs a line naming that server
  and the server the relay voices. Unchanged: a host whose Discord server's
  key is `discord`, or whose `editServerId` already names it, needs no
  change to its recipe.
- **Operators whose `modules.ttsRelay.editServerId` is empty or isn't a
  string:** the host now refuses the recipe at load, naming the field.
  Set it to the key of the server the relay voices, or leave it out for
  `discord`.
