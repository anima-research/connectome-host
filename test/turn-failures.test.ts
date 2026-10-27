import { describe, expect, test } from 'bun:test';
import { createPipedTurns } from '../src/piped-turns.js';
import { createFailureLines, failureCountLine, turnEndedLine, type ShownLine } from '../src/state/turn-failures.js';
import { failureHint } from '../src/failure-hint.js';
import type { Recipe } from '../src/recipe.js';

const recipe = (agent: Record<string, unknown> = {}) => ({ name: 'r', agent: { name: 'clerk', ...agent } }) as unknown as Recipe;

function batch(hint: (errorType: string | undefined) => string | undefined = () => undefined) {
  const err: string[] = [];
  const turns = createPipedTurns('clerk', { write: () => {}, log: () => {}, error: (line) => { err.push(line); } }, hint);
  const emit = (type: string, extra: Record<string, unknown> = {}, agentName = 'clerk') => turns.onTrace({ type, agentName, ...extra });
  const attempt = (error: string, agentName = 'clerk') => {
    emit('inference:started', {}, agentName);
    emit('inference:failed', { error }, agentName);
  };
  return { err, emit, attempt, turns };
}

describe('a batch run\'s failed turn', () => {
  test('prints each failure once, and when the turn gives up, how many attempts it made and what to check', () => {
    const { err, emit, attempt } = batch((type) => (type === 'network' ? 'Check the network.' : undefined));
    attempt('Connection error.');
    attempt('Connection error.');
    attempt('Connection error.');
    emit('inference:exhausted', { error: 'Connection error.', errorType: 'network' });
    expect(err).toEqual(['Error: Connection error.', 'Turn ended after 3 attempts. Check the network.']);
  });

  test('prints a failure with other words on a line of its own', () => {
    const { err, emit, attempt } = batch();
    attempt('Connection error.');
    attempt('overloaded');
    attempt('overloaded');
    attempt('Connection error.');
    emit('inference:exhausted', { error: 'Connection error.', errorType: 'server' });
    expect(err).toEqual(['Error: Connection error.', 'Error: overloaded', 'Error: Connection error.', 'Turn ended after 4 attempts.']);
  });

  test('a retry that answers ends the turn with no count, and the next turn counts from one', () => {
    const { err, emit, attempt } = batch();
    attempt('Connection error.');
    emit('inference:started');
    emit('inference:completed');
    attempt('Connection error.');
    emit('inference:exhausted', { error: 'Connection error.' });
    expect(err).toEqual(['Error: Connection error.', 'Error: Connection error.', 'Turn ended after 1 attempt.']);
  });

  test('another agent\'s failures print once, and its giving up isn\'t the line\'s turn ending', () => {
    const { err, emit, attempt } = batch(() => 'Check the network.');
    attempt('Connection error.', 'spawn-a');
    attempt('Connection error.', 'spawn-a');
    emit('inference:exhausted', { error: 'Connection error.', errorType: 'network' }, 'spawn-a');
    expect(err).toEqual(['Error: Connection error.']);
  });

  test('a turn stopped after a failure says nothing of attempts', () => {
    const { err, emit, attempt } = batch();
    attempt('Connection error.');
    emit('inference:aborted', { reason: 'user' });
    expect(err).toEqual(['Error: Connection error.']);
  });

  test('after a turn gives up, the next turn\'s first failure gets a line of its own', () => {
    const { err, emit, attempt } = batch();
    attempt('Connection error.');
    emit('inference:exhausted', { error: 'Connection error.', errorType: 'network' });
    attempt('Connection error.');
    emit('inference:exhausted', { error: 'Connection error.', errorType: 'network' });
    expect(err).toEqual(['Error: Connection error.', 'Turn ended after 1 attempt.', 'Error: Connection error.', 'Turn ended after 1 attempt.']);
  });

  test('a session switch releases a line still waiting on the old framework\'s turn', async () => {
    const { err, turns } = batch();
    const waiting = turns.waitForTurn(60_000);
    turns.switched();
    await waiting;
    expect(err).toEqual([]);
  });

  test('two agents failing at once each keep their own count', () => {
    const { err, emit, attempt } = batch();
    attempt('Connection error.');
    attempt('Connection error.', 'spawn-a');
    attempt('Connection error.');
    attempt('Connection error.', 'spawn-a');
    emit('inference:exhausted', { error: 'Connection error.' });
    expect(err).toEqual(['Error: Connection error.', 'Error: Connection error.', 'Turn ended after 2 attempts.']);
  });

  // agent-framework 0.27.0 ends a stream it aborts with a lone exhausted that carries no errorType.
  test('a retry the framework aborts counts as an attempt, after the line that says the turn ended', () => {
    const { err, emit, attempt } = batch((type) => (type === undefined ? undefined : 'Check the network.'));
    attempt('Connection error.');
    emit('inference:started');
    emit('inference:exhausted', { error: 'Stream aborted: timeout' });
    expect(err).toEqual(['Error: Connection error.', '(turn ended: Stream aborted: timeout)', '2 attempts in all.']);
  });

  test('a first attempt the framework aborts says only that the turn ended', () => {
    const { err, emit } = batch((type) => (type === undefined ? undefined : 'Check the network.'));
    emit('inference:started');
    emit('inference:exhausted', { error: 'Stream aborted: timeout' });
    expect(err).toEqual(['(turn ended: Stream aborted: timeout)']);
  });

  test('a failure whose start it never saw is neither printed nor counted', () => {
    const { err, emit, attempt } = batch();
    emit('inference:failed', { error: 'Connection error.' });
    attempt('Connection error.');
    emit('inference:exhausted', { error: 'Connection error.' });
    expect(err).toEqual(['Error: Connection error.', 'Turn ended after 1 attempt.']);
  });

  test('a session switch starts the count again, and forgets the old framework\'s streams', () => {
    const { err, emit, attempt, turns } = batch();
    attempt('Connection error.');
    turns.switched();
    emit('inference:failed', { error: 'Connection error.' });
    attempt('Connection error.');
    emit('inference:exhausted', { error: 'Connection error.' });
    expect(err).toEqual(['Error: Connection error.', 'Error: Connection error.', 'Turn ended after 1 attempt.']);
  });
});

