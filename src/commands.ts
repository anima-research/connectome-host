/**
 * Slash command handler for Chronicle-backed reversibility.
 *
 * Commands:
 *   /undo          — Revert to state before last agent turn
 *   /redo          — Re-apply last undone action
 *   /checkpoint N  — Save current state as named checkpoint
 *   /restore N     — Branch from checkpoint, switch to it
 *   /branches      — List all Chronicle branches
 *   /checkout N    — Switch to named branch
 *   /history       — Show recent state transitions
 *   /lessons       — Show current lesson library
 *   /status        — Show agent/module status
 *   /clear         — Clear conversation display
 *   /help          — List commands
 */

import type { AgentFramework } from '@connectome/agent-framework';
import type { ContextManager } from '@connectome/context-manager';
import type { Line } from './tui/app.js';

// Undo/redo stacks: track (branchId, messageId) pairs for time-travel
interface StatePoint {
  branchId: string;
  branchName: string;
  messageId?: string;
}

const undoStack: StatePoint[] = [];
const redoStack: StatePoint[] = [];

// Named checkpoints: name → StatePoint
const checkpoints = new Map<string, StatePoint>();

export interface CommandResult {
  lines: Line[];
  quit?: boolean;
}

/**
 * Get the context manager for the main agent.
 */
function getAgentCM(framework: AgentFramework, agentName = 'researcher'): ContextManager | null {
  const agent = framework.getAgent(agentName);
  return agent?.getContextManager() ?? null;
}

export function handleCommand(command: string, framework: AgentFramework): CommandResult {
  const parts = command.slice(1).split(/\s+/);
  const cmd = parts[0]!;
  const args = parts.slice(1);

  switch (cmd) {
    case 'quit':
    case 'q':
      return { lines: [], quit: true };

    case 'help':
      return {
        lines: [
          { text: '--- Commands ---', style: 'system' },
          { text: '  /quit, /q              Exit the app', style: 'system' },
          { text: '  /status                Show agent status', style: 'system' },
          { text: '  /clear                 Clear conversation', style: 'system' },
          { text: '  /lessons               Show lesson library', style: 'system' },
          { text: '  /undo                  Revert last agent turn', style: 'system' },
          { text: '  /redo                  Re-apply undone action', style: 'system' },
          { text: '  /checkpoint <name>     Save current state', style: 'system' },
          { text: '  /restore <name>        Restore to checkpoint', style: 'system' },
          { text: '  /branches              List Chronicle branches', style: 'system' },
          { text: '  /checkout <name>       Switch to branch', style: 'system' },
          { text: '  /history               Show state transitions', style: 'system' },
        ],
      };

    case 'clear':
      return { lines: [{ text: '(cleared)', style: 'system' }] };

    case 'status':
      return handleStatus(framework);

    case 'lessons':
      return handleLessons(framework);

    case 'undo':
      return handleUndo(framework);

    case 'redo':
      return handleRedo(framework);

    case 'checkpoint':
      return handleCheckpoint(framework, args[0]);

    case 'restore':
      return handleRestore(framework, args[0]);

    case 'branches':
      return handleBranches(framework);

    case 'checkout':
      return handleCheckout(framework, args[0]);

    case 'history':
      return handleHistory(framework);

    default:
      return {
        lines: [{ text: `Unknown command: /${cmd}. Type /help.`, style: 'system' }],
      };
  }
}

function handleStatus(framework: AgentFramework): CommandResult {
  const agents = framework.getAllAgents();
  const lines: Line[] = [{ text: '--- Status ---', style: 'system' }];

  for (const agent of agents) {
    lines.push({ text: `  ${agent.name}: ${agent.state.status} (${agent.model})`, style: 'system' });
  }

  const cm = getAgentCM(framework);
  if (cm) {
    const branch = cm.currentBranch();
    lines.push({ text: `  Branch: ${branch.name} (head: ${branch.head})`, style: 'system' });
  }

  lines.push({ text: `  Queue depth: ${framework.getQueueDepth()}`, style: 'system' });

  return { lines };
}

function handleLessons(framework: AgentFramework): CommandResult {
  const modules = framework.getAllModules();
  const lessonsModule = modules.find(m => m.name === 'lessons') as
    { getLessons(): Array<{ id: string; content: string; confidence: number; tags: string[]; deprecated: boolean }> } | undefined;

  if (!lessonsModule) {
    return { lines: [{ text: 'Lessons module not loaded.', style: 'system' }] };
  }

  const lessons = lessonsModule.getLessons();
  const active = lessons.filter(l => !l.deprecated);

  if (active.length === 0) {
    return { lines: [{ text: 'No lessons yet. The agent will create them during analysis.', style: 'system' }] };
  }

  const lines: Line[] = [{ text: `--- Lessons (${active.length}) ---`, style: 'system' }];
  for (const l of active.sort((a, b) => b.confidence - a.confidence)) {
    const conf = (l.confidence * 100).toFixed(0);
    lines.push({
      text: `  [${conf}%] ${l.id}: ${l.content.slice(0, 80)}${l.content.length > 80 ? '...' : ''} (${l.tags.join(', ')})`,
      style: 'system',
    });
  }

  return { lines };
}

