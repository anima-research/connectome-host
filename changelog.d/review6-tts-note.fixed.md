- tts-relay matches an interruption's heard words to the messages published
  in its channel on their first 80 characters, runs of white space made one
  space: a message the heard words start is one whose text starts with those
  80 characters. Of the messages that match, the one whose text shares the
  longest opening with all of the heard words is edited, the newest of those
  that share as much; the newest that matched was edited before. When the
  matched messages are by more than one agent, the note that the reply was
  interrupted is written for no agent, and the log names them. With no
  message matched, the agent voicing in the channel is the one whose
  activation there is live or was announced there since the channel's
  previous interruption; when that is more than one agent, the note is
  written for no agent, and the log names them.
