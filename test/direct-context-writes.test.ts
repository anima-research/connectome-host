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
 * `forAgent`, or an EventResponse's `addMessages` whose inference request
 * names none) is stamped for every agent that takes untargeted inbound in
 * the slot it lands in: on a residents' host, every resident. So each such
 * write is listed too, as a row meant for every one of them (each
 * EventResponse's `addMessages` is listed, with whom its request names); a
 * row about one agent's work names that agent. A write whose target (its
 * fourth argument) holds `forAgent` other than as an object literal's own
 * property (under a `?:`, an `&&` or an `||`, or in a spread) is listed as
 * well: on some path the row names no agent. A `forAgent` in another
 * argument names no one.
 *
 * The scan reads each source file under src/ as Bun transpiles it, so
 * comments and types are gone, with the text of its string literals,
 * templates and regular expressions blanked. It finds every call of a
 * context manager's writing or branch-moving methods by its receiver, every
 * mention of one of those methods that isn't a call (`cm.addMessage.bind(cm)`:
 * what is done with it isn't read), every call or other mention of
 * storeOwnRow, by its name or an alias it is imported as, and every mention
 * of `addMessages`.
 *
 * The scan goes by names, not by what they hold (#485 review, 32). A
 * receiver named `ctx` is taken as a module's context and one named
 * `framework` as the framework, whatever they are bound to: a context
 * manager held in a variable named `ctx` passes as a module's context, and
 * a branch moved through another object named `framework` passes as the
 * framework's. A target `{ forAgent: name }` is taken as naming an agent
 * whatever `name` holds. A method reached by destructuring
 * (`const { addMessage } = cm`) or by a computed name (`cm['addMessage']`)
 * isn't found. Such a write is left to review.
 */
import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { blankLiterals } from './blank-literals.js';

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'src');

/** A context manager's methods that write a context or move the store's
 *  branch, and those that make a branch or a context from one (fork, derive). */
const WRITERS = [
  'addMessage', 'editMessage', 'removeMessage', 'removeMessages', 'resetHeadWindow', 'presentRows', 'retractRows',
  'branchAt', 'switchBranch', 'fork', 'derive',
];
/** A writer's receiver: a name, its members, and calls in it
 *  (`getAgent(name).getContextManager()`), one level of parentheses deep. */
const RECEIVER = '([A-Za-z_$][\\w$]*(?:\\??\\.[A-Za-z_$][\\w$]*|\\([^()]*\\))*)';
/** A writer's call by its receiver, an optional call (`?.(`) among them. */
const CALL = new RegExp(`${RECEIVER}\\??\\.(${WRITERS.join('|')})(?:\\?\\.)?\\(`, 'g');
/** A writer's mention by its receiver that isn't a call. */
const MENTION = new RegExp(`${RECEIVER}\\??\\.(${WRITERS.join('|')})(?![\\w$])(?!\\s*(?:\\?\\.)?\\()`, 'g');

/** A module's context writes through the framework; so do the framework's own branch moves. */
function throughTheFramework(receiver: string, method: string): boolean {
  const plain = receiver.replace(/\?/g, '');
  if (/(^|\.)ctx$/.test(plain)) return ['addMessage', 'editMessage', 'removeMessage'].includes(method);
  if (/(^|\.)framework$/.test(plain)) return method === 'switchBranch';
  return false;
}

const TRANSPILERS = { ts: new Bun.Transpiler({ loader: 'ts' }), tsx: new Bun.Transpiler({ loader: 'tsx' }) };

/** A source file as the scan reads it: transpiled, its literals blanked. */
function prepared(source: string, loader: 'ts' | 'tsx' = 'ts'): string {
  return blankLiterals(TRANSPILERS[loader].transformSync(source));
}

/** The argument text of the call whose opening parenthesis ends at `from`,
 *  in code whose literals are blanked: up to its closing parenthesis. */
function argumentsAt(code: string, from: number): string {
  let depth = 1;
  for (let i = from; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) return code.slice(from, i);
  }
  return code.slice(from);
}