describe('the TUI\'s failure line', () => {
  test('a failure line reads its count once there is more than one', () => {
    expect(failureCountLine('Connection error.', 1)).toBe('Error: Connection error.');
    expect(failureCountLine('Connection error.', 3)).toBe('Error (×3): Connection error.');
  });

  test('the give-up line counts one attempt as one', () => {
    expect(turnEndedLine({ attempts: 1, alone: false }, undefined)).toBe('Turn ended after 1 attempt.');
    expect(turnEndedLine({ attempts: 2, alone: false }, 'Check ANTHROPIC_API_KEY.')).toBe('Turn ended after 2 attempts. Check ANTHROPIC_API_KEY.');
  });

  test("after an end that said the turn ended, the line adds only what's new", () => {
    expect(turnEndedLine({ attempts: 1, alone: true }, undefined)).toBeUndefined();
    expect(turnEndedLine({ attempts: 1, alone: true }, 'Check the network.')).toBe('Check the network.');
    expect(turnEndedLine({ attempts: 2, alone: true }, undefined)).toBe('2 attempts in all.');
    expect(turnEndedLine({ attempts: 2, alone: true }, 'Check the network.')).toBe('2 attempts in all. Check the network.');
  });

  test('a shown line is updated in place, and a gone one is replaced by a new line', () => {
    const added: Array<{ text: string; isDestroyed: boolean } & ShownLine> = [];
    const add = (text: string) => {
      const line = { text, isDestroyed: false, setText(next: string) { line.text = next; } };
      added.push(line);
      return line;
    };
    const lines = createFailureLines();
    lines.show('clerk', '10:00 ', { show: 'line', text: 'x' }, add);
    lines.show('clerk', '10:01 ', { show: 'count', text: 'x', count: 2 }, add);
    expect(added.map((l) => l.text)).toEqual(['10:00 Error (×2): x']);
    added[0]!.isDestroyed = true;
    lines.show('clerk', '10:02 ', { show: 'count', text: 'x', count: 3 }, add);
    expect(added.map((l) => l.text)).toEqual(['10:00 Error (×2): x', '10:02 Error (×3): x']);
  });

  test('a line that wasn\'t added leaves no line to update', () => {
    const added: string[] = [];
    const add = (text: string) => { added.push(text); return { setText: (next: string) => { added[0] = next; }, isDestroyed: false }; };
    const lines = createFailureLines();
    lines.show('clerk', '', { show: 'line', text: 'y' }, add);
    lines.show('clerk', '', { show: 'line', text: 'x' }, () => undefined);
    lines.show('clerk', '', { show: 'count', text: 'x', count: 2 }, add);
    expect(added).toEqual(['Error: y', 'Error (×2): x']);
  });
});

