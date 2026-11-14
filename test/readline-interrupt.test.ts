import { afterEach, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readEnvFile } from '../src/setup/secrets.js';

const INDEX = resolve(import.meta.dir, '..', 'src', 'index.ts');

const dirs: string[] = [];
const hosts: ChildProcess[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    if (host.exitCode !== null || host.signalCode !== null) continue;
    const exited = new Promise<void>((done) => host.once('exit', () => done()));
    host.kill('SIGKILL');
    await exited;
  }
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function until(check: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(25);
  }
}

test.skipIf(process.platform !== 'linux')(
  'in readline mode, a Ctrl-C while a turn waits on its model ends the host by its own shutdown, with exit 0 and without readline\'s use-after-close error (Linux only)',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'readline-interrupt-'));
    dirs.push(dir);
    let turns = 0;
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === '/v1/messages/count_tokens') return Response.json({ input_tokens: 10 });
        if (pathname !== '/v1/messages') return new Response('not found', { status: 404 });
        turns += 1;
        return new Promise<Response>((done) => {
          request.signal.addEventListener('abort', () => done(new Response('aborted', { status: 499 })));
        });
      },
    });
    servers.push(server);
    const recipe = join(dir, 'recipe.json');
    writeFileSync(recipe, JSON.stringify({
      name: 'Readline interrupt',
      agent: { name: 'readline', model: 'claude-opus-5-5', systemPrompt: 'Answer briefly.' },
      modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
    }));
    const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => name !== 'MODEL' && !/^(ANTHROPIC|OPENAI|OPENROUTER|BEDROCK|AWS|CODEX|CONNECTOME)_/.test(name)));
    Object.assign(env, {
      ANTHROPIC_API_KEY: 'sk-ant-readline-interrupt',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
      THINKING_BINDING_PROBE: 'off',
      DATA_DIR: join(dir, 'data'),
      TERM: 'xterm-256color',
    });
    const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;
    const command = `stty cols 120 rows 40; exec ${[process.execPath, INDEX, recipe, '--no-tui'].map(quote).join(' ')}`;
    const host = spawn('script', ['-qfec', command, '/dev/null'], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    hosts.push(host);
    let output = '';
    host.stdout!.on('data', (chunk) => { output += String(chunk); });
    host.stderr!.on('data', (chunk) => { output += String(chunk); });
    const exit = new Promise<number | null>((done) => host.once('close', (code) => done(code)));

    await until(() => output.includes('(readline mode)'), 60_000, `the host's readline prompt (output: ${output.slice(-1500)})`);
    host.stdin!.write('hello\r');
    await until(() => turns > 0, 30_000, `the turn's request (output: ${output.slice(-1500)})`);
    host.stdin!.write('\x03');

    expect(await exit).toBe(0);
    expect(output).toContain('Shutting down...');
    expect(output).not.toContain('ERR_USE_AFTER_CLOSE');
  },
  120_000,
);

const sse = (events: Array<Record<string, unknown> & { type: string }>): Response =>
  new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });

const reply = (id: string, stop: string, block: Record<string, unknown>, delta: Record<string, unknown>): Response => sse([
  { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: block },
  { type: 'content_block_delta', index: 0, delta },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
]);

