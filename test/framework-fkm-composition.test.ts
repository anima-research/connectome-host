import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFrameworkAgentConfig } from '../src/framework-agent-config.js';
import { buildFrameworkStrategy } from '../src/framework-strategy.js';
import { loadSavedRecipe, saveRecipe, validateRecipe } from '../src/recipe.js';

function recipe(agent: Record<string, unknown> = {}) {
  return {
    name: 'framework-fkm-composition',
    agent: {
      systemPrompt: 'sys',
      ...agent,
    },
  };
}

function strategyConfigView(strategy: object): Record<string, unknown> {
  return (strategy as { config?: Record<string, unknown> }).config ?? {};
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { force: true, recursive: true });
  }
});

describe('framework FKM composition', () => {
  test('preserves the pre-merge AgentConfig shape field-for-field when FKM additions are omitted', () => {
    const parsed = validateRecipe(recipe({
      provider: 'openai-responses',
      maxTokens: 4_096,
      maxStreamTokens: 80_000,
      contextBudgetTokens: 120_000,
      cacheTtl: '5m',
      responses: {
        reasoningEffort: 'medium',
        reasoningContext: 'current_turn',
        serviceTier: 'priority',
        compactThreshold: 90_000,
      },
      thinking: {
        enabled: true,
        budgetTokens: 1_024,
      },
      refusalHandling: {
        autoRewind: true,
        maxRewinds: 2,
        announceHumanTurns: false,
      },
    }));
    const strategy = { kind: 'baseline-strategy' } as never;

    expect(buildFrameworkAgentConfig(parsed, 'agent', 'model', strategy)).toEqual({
      name: 'agent',
      model: 'model',
      systemPrompt: 'sys',
      maxTokens: 4_096,
      maxStreamTokens: 80_000,
      contextBudgetTokens: 120_000,
      cacheTtl: '5m',
      providerParams: {
        reasoning: {
          effort: 'medium',
          context: 'current_turn',
        },
        service_tier: 'priority',
        context_management: [{
          type: 'compaction',
          compact_threshold: 90_000,
        }],
      },
      strategy,
      thinking: {
        enabled: true,
        budgetTokens: 1_024,
      },
      refusalHandling: {
        autoRewind: true,
        maxRewinds: 2,
        announceHumanTurns: false,
      },
    });
  });

  test('composes validation, serialization, and AF/CM wiring for the merged FKM settings without cross-agent bleed', () => {
    const parsed = validateRecipe(recipe({
      provider: 'openai-responses',
      maxTokens: 4_096,
      responses: {
        reasoningEffort: 'high',
        reasoningContext: 'all_turns',
        serviceTier: 'priority',
      },
      sameRoundThinkTextPolicy: 'private',
      refusalHandling: {
        autoRewind: true,
        primarySummaryFallback: {
          enabled: true,
          maxNewSummaries: 4,
          requestBudgetTokens: 216_000,
        },
      },
      strategy: {
        type: 'autobiographical',
        compressionRefusalCurveFallbacks: 2,
        compressionContextBudgetTokens: 19_000,
      },
    }));

    const dir = mkdtempSync(join(tmpdir(), 'connectome-fkm-'));
    tempDirs.push(dir);
    saveRecipe(dir, parsed);
    const reloaded = loadSavedRecipe(dir);
    expect(reloaded).not.toBeNull();

    expect(reloaded!.agent.sameRoundThinkTextPolicy).toBe('private');
    expect(reloaded!.agent.refusalHandling?.primarySummaryFallback).toEqual({
      enabled: true,
      maxNewSummaries: 4,
      requestBudgetTokens: 216_000,
    });
    expect(reloaded!.agent.strategy?.compressionRefusalCurveFallbacks).toBe(2);
    expect(reloaded!.agent.strategy?.compressionContextBudgetTokens).toBe(19_000);

    const runtimeStrategy = buildFrameworkStrategy(reloaded!, 'model', 'America/Los_Angeles');
    const runtimeConfig = strategyConfigView(runtimeStrategy);
    expect(runtimeConfig.compressionRefusalCurveFallbacks).toBe(2);
    expect(runtimeConfig.compressionContextBudgetTokens).toBe(19_000);

    const agentConfig = buildFrameworkAgentConfig(reloaded!, 'agent', 'model', runtimeStrategy);
    expect(agentConfig.sameRoundThinkTextPolicy).toBe('private');
    expect(agentConfig.refusalHandling?.primarySummaryFallback).toEqual({
      enabled: true,
      maxNewSummaries: 4,
      requestBudgetTokens: 216_000,
    });
    expect((agentConfig.providerParams as Record<string, unknown>).service_tier).toBe('priority');
    expect(Object.keys(agentConfig.providerParams as Record<string, unknown>)
      .filter((key) => key === 'service_tier')).toHaveLength(1);

    const otherRecipe = validateRecipe(recipe({
      strategy: {
        type: 'autobiographical',
        compressionRefusalCurveFallbacks: 0,
        compressionContextBudgetTokens: 50_000,
      },
    }));
    const otherStrategy = buildFrameworkStrategy(otherRecipe, 'other-model', 'America/Los_Angeles');
    const otherConfig = strategyConfigView(otherStrategy);
    expect(otherConfig.compressionRefusalCurveFallbacks).toBe(0);
    expect(otherConfig.compressionContextBudgetTokens).toBe(50_000);
    expect(otherConfig).not.toBe(runtimeConfig);
    expect(runtimeConfig.compressionRefusalCurveFallbacks).toBe(2);
    expect(runtimeConfig.compressionContextBudgetTokens).toBe(19_000);
  });
});
