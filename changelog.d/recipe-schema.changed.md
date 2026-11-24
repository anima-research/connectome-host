- A recipe's refusal names each fault that the schema finds, one line each,
  where it named the first one alone, and a wrong value reads `Recipe <path>
  must be <what it takes>, got <value>.` A refusal prints no value that came
  from the environment: it names the `${VAR}` reference, or the kind of
  value where a saved recipe no longer holds the reference. An object that
  refuses an unknown key names the keys that it takes.
- The warning of keys that the host does not read now covers the objects
  that said nothing of one, such as `agent.thinking`, `codeExecution`, an
  `mcpServers` entry and `modules.fleet`, where a misspelt key loaded with
  no word. The key still loads. Some objects stay unchecked, such as the
  wake gate's rules, an extension's `config` and a custom strategy's own
  options. The warning no longer names the recipe.