test.skipIf(process.platform !== 'linux')(
  'in readline mode, setup--ask_secret asks on the host\'s own terminal without echoing what is typed, and stores it, in the turn setup opens (Linux only)',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'readline-secret-'));
    dirs.push(dir);
    const bodies: Array<{ tools?: Array<{ name: string }>; messages: unknown[] }> = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === '/v1/messages/count_tokens') return Response.json({ input_tokens: 10 });
        if (pathname !== '/v1/messages') return new Response('not found', { status: 404 });
        const body = await request.json() as (typeof bodies)[number];
        bodies.push(body);
        const tool = body.tools?.find((each) => each.name.endsWith('ask_secret'))?.name;
        if (bodies.length === 1 && tool) {
          return reply('msg_ask', 'tool_use', { type: 'tool_use', id: 'toolu_ask', name: tool, input: {} },
            { type: 'input_json_delta', partial_json: JSON.stringify({ name: 'TEST_SECRET', purpose: 'a test secret' }) });
        }
        return reply(`msg_${bodies.length}`, 'end_turn', { type: 'text', text: '' }, { type: 'text_delta', text: 'Stored.' });
      },
    });
    servers.push(server);
    const recipe = join(dir, 'recipe.json');
    writeFileSync(recipe, JSON.stringify({
      name: 'Readline secret',
      agent: { name: 'readline', model: 'claude-opus-5-5', systemPrompt: 'Answer briefly.', allowedTools: ['setup--ask_secret'] },
      modules: { setup: true, subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
    }));
    const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => name !== 'MODEL' && !/^(ANTHROPIC|OPENAI|OPENROUTER|BEDROCK|AWS|CODEX|CONNECTOME)_/.test(name)));
    Object.assign(env, {
      ANTHROPIC_API_KEY: 'sk-ant-readline-secret',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
      THINKING_BINDING_PROBE: 'off',
      DATA_DIR: join(dir, 'data'),
      CONNECTOME_SETUP_DIR: dir,
      TERM: 'xterm-256color',
    });
    const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;
    const command = `stty cols 120 rows 40; exec ${[process.execPath, INDEX, recipe, '--no-tui'].map(quote).join(' ')}`;
    const host = spawn('script', ['-qfec', command, '/dev/null'], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    hosts.push(host);
    let output = '';
    host.stdout!.on('data', (chunk) => { output += String(chunk); });
    host.stderr!.on('data', (chunk) => { output += String(chunk); });
    const exit = new Promise<number | null>((done) => host.once('close', (code) => done(code)));

    await until(() => output.includes('(readline mode)'), 60_000, `the host's readline prompt (output: ${output.slice(-1500)})`);
    await until(() => output.includes('TEST_SECRET (a test secret), typed hidden'), 30_000,
      `the hidden question (requests: ${bodies.length}; output: ${output.slice(-1500)})`);
    host.stdin!.write('the-typed-value\r');
    await until(() => bodies.length >= 2, 30_000, `the turn's next request (output: ${output.slice(-1500)})`);

    expect(JSON.stringify(bodies[1]!.messages)).toContain(`stored as TEST_SECRET in ${join(dir, '.env')}`);
    expect(readEnvFile(join(dir, '.env')).get('TEST_SECRET')).toBe('the-typed-value');
    expect(output).not.toContain('the-typed-value');
    host.stdin!.write('/quit\r');
    expect(await exit).toBe(0);
    expect(output).not.toContain('the-typed-value');
  },
  120_000,
);

type Body = { tools?: Array<{ name: string }>; messages: Array<{ role: string; content: unknown }> };

const lastFromPerson = (body: Body): string => {
  const message = body.messages.filter((each) => each.role === 'user').at(-1)!;
  if (typeof message.content === 'string') return message.content;
  return (message.content as Array<{ type: string; text?: string }>).filter((block) => block.type === 'text').at(-1)?.text ?? '';
};

const carries = (text: string, said: string): boolean =>
  text === said || (/^[^:\n]+: /.test(text) && text.slice(text.indexOf(': ') + 2) === said);

function startHost(dir: string, modules: Record<string, unknown>,
  answer: (body: Body, bodies: Body[]) => Response | Promise<Response>, allowedTools?: string[],
  hold?: (request: Request) => Promise<Response>, recipeMore: Record<string, unknown> = {}) {
  const bodies: Body[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === '/v1/messages/count_tokens') return Response.json({ input_tokens: 10 });
      if (pathname !== '/v1/messages') return new Response('not found', { status: 404 });
      const body = await request.json() as Body;
      bodies.push(body);
      return hold ? hold(request) : answer(body, bodies);
    },
  });
  servers.push(server);
  const recipe = join(dir, 'recipe.json');
  writeFileSync(recipe, JSON.stringify({
    name: 'Readline paste',
    agent: { name: 'readline', model: 'claude-opus-5-5', systemPrompt: 'Answer briefly.', ...(allowedTools ? { allowedTools } : {}) },
    modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false, ...modules },
    ...recipeMore,
  }));
  const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => name !== 'MODEL' && !/^(ANTHROPIC|OPENAI|OPENROUTER|BEDROCK|AWS|CODEX|CONNECTOME)_/.test(name)));
  Object.assign(env, {
    ANTHROPIC_API_KEY: 'sk-ant-readline-paste',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
    THINKING_BINDING_PROBE: 'off',
    DATA_DIR: join(dir, 'data'),
    CONNECTOME_SETUP_DIR: dir,
    CONNECTOME_UPDATE_CHECK: '0',
    TERM: 'xterm-256color',
  });
  const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;
  const command = `stty cols 120 rows 40; exec ${[process.execPath, INDEX, recipe, '--no-tui'].map(quote).join(' ')}`;
  const host = spawn('script', ['-qfec', command, '/dev/null'], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  hosts.push(host);
  const seen = { output: '' };
  host.stdout!.on('data', (chunk) => { seen.output += String(chunk); });
  host.stderr!.on('data', (chunk) => { seen.output += String(chunk); });
  const exit = new Promise<number | null>((done) => host.once('close', (code) => done(code)));
  return { host, bodies, seen, exit };
}

