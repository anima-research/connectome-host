- `/budget` refuses an argument that doesn't come to a whole number of
  tokens, naming it, as it refused `-5` and `abc`: it takes digits with an
  optional decimal part, an optional leading `+` and an optional `k`/`m`
  (`200000`, `150k`, `1.5m`, `.5k`, `200000.0`); exponents (`1e5`), other
  signs, separators (`200,000`, `200 000`, `200_000`) and trailing words are
  refused, the whole argument with them. Before, `parseInt` read `1e5` as 1,
  `200,000` as 200 and `150abc` as 150, and `200 000` lost everything after
  its first word, and the command set that for every agent, confirming it as
  a success. The confirmation and the listing show the exact count beside the
  rounded one where rounding hid it (`1.0k (1,001)`).