describe('what to check names where this host sends its calls', () => {
  test('a network or timeout failure names the provider\'s base URL setting, not set', () => {
    const hint = failureHint(recipe(), {}, null);
    expect(hint('network')).toBe('Check the network, any proxy, and ANTHROPIC_BASE_URL (not set, so the default).');
    expect(hint('timeout')).toBe('Check the network, any proxy, and ANTHROPIC_BASE_URL (not set, so the default).');
  });

  test('a setting that is set is named by its host only', () => {
    const env = { ANTHROPIC_BASE_URL: 'https://key:secret@gate.example.com:8443/anthropic?token=t' };
    expect(failureHint(recipe(), env, null)('network')).toBe('Check the network, any proxy, and ANTHROPIC_BASE_URL (set to gate.example.com:8443).');
    expect(failureHint(recipe(), { ANTHROPIC_BASE_URL: 'gate' }, null)('network')).toBe('Check the network, any proxy, and ANTHROPIC_BASE_URL (set, but not to a URL such as https://host:port).');
    expect(failureHint(recipe(), { ANTHROPIC_BASE_URL: 'localhost:8080' }, null)('network')).toBe('Check the network, any proxy, and ANTHROPIC_BASE_URL (set, but not to a URL such as https://host:port).');
  });

  test('each provider\'s own setting', () => {
    const net = (agent: Record<string, unknown>, env: Record<string, string> = {}) => failureHint(recipe(agent), env, null)('network');
    expect(net({ provider: 'openai-responses' })).toBe('Check the network, any proxy, and OPENAI_BASE_URL (not set, so the default).');
    expect(net({ provider: 'bedrock' }, { BEDROCK_BASE_URL: 'https://gate.example.com/bedrock/x' })).toBe('Check the network, any proxy, and BEDROCK_BASE_URL (set to gate.example.com).');
    expect(net({ provider: 'openai-codex' })).toBe('Check the network, any proxy, and CODEX_BASE_URL (not set, so the default).');
    expect(net({ provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' })).toBe("Check the network, any proxy, and the recipe's agent.baseUrl (set to localhost:11434).");
    expect(net({ provider: 'openrouter' })).toBe('Check the network and any proxy.');
    expect(net({ provider: 'mock' })).toBeUndefined();
  });

  test('an auth failure names the credential the host used', () => {
    const auth = (agent: Record<string, unknown>, env: Record<string, string> = {}, built: { provider: string } | null = null) =>
      failureHint(recipe(agent), env, built)('auth');
    expect(auth({})).toBe('Check ANTHROPIC_API_KEY.');
    expect(auth({}, {}, { provider: 'anthropic' })).toBe('Check the subscription credential (/auth status shows its state).');
    expect(auth({ provider: 'openai-responses' })).toBe('Check OPENAI_API_KEY.');
    expect(auth({ provider: 'openrouter' })).toBe('Check OPENROUTER_API_KEY.');
    expect(auth({ provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' })).toBe('Check OPENAI_COMPATIBLE_API_KEY.');
    expect(auth({ provider: 'bedrock' })).toBe('Check AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.');
    expect(auth({ provider: 'bedrock' }, { AWS_SESSION_TOKEN: 's' })).toBe('Check AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN.');
    const gate = { CODEX_GATE_TOKEN: 'g', CODEX_BASE_URL: 'https://gate.example.com/codex' };
    expect(auth({ provider: 'openai-codex' })).toBe('Check the ChatGPT login (/auth status shows its state).');
    expect(auth({ provider: 'openai-codex' }, gate)).toBe('Check CODEX_GATE_TOKEN.');
    expect(auth({ provider: 'openai-codex' }, { ...gate, CODEX_GATE_TOKEN: '  ' })).toBe('Check the ChatGPT login (/auth status shows its state).');
  });

  test('any other kind gets nothing to check', () => {
    const hint = failureHint(recipe(), {}, null);
    for (const kind of ['rate_limit', 'server', 'invalid_request', 'context_length', 'safety', 'unsupported', 'unknown', undefined]) {
      expect(hint(kind)).toBeUndefined();
    }
  });
});