const said = (text: string) => (_body: Body, bodies: Body[]) =>
  reply(`msg_${bodies.length}`, 'end_turn', { type: 'text', text: '' }, { type: 'text_delta', text });

const linux = test.skipIf(process.platform !== 'linux');

linux('in readline mode, two lines entered together, as a terminal sends a paste, are answered in order, each in its own turn, and the prompt comes once, after the second answer (Linux only)',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'readline-two-lines-'));
    dirs.push(dir);
    let echoed = (): boolean => false;
    const answers = async (body: Body, bodies: Body[]) => {
      if (bodies.length === 1) await until(echoed, 30_000, 'the second line\'s Enter, echoed by readline');
      return said(`Answer number ${bodies.length}.`)(body, bodies);
    };
    const { bodies, seen, exit } = startHost(dir, {}, answers);
    echoed = () => /second line\r*\n/.test(seen.output);
    await until(() => seen.output.includes('(readline mode)'), 60_000, `the prompt (output: ${seen.output.slice(-1500)})`);
    seen.output = seen.output.slice(seen.output.indexOf('(readline mode)'));
    const host = hosts.at(-1)!;
    host.stdin!.write('first line\rsecond line\r');
    await until(() => {
      const at = seen.output.indexOf('Answer number 2.');
      return at >= 0 && seen.output.slice(at).includes('> ');
    }, 60_000, `both answers and a prompt after the second (requests: ${bodies.length}; output: ${seen.output.slice(-1500)})`);
    const first = seen.output.indexOf('Answer number 1.');
    const second = seen.output.indexOf('Answer number 2.');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
    expect(seen.output.slice(seen.output.indexOf('first line'), second)).not.toContain('> ');
    expect(seen.output.slice(second).split('> ')).toHaveLength(2);
    expect(carries(lastFromPerson(bodies[0]!), 'first line'), lastFromPerson(bodies[0]!)).toBe(true);
    expect(carries(lastFromPerson(bodies[1]!), 'second line'), lastFromPerson(bodies[1]!)).toBe(true);
    host.stdin!.write('/quit\r');
    expect(await exit).toBe(0);
  },
  120_000,
);

linux('setup\'s host speaks first, on a message that says it\'s setup\'s, shows a command it runs under the lead alone with no trace, and opens again where it stopped when started again (Linux only)',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'readline-setup-open-'));
    dirs.push(dir);
    const runs = (body: Body, bodies: Body[]) => {
      const tool = body.tools?.find((each) => each.name.endsWith('run'))?.name;
      if (bodies.length === 1 && tool) {
        return reply('msg_run', 'tool_use', { type: 'tool_use', id: 'toolu_run', name: tool, input: {} },
          { type: 'input_json_delta', partial_json: JSON.stringify({ command: 'echo shown-command' }) });
      }
      return reply(`msg_${bodies.length}`, 'end_turn', { type: 'text', text: '' }, { type: 'text_delta', text: 'Hello from setup.' });
    };
    const first = startHost(dir, { setup: true }, runs, ['setup--run']);
    await until(() => promptAfterLast(first.seen.output, 'Hello from setup.'), 60_000,
      `setup's first words and the prompt after its turn (requests: ${first.bodies.length}; output: ${first.seen.output.slice(-1500)})`);
    const opening = lastFromPerson(first.bodies[0]!);
    expect(carries(opening, 'From setup, not the person: they\'ve started setup, and this conversation holds nothing yet: what setup did before, if it ran here, stays on disk.'), opening).toBe(true);
    expect(JSON.stringify(first.bodies[0]!.messages)).not.toContain('started setup again');
    expect(first.seen.output).toContain('Setup\'s agent runs:\r\n  echo shown-command');
    expect(first.seen.output).not.toContain('[tool');
    hosts.at(-1)!.stdin!.write('/quit\r');
    expect(await first.exit).toBe(0);

    const again = startHost(dir, { setup: true }, said('Welcome back.'), ['setup--run']);
    await until(() => again.seen.output.includes('Welcome back.'), 60_000,
      `setup's words on its second start (requests: ${again.bodies.length}; output: ${again.seen.output.slice(-1500)})`);
    const resumed = again.bodies[0]!;
    expect(JSON.stringify(resumed.messages)).toContain('they\'ve started setup, and this conversation holds nothing yet: what setup did before, if it ran here, stays on disk.');
    expect(JSON.stringify(resumed.messages)).toContain('Hello from setup.');
    const reopening = lastFromPerson(resumed);
    expect(carries(reopening, 'From setup, not the person: they\'ve started setup again, and this conversation picks up where it stopped.'), reopening).toBe(true);
    hosts.at(-1)!.stdin!.write('/quit\r');
    expect(await again.exit).toBe(0);
  },
  180_000,
);

