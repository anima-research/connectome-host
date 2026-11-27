import type { Membrane } from '@animalabs/membrane';
import type { Recipe } from './recipe.js';
import { auxiliaryRequest } from './auxiliary-model.js';
import { storedInjectionMarkOf } from '@animalabs/agent-framework';

const DEFAULT_EXAMPLES = [
  'Context Window Budgeting',
  'Agent Memory Architecture',
  'Pipeline Debug Session',
  'Schema Migration Plan',
  'API Integration Review',
];

function buildNamingPrompt(examples?: string[]): string {
  const exampleList = (examples ?? DEFAULT_EXAMPLES)
    .map(e => `- "${e}"`)
    .join('\n');

  return `You are a session naming assistant. Given a brief summary of a conversation, generate a short, evocative name (2-4 words) that captures its essence. The name should be memorable and descriptive, like a chapter title.

Examples of good names:
${exampleList}

Respond with ONLY the name, nothing else. No quotes, no explanation.`;
}

export function namingSummary(
  messages: ReadonlyArray<{ participant: string; content: ReadonlyArray<{ type: string; text?: unknown }>; metadata?: unknown }>,
): string {
  return messages
    .filter(m => m.content.some(b => b.type === 'text') && storedInjectionMarkOf(m.metadata) === undefined)
    .slice(0, 6)
    .map(m => {
      const text = m.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text)
        .join(' ');
      return `${m.participant}: ${text.slice(0, 200)}`;
    })
    .join('\n');
}

/**
 * A name for the session from the host's auxiliary model (auxiliaryRequest:
 * the model, cap and reasoning effort the recipe's provider takes), or null
 * when the model's answer isn't one or the call fails. Either is said once
 * per process, on stderr, which each runtime routes to its log (headless.log,
 * tui-error.log, readline-error.log: the files /bug reads), so a host whose
 * naming calls are refused, or whose
 * model spends its cap before the name, says so instead of leaving sessions
 * unnamed in silence.
 */
export async function generateSessionName(
  membrane: Membrane,
  conversationSummary: string,
  examples: string[] | undefined,
  recipe: Recipe,
): Promise<string | null> {
  const request = auxiliaryRequest(recipe, 30);
  try {
    const response = await membrane.complete({
      messages: [
        {
          participant: 'user',
          content: [{ type: 'text', text: conversationSummary }],
        },
      ],
      system: buildNamingPrompt(examples),
      ...request,
    });

    const text = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    if (!text || text.length > 60 || text.includes('\n')) {
      namingFailed(request.config.model, `its answer wasn't a name (stop reason ${response.stopReason ?? 'unknown'}, ` +
        `${text.length} characters${text.includes('\n') ? ', with a newline' : ''})`);
      return null;
    }
    return text;
  } catch (error) {
    namingFailed(request.config.model, `the call failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

let namingFailureLogged = false;

function namingFailed(model: string, why: string): void {
  if (namingFailureLogged) return;
  namingFailureLogged = true;
  process.stderr.write(`[session-naming] the naming call to ${model} gave no name, so this session keeps its default name ` +
    `(said once per process; recipe auxiliaryModel picks the model): ${why}\n`);
}

/** Forgets that the warning was given, so a test can see it given again. */
export function resetSessionNamingWarning(): void {
  namingFailureLogged = false;
}