/** A call's arguments, split at their top-level commas. */
function topLevelArguments(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { parts.push(args.slice(from, i)); from = i + 1; }
  }
  parts.push(args.slice(from));
  return parts;
}

/** Whom a module context's addMessage names for its row, read from its
 *  target, the fourth argument (a `forAgent` in another, the metadata say,
 *  names no one): no agent (`none`) when it doesn't mention `forAgent`;
 *  `named` when it is an object literal with `forAgent` as one of its own
 *  properties, whatever its value; otherwise `conditional`, as for
 *  `name ? { forAgent: name } : undefined`, `{ ...(ok && { forAgent }) }`
 *  or `ok || { forAgent }`, whose row names no agent on some path. */
function targetOf(args: string): 'named' | 'none' | 'conditional' {
  const target = topLevelArguments(args)[3]?.trim();
  if (target === undefined || !/\bforAgent\b/.test(target)) return 'none';
  if (!isObjectLiteral(target)) return 'conditional';
  const own = topLevelArguments(target.slice(1, -1)).some((property) => /^\s*forAgent\b\s*(:|$)/.test(property));
  return own ? 'named' : 'conditional';
}

/** Whether `code` is one object literal: a `{` whose matching `}` ends it,
 *  not `{ … } || { … }`. */
function isObjectLiteral(code: string): boolean {
  if (!code.startsWith('{')) return false;
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    if ('([{'.includes(code[i]!)) depth++;
    else if (')]}'.includes(code[i]!) && --depth === 0) return i === code.length - 1;
  }
  return false;
}

/** A module context's addMessage, which the framework stamps for whom its target names. */
const contextAdd = (receiver: string, method: string): boolean =>
  method === 'addMessage' && /(^|\.)ctx$/.test(receiver.replace(/\?/g, ''));

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
    file: 'src/modules/tui-module.ts',
    call: 'EventResponse.addMessages',
    count: 1,
    why: "An external message (one sent over IPC, or typed into the TUI). agent-framework stamps it for the agents its " +
      "inference request names (the event's targetAgents), and for every resident when it names none or requests " +
      'no inference: no host sender names one.',
  },
  {
    file: 'src/modules/subscription-gc-module.ts',
    call: 'EventResponse.addMessages',
    count: 1,
    why: "The note that subscription-gc closed a channel after more ambient traffic there than its limit. The count is " +
      "kept per channel, not per agent: meant for every resident.",
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

/** In one prepared file, every call and other mention of a writer past the
 *  framework, every untargeted or conditionally targeted write through it,
 *  every call and other mention of storeOwnRow (by its name or an alias it
 *  is imported as), and every mention of `addMessages`, counted into `found`. */
function scanCode(file: string, code: string, found: Map<string, number>): void {
  const count = (key: string) => found.set(key, (found.get(key) ?? 0) + 1);
  for (const match of code.matchAll(CALL)) {
    const [, receiver, method] = match;
    const call = `${receiver!.replace(/\?/g, '')}.${method}`;
    if (!throughTheFramework(receiver!, method!)) count(`${file} ${call}`);
    else if (contextAdd(receiver!, method!)) {
      const target = targetOf(argumentsAt(code, match.index! + match[0].length));
      if (target === 'none') count(`${file} ${call} (untargeted)`);
      else if (target === 'conditional') count(`${file} ${call} (target in a conditional)`);
    }
  }
  for (const [, receiver, method] of code.matchAll(MENTION)) count(`${file} ${receiver!.replace(/\?/g, '')}.${method} (not a call)`);
  const imports = [...code.matchAll(/\b(?:import|export)\s*\{[^}]*\}/g)];
  const aliases = imports.flatMap((m) => [...m[0].matchAll(/\bstoreOwnRow\s+as\s+([A-Za-z_$][\w$]*)/g)].map((a) => a[1]!));
  const inImport = (at: number) => imports.some((m) => at >= m.index! && at < m.index! + m[0].length);
  const own = new RegExp(`(?<![\\w$])(?:[A-Za-z_$][\\w$]*\\??\\.)?(?:${['storeOwnRow', ...aliases].join('|')})(?![\\w$])(\\s*(?:\\?\\.)?\\()?`, 'g');
  for (const match of code.matchAll(own)) {
    if (inImport(match.index!)) continue;
    count(match[1] !== undefined ? `${file} storeOwnRow` : `${file} storeOwnRow (not a call)`);
  }
  for (const _ of code.matchAll(/(?<![\w$])addMessages(?![\w$])/g)) count(`${file} EventResponse.addMessages`);
}

