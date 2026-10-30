import { AgentFramework } from '@animalabs/agent-framework';
import type { Recipe } from './recipe.js';
import { DEFAULT_RECIPE_CLOCK, resolveProvider } from './recipe.js';
import { effectiveContextBudgetTokens, effectiveMaxTokens } from './recipe-fit.js';
import { modelThinking } from './logging-adapter.js';
import { getDefaultModelLimits } from './model-limits.js';

type AgentConfig = Parameters<typeof AgentFramework.create>[0]['agents'][number];

/**
 * An agent-framework that predates `agent.autoContinue` (agent-framework#744)
 * passes the key through and builds the agent without it, so turns end as
 * before with no other sign. One that supports it gives the built agent
 * (framework.getAgent) `autoContinue`, resolved.
 */
export function autoContinueSupportWarning(recipe: Recipe, agent: object | undefined): string | undefined {
  if (!recipe.agent.autoContinue || !agent) return undefined;
  if ((agent as { autoContinue?: unknown }).autoContinue !== undefined) return undefined;
  return '[agent-settings] agent.autoContinue is set, but the installed agent-framework predates it ' +
    '(agent-framework#744): turns end as before, without continuing, until it is upgraded.';
}

export type FrameworkAgentConfig = AgentConfig & {
  refusalHandling?: Recipe['agent']['refusalHandling'];
  sameRoundThinkTextPolicy?: 'public' | 'private';
  autoContinue?: Recipe['agent']['autoContinue'];
  thinkingBinding?: { binds?: boolean; dropBlock?: boolean };
};

/** The drop control and the window go only on the Anthropic route, the one
 *  they were tried on (anima-research/context-manager#155). */
export function thinkingBindingSettings(model: string, provider: string | undefined): {
  thinkingBinding?: { binds: true; dropBlock: boolean };
  physicalWindowTokens?: number;
} {
  const facts = modelThinking(model);
  if (!facts.binds) return {};
  const direct = provider === 'anthropic';
  const window = direct && facts.windowShownByRefusal ? getDefaultModelLimits(model)?.maxContextTokens : undefined;
  return {
    thinkingBinding: { binds: true, dropBlock: direct && facts.dropBlock },
    ...(window !== undefined ? { physicalWindowTokens: window } : {}),
  };
}

/** The paragraph hosts 0.16.0 to 0.20.x appended to a binding model's system
 *  prompt about folds taking an agent's earlier reasoning. The host no longer
 *  adds it: an agent isn't told about the mechanics of its own memory or
 *  reasoning in standing text. */
const LEGACY_FOLD_LINE =
  'When your context folds, the reasoning behind your earlier replies leaves it, though their words stay, ' +
  'so a reply of yours that shows no reasoning may still have had some.';

/** The system prompt an agent is given: the recipe's (or a launch's), with the
 *  legacy fold paragraph taken off where a prompt still carries it, such as a
 *  fork's copy of a parent's prompt from a host that added it. */
export function systemPromptFor(systemPrompt: string): string {
  if (systemPrompt === LEGACY_FOLD_LINE) return '';
  return systemPrompt.endsWith(`\n\n${LEGACY_FOLD_LINE}`)
    ? systemPrompt.slice(0, -(LEGACY_FOLD_LINE.length + 2))
    : systemPrompt;
}

/**
 * Prompt caching went GA on Bedrock in April 2025 for 3.5 Haiku, 3.7 Sonnet,
 * and Claude 4+, but not for 3.5 Sonnet (either version): 1022 ("3.6") was
 * in the Dec 2024 preview and was dropped at GA, and Bedrock refuses it with
 * an account-level "your request did not allow prompt caching".
 */
export function bedrockModelSupportsPromptCaching(model: string): boolean {
  const id = model.toLowerCase();
  if (!id.includes('claude')) return false;
  return !/claude-(v2|instant|3-(opus|sonnet|haiku)|3-5-sonnet)(?![a-z0-9])/.test(id);
}

export function resolvePromptCaching(recipe: Recipe, model: string): boolean | undefined {
  if (recipe.agent.promptCaching !== undefined) return recipe.agent.promptCaching;
  if (recipe.agent.provider === 'bedrock') return bedrockModelSupportsPromptCaching(model);
  return undefined; // membrane default (on)
}

