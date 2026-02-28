/**
 * OpenTUI-based terminal interface.
 *
 * Layout (top to bottom):
 *   ┌─────────────────────────────┐
 *   │  ScrollBox (conversation)   │  ← flexGrow, stickyScroll
 *   │  └─ TextRenderable per msg  │
 *   ├─────────────────────────────┤
 *   │  Status bar (1 row)         │  ← [status | tool | N sub]
 *   ├─────────────────────────────┤
 *   │  InputRenderable            │  ← user input
 *   └─────────────────────────────┘
 *
 * Tab toggles between conversation and agent fleet tree view.
 * Fleet view: interactive tree with expand/collapse (↑↓ navigate, ⏎ toggle).
 */

import {
  createCliRenderer,
  type CliRenderer,
  BoxRenderable,
  TextRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  bold,
  dim,
  fg,
} from '@opentui/core';
import type { AgentFramework } from '@connectome/agent-framework';
import type { AutobiographicalStrategy } from '@connectome/context-manager';
import type { Membrane, NormalizedRequest } from 'membrane';
import type { SubagentModule, ActiveSubagent } from './modules/subagent-module.js';
import { handleCommand } from './commands.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface TuiState {
  status: string;
  tool: string | null;
  subagents: ActiveSubagent[];
  viewMode: 'chat' | 'fleet';
  tokens: TokenUsage;
}

// ---------------------------------------------------------------------------
// Fleet tree types
// ---------------------------------------------------------------------------

interface FleetNode {
  /** Short display name */
  name: string;
  /** Full agent name (for lookups in transcript/token maps) */
  fullName: string;
  /** Whether this is the root researcher node */
  isResearcher: boolean;
  /** ActiveSubagent data (undefined for researcher) */
  agent?: ActiveSubagent;
  /** Child nodes */
  children: FleetNode[];
}

// ---------------------------------------------------------------------------
// Colours (hex strings for OpenTUI)
// ---------------------------------------------------------------------------