/** scanCode over every source file under src/. */
function scan(): Map<string, number> {
  const found = new Map<string, number>();
  for (const path of sources(SRC)) {
    const file = relative(ROOT, path).split('\\').join('/');
    scanCode(file, prepared(readFileSync(path, 'utf8'), path.endsWith('.tsx') ? 'tsx' : 'ts'), found);
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

  test("the scan tells a module context's write that names its agent from one that names none, or names one only on a condition", () => {
    const code = prepared([
      'export class C { m(ctx: any, name: string, note: string, ok: boolean) {',
      "this.ctx?.addMessage('user', [{ type: 'text', text: `[x] (${name}) done` }]);",
      "this.ctx.addMessage('user', [{ type: 'text', text: note }], undefined, { forAgent: name });",
      "ctx.addMessage('user', [], {}, name ? { forAgent: name } : undefined);",
      "ctx.addMessage('user', [], {}, { ...(ok ? { forAgent: name } : {}) });",
      "ctx.addMessage('user', [{ type: 'text', text: 'a ) in a string' }]);",
      "ctx.addMessage('user', [{ type: 'text', text: 'not { forAgent: name }' }]);",
      "ctx.addMessage('user', [{ type: 'text', text: ok ? 'yes' : 'no' }], {}, { forAgent: name ?? 'clerk' });",
      // Host #485 bot review wave 3, finding 33: these two read `named`.
      "ctx.addMessage('user', [], {}, { ...(ok && { forAgent: name }) });",
      "ctx.addMessage('user', [], { forAgent: name });",
      "ctx.addMessage('user', [], {}, { channel: 'c', forAgent: name });",
      "ctx.addMessage('user', [], {}, ok || { forAgent: name });",
      "ctx.addMessage('user', [], {}, { channel: 'c' } && { forAgent: name });",
      '} }',
    ].join('\n'));
    const calls = [...code.matchAll(CALL)].map((match) => targetOf(argumentsAt(code, match.index! + match[0].length)));
    expect(calls).toEqual(['none', 'named', 'conditional', 'conditional', 'none', 'none', 'named', 'conditional', 'none', 'named', 'conditional', 'conditional']);
    // And scanCode counts them so (host #485 bot review wave 4, finding 18):
    // no write under src/ names its agent on a condition, so the inventory
    // can't show a scan that doesn't count one.
    const found = new Map<string, number>();
    scanCode('f.ts', code, found);
    expect(Object.fromEntries(found)).toEqual({
      'f.ts this.ctx.addMessage (untargeted)': 1,
      'f.ts ctx.addMessage (untargeted)': 3,
      'f.ts ctx.addMessage (target in a conditional)': 5,
    });
  });

  test('the scan finds a direct write and a branch move by their receivers, and passes a module context and the framework', () => {
    // Inside a method, as the host's module code is, so `this` stays `this`.
    const code = prepared([
      'export class C { m(agent: any, ctx: any, cm: any, app: any, id: string) {',
      "agent?.getContextManager().addMessage('user', []);",
      "app.framework.getAgent(id)?.getContextManager().addMessage('user', []);",
      "void cm.fork('f');",
      "this.ctx?.addMessage('user', [], {}, { forAgent: 'a' });",
      'ctx.removeMessage(id);',
      "cm.branchAt(id, 'b');",
      "void app.framework.switchBranch('b');",
      "void cm.switchBranch('b');",
      "cm.retractRows?.([id], { undone: true });",
      '// cm.addMessage in a comment',
      "console.log('cm.addMessage(', \"ctx.removeMessage(id)\", `cm.fork(${id})`, /cm\\.branchAt\\(/);",
      'f(cm, id);',
      '} }',
    ].join('\n'));
    const calls = [...code.matchAll(CALL)].map(([, receiver, method]) => ({
      call: `${receiver!.replace(/\?/g, '')}.${method}`,
      through: throughTheFramework(receiver!, method!),
    }));
    expect(calls).toEqual([
      { call: 'agent.getContextManager().addMessage', through: false },
      { call: 'app.framework.getAgent(id).getContextManager().addMessage', through: false },
      { call: 'cm.fork', through: false },
      { call: 'this.ctx.addMessage', through: true },
      { call: 'ctx.removeMessage', through: true },
      { call: 'cm.branchAt', through: false },
      { call: 'app.framework.switchBranch', through: true },
      { call: 'cm.switchBranch', through: false },
      { call: 'cm.retractRows', through: false },
    ]);
    // And scanCode counts the direct ones, each, and not the module
    // context's or the framework's (#485 bot review 5, finding 28).
    const found = new Map<string, number>();
    scanCode('f.ts', code, found);
    expect(Object.fromEntries(found)).toEqual({
      'f.ts agent.getContextManager().addMessage': 1,
      'f.ts app.framework.getAgent(id).getContextManager().addMessage': 1,
      'f.ts cm.fork': 1,
      'f.ts cm.branchAt': 1,
      'f.ts cm.switchBranch': 1,
      'f.ts cm.retractRows': 1,
    });
  });

  test("the scan counts a writer's mention that isn't a call, storeOwnRow under an alias, and an EventResponse's addMessages", () => {
    const code = prepared([
      "import { storeOwnRow as stamp } from '@animalabs/agent-framework';",
      'export class C { m(agent: any, cm: any, ctx: any) {',
      "const write = cm.addMessage.bind(cm); write('user', []);",
      "const send = ctx.addMessage; send('user', []);",
      "stamp(agent, 'user', []);",
      'const later = stamp;',
      "console.log('storeOwnRow(agent)', 'addMessages');",
      "return { addMessages: [{ participant: 'user', content: [] }] };",
      '} }',
    ].join('\n'));
    const found = new Map<string, number>();
    scanCode('f.ts', code, found);
    expect(Object.fromEntries(found)).toEqual({
      'f.ts cm.addMessage (not a call)': 1,
      'f.ts ctx.addMessage (not a call)': 1,
      'f.ts storeOwnRow': 1,
      'f.ts storeOwnRow (not a call)': 1,
      'f.ts EventResponse.addMessages': 1,
    });
  });

  test('blanking literals keeps code in a template and after a division', () => {
    const code = prepared([
      'export function f(cm: any, a: number, b: number, id: string) {',
      'const half = a / b; const re = /["\\/]/g;',
      // Host #485 bot review wave 4, finding 17: a division after a postfix
      // `++` or `--`, which Bun keeps on the line of what follows it.
      "const up = a++ / 2 + cm.addMessage('user', []); const down = b-- / 2 + cm.fork(id);",
      // Review wave 5, finding 27: a division right after a template's or a
      // string's closing quote.
      "const t = `${a}` / 2 + cm.addMessage('user', []); const s = '4' / b + cm.fork(id); const d = \"6\" / a + cm.branchAt(id);",
      "return `${cm.addMessage('user', [])} and ${half / 2}` + 'x' + re.source + cm.fork(id);",
      '}',
    ].join('\n'));
    expect([...code.matchAll(CALL)].map(([, receiver, method]) => `${receiver}.${method}`))
      .toEqual(['cm.addMessage', 'cm.fork', 'cm.addMessage', 'cm.fork', 'cm.branchAt', 'cm.addMessage', 'cm.fork']);
    expect(code).not.toContain('"\\/');
  });
});
