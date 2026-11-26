import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { resolveTimeZone } from '@animalabs/agent-framework';
import { ENV_REFERENCE } from './recipe-document.js';
import { DEFAULT_RECIPE_CLOCK, type Recipe, type RecipeOrigin } from './recipe.js';
import { checkRecipe, nearestKey, settingFault, settingTakes } from './recipe-schema.js';
import { noteRecipeWarning } from './recipe-warnings.js';
import { strategyMessageCap } from './framework-strategy.js';
import { shown } from './modules/shown.js';
import { settingsRoute } from './modules/unknown-tool.js';
import { PRIVATE_DIR_MODE } from './update/data-swap.js';
import {
  AVAILABILITY, OWN_SETTING_NAMES, OWN_SETTINGS, OWN_SETTINGS_FILE, OWN_SETTINGS_MAX_BYTES, OWN_SETTINGS_MOUNT,
  OWN_SETTINGS_SET_ASIDE, OWN_SETTINGS_TOOL, WRITE_TOOL, changesSettings, domainTakes, insideDomain, ownSettingsDir, ownSettingsWarnings,
  type OwnSetting, type OwnSettingName,
} from './own-settings-table.js';

type Grant = Recipe['ownSettings'];

const settingNamed = (name: string): OwnSetting | undefined => OWN_SETTINGS.find((setting) => setting.name === name);

const errorCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
const errorText = (err: unknown): string => errorCode(err) ?? (err instanceof Error ? err.message : String(err));

const UNREAD_WORDS: Readonly<Record<string, string>> = {
  ENOTDIR: 'a part of its path on the host is not a directory',
  EACCES: 'the host has no permission to read it',
  EPERM: 'the host has no permission to read it',
  EISDIR: 'it is a directory',
};
const unreadWhy = (err: unknown): string => {
  const code = errorCode(err);
  return `it can't be read: ${(code === undefined ? undefined : UNREAD_WORDS[code]) ?? errorText(err)}`;
};

const mayRead = (grant: Grant, name: OwnSettingName): boolean =>
  grant === 'all' || grant === 'read' || (Array.isArray(grant) && grant.includes(name));
const mayChange = (grant: Grant, name: OwnSettingName): boolean =>
  grant === 'all' || (Array.isArray(grant) && grant.includes(name));

const isAvailable = (setting: OwnSetting, recipe: Recipe): boolean => AVAILABILITY[setting.available].on(recipe);