linux('setup--finished records setup finished, the host ends once that turn is done, and a later start says when it finished (Linux only)',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'readline-setup-finished-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.setup'), { recursive: true });
    writeFileSync(join(dir, '.setup', 'setup-state.json'), JSON.stringify({ v: 1 }));
    const finishes = (body: Body, bodies: Body[]) => {
      const tool = body.tools?.find((each) => each.name.endsWith('finished'))?.name;
      if (bodies.length === 1 && tool) {
        return reply('msg_finish', 'tool_use', { type: 'tool_use', id: 'toolu_finish', name: tool, input: {} },
          { type: 'input_json_delta', partial_json: '{}' });
      }
      return reply(`msg_${bodies.length}`, 'end_turn', { type: 'text', text: '' }, { type: 'text_delta', text: 'All set, goodbye.' });
    };
    const first = startHost(dir, { setup: true }, finishes, ['setup--finished']);
    expect(await first.exit).toBe(0);
    expect(first.seen.output).toContain('All set, goodbye.');
    const state = JSON.parse(readFileSync(join(dir, '.setup', 'setup-state.json'), 'utf-8')) as { v: number; finished?: string };
    expect(state.v).toBe(1);
    expect(Number.isNaN(Date.parse(state.finished ?? ''))).toBe(false);

    const again = startHost(dir, { setup: true }, said('What would you like to change?'), ['setup--finished']);
    await until(() => again.seen.output.includes('What would you like to change?'), 60_000,
      `setup's words on its next start (output: ${again.seen.output.slice(-1500)})`);
    const reopening = lastFromPerson(again.bodies[0]!);
    expect(carries(reopening, `From setup, not the person: they've started setup again after it finished, at ${state.finished}, and this conversation picks up where it stopped.`), reopening).toBe(true);
    hosts.at(-1)!.stdin!.write('/quit\r');
    expect(await again.exit).toBe(0);
  },
  180_000,
);

linux('a Ctrl-C while setup\'s opening turn waits on its model ends the host, and the next start, whose conversation holds that opening alone, picks it up where it stopped (Linux only)',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'readline-setup-open-c-'));
    dirs.push(dir);
    const waiting = startHost(dir, { setup: true }, () => new Response('the opening is held', { status: 500 }), ['setup--run'],
      (request) => new Promise<Response>((done) => {
        request.signal.addEventListener('abort', () => done(new Response('aborted', { status: 499 })));
      }));
    await until(() => waiting.bodies.length > 0, 60_000, `the opening's request (output: ${waiting.seen.output.slice(-1500)})`);
    hosts.at(-1)!.stdin!.write('\x03');
    expect(await waiting.exit).toBe(0);

    const again = startHost(dir, { setup: true }, said('Welcome back.'), ['setup--run']);
    await until(() => again.seen.output.includes('Welcome back.'), 60_000,
      `setup's words on its second start (requests: ${again.bodies.length}; output: ${again.seen.output.slice(-1500)})`);
    const request = JSON.stringify(again.bodies[0]!.messages);
    expect(request.split('they\'ve started setup, and this conversation holds nothing yet: what setup did before, if it ran here, stays on disk.')).toHaveLength(2);
    const reopening = lastFromPerson(again.bodies[0]!);
    expect(carries(reopening, 'From setup, not the person: they\'ve started setup again, and this conversation picks up where it stopped.'), reopening).toBe(true);
    hosts.at(-1)!.stdin!.write('/quit\r');
    expect(await again.exit).toBe(0);
  },
  180_000,
);

