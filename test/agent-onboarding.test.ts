import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMANDS } from '../src/cli/connectome.ts';
import { parseHandWrittenJson } from '../src/hand-written-json.ts';
import { WHOLE_OUTPUT_BYTES } from '../src/modules/setup-module.ts';

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
const SPANS = [...GUIDE.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!);

describe('the setup agent reads the guide through setup--run', () => {
  it('gets the opening and each section back whole', () => {
    expect(HEADINGS.length).toBeGreaterThan(1);
    for (const piece of PIECES) {
      const bytes = Buffer.byteLength(piece.text);
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
    const named = [...new Set([...GUIDE.matchAll(/<host>\/([\w./-]+[\w])/g)].map((match) => match[1]!))];
    expect(named.length).toBeGreaterThan(0);
    for (const path of named) {
      const carried = alwaysPacked.includes(path) || pkg.files.some((entry) => path === entry || path.startsWith(`${entry}/`));
      expect({ path, there: existsSync(join(ROOT, path)), carried }).toEqual({ path, there: true, carried: true });
    }
  });

  it('runs only connectome commands the install\'s command has, each word one its usage takes', () => {
    const usages = [...COMMANDS.map((command) => command.usage), 'connectome help'];
    const runs = SPANS.filter((span) => span.startsWith('connectome '));
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      const [, name, ...rest] = run.split(' ');
      const usage = usages.find((candidate) => candidate.split(' ')[1] === name) ?? '';
      const words = new Set(usage.replace(/[[\]()|]/g, ' ').split(/\s+/));
      const takesValue = /<[^>]+>/.test(usage);
      const fits = usage !== '' && rest.every((word) => words.has(word) || (takesValue && /<[^>]+>/.test(word)));
      expect({ run, fits }).toEqual({ run, fits: true });
    }
  });

  const serversSection = () => PIECES.find((piece) => piece.heading === 'The recipe\'s servers')!.text;
  const servers = () => Object.assign({}, ...[...serversSection().matchAll(/```json\n([\s\S]*?)```/g)]
    .map((match) => JSON.parse(`{${match[1]}}`))) as Record<string, { env: Record<string, string> }>;

  it('maps DISCORD_TOKEN and the shell\'s two values into their own servers\' env as ${NAME}, and gives every other value with a <placeholder> in it', () => {
    const reads = { discord: ['DISCORD_TOKEN'], shell: ['SESSION_SERVER_PORT', 'SESSION_SERVER_TOKEN'] };
    const recipe = servers();
    for (const [server, names] of Object.entries(reads)) {
      for (const name of names) expect({ server, name, value: recipe[server]?.env[name] }).toEqual({ server, name, value: `\${${name}}` });
    }
    for (const [server, { env }] of Object.entries(recipe)) {
      for (const [name, value] of Object.entries(env)) {
        const named = /^\$\{[A-Z_]+\}$/.test(value) || /<[^>]+>/.test(value);
        expect({ server, name, value, named }).toEqual({ server, name, value, named: true });
      }
    }
  });

  it('gives the recipe skeleton as JSON the host\'s loader parses', () => {
    const blocks = [...PIECES.find((piece) => piece.heading === 'The recipe')!.text.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1]!);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(() => parseHandWrittenJson(block)).not.toThrow();
  });

  it('puts each discord-mcpl state file the example names in the data directory', () => {
    const files = Object.entries(servers().discord!.env).filter(([name]) => /^DISCORD_\w+_FILE$/.test(name));
    expect(files.length).toBeGreaterThan(0);
    for (const [name, value] of files) expect({ name, inData: value.startsWith('<dir>/data/') }).toEqual({ name, inData: true });
  });

  it('is pointed into, from README.md, ARCHITECTURE.md, docs/*.md and src, as `FILE.md`\'s "Heading", by headings the guide and DEPLOYMENTS.md have, and by no section number', () => {
    const headings = (file: string) => readFileSync(join(ROOT, 'docs', file), 'utf-8').split('\n')
      .filter((line) => /^#{2,3} /.test(line)).map((line) => line.replace(/^#+ /, '').trim());
    const docs = { 'AGENT-ONBOARDING.md': headings('AGENT-ONBOARDING.md'), 'DEPLOYMENTS.md': headings('DEPLOYMENTS.md') };
    const sources = [
      'README.md', 'ARCHITECTURE.md',
      ...new Bun.Glob('docs/*.md').scanSync({ cwd: ROOT }),
      ...new Bun.Glob('src/**/*.ts').scanSync({ cwd: ROOT }),
    ];
    const pointers: Array<{ from: string; doc: keyof typeof docs; heading: string }> = [];
    for (const from of sources) {
      const text = readFileSync(join(ROOT, from), 'utf-8').replace(/\s*\n\s*/g, ' ');
      for (const match of text.matchAll(/(AGENT-ONBOARDING|DEPLOYMENTS)\.md`?\)?\\?'s ((?:"[^"]+"(?:, (?:and )?| and )?)+)/g)) {
        for (const named of match[2]!.matchAll(/"([^"]+)"/g)) {
          pointers.push({ from, doc: `${match[1]}.md` as keyof typeof docs, heading: named[1]!.replace(/`/g, '') });
        }
      }
    }
    for (const from of sources) {
      const text = readFileSync(join(ROOT, from), 'utf-8').replace(/\s*\n\s*/g, ' ');
      const numbered = text.match(/(?:AGENT-ONBOARDING(?:\.md)?|onboarding)[^.]{0,40}?(?:§|\bsection)\s?\d|(?:§|\bsection)\s?\d[\w.]*\s+of the onboarding/gi) ?? [];
      expect({ from, numbered }).toEqual({ from, numbered: [] });
    }
    expect(pointers.length).toBeGreaterThan(0);
    for (const pointer of pointers) {
      const there = docs[pointer.doc].some((heading) => heading.replace(/`/g, '') === pointer.heading);
      expect({ ...pointer, there }).toEqual({ ...pointer, there: true });
    }
    const inner = { 'AGENT-ONBOARDING.md': /\("([^"]+)"(?:, (?:above|below))?\)/g, 'DEPLOYMENTS.md': /\("([^"]+)", (?:above|below)\)/g };
    for (const doc of Object.keys(docs) as Array<keyof typeof docs>) {
      const text = readFileSync(join(ROOT, 'docs', doc), 'utf-8');
      for (const [, heading] of text.matchAll(inner[doc])) {
        expect({ doc, heading, there: docs[doc].includes(heading!) }).toEqual({ doc, heading, there: true });
      }
    }
    const deployments = readFileSync(join(ROOT, 'docs', 'DEPLOYMENTS.md'), 'utf-8');
    const slug = (heading: string) => heading.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s/g, '-');
    for (const [, anchor] of deployments.matchAll(/\]\(#([\w-]+)\)/g)) {
      expect({ anchor, there: docs['DEPLOYMENTS.md'].some((heading) => slug(heading) === anchor) }).toEqual({ anchor, there: true });
    }
  });

  it('gives each shipped script it runs only the options that script takes', () => {
    const runs = [...GUIDE.replace(/\\\n\s*/g, ' ').matchAll(/bun '?<host>\/(scripts\/[\w.-]+)'? ([^\n]+)/g)];
    expect(runs.length).toBeGreaterThan(0);
    for (const [, script, rest] of runs) {
      const source = readFileSync(join(ROOT, script!), 'utf-8');
      for (const option of rest!.match(/--[a-z-]+/g) ?? []) {
        expect({ script, option, taken: source.includes(`'${option}'`) }).toEqual({ script, option, taken: true });
      }
    }
  });

  it('names, in the prose of a section that runs a shipped script, only options that script takes', () => {
    let named = 0;
    for (const piece of PIECES) {
      const scripts = [...piece.text.replace(/\\\n\s*/g, ' ').matchAll(/bun '?<host>\/(scripts\/[\w.-]+)/g)].map((match) => match[1]!);
      if (scripts.length === 0) continue;
      const sources = scripts.map((script) => readFileSync(join(ROOT, script), 'utf-8'));
      for (const [, option] of piece.text.matchAll(/`(--[a-z-]+)[^`]*`/g)) {
        named++;
        const taken = sources.some((source) => source.includes(`'${option}'`));
        expect({ section: piece.heading, option, taken }).toEqual({ section: piece.heading, option, taken: true });
      }
    }
    expect(named).toBeGreaterThan(0);
  });
});
