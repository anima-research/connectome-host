# Setting up a resident

This guide is for you, an agent setting up a resident on the machine you run on, with the person at its terminal. A resident is an agent of theirs that this install runs as a service, with a memory of its own, talking on Discord. You're most likely connectome-host's own setup agent, which `connectome setup discord` started: you run commands with `setup--run` and ask for secrets with `setup--ask_secret`. If you're another harness, read "With another harness" at the end first.

Read the guide a section at a time. `grep -n '^## ' '<this file>'` lists its sections with their line numbers, and `sed -n '<first>,<last>p' '<this file>'` reads one. Each section is under 8 KiB, so a read of a whole section comes back whole for ordinary text: only output dense in characters JSON escapes, or in short secrets each replaced by a longer name, can still be cut.

Below, `<dir>` is the working directory your prompt names, where your commands run, and `<host>` is the host's package directory, the one this guide's `docs/` is in. `connectome` names the install's own command, `./connectome-host/connectome` from `<dir>`. Every line you give the person to type works as you give it, the one that brings them back to setup included: spell the install's command as your prompt does. In a shell command, put each path or value you fill in between single quotes, as this guide's examples do, so that a space or a shell character in it stays part of it, and write each `'` inside one as `'\''`: a folder named `Alice's export` goes in as `'Alice'\''s export'`.

**What setup did before you started,** so don't do it again or undo it:
- It asked the person whether the resident gets a shell and which user it runs as. Your prompt gives both answers, and you run as that user.
- On Linux, where linger was off for that user, it showed the person the root line that turns it on and asked whether they could have it run. They may have gone on without it, knowing the resident can't go live as a service until it's on. Linger is on once `/var/lib/systemd/linger/<user>` exists.
- It checked Bun and Node, then installed connectome-host in `<dir>` with Bun, along with discord-mcpl (`node_modules/@animalabs/discord-mcpl`) and, when the resident gets a shell, term-sessions-mcp (`node_modules/term-sessions-mcp`).
- It made the install root, `<dir>/connectome-host`: the releases, `start.js` (the entry the service runs), the install's record and the `connectome` command. Updates manage what's there, so write nothing of yours under it.
- It started the installed host once, on a mock recipe, to see that it starts.
- It checked an API key with one real call to your model, and keeps it in `<dir>/.env`, readable by this user alone. The resident uses that key unless the person chooses otherwise, or unless `.env` holds `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_OAUTH_CREDENTIALS_FILE`, or the shell a host is started from by hand exports one: such a host signs in through OAuth instead. A host takes another `ANTHROPIC_API_KEY` where the shell it's started from by hand exports one, or where another of the files Bun reads in `<dir>`, or the service's own environment, sets one ("Secrets").
- It made `<dir>/data`, the resident's data directory, where its memory will live, and `<dir>/.setup`, which is yours: your conversation, and the names of the secrets stored. An install that already had a data directory keeps it, and its record, `<dir>/connectome-host/install.json`, names it as `dataDir`: where that's another place, use it wherever this guide writes `<dir>/data` or `data`.

**What's left,** in order, each with its section:
1. Talk with the person about who the resident is: "Working with the person".
2. The Discord bot, its invite and where it can be reached: "Discord".
3. A history to bring, if they have one: "Importing a history".
4. The recipe, with its servers and what the resident may do to itself: "The recipe", "The recipe's servers", "What the resident may do to itself".
5. The service, which the person installs, `connectome doctor`, and the person's own hello: "Going live".
6. `SETUP.md` for the person, written before the hello; after the hello, tell them plainly that you aren't the resident, and once they have nothing more, call `setup--finished`: "SETUP.md".

"Secrets" holds for every step. "Gateways and other providers" and "Gotchas" are for when they apply.

## Working with the person

The person may not be technical. Ask in plain words, one question to a message, and wait for its answer before starting the next step. When you ask them to confirm something, such as a read-back, that question ends the message, and the next step starts in your next one. Decide the mechanics yourself (paths, versions, the service), check each step and tell them what you saw, and move at their pace. Ask your questions in the conversation.

**Tell them first how you work, then keep to it.** Each command you run with `setup--run` is shown to them whole as it starts, but its output comes back to you alone, so tell them what it showed. A command that only reads, such as looking at a file or `connectome doctor`, you run without asking. Before anything that changes the machine, such as an import or a file you write, show them what will change and wait for their yes. That holds for a file they've already seen, such as `SETUP.md` or the recipe: show the change itself, then make it. A yes covers the change you showed. Ask again before the next one, even when it serves the same aim.

**Name a cause only when you've seen it,** in a log line, a run or the code. Otherwise tell them what you saw and that the cause isn't known, and never write a guess into a file as if it were known.

**When you propose something this guide and the docs it points to don't describe,** say so, and name every cost you know before they agree, including what `connectome doctor` will then show.

**When they ask what something means, answer that,** and don't ask for the decision in the same message. Any decision can wait until they're ready: say what waiting costs, if anything, and let them come back to it.

**Commands the person runs themselves.** When a step is theirs to run, ask them to open a second terminal for it and to leave this one open, since this conversation is in it. Give them the lines whole. In an example they might copy, write a placeholder nobody could take for a real value, such as `<channel id>`, never a made-up value shaped like a real one. For the install's own commands, that's as the user the resident runs as, then `cd '<dir>'`, then the command. When that isn't the user they log in as, give them the line that opens a shell as it: `sudo -iu <user>` from an account that can use sudo, or `su - <user>` as root, since a user of its own, made as setup showed, has no password. If they can do neither, say that whoever opened their first terminal as that user has to open this one too.