linux('a line typed while setup\'s opening turn waits on its model is answered after the opening, and the prompt comes once, after its answer (Linux only)',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'readline-setup-typed-'));
    dirs.push(dir);
    let release = (): void => {};
    const released = new Promise<void>((done) => { release = done; });
    const answers = async (_body: Body, bodies: Body[]) => {
      if (bodies.length === 1) {
        await released;
        return said('Opening words.')(_body, bodies);
      }
      return said('Answer to hi.')(_body, bodies);
    };
    const typed = startHost(dir, { setup: true }, answers, ['setup--run']);
    await until(() => typed.bodies.length > 0, 60_000, `the opening's request (output: ${typed.seen.output.slice(-1500)})`);
    hosts.at(-1)!.stdin!.write('typed-while-held\r');
    await until(() => /typed-while-held\r*\n/.test(typed.seen.output), 30_000,
      `the typed line's Enter, echoed by readline, while the opening is held (output: ${typed.seen.output.slice(-1500)})`);
    expect(typed.bodies).toHaveLength(1);
    release();
    await until(() => {
      const at = typed.seen.output.indexOf('Answer to hi.');
      return at >= 0 && typed.seen.output.slice(at).includes('> ');
    }, 60_000, `the answer to hi and a prompt after it (requests: ${typed.bodies.length}; output: ${typed.seen.output.slice(-1500)})`);
    const output = typed.seen.output;
    const opening = output.indexOf('Opening words.');
    const answer = output.indexOf('Answer to hi.');
    expect(opening).toBeGreaterThanOrEqual(0);
    expect(answer).toBeGreaterThan(opening);
    expect(output.slice(0, answer)).not.toContain('> ');
    expect(output.slice(answer).split('> ')).toHaveLength(2);
    expect(carries(lastFromPerson(typed.bodies[1]!), 'typed-while-held'), lastFromPerson(typed.bodies[1]!)).toBe(true);
    hosts.at(-1)!.stdin!.write('/quit\r');
    expect(await typed.exit).toBe(0);
  },
  120_000,
);

linux('a line still waiting to go in when the person switches session isn\'t sent, and the host says so; a session change typed with the switch is refused as under way; a line typed after the switch goes in after the new opening; and setup--finished in the new conversation ends the host once that line is answered (Linux only)',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'readline-setup-switch-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.setup'), { recursive: true });
    writeFileSync(join(dir, '.setup', 'setup-state.json'), JSON.stringify({ v: 1 }));
    let output = (): string => '';
    const answers = async (body: Body, bodies: Body[]) => {
      if (bodies.length === 2) await until(() => /\/session new\r*\n/.test(output()), 30_000, 'the switch\'s Enter, echoed by readline');
      if (bodies.length === 3) await until(() => /after line\r*\n/.test(output()), 30_000, 'the after line\'s Enter, echoed by readline');
      const tool = body.tools?.find((each) => each.name.endsWith('finished'))?.name;
      if (bodies.length === 3 && tool) {
        return reply('msg_finish', 'tool_use', { type: 'tool_use', id: 'toolu_finish', name: tool, input: {} },
          { type: 'input_json_delta', partial_json: '{}' });
      }
      return said(`Answer number ${bodies.length}.`)(body, bodies);
    };
    const host = startHost(dir, { setup: true }, answers, ['setup--finished']);
    output = () => host.seen.output;
    await until(() => promptAfterLast(host.seen.output, 'Answer number 1.'), 60_000,
      `the opening's answer and a prompt (output: ${host.seen.output.slice(-1500)})`);
    hosts.at(-1)!.stdin!.write('held line\r');
    await until(() => host.bodies.length === 2, 30_000, `the held line's request (output: ${host.seen.output.slice(-1500)})`);
    hosts.at(-1)!.stdin!.write('queued line\r');
    await until(() => /queued line\r*\n/.test(host.seen.output), 30_000,
      `the queued line's Enter, echoed by readline (output: ${host.seen.output.slice(-1500)})`);
    hosts.at(-1)!.stdin!.write('/session new\r/session rename too-soon\r');
    await until(() => host.bodies.length === 3, 30_000, `the new conversation's opening request (output: ${host.seen.output.slice(-1500)})`);
    hosts.at(-1)!.stdin!.write('after line\r');
    expect(await host.exit).toBe(0);
    expect(host.seen.output).toContain('Not sent, since a session switch was asked for before it went in: "queued line"');
    expect(host.seen.output).toContain('refused: a session switch is under way.');
    expect(JSON.stringify(host.bodies)).not.toContain('queued line');
    expect(carries(lastFromPerson(host.bodies[2]!), 'From setup, not the person: they\'ve started a new conversation with setup. What setup has done stays on disk, and this conversation doesn\'t hold it.'), lastFromPerson(host.bodies[2]!)).toBe(true);
    expect(host.bodies).toHaveLength(5);
    expect(carries(lastFromPerson(host.bodies[4]!), 'after line'), lastFromPerson(host.bodies[4]!)).toBe(true);
    expect(host.seen.output).toContain('Answer number 5.');
    const state = JSON.parse(readFileSync(join(dir, '.setup', 'setup-state.json'), 'utf-8')) as { finished?: string };
    expect(Number.isNaN(Date.parse(state.finished ?? ''))).toBe(false);
  },
  180_000,
);