/**
 * Callers inside the agent's strategy, such as context-manager's
 * autobiographical compression and merge, send requests that don't set
 * promptCaching, which membrane's defaultPromptCaching then decides, so a
 * recipe's override is set at both layers.
 */
export function membraneCachingOverride(
  recipe: Recipe,
  model: string,
): { defaultPromptCaching?: boolean } {
  const promptCaching = resolvePromptCaching(recipe, model);
  return promptCaching === undefined ? {} : { defaultPromptCaching: promptCaching };
}

export function buildFrameworkAgentConfig(
  recipe: Recipe,
  agentName: string,
  model: string,
  strategy: FrameworkAgentConfig['strategy'],
): FrameworkAgentConfig {
  const promptCaching = resolvePromptCaching(recipe, model);
  const contextBudgetTokens = effectiveContextBudgetTokens(recipe, model);
  let thinking: FrameworkAgentConfig['thinking'];
  if (recipe.agent.thinking) {
    // Effort is a host setting sent as output_config.effort, never as thinking.effort.
    const { effort: _hostEffort, ...providerThinking } = recipe.agent.thinking;
    thinking = providerThinking;
  }
  return {
    name: agentName,
    ...(recipe.agent.toolPresentation ? {toolPresentation: recipe.agent.toolPresentation} : {}),
    model,
    systemPrompt: systemPromptFor(recipe.agent.systemPrompt),
    ...(recipe.agent.allowedTools !== undefined
      ? { allowedTools: recipe.agent.allowedTools }
      : {}),
    maxTokens: effectiveMaxTokens(recipe),
    maxStreamTokens: recipe.agent.maxStreamTokens
      ?? (recipe.agent.contextBudgetTokens === undefined ? contextBudgetTokens + 20_000 : 150_000),
    contextBudgetTokens,
    // Bedrock offers only the default 5m cache, so cacheTtl isn't forwarded
    // there. agent-framework sends its own default ('1h') when the host omits it.
    ...(recipe.agent.cacheTtl && recipe.agent.provider !== 'bedrock'
      && { cacheTtl: recipe.agent.cacheTtl }),
    ...(promptCaching !== undefined && { promptCaching }),
    ...(recipe.agent.prefillUserMessage && { prefillUserMessage: recipe.agent.prefillUserMessage }),
    ...((recipe.agent.provider === 'openai-responses' || recipe.agent.provider === 'openai-codex') && {
      providerParams: {
        reasoning: {
          effort: recipe.agent.responses?.reasoningEffort ?? 'high',
          context: recipe.agent.responses?.reasoningContext ?? 'all_turns',
        },
        ...(recipe.agent.provider === 'openai-responses' ? {
          ...(recipe.agent.responses?.serviceTier ? {
            service_tier: recipe.agent.responses.serviceTier,
          } : {}),
          ...(recipe.agent.responses?.compactThreshold ? {
            context_management: [{
              type: 'compaction',
              compact_threshold: recipe.agent.responses.compactThreshold,
            }],
          } : {}),
        } : {}),
      },
    }),
    strategy,
    ...(thinking && { thinking }),
    ...thinkingBindingSettings(model, resolveProvider(recipe)),
    ...(recipe.agent.refusalHandling && { refusalHandling: recipe.agent.refusalHandling }),
    ...(recipe.agent.sameRoundThinkTextPolicy !== undefined
      ? { sameRoundThinkTextPolicy: recipe.agent.sameRoundThinkTextPolicy }
      : {}),
    ...(recipe.agent.proseRouting !== undefined
      ? { proseRouting: recipe.agent.proseRouting }
      : {}),
    ...(recipe.agent.toolWrapperProseGuard !== undefined
      ? { toolWrapperProseGuard: recipe.agent.toolWrapperProseGuard }
      : {}),
    ...(recipe.agent.autoContinue !== undefined
      ? { autoContinue: recipe.agent.autoContinue }
      : {}),
    ...(recipe.agent.clock === false ? {} : { clock: recipe.agent.clock ?? { ...DEFAULT_RECIPE_CLOCK } }),
  };
}