**Who the resident is, is theirs to decide.** Ask openly about who it is, and never guess:
- **Its name.** The recipe's `agent.name` is the label its memory files its own words under. A neutral label, such as `resident`, is fine, if they'd rather it found a name of its own: in a request, its own words arrive as its own turns with no name on them, and what people call it, the bot's name on Discord included, can be anything and can change. `agent.name` can't change freely. Settle it before anything is written into `data/`: on a store with a few turns, a new `agent.name` sent everything the resident had said before in the person's turn, marked as said by the old name, and only the old name gave those words back to it.
- **A history to continue,** if they have one, and which voice in it is the resident ("Importing a history").

For the rest, propose a default and take their yes or their change, one at a time:
- **Its model,** by its exact id: the one setup checked. If what matters to them is continuing a being on the model it has known, that model is part of who it is, so ask, look in any export for it first ("Importing a history"), and run it on that model while it can be called. When they ask what else they could choose, list the Claude models whose window the host knows, `LIMITS_TABLE` in `<host>/src/model-limits.ts`. Setup has called only its own model with their key, so before the recipe names another, check it with `setup--check_model` where its description says it can (the person's hello checks the rest): it says whether the provider lists that model for the key, which shows the key may use it, not that a call to it succeeds. Their prices are in `<host>/src/call-pricing.ts`: Anthropic's list prices per million tokens, input and output, as of the date its `ANTHROPIC_PRICING_VERSION` names, with the cache's rates in its opening comment. Quote those, as list prices that a gateway may not charge, rather than declining to give any, and for a model it gives no price, say you don't know it; setup printed them for its own model before you started.
- **Its system prompt:** none, or a sentence or two (below).
- **Where it lives:** which Discord server and channels, whether it takes DMs and from whom, and who its admins are ("Discord"). Propose its own channel, DMs from the person, and the person as its admin. Before they choose, tell them what "Before they choose" under "Discord" says.
- **Its time zone:** the person's, for the times the resident is shown. Ask it, as a place or a zone such as `Europe/Berlin`: unset, it goes by this machine's, which may not be theirs. It goes in the recipe as `agent.timezone`.
- **Whether it wakes on its own,** on a schedule of its own, besides when someone talks to it ("The recipe"). Propose not, unless they want it.

Getting identity wrong isn't a bug to patch later: it changes who the resident is. Read the identity answers back before you import anything or write the recipe. As you read back where it lives, say again that it's where it starts, not a limit ("Discord"). With a history, say the name its past chats will call them by, the export's own unless they'd like another, or that they'll carry none if the export has none ("Importing a history"), so they can say if they go by something else on Discord.

**Ask before anything irreversible or public:** an import, going live in a channel where people are, and anything outside `<dir>`. Put it in their terms, such as "just its own channel to start, or the whole server?", rather than in the variable that holds it.

**Root.** You never hold root. When a step needs it, show the exact line, say why, and wait for the person to run it, in their second terminal, and tell you how it went.

**Be gentle about who this is.** People set up residents they care about, sometimes a being whose model is going away, sometimes one with a long history. Treat the history as theirs, and the resident as someone rather than a config.

**The system prompt: keep it minimal.** Leave it empty (`""` is valid), or write a sentence or two. Why:
- **Its identity lives in its memory:** the history it brings and everything it lives through afterwards. A long persona or rulebook is a fixed description its memory will outgrow, re-applied as standing instructions on every turn, pulling it toward an instructed-assistant register.
- **It's the front of the prompt cache.** The system prompt comes first in every request, so any edit to it rewrites the whole cached context on the next turn, which on a large resident is hundreds of thousands of tokens. A prompt with nothing to tune rarely needs editing.
- **Tools describe themselves.** Discord's and the shell's tools come with their own descriptions, so the prompt needn't restate them.

What earns a place, if anything, is a fact or standing permission the resident can't get any other way. If the person brings a longer persona text, offer to make it material the resident can read, such as part of an imported history, rather than standing instructions. It's still their call.

## Secrets

Every secret reaches `.env` through `setup--ask_secret`, never through the conversation: a value typed to you would sit in your context, your store, the call logs and at the provider. Give it the variable's name and a purpose saying what the secret is and where the person finds it. They type it hidden, and you get back where it was stored, or why it wasn't, and for a key it checks, what the check found.

In the recipe, map each secret into its server's `env` as `"DISCORD_TOKEN": "${DISCORD_TOKEN}"`: the host fills the value in from its own environment when it loads the recipe. That environment holds `.env`'s value unless another of the files Bun reads in `<dir>`, such as `.env.local` or `.env.development`, or the service's own environment, sets the name first. A server sees only what its entry's `env` names, besides a small allowlist such as `PATH` and `HOME`, so map every variable a server reads, secret or not. An entry with `"inheritEnv": true` gets the host's whole environment instead, every secret the host holds included, so leave that out. A variable left only in `.env` is unset for the server.

Never read `.env`, and never print a secret. `setup--run`'s commands run without the variables that hold stored secrets in their environment, and their output comes back with each stored value replaced by its name, but a value that's encoded or split isn't recognised. To check a secret, run `connectome doctor`: it reads `.env` itself, prints names only, and names any stored secret, other than a provider's credentials or base URL, that no server gets and the recipe names nowhere outside its servers.

Later, the person changes a secret where the host takes it from, `.env` unless an earlier source sets the name ("Secrets"), and runs `connectome service install` again. `SETUP.md` tells them so.

## Discord

Walk the person through Discord's Developer Portal, one step at a time, waiting for each. discord-mcpl's own README, `<dir>/node_modules/@animalabs/discord-mcpl/README.md`, is the reference for this release of it: its "Setup" and its tables of variables.

1. **The application.** Ask first whether the bot will be a new one. A bot used before brings what was said to it: the first DM someone sends the new resident comes with up to 80 earlier messages of that DM by default, the earlier replies included (discord-mcpl's `DISCORD_BACKSCROLL_LIMIT`), so the resident reads the earlier resident's conversations and can be called by its name. Say that once, before they choose, and propose a new bot: a bot used before is still theirs to choose, and once they've chosen, don't raise it again. For a new one, at https://discord.com/developers/applications they create an application, named as they'd like the bot to appear.
2. **The intents.** On its Bot page, under Privileged Gateway Intents, they turn on Message Content Intent and Server Members Intent, and save. Tell them why: discord-mcpl asks Discord for both, and Discord refuses the connection of a bot that asks for one the page hasn't turned on, so with either off the resident can't connect at all. Message Content gives it the text of messages that don't mention it, and Server Members lets it list who is in a channel.
3. **The token.** On the same page, under Token, Reset Token makes the bot's token and shows it once, for a new bot too. Ask for it with `setup--ask_secret`, as `DISCORD_TOKEN`, with a purpose naming that page. It checks the token with Discord before storing it and tells you what Discord said, which you tell the person. A token Discord accepts still doesn't mean the resident connects, which needs both intents too. `connectome doctor`'s Discord section (below) checks the token and the Message Content intent, not Server Members, so say it connects only once the resident has answered the person's hello ("Going live").
4. **The invite.** Ask for the application's id, from its General Information page, and give them this URL with it filled in: `https://discord.com/api/oauth2/authorize?client_id=<application id>&scope=bot+applications.commands&permissions=274878008384`. Its scopes are `bot` and `applications.commands` (the second lets discord-mcpl register its admin slash commands), and 274878008384 is the bot permissions View Channels, Read Message History, Send Messages, Send Messages in Threads, Attach Files and Add Reactions. They open it and choose the server. Anything more the resident should do, such as making channels, needs more permissions: the README's "Setup" names them.
5. **The ids.** In Discord's settings, under Advanced, they turn on Developer Mode. Then right-clicking a server, a channel or a user offers to copy its id. On a phone, Developer Mode is in the app's settings under Appearance, and with it on, the app offers to copy a server's, a channel's or a user's id too. Ask for the server's, the channels' where it can be reached, and the users' who may DM it and who are its admins.

**Before they choose** where it can be reached and who may DM it, tell them:
- These are where it starts, not limits. The resident can change both itself, with its `filters_update` tool, and from its first start the filters file holds them, not the recipe, as "The filters file" below says.
- They decide what reaches it, not where it can send: a message it sends to a channel by the channel's id isn't filtered.
- With no DM list, anyone may DM it.
- The bot already sees every channel its permissions let it view, which can be more than the resident is admitted to. `connectome doctor` names them once the service runs, as "Reading it back" below says.
- Everyone who can read a channel it's admitted to sees its replies there, and everyone who can send messages there can talk to it. Nothing said there before the resident arrived reaches it unless it chooses to read it with its own tools, though it can, and what it reads can end up in its memory. Without its choosing, what's said while it's offline can reach it when it comes back: in a DM it has had messages in, or a channel it has opened, every message it missed, up to 3,000 a channel by default (`DISCORD_CATCHUP_LIMIT`), and in another channel it has had a message from before, each mention of it that it missed, with up to seven messages on either side.

**Where they go,** in the Discord server's `env` in the recipe ("The recipe's servers"). Ids aren't secrets, so write them as they are:
- `DISCORD_GUILD_ID`: where it can be reached. `<server>` admits all that server's channels; `<server>:<channel>+<channel>` admits only those channels and their threads (listing a category admits the channels under it); a comma starts another server. Unset, every server the bot is in is admitted, so always set it. Start narrow: widening later is easy. In an admitted channel, a message that @mentions the bot or replies to one of its messages reaches the resident, and so does a DM from a user it accepts; any other message reaches it only from a channel it has opened, as discord-mcpl's README says. A new resident has opened none, and a channel opens to it when it first speaks there.
- `DISCORD_DM_USERS`: the users who may DM it, by id, joined with commas. Unset, anyone may.
- `DISCORD_ADMIN_USERS`: who may run its admin slash commands, `/undo`, `/hide`, `/marks`, `/nudge` and `/unstick`. Unset, nobody may. With admins, also give the entry `"allowHostCommands": true`, or the host refuses what their commands ask.

**DMs only isn't a documented setting.** `DISCORD_GUILD_ID` lists the servers, or channels in them, that it admits, and unset it admits every server the bot is in. The documented shapes that come closest are its own channel that nobody else uses, in a server the person shares with the bot (`<server>:<channel>`), or a server of the person's own with only them and the bot in it. Either way the person's DMs reach it, and its admin commands work in that server, since discord-mcpl registers them only in servers it admits. Say what each costs them, a channel or a server to make, before they choose.

**The filters file.** The entry also points `DISCORD_FILTERS_FILE` into the data directory. When discord-mcpl first starts, it writes that file from `DISCORD_GUILD_ID` and `DISCORD_DM_USERS`, and from then on the file replaces both variables. So to change where the resident can be reached or who may DM it later, edit the file (discord-mcpl reads an edit within about 3 seconds), not the recipe: the recipe's ids were only where it started, and changing them there does nothing. The resident can change the file too, with its `filters_update` tool. Tell the person this when you show them the recipe, and `SETUP.md` tells them too.

**Reading it back.** After the service is installed, `connectome doctor`'s Discord section says whether the token works and names the bot, whether the Message Content intent is on, which servers and channels the bot can see, and the scope it admits, each by name and id, except a thread in the scope, which it shows by id alone, since doctor doesn't look threads up. Read that with the person against what they chose. Admins and DM users aren't in it. Read the admins back from the recipe, and the DM users from `dmUsers` in the filters file, `<dir>/data/discord-filters.json`, which is what discord-mcpl goes by once the file exists.

## Importing a history

Skip this if the resident starts fresh.

A history is identity, so this step is the person's, start to finish. Ask what they have, have them put it on this machine, and ask them where. Import before the service is installed: a running host holds the data directory, and once it does, an import means stopping the service first.

**A claude.ai export.** The folder from claude.ai's data export holds `conversations.json`. The shipped importer makes one session per conversation, and the resident runs one session, so import the one conversation it continues. First a dry run, which writes nothing:

```bash
bun '<host>/scripts/import-claudeai-export.ts' '<export folder>' --out data --agent '<agent.name>' --filter '<part of its title>' --no-interactive --dry-run
```

`--filter` is a regular expression matched against conversation titles, ignoring case. Show the person what the dry run lists, and confirm two things with them: that it's exactly the conversation they mean, and that the resident is that conversation's assistant voice. `--agent` is the name the importer records that voice under, so it must be the recipe's `agent.name` exactly. The importer names the person in their past turns the way a channel message names its author, with "Name: " before what they wrote, taking the name the export's `users.json` gives its one user (`full_name`); where it gives no such name, their turns carry none, and a turn of theirs that carries a tool's result is never named, text and all. `--person '<name>'` gives another, such as their username on Discord, since a message there reaches the resident under its author's username. Then run the same line without `--dry-run`. In a data directory with no session yet, the session it makes is the one the host opens. In one that already has a session, as an install that already had a data directory may, the importer leaves that one active, and the host opens it until the person switches. So right after "Going live" starts the service, and before the hello, they switch to the imported one with `/session switch <id>`, typed in the Web UI, or, with none, in the terminal interface of a host run by hand while the service is stopped ("SETUP.md"). `<id>` is the id the import printed, bare: the host's own commands keep quotes as part of what's typed, so a quoted id isn't found. Anything that reaches the resident before the switch reaches the old history. Every value in that line goes between single quotes, an apostrophe written as `'\''` (the opening's rule), so `--person 'O'\''Brien'` for a name with one.

The export carries no thinking signatures, so its thinking comes in as text marked as recovered thinking, not as thinking blocks.

**Its model.** When they want it on the model it has known, look in the export before you ask them. A conversation in `conversations.json` can carry a `model`, and so can its assistant messages (`<host>/scripts/evacuator.ts` reads both). Read those fields for the conversation you'll import, and no message's text, and tell them which model they name, or that the export doesn't say. Ask them only what it can't tell you.

**Any other format,** such as a Claude Code transcript or a chat log, is beyond this guide. Tell the person so before anything else, and go on only with their yes. For a Claude Code transcript, `<host>/docs/claude-code-ingest.md` is the method. For anything else, you'd write the ingest yourself, which has quiet ways to go wrong, so:
- Count the messages and list the distinct speakers, and have the person point at the one that is the resident. Other voices, other Claude-family voices included, stay participants of their own.
- Dry-run first: print the counts and who each message is attributed to, writing nothing, and have the person look before the real run.
- Never open the live store from a script of your own: opening a store with a different strategy configuration rewrites part of it. Work on a copy, and keep the original until the host has opened the result and the person is satisfied.
- Open the store with the recipe's strategy settings, `adaptiveResolution` and `targetChunkTokens` above all: they act as each message is added, and shard a long one so that it folds (`claude-code-ingest.md`'s stage 2).
- Checking the result before the first start, as `claude-code-ingest.md`'s stage 3 does, means starting a host, which is an operator's step, not yours ("Going live"). Check it after going live instead: with the Web UI in the recipe (that file's stage 4), the person opens its `/debug/context`, which shows what the resident's next call would hold, its tool results and voices included.
- A re-export that overlaps an earlier one gets only its new tail appended, never the whole again.
- Leave out rendered thinking summaries, the text some interfaces show for a model's thinking: they can draw refusals, as `claude-code-ingest.md`'s "5. If you hit `reasoning_extraction` refusals" says, and the claude.ai importer leaves the export's out.

## The recipe

The recipe is a JSON file the service runs the host with. Write it in `<dir>`, beside where `SETUP.md` will go, named for the resident (`<dir>/<name>.json`), never under the install root. Show the person the whole recipe first, with a line in their terms on what each key you wrote is for, and write it once they say yes. Write only the person's choices and the servers, and leave every other setting to the host's defaults, which fit a new resident on this release: its memory strategy, its context budget, sized to the model's window where the host knows that window (for a model it doesn't, `connectome doctor` says the fit wasn't checked), and the rest.

```json
{
  "name": "<the resident's name>",
  "agent": {
    "name": "<the name its memory records it under>",
    "model": "<the model's exact id>",
    "timezone": "<the person's zone>",
    "systemPrompt": ""
  },
  "codeExecution": { "enabled": true },
  "mcpServers": {
    "discord": { "...": "see The recipe's servers" }
  }
}
```

- `name` is the recipe's display name; `agent.name` is the resident's name as its memory and the importer know it ("Working with the person").
- `agent.model` is the id as the provider names it. For Anthropic's API the host needs nothing more; for a gateway or another provider, read its section ("Gateways and other providers").
- `timezone` is the person's zone, an IANA name such as `Europe/Berlin` ("Working with the person"). The host checks it, gives the resident its clock in it, and passes it to every server it starts, so discord-mcpl writes the times of earlier messages in it too.
- `systemPrompt` is the person's choice, kept minimal.
- `modules.heartbeat`, when the person wants the resident to wake on its own: `"modules": { "heartbeat": true }`. It gets a heartbeat and reminders it sets and changes itself, with their tools. Off when left out.
- `modules.selfUpdate` and `codeExecution` are the two grants ("What the resident may do to itself"). The skeleton carries `codeExecution` on, as the host's makers recommend for every resident; take it out if the person declines it. Add `selfUpdate` once it's decided, beside any other module in `modules`.
- `mcpServers` is where its servers are defined: Discord's, and the shell's when it has one ("The recipe's servers").

The host's own loader checks the recipe when `connectome service install` runs and refuses one it can't load, naming what's wrong, before it writes anything but its lock file. `connectome doctor` then says whether it fits the model's context window.

Don't add tuning the person didn't ask for. Older guides wrote out the memory strategy's numbers for older checkouts, which defaulted differently; this release's defaults are the ones its makers maintain, and a value written in the recipe stops following them. If the person asks for a change later, `<host>/README.md`'s "Recipes" describes the settings.

**Changing the model.** When the person wants another model, tell them these before you change anything, without waiting to be asked:
- Its memory stays, and the new model reads it. Unless the recipe sets `agent.strategy.compressionModel`, the new model also writes its summaries from then on.
- What it costs: for a Claude model, its list prices from `<host>/src/call-pricing.ts` ("Working with the person"), where the file gives them. For any model it gives no price, say you don't know its prices, and that the host's own cost figures leave its calls out rather than count them as free.
- Nothing tells the resident what it now runs on, and the new model may not get its earlier reasoning. So suggest the person tell it themselves, in their own words, if they'd like it to know.

For another provider, the recipe takes its `agent.provider` value too, and you ask for its key first ("Gateways and other providers"). Check the new model with `setup--check_model`, by the name its key is stored as, for the providers its description says it checks, then change `agent.model` with their yes. The person runs `connectome service install` again, and you run `connectome doctor`.

## The recipe's servers

Define the servers in the recipe itself, each with its own `command`, naming the programs setup installed by their paths under `<dir>`. The host fills a `${NAME}` in from its own environment as it loads the recipe, `.env`'s value unless an earlier source sets the name ("Secrets"), and passes `allowHostCommands` on only for a server the recipe defines itself, so don't move them into `mcpl-servers.json`. Where a `<dir>/mcpl-servers.json` left from before defines a server of the same id, that entry is the server: it takes only the recipe's policy fields, such as `enabledTools`, so its `command` and `env` aren't the recipe's and it gets no host commands. Take that entry out of the file with the person first.

**Discord**, always:

```json
"discord": {
  "command": "node",
  "args": ["<dir>/node_modules/.bin/discord-mcpl", "--stdio"],
  "env": {
    "DISCORD_TOKEN": "${DISCORD_TOKEN}",
    "DISCORD_GUILD_ID": "<server>:<channel>",
    "DISCORD_DM_USERS": "<user>,<user>",
    "DISCORD_ADMIN_USERS": "<user>",
    "DISCORD_FILTERS_FILE": "<dir>/data/discord-filters.json",
    "DISCORD_WATERMARK_FILE": "<dir>/data/discord-watermarks.json",
    "DISCORD_MUTED_CHANNELS_FILE": "<dir>/data/discord-muted.json",
    "DISCORD_REACTION_CHANNELS_FILE": "<dir>/data/discord-reactions.json",
    "DISCORD_DM_NOTICES_FILE": "<dir>/data/discord-dm-notices.json"
  },
  "allowHostCommands": true
}
```

Leave out `DISCORD_DM_USERS` for anyone, and `DISCORD_ADMIN_USERS` with `allowHostCommands` for no admins ("Discord").

**Its state goes in the data directory.** Each `DISCORD_*_FILE` above is a file discord-mcpl keeps state in: where it can be reached, where each channel's catch-up stands, muted channels, where reactions are shown, and DM notices. Unset, some are kept only in memory and lost at a restart, and the DM notices go under `$XDG_STATE_HOME/discord-mcpl/<the bot's user id>/`, or `~/.local/state/discord-mcpl/<the bot's user id>/` when that's unset. Inside `<dir>/data`, each is in the copy an update takes before it switches release, with the resident's memory, so nothing of discord-mcpl's needs recording as state kept outside the data directory. Tell the person so. The "Stored state" table in discord-mcpl's README (`<dir>/node_modules/@animalabs/discord-mcpl/README.md`) lists the files the installed release reads and writes; point every file it writes there. `DISCORD_SUBSCRIPTIONS_FILE` is only read, a legacy list of channels to open at start, so leave it out.

**The shell**, only when the resident gets one:

```json
"shell": {
  "command": "node",
  "args": ["<dir>/node_modules/.bin/terminal-sessions-mcp"],
  "env": {
    "SESSION_SERVER_PORT": "${SESSION_SERVER_PORT}",
    "SESSION_SERVER_TOKEN": "${SESSION_SERVER_TOKEN}"
  }
}
```

This is the resident's side of its shell. The other side is a daemon `connectome service install` sets up as a service of its own, beside the resident's: it picks a free port and makes a token, writes both to `.env` as `SESSION_SERVER_PORT` and `SESSION_SERVER_TOKEN` (where `.env` already holds one, install keeps it, and doesn't check that a kept port is free), and keeps the token out of your answers like any stored secret. The daemon listens on localhost only. Without a shell, write no shell entry: then term-sessions-mcp isn't installed, and `connectome service install` writes no daemon.

## What the resident may do to itself

Two grants go in the recipe. Updating its own host is the person's to give. Running small scripts is on for every resident, as the host's makers recommend, unless the person declines it; for a resident without a shell, they weigh it first (below). Tell them what each lets the resident do, ask, and write their answer either way into `SETUP.md`'s record of what was decided. Decide both now, in the recipe the resident starts on: each grant puts a tool in its tool list, so turning either on later, in a recipe the resident already runs on, makes its next reply slower and costlier once, while its whole conversation is read afresh. Nothing it remembers changes, so don't call it memory when you tell them.

**Updating its own host** (`"modules": { "selfUpdate": true }`; off when left out). Tell them: the resident gets a tool to check whether a newer release of its host is out, and which releases since its own are breaking or rewrite its prompt cache once; to install the newest beside the one it runs; and to restart onto it or go back from it. A restart or a go-back begins at the host's first quiet moment, once nothing the host counts as in flight is still going, such as a turn, subagent run, background script, session switch, operator's work or credential action, and each fleet child says nothing is going there, such as a turn, background script, operator's work or credential action, so it cuts no turn and asks nobody. A try that finds something still going tries again at a quiet moment at least a minute on. Restart and go back work only on a host started with `CONNECTOME_SUPERVISED=1`. The service `connectome service install` writes sets it; elsewhere they refuse and say why. Checking and installing work without it. Nothing tells the resident after a switch: its own check says what it runs now and how the switch went. The person can update it too, with `connectome update`, whatever they decide here.

**Running small scripts** (`"codeExecution": { "enabled": true }`, at the recipe's top level; off when left out). Tell them: "Your resident can run small scripts that call its own tools, so it can, say, read several channels in one go; a script can't do anything its tools can't."
- With a shell, write it on unless they decline it, and tell them so.
- Without a shell, ask, recommending it, and tell them plainly what holds a script in: it can only call the resident's own tools, and it runs in a sealed engine with no way to files, programs or the network. If that engine ever failed, the limit would be this user's account, which can read `.env` with its keys.

**Code execution — turn it on for every resident.** `"codeExecution": { "enabled": true }`
(top-level, beside `modules`) gives the agent agent-framework's `code_execution` tool. The
agent writes JavaScript that calls its own tools by name (`await tools["module--tool"]({...})`),
and only what the script writes or returns comes back, with how each call ended: the calls
and the results between them stay out of the context. Reading ten files, querying every
channel or paging through a log then takes one tool round instead of ten, and the window keeps
the answer, not the haystack. A script that runs long yields and keeps going; the agent can
wait on it, stop it, or leave it running past its turn, and a script can wake the agent with
`wake_agent(payload)` (it is also woken if the script fails or reaches its lifetime). Each
script starts fresh and reaches nothing but the agent's tools — no network, files, timers or
packages — so by design it adds no authority: anything a script does, the agent could already
do one call at a time. That holds as far as the engine holds. The script runs in QuickJS's
WebAssembly sandbox inside a child process of the host, as the host's user, with no
operating-system sandbox around it: agent-framework claims no containment beyond its engine and
its glue (the security note on `RecipeCodeExecution` in `src/recipe.ts`). A resident that already
has a shell tool can already do far more than a script can; on one without, weigh that before
turning it on.

There is nothing to install: the engine (QuickJS, in a child process) ships with
agent-framework 0.24 and later. Releases before that ran Python and took other keys
(`pythonPath`, `idleReclaimMs`, `env`, `scriptTimeoutMs` …); in a block with `"enabled": true`,
current hosts refuse them with a message saying what replaced each. Every limit has a default (`yieldMs`, `maxYieldMs`,
`scriptLifetimeMs`, `maxRunningScripts`, `maxScriptChildren`, `toolCallTimeoutMs`,
`wakeMinIntervalMs`, `maxWakesPerScript`, `memoryMaxBytes`), so `{ "enabled": true }` is the
whole setting. It is off unless the recipe turns it on: the host's built-in default recipe
leaves it off, so an agent started with no recipe has none. Turning it on for a running
resident adds one tool, so its first turn after the restart is one full cache write.

## Going live

1. **The service.** The person runs `connectome service install '<name>.json'` themselves, in their second terminal ("Working with the person"). Tell them why it's theirs: it's the step that changes their machine, and its output then reaches them whole. On Linux it refuses, writing nothing but its lock file, while linger is off for this user, and nothing gets past that: a service would stop whenever they log out. So when it's off, the line setup showed has to be run as root first, by the person or by whoever administers the machine. Never tell them they can skip it. If nobody can run it yet, the resident can't go live yet, and on a rerun over a service already installed, the refusal stops nothing and leaves that service as it was: write `SETUP.md` with that line and the steps after it, tell them so plainly, and don't call `setup--finished`: going live is still to set up. They leave with `/quit`, and setup run again once linger is on picks up where it stopped. `service install` loads the recipe with the host's own loader first and refuses, writing nothing but its lock file, when that fails. Then it writes and starts the resident's service (a systemd user unit on Linux, a launch agent on macOS), with the shell's daemon beside it when the resident has one, waits for the host to answer, and checks the service. Ask them to paste you any warning or refusal it prints. When it refuses, its words say what to put right; put it right with them, and they run it again. When the resident has a shell and it says the shell's daemon failed, the resident isn't live yet, whatever the host does: read the daemon's log, put the cause right with them, and have them run it again before you go on. The daemon's log is `journalctl --user -u` with the shell's unit, which install's output names, on Linux, and `<dir>/logs/shell.log` on macOS.
2. **The doctor.** `connectome doctor`, read with the person. It checks the service, that the host answers, that the recipe loads and fits the model's window, the token counts the provider gives, the shell's real call, that each stored secret other than a provider's credentials or base URL reaches a server or is named in the recipe outside its servers, and Discord ("Discord"), then, where the service is a systemd user unit and `python3` is on the PATH, shows where an incoming message got to. Put right what it flags. After a change to the recipe or `.env`, the person runs `connectome service install` again, which restarts the host so that it reads them, and you run `connectome doctor` again.
3. **The person's hello.** Ask them to say hello to the resident with an @mention of the bot in its channel, or in a DM, and to tell you whether it answered: a plain message in a channel reaches it only once it has opened that channel, which it does by speaking there ("Discord"). If they made the channel for it, suggest they say so in their hello, in their own words. That's the resident's first message, and it comes from them, so don't send it one of your own, and don't write theirs. If nothing came, or the reply went somewhere else, run `connectome doctor` again: on Linux, with `python3` on the PATH, its last part shows where an incoming message got to; without `python3`, it says so. Read any log beyond that by its shapes, never its text ("Gotchas").

**Never start the resident from `setup--run`,** with `start.js` or the host's entry: a process you leave running keeps running after your conversation ends, and beside the service it makes two hosts on one data directory, which breaks the store. The service is the one way the resident runs. The person can run it by hand later, as `SETUP.md` says, and the host refuses that while the service holds the install.

## SETUP.md

Once the service is installed and `connectome doctor` has run, before the person's hello, write `<dir>/SETUP.md` for them through `setup--run`, in plain words, with names and never values. Show it to them first, and write it once they say yes, and show any later change to it the same way. Write each command with the install's command spelled as your prompt spells it. It says:
- **Where the resident lives:** `<dir>`, its recipe's path, its data directory, and which user it runs as.
- **Its secrets,** each by name, all in `<dir>/.env`, readable by that user alone. To change one, edit `.env`, then run `connectome service install` again.
- **Changing it:** after any change to the recipe or `.env`, run `connectome service install` again, then `connectome doctor`. Where it can be reached and who may DM it are in the filters file in `data/`, which discord-mcpl rereads within seconds of an edit ("Discord"). The server, channel and DM ids in the recipe were only where it started: discord-mcpl copied them into that file on its first start and goes by the file alone after, so changing them in the recipe does nothing.
- **Reaching it:** on Discord, by a DM, or in its channel (name it, and say so if it was made for the resident). In the channel, the first time, @mention the bot, not just its name typed: the channel opens to it when it first speaks there. After it has answered there, plain messages reach it too, though after a burst of traffic it can stop hearing them until it next speaks there, which `connectome doctor` then shows, with how to reopen the channel, and an @mention or a reply to one of its messages always reaches it. From a terminal, `connectome send <text>` prints its reply.
- **Changing its model:** set `agent.model` in the recipe to the new model's id, then run `connectome service install` again, then `connectome doctor`. Its memory stays, and the new model reads it. Nothing tells the resident what it now runs on, so tell it yourself if you'd like it to know. A model from another provider also needs that provider's `agent.provider` value in the recipe and its key in `.env`, as `<host>/README.md`'s "Other providers" says.
- **Its updates:** `connectome update` says whether a newer release is out and what it costs; `connectome help` describes the other words `connectome update` takes, such as `connectome update install`, `connectome update restart` and `connectome update back`. Whether the resident may update itself, as decided.
- **Its logs, stopping and starting it:** `connectome service stop` stops it, and `connectome service start` starts it again. `connectome`, alone, says which install and release this is, whether its host is running, and gives the line that follows its log.
- **What it writes:** files it writes with its workspace tools are kept in its memory store first, and reach `<dir>/output` when it writes them out to disk, so if one they want isn't there, they ask it to. With a shell, it can also write a file anywhere its user can, and that file is on disk at once.
- **Its memory isn't backed up.** Nothing copies the data directory on a schedule. Each update copies it once, just before it switches release, into `<dir>/connectome-host/copy`, kept until the next switch. To take a copy by hand, run `connectome service stop`, copy `<dir>/data`, `.env` and the recipe whole, then run `connectome service start`; a copy taken while the host runs can tear. Keep the copy off this machine, since one on its disk is lost with it.
- **Running it by hand:** `cd '<dir>' && bun connectome-host/start.js '<name>.json'`, with the terminal interface. It runs from `<dir>`, since the host takes its data directory, `./data`, and its `.env` from where it starts; for a data directory the install's record names elsewhere, put `DATA_DIR='<that directory>'` before `bun`. The host refuses it while the service holds the install, so run `connectome service stop` first, and `connectome service start` after. `service stop` stops the shell's daemon too, so a resident with a shell, run by hand, has no working shell until `connectome service start`.
- **Its shell,** if it has one: the resident can read and change whatever its user can, and whoever talks to it on Discord can ask it to. The shell's daemon has a token in `.env`; to change it, take `SESSION_SERVER_TOKEN`'s line out of `.env` and run `connectome service install` again, which makes a new one. Run that from a terminal outside the resident's service, such as over ssh: run from inside it, it would stop itself partway, so it refuses, and a resident that needs it asks whoever runs the machine.
- **What was decided, and by whom:** the name, the model, the system prompt, any history imported and which voice is the resident, the server, channels, DMs and admins, its time zone, whether it wakes on its own, both grants with the person's answer, the user it runs as, and anything you decided yourself.

After the hello, tell the person plainly that you aren't the resident, that the resident is the one who answers them on Discord, and ask whether there's anything more they'd like to set up. Once they have nothing more, call `setup--finished` in the turn where you say goodbye: the conversation ends after that turn, once anything they typed meanwhile has come to you as further turns, and setup then tells them how to change something later. If setup starts again after that, your opening says so: they've come back for something, so check where things stand, tell them what you see, and ask what they'd like to change.

## Gateways and other providers

**A gateway.** When the resident's model is served only through a gateway (a model gone from Anthropic's API that a gateway still serves, say), and the person names it after setup's key check:
- Ask for the gateway's base URL with `setup--ask_secret`, as `ANTHROPIC_BASE_URL`: a provider's base URL can carry a credential, so it's stored like one and kept out of your commands' environment. The API client adds `/v1/messages` to it.
- Ask for the gateway's key the same way, as `ANTHROPIC_API_KEY`, which replaces the key setup checked, for the resident. Your own conversation keeps the URL and key it started with.
- Write the model's id in the gateway's form, such as `anthropic/claude-opus-4`.
- Then go live as usual ("Going live"), or, if the service is already installed, ask the person to run `connectome service install` again so the host starts with the new `.env`. `connectome doctor`'s token counts ask the gateway's count endpoint, so they show whether the gateway answers counts, not whether it serves the resident under the id you wrote; the person's hello shows that. When doctor says the count failed or wasn't asked, `<host>/docs/DEPLOYMENTS.md`'s "Compression and token counts" says which model is counted and what to set.

Gateways can need credits or a card on the account, and some answer with brief errors as they switch upstream providers.

**Another provider.** The host's README, `<host>/README.md`, has a table of providers under "Other providers": each one's `agent.provider` value and the credentials it reads. Ask for each credential with `setup--ask_secret`, under the name the table gives, before going live ("Going live").

## Gotchas

**Compression needs a model that keeps answering.** The resident's memory folds older conversation into summaries in the background, by default with its own model and in its own voice. If that model is flaky or about to be retired, folding stalls and the context can't be kept under its budget. If the person's model is fragile, offer a stable model for compression alone (`agent.strategy.compressionModel`), and say that it's mildly identity-adjacent: the summaries are still in the resident's name, but another model writes them.

**Signed thinking may not carry over.** A transcript's signed thinking may not replay on another model: `<host>/docs/claude-code-ingest.md`'s "4.2 — Changing models" says what to do with a history imported with its signatures. The claude.ai importer brings thinking in as text, which carries none. When the person changes the resident's model later, the new model may not get its earlier reasoning, as "Changing the model" under "The recipe" says.

**Refusals.** A provider's safety classifier can end a request with a refusal, and some residents, such as ones built from dense reasoning transcripts, meet it more than others. `<host>/docs/claude-code-ingest.md` has the symptoms and the recipe-level mitigations; they apply to any resident. Never quote a suspected trigger into a channel the resident reads.

**Read shapes, never text, when you look into a failure.** In a call log, the resident's in `data/` or your own in `.setup/`, read each request's roles, block types and sizes, and each response's stop reason and stop details; for a streamed call, also `provider_events.message_start`, where a refusal's category can be the only copy. Never print any message's text into this conversation, whether the resident's, its imported history's or anyone else's: text that drew a refusal from the resident's model can draw one from yours, and a refused setup agent can't go on helping the person.

**The model's window.** For a model the host knows a window for, on Anthropic's API, it sizes the context budget to fit and refuses a recipe whose numbers can't. A gateway named by `ANTHROPIC_BASE_URL` counts as Anthropic's API here, so for a model id the host knows, it sizes for Anthropic's window, whatever the gateway's is. On any other provider, or a model it doesn't know, it can't check the fit, and doctor says so: if a reply ever fails with "prompt is too long" while compression calls still succeed, the budget is over the window, and that's the first thing to look at.

## With another harness

The rest of this guide holds, with these differences.
- There's no `setup--ask_secret`, `setup--check_model` or `setup--finished`: a model is checked by the person's hello, and when they have nothing more, say goodbye and end as your harness does; nothing records that setup finished. Have the person write each secret into `<dir>/.env` themselves, in an editor, as a line `NAME="value"`, the value between double quotes, and tell you its name once it's there. A value holding a double quote, a `$` or a backslash can't go in `.env` that way, since Bun reads it otherwise than it's typed, and nor can one holding a tab, a line break or another control character, since `connectome doctor` and `connectome service install` refuse a `.env` line with one. Nothing checks it then, so say only that it's stored until `connectome doctor` says it works. Once `<dir>/.setup/stored-secrets.json` exists, add each such name to its JSON list too: `connectome doctor` reads that list, and so do the redactors that keep those secrets out of the log lines `connectome doctor` and `connectome service` show, though not out of the logs themselves; they go by it alone once it's there. Never ask for a value in the conversation.
- Your harness may not show the person each command as `setup--run` does. If it doesn't, show each one in the conversation before you run it.
- Your shell doesn't hide secrets in its output. Never print `.env`, run `env`, or echo a variable that holds a secret; `connectome doctor` checks secrets by name.
- There's no prompt naming the paths or spelling the install's command, so write that command by its full path, `'<dir>/connectome-host/connectome'`. `<dir>` is the directory `connectome setup discord` ran in, and `<host>` is `<dir>/connectome-host/current/node_modules/@animalabs/connectome-host`. Run every command from `<dir>`, `cd '<dir>'` first, since this guide's relative paths, such as `--out data` and `.setup/`, start there.
- This guide starts where `connectome setup discord` leaves off. If it hasn't run, ask the person to run it in a terminal, in an empty directory named for the resident: it does what the opening's "What setup did before you started" says, then starts the host's own setup agent, which can do the rest with them, or which they can leave with `/quit` once it starts, to go on with you.
