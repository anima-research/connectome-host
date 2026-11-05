import type { Membrane } from '@animalabs/membrane';
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

export async function generateSessionName(
  membrane: Membrane,
  conversationSummary: string,
  examples?: string[],
): Promise<string | null> {
  try {
    const response = await membrane.complete({
      messages: [
        {
          participant: 'user',
          content: [{ type: 'text', text: conversationSummary }],
        },
      ],
      system: buildNamingPrompt(examples),
      config: {
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 30,
        temperature: 0.8,
      },
    });

    const text = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    if (!text || text.length > 60 || text.includes('\n')) return null;
    return text;
  } catch {
    return null;
  }
}
