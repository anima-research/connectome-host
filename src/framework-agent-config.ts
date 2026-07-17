import { AgentFramework } from '@animalabs/agent-framework';
import type { Recipe } from './recipe.js';

export type FrameworkAgentConfig = Parameters<typeof AgentFramework.create>[0]['agents'][number] & {
  sameRoundThinkTextPolicy?: 'public' | 'private';
};

export function buildFrameworkAgentConfig(
  recipe: Recipe,
  agentName: string,
  model: string,
  strategy: FrameworkAgentConfig['strategy'],
): FrameworkAgentConfig {
  return {
    name: agentName,
    model,
    systemPrompt: recipe.agent.systemPrompt,
    maxTokens: recipe.agent.maxTokens ?? 16384,
    maxStreamTokens: recipe.agent.maxStreamTokens ?? 150000,
    contextBudgetTokens: recipe.agent.contextBudgetTokens,
    ...(recipe.agent.cacheTtl && { cacheTtl: recipe.agent.cacheTtl }),
    ...(recipe.agent.provider === 'openai-responses' && {
      providerParams: {
        reasoning: {
          effort: recipe.agent.responses?.reasoningEffort ?? 'high',
          context: recipe.agent.responses?.reasoningContext ?? 'all_turns',
        },
        ...(recipe.agent.responses?.serviceTier ? {
          service_tier: recipe.agent.responses.serviceTier,
        } : {}),
        ...(recipe.agent.responses?.compactThreshold ? {
          context_management: [{
            type: 'compaction',
            compact_threshold: recipe.agent.responses.compactThreshold,
          }],
        } : {}),
      },
    }),
    strategy,
    ...(recipe.agent.thinking && { thinking: recipe.agent.thinking }),
    ...(recipe.agent.refusalHandling && { refusalHandling: recipe.agent.refusalHandling }),
    ...(recipe.agent.sameRoundThinkTextPolicy !== undefined
      ? { sameRoundThinkTextPolicy: recipe.agent.sameRoundThinkTextPolicy }
      : {}),
  };
}
