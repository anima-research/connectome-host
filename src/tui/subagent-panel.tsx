import React from 'react';
import { Box, Text } from 'ink';
import type { ActiveSubagent } from '../modules/subagent-module.js';

interface SubagentPanelProps {
  subagents: ActiveSubagent[];
  height: number;
}

export function SubagentPanel({ subagents, height }: SubagentPanelProps) {
  if (subagents.length === 0) {
    return (
      <Box flexDirection="column" height={height} borderStyle="single" borderColor="gray">
        <Text color="gray"> No subagents</Text>
      </Box>
    );
  }

  // Show most recent subagents that fit
  const visible = subagents.slice(-Math.max(height - 1, 1));

  return (
    <Box flexDirection="column" height={height} borderStyle="single" borderColor="magenta">
      <Text color="magenta" bold> Subagents ({subagents.filter(s => s.status === 'running').length} running / {subagents.length} total)</Text>
      {visible.map((sa, i) => (
        <SubagentRow key={i} subagent={sa} />
      ))}
    </Box>
  );
}

function SubagentRow({ subagent }: { subagent: ActiveSubagent }) {
  const elapsed = Math.floor((Date.now() - subagent.startedAt) / 1000);

  const statusIcon = subagent.status === 'running' ? '⟳'
    : subagent.status === 'completed' ? '✓'
    : '✗';

  const statusColor = subagent.status === 'running' ? 'yellow'
    : subagent.status === 'completed' ? 'green'
    : 'red';

  const taskPreview = subagent.task.length > 50
    ? subagent.task.slice(0, 50) + '...'
    : subagent.task;

  const stats = subagent.toolCallsCount > 0 ? ` | ${subagent.toolCallsCount} tools` : '';
  const statusMsg = subagent.statusMessage ? ` | ${subagent.statusMessage}` : '';

  return (
    <Box>
      <Text color={statusColor}> {statusIcon} </Text>
      <Text color="cyan">{subagent.name}</Text>
      <Text color="gray"> ({subagent.type}) </Text>
      <Text dimColor>{taskPreview}</Text>
      <Text color="gray"> [{elapsed}s{stats}{statusMsg}]</Text>
    </Box>
  );
}
