- `/history <n>` refuses a count that isn't a whole number above 0, naming it,
  as `/budget` refuses a token count: `/history 1e309` read as `Infinity` and
  printed the whole store (every message, one line each) to every connected
  client, and `abc`, `0` or `-5` showed the default 20 without a word.
