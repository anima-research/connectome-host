import { join } from 'node:path';
import type { Recipe } from './recipe-schema.js';

/** The directory in the data directory that holds the resident's own settings file. */
export const ownSettingsDir = (dataDir: string): string => join(dataDir, 'own-settings');
/** The resident's own settings file, in ownSettingsDir. */
export const OWN_SETTINGS_FILE = 'own.json';
/** Where the host moves OWN_SETTINGS_FILE when the recipe stops letting the resident change settings. */
export const OWN_SETTINGS_SET_ASIDE = 'own.not-used.json';
/** The workspace mount of ownSettingsDir that the host adds. */
export const OWN_SETTINGS_MOUNT = '_settings';
/**
 * The most bytes of OWN_SETTINGS_FILE that the host reads, so that a start
 * never waits on an unbounded read, and the mount's limit for one file, so
 * that the workspace refuses a write that a start would not read: the
 * default limit for one file of a mount in agent-framework, which doesn't
 * export it.
 */
export const OWN_SETTINGS_MAX_BYTES = 5 * 1024 * 1024;

type AvailabilityKind = 'always' | 'strategy' | 'reader' | 'retrieval' | 'subagents' | 'ttsRelay' | 'replyJudge';
type Availability = { readonly when: string; readonly on: (recipe: Recipe) => boolean };

/**
 * When a setting of the table means something on a host: where the operator's
 * recipe has what reads it. A resident's entry never switches a module on.
 */
export const AVAILABILITY: Readonly<Record<AvailabilityKind, Availability>> = {
  always: { when: 'on every host', on: () => true },
  strategy: {
    when: 'with the strategy "autobiographical" or "frontdesk"',
    on: (recipe) => {
      const type = recipe.agent.strategy?.type ?? 'autobiographical';
      return type === 'autobiographical' || type === 'frontdesk';
    },
  },
  reader: { when: 'with a reader (subconscious) on', on: (recipe) => recipe.subconscious?.enabled === true },
  retrieval: {
    when: 'with modules.retrieval and modules.lessons on',
    on: (recipe) => Boolean(recipe.modules?.retrieval) && Boolean(recipe.modules?.lessons),
  },
  subagents: { when: 'with modules.subagents on', on: (recipe) => Boolean(recipe.modules?.subagents) },
  ttsRelay: { when: 'with the voice relay on (modules.ttsRelay)', on: (recipe) => Boolean(recipe.modules?.ttsRelay) },
  replyJudge: {
    when: 'with the gate on (modules.wake not false) and its reply judge not switched off',
    on: (recipe) => {
      const wake = recipe.modules?.wake;
      return wake !== false && !(typeof wake === 'object' && wake.judge?.enabled === false);
    },
  },
};

/**
 * What a numeric row takes, past what the recipe's field takes: a value that
 * the row's words describe. That is a whole number of 0 or more where the
 * words give 0 a meaning, and of 1 or more where they don't (`least`), up to
 * the largest safe integer. With `byName`, the row also takes an object from
 * tool names to such numbers. The recipe's field takes more, which an
 * operator's recipe keeps: a resident's value outside the domain can keep its
 * host down (a `targetChunkTokens` of 0 stops the chunker's loop from moving).
 */
type Domain = { readonly least: 0 | 1; readonly byName?: true };

/**
 * The settings that an operator can let a resident manage with the recipe's
 * `ownSettings`: each one's path in the recipe, the words that the resident
 * reads about it, and when it is available on a host.
 */
