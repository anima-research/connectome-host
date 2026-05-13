#!/usr/bin/env bun
/**
 * Probe whether Anthropic's API accepts historical thinking blocks without
 * cryptographic signatures, when the current request has extended thinking
 * enabled.
 *
 * Context: claude.ai web export contains thinking text but no signatures
 * (claude.ai never plumbed signatures into the export pipeline). To resume
 * those conversations via API with extended thinking on — preserving the
 * model's cognitive mode — we need to know which of these the API tolerates:
 *
 *   case A: signature field omitted
 *   case B: signature field empty string ""
 *   case C: thinking wrapped as <recovered_thinking> text (control — must work)
 *   case D: redacted_thinking block (alt encoding the API natively supports)
 *
 * Cases that succeed unlock the corresponding import strategy.
 *
 * Last run: 2026-05-13 against claude-sonnet-4-5-20250929. Results:
 *   A_no_signature     → 400 invalid_request_error "signature: Field required"
 *   B_empty_signature  → 400 invalid_request_error "Invalid `signature` in `thinking` block"
 *   C_wrapped_text     → 200 OK; response itself contained native thinking
 *   D_redacted_thinking → 400 invalid_request_error "Invalid `data` in `redacted_thinking`"
 * Conclusion: signatures are server-generated HMACs, cryptographically validated,
 * cannot be forged or stripped. Wrapped text is the only path that round-trips.
 * Re-run if Anthropic loosens this in future API versions.
 *
 * Run: ANTHROPIC_API_KEY=sk-... bun scripts/test-historical-thinking.ts
 */

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('Set ANTHROPIC_API_KEY');
  process.exit(1);
}

const MODEL = process.env.MODEL ?? 'claude-sonnet-4-5-20250929';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';

// A fabricated past turn: user asked something, assistant thought, then spoke.
// This mirrors the shape of an exported claude.ai assistant message.
const FAKE_PAST_THINKING =
  'The user is asking about prime numbers. The smallest prime is 2 — sometimes ' +
  'people forget 1 is not prime by convention. I should give the answer plainly.';
const FAKE_PAST_TEXT = 'The smallest prime number is 2.';

interface Case {
  name: string;
  description: string;
  assistantBlocks: unknown[];
}

const CASES: Case[] = [
  {
    name: 'A_no_signature',
    description: 'thinking block with signature field omitted entirely',
    assistantBlocks: [
      { type: 'thinking', thinking: FAKE_PAST_THINKING },
      { type: 'text', text: FAKE_PAST_TEXT },
    ],
  },
  {
    name: 'B_empty_signature',
    description: 'thinking block with signature: ""',
    assistantBlocks: [
      { type: 'thinking', thinking: FAKE_PAST_THINKING, signature: '' },
      { type: 'text', text: FAKE_PAST_TEXT },
    ],
  },
  {
    name: 'C_wrapped_text_control',
    description: 'recovered_thinking as wrapped text (must succeed)',
    assistantBlocks: [
      {
        type: 'text',
        text: `<recovered_thinking>${FAKE_PAST_THINKING}</recovered_thinking>\n\n${FAKE_PAST_TEXT}`,
      },
    ],
  },
  {
    name: 'D_redacted_thinking',
    description: 'redacted_thinking block (data field is base64-ish placeholder)',
    assistantBlocks: [
      { type: 'redacted_thinking', data: Buffer.from('unrecoverable').toString('base64') },
      { type: 'text', text: FAKE_PAST_TEXT },
    ],
  },
];

async function runCase(c: Case): Promise<{ ok: boolean; status: number; body: string }> {
  const body = {
    model: MODEL,
    max_tokens: 4096,
    temperature: 1,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    messages: [
      { role: 'user', content: 'What is the smallest prime number?' },
      { role: 'assistant', content: c.assistantBlocks },
      { role: 'user', content: 'And what is the next one after that?' },
    ],
  };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

function summarize(body: string, ok: boolean): string {
  try {
    const parsed = JSON.parse(body);
    if (ok) {
      const blocks = (parsed.content ?? []) as Array<{ type: string; text?: string }>;
      const reply = blocks.find((b) => b.type === 'text')?.text ?? '<no text>';
      const hadThinking = blocks.some((b) => b.type === 'thinking');
      return `OK; reply=${JSON.stringify(reply.slice(0, 80))}; thinking_in_response=${hadThinking}`;
    }
    return `${parsed.error?.type ?? 'error'}: ${parsed.error?.message ?? body.slice(0, 200)}`;
  } catch {
    return body.slice(0, 200);
  }
}

async function main() {
  console.log(`Model: ${MODEL}\n`);
  for (const c of CASES) {
    process.stdout.write(`[${c.name}] ${c.description} ... `);
    try {
      const { ok, status, body } = await runCase(c);
      console.log(`${ok ? 'PASS' : 'FAIL'} (${status}) — ${summarize(body, ok)}\n`);
    } catch (err) {
      console.log(`THROW — ${(err as Error).message}\n`);
    }
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
