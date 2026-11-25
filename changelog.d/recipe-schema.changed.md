- A recipe's refusal now names each fault that the schema finds, one per
  line. Before, it named only the first fault. A wrong value reads `Recipe
  <path> must be <what it takes>, got <value>.` The refusal prints no value
  that came from the environment, and names the `${VAR}` reference instead.
  Some older releases saved a recipe with its values filled in, and for such
  a recipe the refusal names only the kind of a value. A refusal of an
  unknown key lists the keys that its object takes.
- The warning of keys that the host does not read now covers more objects,
  such as `agent.thinking`, `codeExecution`, an `mcpServers` entry and
  `modules.fleet`. Before, a misspelt key in these objects loaded without a
  warning. The key still loads. Some objects still take any key without a
  warning, such as the wake gate's rules and an extension's `config`.
  Everything under a custom strategy goes whole to its extension, so it gets
  no warning either. The warning gives the recipe's name as its author wrote
  it. The warning gives no name for a recipe that an older release saved.
