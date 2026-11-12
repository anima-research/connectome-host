import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { COMMANDS } from '../src/cli/connectome.ts';
import { slugOf } from '../src/cli/service-unit.ts';
import { parseHandWrittenJson } from '../src/hand-written-json.ts';
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, WHOLE_OUTPUT_BYTES } from '../src/modules/setup-module.ts';
import { AUDIT_STORES_FLAG } from '../src/update/audit-stores.ts';

const ROOT = join(import.meta.dir, '..');
const GUIDE = readFileSync(join(ROOT, 'docs', 'AGENT-ONBOARDING.md'), 'utf-8');

function pieces(text: string): Array<{ heading: string | null; text: string }> {
  const out: Array<{ heading: string | null; text: string }> = [{ heading: null, text: '' }];
  for (const line of text.split(/(?<=\n)/)) {
    if (line.startsWith('## ')) out.push({ heading: line.slice(3).trim(), text: '' });
    out[out.length - 1]!.text += line;
  }
  return out;
}

const PIECES = pieces(GUIDE);
const OPENING = PIECES[0]!.text;
const HEADINGS = PIECES.slice(1).map((piece) => piece.heading!);
const SPAN = /`([^`\n]+)`/g;
const SCRIPT_RUN = String.raw`bun (?:--[\w-]+ )*'?<host>\/(scripts\/[\w.-]+)'?`;
const PACKAGE = String.raw`(?:<host>|<dir>\/connectome-host\/current\/node_modules\/@animalabs\/connectome-host)`;
const SPANS = [...GUIDE.matchAll(SPAN)].map((match) => match[1]!);

describe('the setup agent reads the guide through setup--run', () => {
  it('gets the opening and each section back whole, with the next heading a sed range to it takes', () => {
    expect(HEADINGS.length).toBeGreaterThan(1);
    for (const [at, piece] of PIECES.entries()) {
      // `sed -n '<first>,<last>p'` with <last> the next heading's line, as `grep -n` lists it, prints that line too.
      const next = PIECES[at + 1]?.text.split(/(?<=\n)/)[0] ?? '';
      const bytes = Buffer.byteLength(piece.text + next);
      expect({ section: piece.heading ?? '(opening)', bytes, whole: bytes > 0 && bytes <= WHOLE_OUTPUT_BYTES })
        .toEqual({ section: piece.heading ?? '(opening)', bytes, whole: true });
    }
  });

  it('finds each step in the opening, by the name of a section that is there, and every section named there', () => {
    const steps = OPENING.split('\n').filter((line) => /^\d+\. /.test(line));
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      const named = [...step.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
      expect({ step, named: named.length > 0 }).toEqual({ step, named: true });
      for (const name of named) expect(HEADINGS).toContain(name);
    }
    for (const heading of HEADINGS) expect({ heading, inOpening: OPENING.includes(`"${heading}"`) }).toEqual({ heading, inOpening: true });
  });
});

describe('what the guide names ships, or is the install\'s own', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { files: string[] };
  // npm packs these whatever `files` says.
  const alwaysPacked = ['README.md', 'package.json'];

  it('names files in the host\'s package that are there and that the package carries', () => {
    const named = [...new Set([...GUIDE.matchAll(new RegExp(String.raw`${PACKAGE}\/([\w./-]+[\w])`, 'g'))].map((match) => match[1]!))];
    expect(named.length).toBeGreaterThan(0);
    for (const path of named) {
      const carried = alwaysPacked.includes(path) || pkg.files.some((entry) => path === entry || path.startsWith(`${entry}/`));
      expect({ path, there: existsSync(join(ROOT, path)), carried }).toEqual({ path, there: true, carried: true });
    }
  });

  it('runs the host\'s entry only as its store audit, with the flag the entry reads first', () => {
    const runs = [...GUIDE.matchAll(new RegExp(String.raw`${PACKAGE}\/src\/index\.ts'? +(\S+)`, 'g'))].map((match) => match[1]!);
    expect(runs.length).toBeGreaterThan(0);
    for (const first of runs) expect(first).toBe(AUDIT_STORES_FLAG);
  });

  it('runs only connectome commands the install\'s command has, each word one its usage takes or, where the usage takes a value, a word that holds a <placeholder> and isn\'t an option', () => {
    const usages = [...COMMANDS.map((command) => command.usage), 'connectome help'];
    const runs = SPANS.filter((span) => span.startsWith('connectome '));
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      const [, name, ...rest] = run.split(' ');
      const usage = usages.find((candidate) => candidate.split(' ')[1] === name) ?? '';
      const words = new Set(usage.replace(/[[\]()|]/g, ' ').split(/\s+/));
      const takesValue = /<[^>]+>/.test(usage);
      const fits = usage !== '' && rest.every((word) => words.has(word) || (takesValue && /<[^>]+>/.test(word) && !word.startsWith('-')));
      expect({ run, fits }).toEqual({ run, fits: true });
    }
  });

  const serversSection = () => PIECES.find((piece) => piece.heading === 'The recipe\'s servers')!.text;
  const entries = () => [...serversSection().matchAll(/```json\n([\s\S]*?)```/g)]
    .flatMap((match, fragment) => Object.entries(parseHandWrittenJson(`{${match[1]}}`) as Record<string, { env: Record<string, string> }>)
      .map(([server, entry]) => ({ fragment, server, env: entry.env })));

  it('maps DISCORD_TOKEN and the shell\'s two values into their own servers\' env as ${NAME}, and gives every other value with a <placeholder> in it', () => {
    const reads: Record<string, string[]> = { discord: ['DISCORD_TOKEN'], shell: ['SESSION_SERVER_PORT', 'SESSION_SERVER_TOKEN'] };
    const shown = entries();
    for (const server of Object.keys(reads)) expect({ server, shown: shown.some((entry) => entry.server === server) }).toEqual({ server, shown: true });
    for (const { fragment, server, env } of shown) {
      for (const name of reads[server] ?? []) {
        expect({ fragment, server, name, value: env[name] }).toEqual({ fragment, server, name, value: `\${${name}}` });
      }
      for (const [name, value] of Object.entries(env)) {
        if ((reads[server] ?? []).includes(name)) continue;
        expect({ fragment, server, name, value, placeholder: /<[^>]+>/.test(value) }).toEqual({ fragment, server, name, value, placeholder: true });
      }
    }
  });

  it('gives the recipe skeleton as JSON the host\'s loader parses', () => {
    const blocks = [...PIECES.find((piece) => piece.heading === 'The recipe')!.text.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1]!);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(() => parseHandWrittenJson(block)).not.toThrow();
  });

  it('puts each discord-mcpl state file the example names in the data directory', () => {
    const files = entries().filter((entry) => entry.server === 'discord')
      .flatMap((entry) => Object.entries(entry.env)).filter(([name]) => /^DISCORD_\w+_FILE$/.test(name));
    expect(files.length).toBeGreaterThan(0);
    for (const [name, value] of files) expect({ name, inData: posix.normalize(value).startsWith('<dir>/data/') }).toEqual({ name, inData: true });
  });

  it('is pointed into, from README.md, ARCHITECTURE.md, docs, scripts and src, as `FILE.md`\'s "Heading", `FILE.md`, "Heading" or `FILE.md#anchor`, by parts the guide, DEPLOYMENTS.md, the ingest doc and the README have, and by no section number', () => {
    const lines = (path: string) => readFileSync(join(ROOT, path), 'utf-8').split('\n');
    const joined = (path: string) => readFileSync(join(ROOT, path), 'utf-8').replace(/\s*\n\s*/g, ' ').replace(/(['"`])\s*\+\s*\1/g, '');
    const headingsOf = (path: string) => lines(path).filter((line) => /^#{2,6} /.test(line)).map((line) => line.replace(/^#+ /, '').trim());
    const partsOf = (path: string) => [...headingsOf(path), ...lines(path).flatMap((line) => [...line.matchAll(/^\*\*([^*]+?)\.\*\*/g)].map((match) => match[1]!))];
    const files = {
      'AGENT-ONBOARDING.md': 'docs/AGENT-ONBOARDING.md', 'DEPLOYMENTS.md': 'docs/DEPLOYMENTS.md', 'claude-code-ingest.md': 'docs/claude-code-ingest.md',
      'README.md': 'README.md',
    };
    const docs = Object.fromEntries(Object.entries(files).map(([doc, path]) => [doc, partsOf(path)])) as Record<keyof typeof files, string[]>;
    // An anchor names a heading alone, as GitHub renders one.
    const headings = Object.fromEntries(Object.entries(files).map(([doc, path]) => [doc, headingsOf(path)])) as Record<keyof typeof files, string[]>;
    const sources = [
      'README.md', 'ARCHITECTURE.md',
      ...new Bun.Glob('docs/**/*.md').scanSync({ cwd: ROOT }),
      ...new Bun.Glob('scripts/**/*').scanSync({ cwd: ROOT }),
      ...new Bun.Glob('src/**/*.ts').scanSync({ cwd: ROOT }),
    ];
    const slug = (heading: string) => heading.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
    const pointers: Array<{ from: string; doc: keyof typeof docs; heading: string }> = [];
    const anchors: Array<{ from: string; doc: keyof typeof docs; anchor: string }> = [];
    for (const from of sources) {
      const text = joined(from);
      for (const match of text.matchAll(/(AGENT-ONBOARDING|DEPLOYMENTS|claude-code-ingest|(?:<host>|<dir>\/connectome-host\/current\/node_modules\/@animalabs\/connectome-host)\/README)\.md`?\)?(?:\\?'s|,) ((?:"[^"]+"(?:, (?:and )?| and )?)+)/g)) {
        const doc = `${match[1]!.replace(/^.*\//, '')}.md` as keyof typeof docs;
        for (const named of match[2]!.matchAll(/"([^"]+)"/g)) pointers.push({ from, doc, heading: named[1]!.replace(/`/g, '') });
      }
      for (const match of text.matchAll(/(AGENT-ONBOARDING|DEPLOYMENTS|claude-code-ingest)\.md#([\p{L}\p{N}_-]+)/gu)) {
        anchors.push({ from, doc: `${match[1]}.md` as keyof typeof docs, anchor: match[2]! });
      }
    }
    for (const { from, doc, anchor } of anchors) {
      expect({ from, doc, anchor, there: headings[doc].some((heading) => slug(heading) === anchor) }).toEqual({ from, doc, anchor, there: true });
    }
    for (const from of sources) {
      const text = joined(from);
      const numbered = text.match(/(?:AGENT-ONBOARDING(?:\.md)?|onboarding)[^.]{0,40}?(?:§|\bsection)\s?\d|(?:§|\bsection)\s?\d[\w.]*\s+of the onboarding/gi) ?? [];
      expect({ from, numbered }).toEqual({ from, numbered: [] });
    }
    expect(pointers.length).toBeGreaterThan(0);
    for (const pointer of pointers) {
      const there = docs[pointer.doc].some((heading) => heading.replace(/`/g, '') === pointer.heading);
      expect({ ...pointer, there }).toEqual({ ...pointer, there: true });
    }
    const inner = { 'AGENT-ONBOARDING.md': /\("([^"]+)"(?:, (?:above|below))?\)/g, 'DEPLOYMENTS.md': /\("([^"]+)", (?:above|below)\)/g };
    for (const doc of Object.keys(inner) as Array<keyof typeof inner>) {
      const text = readFileSync(join(ROOT, 'docs', doc), 'utf-8');
      for (const [, heading] of text.matchAll(inner[doc])) {
        expect({ doc, heading, there: headings[doc].includes(heading!) }).toEqual({ doc, heading, there: true });
      }
    }
    const deployments = readFileSync(join(ROOT, 'docs', 'DEPLOYMENTS.md'), 'utf-8');
    for (const [, anchor] of deployments.matchAll(/\]\(#([\p{L}\p{N}_-]+)\)/gu)) {
      expect({ anchor, there: headings['DEPLOYMENTS.md'].some((heading) => slug(heading) === anchor) }).toEqual({ anchor, there: true });
    }
  });

  it('reads every line that runs a shipped script as a run, and gives each script only the options it takes', () => {
    const text = GUIDE.replace(/\\\n\s*/g, ' ');
    const runs = [...text.matchAll(new RegExp(String.raw`${SCRIPT_RUN} ([^\n]+)`, 'g'))];
    expect(runs.length).toBeGreaterThan(0);
    for (const line of text.split('\n').filter((each) => each.includes('bun ') && each.includes('<host>/scripts/'))) {
      expect({ line, read: new RegExp(SCRIPT_RUN).test(line) }).toEqual({ line, read: true });
    }
    for (const [, script, rest] of runs) {
      const source = readFileSync(join(ROOT, script!), 'utf-8');
      for (const option of rest!.match(/--\w[\w-]*(?:=\S*)?/g) ?? []) {
        expect({ script, option, taken: source.includes(`'${option}'`) }).toEqual({ script, option, taken: true });
      }
    }
  });

  it('names, in the prose of a section that runs a shipped script, only options that script takes', () => {
    const BUN_OPTIONS = new Set(['--no-env-file']);
    let named = 0;
    for (const piece of PIECES) {
      const scripts = [...piece.text.replace(/\\\n\s*/g, ' ').matchAll(new RegExp(SCRIPT_RUN, 'g'))].map((match) => match[1]!);
      if (scripts.length === 0) continue;
      const sources = scripts.map((script) => readFileSync(join(ROOT, script), 'utf-8'));
      for (const [, span] of piece.text.matchAll(SPAN)) {
        for (const option of span!.match(/(?<![\w-])--\w[\w-]*(?:=\S*)?/g) ?? []) {
          if (BUN_OPTIONS.has(option)) continue;
          named++;
          const taken = sources.some((source) => source.includes(`'${option}'`));
          expect({ section: piece.heading, option, taken }).toEqual({ section: piece.heading, option, taken: true });
        }
      }
    }
    expect(named).toBeGreaterThan(0);
  });
});

describe('the opening\'s steps, in the order the person meets them', () => {
  const steps = OPENING.split('\n').filter((line) => /^\d+\. /.test(line));
  const first = (pattern: RegExp) => steps.findIndex((step) => pattern.test(step));

  it('take Discord and any history before one read-back, the read-back by going live, SETUP.md before the hello, and backups after the hello and before setup--finished', () => {
    const at = {
      discord: first(/"Discord"/),
      history: first(/"Importing a history"/),
      readBack: first(/"The read-back"/),
      goingLive: first(/"Going live"/),
      setupMd: first(/"SETUP\.md"/),
      hello: first(/^\d+\. The person's own hello/),
      backups: first(/"Backups"/),
      finished: first(/`setup--finished`/),
    };
    const found = Object.values(at).every((step) => step >= 0);
    const readBacks = steps.filter((step) => /"The read-back"/.test(step)).length;
    expect({ at, found, readBacks, order: found && at.discord < at.readBack && at.history < at.readBack
      && at.readBack <= at.goingLive && at.setupMd < at.hello && at.hello < at.backups && at.backups < at.finished })
      .toEqual({ at, found: true, readBacks: 1, order: true });
  });
});

describe('the setup agent\'s tools', () => {
  it('are each one the setup recipe allows, wherever the guide names one', () => {
    const recipe = JSON.parse(readFileSync(join(ROOT, 'recipes', 'setup.json'), 'utf-8')) as { agent: { allowedTools: string[] } };
    const named = [...new Set([...GUIDE.matchAll(/\bsetup--\w+/g)].map((match) => match[0]))];
    expect(named.length).toBeGreaterThan(0);
    for (const tool of named) expect({ tool, allowed: recipe.agent.allowedTools.includes(tool) }).toEqual({ tool, allowed: true });
  });
});

describe('the resident\'s shell is decided with the person', () => {
  const STEP = 'The resident\'s shell';

  it('in a step of its own, before the recipe\'s servers, the grants and the backups, which each go by its answer', () => {
    const at = (heading: string) => HEADINGS.indexOf(heading);
    expect(at(STEP)).toBeGreaterThanOrEqual(0);
    for (const later of ['The recipe\'s servers', 'What the resident may do to itself', 'Backups']) {
      expect({ later, after: at(later) > at(STEP) }).toEqual({ later, after: true });
    }
  });

  it('and on a yes, runs `connectome shell install` with a time limit above setup--run\'s default and within its most', () => {
    const step = PIECES.find((piece) => piece.heading === STEP)?.text ?? '';
    expect(step).toContain('`connectome shell install`');
    const limits = [...step.matchAll(/`timeoutMs`[^.\n]*?`(\d+)`/g)].map((match) => Number(match[1]));
    expect(limits.length).toBeGreaterThan(0);
    for (const limit of limits) {
      expect({ limit, within: limit > DEFAULT_TIMEOUT_MS && limit <= MAX_TIMEOUT_MS }).toEqual({ limit, within: true });
    }
  });
});

describe('SETUP.md\'s lines', () => {
  it('run `connectome service install` with the recipe, which it takes on every run', () => {
    const setupMd = PIECES.find((piece) => piece.heading === 'SETUP.md')!.text;
    const installs = [...setupMd.matchAll(SPAN)].map((match) => match[1]!)
      .filter((span) => span.startsWith('connectome service install'));
    expect(installs.length).toBeGreaterThan(0);
    for (const span of installs) {
      expect({ span, recipe: span === "connectome service install '<name>.json'" }).toEqual({ span, recipe: true });
    }
  });
});

describe('the backups\' units', () => {
  it('are named with a character after the slug that no slug holds, so none is another install\'s own unit', () => {
    const backups = PIECES.filter((piece) => ['Backups', 'The restore check', 'Backups run by root'].includes(piece.heading ?? ''))
      .map((piece) => piece.text).join('');
    const rests = [...backups.matchAll(/connectome-<slug>([^`'\s]*)\.(?:service|timer)\b/g)].map((match) => match[1]!)
      .filter((rest) => rest !== '');
    expect(rests.length).toBeGreaterThan(0);
    for (const rest of rests) expect({ rest, apart: slugOf(`x${rest}`) !== `x${rest}` }).toEqual({ rest, apart: true });
  });
});

describe('the backups\' commands', () => {
  const sections = ['Backups', 'The restore check', 'Backups run by root'];
  const spansIn = (names: string[]) => PIECES.filter((piece) => names.includes(piece.heading ?? ''))
    .flatMap((piece) => [...piece.text.matchAll(SPAN)].map((match) => match[1]!));

  it('run restic by hand by the whole path the script runs, so root runs the restic it checked', () => {
    const subshells = spansIn(sections).filter((span) => span.startsWith('(') && span.includes(". '<dir>/backup.env'"));
    expect(subshells.length).toBeGreaterThan(0);
    for (const span of subshells) expect({ span, whole: /; '<restic>' <command>\)$/.test(span) }).toEqual({ span, whole: true });
  });

  it('have root remove the restore check\'s copy with rm -rf alone, since a chown or chmod there follows a link the resident\'s user can put at its name', () => {
    const root = spansIn(['Backups run by root']).filter((span) => span.includes("'<scratch>'"));
    expect(root).toContain("rm -rf '<scratch>'");
    for (const span of root) expect({ span, follows: /\b(?:chown root|chmod)\b/.test(span) }).toEqual({ span, follows: false });
  });

  it('pipe the audit to grep with its stderr, where the audit writes every line', () => {
    const greps = spansIn(['The restore check']).filter((span) => /\bgrep\b/.test(span));
    expect(greps.length).toBeGreaterThan(0);
    for (const span of greps) expect({ span, stderr: /2>&1 \| grep\b/.test(span) }).toEqual({ span, stderr: true });
  });

  it('write the password over no file already there, so the umask gives the new file its mode', () => {
    const lines = spansIn(sections).filter((span) => span.includes('stty -echo'));
    expect(lines.length).toBeGreaterThan(0);
    for (const span of lines) expect({ span, removedFirst: /rm -f "\$1"; printf "%s" "\$p" > "\$1"/.test(span) }).toEqual({ span, removedFirst: true });
  });

  it('name root\'s files, units and daemon with the resident\'s user too, since root\'s names are the whole machine\'s', () => {
    const root = PIECES.find((piece) => piece.heading === 'Backups run by root')!.text;
    const names = [...root.matchAll(/(?:connectome-<slug>|com\.animalabs\.connectome\.<slug>)[^`'\s/]*/g)].map((match) => match[0]);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect({ name, user: name.includes('.<user>.') }).toEqual({ name, user: true });
  });
});

describe('connectome service install, run by the agent', () => {
  it('gets setup--run\'s most as its timeoutMs in "Going live", which each run of it again elsewhere points to', () => {
    const live = PIECES.find((piece) => piece.heading === 'Going live')!.text;
    const run = live.split(/(?<=\.) /)
      .find((sentence) => sentence.includes("Run `connectome service install '<name>.json'` with `setup--run`")) ?? '';
    const limits = [...run.matchAll(/`timeoutMs`[^.\n]*?`(\d+)`/g)].map((match) => Number(match[1]));
    expect({ limits }).toEqual({ limits: [MAX_TIMEOUT_MS] });
    for (const piece of PIECES) {
      if (['SETUP.md', 'With another harness', 'Going live'].includes(piece.heading ?? '')) continue;
      for (const sentence of piece.text.split(/(?<=\.) |\n/)) {
        if (!/connectome service install[^`]*` again/.test(sentence)) continue;
        expect({ sentence, routed: sentence.includes('("Going live")') }).toEqual({ sentence, routed: true });
      }
    }
  });
});
