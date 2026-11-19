- `docs/AGENT-ONBOARDING.md` is now the guide of the host's setup agent. It is for any agent that sets up a resident on the machine it runs on, after `connectome setup discord`. It covers:
  - the person's decisions;
  - whether the resident gets a shell, decided with the person, and on a yes installed by `connectome shell install`;
  - secrets, by `setup--ask_secret`;
  - the Discord bot and its scope, with its server, channel and person found by name with `setup--discord`;
  - importing a claude.ai history;
  - a recipe of the person's choices, with its servers defined in it, and discord-mcpl's state in the data directory;
  - the update and code-execution grants;
  - one read-back of all of it, with one yes, before the resident goes live;
  - `connectome service install`, `connectome doctor` and the person's own hello;
  - `SETUP.md`;
  - restic backups, offered after the hello and run by the resident's user.

  Each section is under 8 KiB. `setup--run`'s description says that it returns that much whole.
- The old runbook's operator material is now in `docs/DEPLOYMENTS.md`, checked against this release:
  - "A resident's memory: sizing, folding and repair". It covers the context budget against the model's window, the folding solver, the compression and token-count models, and a compile that can't fit. It also covers auditing and repairing a store with crossed summaries, refusals and signed thinking, and `/healthz`'s memory fields.
  - Moving a resident off heartbeat-mcpl, under "Operating an agent".

  Some of the runbook isn't carried over:
  - its hand-written service units, its isolated-user phase, its budget numbers for a 200k-window model, and its backup cron and watchdog;
  - its pre-compress step. `scripts/warmup-session.ts` gives the store no tool definitions, so it compresses none of a history's chunks that have tool calls in them;
  - its warning about an image's `media_type`. membrane now checks that type against the image's own bytes;
  - its advice to keep context-manager recent. The host's own dependency range sets the version that it gets;
  - `flat-profile` as a fallback. The recipe's types call it a legacy planner, and a store can't switch to it without a change to its layout.

  Its advice to keep a copy of the data off the machine is now the setup guide's offer of restic backups after the hello. The README describes Anthropic's `agent.thinking.effort`. It also describes code execution, as "Code execution (`codeExecution`)". That section is the old guide's "Code execution — turn it on for every resident", without that lead-in. `docs/DEPLOYMENTS.md` no longer suggests running `scripts/warmup-session.ts` on a stopped resident's store to make a restart's calls fewer. The script opens the store with a strategy of its own, not the one that the host builds from the recipe.
- The store audit's line for a store refused for crossed summaries now names `docs/DEPLOYMENTS.md`'s "Crossed summaries: auditing and repairing a store", with the version of the release that wrote the line. Before, it named `AGENT-ONBOARDING.md` §11.8. So after a fallback to an older release, the line still says which release's docs have the section. A release's refusal before its commit carries such lines among its own. Its closing now says to do what each line says, and to correct each failure that it names. Before, it said to repair each refused store as §11.8 says.
