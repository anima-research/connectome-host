/**
 * Synesthete — auto-generates evocative session names via a quick Haiku call.
 *
 * Called after a few user messages in an auto-named session. Produces a
 * 2–4 word name that captures the session's topic/mood.
 */

import type { Membrane } from '@animalabs/membrane';

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

/**
 * Generate a session name from conversation content.
 * Returns the generated name, or null if the call fails.
 */
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

    // Sanity check: should be short and non-empty
    if (!text || text.length > 60 || text.includes('\n')) return null;
    return text;
  } catch {
    return null;
  }
}
