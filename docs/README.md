# Documentation

A map of the guides, by who they are for. The top-level
[README](../README.md) says what connectome-host is and how to run it;
[ARCHITECTURE.md](../ARCHITECTURE.md) says how it is built.

## Standing up and running agents

| Guide | For |
|---|---|
| [AGENT-ONBOARDING.md](./AGENT-ONBOARDING.md) | Deploying a new resident end to end — interview, host user, install dir, recipe, history import, Discord, services, launch checks. Written as a runbook for an assisting Claude instance. |
| [DEPLOYMENTS.md](./DEPLOYMENTS.md) | Day-to-day operations: supervision, logs, wake gating, known gaps. |
| [DEV-ENVIRONMENT.md](./DEV-ENVIRONMENT.md) | Working on the libraries themselves: sibling checkouts wired to one shared instance of each. |
| [webui-deployment.md](./webui-deployment.md) | Serving the web console behind a proxy; auth and observers. |
| [webui-live-surgery.md](./webui-live-surgery.md) | Rolling back, suppressing messages, quiescing — from the web console. |
| [debug-context-api.md](./debug-context-api.md) | Seeing exactly what the agent's next request would contain. |
| [retrieval-traces.md](./retrieval-traces.md) | Why a lesson was (or wasn't) injected. |
| [subscription-transport.md](./subscription-transport.md) | How the ChatGPT-subscription transport authenticates and refreshes. |
| [fleet-protocol.md](./fleet-protocol.md) | Headless mode, its socket protocol, and the fleet module. |

## Bringing an agent in from elsewhere

| Guide | For |
|---|---|
| [claudeai-evacuation.md](./claudeai-evacuation.md) | Continuing a claude.ai conversation (thinking signatures not recoverable). |
| [claude-code-ingest.md](./claude-code-ingest.md) | Continuing a Claude Code session verbatim, signed thinking included. |

Codex rollouts are imported with `scripts/import-codex-rollout.ts`.

## For the agents themselves

Written to be read by residents about their own mechanics — honest rather
than reassuring. Point an agent at them, or mount them in its workspace.

| Guide | About |
|---|---|
| [AGENT-MEMORY-GUIDE.md](./AGENT-MEMORY-GUIDE.md) | How autobiographical memory works from the inside. |
| [ATTENTION-AND-GATING.md](./ATTENTION-AND-GATING.md) | What wakes you, and how to change it. |

## Recipe guides

| Guide | For |
|---|---|
| [../recipes/SETUP.md](../recipes/SETUP.md) | The knowledge-miner recipe on its own. |
| [../recipes/TRIUMVIRATE-SETUP.md](../recipes/TRIUMVIRATE-SETUP.md) | Miner, reviewer and clerk as one fleet under a conductor. |
| [LIBRARY-PIPELINE.md](./LIBRARY-PIPELINE.md) | How those three agents hand work to each other through files. |

## Contributing

[CONTRIBUTING.md](../CONTRIBUTING.md) — how changes land, review, AI
attribution, changelog fragments in [`changelog.d/`](../changelog.d/). The
[CHANGELOG](../CHANGELOG.md) is the most complete record of what changed and
why.

## History

[history/](./history/README.md) — the original architecture document and the
plans the headless, fleet and locus-routing work were built from, kept
verbatim, with notes on what became of each.
