import { AnthropicXmlFormatter, NativeFormatter, OpenAIResponsesFormatter } from '@animalabs/membrane';
import type { Recipe } from './recipe.js';
import { resolvePromptCaching } from './framework-agent-config.js';

/**
 * The membrane formatter a recipe's agent runs through, given the model the
 * host resolved for it. The host builds one Membrane, so every agent it runs,
 * subagents included, sends through this formatter, decided from the recipe's
 * agent.
 */
export function recipeFormatter(
  recipe: Recipe,
  provider: string,
  model: string,
): AnthropicXmlFormatter | NativeFormatter | OpenAIResponsesFormatter {
  if (provider === 'openai-responses' || provider === 'openai-codex') return new OpenAIResponsesFormatter();
  if (recipe.agent.formatter === 'anthropic-xml') return anthropicXmlFormatter({ toolsInSystem: xmlToolsInSystem(recipe, model) });
  return new NativeFormatter();
}

/**
 * Whether an `anthropic-xml` recipe's tool definitions go into the system
 * block: when the recipe's agent has a system prompt and prompt caching
 * doesn't resolve off for the model.
 *
 * The move pays only in cache reads, so without caching the tools stay where
 * membrane puts them by default, as on main. So they do without a system
 * prompt: membrane gives a transcript that opens with the agent's own turn its
 * CLI-simulation frame only when the request's system text is empty, and
 * tools in the system text would take that frame away from the prefill-era
 * agents the `anthropic-xml` pin exists for. The recipe's prompt is what the
 * host can read when it builds the formatter, so an agent whose recipe has no
 * prompt keeps main's request even when its requests carry injected system
 * text (instructions, a heartbeat), which leaves it no frame at stake.
 *
 * The answer is the recipe's for every agent the host runs: they all send
 * through one formatter, so a subagent takes it whatever its own prompt or
 * model.
 */
export function xmlToolsInSystem(recipe: Recipe, model: string): boolean {
  return recipe.agent.systemPrompt !== '' && resolvePromptCaching(recipe, model) !== false;
}

/**
 * The formatter of an `anthropic-xml` recipe's agent: one place for its
 * options, since the host's count of an agent's context builds its request
 * with the same one.
 *
 * It's pinned to XML tool mode. Since membrane 0.5.87 a formatter constructed
 * without a mode leaves the choice to membrane, which picks native whenever
 * the formatter supports it, and AnthropicXmlFormatter does. That turned a
 * prefill-transcript agent ("participant: text" runs, an assistant prefill,
 * speaker stop sequences, XML tools) into an ordinary native chat with native
 * tools. The recipe's `anthropic-xml` promises the prefill-era structure, so
 * the mode is stated here rather than derived.
 *
 * With `toolsInSystem` (xmlToolsInSystem), its tool definitions go into the
 * system block. Membrane's default splices them into the transcript ten
 * messages before its end, a point that moves with every appended message,
 * so the tool block was written to the prompt cache again on every turn
 * (#287). In the system block they sit in the prefix consecutive requests
 * share while the tool list and the system text hold. Each change of either,
 * such as an MCPL server reconnecting, writes the whole prompt to the cache
 * once.
 */
export function anthropicXmlFormatter({ toolsInSystem }: { toolsInSystem: boolean }): AnthropicXmlFormatter {
  return new AnthropicXmlFormatter({ toolMode: 'xml', toolInjectionMode: toolsInSystem ? 'system' : 'conversation' });
}