function handleUndo(framework: AgentFramework): CommandResult {
  const cm = getAgentCM(framework);
  if (!cm) return { lines: [{ text: 'No agent context manager.', style: 'system' }] };

  const { messages } = cm.queryMessages({});
  if (messages.length === 0) {
    return { lines: [{ text: 'Nothing to undo.', style: 'system' }] };
  }

  // Find the last agent message (working backwards)
  let undoPoint: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.participant !== 'user') {
      // Found an agent message — undo to the message before it
      undoPoint = i > 0 ? messages[i - 1]!.id : undefined;
      break;
    }
  }

  if (!undoPoint) {
    return { lines: [{ text: 'Nothing to undo (no agent messages found).', style: 'system' }] };
  }

  try {
    // Save current state for redo
    const currentBranch = cm.currentBranch();
    redoStack.push({
      branchId: currentBranch.id,
      branchName: currentBranch.name,
    });

    // Create a new branch from the undo point
    const newBranchId = cm.branchAt(undoPoint, `undo-${Date.now()}`);
    cm.switchBranch(newBranchId);

    undoStack.push({
      branchId: newBranchId,
      branchName: `undo-${Date.now()}`,
      messageId: undoPoint,
    });

    return { lines: [{ text: `Undone. Switched to branch ${newBranchId}.`, style: 'system' }] };
  } catch (err) {
    return { lines: [{ text: `Undo failed: ${err}`, style: 'system' }] };
  }
}

function handleRedo(framework: AgentFramework): CommandResult {
  const cm = getAgentCM(framework);
  if (!cm) return { lines: [{ text: 'No agent context manager.', style: 'system' }] };

  if (redoStack.length === 0) {
    return { lines: [{ text: 'Nothing to redo.', style: 'system' }] };
  }

  const point = redoStack.pop()!;
  try {
    cm.switchBranch(point.branchId);
    return { lines: [{ text: `Redone. Switched to branch ${point.branchName}.`, style: 'system' }] };
  } catch (err) {
    return { lines: [{ text: `Redo failed: ${err}`, style: 'system' }] };
  }
}

function handleCheckpoint(framework: AgentFramework, name?: string): CommandResult {
  if (!name) {
    return { lines: [{ text: 'Usage: /checkpoint <name>', style: 'system' }] };
  }

  const cm = getAgentCM(framework);
  if (!cm) return { lines: [{ text: 'No agent context manager.', style: 'system' }] };

  const branch = cm.currentBranch();
  checkpoints.set(name, {
    branchId: branch.id,
    branchName: branch.name,
  });

  return { lines: [{ text: `Checkpoint "${name}" saved at branch ${branch.name} (head: ${branch.head}).`, style: 'system' }] };
}

function handleRestore(framework: AgentFramework, name?: string): CommandResult {
  if (!name) {
    const names = [...checkpoints.keys()];
    if (names.length === 0) {
      return { lines: [{ text: 'No checkpoints saved. Use /checkpoint <name> to create one.', style: 'system' }] };
    }
    return {
      lines: [
        { text: 'Available checkpoints:', style: 'system' },
        ...names.map(n => ({ text: `  ${n}`, style: 'system' as const })),
      ],
    };
  }

  const point = checkpoints.get(name);
  if (!point) {
    return { lines: [{ text: `Checkpoint "${name}" not found.`, style: 'system' }] };
  }

  const cm = getAgentCM(framework);
  if (!cm) return { lines: [{ text: 'No agent context manager.', style: 'system' }] };

  try {
    cm.switchBranch(point.branchId);
    return { lines: [{ text: `Restored to checkpoint "${name}" (branch: ${point.branchName}).`, style: 'system' }] };
  } catch (err) {
    return { lines: [{ text: `Restore failed: ${err}`, style: 'system' }] };
  }
}

function handleBranches(framework: AgentFramework): CommandResult {
  const cm = getAgentCM(framework);
  if (!cm) return { lines: [{ text: 'No agent context manager.', style: 'system' }] };

  const branches = cm.listBranches();
  const current = cm.currentBranch();

  const lines: Line[] = [{ text: `--- Branches (${branches.length}) ---`, style: 'system' }];
  for (const b of branches) {
    const marker = b.id === current.id ? ' *' : '';
    lines.push({
      text: `  ${b.name} (head: ${b.head})${marker}`,
      style: 'system',
    });
  }

  return { lines };
}

function handleCheckout(framework: AgentFramework, name?: string): CommandResult {
  if (!name) {
    return { lines: [{ text: 'Usage: /checkout <branch-name>', style: 'system' }] };
  }

  const cm = getAgentCM(framework);
  if (!cm) return { lines: [{ text: 'No agent context manager.', style: 'system' }] };

  const branches = cm.listBranches();
  const target = branches.find(b => b.name === name || b.id === name);
  if (!target) {
    return { lines: [{ text: `Branch "${name}" not found. Use /branches to list.`, style: 'system' }] };
  }

  try {
    cm.switchBranch(target.id);
    return { lines: [{ text: `Switched to branch ${target.name}.`, style: 'system' }] };
  } catch (err) {
    return { lines: [{ text: `Checkout failed: ${err}`, style: 'system' }] };
  }
}

function handleHistory(framework: AgentFramework): CommandResult {
  const cm = getAgentCM(framework);
  if (!cm) return { lines: [{ text: 'No agent context manager.', style: 'system' }] };

  const { messages } = cm.queryMessages({});
  const lines: Line[] = [{ text: `--- History (${messages.length} messages) ---`, style: 'system' }];

  // Show the last 20 messages in summary form
  const recent = messages.slice(-20);
  for (const msg of recent) {
    const text = msg.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join(' ')
      .slice(0, 60);
    const suffix = text.length >= 60 ? '...' : '';
    lines.push({
      text: `  [${msg.id}] ${msg.participant}: ${text}${suffix}`,
      style: 'system',
    });
  }

  return { lines };
}