linux('a line still waiting to go in when the person ends the conversation isn\'t sent, and the host says so (Linux only)',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'readline-quit-waiting-'));
    dirs.push(dir);
    let output = (): string => '';
    const answers = async (body: Body, bodies: Body[]) => {
      await until(() => /\/quit\r*\n/.test(output()), 30_000, 'the /quit\'s Enter, echoed by readline');
      return said(`Answer number ${bodies.length}.`)(body, bodies);
    };
    const host = startHost(dir, {}, answers);
    output = () => host.seen.output;
    await until(() => host.seen.output.includes('(readline mode)'), 60_000, `the prompt (output: ${host.seen.output.slice(-1500)})`);
    hosts.at(-1)!.stdin!.write('held line\r');
    await until(() => host.bodies.length === 1, 30_000, `the held line's request (output: ${host.seen.output.slice(-1500)})`);
    hosts.at(-1)!.stdin!.write('queued line\r');
    await until(() => /queued line\r*\n/.test(host.seen.output), 30_000,
      `the queued line's Enter, echoed by readline (output: ${host.seen.output.slice(-1500)})`);
    hosts.at(-1)!.stdin!.write('/quit\r');
    expect(await host.exit).toBe(0);
    expect(host.seen.output).toContain('A line you typed hadn\'t gone in to the agent yet, and won\'t now.');
    expect(JSON.stringify(host.bodies)).not.toContain('queued line');
  },
  120_000,
);

linux('a line typed while a turn runs that holds what the person then enters hidden isn\'t sent, and the host says so without quoting it (Linux only)',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'readline-hidden-queued-'));
    dirs.push(dir);
    let output = (): string => '';
    const answers = async (body: Body, bodies: Body[]) => {
      const tool = body.tools?.find((each) => each.name.endsWith('ask_secret'))?.name;
      if (bodies.length === 2 && tool) {
        await until(() => /my token is tok-hidden-9\r*\n/.test(output()), 30_000, 'the queued line\'s Enter, echoed by readline');
        return reply('msg_ask', 'tool_use', { type: 'tool_use', id: 'toolu_ask', name: tool, input: {} },
          { type: 'input_json_delta', partial_json: JSON.stringify({ name: 'TEST_SECRET', purpose: 'a test secret' }) });
      }
      return said(`Answer number ${bodies.length}.`)(body, bodies);
    };
    const host = startHost(dir, { setup: true }, answers, ['setup--ask_secret']);
    output = () => host.seen.output;
    await until(() => promptAfterLast(host.seen.output, 'Answer number 1.'), 60_000,
      `the opening's answer and a prompt (output: ${host.seen.output.slice(-1500)})`);
    hosts.at(-1)!.stdin!.write('first line\r');
    await until(() => host.bodies.length === 2, 30_000, `the first line's request (output: ${host.seen.output.slice(-1500)})`);
    hosts.at(-1)!.stdin!.write('my token is tok-hidden-9\r');
    await until(() => host.seen.output.includes('TEST_SECRET (a test secret), typed hidden'), 30_000,
      `the hidden question (output: ${host.seen.output.slice(-1500)})`);
    hosts.at(-1)!.stdin!.write('tok-hidden-9\r');
    await until(() => host.seen.output.includes('Not sent, since it holds what you entered hidden.') || host.bodies.length >= 4, 30_000,
      `the queued line's fate (output: ${host.seen.output.slice(-1500)})`);
    hosts.at(-1)!.stdin!.write('after line\r');
    await until(() => host.bodies.some((each) => lastFromPerson(each).endsWith('after line')), 30_000,
      `the next line's request, which goes after anything still queued (output: ${host.seen.output.slice(-1500)})`);
    hosts.at(-1)!.stdin!.write('/quit\r');
    expect(await host.exit).toBe(0);
    expect(host.seen.output).toContain('Not sent, since it holds what you entered hidden.');
    expect(JSON.stringify(host.bodies)).not.toContain('tok-hidden-9');
    expect(readEnvFile(join(dir, '.env')).get('TEST_SECRET')).toBe('tok-hidden-9');
  },
  180_000,
);

