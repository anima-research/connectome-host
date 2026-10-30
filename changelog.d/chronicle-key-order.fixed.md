- `@animalabs/chronicle` is now ^0.5.1 (was ^0.5.0). chronicle 0.5.1 hands
  back a stored JSON object with its keys in the order they were written
  (in a JavaScript object, its own property order), where 0.5.0 sorted them.
  So the request after a turn sends that turn's tool calls with their keys
  as written, and a prompt cache that serves a request from the prefix it
  shares with an earlier one can serve it past a tool call whose input has
  keys written out of sorted order at any level, where on 0.5.0 the request
  first differed. Objects already stored keep the order they were stored in,
  except one stored as raw bytes, which 0.5.0 handed back sorted and 0.5.1
  hands back in the order of its stored bytes. So a request rebuilt from
  such an object can differ once from the last request before the update,
  and the prompt cache is written again from there. On an install made with
  bun, the update takes 0.5.1 for connectome-host's own copy only.
  agent-framework 0.30.0 and context-manager 0.24.1 ask for ^0.5.0, so bun
  keeps each one's own 0.5.0, and agent-framework's copy is the one that
  opens the store. There, stored objects keep coming back sorted until an
  update brings an agent-framework release that asks for ^0.5.1.
