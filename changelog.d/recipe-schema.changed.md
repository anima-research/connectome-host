- A recipe's refusal names each fault that the schema finds, one line each,
  where it named the first one alone, and a wrong value reads `Recipe <path>
  must be <what it takes>, got <value>.` The schema's refusal prints no value
  that came from the environment: it names the `${VAR}` reference, or the
  kind of value where a recipe that an older release saved no longer holds
  the reference. An object that refuses an unknown key names the keys that
  it takes.
- The warning of keys that the host does not read now covers the objects
  that said nothing of one, such as `agent.thinking`, `codeExecution`, an
  `mcpServers` entry and `modules.fleet`, where a misspelt key loaded with
  no word. The key still loads. Some objects stay unchecked, such as the
  wake gate's rules, an extension's `config`, and everything under a custom
  strategy, which goes whole to its extension. The warning names the recipe as its author wrote the name, and a
  recipe that an older release saved by no name.
