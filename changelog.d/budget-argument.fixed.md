- `/budget` refuses an argument that isn't a whole number of tokens, plain or
  with a `k`/`m` suffix (`200000`, `150k`, `1.5m`), naming it, as it refused
  `-5` and `abc`: `parseInt` read `1e5` as 1, `200,000` as 200 and `150abc`
  as 150, and the command set that for every agent, confirming it as a
  success.
