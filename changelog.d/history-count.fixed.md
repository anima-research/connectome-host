- `/history <n>` refuses a count that isn't decimal digits coming to a whole
  number above 0, naming it (`1e309`, `abc`, `0`, `-5`, `2.5`, `0x10`, `1e3`),
  and shows at most 500 messages, saying how many were asked: `/history 1e309`
  read as `Infinity` and printed the whole store, one line per message, in the
  command's result (4,590 lines on one store), and `abc`, `0` or `-5` showed
  the default 20 without a word. The Web UI's history view pages further back.
