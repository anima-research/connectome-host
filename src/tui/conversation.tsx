import React from 'react';
import { Box, Text } from 'ink';
import type { Line } from './app.js';

interface ConversationPanelProps {
  lines: Line[];
  height: number;
}

export function ConversationPanel({ lines, height }: ConversationPanelProps) {
  // Show only the most recent lines that fit
  const visible = lines.slice(-height);

  return (
    <Box flexDirection="column" height={height}>
      {visible.map((line, i) => (
        <LineView key={i} line={line} />
      ))}
    </Box>
  );
}

function LineView({ line }: { line: Line }) {
  switch (line.style) {
    case 'user':
      return <Text color="green">{line.text}</Text>;
    case 'agent':
      return <Text>{line.text}</Text>;
    case 'tool':
      return <Text color="yellow" dimColor>{line.text}</Text>;
    case 'system':
      return <Text color="gray">{line.text}</Text>;
    default:
      return <Text>{line.text}</Text>;
  }
}
