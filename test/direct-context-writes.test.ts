/**
 * The host writes into an agent's context, and moves the store's branch, only
 * through the framework (#291, HOST-1), apart from the writes listed here.
 *
 * Every agent's context follows its own window over the one store: a row
 * stored is shown to an agent when the framework presents it, by the audience
 * it is stamped for, at that agent's presentation points. A row the host
 * stores straight into a context manager carries no stamp and bypasses the
 * framework's presentation and its surgery hold; a branch the host moves
 * through one agent's context manager moves under every agent sharing the
 * store, past the framework's reservation of it. So host code writes through
 * a module's context (`ctx.addMessage`, with `forAgent` for a row meant for
 * one agent), moves branches with the framework's own operations, and stamps
 * an agent's own rows with agent-framework's storeOwnRow, which the list
 * below names with why each is safe where it is.
 *
 * A module's write that names no agent (`ctx.addMessage` without
 * `forAgent`) is stamped for every agent that takes untargeted inbound in
 * the slot it lands in: on a residents' host, every resident. So each such
 * write is listed too, as a row meant for every one of them; a row about
 * one agent's work names that agent.
 *
 * The scan reads each source file under src/ as Bun transpiles it, so
 * comments and types are gone, and finds every call of a context manager's
 * writing or branch-moving methods by its receiver.
 */
import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'src');

/** A context manager's methods that write a context or move the store's branch. */
const WRITERS = ['addMessage', 'editMessage', 'removeMessage', 'removeMessages', 'resetHeadWindow', 'presentRows', 'retractRows', 'branchAt', 'switchBranch'];
const CALL = new RegExp(
  `([A-Za-z_$][\\w$]*(?:\\??\\.[A-Za-z_$][\\w$]*|\\(\\))*)\\??\\.(${WRITERS.join('|')})\\(`,
  'g',
);

/** A module's context writes through the framework; so do the framework's own branch moves. */
function throughTheFramework(receiver: string, method: string): boolean {
  const plain = receiver.replace(/\?/g, '');
  if (/(^|\.)ctx$/.test(plain)) return ['addMessage', 'editMessage', 'removeMessage'].includes(method);
  if (/(^|\.)framework$/.test(plain)) return method === 'switchBranch';
  return false;
}

/** The argument text of the call whose opening parenthesis ends at `from`:
 *  up to its closing parenthesis, strings skipped whole. */
function argumentsAt(code: string, from: number): string {
  let depth = 1;
  for (let i = from; i < code.length; i++) {
    const c = code[i]!;
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < code.length && code[i] !== c; i++) if (code[i] === '\\') i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return code.slice(from, i);
  }
  return code.slice(from);
}

/** A module context's addMessage that names no agent for its row. */
const untargeted = (receiver: string, method: string, args: string): boolean =>
  method === 'addMessage' && /(^|\.)ctx$/.test(receiver.replace(/\?/g, '')) && !/\bforAgent\b/.test(args);