export const OWN_SETTINGS = [
  {
    name: 'agent.proseRouting',
    available: 'always',
    example: 'explicit',
    words: 'The mode of your plain speech: where a line goes that you write without a send tool.' +
      ' `locus`: the host posts each plain line to the turn\'s channel, where the turn has one.' +
      ' `explicit`: a line is posted where you put a destination before it, such as `>>#channel`, and each later line of that turn goes there too, until you name another.' +
      ' A line with no destination named before it in the turn is not posted, and it is held for you to send again.' +
      ' The host then wakes you about the held line, up to two times in a row.' +
      ' This also happens when your line answered someone at the host\'s terminal.' +
      ' `hybrid`: as `locus`, and a line that starts with `>>>destination` goes there; each later line of that turn goes there too, until another `>>>` line changes that.' +
      ' `disabled`: no plain line is posted, and only a send tool posts.' +
      ' `locked`: every plain line goes to one destination, and you move it with the tool `prose_locus`, if your operator\'s tool list lets you call it.' +
      ' A change reaches the people in your channels, and `locked` changes your tool list.',
  },
  {
    name: 'agent.timezone',
    available: 'always',
    example: 'Europe/Berlin',
    words: 'Your local time zone, for your clock rows and the times that the host shows you.' +
      ' Rows that are already written keep the old zone.' +
      ' With the strategy `frontdesk`, the times shown with channel messages are in the zone, so a change there writes your prompt cache again, one time.' +
      ' Your MCPL servers are given the zone too, and so is a fleet child whose recipe sets none.',
  },
  {
    name: 'agent.autoContinue',
    available: 'always',
    example: { maxConsecutive: 2 },
    words: 'Whether you get another turn after a turn that you end yourself, and how many in a row.' +
      ' You end the row with `skip_reply`: the tool, or in the modes `explicit` and `hybrid` an envelope.' +
      ' If your host offers you no way to end the row, no turn continues.' +
      ' Other people get more messages, and the operator pays for the turns.',
  },
  {
    name: 'agent.clock',
    available: 'always',
    example: { intervalMinutes: 30 },
    words: 'Your clock rows: how often one comes, or `false` for none.' +
      ' On some models, a clock row in the middle of a turn drops the turn\'s earlier thinking.',
  },
  {
    name: 'agent.refusalHandling.autoRewind',
    available: 'always',
    example: true,
    words: 'Whether the host sets your newest turn aside after the provider refuses a request, and then tries again: one turn for each refusal in a row, up to a limit.' +
      ' A row then tells you how many turns were set aside.' +
      ' Their content is not shown to you, and it stays in the stored record.',
  },
  {
    name: 'agent.strategy.maxLiveImages',
    domain: { least: 0 },
    available: 'strategy',
    example: 3,
    words: 'How many pictures stay in your view as pictures, counted from the newest.' +
      ' An older one is replaced by a line of text. 0 sets no limit of your own.' +
      ' With a limit, each new picture past it turns the oldest picture into text.' +
      ' Each time, that writes your prompt cache again from that picture, and it invalidates your thinking after that picture.',
  },
  {
    name: 'agent.strategy.imageStripDepthTokens',
    domain: { least: 0 },
    available: 'strategy',
    example: 50_000,
    words: 'How deep in your history a picture stays a picture, in tokens from the newest message.' +
      ' 0 means that depth turns no picture into text.' +
      ' Each picture that passes the depth turns into text, at the same cost each time.',
  },
  {
    name: 'agent.strategy.toolResultMaxLastN',
    domain: { least: 0, byName: true },
    available: 'strategy',
    example: 5,
    words: 'How many of a tool\'s last results you are sent in full: one number for every tool, or a number for each tool by its name.' +
      ' An older result is replaced by a short marker. The stored result stays.' +
      ' With a limit, each new result past it turns the oldest shown result into the marker, and that writes your prompt cache again from there, each time.' +
      ' With 0, you are sent no result of that tool at all, also not of the tool that reads your files.',
  },
  {
    name: 'agent.strategy.toolUseInputMaxTokens',
    domain: { least: 0 },
    available: 'strategy',
    example: 2_000,
    words: 'The longest that the arguments of one tool call in your view may be.' +
      ' Longer arguments are replaced whole by a short marker, which gives their size and their first five keys.' +
      ' The stored call stays. 0 sets no limit.',
  },
  {
    name: 'agent.strategy.maxMessageTokens',
    domain: { least: 0 },
    available: 'strategy',
    example: 8_000,
    words: 'The longest that one message in your view may be. A longer one is cut. 0 sets no limit.' +
      ' A small value cuts every longer message, also the results of your tools.' +
      ' Where it is above 0, it also caps the message of lessons that the host retrieves, unless a smaller cap of the host\'s applies.',
  },
  {
    name: 'agent.strategy.summaryTargetTokens',
    domain: { least: 1 },
    available: 'strategy',
    example: 600,
    words: 'How long each summary of your memory is. A summary that was written stays as it was written.',
  },
  {
    name: 'agent.strategy.targetChunkTokens',
    domain: { least: 1 },
    available: 'strategy',
    example: 3_000,
    words: 'The size of one chunk of your history. Each chunk gets a summary. A summary that was written stays.',
  },
  {
    name: 'agent.strategy.summaryParticipant',
    available: 'strategy',
    example: 'Ember',
    words: 'The name under which your summaries speak.' +
      ' With another name than yours, your memories read as someone else\'s words about you.' +
      ' A change writes your prompt cache again from your first summary, one time.',
  },
  {
    name: 'agent.strategy.summaryContextLabel',
    available: 'strategy',
    example: 'Earlier, in summary:',
    words: 'The line that you read before a summary in your context.' +
      ' A change writes your prompt cache again from your first summary, one time.',
  },
  {
    name: 'agent.strategy.identityReminder',
    available: 'strategy',
    example: 'Write as me.',
    words: 'A reminder that is added to each instruction to your summarizer, so that a summary is written in your voice and not in another speaker\'s.',
  },
  {
    name: 'speech.locus',
    available: 'always',
    example: 'latest-inbound',
    words: 'Where a plain line goes when nothing names a channel.' +
      ' `delivery`: to the channel that woke the turn, or to one that you opened in the turn.' +
      ' Past those, it goes to the channel of an open tune-out hold, or to the channel that your operator set for turns that your own timer starts.' +
      ' With none of these the line stays private, and a notice tells you.' +
      ' `latest-inbound`: the same, and else to the channel of the newest incoming message; a message that is addressed to you in the middle of a turn moves the turn\'s channel.' +
      ' This setting also decides where a `channel_publish` call that names no channel goes, in every mode of your plain speech but `locked`.' +
      ' A call that names its channel is not affected.' +
      ' In the mode `locked`, this setting does nothing.',
  },
  {
    name: 'tuneOut.announce',
    available: 'reader',
    example: true,
    words: 'Whether the channel that stays open is told when you tune out, and again when that ends: one line under your name each time.',
  },
  {
    name: 'modules.retrieval.maxInjected',
    domain: { least: 0 },
    available: 'retrieval',
    example: 4,
    words: 'The most lessons that the host puts into your context for one turn. Each costs tokens. With 0, the host puts in none.' +
      ' It still searches for lessons at each turn, and only your operator can turn the search off.',
  },
  {
    name: 'modules.subagents.orientation',
    available: 'subagents',
    example: 'none',
    words: 'What a fork or a subagent of yours is told at its start: `full` or `none`.',
  },
  {
    name: 'modules.ttsRelay.notifyOnInterruption',
    available: 'ttsRelay',
    example: false,
    words: 'Whether you are told when your voice was interrupted: one row of context each time, where the host can tell that it was your voice.' +
      ' With `false`, you are not told. Either way, where some of the message was spoken and the host can edit it, the host cuts the posted message to what was spoken.',
  },
  {
    name: 'modules.wake.judge.onError',
    available: 'replyJudge',
    example: 'skip',
    words: 'What happens when the reply judge fails: you are woken (`wake`) or not (`skip`).',
  },
] as const satisfies ReadonlyArray<{
  readonly name: string; readonly available: AvailabilityKind; readonly example: unknown; readonly words: string; readonly domain?: Domain;
}>;

