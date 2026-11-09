import { AnthropicXmlFormatter, NativeFormatter, OpenAIResponsesFormatter } from '@animalabs/membrane';
import type { Recipe } from './recipe.js';
import { resolvePromptCaching } from './framework-agent-config.js';

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
 * When an XML-mode request's first message isn't a user turn and the recipe
 * sets no prefill user message, membrane opens it with a CLI-simulation frame
 * if its system text is empty, and with a [Start] marker otherwise, so tools
 * in the system text take the frame away.
 */
export function xmlToolsInSystem(recipe: Recipe, model: string): boolean {
  return recipe.agent.systemPrompt !== '' && resolvePromptCaching(recipe, model) !== false;
}

/**
 * A formatter constructed without a tool mode leaves the choice to membrane,
 * which picks native whenever the formatter supports it, as
 * AnthropicXmlFormatter does. Membrane's default splices XML tool definitions
 * into the transcript ten messages before its end, or at its start while it
 * holds ten or fewer, so past ten messages the point moves with every
 * appended message.
 */
export function anthropicXmlFormatter({ toolsInSystem }: { toolsInSystem: boolean }): AnthropicXmlFormatter {
  return new AnthropicXmlFormatter({ toolMode: 'xml', toolInjectionMode: toolsInSystem ? 'system' : 'conversation' });
}
