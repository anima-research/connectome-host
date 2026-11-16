- `/history <n>` refuses a count that doesn't come to a whole number above 0,
  naming it (`1e309`, `abc`, `0`, `-5`, `2.5`, `0x10`, `1e3`; `20`, `+20` and
  `20.0` are read), and shows at most 500 messages: `/history 1e309` read as
  `Infinity` and printed the whole store, one line per message, in the
  command's result (4,590 lines on one store), and `abc`, `0` or `-5` showed
  the default 20 without a word. Where rows were held back, a last line says
  how many the store holds; `/find <text>` searches them all.
