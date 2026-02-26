import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useApp, useStdout, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { AgentFramework } from '@connectome/agent-framework';
import { ConversationPanel } from './conversation.js';
import { StatusBar } from './status-bar.js';
import { SubagentPanel } from './subagent-panel.js';
import { handleCommand } from '../commands.js';
import type { SubagentModule, ActiveSubagent } from '../modules/subagent-module.js';

export type Line = { text: string; style?: 'user' | 'agent' | 'tool' | 'system' };

interface AppProps {
  framework: AgentFramework;
}

export function App({ framework }: AppProps) {
  const [input, setInput] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [agentStatus, setAgentStatus] = useState<string>('idle');
  const [currentTool, setCurrentTool] = useState<string | null>(null);
  const [showSubagents, setShowSubagents] = useState(false);
  const [subagents, setSubagents] = useState<ActiveSubagent[]>([]);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;

  // Use a ref for the token buffer so it's stable across renders
  // and doesn't cause stale closure issues.
  const tokenBufferRef = useRef('');
  // Track whether we're in a streaming text block to properly finalize it
  const streamingRef = useRef(false);

  // Poll subagent state
  useEffect(() => {
    const subagentModule = framework.getAllModules().find(m => m.name === 'subagent') as SubagentModule | undefined;
    if (!subagentModule) return;

    const interval = setInterval(() => {
      setSubagents([...subagentModule.activeSubagents.values()]);
    }, 500);
    return () => clearInterval(interval);
  }, [framework]);

  useEffect(() => {
    const listener = (event: Record<string, unknown>) => {
      switch (event.type) {
        case 'inference:started':
          setAgentStatus('thinking');
          tokenBufferRef.current = '';
          streamingRef.current = true;
          break;

        case 'inference:tokens': {
          const content = event.content as string;
          if (content) {
            tokenBufferRef.current += content;
            const snapshot = tokenBufferRef.current;
            setLines(prev => {
              // Replace the last line if it's an in-progress agent line
              if (prev.length > 0 && prev[prev.length - 1]!.style === 'agent' && streamingRef.current) {
                const copy = prev.slice(0, -1);
                copy.push({ text: snapshot, style: 'agent' });
                return copy;
              }
              return [...prev, { text: snapshot, style: 'agent' }];
            });
          }
          break;
        }

        case 'inference:completed':
          // Finalize: flush the token buffer as a completed line
          streamingRef.current = false;
          setAgentStatus('idle');
          setCurrentTool(null);
          tokenBufferRef.current = '';
          break;

        case 'inference:failed': {
          streamingRef.current = false;
          const err = event.error as string;
          setAgentStatus('error');
          setLines(prev => [...prev, { text: `Error: ${err}`, style: 'system' }]);
          tokenBufferRef.current = '';
          break;
        }

        case 'inference:tool_calls_yielded': {
          // Finalize any in-progress text block before the tool line
          streamingRef.current = false;
          tokenBufferRef.current = '';

          setAgentStatus('tools');
          const calls = event.calls as Array<{ name: string }>;
          const names = calls.map(c => c.name).join(', ');
          setCurrentTool(names);
          setLines(prev => [...prev, { text: `[tools] ${names}`, style: 'tool' }]);
          break;
        }

        case 'inference:stream_resumed':
          setAgentStatus('thinking');
          tokenBufferRef.current = '';
          streamingRef.current = true;
          break;

        case 'tool:started':
          setCurrentTool(event.tool as string);
          break;
      }
    };

    framework.onTrace(listener as (e: unknown) => void);
    return () => framework.offTrace(listener as (e: unknown) => void);
  }, [framework]);

  // Tab key toggles subagent panel
  useInput((input, key) => {
    if (key.tab) {
      setShowSubagents(prev => !prev);
    }
  });

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

  // Layout: status bar (1) + input (1) + subagent panel (if shown)
  const subagentPanelHeight = showSubagents ? Math.min(subagents.length + 2, 8) : 0;
  const conversationHeight = Math.max(rows - 2 - subagentPanelHeight, 5);

  const runningCount = subagents.filter(s => s.status === 'running').length;

  return (
    <Box flexDirection="column">
      <ConversationPanel lines={lines} height={conversationHeight} />
      {showSubagents && <SubagentPanel subagents={subagents} height={subagentPanelHeight} />}
      <StatusBar
        status={agentStatus}
        tool={currentTool}
        subagentCount={runningCount}
        hint={runningCount > 0 && !showSubagents ? 'Tab: subagents' : undefined}
      />
      <Box>
        <Text bold color="cyan">{'> '}</Text>
        <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
      </Box>
    </Box>
  );
}