linux('a line typed while a turn runs that holds what the person then enters hidden, and that a session switch then overtakes, isn\'t sent or quoted (Linux only)',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'readline-hidden-switch-'));
    dirs.push(dir);
    let output = (): string => '';
    const answers = async (body: Body, bodies: Body[]) => {
      const tool = body.tools?.find((each) => each.name.endsWith('ask_secret'))?.name;
      if (bodies.length === 2 && tool) {
        await until(() => /my token is tok-hidden-7\r*\n/.test(output()), 30_000, 'the queued line\'s Enter, echoed by readline');
        return reply('msg_ask', 'tool_use', { type: 'tool_use', id: 'toolu_ask', name: tool, input: {} },
          { type: 'input_json_delta', partial_json: JSON.stringify({ name: 'TEST_SECRET', purpose: 'a test secret' }) });
      }
      if (bodies.length === 3) await until(() => /\/session new\r*\n/.test(output()), 30_000, 'the switch\'s Enter, echoed by readline');
      return said(`Answer number ${bodies.length}.`)(body, bodies);
    };
    const host = startHost(dir, { setup: true }, answers, ['setup--ask_secret']);
    output = () => host.seen.output;
    await until(() => promptAfterLast(host.seen.output, 'Answer number 1.'), 60_000,
      `the opening's answer and a prompt (output: ${host.seen.output.slice(-1500)})`);
    hosts.at(-1)!.stdin!.write('first line\r');
    await until(() => host.bodies.length === 2, 30_000, `the first line's request (output: ${host.seen.output.slice(-1500)})`);
    hosts.at(-1)!.stdin!.write('my token is tok-hidden-7\r');
    await until(() => host.seen.output.includes('TEST_SECRET (a test secret), typed hidden'), 30_000,
      `the hidden question (output: ${host.seen.output.slice(-1500)})`);
    hosts.at(-1)!.stdin!.write('tok-hidden-7\r');
    await until(() => host.bodies.length === 3, 30_000, `the hidden answer's request (output: ${host.seen.output.slice(-1500)})`);
    hosts.at(-1)!.stdin!.write('/session new\r');
    await until(() => host.bodies.length === 4 && promptAfterLast(host.seen.output, 'Answer number 4.'), 60_000,
      `the new conversation's opening answer and a prompt (output: ${host.seen.output.slice(-1500)})`);
    hosts.at(-1)!.stdin!.write('/quit\r');
    expect(await host.exit).toBe(0);
    expect(host.seen.output).not.toContain('"my token is tok-hidden-7"');
    expect(host.seen.output).toContain('Not sent, since it holds what you entered hidden.');
    expect(host.bodies).toHaveLength(4);
    expect(carries(lastFromPerson(host.bodies[3]!), 'From setup, not the person: they\'ve started a new conversation with setup. What setup has done stays on disk, and this conversation doesn\'t hold it.'), lastFromPerson(host.bodies[3]!)).toBe(true);
    expect(JSON.stringify(host.bodies)).not.toContain('tok-hidden-7');
    expect(readEnvFile(join(dir, '.env')).get('TEST_SECRET')).toBe('tok-hidden-7');
  },
  180_000,
);

linux('what a setup host\'s libraries say on stderr while it starts goes to its readline log, not the person\'s terminal, and a start that fails still says why there (Linux only)',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'readline-setup-quiet-'));
    dirs.push(dir);
    const extension = join(dir, 'diagnostic.mjs');
    writeFileSync(extension, "console.error('[test-library] a diagnostic while the host starts');\nexport function register() {}\n");
    const quiet = startHost(dir, { setup: true }, said('Hello.'), ['setup--run'], undefined,
      { extensions: { diagnostic: { kind: 'module', path: extension } } });
    await until(() => quiet.seen.output.includes('Hello.'), 60_000, `setup's first words (output: ${quiet.seen.output.slice(-1500)})`);
    expect(quiet.seen.output).not.toContain('[test-library]');
    expect(readFileSync(join(dir, 'data', 'readline-error.log'), 'utf-8')).toContain('[test-library] a diagnostic while the host starts');
    hosts.at(-1)!.stdin!.write('/quit\r');
    expect(await quiet.exit).toBe(0);

    const other = mkdtempSync(join(tmpdir(), 'readline-setup-quiet-fails-'));
    dirs.push(other);
    const failing = join(other, 'refusing.mjs');
    writeFileSync(failing, "export function register() { throw new Error('this extension refuses to load'); }\n");
    const refused = startHost(other, { setup: true }, said('Hello.'), ['setup--run'], undefined,
      { extensions: { refusing: { kind: 'module', path: failing } } });
    expect(await refused.exit).toBe(1);
    expect(refused.seen.output).toContain('this extension refuses to load');
  },
  180_000,
);

const REFUSED_TURN = 'The model refused that turn. This can come from anything in the conversation, not only what you just wrote. ' +
  'Try once more; if it refuses again, /session new starts a new conversation with setup\'s agent, and what setup has done ' +
  'stays on disk.';

const refuses = (_body: Body, bodies: Body[]) =>
  reply(`msg_${bodies.length}`, 'refusal', { type: 'text', text: '' }, { type: 'text_delta', text: 'Partial.' });

