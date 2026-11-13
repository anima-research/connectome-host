- **Recipe authors:** `sessionNaming` must be an object with `examples` an
  array of strings, and an unknown key under it is refused by name;
  `sessionNaming: null`, `examples: "x"` and a misspelt key loaded before (the
  second failed inside the naming call, unseen). A saved recipe with one of
  these is refused at the next start: fix the recipe and start with it as the
  argument once.
