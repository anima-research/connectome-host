import React from 'react';
import { Box, Text } from 'ink';

interface StatusBarProps {
  status: string;
  tool: string | null;
  branch?: string;
  lessonsCount?: number;
  subagentCount?: number;
}

export function StatusBar({ status, tool, branch, lessonsCount, subagentCount }: StatusBarProps) {
  const statusColor = status === 'idle' ? 'green'
    : status === 'error' ? 'red'
    : 'yellow';

  return (
    <Box>
      <Text color="gray">[</Text>
      {branch && <Text color="cyan">{branch} </Text>}
      <Text color={statusColor}>{status}</Text>
      {tool && <Text color="yellow"> | {tool}</Text>}
      {subagentCount !== undefined && subagentCount > 0 && (
        <Text color="magenta"> | {subagentCount} subagent{subagentCount > 1 ? 's' : ''}</Text>
      )}
      {lessonsCount !== undefined && lessonsCount > 0 && (
        <Text color="blue"> | {lessonsCount} lessons</Text>
      )}
      <Text color="gray">]</Text>
    </Box>
  );
}