export type OwnSettingName = (typeof OWN_SETTINGS)[number]['name'];
export type OwnSetting = (typeof OWN_SETTINGS)[number];

export const OWN_SETTING_NAMES: readonly OwnSettingName[] = OWN_SETTINGS.map((setting) => setting.name);

/**
 * Whether the grant lets the resident change a setting: `"all"`, or a list
 * that names at least one setting of the table. A list that names none, as
 * after a release that drops each setting it names, changes nothing, as
 * `"read"` does.
 */
export const changesSettings = (grant: Recipe['ownSettings']): boolean =>
  grant === 'all' || (Array.isArray(grant) && grant.some((name) => OWN_SETTINGS.some((setting) => setting.name === name)));

const domainOf = (setting: OwnSetting): Domain | undefined => ('domain' in setting ? setting.domain : undefined);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** What a numeric row takes, in words: its domain's, for the resident's tool and its refusals. Undefined for a row with no domain. */
export function domainTakes(setting: OwnSetting): string | undefined {
  const domain = domainOf(setting);
  if (domain === undefined) return undefined;
  const count = `a whole number from ${domain.least} to ${Number.MAX_SAFE_INTEGER}`;
  return domain.byName ? `${count}, or an object from tool names to such numbers` : count;
}

/** Whether `value` is inside the row's domain; true for a row with none. */
export function insideDomain(setting: OwnSetting, value: unknown): boolean {
  const domain = domainOf(setting);
  if (domain === undefined) return true;
  const fits = (n: unknown): boolean => typeof n === 'number' && Number.isSafeInteger(n) && n >= domain.least;
  return domain.byName && isPlainObject(value) ? Object.values(value).every(fits) : fits(value);
}

/** The settings tool, as agent-framework names a utility of the host's `settings` module. */
export const OWN_SETTINGS_TOOL = 'settings--own';
export const WRITE_TOOL = 'workspace--write';

/**
 * The warnings about `ownSettings` that a start's log and `connectome doctor`
 * give: one for each setting that the list names and that does nothing on
 * this host, and one when `agent.allowedTools` is a list that leaves out a
 * tool that the grant needs.
 */
export function ownSettingsWarnings(recipe: Recipe): string[] {
  const grant = recipe.ownSettings;
  if (grant === undefined) return [];
  const warnings: string[] = [];
  if (Array.isArray(grant)) {
    for (const setting of OWN_SETTINGS) {
      if (grant.includes(setting.name) && !AVAILABILITY[setting.available].on(recipe)) {
        warnings.push(`Recipe ownSettings names ${setting.name}, and that grant does nothing on this host: the host uses a resident's ` +
          `value for it only ${AVAILABILITY[setting.available].when}.`);
      }
    }
  }
  const allowed = recipe.agent.allowedTools;
  if (Array.isArray(allowed)) {
    const changes = changesSettings(grant) && recipe.modules?.workspace !== false;
    const missing = [OWN_SETTINGS_TOOL, ...(changes ? [WRITE_TOOL] : [])].filter((tool) => !allowed.includes(tool));
    if (missing.length > 0) {
      warnings.push(`Recipe agent.allowedTools leaves out ${missing.join(' and ')}, which ownSettings needs: ` +
        `${OWN_SETTINGS_TOOL} shows the resident its settings${changes ? `, and ${WRITE_TOOL} writes its settings file` : ''}. ` +
        `Add ${missing.length > 1 ? 'them' : 'it'} to the list.`);
    }
  }
  return warnings;
}
