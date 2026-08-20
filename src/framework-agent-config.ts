import { AgentFramework } from '@animalabs/agent-framework';
import type { Recipe } from './recipe.js';

type AgentConfig = Parameters<typeof AgentFramework.create>[0]['agents'][number];

export type FrameworkAgentConfig = AgentConfig & {
  // Forward recipe fields that newer Agent Framework releases understand
  // while remaining structurally compatible with older installs.
  refusalHandling?: Recipe['agent']['refusalHandling'];
  sameRoundThinkTextPolicy?: 'public' | 'private';
  retirement?: Recipe['agent']['retirement'];
};

/**
 * Keep the host fail-closed across a staged Agent Framework release. Older
 * versions structurally accept unknown agent fields, so without this guard an
 * opted-in recipe could appear valid while providing no retirement mechanism.
 *
 * The status reader is only a proxy for enforcement: Agent Framework ships
 * getResidentLifecycleStatus and the retirement machinery atomically. The
 * released dependency range and lockfile are therefore the load-bearing
 * compatibility boundary; this runtime probe is belt-and-braces protection for
 * stale or incorrectly linked installs, not proof of enforcement by itself.
 */
export function assertResidentRetirementSupport(
  recipe: Recipe,
  framework: unknown,
): void {
  if (!recipe.agent.retirement?.enabled) return;
  const candidate = framework as { getResidentLifecycleStatus?: unknown };
  if (typeof candidate.getResidentLifecycleStatus !== 'function') {
    throw new Error(
      'This recipe enables agent.retirement, but the installed Agent Framework does not support resident retirement.',
    );
  }
}

/**
 * Prompt caching went GA on Bedrock in April 2025 for 3.5 Haiku, 3.7
 * Sonnet, and Claude 4+ — but NOT for 3.5 Sonnet (either version). 1022
 * ("3.6") was in the Dec 2024 preview and was dropped at GA — that
 * account-level "your request did not allow prompt caching" is the error
 * observed here 2026-07-21 (antra's diagnosis, confirmed against the AWS
 * docs 2026-07-31; as of the same day's live probe every 3.5-era model
 * is EOL on Bedrock anyway). So the gate denies the pre-GA FAMILIES —
 * Claude v2/instant, Claude 3, 3.5 Sonnet — at the family boundary, so
 * dated ids, bare aliases, -latest, and inference-profile forms
 * (us.anthropic.claude-...) all resolve the same; 3.5 Haiku and 3.7
 * Sonnet stay distinct and on. Non-Claude Bedrock ids (Nova etc.) are
 * out of scope for this gate and conservatively off — membrane's
 * BedrockAdapter only accepts Claude ids today. recipe.agent.
 * promptCaching overrides in either direction for accounts/regions
 * whose entitlements differ from the GA table. (Connectome issue #35.)
 */
export function bedrockModelSupportsPromptCaching(model: string): boolean {
  const id = model.toLowerCase();
  if (!id.includes('claude')) return false;
  // (?![a-z0-9]) = family boundary: end of id, or a separator (-, ., :)
  // before a date/qualifier — matches the whole family, not one spelling.
  return !/claude-(v2|instant|3-(opus|sonnet|haiku)|3-5-sonnet)(?![a-z0-9])/.test(id);
}

export function resolvePromptCaching(recipe: Recipe, model: string): boolean | undefined {
  if (recipe.agent.promptCaching !== undefined) return recipe.agent.promptCaching;
  if (recipe.agent.provider === 'bedrock') return bedrockModelSupportsPromptCaching(model);
  return undefined; // membrane default (on)
}

/**
 * Membrane-level counterpart of resolvePromptCaching, spread into the
 * Membrane constructor config. The per-agent flag only governs agent
 * inference; internal callers (autobio compression, executeMerge) read
 * Membrane's defaultPromptCaching — so an explicit recipe override must
 * land at BOTH layers, on every provider, or `promptCaching: false` on
 * an Anthropic recipe would silently keep caching on for internal calls.
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
  return {
    name: agentName,
    model,
    systemPrompt: recipe.agent.systemPrompt,
    maxTokens: recipe.agent.maxTokens ?? 16384,
    maxStreamTokens: recipe.agent.maxStreamTokens ?? 150000,
    contextBudgetTokens: recipe.agent.contextBudgetTokens,
    // cacheTtl is withheld at the HOST layer on bedrock: the transport
    // only has the default 5m cache, and older membrane releases forward
    // the ttl field Bedrock rejects. Note this is not the whole story —
    // Agent Framework still supplies its own default ('1h') downstream
    // when the host omits the field, and membrane ≥0.5.77 strips it at
    // the provider boundary before wire dispatch. Requests are safe, but
    // pre-adapter config is NOT cache-TTL telemetry; the wire truth lives
    // at the adapter.
    ...(recipe.agent.cacheTtl && recipe.agent.provider !== 'bedrock'
      && { cacheTtl: recipe.agent.cacheTtl }),
    ...(promptCaching !== undefined && { promptCaching }),
    // Prefill scaffold (anthropic-xml formatter), e.g. chapterx CLI-sim's
    // '<cmd>cat untitled.txt</cmd>' — part of migrating prefill-era bots.
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
    ...(recipe.agent.thinking && { thinking: recipe.agent.thinking }),
    ...(recipe.agent.refusalHandling && { refusalHandling: recipe.agent.refusalHandling }),
    ...(recipe.agent.retirement && { retirement: recipe.agent.retirement }),
    ...(recipe.agent.sameRoundThinkTextPolicy !== undefined
      ? { sameRoundThinkTextPolicy: recipe.agent.sameRoundThinkTextPolicy }
      : {}),
    ...(recipe.agent.proseRouting !== undefined
      ? { proseRouting: recipe.agent.proseRouting }
      : {}),
  };
}
