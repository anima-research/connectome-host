import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useApp, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import type { AgentFramework } from '@connectome/agent-framework';
import { ConversationPanel } from './conversation.js';
import { StatusBar } from './status-bar.js';
import { handleCommand } from '../commands.js';

export type Line = { text: string; style?: 'user' | 'agent' | 'tool' | 'system' };

interface AppProps {
  framework: AgentFramework;
}

export function App({ framework }: AppProps) {
  const [input, setInput] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [agentStatus, setAgentStatus] = useState<string>('idle');
  const [currentTool, setCurrentTool] = useState<string | null>(null);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;

  useEffect(() => {
    let tokenBuffer = '';

    const listener = (event: Record<string, unknown>) => {
      switch (event.type) {
        case 'inference:started':
          setAgentStatus('thinking');
          tokenBuffer = '';
          break;

        case 'inference:tokens': {
          const content = event.content as string;
          if (content) {
            tokenBuffer += content;
            setLines(prev => {
              const copy = [...prev];
              if (copy.length > 0 && copy[copy.length - 1]!.style === 'agent') {
                copy[copy.length - 1] = { text: tokenBuffer, style: 'agent' };
              } else {
                copy.push({ text: tokenBuffer, style: 'agent' });
              }
              return copy;
            });
          }
          break;
        }

        case 'inference:completed':
          setAgentStatus('idle');
          setCurrentTool(null);
          tokenBuffer = '';
          break;

        case 'inference:failed': {
          const err = event.error as string;
          setAgentStatus('error');
          setLines(prev => [...prev, { text: `Error: ${err}`, style: 'system' }]);
          break;
        }

        case 'inference:tool_calls_yielded': {
          setAgentStatus('tools');
          const calls = event.calls as Array<{ name: string }>;
          const names = calls.map(c => c.name).join(', ');
          setCurrentTool(names);
          setLines(prev => [...prev, { text: `[tools] ${names}`, style: 'tool' }]);
          tokenBuffer = '';
          break;
        }

        case 'inference:stream_resumed':
          setAgentStatus('thinking');
          tokenBuffer = '';
          break;

        case 'tool:started':
          setCurrentTool(event.tool as string);
          break;
      }
    };

    framework.onTrace(listener as (e: unknown) => void);
    return () => framework.offTrace(listener as (e: unknown) => void);
  }, [framework]);

  const handleSubmit = useCallback((value: string) => {
    if (!value.trim()) return;
    const trimmed = value.trim();

    if (trimmed.startsWith('/')) {
      const result = handleCommand(trimmed, framework);

      if (result.quit) {
        exit();
      } else if (trimmed === '/clear') {
        setLines([]);
      } else {
        setLines(prev => [...prev, ...result.lines]);
      }
    } else {
      setLines(prev => [...prev, { text: `You: ${trimmed}`, style: 'user' }]);
      framework.pushEvent({
        type: 'external-message',
        source: 'tui',
        content: trimmed,
        metadata: {},
        triggerInference: true,
      });
    }
    setInput('');
  }, [framework, exit]);

  const conversationHeight = Math.max(rows - 4, 5);

  return (
    <Box flexDirection="column">
      <ConversationPanel lines={lines} height={conversationHeight} />
      <StatusBar status={agentStatus} tool={currentTool} />
      <Box>
        <Text bold color="cyan">{'> '}</Text>
        <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
      </Box>
    </Box>
  );
}
