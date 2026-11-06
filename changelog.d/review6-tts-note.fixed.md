- tts-relay matches an interruption's heard words to the messages published
  in its channel on their first 80 characters, runs of white space made one
  space: a message the heard words start is one whose text starts with those
  80 characters. Of the messages that match, the one whose text shares the
  longest opening with all of the heard words is edited, the newest of those
  that share as much; the newest that matched was edited before. When the
  matched messages are by more than one agent, no note that the reply was
  interrupted is written, and the log names them. With no message matched,
  the agent voicing in the channel is the one whose activation there is
  live or was announced there since the channel's previous interruption;
  when that is more than one agent, no note is written, and the log names
  them. The agents voiced are kept for every channel the relay voices in,
  however many.
- tts-relay matches an interruption's heard words only to messages published
  in its channel since the channel's previous interruption, which ended its
  voicing. A message published before that was matched again, so a later
  reply that opened with the same words had it edited again.
- tts-relay counts an agent whose activation was live at a channel's
  interruption as voiced there since, as the relay goes on voicing it. Once
  that activation ended and another agent's started, a later interruption
  that matched no message was told to the other agent alone; no note is
  written now, and the log names both.
- tts-relay keeps each channel's latest 32 publishes to match an
  interruption there, and what each agent last voiced there, for the 32
  channels it last published in or ended an activation in. It kept the
  latest 32 of every channel together, so another channel's traffic could
  push out a message by one agent, and heard words that started it and
  another agent's message were taken as the other agent's alone. In a
  channel past those 32 an interruption edits nothing, and its note is for
  the agent voiced there when that is one agent.
- tts-relay neither edits a published message nor writes a note when the
  heard words start it and also what another agent voiced in the channel
  after it was published (that agent's live activation there, or its
  latest since the channel's previous interruption), and the log names
  both: the relay can't tell whose voicing was cut. The message was
  trimmed to the heard words and its author told, a fully voiced message
  included, before the channel's first interruption as after one.
