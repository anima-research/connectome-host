import { closeSync, constants, copyFileSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
  OWN_SETTINGS_SET_ASIDE, OWN_SETTINGS_TOOL, ownSettingsDir, ownSettingsWarnings, type OwnSetting, type OwnSettingName,
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
/** Whether the grant lets the resident change a setting: `"all"`, or a list. */
export const changesSettings = (grant: Grant): boolean => grant === 'all' || Array.isArray(grant);

const isAvailable = (setting: OwnSetting, recipe: Recipe): boolean => AVAILABILITY[setting.available].on(recipe);

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
  | { readonly kind: 'unread'; readonly why: string }
  | { readonly kind: 'not-an-object'; readonly why: string }
  | { readonly kind: 'entries'; readonly entries: ReadonlyArray<readonly [string, unknown]> };

function readOwnFile(path: string): OwnFile {
  let fd: number;
  try {
    // Without O_NONBLOCK, opening a pipe waits for a writer.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOENT') return { kind: 'none' };
    if (code === 'ELOOP') return { kind: 'unread', why: 'it is a link, and the host follows no link there' };
    return { kind: 'unread', why: unreadWhy(err) };
  }
  let text: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { kind: 'unread', why: 'it is not a plain file' };
    const tooLarge = `it is larger than ${OWN_SETTINGS_MAX_BYTES} bytes`;
    if (stat.size > OWN_SETTINGS_MAX_BYTES) return { kind: 'unread', why: tooLarge };
    const buffer = Buffer.alloc(OWN_SETTINGS_MAX_BYTES + 1);
    let length = 0;
    for (let n = -1; n !== 0 && length < buffer.length;) {
      n = readSync(fd, buffer, length, buffer.length - length, null);
      length += n;
    }
    if (length > OWN_SETTINGS_MAX_BYTES) return { kind: 'unread', why: tooLarge };
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } catch (err) {
    if (err instanceof TypeError) return { kind: 'not-an-object', why: 'it is not UTF-8 text' };
    return { kind: 'unread', why: unreadWhy(err) };
  } finally {
    closeSync(fd);
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
  const fault = settingFault(name, value);
  return { name, value, notUsed: fault === undefined ? null : { kind: 'value', fault } };
}

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

/** A line for each of the first LISTED_MAX items, and a last line that counts the rest. */
function listed<T>(items: readonly T[], line: (item: T) => string, rest: (count: number) => string): string[] {
  const lines = items.slice(0, LISTED_MAX).map(line);
  return items.length <= LISTED_MAX ? lines : [...lines, rest(items.length - LISTED_MAX)];
}

const near = (name: string): string | null => nearestKey(name, OWN_SETTING_NAMES);

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
      return `${name} is not used: it does nothing on this host, since it takes effect only ${reason.when}. Your operator's recipe decides that.`;
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
      return `it takes effect only ${reason.when}`;
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
  const warnings = ownSettingsWarnings(operator.recipe).map((warning) => `[own-settings] ${warning}`);
  const log = [...warnings];
  const warn = (line: string) => { log.push(line); warnings.push(line); };
  let move: OwnFileMove = null;
  if (changesSettings(grant)) {
    try {
      mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    } catch (err) {
      warn(`[own-settings] The host could not make ${dir}: ${errorText(err)}.`);
    }
    if (!exists(own) && exists(parked)) {
      move = 'put-back';
      log.push(`[own-settings] The recipe lets the resident change settings again, so the host applies ${parked}, and puts it back ` +
        `as ${own} once it has started.`);
    }
  } else if (exists(own)) {
    move = 'park';
    log.push(`[own-settings] The recipe lets the resident change no setting, so the host parks ${own} as ${parked} once it has started.`);
  }
  const check = checkOwnSettings(operator, dataDir, move === 'put-back' ? parked : own);
  if (check.file.kind === 'unread' || check.file.kind === 'not-an-object') {
    warn(`[own-settings] The host did not use ${check.path}: ${check.file.why}.`);
  }
  const line = (entry: OwnEntry): string => (entry.notUsed === null
    ? `[own-settings] ${entry.name} is ${brief(entry.value)} from the resident's file; ${recipeOwn(operator, entry.name)}.`
    : `[own-settings] ${cut(entry.name)} in the resident's file is not used: ${ended(operatorReason(entry.name, entry.notUsed))}`);
  log.push(...listed(check.entries, line, (count) => `[own-settings] The resident's file has ${count} more entries.`));
  warnings.push(...listed(check.entries.filter((entry) => entry.notUsed !== null), line,
    (count) => `[own-settings] The resident's file has ${count} more entries that are not used.`));
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
        copyFileSync(from, to, constants.COPYFILE_EXCL);
        unlinkSync(from);
      }
      return `[own-settings] The host moved ${from} to ${to}.`;
    } catch (err) {
      if (move === 'put-back' && errorCode(err) === 'EEXIST') {
        return failed(`[own-settings] ${to} was written during the start, so the host left ${from} where it is.`);
      }
      return failed(`[own-settings] The host could not move ${from} to ${to}: ${errorText(err)}. The next start decides the same, and ` +
        'gives the resident its note again.');
    }
  };
  for (const warning of warnings) noteRecipeWarning(warning);
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
      (inForce.length > 0 ? ` In force from it:\n${listed(inForce, (entry) => `- ${residentReason(entry)}`, (count) => `- and ${count} more entries`).join('\n')}` : ' Nothing of it is in force.'));
  }
  if (check.file.kind === 'unread' || check.file.kind === 'not-an-object') {
    parts.push(`The host did not use your settings file ${place} at this start: ${check.file.why}. The recipe's values are in force. ` +
      (check.file.kind === 'not-an-object'
        ? 'Write it again as one JSON object, or remove it.'
        : 'Replace it with a plain file, or ask your operator.'));
  }
  if (notUsed.length > 0) {
    parts.push(`Your settings file ${place} did not take effect as written at this start.` +
      `${inForce.length > 0 ? ' Each other entry of it is in force.' : ''}\n` +
      listed(notUsed, (entry) => `- ${residentReason(entry)}`, (count) => `- and ${count} more entries that are not used`).join('\n'));
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

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

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
 * that the resident may read with its value in force and where that comes
 * from, how to change them, and the file as the next start would apply it.
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

  const pending = readable.filter((setting) => !sameValue(valueAt(start.recipe, setting.name), valueAt(next.recipe, setting.name)));
  if (pending.length > 0) {
    sections.push('Pending: your file changes these at the next start, and they are not in force in this run.\n' +
      pending.map((setting) => {
        const later = valueAt(next.recipe, setting.name);
        const fromNextFile = next.entries.some((entry) => entry.name === setting.name && entry.notUsed === null);
        const value = fromNextFile ? brief(later)
          : valueAt(operator.recipe, setting.name) !== undefined ? `the recipe's own value, ${recipeValueShown(operator, setting.name)}`
          : 'not set by the recipe or your file';
        return `- ${setting.name}: ${value} at the next start`;
      }).join('\n'));
  }

  sections.push(readable.map((setting) => {
    const available = isAvailable(setting, operator.recipe);
    const inForce = valueAt(start.recipe, setting.name);
    const now = !available ? `not available on this host: it takes effect only ${AVAILABILITY[setting.available].when}`
      : fromFile(setting.name)
        ? `${brief(inForce)}, from your file, and ${recipeOwn(operator, setting.name)}`
      : inForce !== undefined ? `${recipeValueShown(operator, setting.name)}, from the recipe`
      : setting.name === 'agent.proseRouting' && running.proseRouting !== undefined
        ? `${shown(running.proseRouting)}, the agent's own default`
      : hostValue(setting.name, start.recipe, running) !== undefined
        ? `${hostValue(setting.name, start.recipe, running)}, which the host sets, since neither the recipe nor your file sets it`
        : 'not set: the package\'s default applies';
    const may = mayChange(grant, setting.name) ? 'You may change it.' : 'You may read it, and your operator\'s recipe does not let you change it.';
    return `${setting.name}: ${now}. ${may}\n  ${setting.words}\n  It takes ${settingTakes(setting.name) ?? 'what the recipe takes there'}.`;
  }).join('\n\n'));

  const place = filePlace(dataDir, operator.recipe, OWN_SETTINGS_FILE);
  const mounted = place.startsWith(`${OWN_SETTINGS_MOUNT}/`);
  if (changesSettings(grant)) {
    const example = OWN_SETTINGS.find((setting) => mayChange(grant, setting.name) && isAvailable(setting, operator.recipe))
      ?? OWN_SETTINGS.find((setting) => mayChange(grant, setting.name));
    sections.push(`To change a setting, write it into ${place}` +
      (mounted ? '' : ', on the host\'s disk: this host has no workspace, so a shell tool of yours can write it there, or your operator can') +
      ': one JSON object, each key a setting\'s name, and each value what the recipe would hold at that place, whole' +
      (example === undefined ? '' : `, such as {${JSON.stringify(example.name)}: ${shown(example.example)}}`) + '. ' +
      'A change takes effect when the host next starts. A key that you remove from the file follows the recipe again. ' +
      (running.restartOffered
        ? 'You can ask for a restart with lifecycle--restart.'
        : 'Here lifecycle--restart can\'t restart the host, so a change waits until your operator restarts it.'));
  } else {
    sections.push('Your operator\'s recipe lets you read these settings, and it lets you change none of them.');
  }

  const parked = resolve(ownSettingsDir(dataDir), OWN_SETTINGS_SET_ASIDE);
  const ownThere = exists(join(ownSettingsDir(dataDir), OWN_SETTINGS_FILE));
  const parkedThere = exists(parked);
  const parkedPlace = filePlace(dataDir, operator.recipe, OWN_SETTINGS_SET_ASIDE);
  if (!changesSettings(grant)) {
    if (ownThere) sections.push(`Your file ${place} is there, and the next start parks it, since the recipe lets you change no setting.`);
  } else if (next.file.kind === 'none') {
    sections.push(`There is no file ${place} now.`);
  } else {
    const fromParked = resolve(next.path) === parked;
    const lines = next.file.kind === 'entries'
      ? (next.entries.length === 0 ? ['It holds no entry.'] : listed(next.entries, (entry) => `- ${residentReason(entry)}`, (count) => `- and ${count} more entries`))
      : [];
    sections.push(fromParked
      ? `Your parked file ${parkedPlace} is there, and ${place} is not: the next start puts it back as ${place}, and applies it. If you ` +
        `write a new ${place} first, the next start uses that file in its place, and leaves the parked one where it is.\n` +
        (next.file.kind === 'entries' ? `The parked file, as the next start applies it:\n${lines.join('\n')}` : `The next start does not use the parked file: ${next.file.why}.`)
      : next.file.kind === 'entries'
        ? `Your file ${place} now, as the next start applies it:\n${lines.join('\n')}`
        : `Your file ${place} now. The next start does not use it: ${next.file.why}.`);
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
  const lines: string[] = [...ownSettingsWarnings(operator.recipe)];
  if (!changesSettings(grant)) {
    lines.push(grant === undefined ? 'The recipe has no ownSettings.' : 'The recipe\'s ownSettings is "read", so the resident changes no setting.');
    if (ownThere) lines.push(`${own} is there, and the next start parks it as ${OWN_SETTINGS_SET_ASIDE}.`);
    if (parkedThere) lines.push(`${parked} is there: the resident's file, parked while the recipe lets it change no setting.`);
    return lines;
  }
  if (!ownThere && parkedThere) lines.push(`The next start puts ${parked} back as ${OWN_SETTINGS_FILE}, and applies it.`);
  const check = checkOwnSettings(operator, dataDir);
  if (check.file.kind === 'none') lines.push(`There is no ${own}.`);
  else if (check.file.kind !== 'entries') {
    lines.push(`The next start does not use the resident's file: ${check.file.why}. ` +
      (check.file.kind === 'not-an-object' ? 'Write it again as one JSON object, or remove it.' : 'Replace it with a plain file, or remove it.'));
  }
  else if (check.entries.length === 0) lines.push('The resident\'s file holds no entry.');
  lines.push(...listed(check.entries, (entry) => (entry.notUsed === null
    ? `${entry.name} would be ${brief(entry.value)} from the resident's file; ${recipeOwn(operator, entry.name)}.`
    : `${cut(entry.name)} in the resident's file would not be used: ${ended(operatorReason(entry.name, entry.notUsed))}`),
  (count) => `The resident's file has ${count} more entries.`));
  if (ownThere && parkedThere) lines.push(`${parked} is there too, and the start uses ${OWN_SETTINGS_FILE}.`);
  return lines;
}
