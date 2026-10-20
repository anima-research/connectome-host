- The call ledger prices Claude Haiku 5.5 by prompt length: $0.10/$0.50 per million tokens for a
  request whose prompt, counting its cache reads and cache writes, is up to 100,000 tokens, and
  $0.50/$2.50 over that, with cache reads at 0.1x and writes at 1.25x (5m) and 2x (1h) in both.
  It matched no entry, so its calls showed no cost. After a restart, the Haiku 5.5 calls the
  ledger reads back from the recent call logs are priced too. The pricing version is now
  `anthropic-public-2026-10-19`.