const isPlainFile = (path: string): boolean => {
  try {
    return lstatSync(path, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
};

const exists = (path: string): boolean => {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false;
  }
};

function fileForStart(dir: string, grant: Grant): string {
  const own = join(dir, OWN_SETTINGS_FILE);
  const parked = join(dir, OWN_SETTINGS_SET_ASIDE);
  return changesSettings(grant) && !exists(own) && exists(parked) ? parked : own;
}

/** The resident's file as the host reads it. */
export type OwnFile =
  | { readonly kind: 'none' }
  | { readonly kind: 'unread'; readonly why: string; readonly remedy: string }
  | { readonly kind: 'not-an-object'; readonly why: string }
  | { readonly kind: 'entries'; readonly entries: ReadonlyArray<readonly [string, unknown]> };

const REPLACE = 'Replace it with a plain file, or remove it.';
const SHRINK = `Make it ${OWN_SETTINGS_MAX_BYTES} bytes or smaller, or remove it.`;
const REACH = 'Check that the host can reach and read it on its path.';

function readPlainFile(path: string): { readonly bytes: Buffer } | Extract<OwnFile, { kind: 'none' | 'unread' }> {
  let fd: number;
  try {
    // Without O_NONBLOCK, opening a pipe waits for a writer.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOENT') return { kind: 'none' };
    if (code === 'ELOOP') return { kind: 'unread', why: 'it is a link, and the host follows no link there', remedy: REPLACE };
    return { kind: 'unread', why: unreadWhy(err), remedy: REACH };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { kind: 'unread', why: 'it is not a plain file', remedy: REPLACE };
    const tooLarge = `it is larger than ${OWN_SETTINGS_MAX_BYTES} bytes`;
    if (stat.size > OWN_SETTINGS_MAX_BYTES) return { kind: 'unread', why: tooLarge, remedy: SHRINK };
    const buffer = Buffer.alloc(OWN_SETTINGS_MAX_BYTES + 1);
    let length = 0;
    for (let n = -1; n !== 0 && length < buffer.length;) {
      n = readSync(fd, buffer, length, buffer.length - length, null);
      length += n;
    }
    if (length > OWN_SETTINGS_MAX_BYTES) return { kind: 'unread', why: tooLarge, remedy: SHRINK };
    return { bytes: buffer.subarray(0, length) };
  } catch (err) {
    return { kind: 'unread', why: unreadWhy(err), remedy: REACH };
  } finally {
    closeSync(fd);
  }
}

function publish(path: string, bytes: Buffer): void {
  const temporary = join(dirname(path), `.own.json.${randomBytes(8).toString('hex')}.writing`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      for (let written = 0; written < bytes.length;) written += writeSync(fd, bytes, written, bytes.length - written);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // A link fails where `path` is there, so a file written meanwhile is never replaced.
    linkSync(temporary, path);
    // The new name is on disk before the caller removes the parked one, so a crash between the two leaves at least one.
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
  }
}

function residentRemedy(file: Extract<OwnFile, { kind: 'unread' | 'not-an-object' }>): string {
  if (file.kind === 'not-an-object') return 'Write it again as one JSON object, remove it, or ask your operator.';
  if (file.remedy === REACH) return 'Ask your operator.';
  return `${file.remedy.replace(/, or remove it\.$/, '')}, remove it, or ask your operator.`;
}

function readOwnFile(path: string): OwnFile {
  const read = readPlainFile(path);
  if (!('bytes' in read)) return read;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes);
  } catch {
    return { kind: 'not-an-object', why: 'it is not UTF-8 text' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { kind: 'not-an-object', why: `it is not JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const holds = parsed === null ? 'null' : Array.isArray(parsed) ? 'a list' : `a ${typeof parsed}`;
    return { kind: 'not-an-object', why: `it holds ${holds}, not a JSON object` };
  }
  return { kind: 'entries', entries: Object.entries(parsed) };
}

/** Why the host does not use an entry of the resident's file. */
export type NotUsed =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'not-granted' }
  | { readonly kind: 'not-available'; readonly when: string }
  | { readonly kind: 'value'; readonly fault: string }
  | { readonly kind: 'check'; readonly fault: string };

export type OwnEntry = {
  readonly name: string;
  readonly value: unknown;
  readonly notUsed: NotUsed | null;
};

export interface OwnSettingsCheck {
  /** The recipe with each entry that is in force. */
  readonly recipe: Recipe;
  /** The file that was read: OWN_SETTINGS_FILE, or the parked file that a start would put back. */
  readonly path: string;
  readonly file: OwnFile;
  readonly entries: readonly OwnEntry[];
}

/** The operator's recipe as the start resolved it, with the origin that its load had. */
export interface OperatorRecipe {
  readonly recipe: Recipe;
  readonly origin: RecipeOrigin;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function placed(document: unknown, path: readonly string[], value: unknown): unknown {
  const [key, ...rest] = path;
  if (key === undefined) return value;
  const section = isPlainObject(document) ? document : {};
  return { ...section, [key]: placed(section[key], rest, value) };
}

export function valueAt(document: unknown, name: string): unknown {
  let value = document;
  for (const key of name.split('.')) {
    if (!isPlainObject(value)) return undefined;
    value = value[key];
  }
  return value;
}

/**
 * What a start does with the resident's file in `dataDir` on top of the
 * operator's recipe. It writes nothing. Without a grant to change a setting it
 * applies nothing. Otherwise it judges each entry alone, in the file's order,
 * and then adds each remaining entry to the recipe one by one, keeping it
 * when the recipe with it passes the load's checks. The fit check reads none
 * of the table's settings, so the recipe fits with each entry as it fits
 * without it.
 */
export function checkOwnSettings(operator: OperatorRecipe, dataDir: string,
  path = fileForStart(ownSettingsDir(dataDir), operator.recipe.ownSettings)): OwnSettingsCheck {
  const { recipe } = operator;
  const grant = recipe.ownSettings;
  if (!changesSettings(grant)) return { recipe, path, file: { kind: 'none' }, entries: [] };
  const file = readOwnFile(path);
  if (file.kind !== 'entries') return { recipe, path, file, entries: [] };

  const judged = file.entries.map(([name, value]) => judge(grant, recipe, name, value));

  let current = recipe;
  let origin = operator.origin;
  const entries = judged.map((entry): OwnEntry => {
    if (entry.notUsed !== null) return entry;
    const path = entry.name.split('.');
    const nextOrigin: RecipeOrigin = origin.kind === 'authored'
      ? { kind: 'authored', document: placed(origin.document, path, entry.value) }
      : origin;
    const checked = checkRecipe(placed(current, path, entry.value), nextOrigin);
    if (!checked.ok) return { ...entry, notUsed: { kind: 'check', fault: checked.fault } };
    current = checked.recipe;
    origin = nextOrigin;
    return entry;
  });
  return { recipe: current, path, file, entries };
}

function judge(grant: Grant, recipe: Recipe, name: string, value: unknown): OwnEntry {
  const setting = settingNamed(name);
  if (setting === undefined) return { name, value, notUsed: { kind: 'unknown' } };
  if (!mayChange(grant, setting.name)) return { name, value, notUsed: { kind: 'not-granted' } };
  if (!isAvailable(setting, recipe)) return { name, value, notUsed: { kind: 'not-available', when: AVAILABILITY[setting.available].when } };
  const fault = value === null ? `${name} must be ${takes(setting)}, got null.`
    : settingFault(name, value) ?? (insideDomain(setting, value) ? undefined : `${name} must be ${takes(setting)}, got ${brief(value)}.`);
  return { name, value, notUsed: fault === undefined ? null : { kind: 'value', fault } };
}

function grantWarnings(recipe: Recipe): string[] {
  const grant = recipe.ownSettings;
  const unknown = Array.isArray(grant) ? grant.filter((name) => settingNamed(name) === undefined) : [];
  return [
    ...unknown.map((name) => {
      const nearest = near(name);
      return `Recipe ownSettings names ${cut(JSON.stringify(name))}, which is not a setting that a resident may manage in this release, ` +
        `so it grants nothing${nearest ? ` (did you mean ${nearest}?)` : ''}.`;
    }),
    ...ownSettingsWarnings(recipe),
  ];
}

const takes = (setting: OwnSetting): string => domainTakes(setting) ?? settingTakes(setting.name) ?? 'what the recipe takes there';

const ended = (text: string): string => (text.endsWith('.') ? text : `${text}.`);

const SHOWN_MAX = 300;
const LISTED_MAX = 20;
const cut = (text: string): string => (text.length > SHOWN_MAX ? `${text.slice(0, SHOWN_MAX)}…` : text);

function brief(value: unknown): string {
  try {
    return cut(shown(value));
  } catch {
    return 'a value too deeply nested to show';
  }
}

function listed(entries: readonly OwnEntry[], line: (entry: OwnEntry) => string, rest: (count: number) => string): string[] {
  const lines: string[] = [];
  let others = 0;
  for (const entry of entries) {
    if (entry.notUsed?.kind !== 'unknown') lines.push(line(entry));
    else if (others++ < LISTED_MAX) lines.push(line(entry));
  }
  return others > LISTED_MAX ? [...lines, rest(others - LISTED_MAX)] : lines;
}

const near = (name: string): string | null => nearestKey(name, OWN_SETTING_NAMES);

const logName = (entry: OwnEntry): string => (entry.notUsed?.kind === 'unknown' ? cut(JSON.stringify(entry.name)) : entry.name);

const quoted = (sentence: string): string =>
  sentence.includes('\n') ? `\n${sentence.split('\n').map((line) => `    ${line}`).join('\n')}` : ` '${sentence}'`;

function residentReason(entry: OwnEntry): string {
  const name = `\`${cut(entry.name)}\``;
  const reason = entry.notUsed;
  if (reason === null) return `${name} is ${brief(entry.value)}.`;
  switch (reason.kind) {
    case 'unknown':
    {
      const nearest = near(entry.name);
      return `${name} is not used: it is not a setting that you can manage${nearest ? ` (did you mean \`${nearest}\`?)` : ''}.`;
    }
    case 'not-granted':
      return `${name} is not used: your operator's recipe does not let you change it. Remove it from the file, or ask your operator.`;
    case 'not-available':
      return `${name} is not used: the host uses a resident's value for it only ${reason.when}. Your operator's recipe decides that.`;
    case 'value':
      return `${name} is not used: ${brief(entry.value)} is not a value that this setting takes. The host's check says:${quoted(cut(reason.fault))}`;
    case 'check':
      return `${name} is not used. With your value ${brief(entry.value)}, your operator's recipe fails a check of the host:` +
        `${quoted(cut(reason.fault))}\n  That check reads settings that your operator holds. Choose a value that passes, or ask your operator.`;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

function operatorReason(name: string, reason: NotUsed): string {
  switch (reason.kind) {
    case 'unknown': {
      const nearest = near(name);
      return `it is not a setting of the table${nearest ? ` (did you mean ${nearest}?)` : ''}`;
    }
    case 'not-granted':
      return 'the recipe\'s ownSettings does not name it';
    case 'not-available':
      return `the host uses a resident's value for it only ${reason.when}`;
    case 'value':
      return cut(reason.fault);
    case 'check':
      return `the recipe fails a check with it: ${cut(reason.fault)}`;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

function namesReference(value: unknown): boolean {
  if (typeof value === 'string') return new RegExp(ENV_REFERENCE).test(value);
  if (Array.isArray(value)) return value.some(namesReference);
  return isPlainObject(value) && Object.values(value).some(namesReference);
}

function recipeValueShown(operator: OperatorRecipe, name: string): string {
  const value = valueAt(operator.recipe, name);
  if (value === undefined) return 'nothing';
  if (operator.origin.kind === 'authored') {
    const written = valueAt(operator.origin.document, name);
    if (namesReference(written)) return `${JSON.stringify(written)}, which the host fills from its environment`;
  }
  if (operator.origin.kind === 'resolved' && typeof value !== 'number' && typeof value !== 'boolean') return 'a value of the saved recipe';
  return shown(value);
}

const recipeOwn = (operator: OperatorRecipe, name: string): string =>
  valueAt(operator.recipe, name) === undefined ? 'the recipe sets none' : `the recipe's own value is ${recipeValueShown(operator, name)}`;

function filePlace(dataDir: string, recipe: Recipe, file: string): string {
  return changesSettings(recipe.ownSettings) && recipe.modules?.workspace !== false
    ? `${OWN_SETTINGS_MOUNT}/${file}`
    : resolve(ownSettingsDir(dataDir), file);
}

/** The move of the resident's file that a start decided: parking it, or putting a parked file back. */
export type OwnFileMove = 'park' | 'put-back' | null;

export interface OwnSettingsStart {
  readonly check: OwnSettingsCheck;
  readonly move: OwnFileMove;
  /**
   * The start's log lines for the operator. The lines that need the
   * operator (the grant's warnings, and what the host did not use) also go
   * to the recipe-warning queue, which the TUI's and headless logs read.
   */
  readonly log: readonly string[];
  /** The host note for the resident, where the file did not take effect as written or the host moves it. */
  readonly note: string | undefined;
  /**
   * Makes the move, and gives its log line; a move that fails also goes to
   * the recipe-warning queue. The start calls it once the framework has
   * started, after the note is written, so that a start that fails before
   * then leaves the file where it was, and the next start decides the same
   * and gives the note again.
   */
  moveFile(): string | null;
}

/**
 * The start's part: it makes the directory for a grant that changes a
 * setting, decides whether to park the resident's file (where the grant
 * changes no setting) or to put a parked file back (where it changes one
 * again), and applies the file that it would then hold (checkOwnSettings).
 * It moves nothing itself (moveFile).
 */
export function startOwnSettings(operator: OperatorRecipe, dataDir: string): OwnSettingsStart {
  const grant = operator.recipe.ownSettings;
  const dir = ownSettingsDir(dataDir);
  const own = join(dir, OWN_SETTINGS_FILE);
  const parked = join(dir, OWN_SETTINGS_SET_ASIDE);
  const warnings = grantWarnings(operator.recipe).map((warning) => `[own-settings] ${warning}`);
  const log = [...warnings];
  const warn = (line: string) => { log.push(line); warnings.push(line); };
  let move: OwnFileMove = null;
  if (changesSettings(grant)) {
    try {
      mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    } catch (err) {
      warn(`[own-settings] The host could not make ${dir}: ${errorText(err)}.`);
    }
  } else if (isPlainFile(own)) {
    move = 'park';
    log.push(`[own-settings] The recipe lets the resident change no setting, so the host parks ${own} as ${parked} once it has started.`);
  } else if (exists(own)) {
    warn(`[own-settings] The recipe lets the resident change no setting, and ${own} is not a plain file, so the host leaves it where it is. ` +
      'Each start leaves it and says so again, until it is removed or is a plain file.');
  }
  const check = checkOwnSettings(operator, dataDir, fileForStart(dir, grant));
  if (check.path === parked && check.file.kind !== 'unread') {
    move = 'put-back';
    log.push(`[own-settings] The recipe lets the resident change settings again, so the host applies ${parked}, and puts it back ` +
      `as ${own} once it has started.`);
  }
  if (check.file.kind === 'unread' || check.file.kind === 'not-an-object') {
    warn(`[own-settings] The host did not use ${check.path}: ${check.file.why}.`);
  }
  const line = (entry: OwnEntry): string => (entry.notUsed === null
    ? `[own-settings] ${entry.name} is ${brief(entry.value)} from the resident's file; ${recipeOwn(operator, entry.name)}.`
    : `[own-settings] ${logName(entry)} in the resident's file is not used: ${ended(operatorReason(entry.name, entry.notUsed))}`);
  log.push(...listed(check.entries, line, (count) => `[own-settings] The resident's file has ${count} more entries that name no setting.`));
  warnings.push(...listed(check.entries.filter((entry) => entry.notUsed !== null), line,
    (count) => `[own-settings] The resident's file has ${count} more entries that name no setting.`));
  const failed = (line: string): string => {
    noteRecipeWarning(line);
    return line;
  };
  const moveFile = (): string | null => {
    if (move === null) return null;
    const [from, to] = move === 'park' ? [own, parked] : [parked, own];
    try {
      if (move === 'park') {
        renameSync(from, to);
      } else {
        const read = readPlainFile(from);
        if (!('bytes' in read)) {
          return failed(`[own-settings] The host did not put ${from} back: ${read.kind === 'none' ? 'it is gone' : read.why}.`);
        }
        publish(to, read.bytes);
        try {
          unlinkSync(from);
        } catch (err) {
          return failed(`[own-settings] The host put ${from} back as ${to}, and could not remove ${from}: ${errorText(err)}. The next ` +
            `start uses ${to}, and moves nothing.`);
        }
      }
      return `[own-settings] The host moved ${from} to ${to}.`;
    } catch (err) {
      if (move === 'put-back' && errorCode(err) === 'EEXIST') {
        return failed(`[own-settings] ${to} was written during the start, so the host left ${from} where it is.`);
      }
      return failed(`[own-settings] The host could not move ${from} to ${to}: ${errorText(err)}. The next start decides again ` +
        'from the files that it finds then.');
    }
  };
  if (warnings.length > 0) noteRecipeWarning(warnings.join('\n'));
  return { check, move, log, note: startNote(operator.recipe, dataDir, check, move), moveFile };
}

function startNote(recipe: Recipe, dataDir: string, check: OwnSettingsCheck, move: OwnFileMove): string | undefined {
  const place = filePlace(dataDir, recipe, OWN_SETTINGS_FILE);
  const notUsed = check.entries.filter((entry) => entry.notUsed !== null);
  const inForce = check.entries.filter((entry) => entry.notUsed === null);
  const parts: string[] = [];
  if (move === 'park') {
    parts.push('Your operator\'s recipe no longer lets you change your own settings, so the recipe\'s values are in force, and the host ' +
      `parks your settings file as ${resolve(ownSettingsDir(dataDir), OWN_SETTINGS_SET_ASIDE)} on its disk. It puts the file back when ` +
      'the recipe lets you change a setting again.');
  } else if (move === 'put-back') {
    parts.push(`Your operator's recipe lets you change your own settings again, so the host puts your parked settings file back as ${place}.` +
      (inForce.length > 0 ? ` In force from it:\n${listed(inForce, (entry) => `- ${residentReason(entry)}`, (count) => `- and ${count} more entries that name no setting`).join('\n')}` : ' Nothing of it is in force.'));
  }
  if (check.file.kind === 'unread' || check.file.kind === 'not-an-object') {
    parts.push(check.file.kind === 'unread' && resolve(check.path) === resolve(ownSettingsDir(dataDir), OWN_SETTINGS_SET_ASIDE)
      ? `The host did not use your parked settings file ${filePlace(dataDir, recipe, OWN_SETTINGS_SET_ASIDE)} at this start, and it ` +
        `leaves it where it is: ${check.file.why}. The recipe's values are in force. ${residentRemedy(check.file)}`
      : `The host did not use your settings file ${place} at this start: ${check.file.why}. The recipe's values are in force. ` +
        residentRemedy(check.file));
  }
  if (notUsed.length > 0) {
    parts.push(`Your settings file ${place} did not take effect as written at this start.` +
      `${inForce.length > 0 ? ' Each other entry of it is in force.' : ''}\n` +
      listed(notUsed, (entry) => `- ${residentReason(entry)}`, (count) => `- and ${count} more entries that name no setting`).join('\n'));
  }
  if (parts.length === 0) return undefined;
  const allowed = recipe.agent.allowedTools;
  if (recipe.ownSettings !== undefined && (!Array.isArray(allowed) || allowed.includes(OWN_SETTINGS_TOOL))) {
    parts.push(`${OWN_SETTINGS_TOOL} shows your own settings and checks your file: ${settingsRoute(OWN_SETTINGS_TOOL)}.`);
  }
  return parts.join('\n\n');
}

/** What the tool needs from the running host. */
export interface RunningAgent {
  readonly name: string;
  readonly proseRouting: string | undefined;
  readonly restartOffered: boolean;
}


function hostValue(name: OwnSettingName, recipe: Recipe, running: RunningAgent): string | undefined {
  switch (name) {
    case 'agent.clock': return shown(DEFAULT_RECIPE_CLOCK);
    case 'agent.timezone': return shown(resolveTimeZone(undefined));
    case 'agent.strategy.maxMessageTokens': return shown(strategyMessageCap(recipe));
    case 'agent.strategy.summaryParticipant': return shown(running.name);
    default: return undefined;
  }
}

/**
 * The answer of OWN_SETTINGS_TOOL: what is pending in the file, each setting
 * that the resident may read, with its value in force where it has one and
 * where that comes from, how to change them, and the file as the next start
 * would apply it.
 * It writes nothing.
 */
export function ownSettingsAnswer(input: {
  readonly operator: OperatorRecipe;
  readonly start: OwnSettingsCheck;
  readonly dataDir: string;
  readonly running: RunningAgent;
}): string {
  const { operator, start, dataDir, running } = input;
  const grant = operator.recipe.ownSettings;
  const next = checkOwnSettings(operator, dataDir);
  const readable = OWN_SETTINGS.filter((setting) => mayRead(grant, setting.name));
  const fromFile = (name: string): boolean => start.entries.some((entry) => entry.name === name && entry.notUsed === null);
  const sections: string[] = [];

  const pending = readable.filter((setting) => !isDeepStrictEqual(valueAt(start.recipe, setting.name), valueAt(next.recipe, setting.name)));
  if (pending.length > 0) {
    sections.push('Pending: your file changes what the recipe holds for these at the next start, if the recipe stays as it is. In this run, ' +
      'the recipe holds what it held when the host started. A value that the host or a package gives by default can be the same as yours.\n' +
      pending.map((setting) => {
        const later = valueAt(next.recipe, setting.name);
        const fromNextFile = next.entries.some((entry) => entry.name === setting.name && entry.notUsed === null);
        const value = fromNextFile ? brief(later)
          : valueAt(operator.recipe, setting.name) !== undefined ? `the recipe's own value, ${recipeValueShown(operator, setting.name)}`
          : 'not set by the recipe or your file';
        return `- ${setting.name}: ${value} at the next start`;
      }).join('\n'));
  }

  if (readable.length > 0) sections.push(readable.map((setting) => {
    const available = isAvailable(setting, operator.recipe);
    const inForce = valueAt(start.recipe, setting.name);
    const now = !available ? `not available on this host: the host uses a resident's value for it only ${AVAILABILITY[setting.available].when}`
      : fromFile(setting.name)
        ? `${brief(inForce)}, from your file, and ${recipeOwn(operator, setting.name)}`
      : inForce !== undefined ? `${recipeValueShown(operator, setting.name)}, from the recipe`
      : setting.name === 'agent.proseRouting' && running.proseRouting !== undefined
        ? `${shown(running.proseRouting)}, the agent's own default`
      : hostValue(setting.name, start.recipe, running) !== undefined
        ? `${hostValue(setting.name, start.recipe, running)}, which the host sets, since neither the recipe nor your file sets it`
        : 'not set: the package\'s default applies';
    const may = mayChange(grant, setting.name) ? 'You may change it.' : 'You may read it, and your operator\'s recipe does not let you change it.';
    return `${setting.name}: ${now}. ${may}\n  ${setting.words}\n  It takes ${takes(setting)}.`;
  }).join('\n\n'));

  const place = filePlace(dataDir, operator.recipe, OWN_SETTINGS_FILE);
  const mounted = place.startsWith(`${OWN_SETTINGS_MOUNT}/`);
  if (changesSettings(grant)) {
    const example = OWN_SETTINGS.find((setting) => mayChange(grant, setting.name) && isAvailable(setting, operator.recipe))
      ?? OWN_SETTINGS.find((setting) => mayChange(grant, setting.name));
    const allowed = operator.recipe.agent.allowedTools;
    const writes = !Array.isArray(allowed) || allowed.includes(WRITE_TOOL);
    sections.push(`To change a setting, write it into ${place}` +
      (!mounted ? ', on the host\'s disk: this host has no workspace, so a shell tool of yours can write it there, or your operator can'
        : writes ? '' : `, though your operator's tool list leaves out ${WRITE_TOOL}, so ask your operator to write it, unless a shell tool of yours can`) +
      ': one JSON object, each key a setting\'s name, and each value what the recipe would hold at that place, whole' +
      (example === undefined ? '' : `, such as {${JSON.stringify(example.name)}: ${shown(example.example)}}`) + '. ' +
      'A change takes effect when the host next starts. A key that you remove from the file follows the recipe again. ' +
      (mounted ? `Any agent of this host that can call ${WRITE_TOOL} can write the file too, such as a subagent or a fork of yours. ` : '') +
      (running.restartOffered
        ? 'You can ask for a restart with lifecycle--restart.'
        : 'Here lifecycle--restart can\'t restart the host, so a change waits until your operator restarts it.'));
  } else {
    sections.push(Array.isArray(grant)
      ? `Your operator's recipe names settings for you that this release of the host doesn't have: ${grant.map((name) => cut(JSON.stringify(name))).join(', ')}. ` +
        'So you can read none of your own settings, and change none.'
      : 'Your operator\'s recipe lets you read these settings, and it lets you change none of them.');
  }

  const parked = resolve(ownSettingsDir(dataDir), OWN_SETTINGS_SET_ASIDE);
  const ownThere = exists(join(ownSettingsDir(dataDir), OWN_SETTINGS_FILE));
  const parkedThere = exists(parked);
  const parkedPlace = filePlace(dataDir, operator.recipe, OWN_SETTINGS_SET_ASIDE);
  if (!changesSettings(grant)) {
    if (ownThere) {
      sections.push(isPlainFile(join(ownSettingsDir(dataDir), OWN_SETTINGS_FILE))
        ? `Your file ${place} is there, and the next start parks it, since the recipe lets you change no setting.`
        : `Your ${place} is there, and it is not a plain file, so the next start leaves it where it is.`);
    }
  } else if (next.file.kind === 'none') {
    sections.push(`There is no file ${place} now.`);
  } else {
    const fromParked = resolve(next.path) === parked;
    const lines = next.file.kind === 'entries'
      ? (next.entries.length === 0 ? ['It holds no entry.'] : listed(next.entries, (entry) => `- ${residentReason(entry)}`, (count) => `- and ${count} more entries that name no setting`))
      : [];
    sections.push(fromParked
      ? (next.file.kind === 'unread'
        ? `Your parked file ${parkedPlace} is there, and ${place} is not. The next start leaves the parked file where it is, and does ` +
          `not use it: ${next.file.why}. ${residentRemedy(next.file)}`
        : `Your parked file ${parkedPlace} is there, and ${place} is not: the next start puts it back as ${place}` +
          `${next.file.kind === 'entries' ? ', and applies it' : ''}. If you write a new ${place} first, the next start uses that file ` +
          'in its place, and leaves the parked one where it is.\n' +
          (next.file.kind === 'entries'
            ? `The parked file, as the next start applies it:\n${lines.join('\n')}`
            : `The next start does not use the parked file: ${next.file.why}. ${residentRemedy(next.file)}`))
      : next.file.kind === 'entries'
        ? `Your file ${place} now, as the next start applies it:\n${lines.join('\n')}`
        : `Your file ${place} now. The next start does not use it: ${next.file.why}. ${residentRemedy(next.file)}`);
  }
  if (parkedThere && resolve(next.path) !== parked) {
    sections.push(`Your parked file ${parkedPlace} is there: the host parked it when the recipe let you change no setting, and it puts it back ` +
      `when the recipe lets you change a setting again${ownThere ? ` and there is no ${OWN_SETTINGS_FILE}` : ''}.`);
  }
  return sections.join('\n\n');
}

/**
 * What the next start does with the resident's file, for the operator
 * (`connectome doctor`): each entry that would be in force with its value,
 * each that would not with its reason, and the parked file where it is
 * there. Empty where the recipe has no ownSettings and the directory holds
 * neither file.
 */
export function ownSettingsLines(operator: OperatorRecipe, dataDir: string): string[] {
  const grant = operator.recipe.ownSettings;
  const dir = ownSettingsDir(dataDir);
  const own = resolve(dir, OWN_SETTINGS_FILE);
  const parked = resolve(dir, OWN_SETTINGS_SET_ASIDE);
  const ownThere = exists(own);
  const parkedThere = exists(parked);
  if (grant === undefined && !ownThere && !parkedThere) return [];
  const lines: string[] = [...grantWarnings(operator.recipe)];
  if (!changesSettings(grant)) {
    lines.push(grant === undefined ? 'The recipe has no ownSettings.'
      : Array.isArray(grant) ? 'The recipe\'s ownSettings names no setting that this release has, so the resident reads and changes none.'
      : 'The recipe\'s ownSettings is "read", so the resident changes no setting.');
    if (ownThere) {
      lines.push(isPlainFile(own)
        ? `${own} is there, and the next start parks it as ${OWN_SETTINGS_SET_ASIDE}.`
        : `${own} is there, and it is not a plain file, so the next start leaves it where it is, and says so. Remove it, or make it a plain file that the next start parks.`);
    }
    if (parkedThere) lines.push(`${parked} is there: the resident's file, parked while the recipe lets it change no setting.`);
    return lines;
  }
  if (grant === 'all') {
    lines.push(`The recipe's ownSettings is "all", which in this release covers these ${OWN_SETTING_NAMES.length} settings: ${OWN_SETTING_NAMES.join(', ')}.`);
  }
  const others = [
    ...(operator.recipe.modules?.subagents ? ['subagents (modules.subagents is on)'] : []),
    ...(operator.recipe.conversations !== undefined ? ['conversation forks (conversations is set)'] : []),
  ];
  if (others.length > 0 && filePlace(dataDir, operator.recipe, OWN_SETTINGS_FILE).startsWith(`${OWN_SETTINGS_MOUNT}/`)) {
    lines.push(`Any agent of the host that can call ${WRITE_TOOL} can write ${OWN_SETTINGS_MOUNT}/${OWN_SETTINGS_FILE}, such as the resident's ${others.join(' and ')}.`);
  }
  const check = checkOwnSettings(operator, dataDir);
  const fromParked = resolve(check.path) === parked;
  if (check.file.kind === 'none') {
    lines.push(`There is no ${own}.`);
  } else if (fromParked && check.file.kind === 'unread') {
    lines.push(`The next start leaves ${parked} where it is, and does not use it: ${check.file.why}. ${check.file.remedy}`);
  } else {
    if (fromParked) lines.push(`The next start puts ${parked} back as ${OWN_SETTINGS_FILE}${check.file.kind === 'entries' ? ', and applies it' : ''}.`);
    if (check.file.kind !== 'entries') {
      lines.push(`The next start does not use the resident's file: ${check.file.why}. ` +
        (check.file.kind === 'not-an-object' ? 'Write it again as one JSON object, or remove it.' : check.file.remedy));
    } else if (check.entries.length === 0) {
      lines.push('The resident\'s file holds no entry.');
    }
  }
  lines.push(...listed(check.entries, (entry) => (entry.notUsed === null
    ? `${entry.name} would be ${brief(entry.value)} from the resident's file; ${recipeOwn(operator, entry.name)}.`
    : `${logName(entry)} in the resident's file would not be used: ${ended(operatorReason(entry.name, entry.notUsed))}`),
  (count) => `The resident's file has ${count} more entries that name no setting.`));
  if (ownThere && parkedThere) lines.push(`${parked} is there too, and the start uses ${OWN_SETTINGS_FILE}.`);
  return lines;
}