/** The writes the host makes past the framework, and its untargeted writes through it, each counted, with why it is safe. */
const ALLOWED: Array<{ file: string; call: string; count: number; why: string }> = [
  {
    file: 'src/commands.ts',
    call: 'cm.resetHeadWindow',
    count: 1,
    why: "/newtopic's transition, given its text or after its summary, stamped as the agent's own row (asOwnRow). " +
      'context-manager presents it as it stores it, ' +
      "before the head window starts at it, and the command stores it only where it has found the agent idle with no turn " +
      'alive (idleWithNoTurn, which counts a continuation or a retry on its way), with no await between: given its text, ' +
      'as the command is given, and for a bare /newtopic once the summary is written. Otherwise it stores nothing.',
  },
  {
    file: 'src/modules/time-module.ts',
    call: 'ctx.addMessage (untargeted)',
    count: 1,
    why: "The session's start time, once per session: meant for every resident.",
  },
  {
    file: 'src/modules/lifecycle-module.ts',
    call: 'ctx.addMessage (untargeted)',
    count: 1,
    why: 'The note after a self-restart, saying who asked, when, why and when the host came back: meant for every resident.',
  },
  {
    file: 'src/modules/subagent-module.ts',
    call: 'ctx.addMessage (untargeted)',
    count: 1,
    why: "An async run's result or failure with no launcher named (addForLauncher): the host's unnamed agent's, " +
      'whom it wakes, as main has it (#467). A run whose launcher or current attempt is listed is written for that ' +
      'agent; one whose launcher or launching attempt has ended, for the nearest listed agent above the launcher, ' +
      'else the primary, waking nobody. Only with no agent listed at all is that one written for none.',
  },
  {
    file: 'src/modules/subagent-module.ts',
    call: 'storeOwnRow',
    count: 7,
    why: "A spawn's or fork's seed rows (its orientation and task, a fork's copy of its parent's context and the fork " +
      'pair), stored in the child\'s own context before its run registers it: no turn of the child is alive, and the ' +
      'run presents them as it takes the child on.',
  },
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

/** Every call of a writer past the framework, and of storeOwnRow, by file and call, counted. */
function scan(): Map<string, number> {
  const transpilers = { ts: new Bun.Transpiler({ loader: 'ts' }), tsx: new Bun.Transpiler({ loader: 'tsx' }) };
  const found = new Map<string, number>();
  const count = (key: string) => found.set(key, (found.get(key) ?? 0) + 1);
  for (const path of sources(SRC)) {
    const file = relative(ROOT, path).split('\\').join('/');
    const code = transpilers[path.endsWith('.tsx') ? 'tsx' : 'ts'].transformSync(readFileSync(path, 'utf8'));
    for (const match of code.matchAll(CALL)) {
      const [, receiver, method] = match;
      const call = `${receiver!.replace(/\?/g, '')}.${method}`;
      if (!throughTheFramework(receiver!, method!)) count(`${file} ${call}`);
      else if (untargeted(receiver!, method!, argumentsAt(code, match.index! + match[0].length))) count(`${file} ${call} (untargeted)`);
    }
    for (const _ of code.matchAll(/(?<![\w$.])storeOwnRow\(/g)) count(`${file} storeOwnRow`);
  }
  return found;
}

describe('direct context writes', () => {
  test('the host writes into an agent\'s context, and moves the branch, only through the framework, but for the listed writes', () => {
    const found = scan();
    const listed = new Map(ALLOWED.map((entry) => [`${entry.file} ${entry.call}`, entry.count]));
    // Each found call is listed, as many times as it is found; each listed one is still there.
    expect(Object.fromEntries(found)).toEqual(Object.fromEntries(listed));
  });

  test("the scan tells a module context's write that names its agent from one that names none", () => {
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    const code = transpiler.transformSync([
      'export class C { m(ctx: any, name: string, note: string) {',
      "this.ctx?.addMessage('user', [{ type: 'text', text: `[x] (${name}) done` }]);",
      "this.ctx.addMessage('user', [{ type: 'text', text: note }], undefined, { forAgent: name });",
      "ctx.addMessage('user', [], {}, name ? { forAgent: name } : undefined);",
      "ctx.addMessage('user', [{ type: 'text', text: 'a ) in a string' }]);",
      '} }',
    ].join('\n'));
    const calls = [...code.matchAll(CALL)].map((match) => untargeted(match[1]!, match[2]!, argumentsAt(code, match.index! + match[0].length)));
    expect(calls).toEqual([true, false, false, true]);
  });

  test('the scan finds a direct write and a branch move by their receivers, and passes a module context and the framework', () => {
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    // Inside a method, as the host's module code is, so `this` stays `this`.
    const code = transpiler.transformSync([
      'export class C { m(agent: any, ctx: any, cm: any, app: any, id: string) {',
      "agent?.getContextManager().addMessage('user', []);",
      "this.ctx?.addMessage('user', [], {}, { forAgent: 'a' });",
      'ctx.removeMessage(id);',
      "cm.branchAt(id, 'b');",
      "void app.framework.switchBranch('b');",
      "void cm.switchBranch('b');",
      '// cm.addMessage in a comment',
      'f(cm, id);',
      '} }',
    ].join('\n'));
    const calls = [...code.matchAll(CALL)].map(([, receiver, method]) => ({
      call: `${receiver!.replace(/\?/g, '')}.${method}`,
      through: throughTheFramework(receiver!, method!),
    }));
    expect(calls).toEqual([
      { call: 'agent.getContextManager().addMessage', through: false },
      { call: 'this.ctx.addMessage', through: true },
      { call: 'ctx.removeMessage', through: true },
      { call: 'cm.branchAt', through: false },
      { call: 'app.framework.switchBranch', through: true },
      { call: 'cm.switchBranch', through: false },
    ]);
  });
});