const GREEN = '#00cc00';
const YELLOW = '#cccc00';
const CYAN = '#00cccc';
const MAGENTA = '#cc00cc';
const RED = '#cc0000';
const GRAY = '#888888';
const DIM_GRAY = '#555555';
const WHITE = '#cccccc';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runTui(framework: AgentFramework, membrane: Membrane): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });

  // Set terminal title
  process.stdout.write('\x1b]0;Zulip Knowledge Miner\x07');

  const state: TuiState = {
    status: 'idle',
    tool: null,
    subagents: [],
    viewMode: 'chat',
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };

  let streaming = false;
  let currentStreamText: TextRenderable | null = null;
  let currentStreamBuffer = '';

  // ── Layout ────────────────────────────────────────────────────────────

  const rootBox = new BoxRenderable(renderer, {
    id: 'root',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
  });

  const scrollBox = new ScrollBoxRenderable(renderer, {
    id: 'conversation',
    flexGrow: 1,
    stickyScroll: true,
  });

  const fleetText = new TextRenderable(renderer, {
    id: 'fleet-text',
    content: '',
    fg: GRAY,
  });
  const fleetBox = new BoxRenderable(renderer, {
    id: 'fleet',
    flexGrow: 1,
    flexDirection: 'column',
    paddingLeft: 1,
    paddingTop: 1,
  });
  fleetBox.add(fleetText);

  const statusLeft = new TextRenderable(renderer, {
    id: 'status-left',
    content: formatStatusLeft(state),
    fg: GRAY,
  });

  const statusRight = new TextRenderable(renderer, {
    id: 'status-right',
    content: formatTokens(state.tokens),
    fg: DIM_GRAY,
  });

  const statusBox = new BoxRenderable(renderer, {
    id: 'status-box',
    height: 1,
    paddingLeft: 1,
    paddingRight: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
  });

  const input = new InputRenderable(renderer, {
    id: 'input',
    placeholder: 'Type a message or /help...',
  });

  const inputBox = new BoxRenderable(renderer, {
    id: 'input-box',
    height: 1,
    paddingLeft: 1,
  });

  // Assembly — both views always present; fleet starts hidden
  statusBox.add(statusLeft);
  statusBox.add(statusRight);
  inputBox.add(input);
  rootBox.add(scrollBox);
  rootBox.add(fleetBox);
  fleetBox.visible = false;
  rootBox.add(statusBox);
  rootBox.add(inputBox);
  renderer.root.add(rootBox);

  input.focus();

  // ── Agent observability maps ──────────────────────────────────────

  /** Accumulated transcript per agent (text output + tool calls). */
  const agentTranscripts = new Map<string, string>();

  /** Parent tracking: child short name → parent full agent name. */
  const agentParent = new Map<string, string>();

  /** Last known input token count per agent (= context window size). */
  const agentContextTokens = new Map<string, number>();

  /** Synesthete summary per agent, keyed by full agent name. */
  const summaryCache = new Map<string, string>();
  const summarySnapshotLen = new Map<string, number>();
  const summaryPending = new Set<string>();

  const SUMMARY_DELTA = 2000;
  const SUMMARY_WINDOW = 10_000;

  function appendTranscript(agent: string, text: string) {
    const prev = agentTranscripts.get(agent) ?? '';
    agentTranscripts.set(agent, prev + text);
  }

  async function generateSummary(agentName: string) {
    if (summaryPending.has(agentName)) return;
    const transcript = agentTranscripts.get(agentName);
    if (!transcript || transcript.length < 50) return;

    const lastLen = summarySnapshotLen.get(agentName) ?? 0;
    if (transcript.length - lastLen < SUMMARY_DELTA && summaryCache.has(agentName)) return;

    summaryPending.add(agentName);
    try {
      const window = transcript.slice(-SUMMARY_WINDOW);
      const request: NormalizedRequest = {
        messages: [{
          participant: 'user',
          content: [{ type: 'text', text: `Agent activity stream:\n\n${window}\n\nWhat is this agent doing right now? Answer in 5-10 words.` }],
        }],
        system: 'You distill an agent\'s activity into a terse status phrase. 5-10 words max. No punctuation. Specific, not generic.',
        config: { model: 'claude-haiku-4-5-20251001', maxTokens: 40, temperature: 0.3 },
      };
      const response = await membrane.complete(request);
      const text = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text).join('').trim();
      summaryCache.set(agentName, text.length > 60 ? text.slice(0, 57) + '...' : text);
      summarySnapshotLen.set(agentName, transcript.length);
      if (state.viewMode === 'fleet') updateFleetView();
    } catch {
      // best-effort
    } finally {
      summaryPending.delete(agentName);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  let messageCounter = 0;

  function addLine(text: string, color: string = WHITE) {
    scrollBox.add(new TextRenderable(renderer, {
      id: `msg-${++messageCounter}`,
      content: text,
      fg: color,
    }));
  }

  function updateStatus() {
    statusLeft.content = formatStatusLeft(state);
    statusRight.content = formatTokens(state.tokens);
  }

  function beginStream() {
    currentStreamBuffer = '';
    currentStreamText = new TextRenderable(renderer, {
      id: `stream-${++messageCounter}`,
      content: '',
      fg: WHITE,
    });
    scrollBox.add(currentStreamText);
    streaming = true;
  }

  function streamToken(text: string) {
    if (currentStreamText) {
      currentStreamBuffer += text;
      currentStreamText.content = currentStreamBuffer;
    }
  }

  function endStream() {
    streaming = false;
    currentStreamText = null;
    currentStreamBuffer = '';
  }

  const fmtK = (n: number) => {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return String(n);
  };

  // ── Fleet tree view ────────────────────────────────────────────────

  const expandedNodes = new Set<string>(['researcher']);
  let fleetCursor = 0;
  /** Ordered list of node IDs in current rendering (for cursor navigation). */
  let visibleNodeIds: string[] = [];

  function buildFleetTree(): FleetNode {
    const root: FleetNode = {
      name: 'researcher',
      fullName: 'researcher',
      isResearcher: true,
      children: [],
    };

    // Index subagents by short name for tree building
    const byName = new Map<string, FleetNode>();
    for (const sa of state.subagents) {
      const fullName = [...(subMod?.activeSubagents.keys() ?? [])].find(k => k.includes(sa.name)) ?? sa.name;
      const node: FleetNode = {
        name: sa.name,
        fullName,
        isResearcher: false,
        agent: sa,
        children: [],
      };
      byName.set(sa.name, node);
    }

    // Build parent-child links
    for (const sa of state.subagents) {
      const parentFullName = agentParent.get(sa.name);
      if (parentFullName && parentFullName !== 'researcher') {
        // Find the parent's short name
        const parentShort = [...byName.keys()].find(k => parentFullName.includes(k));
        if (parentShort && byName.has(parentShort)) {
          byName.get(parentShort)!.children.push(byName.get(sa.name)!);
          continue;
        }
      }
      // Default: child of researcher
      root.children.push(byName.get(sa.name)!);
    }

    return root;
  }

  function renderNode(node: FleetNode, depth: number, lines: string[]): void {
    const indent = '  '.repeat(depth);
    const isExpanded = expandedNodes.has(node.name);
    const hasChildren = node.children.length > 0;

    // Status tag
    let statusTag: string;
    if (node.isResearcher) {
      statusTag = state.status === 'idle' ? '✓ idle'
        : state.status === 'error' ? '✗ error'
        : `… ${state.status}`;
    } else {
      const sa = node.agent!;
      const elapsed = Math.floor((Date.now() - sa.startedAt) / 1000);
      statusTag = sa.status === 'running' ? `running ${elapsed}s`
        : sa.status === 'completed' ? `done ${elapsed}s` : 'failed';
    }

    // Context size
    const ctxTokens = agentContextTokens.get(node.fullName);
    const ctxStr = ctxTokens ? ` ${fmtK(ctxTokens)}ctx` : '';

    // Compression stats (researcher only — we can access the strategy)
    let compStr = '';
    if (node.isResearcher) {
      try {
        const agent = framework.getAgent('researcher');
        const cm = agent?.getContextManager();
        const strategy = (cm as any)?.strategy as AutobiographicalStrategy | undefined;
        if (strategy?.getStats) {
          const stats = strategy.getStats();
          if (stats.compressionCount > 0) {
            compStr = ` ${stats.compressionCount}comp`;
          }
        }
      } catch { /* best-effort */ }
    }

    // Fold marker
    const marker = hasChildren ? (isExpanded ? '▼' : '►') : '─';

    // Header line (this is a navigable node)
    const isCursor = visibleNodeIds.length === fleetCursor;
    const cursor = isCursor ? '→' : ' ';
    visibleNodeIds.push(node.name);
    lines.push(`${cursor} ${indent}${marker} ${node.name}  [${statusTag}]${ctxStr}${compStr}`);

    if (!isExpanded) return;

    // Detail lines (indented further)
    const detail = indent + '    ';

    if (node.isResearcher && state.tool) {
      lines.push(`  ${detail}tool: ${state.tool}`);
    }
    if (!node.isResearcher && node.agent) {
      const sa = node.agent;
      // Truncate task to 60 chars
      const task = sa.task.length > 60 ? sa.task.slice(0, 57) + '...' : sa.task;
      lines.push(`  ${detail}task: ${task}`);
      if (sa.statusMessage) {
        lines.push(`  ${detail}tool: ${sa.statusMessage} (${sa.toolCallsCount} calls)`);
      }
    }

    // Synesthete summary
    const fullName = node.isResearcher ? 'researcher'
      : [...agentTranscripts.keys()].find(k => k.includes(node.name));
    if (fullName) {
      const summary = summaryCache.get(fullName);
      if (summary) {
        lines.push(`  ${detail}┈ ${summary}`);
      } else if (summaryPending.has(fullName)) {
        lines.push(`  ${detail}┈ …`);
      }
      generateSummary(fullName);
    }

    // Recurse into children
    for (const child of node.children) {
      renderNode(child, depth + 1, lines);
    }
  }

  function updateFleetView() {
    const tree = buildFleetTree();
    visibleNodeIds = [];

    const lines: string[] = [];
    lines.push('─── Agent Fleet ─────────────── ↑↓:nav ⏎:fold ───');
    lines.push('');

    renderNode(tree, 0, lines);

    // Clamp cursor
    if (fleetCursor >= visibleNodeIds.length) fleetCursor = visibleNodeIds.length - 1;
    if (fleetCursor < 0) fleetCursor = 0;

    lines.push('');
    lines.push('                                    Tab: chat');

    fleetText.content = lines.join('\n');
  }

  function switchView(mode: 'chat' | 'fleet') {
    state.viewMode = mode;
    scrollBox.visible = mode === 'chat';
    fleetBox.visible = mode === 'fleet';
    if (mode === 'fleet') {
      input.blur();
      updateFleetView();
    } else {
      input.focus();
    }
  }

  // ── Trace listener ──────────────────────────────────────────────────

  function onTrace(event: Record<string, unknown>) {
    const agent = event.agentName as string | undefined;

    switch (event.type) {
      case 'inference:started': {
        if (agent === 'researcher') {
          state.status = 'thinking';
          beginStream();
          updateStatus();
        }
        break;
      }

      case 'inference:tokens': {
        const content = event.content as string;
        if (content) {
          if (agent === 'researcher' && streaming) {
            streamToken(content);
          }
          if (agent) appendTranscript(agent, content);
        }
        break;
      }

      case 'inference:completed': {
        const usage = event.tokenUsage as { input?: number; output?: number; cacheRead?: number; cacheCreation?: number } | undefined;
        if (usage) {
          state.tokens.input += usage.input ?? 0;
          state.tokens.output += usage.output ?? 0;
          state.tokens.cacheRead += usage.cacheRead ?? 0;
          state.tokens.cacheWrite += usage.cacheCreation ?? 0;
          // Track context size per agent
          if (agent && usage.input) {
            agentContextTokens.set(agent, usage.input);
          }
        }

        if (agent === 'researcher') {
          state.status = 'idle';
          state.tool = null;
          if (streaming) endStream();
        }
        updateStatus();
        break;
      }

      case 'inference:failed': {
        if (agent === 'researcher') {
          state.status = 'error';
          if (streaming) endStream();
          addLine(`Error: ${event.error}`, RED);
          updateStatus();
        } else {
          addLine(`[${agent}] Error: ${event.error}`, DIM_GRAY);
        }
        break;
      }

      case 'inference:tool_calls_yielded': {
        const calls = event.calls as Array<{ name: string; input?: unknown }>;
        const names = calls.map(c => c.name).join(', ');

        if (agent) {
          const toolSnippet = calls.map(c => {
            const inp = c.input ? JSON.stringify(c.input) : '';
            return `[tool: ${c.name}${inp ? ' ' + inp.slice(0, 200) : ''}]`;
          }).join('\n');
          appendTranscript(agent, '\n' + toolSnippet + '\n');

          // Track parent-child for fleet tree
          for (const call of calls) {
            if (call.name === 'subagent:spawn' || call.name === 'subagent:fork') {
              const childName = (call.input as Record<string, unknown>)?.name as string | undefined;
              if (childName) {
                agentParent.set(childName, agent);
              }
            }
          }
        }

        if (agent === 'researcher') {
          state.status = 'tools';
          state.tool = names;
          if (streaming) endStream();
          addLine(`[tools] ${names}`, YELLOW);
        } else {
          const short = (agent ?? '').replace(/^(spawn|fork)-/, '').replace(/-\d+$/, '');
          addLine(`  [${short}] ${names}`, DIM_GRAY);
          const sa = state.subagents.find(s => (agent ?? '').includes(s.name));
          if (sa) {
            sa.toolCallsCount += calls.length;
            sa.statusMessage = names.split(':').pop();
          }
        }
        updateStatus();
        break;
      }

      case 'inference:stream_resumed': {
        if (agent === 'researcher') {
          state.status = 'thinking';
          state.tool = null;
          beginStream();
          updateStatus();
        }
        break;
      }

      case 'tool:started': {
        if (agent === 'researcher') {
          state.tool = event.tool as string;
          updateStatus();
        }
        break;
      }
    }
  }

  // ── Subagent polling ────────────────────────────────────────────────

  const subMod = framework.getAllModules().find(m => m.name === 'subagent') as SubagentModule | undefined;
  const pollTimer = setInterval(() => {
    if (subMod) {
      state.subagents = [...subMod.activeSubagents.values()];
      updateStatus();
      if (state.viewMode === 'fleet') updateFleetView();
    }
  }, 500);

  // ── Keyboard ───────────────────────────────────────────────────────

  renderer.keyInput.on('keypress', (key: { name?: string; ctrl?: boolean }) => {
    if (key.name === 'tab') {
      switchView(state.viewMode === 'chat' ? 'fleet' : 'chat');
      updateStatus();
      return;
    }
    if (key.ctrl && key.name === 'c') {
      cleanup();
      return;
    }

    // Fleet view navigation
    if (state.viewMode === 'fleet') {
      if (key.name === 'up') {
        fleetCursor = Math.max(0, fleetCursor - 1);
        updateFleetView();
      } else if (key.name === 'down') {
        fleetCursor = Math.min(visibleNodeIds.length - 1, fleetCursor + 1);
        updateFleetView();
      } else if (key.name === 'return' || key.name === 'right') {
        const nodeId = visibleNodeIds[fleetCursor];
        if (nodeId) {
          if (expandedNodes.has(nodeId)) expandedNodes.delete(nodeId);
          else expandedNodes.add(nodeId);
          updateFleetView();
        }
      } else if (key.name === 'left') {
        const nodeId = visibleNodeIds[fleetCursor];
        if (nodeId) {
          expandedNodes.delete(nodeId);
          updateFleetView();
        }
      }
    }
  });

  // ── Input handling ─────────────────────────────────────────────────

  let resolveExit: (() => void) | null = null;

  input.on(InputRenderableEvents.ENTER, () => {
    const text = input.value.trim();
    input.deleteLine();

    if (!text) return;

    if (text.startsWith('/')) {
      const result = handleCommand(text, framework);
      if (result.quit) {
        cleanup();
        return;
      }
      if (text === '/clear') {
        const children = [...scrollBox.getChildren()];
        for (const child of children) {
          scrollBox.remove(child.id);
        }
      } else {
        for (const l of result.lines) {
          addLine(l.text, GRAY);
        }
      }
    } else {
      addLine(`You: ${text}`, GREEN);
      framework.pushEvent({
        type: 'external-message', source: 'tui',
        content: text, metadata: {}, triggerInference: true,
      });
    }
  });

  // ── Init ───────────────────────────────────────────────────────────

  addLine('Zulip Knowledge App. Type /help for commands.', GRAY);
  framework.onTrace(onTrace as (e: unknown) => void);

  // ── Cleanup ────────────────────────────────────────────────────────

  function cleanup() {
    clearInterval(pollTimer);
    framework.offTrace(onTrace as (e: unknown) => void);
    renderer.destroy();
    process.stdout.write('\x1b]0;\x07');
    framework.stop().then(() => {
      resolveExit?.();
    });
  }

  // ── Wait for exit ──────────────────────────────────────────────────

  await new Promise<void>(resolve => {
    resolveExit = resolve;
  });
}

// ---------------------------------------------------------------------------
// Status bar formatter
// ---------------------------------------------------------------------------

function formatStatusLeft(state: TuiState): string {
  const sColor = state.status === 'idle' ? '✓' : state.status === 'error' ? '✗' : '…';
  let bar = `[${sColor} ${state.status}`;
  if (state.tool) bar += ` | ${state.tool}`;
  const running = state.subagents.filter(s => s.status === 'running').length;
  if (running > 0) {
    bar += ` | ${running} sub`;
  }
  if (state.viewMode === 'fleet') {
    bar += ' | fleet view';
  } else if (running > 0) {
    bar += ' Tab:fleet';
  }
  bar += ']';
  return bar;
}

function formatTokens(tokens: TokenUsage): string {
  const total = tokens.input + tokens.output;
  if (total === 0) return '';

  const fmt = (n: number) => {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return String(n);
  };

  let s = `${fmt(tokens.input)}in ${fmt(tokens.output)}out`;
  if (tokens.cacheRead > 0) s += ` ${fmt(tokens.cacheRead)}cache`;
  return s;
}