const promptAfterLast = (output: string, text: string): boolean =>
  output.includes(text) && output.slice(output.lastIndexOf(text)).includes('> ');

linux('in setup, a refused turn says so and a prompt follows, with no refusal-streak alert; a refused reopening says so only at its own turn; /session new opens a new conversation; and a switch back opens the older one where it stopped (Linux only)',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'readline-setup-refused-'));
    dirs.push(dir);
    const refused = startHost(dir, { setup: true }, refuses, ['setup--run']);
    await until(() => promptAfterLast(refused.seen.output, REFUSED_TURN), 60_000,
      `the refused opening's line and a prompt (requests: ${refused.bodies.length}; output: ${refused.seen.output.slice(-1500)})`);
    hosts.at(-1)!.stdin!.write('hi\r');
    await until(() => refused.seen.output.split(REFUSED_TURN).length === 3 && promptAfterLast(refused.seen.output, REFUSED_TURN), 60_000,
      `the refused answer's line and a prompt (requests: ${refused.bodies.length}; output: ${refused.seen.output.slice(-1500)})`);
    expect(refused.seen.output).not.toContain('refusal streak');
    hosts.at(-1)!.stdin!.write('/quit\r');
    expect(await refused.exit).toBe(0);

    const answers = (_body: Body, bodies: Body[]) =>
      bodies.length === 1 ? refuses(_body, bodies) : said('A new conversation.')(_body, bodies);
    const again = startHost(dir, { setup: true }, answers, ['setup--run']);
    await until(() => promptAfterLast(again.seen.output, REFUSED_TURN), 60_000,
      `the refused reopening's line and a prompt (requests: ${again.bodies.length}; output: ${again.seen.output.slice(-1500)})`);
    expect(again.seen.output.slice(0, again.seen.output.indexOf(REFUSED_TURN)).split(dir).join('')).not.toContain('refused');
    expect(carries(lastFromPerson(again.bodies[0]!), 'From setup, not the person: they\'ve started setup again, and this conversation picks up where it stopped.')).toBe(true);
    hosts.at(-1)!.stdin!.write('/session new\r');
    await until(() => promptAfterLast(again.seen.output, 'A new conversation.'), 60_000,
      `the new conversation's opening answer and a prompt (requests: ${again.bodies.length}; output: ${again.seen.output.slice(-1500)})`);
    const fresh = again.bodies[1]!;
    expect(carries(lastFromPerson(fresh), 'From setup, not the person: they\'ve started a new conversation with setup. What setup has done stays on disk, and this conversation doesn\'t hold it.'), lastFromPerson(fresh)).toBe(true);
    expect(JSON.stringify(fresh.messages)).not.toContain('Partial.');
    expect(again.seen.output.indexOf('Session switched.')).toBeLessThan(again.seen.output.indexOf('A new conversation.'));
    hosts.at(-1)!.stdin!.write('/quit\r');
    expect(await again.exit).toBe(0);

    const third = startHost(dir, { setup: true }, said('Hello again.'), ['setup--run']);
    await until(() => promptAfterLast(third.seen.output, 'Hello again.'), 60_000,
      `setup's words on its third start (requests: ${third.bodies.length}; output: ${third.seen.output.slice(-1500)})`);
    const listed = third.seen.output.length;
    hosts.at(-1)!.stdin!.write('/session list\r');
    await until(() => third.seen.output.slice(listed).includes('--- Sessions (2) ---') && third.seen.output.slice(listed).includes(' *'), 30_000,
      `the session list (output: ${third.seen.output.slice(-1500)})`);
    const older = third.seen.output.slice(listed).split(/\r?\n/).find((line) => /\[[^\]]+\]/.test(line) && !line.trimEnd().endsWith('*'));
    const id = older?.match(/\[([^\]]+)\]/)?.[1];
    expect(id).toBeDefined();
    const switching = third.seen.output.length;
    hosts.at(-1)!.stdin!.write(`/session switch ${id}\r`);
    await until(() => third.bodies.length >= 2 && promptAfterLast(third.seen.output.slice(switching), 'Hello again.'), 60_000,
      `the switched conversation's opening answer (requests: ${third.bodies.length}; output: ${third.seen.output.slice(-1500)})`);
    expect(carries(lastFromPerson(third.bodies[1]!), 'From setup, not the person: they\'ve switched to this conversation, and it picks up where it stopped.'), lastFromPerson(third.bodies[1]!)).toBe(true);
    hosts.at(-1)!.stdin!.write('/quit\r');
    expect(await third.exit).toBe(0);
  },
  300_000,
);
