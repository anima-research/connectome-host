import { packageJson } from './packages.js';
import { answerOf, type KeyAnswer } from './provider-key.js';

export const DISCORD_API = 'https://discord.com/api/v10';

/** Asks Discord whether it accepts a bot token, as the token's own bot user. */
export function checkDiscordToken(token: string, fetch?: typeof globalThis.fetch): Promise<KeyAnswer> {
  return answerOf(`${DISCORD_API}/users/@me`, {
    authorization: `Bot ${token}`,
    // Discord asks an API caller for a User-Agent that names its library, and can refuse a call without one.
    'user-agent': `DiscordBot (https://github.com/anima-research/connectome-host, ${packageJson().version})`,
  }, fetch);
}
